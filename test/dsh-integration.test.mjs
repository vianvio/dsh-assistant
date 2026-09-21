/**
 * 与**真实 DSH 设置服务**的集成测试（拿不到 DSH 包时自动跳过）。
 *
 * 为什么必须有这一条：那个"设置永远存不进去"的核心 bug，用假 provider 是测不出来的 ——
 * 旧代码 `provider.get()` / `provider.update(patch)` 在**假实现**上看起来完全正常，
 * 只有真 provider 的 `namespace` 校验会把它打回原形。
 * 所以这里直接加载机器上真实安装的 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-settings`，
 * 走一遍：注册 namespace → 端点读 → 端点写 → 落盘 → 用户层判定。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

process.env.DSH_ASSISTANT_HELPER = '/nonexistent/dsh-assistant-helper'

/** 找一套装好的 DSH 包（插件运行时从 profile 的 node_modules 解析它们）。 */
function findDshPackages() {
  const homes = [
    process.env.DSH_HOME,
    join(homedir(), 'Documents/projects/slf/agent-mesh/desktop/.local/dsh-home'),
    join(homedir(), '.dsh'),
  ].filter(Boolean)
  for (const home of homes) {
    for (const candidate of [join(home, 'profiles/node_modules'), join(home, 'node_modules')]) {
      const scope = join(candidate, '@deepseek-ai')
      if (existsSync(join(scope, 'cordis')) && existsSync(join(scope, 'dsh-settings'))) return scope
    }
  }
  return undefined
}

const scope = findDshPackages()
const skip = scope ? false : '本机没有安装 @deepseek-ai/cordis + dsh-settings（插件跑在 DSH 里时才有）'

test('集成：真实 DSH 设置服务下，配置能注册、能读写、能落盘', { skip }, async () => {
  const { Context } = await import(pathToFileURL(join(scope, 'cordis/lib/index.js')).href)
  const { SettingsProvider } = await import(pathToFileURL(join(scope, 'dsh-settings/lib/index.js')).href)

  // 只在内存里持久化的 provider（真机上换成 dsh-settings-file 就是写 settings.yaml）
  const persisted = []
  class MemorySettings extends SettingsProvider {
    get writable() { return true }
    async load() { return {} }
    async persist(ns, section) { persisted.push([ns, structuredClone(section)]) }
  }

  // 最小的 webServer 替身：把路由接住（真机上由 dsh-host-webserver 提供）
  const { Service } = await import(pathToFileURL(join(scope, 'cordis/lib/index.js')).href)
  class StubWebServer extends Service {
    constructor(ctx) { super(ctx, 'webServer') }
    register(route) { this.route = route; return () => { this.route = undefined } }
  }

  const ctx = new Context()
  ctx.plugin(MemorySettings)
  ctx.plugin(StubWebServer)
  await new Promise((done) => setTimeout(done, 30))

  const warnings = []
  ctx.logger = { info() {}, warn: (line) => warnings.push(String(line)), error() {}, debug() {} }

  const { apply } = await import('../src/index.js')
  await apply(ctx, { scale: 0.65 })

  const provider = ctx.get('settings')
  const webServer = ctx.get('webServer')
  assert.ok(provider, '真 provider 应该在位')
  assert.ok(webServer.route, '设置端点应该注册上')

  // ① namespace 真的注册进去了（旧代码根本走不到这一步）
  const descriptor = provider.describe({ redactSecrets: true }).find((entry) => entry.ns === 'dsh-assistant')
  assert.ok(descriptor, '必须注册 dsh-assistant namespace')
  assert.equal(descriptor.applies, 'live')
  assert.equal(descriptor.value.scale, 0.65, '组合配置作为 base 层生效')

  // ② 端点读到的就是这份配置
  const request = (method, body) => ({
    method,
    url: '/plugins/dsh-assistant/config',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) },
  })
  const response = () => {
    const state = { status: 0, body: '' }
    return { state, writeHead(s) { state.status = s }, end(p) { state.body = p ?? '' } }
  }

  const read = response()
  await webServer.route.handler(request('GET'), read)
  assert.equal(read.state.status, 200)
  assert.equal(JSON.parse(read.state.body).scale, 0.65)

  // ③ 端点写 → 真的落到设置服务（错误签名的调用在这里会直接抛）
  const patched = response()
  await webServer.route.handler(request('PATCH', { scale: 1.35, bubbleTheme: 'dark' }), patched)
  assert.equal(patched.state.status, 200, JSON.parse(patched.state.body).error ?? '')
  assert.equal(provider.get('dsh-assistant').scale, 1.35, '写进设置服务的新值')
  assert.deepEqual(persisted.at(-1)?.[0], 'dsh-assistant', '落盘用的是正确的 namespace')
  assert.equal(persisted.at(-1)?.[1].bubbleTheme, 'dark')

  // ④ 白名单之外仍然被拒（不会把任意字段写进用户设置）
  const bad = response()
  await webServer.route.handler(request('PATCH', { 乱写: 1 }), bad)
  assert.equal(bad.state.status, 400)
  assert.equal(provider.get('dsh-assistant')['乱写'], undefined)

  // 全程只该有"缺 helper"这一类告警：
  //   · 它是预期的（测试刻意把 DSH_ASSISTANT_HELPER 指向不存在的路径）；
  //   · 写设置会再触发一次 startProcess（helper 补齐后不重启 DSH 也能起来），
  //     所以出现两次是正常的。
  // 真正要守的是**没有**设置链路相关的告警（注册失败 / 写回失败 / namespace 用错）。
  assert.deepEqual(
    warnings.filter((line) => !/缺少原生 helper/.test(line)),
    [],
    `设置链路不该有告警: ${warnings.join(' / ')}`,
  )
})

