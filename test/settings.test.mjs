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
  PetConfig,
  WRITABLE_FIELDS,
  clampScale,
  createMemoryScope,
  createSettingsScope,
  defaults,
  publicConfig,
} from '../src/pet-settings.js'
import { CONFIG_ENDPOINT, PENDING_ENDPOINT, VIEWED_ENDPOINT, createConfigHandler } from '../src/pet-endpoint.js'
import { configMessage } from '../src/pet.js'
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

/* ---------------------------------------------------------- 本地端点 */

function fakeRequest({ method = 'GET', address = '127.0.0.1', body, headers = {}, url = CONFIG_ENDPOINT } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) { state.status = status },
    end(payload) { state.body = payload ?? '' },
  }
}

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
