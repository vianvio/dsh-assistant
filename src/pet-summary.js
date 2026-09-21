/**
 * pet-summary.js —— 「今天干了什么」的编排层，两种模式：
 *
 *   · **全量**（`backgroundSummary` 关，默认）：把今天所有会话拼进一个 prompt 一次生成。
 *   · **增量**（`backgroundSummary` 开）：每个会话单独提炼 → 再汇总成日报，
 *     水位存在 `pet-summary-store.js`，会话每次压缩时后台留存一段。
 *
 * 纯数据在 pet-summary-corpus.js（可单测），跑隐藏会话在 pet-summary-agent.js
 * （超时/dispose/取正文只有一份实现），这里只负责"怎么串"。
 */

import {
  buildCorpus,
  buildMergePrompt,
  buildPrompt,
  buildRewritePrompt,
  buildSessionPrompt,
  extractDeltas,
  reportLengthWarning,
  reportLineCount,
} from './pet-summary-corpus.js'
import { collectSessions, runHiddenSession } from './pet-summary-agent.js'
import { appendPart, storePath, summarizedUntil } from './pet-summary-store.js'

/**
 * 全量模式：所有会话一个 prompt。
 *
 * @returns {Promise<{ markdown: string, sessions: number }>}
 */
export async function generateTodaySummary(ctx, { logger = console, now = Date.now() } = {}) {
  const { records, snapshots, titleOf } = await collectSessions(ctx, logger)
  const { sessions: today, chunks } = buildCorpus(records, snapshots, { now, titleOf })
  if (today.length === 0) throw new Error('今天还没有可总结的会话')

  const date = dateOf(now)
  const markdown = await summariseWithinLimits(ctx, {
    prompt: buildPrompt(chunks, { date }),
    cwd: cwdOf(today),
    date,
    logger,
  })
  return { markdown, sessions: today.length }
}

/**
 * 增量模式的**前半段**：把"水位之后的新增部分"逐会话提炼并留存。
 *
 * 拆出来的原因：后台总结（会话每次压缩时跑）只需要这一段 —— 它**不产出日报正文**，
 * 只负责把已完成的部分落进水位存储。原先它复用了完整的分步总结（含最后那次汇总），
 * 而那次汇总的结果在后台路径里是被直接丢掉的 —— 每次压缩白花一次模型调用。
 *
 * 水位由 `untilTime`（这段覆盖到的最后事件时间）推进，下次只取它之后的部分。
 *
 * @returns {Promise<{ parts: object[], sessions: number, fallbackCwd: string, date: string }>}
 */
export async function refinePendingParts(ctx, {
  logger = console, now = Date.now(), storeFile = storePath(), onPart,
} = {}) {
  const { records, snapshots, titleOf } = await collectSessions(ctx, logger)
  const deltas = extractDeltas(records, snapshots, {
    now,
    summarizedUntilOf: (sessionId) => summarizedUntil(sessionId, storeFile),
  })
  if (deltas.length === 0) throw new Error('今天还没有可总结的会话')

  const fallbackCwd = cwdOf(deltas)
  const parts = []
  let index = 0
  for (const delta of deltas) {
    index += 1
    delta.title = titleOf(delta.id) ?? delta.cwd ?? '未命名会话'
    onPart?.({ index, total: deltas.length, title: delta.title })
    try {
      const markdown = await runHiddenSession(ctx, {
        prompt: buildSessionPrompt(delta),
        cwd: delta.cwd || fallbackCwd,
        logger,
      })
      if (markdown) {
        parts.push({ id: delta.id, title: delta.title, cwd: delta.cwd, untilTime: delta.untilTime, markdown })
      }
    } catch (error) {
      // 单个会话失败不该毁掉整份日报：记一笔，继续下一个
      logger.warn?.(`dsh-assistant: 会话 ${delta.id} 提炼失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (parts.length === 0) throw new Error('所有会话都没提炼出内容')

  // 落盘：下次只取这些水位之后的新增部分（失败也不要紧，最多是下次多提炼一遍）
  for (const part of parts) {
    appendPart({
      sessionId: part.id,
      title: part.title,
      cwd: part.cwd,
      untilTime: part.untilTime,
      markdown: part.markdown,
    }, storeFile)
  }
  return { parts, sessions: parts.length, fallbackCwd, date: dateOf(now) }
}

/**
 * 增量模式：每个会话单独提炼 → 汇总。
 *
 * @param {string} [options.storeFile] 水位存储路径（默认 $DSH_HOME/dsh-assistant/summaries.json）
 * @param {(part: {index: number, total: number, title: string}) => void} [options.onPart] 每完成一个会话的回调
 * @returns {Promise<{ markdown: string, parts: object[], sessions: number }>}
 */
export async function generateTodaySummaryStepped(ctx, { logger = console, ...options } = {}) {
  const { parts, sessions, fallbackCwd, date } = await refinePendingParts(ctx, { logger, ...options })

  const markdown = await summariseWithinLimits(ctx, {
    prompt: buildMergePrompt(parts, { date }),
    cwd: fallbackCwd,
    date,
    logger,
  })

  logger.info?.(`dsh-assistant: 今日总结完成（${sessions} 个会话分别提炼后汇总，${markdown.length} 字）`)
  return { markdown, parts, sessions }
}

/**
 * 生成 → 超限就**带着上次的输出重写一遍**（最多一次）。
 *
 * 提示词只是软约束：实测被要求"合并同类项 + 每项目最多 3 条"时，模型经常只做一半
 * （某次一个项目写了 9 条）。与其继续加惊叹号，不如让它盯着自己上一次的输出删一遍 ——
 * 多一次调用，但长度收敛有保证；重写完仍然更长的话，保留原来那版（只做减法，不做无谓替换）。
 */
async function summariseWithinLimits(ctx, { prompt, cwd, date, logger }) {
  const first = await runHiddenSession(ctx, { prompt, cwd, logger })
  if (!first) throw new Error('模型没有返回内容')

  const warning = reportLengthWarning(first)
  if (!warning) return first
  logger.warn?.(`dsh-assistant: ${warning}`)

  let rewritten
  try {
    rewritten = await runHiddenSession(ctx, {
      prompt: buildRewritePrompt(first, { date }),
      cwd,
      logger,
    })
  } catch (error) {
    logger.warn?.(`dsh-assistant: 重写失败，保留原来那版: ${error instanceof Error ? error.message : String(error)}`)
    return first
  }
  if (!rewritten) return first

  const shorter = reportLineCount(rewritten) <= reportLineCount(first) ? rewritten : first
  logger.info?.(`dsh-assistant: 日报超限已重写（${reportLineCount(first)} → ${reportLineCount(shorter)} 行）`)
  return shorter
}

function dateOf(now) {
  return new Date(now).toLocaleDateString('zh-CN')
}

/** 隐藏会话的工作目录：优先取今天真用过的项目目录。 */
function cwdOf(entries) {
  return entries.find((entry) => entry.cwd)?.cwd ?? process.cwd()
}
