/**
 * dsh-assistant 客户端半边：在 DSH 设置面板里加一张「桌面宠物」卡片。
 *
 * 宠物本体完全由原生 helper 绘制，这里只做三件事：
 *   1. 读写宿主设置端点（大小/气泡/动效/提示音/子 Agent）；
 *   2. 提供一排互动按钮，走 POST <endpoint>/action；
 *   3. 显示 helper 是否在跑 —— 没编译原生端时明确告诉用户怎么修。
 */

window.__ModuleLoader__.load({
  id: 'dsh-assistant',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useEffect, useRef, useState } = React

    const CONFIG_ENDPOINT = '/plugins/dsh-assistant/config'
    const BUBBLE_THEMES = [
      ['light', '浅色（黑字）'],
      ['dark', '深色（白字）'],
    ]
    const ACTIONS = [
      ['pat', '摸摸头'],
      ['poke', '戳一下'],
      ['feed', '投喂'],
      ['praise', '夸夸它'],
      ['home', '回原位'],
      ['hide', '藏起来'],
    ]

    const cardStyle = {
      listStyle: 'none',
      border: '1px solid var(--border-color, #d8d8d8)',
      borderRadius: 12,
      padding: 16,
      background: 'var(--surface-color, transparent)',
      display: 'grid',
      gap: 12,
    }
    const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }
    const hintStyle = { display: 'block', opacity: 0.65, marginTop: 3, fontSize: 11, lineHeight: '15px' }

    function Field({ label, hint, children }) {
      return React.createElement('label', { style: rowStyle },
        React.createElement('span', null,
          React.createElement('span', { style: { display: 'block' } }, label),
          hint ? React.createElement('small', { style: hintStyle }, hint) : null,
        ),
        children,
      )
    }

    function Toggle({ checked, disabled, onChange }) {
      return React.createElement('input', {
        type: 'checkbox',
        checked,
        disabled,
        // 显式钉死尺寸与对齐：App 的全局 CSS 会按容器给 input[type=checkbox] 不同规则，
        // 结果同一张卡片里"任务后台总结"那行看起来比别的大（实测如此）。
        // 自己在组件里定尺寸，各行的观感就一致了。
        style: {
          width: 17, height: 17, minWidth: 17, minHeight: 17,
          margin: 0, marginLeft: 'auto', flex: '0 0 auto',
          padding: 0, verticalAlign: 'middle', accentColor: 'var(--dsw-accent, #4c8dff)',
        },
        onChange: (event) => onChange(event.target.checked),
      })
    }

    function PetCard() {
      const [status, setStatus] = useState('loading')
      const [value, setValue] = useState({})
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [sending, setSending] = useState('')
      const seq = useRef(0)
      const timers = useRef(new Map())

      const load = () => fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        })

      useEffect(() => {
        let active = true
        load()
          .then((next) => { if (active) { setValue(next); setStatus('ready') } })
          .catch(() => { if (active) setStatus('unavailable') })
        const timer = window.setInterval(() => {
          load().then((next) => { if (active) setValue((current) => ({ ...current, helperRunning: next.helperRunning })) }).catch(() => {})
        }, 5000)
        return () => {
          active = false
          window.clearInterval(timer)
          for (const handle of timers.current.values()) window.clearTimeout(handle)
          timers.current.clear()
        }
      }, [])

      const write = async (field, next) => {
        const ticket = ++seq.current
        setBusy(true)
        setError('')
        try {
          const response = await fetch(CONFIG_ENDPOINT, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [field]: next }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const saved = await response.json()
          if (ticket === seq.current) setValue((current) => ({ ...saved, helperRunning: current.helperRunning }))
        } catch (cause) {
          if (ticket === seq.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (ticket === seq.current) setBusy(false)
        }
      }

      /** 滑块：本地即时反馈，停手 220ms 再落盘，避免把设置服务刷爆。 */
      const writeDebounced = (field, next) => {
        setValue((current) => ({ ...current, [field]: next }))
        const existing = timers.current.get(field)
        if (existing) window.clearTimeout(existing)
        timers.current.set(field, window.setTimeout(() => {
          timers.current.delete(field)
          void write(field, next)
        }, 220))
      }

      const act = async (action) => {
        setSending(action)
        setError('')
        try {
          const response = await fetch(`${CONFIG_ENDPOINT}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
          // 409 = 宠物没在跑 / 总结已经在生成中，属于"这次没做"，不是错误
          if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setSending('')
        }
      }

      if (status === 'loading') {
        return React.createElement('ul', { style: cardStyle }, React.createElement('li', null, '正在读取 DSH小助手设置…'))
      }
      if (status === 'unavailable') {
        return React.createElement('ul', { style: cardStyle },
          React.createElement('li', null, 'DSH小助手未在当前 profile 启用（宿主端点不可用）。'))
      }

      const writable = !busy
      const running = value.helperRunning === true
      return React.createElement('ul', { style: cardStyle },
        React.createElement('li', { style: { fontWeight: 700 } }, 'DSH小助手 · 原生悬浮窗'),
        React.createElement('li', { style: hintStyle },
          running
            ? '原生进程运行中：切到别的应用也一直待在桌面上。拖动可移动，单击互动，右键有菜单。'
            : '原生进程未运行。若在 macOS 上首次安装，请在插件目录执行 npm run build:helper 后重启 DSH。'),

        React.createElement('li', null,
          React.createElement(Field, { label: '启用', hint: '关闭后会立即收起桌面窗口' },
            React.createElement(Toggle, {
              checked: value.enabled !== false,
              disabled: !writable,
              onChange: (next) => void write('enabled', next),
            }),
          ),
        ),

        React.createElement('li', null,
          React.createElement(Field, {
            label: '任务后台总结',
            hint: '开启后：会话每次压缩时后台提炼已完成的部分并留存；「今日总结」只补最后没压缩的增量再合并。关闭则每次全量重读（慢，且多会话容易互相干扰）',
          },
            React.createElement(Toggle, {
              checked: value.backgroundSummary === true,
              disabled: !writable,
              onChange: (next) => void write('backgroundSummary', next),
            }),
          ),
        ),

        React.createElement('li', null,
          React.createElement(Field, { label: `宠物大小 ${Math.round((value.scale ?? 0.4) * 100)}%`, hint: '100% = 原始尺寸；也可以用悬浮窗右键菜单换挡' },
            React.createElement('input', {
              type: 'range', min: 0.15, max: 2, step: 0.05,
              value: value.scale ?? 0.4, disabled: !writable, style: { width: 160 },
              onChange: (event) => writeDebounced('scale', Number(event.target.value)),
            }),
          ),
        ),

        React.createElement('li', null,
          React.createElement(Field, { label: '显示气泡台词' },
            React.createElement(Toggle, {
              checked: value.bubbleEnabled !== false,
              disabled: !writable,
              onChange: (next) => void write('bubbleEnabled', next),
            }),
          ),
        ),

        React.createElement('li', null,
          React.createElement(Field, { label: '气泡配色', hint: '浅色配黑字，深色配白字' },
            React.createElement('select', {
              value: value.bubbleTheme ?? 'light',
              disabled: !writable,
              style: { padding: '4px 8px', borderRadius: 8, minWidth: 110 },
              onChange: (event) => void write('bubbleTheme', event.target.value),
            },
              ...BUBBLE_THEMES.map(([id, label]) =>
                React.createElement('option', { key: id, value: id }, label)),
            ),
          ),
        ),

        React.createElement('li', null,
          React.createElement(Field, { label: '减少动效', hint: '关掉呼吸/摆动/抖动，省电又安静' },
            React.createElement(Toggle, {
              checked: value.reducedMotion === true,
              disabled: !writable,
              onChange: (next) => void write('reducedMotion', next),
            }),
          ),
        ),

        React.createElement('li', null,
          React.createElement(Field, { label: '提示音' },
            React.createElement(Toggle, {
              checked: value.soundEnabled === true,
              disabled: !writable,
              onChange: (next) => void write('soundEnabled', next),
            }),
          ),
        ),

        React.createElement('li', null,
          React.createElement(Field, { label: '含子 Agent', hint: '允许子 Agent 的任务抢占宠物状态' },
            React.createElement(Toggle, {
              checked: value.includeSubagents === true,
              disabled: !writable,
              onChange: (next) => void write('includeSubagents', next),
            }),
          ),
        ),

        React.createElement('li', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          ...ACTIONS.map(([action, label]) =>
            React.createElement('button', {
              key: action,
              type: 'button',
              disabled: sending !== '' || !running,
              onClick: () => void act(action),
              style: { padding: '4px 10px', borderRadius: 8, cursor: running ? 'pointer' : 'default' },
            }, sending === action ? '…' : label),
          ),
        ),

        React.createElement('li', null,
          React.createElement(Field, {
            label: '今天干了什么',
            hint: '回顾今天的会话生成一份日报（后台开隐藏会话，生成完在宠物上方弹通知，点开可复制 Markdown）',
          },
            React.createElement('button', {
              type: 'button',
              disabled: sending !== '' || !running,
              onClick: () => void act('summary'),
              style: {
                padding: '4px 10px', borderRadius: 8, cursor: running ? 'pointer' : 'default',
              },
            }, sending === 'summary' ? '生成中…' : '生成日报'),
          ),
        ),

        error
          ? React.createElement('li', { style: { color: 'var(--dsw-static-danger, #d9534f)', fontSize: 12 } }, `操作失败：${error}`)
          : null,
      )
    }

    /**
     * 长轮询宿主的命令并执行 —— 目前只有「打开某个会话」。
     *
     * 为什么是客户端干这件事：宠物（原生）能感知"用户点了通知"，但它打不开 DSH 界面；
     * 能切会话的只有这里的 `sessions.open(id)`（侧边栏点会话走的也是它）。
     * 空闲时 20 秒一个请求，点通知到界面切换之间几乎没有延迟。
     */
    function runCommands(ctx, sessions) {
      if (!sessions?.open) return
      let stopped = false
      let controller
      const dispose = () => {
        stopped = true
        controller?.abort()
      }
      // 两层箭头：ctx.effect(cb) 会立即执行 cb，并把它返回的函数当作回收器
      ctx.effect?.(() => dispose, 'dsh-assistant: 命令通道')

      // 服务端正常是长轮询（20s 一次）；万一它立刻返回（比如端点被换成静态响应），
      // 这里的最小间隔保证不会变成忙轮询。
      const minIntervalMs = 250
      const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

      const loop = async () => {
        while (!stopped) {
          const startedAt = Date.now()
          controller = typeof AbortController === 'function' ? new AbortController() : undefined
          try {
            const response = await fetch(`${CONFIG_ENDPOINT}/pending`, {
              cache: 'no-store',
              ...(controller ? { signal: controller.signal } : {}),
            })
            if (stopped) return
            const body = response.ok ? await response.json() : {}
            const commands = body?.commands ?? []
            for (const command of commands) {
              if (command?.kind !== 'open-session' || typeof command.sessionId !== 'string') continue
              try {
                sessions.open(command.sessionId)
                // 顺手把窗口带到前台：用户点宠物的意图就是"我要看它"
                window.focus?.()
              } catch (cause) {
                // 会话可能已经没了（比如刚被删/销毁）：记一笔就好，别把它当成通信故障
                console.warn('[dsh-assistant] 打开会话失败:', command.sessionId, cause)
              }
            }
            const elapsed = Date.now() - startedAt
            if (stopped) return
            // 服务端在长轮询（挂了很久才回）→ 立刻再挂上；
            // 立刻返回说明宿主没在长轮询（helper 没起来）→ 放慢，别变成忙轮询
            if (commands.length === 0 && elapsed < 1000) await sleep(2000)
            else if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed)
          } catch (cause) {
            if (stopped) return
            // 宿主没起来 / 端点不可用：退一步慢慢重试，别刷屏
            await sleep(2000)
          }
        }
      }
      void loop()
    }

    /**
     * 上报"用户正在看哪个会话"，让宿主清掉它的完成通知。
     *
     * 为什么必须由客户端上报：宿主侧只有 `session/created`（会话**第一次**载入内存
     * 时发一次），而**刚跑完任务的会话本来就在内存里** —— 用户点它不会再有任何事件，
     * 通知就一直挂在宠物上方（用户实测：点了侧边栏对应会话，气泡不消失）。
     * 会话列表的 `current` 才是"用户此刻在看哪个会话"的权威来源。
     *
     * 用 `ctx.inject(['sessions'], …)` 而不是把 sessions 写进 inject 列表：
     * 后者会让整个客户端插件**等**这个服务，缺了就连设置页都不出现；
     * 这里只是锦上添花，拿不到就安静跳过。
     */
    function watchActiveSession(ctx) {
      const attach = (scope) => {
        const list = scope.get?.('sessions')?.list
        if (!list?.subscribe || !list?.getSnapshot) return

        let reported
        let reportedAt = 0
        /** @param {boolean} force 同一个会话也再报一次（回到 DSH 时用） */
        const report = (force = false) => {
          const id = list.getSnapshot()?.current
          if (typeof id !== 'string' || id === '' ) return
          const now = Date.now()
          if (!force && id === reported) return
          // focus 与 visibilitychange 回到窗口时几乎同时触发，别发两遍
          if (force && id === reported && now - reportedAt < 200) return
          reported = id
          reportedAt = now
          void fetch(`${CONFIG_ENDPOINT}/viewed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: id }),
          }).catch(() => { /* 端点不可用不影响界面 */ })
        }

        // 任务是在你去别的应用时完成的 → 回到 DSH 也算"已查看"（当前会话没变，
        // 所以不能只靠列表变更触发）。
        const onReturn = () => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          report(true)
        }

        try {
          const dispose = list.subscribe(() => report())
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onReturn)
          if (typeof window !== 'undefined') window.addEventListener('focus', onReturn)
          report()          // 订阅之前可能已经有选中的会话
          // 注意箭头是**两层**：`ctx.effect(cb)` 会立即执行 cb，并把它**返回**的函数
          // 当作回收器。写成 `() => { dispose() }` 会在订阅的同一瞬间就取消订阅。
          ctx.effect?.(() => () => {
            dispose()
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onReturn)
            if (typeof window !== 'undefined') window.removeEventListener('focus', onReturn)
          }, 'dsh-assistant: 上报当前会话')
        } catch (cause) {
          console.warn('[dsh-assistant] 订阅当前会话失败（不影响设置页）:', cause)
        }
      }

      try {
        if (typeof ctx.inject === 'function') ctx.inject(['sessions'], attach)
        else attach(ctx)  // 老客户端没有 inject 助手：直接试一次
      } catch (cause) {
        console.warn('[dsh-assistant] 会话上报未接线:', cause)
      }
    }

    function apply(ctx) {
      // ① **设置页**（settings.section）：左侧导航里一块独立的「DSH小助手」页面。
      //    槽位是"列表"语义，必须有 id。
      const section = () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-assistant',
        order: 26,
        label: () => 'DSH小助手',
        inject: () => ({}),
      }, PetCard)
      try {
        // inject 的回调要**返回 register 的 disposer**：槽位声明消失时能一起收掉
        ctx.slots.inject('settings.section', section)
      } catch (cause) {
        console.error('[dsh-assistant] 设置页槽位注入失败:', cause)
      }

      // ② **插件配置卡**（settings.plugin.item）：插件列表里按 namespace 展开的一行。
      //    槽位是"keyed"语义，只认 key（必须等于设置 namespace），id/order 是无效字段。
      const card = () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'dsh-assistant',
        inject: () => ({}),
      }, PetCard)
      try {
        ctx.slots.inject('settings.plugin.item', card)
      } catch (cause) {
        console.error('[dsh-assistant] 设置卡槽位注入失败:', cause)
      }

      // ③ 会话切换上报（消完成通知）
      watchActiveSession(ctx)

      // ④ 命令通道：接收"打开某个会话"（点宠物上的完成通知时由宿主派发）
      const attachCommands = (scope) => runCommands(ctx, scope.get?.('sessions'))
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['sessions'], attachCommands)
        else attachCommands(ctx)
      } catch (cause) {
        console.warn('[dsh-assistant] 命令通道未接线:', cause)
      }
    }

    module.exports = { name: 'dsh-assistant-client', inject: ['slots'], apply }
    return module.exports
  },
})
