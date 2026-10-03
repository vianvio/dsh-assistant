/**
 * 配置：归一化、设置作用域（DSH 服务 / 内存兜底）、以及本地回环端点。
 *
 * 这里有一条**回归测试**：曾经端点用的是一份自己 wrap 的"设置服务"，
 * 用 provider.get() / provider.update(patch) 这种错签名调用，
 * 于是读到的永远是默认值、写进去必然 400。现在两端共用同一个 scope。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BUBBLE_THEMES,
  SETTINGS_FIELDS,
  PetConfig,
  WRITABLE_FIELDS,
  clampAutoInteractSeconds,
  clampScale,
  createMemoryScope,
  createSettingsScope,
  defaults,
  publicConfig,
} from '../src/pet-settings.js'
import { CONFIG_ENDPOINT, PENDING_ENDPOINT, VIEWED_ENDPOINT, createConfigHandler } from '../src/pet-endpoint.js'
import { configMessage } from '../src/pet.js'
import { NATIVE_FIELDS } from '../src/pet-settings.js'
import { fakeRequest, fakeResponse } from './helpers/http.mjs'
import { PetMessageKind } from '../src/protocol.js'

/* ------------------------------------------------------------ 归一化 */

test('设置：归一化会丢弃未知字段、夹住范围、校验配色', () => {
  const config = publicConfig({ scale: 9, bubbleEnabled: 'yes', bubbleTheme: 'neon', hack: 1 })
  assert.equal(config.scale, 2)
  assert.equal(config.bubbleEnabled, true)
  assert.equal(config.bubbleTheme, 'light', '非法配色落回默认浅色')
  assert.equal('hack' in config, false)
  assert.equal(clampScale(0.05), 0.15, '下限放宽到 15%，方便继续缩小')
  assert.equal(clampScale(Number.NaN), defaults.scale)
  assert.equal(defaults.scale, 0.4, '默认按 40% 出镜')
  assert.deepEqual(BUBBLE_THEMES, ['light', 'dark'])
})

test('设置：自动互动（开关 + 间隔秒数）归一化与夹取', () => {
  const on = publicConfig({})
  assert.equal(on.autoInteract, true, '默认开：这是它的性格')
  assert.equal(on.autoInteractSeconds, 10, '默认每 10 秒掷一次')

  assert.equal(publicConfig({ autoInteract: false }).autoInteract, false, '关得掉')
  assert.equal(publicConfig({ autoInteract: 'no' }).autoInteract, true, '只有显式 false 才算关')

  assert.equal(clampAutoInteractSeconds(1), 5, '太密 → 提到 5 秒')
  assert.equal(clampAutoInteractSeconds(9999), 300, '太疏 → 压到 5 分钟')
  assert.equal(clampAutoInteractSeconds(37.6), 38, '取整')
  assert.equal(clampAutoInteractSeconds(Number.NaN), 10, '非法值落回默认')
  assert.equal(publicConfig({ autoInteractSeconds: 0 }).autoInteractSeconds, 5)

  assert.ok(WRITABLE_FIELDS.includes('autoInteract'), '设置卡要能改')
  assert.ok(WRITABLE_FIELDS.includes('autoInteractSeconds'))
})

test('设置：组合配置只认白名单字段，schema 描述齐全', () => {
  assert.ok(WRITABLE_FIELDS.includes('scale'))
  assert.ok(WRITABLE_FIELDS.includes('backgroundSummary'))
  if (PetConfig) {
    const resolved = PetConfig({ scale: 0.55, 乱写: 1 })
    assert.equal(resolved.scale, 0.55)
    assert.equal(typeof PetConfig.toJSON(), 'object', 'schema 要能被设置页序列化')
  }
  // 未知字段由 publicConfig 统一丢掉（schema 只管自己认识的字段）
  assert.equal(publicConfig({ scale: 0.55, 乱写: 1 })['乱写'], undefined)
})

/* ------------------------------------------------- 设置作用域（重点） */

/**
 * 假 DSH 设置服务：只实现真服务里我们用到的语义 ——
 * get(ns) / update(ns, patch) / register(ns, schema, opts) 都要求 namespace，
 * 也正是旧代码漏掉的那个参数。
 */
