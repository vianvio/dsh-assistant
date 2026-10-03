/**
 * 覆盖门禁：**需要外部依赖的用例不许静默跳过**。
 *
 * 背景：`node --test` 把 `{ skip }` 当成功，于是「本机没装 X」会变成一片安静 ——
 * 124 个用例里少跑 7 个也照样 exit 0，谁都不知道原生端与宿主之间唯一的进程级契约
 * 已经零覆盖了。这里把规矩改成：
 *
 *   · 依赖在位 → 正常跑；
 *   · 依赖不在，但**显式 opt-out**（环境变量 = 1）→ 跳过，并在用例名里写明原因；
 *   · 依赖不在，也没 opt-out → **失败**，错误信息里给出「装什么」或「怎么显式接受」。
 *
 * 于是同一份仓库在任何机器上给同一个结论，覆盖率下降必然被看见。
 */

import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {string} label 这段覆盖叫什么（出现在失败信息里）
 * @param {boolean} available 依赖是否在位
 * @param {string} optOutEnv 显式接受覆盖下降的环境变量名
 * @param {string} detail 缺什么、怎么装
 * @returns {{ skip: false|string, check: () => void }}
 */
export function coverageGate(label, available, optOutEnv, detail) {
  if (available) return { skip: false, check() {} }
  if (process.env[optOutEnv] === '1') {
    return { skip: `${label}：依赖不在位且已显式 opt-out（${optOutEnv}=1）`, check() {} }
  }
  return {
    skip: false,
    check() {
      assert.fail(
        `[覆盖缺失] ${label} 本次跑不了：${detail}\n`
        + `  · 装上依赖后重跑；或\n`
        + `  · 显式接受这次覆盖下降：${optOutEnv}=1 npm test`,
      )
    },
  }
}

/**
 * DSH 自己的包（cordis / dsh-settings …）装在哪。
 *
 * 只认环境：`$DSH_HOME`（缺省 `~/.dsh`）下的 `profiles/node_modules` 与 `node_modules`。
 * 以前这里写死过 `~/Documents/projects/slf/agent-mesh/desktop/.local/dsh-home`
 * —— 那是开发机的目录结构，不该出现在仓库里。
 *
 * 用 realpath 判存在：pnpm 装出来的是符号链接，链接断了 `existsSync` 会跟着目标一起 false，
 * 但 `ls` 看名字还在 —— 那种"看着装了其实用不了"的状态必须当成没装。
 */
export function dshPackagesDir() {
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    for (const candidate of [join(home, 'profiles', 'node_modules'), join(home, 'node_modules')]) {
      if (realpathExists(join(candidate, '@deepseek-ai', 'cordis'))
        && realpathExists(join(candidate, '@deepseek-ai', 'dsh-settings'))) {
        return candidate
      }
    }
  }
  return undefined
}

function realpathExists(target) {
  try {
    return Boolean(realpathSync(target))
  } catch {
    return false
  }
}
