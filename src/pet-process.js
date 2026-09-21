/**
 * pet-process —— 原生 helper 的生命周期管理。
 *
 * 与「一次性 spawn 就完事」的做法相比，这里处理的是真实运行时会遇到的四类问题：
 *   1. **启动竞态**：ready 之前的消息必须先排队（按类型合并），就绪后补发；
 *   2. **重启风暴**：连续启动失败要退避并最终放弃，而不是无限重启；
 *   3. **僵尸残留**：DSH 退出/插件卸载时先发 shutdown，超时再 kill，
 *      同时监听 stdin 关闭，helper 自己也会退出（双保险）；
 *   4. **半死连接**：心跳 ping/pong，超时即判定掉线并重启。
 *
 * 进程模型：helper 是独立 AppKit 进程，靠 stdin/stdout 上的 JSON 行通信；
 * 它崩溃绝不影响 DSH（所有子进程通道都挂了 error 兜底）。
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COALESCED_KINDS,
  PetMessageKind,
  createMessage,
  decodeMessage,
  encodeMessage,
} from './protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

/** 随包分发的 helper（macOS）。可用 DSH_ASSISTANT_HELPER 覆盖，便于调试别的构建。 */
export const defaultHelperPath = resolve(
  packageRoot,
  'runtime',
  'bin',
  'darwin',
  'dsh-assistant-helper.app',
  'Contents',
  'MacOS',
  'dsh-assistant-helper',
)

/** 素材包目录（helper 用它找 pet-manifest.json）。 */
export function defaultAssetRoot() {
  return process.env.DSH_ASSISTANT_ASSET_ROOT || resolve(packageRoot, 'assets', 'pack')
}

/** helper 是否可用；不可用时宿主只告警、不拉起进程。 */
export function helperAvailable(helperPath = process.env.DSH_ASSISTANT_HELPER || defaultHelperPath) {
  return Boolean(helperPath) && existsSync(helperPath)
}

/** 需要合并的“快照类”消息：helper 重启后补发一份最新值即可，不必回放历史。 */
const MERGEABLE = new Set(COALESCED_KINDS)

export class PetProcess {
  /**
   * @param {object} options
   * @param {string} [options.helperPath]
   * @param {string} [options.assetRoot]
   * @param {Record<string,string>} [options.env] 额外环境变量
   * @param {(message: object) => void} [options.onMessage] helper → 宿主的消息
   * @param {object} [options.logger]
   */
  constructor(options = {}, logger = console) {
    this.options = options
    this.logger = logger
    this.child = undefined
    this.ready = false
    this.stopped = false
    this.everStarted = false
    this.failures = 0
    this.maxFailures = options.maxFailures ?? 4
    this.queue = new Map()
    this.pending = []
    this.restartTimer = undefined
    this.heartbeatTimer = undefined
    this.startupTimer = undefined
    this.lastPongAt = 0
    this.lastPingAt = 0
    this.pongs = 0
    this.writeBlocked = false
  }

  get pid() { return this.child?.pid }

  get isRunning() { return Boolean(this.child) && this.ready }

  /** 心跳观测：连续收到多少次 pong、最近一次往返耗时。 */
  get heartbeat() { return { pongs: this.pongs, latencyMs: Math.max(0, this.lastPongAt - this.lastPingAt) } }

  /** 启动（幂等）：已被显式停止或 helper 缺失时不会拉起。 */
  start() {
    if (this.child || this.stopped) return this.child
    const helperPath = this.options.helperPath ?? process.env.DSH_ASSISTANT_HELPER ?? defaultHelperPath
    if (!helperAvailable(helperPath)) {
      this.stopped = true
      this.logger.warn?.(
        `dsh-assistant: 找不到原生 helper（${helperPath}），桌面宠物已停用；`
        + '在本插件目录执行 `npm run build:helper` 后重启 DSH。',
      )
      return undefined
    }

    let child
    try {
      if (process.platform !== 'win32') {
        try { chmodSync(helperPath, 0o755) } catch { /* 最优努力 */ }
      }
      child = spawn(helperPath, this.options.args ?? [], {
        cwd: this.options.cwd ?? packageRoot,
        env: {
          ...process.env,
          ...(this.options.env ?? {}),
          DSH_ASSISTANT_ASSET_ROOT: this.options.assetRoot ?? defaultAssetRoot(),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      })
    } catch (error) {
      this.#onFailure(`spawn 异常: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }

    this.child = child
    this.ready = false
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', () => { /* 通道断裂不能冒泡到宿主 */ })
    }

    child.once('spawn', () => {
      this.everStarted = true
      this.startupTimer = setTimeout(() => {
        if (this.child === child && !this.ready) {
          this.logger.warn?.('dsh-assistant: helper 就绪超时，重启一次')
          child.kill()
        }
      }, this.options.startupTimeoutMs ?? 8000)
      this.startupTimer.unref?.()
    })

    child.once('error', (error) => {
      if (this.child !== child) return
      this.#clearTimers()
      this.child = undefined
      this.ready = false
      this.#onFailure(`启动失败: ${error.message}`)
    })

    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      const wasReady = this.ready
      this.#clearTimers()
      this.child = undefined
      this.ready = false
      if (this.stopped) return
      if (!wasReady) {
        this.#onFailure(`未就绪即退出（code=${String(code)}, signal=${String(signal)}）`)
        return
      }
      this.logger.warn?.(`dsh-assistant: helper 退出（code=${String(code)}），正在重启`)
      this.failures = 0
      this.#scheduleRestart()
    })

