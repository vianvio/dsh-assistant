/**
 * pet-settings —— 配置的**唯一来源**：字段契约、归一化、以及"谁来存"。
 *
 * 一条规矩：宿主与设置面板必须拿到**同一个** scope。历史上有过两份
 * （mountPet 里注册的 namespace scope + 端点自己 wrap 的一份），结果是
 * 设置面板写进去的值落到另一处、永远读不到真实配置。现在 `createSettingsScope()`
 * 是唯一入口，`index.js` 装配一次，同时交给 mountPet 与本地端点。
 *
 * 三条后端，同一个接口（get / update / watch / overridden）：
 *   · DSH 设置服务（持久化到 $DSH_HOME/settings.yaml 的 <namespace> 段）；
 *   · 内存兜底（拿不到服务，或服务拒绝注册时用：重启即丢，但不崩）。
 *
 * **字段契约只有 SETTINGS_FIELDS 一份**：WRITABLE_FIELDS / defaults / publicConfig /
 * schemastery schema / 兜底 schema 的 toJSON 全从它派生。以前同一份约束散在
 * schemastery 字段表、WRITABLE_FIELDS、publicConfig 的归一化表和面板 client.js 里，
 * 改一个边界要动四处（`test/settings-contract.test.mjs` 现在守着面板那份不许漂移）。
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SETTINGS_NAMESPACE = 'dsh-assistant'

/**
 * 设置面板上这块卡片/页面的显示名。
 *
 * 为什么放在契约里：结果页底部那句提示要写"在「设置 → XXX」里打开「任务后台总结」"，
 * 以前这两个名字（卡片名 + 开关名）是**手抄**进 pet-summary.js 的字符串，
 * 面板改名不会有任何测试变红。现在两个名字都从契约里取：
 * 卡片名用这个常量，开关名用 SETTINGS_FIELDS.backgroundSummary.label。
 */
export const SETTINGS_DISPLAY_NAME = 'DSH小助手'

/**
 * 设置项的**单一真源**。
 *
 * kind 决定归一化方式（见 normalizeField）：
 *   boolean —— 默认为 true 时用 `!== false`（缺省即开），默认为 false 时用 `=== true`
 *   number  —— 夹到 [min,max]，按 step 的小数位四舍五入；非有限值回默认
 *   enum    —— 不在 values 里就回默认
 */
export const SETTINGS_FIELDS = Object.freeze({
  // native: true 的字段会被下发给原生端（config 消息）。enabled / includeSubagents /
  // backgroundSummary 是宿主内部行为，原生端不认它们。
  enabled: {
    kind: 'boolean', default: true, label: '启用',
    description: '启用桌面宠物（关闭后立即收起桌面窗口）',
  },
  scale: {
    native: true,
    kind: 'number', default: 0.4, min: 0.15, max: 2, step: 0.05, role: 'slider', label: '宠物大小',
    description: '宠物大小（1 = 原始尺寸；默认 0.4，也可以用悬浮窗右键菜单换挡）',
  },
  bubbleEnabled: {
    native: true,
    kind: 'boolean', default: true, label: '显示气泡台词',
    description: '在宠物上方显示气泡台词',
  },
  bubbleTheme: {
    native: true,
    kind: 'enum', values: ['light', 'dark'], default: 'light', label: '气泡配色',
    description: '气泡配色：浅色配黑字，深色配白字',
  },
  reducedMotion: {
    native: true,
    kind: 'boolean', default: false, label: '减少动效',
    description: '减少程序化动效（呼吸/摆动/抖动）',
  },
  soundEnabled: {
    native: true,
    kind: 'boolean', default: false, label: '提示音',
    description: '任务完成或出错时播放提示音',
  },
  includeSubagents: {
    kind: 'boolean', default: false, label: '含子 Agent',
    description: '允许子 Agent 的任务抢占宠物状态',
  },
  backgroundSummary: {
    kind: 'boolean', default: false, label: '任务后台总结',
    description: '任务后台总结：会话每次压缩时后台提炼已完成的部分并留存，「今日总结」只补最后没压缩的增量再合并（不开启则每次全量重读）',
  },
  autoInteract: {
    native: true,
    kind: 'boolean', default: true, label: '自己找点事做',
    description: '自己找点事做：任意状态停留够久就随机来一次投喂点心 / 夸夸它 / 摸摸头（浮层播放期间不打扰）',
  },
  autoInteractSeconds: {
    native: true,
    kind: 'number', default: 10, min: 5, max: 300, step: 5, role: 'slider', label: '自动互动间隔',
    description: '自动互动的判定间隔（秒）：每隔这么久掷一次 30% 的骰子，中了就随机挑一个动作',
  },
})

