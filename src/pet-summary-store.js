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
 * 并发：整份文件是**跨进程共享**的（同一台机器上桌面端 + CLI 双开时会各跑一份插件）。
 * 所以 `appendPart` 是"加锁 → 重读 → 合并 → 原子写"，并且临时文件名带进程号 ——
 * 以前固定用 `summaries.json.tmp` 且不加锁，两个写者必然互相覆盖，
 * 还会抢同一个 .tmp 抛出 ENOENT。
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
/** 锁文件老过这个时间就认为是陈旧锁（持锁进程已经没了）。 */
const LOCK_STALE_MS = 10_000

const EMPTY = () => ({ version: VERSION, sessions: {} })

/** 存储路径：可用 DSH_ASSISTANT_SUMMARY_STORE 覆盖（测试/多 profile 用）。 */
export function storePath(env = process.env) {
  if (env.DSH_ASSISTANT_SUMMARY_STORE) return env.DSH_ASSISTANT_SUMMARY_STORE
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-assistant', 'summaries.json')
}

/**
 * 读盘并**归一化**：文件不存在 / 整个 JSON 坏掉 → 空；
 * 单条记录半坏（缺 `parts`、`parts` 不是数组、片段缺 untilTime）→ 只丢那一条。
 *
 * 以前只校验到"version 对、sessions 是对象"，半坏的记录会一路传到
 * `entry.parts.findIndex` 抛 TypeError —— 之后每次总结都在同一处炸，
 * 用户只看到"总结没生成出来"。
 */
export function readStore(path = storePath()) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // 文件不存在 / 损坏都按空处理：总结是"锦上添花"，不能因为它读不出来就报错
    return EMPTY()
  }
  if (parsed?.version !== VERSION || !parsed.sessions || typeof parsed.sessions !== 'object') return EMPTY()

  const sessions = {}
  for (const [id, entry] of Object.entries(parsed.sessions)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const parts = Array.isArray(entry.parts)
      ? entry.parts.filter((part) => part && typeof part === 'object' && Number.isFinite(part.untilTime))
      : []
    sessions[id] = { title: entry.title, cwd: entry.cwd, parts }
  }
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
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return path
}

/**
 * 记下一段总结。
 * @param untilTime 这段覆盖到的**最后事件时间**（下次只总结比它更新的部分）
 */
export function appendPart({ sessionId, title, cwd, untilTime, markdown }, path = storePath()) {
  if (!sessionId || !markdown) return false
  return withStoreLock(path, () => {
    // 锁内重读：不覆盖别的进程刚写进去的部分
    const store = readStore(path)
    const entry = store.sessions[sessionId] ?? { title, cwd, parts: [] }
    entry.title = title ?? entry.title
    entry.cwd = cwd ?? entry.cwd
    if (!Array.isArray(entry.parts)) entry.parts = []
    // 同一水位重复写入时覆盖（压缩可能重复触发），避免拼接出重复内容
    const existing = entry.parts.findIndex((part) => part.untilTime === untilTime)
    const part = { untilTime, markdown, ts: Date.now() }
    if (existing >= 0) entry.parts[existing] = part
    else entry.parts.push(part)
    entry.parts.sort((left, right) => left.untilTime - right.untilTime)
    store.sessions[sessionId] = entry
    writeStore(store, path)
    return true
  })
}

/** 读某个会话已留存的所有片段（按时间顺序）。 */
export function partsFor(sessionId, path = storePath()) {
  return readStore(path).sessions[sessionId]?.parts ?? []
}

/** 已总结到的水位（没有就是 0，表示从今天开始全都要总结）。 */
export function summarizedUntil(sessionId, path = storePath()) {
  const parts = partsFor(sessionId, path)
  return parts.length === 0 ? 0 : parts[parts.length - 1].untilTime
}

/**
 * 跨进程互斥：`<path>.lock` 用 `wx` 独占创建。
 *
 * 为什么需要：桌面端与 CLI 同开时是两个进程各跑一份插件，它们读写的是同一份文件；
 * 没有锁的话"读-改-写"会互相覆盖（实测两个写者各写 120 段，最后只留下 119 + 1）。
 */
export function withStoreLock(path, run) {
  const lockPath = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, `${process.pid}\n`, 'utf8')
        return run()
      } finally {
        closeSync(fd)
        try { unlinkSync(lockPath) } catch { /* 已经被人清掉了 */ }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (isStaleLock(lockPath)) {
        try { unlinkSync(lockPath) } catch { /* 别人抢先清了 */ }
        continue
      }
      if (Date.now() >= deadline) throw new Error(`summaries 存储被占用（${lockPath}），本次放弃写入`)
      sleepSync(LOCK_RETRY_MS)
    }
  }
}

/** 陈旧锁：文件太老，或者里面的 pid 已经不在了。 */
function isStaleLock(lockPath) {
  let stat
  try {
    stat = statSync(lockPath)
  } catch {
    return true // 刚被人释放
  }
  if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) return true
    process.kill(pid, 0)
    return false
  } catch (error) {
    // ESRCH = 没这个进程；EPERM = 有，但不是我能管的 → 当成有人在持锁
    return error?.code === 'ESRCH'
  }
}

/** 同步睡一会儿（没有锁原语可用，只能自旋）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
