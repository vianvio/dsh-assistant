/**
 * 素材包契约（v4）：统一高度、宽度自适应、同状态多素材、动作素材齐全。
 *
 * 判据**不在这里** —— 它和 `npm run verify` 共用 `scripts/asset-contract.mjs`。
 * 以前两边各写一遍且阈值不同（自检只判「有没有」，这里要求「至少两张」），
 * 把 actions.pat 从 5 张削到 1 张时自检绿灯、这里报错。现在只有一份阈值。
 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkAssetPack, MIN_VARIANTS, PACK_STATES } from '../scripts/asset-contract.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('素材包：v4 静图/序列帧契约（统一高度、宽度自适应、多素材可选）', () => {
  const { problems, manifest, stats } = checkAssetPack(root)
  assert.deepEqual(problems, [], `素材包不合契约：\n  ${problems.join('\n  ')}`)

  // 契约模块自身的前置也得成立，否则它就是在空转
  assert.equal(manifest.formatVersion, 4)
  assert.equal(stats.heights.length, 1, '所有素材高度必须一致，切状态才不会跳大小')
  assert.equal(PACK_STATES.length, 7)
  assert.ok(MIN_VARIANTS >= 2, '同状态低于两张就「随机挑」不动')
  assert.ok(stats.maxWidth <= (manifest.canvas?.width ?? Infinity) + 1, '素材宽度不应超过参考画布宽度')

  for (const state of PACK_STATES) {
    assert.ok(manifest.states[state].length >= MIN_VARIANTS, `${state} 素材不足`)
  }
  for (const action of Object.keys(manifest.actions)) {
    assert.ok(manifest.actions[action].length >= MIN_VARIANTS, `动作 ${action} 素材不足`)
  }
})

test('素材包：契约模块与自检共用同一份判据（阈值分叉会被这条抓住）', async () => {
  // 把 pat 削到一张：契约必须报错 —— 这条守的是「两条路径不会再各定一套阈值」
  const { problems } = checkAssetPack(root)
  assert.equal(problems.length, 0)
  const source = await import('node:fs').then((fs) => fs.readFileSync(resolve(root, 'scripts', 'verify.mjs'), 'utf8'))
  assert.ok(source.includes('checkAssetPack'), 'verify.mjs 必须调同一个契约模块')
  assert.ok(!/list\.length === 0/.test(source), 'verify.mjs 里不该再留自己的素材判据')
})
