/**
 * pet-summary-corpus —— 总结的**纯数据层**：把会话事件切成给模型看的语料。
 *
 * 这里没有任何 ctx / 网络 / 磁盘依赖，全部可单测（`test/pet-summary.test.mjs`）。
 * 两套模式共用它：
 *   · 全量模式：buildCorpus() → buildPrompt()
 *   · 增量模式：extractDeltas() → buildSessionPrompt() → buildMergePrompt()
 *
 * 三条纪律（都踩过坑，别改）：
 *   1. **按事件时间过滤**，不是按会话过滤。某个会话今天只是被 resume 了一下，
 *      它的昨天消息不能进报告（用户实测："今天什么都没做，报告里全是昨天的工作"）。
 *   2. 只取**真人**发的 user/message（`source.kind === 'user'`），注入的上下文丢掉。
 *   3. 排除 `origin === 'subagent'`：那是我们自己跑总结用的隐藏会话，别再喂回自己。
 */

const MAX_CHARS_PER_SESSION = 12_000
const MAX_TOTAL_CHARS = 120_000

/** 从会话事件里取纯文本（不依赖 @deepseek-ai/dsh-session-query，少一个依赖）。 */
export function eventText(event) {
  const content = event?.data?.content ?? event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** 今天的起点（本地时区 00:00）。 */
export function startOfToday(now = Date.now()) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 会话头：记录可能是 `{ header }` 包装或 header 本身。 */
function headerOf(record) {
  return record?.header ?? record
}

/** 这条会话要不要参与总结（id 存在、不是我们自己跑的隐藏会话）。 */
function countable(record) {
  const header = headerOf(record)
  return Boolean(header?.id) && header.origin !== 'subagent'
}

/** 事件 → 给模型看的行（用户真人消息 + 助手文字）。 */
export function eventsToLines(events) {
  const lines = []
  for (const event of events) {
    if (event?.type === 'user/message') {
      if (event?.data?.source?.kind !== 'user') continue
      const text = eventText(event)
      if (text) lines.push(`【用户】${text}`)
    } else if (event?.type === 'assistant/message') {
      const text = eventText(event)
      if (text) lines.push(`【助手】${text}`)
    }
  }
  return lines
}

/**
 * 全量模式：把今天的会话整理成一段语料。
 *
 * 每个会话截断到 MAX_CHARS_PER_SESSION，总量再封顶 —— 否则一天几十个会话
 * 会把 prompt 撑爆（超了会直接丢排在后面的会话）。
 */
export function buildCorpus(records, snapshots, { now = Date.now(), titleOf } = {}) {
  const since = startOfToday(now)
  const sessions = []

  for (const record of records) {
    if (!countable(record)) continue
    const header = headerOf(record)
    const snapshot = snapshots.get(header.id)
    if (!snapshot?.events?.length) continue

    const userMessages = []
    const assistantMessages = []
    let lastTime = header.createdAt ?? 0
    for (const event of snapshot.events) {
      if (typeof event?.time === 'number') lastTime = Math.max(lastTime, event.time)
      if (typeof event?.time !== 'number' || event.time <= since) continue
      if (event?.type === 'user/message') {
        if (event?.data?.source?.kind !== 'user') continue
        const text = eventText(event)
        if (text) userMessages.push(text)
      } else if (event?.type === 'assistant/message') {
        const text = eventText(event)
        if (text) assistantMessages.push(text)
      }
    }
    // 今天动过的会话（按最后事件时间）或者今天创建的
    if (lastTime < since && (header.createdAt ?? 0) < since) continue
    // 今天没有任何真人消息 → 这个会话今天其实没干活，不参与
    if (userMessages.length === 0) continue

    let body = ''
    const pairs = Math.max(userMessages.length, assistantMessages.length)
    for (let index = 0; index < pairs; index += 1) {
      if (userMessages[index]) body += `\n【用户】${userMessages[index]}\n`
      if (assistantMessages[index]) body += `【助手】${assistantMessages[index]}\n`
      if (body.length > MAX_CHARS_PER_SESSION) {
        body += '\n…（该会话过长，已截断）\n'
        break
      }
    }

    sessions.push({
      id: header.id,
      cwd: header.cwd ?? '',
      title: titleOf?.(header.id) ?? header.cwd ?? '未命名会话',
      turns: userMessages.length,
      lastTime,
      body,
    })
  }

  sessions.sort((left, right) => right.lastTime - left.lastTime)

  const chunks = []
  let budget = MAX_TOTAL_CHARS
  for (const session of sessions) {
    if (budget <= 0) break
    const piece = session.body.slice(0, Math.min(budget, session.body.length))
    budget -= piece.length
    chunks.push(`### ${session.title}${session.cwd ? `（${session.cwd}）` : ''}\n${piece}`)
  }
  return { sessions, chunks }
}

/**
 * 给单个会话的增量封顶（**保留最近的**，从头砍）。
 *
 * 为什么需要：全量模式早就有每会话 12k / 总量 120k 的上限，但增量模式**一条都没有** ——
 * 实测出现过 53KB 的提炼输入（标题服务日志里能看到）。上下文虽然塞得下，
 * 但 token 是要花钱的，而且长输入更容易丢细节（日报要的是"最近发生了什么"）。
 * 水位机制保证这些内容不会重复出现，所以砍掉的只是"更早、更可能已被压缩过"的部分。
 */
function truncateDelta(lines, budget = MAX_CHARS_PER_SESSION) {
  const total = lines.join('\n').length
  if (total <= budget) return { lines, dropped: 0 }

  // 从后往前收，直到放不下（保留最近的部分）
  const kept = []
  let size = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (size + line.length + 1 > budget && kept.length > 0) break
    kept.unshift(line)
    size += line.length + 1
  }
  const dropped = lines.length - kept.length
  return {
    lines: [`…（更早的 ${dropped} 行已省略，只保留最近的部分）`, ...kept],
    dropped,
  }
}

