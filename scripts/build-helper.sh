#!/usr/bin/env bash
# 构建 dsh-assistant 的原生 helper（macOS，arm64 + x86_64 通用二进制）。
#
# 为什么不用 swift build 出成品：分发给用户的应该是一个 .app（LSUIElement、
# 不占 Dock、可被 codesign 校验），这里直接用 swiftc + lipo 组装，和 dafeiyu
# 的做法一致；swift test 另走 Package.swift。
#
# 用法：
#   bash scripts/build-helper.sh                # 编译（默认把当前 assets/pack 打进 .app）
#   SKIP_PACK=1 bash scripts/build-helper.sh    # 不打包素材，只重编译
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
SRC="$ROOT/native/Sources"
PACK="${DSH_ASSISTANT_PACK:-$ROOT/assets/pack}"
APP="$ROOT/runtime/bin/darwin/dsh-assistant-helper.app"
BIN="$APP/Contents/MacOS/dsh-assistant-helper"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.1.0)"

if [[ "${SKIP_PACK:-0}" != "1" && ! -f "$PACK/pet-manifest.json" ]]; then
  echo "[build-helper] 素材包缺失，正在生成：$PACK"
  # 与 package.json 的 build:pack 保持同一组参数：240px 高、quality 86
  # （不传就会用脚本默认的 280px，重新生成出来的包和随包分发的不一致）
  python3 "$ROOT/scripts/build_pack.py" --out "$PACK" --char-h 240 --quality 86
fi

command -v swiftc >/dev/null 2>&1 || {
  echo "[build-helper] 需要 Xcode 命令行工具（swiftc）。安装：xcode-select --install" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$APP"
mkdir -p "$(dirname "$BIN")" "$APP/Contents/Resources"
cp "$ROOT/native/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"

# 把素材打进 .app：这样 helper 也能脱离插件目录独立运行（DSH_ASSISTANT_ASSET_ROOT 优先）
if [[ -f "$PACK/pet-manifest.json" ]]; then
  cp "$PACK/pet-manifest.json" "$APP/Contents/Resources/pet-manifest.json"
  for dir in "$PACK"/*/; do
    name="$(basename "$dir")"
    mkdir -p "$APP/Contents/Resources/$name"
    cp -R "$dir." "$APP/Contents/Resources/$name/"
  done
fi

# 用 glob 而不是手写清单：新增一个 .swift 文件忘了加进清单，
# 症状是"凭空少了一堆符号"的编译错误（main.swift 必须最后，它带顶层语句）。
SOURCES=()
for file in "$SRC"/*.swift; do
  [[ "$(basename "$file")" == "main.swift" ]] && continue
  SOURCES+=("$file")
done
SOURCES+=("$SRC/main.swift")
FRAMEWORKS=(-framework AppKit -framework QuartzCore)

echo "[build-helper] arm64 切片（macOS 12+）..."
swiftc -O -swift-version 5 -target arm64-apple-macosx12.0 "${SOURCES[@]}" "${FRAMEWORKS[@]}" -o "$WORK/helper-arm64"
echo "[build-helper] x86_64 切片（macOS 12+）..."
swiftc -O -swift-version 5 -target x86_64-apple-macosx12.0 "${SOURCES[@]}" "${FRAMEWORKS[@]}" -o "$WORK/helper-x86_64"

lipo -create "$WORK/helper-arm64" "$WORK/helper-x86_64" -output "$BIN"
chmod 0755 "$BIN"
lipo "$BIN" -verify_arch arm64 x86_64
plutil -lint "$APP/Contents/Info.plist" >/dev/null
# 签名失败必须让构建失败：ad-hoc 签名平时不会失败，静默通过的后果是
# 交付一个 Gatekeeper 打不开的 .app，而构建日志写着"完成"。
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"

echo "[build-helper] 完成：$APP"
