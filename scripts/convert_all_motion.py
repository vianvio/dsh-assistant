#!/usr/bin/env python3
"""把素材包里所有静态姿态**批量**转成微动作序列帧（百炼）。

行为：
    · 遍历 build_pack.py 里的状态/动作素材表；
    · 已经转过的（assets/motion 下已存在）自动跳过 → 可中断续跑；
    · 默认 3 路并发（百炼是异步任务，并发只影响创建/轮询节奏）；
    · 生成后写进 assets/motion/，再跑 `npm run build:pack` 就会合并；
    · build:pack 合并时会把同名的静态图从状态列表里换掉 —— 于是"对应状态下就是序列帧动画"。

用法：
    python3 scripts/convert_all_motion.py --dry-run          # 只列计划与预估
    python3 scripts/convert_all_motion.py --limit 1          # 先转一张看质量
    python3 scripts/convert_all_motion.py                    # 全量（可中断续跑）
    python3 scripts/convert_all_motion.py --concurrency 4
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MOTION_ROOT = ROOT / "assets" / "motion"
from build_pack import ACTION_ASSETS, STATE_ASSETS  # noqa: E402
from petgen_lib import MOTION_ROOT, read_sidecar, write_sidecar  # noqa: E402
from bailian_motion import PIPELINE_VERSION  # noqa: E402


def planned_clips() -> list[dict]:
    """按**姿态**去重：同一个姿态只生成一次，登记到它出现的所有状态/动作下。

    之前是按 (owner, pose) 展开的，导致 blush / celebrate / meme-heart / meme-kyun
    这种"一图多挂"的姿态被重复生成、重复计费。
    """
    owners: dict[str, list[str]] = {}
    for state, poses in STATE_ASSETS.items():
        for pose in poses:
            owners.setdefault(pose, [])
            if state not in owners[pose]:
                owners[pose].append(state)
    for action, poses in ACTION_ASSETS.items():
        for pose in poses:
            owners.setdefault(pose, [])
            if action not in owners[pose]:
                owners[pose].append(action)

    plan = []
    for pose, names in sorted(owners.items()):
        primary = names[0]
        group = primary.lower()
        plan.append({"pose": pose, "owners": names, "clip": f"{pose}-motion",
                     "group": group, "kind": "state" if primary.isupper() else "action"})
    return plan


def already_done(clip: str) -> bool:
    """已转过的判定：sidecar 管线版本匹配 + 帧文件齐全（可中断续跑）。

    必须校验管线版本 —— 否则旧管线（逐帧裁剪/锚定）留下的素材会被当成"已完成"，
    续跑时跳过，结果新旧混在一起。
    """
    for directory in MOTION_ROOT.glob(f"*/{clip}"):
        payload = read_sidecar(directory)
        if payload is None:
            continue
        if payload.get("pipeline") != PIPELINE_VERSION:
            continue
        count = int((payload.get("entry") or {}).get("count") or 0)
        if count <= 0:
            continue
        return all((directory / f"{clip}_{index:03d}.webp").exists() for index in range(1, count + 1))
    return False


def convert(item: dict, args, index: int, total: int) -> tuple[str, bool, str]:
    """跑一段（在子进程里调 bailian_motion.py）。

    `--reprocess-archive` 时只重跑后处理（从归档 MP4 抽帧），不调用 API、零成本；
    否则走完整生成链路。
    """
    from_archive = args.reprocess_archive
    owners = "".join(f"（{'+'.join(item['owners'])}）" if not from_archive else "")
    label = f"[{index}/{total}] {item['pose']}{owners}"
    command = [
        sys.executable, str(HERE / "bailian_motion.py"),
        "--pose", item["pose"],
        "--group", item["group"],
        "--clip", item["clip"],
        "--frames", str(args.frames),
    ]
    command += [flag for owner in item["owners"] for flag in ("--state", owner)]
    if from_archive:
        command += ["--from-archive"]
    else:
        command += ["--model", args.model, "--resolution", args.resolution, "--amplitude", args.amplitude]
        if args.frame_ms:
            command += ["--frame-ms", str(args.frame_ms)]
        if args.prompt:
            command += ["--prompt", args.prompt]
        if args.src:
            command += ["--src", args.src]

    started = time.time()
    result = subprocess.run(command, capture_output=True, text=True)
    elapsed = time.time() - started
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-3:]
        return item["clip"], False, f"{label} 失败({elapsed:.0f}s): {' | '.join(tail)}"
    return item["clip"], True, f"{label} 完成({elapsed:.0f}s)"


def sync_owners() -> int:
    """按素材表刷新每段 sidecar 的 owners（不重新生成、不花钱）。

    用途：一张图可能同时挂在多个状态/动作下，owners 变了（比如新增了引用）时，
    用它把登记补齐，避免"另一个状态下还是静图"。
    """
    plan = {item["clip"]: item for item in planned_clips()}
    updated = 0
    for directory in sorted(MOTION_ROOT.glob("*/*")):
        payload = read_sidecar(directory)
        if payload is None:
            continue
        item = plan.get(payload.get("clip"))
        if not item:
            continue
        owners = [{"kind": "state" if name.isupper() else "action", "name": name} for name in item["owners"]]
        if payload.get("owners") != owners:
            payload["owners"] = owners
            payload["state"] = owners[0]["name"]
            payload["kind"] = owners[0]["kind"]
            write_sidecar(directory, payload)
            updated += 1
            print(f"  · {payload['clip']:28s} → {', '.join(o['name'] for o in owners)}")
    print(f"同步完成：{updated} 段有更新")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="批量把静态姿态转成微动作序列帧")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0, help="只转前 N 个（0 = 全部）")
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--model", default="wan2.2-kf2v-flash")
    parser.add_argument("--resolution", default="480P", choices=["480P", "720P", "1080P"])
    parser.add_argument("--frames", type=int, default=30, help="每段抽多少帧（默认 30 ≈ 30fps）")
    parser.add_argument("--frame-ms", type=int, default=0, help="0 = 按循环窗口实时播放")
    parser.add_argument("--src", default=None)
    parser.add_argument("--prompt", default=None, help="覆盖自动生成的提示词（默认按角色+姿态生成）")
    parser.add_argument("--amplitude", default="明显", choices=["轻微", "明显", "强烈"])
    parser.add_argument("--overwrite", action="store_true", help="忽略已有产物，全部重新生成")
    parser.add_argument("--skip-build", action="store_true", help="完成后不自动合并素材包")
    parser.add_argument("--sync-owners", action="store_true", help="只按素材表刷新 owners 登记，不生成")
    parser.add_argument("--reprocess-archive", action="store_true",
                        help="用已归档的 source.mp4 重新抽帧（改抠像/裁剪逻辑后重跑，零 API 成本）")
    args = parser.parse_args()

    if args.sync_owners:
        return sync_owners()

    plan = planned_clips()
    if args.reprocess_archive:
        # 只处理有归档视频的段；不检查"是否已完成"（目的就是重做）
        remaining = [item for item in plan
                     if (MOTION_ROOT / item["group"] / item["clip"] / "source.mp4").exists()]
    else:
        remaining = plan if args.overwrite else [item for item in plan if not already_done(item["clip"])]
    todo = remaining[: args.limit] if args.limit > 0 else remaining

    done = [item for item in plan if already_done(item["clip"])]
    print(f"计划 {len(plan)} 段；已完成 {len(done)} 段；本次要转 {len(todo)} 段"
          + ("（overwrite：忽略已完成）" if args.overwrite else ""))
    print(f"模型 {args.model} / {args.resolution} / {args.frames} 帧 @ {args.frame_ms}ms"
          f" / 并发 {args.concurrency}")
    per_state: dict[str, int] = {}
    for item in todo:
        for owner in item["owners"]:
            per_state[owner] = per_state.get(owner, 0) + 1
    for owner, count in sorted(per_state.items()):
        print(f"  {owner:13s} {count} 段")

    if not todo:
        print("都已转完，直接 `npm run build:pack` 即可合并。")
        return 0

    if args.dry_run:
        # 480P flash 按"秒数×单价"计费；这里只给量级，具体以控制台为准
        print(f"\n预估：{len(todo)} 次调用 × 5 秒视频（单次通常 1–5 分钟）")
        print("按 480P flash 估算约 ¥" + f"{len(todo) * 0.5:.0f}–{len(todo) * 2:.0f}（以百炼控制台账单为准）")
        print("dry-run 结束，没有发起任何调用。")
        return 0

    # --reprocess-archive 只用归档视频重跑后处理，不调用 API，所以不需要 Key
    if not args.reprocess_archive and not os.environ.get("DASHSCOPE_API_KEY"):
        print("缺少 DASHSCOPE_API_KEY（可在 ~/.zshrc 里 export，或用 env DASHSCOPE_API_KEY=... 运行）", file=sys.stderr)
        return 2

    failures: list[str] = []
    if args.overwrite:
        print("overwrite：忽略已有产物，全部重新生成")
    succeeded = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {
            pool.submit(convert, item, args, index, len(todo)): item
            for index, item in enumerate(todo, start=1)
        }
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                clip, ok, message = future.result()
            except Exception as error:      # 单个 worker 抛异常不该中断整批（钱已经花了）
                clip, ok, message = item["clip"], False, f"{item['clip']} 异常: {error}"
            print(message, flush=True)
            if ok:
                succeeded += 1
            else:
                failures.append(clip)

    print(f"\n完成 {succeeded}/{len(todo)}" + (f"，失败 {len(failures)}: {', '.join(failures)}" if failures else ""))

    if not args.skip_build and succeeded > 0:
        print("\n合并素材包…")
        subprocess.run([sys.executable, str(HERE / "build_pack.py"), "--out", str(ROOT / "assets" / "pack")], check=True)
        print("\n再跑 `npm run verify` 检查契约。")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