/**
 * 增量模式：切出每个会话"今天 + 水位之后"的增量。
 *
 * @param summarizedUntilOf (sessionId) => number  已总结到的事件时间（0 = 没有留存）
 */
export function extractDeltas(records, snapshots, { now = Date.now(), summarizedUntilOf } = {}) {
  const since = startOfToday(now)
  const deltas = []
  for (const record of records) {
    if (!countable(record)) continue
    const header = headerOf(record)
    const snapshot = snapshots.get(header.id)
    if (!snapshot?.events?.length) continue

    const watermark = Math.max(since, summarizedUntilOf?.(header.id) ?? 0)
    const fresh = snapshot.events.filter((event) => typeof event?.time === 'number' && event.time > watermark)
    const lines = eventsToLines(fresh)
    if (lines.length === 0) continue

    let untilTime = watermark
    for (const event of fresh) untilTime = Math.max(untilTime, event.time ?? 0)
    const kept = truncateDelta(lines)
    deltas.push({
      id: header.id,
      cwd: header.cwd ?? '',
      title: undefined,
      untilTime,
      lines: kept.lines,
      chars: kept.lines.join('\n').length,
      dropped: kept.dropped,
    })
  }
  deltas.sort((left, right) => right.untilTime - left.untilTime)
  return deltas
}

/**
 * 日报的**硬性限制**：两套提示词共用同一份，谁都不许漏。
 *
 * 教训：这些限制原先只写在"全量模式"的提示词里，而且埋在一条要求的中段
 * （"…不要罗列工具调用。同一个项目不要超过3条，列出最重要的"），
 * 汇总模式那条路径**根本没有数量和行数上限** —— 于是日报越写越长。
 * 现在把它抽成独立一段，并且**在提示词末尾再重复一次**（长输入下，
 * 开头的约束最容易被忽略，末尾复述的命中率高得多）。
 */
export const SUMMARY_LIMITS = Object.freeze({
  /** 每个项目/主题分组最多几条（用户明确要求：每个项目最多 3 条） */
  perGroup: 3,
  /** `## 今天做了什么` 的总条目上限 */
  totalItems: 12,
  /** `## 待办` 的上限 */
  todoItems: 6,
  /**
   * 全文行数上限。
   *
   * 30 而不是 25：**分组行本身要占行**（两节各一组标题，5 个项目就是 10 行），
   * 25 行对多项目的日子是结构性不够的 —— 那样每天都会触发一次重写，
   * 白花一次调用还可能压不下去。条目上限（12 + 6）才是压长度的主力。
   */
  maxLines: 30,
})

/**
 * 限制条款正文（两套提示词逐字相同）。
 *
 * 分组写法统一成「**加粗项目名** 单独一行」：模型自己在"今天做了什么"里就是这么写的，
 * 原生端的 markdown 渲染器也认（加粗段落）。两节用**同一套项目名**，读者才能对上号。
 */
