/**
 * pet-endpoint —— 本地回环 HTTP 端点：设置面板与客户端插件能碰到的宿主口。
 *
 *   GET   <endpoint>          读配置（含 helper 是否在跑、当前主角、并行名单）
 *   PATCH <endpoint>          改配置（只允许 WRITABLE_FIELDS）
 *   POST  <endpoint>/action   触发一次互动（原生动作）或跑一次「今日干了什么」
 *   POST  <endpoint>/viewed   客户端上报"用户正在看哪个会话" → 消掉它的完成通知
 *   GET   <endpoint>/pending  客户端长轮询取宿主命令（如"打开这个会话"）
 *
 * 路由注册成 prefix，所以上面这些路径都进这一个 handler。
 * 门禁：只认本机回环 + 同源（设置面板与客户端插件都是同源页面）。
 */

import { WRITABLE_FIELDS } from './pet-settings.js'

/** 设置面板读写的本机端点（client.js 里是同一份字面量）。 */
export const CONFIG_ENDPOINT = '/plugins/dsh-assistant/config'

/** 「用户看了某个会话」的上报路径。 */
export const VIEWED_ENDPOINT = `${CONFIG_ENDPOINT}/viewed`

/** 客户端长轮询取命令的路径。 */
export const PENDING_ENDPOINT = `${CONFIG_ENDPOINT}/pending`

/** 长轮询最多挂多久（客户端会立刻再发起下一次）。 */
const PENDING_WAIT_MS = 20_000

/** 取 query 里的整数并夹到 [0, max]；缺省或非法就用 fallback。 */
function intParam(url, name, fallback, { max = PENDING_WAIT_MS } = {}) {
  try {
    const value = new URL(String(url ?? '/'), 'http://127.0.0.1').searchParams.get(name)
    if (value === null) return fallback
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(0, Math.trunc(number)))
  } catch {
    return fallback
  }
}

/** 允许的设置面板动作（原生端负责播放）。 */
const INTERACTION_ACTIONS = Object.freeze(['pat', 'poke', 'feed', 'praise', 'home', 'hide'])

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req, limit = 8192) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('body must be a JSON object')
  }
  return value
}

/** 本机回环 + 同源校验，两个端点共用。 */
function guardLocalRequest(req, res) {
  if (!isLoopback(req.socket?.remoteAddress)) {
    jsonResponse(res, 403, { error: 'local access only' })
    return false
  }
  const origin = req.headers?.origin
  if (origin) {
    let originHost
    try { originHost = new URL(origin).host } catch { originHost = undefined }
    if (!originHost || originHost !== req.headers.host) {
      jsonResponse(res, 403, { error: 'origin mismatch' })
      return false
    }
  }
  return true
}

/** 只取路径部分，丢掉 query / fragment。 */
function pathnameOf(req) {
  const raw = typeof req.url === 'string' && req.url !== '' ? req.url : CONFIG_ENDPOINT
  const cut = raw.search(/[?#]/u)
  return cut >= 0 ? raw.slice(0, cut) : raw
}

/**
 * @param settings 配置作用域（createSettingsScope 的返回值）
 * @param petHandle () => 宠物句柄（可能是 undefined：helper 没起来）
 */
export function createConfigHandler(settings, petHandle) {
  return async (req, res) => {
    if (!guardLocalRequest(req, res)) return
    const path = pathnameOf(req)

    if (req.method === 'POST' && path === `${CONFIG_ENDPOINT}/action`) {
      await handleAction(req, res, petHandle)
      return
    }

    if (req.method === 'POST' && path === VIEWED_ENDPOINT) {
      await handleViewed(req, res, petHandle)
      return
    }

    if (req.method === 'GET' && path === PENDING_ENDPOINT) {
      await handlePending(req, res, petHandle)
      return
    }

    if (req.method === 'GET') {
      const handle = petHandle?.()
      jsonResponse(res, 200, {
        ...settings.get(),
        helperRunning: handle?.isRunning === true,
        focus: handle?.focus?.(),
        roster: handle?.roster?.() ?? [],
      })
      return
    }

    if (req.method === 'PATCH') {
      try {
        const patch = await readJsonBody(req)
        const unknown = Object.keys(patch).filter((key) => !WRITABLE_FIELDS.includes(key))
        if (unknown.length > 0) throw new Error(`unknown settings: ${unknown.join(', ')}`)
        // 写入走的就是宿主自己那份 scope：settings.watch 会让宠物热更新，
        // 不需要端点额外推一次配置（内存兜底也实现了 watch）。
        await settings.update(patch)
        jsonResponse(res, 200, settings.get())
      } catch (error) {
        jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    jsonResponse(res, 405, { error: 'method not allowed' })
  }
}

async function handleAction(req, res, petHandle) {
  try {
    const body = await readJsonBody(req)
    const action = String(body.action ?? '')
    const handle = petHandle?.()

    // 「今天干了什么」不是原生动作，而是宿主后台任务：开隐藏会话 → 出 markdown
    if (action === 'summary') {
      const started = handle?.summarize?.() === true
      jsonResponse(res, started ? 202 : 409, { action, started })
      return
    }
    if (!INTERACTION_ACTIONS.includes(action)) {
      jsonResponse(res, 400, { error: `unknown action: ${action}` })
      return
    }
    const delivered = handle?.act?.(action) === true
    jsonResponse(res, delivered ? 200 : 409, { action, delivered })
  } catch (error) {
    jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 客户端长轮询取命令。
 *
 * 长轮询而不是定时轮询：空闲时每 20 秒才一个请求（客户端拿到空数组后立刻再挂上），
 * 而点通知到界面切换之间几乎无延迟 —— 做不到推送，这是最省又不牺牲手感的一档。
 * 拿不到宠物句柄（helper 没起来）就立刻回空，不让客户端白等。
 */
async function handlePending(req, res, petHandle) {
  try {
    const handle = petHandle?.()
    // helper 没在跑 → 没人会去点通知，别让客户端白挂 20 秒
    const running = handle?.isRunning === true && typeof handle.nextCommand === 'function'
    // ?wait= 可以覆盖等待时长（自检/调试用；默认长轮询）
    const wait = intParam(req.url, 'wait', PENDING_WAIT_MS)
    const command = running ? await handle.nextCommand(wait) : undefined
    jsonResponse(res, 200, { commands: command ? [command] : [] })
  } catch (error) {
    jsonResponse(res, 200, { commands: [], error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 客户端上报"用户正在看这个会话" → 清掉它挂着的完成通知。
 *
 * 为什么需要这条：宿主侧只有 `session/created` 能用，而它**每个会话只发一次**
 * （DSH 的 `announce()` 带 announced 标记），刚跑完任务的会话本来就在内存里，
 * 用户点进去不会再有任何事件 —— 通知于是永远挂着。
 * 真正知道"用户在看哪个会话"的只有客户端（会话列表的 current），所以由它上报。
 */
async function handleViewed(req, res, petHandle) {
  try {
    const body = await readJsonBody(req)
    const sessionId = String(body.sessionId ?? '')
    if (!sessionId) throw new Error('viewed 需要 sessionId')
    const cleared = petHandle?.()?.viewed?.(sessionId) ?? 0
    jsonResponse(res, 200, { sessionId, cleared })
  } catch (error) {
    jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}
