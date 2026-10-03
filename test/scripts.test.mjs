/**
 * 构建/自检脚本的守卫用例。
 *
 * 为什么单开一个文件：这些脚本平时没人读，出问题时症状又总是**指向产品**——
 * 「预热脚本崩了」表现成 verify 报"协议握手失败"，"helper 未就绪"表现成测试超时。
 * 所以这里守两件事：诊断不能被吞掉、脚本自身至少语法能过。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = process.cwd()
const read = (relative) => readFileSync(join(root, relative), 'utf8')

test('脚本：构建脚本语法可过（bash -n，不进真编译）', async () => {
  for (const script of ['scripts/build-helper.sh', 'scripts/test-swift.sh']) {
    assert.ok(existsSync(join(root, script)), `${script} 应该在`);
    // 退出码非 0 时 execFile 会抛，抛出即语法错
    const { stderr } = await run('bash', ['-n', join(root, script)])
    assert.equal(stderr.trim(), '', `${script} 语法检查不该有输出：${stderr}`)
  }
})

test('脚本：预热失败不能被 `|| true` 吞掉（那是唯一一条指向真因的线索）', async () => {
  const source = read('scripts/build-helper.sh')

  // ① 明确不能吞：`|| true` 会让"脚本根本没跑起来"和"预热没成功"长得一模一样
  const warmLine = source.split('\n').find((line) => line.includes('warm-helper.mjs')) ?? ''
  assert.ok(warmLine !== '', '构建脚本里应该有预热这一步')
  assert.ok(!/\|\|\s*true/.test(warmLine), `预热那行不能写 || true：${warmLine}`)

  // ② 退出码要被接住，且失败时给出可操作的下一步（而不是沉默）
  assert.match(source, /WARM_STATUS=\$\?/u, '要接住预热脚本的退出码')
  assert.match(source, /WARM_STATUS.*-ne 0/u, '非 0 要处理')
  assert.match(source, /预热脚本自身失败/u, '要明说"是脚本失败了"，而不是含糊的"预热失败"')
  assert.match(source, /排查：node/u, '要给出复现/排查命令')

  // ③ 但**不因此让构建失败**：预热是加速手段，不是正确性条件（而且它在 set -e 里，必须自己关一次）
  assert.match(source, /set \+e\nnode "\$DIR\/warm-helper\.mjs"/u, 'set -e 之下要先关掉 errexit')
  assert.match(source, /^set -e$/mu, '处理完要恢复 errexit')
})

test('脚本：预热脚本自己保证"没成功也 exit 0"（构建依赖这个契约）', async () => {
  const warn = []
  // 真跑一次：给一个不存在的二进制 → 立刻返回，不碰系统扫描
  const { stdout, stderr } = await run('node', [join(root, 'scripts', 'warm-helper.mjs'), '/nonexistent/dsh-assistant-helper'])
  const text = `${stdout}${stderr}`
  assert.match(text, /helper 不存在/u, `失败原因要写清楚，实际输出：${text}`)
  assert.match(text, /不影响构建/u, '要说清"它不阻塞构建"，否则读日志的人会去追一个假故障')
  warn.push(text)

  // 契约：CLI 分支永远 exit 0（否则上面那段 `set +e` 之外还会有人再吞一次）
  const source = read('scripts/warm-helper.mjs')
  assert.match(source, /process\.exit\(0\)/u, '预热失败不该让构建失败')
  assert.ok(!/process\.exit\(1\)/u.test(source), '预热脚本不该有失败退出码')
  assert.equal(warn.length, 1)
})

test('脚本：verify 的 helper 新鲜度判定能看出"该重建了"，而不是只在日志里叹口气', async () => {
  const source = read('scripts/verify.mjs')
  assert.match(source, /mtime|新鲜|stale/u, 'verify 要判 helper 是不是比源码旧')
  // 依赖 mtime 的判定必须把失败讲出来（找不到源码/二进制时不能静默通过）
  assert.ok(!/catch\s*\{\s*\}/u.test(source), 'verify 里不该有空 catch（静默通过 = 自检失去意义）')
})

test('脚本：资产契约模块只有一份（verify 与单测共用，不各定一套阈值）', () => {
  const verify = read('scripts/verify.mjs')
  const assets = read('test/assets.test.mjs')
  for (const source of [verify, assets]) {
    assert.match(source, /asset-contract\.mjs/u, '两边都要用同一个契约模块')
  }
  // 判据本身不该在 verify 里二次实现（曾经分叉过一次）
  assert.ok(!/MIN_VARIANTS\s*=\s*\d/u.test(verify), 'verify 不该自己再定一份阈值')
})

test('脚本：npm scripts 里的路径都存在（改名漏改脚本会在这里红）', async () => {
  const pkg = JSON.parse(read('package.json'))
  const missing = []
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    // 带通配符的命令跳过：`"test/*.test.mjs"` 这种没法直接当路径判
    if (command.includes('*')) continue
    const files = command.match(/[\w./-]+\.(?:mjs|sh|py|js)\b/gu) ?? []
    for (const file of files) {
      // `--out assets/pack` 这类参数也可能被正则捞到：只挑"看起来是脚本路径"的
      const candidate = resolve(root, file)
      if (file.startsWith('assets/') || file.startsWith('runtime/')) continue
      if (!existsSync(candidate)) missing.push(`${name}: ${file}`)
    }
  }
  assert.deepEqual(missing, [], `npm scripts 指向了不存在的文件：\n  ${missing.join('\n  ')}`)
})
