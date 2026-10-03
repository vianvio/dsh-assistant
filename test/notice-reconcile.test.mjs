/**
 * 通知对账的**跨进程**真链路：宿主发通知 → 原生端本地丢掉 → 原生回报 id → 宿主账本跟着清。
 *
 * 为什么单独一个文件：这条用例要真的起一个 helper 子进程、并且要拿到**全部** session/event
 * 订阅者，放在大而全的 plugin.test.mjs 里容易被其它用例的假上下文干扰（试过，行为不一致）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { mountPet } from '../src/pet.js'
import { createMemoryScope, defaults } from '../src/pet-settings.js'

test('通知对账：原生上报"这些通知我这边没了" → 宿主账本跟着清', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-notice-drop-'))
  const script = join(dir, 'fake-helper.mjs')
  // 假 helper：ready → 每收到一条 notice，就把它当成"我本地丢了"回报给宿主
  writeFileSync(script, `
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
      if (message.kind === 'notice') out({ source: 'notice', action: 'notice-dropped', ids: [message.id] })
    } catch { /* 脏行忽略 */ }
  }
})
`)

  const listeners = new Map()
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }
  const ctx = {
    logger: quiet,
    root: undefined,
    get: () => undefined,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => listeners.set(event, list.filter((entry) => entry !== handler))
    },
    effect: (callback) => callback(),
  }
  ctx.root = ctx

  const pet = mountPet({
    ctx,
    settings: createMemoryScope(defaults),
    eventCtx: ctx,
    logger: quiet,
    tuning: { processOptions: { helperPath: process.execPath, args: [script], heartbeatMs: 100000 } },
  })

  try {
    await new Promise((done) => setTimeout(done, 200))
    const zones = listeners.get('session/event') ?? []
    assert.ok(zones.length > 0, '宿主必须订阅 session/event')

    const session = { header: { id: 'drop-1', origin: 'human' }, cwd: '/tmp/demo', id: 'drop-1' }
    for (const zone of zones) zone(session, { type: 'turn/start', seq: 1 })
    for (const zone of zones) zone(session, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
    const posted = pet.notices().map((notice) => notice.id)
    assert.equal(posted.length, 1, `跑完一轮应该挂一条通知（实际 ${posted.length} 条）`)

    // 假 helper 收到 notice 后立刻回报 notice-dropped → 宿主账本必须跟着清
    let cleared = false
    for (let index = 0; index < 100 && !cleared; index += 1) {
      await new Promise((done) => setTimeout(done, 50))
      cleared = pet.notices().length === 0
    }
    assert.equal(cleared, true, `宿主账本没跟着清（还挂着 ${pet.notices().map((n) => n.id).join(',')}）`)
  } finally {
    pet.stop()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('通知对账：同一段通知流，宿主账本与原生显示最终对上同一个数字', async () => {
  const { PetReducer } = await import('../src/pet-reducer.js')
  const { PetProcess, defaultAssetRoot, defaultHelperPath, helperAvailable } = await import('../src/pet-process.js')
  const { PetMessageKind, createMessage } = await import('../src/protocol.js')
  const { coverageGate } = await import('./helpers/coverage.mjs')

  const gate = coverageGate(
    '通知账本对账（需要真 helper 自报 noticeCount）',
    process.platform === 'darwin' && helperAvailable(),
    'DSH_ASSISTANT_SKIP_NATIVE',
    `找不到可执行的 helper（${defaultHelperPath}）`,
  )
  if (gate.skip) return // 显式 opt-out：这条跟着原生用例一起不跑
  gate.check()

  const reducer = new PetReducer()
  let nativeCount
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }
  const process_ = new PetProcess({
    assetRoot: defaultAssetRoot(),
    helperPath: defaultHelperPath,
    heartbeatMs: 2000,
    onMessage: (message) => {
      if (message.action === 'where') nativeCount = message.position?.noticeCount
      // 原生上报"我本地丢了这些" → 宿主账本跟着清（与 pet.js 里的规则一致）
      if (message.action === 'notice-dropped') {
        for (const id of message.ids ?? []) reducer.dismissNotice(String(id))
      }
    },
    onHeartbeat: () => {},
  }, quiet)

  process_.start()
  try {
    for (let index = 0; index < 60 && !process_.isRunning; index += 1) {
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.equal(process_.isRunning, true, 'helper 没就绪')
    process_.send(createMessage(PetMessageKind.HELLO, { label: '桌宠' }))

    const session = { header: { id: 'conv-1', origin: 'human' }, cwd: '/tmp/demo', id: 'conv-1' }
    for (let round = 0; round < 5; round += 1) {
      for (const message of reducer.handle(session, { type: 'turn/start', seq: round * 2 + 1 })) process_.send(message)
      for (const message of reducer.handle(session, { type: 'turn/end', seq: round * 2 + 2, data: { reason: { kind: 'completed' } } })) process_.send(message)
      await new Promise((done) => setTimeout(done, 250))
    }
    await new Promise((done) => setTimeout(done, 600))
    process_.send(createMessage(PetMessageKind.COMMAND, { action: 'where' }))
    for (let index = 0; index < 40 && nativeCount === undefined; index += 1) {
      await new Promise((done) => setTimeout(done, 100))
    }

    assert.equal(typeof nativeCount, 'number', '原生端没有自报 noticeCount')
    assert.equal(
      reducer.pendingNotices().length,
      nativeCount,
      `两侧数量不一致：宿主 ${reducer.pendingNotices().length} 条 / 原生显示 ${nativeCount} 条`,
    )
  } finally {
    process_.stop('test-done')
  }
})
