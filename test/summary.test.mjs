/**
 * 「今天干了什么」：语料切分、提示词、增量水位、以及隐藏会话的执行层。
 *
 * 数据层全是纯函数；执行层用假的 sessionQuery / agents 验证
 * 「读不到的会话跳过」「标题是异步的」这两条容易写错的约定。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  SUMMARY_LIMITS,
  measureReport,
  buildCorpus,
  buildMergePrompt,
  buildPrompt,
  buildSessionPrompt,
  eventText,
  eventsToLines,
  extractDeltas,
  reportLengthWarning,
  reportViolations,
  startOfToday,
  summaryRules,
} from '../src/pet-summary-corpus.js'
import { collectSessions, runHiddenSession, yieldToLoop } from '../src/pet-summary-agent.js'
import { SessionDigests, projectSession } from '../src/pet-summary-digest.js'
import { createSessionActivityIndex, touchedToday } from '../src/pet-summary-activity.js'
import { generateTodaySummary, generateTodaySummaryStepped, refinePendingParts, summaryHint } from '../src/pet-summary.js'
import { appendPart, partsFor, readStore, storePath, summarizedUntil, writeStore } from '../src/pet-summary-store.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 把测试里的 `{events}` 快照投影成 digest（窗口 = 今天，与生产同一口径）。 */
function asDigests(snapshots, now = Date.now()) {
  const since = startOfToday(now)
  return new Map([...snapshots].map(([id, snapshot]) => [id, projectSession(snapshot, { since })]))
}

function digestsOf(events, now = Date.now()) {
  return projectSession({ events }, { since: startOfToday(now) })
}

/* ------------------------------------------------------------- 语料 */

test('今日总结：语料只取今天的真人消息，排除子会话与注入内容', () => {
  const now = Date.now()
  const records = [
    { header: { id: 'today', createdAt: now - 3600_000, cwd: '/p/a' } },
    { header: { id: 'older', createdAt: now - 40 * 86400_000, cwd: '/p/b' } },
    // 我们自己跑总结用的隐藏会话，不能再喂回自己
    { header: { id: 'hidden', createdAt: now - 60_000, origin: 'subagent' } },
  ]
  const snapshots = new Map([
    ['today', { events: [
      { type: 'user/message', time: now - 3600_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '修复登录接口 500' }] } },
      { type: 'assistant/message', time: now - 3500_000, data: { message: { content: [{ type: 'text', text: '已修复：token 未判空' }] } } },
      // 注入的上下文（不是用户打的字）必须被丢掉
      { type: 'user/message', time: now - 3400_000, data: { source: { kind: 'hook' }, content: [{ type: 'text', text: '注入内容不应出现' }] } },
    ] }],
    ['older', { events: [
      { type: 'user/message', time: now - 40 * 86400_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '很久以前' }] } },
    ] }],
    ['hidden', { events: [
      { type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '总结自己' }] } },
    ] }],
  ])
  const { sessions, chunks } = buildCorpus(records, asDigests(snapshots, now), { now, titleOf: (id) => `标题-${id}` })
  assert.deepEqual(sessions.map((item) => item.id), ['today'], '只保留今天、非子会话、有用户消息的会话')
  assert.equal(sessions[0].title, '标题-today')

  // 回归：昨天聊过、今天只是被动动了一下（非对话事件）的会话，
  // 不能把昨天的消息带进报告（用户实测：今天没干活却列出昨天的工作项）
  const yesterdayOnly = [{ header: { id: 'y', createdAt: now - 30 * 3600_000, cwd: '/p/y' } }]
  const ySnap = new Map([['y', { events: [
    { type: 'user/message', time: now - 26 * 3600_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '昨天写的功能' }] } },
    { type: 'assistant/message', time: now - 25 * 3600_000, data: { message: { content: [{ type: 'text', text: '做完了' }] } } },
    { type: 'request/header', time: now - 60_000, data: {} },
  ] }]])
  const empty = buildCorpus(yesterdayOnly, asDigests(ySnap, now), { now })
  assert.equal(empty.sessions.length, 0, '今天没有真人消息的会话不参与总结')
  assert.equal(empty.chunks.length, 0, '不会把昨天的消息带进来')

  const corpus = chunks.join('\n')
  assert.ok(corpus.includes('修复登录接口 500'), '用户消息在语料里')
  assert.ok(corpus.includes('已修复：token 未判空'), '助手回复在语料里')
  assert.ok(!corpus.includes('注入内容不应出现'), '注入的上下文不进语料')
  assert.ok(!corpus.includes('总结自己'), '自己跑总结的隐藏会话不进语料')

  const prompt = buildPrompt(chunks, { date: '2026/9/20' })
  assert.ok(prompt.includes('## 今天做了什么') && prompt.includes('## 待办'), '提示词要求两节结构')
  assert.ok(prompt.includes('2026/9/20'), '提示词带日期')

  assert.equal(eventText({ data: { content: [{ type: 'text', text: ' a ' }, { type: 'image' }] } }), 'a', '只取文本块并 trim')
  assert.equal(new Date(startOfToday(now)).getHours(), 0, '今日起点是本地 0 点')
})

