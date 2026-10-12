/**
 * 与**真实 DSH** 的集成测试（0.2 起）。
 *
 * 为什么必须有这一条：0.2 换了整套设置模型 —— namespace 不再是插件自己注册的字符串，
 * 而是 profile 条目 id；表单来自插件入口导出的 `Config`；字段必须标 `.volatile()` 才算
 * "可热改"，值由 Loader 就地换进运行中的引用。这些契约（哪些字段出得了表单、哪些路径允许
 * 写入、引用怎么被改写）只有**真包**说了算，假实现一律测不出来：自己写一个 provider
 * 觉得"能读能写"，真服务那边可能一个字段都不认。
 *
 * 所以这里直接加载机器上装的那份 `@deepseek-ai/schemastery` + `@deepseek-ai/dsh-settings`
 * （连里面的投影函数 `volatileForm` / `isVolatilePath` / `projectForm` 一起），
 * 加上 `@deepseek-ai/cosmokit` 真正改写引用的那个 `updateVolatile`，跑一遍：
 * 解析 → 出表单 → 判断可写路径 → 写入 → 订阅者收到新值。
 *
 * 包从哪找：`$DSH_HOME`（缺省 `~/.dsh`）下的 `profiles/node_modules`，或
 * `DSH_ASSISTANT_DSH_PACKAGES` 点名的目录。桌面端把 DSH 装在 app.asar 里、$DSH_HOME 下
 * 没有这些包，那就先 `npm run dsh:packages` 解一份出来。找不到依赖时不再静默 skip：
 * 见 test/helpers/coverage.mjs。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { coverageGate, dshPackagesDir } from './helpers/coverage.mjs'
import { fakeRequest, fakeResponse } from './helpers/http.mjs'

process.env.DSH_ASSISTANT_HELPER = '/nonexistent/dsh-assistant-helper'

/** 找一套装好的 DSH 包（插件运行时从 profile 的 node_modules 解析它们）。 */
function findDshPackages() {
  const dir = dshPackagesDir()
  if (!dir) return undefined
  const scope = join(dir, '@deepseek-ai')
  return existsSync(join(scope, 'dsh-settings')) ? scope : undefined
}

/** 这套 DSH 包是哪一代：0.2 的设置服务是 SettingsForms（describe/update），0.1 是 SettingsProvider（register）。 */
function settingsEra(scope) {
  try {
    const manifest = JSON.parse(readFileSync(join(scope, 'dsh-settings', 'package.json'), 'utf8'))
    const entry = readFileSync(join(scope, 'dsh-settings', 'lib', 'index.js'), 'utf8')
    return { version: manifest.version, modern: /SettingsForms/.test(entry) && !/class SettingsProvider/.test(entry) }
  } catch {
    return { version: '?', modern: false }
  }
}

const scope = findDshPackages()
const era = scope ? settingsEra(scope) : undefined
const dshGate = coverageGate(
  '真实 DSH 集成用例（schemastery + dsh-settings 0.2）',
  era?.modern === true,
  'DSH_ASSISTANT_SKIP_DSH',
  scope
    ? `本机找到的 @deepseek-ai/dsh-settings 是 ${era?.version}（${scope}）—— 不是 0.2 那一代，`
      + '没有 describe()/update(ns, patch)，测不了现在这条链路。\n'
      + '  桌面端（Electron）的 DSH 包在 app.asar 里：先 `npm run dsh:packages` 解一份，'
      + '再 `DSH_ASSISTANT_DSH_PACKAGES=<解出来的 node_modules> npm test`'
    : '本机没有 @deepseek-ai/cordis + @deepseek-ai/dsh-settings。'
      + '桌面端把 DSH 装在 app.asar 里、$DSH_HOME 下没有：先 `npm run dsh:packages` 解一份，'
      + '再 `DSH_ASSISTANT_DSH_PACKAGES=<解出来的 node_modules> npm test`',
)
const skip = dshGate.skip

/** 真包里的四个投影/引用工具。 */
async function loadDshTools() {
  const settings = await import(pathToFileURL(join(scope, 'dsh-settings', 'lib', 'index.js')).href)
  const schema = await import(pathToFileURL(join(scope, 'dsh-settings', 'lib', 'types', 'schema.js')).href)
  const cosmokit = await import(pathToFileURL(join(scope, 'cosmokit', 'lib', 'index.js')).href)
  return { settings, schema, cosmokit }
}