function fakeSettingsProvider() {
  const sections = new Map()
  const watchers = []
  return {
    calls: [],
    register(ns, _schema, options = {}) {
      this.calls.push(['register', ns])
      if (sections.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
      sections.set(ns, {})
      const resolve = () => ({ ...(options.base ?? {}), ...sections.get(ns) })
      return {
        get: () => resolve(),
        update: async (patch) => {
          sections.set(ns, { ...sections.get(ns), ...patch })
          for (const watcher of watchers) watcher(resolve())
        },
        watch: (callback) => {
          watchers.push(callback)
          return () => watchers.splice(watchers.indexOf(callback), 1)
        },
      }
    },
    // 真服务里这两个都需要 namespace；不传就取不到东西（旧代码的 bug）
    get(ns) {
      if (typeof ns !== 'string') return undefined
      return sections.has(ns) ? { ...sections.get(ns) } : undefined
    },
    async update(ns, patch) {
      if (typeof ns !== 'string') {
        throw new TypeError(`settings namespace "${ns}" must match /^[a-z][a-z0-9-]*$/`)
      }
      if (!sections.has(ns)) throw new Error(`settings namespace "${ns}" is not registered`)
      sections.set(ns, { ...sections.get(ns), ...patch })
    },
    describe() {
      return [...sections.entries()].map(([ns, user]) => ({ ns, user, value: user, revision: 0, applies: 'live' }))
    },
  }
}

test('设置作用域：优先 DSH 设置服务，读写都落到 namespace 段', async () => {
  const provider = fakeSettingsProvider()
  const ctx = { settings: provider }
  const scope = createSettingsScope(ctx, { scale: 0.55, soundEnabled: true })
  assert.equal(scope.source, 'service')
  assert.deepEqual(provider.calls, [['register', 'dsh-assistant']])

  assert.equal(scope.get().scale, 0.55, '组合配置作为 base 层')
  assert.equal(scope.get().soundEnabled, true)

  const next = await scope.update({ scale: 0.75, 乱写: 1 })
  assert.equal(next.scale, 0.75)
  assert.equal(scope.get().scale, 0.75, 'watch 之外的读取也要能看到新值')
  assert.equal(provider.get('dsh-assistant').乱写, undefined, '非白名单字段不许落到设置服务')

  // overridden 读的是"用户层里有没有这个字段"
  assert.equal(scope.overridden('scale'), true)
  assert.equal(scope.overridden('backgroundSummary'), false)
})

test('回归：设置作用域不再用错签名调用 provider', () => {
  const provider = fakeSettingsProvider()
  const calls = []
  const originalGet = provider.get
  provider.get = (ns) => { calls.push(['get', ns]); return originalGet.call(provider, ns) }

  const scope = createSettingsScope({ settings: provider }, {})
  scope.get()
  assert.deepEqual(calls, [], 'scope.get() 不该再去碰 provider.get（那是 namespace 级 API）')
})

test('设置作用域：服务不可用时退回内存，并且照样能 watch', async () => {
  const scope = createSettingsScope({ get: () => undefined }, { scale: 0.7 })
  assert.equal(scope.source, 'memory')
  assert.equal(scope.get().scale, 0.7)

  const seen = []
  const off = scope.watch((next) => seen.push(next.scale))
  await scope.update({ scale: 0.9 })
  assert.deepEqual(seen, [0.9], '内存兜底也要能通知宿主')
  assert.equal(scope.overridden('scale'), true)
  off()
  await scope.update({ scale: 1.1 })
  assert.deepEqual(seen, [0.9], '取消订阅后不再收到通知')
})

test('设置作用域：服务拒绝注册时退回内存，不把插件带走', async () => {
  const broken = {
    register() { throw new Error('settings namespace "dsh-assistant" is already registered') },
  }
  const warnings = []
  const scope = createSettingsScope({ settings: broken }, { scale: 0.6 }, { warn: (line) => warnings.push(line) })
  assert.equal(scope.source, 'memory')
  assert.equal(scope.get().scale, 0.6)
  assert.ok(warnings.some((line) => /注册设置 namespace 失败/.test(line)), '失败要有日志，不能静默')
  await scope.update({ scale: 0.8 })
  assert.equal(scope.get().scale, 0.8)
})

/* ------------------------------------- 下发给原生端的配置（防冲掉原生设置） */

test('配置下发：只下发用户显式设过的字段', () => {
  const scope = createMemoryScope(defaults)
  const plain = configMessage(scope.get(), scope)
  assert.equal(plain.kind, PetMessageKind.CONFIG)
  assert.equal(plain.scale, undefined, '没被用户设过就不下发，免得冲掉原生菜单里调好的大小')
  assert.equal(plain.bubbleTheme, undefined)
})

test('配置下发：用户改过的字段（含原生菜单回写）会带下去', async () => {
  const scope = createMemoryScope(defaults)
  await scope.update({ scale: 1.2, bubbleTheme: 'dark' })
  const message = configMessage(scope.get(), scope)
  assert.equal(message.scale, 1.2)
  assert.equal(message.bubbleTheme, 'dark')
  assert.equal(message.bubbleEnabled, undefined, '没改过的字段仍然不下发')
})

test('配置下发：自动互动的开关与间隔会送到原生端（关掉时送 false）', async () => {
  const untouched = createMemoryScope(defaults)
  const plain = configMessage(untouched.get(), untouched)
  assert.equal(plain.autoInteract, undefined, '没设过就不下发 —— 原生端内置默认值与之相同')
  assert.equal(plain.autoInteractSeconds, undefined)

  const scope = createMemoryScope(defaults)
  await scope.update({ autoInteract: false, autoInteractSeconds: 45 })
  const message = configMessage(scope.get(), scope)
  assert.equal(message.autoInteract, false, '关掉要明确送到，不能靠"没发"来表达')
  assert.equal(message.autoInteractSeconds, 45)
  assert.equal(message.kind, PetMessageKind.CONFIG)
})

/* ---------------------------------------------------------- 本地端点 */


test('设置端点：GET/PATCH 正常，未知字段被拒', async () => {
  const settings = createMemoryScope(defaults)
  const handler = createConfigHandler(settings, () => undefined)
  const read = fakeResponse()
  await handler(fakeRequest(), read)
  assert.equal(read.state.status, 200)
  assert.equal(JSON.parse(read.state.body).helperRunning, false)

  const ok = fakeResponse()
  await handler(fakeRequest({ method: 'PATCH', body: { scale: 1.25 } }), ok)
  assert.equal(JSON.parse(ok.state.body).scale, 1.25)

  const theme = fakeResponse()
  await handler(fakeRequest({ method: 'PATCH', body: { bubbleTheme: 'dark' } }), theme)
  assert.equal(JSON.parse(theme.state.body).bubbleTheme, 'dark')

  const bad = fakeResponse()
  await handler(fakeRequest({ method: 'PATCH', body: { nope: 1 } }), bad)
  assert.equal(bad.state.status, 400)

  // 带 query 的 URL 也要命中同一个 handler
  const withQuery = fakeResponse()
  await handler(fakeRequest({ url: `${CONFIG_ENDPOINT}?x=1` }), withQuery)
  assert.equal(withQuery.state.status, 200)
})

test('设置端点：PATCH 会通知订阅者（设置页改了、宠物立刻跟上）', async () => {
  const settings = createMemoryScope(defaults)
  const seen = []
  settings.watch((next) => seen.push(next.scale))
  const handler = createConfigHandler(settings, () => undefined)
  await handler(fakeRequest({ method: 'PATCH', body: { scale: 0.85 } }), fakeResponse())
  assert.deepEqual(seen, [0.85])
})

test('设置端点：非回环 / 跨源 / 未知方法都被挡', async () => {
  const handler = createConfigHandler(createMemoryScope(defaults), () => undefined)
  const remote = fakeResponse()
  await handler(fakeRequest({ address: '10.1.2.3' }), remote)
  assert.equal(remote.state.status, 403)

  const crossOrigin = fakeResponse()
  await handler(fakeRequest({ headers: { origin: 'https://evil.example', host: '127.0.0.1:43120' } }), crossOrigin)
  assert.equal(crossOrigin.state.status, 403)

  const sameOrigin = fakeResponse()
  await handler(fakeRequest({ headers: { origin: 'http://127.0.0.1:43120', host: '127.0.0.1:43120' } }), sameOrigin)
  assert.equal(sameOrigin.state.status, 200)

  // DNS rebinding：Host 与 Origin 都是攻击者域名 —— 两个值都来自请求方，
  // "Origin.host === Host" 这种自参照判定在这里恒成立（旧实现能读能写）
  const rebindingGet = fakeResponse()
  await handler(fakeRequest({ headers: { origin: 'http://evil.example', host: 'evil.example' } }), rebindingGet)
  assert.equal(rebindingGet.state.status, 403, 'rebinding 读必须被挡')

  const rebindingPatch = fakeResponse()
  await handler(fakeRequest({
    method: 'PATCH',
    headers: { origin: 'http://evil.example', host: 'evil.example', 'content-type': 'application/json' },
    body: { scale: 1.9 },
  }), rebindingPatch)
  assert.equal(rebindingPatch.state.status, 403, 'rebinding 写必须被挡')

  // 解析到回环的域名（nip.io 这类）同样是攻击者可控的名字
  const nipIo = fakeResponse()
  await handler(fakeRequest({ headers: { origin: 'http://127.0.0.1.nip.io:43120', host: '127.0.0.1.nip.io:43120' } }), nipIo)
  assert.equal(nipIo.state.status, 403, '换成域名也要挡')

  // 同一个回环地址上的**另一个端口**不算同源
  const otherPort = fakeResponse()
  await handler(fakeRequest({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:43120' } }), otherPort)
  assert.equal(otherPort.state.status, 403, '端口不同不算同源')

  // localhost 写法的同源请求要放行（设置面板就是这么访问的）
  const localhostOrigin = fakeResponse()
  await handler(fakeRequest({ headers: { origin: 'http://localhost:43120', host: 'localhost:43120' } }), localhostOrigin)
  assert.equal(localhostOrigin.state.status, 200)

  const wrongMethod = fakeResponse()
  await handler(fakeRequest({ method: 'DELETE' }), wrongMethod)
  assert.equal(wrongMethod.state.status, 405)
})

test('互动端点：动作白名单 + 未运行时报 409', async () => {
  const handler = createConfigHandler(createMemoryScope(defaults), () => undefined)
  const unknown = fakeResponse()
  await handler(fakeRequest({
    method: 'POST', url: `${CONFIG_ENDPOINT}/action`, body: { action: 'explode' },
  }), unknown)
  assert.equal(unknown.state.status, 400)

  const offline = fakeResponse()
  await handler(fakeRequest({
    method: 'POST', url: `${CONFIG_ENDPOINT}/action`, body: { action: 'pat' },
  }), offline)
  assert.equal(offline.state.status, 409)

  const seen = []
  const live = createConfigHandler(createMemoryScope(defaults), () => ({ isRunning: true, act: (action) => { seen.push(action); return true } }))
  const delivered = fakeResponse()
  await live(fakeRequest({
    method: 'POST', url: `${CONFIG_ENDPOINT}/action`, body: { action: 'feed' },
  }), delivered)
  assert.equal(delivered.state.status, 200)
  assert.deepEqual(seen, ['feed'])
})

test('互动端点：summary 走宿主后台任务，不是原生动作', async () => {
  const started = []
  const handler = createConfigHandler(createMemoryScope(defaults), () => ({
    isRunning: true,
    summarize: () => { started.push('summary'); return true },
  }))
  const response = fakeResponse()
  await handler(fakeRequest({
    method: 'POST', url: `${CONFIG_ENDPOINT}/action`, body: { action: 'summary' },
  }), response)
  assert.equal(response.state.status, 202)
  assert.deepEqual(started, ['summary'])

  // 总结正在跑 / helper 没起来时 summarize() 返回 false → 409
  const busy = createConfigHandler(createMemoryScope(defaults), () => ({ isRunning: true, summarize: () => false }))
  const conflict = fakeResponse()
  await busy(fakeRequest({
    method: 'POST', url: `${CONFIG_ENDPOINT}/action`, body: { action: 'summary' },
  }), conflict)
  assert.equal(conflict.state.status, 409)
})

test('查看上报：客户端说"我在看这个会话"，端点转给宿主清通知', async () => {
  const seen = []
  const handler = createConfigHandler(createMemoryScope(defaults), () => ({
    isRunning: true,
    viewed: (sessionId) => { seen.push(sessionId); return sessionId === 's1' ? 1 : 0 },
  }))

  const ok = fakeResponse()
  await handler(fakeRequest({ method: 'POST', url: VIEWED_ENDPOINT, body: { sessionId: 's1' } }), ok)
  assert.equal(ok.state.status, 200)
  assert.equal(JSON.parse(ok.state.body).cleared, 1)
  assert.deepEqual(seen, ['s1'], 'sessionId 要原样传给宿主（大小写/前缀都不能改）')

  // helper 没起来时宿主句柄是 undefined：不报错，只是没清掉
  const offline = createConfigHandler(createMemoryScope(defaults), () => undefined)
  const none = fakeResponse()
  await offline(fakeRequest({ method: 'POST', url: VIEWED_ENDPOINT, body: { sessionId: 's2' } }), none)
  assert.equal(none.state.status, 200)
  assert.equal(JSON.parse(none.state.body).cleared, 0)

  // 没带 sessionId 是调用方的问题
  const missing = fakeResponse()
  await handler(fakeRequest({ method: 'POST', url: VIEWED_ENDPOINT, body: {} }), missing)
  assert.equal(missing.state.status, 400)
})

test('查看上报：同样要过回环 / 同源门禁', async () => {
  const handler = createConfigHandler(createMemoryScope(defaults), () => ({ viewed: () => 0 }))
  const remote = fakeResponse()
  await handler(fakeRequest({ method: 'POST', url: VIEWED_ENDPOINT, body: { sessionId: 's1' }, address: '10.1.2.3' }), remote)
  assert.equal(remote.state.status, 403)

  const crossOrigin = fakeResponse()
  await handler(fakeRequest({
    method: 'POST', url: VIEWED_ENDPOINT, body: { sessionId: 's1' },
    headers: { origin: 'https://evil.example', host: '127.0.0.1:43120' },
  }), crossOrigin)
  assert.equal(crossOrigin.state.status, 403)
})

test('命令通道：长轮询把宿主的"打开会话"取走，取完即空', async () => {
  const queue = [{ kind: 'open-session', sessionId: 's1' }]
  const waits = []
  const handler = createConfigHandler(createMemoryScope(defaults), () => ({
    isRunning: true,
    nextCommand: async (timeoutMs) => { waits.push(timeoutMs); return queue.shift() },
  }))

  const first = fakeResponse()
  await handler(fakeRequest({ url: PENDING_ENDPOINT }), first)
  assert.equal(first.state.status, 200)
  assert.deepEqual(JSON.parse(first.state.body).commands, [{ kind: 'open-session', sessionId: 's1' }])

  const second = fakeResponse()
  await handler(fakeRequest({ url: PENDING_ENDPOINT }), second)
  assert.deepEqual(JSON.parse(second.state.body).commands, [], '没有命令时回空数组（客户端立刻再挂上）')
  assert.ok(waits[0] > 0, '端点要带上等待时长，让宿主做长轮询')

  // helper 没起来：也要立刻回空，别让客户端一直挂着
  const offline = createConfigHandler(createMemoryScope(defaults), () => undefined)
  const none = fakeResponse()
  await offline(fakeRequest({ url: PENDING_ENDPOINT }), none)
  assert.equal(none.state.status, 200)
  assert.deepEqual(JSON.parse(none.state.body).commands, [])
})

test('命令通道：nextCommand 抛错也不该把端点带崩', async () => {
  const handler = createConfigHandler(createMemoryScope(defaults), () => ({
    nextCommand: async () => { throw new Error('boom') },
  }))
  const response = fakeResponse()
  await handler(fakeRequest({ url: PENDING_ENDPOINT }), response)
  assert.equal(response.state.status, 200)
  assert.deepEqual(JSON.parse(response.state.body).commands, [])
})

test('设置端点：GET 带上主角与并行名单', async () => {
  const handler = createConfigHandler(createMemoryScope(defaults), () => ({
    isRunning: true,
    focus: () => ({ id: 'a', project: 'agent-mesh', state: 'WORKING', message: '正在执行项目命令' }),
    roster: () => [{ id: 'a', project: 'agent-mesh', state: 'WORKING', active: true }],
  }))
  const response = fakeResponse()
  await handler(fakeRequest(), response)
  const body = JSON.parse(response.state.body)
  assert.equal(body.helperRunning, true)
  assert.equal(body.focus.project, 'agent-mesh')
  assert.equal(body.roster.length, 1)
})

test('设置契约：面板不再手抄任何边界（从端点字段元数据派生）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fieldMetadata, SETTINGS_FIELDS } = await import('../src/pet-settings.js')
  const source = readFileSync(join(process.cwd(), 'src/client.js'), 'utf8')

  // ① 面板里不许出现 range 的数字边界（以前抄了 min: 0.15, max: 2, step: 0.05 和 min: 5, max: 300, step: 5）
  const hardCoded = [...source.matchAll(/type: 'range'[^}]*?\b(min|max|step):\s*([\d.]+)/gu)].map((m) => m[0])
  assert.deepEqual(hardCoded, [], `面板里还在手抄滑杆边界：${hardCoded.join(' / ')}`)

  // ② 滑杆的边界必须真的取自端点下发的 fields
  assert.ok(source.includes('min: fields.'), '滑杆的 min 要从 fields 取')
  assert.ok(source.includes('max: fields.'), '滑杆的 max 要从 fields 取')
  assert.ok(source.includes('step: fields.'), '滑杆的 step 要从 fields 取')

  // ③ 端点确实把这份元数据发出去了（而且默认值/边界与契约一致）
  const fields = fieldMetadata()
  assert.equal(fields.scale.min, SETTINGS_FIELDS.scale.min)
  assert.equal(fields.scale.max, SETTINGS_FIELDS.scale.max)
  assert.equal(fields.scale.step, SETTINGS_FIELDS.scale.step)
  assert.equal(fields.autoInteractSeconds.max, SETTINGS_FIELDS.autoInteractSeconds.max)
  assert.deepEqual(fields.bubbleTheme.values, [...SETTINGS_FIELDS.bubbleTheme.values])

  // ④ 面板提到的字段名都在契约里（改名字会红）
  for (const name of Object.keys(SETTINGS_FIELDS)) {
    assert.ok(source.includes(name), `面板里没提到字段 ${name}`)
  }
})

test('设置契约：字段清单只有一处（可写 / 下发 / 原生回写都从契约派生）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const pet = readFileSync(join(process.cwd(), 'src/pet.js'), 'utf8')

  // 原生回写不再手写 if 链：它必须遍历 WRITABLE_FIELDS
  assert.match(pet, /for \(const field of WRITABLE_FIELDS\)/, 'handleNativeSettings 要从契约派生')
  // 下发清单也不再手写：用契约里 native 标记派生的 NATIVE_FIELDS
  assert.match(pet, /for \(const field of NATIVE_FIELDS\)/, 'configMessage 要用派生的下发清单')
  // 注意：注释里可能还在提这个名字（讲历史），所以只禁"定义"
  assert.ok(!/(?:const|let|var)\s+OVERRIDABLE_FIELDS/.test(pet), '那份手写的下发清单已经删掉了')
  for (const field of NATIVE_FIELDS) {
    assert.ok(WRITABLE_FIELDS.includes(field), `下发清单里的 ${field} 不在可写字段里`)
  }
  for (const internal of ['enabled', 'includeSubagents', 'backgroundSummary']) {
    assert.ok(!NATIVE_FIELDS.includes(internal), `${internal} 是宿主内部字段，不该下发给原生端`)
  }
})

test('设置契约：面板显示名与开关名在提示文案里同源（改名会被顶红）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { summaryHint } = await import('../src/pet-summary.js')
  const { SETTINGS_DISPLAY_NAME, SETTINGS_FIELDS } = await import('../src/pet-settings.js')

  const hint = summaryHint({ backgroundSummary: false })
  assert.ok(hint.includes(SETTINGS_DISPLAY_NAME), '提示里的卡片名要来自契约')
  assert.ok(hint.includes(SETTINGS_FIELDS.backgroundSummary.label), '提示里的开关名要来自契约')
  assert.equal(summaryHint({ backgroundSummary: true }), '', '开着的时候不念')

  // 面板自己也得用同一个名字（它是浏览器 bundle，只能手抄一份 —— 这条守着那份）
  const client = readFileSync(join(process.cwd(), 'src', 'client.js'), 'utf8')
  assert.ok(client.includes(`'${SETTINGS_DISPLAY_NAME}'`), '面板显示名要与契约一致')
})