test('今日总结：单会话过长时截断，不会把 prompt 撑爆', () => {
  const now = Date.now()
  const long = 'x'.repeat(2000)
  const events = []
  for (let index = 0; index < 20; index += 1) {
    events.push({ type: 'user/message', time: now - 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: long }] } })
  }
  const records = [{ header: { id: 'a', createdAt: now, cwd: '/p/a' } }]
  const { chunks } = buildCorpus(records, new Map([['a', digestsOf(events, now)]]), { now })
  assert.ok(chunks[0].includes('已截断'), '超长会话要留截断标记')
  assert.ok(chunks[0].length < 13_000, `实际 ${chunks[0].length}`)
})

/* --------------------------------------------------- 增量（水位）切分 */

test('今日总结：增量抽取只取"今天 + 水位之后"的部分', () => {
  const now = Date.now()
  const yesterday = now - 36 * 3600_000
  const records = [
    { header: { id: 'a', createdAt: yesterday, cwd: '/p/a' } },
    { header: { id: 'b', createdAt: now - 3600_000, cwd: '/p/b' } },
    { header: { id: 'sub', createdAt: now - 60_000, origin: 'subagent' } },
    { header: { id: 'quiet', createdAt: yesterday, cwd: '/p/quiet' } },
  ]
  const snapshots = new Map([
    ['a', { events: [
      { type: 'user/message', time: yesterday, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '昨天的事' }] } },
      { type: 'user/message', time: now - 7200_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天新增：改了配置' }] } },
      { type: 'assistant/message', time: now - 7100_000, data: { message: { content: [{ type: 'text', text: '改好了' }] } } },
    ] }],
    ['b', { events: [
      { type: 'user/message', time: now - 3600_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'B 的今天' }] } },
    ] }],
    ['quiet', { events: [
      { type: 'user/message', time: yesterday, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '昨天说过话，今天没动' }] } },
    ] }],
  ])

  // 水位 = 0：今天起的所有内容都要
  const fresh = extractDeltas(records, asDigests(snapshots, now), { now, summarizedUntilOf: () => 0 })
  assert.deepEqual(fresh.map((delta) => delta.id).sort(), ['a', 'b'], '两个会话都有增量')
  const deltaA = fresh.find((delta) => delta.id === 'a')
  assert.ok(deltaA.lines.join('\n').includes('今天新增：改了配置'), '取到今天的增量')
  assert.ok(!deltaA.lines.join('\n').includes('昨天的事'), '昨天的内容不算增量')
  assert.equal(deltaA.untilTime, now - 7100_000, '水位推进到最后一条事件时间')
  assert.ok(!fresh.some((delta) => delta.id === 'sub'), '子会话（自己跑总结用的）不参与')
  assert.ok(!fresh.some((delta) => delta.id === 'quiet'), '今天没更新的会话不参与')

  // 水位 = 已总结到 7200_000 之前：只剩助手那句
  const afterWatermark = extractDeltas(records, asDigests(snapshots, now), { now, summarizedUntilOf: (id) => (id === 'a' ? now - 7200_000 : 0) })
  const remaining = afterWatermark.find((delta) => delta.id === 'a')
  assert.equal(remaining.lines.join('\n'), '【助手】改好了', '只补水位之后的部分（这就是"只总结没压缩的增量"）')
})

test('今日总结：分段/汇总提示词各司其职', () => {
  const sessionPrompt = buildSessionPrompt({ lines: ['【用户】x'] })
  assert.ok(sessionPrompt.includes('一个会话'), '分会话提示词限定在单个会话')
  assert.ok(!sessionPrompt.includes('## 今天做了什么'), '分会话不做两节结构（那是汇总的事）')
  const mergePrompt = buildMergePrompt([{ title: 'A', cwd: '/p/a', markdown: '- 做了 x' }], { date: '2026/9/20' })
  assert.ok(mergePrompt.includes('## 今天做了什么') && mergePrompt.includes('## 待办'), '汇总要求两节结构')
  assert.ok(mergePrompt.includes('合并同类项'), '汇总要求去重合并')
  assert.ok(mergePrompt.includes('最多'), '汇总也要有数量上限（曾经这条路径完全没有上限）')
  assert.equal(eventsToLines([{ type: 'user/message', data: { source: { kind: 'hook' }, content: [{ type: 'text', text: 'x' }] } }]).length, 0)
})

