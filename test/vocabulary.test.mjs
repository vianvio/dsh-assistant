/**
 * 词表守卫：**同一条词表在多个面各写一遍时，必须有一条测试把它们绑在一起**。
 *
 * 背景（代码审计）：七个状态在本仓库里有 10 份副本、动作词表有 4 份，
 * 但它们之间**没有任何机制**保证一致 —— `test/assets.test.mjs` 自己硬编码了一份
 * 状态名数组，改 `src/protocol.js` 的 PetState 或 `native/Sources/PetState.swift`
 * 的 case 都不会让它失败。今天恰好一致，明天未必。
 *
 * 这份测试把"哪些面必须等于同一份词表"写死，任何一面改了名字就会红在这里，
 * 而不是等到桌面上某个状态静默退化。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PetState } from '../src/protocol.js'
import { SessionEventKind, isKnownEvent } from '../src/events.js'
import { INTERACTIONS } from '../src/pet-interactions.js'
import { PRIORITY } from '../src/pet-reducer.js'
import { TRANSITIONS } from '../src/state-machine.js'
import { STATE_GLYPH, rosterLine } from '../src/pet-copy.js'
import { PACK_STATES } from '../scripts/asset-contract.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/** 权威：宿主协议里的状态全集。 */
const AUTHORITATIVE = Object.keys(PetState)
const sorted = (list) => [...list].sort()

test('词表：七个状态在所有面都是同一份（原生 / 素材包 / 文案 / 状态机 / 优先级）', () => {
  const faces = {
    '宿主 protocol.js': AUTHORITATIVE,
    '原生 PetState.swift': swiftStateCases(),
    '素材包 states 表': Object.keys(JSON.parse(read('assets/pack/pet-manifest.json')).states ?? {}),
    '素材包副本（.app 内）': Object.keys(JSON.parse(read('runtime/bin/darwin/dsh-assistant-helper.app/Contents/Resources/pet-manifest.json')).states ?? {}),
    '气泡图标 STATE_GLYPH': Object.keys(STATE_GLYPH),
    '选主角优先级 PRIORITY': Object.keys(PRIORITY),
    '状态机迁移表 TRANSITIONS': Object.keys(TRANSITIONS),
    '素材契约 PACK_STATES': PACK_STATES,
    '构建脚本 petgen_lib.py': pythonStateSet(),
  }
  for (const [name, list] of Object.entries(faces)) {
    assert.deepEqual(sorted(list), sorted(AUTHORITATIVE), `${name} 与权威词表不一致`)
  }
})

test('词表：动作在宿主台词表与素材包里是同一组', () => {
  const pack = JSON.parse(read('assets/pack/pet-manifest.json'))
  const hostActions = Object.keys(INTERACTIONS)
  assert.deepEqual(sorted(Object.keys(pack.actions ?? {})), sorted(hostActions),
    '素材包 actions 与宿主 INTERACTIONS 必须一一对应')
  // 原生端的"可自动触发动作"是宿主台词表的子集（键名要能对上，否则点了没反应）
  for (const action of ['feed', 'praise', 'pat']) {
    assert.ok(hostActions.includes(action), `自动互动会用到的动作 ${action} 必须存在于台词表`)
  }
})

test('词表：未知状态不能长得像已知状态（图标兜底不复用 DISCONNECTED）', () => {
  const unknown = rosterLine([{ name: 'proj', state: 'NEW_STATE_8' }])
  const disconnected = rosterLine([{ name: 'proj', state: 'DISCONNECTED' }])
  assert.notEqual(unknown, disconnected, '拼错的状态名会静默显示成"失联"')
  assert.match(unknown, /\?/u, '未知状态要有醒目的兜底符号')
})

/** 从 native/Sources/PetState.swift 里抠出 `case xxx = "NAME"`。 */
function swiftStateCases() {
  const source = read('native/Sources/PetState.swift')
  return [...source.matchAll(/case\s+\w+\s*=\s*"([A-Z_]+)"/gu)].map((match) => match[1])
}

/** 从 scripts/petgen_lib.py 里抠出状态集合（frozenset({...}) 或 list 字面量）。 */
function pythonStateSet() {
  const source = read('scripts/petgen_lib.py')
  const block = /KNOWN_STATES\s*=\s*frozenset\(\s*\{([^}]*)\}/u.exec(source)
  assert.ok(block, '在 petgen_lib.py 里找不到 KNOWN_STATES 定义')
  return [...block[1].matchAll(/"([A-Z_]+)"/gu)].map((match) => match[1])
}

test('词表：事件类型清单覆盖生产在用的每一种（不能再用裸字面量绕过枚举）', () => {
  const kinds = Object.values(SessionEventKind)
  assert.ok(kinds.includes('compaction/end'), '自动压缩结束的类型必须在枚举里（它决定后台提炼是否触发）')

  // 用法侧不许再拿裸字面量判事件类型：漏改一个就是静默读不到正文
  const offenders = []
  for (const file of [
    'src/pet.js', 'src/pet-summary-corpus.js', 'src/pet-summary-digest.js', 'src/pet-summary-agent.js',
    'scripts/verify.mjs', 'scripts/probe.mjs', 'scripts/inspect-report.mjs',
  ]) {
    const source = read(file)
    for (const match of source.matchAll(/(?:type\s*[!=]==?\s*|case\s+)'((?:turn|step|tool|todo|approval|user|assistant|compaction)\/[a-z-]+)'/gu)) {
      offenders.push(`${file}: ${match[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `这些地方应该用 SessionEventKind：\n  ${offenders.join('\n  ')}`)

  // isKnownEvent 只对枚举里的类型返回 true
  assert.equal(isKnownEvent('compaction/end'), true)
  assert.equal(isKnownEvent('nope/nope'), false)
})

test('文案归属：领域层不产出用户可见字符串，气泡与朗读文案各有归属且覆盖全部状态', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { stageCopy, machineCopy } = await import('../src/pet-copy.js')

  // ① 领域层（状态机）不许 import 文案层
  const machine = readFileSync(join(process.cwd(), 'src', 'state-machine.js'), 'utf8')
  assert.ok(!/from '\.\/pet-copy\.js'/u.test(machine), 'state-machine 不该依赖文案层')
  assert.ok(!/statusCopy|activityCopy/u.test(machine), '状态机只产出语义键，不产出句子')

  // ② 语义键 → 句子只有展示层做；未知键要有兜底而不是空白
  assert.equal(stageCopy('analyzing'), '分析阶段')
  assert.equal(stageCopy('没这个键'), '处理阶段')
  assert.ok(machineCopy({ group: 'waiting' }, 0).length > 0)

  // ③ 原生端的朗读文案（PetState.label）与宿主的气泡文案：两套措辞是**有意**不同的，
  //    但必须覆盖同一批状态 —— 以前没有任何东西保证"新增一个状态时两边都补了文案"。
  const swift = readFileSync(join(process.cwd(), 'native', 'Sources', 'PetState.swift'), 'utf8')
  const labels = [...swift.matchAll(/case \.\w+: return "([^"]+)"/gu)].map((match) => match[1])
  assert.equal(labels.length, 7, `原生朗读文案要覆盖七个状态，实际 ${labels.length} 个`)
  for (const label of labels) assert.ok(label.trim().length > 0, '朗读文案不能为空')

  // 气泡侧：每个状态都要能说出话（rosterLine/状态机都会用到）
  for (const state of AUTHORITATIVE) {
    assert.ok(STATE_GLYPH[state], `${state} 缺气泡图标`)
  }
})