test('设置契约：端点的路径字面量只有一处（面板那份由这条守着）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { CONFIG_ENDPOINT, VIEWED_ENDPOINT, PENDING_ENDPOINT } = await import('../src/pet-endpoint.js')

  // 面板是浏览器 bundle，没法 import 宿主模块 —— 它的那份只能靠守卫不许漂
  const client = readFileSync(join(process.cwd(), 'src', 'client.js'), 'utf8')
  const literal = new RegExp(`CONFIG_ENDPOINT\\s*=\\s*'${CONFIG_ENDPOINT}'`, 'u')
  assert.match(client, literal, '面板里的端点字面量必须与 pet-endpoint 导出的常量一致')

  // 测试自己也别手抄
  for (const file of ['test/client.test.mjs', 'test/settings.test.mjs', 'test/dsh-integration.test.mjs']) {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    const handWritten = source.match(new RegExp(`'${CONFIG_ENDPOINT}(/[a-z]+)?'`, 'gu')) ?? []
    assert.deepEqual(handWritten, [], `${file} 里手抄了端点字面量：${handWritten.join(', ')}`)
  }
  assert.equal(VIEWED_ENDPOINT, `${CONFIG_ENDPOINT}/viewed`)
  assert.equal(PENDING_ENDPOINT, `${CONFIG_ENDPOINT}/pending`)
})

