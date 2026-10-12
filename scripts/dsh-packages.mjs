#!/usr/bin/env node
/**
 * dsh-packages —— 把桌面端（Electron）里的 DSH 包解出来，供集成测试使用。
 *
 * 为什么需要它：桌面端把整个 DSH 运行时打包在 `app.asar` 里，`$DSH_HOME/profiles/node_modules`
 * 下**没有** `@deepseek-ai/*`（那是源码工作区时代的布局）。而 `test/dsh-integration.test.mjs`
 * 要拿真的 `schemastery` / `dsh-settings` 的投影函数跑一遍（假实现测不出设置页认不认我们的
 * schema），所以这里把运行时装的那一份解到 `$DSH_HOME/cache/dsh-packages/<dsh 版本>/`。
 *
 * 用法：
 *   npm run dsh:packages                        # 解出并打印 node_modules 路径
 *   DSH_ASSISTANT_DSH_PACKAGES=$(npm run -s dsh:packages) npm test
 *   node scripts/dsh-packages.mjs --force       # 重新解一份
 *
 * 环境变量：`DSH_DESKTOP_APP` 指定别的安装位置；`DSH_HOME` 决定解到哪儿。
 *
 * 只解 JS/JSON：asar 里标了 unpacked 的原生二进制（LibreOffice 引擎等）跳过，
 * 集成测试用不到它们，写进去只是几百 MB 的垃圾。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SKIP_PACKAGES = [/^libreoffice-kit-/]

const appRoot = process.env.DSH_DESKTOP_APP || '/Applications/DeepSeek Harness.app'
const asarPath = join(appRoot, 'Contents', 'Resources', 'app.asar')
const force = process.argv.includes('--force')

if (!existsSync(asarPath)) {
  process.stderr.write(
    `dsh-packages: 找不到 ${asarPath}\n`
    + '  · 桌面端装在别处时用 DSH_DESKTOP_APP=<DeepSeek Harness.app 路径> 指定\n',
  )
  process.exit(1)
}

/** 读 asar 头：Electron 的归档格式就是「游标 + JSON 头 + 顺序拼接的文件体」。 */
function readArchive(path) {
  const fd = openSync(path, 'r')
  const sizeBuf = Buffer.alloc(8)
  readSync(fd, sizeBuf, 0, 8, 0)
  const headerSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 8)
  const jsonLength = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLength).toString('utf8'))
  const baseOffset = 8 + headerSize
  const files = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const file = prefix === '' ? name : `${prefix}/${name}`
      if (value.files) walk(value, file)
      else files.push({ path: file, size: value.size, offset: Number(value.offset), unpacked: value.unpacked === true })
    }
  }
  walk(header, '')
  return {
    files,
    read(file) {
      if (file.size === 0) return Buffer.alloc(0)
      const buffer = Buffer.alloc(file.size)
      readSync(fd, buffer, 0, file.size, baseOffset + file.offset)
      return buffer
    },
    close() {
      closeSync(fd)
    },
  }
}

const archive = readArchive(asarPath)
const runtimeManifest = JSON.parse(archive.read(archive.files.find((file) => file.path === 'dsh/package.json')).toString('utf8'))
const version = runtimeManifest.version ?? 'unknown'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const outDir = join(home, 'cache', 'dsh-packages', version)
const nodeModules = join(outDir, 'node_modules')
const marker = join(outDir, '.complete')

if (existsSync(marker) && !force) {
  process.stderr.write(`dsh-packages: 已经解过了（${version}，--force 可重解）\n`)
  process.stdout.write(`${nodeModules}\n`)
  process.exit(0)
}

const PREFIX = 'dsh/node_modules/'
const unpackedRoot = `${asarPath}.unpacked`
let written = 0
let skippedUnpacked = 0
let bytes = 0

for (const file of archive.files) {
  if (!file.path.startsWith(PREFIX)) continue
  const rest = file.path.slice(PREFIX.length)
  // 只处理包根下的文件（含嵌套 node_modules），忽略归档里其它杂项
  if (SKIP_PACKAGES.some((pattern) => rest.split('/').some((part) => pattern.test(part)))) continue
  const target = join(nodeModules, rest)
  if (file.unpacked) {
    const physical = join(unpackedRoot, file.path)
    if (!existsSync(physical)) {
      skippedUnpacked += 1
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(physical))
  } else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, archive.read(file))
  }
  written += 1
  bytes += file.size
}

mkdirSync(outDir, { recursive: true })
writeFileSync(marker, `${JSON.stringify({ version, app: resolve(appRoot), files: written, at: new Date().toISOString() }, null, 2)}\n`)
archive.close()
process.stderr.write(
  `dsh-packages: DSH ${version} → ${nodeModules}`
  + `（${written} 个文件，${(bytes / 1048576).toFixed(1)} MB`
  + `${skippedUnpacked > 0 ? `，跳过 ${skippedUnpacked} 个原生二进制` : ''}）\n`,
)
process.stdout.write(`${nodeModules}\n`)
