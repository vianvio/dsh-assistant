#!/usr/bin/env bash
# 编译并运行动画内核检查。
#
# 为什么不用 swift test：动画内核在可执行目标里（要 main.swift 启动 AppKit），
# 而 SwiftPM 测试可执行目标需要拆库 + public API。这里直接把「内核源码 + 断言」
# 编成一个命令行程序运行，覆盖同样的行为且零结构改动。
#
# 两段都要，缺一段就有源码不被任何编译面覆盖：
#   ① 全量 typecheck —— native/Sources 一个文件都不许漏，包含 main.swift 入口；
#   ② 逻辑检查 —— 除入口外的全部源码编进命令行程序（AppKit 只链接、不实例化窗口），
#      再跑 native/Tests/main.swift 里的断言。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/animation-checks"

SOURCES=("$ROOT"/native/Sources/*.swift)
if [[ ! -e "${SOURCES[0]}" ]]; then
  echo "[test-swift] 找不到 native/Sources/*.swift —— 前置条件被破坏了" >&2
  exit 1
fi

# 逻辑检查用的清单 = 全部源码去掉入口（两个顶层 main 不能同时进一个可执行文件）
LIB=()
for file in "${SOURCES[@]}"; do
  [[ "$(basename "$file")" == "main.swift" ]] && continue
  LIB+=("$file")
done

# ① 全量类型检查：源码写坏了这里必须红。
#    （以前编译清单是手写的 6 个文件，PetController / PetView / PetWindow / FrameStore /
#      PetHeadless / PetProtocol / PetSummaryWindow 合计 68.8% 的源码改坏了也全绿。）
echo "[test-swift] ① 全量 typecheck：${#SOURCES[@]} 个文件"
swiftc -swift-version 5 -typecheck "${SOURCES[@]}"

# ② 逻辑检查：编出来 + 跑断言
echo "[test-swift] ② 编译并运行内核断言：${#LIB[@]} 个文件 + native/Tests/main.swift"
swiftc -swift-version 5 -O "${LIB[@]}" "$ROOT/native/Tests/main.swift" -o "$OUT"

# 配置归一化的跨语言契约：宿主与原生端读同一份 fixture 的同一组用例
export DSH_ASSISTANT_CONFIG_FIXTURE="$ROOT/test/fixtures/config-normalization.json"

"$OUT"
