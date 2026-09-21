#!/usr/bin/env python3
"""petgen_lib —— 素材管线的公共部分（路径解析、姿态归一化、序列帧 sidecar）。

为什么要有这个模块：这些逻辑原本在 4–5 个脚本里各抄了一份
（`candidate_sources` 两份逐字节相同、`clip_dirs` 三份、备份/改帧/回写 sidecar
三段几乎一样）。抄写版本的典型后果是"改了一处、另一处还是旧的" ——
比如打包高度一度有 400 / 280 / 240 三个值同时在用。

约定：
    · 随包分发的素材包参数只有一个来源：`PACK_CHAR_H` / `PACK_QUALITY`；
    · sidecar（assets/motion/<group>/<clip>/clip.json）的读写只走这里，
      写入一律原子替换，避免中断留下半个 JSON。
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

#: 随包分发的素材参数。改这里 = 改 `npm run build:pack` 的产物，
#: 也必须同步 `scripts/build-helper.sh`（它直接调 build_pack.py）。
PACK_CHAR_H = 240
#: 烘焙质量。78 是实测最贴近随包分发那一版的值（同一帧 q70=15.4KB / q78=16.8KB /
#: q86=19.8KB，分发件 16.2KB）；调高只增加体积，肉眼几乎无差。
PACK_QUALITY = 78
#: 气泡带高度（原生端把它加在窗口顶部）
BUBBLE_BAND = 84
#: 大纲高度：素材源图统一按这个高度归一化，之后按 PACK_CHAR_H 烘焙
SOURCE_CHAR_H = 400

KNOWN_STATES = frozenset(
    {"IDLE", "THINKING", "WORKING", "WAITING", "SUCCESS", "ERROR", "DISCONNECTED"}
)

MOTION_ROOT = ROOT / "assets" / "motion"


# --------------------------------------------------------------- 路径解析


def candidate_sources(explicit: str | None) -> list[Path]:
    """候选素材源目录（找不到时按顺序试，最后一个是我们 clone 的临时位置）。"""
    sources: list[Path] = []
    if explicit:
        sources.append(Path(explicit))
    if os.environ.get("DSH_ASSISTANT_ASSET_SOURCE"):
        sources.append(Path(os.environ["DSH_ASSISTANT_ASSET_SOURCE"]))
    home = Path.home()
    for profile in ("desktop", "web", "headless"):
        sources.append(
            home / ".dsh" / "profiles" / profile / "node_modules" / "dsh-whale-musume" / "assets" / "generated"
        )
    sources.append(Path("/tmp/whale-src/assets/generated"))
    return sources


def resolve_source(explicit: str | None) -> Path:
    """第一个真的存在姿态图的候选目录；都没有就给出可执行的修复命令。"""
    for candidate in candidate_sources(explicit):
        if candidate.is_dir() and any(candidate.glob("dsh-whale-state-*.webp")):
            return candidate
    raise SystemExit(
        "找不到 dsh-whale-musume 素材目录。用法：\n"
        "  python3 scripts/build_pack.py --src /path/to/dsh-whale-musume/assets/generated\n"
        "或先 clone：git clone git@github.com:Sutera-Diffusus/dsh-whale-musume.git /tmp/whale-src",
    )


def motion_clips() -> list[Path]:
    """assets/motion 下所有带 sidecar 的序列帧目录。"""
    return sorted(path.parent for path in MOTION_ROOT.glob("*/*/clip.json"))


def source_pose_file(source: Path, pose: str) -> Path:
    return source / f"dsh-whale-state-{pose}.webp"


# --------------------------------------------------------------- 姿态图


def normalise_pose(source: Path, pose: str, char_h: int = SOURCE_CHAR_H) -> Image.Image | None:
    """读姿态图 → 裁掉透明边 → **统一高度**等比缩放（宽度按原图比例，不拉伸）。

    不存在返回 None（调用方决定是"跳过"还是"报错"）。
    """
    src_file = source_pose_file(source, pose)
    if not src_file.exists():
        return None
    with Image.open(src_file) as raw:
        art = raw.convert("RGBA")
    bbox = art.getbbox()
    if bbox:
        art = art.crop(bbox)
    if art.height == 0 or art.width == 0:
        return None
    scale = char_h / art.height
    return art.resize((max(1, round(art.width * scale)), char_h), Image.LANCZOS)


def content_top(image: Image.Image) -> int:
    """内容顶边（气泡据此贴头顶）。"""
    bbox = image.convert("RGBA").getchannel("A").getbbox()
    return int(bbox[1]) if bbox else 0


def save_webp(image: Image.Image, path: Path, quality: int = PACK_QUALITY) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "WEBP", quality=quality, method=5)


# --------------------------------------------------------------- sidecar


def read_sidecar(directory: Path) -> dict | None:
    """读一段序列帧的 clip.json；坏文件返回 None（调用方记一条并跳过）。"""
    path = directory / "clip.json"
    try:
        return json.loads(path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_sidecar(directory: Path, payload: dict) -> Path:
    """原子写 sidecar：先写同目录临时文件再 replace。"""
    path = directory / "clip.json"
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    handle, temporary = tempfile.mkstemp(dir=directory, prefix=".clip-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf8") as stream:
            stream.write(text)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return path


def frame_paths(directory: Path, prefix: str, count: int) -> list[Path]:
    return [directory / f"{prefix}_{index:03d}.webp" for index in range(1, count + 1)]


def load_frames(directory: Path, prefix: str, count: int) -> list[Image.Image]:
    """按序读帧；缺帧直接报错（半个 clip 播出来是闪的，不如早点停）。"""
    frames: list[Image.Image] = []
    for path in frame_paths(directory, prefix, count):
        if not path.exists():
            raise FileNotFoundError(path)
        frames.append(Image.open(path).convert("RGBA"))
    return frames


def save_frames(frames: list[Image.Image], directory: Path, prefix: str, quality: int) -> None:
    for index, frame in enumerate(frames, start=1):
        save_webp(frame, directory / f"{prefix}_{index:03d}.webp", quality)


def drop_stale_frames(directory: Path, prefix: str, keep: int) -> int:
    """删掉编号超过 keep 的旧帧（帧数变少时用）。"""
    removed = 0
    for stale in directory.glob(f"{prefix}_*.webp"):
        tail = stale.stem.rsplit("_", 1)[-1]
        if tail.isdigit() and int(tail) > keep:
            stale.unlink()
            removed += 1
    return removed


def backup_dir(directory: Path, suffix: str) -> Path:
    """该段的后备目录（`.orig` 增强前 / `.key` 插值前 / `.prestab` 稳定前）。"""
    return directory / suffix


def ensure_backup(directory: Path, prefix: str, count: int, suffix: str) -> Path:
    """首次处理前把原始帧备份一份；后续反复处理都从备份出发（不叠加）。"""
    backup = backup_dir(directory, suffix)
    if backup.exists():
        return backup
    backup.mkdir(parents=True, exist_ok=True)
    for path in frame_paths(directory, prefix, count):
        if path.exists():
            shutil.copy2(path, backup / path.name)
    return backup


def restore_backup(directory: Path, prefix: str, suffix: str) -> int:
    """从备份还原；返回还原的帧数（0 = 没有备份）。"""
    backup = backup_dir(directory, suffix)
    if not backup.exists():
        return 0
    frames = sorted(backup.glob("*.webp"))
    for path in frames:
        shutil.copy2(path, directory / path.name)
    drop_stale_frames(directory, prefix, len(frames))
    return len(frames)


# --------------------------------------------------------------- 帧运算


def blend(left: Image.Image, right: Image.Image, alpha: float) -> Image.Image:
    """两帧之间线性混合（RGBA 一起插值，边缘不会闪）。"""
    a = np.asarray(left, dtype="float32")
    b = np.asarray(right, dtype="float32")
    return Image.fromarray(np.clip(a + (b - a) * alpha, 0, 255).astype("uint8"), "RGBA")


def densify(frames: list[Image.Image], factor: int) -> list[Image.Image]:
    """在每对相邻帧之间插入 factor-1 帧；末帧到首帧也插（循环才完整）。"""
    if factor <= 1 or len(frames) < 2:
        return frames
    result: list[Image.Image] = []
    count = len(frames)
    for index in range(count):
        current = frames[index]
        following = frames[(index + 1) % count]
        result.append(current)
        for step in range(1, factor):
            result.append(blend(current, following, step / factor))
    return result


def amplify(frames: list[Image.Image], factor: float) -> tuple[list[Image.Image], tuple[float, float]]:
    """时间域对比度增强：`frame' = mean + k × (frame - mean)`。

    返回 (增强后的帧, (增强前帧间差, 增强后帧间差)) —— 后者用来量化"到底动起来没有"。

    两个边界（踩过）：
      · alpha 通道本身不放大 —— 轮廓不该变；
      · 半透明边缘按 alpha 混回原样（alpha<8 全原样、>64 全增强），
        否则放大会把抠像毛边一起放大，出现彩色毛边。
    """
    arrays = [np.asarray(frame).astype("float32") for frame in frames]
    stack = np.stack(arrays, axis=0)
    before = float(np.abs(np.diff(stack, axis=0)).mean())

    mean = stack.mean(axis=0)
    boosted = np.clip(mean + factor * (stack - mean), 0, 255)

    alpha = stack[..., 3:4]
    boosted[..., 3:4] = alpha
    edge = np.clip((alpha - 8.0) / 56.0, 0.0, 1.0)
    boosted[..., :3] = boosted[..., :3] * edge + stack[..., :3] * (1 - edge)

    after = float(np.abs(np.diff(boosted, axis=0)).mean())
    result = [Image.fromarray(np.clip(frame, 0, 255).astype("uint8"), "RGBA") for frame in boosted]
    return result, (before, after)
