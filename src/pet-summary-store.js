/**
 * pet-summary-store.js —— 后台总结的持久化（按会话存"已总结到哪"）。
 *
 * 为什么要存：开启"后台总结"后，每次会话触发压缩就把**已完成的那段**总结一次并留下。
 * 之后点"今日总结"时，只需要总结**还没被压缩的那一小段**，再和留存的片段合并 ——
 * 这样既不会把一天的上下文一股脑塞进一个 prompt（互相干扰），也不会丢信息。
 *
 * 存储形态：`$DSH_HOME/dsh-assistant/summaries.json`
 *   { version: 1, sessions: { <sessionId>: { title, cwd, parts: [ { untilTime, markdown, ts } ] } } }
 * 同一会话保留多段（按时间递增），合并时按顺序拼。
 *
 * 四条规矩（都是踩过的）：
 *   ① **并发**：整份文件跨进程共享（桌面端 + CLI 双开时各跑一份插件），
 *      所以读-改-写要加锁、临时文件名带 pid，且在锁内重读合并。
 *   ② **写放大**：一次日报要落 N 段，就只做 **一次** 加锁-读-改-写（`appendParts`），
 *      不是 N 次；否则单次成本 ≈ N × 库大小，随累计天数线性上涨。
 *   ③ **不无限增长**：按保留窗口 + 每会话条数上限裁剪（以前只 push 不裁，
 *      本机真实库从 9 月攒到现在，成本 O(天数²)）。
 *   ④ **失败要说话**：读不出来得区分"首次运行没这个文件"和"文件坏了/被锁"，
 *      否则用户在日报侧只会看到"今天的东西又重做了一遍"，拿不到任何线索。
 */

import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const VERSION = 1

/** 拿不到锁时最多等这么久（毫秒），超时宁可抛错让上层降级，也不写坏别人的数据。 */
const LOCK_TIMEOUT_MS = 4000
const LOCK_RETRY_MS = 15
/** 持锁进程已经不在时，锁文件老过这个时间才敢抢。 */
const LOCK_STALE_MS = 10_000
/** 持锁进程**还活着**时，最多容忍它持锁这么久；超过才当它卡死并夺锁。 */
const LOCK_ABANDON_MS = 5 * 60 * 1000

/** 保留窗口：比这更老的片段不再参与合并（水位靠每个会话最新那段保留）。 */
const RETENTION_DAYS = 45
/** 每个会话最多留多少段（超出丢最旧的，但**永远保留最新一段** —— 它是水位）。 */
const MAX_PARTS_PER_SESSION = 200

const EMPTY = () => ({ version: VERSION, sessions: {} })

/**
 * 这个模块对存储的读写量（次 + 字节）。
 *
 * 为什么要有：日报的存储开销要能**复算** —— "一次总结写了几倍于库大小的字节"
 * 这种事不该靠打点 fs 才看得出来。测试也直接读它来守住"批量写"这条契约。
 */
export const storeIO = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 }

/** 清空计数（测试与基准用）。 */
export function resetStoreIO() {
  storeIO.reads = 0
  storeIO.readBytes = 0
  storeIO.writes = 0
  storeIO.writeBytes = 0
}

/** 存储路径：可用 DSH_ASSISTANT_SUMMARY_STORE 覆盖（测试/多 profile 用）。 */
export function storePath(env = process.env) {
  if (env.DSH_ASSISTANT_SUMMARY_STORE) return env.DSH_ASSISTANT_SUMMARY_STORE
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-assistant', 'summaries.json')
}

/**
 * 读盘并**归一化**。
 *
 * 三种失败语义不同，别再折叠成一个返回值：
 *   · 文件不存在（首次运行）→ 静默给空（debug）；
 *   · 读不动 / 不是 JSON / 结构不符 → warn（带 path 与错误码），给空继续跑。
 *
 * @param {string} [path]
 * @param {{ logger?: object }} [options] 传了就说话（宿主侧一直传）
 */
