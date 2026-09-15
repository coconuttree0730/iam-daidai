#!/usr/bin/env python3
"""制备印章墙新增贴纸（/lab/stamps/，2026-09-15）。

输入全部是已抠好透明通道的产物（RVM / keyed），本脚本不做抠图，只做：
1. 轻度去绿溢色（despill）——keyed 序列边缘的绿色镶边；
2. 按 alpha 裁到内容 bbox（留 6px 边距）；
3. LANCZOS 降采样到展示高度（与现有贴纸 1x 约定一致）；
4. 存为 public/lab/stamps/ 下的 RGBA WebP。

产出：
  pose-up.webp      ← motion/head-turn/candidates/atlas48/frame_010.png（抬头看，笑）
  pose-hand.webp    ← motion/head-turn/candidates/atlas48/frame_040.png（抬手）
  pose-arms.webp    ← public/motion/0166.png（抱臂笑，scroll 段同源帧）
  chibi-archive.webp← public/motion/categories-archive-chibi.webp（抱文件 chibi，已干净，仅裁剪缩放）
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "lab" / "stamps"
PAD = 6


def despill(img: Image.Image, factor: float = 0.15) -> Image.Image:
    """压制 keyed 边缘的绿色溢色：G 超出 max(R,B) 的部分按 factor 保留。"""
    arr = np.asarray(img.convert("RGBA")).astype(np.int16)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    excess = g - np.maximum(r, b)
    g = np.where(excess > 0, np.maximum(r, b) + excess * factor, g)
    arr[..., 1] = g
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8), "RGBA")


def trim(img: Image.Image, pad: int = PAD) -> Image.Image:
    a = np.asarray(img.getchannel("A"))
    ys, xs = np.where(a > 8)
    if len(xs) == 0:
        return img
    l, t, r, b = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    l, t = max(0, l - pad), max(0, t - pad)
    r, b = min(img.width, r + pad), min(img.height, b + pad)
    return img.crop((l, t, r, b))


def resize_h(img: Image.Image, h: int) -> Image.Image:
    w = round(img.width * h / img.height)
    return img.resize((w, h), Image.LANCZOS)


JOBS = [
    # (源文件, 输出名, 展示高度, 是否 despill)
    ("motion/head-turn/candidates/atlas48/frame_010.png", "pose-up.webp", 240, True),
    ("motion/head-turn/candidates/atlas48/frame_040.png", "pose-hand.webp", 240, True),
    ("public/motion/0166.png", "pose-arms.webp", 240, True),
    ("public/motion/categories-archive-chibi.webp", "chibi-archive.webp", 260, False),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for src, name, h, spill in JOBS:
        img = Image.open(ROOT / src).convert("RGBA")
        if spill:
            img = despill(img)
        img = trim(img)
        img = resize_h(img, h)
        img.save(OUT / name, "WEBP", quality=90, method=6)
        print(f"{name}: {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    main()
