/**
 * 客户端插件（src/client.js）的接线测试。
 *
 * 这个文件跑在浏览器的模块加载器里（`window.__ModuleLoader__.load` + 注入的 React），
 * 所以这里把这两样都替身掉，然后验证它对外做的两件事：
 *   · 往设置页/插件卡注册 PetCard（槽位参数必须是各自契约要求的那套）；
 *   · 订阅会话列表的 current，把"用户在看哪个会话"上报给宿主端点。
 *
 * 后半件是"点了侧边栏、完成通知却不消失"那个 bug 的修复点，
 * 没有别的自动化手段能覆盖它（要真的点 UI）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'

import { VIEWED_ENDPOINT } from '../src/pet-endpoint.js'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 按浏览器的方式加载 src/client.js，拿到它的模块导出。 */
function loadClientModule({ withDom = false } = {}) {
  const source = readFileSync(resolve(root, 'src/client.js'), 'utf8')
  const react = {
    createElement: (type) => ({ type }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  }
  let loaded
  const listeners = new Map()
  const window = {
    __ModuleLoader__: { load: (module) => { loaded = module } },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  }
  const document = withDom
    ? {
      visibilityState: 'visible',
      addEventListener: (name, fn) => listeners.set(`doc:${name}`, fn),
      removeEventListener: (name) => listeners.delete(`doc:${name}`),
    }
    : undefined
  const factory = new Function('window', 'document', 'require', source)
  factory(window, document, (id) => {
    if (id === 'react') return react
    throw new Error(`未预期的依赖: ${id}`)
  })
  const module = loaded.factory((id) => {
    if (id === 'react') return react
    throw new Error(`未预期的依赖: ${id}`)
  })
  module.__listeners = listeners
  return module
}

/** 假客户端上下文：只实现 slots / inject / effect / get。 */
function fakeClientContext({ sessions, uiWorkspace } = {}) {
  const slots = []
  const effects = []
  const injected = []
  const services = { sessions, uiWorkspace }
  const ctx = {
    slots: {
      register(options) { slots.push(options); return () => {} },
      inject(name, callback) { injected.push([name, callback]); callback() },
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['sessions'])
      callback({ get: (key) => (key === 'sessions' ? sessions : undefined) })
    },
    effect(callback) { effects.push(callback()) },
    get: (key) => services[key],
  }
  // 插件跑起来后会开一个长轮询循环，测试结束必须停掉，否则进程不退出
  const stop = () => { for (const dispose of effects) { try { dispose?.() } catch { /* 忽略 */ } } }
  return { ctx, slots, effects, injected, stop }
}

/** 假会话列表 store（与 dsh-client-store 的 SnapshotStore 同形）。 */
function fakeSessionList(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    push(next) { snapshot = next; for (const fn of [...listeners]) fn() },
  }
}

test('客户端：注册设置页，槽位参数合规；0.2 里没有的插件卡不再注册', () => {
  const module = loadClientModule()
  assert.equal(module.name, 'dsh-assistant-client')
  assert.deepEqual(module.inject, ['slots'])

  const harness = fakeClientContext({})
  module.apply(harness.ctx)

  const section = harness.slots.find((options) => options.name === 'settings.section')
  assert.ok(section, '要注册设置页（list 槽位）')
  assert.equal(section.id, 'dsh-assistant', 'list 槽位必须有 id')
  assert.equal(typeof section.label, 'function', 'label 用 thunk 形式')
  assert.equal(typeof section.inject, 'function', 'inject 是 props 工厂')

  // DSH 0.2 起 `settings.plugin.item` 这个槽位没了（插件页改成 settings.plugins.tab，
  // 条目卡片由插件导出的 Config 自动生成）。往里注册只会是一条永远不触发的死声明，
  // 所以这里守的是"别再写回去"。
  assert.equal(
    harness.slots.filter((options) => options.name === 'settings.plugin.item').length, 0,
    'settings.plugin.item 在 0.2 里已不存在，不该再注册',
  )
  harness.stop()
})

test('客户端（0.2）：当前会话由"主视图保留"表达 —— 手动切过去也要上报', async () => {
  const module = loadClientModule()
  // 0.2 的会话列表快照没有 current：谁被 mainView 保留着，谁就是用户正在看的那个
  const snapshot = (mainId) => ({
    ids: ['session-a', 'session-b'],
    byId: {
      'session-a': { id: 'session-a', retainedBy: mainId === 'session-a' ? { mainView: 1 } : {} },
      'session-b': { id: 'session-b', retainedBy: mainId === 'session-b' ? { mainView: 1 } : {} },
    },
  })
  const list = fakeSessionList(snapshot('session-a'))
  const harness = fakeClientContext({ sessions: { list } })

  const posted = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    posted.push([url, JSON.parse(options.body)])
    return { ok: true, json: async () => ({}) }
  }
  try {
    module.apply(harness.ctx)
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(posted.map(([, body]) => body.sessionId), ['session-a'], '订阅时先报当前那个')

    // 用户手点侧边栏切到 session-b：保留来源跟着换 → 必须再报一次，
    // 否则那条完成通知会一直挂在宠物上方（用户实测的毛病）
    list.push(snapshot('session-b'))
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(posted.map(([, body]) => body.sessionId), ['session-a', 'session-b'])

    // 切走的那一瞬间可能"谁都没被保留"：那时不该报，也不该炸
    list.push({ ids: [], byId: {} })
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(posted.map(([, body]) => body.sessionId), ['session-a', 'session-b'])
  } finally {
    globalThis.fetch = originalFetch
    harness.stop()
  }
})