/** 只有这些字段可以被设置卡 / 原生菜单改写（= 字段表本身）。 */
export const WRITABLE_FIELDS = Object.freeze(Object.keys(SETTINGS_FIELDS))

/**
 * 需要**下发给原生端**的字段：契约里 `native: true` 的那些。
 *
 * 以前这是 pet.js 里手写的第三个清单（7 个字段），和 WRITABLE_FIELDS（10 个）、
 * schemastery 字段表各写一遍；现在它在契约里标一次，谁也别再抄。
 */
export const NATIVE_FIELDS = Object.freeze(
  Object.entries(SETTINGS_FIELDS).filter(([, field]) => field.native === true).map(([name]) => name),
)

/** 气泡配色：浅色配黑字，深色配白字。 */
export const BUBBLE_THEMES = Object.freeze([...SETTINGS_FIELDS.bubbleTheme.values])

export const defaults = Object.freeze(
  Object.fromEntries(Object.entries(SETTINGS_FIELDS).map(([name, field]) => [name, field.default])),
)

/** 小数位数：由 step 推出来（0.05 → 2 位，5 → 0 位）。 */
function decimalsOf(step) {
  if (!Number.isFinite(step) || step <= 0) return 0
  const text = String(step)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

/**
 * 按字段契约归一化一个值 —— 范围与精度的**唯一实现**。
 * 原生端在 `native/Sources/PetConfigRules.swift` 里有一份逐值等价的实现，
 * 两侧都对着 `test/fixtures/config-normalization.json` 跑同一组用例。
 */
export function normalizeField(name, value) {
  const field = SETTINGS_FIELDS[name]
  if (!field) return undefined
  switch (field.kind) {
    case 'boolean':
      return field.default === true ? value !== false : value === true
    case 'number': {
      const number = Number(value)
      if (!Number.isFinite(number)) return field.default
      const clamped = Math.min(field.max, Math.max(field.min, number))
      const decimals = decimalsOf(field.step)
      const factor = 10 ** decimals
      return Math.round(clamped * factor) / factor
    }
    case 'enum':
      return field.values.includes(value) ? value : field.default
    default:
      return value
  }
}

/**
 * 给设置面板用的字段元数据（纯 JSON，能被端点直接发出去）。
 *
 * 面板是浏览器侧独立 bundle（只能 require('react')，不能 import 宿主模块），
 * 以前它把字段名、边界、默认值又手抄了一遍 —— 现在**从端点拿**这份，
 * 面板里一个数字都不该出现（test/settings.test.mjs 会检查这一点）。
 */
export function fieldMetadata() {
  return Object.fromEntries(Object.entries(SETTINGS_FIELDS).map(([name, field]) => {
    const entry = { kind: field.kind, default: field.default, label: field.label, description: field.description }
    if (field.kind === 'number') {
      entry.min = field.min
      entry.max = field.max
      entry.step = field.step
    }
    if (field.kind === 'enum') entry.values = [...field.values]
    return [name, entry]
  }))
}

/** 归一化：丢掉未知字段、按契约夹住每个字段。 */
export function publicConfig(config = {}) {
  const out = {}
  for (const name of WRITABLE_FIELDS) out[name] = normalizeField(name, config[name])
  return out
}

export function clampScale(value) {
  return normalizeField('scale', value)
}

/** 间隔夹在 5–300 秒；太小的值等于让宠物一直自己动，太大的值等于关掉。 */
export function clampAutoInteractSeconds(value) {
  return normalizeField('autoInteractSeconds', value)
}

/**
 * schemastery 由 DSH profile 提供，插件自己不打包依赖，所以只能在运行时找。
 *
 * 找不到**不再降级**：DSH 设置服务要的只是「一个把原始值解析成配置的函数」
 * （`dsh-settings` 的 resolve 就是 `schema(mergeLayers(base, section))`），
 * 我们的归一化函数正好符合这个形状，于是照样注册、照样读写持久化。
 * 以前这里找不到就整条服务分支跳过 —— 用户存过的设置被静默忽略、改设置不落盘，
 * 只留一句 warn（把「schema 有没有」和「存储后端用哪个」两件事绑在了一起）。
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

/** 兜底 schema：可调用（服务要的就是这个）+ toJSON（设置页要序列化）。 */
export function fallbackSchema(raw) {
  return publicConfig(raw)
}
fallbackSchema.toJSON = () => ({
  type: 'object',
  description: '由 DSH 会话状态驱动的桌面宠物',
  properties: Object.fromEntries(Object.entries(SETTINGS_FIELDS).map(([name, field]) => {
    const entry = { description: field.description, default: field.default }
    if (field.kind === 'number') {
      entry.type = 'number'
      entry.minimum = field.min
      entry.maximum = field.max
      if (field.role) entry.role = field.role
    } else if (field.kind === 'enum') {
      entry.type = 'string'
      entry.enum = [...field.values]
    } else {
      entry.type = 'boolean'
    }
    return [name, entry]
  })),
})

const Schema = loadSchema()

/** 配置 schema：schemastery 在就用它（设置页能渲染出控件），不在就用等价的可调用兜底。 */
export const PetConfig = Schema
  ? Schema.object(Object.fromEntries(Object.entries(SETTINGS_FIELDS).map(([name, field]) => {
    let node
    if (field.kind === 'number') {
      node = Schema.number().min(field.min).max(field.max)
      if (field.step) node = node.step(field.step)
      if (field.role) node = node.role(field.role)
    } else if (field.kind === 'enum') {
      node = Schema.union(field.values.map((value) => Schema.const(value).description(value)))
    } else {
      node = Schema.boolean()
    }
    return [name, node.default(field.default).description(field.description)]
  }))).description('由 DSH 会话状态驱动的桌面宠物')
  : undefined

/** 实际注册用的 schema：优先真 schemastery，缺失时用兜底（两者都可用、都能持久化）。 */
export function effectiveSchema() {
  return PetConfig ?? fallbackSchema
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
 * @param {object} ctx 插件上下文
 * @param {object} [compositionConfig] 组合补丁里的配置（base 层）
 * @param {object} [logger]
 * @param {{ schema?: Function, provider?: object }} [options] 测试注入点：
 *   schema 覆盖注册用的 schema，provider 跳过上下文探测直接给一个服务替身 ——
 *   有了它，用例不必依赖开发机 $HOME 里装没装 DSH。
 * @returns {{ source: 'service'|'memory', get: () => object, update: (patch: object) => Promise<object>, watch: (cb: (next: object) => void) => () => void, overridden: (field: string) => boolean }}
 */
export function createSettingsScope(ctx, compositionConfig = {}, logger = console, options = {}) {
  const base = publicConfig(compositionConfig)
  const provider = options.provider ?? resolveSettingsProvider(ctx)
  const schema = options.schema ?? effectiveSchema()

  if (provider) {
    try {
      const scope = provider.register(SETTINGS_NAMESPACE, schema, { base, applies: 'live' })
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