export function readStore(path = storePath(), { logger } = {}) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
    storeIO.reads += 1
    storeIO.readBytes += Buffer.byteLength(raw)
  } catch (error) {
    const code = error?.code
    if (code === 'ENOENT') {
      logger?.debug?.(`dsh-assistant: 水位存储还不存在（${path}），本次按空处理`)
    } else {
      logger?.warn?.(
        `dsh-assistant: 水位存储读不出来（${path}，${code ?? error?.message}）——`
        + '本次按空处理，代价是今天的会话会被重新提炼一遍',
      )
    }
    return EMPTY()
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger?.warn?.(
      `dsh-assistant: 水位存储不是合法 JSON（${path}，${error instanceof Error ? error.message : String(error)}）——`
      + '本次按空处理，坏文件留在原处供排查',
    )
    return EMPTY()
  }

  if (parsed?.version !== VERSION || !parsed.sessions || typeof parsed.sessions !== 'object') {
    logger?.warn?.(`dsh-assistant: 水位存储版本/结构不符（${path}，version=${String(parsed?.version)}）——本次按空处理`)
    return EMPTY()
  }

  const sessions = {}
  let dropped = 0
  for (const [id, entry] of Object.entries(parsed.sessions)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { dropped += 1; continue }
    if (!Array.isArray(entry.parts)) dropped += 1
    const parts = Array.isArray(entry.parts)
      ? entry.parts.filter((part) => part && typeof part === 'object' && Number.isFinite(part.untilTime))
      : []
    sessions[id] = { title: entry.title, cwd: entry.cwd, parts }
  }
  if (dropped > 0) logger?.warn?.(`dsh-assistant: 水位存储里有 ${dropped} 条会话记录结构不对，已按空跳过（${path}）`)

  return { version: VERSION, sessions }
}

/**
 * 原子写：先写**本进程专属**的临时文件再 rename —— 中断只会留下旧的完整文件。
 * 临时文件名带 pid 与序号：两个进程同时写也不会抢同一个 .tmp（那会抛 ENOENT）。
 */
let tempCounter = 0
export function writeStore(store, path = storePath()) {
  mkdirSync(dirname(path), { recursive: true })
  tempCounter += 1
  const temporary = `${path}.tmp-${process.pid}-${tempCounter}`
  const text = `${JSON.stringify(store, null, 2)}\n`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, path)
  storeIO.writes += 1
  storeIO.writeBytes += Buffer.byteLength(text)
  return path
}

/** 裁剪：保留窗口内的片段；一个会话至少留最新一段（水位靠它）。 */
function trimParts(parts, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86400_000
  let kept = parts.filter((part) => part.untilTime >= cutoff)
  if (kept.length === 0) kept = parts.slice(-1)
  if (kept.length > MAX_PARTS_PER_SESSION) kept = kept.slice(-MAX_PARTS_PER_SESSION)
  return kept
}

/** 把一批片段合并进一份 store（纯函数，便于单测）。 */
function mergeInto(store, records, now) {
  let touched = 0
  for (const record of records) {
    const { sessionId, title, cwd, untilTime, markdown } = record
    if (!sessionId || !markdown) continue
    const entry = store.sessions[sessionId] ?? { title, cwd, parts: [] }
    entry.title = title ?? entry.title
    entry.cwd = cwd ?? entry.cwd
    if (!Array.isArray(entry.parts)) entry.parts = []
    const part = { untilTime, markdown, ts: now }
    const existing = entry.parts.findIndex((item) => item.untilTime === untilTime)
    if (existing >= 0) entry.parts[existing] = part
    else entry.parts.push(part)
    entry.parts.sort((left, right) => left.untilTime - right.untilTime)
    entry.parts = trimParts(entry.parts, now)
    store.sessions[sessionId] = entry
    touched += 1
  }
  return touched
}

/**
 * 记下**一批**片段：加锁一次、读一次、写一次。
 *
 * 这是日报路径该用的入口。以前是逐段 appendPart —— 一次日报 N 段就是
 * N 次整份读 + N 次整份写，写成 N × 库大小（真实库 103KB 时一次总结写 720KB）。
 *
 * @returns {Promise<number>} 写进去几条
 */
