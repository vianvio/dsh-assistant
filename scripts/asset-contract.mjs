/**
 * 素材包契约（v4）—— **唯一判据**。
 *
 * 为什么单独抽一个模块：同一条契约以前被写了两遍，阈值还不一样 ——
 * `scripts/verify.mjs` 只判「这个状态/动作有没有素材」（`length === 0`），
 * `test/assets.test.mjs` 要求「至少两张」（原生端要随机挑，只有一张挑不动）。
 * 于是把 `actions.pat` 从 5 张削到 1 张时：`npm run verify` 绿灯、
 * `npm test` 报错 —— 用户照着自检的绿灯以为包没问题。
 *
 * 现在两边都调 `checkAssetPack()`：改阈值只改这里一处，两条路径不可能再分叉。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export const ASSET_PACK_FORMAT = 4

/** 同状态/同动作至少要有这么多张素材 —— 原生端要「随机挑一张，且避开当前这张」。 */
export const MIN_VARIANTS = 2

/** 素材包里的状态键（原生端 PetState 的镜像，由 test/vocabulary.test.mjs 守卫一致性）。 */
export const PACK_STATES = Object.freeze([
  'IDLE', 'THINKING', 'WORKING', 'WAITING', 'SUCCESS', 'ERROR', 'DISCONNECTED',
])

/** 气泡带最小高度（低于这个值，两行气泡会压到角色） */
export const MIN_BUBBLE_BAND = 60

/**
 * 读素材包并跑完所有契约检查。
 *
 * @param {string} root 仓库根（素材包在 `<root>/assets/pack`）
 * @returns {{ problems: string[], manifest: object|null, stats: object }}
 */
export function checkAssetPack(root) {
  const problems = []
  const manifestPath = resolve(root, 'assets', 'pack', 'pet-manifest.json')
  const packDir = resolve(root, 'assets', 'pack')

  if (!existsSync(manifestPath)) {
    return { problems: ['缺少素材包 assets/pack/pet-manifest.json —— 运行 `npm run build:helper` 之前先跑 `npm run build:pack`'], manifest: null, stats: {} }
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { problems: [`素材包 manifest 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`], manifest: null, stats: {} }
  }

  if (manifest.formatVersion !== ASSET_PACK_FORMAT) {
    problems.push(`素材包格式版本是 ${manifest.formatVersion}，期望 ${ASSET_PACK_FORMAT} —— 重新运行 \`npm run build:pack\``)
  }
  if (!(Number(manifest.bubbleBand) >= MIN_BUBBLE_BAND)) {
    problems.push(`bubbleBand=${manifest.bubbleBand} 小于 ${MIN_BUBBLE_BAND} —— 两行气泡会压到角色`)
  }

  const clips = Object.keys(manifest.clips ?? {})
  const heights = new Set()
  const widths = []
  let animated = 0
  let staticClips = 0
  let frames = 0
  let bytes = 0

  for (const [clip, spec] of Object.entries(manifest.clips ?? {})) {
    if (!(spec.width > 0) || !(spec.height > 0)) problems.push(`${clip} 缺少像素尺寸`)
    if (!Number.isFinite(spec.top) || spec.top < 0) problems.push(`${clip} 缺少头顶位置 top`)
    heights.add(spec.height)
    widths.push(spec.width)

    const count = Number(spec.count ?? 0)
    if (count > 1) {
      animated += 1
      if (!(spec.frameMs > 0)) problems.push(`${clip} 是序列帧但没写 frameMs`)
      for (let index = 1; index <= count; index += 1) {
        const frame = resolve(packDir, spec.dir, `${spec.prefix}_${String(index).padStart(3, '0')}.webp`)
        if (existsSync(frame)) { bytes += statSync(frame).size; frames += 1 } else { problems.push(`缺帧: ${clip} ${index}/${count}`) }
      }
    } else {
      staticClips += 1
      const file = resolve(packDir, spec.file ?? '')
      if (existsSync(file)) { bytes += statSync(file).size; frames += 1 } else { problems.push(`素材缺失: ${clip} -> ${spec.file}`) }
    }
  }

  if (heights.size > 1) problems.push(`素材高度不一致: ${[...heights].join('/')} —— 切图会跳大小`)
  if (new Set(widths).size <= 5) problems.push('素材宽度没有随原图比例变化（被拉成同一宽度了？）')
  if (widths.length && Math.max(...widths) > (manifest.canvas?.width ?? Infinity) + 1) {
    problems.push(`素材宽度 ${Math.max(...widths)} 超过参考画布 ${manifest.canvas?.width}`)
  }

  // 状态与动作：**至少 MIN_VARIANTS 张**，且引用的 clip 必须在 clips 里
  let variants = 0
  for (const state of PACK_STATES) {
    const list = manifest.states?.[state] ?? []
    if (list.length < MIN_VARIANTS) problems.push(`states.${state} 只有 ${list.length} 张素材（至少 ${MIN_VARIANTS} 张才能「随机挑」）`)
    for (const clip of list) if (!clips.includes(clip)) problems.push(`states.${state} 指向不存在的 clip: ${clip}`)
    variants += list.length
  }
  for (const [action, list] of Object.entries(manifest.actions ?? {})) {
    if (list.length < MIN_VARIANTS) problems.push(`actions.${action} 只有 ${list.length} 张素材（至少 ${MIN_VARIANTS} 张才能「随机挑」）`)
    for (const clip of list) if (!clips.includes(clip)) problems.push(`actions.${action} 指向不存在的 clip: ${clip}`)
  }

  return {
    problems,
    manifest,
    stats: {
      clips: clips.length, animated, staticClips, frames, bytes, variants,
      heights: [...heights],
      minWidth: widths.length ? Math.min(...widths) : 0,
      maxWidth: widths.length ? Math.max(...widths) : 0,
      actions: Object.keys(manifest.actions ?? {}).length,
    },
  }
}
