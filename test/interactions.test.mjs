/** 互动语义：动作 → 台词、连点彩蛋、区块映射。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PetMessageKind } from '../src/protocol.js'
import { INTERACTIONS, MIN_INTERACTION_MS, createPatTracker, interactionMessage, pickLine, zoneToAction } from '../src/pet-interactions.js'
import { copyLibrary, parallelHeadline, rosterLine, singleDetail, statusCopy } from '../src/pet-copy.js'

test('互动：每个动作都有台词与 ttl，未知动作返回 undefined', () => {
  for (const action of Object.keys(INTERACTIONS)) {
    const message = interactionMessage(action, { seed: 3 })
    assert.equal(message.kind, PetMessageKind.OVERLAY)
    assert.equal(message.action, action, '宿主只给动作语义，素材由原生端随机挑')
    assert.ok(message.message.length > 0)
    assert.ok(message.ttlMs > 0)
  }
  assert.equal(interactionMessage('unknown'), undefined)
  assert.equal(interactionMessage('home'), undefined, 'home/hide 是命令，不是浮层')
})

test('互动：浮层至少播 4 秒（含连点彩蛋那条）', () => {
  assert.equal(MIN_INTERACTION_MS, 4000)
  for (const [action, spec] of Object.entries(INTERACTIONS)) {
    assert.ok(spec.ttlMs >= MIN_INTERACTION_MS, `${action} 的 ttlMs=${spec.ttlMs} 低于下限`)
    assert.ok(interactionMessage(action, { seed: 1 }).ttlMs >= MIN_INTERACTION_MS, `${action} 下发时也要达标`)
  }
  assert.equal(interactionMessage('pat', { celebrate: true }).ttlMs, MIN_INTERACTION_MS, '彩蛋不短于下限')
  // 台词表被改小也拦得住：夹取在 interactionMessage 里
  const original = INTERACTIONS.poke.ttlMs
  try {
    INTERACTIONS.poke.ttlMs = 10
    assert.equal(interactionMessage('poke').ttlMs, MIN_INTERACTION_MS, '夹取兜住下限')
  } finally {
    INTERACTIONS.poke.ttlMs = original
  }
})

test('互动：同一个 seed 取到同一句，负 seed 也不会取到空', () => {
  assert.equal(pickLine(['a', 'b', 'c'], 4), 'b')
  assert.equal(pickLine(['a', 'b', 'c'], -4), 'b', '负数取模要规整成正索引')
  assert.equal(pickLine(['a', 'b', 'c'], 1.7), 'b')
  assert.equal(pickLine([], 1), '')
  assert.equal(pickLine(undefined, 1), '')
})

test('互动：连点三次触发彩蛋，之后重新计数', () => {
  assert.match(interactionMessage('pat', { celebrate: true }).message, /最喜欢/)
  // startedAt 取负数：等价于「这个 tracker 很久以前就建好了」，冷却已过
  const tracker = createPatTracker({ windowMs: 2000, cooldownMs: 3000, startedAt: -9999 })
  assert.equal(tracker(1000), false)
  assert.equal(tracker(1100), false)
  assert.equal(tracker(1200), true, '第三次应触发彩蛋')
  assert.equal(tracker(1300), false, '彩蛋后重新计数')
})

test('互动：分区映射到动作', () => {
  assert.equal(zoneToAction('head'), 'pat')
  assert.equal(zoneToAction('tail'), 'pat')
  assert.equal(zoneToAction('body'), 'poke')
  assert.equal(zoneToAction(undefined), 'poke')
})

test('文案：每个分组都有句子，且短到能塞进气泡', () => {
  for (const [group, lines] of Object.entries(copyLibrary)) {
    assert.ok(lines.length >= 2, `${group} 至少要两条，随机取才有变化`)
    for (const line of lines) {
      assert.ok(line.length > 0 && line.length <= 20, `${group} 的台词太长：${line}`)
    }
    assert.ok(lines.includes(statusCopy(group, 0)))
  }
  // 同一个 seed 稳定取到同一句（测试与用户都不会看到"随机闪一下"）
  assert.equal(statusCopy('working', 5), statusCopy('working', 5))
  assert.equal(statusCopy('不存在的分组', 0), copyLibrary.working[0], '未知分组落到 working')
})

test('文案：并行两行短句', () => {
  assert.equal(parallelHeadline({ running: 0, waiting: 0 }), '空闲中')
  assert.equal(parallelHeadline({ running: 3, waiting: 0 }), '3 个在跑')
  assert.equal(parallelHeadline({ running: 2, waiting: 1 }), '2 个在跑，1 个等你')
  assert.equal(parallelHeadline({ running: 0, waiting: 2 }), '2 个等你确认')

  const line = rosterLine([
    { name: 'agent-mesh', state: 'WORKING' },
    { name: 'assistant', state: 'WAITING' },
  ])
  assert.equal(line, 'agent-mesh ● · assistant ⏸')

  const many = rosterLine([
    { name: 'a', state: 'WORKING' },
    { name: 'b', state: 'IDLE' },
    { name: 'c', state: 'IDLE' },
    { name: 'd', state: 'IDLE' },
  ], { max: 3 })
  assert.match(many, /\+1$/)

  assert.equal(singleDetail({ project: 'assistant', stage: '执行阶段', progress: { completed: 1, total: 3 }, task: '修复登录接口' }),
    'assistant · 1/3 · 修复登录接口')
  assert.equal(singleDetail({ project: 'assistant', stage: '执行阶段' }), 'assistant · 执行阶段')
  assert.equal(singleDetail({}), '')
})
