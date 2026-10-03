#!/usr/bin/env node
/**
 * 预热原生 helper：**首次 exec 一次，把系统扫描的代价付掉**。
 *
 * 为什么需要它：刚签出来的二进制在 macOS 上首次 exec 会被安全扫描 ——
 * 本机实测 **166 秒**（之后每次 ~20ms）。这段冷启动落在谁头上，谁就会误判：
 *
 *   · `npm run build:helper && npm run verify` → 探针 timeout，报"协议握手失败"
 *   · `npm test` 的三条原生集成用例 → "假 helper 未就绪"，把故障指向 PetProcess
 *
 * 所以预热放在**构建之后**（代价落在该付的地方），构建产物一旦热了，
 * 后续 verify / test / 真实启动都是毫秒级。
 *
 * 用法：node scripts/warm-helper.mjs [helper 路径] [最长等待秒数]
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const defaultHelperBinary = resolve(
  root, 'runtime', 'bin', 'darwin', 'dsh-assistant-helper.app', 'Contents', 'MacOS', 'dsh-assistant-helper',
)

/**
 * @param {string} [binary] helper 可执行文件
 * @param {{ timeoutMs?: number, quiet?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, ms: number, reason?: string }>}
 */
export function warmHelper(binary = defaultHelperBinary, { timeoutMs = 300_000, quiet = false } = {}) {
  return new Promise((resolveWarm) => {
    if (!existsSync(binary)) return resolveWarm({ ok: false, ms: 0, reason: 'helper 不存在' })
    const started = Date.now()
    const child = spawn(binary, ['--headless'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
      resolveWarm({ ...result, ms: Date.now() - started })
    }
    const timer = setTimeout(() => finish({ ok: false, reason: `预热超时（${timeoutMs}ms）` }), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      // ready 就说明冷启动已经过去（进程真的跑起来了）
      if (String(chunk).includes('"ready"')) finish({ ok: true })
    })
    child.on('error', (error) => finish({ ok: false, reason: error.message }))
    child.on('exit', () => finish({ ok: false, reason: '没等到 ready 就退出了' }))
    child.stdin.write('{"v":1,"kind":"ping"}\n')
    if (!quiet) process.stderr.write('[warm-helper] 预热原生 helper（首次 exec 可能要等系统扫描，几分钟内属正常）…\n')
  })
}

if (process.argv[1] && process.argv[1].endsWith('warm-helper.mjs')) {
  const binary = process.argv[2] ? resolve(process.argv[2]) : defaultHelperBinary
  const result = await warmHelper(binary)
  process.stderr.write(result.ok
    ? `[warm-helper] 就绪（首次 exec 花了 ${(result.ms / 1000).toFixed(1)}s；之后是毫秒级）\n`
    : `[warm-helper] 预热没成功：${result.reason}（不影响构建，但紧接着的 verify/test 可能超时）\n`)
  process.exit(0) // 预热失败不该让构建失败：它是加速手段，不是正确性条件
}
