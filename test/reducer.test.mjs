/**
 * 事件归一化 → 状态机 → 多项目归约（宠物状态的整条链路）。
 *
 * 这一层全是纯函数，不需要 DSH、不需要 helper。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PetMessageKind, PetState } from '../src/protocol.js'
import { PetReducer } from '../src/pet-reducer.js'
import { ProjectStateMachine, TRANSITIONS, Trigger } from '../src/state-machine.js'
import { asksUser, classifyTool, isKnownEvent, normalize, projectName, sessionId, turnEndKind } from '../src/events.js'

function session(id = 's1', origin = 'human') {
  return { header: { id, origin }, id, cwd: '/tmp/demo' }
}

function withCwd(id, dir) {
  const value = session(id, 'human')
  value.cwd = `/home/dev/projects/${dir}`
  return value
}

function statesOf(messages) {
  return messages.filter((message) => message.kind === PetMessageKind.STATE).map((message) => message.state)
}

/* ------------------------------------------------------------ 状态归约 */

test('归约：回合开始→思考，工具调用→工作，结束→庆祝停留态 + 脉冲', () => {
  const reducer = new PetReducer()
  assert.deepEqual(statesOf(reducer.handle(session(), { type: 'turn/start', seq: 1 })), [PetState.THINKING])
  assert.deepEqual(
    statesOf(reducer.handle(session(), { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1' } })),
    [PetState.WORKING],
  )
  const end = reducer.handle(session(), { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
  assert.deepEqual(statesOf(end), [PetState.SUCCESS])
  const pulse = end.find((message) => message.kind === PetMessageKind.PULSE)
  assert.equal(pulse.state, PetState.SUCCESS)
  assert.ok(pulse.ttlMs >= 2000)
})

test('归约：庆祝停留态由 tick 回落（2.2s 后回到待机）', () => {
  const reducer = new PetReducer()
  reducer.handle(session(), { type: 'turn/start', seq: 1 })
  reducer.handle(session(), { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
  assert.deepEqual(statesOf(reducer.tick(Date.now())), [], '还没到点不该回落')
  assert.deepEqual(statesOf(reducer.tick(Date.now() + 5000)), [PetState.IDLE])
})

test('归约：回合失败 → 报错停留态；被中止 → 直接回待机', () => {
  const failed = new PetReducer()
  failed.handle(session(), { type: 'turn/start', seq: 1 })
  assert.deepEqual(
    statesOf(failed.handle(session(), { type: 'turn/end', seq: 2, data: { reason: { kind: 'failed' } } })),
    [PetState.ERROR],
  )

  const aborted = new PetReducer()
  aborted.handle(session(), { type: 'turn/start', seq: 1 })
  const messages = aborted.handle(session(), { type: 'turn/end', seq: 2, data: { reason: { kind: 'aborted' } } })
  assert.deepEqual(statesOf(messages), [PetState.IDLE])
})

test('归约：回合被阻塞（blocked）→ 停在等待确认，不吃庆祝', () => {
  const reducer = new PetReducer()
  reducer.handle(session(), { type: 'turn/start', seq: 1 })
  assert.deepEqual(
    statesOf(reducer.handle(session(), { type: 'turn/end', seq: 2, data: { reason: { kind: 'blocked' } } })),
    [PetState.WAITING],
  )
})

test('归约：工具分类决定气泡文案所属阶段', () => {
  const reducer = new PetReducer()
  reducer.handle(session(), { type: 'turn/start', seq: 1 })
  const search = reducer.handle(session(), { type: 'tool/call', seq: 2, data: { name: 'web_search', callId: 'a' } })
  assert.match(search.at(-1).detail, /查找阶段/)
  const edit = reducer.handle(session(), { type: 'tool/call', seq: 3, data: { name: 'apply_patch', callId: 'b' } })
  assert.match(edit.at(-1).detail, /实现阶段/)
})

test('归约：需要人类拍板的工具 → 等待确认', () => {
  const reducer = new PetReducer()
  reducer.handle(session(), { type: 'turn/start', seq: 1 })
  const waiting = reducer.handle(session(), {
    type: 'tool/call', seq: 2, data: { name: 'ask_user_question', callId: 'q1' },
  })
  assert.deepEqual(statesOf(waiting), [PetState.WAITING])
})

test('归约：工具报错只闪错误脉冲，耐久状态不被污染', () => {
  const reducer = new PetReducer()
  reducer.handle(session(), { type: 'turn/start', seq: 1 })
  reducer.handle(session(), { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1' } })
  const result = reducer.handle(session(), { type: 'tool/result', seq: 3, data: { callId: 'c1', error: { code: 'E1' } } })
  assert.deepEqual(statesOf(result), [PetState.THINKING], '工具结束后回到思考')
  const pulse = result.find((message) => message.kind === PetMessageKind.PULSE)
  assert.equal(pulse?.state, PetState.ERROR)
})

test('归约：todo/write 会把任务名带进气泡细节', () => {
  const reducer = new PetReducer()
  reducer.handle(session(), { type: 'turn/start', seq: 1 })
  const messages = reducer.handle(session(), {
    type: 'todo/write', seq: 2,
    data: { todos: [{ content: '修复登录接口', status: 'in_progress' }, { content: '写测试', status: 'pending' }] },
  })
  assert.match(messages.at(-1).detail, /修复登录接口|1\/2/)
})

test('归约：未知事件与子 Agent 默认忽略', () => {
  const reducer = new PetReducer()
  assert.deepEqual(reducer.handle(session(), { type: 'something/else', seq: 1 }), [])
  const sub = session('sub', 'subagent')
  assert.deepEqual(reducer.handle(sub, { type: 'turn/start', seq: 1 }), [])
  assert.deepEqual(reducer.roster(), [], '被忽略的会话不该出现在项目名单里')
})

test('归约：可开启子 Agent，关闭后回到待机', () => {
  const reducer = new PetReducer({ includeSubagents: true })
  const sub = session('sub', 'subagent')
  assert.deepEqual(statesOf(reducer.handle(sub, { type: 'turn/start', seq: 1 })), [PetState.THINKING])
  assert.deepEqual(statesOf(reducer.setIncludeSubagents(false)), [PetState.IDLE])
})

test('归约：项目数超上限时淘汰最久没动的空闲项目', () => {
  const reducer = new PetReducer({ maxSessions: 2 })
  reducer.handle(withCwd('a', 'p1'), { type: 'turn/start', seq: 1 })
  reducer.handle(withCwd('b', 'p2'), { type: 'turn/start', seq: 1 })
  reducer.handle(withCwd('a', 'p1'), { type: 'turn/start', seq: 2 })
  reducer.handle(withCwd('c', 'p3'), { type: 'turn/start', seq: 1 })
  const ids = reducer.roster().map((entry) => entry.id).sort()
  assert.deepEqual(ids, ['a', 'c'], 'b 最久没动过，先被淘汰')
})

test('并行：两个会话同时干活时，主角不会来回翻转（画面才不会闪）', () => {
  // 用户实测的现象：点通知切到另一个会话后，宠物素材在两张图之间来回换 →
  // 两张图宽高不同，窗口宽度跟着变 → "人在原地闪"。
  const reducer = new PetReducer({ focusDwellMs: 3000, now: () => current })
  let current = 1000

  const a = withCwd('a', 'p1')
  const b = withCwd('b', 'p2')
  reducer.handle(a, { type: 'turn/start', seq: 1 })
  reducer.handle(b, { type: 'turn/start', seq: 1 })
  const started = reducer.focus().id

  // 两个会话交替刷事件：主角必须保持不动
  for (let index = 0; index < 6; index += 1) {
    current += 100
    reducer.handle(index % 2 === 0 ? a : b, { type: 'tool/call', seq: 10 + index, data: { name: 'bash', callId: `c${index}` } })
  }
  assert.equal(reducer.focus().id, started, '停留时间内不该换主角')

  // 停留时间过了，才允许让"最近更新的"上台
  current += 5000
  reducer.handle(b, { type: 'tool/call', seq: 99, data: { name: 'bash', callId: 'c9' } })
  assert.equal(reducer.focus().id, 'b', '过了停留时间就可以换')
})

test('并行：等你确认 / 出错可以立刻抢主角（该打断的要打断）', () => {
  let current = 1000
  const reducer = new PetReducer({ focusDwellMs: 3000, now: () => current })
  const a = withCwd('a', 'p1')
  const b = withCwd('b', 'p2')
  reducer.handle(a, { type: 'turn/start', seq: 1 })
  reducer.handle(b, { type: 'turn/start', seq: 1 })
  reducer.handle(a, { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1' } })
  const started = reducer.focus().id

  current += 100   // 远没到停留时间
  reducer.handle(b, { type: 'tool/call', seq: 3, data: { name: 'ask_user_question', callId: 'q1' } })
  assert.equal(reducer.focus().id, 'b', '有人在等你 → 立刻上台')
  assert.notEqual(reducer.focus().id, started)
})

test('并行：当前主角空闲时，新任务不必等停留时间', () => {
  let current = 1000
  const reducer = new PetReducer({ focusDwellMs: 3000, now: () => current })
  const a = withCwd('a', 'p1')
  const b = withCwd('b', 'p2')
  reducer.handle(a, { type: 'turn/start', seq: 1 })
  reducer.handle(a, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
  assert.equal(reducer.focus().id, 'a')

  current += 50
  reducer.handle(b, { type: 'turn/start', seq: 1 })
  assert.equal(reducer.focus().id, 'b', '原来的角儿已经收工，新任务立刻接管')
})

/* -------------------------------------------------- 多项目并行（重点） */

test('并行：两个项目在跑时，第一行只说数量，第二行逐项目列状态', () => {
  const reducer = new PetReducer()
  const a = withCwd('a', 'agent-mesh')
  const b = withCwd('b', 'assistant')

  reducer.handle(a, { type: 'turn/start', seq: 1 })
  reducer.handle(a, { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1' } })
  const messages = reducer.handle(b, { type: 'turn/start', seq: 1 })

  const state = messages.find((message) => message.kind === PetMessageKind.STATE)
  assert.equal(state.message, '2 个在跑')
  assert.match(state.detail, /agent-mesh ●/)
  assert.match(state.detail, /assistant ◐/)
  assert.equal(state.parallel.running, 2)
})

test('并行：有人在等确认时，第一行补出「M 个等你」', () => {
  const reducer = new PetReducer()
  const a = withCwd('a', 'agent-mesh')
  const b = withCwd('b', 'assistant')
  reducer.handle(a, { type: 'turn/start', seq: 1 })
  reducer.handle(b, { type: 'turn/start', seq: 1 })
  const messages = reducer.handle(b, { type: 'tool/call', seq: 2, data: { name: 'ask_user_question', callId: 'q' } })
  const state = messages.find((message) => message.kind === PetMessageKind.STATE)
  assert.equal(state.message, '1 个在跑，1 个等你')
  assert.match(state.detail, /assistant ⏸/, '等你确认的项目排最前')
})

test('并行：项目多于三行时用 +N 收尾，第一行仍然很短', () => {
  const reducer = new PetReducer({ rosterSize: 3 })
  for (const [id, dir] of [['a', 'p1'], ['b', 'p2'], ['c', 'p3'], ['d', 'p4']]) {
    reducer.handle(withCwd(id, dir), { type: 'turn/start', seq: 1 })
  }
  assert.equal(reducer.roster().length, 4)
  const messages = reducer.handle(withCwd('a', 'p1'), { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'x' } })
  const rendered = messages.find((message) => message.kind === PetMessageKind.STATE)
  assert.equal(rendered.message, '4 个在跑')
  assert.match(rendered.detail, /\+1$/, '第四个用 +1 表示')
  assert.ok(rendered.message.length <= 12, `第一行要短，实际 ${rendered.message.length} 字`)
})

test('并行：单项目时恢复「项目 · 阶段」细节', () => {
  const reducer = new PetReducer()
  const a = withCwd('a', 'agent-mesh')
  reducer.handle(a, { type: 'turn/start', seq: 1 })
  const messages = reducer.handle(a, { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1' } })
  const state = messages.find((message) => message.kind === PetMessageKind.STATE)
  assert.match(state.message, /命令|执行/)
  assert.match(state.detail, /agent-mesh · 执行阶段/)
  assert.equal(state.parallel, undefined)
})

test('并行：会话销毁后主角换成剩下的项目', () => {
  const reducer = new PetReducer()
  const a = withCwd('a', 'agent-mesh')
  reducer.handle(a, { type: 'turn/start', seq: 1 })
  const settled = reducer.disposeSession(a)
  assert.deepEqual(statesOf(settled), [PetState.IDLE])
  assert.deepEqual(reducer.roster(), [])
})

/* ------------------------------------------------- 事件枚举与状态机 */

test('事件枚举：工具分类、需要提问的工具、回合原因归一化', () => {
  assert.equal(classifyTool('web_search'), 'searching')
  assert.equal(classifyTool('apply_patch'), 'editing')
  assert.equal(classifyTool('run_tests'), 'testing')
  assert.equal(classifyTool('bash'), 'commanding')
  assert.equal(classifyTool('whatever'), 'using-tool')

  assert.equal(asksUser('ask_user_question'), true)
  assert.equal(asksUser('exit_plan_mode'), true)
  assert.equal(asksUser('code_review'), false)
  assert.equal(asksUser('permission_scan'), false)

  assert.equal(turnEndKind({ data: { reason: { kind: 'completed' } } }), 'completed')
  assert.equal(turnEndKind({ data: { reason: { kind: 'weird' } } }), 'failed', '未知原因按失败处理')
  assert.equal(isKnownEvent('turn/start'), true)
  assert.equal(isKnownEvent('unknown/event'), false)
})

test('事件枚举：不认识的事件不参与状态判断', () => {
  assert.equal(normalize({ type: 'unknown/event', seq: 1 }), undefined)
  // request/header 之类只带展示信息、机器用不上的事件不该被归一化
  assert.equal(normalize({ type: 'request/header', seq: 1, data: { header: { config: { reasoningEffort: 'high' } } } }), undefined)
  assert.deepEqual(normalize({ type: 'turn/start', seq: 3 }), { kind: 'turn/start', seq: 3 })
})

test('事件枚举：工具调用带上 callId 与「要不要人类拍板」', () => {
  const call = normalize({ type: 'tool/call', seq: 2, data: { name: 'ask_user_question', callId: 'c9' } })
  assert.equal(call.tool, 'ask_user_question')
  assert.equal(call.callId, 'c9')
  assert.equal(call.asksUser, true)
  // 没有 callId 时按 seq 兜底，保证 openTools 的键唯一
  assert.equal(normalize({ type: 'tool/call', seq: 7, data: { name: 'bash' } }).callId, 'seq-7')
})

test('事件枚举：项目名截断，过长的目录名不会撑爆气泡', () => {
  const long = { cwd: '/home/dev/projects/a-very-long-project-name-here' }
  const name = projectName(long, {})
  assert.ok(name.length <= 14, `实际 ${name.length}`)
  assert.match(name, /…$/)
  assert.equal(projectName({ cwd: '/tmp/demo' }, {}), 'demo')
  assert.equal(sessionId({ header: { id: 'x' } }), 'x')
})

test('状态机：迁移表覆盖全部状态且目标合法', () => {
  const states = Object.values(PetState)
  for (const [from, table] of Object.entries(TRANSITIONS)) {
    assert.ok(states.includes(from), `非法起始状态 ${from}`)
    for (const [trigger, to] of Object.entries(table)) {
      assert.ok(Object.values(Trigger).includes(trigger), `非法触发 ${trigger}`)
      assert.ok(states.includes(to), `${from} --${trigger}--> 非法状态 ${to}`)
    }
  }
  assert.deepEqual(Object.values(PetState).sort(), [...new Set(Object.values(PetState))].sort())
})

test('状态机：等待确认期间来的新回合会把人等状态解除', () => {
  const machine = new ProjectStateMachine({ id: 's' })
  machine.consume({ kind: 'turn/start', seq: 1 }, 0)
  machine.consume({ kind: 'tool/call', seq: 2, tool: 'ask_user_question', callId: 'q', asksUser: true }, 0)
  assert.equal(machine.state, PetState.WAITING)
  machine.consume({ kind: 'user/message', seq: 3 }, 0)
  assert.notEqual(machine.state, PetState.WAITING, '用户已回复，不该继续停在等待')
})

test('状态机：回到 THINKING 时阶段标签跟着回落', () => {
  const machine = new ProjectStateMachine({ id: 's' })
  machine.consume({ kind: 'turn/start', seq: 1 }, 0)
  machine.consume({ kind: 'tool/call', seq: 2, tool: 'bash', callId: 'c', asksUser: false }, 0)
  machine.consume({ kind: 'tool/result', seq: 3, callId: 'c' }, 0)
  assert.equal(machine.state, PetState.THINKING)
  assert.equal(machine.stage, '整理阶段')
  machine.consume({ kind: 'assistant/chunk', seq: 4 }, 0)
  assert.equal(machine.stage, '分析阶段', 'THINKING 阶段不该一直挂着旧阶段名')
})

/* ---------------------------------------------------------- 完成通知 */

test('完成通知：并行时也要发，且只在被查看后清除', () => {
  const reducer = new PetReducer()
  const sessionA = { id: 'session-a', cwd: '/tmp/project-a', title: '项目A' }
  const sessionB = { id: 'session-b', cwd: '/tmp/project-b', title: '项目B' }

  // A 先跑起来，B 后跑起来 → 主角是 B（A 完成时已不是焦点）
  reducer.handle(sessionA, { type: 'turn/start', seq: 1 })
  reducer.handle(sessionA, { type: 'step/start', seq: 2 })
  reducer.handle(sessionB, { type: 'turn/start', seq: 1 })
  reducer.handle(sessionB, { type: 'step/start', seq: 2 })

  // A 跑完：不在焦点，但必须发通知（否则用户看不到）
  const messages = reducer.handle(sessionA, { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
  const notices = messages.filter((message) => message.kind === 'notice')
  assert.equal(notices.length, 1, '非焦点项目跑完也要发通知')
  assert.equal(notices[0].state, 'SUCCESS')
  assert.ok(notices[0].id, '通知要带 id（用于精确清除）')
  assert.ok(notices[0].project, '通知要带项目名')
  assert.equal(notices[0].sessionId, 'session-a', '通知要带会话 id（点击时据此打开对话）')

  // 状态气泡被 B 抢走，通知仍然挂着
  assert.equal(reducer.pendingNotices().length, 1, '状态被抢走时通知仍在')
  assert.ok(messages.filter((message) => message.kind === 'state').length >= 1, '状态本身照常下发')

  // 回到 A 说话 = 已查看 → 清除
  const seen = reducer.handle(sessionA, { type: 'user/message', seq: 4 })
  const clears = seen.filter((message) => message.kind === 'notice-clear')
  assert.equal(clears.length, 1, '用户回到该项目后清掉通知')
  assert.equal(clears[0].reason, 'seen')
  assert.equal(reducer.pendingNotices().length, 0, '清完之后没有挂着的通知')

  // 点击关闭：原生端上报 interaction，宿主侧也要能清
  reducer.handle(sessionA, { type: 'turn/start', seq: 5 })
  reducer.handle(sessionA, { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } })
  const pending = reducer.pendingNotices()
  assert.equal(pending.length, 1, '再次完成又挂一条')
  assert.equal(reducer.dismissNotice(pending[0].id), true, '按 id 清除成功')
  assert.equal(reducer.pendingNotices().length, 0)
  assert.equal(reducer.dismissNotice('不存在的 id'), false, '清不存在的 id 返回 false')

  // 出错也发通知
  reducer.handle(sessionA, { type: 'turn/start', seq: 7 })
  const failed = reducer.handle(sessionA, { type: 'turn/end', seq: 8, data: { reason: { kind: 'failed' } } })
  const errorNotice = failed.filter((message) => message.kind === 'notice')
  assert.equal(errorNotice.length, 1, '出错同样发通知')
  assert.equal(errorNotice[0].state, 'ERROR')

  // 用户在 DSH 里打开这个会话（宿主 resume → session/created）→ 通知算已查看
  reducer.handle(sessionA, { type: 'turn/start', seq: 20 })
  reducer.handle(sessionA, { type: 'turn/end', seq: 21, data: { reason: { kind: 'completed' } } })
  reducer.handle(sessionB, { type: 'turn/start', seq: 20 })
  reducer.handle(sessionB, { type: 'turn/end', seq: 21, data: { reason: { kind: 'completed' } } })
  const beforeOpen = reducer.pendingNotices()
  assert.ok(beforeOpen.length >= 2, '两个会话都有挂着的通知')
  const forA = beforeOpen.filter((notice) => notice.id.includes('session-a')).length
  const opened = reducer.markSessionSeen('session-a')
  assert.equal(opened.length, forA, '被打开那个会话的通知全清（A 自己可能挂了多条）')
  assert.equal(opened[0].reason, 'opened')
  assert.ok(reducer.pendingNotices().every((notice) => !notice.id.includes('session-a')), 'A 的通知已清空')
  assert.ok(reducer.pendingNotices().length >= 1, '另一个会话（B）的通知还在')
  assert.equal(reducer.markSessionSeen('session-a').length, 0, '重复打开不会重复清')

  // 会话销毁 → 它挂着的通知一起清（用还有通知的 B 验证）
  const disposed = reducer.disposeSession(sessionB)
  assert.ok(disposed.some((message) => message.kind === 'notice-clear'), '会话销毁时清掉它的通知')
})

test('完成通知：每个项目最多挂 MAX 条，不会无限长', () => {
  const reducer = new PetReducer()
  const a = session('a')
  for (let index = 0; index < 8; index += 1) {
    reducer.handle(a, { type: 'turn/start', seq: index * 2 + 1 })
    reducer.handle(a, { type: 'turn/end', seq: index * 2 + 2, data: { reason: { kind: 'completed' } } })
  }
  assert.ok(reducer.pendingNotices().length <= 4, `实际 ${reducer.pendingNotices().length}`)
})
