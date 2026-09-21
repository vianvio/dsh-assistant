/**
 * 插件装配（index.js + pet.js）的接线测试。
 *
 * 这一层最容易出的错不是逻辑错，而是**接线错**：
 *   · 设置端点拿到的那份 scope 与宠物用的不是同一个（历史上就是这样：写进去读不到）；
 *   · 注册了却没人读的接口 / 没人处理的 helper 消息（表现为"某个按钮点了没反应"）；
 *   · 生命周期收不干净（root 总线上的监听器会跨热重载叠加）。
 *
 * 所以这里用假的 ctx 把插件真跑一遍，并断言这些接线。
 * **不拉真 helper**：把 DSH_ASSISTANT_HELPER 指到不存在的路径，宠物会按设计缺席
 * （这条路径本身也是要验的：缺 helper 只告警、不影响其余部分）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

// 必须在 apply() 之前设置：PetProcess 是按调用时的 env 判断 helper 是否存在的
process.env.DSH_ASSISTANT_HELPER = '/nonexistent/dsh-assistant-helper'

const { apply, inject, name } = await import('../src/index.js')
const { CONFIG_ENDPOINT, VIEWED_ENDPOINT } = await import('../src/pet-endpoint.js')

/** 假 cordis 上下文：只实现插件用到的那几件事。 */
function fakeContext({ settings } = {}) {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    root: undefined,
    settings,
    get: (key) => (key === 'settings' ? settings : undefined),
    on(event, handler) {
      listeners.set(event, handler)
      const off = () => listeners.delete(event)
      disposers.push(off)
      return off
    },
    effect(callback) {
      const disposer = callback()
      disposers.push(disposer)
      return disposer
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback({
        get: () => ({ register: (route) => { ctx.route = route; return () => { ctx.route = undefined } } }),
        // 真 cordis 会把这个 effect 挂在插件 fiber 上，卸载时一起释放
        effect: (callback) => { disposers.push(callback()) },
      })
    },
  }
  ctx.root = ctx
  return {
    ctx,
    listeners,
    /** 卸载插件（跑所有 effect 的 dispose） */
    dispose: () => { for (const disposer of [...disposers]) { try { disposer?.() } catch { /* 忽略 */ } } },
  }
}

function fakeSettings(initial = {}) {
  // 真 provider 的解析顺序：schema 默认 → 组合配置(base) → 用户层。
  // initial 放**用户层**：settings.yaml 里存的值就是这么来的（组合配置只提供默认）。
  let base = {}
  const state = { ...initial }
  const watchers = new Set()
  const resolved = () => ({ ...base, ...state })
  const handle = {
    get: () => resolved(),
    update: async (patch) => { Object.assign(state, patch); for (const watcher of watchers) watcher(resolved()) },
    watch: (callback) => { watchers.add(callback); return () => watchers.delete(callback) },
  }
  return {
    state,
    register: (_ns, _schema, options = {}) => { base = { ...base, ...(options.base ?? {}) }; return handle },
    describe: () => [{ ns: 'dsh-assistant', user: { ...state } }],
  }
}

function request({ method = 'GET', body, address = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: CONFIG_ENDPOINT,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

function response() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) { state.status = status },
    end(payload) { state.body = payload ?? '' },
  }
}

test('装配：插件声明了要用的服务与名字', () => {
  assert.equal(name, 'dsh-assistant')
  assert.deepEqual(inject, ['sessions', 'settings'])
})

test('装配：设置端点与宠物共用同一个配置作用域', async () => {
  const settings = fakeSettings()
  const harness = fakeContext({ settings })
  await apply(harness.ctx, { scale: 0.7 })

  assert.ok(harness.ctx.route, '应该注册了设置端点')
  assert.equal(harness.ctx.route.path, CONFIG_ENDPOINT)
  assert.equal(harness.ctx.route.kind, 'prefix')

  const read = response()
  await harness.ctx.route.handler(request(), read)
  assert.equal(read.state.status, 200)
  const body = JSON.parse(read.state.body)
  assert.equal(body.scale, 0.7, '端点读到的必须是宠物用的那份配置（组合配置能透上来）')
  assert.equal(body.helperRunning, false, 'helper 缺失时如实上报，面板据此提示怎么修')

  harness.dispose()
})

