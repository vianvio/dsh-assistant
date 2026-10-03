/**
 * helper 子进程：启动竞态、心跳、优雅退出、自检握手。
 *
 * 真 helper 不在位时**不再静默跳过**：要么装好（仓库里本来就带了编译好的 .app），
 * 要么显式接受覆盖下降（DSH_ASSISTANT_SKIP_NATIVE=1）。理由见 test/helpers/coverage.mjs。
 * "缺 helper 只告警不抛"这条不依赖 helper，永远跑。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PetMessageKind, PetState, createMessage, decodeMessage } from '../src/protocol.js'
import { PetProcess, defaultHelperPath, helperAvailable, probeHelper, probeProtocol } from '../src/pet-process.js'
import { coverageGate } from './helpers/coverage.mjs'
import { warmHelper } from '../scripts/warm-helper.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperReady = process.platform === 'darwin' && helperAvailable()
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 原生用例开跑前先把 helper 预热一次。
 *
 * 刚构建/刚 checkout 出来的二进制首次 exec 会被系统扫描（本机实测过 166 秒），
 * 不预热的话这三条用例会以"假 helper 未就绪"失败 —— 故障指向 PetProcess，
 * 实际是冷启动。见 scripts/warm-helper.mjs。
 */
const warmed = helperReady
  ? await warmHelper(defaultHelperPath, { quiet: true })
  : { ok: false, reason: 'helper 不在位' }
if (helperReady && !warmed.ok) {
  process.stderr.write(`[process.test] helper 预热没成功：${warmed.reason}\n`)
}

/** 原生集成用例的覆盖门禁：缺 helper 时失败（或显式 opt-out），不再静默 skip。 */
const nativeGate = coverageGate(
  '原生 helper 集成用例（握手 / 心跳 / 协议一致性）',
  helperReady,
  'DSH_ASSISTANT_SKIP_NATIVE',
  `找不到可执行的 helper（${defaultHelperPath}）；仓库自带编译产物，缺了就跑 \`npm run build:helper\``,
)

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
  process.send(createMessage(PetMessageKind.NOTICE, { id: 'n1', state: PetState.SUCCESS, title: 'x', detail: 'd' }))
  process.send(createMessage(PetMessageKind.NOTICE, { id: 'n2', state: PetState.ERROR, title: 'y', detail: 'd' }))
  assert.equal(process.queue.size, 1, '同 kind 的 state 只留最后一条')
  assert.equal(process.pending.length, 2, '通知必须保序补发，不能合并')
  process.stop('test')
})

test('进程：握手 → 心跳 → 优雅退出（含状态下发）', { skip: nativeGate.skip }, async () => {
  nativeGate.check()
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
      args: fixture.args,
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
      args: fixture.args,
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
      args: fixture.args,
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
  // 假 helper 的"可执行文件"= 指向 node 本体的符号链接，脚本作为参数传进去
  // （PetProcess 支持 options.args）。
  //
  // 以前这里是 `#!/bin/sh` 的包装脚本，靠内核解释 shebang —— 实测在新写出的文件上
  // 首次 exec 会被系统扫描拖到 4–8 秒，三条用例于是间歇性变成"假 helper 未就绪"，
  // 而那句断言把故障指向了 PetProcess 而不是夹具。现在 exec 的是真二进制，没有这一步。
  symlinkSync(process.execPath, shim)

  return {
    shim,
    // spawn 的时候要带上脚本路径（shim 只是 node 本体）
    args: [script],
    log,
    received: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    // 子进程可能还在写日志（stop 是异步的），删不掉就重试几次，别让清理掩盖断言
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

test('握手自检：probeHelper 能跑通 ready → pong', { skip: nativeGate.skip }, async () => {
  nativeGate.check()
  const result = await probeHelper(defaultHelperPath, { assetRoot: resolve(root, 'assets', 'pack'), timeoutMs: 10000 })
  assert.equal(result.ok, true, `probe 失败: ${result.reason}`)
  assert.ok(result.seen.includes(PetMessageKind.READY))
  assert.ok(result.seen.includes(PetMessageKind.PONG))
})

test('协议一致性：宿主能发的每种消息都被 helper 认下', { skip: nativeGate.skip }, async () => {
  nativeGate.check()
  const result = await probeProtocol(defaultHelperPath, { assetRoot: resolve(root, 'assets', 'pack'), timeoutMs: 10000 })
  assert.equal(result.ok, true, `协议漂移: ${result.reason} ${JSON.stringify(result.errors)}`)
  assert.deepEqual(result.errors, [], '不该出现任何 unknown kind 回执')
  // 总结消息必须被真正处理（回执），否则"生成日报"会静默失败
  assert.ok(result.seen.includes(PetMessageKind.PONG))
})

test('协议一致性：检测器真的能发现漂移（不认的 kind 会回 error）', { skip: nativeGate.skip }, async () => {
  nativeGate.check()
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

test('进程：helper 路径的解析规则只有一处（显式 > 环境变量 > 默认）', async () => {
  const { resolveHelperPath, defaultHelperPath } = await import('../src/pet-process.js')
  const original = process.env.DSH_ASSISTANT_HELPER
  try {
    delete process.env.DSH_ASSISTANT_HELPER
    assert.equal(resolveHelperPath(), defaultHelperPath, '没有显式路径、没有环境变量 → 用默认')
    assert.equal(resolveHelperPath('/tmp/explicit'), '/tmp/explicit', '显式路径最优先')

    process.env.DSH_ASSISTANT_HELPER = '/tmp/from-env'
    assert.equal(resolveHelperPath(), '/tmp/from-env', '环境变量次之')
    assert.equal(resolveHelperPath('/tmp/explicit'), '/tmp/explicit', '显式路径仍然压过环境变量')
  } finally {
    if (original === undefined) delete process.env.DSH_ASSISTANT_HELPER
    else process.env.DSH_ASSISTANT_HELPER = original
  }
})

test('进程：显式给了 helperPath 时，环境变量不该把宠物挡在门外', async () => {
  const { mountPet } = await import('../src/pet.js')
  const { createMemoryScope, defaults } = await import('../src/pet-settings.js')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'pet-explicit-helper-'))
  const script = join(dir, 'fake-helper.mjs')
  writeFileSync(script, 'process.stdout.write(JSON.stringify({ v: 1, kind: "ready" }) + "\\n")\nsetInterval(() => {}, 1000)\n')

  const original = process.env.DSH_ASSISTANT_HELPER
  process.env.DSH_ASSISTANT_HELPER = '/nonexistent/helper' // 环境变量指向不存在的东西
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
      return () => {}
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
    let running = false
    for (let index = 0; index < 40 && !running; index += 1) {
      await new Promise((done) => setTimeout(done, 50))
      running = pet.isRunning
    }
    assert.equal(running, true, '显式 helperPath 必须生效（以前会被"按默认路径判可用"的提前返回挡掉）')
  } finally {
    pet.stop()
    if (original === undefined) delete process.env.DSH_ASSISTANT_HELPER
    else process.env.DSH_ASSISTANT_HELPER = original
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
