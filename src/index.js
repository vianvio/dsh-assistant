/**
 * dsh-assistant 宿主插件入口 —— 只做**装配**。
 *
 * 一个原则：宠物崩了、helper 缺了、宿主 API 变了，都只让宠物缺席，
 * 绝不让 DSH 启动失败（所有失败路径都收敛成日志 + 空操作）。
 *
 * 装配顺序很重要：先建配置作用域（唯一一份），再挂宠物，最后把同一个作用域
 * 交给本地端点 —— 两端共用一个 scope 才不会出现"设置面板写进去、宠物读不到"。
 */

import { mountPet } from './pet.js'
import { createSettingsScope } from './pet-settings.js'
import { CONFIG_ENDPOINT, createConfigHandler } from './pet-endpoint.js'

export const name = 'dsh-assistant'

/**
 * 订阅全局会话事件（sessions）；设置服务由 ctx.get 按需取。
 *
 * 'settings' 必须声明：Cordis 服务按上下文作用域可见，不声明注入就
 * `ctx.get('settings')` 取不到。声明后 Cordis 会等服务就绪并把 ctx.settings
 * 提供进我们的上下文。
 */
export const inject = ['sessions', 'settings']

/**
 * 入口只暴露插件协议要求的三个东西（name / inject / apply）。
 *
 * 想要内部件（状态机、进程守护、日报…）请**直接 import 子模块** ——
 * 之前这里有一串转发导出，实际没有任何调用方（连测试都是直接引子模块的），
 * 留着只会让人以为它们是稳定 API。
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  let pet

  try {
    // 配置的唯一来源：DSH 设置服务（持久化）→ 内存兜底 → 组合配置。见 pet-settings.js
    const settings = createSettingsScope(ctx, config, logger)
    pet = mountPet({
      ctx,
      settings,
      eventCtx: ctx.root ?? ctx,
      logger,
      tuning: { version: await readVersion() },
    })

    try {
      ctx.inject?.(['webServer'], (httpCtx) => {
        const webServer = httpCtx.get('webServer')
        // prefix 路由会同时匹配 /config 与其子路径 /config/action，一个 handler 全包
        const dispose = webServer.register({
          kind: 'prefix',
          path: CONFIG_ENDPOINT,
          handler: createConfigHandler(settings, () => pet),
        })
        httpCtx.effect(() => dispose, 'dsh-assistant: 本地设置与互动端点')
      })
    } catch (error) {
      logger.warn?.(`dsh-assistant: 设置端点注册失败: ${reason(error)}`)
    }

    ctx.effect?.(() => () => {
      try { pet?.stop?.() } catch { /* 收尾失败不再抛 */ }
    }, 'dsh-assistant: 生命周期')
  } catch (error) {
    logger.error?.(`dsh-assistant: 启动失败，本次会话保持停用: ${reason(error)}`)
  }
}

function reason(error) {
  return error instanceof Error ? error.message : String(error)
}

async function readVersion() {
  try {
    const pkg = await import('../package.json', { with: { type: 'json' } })
    return pkg.default?.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
