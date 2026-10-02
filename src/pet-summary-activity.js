/**
 * pet-summary-activity —— 会话文件 mtime 索引（D：首轮扫描的预筛信号）。
 *
 * 目的：`collectSessions` 的第一轮（进程刚起来、缓存还空着）原本要把**所有**非子会话
 * 整段读一遍。实测本机：160 个会话、解压 0.70 GB，而今天真正动过的只有 8 个。
 *
 * 为什么能预筛：会话日志是**追加**写的，只要今天有事件，文件 mtime 一定是今天。
 * 所以 `mtime < 今天 0 点` ⇒ 这个会话今天不可能有新内容。这条代理关系在真机上验证过：
 * 171 个 mtime 早于今天的会话，逐个解压核对事件时间，**0 个**今天有事件
 *（脚本见提交说明；一个有反例就说明规则不成立）。
 *
 * 为什么用文件而不是 DSH 的接口：`sessionQuery.listSessions()` 的记录只有
 * `{ header, live, persisted }`，header 里也没有"最后活动时间"（排序只按 createdAt）。
 * 底层 `sessionPersistence.list()` 倒是带 `revision`（`dev:ino:size:mtimeNs:ctimeNs`），
 * 但那是个**不透明**的 brand 字符串、且换成 SQLite 后端就没有文件语义 —— 解析它
 * 等于押注实现细节，比直接 stat 文件更脆。
 *
 * 三条纪律：
 *   1. **失败一律"照读"**：定位不到目录/文件、读目录出错、路径不存在 → 返回 undefined，
 *      调用方必须退回旧行为（宁可慢，不能漏）。
 *   2. **只做减法**：本模块只回答"这个 id 的日志最后是什么时候写的"，
 *      不参与"要不要总结"的判断（那是 collectSessions 的事）。
 *   3. **一次扫描只走一遍目录树**：索引带 TTL（默认 15s），一轮扫描里的 N 次查询共用一份。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 目录名的几种写法（实测两种都存在：v3 用裸 id，v0 带 `session-` 前缀）。 */
function keysOf(id) {
  const bare = id.replace(/^session-/, '')
  return [id, bare, `session-${bare}`]
}

/**
 * 默认的会话根：`$DSH_HOME/sessions`。
 *
 * 与 layout.json / summaries.json 同一套约定（见 pet-summary-store.js）——
 * DSH_HOME 拿不到时返回 undefined，调用方照读。
 */
function defaultRoot(home) {
  const base = home ?? process.env.DSH_HOME
  return base ? join(base, 'sessions') : undefined
}

/**
 * 建一个"会话最后写入时间"索引。
 *
 * @param {{home?: string, root?: string, now?: () => number, refreshMs?: number}} [options]
 * @returns {{mtimeOf(id: string): number|undefined, stats: {entries: number, builtAt: number}}}
 */
export function createSessionActivityIndex({ home, root, now = Date.now, refreshMs = 15_000 } = {}) {
  let index = new Map()
  let builtAt = 0

  const build = () => {
    const base = root ?? defaultRoot(home)
    const map = new Map()
    if (!base) return map
    let workspaces
    try {
      workspaces = readdirSync(base, { withFileTypes: true })
    } catch {
      // 目录不存在 / 没权限：没有信号，照读
      return map
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const workspaceDir = join(base, workspace.name)
      let sessions
      try {
        sessions = readdirSync(workspaceDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const dir = join(workspaceDir, session.name)
        let files
        try {
          files = readdirSync(dir)
        } catch {
          continue
        }
        let newest = 0
        for (const file of files) {
          if (!file.endsWith('.zstd')) continue
          try {
            const stat = statSync(join(dir, file))
            if (stat.mtimeMs > newest) newest = stat.mtimeMs
          } catch {
            // 单个文件读不到就跳过（可能是正在写的临时态）
          }
        }
        if (newest > 0) map.set(session.name, newest)
      }
    }
    return map
  }

  return {
    /** 会话日志的最后写入时间；不知道就返回 undefined（调用方必须照读）。 */
    mtimeOf(id) {
      const nowMs = now()
      if (nowMs - builtAt > refreshMs) {
        index = build()
        builtAt = nowMs
      }
      for (const key of keysOf(String(id))) {
        const hit = index.get(key)
        if (hit !== undefined) return hit
      }
      return undefined
    },
    /** 诊断用：索引里有几个会话、什么时候建的。 */
    get stats() {
      return { entries: index.size, builtAt }
    },
  }
}

/**
 * 这个会话今天可能有内容吗？
 *
 * @returns {true} 要读（今天新建 / 今天动过 / **不知道**）
 */
export function touchedToday(header, live, activity, since) {
  if ((header?.createdAt ?? 0) >= since) return true
  // 内存里的会话（live）可能还没落盘：mtime 不可信，照读
  if (live) return true
  const mtime = activity?.mtimeOf?.(String(header?.id ?? ''))
  if (mtime === undefined) return true
  return mtime >= since
}
