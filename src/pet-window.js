/**
 * pet-window —— 点宠物上的通知时，把 DSH 窗口抬到最前。
 *
 * 为什么需要它：客户端半边能把**会话**切过去，但窗口还压在别的 app 后面等于没切。
 * 浏览器里的 `window.focus()`（客户端那句）在 Electron 渲染进程里是空操作，
 * 能抬窗口的只有两层，按可用性依次尝试：
 *
 *   ① 宿主恰好跑在 Electron 主进程里 → 直接 show/focus BrowserWindow。
 *      注意：桌面端**不是**这种 —— 宿主是 `ELECTRON_RUN_AS_NODE` 子进程，
 *      `require('electron')` 是 MODULE_NOT_FOUND（本机实测），所以才需要下面那条。
 *   ② macOS：让 LaunchServices 去激活那个 .app（`open -a <app>`）。
 *      宿主的 execPath 就在 app 里（…/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness），
 *      路径从自己身上推出来，不写死任何安装位置。
 *
 * 两条都不适用（网页版 / headless / 非 macOS）→ 返回 false，只留一条 debug：
 * 插件不许因为"抬不动窗口"把宠物带崩，也不许静默 —— 用户点了没反应时日志里要能查。
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

/** 从可执行文件路径推出 .app（宿主是 app 包内的一个子进程）。 */
export function appBundlePath(execPath) {
  return /^(.*\.app)\/Contents\/MacOS\//.exec(String(execPath ?? ''))?.[1]
}

/** 从 require 到的 electron 模块里挑出我们要的两个能力；不合格就当没有。 */
function usable(loaded) {
  return loaded?.app && loaded?.BrowserWindow ? loaded : undefined
}

export function createWindowRaiser(logger = console, options = {}) {
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const spawn = options.execFile ?? execFile
  const bundle = appBundlePath(execPath)

  let electron = options.electron
  let resolved = options.electron !== undefined
  const electronApi = () => {
    if (resolved) return electron
    resolved = true
    try {
      electron = usable(createRequire(import.meta.url)('electron'))
    } catch {
      electron = undefined // 桌面端的宿主是 RUN_AS_NODE 子进程：本来就没有这个模块
    }
    return electron
  }
  // 一开始就解析一次：否则"这台机器到底能不能抬窗口"要等用户第一次点通知才知道
  const inProcess = electronApi()
  if (!inProcess && !(platform === 'darwin' && bundle !== undefined)) {
    logger?.debug?.('dsh-assistant: 当前环境没有可抬起的 DSH 窗口（网页版/headless？），点通知只切会话')
  }

  /**
   * @returns {boolean} 是否真的做了"把窗口抬起来"这件事（false = 这里没有窗口可抬）
   */
  return function raiseWindow() {
    const loaded = inProcess ?? electronApi()
    if (loaded) {
      try {
        const windows = loaded.BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
        const window = loaded.BrowserWindow.getFocusedWindow?.() ?? windows[0]
        if (!window || window.isDestroyed?.()) return false
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
        // macOS：不抢焦点的话，窗口只是"显示"出来，仍然留在别的 app 后面
        loaded.app.focus?.({ steal: true })
        return true
      } catch (error) {
        logger?.warn?.(`dsh-assistant: 抬窗口失败: ${messageOf(error)}`)
        return false
      }
    }

    if (platform !== 'darwin' || bundle === undefined) return false
    try {
      // `open -a` 就是 LaunchServices 的"激活这个 app"：已经在跑就把它带到最前
      spawn('open', ['-a', bundle], { stdio: 'ignore' }, (error) => {
        if (error) logger?.debug?.(`dsh-assistant: 激活 DSH 窗口失败: ${messageOf(error)}`)
      })
      return true
    } catch (error) {
      logger?.warn?.(`dsh-assistant: 抬窗口失败: ${messageOf(error)}`)
      return false
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
