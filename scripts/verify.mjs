/**
 * 端到端自检：素材包 → 原生 helper → 模块导入 → 协议握手 → 会话事件驱动。
 * 任何一项失败都非零退出，并给出可执行的修复命令。
 */
import { existsSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkAssetPack } from './asset-contract.mjs'
import { defaultAssetRoot, defaultHelperPath, helperAvailable, probeHelper, probeProtocol } from '../src/pet-process.js'
import { PetReducer } from '../src/pet-reducer.js'
import { PetMessageKind, PetState } from '../src/protocol.js'
import { SessionEventKind } from '../src/events.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

/* ---- 1. 素材包（判据在 scripts/asset-contract.mjs，与 test/assets.test.mjs 共用同一份） ---- */
{
  const { problems: assetProblems, stats } = checkAssetPack(root)
  problems.push(...assetProblems)
  if (assetProblems.length === 0) {
    notes.push(`素材包: ${stats.clips} 段（动画 ${stats.animated} / 静图 ${stats.staticClips}）/ ${stats.frames} 帧 / 高度统一 ${stats.heights[0]}px / ${(stats.bytes / 1e6).toFixed(2)} MB`)
    notes.push(`状态素材: ${stats.variants} 张（同状态多张，原生端随机挑一张；宽 ${stats.minWidth}-${stats.maxWidth}px 自适应）`)
  }
}

/* ---- 2. 原生 helper ---- */
if (!helperAvailable()) {
  problems.push(`缺少原生 helper（${defaultHelperPath}）—— 运行 \`npm run build:helper\``)
} else {
  notes.push(`原生 helper: ${(statSync(defaultHelperPath).size / 1e6).toFixed(2)} MB`)
  notes.push(`素材包解析根: ${defaultAssetRoot()}`)
  problems.push(...staleHelperProblems())
}

/**
 * helper 是不是**当前源码**编出来的。
 *
 * 为什么要有这一条：helper 是编译产物、且进了版本库，自检以前只探这个二进制
 * —— 改了 `native/Sources/*.swift` 不重编译，`npm run test:all` 照样全绿
 * （探的是旧二进制）。这里用 mtime 兜一道：源码比二进制新就判失败。
 */
function staleHelperProblems() {
  const sources = resolve(root, 'native', 'Sources')
  if (!existsSync(sources) || !existsSync(defaultHelperPath)) return []
  let newest = ''
  let newestAt = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.swift')) {
        const at = statSync(full).mtimeMs
        if (at > newestAt) { newestAt = at; newest = full }
      }
    }
  }
  walk(sources)
  if (!newest) return []
  const builtAt = statSync(defaultHelperPath).mtimeMs
  if (newestAt > builtAt) {
    const rel = newest.slice(root.length + 1)
    return [`原生 helper 早于源码（${rel} 比二进制新）—— 二进制可能是旧的，运行 \`npm run build:helper\``]
  }
  return []
}

/* ---- 3. 模块导入 ---- */
try {
  const host = await import('../src/index.js')
  notes.push(`宿主插件: ${host.name}, inject=[${host.inject.join(', ')}]`)
} catch (error) {
  problems.push(`宿主插件导入失败: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * 探一次，失败就**再探一次**。
 *
 * 为什么：刚 `npm run build:helper` 出来的二进制，首次 exec 会被系统扫描（实测 >10s），
 * 于是自检会在"刚编译完"这个最该绿的时刻报 timeout —— 那是环境的冷启动，
 * 不是协议坏了。第二次 exec 已经是热路径，用它来判成败。
 */
async function probeWarm(run) {
  const first = await run()
  if (first.ok) return first
  const second = await run()
  return second.ok ? second : first
}

/* ---- 4. 协议握手（真实进程） ---- */
if (helperAvailable() && process.platform === 'darwin') {
  const result = await probeWarm(() => probeHelper(defaultHelperPath, { assetRoot: defaultAssetRoot(), timeoutMs: 20000 }))
  if (result.ok) notes.push(`协议握手: ${result.seen.join(' → ')}`)
  else problems.push(`协议握手失败: ${result.reason ?? 'unknown'}（seen=${(result.seen ?? []).join(',')}）`)
}

/* ---- 4b. 协议一致性：宿主能发的每种消息都要被认（不能再出现"按钮点了没反应"） ---- */
if (helperAvailable() && process.platform === 'darwin') {
  const result = await probeWarm(() => probeProtocol(defaultHelperPath, { assetRoot: defaultAssetRoot(), timeoutMs: 20000 }))
  if (result.ok) {
    notes.push(`协议一致性: ${[...new Set(result.seen)].join(' → ')}（宿主能发的消息全被认下）`)
  } else {
    problems.push(`协议一致性失败: ${result.reason ?? 'unknown'}${result.errors?.length ? `（${result.errors.join('; ')}）` : ''}`)
  }
}

/* ---- 5. 会话事件 → 状态（纯逻辑，不需要进程） ---- */
try {
  const reducer = new PetReducer()
  const session = { header: { id: 'verify', origin: 'human' }, id: 'verify', cwd: '/tmp/demo' }
  // 事件类型走枚举（不再裸写字符串）：改类型名时这里跟着一起变
  const start = reducer.handle(session, { type: SessionEventKind.TURN_START, seq: 1 })
  const tool = reducer.handle(session, { type: SessionEventKind.TOOL_CALL, seq: 2, data: { name: 'bash', callId: 'c1' } })
  const end = reducer.handle(session, { type: SessionEventKind.TURN_END, seq: 3, data: { reason: { kind: 'completed' } } })
  const states = [...start, ...tool, ...end]
    .filter((message) => message.kind === PetMessageKind.STATE)
    .map((message) => message.state)
  const expected = [PetState.THINKING, PetState.WORKING, PetState.SUCCESS].join(',')
  if (states.join(',') !== expected) {
    problems.push(`状态归约异常: ${states.join(' → ')}（期望 ${expected}）`)
  } else {
    const pulse = end.find((message) => message.kind === PetMessageKind.PULSE)
    const settled = reducer.tick(Date.now() + 5000)
    const after = settled.find((message) => message.kind === PetMessageKind.STATE)?.state
    if (after !== PetState.IDLE) problems.push(`停留态未回落: ${String(after)}`)
    notes.push(`状态归约: ${states.join(' → ')} + ${pulse?.state ?? '无脉冲'} → tick → ${after}`)
  }
} catch (error) {
  problems.push(`状态归约抛错: ${error instanceof Error ? error.message : String(error)}`)
}

console.log('dsh-assistant 自检')
for (const note of notes) console.log(`  ✓ ${note}`)
for (const problem of problems) console.error(`  ✗ ${problem}`)
if (problems.length > 0) {
  console.error(`\n未通过（${problems.length} 项）`)
  process.exit(1)
}
console.log('\n全部通过：桌面宠物可以随 DSH 启动。')
