/**
 * 端到端自检：素材包 → 原生 helper → 模块导入 → 协议握手 → 会话事件驱动。
 * 任何一项失败都非零退出，并给出可执行的修复命令。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultAssetRoot, defaultHelperPath, helperAvailable, probeHelper, probeProtocol } from '../src/pet-process.js'
import { PetReducer } from '../src/pet-reducer.js'
import { PetMessageKind, PetState } from '../src/protocol.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

/* ---- 1. 素材包 ---- */
const manifestPath = resolve(root, 'assets', 'pack', 'pet-manifest.json')
let manifest
if (!existsSync(manifestPath)) {
  problems.push('缺少素材包 assets/pack/pet-manifest.json —— 运行 `npm run build:pack`')
} else {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.formatVersion !== 4) problems.push('素材包格式版本不是 4 —— 重新运行 `npm run build:pack`')
  const clips = Object.keys(manifest.clips ?? {})
  let missing = 0
  let bytes = 0
  let frames = 0
  const heights = new Set()
  let animated = 0
  let staticClips = 0
  for (const [clip, spec] of Object.entries(manifest.clips ?? {})) {
    const count = Number(spec.count ?? 0)
    if (count > 1) {
      animated += 1
      // 序列帧：逐帧都要在
      for (let index = 1; index <= count; index += 1) {
        const frame = resolve(root, 'assets', 'pack', spec.dir, `${spec.prefix}_${String(index).padStart(3, '0')}.webp`)
        if (existsSync(frame)) { bytes += statSync(frame).size; frames += 1 }
        else { missing += 1; problems.push(`缺帧: ${clip} ${index}/${count}`) }
      }
    } else {
      staticClips += 1
      const file = resolve(root, 'assets', 'pack', spec.file ?? '')
      if (existsSync(file)) { bytes += statSync(file).size; frames += 1 }
      else { missing += 1; problems.push(`素材缺失: ${clip} -> ${spec.file}`) }
    }
    heights.add(spec.height)
  }
  if (heights.size > 1) problems.push(`素材高度不一致: ${[...heights].join('/')} —— 切图会跳大小`)
  if (missing === 0) {
    notes.push(`素材包: ${clips.length} 段（动画 ${animated} / 静图 ${staticClips}）/ ${frames} 帧 / 高度统一 ${[...heights][0]}px / ${(bytes / 1e6).toFixed(2)} MB`)
  }
  let variants = 0
  for (const state of ['IDLE', 'THINKING', 'WORKING', 'WAITING', 'SUCCESS', 'ERROR', 'DISCONNECTED']) {
    const list = manifest.states?.[state] ?? []
    if (list.length === 0) problems.push(`states.${state} 没有素材`)
    for (const clip of list) if (!clips.includes(clip)) problems.push(`states.${state} 指向不存在的 clip: ${clip}`)
    variants += list.length
  }
  for (const [action, list] of Object.entries(manifest.actions ?? {})) {
    if (list.length === 0) problems.push(`actions.${action} 没有素材`)
    for (const clip of list) if (!clips.includes(clip)) problems.push(`actions.${action} 指向不存在的 clip: ${clip}`)
  }
  notes.push(`状态素材: ${variants} 张（同状态多张，原生端随机挑一张；宽 ${Math.min(...Object.values(manifest.clips).map((c) => c.width))}-${Math.max(...Object.values(manifest.clips).map((c) => c.width))}px 自适应）`)
}

/* ---- 2. 原生 helper ---- */
if (!helperAvailable()) {
  problems.push(`缺少原生 helper（${defaultHelperPath}）—— 运行 \`npm run build:helper\``)
} else {
  notes.push(`原生 helper: ${(statSync(defaultHelperPath).size / 1e6).toFixed(2)} MB`)
  notes.push(`素材包解析根: ${defaultAssetRoot()}`)
}

/* ---- 3. 模块导入 ---- */
try {
  const host = await import('../src/index.js')
  notes.push(`宿主插件: ${host.name}, inject=[${host.inject.join(', ')}]`)
} catch (error) {
  problems.push(`宿主插件导入失败: ${error instanceof Error ? error.message : String(error)}`)
}

/* ---- 4. 协议握手（真实进程） ---- */
if (helperAvailable() && process.platform === 'darwin') {
  const result = await probeHelper(defaultHelperPath, { assetRoot: defaultAssetRoot(), timeoutMs: 10000 })
  if (result.ok) notes.push(`协议握手: ${result.seen.join(' → ')}`)
  else problems.push(`协议握手失败: ${result.reason ?? 'unknown'}（seen=${(result.seen ?? []).join(',')}）`)
}

/* ---- 4b. 协议一致性：宿主能发的每种消息都要被认（不能再出现"按钮点了没反应"） ---- */
if (helperAvailable() && process.platform === 'darwin') {
  const result = await probeProtocol(defaultHelperPath, { assetRoot: defaultAssetRoot(), timeoutMs: 10000 })
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
  const start = reducer.handle(session, { type: 'turn/start', seq: 1 })
  const tool = reducer.handle(session, { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1' } })
  const end = reducer.handle(session, { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
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
