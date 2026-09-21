/**
 * dsh-assistant 伴侣协议（v1）。
 *
 * 传输：宿主 ↔ helper 进程的 stdin/stdout，一行一条 JSON。
 * 设计原则：
 *   · 宿主只发语义，helper 只做展示 —— 状态文案、台词、养成数值都在宿主侧，
 *     原生端拿不到 DSH，也不该拿；
 *   · 所有消息幂等，重复收到只做一次效果（helper 会记住 lastSeq）；
 *   · 扩展只加新 kind，不改既有字段含义，旧 helper 遇到未知 kind 直接忽略。
 */

const PROTOCOL_VERSION = 1

/** helper 会长期显示的耐久状态（与 DSH 会话语义一一对应）。 */
export const PetState = Object.freeze({
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED',
})

export const PetMessageKind = Object.freeze({
  /** helper → 宿主：窗口已就绪，可以开始收状态 */
  READY: 'ready',
  /** 宿主 → helper：握手信息（版本、称呼、自称） */
  HELLO: 'hello',
  /** 宿主 → helper：耐久状态 */
  STATE: 'state',
  /** 宿主 → helper：一次性情绪脉冲（完成/报错），ttl 到期回到 resumeState */
  PULSE: 'pulse',
  /** 宿主 → helper：临时浮层（某个动作 + 一句话），不改耐久状态 */
  OVERLAY: 'overlay',
  /** 宿主 → helper：**完成通知**（独立于状态气泡，钉在宠物上方直到被查看） */
  NOTICE: 'notice',
  /** 宿主 → helper：清除通知（用户已查看该项目 / 会话销毁） */
  NOTICE_CLEAR: 'notice-clear',
  /** 宿主 → helper：「今天干了什么」总结正文（markdown），本地留存 */
  SUMMARY: 'summary',
  /** 宿主 → helper：配置（大小/气泡/动效/提示音），也可随时下发 */
  CONFIG: 'config',
  /** 宿主 → helper：让宠物做个动作（摸头/投喂/夸奖…） */
  COMMAND: 'command',
  /** 宿主 → helper：心跳 */
  PING: 'ping',
  /** helper → 宿主：心跳应答 */
  PONG: 'pong',
  /** helper → 宿主：用户在宠物身上的互动（点击分区、右键菜单） */
  INTERACTION: 'interaction',
  /** helper → 宿主：用户在原生菜单里改了设置，请写回 */
  SETTINGS: 'settings',
  /** helper → 宿主：helper 自己看不懂某条消息（native 侧解码失败/未知 kind） */
  ERROR: 'error',
  /** helper → 宿主：窗口被用户关闭，不要再拉起 */
  CLOSED: 'closed',
  /** 宿主 → helper：请退出 */
  SHUTDOWN: 'shutdown',
})

const kinds = new Set(Object.values(PetMessageKind))
const states = new Set(Object.values(PetState))

/** 构造一条协议消息（自动带版本号与时间戳）；非法 kind/state 构造时就抛错。 */
export function createMessage(kind, payload = {}) {
  if (!kinds.has(kind)) throw new TypeError(`unknown pet message kind: ${kind}`)
  const message = { v: PROTOCOL_VERSION, kind, ts: Date.now(), ...payload }
  const result = validate(message)
  if (result instanceof Error) throw result
  return message
}

/** 校验消息结构；返回 Error 表示不合法（无异常抛出，便于 decode 里直接判类型）。 */
function validate(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return new TypeError('pet message must be an object')
  }
  if (value.v !== PROTOCOL_VERSION) return new TypeError(`unsupported protocol version: ${String(value.v)}`)
  if (!kinds.has(value.kind)) return new TypeError(`unknown pet message kind: ${String(value.kind)}`)
  if ((value.kind === PetMessageKind.STATE || value.kind === PetMessageKind.PULSE) && !states.has(value.state)) {
    return new TypeError(`unknown pet state: ${String(value.state)}`)
  }
  // 通知必须带 id：点击/查看后的精确清除全靠它，没有 id 就清不掉，会永远挂着
  if (value.kind === PetMessageKind.NOTICE && (typeof value.id !== 'string' || value.id.length === 0)) {
    return new TypeError('notice 需要非空 id（用于查看后精确清除）')
  }
  return undefined
}

/** 校验外来消息；不合法时抛错（宿主侧用来挡住 helper 的脏输出）。 */
function assertPetMessage(value) {
  const problem = validate(value)
  if (problem) throw problem
  return value
}

/** 编码为一行 JSON（含结尾换行）。 */
export function encodeMessage(message) {
  assertPetMessage(message)
  return `${JSON.stringify(message)}\n`
}

/** 解析 helper 的一行输出；解析或校验失败返回 undefined。 */
export function decodeMessage(line) {
  const text = String(line ?? '').trim()
  if (text === '') return undefined
  try {
    const parsed = JSON.parse(text)
    const problem = validate(parsed)
    return problem ? undefined : parsed
  } catch {
    return undefined
  }
}

/**
 * helper 未就绪时**可被覆盖**的消息：保留每个 kind 的最后一份即可，不必回放历史。
 *
 * 其余 kind（notice / notice-clear / summary …）必须保序补发，否则会出现
 * 「先清通知、后到通知」这类顺序颠倒。pet-process 的排队策略就按这份清单分叉。
 */
export const COALESCED_KINDS = Object.freeze([
  PetMessageKind.HELLO,
  PetMessageKind.CONFIG,
  PetMessageKind.STATE,
  PetMessageKind.OVERLAY,
])
