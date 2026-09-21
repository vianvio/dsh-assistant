/**
 * state-machine.js —— **单项目视角**的宠物状态机。
 *
 * 输入是归一化事件（events.js），输出是状态迁移 + 该说什么话。刻意做成显式的
 * 迁移表而不是一串 if：状态、触发条件、副作用都写在表里，加事件类型时不会漏。
 *
 * 七个耐久状态（与原生端 pet-manifest 的 states 一一对应）：
 *
 *      ┌──────────── TURN_STARTED ────────────┐
 *      ▼                                      │
 *   ┌──────┐   TURN_STARTED   ┌──────────┐    │
 *   │ IDLE │ ───────────────▶ │ THINKING │◀───┼──── TOOL_FINISHED
 *   └──────┘                  └────┬─────┘    │
 *      ▲                           │ TOOL_STARTED
 *      │ TURN_SETTLED(aborted)     ▼
 *      │                     ┌──────────┐
 *      │◀────────────────────│ WORKING  │
 *      │                     └────┬─────┘
 *      │                          │ QUESTION_ASKED / APPROVAL_REQUESTED
 *      │                          ▼
 *      │                     ┌──────────┐  APPROVAL_RESOLVED / USER_REPLIED
 *      │                     │ WAITING  │ ─────────────────────────┐
 *      │                     └──────────┘                          │
 *      │                          │ TURN_SETTLED(blocked)         │
 *      │                          ▼                               ▼
 *      │                   （保持 WAITING）                  回到 THINKING/WORKING
 *      │
 *      ├── TURN_SETTLED(completed) ──▶ SUCCESS ──(hold 2.2s)──▶ IDLE
 *      └── TURN_SETTLED(failed)    ──▶ ERROR   ──(hold 3.0s)──▶ IDLE
 *
 *   DISCONNECTED 由 helper 掉线时宿主直接置位（见 pet-process 的失败路径）。
 */

import { PetState } from './protocol.js'
import { SessionEventKind, ToolActivity, TurnEndKind, classifyTool } from './events.js'
import { activityCopy, statusCopy } from './pet-copy.js'

/** 机器可见的触发事件（把 DSH 事件翻译成状态机语言）。 */
export const Trigger = Object.freeze({
  TURN_STARTED: 'TURN_STARTED',
  STEP_PROGRESS: 'STEP_PROGRESS',
  TOOL_STARTED: 'TOOL_STARTED',
  TOOL_FINISHED: 'TOOL_FINISHED',
  QUESTION_ASKED: 'QUESTION_ASKED',
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_RESOLVED: 'APPROVAL_RESOLVED',
  USER_REPLIED: 'USER_REPLIED',
  TURN_SETTLED: 'TURN_SETTLED',
  TASK_UPDATED: 'TASK_UPDATED',
})

/** SUCCESS / ERROR 是「短暂庆祝」：展示完自动回到 IDLE。 */
export const HOLD_MS = Object.freeze({
  [PetState.SUCCESS]: 2200,
  [PetState.ERROR]: 3000,
})

/**
 * 迁移表：`TRANSITIONS[当前状态][触发] = 目标状态`
 * 表里没有的组合 = 不迁移（只可能更新文案，见 #apply）。
 */
export const TRANSITIONS = Object.freeze({
  [PetState.IDLE]: {
    [Trigger.TURN_STARTED]: PetState.THINKING,
    [Trigger.APPROVAL_REQUESTED]: PetState.WAITING,
  },
  [PetState.THINKING]: {
    [Trigger.TOOL_STARTED]: PetState.WORKING,
    [Trigger.QUESTION_ASKED]: PetState.WAITING,
    [Trigger.APPROVAL_REQUESTED]: PetState.WAITING,
    [Trigger.STEP_PROGRESS]: PetState.THINKING,
    [Trigger.TASK_UPDATED]: PetState.THINKING,
  },
  [PetState.WORKING]: {
    [Trigger.TOOL_STARTED]: PetState.WORKING,
    [Trigger.TOOL_FINISHED]: PetState.THINKING,
    [Trigger.QUESTION_ASKED]: PetState.WAITING,
    [Trigger.APPROVAL_REQUESTED]: PetState.WAITING,
    [Trigger.TASK_UPDATED]: PetState.WORKING,
  },
  [PetState.WAITING]: {
    [Trigger.APPROVAL_RESOLVED]: PetState.THINKING,
    [Trigger.USER_REPLIED]: PetState.THINKING,
    [Trigger.TOOL_STARTED]: PetState.WORKING,
    [Trigger.TURN_STARTED]: PetState.THINKING,
  },
  [PetState.SUCCESS]: {
    [Trigger.TURN_STARTED]: PetState.THINKING,
    [Trigger.TOOL_STARTED]: PetState.WORKING,
  },
  [PetState.ERROR]: {
    [Trigger.TURN_STARTED]: PetState.THINKING,
    [Trigger.TOOL_STARTED]: PetState.WORKING,
  },
  [PetState.DISCONNECTED]: {
    [Trigger.TURN_STARTED]: PetState.THINKING,
  },
})