test('设置：provider 在位但拿不到 schemastery 时，仍然走服务存储（不静默退回内存）', async () => {
  const { createSettingsScope, fallbackSchema, publicConfig } = await import('../src/pet-settings.js')
  const { configMessage } = await import('../src/pet.js')

  // 与真服务同形的假 provider：只要求 schema 是**可调用的**（dsh-settings 的 resolve 就是 schema(raw)）
  const state = { scale: 1.4 }
  const provider = {
    register(ns, schema, options) {
      const resolved = () => ({ ...(options.base ?? {}), ...state })
      return {
        get: () => schema(resolved()),
        update: async (patch) => { Object.assign(state, patch) },
        watch: () => () => {},
      }
    },
    describe: () => [{ ns: 'dsh-assistant', user: { ...state } }],
  }

  const scope = createSettingsScope({}, {}, { debug() {}, warn() {} }, { provider, schema: fallbackSchema })
  assert.equal(scope.source, 'service', 'provider 在位就该走服务存储')
  assert.equal(scope.get().scale, 1.4, '用户存过的值要读回来（以前整条服务分支被跳过，用户设置被丢弃）')
  assert.equal(scope.overridden('scale'), true)

  // 写进去要落回 provider（而不是只改内存）
  await scope.update({ bubbleTheme: 'dark' })
  assert.equal(state.bubbleTheme, 'dark', '改动要落进 provider')
  const message = configMessage(scope.get(), scope)
  assert.equal(message.bubbleTheme, 'dark')
  assert.equal(publicConfig(fallbackSchema({ scale: 0.155 })).scale, 0.16, '兜底 schema 走同一套归一化')
})

test('通知对账：原生上报"我这边丢了这些通知"时，宿主账本跟着清', async () => {
  const { PetReducer } = await import('../src/pet-reducer.js')
  const reducer = new PetReducer()
  const a = { id: 'session-a', cwd: '/tmp/project-a', title: '项目A' }
  reducer.handle(a, { type: 'turn/start', seq: 1 })
  reducer.handle(a, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
  assert.equal(reducer.pendingNotices().length, 1)

  // pet.js 收到原生上报后逐个 dismissNotice —— 这里直接验证 reducer 侧的效果
  const dropped = reducer.pendingNotices().map((notice) => notice.id)
  for (const id of dropped) assert.equal(reducer.dismissNotice(id), true)
  assert.equal(reducer.pendingNotices().length, 0, '宿主账本要跟着清，否则两边"还挂着几条"永远对不上')
})