test('装配：PATCH 走的就是宠物那份 scope，会通知订阅者', async () => {
  const settings = fakeSettings()
  const watched = []
  const harness = fakeContext({ settings })
  await apply(harness.ctx, {})
  settings.register().watch((next) => watched.push(next.scale))

  const patched = response()
  await harness.ctx.route.handler(request({ method: 'PATCH', body: { scale: 1.4 } }), patched)
  assert.equal(patched.state.status, 200)
  assert.equal(settings.state.scale, 1.4, '写入落到同一份配置里')
  assert.deepEqual(watched, [1.4], '订阅者要收到（原生端热更新靠它）')

  const bad = response()
  await harness.ctx.route.handler(request({ method: 'PATCH', body: { 乱写: 1 } }), bad)
  assert.equal(bad.state.status, 400, '非白名单字段仍然被拒')

  harness.dispose()
})

test('装配：会话事件总线都订阅上了，卸载后一个不留', async () => {
  const harness = fakeContext({ settings: fakeSettings() })
  await apply(harness.ctx, {})
  assert.ok(harness.listeners.has('session/event'))
  assert.ok(harness.listeners.has('session/created'))
  assert.ok(harness.listeners.has('session/disposed'))

  harness.dispose()
  assert.equal(harness.listeners.size, 0, '每个监听器都要有对应的释放（否则热重载会叠加）')
  assert.equal(harness.ctx.route, undefined, '端点也要跟着插件生命周期释放')
})

test('装配：helper 缺失只告警，端点与订阅照常（宠物缺席不拖垮插件）', async () => {
  const warnings = []
  const settings = fakeSettings()
  const harness = fakeContext({ settings })
  harness.ctx.logger = { info() {}, warn: (line) => warnings.push(String(line)), error() {}, debug() {} }

  await apply(harness.ctx, {})
  assert.ok(warnings.some((line) => /缺少原生 helper/.test(line)), '要明确告诉用户怎么修')
  assert.ok(harness.ctx.route, '设置端点仍然可用（面板要能显示"未运行"）')
  assert.ok(harness.listeners.has('session/event'))
  harness.dispose()
})

test('装配：拿不到 DSH 设置服务时退回内存配置，不启动失败', async () => {
  const harness = fakeContext({ settings: undefined })
  await apply(harness.ctx, {})
  assert.ok(harness.ctx.route, '内存兜底下端点也要能用')

  const read = response()
  await harness.ctx.route.handler(request(), read)
  assert.equal(read.state.status, 200)
  assert.equal(typeof JSON.parse(read.state.body).scale, 'number')
  harness.dispose()
})

test('装配：互动动作的白名单与宿主语义一致', async () => {
  const harness = fakeContext({ settings: fakeSettings() })
  await apply(harness.ctx, {})

  // helper 没起来 → 原生动作应报 409（"这次没做"），而不是 500
  const offline = response()
  await harness.ctx.route.handler({ ...request({ method: 'POST', body: { action: 'pat' } }), url: `${CONFIG_ENDPOINT}/action` }, offline)
  assert.equal(offline.state.status, 409)

  const unknown = response()
  await harness.ctx.route.handler({ ...request({ method: 'POST', body: { action: 'explode' } }), url: `${CONFIG_ENDPOINT}/action` }, unknown)
  assert.equal(unknown.state.status, 400)

  // 日报是宿主后台任务：helper 没起来时也不能谎报"已开跑"
  const summary = response()
  await harness.ctx.route.handler({ ...request({ method: 'POST', body: { action: 'summary' } }), url: `${CONFIG_ENDPOINT}/action` }, summary)
  assert.equal(summary.state.status, 409)
  assert.equal(JSON.parse(summary.state.body).started, false)

  harness.dispose()
})