/**
 * 一个会话对应一台状态机。
 *
 * 它只维护「这个项目现在处于什么状态、开了几个工具、在干什么」，
 * 文案由 copy 模块生成，跨项目的取舍由 reducer 负责。
 */
export class ProjectStateMachine {
  constructor({ id } = {}) {
    this.id = String(id ?? 'unknown-session')
    this.state = PetState.IDLE
    this.message = statusCopy('idle')
    this.stage = '待机'
    this.task = undefined
    this.progress = undefined
    this.turnActive = false
    /** 未结束的工具调用（callId → 工具名），用来决定"还有活没干完" */
    this.openTools = new Map()
    this.holdUntil = 0
    this.updatedAt = 0
    /** 供渲染层判断是否需要下发（避免同状态重复刷）。 */
    this.revision = 0
  }

  /**
   * 消费一条归一化事件。
   * @returns {{ changed: boolean, state: string, trigger?: string, pulse?: object }}
   */
  consume(event, now = Date.now()) {
    if (!event || typeof event.kind !== 'string') return { changed: false, state: this.state }
    const trigger = triggerFor(event)
    if (!trigger) {
      // 没有触发迁移，但可能只更新文案（例如 todo 完成度）
      if (event.kind === SessionEventKind.TODO_WRITE && event.progress) {
        return this.#touch({ task: event.progress.current, progress: event.progress }, now)
      }
      return { changed: false, state: this.state }
    }

    // 状态自己带的计时器到点先回落（SUCCESS/ERROR → IDLE）
    const expired = this.#expireHold(now)
    const payload = this.#payloadFor(event, trigger)
    const result = this.#apply(trigger, payload, now)
    return expired && !result.changed ? { changed: true, state: this.state, trigger: 'HOLD_EXPIRED' } : result
  }

  /** 计时器驱动的状态（庆祝/报错停留）到点回落；返回是否有变化。 */
  tick(now = Date.now()) {
    return this.#expireHold(now)
  }

  // MARK: - 内部

