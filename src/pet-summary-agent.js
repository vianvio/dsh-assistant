/**
 * pet-summary-agent —— 总结的**执行层**：读会话快照、跑一轮隐藏会话。
 *
 * 三条设计决定（都踩过，别改）：
 *
 *  1. **新会话必须隐藏**。DSH 没有 `hidden` 开关，真正的隐藏标记是
 *     `SessionHeader.origin === 'subagent'`（客户端侧边栏 `sessionVisible()` 就按它过滤）。
 *     用别的办法（比如建完再删）做不到 —— 会话持久化层**没有删除 API**。
 *     顺带一提，`origin: 'subagent'` 还会让桌面通知跳过它，不会平白弹系统通知。
 *
 *  2. **不读磁盘上的 .zstd**。用 `ctx.sessionQuery` 的
 *     `listSessions()`（含未加载的历史会话）+ `readSession(id)`。手解 jsonl.zstd
 *     要自己重做 surface fold 与格式迁移，纯属自找麻烦。
 *
 *  3. **跑完必须 dispose**。`handle.dispose()` 是唯一能保证 agent 停下来、
 *     会话从内存里摘掉的入口；会话文件仍留在磁盘（不可删），但列表里看不到。
 */

import { randomUUID } from 'node:crypto'

import { createSessionDigests, projectSession } from './pet-summary-digest.js'
import { createSessionActivityIndex, touchedToday } from './pet-summary-activity.js'

const TIMEOUT_MS = 5 * 60 * 1000

/**
 * 取所有会话的当前投影。读不出来的会话按"跳过"处理 ——
 * 部分会话（fork/seeded 的、历史格式有瑕疵的）整段复现会失败，
 * 别让一整天都总结不出来。
 *
 * 四个关键点（都是实测出来的，别改回去）：
 *
 *  1. **投影**：读到快照立刻折成 digest（`pet-summary-digest.js`），事件对象当场丢弃。
 *     旧实现把 179 个会话的快照全留在 Map 里 —— 1.09 GB 解压内容 ≈ 1.3 GB heap，
 *     而真正进日报的只有 0.8%。
 *
 *  2. **缓存 + 脏标记**：只重读"没缓存过"或"宿主标脏过"的会话（`digests.takeDirty()`）。
 *     全量重扫只在启动后第一轮发生一次；之后每轮退化到个位数会话 ——
 *     后台总结是**每次会话压缩**都会跑的，这一条决定了它是不是常态尖峰。
 *
 *  3. **让出主线程**：整段读会话是同步 CPU（解压 + JSON.parse + surface 折叠），
 *     串行 179 个会把宿主的 15 秒心跳窗口吃掉。每个会话之间 `setImmediate` 一次，
 *     事件循环就不会被连续占住。
 *
 *  4. **首轮预筛（mtime）**：进程刚起来时缓存是空的，本来要把所有会话读一遍 ——
 *     实测 160 个里只有 8 个今天动过。日志是追加写的，所以"文件 mtime 早于今天 0 点"
 *     就等于"今天不可能有新内容"（`pet-summary-activity.js`，真机验证过 0 反例）。
 *     **定位不到文件就照读**，宁可慢不能漏。
 */
export async function collectSessions(ctx, logger = console, { digests, activity, onYield } = {}) {
  const sessionQuery = ctx?.get?.('sessionQuery')
  const agents = ctx?.get?.('agents')
  if (!sessionQuery || !agents) {
    throw new Error('当前 DSH 缺少 sessionQuery / agents 服务，无法生成总结')
  }

  // 没有传缓存就每轮新建一份（等价于旧行为：每次都全读）—— 测试与一次性调用走这条
  const cache = digests ?? createSessionDigests()
  // 没有传索引就自己建一个（默认 $DSH_HOME/sessions，失败即"没有信号"）
  const files = activity ?? createSessionActivityIndex()
  // 让出方式可注入：测试要能数"让出了几次"，而不是靠时间窗口去碰运气
  const pause = onYield ?? yieldToLoop
  // 扫描**开始**就取走脏集：扫描期间新到的事件留给下一轮（这一轮的摘要已经不含它们）
  const pending = cache.takeDirty()
  const since = cache.windowStart
  const records = await sessionQuery.listSessions()
  const ids = []
  const usable = []
  let skipped = 0

  for (const record of records) {
    const header = record?.header ?? record
    if (!header?.id || header.origin === 'subagent') continue
    const id = String(header.id)
    ids.push(id)
    if (cache.has(id) && !pending.has(id)) {
      if (cache.get(id).messages.length > 0) usable.push(id)
      continue
    }
    // 首轮预筛：今天不可能有新内容的会话直接不看（缓存里也没有它，下轮还会再判一次）
    if (!cache.has(id) && !touchedToday(header, record?.live === true, files, since)) {
      skipped += 1
      continue
    }
    cache.reads += 1
    try {
      const snapshot = await sessionQuery.readSession(id)
      const digest = projectSession(snapshot, { since })
      cache.put(id, digest)
      if (digest.messages.length > 0) usable.push(id)
    } catch (error) {
      const reason = message(error)
      // 整段复现失败时退一步读"当前 surface"：它只取需要的那部分事件，宽容得多
      let recovered = false
      try {
        const surface = await sessionQuery.readSurface?.(id)
        if (surface?.events?.length) {
          const digest = projectSession(surface, { since })
          cache.put(id, digest)
          if (digest.messages.length > 0) usable.push(id)
          logger.warn?.(`dsh-assistant: 会话 ${id} 整段读取失败，已退回 surface（${reason.slice(0, 60)}）`)
          recovered = true
        }
      } catch {
        // 读不出来就跳过这一个会话
      }
      if (!recovered) logger.warn?.(`dsh-assistant: 跳过会话 ${id}: ${reason}`)
    } finally {
      // 让出主线程：否则连读几十个会话时，宿主的定时器/心跳会被整体推迟
      await pause()
    }
  }

  // 标题只对"真有今天内容的会话"读：标题是锦上添花，没必要为 179 个会话各折一次语料
  const titles = await readTitles(sessionQuery, usable, logger)
  // 留一条可查的账：首轮预筛跳了多少、实际读了多少（"日报怎么变快了"要能一眼看懂）
  logger.debug?.(
    `dsh-assistant: 总结扫描：读 ${cache.reads} 个（含缓存命中后的重读），`
    + `按 mtime 预筛跳过 ${skipped} 个，缓存 ${cache.stats.size} 个会话`,
  )
  return { records, digests: cache, titleOf: (id) => titles.get(String(id)) }
}

