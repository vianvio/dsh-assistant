#!/usr/bin/env bash
# 编译并运行动画内核检查。
#
# 为什么不用 swift test：动画内核在可执行目标里（要 main.swift 启动 AppKit），
# 而 SwiftPM 测试可执行目标需要拆库 + public API。这里直接把「内核源码 + 断言」
# 编成一个命令行程序运行，覆盖同样的行为且零结构改动。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/animation-checks"

# 只编"纯逻辑"那几件：动画内核 / 素材清单 / 布局 / 几何算式。
# 它们不依赖窗口，所以能脱离 AppKit 跑；PetController 那些要真窗口的只能靠 probe 肉眼验。
swiftc -swift-version 5 -O \
  "$ROOT/native/Sources/PetManifest.swift" \
  "$ROOT/native/Sources/PetAnimation.swift" \
  "$ROOT/native/Sources/PetState.swift" \
  "$ROOT/native/Sources/PetMetrics.swift" \
  "$ROOT/native/Sources/PetLayout.swift" \
  "$ROOT/native/Tests/main.swift" \
  -o "$OUT"

"$OUT"