test('集成：用户层判定决定"哪些字段下发给原生端"', { skip }, async () => {
  const { Context } = await import(pathToFileURL(join(scope, 'cordis/lib/index.js')).href)
  const { SettingsProvider } = await import(pathToFileURL(join(scope, 'dsh-settings/lib/index.js')).href)

  class MemorySettings extends SettingsProvider {
    get writable() { return true }
    async load() { return {} }
    async persist() {}
  }
  const ctx = new Context()
  ctx.plugin(MemorySettings)
  await new Promise((done) => setTimeout(done, 30))

  const { createSettingsScope } = await import('../src/pet-settings.js')
  const { configMessage } = await import('../src/pet.js')

  // 只给组合配置、没有任何用户覆盖 → 一个字段都不该下发
  const settings = createSettingsScope(ctx, { scale: 0.65, bubbleTheme: 'light' })
  assert.equal(settings.source, 'service')
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
  assert.equal(after.bubbleEnabled, undefined)
})

test('集成：真 provider 上重复注册同一个 namespace 会被拒（不会静默拿错作用域）', { skip }, async () => {
  const { Context } = await import(pathToFileURL(join(scope, 'cordis/lib/index.js')).href)
  const { SettingsProvider } = await import(pathToFileURL(join(scope, 'dsh-settings/lib/index.js')).href)

  class MemorySettings extends SettingsProvider {
    get writable() { return true }
    async load() { return {} }
    async persist() {}
  }
  const ctx = new Context()
  ctx.plugin(MemorySettings)
  await new Promise((done) => setTimeout(done, 30))

  const { createSettingsScope } = await import('../src/pet-settings.js')
  const first = createSettingsScope(ctx, { scale: 0.5 })
  assert.equal(first.source, 'service')

  // 第二次注册必然失败 → 必须降级成内存兜底（而不是让插件崩掉）
  const warnings = []
  const second = createSettingsScope(ctx, { scale: 0.9 }, { warn: (line) => warnings.push(String(line)) })
  assert.equal(second.source, 'memory')
  assert.equal(second.get().scale, 0.9, '兜底作用域仍然可用')
  assert.ok(warnings.some((line) => /注册设置 namespace 失败/.test(line)))
})