/** 把主线程让出去一轮（见 collectSessions 的第 3 条）。 */
export function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 一次读回所有会话标题；失败不致命（标题只是锦上添花）。 */
async function readTitles(sessionQuery, ids, logger) {
  const titles = new Map()
  if (ids.length === 0) return titles
  try {
    const results = await sessionQuery.readTitleSnapshots?.(ids)
    if (Array.isArray(results)) {
      for (const result of results) {
        const title = result?.status === 'fulfilled' ? result.value?.title?.title : undefined
        if (title) titles.set(String(result.sessionId), title)
      }
      return titles
    }
  } catch (error) {
    logger.warn?.(`dsh-assistant: 批量读取会话标题失败，改为逐个读: ${message(error)}`)
  }
  for (const id of ids) {
    try {
      const snapshot = await sessionQuery.readTitle?.(id)
      if (snapshot?.title) titles.set(id, snapshot.title)
    } catch {
      // 读不到就用 cwd 兜底
    }
  }
  return titles
}

/** 用当前默认模型跑（用户改过推理档位也跟着走）。 */
function defaultSelection(ctx) {
  return ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {}
}

/**
 * 跑一轮隐藏会话拿文本。全量模式与增量模式共用这一份 ——
 * 超时、落盘屏障、取正文、dispose 只有这一处实现。
 *
 * @returns {Promise<string>} 助手最后一条文本（已 trim），空表示没产出
 */
export async function runHiddenSession(ctx, { prompt, cwd, logger = console } = {}) {
  const agents = ctx?.get?.('agents')
  const sessions = ctx?.get?.('sessions')
  if (!agents) throw new Error('当前 DSH 缺少 agents 服务')

  const selection = defaultSelection(ctx)
  // 超时保护：agent 回合可能因为工具/网络卡住，必须有上限，
  // 否则通知永远停在"正在整理…"，用户只能重启 DSH。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('总结超时（5 分钟）')), TIMEOUT_MS)

  const handle = await agents.create({
    // sessionId 是必填（brandString<SessionId>，运行时就是个字符串）
    sessionId: `assistant-review-${randomUUID()}`,
    // origin: 'subagent' —— 唯一的隐藏手段
    meta: { cwd, origin: 'subagent' },
    agentOptions: {
      ...(selection.provider ? { provider: selection.provider } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    },
    signal: controller.signal,
  })

  try {
    handle.agent.followup(createUserPrompt(prompt))
    logger.info?.(`dsh-assistant: 总结会话已启动（模型 ${selection.model ?? '默认'}）`)
    await Promise.race([
      handle.agent.whenIdle(),
      new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason ?? new Error('总结被中止'))
        }, { once: true })
      }),
    ])
    // 落盘屏障：读完就 dispose，先确保事件都进持久化层
    await sessions?.flush?.(handle.agent.session)
    return lastAssistantText(handle.agent.session?.snapshotEvents?.() ?? [])
  } finally {
    clearTimeout(timer)
    // dispose 偶尔会在 harness 内部监听器里抛（日志出现过 agent/disposed listener threw），
    // 但会话已经拿到了结果/已经失败，这里不该让清理异常盖掉真正的结果。
    try {
      await handle.dispose?.()
    } catch (error) {
      logger.warn?.(`dsh-assistant: 总结会话清理异常（忽略）: ${message(error)}`)
    }
  }
}

/** 取最后一条有内容的助手文本。 */
function lastAssistantText(events) {
  let text = ''
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const piece = eventTextOf(event)
    if (piece) text = piece
  }
  return text.trim()
}

function eventTextOf(event) {
  const content = event?.data?.content ?? event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * 造一条用户消息。
 *
 * 形状对齐 `@deepseek-ai/dsh-llm` 的 `createUserMessage()`：它在
 * `{ role, content, source }` 之上只补一个 `id: randomUUID()`（brand 类型在运行时
 * 就是字符串）。这里照抄这个形状，省掉对 harness 内部包的依赖 ——
 * 插件跑在用户 profile 里，打包进这个依赖不划算。
 */
function createUserPrompt(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
