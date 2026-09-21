#!/usr/bin/env node
/**
 * 交互探针：不经过 DSH，直接按脚本驱动原生宠物，用来肉眼确认渲染与动作。
 *
 *   node scripts/probe.mjs            # 走一遍状态巡游 + 全部互动动作
 *   node scripts/probe.mjs --hold 30  # 巡游结束后保持显示 30 秒
 *
 * 它用的是宿主插件同一份 PetProcess / 协议常量，所以能区分两类故障：
 * 「桌面显示不对」和「DSH 事件没喂进来」。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PetProcess, defaultAssetRoot, defaultHelperPath, helperAvailable } from '../src/pet-process.js'
import { PetMessageKind, PetState, createMessage } from '../src/protocol.js'
import { interactionMessage } from '../src/pet-interactions.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const noticeMode = process.argv.includes('--notice')
const menuMode = process.argv.includes('--menu')
// --where：问一次原生端的坐标/气泡实测尺寸（排查"气泡被压扁""窗口跑出屏幕"用）
const whereMode = process.argv.includes('--where')
const holdIndex = process.argv.indexOf('--hold')
const holdSeconds = holdIndex > 0 ? Number(process.argv[holdIndex + 1] ?? 15) : 15

if (!helperAvailable()) {
  console.error(`未找到原生 helper：${defaultHelperPath}\n先运行 npm run build:helper`)
  process.exit(1)
}

const process_ = new PetProcess({
  assetRoot: defaultAssetRoot(),
  helperPath: defaultHelperPath,
  heartbeatMs: 2000,
  onMessage: (message) => {
    if (message.kind !== PetMessageKind.INTERACTION) return
    // where 的回执带一整套几何自报，单独打出来（其余互动只报动作）
    if (message.action === 'where' && message.position) {
      console.log('  ← 原生端自报几何:')
      for (const [key, value] of Object.entries(message.position)) console.log(`      ${key}: ${value}`)
      return
    }
    console.log(`  ← 互动回传: ${message.zone ?? message.action ?? ''}`)
  },
  onHeartbeat: () => {},
}, { info() {}, warn: console.log, error: console.log, debug() {} })

process_.start()
process_.send(createMessage(PetMessageKind.HELLO, { label: '桌面宠物' }))

const tour = [
  [PetState.IDLE, '待机中，随时可以开工', 1800],
  [PetState.THINKING, '正在认真想下一步', 1800],
  [PetState.WORKING, '正在执行项目命令', 2200],
  [PetState.WAITING, '轮到你决定下一步啦', 1800],
  [PetState.ERROR, '这次没顺利跑完', 1800],
  [PetState.IDLE, '待机中', 1200],
]

for (const [state, message, wait] of tour) {
  console.log(`→ 状态 ${state}: ${message}`)
  process_.send(createMessage(PetMessageKind.STATE, { state, message, detail: `probe · ${state}` }))
  await new Promise((done) => setTimeout(done, wait))
}

if (whereMode) {
  process_.send(createMessage(PetMessageKind.COMMAND, { action: 'where' }))
  await new Promise((done) => setTimeout(done, 600))
}

if (menuMode) {
  // 复刻菜单四项的真实链路：原生 emit interaction(menu) → 宿主 interactionMessage() → overlay 回给原生。
  // 这里直接走宿主那半段（interactionMessage），确认"只带 action"的浮层能被原生播出。
  process_.send(createMessage(PetMessageKind.STATE, { state: PetState.IDLE, message: '待机中', detail: 'menu probe' }))
  for (const action of ['feed', 'poke', 'praise', 'pat']) {
    const overlay = interactionMessage(action, { seed: 7 })
    console.log(`→ 菜单动作 ${action}: ${overlay.message}`)
    process_.send(overlay)
    await new Promise((done) => setTimeout(done, 2400))
  }
}

if (noticeMode) {
  // 关键场景：状态气泡被"还在跑的项目"占着，此时另一个项目完成 —— 通知必须独立显示
  process_.send(createMessage(PetMessageKind.STATE, {
    state: PetState.WORKING, message: '2 个在跑', detail: 'research ● · agent-mesh ●',
  }))
  await new Promise((done) => setTimeout(done, 600))
  console.log('→ 完成通知（与状态气泡无关的一层）')
  process_.send(createMessage(PetMessageKind.NOTICE, {
    id: 'probe:1', project: 'dsh-assistant', state: PetState.SUCCESS,
    title: '任务完成了', detail: 'dsh-assistant · 1m20s',
  }))
  await new Promise((done) => setTimeout(done, 500))
  process_.send(createMessage(PetMessageKind.NOTICE, {
    id: 'probe:2', project: 'agent-mesh', state: PetState.ERROR,
    title: '任务出错了', detail: 'agent-mesh · 超时',
  }))
  console.log('  两条通知已挂上；点一下通知即消失')
}

console.log('→ 完成脉冲')
process_.send(createMessage(PetMessageKind.PULSE, {
  state: PetState.SUCCESS, ttlMs: 1800, message: '这一轮完成啦', resumeState: PetState.IDLE,
}))
await new Promise((done) => setTimeout(done, 2000))

// 互动：宿主只发动作语义，素材由原生端随机挑
for (const action of ['pat', 'poke', 'feed', 'praise']) {
  const overlay = interactionMessage(action, { seed: 1 })
  console.log(`→ 互动 ${action}: ${overlay.message}`)
  process_.send(overlay)
  await new Promise((done) => setTimeout(done, 1600))
}

// 多项目并行：直接喂归约后的两行文案，确认双行气泡的排版
const parallel = [
  { state: PetState.WORKING, message: '2 个在跑', detail: 'agent-mesh ● · dsh-assistant ◐' },
  { state: PetState.WAITING, message: '2 个在跑，1 个等你', detail: 'dsh-assistant ⏸ · agent-mesh ● · promo ◐' },
  { state: PetState.WORKING, message: '4 个在跑', detail: 'p1 ● · p2 ◐ · p3 ◐ +1' },
  { state: PetState.IDLE, message: '待机中，随时可以开工', detail: 'agent-mesh · 2/5 · 修复登录接口' },
]
for (const item of parallel) {
  console.log(`→ 并行: [${item.message}] / [${item.detail}]`)
  process_.send(createMessage(PetMessageKind.STATE, { ...item, detail: item.detail }))
  await new Promise((done) => setTimeout(done, 2600))
}

console.log(`巡游结束，保持显示 ${holdSeconds}s（拖动/单击/右键都能试）…`)
await new Promise((done) => setTimeout(done, holdSeconds * 1000))
process_.stop('probe-done')
await new Promise((done) => setTimeout(done, 800))
console.log('探针退出')