test('提示词：两套模式都带"每个分组最多 N 条 + 行数上限"，且末尾复述一遍', () => {
  const { perGroup, maxLines } = SUMMARY_LIMITS
  const chunks = ['### 项目A\n【用户】x']
  const full = buildPrompt(chunks, { date: '2026/9/20' })
  const merge = buildMergePrompt([{ title: '会话A', cwd: '/p/a', markdown: '- 做了 x' }], { date: '2026/9/20' })
  const refine = buildSessionPrompt({ lines: ['【用户】x'] })

  for (const [name, prompt] of [['全量', full], ['汇总', merge]]) {
    assert.ok(prompt.includes(`每个项目最多 ${perGroup} 条`), `${name}模式必须写清每项目上限`)
    assert.ok(prompt.includes(`全文不超过 ${maxLines} 行`), `${name}模式必须有行数上限`)
    assert.ok(prompt.includes('按项目聚合'), `${name}模式的待办要求按项目聚合`)
    assert.ok(prompt.includes('## 今天做了什么') && prompt.includes('## 待办'), `${name}模式要求两节结构`)
    assert.ok(prompt.includes('合并同类项'), `${name}模式要求合并同类项`)
    // 约束必须在**末尾再出现一次**：长输入里开头的约束最容易被忽略
    assert.match(prompt.slice(-120), /再次强调/, `${name}模式末尾要复述限制`)
    assert.ok(!prompt.includes('40 行'), `${name}模式不该再留旧的"40 行"宽松上限`)
  }
  assert.ok(refine.includes('最多'), '单会话提炼也要有数量上限')
  assert.ok(summaryRules().includes('硬性限制'), '限制条款要显式标成硬性')

  // 提醒里也要带上同一个数字（两处口径必须一致，改一处不会漏另一处）
  assert.ok(full.includes(`每个项目最多 ${perGroup} 条`))
  assert.ok(full.includes('「待办」按项目聚合'), '末尾复述也要带上待办聚合')
})

test('日报长度诊断：超了要给出可操作的一句话，没超就安静', () => {
  const { maxLines } = SUMMARY_LIMITS
  const ok = ['## 今天做了什么', '- 干了一件事'].join('\n')
  assert.equal(reportLengthWarning(ok), undefined, '没超就不打扰')

  const long = Array.from({ length: maxLines + 1 }, (_, index) => `- 第 ${index + 1} 条`).join('\n')
  const warning = reportLengthWarning(long)
  assert.match(warning, new RegExp(`全文 ${maxLines + 1} 行 > ${maxLines}`), '要报出实际行数与上限')
  assert.match(warning, /SUMMARY_LIMITS/, '要指出去哪儿调紧')
  // 空行不算行（markdown 里分组之间会有空行，别把空行算进去吓人）
  assert.equal(reportLengthWarning(`\n\n${ok}\n\n`), undefined)
})

test('日报超限：会带着上一次的输出重写一遍，并且只认更短的那版', async () => {
  const now = Date.now()
  const records = [{ header: { id: 'a', createdAt: now, cwd: '/p/a' } }]
  const snapshots = new Map([['a', { events: [
    { type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '干活' }] } },
  ] }]])

  const long = Array.from({ length: SUMMARY_LIMITS.maxLines + 10 }, (_, index) => `- 第 ${index + 1} 条`).join('\n')
  const short = '## 今天做了什么\n- 干了一件事\n\n## 待办\n- [ ] 下一步'
  const warnings = []

  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map(), answers: [long, short] })
  const result = await generateTodaySummary(ctx, { logger: { ...quiet, warn: (line) => warnings.push(String(line)) }, now })

  assert.equal(calls.created.length, 2, '超限要再跑一轮（只会多一次）')
  assert.equal(result.markdown, short, '采纳删减后的版本')
  assert.ok(warnings.some((line) => /日报超出限制/.test(line)), '超限要有日志')

  // 重写反而更长 → 保留原版（只做减法，不做无谓替换）
  const worse = fakeCtx({ records, snapshots, titles: new Map(), answers: [long, `${long}\n- 更多`] })
  const kept = await generateTodaySummary(worse.ctx, { logger: quiet, now })
  assert.equal(kept.markdown, long, '重写更长就丢弃它')

  // 本来就没超 → 不该多跑一轮
  const ok = fakeCtx({ records, snapshots, titles: new Map(), answers: [short] })
  const clean = await generateTodaySummary(ok.ctx, { logger: quiet, now })
  assert.equal(clean.markdown, short)
  assert.equal(ok.calls.created.length, 1, '没超限就别多花一次调用')
})

