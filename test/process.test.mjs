/**
 * helper 子进程：启动竞态、心跳、优雅退出、自检握手。
 *
 * 真 helper 不存在时（非 macOS / 未编译）自动跳过集成用例，
 * 但"缺 helper 只告警不抛"这条必须永远成立。
 */

import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PetMessageKind, PetState, createMessage, decodeMessage } from '../src/protocol.js'
import { PetProcess, defaultHelperPath, helperAvailable, probeHelper, probeProtocol } from '../src/pet-process.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperReady = process.platform === 'darwin' && helperAvailable()
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

test('进程：helper 缺失时只告警、不抛异常', () => {
  const warnings = []
  const process = new PetProcess(
    { helperPath: '/nonexistent/dsh-assistant-helper', assetRoot: resolve(root, 'assets', 'pack') },
    { ...quiet, warn: (message) => warnings.push(String(message)) },
  )
  assert.equal(process.start(), undefined)
  assert.equal(process.isRunning, false)
  assert.ok(warnings.some((line) => /build:helper/.test(line)))
  process.stop('test')
})

test('进程：未就绪时的消息按类型合并且不丢', () => {
  const process = new PetProcess({ helperPath: '/nonexistent/dsh-assistant-helper' }, quiet)
  // 通过队列观察排队策略（这里不发真进程，只看内部账本）
  process.send(createMessage(PetMessageKind.STATE, { state: PetState.IDLE, message: 'a' }))
  process.send(createMessage(PetMessageKind.STATE, { state: PetState.WORKING, message: 'b' }))
  process.send(createMessage(PetMessageKind.NOTICE, { id: 'n1', title: 'x' }))
  process.send(createMessage(PetMessageKind.NOTICE, { id: 'n2', title: 'y' }))
  assert.equal(process.queue.size, 1, '同 kind 的 state 只留最后一条')
  assert.equal(process.pending.length, 2, '通知必须保序补发，不能合并')
  process.stop('test')
})

test('进程：握手 → 心跳 → 优雅退出（含状态下发）', { skip: !helperReady }, async () => {
  const heartbeats = []
  const process = new PetProcess({
    assetRoot: resolve(root, 'assets', 'pack'),
    helperPath: defaultHelperPath,
    heartbeatMs: 600,
    onHeartbeat: (beat) => heartbeats.push(beat),
  }, quiet)

  process.start()
  process.send(createMessage(PetMessageKind.HELLO, { label: '测试宠' }))
  process.send(createMessage(PetMessageKind.STATE, { state: PetState.THINKING, message: '自检' }))

  assert.ok(await waitFor(() => process.isRunning, 8000), 'helper 未在 8s 内就绪')
  // 心跳：连续两次 pong 才算通道稳定（首次可能赶上 helper 启动抖动）
  assert.ok(await waitFor(() => heartbeats.length >= 2, 8000), `心跳不足: ${heartbeats.length}`)
  assert.ok(heartbeats.at(-1).latencyMs >= 0)
  assert.equal(process.heartbeat.pongs >= 2, true)

  process.stop('test-done')
  assert.ok(await waitFor(() => !process.child, 6000), 'stop 后进程应已退出')
})

test('握手自检：probeHelper 能跑通 ready → pong', { skip: !helperReady }, async () => {
  const result = await probeHelper(defaultHelperPath, { assetRoot: resolve(root, 'assets', 'pack'), timeoutMs: 10000 })
  assert.equal(result.ok, true, `probe 失败: ${result.reason}`)
  assert.ok(result.seen.includes(PetMessageKind.READY))
  assert.ok(result.seen.includes(PetMessageKind.PONG))
})

test('协议一致性：宿主能发的每种消息都被 helper 认下', { skip: !helperReady }, async () => {
  const result = await probeProtocol(defaultHelperPath, { assetRoot: resolve(root, 'assets', 'pack'), timeoutMs: 10000 })
  assert.equal(result.ok, true, `协议漂移: ${result.reason} ${JSON.stringify(result.errors)}`)
  assert.deepEqual(result.errors, [], '不该出现任何 unknown kind 回执')
  // 总结消息必须被真正处理（回执），否则"生成日报"会静默失败
  assert.ok(result.seen.includes(PetMessageKind.PONG))
})

test('协议一致性：检测器真的能发现漂移（不认的 kind 会回 error）', { skip: !helperReady }, async () => {
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const { encodeMessage } = await import('../src/protocol.js')
  const child = spawn(defaultHelperPath, ['--headless'], {
    env: { ...process.env, DSH_ASSISTANT_ASSET_ROOT: resolve(root, 'assets', 'pack') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const replies = []
  await new Promise((done) => {
    const timer = setTimeout(done, 8000)
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = decodeMessage(line)
      if (!message) return
      replies.push(message)
      if (message.kind === PetMessageKind.READY) {
        // 故意发一条宿主永远不会发的 kind：只能用裸 JSON（encodeMessage 会先拦住它）
        child.stdin.write(`${JSON.stringify({ v: 1, kind: 'no-such-kind' })}\n`)
        child.stdin.write(encodeMessage({ v: 1, kind: PetMessageKind.SHUTDOWN, reason: 'x' }))
      }
      if (message.kind === PetMessageKind.CLOSED) {
        clearTimeout(timer)
        done()
      }
    })
  })
  child.kill()
  assert.ok(replies.some((message) => message.kind === 'error'), '不认识的 kind 必须回 error，否则自检是假绿')
})

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  return new Promise((done) => {
    const tick = () => {
      if (predicate()) return done(true)
      if (Date.now() - started > timeoutMs) return done(false)
      setTimeout(tick, 40)
    }
    tick()
  })
}
