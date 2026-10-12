/**
 * 抬窗口（src/pet-window.js）的单测：注入假 electron / 假 execFile，验证两条路径都按契约来 ——
 * 主进程内能操作窗口时不用 spawn；桌面端（RUN_AS_NODE 宿主）走 `open -a <app>`；
 * 两边都不适用时安静返回 false。
 *
 * 真窗口行为只能在桌面端肉眼验收，所以这里守的是**契约**：
 * 该调的调了、路径推导对不对、返回值如实、失败只留日志。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appBundlePath, createWindowRaiser } from '../src/pet-window.js'

const DESKTOP_EXEC = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'

/** 假 electron：只实现我们用到的几个方法，并记下调用顺序。 */
function fakeElectron({ windows = [{}], throws } = {}) {
  const calls = []
  const made = windows.map((options) => ({
    minimized: options.minimized === true,
    destroyed: options.destroyed === true,
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    restore() { calls.push('restore'); this.minimized = false },
    show() { if (throws === 'show') throw new Error('show 炸了'); calls.push('show') },
    focus() { calls.push('focus') },
  }))
  return {
    calls,
    windows: made,
    BrowserWindow: {
      getAllWindows: () => made,
      getFocusedWindow: () => made.find((window) => !window.destroyed && !window.minimized) ?? null,
    },
    app: { focus: (options) => calls.push(`app.focus:${options?.steal === true}`) },
  }
}

/** 假 execFile：只记下参数，不真起进程。 */
function fakeExecFile() {
  const calls = []
  const run = (command, args, options, callback) => {
    calls.push([command, args, options])
    callback?.(null)
  }
  return { calls, run }
}

test('抬窗口（主进程内）：最小化 → 恢复 + 显示 + 聚焦 + 抢焦点，不用 spawn', () => {
  const electron = fakeElectron({ windows: [{ minimized: true }] })
  const spawn = fakeExecFile()
  const raise = createWindowRaiser({ warn() {} }, { electron, execFile: spawn.run, platform: 'darwin', execPath: DESKTOP_EXEC })
  assert.equal(raise(), true)
  assert.deepEqual(electron.calls, ['restore', 'show', 'focus', 'app.focus:true'],
    '少了 app.focus 的话，窗口只是显示出来，还会留在别的 app 后面')
  assert.deepEqual(spawn.calls, [], '能直接操作窗口就不该再起进程')
})

test('抬窗口（桌面端 RUN_AS_NODE 宿主）：没有 electron 时用 open -a 激活那个 .app', () => {
  const spawn = fakeExecFile()
  const warnings = []
  const raise = createWindowRaiser({ warn: (line) => warnings.push(String(line)) }, {
    electron: undefined,
    execFile: spawn.run,
    platform: 'darwin',
    execPath: DESKTOP_EXEC,
  })
  assert.equal(raise(), true)
  assert.equal(spawn.calls.length, 1)
  assert.deepEqual(spawn.calls[0][0], 'open')
  assert.deepEqual(spawn.calls[0][1], ['-a', '/Applications/DeepSeek Harness.app'])
  assert.deepEqual(warnings, [], '这条路径是本机的正常路径，不该有告警')
})

test('抬窗口：路径不是 .app（网页版跑在 node 上）时返回 false、不起进程', () => {
  const spawn = fakeExecFile()
  const raise = createWindowRaiser({ warn() {} }, {
    electron: undefined,
    execFile: spawn.run,
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
  })
  assert.equal(raise(), false)
  assert.deepEqual(spawn.calls, [], '没有窗口可抬就别去激活别的程序')
})

test('抬窗口：非 macOS 且不在主进程内 → false', () => {
  const spawn = fakeExecFile()
  const raise = createWindowRaiser({ warn() {} }, {
    electron: undefined,
    execFile: spawn.run,
    platform: 'linux',
    execPath: '/opt/app/resources/bin/node',
  })
  assert.equal(raise(), false)
  assert.deepEqual(spawn.calls, [])
})

test('抬窗口：没有窗口时返回 false', () => {
  const electron = fakeElectron({ windows: [] })
  const raise = createWindowRaiser({ warn() {} }, { electron, platform: 'linux', execPath: '/usr/bin/node' })
  assert.equal(raise(), false)
})

test('抬窗口：窗口操作抛错时只留一条日志，不把插件带崩', () => {
  const warnings = []
  const electron = fakeElectron({ throws: 'show' })
  const raise = createWindowRaiser({ warn: (line) => warnings.push(String(line)) }, { electron, platform: 'darwin', execPath: DESKTOP_EXEC })
  assert.equal(raise(), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /抬窗口失败/)
})

test('路径推导：只认 app 包内的可执行文件', () => {
  assert.equal(appBundlePath(DESKTOP_EXEC), '/Applications/DeepSeek Harness.app')
  assert.equal(appBundlePath('/Applications/Some.app/Contents/MacOS/some-helper'), '/Applications/Some.app')
  assert.equal(appBundlePath('/usr/local/bin/node'), undefined)
  assert.equal(appBundlePath(undefined), undefined)
})
