/**
 * 跨进程宠物用例的公共脚手架：一个假 helper + 一个只实现插件用到那几件事的假 ctx。
 *
 * 为什么抽出来：`notice-reconcile` 与 `notice-open` 两条用例都要"真的起一个 helper 子进程、
 * 让它往宿主发消息"，各自抄一份假 ctx 与 spawn 参数的话，改一处（比如 ctx 少实现一个方法）
 * 另一处就会静默失真 —— 这个仓库已经为同类问题吃过一次亏。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 什么都不打印的 logger（用例只关心行为，不关心日志）。 */
export const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 假 cordis 上下文：on / effect / get 就够 mountPet 用，并暴露监听器表给用例喂事件。
 *
 * @returns {{ ctx: object, listeners: Map<string, Function[]> }}
 */
export function fakePetContext() {
  const listeners = new Map()
  const ctx = {
    logger: quietLogger,
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
  return { ctx, listeners }
}

/**
 * 写一个假 helper（Node 脚本）到临时目录。
 *
 * @param {string} body 脚本正文；stdout 里按行写 JSON 就是"原生端发消息给宿主"
 * @returns {{ dir: string, script: string, cleanup: () => void }}
 */
export function fakeHelper(body) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-helper-'))
  const script = join(dir, 'fake-helper.mjs')
  writeFileSync(script, body)
  return {
    dir,
    script,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  }
}

/** mountPet 的 tuning：把假 helper 脚本当成原生端拉起来（心跳放到很远，用例自己控制节奏）。 */
export function helperTuning(script, options = {}) {
  return { processOptions: { helperPath: process.execPath, args: [script], heartbeatMs: 100_000, ...options } }
}

/** 轮询等待条件成立（用例里避免写死 sleep 时长）。 */
export async function waitFor(predicate, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((done) => setTimeout(done, stepMs))
  }
  return predicate()
}
