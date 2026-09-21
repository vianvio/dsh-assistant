#!/usr/bin/env python3
"""从 dsh-whale-musume 的姿态图生成 dsh-assistant 的素材包（manifest v4）。

上游只有静态姿态图，那就**保持静态**：不烘帧、不做假动画。打包只做三件必要的事：

  1. **统一高度**：所有图按同一高度等比缩放 —— 切状态时角色大小不会跳；
  2. **宽度自适应**：宽度按原图比例算，不做任何拉伸；每张图的宽高都写进
     manifest，原生端据此建窗 —— 窗口紧贴角色，切换时宽度自然变化；
  3. **记录头顶**：把内容顶边写进 clips[].top，原生端据此把气泡贴在这张图的
     头顶上方，而不是贴在窗口顶端。

`assets/motion/**`（百炼生成的微动作序列帧）会被合并进来：同名姿态的动画**替换**
静态图，于是"该状态下就是序列帧动画"。合并逻辑在本文件，序列帧的生产在别的脚本。

产物：
    assets/pack/pet-manifest.json
    assets/pack/<group>/<clip>.webp

用法：
    python3 scripts/build_pack.py --out assets/pack           # 用默认参数（240px / q86）
    python3 scripts/build_pack.py --dry-run                   # 只报计划，不动 assets/pack
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

from PIL import Image

from petgen_lib import (
    BUBBLE_BAND,
    KNOWN_STATES,
    PACK_CHAR_H,
    PACK_QUALITY,
    SOURCE_CHAR_H,
    ROOT,
    content_top,
    load_frames,
    motion_clips,
    normalise_pose,
    read_sidecar,
    resolve_source,
    save_webp,
)

# 状态 → 多个静图（同状态多张，原生端随机挑一张）
STATE_ASSETS: dict[str, list[str]] = {
    "IDLE": ["idle-cute", "daily-coffee", "daily-stretch", "meme-smug", "cool-shades", "tail-swing",
             "curious", "greet", "wink", "bold", "meme-worship", "daily-melt"],
    "THINKING": ["thinking", "work-idea", "game-think", "abstract", "daily-painting",
                 "meme-doubt", "meme-ojisan", "meme-music"],
    # 注意：不含 "tool" —— 这张图的生成结果不对，已按用户要求剔除
    "WORKING": ["running", "work-debug", "work-deploy", "work-review", "work-ram", "work-meeting",
                "work-slack", "work-boss", "sweep", "pick-up", "daily-gaming"],
    "WAITING": ["waiting", "work-slack-phone", "blush", "meme-kyun",
                "meme-wakuwaku", "meme-peace", "weather-umbrella", "weather-rain-happy", "meme-omg"],
    "SUCCESS": ["success", "celebrate", "star", "levelup", "work-celebrate", "game-win", "meme-yes", "meme-heart",
                "achievement", "game-happy", "meme-sike", "game-cheat", "festival-christmas", "festival-halloween",
                "festival-spring"],
    "ERROR": ["failure", "meme-cry", "meme-smile-pain", "balance-low", "weather-thunder", "work-deadline",
              "game-lose", "meme-broke", "meme-doge", "meme-shock", "weather-cold"],
    "DISCONNECTED": ["afk", "sleep", "work-sleep", "night",
                     "daily-pajama", "daily-shower", "daily-fishing", "weather-snow", "festival-mid-autumn"],
}

# 互动动作 → 多个静图
ACTION_ASSETS: dict[str, list[str]] = {
    "pat": ["work-pat", "react-head", "meme-kyun", "meme-worship", "greet"],
    "poke": ["teasing", "angry", "react-belly", "meme-no", "meme-sike", "meme-doge"],
    "feed": ["eat", "daily-eat", "daily-cooking", "daily-picnic",
             "festival-mid-autumn", "festival-christmas", "daily-done"],
    "praise": ["blush", "meme-heart", "valentine", "react-tail", "celebrate",
               "achievement", "festival-halloween", "meme-peace", "game-happy"],
}


def prune_unreferenced(pack: Path, clips: dict) -> int:
    """删掉没有被任何 clip 引用的素材文件（通常是"被动画替换掉的静态图"）。"""
    referenced: set[Path] = set()
    for entry in clips.values():
        referenced.add((pack / entry["file"]).resolve())
        if "dir" in entry and "count" in entry:
            for index in range(1, int(entry["count"]) + 1):
                name = f"{entry['prefix']}_{index:03d}.webp"
                referenced.add((pack / entry["dir"] / name).resolve())

    removed = 0
    for path in pack.rglob("*.webp"):
        if path.resolve() not in referenced:
            path.unlink()
            removed += 1
    # 顺手清掉空目录：**按深度倒序**（只按路径字典序排，嵌套的空目录会清不干净）
    directories = sorted((d for d in pack.rglob("*") if d.is_dir()),
                         key=lambda d: len(d.parts), reverse=True)
    for directory in directories:
        if not any(directory.iterdir()):
            directory.rmdir()
    return removed


def merge_motion(pack: Path, clips: dict, states: dict, actions: dict,
                 char_h: int = PACK_CHAR_H, quality: int = PACK_QUALITY) -> int:
    """把 assets/motion 下的序列帧（每段一个 clip.json sidecar）合并进素材包。

    合并规则：
      · 序列帧 clip 名形如 <pose>-motion，且它对应的静态图 <pose> 在同一条列表里
        → **用动画替换静态图**，这样"该状态下就是序列帧动画"；
      · 没有对应静态图的，直接追加。
    """
    known_states = KNOWN_STATES
    merged = 0
    for source_dir in motion_clips():
        payload = read_sidecar(source_dir)
        if payload is None:
            print(f"  ! {source_dir.name}/clip.json 读不出来，跳过这一段")
            continue
        clip = payload.get("clip")
        entry = payload.get("entry") or {}
        owners = payload.get("owners") or [{"kind": "state" if str(payload.get("state", "")).upper() in known_states else "action",
                                            "name": payload.get("state")}]
        if not clip or not entry.get("count"):
            continue

        target_dir = pack / entry["dir"]
        target_dir.mkdir(parents=True, exist_ok=True)
        first: Path | None = None
        target_height = char_h
        scale = target_height / int(entry.get("height") or target_height)
        for index in range(1, int(entry["count"]) + 1):
            name = f"{entry['prefix']}_{index:03d}.webp"
            source = source_dir / name
            if not source.exists():
                continue
            target = target_dir / name
            if abs(scale - 1.0) > 0.01:
                # 按显示尺寸缩一档：体积降到 ~1/2，肉眼几乎无差
                with Image.open(source) as image:
                    resized = image.convert("RGBA").resize(
                        (max(1, round(image.width * scale)), target_height), Image.LANCZOS)
                resized.save(target, "WEBP", quality=quality, method=5)
            else:
                shutil.copy2(source, target)
            first = first or target
        if first is None:
            continue

        clips[clip] = {
            # file 指向第一帧：没有帧播放能力的旧版本也能显示一张，而不是空白
            "file": f"{entry['dir']}/{first.name}",
            "width": round(int(entry.get("width", 0)) * scale),
            "height": target_height,
            "top": entry.get("top", 0),
            "dir": entry["dir"],
            "prefix": entry["prefix"],
            "count": int(entry["count"]),
            "frameMs": int(entry.get("frameMs", 90)),
            "loop": bool(entry.get("loop", True)),
        }

        static_pose = clip[:-len("-motion")] if clip.endswith("-motion") else None
        for owner in owners:
            key = str(owner.get("name") or "")
            key = key.upper() if key.upper() in known_states else key.lower()
            bucket = states.setdefault(key, []) if key in known_states else actions.setdefault(key, [])
            if static_pose and static_pose in bucket:
                bucket.remove(static_pose)   # 同一姿态：动画替换静图
            if clip not in bucket:
                bucket.append(clip)
        merged += 1
    return merged


def write_manifest(path: Path, manifest: dict) -> None:
    """原子写 manifest：中断只留下旧的完整文件，不会出现半个 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".manifest-", suffix=".json")
    with open(handle, "w", encoding="utf8") as stream:
        stream.write(text)
    Path(temporary).replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default=None, help="dsh-whale-musume 的 assets/generated 目录")
    parser.add_argument("--out", type=Path, default=ROOT / "assets" / "pack")
    parser.add_argument("--quality", type=int, default=PACK_QUALITY)
    parser.add_argument("--char-h", type=int, default=PACK_CHAR_H,
                        help=f"打包时的角色高度：按显示尺寸烘焙（默认 {PACK_CHAR_H}，与随包分发的一致）")
    parser.add_argument("--dry-run", action="store_true", help="只报计划，不动输出目录")
    args = parser.parse_args()

    source = resolve_source(args.src)
    print(f"素材来源: {source}")

    # 1) **先读源图、再动输出目录**。
    #    原来是"先 rmtree 再读源"：源目录不对时会把别人分发中的素材包清空，
    #    留下一个空 assets/pack（`--src` 指错一次就中招）。
    arts: dict[str, Image.Image] = {}
    for poses in list(STATE_ASSETS.values()) + list(ACTION_ASSETS.values()):
        for pose in poses:
            if pose in arts:
                continue
            art = normalise_pose(source, pose, SOURCE_CHAR_H)
            if art is None:
                continue
            arts[pose] = art

    missing = sorted({
        pose
        for poses in list(STATE_ASSETS.values()) + list(ACTION_ASSETS.values())
        for pose in poses
        if pose not in arts
    })
    if not arts:
        raise SystemExit(f"没有可用的素材（源目录 {source} 里没有匹配的姿态图），已保持 {args.out} 原样")

    out = args.out
    if args.dry_run:
        print(f"[dry-run] 会重建 {out}：{len(arts)} 张姿态图，缺 {len(missing)} 张")
        return 0
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    widest = max(art.width for art in arts.values())
    print(f"统一高度 {SOURCE_CHAR_H}px | 宽度范围 {min(a.width for a in arts.values())}-{widest}px"
          f"（宽度按原图比例，窗口随之自适应）")

    clips: dict[str, dict] = {}
    states: dict[str, list[str]] = {}
    actions: dict[str, list[str]] = {}
    total_bytes = 0

    def build(owner: str, poses: list[str], into: dict[str, list[str]]) -> None:
        nonlocal total_bytes
        for pose in poses:
            art = arts.get(pose)
            if art is None:
                continue
            if pose not in clips:
                group = owner.lower()
                directory = out / group
                directory.mkdir(parents=True, exist_ok=True)
                target = directory / f"{pose}.webp"
                art.save(target, "WEBP", quality=args.quality, method=5)
                total_bytes += target.stat().st_size
                clips[pose] = {
                    "file": f"{group}/{pose}.webp",
                    "width": art.width,
                    "height": art.height,
                    "top": content_top(art),
                }
            into.setdefault(owner, [])
            if pose not in into[owner]:
                into[owner].append(pose)

    for state, poses in STATE_ASSETS.items():
        build(state, poses, states)
    for action, poses in ACTION_ASSETS.items():
        build(action, poses, actions)

    # 合并 assets/motion/**：那是 bailian_motion.py 用百炼生成的微动作序列帧。
    # 放在独立目录是为了不被本脚本的"清空重建"抹掉，合并动作在这里做。
    merged = merge_motion(out, clips, states, actions, char_h=args.char_h, quality=args.quality)
    if merged:
        animated = [name for name in clips if "count" in clips[name]]
        print(f"合并百炼生成的序列帧: {merged} 段（素材包内共 {len(animated)} 段动画）")

    # 被动画替换掉的静图，既不在任何状态列表里、也不该留在 clips 里
    referenced = set()
    for names in list(states.values()) + list(actions.values()):
        referenced.update(names)
    for name in [name for name in clips if name not in referenced]:
        del clips[name]

    pruned = prune_unreferenced(out, clips)
    if pruned:
        print(f"清理被替换的静态图: {pruned} 张")

    manifest = {
        "formatVersion": 4,
        # canvas 只是参考尺寸（最宽素材 × 统一高度）；实际窗口按 clips[].width/height 走
        "canvas": {"width": widest, "height": SOURCE_CHAR_H},
        "bubbleBand": BUBBLE_BAND,
        "clips": clips,
        "states": states,
        "actions": actions,
    }
    write_manifest(out / "pet-manifest.json", manifest)

    print(f"写入 {len(clips)} 张静图 / {total_bytes / 1e6:.2f} MB -> {out}")
    for state, names in states.items():
        print(f"  {state:13s} {len(names)} 张: {', '.join(names)}")
    if missing:
        print(f"  缺失（已跳过）: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
