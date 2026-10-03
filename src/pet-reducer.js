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
import { machineCopy, noticeCopy, parallelHeadline, rosterLine, singleDetail, stageCopy, statusCopy } from './pet-copy.js'

/** 选主角的优先级：等你的最优先，其次出错，再是在干活的（键必须覆盖全部状态）。 */
export const PRIORITY = Object.freeze({
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

/**
 * 每个项目最多挂几条通知（钉在宠物上方直到被查看）。
 *
 * **容量与过期是两侧各管一段，靠"谁丢谁上报"对齐**（不是两边各有一份私有规则）：
 *   · 这里的 4 是**宿主账本**的每会话上限：挤掉最旧的一条时立刻补 `notice-clear`（capacity）；
 *   · 原生侧 `PetAnimation.maxNotices = 3` 是**全局显示**上限、`noticeTtlMs = 20min` 是兜底过期，
 *     它丢任何一条都会回报 `interaction{action:'notice-dropped', ids}`，宿主据此清账本；
 *   · 会话被淘汰（#evictOthers）时，它挂着的通知一起补 `notice-clear`（evicted）。
 * 对账口径见 test/notice-reconcile.test.mjs：同一段通知流跑完，两侧"还挂着几条"必须相等。
 */
const MAX_NOTICES = 4

/**
 * 「等你确认」通知的 id 后缀。
 *
 * 一个会话最多挂一条（重复进入 WAITING 会覆盖同 id），离开 WAITING 就撤。
 * 之所以按会话而不是按次数发：用户需要知道的是"**哪个**会话在等我"，
 * 而不是"它问了第几次" —— 后者会刷满通知层。
 */
const WAITING_NOTICE_SUFFIX = ':wait'

/**
 * 通知的**唯一构造器**：生产端、探针、自检都用它。
 *
 * 以前探针与自检各手抄一份字面量，生产端加 `sessionId` 时它们没跟上 ——
 * 于是"点通知切到该会话"这条真实路径在探针里永远走不到（原生端没有 sessionId
 * 只能当成"已查看"）。字段只有一处定义就不会再漂。
 */
/** 状态机的语义键 → 气泡文案（领域不产出用户可见字符串，渲染在这里发生）。 */
function machineMessage(machine) {
  return machineCopy(machine.copy, machine.seq)
}

function machineStage(machine) {
  return stageCopy(machine.stageKey)
}

export function noticeMessage({ id, project, state, title, detail, action, sessionId, createdAt } = {}) {
  const payload = { id, project, state, title, detail }
  if (action !== undefined) payload.action = action
  if (sessionId !== undefined) payload.sessionId = sessionId
  if (createdAt !== undefined) payload.createdAt = createdAt
  return createMessage(PetMessageKind.NOTICE, payload)
}

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
    /**
     * 宿主自己产生的通知（日报进度/结果/失败）也进同一份账本。
     *
     * 以前这三条走 `send()` 直发、不进任何账本：于是它们不受条数上限约束、
     * `dismissNotice()` 永远返回 false、换 helper 也不会补发 ——
     * "通知由谁持有、谁清得掉"被拆成了两半。
     */
    this.hostNotices = []
    /** 淘汰项目时欠下的一批清通知（由 #entry 触发，handle 开头补发） */
    this.evictionQueue = []
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

    const evicted = this.#drainEvictions()
    const entry = this.#entry(session, subagent)
    entry.touchedAt = ++this.clock
    entry.project = projectName(session, event) ?? entry.project

    const outcome = entry.machine.consume(normalized, this.now())
    if (!outcome.changed) return [...evicted]

    const messages = [...evicted, ...this.#render()]
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
        message: machineMessage(entry.machine),
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
        detail: entry.machine.task ?? machineStage(entry.machine),
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
      messages.push(...this.#rememberNotice(entry, notice))
    }

    // 「等你确认」：也走通知层，且不看焦点。
    //
    // 和完成通知的区别在于**它还没结束**：那个会话卡在 WAITING 不动，
    // 用户在别的窗口里干活时，光看状态气泡是发现不了的（气泡可能正被别的项目占着），
    // 所以这里也要冒一条，并且点一下能跳到那个对话。
    // 只在**真的迁移进** WAITING 时发（`from` 只在真迁移上出现）——
    // 否则在 WAITING 里每来一条文案更新都会重发一条。
    if (outcome.changed && outcome.from !== undefined && outcome.from !== PetState.WAITING
      && outcome.state === PetState.WAITING) {
      const copy = noticeCopy(PetState.WAITING, {
        project: entry.project,
        detail: machineStage(entry.machine),
      })
      const notice = {
        id: `${entry.machine.id}${WAITING_NOTICE_SUFFIX}`,
        sessionId: entry.machine.id,
        project: entry.project ?? '会话',
        state: PetState.WAITING,
        title: copy.title,
        detail: copy.detail,
        createdAt: Date.now(),
      }
      messages.push(...this.#rememberNotice(entry, notice))
    }

    // 离开 WAITING = 用户回复/批准了，或者它自己接着跑了 → 这条催办没意义了。
    // 只撤 `:wait` 那条，同会话可能同时挂着完成通知，别误伤。
    if (outcome.changed && outcome.from === PetState.WAITING && outcome.state !== PetState.WAITING) {
      messages.push(...this.#clearWaitingNotice(entry, 'resolved'))
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

  /**
   * 宿主自己发一条通知（日报进度、结果、失败提示）：进同一份账本，
   * 于是它同样受上限约束、同样能被 dismissNotice 清掉、换 helper 时同样会补发。
   */
  postNotice(payload) {
    const message = noticeMessage({ createdAt: Date.now(), ...payload })
    this.hostNotices = this.hostNotices.filter((notice) => notice.id !== message.id)
    this.hostNotices.push(message)
    if (this.hostNotices.length > MAX_NOTICES) this.hostNotices.shift()
    return message
  }

  /** 清掉宿主自己发的一条（返回该发的 clear 消息；没这条就返回 undefined）。 */
  clearNotice(id, reason = 'cleared') {
    const before = this.hostNotices.length
    this.hostNotices = this.hostNotices.filter((notice) => notice.id !== id)
    if (this.hostNotices.length === before) return undefined
    return createMessage(PetMessageKind.NOTICE_CLEAR, { id, reason })
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
    const before = this.hostNotices.length
    this.hostNotices = this.hostNotices.filter((notice) => notice.id !== id)
    return this.hostNotices.length !== before
  }

  /** 当前挂着的通知（含宿主自己发的那些）。 */
  pendingNotices() {
    const all = [...this.hostNotices]
    for (const entry of this.projects.values()) all.push(...entry.notices)
    return all
  }

  /** 挂着的通知对应的**协议消息**（补发用：新 helper 起来时要把它们重放一遍）。 */
  pendingNoticeMessages() {
    return this.pendingNotices().map((notice) => noticeMessage({
      id: notice.id,
      project: notice.project,
      state: notice.state,
      title: notice.title,
      detail: notice.detail,
      action: notice.action,
      sessionId: notice.sessionId,
      createdAt: notice.createdAt,
    }))
  }

  /** 计时器驱动：让 SUCCESS/ERROR 这类停留态到点回落（宿主每秒调一次即可）。 */
  tick(now = this.now()) {
    let changed = false
    for (const entry of this.projects.values()) {
      if (entry.machine.tick(now)) changed = true
    }
    return changed ? this.#render() : []
  }

  /**
   * 强制重渲染一份"当前画面"（忽略签名去重）。
   *
   * 给"换了个新 helper"用：新进程没有历史文案，而签名去重会让本该重发的那条
   * `state` 被吞掉（`#render` 认为"没变化"）—— 桌面上的表现就是气泡一直空着。
   */
  snapshot() {
    // 通知属于"当前该显示什么"：新 helper 是空进程，不补发就永远看不到
    //（宿主账本里还挂着，屏幕上一条都没有）
    return [...this.#render({ force: true }), ...this.pendingNoticeMessages()]
  }

  /** 当前主角项目（供宿主 / 设置面板查询）。 */
  focus() {
    const entry = this.#focus()
    if (!entry) return undefined
    return {
      id: entry.machine.id,
      project: entry.project,
      state: entry.machine.state,
      message: machineMessage(entry.machine),
    }
  }

  /** 所有项目的当前状态（供设置面板展示并行情况）。 */
  roster() {
    return this.#sorted().map((entry) => ({
      id: entry.machine.id,
      project: entry.project ?? '未命名',
      state: entry.machine.state,
      message: machineMessage(entry.machine),
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
    if (!victim) return
    // 淘汰一个会话时，它挂着的通知**必须一起清**：宿主这边账本已经没了，
    // 原生端却还在显示，之后连清都清不掉（发 notice-clear 的名单也找不到了）
    this.evictionQueue.push(...this.#clearNotices(victim[1], 'evicted'))
    this.projects.delete(victim[0])
  }

  /** 取走淘汰时欠下的清通知（在 handle 开头补进消息流）。 */
  #drainEvictions() {
    if (this.evictionQueue.length === 0) return []
    const queued = this.evictionQueue
    this.evictionQueue = []
    return queued
  }

  /**
   * 记一条通知到账本并发出去。
   *
   * 关键：**超出上限被挤掉的那条要补一条 notice-clear**。
   * 以前这里是 `push` 之后 `shift()` —— 宿主账本悄悄少一条，原生端却还挂着它
   * （而且以后再也没有任何一条清得掉它，因为宿主已经不记得这个 id 了）。
   * 两侧的"还挂着几条"要能对上，就必须"谁丢谁负责通知"。
   */
  #rememberNotice(entry, notice) {
    entry.notices.push(notice)
    const messages = [createMessage(PetMessageKind.NOTICE, notice)]
    while (entry.notices.length > MAX_NOTICES) {
      const dropped = entry.notices.shift()
      messages.push(createMessage(PetMessageKind.NOTICE_CLEAR, { id: dropped.id, reason: 'capacity' }))
    }
    return messages
  }

  #clearNotices(entry, reason) {
    const messages = entry.notices.map((notice) =>
      createMessage(PetMessageKind.NOTICE_CLEAR, { id: notice.id, reason }))
    entry.notices.length = 0
    return messages
  }

  /** 只撤「等你确认」那条（`:wait`），同会话挂着的完成通知不动。 */
  #clearWaitingNotice(entry, reason) {
    const messages = []
    const keep = []
    for (const notice of entry.notices) {
      if (notice.id.endsWith(WAITING_NOTICE_SUFFIX)) {
        messages.push(createMessage(PetMessageKind.NOTICE_CLEAR, { id: notice.id, reason }))
      } else {
        keep.push(notice)
      }
    }
    entry.notices = keep
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

    const headline = parallel ? parallelHeadline(counts) : machineMessage(machine)
    const detail = parallel
      ? rosterLine(this.#rosterEntries(), { max: this.rosterSize })
      : singleDetail({
        project: entry.project,
        stage: machineStage(machine),
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
