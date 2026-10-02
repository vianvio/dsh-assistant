/**
 * helper 子进程：启动竞态、心跳、优雅退出、自检握手。
 *
 * 真 helper 不存在时（非 macOS / 未编译）自动跳过集成用例，
 * 但"缺 helper 只告警不抛"这条必须永远成立。
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
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

// ─────────────────────────────────────────────────────────────────────────────
// 下面三组用「假 helper」跑：协议的坑（写阻塞、心跳误判、重启补快照）
// 不该只能靠真 helper + 观察桌面才能发现，而在 CI 里它们必须是确定性用例。
// ─────────────────────────────────────────────────────────────────────────────

test('进程：写阻塞标记换进程后必须复位（否则重启也救不回来）', async () => {
  const fixture = makeFakeHelper({ readDelayMs: 1500 })
  try {
    const process_ = new PetProcess({
      helperPath: fixture.shim,
      heartbeatMs: 4000,
      restartDelayMs: 30,
      env: { FAKE_HELPER_LOG: fixture.log },
    }, quiet)

    process_.start()
    assert.ok(await waitFor(() => process_.isRunning, 5000), '假 helper 未就绪')
    const firstPid = process_.pid

    // 对端还堵在 readDelayMs 里没读 stdin → 这条大消息必然触发背压
    process_.send(createMessage(PetMessageKind.SUMMARY, { title: '压测', markdown: 'x'.repeat(512 * 1024) }))
    assert.ok(
      await waitFor(() => process_.writeBlocked === true, 2000),
      '大消息没触发背压，用例失去意义',
    )

    // 心跳超时那条路：宿主把 helper 杀掉，换个新的
    process_.child.kill()
    assert.ok(
      await waitFor(() => process_.isRunning && process_.pid !== firstPid, 6000),
      'helper 没有重启',
    )

    // 新 helper 是好的：ping 必须真的写进去（旧实现里它一条都收不到）
    process_.send(createMessage(PetMessageKind.PING, { ts: Date.now() }))
    assert.ok(
      await waitFor(() => fixture.received().some((line) => line.includes('"ping"')), 5000),
      `新 helper 一条消息都没收到：${JSON.stringify(fixture.received())}`,
    )
    assert.ok(await waitFor(() => process_.heartbeat.pongs >= 1, 3000), '通道没有恢复（收不到 pong）')
    process_.stop('test')
  } finally {
    fixture.cleanup()
  }
})

test('进程：宿主自己被卡住时，不该把健康的 helper 判死', async () => {
  const fixture = makeFakeHelper({ readDelayMs: 0 })
  const warnings = []
  try {
    const process_ = new PetProcess({
      helperPath: fixture.shim,
      heartbeatMs: 100,
      heartbeatTimeoutMs: 200,
      restartDelayMs: 30,
      env: { FAKE_HELPER_LOG: fixture.log },
    }, { ...quiet, warn: (message) => warnings.push(String(message)) })

    process_.start()
    assert.ok(await waitFor(() => process_.isRunning, 5000), '假 helper 未就绪')
    const pid = process_.pid
    assert.ok(await waitFor(() => process_.heartbeat.pongs >= 1, 3000), '心跳没起来')

    // 同步占住事件循环 500ms（> 2×interval）：真实世界对应"主线程在跑重活"
    const until = Date.now() + 500
    while (Date.now() < until) { /* 忙等，故意的 */ }

    await new Promise((done) => setTimeout(done, 700))
    assert.equal(process_.pid, pid, 'helper 被误杀了：卡住的是宿主自己')
    assert.equal(
      warnings.some((line) => line.includes('心跳超时')),
      false,
      `不该报心跳超时：${warnings.join(' / ')}`,
    )
    // 恢复之后照常心跳
    const pongs = process_.heartbeat.pongs
    assert.ok(await waitFor(() => process_.heartbeat.pongs > pongs, 3000), '卡顿之后心跳没恢复')
    process_.stop('test')
  } finally {
    fixture.cleanup()
  }
})

test('进程：每次 ready 都会通知宿主补快照（换 helper 用）', async () => {
  const fixture = makeFakeHelper({ readDelayMs: 0 })
  const readyCalls = []
  try {
    const process_ = new PetProcess({
      helperPath: fixture.shim,
      heartbeatMs: 4000,
      restartDelayMs: 30,
      onReady: () => readyCalls.push(Date.now()),
      env: { FAKE_HELPER_LOG: fixture.log },
    }, quiet)

    process_.start()
    assert.ok(await waitFor(() => readyCalls.length === 1, 5000), '首次 ready 没通知宿主')
    process_.child.kill()
    assert.ok(
      await waitFor(() => readyCalls.length === 2, 6000),
      '重启后没有再次通知宿主：新 helper 会一直空着',
    )
    process_.stop('test')
  } finally {
    fixture.cleanup()
  }
})

/**
 * 假 helper：只实现协议里被测到的那几条（ready / 读 stdin 落盘 / ping → pong）。
 *
 * `readDelayMs` 用来制造"对端不读"的那段时间 —— 背压必须由它逼出来。
 * 返回的 `shim` 是 PetProcess 能直接 exec 的东西（一个 shell 包装），
 * 因为真 helper 是可执行文件，而这里只有 node 脚本。
 */
function makeFakeHelper({ readDelayMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-fake-helper-'))
  const script = join(dir, 'fake-helper.mjs')
  const shim = join(dir, 'fake-helper')
  const log = join(dir, 'received.jsonl')

  writeFileSync(script, `
import { appendFileSync } from 'node:fs'
const out = (payload) => process.stdout.write(JSON.stringify({ v: 1, ...payload }) + '\\n')
out({ kind: 'ready' })
process.stdin.setEncoding('utf8')
let buffer = ''
setTimeout(() => {
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      appendFileSync(process.env.FAKE_HELPER_LOG, line + '\\n')
      try {
        if (JSON.parse(line).kind === 'ping') out({ kind: 'pong' })
      } catch { /* 脏输入忽略 */ }
    }
  })
}, ${Number(readDelayMs)})
`)
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`)
  chmodSync(shim, 0o755)

  return {
    shim,
    log,
    received: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    // 子进程可能还在写日志（stop 是异步的），删不掉就重试几次，别让清理掩盖断言
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

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
