#!/usr/bin/env python3
"""用百炼（Model Studio）把静态姿态图变成**微动作序列帧动画**。

为什么需要这样一条管线（调研结论）
-----------------------------------
百炼的图生视频模型（万相系列）**只吃 RGB、不吃透明通道**，输出也永远是 MP4（无 alpha）。
所以"静图 → 微动作序列帧"必须补上两头：

    静态透明 PNG/WebP
        │  ① 合成到纯色幕布（绿幕）—— 模型不接受透明通道
        ▼
    绿幕图 ──② 百炼 图生视频 ──▶ 5s MP4（H.264，无 alpha）
        │  ③ ffmpeg 抽帧
        ▼
    绿幕序列帧 ──④ 色键抠像 + 原图 alpha 约束 ──▶ 透明序列帧
        │  ⑤ 统一高度、写回素材包
        ▼
    assets/pack/<group>/<clip>/<clip>_NNN.webp（manifest 记 frames）

微动作要"首尾同帧"才能无缝循环，所以默认走**首尾帧生视频**：把同一张图同时作为
首帧和尾帧，模型只会在中间插入微动（呼吸、头发轻晃、眨眼），回到原位即无缝。

参考文档
    · 首尾帧生视频（2.2，推荐做循环）：https://help.aliyun.com/zh/model-studio/legacy-image-to-video-by-first-and-last-frame-api-reference
    · 首帧生视频（2.1–2.6）：https://help.aliyun.com/zh/model-studio/legacy-image-to-video-api-reference/
    · 图像编辑/局部重绘（微调单帧）：https://help.aliyun.com/zh/model-studio/wanx2-1-imageedit

用法
----
    # 只做本地后处理：拿一段已有的 MP4（比如手工在百炼控制台生成的）抽帧 + 抠像
    python3 scripts/bailian_motion.py --pose idle-cute --from-video /tmp/idle.mp4 \
        --group idle --clip idle-breathe

    # 端到端：调百炼生成再后处理（需要 DASHSCOPE_API_KEY）
    python3 scripts/bailian_motion.py --pose thinking --group thinking --clip think-sway \
        --prompt "角色保持静止，只有轻微的呼吸起伏与发丝飘动，镜头固定不动"

    # 只看会发出什么请求，不真的调用
    python3 scripts/bailian_motion.py --pose idle-cute --group idle --clip idle-breathe --dry-run
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

from motion_prompts import NEGATIVE, prompt_for
from petgen_lib import (
    KNOWN_STATES,
    MOTION_ROOT,
    ROOT,
    SOURCE_CHAR_H,
    candidate_sources,
    write_sidecar,
)

# 管线版本：改动抽帧/抠像/裁剪逻辑时递增，避免旧产物被当成新产物
PIPELINE_VERSION = "union-crop-v1"

# 源图统一高度（与 build_pack 的归一化口径一致）
CHAR_H = SOURCE_CHAR_H
CHROMA = (0, 177, 64)  # 绿幕（偏冷的纯绿，避免与角色蓝色头发串色）
DEFAULT_MODEL_KF2V = "wan2.2-kf2v-flash"
DEFAULT_MODEL_I2V = "wan2.2-i2v-flash"
DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com"   # 北京地域；业务空间专属域名更快更稳


# ---------------------------------------------------------------------------
# 素材定位与合成
# ---------------------------------------------------------------------------

def resolve_pose_file(pose: str, explicit_src: str | None) -> Path:
    if pose.endswith(".webp") or pose.endswith(".png"):
        candidate = Path(pose)
        if candidate.exists():
            return candidate
    for source in candidate_sources(explicit_src):
        candidate = source / f"dsh-whale-state-{pose}.webp"
        if candidate.exists():
            return candidate
        candidate = source / f"{pose}.webp"
        if candidate.exists():
            return candidate
    raise SystemExit(f"找不到姿态图 {pose}；用 --src 指定素材目录，或直接给文件名")


def composite_on_chroma(pose_file: Path) -> Image.Image:
    """把透明姿态图放到绿幕上：模型不接受 alpha，必须先有实底。"""
    with Image.open(pose_file) as raw:
        art = raw.convert("RGBA")
    bbox = art.getbbox()
    if bbox:
        art = art.crop(bbox)
    scale = CHAR_H / art.height
    art = art.resize((max(1, round(art.width * scale)), CHAR_H), Image.LANCZOS)

    # 四周留出余量：微动作（发丝/衣摆）可能超出原图轮廓，避免贴着画布边被裁
    pad = 32
    canvas = Image.new("RGB", (art.width + pad * 2, art.height + pad * 2), CHROMA)
    canvas.paste(art, (pad, pad), art)
    return canvas


# ---------------------------------------------------------------------------
# 百炼调用
# ---------------------------------------------------------------------------

def to_data_url(image: Image.Image) -> str:
    import io
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    payload = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{payload}"


# 两种任务的 API 路径不同，用错会报 "url error, please check url!"
ENDPOINT_PATH = {
    "kf2v": "/api/v1/services/aigc/image2video/video-synthesis",
    "i2v": "/api/v1/services/aigc/video-generation/video-synthesis",
}


def create_task(endpoint: str, api_key: str, body: dict, mode: str = "kf2v", timeout: int = 60) -> dict:
    path = ENDPOINT_PATH.get(mode, ENDPOINT_PATH["kf2v"])
    request = urllib.request.Request(
        f"{endpoint}{path}",
        data=json.dumps(body).encode("utf8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            # 图生视频只有异步：缺这个头会报 "does not support synchronous calls"
            "X-DashScope-Async": "enable",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf8"))


def poll_task(endpoint: str, api_key: str, task_id: str, interval: int = 15, max_wait: int = 600) -> str:
    deadline = time.time() + max_wait
    while time.time() < deadline:
        request = urllib.request.Request(
            f"{endpoint}/api/v1/tasks/{task_id}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf8"))
        output = payload.get("output", {})
        status = output.get("task_status")
        print(f"  [{time.strftime('%H:%M:%S')}] task_status = {status}")
        if status == "SUCCEEDED":
            video_url = output.get("video_url")
            if not video_url:
                raise SystemExit("任务成功但没有 video_url")
            return video_url
        if status in ("FAILED", "CANCELED", "UNKNOWN"):
            raise SystemExit(f"任务失败: {status} {output.get('code', '')} {output.get('message', '')}")
        time.sleep(interval)
    raise SystemExit("等待超时（可调大 --max-wait）")


def download(url: str, target: Path) -> Path:
    with urllib.request.urlopen(url, timeout=300) as response, open(target, "wb") as handle:
        shutil.copyfileobj(response, handle)
    return target


# ---------------------------------------------------------------------------
# 帧处理
# ---------------------------------------------------------------------------

def frame_descriptors(paths: list[Path], size: int = 48) -> list[np.ndarray]:
    """把每帧压成一个小向量，用于比较"哪两帧最像"（找循环点）。"""
    vectors = []
    for path in paths:
        with Image.open(path) as image:
            small = image.convert("LA").resize((size, size), Image.BILINEAR)
        vectors.append(np.asarray(small, dtype="float32").reshape(-1) / 255.0)
    return vectors


def find_best_loop(vectors: list[np.ndarray], fps: float,
                   min_seconds: float = 0.8, max_seconds: float = 3.0) -> tuple[int, int]:
    """在整段视频里找"最像首尾相接"的一段（循环窗口）。

    为什么要找：kf2v 生成的是 5 秒，但真正可循环的周期常常更短；直接拿整段
    均匀抽帧再快放，动作会快好几倍（之前 4.5 秒压成 1 秒就是这个问题）。
    评分 = 首尾差异 / 动作覆盖度：既要接得上，也要动作完整。
    """
    count = len(vectors)
    stack = np.stack(vectors, axis=0)
    best = (0, count - 1, float("inf"))
    for length in range(int(min_seconds * fps), int(max_seconds * fps) + 1):
        for start in range(0, count - length, max(1, length // 8)):
            end = start + length
            seam = float(np.linalg.norm(stack[start] - stack[end]))
            window = stack[start:end + 1]
            coverage = float(np.linalg.norm(window - window.mean(axis=0), axis=1).mean())
            score = seam / (coverage + 1e-3)
            if score < best[2]:
                best = (start, end, score)
    return best[0], best[1]


def detect_loop_window(video: Path, workdir: Path, fps: float = 30.0) -> tuple[int, int, float]:
    """抽一遍轻量帧（1/3 分辨率）用于找循环窗口。返回 (start, end, 窗口秒数)。"""
    ffmpeg = shutil.which("ffmpeg")
    probe_dir = workdir / "probe"
    probe_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", str(video),
         "-vf", "fps=30,scale=160:-2", str(probe_dir / "p_%04d.png")],
        check=True,
    )
    paths = sorted(probe_dir.glob("p_*.png"))
    if len(paths) < 10:
        return 0, max(0, len(paths) - 1), 0.0
    vectors = frame_descriptors(paths, size=32)
    start, end = find_best_loop(vectors, fps)
    return start, end, (end - start) / fps


def extract_frames(video: Path, count: int, workdir: Path, window: tuple[int, int] | None = None) -> list[Path]:
    """按时间均匀抽 count 帧；给了 window 就只在该窗口内抽（帧号按 30fps 计）。"""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise SystemExit("需要 ffmpeg：brew install ffmpeg")

    probe = subprocess.run(
        [ffmpeg, "-i", str(video), "-hide_banner"],
        capture_output=True, text=True,
    ).stderr
    duration = 5.0
    for token in probe.split():
        if token.count(":") == 2 and "." in token:
            try:
                hours, minutes, seconds = token.split(":")
                duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
                break
            except ValueError:
                continue

    if window:
        # 窗口按 30fps 的帧号给出 → 换算成秒；窗口内均匀取帧
        first = max(0.0, window[0] / 30.0)
        last = max(first + 0.1, window[1] / 30.0)
    else:
        first, last = duration * 0.05, duration * 0.95
    span = last - first
    step = span / max(1, count - 1)
    frames: list[Path] = []
    for index in range(count):
        moment = first + step * index
        target = workdir / f"raw_{index + 1:03d}.png"
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-ss", f"{moment:.3f}", "-i", str(video),
             "-frames:v", "1", str(target)],
            check=True,
        )
        if target.exists():
            frames.append(target)
    return frames


def key_out(frame_path: Path, guide_alpha: Image.Image | None, tolerance: int) -> Image.Image:
    """色键抠像：把绿幕判成透明，**其余一律不透明**。

    之前用"离绿幕的 RGB 距离"线性映射 alpha，是个严重的错：深蓝头发、深色裙摆
    离绿色也不算远，于是整只角色变成半透明（实测 74% 的像素 alpha 在 9–254 之间）。
    正确判据是两条**同时**成立才算背景：

        A 离绿幕色足够近（RGB 距离）
        B 明显偏绿（g 明显大于 r、b）—— 角色是蓝/白/肤色，永远不会 g ≫ r,b

    alpha = 255 × (1 - min(A, B))：只有真正偏绿的像素才透明，过渡带很窄，
    抗锯齿边缘得到中间值（保持边缘平滑）；深色部位必然是纯不透明。

    另外对半透明边缘做一次**去绿边**：把 g 压回 max(r, b) 附近，避免淡淡一圈绿。
    """
    with Image.open(frame_path) as raw:
        rgb = raw.convert("RGB")

    array = np.asarray(rgb).astype("float32")
    r, g, b = array[..., 0], array[..., 1], array[..., 2]
    chroma = np.array(CHROMA, dtype="float32")
    distance = np.abs(array - chroma).sum(axis=2)
    greenness = g - np.maximum(r, b)

    # A: 离绿幕多近；B: 有多绿。两者都低 → 一定是角色
    near = np.clip((tolerance - distance) / (tolerance * 0.5), 0.0, 1.0)
    green = np.clip((greenness - 5.0) / 35.0, 0.0, 1.0)
    background = np.minimum(near, green)
    alpha = (255.0 * (1.0 - background)).astype("float32")

    # 去绿边：半透明像素把 g 夹到 max(r,b) 附近
    edge = (alpha > 4) & (alpha < 250)
    if edge.any():
        limit = np.maximum(r, b) + 6.0
        array[..., 1] = np.where(edge, np.minimum(g, limit), g)

    if guide_alpha is not None:
        guide = guide_alpha
        if guide.size != rgb.size:
            guide = guide.resize(rgb.size, Image.LANCZOS)
        alpha = np.where(np.asarray(guide) > 0, alpha, 0.0)

    result = Image.fromarray(np.clip(array, 0, 255).astype("uint8"), "RGB").convert("RGBA")
    result.putalpha(Image.fromarray(alpha.astype("uint8"), "L"))
    return result


def build_guide(pose_file: Path, size: tuple[int, int], pad: int, grow: int = 10) -> Image.Image:
    """原图 alpha 的**膨胀**版：限定「角色可能出现的区域」，滤掉绿幕上的杂散像素。

    注意：视频输出分辨率（480P/720P…）与送进去的绿幕图**不是同一个尺寸**，
    模型只是把画面整体缩放。所以掩码必须在"源图坐标系"里做好之后，
    **再缩放到实际帧尺寸** —— 否则掩码会跑偏，抠出来只剩一角（踩过这个坑）。
    """
    with Image.open(pose_file) as raw:
        art = raw.convert("RGBA")
    bbox = art.getbbox()
    if bbox:
        art = art.crop(bbox)
    scale = CHAR_H / art.height
    art = art.resize((max(1, round(art.width * scale)), CHAR_H), Image.LANCZOS)

    source_size = (art.width + pad * 2, art.height + pad * 2)
    mask = Image.new("L", source_size, 0)
    mask.paste(art.getchannel("A"), (pad, pad))
    # 缩放到实际帧尺寸（输出分辨率 ≠ 输入尺寸）
    mask = mask.resize(size, Image.LANCZOS)

    from PIL import ImageFilter
    blurred = mask.filter(ImageFilter.GaussianBlur(radius=max(2, grow / 2)))
    return blurred.point(lambda value: 255 if value > 8 else 0)




def align_frames(frames: list[Image.Image], char_h: int = CHAR_H) -> list[Image.Image]:
    """整段统一裁剪 + 统一高度。**不做任何逐帧裁剪、不做锚定、不做侧倾校正。**

    视频本身就是同一坐标系（相机固定），所以稳定对齐的正确做法只有一步：

        取所有帧非透明区域的**并集**（min left/top, max right/bottom）
        → 用这一个矩形去裁**每一帧**

    这样所有帧宽高完全一致，角色在画面里的位置与视频里**逐像素一致**，
    晃动/动作都保持模型给的原样。

    踩过的坑（写在这里免得再犯）：
      · 逐帧按自己的包围盒裁剪/居中 → 坐标系被打散，角色被推来推去，
        看起来就是"左右晃动"——这是我自己制造的假问题；
      · 之后又用"身体重心""头部"当锚点、甚至去侧倾 → 是在跟这个假问题较劲，
        还会把模型真实动作削掉（头钉住了、身子反而更飘）。
    """
    masks = []
    for frame in frames:
        alpha = np.asarray(frame.convert("RGBA"))[..., 3]
        masks.append(alpha > 8)

    top, left = 10 ** 6, 10 ** 6
    bottom, right = 0, 0
    for mask in masks:
        rows = np.nonzero(mask.any(axis=1))[0]
        cols = np.nonzero(mask.any(axis=0))[0]
        if rows.size == 0:
            continue
        top, bottom = min(top, int(rows[0])), max(bottom, int(rows[-1]) + 1)
        left, right = min(left, int(cols[0])), max(right, int(cols[-1]) + 1)
    if top > bottom or left > right:
        top, left = 0, 0
        bottom = frames[0].height
        right = frames[0].width

    cropped = [frame.convert("RGBA").crop((left, top, right, bottom)) for frame in frames]

    # 统一的缩放到目标高度（整段同一系数，保持比例）
    height = cropped[0].height
    if char_h and height and abs(height - char_h) > 1:
        scale = char_h / height
        cropped = [
            frame.resize((max(1, round(frame.width * scale)), char_h), Image.LANCZOS)
            for frame in cropped
        ]
    return cropped


def write_clip(frames: list[Image.Image], group: str, clip: str, out_root: Path, frame_ms: int) -> dict:
    """写进 assets/motion/<group>/<clip>/，并更新 assets/motion/manifest.json。

    之所以不直接写素材包：`npm run build:pack` 会重建整个 assets/pack，
    辛苦生成的动画不能放在会被清掉的地方。build:pack 会自动合并这里的产物。
    """
    directory = out_root / group / clip
    directory.mkdir(parents=True, exist_ok=True)
    for index, frame in enumerate(frames, start=1):
        frame.save(directory / f"{clip}_{index:03d}.webp", "WEBP", quality=86, method=5)
    # 清掉上一次抽帧留下的多余帧（例如从 36 帧重抽成 30 帧）
    for stale in directory.glob(f"{clip}_*.webp"):
        tail = stale.stem.rsplit("_", 1)[-1]
        if tail.isdigit() and int(tail) > len(frames):
            stale.unlink()
    widths = [frame.width for frame in frames]
    heights = [frame.height for frame in frames]
    return {
        "dir": f"{group}/{clip}",
        "prefix": clip,
        "count": len(frames),
        "frameMs": frame_ms,
        "loop": True,
        "top": 0,
        # 对齐后所有帧同高（=盘 CHAR_H），宽取最宽帧 —— 与静图素材的高度口径一致
        "height": heights[0],
        "width": max(widths),
    }


def normalise_state(value: str) -> str:
    """状态名统一成大写（若命中已知状态），否则按互动动作处理（小写）。"""
    upper = str(value).upper()
    return upper if upper in KNOWN_STATES else str(value).lower()


def register_clip_sidecar(directory: Path, clip: str, entry: dict, state) -> None:
    """每段动画写自己的 sidecar（clip.json）。

    两件事：
      · 一段一个文件 —— 早期版本所有段落写同一个 manifest，批量并发会互相覆盖；
      · owners 是**列表** —— 同一张图可能同时挂在多个状态/动作下（例如 blush 既在
        WAITING 也在 praise），只生成一次、多处登记，不重复花调用。
    """
    names = state if isinstance(state, (list, tuple)) else [state]
    owners = []
    for name in names:
        key = normalise_state(name)
        owners.append({"kind": "state" if key in KNOWN_STATES else "action", "name": key})
    write_sidecar(directory, {
        "clip": clip,
        # 管线标记：续跑判定用它区分"本管线产物"与旧管线残留
        "pipeline": PIPELINE_VERSION,
        "owners": owners,
        # 兼容旧字段：第一个 owner
        "state": owners[0]["name"] if owners else None,
        "kind": owners[0]["kind"] if owners else None,
        "entry": entry,
    })
    label = ", ".join(f"{o['name']}" for o in owners)
    print(f"已登记：{clip} → [{label}]（{entry['count']} 帧，{entry['frameMs']}ms/帧）")


def main() -> int:
    parser = argparse.ArgumentParser(description="百炼：静态姿态图 → 微动作序列帧")
    parser.add_argument("--pose", required=True, help="姿态名（如 idle-cute）或图片路径")
    parser.add_argument("--src", default=None, help="dsh-whale-musume 素材目录")
    parser.add_argument("--group", required=True, help="输出分组目录（如 idle / thinking）")
    parser.add_argument("--clip", required=True, help="clip 名（如 idle-breathe）")
    parser.add_argument("--state", action="append", default=None,
                        help="登记到 states/actions 的键，可给多个（同一张图挂在多处）；默认用 --group")
    parser.add_argument("--prompt", default=None,
                        help="自定义微动作提示词；默认按「角色形象 + 该姿态的具体动作 + 约束」自动生成")
    parser.add_argument("--amplitude", default="明显", choices=["轻微", "明显", "强烈"],
                        help="动作幅度措辞（幅度不够时用强烈重生成）")
    parser.add_argument("--negative-prompt", default=NEGATIVE)
    parser.add_argument("--model", default=None, help="默认 kf2v 用 wan2.2-kf2v-flash、i2v 用 wan2.2-i2v-flash")
    parser.add_argument("--mode", default="kf2v", choices=["kf2v", "i2v"],
                        help="kf2v=首尾帧同图（稳、必回原位）；i2v=只给首帧（动作更大）")
    parser.add_argument("--endpoint", default=os.environ.get("DASHSCOPE_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--resolution", default="480P", choices=["480P", "720P", "1080P"])
    parser.add_argument("--no-autoloop", action="store_true",
                        help="不自动找循环片段，直接在整段视频上均匀抽帧")
    parser.add_argument("--frames", type=int, default=30,
                        help="抽多少帧（模型给的是 5s/24fps≈120 帧，30 帧 ≈ 30fps 播放，够顺）")
    parser.add_argument("--video-only", action="store_true",
                        help="只要视频、不抽帧（用于先看效果/留档）")
    parser.add_argument("--from-archive", action="store_true",
                        help="用归档的 source.mp4 重新抽帧，不调用 API")
    parser.add_argument("--frame-ms", type=int, default=0,
                        help="每帧毫秒；0 = 按循环窗口自动算（实时速度）")
    parser.add_argument("--tolerance", type=int, default=90, help="色键容差（越大抠得越狠）")
    parser.add_argument("--guide-grow", type=int, default=0,
                        help="用静态姿态 alpha 做约束的膨胀量；0 = 关闭（默认）。"
                             "开启会把超出原轮廓的动作削平，只在绿幕残留严重时才用")
    parser.add_argument("--from-video", default=None, help="跳过生成：直接处理已有 MP4")
    parser.add_argument("--out-root", type=Path, default=ROOT / "assets" / "motion",
                        help="序列帧输出目录（build:pack 会自动合并进素材包）")
    parser.add_argument("--pingpong", action="store_true",
                        help="i2v 模式下把帧序列做成乒乓回放（首尾相接，循环无缝）")
    parser.add_argument("--dry-run", action="store_true", help="只打印请求，不调用")
    args = parser.parse_args()

    # 提示词：默认按角色 + 姿态生成（比通用话有效得多）
    pose_key = Path(args.pose).stem.replace("dsh-whale-state-", "")
    prompt = args.prompt or prompt_for(pose_key, args.amplitude)

    pose_file = resolve_pose_file(args.pose, args.src)
    chroma_image = composite_on_chroma(pose_file)
    print(f"姿态图: {pose_file}")
    print(f"绿幕图: {chroma_image.size[0]}×{chroma_image.size[1]}（模型不吃透明通道，必须先铺实底）")

    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    model = args.model or (DEFAULT_MODEL_KF2V if args.mode == "kf2v" else DEFAULT_MODEL_I2V)
    image_payload = to_data_url(chroma_image)
    payload_input = {
        "prompt": prompt,
        "negative_prompt": args.negative_prompt,
    }
    if args.mode == "kf2v":
        # 首尾帧同图 = 只插入微动、回到原位 → 天然可循环
        payload_input["first_frame_url"] = image_payload
        payload_input["last_frame_url"] = image_payload
    else:
        # i2v（首帧生视频）的参数名是 img_url —— 用错会报 img_url must be set
        payload_input["img_url"] = image_payload
    body = {
        "model": model,
        "input": payload_input,
        "parameters": {"resolution": args.resolution, "prompt_extend": False, "watermark": False},
    }

    if args.dry_run:
        preview = dict(body)
        preview_input = dict(body["input"])
        placeholder = f"<base64 png, {len(image_payload)} chars>"
        for key in ("first_frame_url", "last_frame_url", "img_url"):
            if key in preview_input:
                preview_input[key] = placeholder
        preview["input"] = preview_input
        print("\n会发出的请求（脱敏）：")
        print(json.dumps({
            "POST": f"{args.endpoint}{ENDPOINT_PATH.get(args.mode)}",
            "headers": {"X-DashScope-Async": "enable", "Authorization": "Bearer $DASHSCOPE_API_KEY"},
            "body": preview,
        }, ensure_ascii=False, indent=2))
        print(f"\n提示词（{len(prompt)} 字）：\n{prompt}")
        print("\n注意：input 里首尾帧都是同一张绿幕图；模型只会在中间插微动。")
        return 0

    workdir = Path(tempfile.mkdtemp(prefix="dsh-assistant-motion-"))
    try:
        archive = args.out_root / args.group / args.clip / "source.mp4"
        task_id = None
        if args.from_archive:
            if not archive.exists():
                raise SystemExit(
                    f"没有归档视频: {archive}\n"
                    "（只有真正调用过 API 生成的那一段才有 source.mp4；"
                    "--from-video 处理过的视频不会自动归档）",
                )
            video = archive
            print(f"从归档重新抽帧: {video}")
        elif args.from_video:
            video = Path(args.from_video)
            if not video.exists():
                raise SystemExit(f"视频不存在: {video}")
            print(f"跳过生成，直接处理: {video}")
        else:
            if not api_key:
                raise SystemExit("缺少 DASHSCOPE_API_KEY（百炼 API Key）；或用 --from-video 处理已有视频")
            print(f"创建任务：model={model} mode={args.mode} resolution={args.resolution}")
            created = create_task(args.endpoint, api_key, body, args.mode)
            task_id = created.get("output", {}).get("task_id")
            if not task_id:
                raise SystemExit(f"创建任务失败: {json.dumps(created, ensure_ascii=False)}")
            print(f"task_id = {task_id}（轮询中，通常 1–5 分钟）")
            video_url = poll_task(args.endpoint, api_key, task_id)
            video = download(video_url, workdir / "generated.mp4")
            print(f"视频已下载: {video}（{video.stat().st_size / 1e6:.2f} MB）")

        # 归档：视频 + 生成信息（模型/提示词/分辨率）。
        #
        # 这里**只增不改**：`--from-archive` 重新抽帧不该把当初那次生成的信息抹掉
        #（曾经每跑一次就把 88 段的 provenance 清成 null）。
        # **不入档的**：task_id（能反推账号用量）与 video_url（24 小时有效的签名 URL）。
        archive = args.out_root / args.group / args.clip / "source.mp4"
        archive.parent.mkdir(parents=True, exist_ok=True)
        if video.resolve() != archive.resolve():
            shutil.copy2(video, archive)
        info_path = archive.parent / "generation.json"
        info = {}
        if info_path.exists():
            try:
                info = json.loads(info_path.read_text(encoding="utf8"))
            except json.JSONDecodeError:
                info = {}
        info.update({
            "clip": args.clip,
            "group": args.group,
            "pose": pose_key,
            "mode": args.mode,
            "model": model,
            "resolution": args.resolution,
            "prompt": prompt,
            "negative_prompt": args.negative_prompt,
            "pipeline_version": PIPELINE_VERSION,
            "archived_video": str(archive.relative_to(ROOT)),
            "video_bytes": archive.stat().st_size,
        })
        # 不落 task_id / video_url：前者能反推账号用量，后者是 24 小时有效的**签名 URL**
        # （凭据泄漏的一种）。provenance 只留"模型/提示词/分辨率/时间"这些非身份信息。
        if task_id and "generated_at" not in info:
            info["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        info["last_processed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        print(f"原始视频已归档: {archive}（{archive.stat().st_size/1e6:.2f} MB）")

        if args.video_only:
            print("\n--video-only：只保留视频，没有抽帧。")
            print(f"看效果: open '{archive}'")
            print("满意后跑同一个命令去掉 --video-only，即会抽帧并写入素材包。")
            return 0
        # 先在整段视频里找"最像首尾相接"的一段，再在这段里均匀抽帧。
        # 这样循环更无缝，而且能按**实时速度**播放（见下面的 frameMs 计算）。
        start_index, end_index, window_seconds = (0, 0, 0.0)
        if not args.no_autoloop:
            print("寻找最佳循环片段…")
            start_index, end_index, window_seconds = detect_loop_window(video, workdir)
            print(f"  循环窗口: 第 {start_index}–{end_index} 帧（{window_seconds:.2f}s）")

        print(f"抽帧：目标 {args.frames} 帧" + ("（窗口内）" if window_seconds else "（整段）"))
        raw_frames = extract_frames(
            video, args.frames, workdir,
            window=(start_index, end_index) if window_seconds else None,
        )
        if not raw_frames:
            raise SystemExit("抽帧失败")
        print(f"抽出 {len(raw_frames)} 帧，开始抠像（容差 {args.tolerance}）")
        if window_seconds and not args.frame_ms:
            # 实时速度：把窗口时长均分给这些帧（不加速、不慢放）
            args.frame_ms = max(20, int(round(window_seconds * 1000 / len(raw_frames))))
            print(f"  播放节奏: {args.frame_ms}ms/帧（实时，一圈 {args.frame_ms * len(raw_frames) / 1000:.2f}s）")

        # 默认不做静态姿态约束：它会把"举手/伸臂"这类超出原轮廓的动作裁掉
        guide = None
        if args.guide_grow > 0:
            guide = build_guide(pose_file, Image.open(raw_frames[0]).size, pad=32, grow=args.guide_grow)
            print(f"  使用静态姿态约束（膨胀 {args.guide_grow}px）")
        keyed_frames: list[Image.Image] = []
        for index, raw_frame in enumerate(raw_frames, start=1):
            keyed_frames.append(key_out(raw_frame, guide, args.tolerance))
            print(f"  ✓ 第 {index}/{len(raw_frames)} 帧抠像")
        if args.pingpong and len(keyed_frames) > 2:
            # 乒乓：正放 + 倒放（去掉重复的首尾帧）→ 首尾天然相接
            keyed_frames = keyed_frames + keyed_frames[-2:0:-1]
            print(f"  ✓ 乒乓回放：{len(keyed_frames)} 帧")
        frames = align_frames(keyed_frames)
        print(f"  ✓ 已对齐到统一高度 {CHAR_H}px（整段同一缩放系数，起伏保留）")

        entry = write_clip(frames, args.group, args.clip, args.out_root, args.frame_ms)
        register_clip_sidecar(args.out_root / args.group / args.clip, args.clip, entry,
                      args.state or [args.group])

        size = sum(path.stat().st_size for path in (args.out_root / args.group / args.clip).glob("*.webp"))
        print(f"\n完成：{args.out_root / args.group / args.clip}（{len(frames)} 帧 / {size / 1e6:.2f} MB）")
        print(f"素材高度统一 {CHAR_H}px；每帧宽度按角色实际包围盒自适应。")
        print("下一步：`npm run build:pack` 会把 assets/motion 合并进素材包（带 frames 的 clip 会逐帧播放）。")
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf8", "ignore")
        print(f"HTTP {error.code}: {detail}", file=sys.stderr)
        raise SystemExit(1)
