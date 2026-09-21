#!/usr/bin/env node
/**
 * 把**最近一次「今天干了什么」的正文**从会话存储里读出来，量一量它有多长、
 * 有没有违反硬性限制（每个项目/主题 ≤3 条、全文 ≤25 行）。
 *
 * 为什么需要它：日报是在一个隐藏会话（`assistant-review-*`）里生成的，正文只发给原生端弹窗，
 * 磁盘上并没有单独的产物 —— 但它作为会话事件被持久化了。想判断"提示词到底管不管用"，
 * 唯一可靠的证据就是真读一遍模型到底写了什么。
 *
 * 另外可以看**后台留存的水位**：哪些内容已经攒过、现在点一次"今天干了什么"
 * 还要重新提炼多少（`--delta`）。
 *
 *   node scripts/inspect-report.mjs          # 最近一次
 *   node scripts/inspect-report.mjs --all    # 最近 5 次
 *   node scripts/inspect-report.mjs --raw    # 顺便打印正文
 *   node scripts/inspect-report.mjs --delta  # 后台留存的水位 + 本次还需提炼的增量
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { SUMMARY_LIMITS, eventsToLines, measureReport, reportViolations, startOfToday } from '../src/pet-summary-corpus.js'
import { isSubagent } from '../src/events.js'
import { partsFor, summarizedUntil, storePath } from '../src/pet-summary-store.js'

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')

/**
 * 隐藏日报会话的 id 前缀。
 *
 * 认**两种**：改名（dsh-pet → dsh-assistant）之前的旧会话仍叫 `pet-review-*`，
 * 而且它们还躺在会话存储里 —— 只认新前缀的话，"最近一次日报"会看不见历史。
 */
const REPORT_SESSION = /^(pet|assistant)-review-/u

/** 找出所有隐藏日报会话的 session.jsonl.zstd，按修改时间倒序。 */
function findReports() {
  if (!existsSync(sessionsRoot)) return []
  const found = []
  for (const project of readdirSync(sessionsRoot)) {
    const projectDir = join(sessionsRoot, project)
    let entries
    try { entries = readdirSync(projectDir) } catch { continue }
    for (const session of entries.filter((name) => REPORT_SESSION.test(name))) {
      const dir = join(projectDir, session)
      let files
      try { files = readdirSync(dir) } catch { continue }
      // 日志文件名随格式版本变（session.jsonl.zstd / session.v3.jsonl.zstd），别写死
      for (const file of files.filter((name) => /^session(\.[\w.]+)?\.jsonl\.zstd$/u.test(name))) {
        const log = join(dir, file)
        found.push({ session, project, log, at: statSync(log).mtime })
      }
    }
  }
  return found.sort((left, right) => right.at - left.at)
}

/**
 * 解压会话日志。
 *
 * **必须用 CLI 优先**：DSH 的日志是追加写的，一个文件里有**多个 zstd 帧**，
 * 而 Node 的 `zstdDecompressSync` / `createZstdDecompress` 只解第一帧
 * （实测：CLI 74960 字节 vs Node 239 字节 —— 用 Node 会得到"没有正文"的假结论）。
 * CLI 不在时退回 Node，并提示可能不完整。
 */
function readLog(path) {
  for (const [command, args] of [['unzstd', ['-c', path]], ['zstd', ['-dc', path]]]) {
    try { return execFileSync(command, args, { maxBuffer: 1 << 28 }).toString('utf8') } catch { /* 换下一个 */ }
  }
  try {
    const text = zstdDecompressSync(readFileSync(path)).toString('utf8')
    console.error('提示：没找到 zstd CLI，用 Node 解压可能只拿到第一帧（日志是多帧追加的）')
    return text
  } catch (error) {
    throw new Error(`解压失败：本机没有 zstd/unzstd，Node 原生解压也失败（${error.message}）`)
  }
}

function assistantText(logPath) {
  let last = ''
  for (const line of readLog(logPath).split('\n')) {
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.content ?? event?.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('').trim()
    if (text) last = text
  }
  return last
}

/**
 * 后台留存的水位：每个会话"已经攒到哪"，以及现在点一次日报还要补多少。
 *
 * 这就是「任务后台总结」开关的实际效果 —— 开关开着且压缩过，
 * 这里的"增量"应该远小于"今天的全部内容"；关着就全是增量。
 */
