/**
 * pet-reducer.js —— 多项目视图：把 N 个会话的状态机汇总成宠物要说的话。
 *
 * 分工很清楚：
 *   · events.js          一条 DSH 事件是什么
 *   · state-machine.js   单个项目因此变成什么状态
 *   · 本文件             此刻宠物该以谁为主角、气泡两行分别说什么
 *
 * 双行气泡：
 *   第一行 headline —— 单项目时说当前动作；多项目时只说「几个在跑、几个等你」
 *   第二行 detail   —— 单项目说 项目·进度·阶段；多项目说 每个项目 名字+图标
 * 两行都很短，因为桌面气泡只有 ~448px 宽。
 */

import { PetMessageKind, PetState, createMessage } from './protocol.js'
import { SessionEventKind, isSubagent, normalize, projectName, sessionId } from './events.js'
import { HOLD_MS, ProjectStateMachine } from './state-machine.js'
import { noticeCopy, parallelHeadline, rosterLine, singleDetail, statusCopy } from './pet-copy.js'

/** 选主角的优先级：等你的最优先，其次出错，再是在干活的。 */
const PRIORITY = Object.freeze({
  [PetState.WAITING]: 60,
  [PetState.ERROR]: 50,
  [PetState.WORKING]: 30,
  [PetState.THINKING]: 20,
  [PetState.SUCCESS]: 15,
  [PetState.IDLE]: 0,
  [PetState.DISCONNECTED]: -1,
})

/** 「在跑」的判定（用于并行计数）：正在思考/干活/等人都算有事在做。 */
const ACTIVE_STATES = new Set([PetState.THINKING, PetState.WORKING, PetState.WAITING])

/**
 * 「必须立刻让位」的优先级线：等人类拍板 / 出错。
 * 比它低的（思考/干活/完成）都走"主角停留时间"，避免来回抖。
 */
const URGENT_PRIORITY = 50

/**
 * 主角最短停留时间（毫秒）。
 *
 * 为什么需要：两个会话**同时**在干活时，每个事件都会重算主角 ——
 * 谁最后更新谁赢，于是两边的 `tool/call`、`assistant/chunk` 交替进来，
 * 主角就**每条事件翻转一次**。宠物表现为：素材在两张图之间来回换，
 * 而每张图宽高不同 → 窗口宽度跟着变 → 看起来就是"人在原地闪"。
 *
 * 所以：同为"活跃但不等你"的项目之间，主角至少停这么久才换；
 * 但「等你确认 / 出错」可以立刻抢，因为那是要人处理的事。
 */
const FOCUS_DWELL_MS = 3000

/** 每个项目最多挂几条完成通知（钉在宠物上方直到被查看）。 */
const MAX_NOTICES = 4

export class PetReducer {
  /**
   * @param {{ includeSubagents?: boolean, maxSessions?: number, rosterSize?: number }} [options]
   *   rosterSize：第二行最多列几个项目（超出显示 +N）
   */
  constructor({ includeSubagents = false, maxSessions = 64, rosterSize = 3, focusDwellMs = FOCUS_DWELL_MS, now = Date.now } = {}) {
    this.includeSubagents = includeSubagents === true
    this.maxSessions = maxSessions
    this.rosterSize = rosterSize
    /** 主角最短停留时间（测试可注入 0 恢复"每次都重选"） */
    this.focusDwellMs = focusDwellMs
    this.now = now
    /** 当前主角的 id 与它上台的时刻（见 FOCUS_DWELL_MS 的说明） */
    this.focusId = undefined
    this.focusSinceAt = 0
    /** @type {Map<string, { machine: ProjectStateMachine, subagent: boolean, project?: string, touchedAt: number, notices: object[] }>} */
    this.projects = new Map()
    this.clock = 0
    this.lastSignature = undefined
  }

  setIncludeSubagents(value) {
    const next = value === true
    if (next === this.includeSubagents) return []
    this.includeSubagents = next
    if (!next) {
      for (const [id, entry] of this.projects) {
        if (entry.subagent) this.projects.delete(id)
      }
    }
    return this.#render({ force: true })
  }