test('集成：插件导出的 Config 就是 0.2 设置页认得的那份表单', { skip }, async () => {
  dshGate.check()
  const { schema: projection } = await loadDshTools()
  const { Config, WRITABLE_FIELDS } = await import('../src/pet-settings.js')

  assert.ok(Config, '必须导出 Config：0.2 的表单、可写字段、条目 config 解析全靠它')
  assert.equal(typeof Config.toJSON, 'function', '设置页要能序列化它')

  // ① 真投影函数能把我们的 schema 变成一张可编辑表单，且字段一个不少
  const form = projection.volatileForm(Config)
  assert.ok(form, 'volatileForm(Config) 不能是 undefined —— 否则插件在设置里根本不出现')
  assert.equal(form.type, 'object')
  assert.deepEqual(Object.keys(form.dict ?? {}).sort(), [...WRITABLE_FIELDS].sort(), '设置页字段必须与契约一致')

  // ② 每个字段都得是"可热改"的：settings.update() 只放行落在 volatile 节点下的路径
  for (const name of WRITABLE_FIELDS) {
    assert.equal(projection.isVolatilePath(Config, [name]), true, `${name} 必须标 .volatile()，否则设置页改不了`)
  }

  // ③ 真 schemastery 解析出来的字段是**引用**：Loader 就地改写它们，宿主读引用即最新值
  const resolved = Config({ scale: 1.35, bubbleTheme: 'dark' })
  for (const name of WRITABLE_FIELDS) {
    assert.equal(typeof resolved[name]?.get, 'function', `${name} 应该是 volatile 引用（{ get() }）`)
  }
  assert.equal(resolved.scale.get(), 1.35)
  assert.equal(projection.plainConfig(resolved).bubbleTheme, 'dark')

  // ④ 越界 / 非法值由真 schema 当场拒掉，**不是悄悄夹住** —— 这条行为决定了
  //    profile 补丁里的坏值会以 ValidationError 暴露（而不是变成另一个值让人以为设置没生效）。
  assert.throws(() => Config({ scale: 99 }), /expected number <= 2/)
  assert.throws(() => Config({ bubbleTheme: '乱写' }), /ValidationError|expected/)
})

test('集成：0.2 的设置服务按条目 id 寻址（register 那套没了）', { skip }, async () => {
  dshGate.check()
  const { settings } = await loadDshTools()
  const methods = Object.getOwnPropertyNames(settings.SettingsForms.prototype)

  assert.equal(typeof settings.SettingsForms.prototype.describe, 'function')
  assert.equal(typeof settings.SettingsForms.prototype.update, 'function')
  assert.equal(methods.includes('register'), false,
    '0.2 没有 register：插件必须靠导出的 Config + profile 条目 id，而不是自己注册 namespace')
  assert.equal(settings.SettingsProvider, undefined, 'SettingsProvider 已经不在导出里了')
})

test('集成：作用域在真 0.2 服务形状下读写（条目 id + 真引用 + 真 updateVolatile）', { skip }, async () => {
  dshGate.check()
  const { schema: projection, cosmokit } = await loadDshTools()
  const { Config } = await import('../src/pet-settings.js')
  const { createSettingsScope } = await import('../src/pet-settings.js')

  // 真 schemastery 解析出的那份配置：字段是引用，Loader 就是这么交给插件的
  const live = Config({})
  const user = {}
  const calls = []
  /** 假服务只实现真服务的**形状**；改值用的是真 cosmokit 的 updateVolatile（Loader 内部同一支）。 */
  const provider = {
    describe: () => [{
      ns: 'dsh-assistant',
      applies: 'live',
      revision: calls.length,
      user: projection.projectForm(projection.volatileForm(Config), user),
      value: projection.plainConfig(live),
      base: {},
    }],
    async update(ns, patch, expectedRevision) {
      calls.push([ns, patch, expectedRevision])
      if (ns !== 'dsh-assistant') throw new Error(`No configurable plugin entry "${ns}"`)
      const next = Config({ ...projection.plainConfig(live), ...patch })
      for (const name of Object.keys(patch)) cosmokit.updateVolatile(live[name], next[name])
      Object.assign(user, patch)
    },
  }

  const ctx = { settings: provider, fiber: { entry: { options: { id: 'dsh-assistant' } } } }
  const scope = createSettingsScope(ctx, live)
  assert.equal(scope.source, 'service')
  assert.equal(scope.entry, 'dsh-assistant')
  assert.equal(scope.get().scale, Config({}).scale.get())

  const seen = []
  scope.watch((next) => seen.push(next.scale))
  const after = await scope.update({ scale: 1.35, bubbleTheme: 'dark', 乱写: 1 })
  assert.equal(after.scale, 1.35)
  assert.equal(scope.get().bubbleTheme, 'dark')
  assert.deepEqual(seen, [1.35], '写完之后订阅者（宠物）要立刻收到新值')
  assert.deepEqual(calls, [['dsh-assistant', { scale: 1.35, bubbleTheme: 'dark' }, undefined]],
    '写给设置服务的必须是条目 id + 白名单字段，且不带 revision')
  assert.equal(projection.plainConfig(live).乱写, undefined)
  assert.equal(scope.overridden('scale'), true, '用户层里出现过的字段才算"用户设过"')
  assert.equal(scope.overridden('autoInteract'), false)
})