test('客户端：切换会话会向宿主上报"我在看这个会话"', async () => {
  const module = loadClientModule()
  const list = fakeSessionList({ current: undefined })
  const harness = fakeClientContext({ sessions: { list } })

  const posted = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    posted.push([url, JSON.parse(options.body)])
    return { ok: true, json: async () => ({}) }
  }
  try {
    module.apply(harness.ctx)

    list.push({ current: 'session-a' })
    list.push({ current: 'session-a' })   // 同一个会话重复推送不该重复上报
    list.push({ current: 'session-b' })
    await new Promise((done) => setTimeout(done, 0))

    assert.deepEqual(posted.map(([, body]) => body.sessionId), ['session-a', 'session-b'])
    assert.equal(posted[0][0], VIEWED_ENDPOINT, '测试引用端点常量，不再手抄一份字面量')
    assert.equal(posted[0][1].sessionId, 'session-a')
  } finally {
    globalThis.fetch = originalFetch
    harness.stop()
  }
})

test('客户端：回到 DSH 时（当前会话没变）也会重新上报一次', async () => {
  const module = loadClientModule({ withDom: true })
  const list = fakeSessionList({ current: 'session-a' })
  const harness = fakeClientContext({ sessions: { list } })

  const posted = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => { posted.push(JSON.parse(options.body).sessionId); return { ok: true } }
  try {
    module.apply(harness.ctx)
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(posted, ['session-a'], '订阅时先报一次当前会话')

    // 任务在别的应用里完成 → 回到 DSH：current 没变，但要再报一次。
    // 等过"合并窗口"，再同时触发 focus + visibilitychange（两者本来就几乎同时来）
    await new Promise((done) => setTimeout(done, 250))
    module.__listeners.get('focus')?.()
    module.__listeners.get('doc:visibilitychange')?.()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(posted, ['session-a', 'session-a'], '回到窗口要重新上报（两个事件合并成一次）')
  } finally {
    globalThis.fetch = originalFetch
    harness.stop()
  }
})

test('客户端：没有选中会话 / 端点失败都不该抛', async () => {
  const module = loadClientModule()
  const list = fakeSessionList({ current: undefined })
  const harness = fakeClientContext({ sessions: { list } })

  const originalFetch = globalThis.fetch
  // 只数"上报我在看哪个会话"的那些请求：命令通道自己也在长轮询 /pending
  const viewed = []
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/viewed')) viewed.push(url)
    throw new Error('宿主没起来')
  }
  try {
    module.apply(harness.ctx)
    list.push({ current: undefined })
    list.push({ current: '' })
    await new Promise((done) => setTimeout(done, 0))
    assert.equal(viewed.length, 0, '没有会话 id 就不该发请求')

    list.push({ current: 'session-c' })
    await new Promise((done) => setTimeout(done, 0))
    assert.equal(viewed.length, 1, '有 id 就发一次（失败被吞掉，不影响界面）')
  } finally {
    globalThis.fetch = originalFetch
    harness.stop()
  }
})

test('客户端：收到"打开会话"命令就切过去（0.2 走 uiWorkspace.openSession）', async () => {
  const module = loadClientModule()
  const list = fakeSessionList({ current: 'session-now' })
  const opened = []
  // 0.2 的客户端里 `sessions.open` 已经没有了：切主视图归 workspace 服务
  const harness = fakeClientContext({
    sessions: { list },
    uiWorkspace: { openSession: (id) => opened.push(id) },
  })

  const originalFetch = globalThis.fetch
  let served = 0
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/pending')) return { ok: true, json: async () => ({}) }
    served += 1
    return served === 1
      ? { ok: true, json: async () => ({ commands: [{ kind: 'open-session', sessionId: 'session-a' }] }) }
      : { ok: false }        // 之后一律失败，避免测试里无限循环
  }
  try {
    module.apply(harness.ctx)
    await new Promise((done) => setTimeout(done, 50))
    assert.deepEqual(opened, ['session-a'], '要调用 uiWorkspace.openSession(sessionId)')
    await new Promise((done) => setTimeout(done, 30))
    assert.deepEqual(opened, ['session-a'], '重复命令不该重复执行')
  } finally {
    globalThis.fetch = originalFetch
    harness.stop()
  }
})

