#!/usr/bin/env python3
"""量一段序列帧的"动作幅度"，用来客观判断动画看不看得出来。

两个指标（都只看角色像素，alpha > 64，避免背景噪声干扰）：

    step  相邻帧之间的平均差异 —— 反映"每帧变化多大"，决定肉眼是否觉得在动
    range 每帧相对本段均值的平均偏离 —— 反映"整段动作的幅度范围"

经验阈值（400px 序列帧、0.4~0.5 倍显示）：
    step  < 2.0  几乎看不出在动（判为 weak，需要重生成）
    2.0 ~ 5.0    能看出轻微动作
    > 5.0        动作明显

用法：
    python3 scripts/measure_motion.py                  # 列出所有段，按 step 升序
    python3 scripts/measure_motion.py --clip idle-cute-motion
    python3 scripts/measure_motion.py --json           # 机器可读
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from petgen_lib import motion_clips

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MOTION_ROOT = ROOT / "assets" / "motion"

WEAK_STEP = 2.0
GOOD_STEP = 5.0


def score_clip(directory: Path) -> dict | None:
    sidecar = directory / "clip.json"
    if not sidecar.exists():
        return None
    payload = json.loads(sidecar.read_text(encoding="utf8"))
    entry = payload["entry"]
    prefix, count = entry["prefix"], int(entry["count"])

    frames = []
    for index in range(1, count + 1):
        path = directory / f"{prefix}_{index:03d}.webp"
        if not path.exists():
            return None
        frames.append(np.asarray(Image.open(path).convert("RGBA")).astype("float32"))

    stack = np.stack(frames, axis=0)
    mask = stack[..., 3] > 64
    if mask.sum() < 100:
        return None
    rgb = stack[..., :3]

    steps = [float(np.abs(rgb[i + 1] - rgb[i])[mask[i] & mask[i + 1]].mean()) for i in range(len(frames) - 1)]
    mean = rgb.mean(axis=0)
    ranges = [float(np.abs(rgb[i] - mean)[mask[i]].mean()) for i in range(len(frames))]

    step = float(np.mean(steps)) if steps else 0.0
    spread = float(np.mean(ranges)) if ranges else 0.0
    grade = "weak" if step < WEAK_STEP else ("ok" if step < GOOD_STEP else "good")
    return {
        "clip": directory.name,
        "state": payload.get("state"),
        "frames": count,
        "step": round(step, 2),
        "range": round(spread, 2),
        "grade": grade,
    }


def all_scores() -> list[dict]:
    scores = []
    for sidecar in sorted(MOTION_ROOT.glob("*/*/clip.json")):
        result = score_clip(sidecar.parent)
        if result:
            scores.append(result)
    return scores


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip", default=None)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--weak-only", action="store_true")
    args = parser.parse_args()

    scores = all_scores()
    if args.clip:
        scores = [score for score in scores if score["clip"] == args.clip]
    if args.weak_only:
        scores = [score for score in scores if score["grade"] == "weak"]

    if args.json:
        print(json.dumps(scores, ensure_ascii=False, indent=2))
        return 0

    scores.sort(key=lambda item: item["step"])
    for score in scores:
        mark = {"weak": "✗ 看不出", "ok": "· 轻微", "good": "✓ 明显"}[score["grade"]]
        print(f"  {mark}  {score['clip']:30s} step={score['step']:5.2f}  range={score['range']:5.2f}  {score['frames']} 帧")

    weak = [score for score in scores if score["grade"] == "weak"]
    print(f"\n共 {len(scores)} 段；其中 {len(weak)} 段偏弱（step < {WEAK_STEP}）")
    if weak:
        # 这条命令以前印的是不存在的 --only-weak（照抄会直接报错）。现在给的是真能跑的：
        # --reprocess-archive 用归档 MP4 重做后处理、零 API 成本；要重生成才去掉它。
        print("偏弱的可以先用后处理增强（零成本）：")
        print("  python3 scripts/motion_post.py --amplify 2.8 --only <clip 名子串>")
        print("要重生成（会花钱）：")
        print("  python3 scripts/convert_all_motion.py --overwrite --amplitude 强烈 --limit 5")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
