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
 * 四条纪律：
 *   1. **失败一律"照读"**：定位不到目录/文件、读目录出错、路径不存在 → 返回 undefined，
 *      调用方必须退回旧行为（宁可慢，不能漏）。
 *   2. **失败要能看见**：所有 failure 都进计数，每建一次索引留一条汇总（含首个原因与次数）。
 *      以前全是空 catch —— 预筛静默失效时表现成"日报又变成几分钟"，日志里一个字都没有。
 *   3. **只做减法**：本模块只回答"这个 id 的日志最后是什么时候写的"，
 *      不参与"要不要总结"的判断（那是 collectSessions 的事）。
 *   4. **一次扫描只走一遍目录树**：索引带 TTL（默认 15s），一轮扫描里的 N 次查询共用一份。
 *
 * 关于**异步**（这条是后补的，值得单独说）：以前 build() 是同步的 readdir+stat 递归，
 * 而它是在第一次 mtimeOf() 里被触发的 —— 也就是**在事件循环里**就地走一遍目录树。
 * 目录多的时候（本机 160 个会话）这一下就是几百毫秒的硬卡顿，宿主的定时器/心跳整体推迟。
 * 现在：构建放到后台（`fs.promises` + 有界的 stat 并发 + 按目录让出），
 * 期间 `mtimeOf()` 一律返回 undefined ⇒ 调用方"照读"（旧行为，只慢不漏）；
 * 需要"第一轮就用上索引"的调用方 `await index.ready()`。
 * 索引过期时同样后台重建：**这一轮继续用上一份**（旧 = 只会多读，不会漏）。
 */

import { readdir, stat } from 'node:fs/promises'
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
export function createSessionActivityIndex({
  home, root, now = Date.now, refreshMs = 15_000, logger, statConcurrency = 8,
} = {}) {
  let index = new Map()
  let builtAt = 0
  /** 上次**尝试**构建的时间：构建失败时不能让每次查询都重来一遍（会变成不停走目录树）。 */
  let attemptedAt = 0
  /** 在飞的那次构建（同一时刻只允许一份：两轮扫描撞上时不重复走目录树）。 */
  let building
  const counters = {
    builds: 0, directories: 0, sessions: 0, skipped: 0, failures: 0, firstFailure: '',
  }

  const fail = (error) => {
    counters.failures += 1
    counters.firstFailure ||= `${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}`
  }

  /** 每次构建留一条汇总：走到哪些目录、跳过多少、失败几次、首个原因是什么。 */
  const report = (scope) => {
    if (counters.failures === 0) {
      logger?.debug?.(
        `dsh-assistant: 会话活动索引 ${scope}：${index.size} 个会话 / ${counters.directories} 个目录`,
      )
      return
    }
    logger?.warn?.(
      `dsh-assistant: 会话活动索引 ${scope}：跳过 ${counters.skipped} 项、失败 ${counters.failures} 次`
      + `（首个原因 ${counters.firstFailure}）—— 这部分会话会退化成"照读"`,
    )
  }

  /** 有界的并发 map（stat 一次开几百个会把文件描述符和事件循环一起打满）。 */
  const eachLimit = async (items, limit, worker) => {
    let next = 0
    const width = Math.max(1, Math.min(limit, items.length))
    await Promise.all(Array.from({ length: width }, async () => {
      for (;;) {
        const at = next
        next += 1
        if (at >= items.length) return
        await worker(items[at])
      }
    }))
  }

  const directoryOf = async (dir, isRoot) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      // 根目录不存在是**预期**的（换了 DSH_HOME / 还没建过会话）：没有信号，不是错误
      if (isRoot && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')) {
        logger?.debug?.(`dsh-assistant: 会话活动索引：${dir} 不存在，本次没有信号（照读）`)
        return []
      }
      fail(error)
      return []
    }
    counters.directories += 1
    return entries
  }

  const scan = async (base) => {
    const map = new Map()
    const workspaces = await directoryOf(base, true)
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const workspaceDir = join(base, workspace.name)
      const sessions = await directoryOf(workspaceDir, false)
      const dirs = sessions.filter((session) => session.isDirectory())
      // 每个会话目录三件事：列文件 → stat 每个 zstd → 取最大 mtime
      await eachLimit(dirs, statConcurrency, async (session) => {
        const dir = join(workspaceDir, session.name)
        const files = await directoryOf(dir, false)
        const zstds = files.filter((file) => file.name.endsWith('.zstd'))
        if (zstds.length === 0) {
          counters.skipped += 1
          return
        }
        let newest = 0
        await eachLimit(zstds, statConcurrency, async (file) => {
          try {
            const info = await stat(join(dir, file.name))
            if (info.mtimeMs > newest) newest = info.mtimeMs
          } catch (error) {
            // 单个文件读不到就跳过（可能正在写/正被轮转），但要记账
            fail(error)
          }
        })
        if (newest > 0) map.set(session.name, newest)
        counters.sessions += 1
      })
      // 目录之间让出一轮：构建是后台的，但也不能把事件循环整个占住
      await new Promise((resolve) => setImmediate(resolve))
    }
    return map
  }

  const start = () => {
    if (building) return building
    const base = root ?? defaultRoot(home)
    attemptedAt = now()
    counters.builds += 1
    counters.directories = 0
    counters.sessions = 0
    counters.skipped = 0
    counters.failures = 0
    counters.firstFailure = ''
    building = (async () => {
      const map = base ? await scan(base) : new Map()
      index = map
      builtAt = now()
      report(base ? '已重建' : '没有会话根目录')
      return map
    })()
      // 构建再失败也不该冒泡成 unhandled rejection：没有信号 = 照读
      .catch((error) => {
        fail(error)
        logger?.warn?.(`dsh-assistant: 会话活动索引构建失败（本次没有信号，照读）: ${error?.message ?? error}`)
        return index
      })
      .finally(() => { building = undefined })
    return building
  }

  return {
    /** 会话日志的最后写入时间；不知道就返回 undefined（调用方必须照读）。 */
    mtimeOf(id) {
      // 过期就**后台**重建：本次仍用上一份。旧索引只会让预筛少跳几个（多读），不会漏。
      // 用 max(建成时间, 尝试时间)：构建失败时也是每个刷新窗口只重试一次。
      if (now() - Math.max(builtAt, attemptedAt) > refreshMs) void start()
      for (const key of keysOf(String(id))) {
        const hit = index.get(key)
        if (hit !== undefined) return hit
      }
      return undefined
    },
    /**
     * 等到"至少有过一次构建结果"。首轮扫描要真用上预筛就得先 await 它
     *（不 await 也**不会错**：那 N 次查询一律 undefined ⇒ 照读，只是慢）。
     */
    ready() {
      if (builtAt > 0) return undefined
      return start()
    },
    /** 诊断用：索引里有几个会话、什么时候建的、这次构建跳过/失败了多少。 */
    get stats() {
      return {
        entries: index.size,
        builtAt,
        builds: counters.builds,
        directories: counters.directories,
        sessions: counters.sessions,
        skipped: counters.skipped,
        failures: counters.failures,
        firstFailure: counters.firstFailure,
        building: building !== undefined,
      }
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
