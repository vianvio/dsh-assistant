/**
 * events.js —— DSH 会话事件的**枚举与归一化**（单项目视角）。
 *
 * 这一层只回答一个问题：一条 `session/event` 到底属于哪一类、携带了什么关键信息。
 * 它不做任何状态判断（那是 state-machine.js 的事），也不拼文案（pet-copy.js）。
 * 这样三件事各自可单测，DSH 事件结构变化时只改这一个文件。
 *
 * **只枚举我们真的会用的类型**：不认识的一律返回 undefined 忽略，
 * 不做兜底猜测（猜错比不猜更糟）。
 *
 * | 原始事件            | 机器可见的语义            | 关键字段                                   |
 * |---------------------|---------------------------|--------------------------------------------|
 * | turn/start          | 回合开始                  | —                                          |
 * | step/start          | 步骤推进                  | —                                          |
 * | assistant/chunk     | 流式产出                  | —                                          |
 * | assistant/message   | 产出完成                  | —                                          |
 * | tool/call           | 工具开始                  | data.name / data.callId                    |
 * | tool/result         | 工具结束                  | data.callId / data.error                   |
 * | todo/write          | 任务清单更新              | data.todos[].content / .status             |
 * | approval/asked      | 需要审批                  | data.id / data.toolName                    |
 * | approval/decided    | 审批有结果                | data.id                                    |
 * | user/message        | 用户发话（回答等待）      | —                                          |
 * | turn/end            | 回合结束                  | data.reason.kind                           |
 */

/** 我们认得的会话事件（其余事件一律忽略）。 */
export const SessionEventKind = Object.freeze({
  TURN_START: 'turn/start',
  STEP_START: 'step/start',
  ASSISTANT_CHUNK: 'assistant/chunk',
  ASSISTANT_MESSAGE: 'assistant/message',
  TOOL_CALL: 'tool/call',
  TOOL_RESULT: 'tool/result',
  TODO_WRITE: 'todo/write',
  APPROVAL_ASKED: 'approval/asked',
  APPROVAL_DECIDED: 'approval/decided',
  USER_MESSAGE: 'user/message',
  TURN_END: 'turn/end',
})

/** 回合结束的原因（DSH 用 `data.reason.kind` 表达）。 */
export const TurnEndKind = Object.freeze({
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  ABORTED: 'aborted',
  MAX_TOKENS: 'max-tokens',
  FAILED: 'failed',
})

/** 工具活动分类（决定气泡说「在找东西」还是「在跑命令」）。 */
export const ToolActivity = Object.freeze({
  SEARCHING: 'searching',
  EDITING: 'editing',
  TESTING: 'testing',
  COMMANDING: 'commanding',
  USING_TOOL: 'using-tool',
})

const EVENT_KINDS = new Set(Object.values(SessionEventKind))
const TURN_END_KINDS = new Set(Object.values(TurnEndKind))
const ACTIVITY_RULES = [
  [ToolActivity.SEARCHING, /search|grep|find|glob|web|fetch|read|open|list/i],
  [ToolActivity.EDITING, /write|edit|patch|replace|create|move|delete|apply/i],
  [ToolActivity.TESTING, /test|check|lint|build|verify|typecheck/i],
  [ToolActivity.COMMANDING, /shell|bash|exec|command|terminal|powershell|job|process/i],
]

/** 事件类型是否被我们处理。 */
export function isKnownEvent(type) {
  return EVENT_KINDS.has(String(type ?? ''))
}

/** 工具名 → 活动分类（命中顺序即优先级，最后落到 using-tool）。 */
export function classifyTool(name) {
  const value = String(name ?? '')
  for (const [activity, pattern] of ACTIVITY_RULES) {
    if (pattern.test(value)) return activity
  }
  return ToolActivity.USING_TOOL
}

/**
 * 需要人类拍板的工具：问问题 / 计划审批 / 明确的授权类词。
 * 只看 token，避免 `code_review`、`permission_scan` 这类普通工具被误判。
 */