test('集成：设置端点接的就是这份作用域（GET 读引用，PATCH 写条目）', { skip }, async () => {
  dshGate.check()
  const { schema: projection, cosmokit } = await loadDshTools()
  const { Config, createSettingsScope } = await import('../src/pet-settings.js')
  const { createConfigHandler, CONFIG_ENDPOINT } = await import('../src/pet-endpoint.js')
  const { mountPet } = await import('../src/pet.js')

  const live = Config({})
  const calls = []
  const provider = {
    describe: () => [{ ns: 'dsh-assistant', user: {}, value: projection.plainConfig(live), base: {}, revision: 0, applies: 'live' }],
    async update(ns, patch) {
      calls.push([ns, patch])
      const next = Config({ ...projection.plainConfig(live), ...patch })
      for (const name of Object.keys(patch)) cosmokit.updateVolatile(live[name], next[name])
    },
  }
  const ctx = { settings: provider, fiber: { entry: { options: { id: 'dsh-assistant' } } } }
  const settings = createSettingsScope(ctx, live)
  const warnings = []
  const logger = { info() {}, warn: (line) => warnings.push(String(line)), error() {}, debug() {} }
  mountPet({ ctx, settings, eventCtx: ctx, logger, tuning: { version: 'test' } })

  const handler = createConfigHandler(settings, () => undefined, logger)
  assert.ok(CONFIG_ENDPOINT.startsWith('/plugins/'), '端点的字面量只有 client.js 那份是手抄的，这里只做形状检查')

  const read = fakeResponse()
  await handler(fakeRequest({ method: 'GET' }), read)
  assert.equal(read.state.status, 200)
  assert.equal(JSON.parse(read.state.body).scale, live.scale.get(), 'GET 读的是当前引用')

  const patched = fakeResponse()
  await handler(fakeRequest({ method: 'PATCH', body: { scale: 0.85 } }), patched)
  assert.equal(patched.state.status, 200, JSON.parse(patched.state.body).error ?? '')
  assert.equal(JSON.parse(patched.state.body).scale, 0.85)
  assert.deepEqual(calls, [['dsh-assistant', { scale: 0.85 }]], 'PATCH 落到 profile 条目上')

  const bad = fakeResponse()
  await handler(fakeRequest({ method: 'PATCH', body: { 乱写: 1 } }), bad)
  assert.equal(bad.state.status, 400)
  assert.ok(warnings.some((line) => /拒绝 400 PATCH/.test(line)), '故意写坏字段要留一条拒绝日志')
  assert.ok(!warnings.some((line) => /注册设置|没有可配置的条目/.test(line)), '设置链路不该有降级告警')
})

test('集成：用户层判定决定"哪些字段下发给原生端"', { skip }, async () => {
  dshGate.check()
  const { schema: projection, cosmokit } = await loadDshTools()
  const { Config, createSettingsScope } = await import('../src/pet-settings.js')
  const { configMessage } = await import('../src/pet.js')

  const live = Config({})
  const user = {}
  const provider = {
    describe: () => [{
      ns: 'dsh-assistant',
      user: projection.projectForm(projection.volatileForm(Config), user),
      value: projection.plainConfig(live),
      base: {},
      revision: 0,
      applies: 'live',
    }],
    async update(ns, patch) {
      const next = Config({ ...projection.plainConfig(live), ...patch })
      for (const name of Object.keys(patch)) cosmokit.updateVolatile(live[name], next[name])
      Object.assign(user, patch)
    },
  }
  const ctx = { settings: provider, fiber: { entry: { options: { id: 'dsh-assistant' } } } }
  const settings = createSettingsScope(ctx, live)

  // 只给组合配置、没有任何用户覆盖 → 一个字段都不该下发
  const before = configMessage(settings.get(), settings)
  assert.equal(before.scale, undefined, '用户没设过就不下发（留给原生端自己的 layout.json）')
  assert.equal(before.bubbleTheme, undefined)

  // 用户显式设过两个字段 → 只下发这两个
  await settings.update({ scale: 1.35, bubbleTheme: 'dark' })
  const after = configMessage(settings.get(), settings)
  assert.equal(after.scale, 1.35)
  assert.equal(after.bubbleTheme, 'dark')
  assert.equal(after.soundEnabled, undefined, '没设过的字段仍然不下发')
  assert.equal(after.reducedMotion, undefined)
})
