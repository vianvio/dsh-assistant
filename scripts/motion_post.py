#!/usr/bin/env python3
"""序列帧后处理：动作幅度增强 / 插值加密 / 还原，都在这一段脚本里。

为什么合并（原来 amplify_motion.py 与 densify_motion.py 两份）：
两者的骨架完全一样 —— 定位 clip → 首次备份原始帧 → 从备份重算 → 写回帧 →
原子回写 sidecar；差别只在"怎么算新帧"。抄成两份的代价是同一类 bug 要修两遍
（例如两边都漏了"帧数变少时删掉多余旧帧"）。

用法：
    python3 scripts/motion_post.py --amplify 2.8 --dry-run   # 先看会改什么
    python3 scripts/motion_post.py --amplify 2.8             # 动作幅度 ×2.8
    python3 scripts/motion_post.py --densify 3               # 12 帧 → 36 帧（帧间隔 ÷3）
    python3 scripts/motion_post.py --restore                 # 还原到备份（两种处理都还原）
    python3 scripts/motion_post.py --amplify 2.8 --only swe  # 只处理名字含 swe 的段

处理完记得 `npm run build:pack` 合并进素材包。
"""

from __future__ import annotations

import argparse

from petgen_lib import (
    amplify,
    densify,
    drop_stale_frames,
    ensure_backup,
    load_frames,
    motion_clips,
    read_sidecar,
    restore_backup,
    save_frames,
    write_sidecar,
)

#: 两种处理的后备目录（各自独立，互不覆盖）
BACKUP_SUFFIX = {"amplify": ".orig", "densify": ".key"}
#: sidecar 里记录处理参数的字段名
MARKER = {"amplify": "amplify", "densify": "interpolated"}


def main() -> int:
    parser = argparse.ArgumentParser(description="序列帧后处理（增强 / 加密 / 还原）")
    parser.add_argument("--amplify", type=float, default=None, help="动作幅度放大倍数（1 = 不变）")
    parser.add_argument("--densify", type=int, default=None, help="插值倍数（3 = 帧数 ×3、帧间隔 ÷3）")
    parser.add_argument("--quality", type=int, default=84)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--restore", action="store_true", help="从备份还原（优先还原增强）")
    parser.add_argument("--only", default="", help="只处理匹配的 clip 名（子串）")
    args = parser.parse_args()

    modes = [name for name, value in (("amplify", args.amplify), ("densify", args.densify)) if value]
    if not args.restore and not modes:
        parser.error("至少要指定 --amplify / --densify / --restore 之一")
    if len(modes) > 1:
        parser.error("--amplify 与 --densify 不能同时用（一次只做一种变换，便于还原）")
    mode = "amplify" if args.restore and args.amplify is None else (modes[0] if modes else "amplify")

    directories = motion_clips()
    if args.only:
        directories = [path for path in directories if args.only in path.name]
    if not directories:
        raise SystemExit("assets/motion 下没有找到 clip.json")

    if args.restore:
        return run_restore(directories, mode, args)
    return run_transform(directories, mode, args)


def run_restore(directories, mode, args) -> int:
    restored = 0
    for directory in directories:
        payload = read_sidecar(directory)
        if payload is None:
            print(f"  ! {directory.name} sidecar 读不出来，跳过")
            continue
        entry = payload.get("entry") or {}
        prefix = entry.get("prefix")
        count = restore_backup(directory, prefix or "", BACKUP_SUFFIX[mode])
        if count == 0:
            continue
        entry["count"] = count
        if mode == "densify" and payload.get("originalFrameMs"):
            entry["frameMs"] = payload.pop("originalFrameMs")
        payload.pop(MARKER[mode], None)
        write_sidecar(directory, payload)
        print(f"  ↩ {directory.name} 还原为 {count} 帧")
        restored += 1
    if restored == 0:
        print("没有可还原的备份（.orig / .key 不存在）——这批帧可能本来就是原始帧")
    return 0


def run_transform(directories, mode, args) -> int:
    factor = args.amplify if mode == "amplify" else args.densify
    print(f"共 {len(directories)} 段序列帧；{('增强倍数 ' + str(factor)) if mode == 'amplify' else ('插值倍数 ' + str(factor))}")
    processed = 0
    before_total = after_total = 0.0

    for directory in directories:
        payload = read_sidecar(directory)
        if payload is None:
            print(f"  ! {directory.name} sidecar 读不出来，跳过")
            continue
        entry = payload.get("entry") or {}
        prefix, count = entry.get("prefix"), int(entry.get("count") or 0)
        if not prefix or count < 2:
            continue

        if args.dry_run:
            if mode == "amplify":
                print(f"  · {directory.name:28s} {count} 帧  当前 amplify={payload.get('amplify')}")
            else:
                print(f"  · {directory.name:28s} {count} 帧 @{entry.get('frameMs')}ms"
                      f" → {count * args.densify} 帧 @{max(16, entry['frameMs'] // args.densify)}ms")
            continue

        if mode == "amplify" and payload.get("amplify"):
            continue  # 已经增强过（--restore 可还原后重做）
        if mode == "densify" and payload.get("interpolated"):
            continue

        # 首次处理前备份原始帧；之后每次都从备份出发，反复跑不会叠加
        source = ensure_backup(directory, prefix, count, BACKUP_SUFFIX[mode])
        frames = load_frames(source, prefix, count)

        if mode == "amplify":
            result, (before, after) = amplify(frames, args.amplify)
            before_total += before
            after_total += after
            payload[MARKER[mode]] = args.amplify
        else:
            result = densify(frames, args.densify)
            payload["originalFrameMs"] = entry["frameMs"]
            payload[MARKER[mode]] = args.densify
            entry["frameMs"] = max(16, entry["frameMs"] // args.densify)

        save_frames(result, directory, prefix, args.quality)
        drop_stale_frames(directory, prefix, len(result))
        entry["count"] = len(result)
        payload["entry"] = entry
        write_sidecar(directory, payload)
        processed += 1

        if mode == "amplify":
            print(f"  ✓ {directory.name:28s} 帧间差 {before:.2f} → {after:.2f}")
        else:
            print(f"  ✓ {directory.name:28s} {count} → {len(result)} 帧，{payload['originalFrameMs']} → {entry['frameMs']}ms/帧")

    if processed and not args.dry_run:
        if mode == "amplify" and before_total > 0:
            print(f"\n平均帧间差 {before_total / processed:.2f} → {after_total / processed:.2f}"
                  f"（约 ×{after_total / max(1e-6, before_total):.1f}）")
        print(f"完成 {processed} 段。接着跑 `npm run build:pack` 合并进素材包。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
