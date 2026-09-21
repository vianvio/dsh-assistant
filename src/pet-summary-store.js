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
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const VERSION = 1

const EMPTY = () => ({ version: VERSION, sessions: {} })

/** 存储路径：可用 DSH_ASSISTANT_SUMMARY_STORE 覆盖（测试/多 profile 用）。 */
export function storePath(env = process.env) {
  if (env.DSH_ASSISTANT_SUMMARY_STORE) return env.DSH_ASSISTANT_SUMMARY_STORE
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-assistant', 'summaries.json')
}

export function readStore(path = storePath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version === VERSION && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed
    }
  } catch {
    // 文件不存在 / 损坏都按空处理：总结是"锦上添花"，不能因为它读不出来就报错
  }
  return EMPTY()
}

/** 原子写：先写同目录临时文件再 rename —— 中断只会留下旧的完整文件，不会留半个 JSON。 */
export function writeStore(store, path = storePath()) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
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
  const store = readStore(path)
  const entry = store.sessions[sessionId] ?? { title, cwd, parts: [] }
  entry.title = title ?? entry.title
  entry.cwd = cwd ?? entry.cwd
  // 同一水位重复写入时覆盖（压缩可能重复触发），避免拼接出重复内容
  const existing = entry.parts.findIndex((part) => part.untilTime === untilTime)
  const part = { untilTime, markdown, ts: Date.now() }
  if (existing >= 0) entry.parts[existing] = part
  else entry.parts.push(part)
  entry.parts.sort((left, right) => left.untilTime - right.untilTime)
  store.sessions[sessionId] = entry
  writeStore(store, path)
  return true
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