export async function appendParts(records, path = storePath(), { logger, timeoutMs } = {}) {
  const list = (Array.isArray(records) ? records : [records])
    .filter((record) => record?.sessionId && record?.markdown)
  if (list.length === 0) return 0
  return withStoreLock(path, async () => {
    const before = { ...storeIO }
    // 锁内重读：不覆盖别的进程刚写进去的部分
    const store = readStore(path, { logger })
    const touched = mergeInto(store, list, Date.now())
    writeStore(store, path)
    logger?.debug?.(
      `dsh-assistant: 水位存储：${touched} 段一次写入（读 ${(storeIO.readBytes - before.readBytes) / 1024}KB / `
      + `写 ${(storeIO.writeBytes - before.writeBytes) / 1024}KB，整份读写各 1 次）`,
    )
    return touched
  }, { logger, timeoutMs })
}

/** 单段写入（测试与脚本用；日报路径走 appendParts 的批量语义）。 */
export async function appendPart(record, path = storePath(), options = {}) {
  const touched = await appendParts([record], path, options)
  return touched > 0
}

/** 读某个会话已留存的所有片段（按时间顺序）。 */
export function partsFor(sessionId, path = storePath(), options = {}) {
  return readStore(path, options).sessions[sessionId]?.parts ?? []
}

/** 一次读出多个会话的片段（日报合并前要用，别每个会话各读一遍整份文件）。 */
export function partsForMany(sessionIds, path = storePath(), options = {}) {
  const store = readStore(path, options)
  const out = new Map()
  for (const id of sessionIds) out.set(String(id), store.sessions[String(id)]?.parts ?? [])
  return out
}

/** 已总结到的水位（没有就是 0，表示从今天开始全都要总结）。 */
export function summarizedUntil(sessionId, path = storePath(), options = {}) {
  const parts = partsFor(sessionId, path, options)
  return parts.length === 0 ? 0 : parts[parts.length - 1].untilTime
}

/**
 * 跨进程互斥：`<path>.lock` 用 `wx` 独占创建。
 *
 * 只有**异步等待**这一种：以前用 `Atomics.wait` 同步自旋，实测单次 appendPart 能把宿主
 * 冻 4 秒（50ms 定时器迟到 3955ms）。那个同步版（`withStoreLockSync`）已经删掉 ——
 * 全仓库零调用点，留着就是"哪天有人图省事用了它，宿主又被冻住"。
 * 没有 await 机会的调用方请把调用点改成异步，而不是把事件循环让出去。
 *
 * 夺锁要**先确认持锁进程已经不在**；进程还活着时只有超过 LOCK_ABANDON_MS 才当它卡死。
 * 以前只看锁文件年龄，活着的持有者也会在 10 秒后被夺锁。
 */
export async function withStoreLock(path, run, { logger, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const lockPath = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, `${process.pid}\n`, 'utf8')
        return await run()
      } finally {
        closeSync(fd)
        try { unlinkSync(lockPath) } catch { /* 已经被人清掉了 */ }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (isStaleLock(lockPath)) {
        logger?.warn?.(`dsh-assistant: 水位存储的锁是陈旧的（${lockPath}），已接管`)
        try { unlinkSync(lockPath) } catch { /* 别人抢先清了 */ }
        continue
      }
      if (Date.now() >= deadline) throw new Error(`summaries 存储被占用（${lockPath}），本次放弃写入`)
      await sleep(LOCK_RETRY_MS)
    }
  }
}

/**
 * 陈旧锁判定：**先看持锁进程还在不在**，再看锁文件年龄。
 *
 * 顺序很重要：活着的持有者不该被抢 —— 只有它卡死超过 LOCK_ABANDON_MS 时才夺锁。
 */
function isStaleLock(lockPath) {
  let stat
  try {
    stat = statSync(lockPath)
  } catch {
    return true // 刚被人释放
  }
  const age = Date.now() - stat.mtimeMs

  let pid
  try {
    pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
  } catch {
    return age > LOCK_STALE_MS
  }
  if (!Number.isInteger(pid) || pid <= 0) return age > LOCK_STALE_MS

  try {
    process.kill(pid, 0) // 活着
    return age > LOCK_ABANDON_MS
  } catch (error) {
    // ESRCH = 没这个进程 → 锁是陈旧的；EPERM = 有，但不是我能管的 → 当作有人持锁
    return error?.code === 'ESRCH'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