export function summaryRules() {
  const { perGroup, totalItems, todoItems, maxLines } = SUMMARY_LIMITS
  return [
    '硬性限制（必须遵守，超了就删内容，不要压缩描述、不要省略号）：',
    '',
    `\`## 今天做了什么\`：用 \`**项目名**\` 单独一行分组，**每个项目最多 ${perGroup} 条**，整节最多 ${totalItems} 条；`,
    '',
    `\`## 待办\`：用 \`**项目名**\` 单独一行**按项目聚合**（项目名与上一节保持一致；只有一`
      + '个项目时可以不写分组行），每个项目最多 ' + `${perGroup} 条` + `、整节最多 ${todoItems} 条；`,
    '  · 同一件事的多个下一步并成一条，别拆开重复写；',
    '  · 只写还没做、且具体可执行的；今天已做完的不要列；没有待办的项目不出现；',
    '',
    `全文不超过 ${maxLines} 行，每条不超过一行；`,
    '- 每条写"做了什么 + 结果"（待办写"要做什么"），不罗列工具调用、不写过程、不写细节；',
    '- 没做的事不要写，不要编。',
  ].join('\n')
}

/** 末尾复述（recency：长输入里开头的约束最容易被忽略）。 */
function summaryReminder() {
  const { perGroup, maxLines } = SUMMARY_LIMITS
  return `再次强调：每个项目最多 ${perGroup} 条，全文不超过 ${maxLines} 行，`
    + '「待办」按项目聚合。宁可少写，不要写长。'
}

/** 日报的正文行数（空行不算 —— markdown 里分组之间会有空行）。 */
export function reportLineCount(markdown) {
  return String(markdown ?? '').split('\n').filter((line) => line.trim() !== '').length
}

/**
 * 量一份日报：行数、每个分节的条目数、每个分组的条目数。
 *
 * **这是唯一一份度量实现**：宿主的超限判定（决定要不要重写）和
 * `npm run report:check`（人看的诊断）都用它 —— 两边各写一份的话，
 * 会出现"工具说超了、宿主说没超"这种最费解的偏差。
 *
 * 分组写法认两种（模型两种都写过）：`### 项目名` 与 `**项目名**` 单独一行。
 */