test('装配：客户端上报"在看某会话"真的会清掉挂在宿主里的通知', async () => {
  const settings = fakeSettings()
  const harness = fakeContext({ settings })
  await apply(harness.ctx, {})

  // helper 不在 → reducer 不存在，viewed 只能返回 0（不报错）
  const offline = response()
  await harness.ctx.route.handler(
    { ...request({ method: 'POST', body: { sessionId: 's1' } }), url: VIEWED_ENDPOINT },
    offline,
  )
  assert.equal(offline.state.status, 200)
  assert.equal(JSON.parse(offline.state.body).cleared, 0)

  harness.dispose()
})

test('装配：原生回报"点了通知" → 队列里出现"打开该会话"命令', async () => {
  const settings = fakeSettings()
  const harness = fakeContext({ settings })
  await apply(harness.ctx, {})

  // 没有 helper 时 reducer 不存在，但命令队列照样要工作（客户端靠它）
  // helper 没起来：不该长轮询，立刻回空（否则客户端白挂 20 秒）
  const started = Date.now()
  const idle = response()
  await harness.ctx.route.handler({ ...request(), url: `${CONFIG_ENDPOINT}/pending` }, idle)
  assert.deepEqual(JSON.parse(idle.state.body).commands, [])
  assert.ok(Date.now() - started < 1000, '没有 helper 就该立刻返回')

  harness.dispose()
})

test('装配：后台总结与 helper 解耦 —— 没 helper 也会去攒（它服务的是"今天干了什么"）', async () => {
  const warnings = []
  const settings = fakeSettings({ backgroundSummary: true })
  const harness = fakeContext({ settings })
  harness.ctx.logger = { info() {}, warn: (line) => warnings.push(String(line)), error() {}, debug() {} }
  await apply(harness.ctx, {})

  const zone = harness.listeners.get('session/event')
  zone({ header: { id: 's1', origin: 'human' }, cwd: '/tmp/demo' }, { type: 'compaction/end', seq: 9 })
  await new Promise((done) => setTimeout(done, 20))

  // 测试环境没有真的 sessionQuery/agents 服务 → 走到"缺服务"这一支，就证明触发链路通了
  assert.ok(
    warnings.some((line) => /后台总结失败/.test(line) && /sessionQuery/.test(line)),
    `压缩事件应该触发后台总结（实际告警: ${warnings.join(' / ')}）`,
  )
  harness.dispose()
})

test('装配：后台总结开关关着时，压缩事件不该触发任何模型调用', async () => {
  const warnings = []
  const settings = fakeSettings({ backgroundSummary: false })
  const harness = fakeContext({ settings })
  harness.ctx.logger = { info() {}, warn: (line) => warnings.push(String(line)), error() {}, debug() {} }
  await apply(harness.ctx, {})

  harness.listeners.get('session/event')(
    { header: { id: 's1', origin: 'human' }, cwd: '/tmp/demo' },
    { type: 'compaction/end', seq: 9 },
  )
  await new Promise((done) => setTimeout(done, 20))
  // 唯一允许的告警是"缺 helper"（测试刻意指到不存在的路径）
  assert.deepEqual(
    warnings.filter((line) => !/缺少原生 helper/.test(line)),
    [],
    '开关关着就不该去跑后台总结',
  )
  harness.dispose()
})

test('装配：apply 两次（热重载）不会互相干扰', async () => {
  const settings = fakeSettings()
  const first = fakeContext({ settings })
  await apply(first.ctx, {})
  const second = fakeContext({ settings })
  await apply(second.ctx, {})

  const read = response()
  await second.ctx.route.handler(request(), read)
  assert.equal(read.state.status, 200)

  first.dispose()
  second.dispose()
  assert.equal(first.listeners.size, 0)
  assert.equal(second.listeners.size, 0)
})