  #payloadFor(event, trigger) {
    const seq = event.seq ?? 0
    switch (trigger) {
      case Trigger.TURN_STARTED:
        this.turnActive = true
        this.openTools.clear()
        this.task = undefined
        this.progress = undefined
        return { message: statusCopy('preparing', seq), stage: '准备阶段' }
      case Trigger.STEP_PROGRESS:
        if (!this.turnActive || this.openTools.size > 0) return undefined
        return { message: statusCopy('thinking', seq), stage: '分析阶段' }
      case Trigger.TOOL_STARTED: {
        if (!this.turnActive) this.turnActive = true
        this.openTools.set(event.callId, event.tool)
        const activity = classifyTool(event.tool)
        return { message: activityCopy(activity, seq), stage: stageOf(activity) }
      }
      case Trigger.TOOL_FINISHED: {
        if (event.callId) this.openTools.delete(event.callId)
        const remaining = [...this.openTools.values()][0]
        return remaining
          ? { message: activityCopy(classifyTool(remaining), seq), stage: stageOf(classifyTool(remaining)) }
          : { message: statusCopy('result', seq), stage: '整理阶段' }
      }
      case Trigger.QUESTION_ASKED:
        this.openTools.set(event.callId, event.tool)
        return { message: statusCopy('waiting', seq), stage: '等待确认' }
      case Trigger.APPROVAL_REQUESTED:
        return { message: statusCopy('approval', seq), stage: '等待审批' }
      case Trigger.APPROVAL_RESOLVED:
      case Trigger.USER_REPLIED:
        return { message: statusCopy('result', seq), stage: '继续执行' }
      case Trigger.TASK_UPDATED:
        this.task = event.progress?.current ?? this.task
        this.progress = event.progress ?? this.progress
        return { stage: this.state === PetState.WORKING ? '执行阶段' : '分析阶段' }
      case Trigger.TURN_SETTLED:
        this.turnActive = false
        this.openTools.clear()
        return { result: event.result }
      default:
        return undefined
    }
  }

  #apply(trigger, payload, now) {
    const from = this.state
    // TURN_SETTLED 是特殊分支：目标状态取决于回合结束原因
    if (trigger === Trigger.TURN_SETTLED) return this.#settle(payload?.result, now)

    const targeted = TRANSITIONS[from]?.[trigger]
    if (!targeted) {
      // 没有迁移：只更新文案/进度，状态不变
      if (payload) return this.#touch(payload, now)
      return { changed: false, state: from }
    }

    this.state = targeted
    if (payload) {
      this.message = payload.message ?? this.message
      this.stage = payload.stage ?? this.stage
    }
    // 不变量：THINKING 阶段的标签就是「分析阶段」（除非这次迁移自带别的阶段文案），
    // 否则从 WORKING 落回 THINKING 后会一直显示旧阶段的「整理阶段」。
    if (targeted === PetState.THINKING) this.stage = payload?.stage ?? '分析阶段'
    this.#bump(now)
    return { changed: true, state: targeted, trigger, from }
  }

  #settle(result, now) {
    const from = this.state
    switch (result) {
      case TurnEndKind.BLOCKED:
        this.#setState(PetState.WAITING, { message: statusCopy('waiting'), stage: '等待确认' }, now)
        return { changed: true, state: PetState.WAITING, trigger: Trigger.TURN_SETTLED, from }
      case TurnEndKind.ABORTED:
        this.#setState(PetState.IDLE, { message: statusCopy('stopped'), stage: '已停止' }, now)
        return { changed: true, state: PetState.IDLE, trigger: Trigger.TURN_SETTLED, from }
      case TurnEndKind.COMPLETED:
        this.#setState(PetState.SUCCESS, { message: statusCopy('success'), stage: '已完成' }, now)
        this.holdUntil = now + HOLD_MS[PetState.SUCCESS]
        return {
          changed: true,
          state: PetState.SUCCESS,
          trigger: Trigger.TURN_SETTLED,
          from,
          pulse: { state: PetState.SUCCESS, holdMs: HOLD_MS[PetState.SUCCESS] },
        }
      default: {
        const limited = result === TurnEndKind.MAX_TOKENS
        this.#setState(PetState.ERROR, {
          message: limited ? statusCopy('limit') : statusCopy('error'),
          stage: limited ? '到达上限' : '需要处理',
        }, now)
        this.holdUntil = now + HOLD_MS[PetState.ERROR]
        return {
          changed: true,
          state: PetState.ERROR,
          trigger: Trigger.TURN_SETTLED,
          from,
          pulse: { state: PetState.ERROR, holdMs: HOLD_MS[PetState.ERROR] },
        }
      }
    }
  }

  /** 文案/进度更新，不改状态。 */
  #touch(payload, now) {
    if (payload.message) this.message = payload.message
    if (payload.stage) this.stage = payload.stage
    if (payload.task !== undefined) this.task = payload.task
    if (payload.progress !== undefined) this.progress = payload.progress
    this.#bump(now)
    return { changed: true, state: this.state }
  }

  #setState(state, payload, now) {
    this.state = state
    this.message = payload.message ?? this.message
    this.stage = payload.stage ?? this.stage
    this.#bump(now)
  }

  #bump(now) {
    this.updatedAt = now
    this.revision += 1
  }

  #expireHold(now) {
    if (!this.holdUntil || now < this.holdUntil) return false
    if (this.state !== PetState.SUCCESS && this.state !== PetState.ERROR) {
      this.holdUntil = 0
      return false
    }
    this.holdUntil = 0
    const remaining = [...this.openTools.values()][0]
    this.#setState(remaining ? PetState.WORKING : PetState.IDLE, remaining
      ? { message: activityCopy(classifyTool(remaining)), stage: '执行阶段' }
      : { message: statusCopy('idle'), stage: '待机' }, now)
    return true
  }
}

/** DSH 事件 → 状态机触发（不认识的组合返回 undefined = 忽略）。 */
function triggerFor(event) {
  switch (event.kind) {
    case SessionEventKind.TURN_START: return Trigger.TURN_STARTED
    case SessionEventKind.STEP_START:
    case SessionEventKind.ASSISTANT_CHUNK:
    case SessionEventKind.ASSISTANT_MESSAGE: return Trigger.STEP_PROGRESS
    case SessionEventKind.TOOL_CALL: return event.asksUser ? Trigger.QUESTION_ASKED : Trigger.TOOL_STARTED
    case SessionEventKind.TOOL_RESULT: return Trigger.TOOL_FINISHED
    case SessionEventKind.TODO_WRITE: return event.progress ? Trigger.TASK_UPDATED : undefined
    case SessionEventKind.APPROVAL_ASKED: return Trigger.APPROVAL_REQUESTED
    case SessionEventKind.APPROVAL_DECIDED: return Trigger.APPROVAL_RESOLVED
    case SessionEventKind.USER_MESSAGE: return Trigger.USER_REPLIED
    case SessionEventKind.TURN_END: return Trigger.TURN_SETTLED
    default: return undefined
  }
}

function stageOf(activity) {
  switch (activity) {
    case ToolActivity.SEARCHING: return '查找阶段'
    case ToolActivity.EDITING: return '实现阶段'
    case ToolActivity.TESTING: return '验证阶段'
    case ToolActivity.COMMANDING: return '执行阶段'
    default: return '处理阶段'
  }
}