    createInterface({ input: child.stdout }).on('line', (line) => this.#handleLine(line))
    createInterface({ input: child.stderr }).on('line', (line) => {
      const text = line.trim()
      if (text) this.logger.debug?.(`dsh-assistant helper: ${text}`)
    })

    return child
  }

  /** 发一条消息：未就绪时按类型合并排队，就绪后补发。 */
  send(message) {
    if (this.stopped) return
    const line = encodeMessage(message)
    if (!this.isRunning) {
      if (MERGEABLE.has(message.kind)) this.queue.set(message.kind, { kind: message.kind, line })
      else this.pending.push({ kind: message.kind, line })
      return
    }
    this.#write(line)
  }

  /** 优雅停止：shutdown → 等 helper 自己退 → 超时 kill。 */
  stop(reason = 'plugin-dispose') {
    this.stopped = true
    this.#clearTimers()
    const child = this.child
    if (!child) return
    try {
      child.stdin.write(encodeMessage({ v: 1, kind: PetMessageKind.SHUTDOWN, reason }))
      if (child.stdin.writable) child.stdin.end()
    } catch { /* 已经断开 */ }
    const timer = setTimeout(() => {
      if (this.child === child) {
        this.logger.warn?.('dsh-assistant: helper 未在 3s 内退出，强制结束')
        child.kill('SIGTERM')
      }
    }, 3000)
    timer.unref?.()
  }

  // MARK: - 内部