function showDelta() {
  const file = storePath()
  const since = startOfToday()
  console.log(`水位存储: ${file}\n`)

  const rows = []
  let skippedSubagents = 0
  for (const { session, project, log, header } of allSessionLogs()) {
    // 与宿主同一套判据：子会话不参与总结（否则这里会报出一堆"要补 10 行"的假增量）
    if (isSubagent({ header })) {
      skippedSubagents += 1
      continue
    }
    const events = readEvents(log)
    const lines = eventsToLines(events)
    const fresh = events.filter((e) => typeof e?.time === 'number' && e.time > Math.max(since, summarizedUntil(session, file)))
    const stored = partsFor(session, file)
    rows.push({
      session,
      project,
      stored: stored.length,
      watermark: summarizedUntil(session, file),
      total: lines.length,
      fresh: eventsToLines(fresh).length,
    })
  }
  rows.sort((left, right) => right.fresh - left.fresh)
  if (rows.length === 0) {
    console.log('今天没有可读的会话日志（子会话已跳过 ' + skippedSubagents + ' 个）')
    return
  }
  let saved = 0
  for (const row of rows.slice(0, 12)) {
    const mark = row.fresh === 0 ? '跳过' : `补 ${row.fresh} 行`
    if (row.fresh === 0) saved += row.total
    const stamp = row.watermark ? new Date(row.watermark).toLocaleTimeString('zh-CN') : '—'
    console.log(`  ${row.fresh === 0 ? '○' : '●'} ${String(row.session).slice(0, 22)}…  留存 ${row.stored} 段（水位 ${stamp}）｜今天共 ${row.total} 行 → ${mark}`)
  }
  if (rows.length > 12) console.log(`  ……（另有 ${rows.length - 12} 个会话）`)
  const withFresh = rows.filter((row) => row.fresh > 0).length
  const savedAll = rows.filter((row) => row.fresh === 0).reduce((sum, row) => sum + row.total, 0)
  void saved
  console.log(`\n共 ${rows.length} 个会话（子会话跳过 ${skippedSubagents} 个）：`
    + `${withFresh} 个要补增量、${rows.length - withFresh} 个可直接跳过`
    + `（已留存的约 ${savedAll} 行不用重提炼）`)
}

/** 今天改动过的会话日志（全量扫会慢）。 */
function allSessionLogs() {
  const found = []
  if (!existsSync(sessionsRoot)) return found
  const since = startOfToday()
  for (const project of readdirSync(sessionsRoot)) {
    const projectDir = join(sessionsRoot, project)
    let entries
    try { entries = readdirSync(projectDir) } catch { continue }
    for (const session of entries) {
      if (REPORT_SESSION.test(session)) continue
      const dir = join(projectDir, session)
      let files
      try { files = readdirSync(dir) } catch { continue }
      for (const name of files.filter((n) => /^session(\.[\w.]+)?\.jsonl\.zstd$/u.test(n))) {
        const log = join(dir, name)
        if (statSync(log).mtimeMs < since) continue
        // 日志第一行就是会话头（含 origin / delegationDepth）
        const header = readEvents(log).find((event) => event?.type === 'session') ?? {}
        found.push({ session, project, log, header })
      }
    }
  }
  return found
}

/** 从会话日志里取出事件数组（会话日志是 NDJSON）。 */
function readEvents(logPath) {
  const events = []
  for (const line of readLog(logPath).split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed?.type) events.push(parsed)
    } catch { /* 坏行跳过 */ }
  }
  return events
}

if (process.argv.includes('--delta')) {
  showDelta()
  process.exit(0)
}

const reports = findReports()
if (reports.length === 0) {
  console.error(`没找到日报会话（${sessionsRoot} 下没有 assistant-review-*）——先在宠物菜单里点一次「今天干了什么」。`)
  process.exit(1)
}

const showAll = process.argv.includes('--all')
const showRaw = process.argv.includes('--raw')
const limit = showAll ? 5 : 1

console.log(
  `日报硬性限制：每分组 ≤${SUMMARY_LIMITS.perGroup} 条 / 「今天做了什么」≤${SUMMARY_LIMITS.totalItems} 条`
  + ` / 「待办」≤${SUMMARY_LIMITS.todoItems} 条且按项目聚合 / 全文 ≤${SUMMARY_LIMITS.maxLines} 行\n`,
)

for (const report of reports.slice(0, limit)) {
  const markdown = assistantText(report.log)
  const stamp = report.at.toLocaleString('zh-CN')
  if (!markdown) {
    console.log(`· ${stamp}  ${report.session}  （没有正文：可能生成失败）`)
    continue
  }
  const { lines, sections } = measureReport(markdown)
  const problems = reportViolations(markdown)
  const describe = (section) => {
    if (!section) return '（没有这一节）'
    const groups = section.groups.map((group) => `${group.title}=${group.items}`).join(', ')
    const loose = section.ungrouped > 0 ? `${section.ungrouped} 条未分组` : ''
    return [groups, loose].filter(Boolean).join(' + ') || '（无分组标题）'
  }

  console.log(`${problems.length === 0 ? '✓' : '✗'} ${stamp}  ${report.session}\n    项目: ${report.project}`)
  console.log(`    行数 ${lines}｜正文 ${markdown.length} 字`)
  for (const [name, section] of sections) {
    console.log(`    ${name}: ${section.items} 条 ← ${describe(section)}`)
  }
  if (sections.size === 0) console.log('    （未识别到 ## 分节）')
  if (problems.length > 0) console.log(`    超限: ${problems.join('；')}`)
  if (showRaw) console.log(`\n${markdown}\n${'─'.repeat(60)}`)
  console.log('')
}