  /** 消费一条 DSH 会话事件，返回要下发给原生端的消息。 */
  handle(session, event) {
    const normalized = normalize(event)
    if (!normalized) return []
    const subagent = isSubagent(session)
    if (subagent && !this.includeSubagents) return []

    const entry = this.#entry(session, subagent)
    entry.touchedAt = ++this.clock
    entry.project = projectName(session, event) ?? entry.project

    const outcome = entry.machine.consume(normalized, this.now())
    if (!outcome.changed) return []

    const messages = this.#render()
    const isFocus = this.#focus() === entry

    // 工具报错：不改耐久状态，只闪一下「出问题了」，让主人立刻注意到
    if (normalized.kind === SessionEventKind.TOOL_RESULT && normalized.error && isFocus) {
      messages.push(createMessage(PetMessageKind.PULSE, {
        state: PetState.ERROR,
        ttlMs: 1800,
        message: statusCopy('toolError', normalized.seq ?? 0),
        resumeState: entry.machine.state,
      }))
    }

    // 庆祝/报错用脉冲表达：原生端按 ttl 自动回落，宿主不必再追一条。
    // 注意：脉冲**只在它是主角时**发 —— 否则会跟别人的状态打架。
    if (outcome.pulse && isFocus) {
      messages.push(createMessage(PetMessageKind.PULSE, {
        state: outcome.pulse.state,
        ttlMs: outcome.pulse.holdMs ?? HOLD_MS[outcome.pulse.state] ?? 2000,
        message: entry.machine.message,
        resumeState: PetState.IDLE,
      }))
    }

    // 完成通知：**独立于状态气泡**，且不看焦点。
    // 并行时一旦有别的项目在跑，SUCCESS 立刻被更高优先级抢走，
    // 用户不切回 DSH 就看不到"某个任务跑完了"。
    if (outcome.pulse) {
      const state = outcome.pulse.state
      // 通知第二行：项目 + 当时的任务/阶段（状态机有就带上，没有就只报项目）
      const copy = noticeCopy(state, {
        project: entry.project,
        detail: entry.machine.task ?? entry.machine.stage ?? undefined,
      })
      const notice = {
        id: `${entry.machine.id}:${normalized.seq ?? this.clock}`,
        // 会话 id 单独带一份：原生端点击通知时要拿它去打开对应会话
        // （id 里虽然也含它会话 id，但那是 `会话:seq` 的复合串，不该让原生端去拆）
        sessionId: entry.machine.id,
        project: entry.project ?? '会话',
        state,
        title: copy.title,
        detail: copy.detail,
        createdAt: Date.now(),
      }
      entry.notices.push(notice)
      if (entry.notices.length > MAX_NOTICES) entry.notices.shift()
      messages.push(createMessage(PetMessageKind.NOTICE, notice))
    }

    // 用户又在这个项目里说话了 → 说明他看过这个项目了，清掉它的通知
    if (normalized.kind === SessionEventKind.USER_MESSAGE && entry.notices.length) {
      messages.push(...this.#clearNotices(entry, 'seen'))
    }

    return messages
  }

  /** 会话销毁：移除项目，重新选主角，并清掉它的通知。 */
  disposeSession(session) {
    const id = sessionId(session)
    const entry = this.projects.get(id)
    const messages = []
    if (entry) messages.push(...this.#clearNotices(entry, 'disposed'))
    if (this.projects.delete(id)) messages.push(...this.#render({ force: true }))
    return messages
  }

  /**
   * 用户在 DSH 里**打开了这个会话** = 已查看 → 清掉它挂着的通知。
   *
   * 这是唯一判据：客户端打开会话 → 宿主把会话 resume 进内存 → `session/created`
   * 带着这个 id 发出。
   */
  markSessionSeen(sessionId) {
    const entry = this.projects.get(sessionId)
    if (!entry?.notices.length) return []
    return this.#clearNotices(entry, 'opened')
  }

  /** 用户点击了宠物上的某条通知（原生端上报）→ 清掉它。 */
  dismissNotice(id) {
    for (const entry of this.projects.values()) {
      const index = entry.notices.findIndex((notice) => notice.id === id)
      if (index >= 0) {
        entry.notices.splice(index, 1)
        return true
      }
    }
    return false
  }

  /** 当前挂着的通知（供测试/宿主查询）。 */
  pendingNotices() {
    const all = []
    for (const entry of this.projects.values()) all.push(...entry.notices)
    return all
  }

  /** 计时器驱动：让 SUCCESS/ERROR 这类停留态到点回落（宿主每秒调一次即可）。 */
  tick(now = this.now()) {
    let changed = false
    for (const entry of this.projects.values()) {
      if (entry.machine.tick(now)) changed = true
    }
    return changed ? this.#render() : []
  }

  /** 当前主角项目（供宿主 / 设置面板查询）。 */
  focus() {
    const entry = this.#focus()
    if (!entry) return undefined
    return {
      id: entry.machine.id,
      project: entry.project,
      state: entry.machine.state,
      message: entry.machine.message,
    }
  }

  /** 所有项目的当前状态（供设置面板展示并行情况）。 */
  roster() {
    return this.#sorted().map((entry) => ({
      id: entry.machine.id,
      project: entry.project ?? '未命名',
      state: entry.machine.state,
      message: entry.machine.message,
      active: ACTIVE_STATES.has(entry.machine.state),
    }))
  }

  // MARK: - 内部

  #entry(session, subagent) {
    const id = sessionId(session)
    const existing = this.projects.get(id)
    if (existing) return existing

