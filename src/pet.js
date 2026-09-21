/**
 * pet.js —— 把三件事缝在一起：进程（pet-process）、状态（pet-reducer）、配置。
 *
 * 这是宿主插件唯一需要 mount 的入口，职责刻意保持很窄：
 *   · 订阅 session/event → reducer → 发给 helper 的 state/pulse 消息；
 *   · 订阅 session/created（会话被打开）与 session/disposed → 维护通知；
 *   · 配置变更 → config 消息（不重启进程，滑块拖动不闪断）；
 *   · helper 反向上报的互动（点分区 / 原生菜单）→ 台词与动作由宿主裁决。
 *
 * 互动台词在 pet-interactions.js，"今日干了什么"的编排在 pet-summary.js。
 */

import { PetProcess, defaultAssetRoot, helperAvailable } from './pet-process.js'
import { PetReducer } from './pet-reducer.js'
import { sessionId } from './events.js'
import { INTERACTIONS, createPatTracker, interactionMessage, zoneToAction } from './pet-interactions.js'
import { generateTodaySummary, generateTodaySummaryStepped, refinePendingParts } from './pet-summary.js'
import { reportLengthWarning } from './pet-summary-corpus.js'
import { PetMessageKind, PetState, createMessage } from './protocol.js'
import { BUBBLE_THEMES, clampScale } from './pet-settings.js'

/**
 * 挂载桌面宠物。
 *
 * @param {object} options
 * @param {any} options.ctx cordis 上下文（需要 agents / sessionQuery / sessions 服务）
 * @param {object} options.settings 配置作用域（index.js 里创建的唯一来源）
 * @param {any} [options.eventCtx] 事件总线（默认 ctx.root ?? ctx）
 * @param {object} [options.logger]
 * @param {{ processOptions?: object, version?: string }} [options.tuning]
 * @returns {PetHandle}
 */
