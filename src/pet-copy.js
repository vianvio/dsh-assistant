/**
 * pet-copy —— 桌面宠物的台词与阶段文案。
 *
 * 一句话原则：气泡里说的是「我现在在干嘛」，不是 DSH 的内部术语。
 * 分组键与状态机一一对应，改文案不影响逻辑（`test/pet-copy.test.mjs` 会校验
 * 每个分组都取得到句子、且短到能塞进 448px 宽的气泡）。
 */

const COPY = Object.freeze({
  idle: [
    '在这儿待机，随时可以开工',
    '桌面很安静，我也很安静',
    '等你下一个任务～',
  ],
  preparing: [
    '先看一眼要做什么',
    '新任务收到，捋一下步骤',
    '开工前先摊开工作台',
  ],
  thinking: [
    '正在认真想下一步',
    '脑子里正在排流程',
    '把刚才的结果理一理',
  ],
  searching: [
    '在项目里翻找相关内容',
    '正在找需要的文件',
    '查一查相关的实现',
  ],
  editing: [
    '正在把改动写进去',
    '这段代码正在调整',
    '按计划改实现',
  ],
  testing: [
    '正在跑一遍确认没问题',
    '验证一下改动',
    '检查结果是否正常',
  ],
  commanding: [
    '正在执行项目命令',
    '让项目先跑起来',
    '看着命令跑完',
  ],
  working: [
    '手上还有活，继续干',
    '这一步正在推进',
    '正在处理任务',
  ],
  result: [
    '结果整理中',
    '这一步好了，接着下一步',
    '确认一下接下来做什么',
  ],
  waiting: [
    '轮到你决定下一步啦',
    '这里需要你看一眼',
    '停在这儿等你确认',
  ],
  approval: [
    '有个操作需要你批准',
    '等你点一下同意',
    '需要你确认权限',
  ],
  success: [
    '这一轮完成啦',
    '搞定！给自己鼓个掌',
    '任务完成，尾巴摇一下',
  ],
  toolError: [
    '这一步没跑通…',
    '刚才的操作遇到点问题',
    '卡了一下，我再看看',
  ],
  error: [
    '这次没顺利跑完',
    '任务遇到点问题，回来看看吧',
    '这里需要一起看看',
  ],
  stopped: [
    '任务先停在这里',
    '好，这次先收工',
  ],
  limit: [
    '内容有点多，碰到上限了',
    '这轮输出到顶了',
  ],
})

/** 活动分类 → 文案分组（与 events.js 的 ToolActivity 对应）。 */
const ACTIVITY_GROUP = Object.freeze({
  searching: 'searching',
  editing: 'editing',
  testing: 'testing',
  commanding: 'commanding',
})

function seedNumber(seed) {
  const number = Number(seed)
  if (Number.isFinite(number)) return Math.abs(Math.trunc(number))
  return [...String(seed ?? '')].reduce((total, ch) => total + (ch.codePointAt(0) ?? 0), 0)
}

/** 取一条稳定（同一 seq 得到同一句）的文案。 */
export function statusCopy(group, seed = 0) {
  const variants = COPY[group] ?? COPY.working
  return variants[seedNumber(seed) % variants.length]
}

/** 工具活动 → 台词（不认识的分类落到 working）。 */
export function activityCopy(activity, seed = 0) {
  return statusCopy(ACTIVITY_GROUP[activity] ?? 'working', seed)
}

/* ------------------------------------------------------------------ *
 * 多项目并行时的表达（气泡只有两行：headline + detail）
 * ------------------------------------------------------------------ */

/** 状态图标：一眼看出每个项目在干什么，比文字短得多。 */
const STATE_GLYPH = Object.freeze({
  IDLE: '○',
  THINKING: '◐',
  WORKING: '●',
  WAITING: '⏸',
  SUCCESS: '✓',
  ERROR: '✕',
  DISCONNECTED: '·',
})

/**
 * 并行时的第一行：只说「几个在跑、几个等你」。
 * 例：`3 个在跑` / `2 个在跑，1 个等你`
 */
export function parallelHeadline({ running = 0, waiting = 0 } = {}) {
  if (running <= 0 && waiting <= 0) return '空闲中'
  if (running <= 0) return `${waiting} 个等你确认`
  const base = `${running} 个在跑`
  return waiting > 0 ? `${base}，${waiting} 个等你` : base
}

/**
 * 并行时的第二行：项目名 + 图标，最多 max 个，超出用 +N 收尾。
 * 例：`agent-mesh ● · dsh-assistant ⏸ · 前端 ◐ +2`
 */
export function rosterLine(entries = [], { max = 3 } = {}) {
  const shown = entries.slice(0, max).map((entry) => {
    const name = String(entry.name ?? '未命名').slice(0, 10)
    const glyph = STATE_GLYPH[entry.state] ?? '·'
    return `${name} ${glyph}`
  })
  const rest = entries.length - shown.length
  const line = shown.join(' · ')
  return rest > 0 ? `${line} +${rest}` : line
}

/**
 * 单项目时的第二行：项目 · 进度 · 当前任务（没有任务才退回阶段）。
 * 任务名截断到 12 字 —— 第二行同样是一行。
 */
export function singleDetail({ project, stage, progress, task, maxTask = 12 } = {}) {
  const shortTask = task
    ? String(task).replace(/\s+/gu, ' ').trim().slice(0, maxTask)
    : undefined
  const parts = [
    project,
    progress?.total ? `${progress.completed}/${progress.total}` : undefined,
    shortTask || stage,
  ]
  return parts.filter(Boolean).join(' · ')
}

/**
 * 通知层的文案（完成 / 出错 / 等你确认）。
 *
 * 为什么单独一套：状态气泡表达的是「此刻在干什么」，会被并行里优先级更高的项目
 * 抢走（WAITING > ERROR > WORKING > …）。任务跑完的消息不能只靠状态气泡 ——
 * 一旦有别的项目在跑，完成信息就没了，用户只能切回 DSH 才看得到。
 * 所以通知是**独立一层**，钉在宠物上方，直到被查看。
 *
 * 「等你确认」同理，而且更急：那个会话**停在那儿不动**，越晚看到越亏，
 * 所以它也走通知层 —— 点一下就跳到那个对话。
 */
export function noticeCopy(state, { project, detail } = {}) {
  const title = state === 'ERROR' ? '任务出错了'
    : state === 'WAITING' ? '等你确认'
      : '任务完成了'
  const tail = detail ? ` · ${detail}` : ''
  return { title, detail: `${project ?? '会话'}${tail}` }
}

export { COPY as copyLibrary }
