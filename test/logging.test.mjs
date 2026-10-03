/**
 * 日志与"静默失败"的账本（守卫用例）。
 *
 * 由来：这一轮排查里，**四个**问题都是同一形状 —— catch 里什么都不做，
 * 于是"设置明明存了却不生效""预筛静默失效""存储读失败被当成没有存储""面板存不上却零日志"
 * 全都表现成"功能好像没反应"，日志里一个字都没有。
 *
 * 所以这里把两件事变成**可执行的账**：
 *   1. 每个做 IO / 面向用户的模块都必须走 logger（而不是把失败咽下去）；
 *   2. 允许存在的"空 catch"必须逐条登记在下面的清单里 —— 新增一条没登记的，这条会红。
 *
 * 清单不是"豁免"，是**说明**：每条都要写清"为什么这里咽下去是对的"。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = process.cwd()
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/** 做 IO / 面向用户的模块：必须有日志通道，且不许新增未登记的空 catch。 */
const IO_MODULES = [
  'src/index.js',
  'src/pet.js',
  'src/pet-process.js',
  'src/pet-settings.js',
  'src/pet-endpoint.js',
  'src/pet-summary.js',
  'src/pet-summary-agent.js',
  'src/pet-summary-store.js',
  'src/pet-summary-activity.js',
]

/**
 * 逐条登记的"故意咽下去"，键是 `文件:近似行` 的稳定标识（用注释文本定位更稳）。
 * 每条都必须能回答：为什么这里咽下去是对的？
 */
const DELIBERATE_SILENT_CATCHES = [
  ['src/index.js', '收尾失败不再抛'],
  ['src/pet.js', '收尾失败不再抛'],
  ['src/pet-process.js', '最优努力'],
  ['src/pet-process.js', '已经断开'],
  ['src/pet-process.js', '观测失败不影响通道'],
  ['src/pet-process.js', '已经退了'],
  ['src/pet-settings.js', '路径拼不出来就只用插件自身'],
  ['src/pet-settings.js', '换下一个位置'],
  ['src/pet-settings.js', '观察者自己炸了不影响写入'],
  ['src/pet-summary-agent.js', '读不出来就跳过这一个会话'],
  ['src/pet-summary-agent.js', '读不到就用 cwd 兜底'],
  ['src/pet-summary-store.js', '已经被人清掉了'],
  ['src/pet-summary-store.js', '别人抢先清了'],
]

/**
 * 扫出"注释即全部内容"的 catch 块。
 * 用花括号配对而不是正则，因为要判的是**块**的空（多行、含注释的都算）。
 */
function silentCatches(source) {
  const found = []
  const pattern = /catch\s*(\([^)]*\))?\s*\{/gu
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length
    let depth = 1
    let at = start
    while (at < source.length && depth > 0) {
      if (source[at] === '{') depth += 1
      else if (source[at] === '}') depth -= 1
      at += 1
    }
    const body = source.slice(start, at - 1)
    const stripped = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, '').trim()
    if (stripped === '') found.push(body.trim())
  }
  return found
}

test('日志：做 IO 的模块都得有日志通道（失败不许凭空消失）', () => {
  for (const file of IO_MODULES) {
    const source = read(file)
    assert.match(source, /logger/u, `${file} 应该持有 logger`)
    assert.match(
      source,
      /logger\??\.(debug|info|warn|error)\??\.\(/u,
      `${file} 应该真的用 logger 说点什么（只有参数没有调用 = 通道是摆设）`,
    )
  }
})

test('日志：每条日志都带插件前缀（用户能一键过滤出这个插件的行）', () => {
  const offenders = []
  for (const file of IO_MODULES) {
    const source = read(file)
    for (const [index, line] of source.split('\n').entries()) {
      const match = /logger\??\.(?:debug|info|warn|error)\??\.\(\s*[`']([^`']{0,40})/u.exec(line)
      if (!match) continue
      // 消息里带插值/多行拼起来的情况单独放行（拼出来的第一段一样要以插件名开头）
      if (match[1].includes('$')) continue
      if (match[1].includes('dsh-assistant')) continue
      offenders.push(`${file}:${index + 1} → ${match[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `这些日志没有插件前缀：\n  ${offenders.join('\n  ')}`)
})

test('日志：空 catch 全部有据可查（新增一条没登记的就红）', () => {
  const registered = []
  for (const [file, marker] of DELIBERATE_SILENT_CATCHES) {
    const source = read(file)
    const blanks = silentCatches(source)
    const hit = blanks.some((body) => body.includes(marker))
    assert.ok(hit, `登记的"故意咽下去"在 ${file} 里找不到了（${marker}）：清单过期了，请删掉或更新`)
    registered.push(`${file}:${marker}`)
  }

  const unregistered = []
  for (const file of IO_MODULES) {
    const source = read(file)
    for (const body of silentCatches(source)) {
      if (registered.some((entry) => entry.startsWith(`${file}:`) && body.includes(entry.split(':')[1]))) continue
      unregistered.push(`${file} → ${body.replace(/\s+/gu, ' ').slice(0, 80)}`)
    }
  }
  assert.deepEqual(
    unregistered,
    [],
    '这些 catch 什么都不做，也没登记理由（要么补日志，要么写清为什么可以咽下去并登记）：\n'
    + `  ${unregistered.join('\n  ')}`,
  )
})

test('日志：日志级别与"有多吵"匹配（逐条目/逐会话的写在 debug，结果写在 info）', () => {
  const agent = read('src/pet-summary-agent.js')
  // 一次日报要开 N+1 个隐藏会话：这条落在 info 上就是每跑一次刷 N 行
  assert.match(agent, /logger\.debug\?\.\(`dsh-assistant: 总结会话已启动/u, '逐会话的启动日志必须在 debug 上')
  assert.ok(!/logger\.info\?\.\(`dsh-assistant: 总结会话已启动/u.test(agent), '不要退回 info')

  // 结果行必须在 info（默认可见），否则"日报什么时候跑完的"用户看不到
  const summary = read('src/pet-summary.js')
  assert.match(summary, /logger\.info\?\.\(\s*`dsh-assistant: 今日总结完成/u, '结果要落在 info 上')

  // 一次日报只留一条 info：全量模式一条、增量模式一条
  const infoLines = summary.match(/logger\.info\?\.\(\s*`dsh-assistant: 今日总结完成/gu) ?? []
  assert.equal(infoLines.length, 2, '两条路径各一条结果日志（多出来就是重复记账）')
})

test('日志：结果行带得动账（能复算：读了多少 / 跳过多少 / 用时）', () => {
  const summary = read('src/pet-summary.js')
  const pet = read('src/pet.js')
  for (const [file, source] of [['src/pet-summary.js', summary], ['src/pet.js', pet]]) {
    const usesScan = /scan\?\.(read|skipped)/u.test(source)
    assert.ok(usesScan, `${file} 的结果日志要带上"读了多少 / 预筛跳过多少"（否则变快变慢只能靠猜）`)
  }
  assert.match(summary, /用时 \$\{Date\.now\(\) - startedAt\}ms/u, '结果日志要带用时')
})