test('客户端：老客户端（0.1，没有 uiWorkspace）退回 sessions.open', async () => {
  const module = loadClientModule()
  const list = fakeSessionList({ current: 'session-now' })
  const opened = []
  const harness = fakeClientContext({ sessions: { list, open: (id) => opened.push(id) } })

  const originalFetch = globalThis.fetch
  let served = 0
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/pending')) return { ok: true, json: async () => ({}) }
    served += 1
    return served === 1
      ? { ok: true, json: async () => ({ commands: [{ kind: 'open-session', sessionId: 'session-b' }] }) }
      : { ok: false }
  }
  try {
    module.apply(harness.ctx)
    await new Promise((done) => setTimeout(done, 50))
    assert.deepEqual(opened, ['session-b'])
  } finally {
    globalThis.fetch = originalFetch
    harness.stop()
  }
})

test('回归：两代接口都没有时不许静默 —— 控制台要留下一条', async () => {
  const module = loadClientModule()
  const harness = fakeClientContext({ sessions: { list: fakeSessionList({ current: undefined }) } })

  const errors = []
  const originalError = console.error
  const originalFetch = globalThis.fetch
  let served = 0
  console.error = (line) => errors.push(String(line))
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/pending')) return { ok: true, json: async () => ({}) }
    served += 1
    return served === 1
      ? { ok: true, json: async () => ({ commands: [{ kind: 'open-session', sessionId: 'session-a' }] }) }
      : { ok: false }
  }
  try {
    module.apply(harness.ctx)
    await new Promise((done) => setTimeout(done, 50))
    assert.equal(errors.length, 1, '必须说一次"这个客户端打不开会话"，而不是一声不吭')
    assert.match(errors[0], /uiWorkspace|sessions\.open/)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    harness.stop()
  }
})

test('客户端：打开会话抛错（会话已销毁）不该被当成通信故障', async () => {
  const module = loadClientModule()
  const list = fakeSessionList({ current: 'session-now' })
  const attempted = []
  const harness = fakeClientContext({
    sessions: { list },
    uiWorkspace: { openSession: (id) => { attempted.push(id); throw new Error('session gone') } },
  })

  const originalFetch = globalThis.fetch
  let served = 0
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/pending')) return { ok: true, json: async () => ({}) }
    served += 1
    return served === 1
      ? { ok: true, json: async () => ({ commands: [{ kind: 'open-session', sessionId: 'gone' }] }) }
      : { ok: false }
  }
  try {
    module.apply(harness.ctx)
    await new Promise((done) => setTimeout(done, 60))
    assert.deepEqual(attempted, ['gone'], '还是要尝试打开')
    assert.ok(warnings.some((line) => /打开会话失败/.test(line)), '失败留痕，但不当通信故障')
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    harness.stop()
  }
})

test('客户端：拿不到 sessions 服务时安静跳过（设置页照常注册）', () => {
  const module = loadClientModule()
  const harness = fakeClientContext({ sessions: undefined })
  module.apply(harness.ctx)
  assert.ok(harness.slots.some((options) => options.name === 'settings.section'),
    '没有 sessions 也要把设置页注册上')
  harness.stop()
})

test('客户端：没有 subscribe（老客户端）时安静跳过，不误报', () => {
  const module = loadClientModule()
  const harness = fakeClientContext({ sessions: { list: { getSnapshot: () => ({ current: 'x' }) } } })
  module.apply(harness.ctx)
  assert.ok(harness.slots.length >= 1, '设置页照常注册')
  harness.stop()
})

test('客户端：会话 id 不等 / 列表项结构变化时不误报、也不炸', async () => {
  const module = loadClientModule()
  const posted = []
  globalThis.fetch = async (url, options) => { posted.push([url, JSON.parse(options.body)]); return { ok: true } }
  const list = fakeSessionList({ current: 'session-a', items: [{ id: 'session-a' }] })
  const harness = fakeClientContext({ sessions: { list } })
  module.apply(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(posted.map(([, body]) => body.sessionId), ['session-a'], '订阅时先报当前会话')

  // ① id 真变了 → 要上报
  list.push({ current: 'session-b', items: [{ id: 'session-b' }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(posted.map(([, body]) => body.sessionId), ['session-a', 'session-b'])

  // ② id 没变、只是列表项换了形状（少字段 / 换结构）→ 不该再上报，也不该抛
  const before = posted.length
  list.push({ current: 'session-b', items: [{ sessionId: 'session-b', title: '换了形状' }, 'oops', null] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(posted.length, before, '会话没变就不该重复上报')
  harness.stop()
})
