/**
 * pet-interactions —— 互动语义：动作 → 台词。
 *
 * **不说用哪张图**：素材选择交给原生端（manifest 里每个动作对应多段素材，
 * 由 PetAnimation 随机挑），宿主只给动作名与一句话。
 *
 * 台词刻意留短：气泡第一行放不下长句。
 */

import { PetMessageKind, createMessage } from './protocol.js'

/**
 * 互动浮层至少播这么久（毫秒）。
 *
 * 动作素材都是 30 帧、循环播放，单段只有 0.9–3.0 秒；右键点一下只看一秒多会显得敷衍，
 * 所以给一个下限 —— 短片段会自己再循环一遍，长片段也不会被这次的改动截短。
 */
export const MIN_INTERACTION_MS = 4000

export const INTERACTIONS = Object.freeze({
  pat: { lines: ['再摸一下就要收费啦', '头发会乱的', '嗯…手感还行吧'], ttlMs: 4000 },
  poke: { lines: ['戳什么戳', '我在忙呢，别闹', '再戳就罢工给你看'], ttlMs: 4000 },
  feed: { lines: ['好耶，是点心', '吃一口再干活', '这个我收下了', '啊呜，啊呜..再吃一口'], ttlMs: 4400 },
  praise: { lines: ['被夸到了', '哼，算你有眼光', '那今天就多干一点'], ttlMs: 4200 },
})

/** 悬浮窗上的分区 → 互动动作。 */
export function zoneToAction(zone) {
  switch (String(zone ?? '')) {
    case 'head':
    case 'tail':
      return 'pat'
    default:
      return 'poke'
  }
}

/**
 * 从台词池里取一条。seed 直接来自 Date.now()/Math.random()，可能是负数或小数，
 * 所以先规整成非负整数再取模 —— 负数取模在 JS 里会得到负索引。
 */
export function pickLine(lines, seed = 0) {
  if (!Array.isArray(lines) || lines.length === 0) return ''
  const normalized = Math.abs(Math.trunc(Number(seed))) || 0
  return lines[normalized % lines.length]
}

/**
 * 把一次互动翻译成一条 overlay 消息。
 * @param {string} action pat / poke / feed / praise
 * @param {{ seed?: number, celebrate?: boolean }} [options]
 * @returns 未知动作返回 undefined
 */
export function interactionMessage(action, { seed = Math.random() * 1000, celebrate = false } = {}) {
  const spec = INTERACTIONS[action]
  if (!spec) return undefined
  if (action === 'pat' && celebrate) {
    return createMessage(PetMessageKind.OVERLAY, {
      action: 'praise',
      message: '诶嘿～最喜欢你了',
      ttlMs: MIN_INTERACTION_MS,
    })
  }
  return createMessage(PetMessageKind.OVERLAY, {
    action,
    message: pickLine(spec.lines, seed),
    // 夹一道下限：以后改台词表也不会不小心让某个动作一闪而过
    ttlMs: Math.max(MIN_INTERACTION_MS, spec.ttlMs),
  })
}

/**
 * 连点三次的彩蛋：windowMs 内累计三次 pat 触发一次庆祝，之后冷却 cooldownMs。
 *
 * startedAt 是时间基准，同时决定初始冷却状态：传入的基准距第一次调用越远，
 * 首次彩蛋越快可用（测试里传负数即可让 tracker 一上来就是「已就绪」）。
 */
export function createPatTracker({ windowMs = 2000, cooldownMs = 3000, startedAt = Date.now() } = {}) {
  let history = []
  let lastCelebrated = startedAt
  return function register(now = Date.now()) {
    history = history.filter((at) => now - at < windowMs)
    history.push(now)
    if (history.length >= 3 && now - lastCelebrated >= cooldownMs) {
      history = []
      lastCelebrated = now
      return true
    }
    return false
  }
}
