/**
 * pet-settings —— 配置的**唯一来源**：schema、归一化、以及"谁来存"。
 *
 * 一条规矩：宿主与设置面板必须拿到**同一个** scope。历史上有过两份
 * （mountPet 里注册的 namespace scope + 端点自己 wrap 的一份），结果是
 * 设置面板写进去的值落到另一处、永远读不到真实配置。现在 `createSettingsScope()`
 * 是唯一入口，`index.js` 装配一次，同时交给 mountPet 与本地端点。
 *
 * 三种后端，同一个接口（get / update / watch / overridden）：
 *   · DSH 设置服务（会持久化到 $DSH_HOME/settings.yaml 的 <namespace> 段）；
 *   · 内存兜底（拿不到服务，或服务拒绝注册时用：重启即丢，但不崩）；
 *   · 组合配置只读兜底（settings 服务与 schemastery 都不可用时）。
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SETTINGS_NAMESPACE = 'dsh-assistant'

/** 只有这些字段可以被设置卡 / 原生菜单改写。 */
export const WRITABLE_FIELDS = Object.freeze([
  'enabled',
  'scale',
  'bubbleEnabled',
  'bubbleTheme',
  'reducedMotion',
  'soundEnabled',
  'includeSubagents',
  'backgroundSummary',
  'autoInteract',
  'autoInteractSeconds',
])

/** 气泡配色：浅色配黑字，深色配白字。 */
export const BUBBLE_THEMES = Object.freeze(['light', 'dark'])

export const defaults = Object.freeze({
  enabled: true,
  /** 默认 40%（菜单里的"迷你"档）：素材按显示尺寸烘焙，40% ≈ 96px 高 */
  scale: 0.4,
  bubbleEnabled: true,
  bubbleTheme: 'light',
  reducedMotion: false,
  soundEnabled: false,
  includeSubagents: false,
  /** 任务后台总结：默认关（关了就是"全量重读"那条实现） */
  backgroundSummary: false,
  /** 自己找点事做：状态停留够久就随机来一次互动 */
  autoInteract: true,
  autoInteractSeconds: 10,
})

/**
 * schemastery 由 DSH profile 提供，插件自己不打包依赖，所以只能在运行时找。
 *
 * 拿不到就**不注册 namespace**（退回内存兜底），而不是塞一个假 schema ——
 * 假 schema 会在 `settings.register()` 里抛 "schema is not a function"，
 * 把整个插件一起带走（踩过）。返回 undefined 让调用方明确降级。
 */
function loadSchema() {
  const bases = [import.meta.url]
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const profile = process.env.DSH_PROFILE || 'desktop'
    bases.push(pathToFileURL(join(home, 'profiles', profile, 'package.json')).href)
    bases.push(pathToFileURL(join(home, 'profiles', 'package.json')).href)
  } catch {
    // 路径拼不出来就只用插件自身
  }
  for (const base of bases) {
    try {
      const loaded = createRequire(base)('@deepseek-ai/schemastery')
      const schema = loaded?.default ?? loaded
      if (typeof schema?.object === 'function' && typeof schema?.boolean === 'function') return schema
    } catch {
      // 换下一个位置
    }
  }
  return undefined
}

const Schema = loadSchema()

/** 配置 schema；schemastery 不可用时为 undefined（此时不注册 namespace）。 */
export const PetConfig = Schema?.object({
  enabled: Schema.boolean().default(true).description('启用桌面宠物'),
  scale: Schema.number().min(0.15).max(2).step(0.05).default(0.4).role('slider').description('宠物大小（1 = 原始尺寸；默认 0.4）'),
  bubbleEnabled: Schema.boolean().default(true).description('在宠物上方显示气泡台词'),
  bubbleTheme: Schema.union([
    Schema.const('light').description('浅色（黑字）'),
    Schema.const('dark').description('深色（白字）'),
  ]).default('light').description('气泡配色'),
  reducedMotion: Schema.boolean().default(false).description('减少程序化动效（呼吸/摆动/抖动）'),
  soundEnabled: Schema.boolean().default(false).description('任务完成或出错时播放提示音'),
  includeSubagents: Schema.boolean().default(false).description('允许子 Agent 的任务抢占宠物状态'),
  backgroundSummary: Schema.boolean()
    .default(false)
    .description('任务后台总结：会话每次压缩时后台提炼已完成的部分并留存，"今日总结"只补最后没压缩的增量再合并（不开启则每次全量重读）'),
  autoInteract: Schema.boolean()
    .default(true)
    .description('自己找点事做：任意状态停留够久就随机来一次投喂点心 / 夸夸它 / 摸摸头（浮层播放期间不打扰）'),
  autoInteractSeconds: Schema.number()
    .min(5).max(300).step(5).default(10).role('slider')
    .description('自动互动的判定间隔（秒）：每隔这么久掷一次 30% 的骰子，中了就随机挑一个动作'),
}).description('由 DSH 会话状态驱动的桌面宠物')