    const project = projectName(session, {})
    const entry = {
      machine: new ProjectStateMachine({ id }),
      subagent,
      project,
      touchedAt: ++this.clock,
      /** 该项目挂着的完成通知（用户查看前一直留着） */
      notices: [],
    }
    this.projects.set(id, entry)
    if (this.projects.size > this.maxSessions) this.#evictOthers(entry)
    return entry
  }

  /** 超过上限：先淘汰最久没动过的空闲项目，没有空闲的才淘汰最旧的。 */
  #evictOthers(keep) {
    const others = [...this.projects.entries()].filter(([, entry]) => entry !== keep)
    const idle = others
      .filter(([, entry]) => entry.machine.state === PetState.IDLE)
      .sort(([, left], [, right]) => left.touchedAt - right.touchedAt)
    const victim = idle[0] ?? others.sort(([, left], [, right]) => left.touchedAt - right.touchedAt)[0]
    if (victim) this.projects.delete(victim[0])
  }

  #clearNotices(entry, reason) {
    const messages = entry.notices.map((notice) =>
      createMessage(PetMessageKind.NOTICE_CLEAR, { id: notice.id, reason }))
    entry.notices.length = 0
    return messages
  }

  /** 按"优先级 → 最近更新 → id"排序，第一个就是主角。 */
  #sorted() {
    return [...this.projects.values()].sort((left, right) => {
      const byPriority = (PRIORITY[right.machine.state] ?? 0) - (PRIORITY[left.machine.state] ?? 0)
      return byPriority
        || right.machine.updatedAt - left.machine.updatedAt
        || left.machine.id.localeCompare(right.machine.id)
    })
  }

  /**
   * 当前主角：按优先级排序后的第一个，但**加了停留时间** ——
   * 免得两个同时在跑的项目来回抢（每次都换 = 画面一直闪）。
   */
  #focus() {
    const best = this.#sorted()[0]
    if (!best) return undefined

    const current = this.focusId === undefined ? undefined : this.projects.get(this.focusId)
    if (!current || current === best) {
      this.#setFocus(best)
      return best
    }

    const bestPriority = PRIORITY[best.machine.state] ?? 0
    const mustYield = bestPriority >= URGENT_PRIORITY
    // 现在的角儿没事干（空闲/刚完成/出错）时，新人上场不必等
    const idleHandover = !ACTIVE_STATES.has(current.machine.state) && ACTIVE_STATES.has(best.machine.state)
    if (mustYield || idleHandover || this.now() - this.focusSinceAt >= this.focusDwellMs) {
      this.#setFocus(best)
      return best
    }
    return current
  }

  #setFocus(entry) {
    if (this.focusId === entry.machine.id) return
    this.focusId = entry.machine.id
    this.focusSinceAt = this.now()
  }

  #counts() {
    let running = 0
    let waiting = 0
    for (const { machine } of this.projects.values()) {
      if (machine.state === PetState.WAITING) waiting += 1
      else if (ACTIVE_STATES.has(machine.state)) running += 1
    }
    return { running, waiting }
  }

  /** 第二行用的项目条目：优先列「有事在做」的，全空闲时才列空闲项目。 */
  #rosterEntries() {
    const sorted = this.#sorted()
    const active = sorted.filter((entry) => ACTIVE_STATES.has(entry.machine.state))
    return (active.length > 0 ? active : sorted)
      .map((entry) => ({ name: entry.project ?? '未命名', state: entry.machine.state }))
  }

  #render({ force = false } = {}) {
    const entry = this.#focus()
    if (!entry) {
      const message = statusCopy('idle')
      const signature = `none|${message}`
      if (!force && signature === this.lastSignature) return []
      this.lastSignature = signature
      return [createMessage(PetMessageKind.STATE, { state: PetState.IDLE, message, detail: 'DSH' })]
    }

    const machine = entry.machine
    const counts = this.#counts()
    const parallel = counts.running + counts.waiting >= 2

    const headline = parallel ? parallelHeadline(counts) : machine.message
    const detail = parallel
      ? rosterLine(this.#rosterEntries(), { max: this.rosterSize })
      : singleDetail({
        project: entry.project,
        stage: machine.stage,
        progress: machine.progress,
        task: machine.task,
      })

    const signature = [
      machine.id,
      machine.state,
      headline,
      detail,
      counts.running,
      counts.waiting,
      machine.revision,
    ].join('|')
    if (!force && signature === this.lastSignature) return []
    this.lastSignature = signature

    return [createMessage(PetMessageKind.STATE, {
      state: machine.state,
      message: headline,
      detail: detail || entry.project || 'DSH',
      parallel: parallel ? { running: counts.running, waiting: counts.waiting, projects: this.projects.size } : undefined,
    })]
  }
}
