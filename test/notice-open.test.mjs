/**
 * 「点通知 → 切会话 + 把 DSH 窗口抬到最前」的**跨进程真链路**。
 *
 * 为什么单独一个文件、而且要真起子进程：这条链路的每一段都在不同的进程/层里 ——
 *   原生（用户点了通知）→ 宿主（排队一条 open-session + 抬窗口）→ 浏览器（长轮询取命令切会话）。
 * 2026-10 那次的真实故障就出在这里：0.2 把客户端 `sessions.open()` 删了，客户端半边
 * 静默不接线，表现是"点通知没反应"，而宿主、协议、状态全都正常。
 * 所以这里用一个假 helper 把"用户点了通知"这件事真的发进来，断言宿主这一段的两个动作：
 *   ① 排队一条 `{ kind: 'open-session', sessionId }` 给客户端；
 *   ② 调一次"抬窗口"（桌面端才抬得动，见 src/pet-window.js）。
 *
 * 窗口本身的行为在 test/window.test.mjs 里单测（注入假 electron）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mountPet } from '../src/pet.js'
import { createMemoryScope, defaults } from '../src/pet-settings.js'
import { fakeHelper, fakePetContext, helperTuning, quietLogger, waitFor } from './helpers/pet-harness.mjs'

/** 假 helper：一收到宿主的 completed 通知就立刻"点"它（等价于用户点了那个气泡）。 */
const CLICKING_HELPER = `
const out = (p) => process.stdout.write(JSON.stringify({ v: 1, kind: 'interaction', ...p }) + '\\n')
process.stdout.write(JSON.stringify({ v: 1, kind: 'ready' }) + '\\n')
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const message = JSON.parse(line)
      if (message.kind === 'notice') out({ source: 'notice', action: 'notice-open-session', noticeId: message.id, sessionId: message.sessionId })
    } catch { /* 脏行忽略 */ }
  }
})
`

test('点通知：宿主排一条"打开该会话"的命令，并把 DSH 窗口抬起来', async () => {
  const helper = fakeHelper(CLICKING_HELPER)
  const { ctx, listeners } = fakePetContext()
  const raised = []
  const pet = mountPet({
    ctx,
    settings: createMemoryScope(defaults),
    eventCtx: ctx,
    logger: quietLogger,
    tuning: helperTuning(helper.script),
    raiseWindow: () => { raised.push(Date.now()); return true },
  })

  try {
    assert.ok(await waitFor(() => pet.isRunning), '假 helper 应该起来了')

    // 跑完一个回合 → 宿主挂一条完成通知 → 假 helper 立刻"点"它
    const session = { header: { id: 'session-click', origin: 'human' }, cwd: '/tmp/demo', id: 'session-click' }
    for (const zone of listeners.get('session/event') ?? []) {
      zone(session, { type: 'turn/start', seq: 1 })
      zone(session, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
    }

    assert.ok(await waitFor(() => raised.length > 0), '点了通知就必须抬窗口（否则会话切了、窗口还在别的 app 后面）')
    const command = await pet.nextCommand(2000)
    assert.equal(command?.kind, 'open-session')
    assert.equal(command?.sessionId, 'session-click', '宿主必须把"打开这个会话"排给客户端')
    assert.equal(raised.length, 1, '一次点击抬一次窗口')
  } finally {
    pet.stop()
    helper.cleanup()
  }
})

test('点通知：抬不动窗口（网页版/headless）也照常切会话', async () => {
  const helper = fakeHelper(CLICKING_HELPER)
  const { ctx, listeners } = fakePetContext()
  let attempts = 0
  const pet = mountPet({
    ctx,
    settings: createMemoryScope(defaults),
    eventCtx: ctx,
    logger: quietLogger,
    tuning: helperTuning(helper.script),
    raiseWindow: () => { attempts += 1; return false }, // 没有窗口可抬
  })

  try {
    assert.ok(await waitFor(() => pet.isRunning))
    const session = { header: { id: 'session-no-window', origin: 'human' }, cwd: '/tmp/demo', id: 'session-no-window' }
    for (const zone of listeners.get('session/event') ?? []) {
      zone(session, { type: 'turn/start', seq: 1 })
      zone(session, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
    }

    assert.ok(await waitFor(() => attempts > 0), '抬不起来也要试一次（日志里会说）')
    const command = await pet.nextCommand(2000)
    assert.equal(command?.sessionId, 'session-no-window', '切会话不该被"抬不动窗口"连累')
  } finally {
    pet.stop()
    helper.cleanup()
  }
})