test('日报超限：增量模式的汇总同样会重写', async () => {
  const now = Date.now()
  const records = [{ header: { id: 'a', createdAt: now, cwd: '/p/a' } }]
  const snapshots = new Map([['a', { events: [
    { type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '干活' }] } },
  ] }]])
  const long = Array.from({ length: SUMMARY_LIMITS.maxLines + 5 }, (_, index) => `- 第 ${index + 1} 条`).join('\n')
  const short = '## 今天做了什么\n- 合并后的一条'

  // 第 1 轮 = 单会话提炼，第 2 轮 = 汇总（超限），第 3 轮 = 重写
  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map([['a', '会话A']]), answers: ['- 提炼一条', long, short] })
  const result = await generateTodaySummaryStepped(ctx, { logger: quiet, now, storeFile: join(tmpdir(), `dsh-assistant-limit-${Date.now()}.json`) })
  assert.equal(result.markdown, short)
  assert.equal(calls.created.length, 3, '提炼 + 汇总 + 重写')
})

test('度量：分组按分节归属，待办条目不会算到上一节的分组头上', () => {
  // 这条是巡检工具曾经的 bug：待办里的 `- [ ]` 被算进了上一节最后一个分组，
  // 于是"某项目 9 条超限"是假警报。
  const markdown = [
    '## 今天做了什么',
    '',
    '**项目A**',
    '- a1',
    '- a2',
    '',
    '## 待办',
    '- [ ] t1',
    '- [ ] t2',
  ].join('\n')
  const { sections } = measureReport(markdown)
  assert.equal(sections.get('今天做了什么').groups[0].items, 2, '项目A 只有 2 条')
  assert.equal(sections.get('待办').ungrouped, 2, '待办的两条算在待办这一节')
  assert.deepEqual(reportViolations(markdown), [], '行数与条数都没超就不该报警')
})

test('度量：违反限制的四种情况都要被点名', () => {
  const { totalItems, maxLines } = SUMMARY_LIMITS
  const count = Math.max(totalItems + 5, maxLines + 2)
  const many = `## 今天做了什么\n**A**\n- ${Array.from({ length: count }, (_, i) => `第${i}条`).join('\n- ')}`
  assert.ok(reportViolations(many).some((line) => /全文 \d+ 行 > \d+/.test(line)), '行数超限')
  assert.ok(reportViolations(many).some((line) => new RegExp(`今天做了什么 ${count} 条 > ${totalItems}`).test(line)),
    '整节条数超限')

  const fatGroup = ['## 今天做了什么', '**A**', '- 1', '- 2', '- 3', '- 4', '', '## 待办', '**A**', '- [ ] x'].join('\n')
  const problems = reportViolations(fatGroup)
  assert.ok(problems.some((line) => new RegExp(`分组「A」4 条 > ${SUMMARY_LIMITS.perGroup}`).test(line)),
    '单分组超限（只查行数会漏掉这种）')

  const flatTodo = ['## 今天做了什么', '**A**', '- 1', '', '**B**', '- 2', '', '## 待办', '- [ ] x', '- [ ] y'].join('\n')
  assert.ok(reportViolations(flatTodo).some((line) => /没归到项目下/.test(line)), '多个项目却把待办平铺')

  // 只有一个项目时，待办不分组是允许的（不必为一个项目加个标题）
  const single = ['## 今天做了什么', '**A**', '- 1', '', '## 待办', '- [ ] x'].join('\n')
  assert.deepEqual(reportViolations(single), [], '单项目不必强求待办分组')
})

test('后台提炼：只提炼不留汇总（原先白花一次模型调用）', async () => {
  const now = Date.now()
  const records = [{ header: { id: 'a', createdAt: now, cwd: '/p/a' } }]
  const snapshots = new Map([['a', { events: [
    { type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '干活' }] } },
  ] }]])
  const storeFile = join(tmpdir(), `dsh-assistant-refine-${Date.now()}.json`)
  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map([['a', '会话A']]), answers: ['- 提炼一条'] })

  const result = await refinePendingParts(ctx, { logger: quiet, now, storeFile })
  assert.equal(calls.created.length, 1, '只跑每个会话那一次提炼，不要汇总')
  assert.equal(result.parts.length, 1)

  // 关键：水位已落盘 → 再跑一次没有增量，直接抛"没有可总结的会话"（这就是它省下的工）
  await assert.rejects(() => refinePendingParts(ctx, { logger: quiet, now, storeFile }), /今天还没有可总结的会话/)

  // 而完整的分步总结 = 提炼 + 汇总（两步都要调用）
  const full = fakeCtx({ records, snapshots, titles: new Map([['a', '会话A']]), answers: ['- 提炼一条', '## 今天做了什么'] })
  await generateTodaySummaryStepped(full.ctx, { logger: quiet, now, storeFile: join(tmpdir(), `dsh-assistant-full-${Date.now()}.json`) })
  assert.equal(full.calls.created.length, 2, '完整路径 = 提炼 1 次 + 汇总 1 次')
})