  #write(line) {
    const child = this.child
    if (!child?.stdin?.writable || child.stdin.destroyed) return
    if (this.writeBlocked) {
      this.pending.push({ kind: 'deferred', line })
      return
    }
    if (child.stdin.write(line)) return
    this.writeBlocked = true
    child.stdin.once('drain', () => {
      this.writeBlocked = false
      this.#flush()
    })
  }

  #flush() {
    const snapshot = [...this.queue.values(), ...this.pending]
    this.queue.clear()
    this.pending = []
    for (const entry of snapshot) this.#write(entry.line)
  }

  #handleLine(line) {
    const message = decodeMessage(line)
    if (!message) return
    switch (message.kind) {
      case PetMessageKind.READY:
        if (this.ready) return
        this.ready = true
        this.lastPongAt = Date.now()
        this.#clearStartup()
        this.#flush()
        this.#startHeartbeat()
        break
      case PetMessageKind.PONG: {
        // 心跳不进业务消息通道：它只反映通道健康度，由 onHeartbeat 单独暴露
        const now = Date.now()
        const latencyMs = now - this.lastPingAt
        this.lastPongAt = now
        this.pongs += 1
        try {
          this.options.onHeartbeat?.({ latencyMs, pongs: this.pongs })
        } catch { /* 观测失败不影响通道 */ }
        return
      }
      case PetMessageKind.CLOSED:
        this.logger.info?.('dsh-assistant: helper 主动关闭，本次不再拉起')
        this.stopped = true
        break
      case PetMessageKind.ERROR:
        // helper 自己认不出的消息：说明两边协议漂移了，必须留痕（否则表现为"某个按钮没反应"）
        this.logger.warn?.(`dsh-assistant: helper 报错: ${String(message.message ?? 'unknown')}`)
        return
      default:
        break
    }
    try {
      this.options.onMessage?.(message)
    } catch (error) {
      this.logger.warn?.(`dsh-assistant: 处理 helper 消息失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #startHeartbeat() {
    const interval = this.options.heartbeatMs ?? 5000
    if (interval <= 0) return
    const timeout = this.options.heartbeatTimeoutMs ?? interval * 3
    this.heartbeatTimer = setInterval(() => {
      if (!this.isRunning) return
      if (Date.now() - this.lastPongAt > timeout) {
        this.logger.warn?.('dsh-assistant: helper 心跳超时，重启')
        this.child?.kill()
        return
      }
      this.lastPingAt = Date.now()
      this.send({ v: 1, kind: PetMessageKind.PING, ts: this.lastPingAt })
    }, interval)
    this.heartbeatTimer.unref?.()
  }

  #onFailure(reason) {
    this.failures += 1
    if (this.failures >= this.maxFailures) {
      this.stopped = true
      this.logger.error?.(`dsh-assistant: helper 连续失败 ${this.failures} 次，已放弃（${reason}）`)
      return
    }
    this.logger.warn?.(`dsh-assistant: ${reason}；${this.failures}/${this.maxFailures} 次后放弃`)
    this.#scheduleRestart()
  }

  #scheduleRestart() {
    if (this.restartTimer || this.stopped) return
    const delay = this.options.restartDelayMs ?? 800
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.start()
    }, delay)
    this.restartTimer.unref?.()
  }

  #clearStartup() {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  #clearTimers() {
    this.#clearStartup()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }
}

/** 供自检脚本复用：起一个 headless helper 走一遍握手。 */
export function probeHelper(helperPath, { assetRoot, timeoutMs = 8000 } = {}) {
  return new Promise((resolveProbe) => {
    if (!helperAvailable(helperPath)) return resolveProbe({ ok: false, reason: 'helper-missing' })
    const child = spawn(helperPath, ['--headless'], {
      env: { ...process.env, DSH_ASSISTANT_ASSET_ROOT: assetRoot ?? defaultAssetRoot() },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const seen = []
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      resolveProbe(result)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', seen }), timeoutMs)
    child.on('error', (error) => finish({ ok: false, reason: error.message, seen }))
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = decodeMessage(line)
      if (!message) return
      seen.push(message.kind)
      if (message.kind === PetMessageKind.READY) {
        child.stdin.write(encodeMessage({ v: 1, kind: PetMessageKind.HELLO, label: 'probe' }))
        child.stdin.write(encodeMessage({
          v: 1,
          kind: PetMessageKind.STATE,
          state: 'WORKING',
          message: '自检',
        }))
        child.stdin.write(encodeMessage({ v: 1, kind: PetMessageKind.PING }))
      }
      if (message.kind === PetMessageKind.PONG) {
        child.stdin.write(encodeMessage({ v: 1, kind: PetMessageKind.SHUTDOWN, reason: 'probe' }))
        finish({ ok: true, seen })
      }
    })
  })
}

/**
 * 协议一致性自检：把宿主**能发的每一种消息**都发一遍，看 helper 认不认。
 *
 * 为什么单独有这一条：握手能过只说明 ready/pong 对得上，消息名一旦漂移
 * （比如宿主改叫 `home`、原生只认 `reset-position`）握手照样是绿的，
 * 但桌面上那个按钮就是没反应。这里用 headless helper 走全量消息，
 * 任何 `error` 回执都算协议漂移。
 */
export function probeProtocol(helperPath, { assetRoot, timeoutMs = 8000 } = {}) {
  const battery = [
    createMessage(PetMessageKind.HELLO, { label: '自检', version: '0.0.0' }),
    createMessage(PetMessageKind.CONFIG, { scale: 0.4, bubbleEnabled: true, bubbleTheme: 'light' }),
    createMessage(PetMessageKind.STATE, { state: 'WORKING', message: '自检', detail: 'DSH · 自检' }),
    createMessage(PetMessageKind.PULSE, { state: 'SUCCESS', ttlMs: 100, message: '好了', resumeState: 'IDLE' }),
    createMessage(PetMessageKind.OVERLAY, { action: 'pat', message: '摸头', ttlMs: 100 }),
    createMessage(PetMessageKind.NOTICE, { id: 'self-check:1', project: '自检', state: 'SUCCESS', title: '任务完成了', detail: '自检 · ok' }),
    createMessage(PetMessageKind.NOTICE_CLEAR, { id: 'self-check:1', reason: 'done' }),
    createMessage(PetMessageKind.SUMMARY, { title: '自检', markdown: '# 自检\n- ok' }),
    createMessage(PetMessageKind.COMMAND, { action: 'home' }),
    createMessage(PetMessageKind.COMMAND, { action: 'hide' }),
    createMessage(PetMessageKind.PING),
  ]
  return new Promise((resolveProbe) => {
    if (!helperAvailable(helperPath)) return resolveProbe({ ok: false, reason: 'helper-missing' })
    const child = spawn(helperPath, ['--headless'], {
      env: { ...process.env, DSH_ASSISTANT_ASSET_ROOT: assetRoot ?? defaultAssetRoot() },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const seen = []
    const errors = []
    let sent = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      resolveProbe({ seen, errors, ...result })
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
    child.on('error', (error) => finish({ ok: false, reason: error.message }))
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = decodeMessage(line)
      if (!message) return
      seen.push(message.kind)
      if (message.kind === 'error') errors.push(String(message.message ?? 'error'))
      if (message.kind === PetMessageKind.READY && !sent) {
        sent = true
        for (const message of battery) child.stdin.write(encodeMessage(message))
      }
      if (message.kind === PetMessageKind.PONG) {
        child.stdin.write(encodeMessage({ v: 1, kind: PetMessageKind.SHUTDOWN, reason: 'self-check' }))
        finish({ ok: errors.length === 0, reason: errors.length === 0 ? undefined : 'helper 不认这些消息' })
      }
    })
  })
}