/** 归一化：丢掉未知字段、夹住数值范围、布尔只认 true。 */
export function publicConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    scale: clampScale(Number(config.scale ?? defaults.scale)),
    bubbleEnabled: config.bubbleEnabled !== false,
    bubbleTheme: BUBBLE_THEMES.includes(config.bubbleTheme) ? config.bubbleTheme : defaults.bubbleTheme,
    reducedMotion: config.reducedMotion === true,
    soundEnabled: config.soundEnabled === true,
    includeSubagents: config.includeSubagents === true,
    backgroundSummary: config.backgroundSummary === true,
    autoInteract: config.autoInteract !== false,
    autoInteractSeconds: clampAutoInteractSeconds(Number(config.autoInteractSeconds ?? defaults.autoInteractSeconds)),
  }
}

export function clampScale(value) {
  if (!Number.isFinite(value)) return defaults.scale
  return Math.min(2, Math.max(0.15, Math.round(value * 100) / 100))
}

/** 间隔夹在 5–300 秒；太小的值等于让宠物一直自己动，太大的值等于关掉。 */
export function clampAutoInteractSeconds(value) {
  if (!Number.isFinite(value)) return defaults.autoInteractSeconds
  return Math.min(300, Math.max(5, Math.round(value)))
}

/** 只保留白名单字段的补丁。 */
function writablePatch(patch = {}) {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => WRITABLE_FIELDS.includes(key)))
}

/** 找到 DSH 设置服务（provider）。插件上下文的 ctx.settings 与 ctx.get('settings') 等价。 */
function resolveSettingsProvider(ctx) {
  for (const source of [ctx, ctx?.root]) {
    const candidate = source?.settings ?? source?.get?.('settings')
    if (typeof candidate?.register === 'function') return candidate
  }
  return undefined
}

/**
 * 建一个配置作用域。**这是配置的唯一读写口**，宿主两端共用同一个实例。
 *
 * `overridden(field)` 回答"用户显式设过这个字段吗"，用途见 pet.js 的 configMessage()：
 * 没被用户设过的字段不下发给原生端，免得把原生菜单里调好的值冲掉。
 *
 * @returns {{ source: 'service'|'memory'|'composition', get: () => object, update: (patch: object) => Promise<object>, watch: (cb: (next: object) => void) => () => void, overridden: (field: string) => boolean }}
 */
export function createSettingsScope(ctx, compositionConfig = {}, logger = console) {
  const base = publicConfig(compositionConfig)
  const provider = resolveSettingsProvider(ctx)

  if (provider && PetConfig) {
    try {
      const scope = provider.register(SETTINGS_NAMESPACE, PetConfig, { base, applies: 'live' })
      logger.debug?.(`[dsh-assistant] 设置存储: DSH 设置服务（持久化到 ${SETTINGS_NAMESPACE} 段）`)
      return {
        source: 'service',
        get: () => publicConfig(scope.get()),
        update: async (patch) => {
          await scope.update(writablePatch(patch))
          return publicConfig(scope.get())
        },
        watch: (callback) => scope.watch((next) => callback(publicConfig(next))),
        overridden: (field) => userFields(provider).has(field),
      }
    } catch (error) {
      logger.warn?.(
        `dsh-assistant: 注册设置 namespace 失败，本次改为内存配置（重启会丢）: ${message(error)}`,
      )
    }
  } else if (!PetConfig) {
    logger.warn?.('dsh-assistant: 找不到 @deepseek-ai/schemastery，设置只能存在内存里（重启会丢）')
  }

  return createMemoryScope(base)
}

/** 内存兜底：接口与 settings scope 对齐，并自己维护 watch（原生菜单热更新靠它）。 */
export function createMemoryScope(base = defaults) {
  let current = publicConfig(base)
  const overridden = new Set()
  const watchers = new Set()
  const publish = () => {
    for (const watcher of [...watchers]) {
      try { watcher(current) } catch { /* 观察者自己炸了不影响写入 */ }
    }
  }
  return {
    source: 'memory',
    get: () => ({ ...current }),
    async update(patch) {
      const clean = writablePatch(patch)
      for (const key of Object.keys(clean)) overridden.add(key)
      current = publicConfig({ ...current, ...clean })
      publish()
      return { ...current }
    },
    watch(callback) {
      watchers.add(callback)
      return () => watchers.delete(callback)
    },
    overridden: (field) => overridden.has(field),
  }
}

/**
 * DSH 设置里该 namespace 的**用户层**有哪些字段：出现在这里 = 用户显式改过。
 *
 * `describe()` 会把每个 namespace 的 base/user 各深拷贝一份，所以一次算全量、
 * 不要每个字段查一次（拖滑块时配置会连续下发）。
 */
function userFields(provider) {
  try {
    const descriptor = provider.describe?.({ redactSecrets: true })
      ?.find?.((entry) => entry?.ns === SETTINGS_NAMESPACE)
    return new Set(descriptor?.user ? Object.keys(descriptor.user) : [])
  } catch {
    return new Set()
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