test('后台提炼：水位之后只补增量（压缩过的那段不再重提炼）', async () => {
  const now = Date.now()
  const earlier = now - 3600_000
  const records = [{ header: { id: 'a', createdAt: earlier, cwd: '/p/a' } }]
  const snapshots = new Map([['a', { events: [
    { type: 'user/message', time: earlier, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '压缩前的事' }] } },
    { type: 'user/message', time: now - 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '压缩后新增' }] } },
  ] }]])
  const storeFile = join(tmpdir(), `dsh-assistant-delta-${Date.now()}.json`)
  appendPart({ sessionId: 'a', title: '会话A', cwd: '/p/a', untilTime: earlier + 1, markdown: '- 之前提炼过的' }, storeFile)

  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map([['a', '会话A']]), answers: ['- 只补这段'] })
  await refinePendingParts(ctx, { logger: quiet, now, storeFile })

  assert.equal(calls.created.length, 1, '水位之后还有新增 → 提炼一次')
  assert.ok(calls.prompts[0].includes('压缩后新增'), '增量内容要进提示词')
  assert.ok(!calls.prompts[0].includes('压缩前的事'), '水位之前的内容不该再喂一遍（这就是留存的意义）')
  assert.equal(summarizedUntil('a', storeFile), now - 1000, '水位推进到最后一条事件时间')
})

test('增量提炼：单会话输入要封顶，且保留最近的部分', () => {
  const now = Date.now()
  const chunk = 'x'.repeat(500)
  const events = []
  for (let index = 0; index < 40; index += 1) {
    events.push({
      type: 'user/message',
      time: now - 40_000 + index * 100,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${chunk} 第${index}条` }] },
    })
  }
  const records = [{ header: { id: 'a', createdAt: now, cwd: '/p/a' } }]
  const delta = extractDeltas(records, new Map([['a', digestsOf(events, now)]]), { now, summarizedUntilOf: () => 0 })[0]

  assert.ok(delta.chars <= 12_000, `输入要封顶（实际 ${delta.chars} 字符）`)
  assert.ok(delta.dropped > 0, '要报出省略了多少行')
  assert.ok(delta.lines[0].includes('已省略'), '开头要有省略标记（告诉模型这是截断过的）')
  assert.ok(delta.lines.at(-1).includes('第39条'), '保留**最近**的部分')
  assert.ok(!delta.lines.some((line) => line.includes('第0条')), '最早的内容被砍掉')

  // 没超上限时不该动它（别平白加个省略标记）
  const small = extractDeltas([{ header: { id: 'b', createdAt: now, cwd: '/p/b' } }],
    new Map([['b', digestsOf([events[39]], now)]]), { now, summarizedUntilOf: () => 0 })[0]
  assert.equal(small.dropped, 0)
  assert.ok(!small.lines[0].includes('已省略'))
})

/* ------------------------------------------------- 投影与扫描缓存（A/B/C） */

test('投影：只留窗口内真人文本，事件对象不进内存，lastTime 按全部事件算', () => {
  const now = Date.now()
  const yesterday = now - 30 * 3600_000
  const digest = projectSession({ events: [
    { type: 'user/message', time: yesterday, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '昨天' }] } },
    { type: 'user/message', time: now - 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天用户' }] } },
    { type: 'user/message', time: now - 900, data: { source: { kind: 'hook' }, content: [{ type: 'text', text: '注入' }] } },
    { type: 'assistant/message', time: now - 800, data: { message: { content: [{ type: 'text', text: '今天助手' }] } } },
    // 非消息事件：不进 messages，但时间要算进 lastTime（日报排序、水位推进都靠它）
    { type: 'tool/call', time: now - 100, data: { name: 'bash' } },
  ] }, { since: startOfToday(now) })

  assert.deepEqual(digest.messages.map((message) => [message.role, message.text]), [
    ['user', '今天用户'],
    ['assistant', '今天助手'],
  ])
  assert.equal(digest.lastTime, now - 100, 'lastTime 取所有事件的最大时间')
  assert.equal(digest.events, undefined, '事件对象（几百 MB 的那个）不能挂在 digest 上')
  assert.ok(!digest.messages.some((message) => message.text === '昨天'), '窗口外的文本不留')
  assert.ok(!digest.messages.some((message) => message.text === '注入'), '注入的上下文不留')
})

test('扫描：第二轮只重读"变过"的会话（每次压缩都全量重扫 = 6 秒 CPU 尖峰）', async () => {
  const now = Date.now()
  const records = [
    { header: { id: 'a', createdAt: now, cwd: '/p/a' } },
    { header: { id: 'b', createdAt: now, cwd: '/p/b' } },
  ]
  const event = (text) => ({ type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const snapshots = new Map([
    ['a', { events: [event('a 干活')] }],
    ['b', { events: [event('b 干活')] }],
  ])
  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map() })
  const digests = new SessionDigests()

  const first = await collectSessions(ctx, quiet, { digests })
  assert.deepEqual(calls.readSession, ['a', 'b'], '第一轮没缓存，两个都要读')
  assert.ok(first.digests.get('a').messages.length > 0, '投影进了缓存')

  const second = await collectSessions(ctx, quiet, { digests })
  assert.deepEqual(calls.readSession, ['a', 'b'], '第二轮一个都不重读')
  assert.equal(second.digests.get('a').messages[0].text, 'a 干活')

  // 只有变了的那一个会话要重读
  digests.touch('b')
  await collectSessions(ctx, quiet, { digests })
  assert.deepEqual(calls.readSession, ['a', 'b', 'b'], '只有 b 变了，就只重读 b')
})

test('扫描：跨天作废缓存（投影窗口是"今天"，昨天的 digest 不能用）', async () => {
  const now = Date.now()
  let clock = now
  const records = [{ header: { id: 'a', createdAt: now, cwd: '/p/a' } }]
  const snapshots = new Map([['a', { events: [
    { type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '干活' }] } },
  ] }]])
  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map() })
  const digests = new SessionDigests({ now: () => clock })

  await collectSessions(ctx, quiet, { digests })
  await collectSessions(ctx, quiet, { digests })
  assert.equal(calls.readSession.length, 1, '同一天内不重读')

  clock = now + 26 * 3600_000     // 第二天
  digests.touch('a')
  const tomorrow = await collectSessions(ctx, quiet, { digests })
  assert.equal(calls.readSession.length, 2, '跨天必须重读：昨天的投影里没有今天的文本')
  assert.equal(tomorrow.digests.get('a').messages.length, 0, '昨天的事件不算今天的增量')
})

test('扫描：每个会话之间把事件循环让出去（否则宿主心跳被整体推迟）', async () => {
  const now = Date.now()
  const records = Array.from({ length: 5 }, (_, index) => ({ header: { id: `s${index}`, createdAt: now, cwd: `/p/${index}` } }))
  const snapshots = new Map(records.map((record, index) => [
    record.header.id,
    { events: [{ type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${index} 个` }] } }] },
  ]))
  const { ctx } = fakeCtx({ records, snapshots, titles: new Map() })

  // 数"让出了几次"，而不是用定时器碰运气：读几个会话就该让出几次
  const yields = []
  const digests = new SessionDigests()
  await collectSessions(ctx, quiet, { digests, onYield: async () => { yields.push(digests.reads) } })
  assert.deepEqual(yields, [1, 2, 3, 4, 5], '每个会话读完都让出一次（且是在读完那一刻）')
  assert.equal(yieldToLoop() instanceof Promise, true, '默认实现必须是异步的')
})

