/**
 * 素材包契约（v4）：统一高度、宽度自适应、同状态多素材、动作素材齐全。
 *
 * 这些是宿主与原生端都依赖的事实，素材重新导出后必须仍然成立。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(root, 'assets', 'pack', 'pet-manifest.json')

test('素材包：v4 静图/序列帧契约（统一高度、宽度自适应、多素材可选）', () => {
  assert.ok(existsSync(manifestPath), '缺少 assets/pack/pet-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.formatVersion, 4)
  assert.ok(manifest.bubbleBand >= 60, '顶部要留出气泡带')

  const heights = new Set()
  const widths = []
  for (const [clip, spec] of Object.entries(manifest.clips)) {
    const first = resolve(root, 'assets', 'pack', spec.file ?? '')
    assert.ok(existsSync(first), `缺少素材 ${clip} -> ${spec.file}`)
    assert.ok(spec.width > 0 && spec.height > 0, `${clip} 缺少像素尺寸`)
    assert.ok(Number.isFinite(spec.top) && spec.top >= 0, `${clip} 缺少头顶位置 top`)
    heights.add(spec.height)
    widths.push(spec.width)
    if (spec.count > 1) {
      for (let index = 1; index <= spec.count; index += 1) {
        const frame = resolve(root, 'assets', 'pack', spec.dir, `${spec.prefix}_${String(index).padStart(3, '0')}.webp`)
        assert.ok(existsSync(frame), `缺帧 ${clip} ${index}/${spec.count}`)
      }
      assert.ok(spec.frameMs > 0, `${clip} 是序列帧但没写 frameMs`)
    }
  }
  // 统一高度：切状态时角色大小不会跳
  assert.equal(heights.size, 1, `所有素材高度必须一致，实测 ${[...heights].join('/')}`)
  // 宽度自适应：按原图比例，不拉伸
  assert.ok(new Set(widths).size > 5, '宽度应随原图比例变化，而不是被拉成同一宽度')
  assert.ok(Math.max(...widths) <= (manifest.canvas?.width ?? Infinity) + 1, '素材宽度不应超过参考画布宽度')

  for (const state of ['IDLE', 'THINKING', 'WORKING', 'WAITING', 'SUCCESS', 'ERROR', 'DISCONNECTED']) {
    const list = manifest.states[state]
    assert.ok(Array.isArray(list) && list.length >= 2, `${state} 至少两张图才能「随机挑」`)
    for (const clip of list) assert.ok(manifest.clips[clip], `${state} 引用了不存在的素材 ${clip}`)
  }
  for (const action of ['pat', 'poke', 'feed', 'praise']) {
    assert.ok(manifest.actions[action]?.length >= 2, `动作 ${action} 的素材不足`)
  }
})