export function measureReport(markdown) {
  const sections = new Map()
  let section
  let group
  let inTable = false

  for (const raw of String(markdown ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (!line.startsWith('|')) inTable = false

    if (line.startsWith('## ')) {
      section = { title: line.replace(/^#+\s*/u, ''), items: 0, groups: [], ungrouped: 0 }
      sections.set(section.title, section)
      group = undefined
      continue
    }
    if (!section) continue

    // 分组行：### 标题 / **标题** / | 表格（表格不当分组，见下）
    const heading = /^#{3,6}\s+(.*)$/u.exec(line)
    const bold = /^\*\*([^*]+)\*\*$/u.exec(line)
    if (heading || bold) {
      // 表格里的加粗单元格不是分组标题：表头之后的行一律忽略分组语义
      if (line.startsWith('|')) { inTable = true; continue }
      group = { title: (heading ? heading[1] : bold[1]).trim(), items: 0 }
      section.groups.push(group)
      continue
    }
    if (line.startsWith('|')) { inTable = true; continue }
    if (inTable) continue

    if (/^([-*]\s|\d+\.\s|-\s\[[ xX]\])/u.test(line)) {
      section.items += 1
      if (group) group.items += 1
      else section.ungrouped += 1
    }
  }
  return { lines: reportLineCount(markdown), sections }
}

/**
 * 违反硬性限制的地方（没违反返回空数组）。
 *
 * 为什么不止看行数：实测模型会写出"某个项目 10 条"这种违反条数上限、
 * 但总行数恰好没超的日报 —— 只查行数就放过去了。
 * 待办没按项目聚合同理：多个项目却把待办平铺成一串，等于没聚合。
 */
export function reportViolations(markdown) {
  const { perGroup, totalItems, todoItems, maxLines } = SUMMARY_LIMITS
  const { lines, sections } = measureReport(markdown)
  const problems = []
  if (lines > maxLines) problems.push(`全文 ${lines} 行 > ${maxLines}`)

  const done = sections.get('今天做了什么')
  if (done) {
    if (done.items > totalItems) problems.push(`今天做了什么 ${done.items} 条 > ${totalItems}`)
    for (const group of done.groups) {
      if (group.items > perGroup) problems.push(`分组「${group.title}」${group.items} 条 > ${perGroup}`)
    }
  }

  const todo = sections.get('待办')
  if (todo) {
    if (todo.items > todoItems) problems.push(`待办 ${todo.items} 条 > ${todoItems}`)
    for (const group of todo.groups) {
      if (group.items > perGroup) problems.push(`待办分组「${group.title}」${group.items} 条 > ${perGroup}`)
    }
    // 多个项目（上一节有 ≥2 个分组）却把待办平铺 → 没按项目聚合
    if (todo.ungrouped > 0 && (done?.groups.length ?? 0) >= 2) {
      problems.push(`待办有 ${todo.ungrouped} 条没归到项目下（应像上一节那样按项目聚合）`)
    }
  }
  return problems
}

/**
 * 日报超出限制时的告警文案（没超返回 undefined）。
 *
 * 为什么要留这一条：提示词是**软约束**，模型偶尔还是会写长/漏聚合。静默的话
 * 只能靠肉眼发现，而这条日志直接进 DSH 日志，能一眼看出"是模型没遵守，
 * 还是限制被改松了"。要收紧就改上面的 SUMMARY_LIMITS（只有这一处）。
 */
export function reportLengthWarning(markdown) {
  const problems = reportViolations(markdown)
  if (problems.length === 0) return undefined
  return `日报超出限制（${problems.join('；')}）；`
    + '超限会自动重写一轮，仍不达标就保留原版 —— 要调紧限制改 SUMMARY_LIMITS（src/pet-summary-corpus.js）'
}

/**
 * 超限时**重写一遍**的提示词（把上一次的输出原样给回去，要求删减到限制内）。
 *
 * 为什么要有这一步：提示词是软约束，模型被要求"合并同类项 + 控制条数"时
 * 经常只做到一半（实测某次一个项目写了 9 条）。与其继续加惊叹号，
 * 不如让它在**看着自己上一次输出**的情况下删一遍 —— 多一次调用，但结果可控。
 */
export function buildRewritePrompt(previous, { date }) {
  const { perGroup, maxLines } = SUMMARY_LIMITS
  return [
    `你上一次生成的 ${date} 工作日报**超过了长度限制**（共 ${reportLineCount(previous)} 行，上限 ${maxLines} 行）。`,
    '',
    summaryRules(),
    '',
    '请把下面这篇**删减**到限制以内（不是重写内容，是删掉不重要的条目、把同一件事并成一条）：',
    '- 保留每个项目/主题里最重要的若干条；',
    '- 结论、数字、待办要保留；过程性描述、重复表述删掉；',
    '- 直接输出删减后的完整日报，不要说明你删了什么。',
    '',
    '--- 上一次的输出 ---',
    previous,
    '',
    summaryReminder(),
  ].join('\n')
}

/** 全量模式的提示词：一次给出日报全文。 */
export function buildPrompt(chunks, { date }) {
  return [
    `你需要生成 ${date} 的工作日报。下面是今天所有会话的对话记录。`,
    '',
    '只输出 markdown，不要任何客套、解释、前后缀。结构固定为两节：',
    '`## 今天做了什么`（按项目分组，**合并同类项**：同一件事只出现一次）',
    '`## 待办`（**按项目聚合**，未完成、下一步要做的）',
    '',
    summaryRules(),
    '',
    '--- 对话记录 ---',
    ...chunks,
    '',
    summaryReminder(),
  ].join('\n')
}

/** 增量模式①：单个会话的提炼提示词（只做"这一段讲了什么"，不跨会话汇总）。 */
export function buildSessionPrompt(delta) {
  const { perGroup, maxLines } = SUMMARY_LIMITS
  return [
    '你在为开发者整理工作记录：下面是**一个会话**里新产生的对话片段。',
    '把它提炼成 markdown 条目：',
    `- 最多 ${perGroup + 2} 条、不超过 ${maxLines / 2} 行，一条一句话；`,
    '- 只写这一个会话里**做了什么 + 结果**（例如"修复了 X 导致的 Y"），不罗列工具调用、不写过程；',
    '- 有明确的下一步就用 `- [ ]` 单独列出来；',
    '- 不编造片段里没有的内容；',
    '- 只输出条目本身，不要标题、不要客套、不要说明。',
    '',
    '--- 会话片段 ---',
    ...delta.lines,
    '',
    `再次强调：最多 ${perGroup + 2} 条、不超过 ${maxLines / 2} 行，只留最重要的。`,
  ].join('\n')
}

/** 增量模式②：汇总提示词（把各会话的提炼合并成日报）。 */
export function buildMergePrompt(parts, { date }) {
  return [
    `你在为一位开发者生成 ${date} 的工作日报。下面是**各会话分别提炼**出的条目（已按会话分组）。`,
    '注意：这些条目是按会话来的，同一件事可能在多个会话里各出现一次 —— **必须合并成一条**。',
    '',
    '只输出 markdown，不要任何客套、解释、前后缀。结构固定为两节：',
    '`## 今天做了什么`（**合并同类项**：同一件事只出现一次）',
    '`## 待办`（**按项目聚合**，同一个项目的下一步归在一起）',
    '',
    summaryRules(),
    '',
    '--- 各会话提炼 ---',
    ...parts.map((part) => `### ${part.title}${part.cwd ? `（${part.cwd}）` : ''}\n${part.markdown}`),
    '',
    summaryReminder(),
  ].join('\n')
}