/* ------------------------------------------------- 首轮预筛（mtime 索引，D） */

test('预筛：按目录名能定位到会话文件（两种命名都要认）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-activity-'))
  try {
    const root = join(dir, 'sessions')
    const write = (slug, key, file, mtime) => {
      mkdirSync(join(root, slug, key), { recursive: true })
      const path = join(root, slug, key, file)
      writeFileSync(path, 'x')
      utimesSync(path, mtime / 1000, mtime / 1000)
    }
    const today = Date.now()
    const old = today - 3 * 86400_000
    write('--Users-vian-Documents-a--', 'aaaa-1111', 'session.v3.jsonl.zstd', today)   // v3：裸 id
    write('--Users-vian-Documents-b--', 'session-bbbb-2222', 'session.jsonl.zstd', old) // v0：带前缀
    write('--Users-vian-Documents-c--', 'cccc-3333', 'session.v3.jsonl.zstd', old)

    const index = createSessionActivityIndex({ root, now: () => today })
    assert.equal(index.mtimeOf('aaaa-1111'), today, 'v3 裸 id 能定位')
    assert.equal(index.mtimeOf('bbbb-2222'), old, '给不带前缀的 id 也要能定位到带前缀的目录')
    assert.equal(index.mtimeOf('session-bbbb-2222'), old, '带前缀的 id 同样能定位')
    assert.equal(index.mtimeOf('nope'), undefined, '定位不到 → undefined（调用方照读）')
    assert.equal(index.stats.entries, 3)

    // 目录不存在（比如换了 DSH_HOME）：没有信号，不是错误
    const missing = createSessionActivityIndex({ root: join(dir, 'nowhere'), now: () => today })
    assert.equal(missing.mtimeOf('aaaa-1111'), undefined)
    assert.equal(missing.stats.entries, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('预筛判定：今天新建 / 今天动过 / live / 不知道 → 都要读', () => {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const since = startOfToday(today.getTime())
  const yesterday = since - 3600_000

  const activity = { mtimeOf: (id) => ({ today: since, old: yesterday })[id] }
  assert.equal(touchedToday({ id: 'today', createdAt: yesterday }, false, activity, since), true, '今天写过日志 → 读')
  assert.equal(touchedToday({ id: 'old', createdAt: yesterday }, false, activity, since), false, '今天没写过 → 跳过')
  assert.equal(touchedToday({ id: 'old', createdAt: since + 1000 }, false, activity, since), true, '今天新建的 → 读')
  assert.equal(touchedToday({ id: 'old', createdAt: yesterday }, true, activity, since), true, '内存里的会话可能还没落盘 → 读')
  assert.equal(touchedToday({ id: 'unknown', createdAt: yesterday }, false, activity, since), true, '定位不到 → 照读（宁可慢不能漏）')
  assert.equal(touchedToday({ id: 'old', createdAt: yesterday }, false, undefined, since), true, '没有索引 → 照读')
})

test('预筛接进扫描：老会话不读，今天动过的读（读的个数要掉一个数量级）', async () => {
  const now = Date.now()
  const since = startOfToday(now)
  const records = [
    { header: { id: 'active', createdAt: now - 3600_000, cwd: '/p/a' }, live: true },
    { header: { id: 'logged', createdAt: now - 3600_000, cwd: '/p/b' }, live: false, persisted: true },
    { header: { id: 'stale', createdAt: now - 30 * 86400_000, cwd: '/p/c' }, live: false, persisted: true },
    { header: { id: 'unknown', createdAt: now - 30 * 86400_000, cwd: '/p/d' }, live: false, persisted: true },
  ]
  const event = (text) => ({ type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const snapshots = new Map([
    ['active', { events: [event('内存里的会话')] }],
    ['logged', { events: [event('今天写过日志')] }],
    ['stale', { events: [event('其实今天也在说话（反例）')] }],
    ['unknown', { events: [event('定位不到文件')] }],
  ])
  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map() })
  const activity = { mtimeOf: (id) => (id === 'logged' ? since : id === 'stale' ? since - 86400_000 : undefined) }

  const { digests } = await collectSessions(ctx, quiet, { digests: new SessionDigests(), activity })
  assert.deepEqual(calls.readSession.sort(), ['active', 'logged', 'unknown'], '只跳过"确实没动过"的那个')
  assert.ok(digests.has('active') && digests.has('logged') && digests.has('unknown'))
  assert.ok(!digests.has('stale'), '被跳过的会话不进缓存（下轮还会再判一次）')

  // 第二轮：一个都没变 → 一个都不重读（预筛/缓存都不该额外读）
  await collectSessions(ctx, quiet, { digests, activity })
  assert.deepEqual(calls.readSession.sort(), ['active', 'logged', 'unknown'], '缓存命中 + 预筛跳过 = 0 次读')

  // 标脏的那个才重读
  digests.touch('active')
  await collectSessions(ctx, quiet, { digests, activity })
  assert.deepEqual(calls.readSession.sort(), ['active', 'active', 'logged', 'unknown'], '只有变过的重读')
})

/* ------------------------------------------------- 结果页提示（后台总结开关） */

test('结果页提示：后台总结关着（默认）时给一行开关说明，开着时不给', () => {
  const off = summaryHint({ backgroundSummary: false })
  assert.ok(off.length > 0, '默认是这个状态，结果页必须有一句说明')
  assert.match(off, /任务后台总结/, '要点名那个开关叫什么')
  assert.match(off, /桌面宠物/, '要说清它在设置面板的哪张卡里')
  assert.match(off, /压缩/, '要说明开关打开后是靠"每次压缩顺手留存"')

  assert.equal(summaryHint({ backgroundSummary: true }), '', '开着就别再念（噪音）')
  assert.ok(summaryHint().length > 0, '没给设置时按默认（关）处理')
  assert.equal(summaryHint({ backgroundSummary: 'true' }), summaryHint(), '只认真正的 true，字符串不算')
})

/* ------------------------------------------------------- 水位存储 */

test('水位存储：写入后可读回，同水位覆盖不重复拼接', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-store-'))
  const file = join(dir, 'summaries.json')
  try {
    assert.equal(summarizedUntil('s1', file), 0, '没有留存时水位是 0')
    appendPart({ sessionId: 's1', title: '会话一', untilTime: 100, markdown: '第一段' }, file)
    appendPart({ sessionId: 's1', title: '会话一', untilTime: 200, markdown: '第二段' }, file)
    assert.equal(summarizedUntil('s1', file), 200)
    assert.deepEqual(partsFor('s1', file).map((part) => part.markdown), ['第一段', '第二段'])

    // 压缩可能重复触发：同一水位重写要覆盖，不能拼出重复内容
    appendPart({ sessionId: 's1', title: '会话一', untilTime: 200, markdown: '第二段（改）' }, file)
    assert.deepEqual(partsFor('s1', file).map((part) => part.markdown), ['第一段', '第二段（改）'])
    assert.equal(readStore(file).version, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('水位存储：原子写（不留 .tmp，损坏的存储按空处理）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-store-'))
  const file = join(dir, 'summaries.json')
  try {
    writeStore({ version: 1, sessions: { s: { parts: [] } } }, file)
    assert.ok(!existsSync(`${file}.tmp`), '不留临时文件')
    assert.ok(existsSync(file))

    writeFileSync(file, '{ 坏掉的 json', 'utf8')
    assert.deepEqual(readStore(file).sessions, {}, '损坏时按空处理，不能让总结整体报错')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('水位存储：路径可由 DSH_ASSISTANT_SUMMARY_STORE / DSH_HOME 覆盖', () => {
  assert.equal(storePath({ DSH_ASSISTANT_SUMMARY_STORE: '/tmp/x.json' }), '/tmp/x.json')
  assert.match(storePath({ DSH_HOME: '/tmp/home' }), /^\/tmp\/home\/dsh-assistant\/summaries\.json$/)
})

/* --------------------------------------------- 执行层（假服务） */

function fakeCtx({ records, snapshots, titles, answers = [] } = {}) {
  const calls = { readSession: [], readSurface: [], readTitleSnapshots: [], created: [], prompts: [], disposed: [], flushed: [] }
  const sessionQuery = {
    async listSessions() { return records },
    async readSession(id) {
      calls.readSession.push(id)
      const snapshot = snapshots.get(id)
      if (!snapshot) throw new Error(`no snapshot for ${id}`)
      return snapshot
    },
    async readSurface(id) {
      calls.readSurface.push(id)
      return snapshots.get(`${id}:surface`)
    },
    async readTitleSnapshots(ids) {
      calls.readTitleSnapshots.push(ids)
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: titles.get(sessionId) } } }))
    },
    async readTitle(id) { return { title: titles.get(id) } },
  }
  let index = 0
  const agents = {
    async create(options) {
      calls.created.push(options)
      const session = { snapshotEvents: () => [{ type: 'assistant/message', data: { content: [{ type: 'text', text: answers[index++] ?? '# ok' }] } }] }
      return {
        agent: {
          session,
          followup(message) { calls.prompts.push(String(message?.content?.[0]?.text ?? '')) },
          whenIdle: async () => {},
        },
        dispose: async () => { calls.disposed.push(true) },
      }
    },
  }
  return {
    calls,
    ctx: {
      get: (name) => ({ sessionQuery, agents, sessions: { flush: async (session) => { calls.flushed.push(session) } } }[name]),
    },
  }
}