export function asksUser(name) {
  const tokens = String(name ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)
  if (tokens.includes('authorize') || tokens.includes('authorise') || tokens.includes('consent')) return true
  const asksQuestion = tokens.some((token, index) =>
    (token === 'ask' || token === 'request' || token === 'prompt')
    && /user|human|question|input|confirm|approval|permission/u.test(tokens[index + 1] ?? ''))
  const planApproval = tokens.some((token, index) =>
    token === 'exit' && tokens[index + 1] === 'plan' && tokens[index + 2] === 'mode')
  return asksQuestion || planApproval
}

/** 归一化回合结束原因（未知值统一按 failed 处理，宁可提示也不装作完成）。 */
export function turnEndKind(event) {
  const raw = String(event?.data?.reason?.kind ?? TurnEndKind.COMPLETED)
  return TURN_END_KINDS.has(raw) ? raw : TurnEndKind.FAILED
}

/** 工具调用的稳定 id（不同 DSH 版本字段位置不同，按优先级取）。 */
function toolCallId(event, fallback = '') {
  const content = event?.data?.message?.content
  const fromContent = Array.isArray(content) ? content.find((item) => item?.toolCallId)?.toolCallId : undefined
  return String(
    event?.data?.message?.source?.callId
      ?? fromContent
      ?? event?.data?.callId
      ?? event?.data?.id
      ?? fallback,
  )
}

function toolName(event) {
  return String(event?.data?.name ?? event?.data?.message?.name ?? event?.data?.toolName ?? 'tool')
}

/** TODO 清单 → { current, completed, total }；没有清单时返回 undefined。 */
function todoProgress(event) {
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : []
  if (todos.length === 0) return undefined
  const done = new Set(['completed', 'complete', 'done'])
  const completed = todos.filter((todo) => done.has(String(todo?.status ?? ''))).length
  const current = todos.find((todo) => todo?.status === 'in_progress')
    ?? todos.find((todo) => todo?.status === 'pending')
  return {
    current: current?.content ? String(current.content) : undefined,
    completed,
    total: todos.length,
  }
}

/** 会话 id（header.id 优先，退回 id / 兜底名）。 */
export function sessionId(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown-session')
}

/** 子 Agent 会话（默认不参与宠物状态，避免抢镜头）。 */
export function isSubagent(session) {
  return session?.header?.origin === 'subagent' || Number(session?.header?.delegationDepth ?? 0) > 0
}

/**
 * 项目名：优先事件里的 projectName（最新），再退回 cwd，最后退回会话标题。
 * 结果会被截断 —— 气泡里一行放不下长路径。
 */
export function projectName(session, event, { maxLength = 14 } = {}) {
  const candidates = [
    event?.data?.projectName,
    session?.cwd,
    session?.context?.cwd,
    session?.header?.cwd,
    session?.title,
    session?.header?.title,
  ]
  for (const candidate of candidates) {
    const text = String(candidate ?? '').trim()
    if (!text) continue
    const parts = text.split(/[\\/]/u).filter(Boolean)
    const name = parts.length > 1 ? parts.at(-1) : text
    const cleaned = name.replace(/\s+/gu, ' ').trim()
    if (cleaned) return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned
  }
  return undefined
}

/**
 * 把一条原始事件归一化成机器事件。
 * 返回 undefined 表示「这条事件不参与状态判断」。
 */
export function normalize(event) {
  if (!event || typeof event.type !== 'string') return undefined
  if (!isKnownEvent(event.type)) return undefined
  const base = { kind: event.type, seq: Number(event.seq ?? 0) }

  switch (event.type) {
    case SessionEventKind.TOOL_CALL: {
      const tool = toolName(event)
      return { ...base, tool, callId: toolCallId(event, `seq-${base.seq}`), asksUser: asksUser(tool) }
    }
    case SessionEventKind.TOOL_RESULT:
      return { ...base, callId: toolCallId(event), error: event.data?.error ? String(event.data.error.code ?? 'error') : undefined }
    case SessionEventKind.TODO_WRITE:
      return { ...base, progress: todoProgress(event) }
    case SessionEventKind.APPROVAL_ASKED:
      return { ...base, tool: String(event.data?.toolName ?? '') }
    case SessionEventKind.TURN_END:
      return { ...base, result: turnEndKind(event) }
    default:
      return base
  }
}