export function mountPet({ ctx, settings, eventCtx, logger = console, tuning = {} } = {}) {
  if (!settings) throw new TypeError('mountPet 需要 settings 作用域（见 createSettingsScope）')

  let process
  let reducer

  const startProcess = (resolved) => {
    if (resolved.enabled === false) {
      logger.info?.('dsh-assistant: 已在设置里关闭，跳过启动')
      return
    }
    if (!helperAvailable()) {
      logger.warn?.(
        'dsh-assistant: 缺少原生 helper，桌面宠物未启动；'
        + '在插件目录执行 `npm run build:helper` 后重启 DSH（插件其余部分不受影响）。',
      )
      return
    }
    process = new PetProcess({
      ...(tuning.processOptions ?? {}),
      assetRoot: defaultAssetRoot(),
    }, logger)
    reducer = new PetReducer({ includeSubagents: resolved.includeSubagents })
    process.options.onMessage = (message) => handleHelperMessage(message)
    process.start()
    // 先把配置与首帧状态发出去，helper 就绪后会按顺序补发
    process.send(configMessage(resolved, settings))
    process.send(createMessage(PetMessageKind.HELLO, {
      label: '桌面宠物',
      version: tuning.version ?? '0.0.0',
    }))
    process.send(createMessage(PetMessageKind.STATE, {
      state: PetState.IDLE,
      message: '待机中，随时可以开工',
      detail: 'DSH · 等待任务',
    }))
    logger.info?.('dsh-assistant: 桌面宠物已启动（原生悬浮窗，会话事件驱动）')
  }

  const stopProcess = (reason) => {
    process?.stop(reason)
    process = undefined
    reducer = undefined
  }

  /** 发给原生端的消息（进程不在就丢掉）。 */
  const send = (message) => {
    if (process) process.send(message)
  }

  // 连点三次摸头触发庆祝
  const registerPat = createPatTracker()

  const handleHelperMessage = (message) => {
    switch (message.kind) {
      case PetMessageKind.INTERACTION:
        handleInteraction(message)
        break
      case PetMessageKind.SETTINGS:
        handleNativeSettings(message)
        break
      default:
        break
    }
  }

  /**
   * 原生端只上报「用户在哪个分区做了什么」，动作语义在这里落定。
   *
   * 有几种 action 不属于互动动作，而是状态同步：
   *   · notice-dismiss / notice-seen / notice-open —— 用户看过某条通知了（原生已本地清掉），
   *     宿主侧的通知账本要跟着清，否则它会一直挂在 pendingNotices 里；
   *   · summary-request —— 原生菜单点「今天干了什么」。
   */
  const handleInteraction = (message) => {
    const action = String(message.action ?? '')
    if (action.startsWith('notice-')) {
      reducer?.dismissNotice(String(message.noticeId ?? ''))
      // 点通知 = 想看那个会话 → 让客户端切过去（原生端自己打不开 DSH 界面）
      if (action === 'notice-open-session') {
        const sessionId = String(message.sessionId ?? '')
        if (sessionId) openSession(sessionId)
      }
      return
    }
    if (action === 'summary-request') {
      void runTodaySummary()
      return
    }
    // 点击分区上报的是 zone，菜单上报的是动作名
    const resolved = INTERACTIONS[action] ? action : zoneToAction(message.zone)
    if (!INTERACTIONS[resolved]) return
    const celebrate = resolved === 'pat' ? registerPat() : false
    send(interactionMessage(resolved, { seed: Date.now(), celebrate }))
  }

  /** 用户在原生菜单里改了大小/气泡：写回设置，保证两边一致。 */
  const handleNativeSettings = (message) => {
    const patch = {}
    if (Number.isFinite(message.scale)) patch.scale = clampScale(Number(message.scale))
    if (typeof message.bubbleEnabled === 'boolean') patch.bubbleEnabled = message.bubbleEnabled
    if (typeof message.reducedMotion === 'boolean') patch.reducedMotion = message.reducedMotion
    if (typeof message.soundEnabled === 'boolean') patch.soundEnabled = message.soundEnabled
    if (BUBBLE_THEMES.includes(message.bubbleTheme)) patch.bubbleTheme = message.bubbleTheme
    if (Object.keys(patch).length === 0) return
    void Promise.resolve(settings.update(patch)).catch((error) => {
      logger.warn?.(`dsh-assistant: 回写设置失败: ${errorText(error)}`)
    })
  }

  /**
   * 给客户端的命令队列。
   *
   * 为什么要有它：原生端（宠物）能感知"用户点了通知"，但它打不开 DSH 界面 ——
   * 真正能切会话的只有浏览器里的 `sessions.open(id)`。两边靠这条队列对接，
   * 客户端用长轮询取（见 pet-endpoint 的 GET /pending）。
   *
   * 上限 + 过期：客户端不在线时（比如没开窗口）队列不会无限涨，
   * 超过 TTL 的命令直接丢掉 —— 十几秒前的"打开某会话"已经没有意义。
   */
  const COMMAND_TTL_MS = 30_000
  const MAX_COMMANDS = 8
  const commands = []
  let commandWaiter

  const openSession = (sessionId) => {
    commands.push({ kind: 'open-session', sessionId, at: Date.now() })
    while (commands.length > MAX_COMMANDS) commands.shift()
    const waiter = commandWaiter
    commandWaiter = undefined
    waiter?.()
  }

  /** 取一条命令；队列空时最多等 timeoutMs（0 = 不等待，立刻返回）。 */
  const nextCommand = (timeoutMs = 20_000) => {
    const fresh = () => {
      const cutoff = Date.now() - COMMAND_TTL_MS
      while (commands.length > 0 && commands[0].at < cutoff) commands.shift()
      return commands.shift()
    }
    const ready = fresh()
    if (ready || timeoutMs <= 0) return Promise.resolve(ready)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        commandWaiter = undefined
        resolve(undefined)
      }, timeoutMs)
      timer.unref?.()
      commandWaiter = () => {
        clearTimeout(timer)
        resolve(fresh())
      }
    })
  }

  /** 生成中标志：避免连点重复开隐藏会话（每次都要真跑一轮 agent，贵）。 */
  let summarising = false

  /**
   * 「今天干了什么」：开一个**隐藏会话**（origin: subagent）回顾今天的对话，
   * 产出 markdown，然后把正文交给原生端弹窗展示。
   *
   * 过程用通知层反馈：先挂一条"正在整理…"，完成后换成可点击的"已生成"。
   */
  const runTodaySummary = async () => {
    if (summarising) {
      logger.info?.('dsh-assistant: 总结已在生成中，忽略重复触发')
      return false
    }
    if (!process) return false
    summarising = true
    const progressId = `summary-progress:${Date.now()}`
    const progress = (title, detail) => send(createMessage(PetMessageKind.NOTICE, {
      id: progressId,
      project: '今日总结',
      state: PetState.WORKING,
      title,
      detail,
    }))
    progress('正在整理今天的对话…', '生成完会在这里提示')
    try {
      // 后台总结开着 → 只补"还没被压缩的增量"；关着 → 全量重读一遍
      const stepped = settings.get().backgroundSummary === true
      const { markdown, sessions } = stepped
        ? await generateTodaySummaryStepped(ctx, {
          logger,
          onPart: ({ index, total, title }) => progress(`正在整理今天的对话…（${index}/${total}）`, title),
        })
        : await generateTodaySummary(ctx, { logger })

      // 提示词是软约束，写长了要能看见（否则只能靠肉眼发现日报越来越长）
      const warning = reportLengthWarning(markdown)
      if (warning) logger.warn?.(`dsh-assistant: ${warning}`)

      const title = `今天干了什么 · ${new Date().toLocaleDateString('zh-CN')}`
      // 先清进度条，再挂正文 + 可点击通知（点击开弹窗）
      send(createMessage(PetMessageKind.NOTICE_CLEAR, { id: progressId, reason: 'done' }))
      send(createMessage(PetMessageKind.SUMMARY, { title, markdown }))
      send(createMessage(PetMessageKind.NOTICE, {
        id: `summary:${new Date().toDateString()}`,
        project: '今日总结',
        state: PetState.SUCCESS,
        title: '今天干了什么 · 已生成',
        detail: `${sessions} 个会话 · 点击查看 / 复制 Markdown`,
        action: 'open-summary',
      }))
      return true
    } catch (error) {
      const detail = errorText(error)
      logger.warn?.(`dsh-assistant: 生成今日总结失败: ${detail}`)
      send(createMessage(PetMessageKind.NOTICE_CLEAR, { id: progressId, reason: 'failed' }))
      send(createMessage(PetMessageKind.NOTICE, {
        id: `summary-error:${Date.now()}`,
        project: '今日总结',
        state: PetState.ERROR,
        title: '总结没生成出来',
        detail,
      }))
      return false
    } finally {
      summarising = false
    }
  }

  /**
   * 后台总结：会话**每次压缩**时，把这轮已完成的部分单独提炼一次并留存。
   *
   * 好处是"今天干了什么"时只需补最后没压缩的那一小段增量，再和留存片段合并 ——
   * 既避免一整天上下文塞进一个 prompt（互相干扰 + 超长丢失），也不用每次重读全天。
   *
   * 三条纪律（都是踩过/算过账的）：
   *   · **只提炼、不汇总**：后台路径不需要日报正文，走 `refinePendingParts()`
   *     （原先复用了完整的分步总结，那次汇总的结果被直接丢掉 —— 每次压缩白花一次调用）；
   *   · **全局单飞**：同时压缩两个会话不该并发跑两整套（水位在跑完后才推进）；
   *   · **与 helper 无关**：这段服务的是"今天干了什么"，helper 没编译也要能攒。
   *     只有用户显式把宠物关掉（enabled = false）才停 —— 那是"我不想为它花钱"的明确信号。
   *
   * 开关：设置里的「任务后台总结」，默认关。
   */
  let backgroundBusy = false
  const backgroundSummarise = async (session, event) => {
    if (settings.get().backgroundSummary !== true) return
    if (settings.get().enabled === false) return
    if (session?.header?.origin === 'subagent') return
    if (backgroundBusy) {
      logger.debug?.('dsh-assistant: 后台总结还在跑，这次压缩先跳过')
      return
    }
    backgroundBusy = true
    try {
      const result = await refinePendingParts(ctx, { logger })
      logger.info?.(
        `dsh-assistant: 压缩后已后台总结并留存（触发 ${event?.type ?? '?'}，补 ${result.parts.length} 段）`,
      )
    } catch (error) {
      logger.warn?.(`dsh-assistant: 后台总结失败: ${errorText(error)}`)
    } finally {
      backgroundBusy = false
    }
  }

  // 事件订阅：用未限定作用域的 root 总线，显式随插件生命周期释放
  const bus = eventCtx ?? ctx?.root ?? ctx
  const offEvent = bus?.on?.('session/event', (session, event) => {
    // 后台总结与宠物状态无关：helper 缺失时也要能攒（它服务的是"今天干了什么"）
    if (event?.type === 'compaction/end') void backgroundSummarise(session, event)
    if (!process || !reducer) return
    try {
      for (const message of reducer.handle(session, event)) process.send(message)
    } catch (error) {
      logger.error?.(`dsh-assistant: 处理会话事件失败: ${errorText(error)}`)
    }
  }, { global: true })

  /**
   * 「这个会话被看过了」→ 清掉它挂着的完成通知。
   *
   * 触发点有两个，缺一不可：
   *   · `session/created`：会话第一次被载入内存时（历史会话点开）；
   *   · 客户端上报的 `viewed()`：**刚跑完任务的会话本来就在内存里**，
   *     点它不会再发 created（DSH 的 announce 只有一次），只有客户端知道
   *     用户此刻在看哪个会话。
   *
   * 两处都走 reducer.markSessionSeen，id 统一用 sessionId() 取值
   * （历史上这里写的是 `session.id ?? session.header.id`，与 events.js 的顺序相反）。
   */
  const markSeen = (id, source) => {
    if (!process || !reducer) return 0
    try {
      const messages = reducer.markSessionSeen(String(id))
      for (const message of messages) process.send(message)
      // 留一条 debug 痕迹：上报的 id 与项目表对不上时（两边 id 口径不一致）
      // 现象就是"点了会话气泡不消失"，有这条日志就能一眼看出来是哪种
      if (messages.length > 0) logger.debug?.(`dsh-assistant: ${id} 的通知已清除（${source}）`)
      else logger.debug?.(`dsh-assistant: ${id} 没有挂着的通知（${source}；在跟的项目 ${reducer.roster().length} 个）`)
      return messages.length
    } catch (error) {
      logger.warn?.(`dsh-assistant: 清理已查看通知失败: ${errorText(error)}`)
      return 0
    }
  }

  const offCreated = bus?.on?.('session/created', (session) => {
    markSeen(sessionId(session), 'session/created')
  }, { global: true })

  const offDisposed = bus?.on?.('session/disposed', (session) => {
    if (!process || !reducer) return
    try {
      for (const message of reducer.disposeSession(session)) process.send(message)
    } catch (error) {
      logger.error?.(`dsh-assistant: 处理会话销毁失败: ${errorText(error)}`)
    }
  }, { global: true })

  const unwatch = settings.watch((next) => {
    try {
      if (next.enabled === false) {
        stopProcess('disabled')
        return
      }
      if (!process) {
        startProcess(next)
        return
      }
      // 子 Agent 开关要重建项目表；其余字段热更新即可
      if (reducer) {
        for (const message of reducer.setIncludeSubagents(next.includeSubagents === true)) process.send(message)
      }
      process.send(configMessage(next, settings))
    } catch (error) {
      logger.error?.(`dsh-assistant: 应用设置失败: ${errorText(error)}`)
    }
  })

  // 所有需要显式释放的东西都登记在这里：中途出岔子也能整体收干净
  const disposers = []
  const disposeAll = () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose?.() } catch { /* 收尾失败不再抛 */ }
    }
    stopProcess('plugin-dispose')
  }

  let tickTimer
  try {
    disposers.push(offEvent, offCreated, offDisposed, unwatch)

    startProcess(settings.get())

    // 状态机 tick：SUCCESS/ERROR 是「停留 2-3 秒」的状态，靠这里回落，
    // 不依赖下一条会话事件（否则没新事件时宠物会一直停在庆祝脸）。
    tickTimer = setInterval(() => {
      const current = reducer
      if (!process || !current) return
      try {
        for (const message of current.tick()) process.send(message)
      } catch (error) {
        logger.warn?.(`dsh-assistant: 状态机 tick 失败: ${errorText(error)}`)
      }
    }, 1000)
    tickTimer.unref?.()
  } catch (error) {
    if (tickTimer) clearInterval(tickTimer)
    disposeAll()
    throw error
  }

  return {
    stop() {
      if (tickTimer) clearInterval(tickTimer)
      disposeAll()
    },
    get isRunning() { return process?.isRunning === true },
    /** 当前主角项目 */
    focus: () => reducer?.focus(),
    /** 所有项目状态（设置面板用来展示并行情况） */
    roster: () => reducer?.roster() ?? [],
    /** 挂着的完成通知（设置面板/测试查看） */
    notices: () => reducer?.pendingNotices() ?? [],
    /**
     * 客户端上报"用户正在看这个会话" → 清掉它的完成通知。
     * @returns 清掉了几条（0 表示本来就没有挂着的）
     */
    viewed: (sessionId) => markSeen(sessionId, 'client'),

    /**
     * 客户端取一条待执行命令（长轮询；没命令就等到超时或者下一条命令到达）。
     * 目前只有 `{ kind: 'open-session', sessionId }`。
     */
    nextCommand: (timeoutMs) => nextCommand(timeoutMs),

    /** 跑一次「今天干了什么」。true = 已经开跑。 */
    summarize: () => {
      if (summarising || !process) return false
      void runTodaySummary()
      return true
    },
    /** 宿主/设置面板触发一次互动。 */
    act(action) {
      if (!process) return false
      if (action === 'home' || action === 'hide') {
        process.send(createMessage(PetMessageKind.COMMAND, { action }))
        return true
      }
      const overlay = interactionMessage(action, { seed: Date.now() })
      if (!overlay) return false
      process.send(overlay)
      return true
    },
  }
}

/**
 * 下发给原生端的配置。
 *
 * **只下发用户显式设过的字段** —— 没设过的（settings 的用户层里没有）留给原生端
 * 自己那份 layout.json：否则只要宿主启动，就会把用户在悬浮窗菜单里调好的大小/配色
 * 推回默认值（现象就是"调整大小后重启又恢复原来的大小"）。
 */
export function configMessage(resolved, settings) {
  const message = createMessage(PetMessageKind.CONFIG, {})
  for (const field of OVERRIDABLE_FIELDS) {
    if (settings.overridden?.(field)) message[field] = resolved[field]
  }
  return message
}

/** 原生端自己也存了一份的字段（它们不该被宿主默认值覆盖）。 */
const OVERRIDABLE_FIELDS = Object.freeze(['scale', 'bubbleEnabled', 'bubbleTheme', 'reducedMotion', 'soundEnabled'])

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