test('执行层：会话标题是异步读的（漏 await 会让标题永远变成 cwd）', async () => {
  const now = Date.now()
  const records = [{ header: { id: 'a', createdAt: now, cwd: '/p/a' } }]
  const snapshots = new Map([['a', { events: [{ type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '干活' }] } }] }]])
  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map([['a', '真正的标题']]) })
  const { titleOf } = await collectSessions(ctx, quiet)
  assert.equal(titleOf('a'), '真正的标题', '标题必须真的解析出来，而不是 undefined')
  assert.deepEqual(calls.readTitleSnapshots, [['a']], '批量读一次，不在循环里逐条等')
})

test('执行层：读不出来的会话跳过，退回 surface', async () => {
  const now = Date.now()
  const records = [
    { header: { id: 'broken', createdAt: now, cwd: '/p/b' } },
    { header: { id: 'fine', createdAt: now, cwd: '/p/f' } },
  ]
  const snapshots = new Map([
    ['broken:surface', { events: [{ type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'surface' }] } }] }],
    ['fine', { events: [{ type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'fine' }] } }] }],
  ])
  const { ctx, calls } = fakeCtx({ records, snapshots, titles: new Map() })
  const { digests: loaded } = await collectSessions(ctx, quiet)
  assert.deepEqual(calls.readSurface, ['broken'], '整段读不出来才退回 surface')
  assert.ok(loaded.has('fine'))
  assert.ok(loaded.has('broken'))
})

test('执行层：跑完隐藏会话必须 dispose，并先落盘', async () => {
  const { ctx, calls } = fakeCtx({ answers: ['## 今天做了什么\n- 干活'] })
  const text = await runHiddenSession(ctx, { prompt: 'x', cwd: '/tmp', logger: quiet })
  assert.match(text, /今天做了什么/)
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].meta.origin, 'subagent', '必须是隐藏会话')
  assert.equal(calls.disposed.length, 1, '不 dispose 会在内存里留下一个停不掉的 agent')
  assert.equal(calls.flushed.length, 1, '读正文前先 flush 持久化')
  assert.equal(calls.created[0].signal instanceof AbortSignal, true, '要有超时中止信号')
})

test('执行层：缺服务时给出可读的错误', async () => {
  await assert.rejects(() => collectSessions({ get: () => undefined }, quiet), /缺少 sessionQuery \/ agents/)
  await assert.rejects(() => runHiddenSession({ get: () => undefined }, { prompt: 'x' }), /缺少 agents 服务/)
})
