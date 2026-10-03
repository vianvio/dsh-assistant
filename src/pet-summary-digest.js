/**
 * pet-summary-digest —— 会话**投影**（digest）与扫描缓存。
 *
 * 为什么要有这一层：`collectSessions` 原先把每个会话的**完整快照**留在 Map 里，
 * 而两个消费方（buildCorpus / extractDeltas）实际只用到三样东西 ——
 * 真人用户消息、助手文本、事件时间。
 *
 * 实测（本机 2026-10-02 的会话库）：179 个非子会话、解压后 **1.09 GB**、
 * 83.1 万条事件，全留在堆里约 **1.3 GB**；而真正进日报的只有 7 个会话、1.04 万条事件
 * —— **0.8%**。剩下 99% 的解析结果只是被读出来、再丢掉。
 *
 * 这里做两件事：
 *
 *   1. **投影**：读到快照就立刻折成 digest（窗口内的文本 + 最后事件时间），
 *      事件对象当场丢弃 —— 内存从 GB 级降到 MB 级；
 *
 *   2. **缓存 + 脏标记**：插件本来就订阅了每个 `session/event`，把会话标脏；
 *      下一轮扫描只重读"变过的"。全量重扫只在启动后第一轮发生一次。
 *
 * 窗口口径：两个消费方的窗口都是**今天 0 点之后**
 * （全量 = 今天；增量 = `max(今天, 水位)`，水位不可能比今天更早）。
 * 所以投影窗口取"今天"就够 —— 跨天时整份缓存作废（见 #rollover）。
 */

import { SessionEventKind } from './events.js'
import { eventText, startOfToday } from './pet-summary-corpus.js'

/**
 * 把一个会话快照投影成 digest。
 *
 * **只保留**：窗口内（> since）的真人用户消息与助手文本（带时间，保序）。
 * `lastTime` 取**所有**事件（含工具事件）的最大时间 —— 与旧实现同口径，
 * 日报按它排序、增量水位也靠它推进，少算了会让水位倒推、内容重复提炼。
 *
 * @param {{events?: Array<object>}} snapshot  `sessionQuery.readSession()` 的返回值
 * @param {{since: number}} options 窗口起点（毫秒时间戳）
 * @returns {{messages: Array<{time: number, role: 'user'|'assistant', text: string}>, lastTime: number}}
 */
export function projectSession(snapshot, { since }) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  const messages = []
  let lastTime = 0
  for (const event of events) {
    const time = typeof event?.time === 'number' ? event.time : undefined
    if (time !== undefined && time > lastTime) lastTime = time
    if (time === undefined || time <= since) continue
    if (event?.type === SessionEventKind.USER_MESSAGE) {
      // 注入的上下文（source.kind !== 'user'）不是用户打的字，不能进日报
      if (event?.data?.source?.kind !== 'user') continue
      const text = eventText(event)
      if (text) messages.push({ time, role: 'user', text })
    } else if (event?.type === SessionEventKind.ASSISTANT_MESSAGE) {
      const text = eventText(event)
      if (text) messages.push({ time, role: 'assistant', text })
    }
  }
  return { messages, lastTime }
}

/** 本地日期键（跨天时用来作废缓存）。 */
function dayKeyOf(now) {
  const date = new Date(now)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/**
 * 会话 digest 的缓存（按天有效）。
 *
 * 使用顺序：宿主在 `session/event` 里 `touch(id)`；一轮扫描开始时 `takeDirty()`
 * 取走待重读集合（**同时清空**脏集），读完用 `put()` 落进去，取用走 `get()`。
 *
 * 为什么是"扫描开始就取走"而不是"扫描结束再清"：扫描期间新到的事件应该留给**下一轮**
 *（这一轮的摘要已经不会包含它们）。反过来若扫描结束再清，就会把扫描中途标脏的会话
 * 一起抹掉 —— 那些会话这一轮读到的是旧内容。
 *
 * 漏掉的事件**不会永久丢**：水位（untilTime）是按读到的 `lastTime` 推进的，
 * 没读到的事件时间必然大于它，下一轮仍会被当作增量捞回来。
 */
export class SessionDigests {
  /**
   * @param {{now?: () => number}} [options] `now` 可注入（测试跨天用）
   */
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.dayKey = dayKeyOf(now())
    this.digests = new Map()
    this.dirty = new Set()
    this.reads = 0
    this.hits = 0
  }

  /** 投影窗口的起点（今天 0 点）。 */
  get windowStart() {
    return startOfToday(this.now())
  }

  /** 某个会话有新事件（`session/event` 订阅里调，必须每事件都调）。 */
  touch(id) {
    const key = String(id)
    if (!key) return
    this.dirty.add(key)
  }

  /** 直接查缓存（可能是 undefined / 陈旧值）。 */
  get(id) {
    return this.digests.get(String(id))
  }

  has(id) {
    return this.digests.has(String(id))
  }

  put(id, digest) {
    this.digests.set(String(id), digest)
  }

  /**
   * 扫描开始：取走"这一轮要重读"的集合，并清空脏集。
   * 跨天则整份缓存作废（投影窗口变了，旧 digest 里没有新一天的文本）。
   */
  takeDirty() {
    const today = dayKeyOf(this.now())
    if (today !== this.dayKey) {
      this.dayKey = today
      this.digests.clear()
      this.dirty.clear()
    }
    const taken = this.dirty
    this.dirty = new Set()
    return taken
  }

  /** 诊断用：缓存了几个会话、还挂着几个脏标记。 */
  get stats() {
    return { size: this.digests.size, dirty: this.dirty.size, reads: this.reads }
  }
}

/** 生产默认：一个插件实例一份缓存（由 mountPet 持有）。 */
export function createSessionDigests(options) {
  return new SessionDigests(options)
}
