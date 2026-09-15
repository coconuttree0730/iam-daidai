#!/usr/bin/env python3
"""抠出 /categories/ 页头插画（Q版人物 + 档案架）为透明底 WebP。

与同目录 matte_character_edge.py 的差异（针对本图的三处改进）：

1. **边界种子加「背景色」门槛**。旧脚本把边界上一切「非边缘」像素都当背景种子，
   主体触边处若有平坦色块（如顶部触边的头发），会被误判成背景并被洪泛吞掉。
   本脚本要求种子像素同时满足 `gray > --seed-gray`，只从真正的浅色底起洪泛。
2. **用 scipy.ndimage 做连通域**，不再逐像素跑纯 Python 双循环（2048x1152 下
   旧脚本的 label_components 是 O(h*w) 的解释器循环，分钟级）。
3. **可按 ROI 定点剔除小块噪声**（本图 = 右上角手写批注「分类归档 / 别放错」）。
   手写笔画是孤立小连通域，主体是十万级大域，按「bbox 完全落在 ROI 内且面积小于
   阈值」剔除即可精确擦掉，不需要涂白矩形（涂白会有过擦主体发丝的风险）。

用法：
    python matte_categories_hero.py <源图> <输出.webp> [--x0 698] [--out-size 723x680]
    python matte_categories_hero.py <源图> --inspect      # 只打印连通域清单
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

# 手写批注所在的右上角区域（源图 2048x1152 坐标系下测得）
TEXT_ROI = (1400, 0, 2048, 320)
TEXT_MAX_AREA = 20000


def build_alpha(rgb: np.ndarray, edge_thr: float, edge_dilate: int,
                seed_gray: float) -> np.ndarray:
    """洪泛抠图：返回布尔前景掩码（True = 保留）。"""
    h, w = rgb.shape[:2]
    gray = rgb.mean(axis=2)

    # 1) 梯度屏障：深色描边挡住洪泛，保护主体内部的浅色区域（白盒/白衬衫/白纸）
    dx = np.abs(np.roll(gray, -1, 1) - np.roll(gray, 1, 1))
    dy = np.abs(np.roll(gray, -1, 0) - np.roll(gray, 1, 0))
    edge = np.hypot(dx, dy) > edge_thr
    if edge_dilate:
        edge = ndimage.binary_dilation(edge, iterations=edge_dilate)

    # 2) 边界种子：必须「非边缘 且 浅色底」，避免主体触边处被误当背景
    border = np.zeros((h, w), dtype=bool)
    border[0, :] = border[-1, :] = True
    border[:, 0] = border[:, -1] = True
    bg = border & ~edge & (gray > seed_gray)

    # 3) 洪泛（4-连通，分块膨胀加速）
    st = ndimage.generate_binary_structure(2, 1)
    for _ in range(4000):
        nxt = ndimage.binary_dilation(bg, structure=st, iterations=8) & ~edge
        if nxt.sum() == bg.sum():
            bg = nxt
            break
        bg = nxt

    return ~bg


def drop_text_blobs(fg: np.ndarray, roi: tuple[int, int, int, int],
                    max_area: int, verbose: bool = False) -> tuple[np.ndarray, list]:
    """剔除 ROI 内面积小于阈值的孤立连通域（手写批注笔画）。"""
    st = ndimage.generate_binary_structure(2, 1)
    lab, n = ndimage.label(fg, structure=st)
    if n == 0:
        return fg, []
    objs = ndimage.find_objects(lab)
    areas = ndimage.sum(fg, lab, range(1, n + 1))

    x0, y0, x1, y1 = roi
    dropped = []
    for i in range(n):
        if areas[i] >= max_area:
            continue
        sy, sx = objs[i]
        # bbox 必须完全落在 ROI 内
        if not (sx.start >= x0 and sx.stop <= x1 and sy.start >= y0 and sy.stop <= y1):
            continue
        dropped.append((i + 1, int(areas[i]), sx.start, sx.stop, sy.start, sy.stop))
        fg[lab == i + 1] = False

    if verbose:
        for d in dropped:
            print(f"  剔除 id={d[0]} area={d[1]} x={d[2]}-{d[3]} y={d[4]}-{d[5]}")
    return fg, dropped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("output", type=Path, nargs="?")
    ap.add_argument("--edge-threshold", type=float, default=18.0)
    ap.add_argument("--edge-dilate", type=int, default=2)
    ap.add_argument("--seed-gray", type=float, default=235.0)
    ap.add_argument("--solidify", type=int, default=2,
                    help="向内腐蚀的像素数，把内部钉成不透明、去掉外圈白边")
    ap.add_argument("--feather", type=int, default=1)
    ap.add_argument("--x0", type=int, default=None, help="裁剪窗口左边界；缺省=右对齐内容")
    ap.add_argument("--crop-w", type=int, default=1225)
    ap.add_argument("--crop-h", type=int, default=1152)
    ap.add_argument("--out-size", default="723x680")
    ap.add_argument("--quality", type=int, default=90)
    ap.add_argument("--no-drop-text", action="store_true")
    ap.add_argument("--preview", type=Path, default=None,
                    help="另存一张铺在纸底 #eeedeb 上的预览图")
    ap.add_argument("--inspect", action="store_true")
    args = ap.parse_args()

    rgb = np.asarray(Image.open(args.source).convert("RGB"), dtype=np.float32)
    h, w = rgb.shape[:2]
    print(f"source {w}x{h}")

    fg = build_alpha(rgb, args.edge_threshold, args.edge_dilate, args.seed_gray)
    print(f"前景占比 {fg.mean():.4f}")

    if args.inspect:
        st = ndimage.generate_binary_structure(2, 1)
        lab, n = ndimage.label(fg, structure=st)
        areas = ndimage.sum(fg, lab, range(1, n + 1))
        objs = ndimage.find_objects(lab)
        for k in np.argsort(-areas)[:20]:
            sy, sx = objs[k]
            print(f"  id={k+1} area={int(areas[k])} x={sx.start}-{sx.stop} y={sy.start}-{sy.stop}")
        ys, xs = np.where(fg)
        print(f"内容 bbox x={xs.min()}-{xs.max()} y={ys.min()}-{ys.max()}")
        return

    if not args.no_drop_text:
        fg, dropped = drop_text_blobs(fg, TEXT_ROI, TEXT_MAX_AREA, verbose=True)
        print(f"剔除文字连通域 {len(dropped)} 个")

    # 裁剪窗口：缺省右对齐内容（保住人物与右下纸堆，左侧档案架出血）
    ys, xs = np.where(fg)
    cx0, cx1 = int(xs.min()), int(xs.max()) + 1
    x0 = args.x0 if args.x0 is not None else max(0, cx1 - args.crop_w)
    x0 = max(0, min(x0, w - args.crop_w))
    y0 = max(0, min(0, h - args.crop_h))

    # alpha：内部钉实 + 边界羽化 + 内缩 1px 去白边
    alpha = fg.astype(np.float32)
    solid = fg.copy()
    for _ in range(args.solidify):
        solid = ndimage.binary_erosion(solid)
    if args.solidify:
        alpha = np.where(solid, 1.0, alpha)
    # 外圈 1px 去掉（抗锯齿残留的浅色像素）
    alpha = alpha * ndimage.binary_erosion(fg, iterations=1)
    if args.feather:
        boundary = ndimage.binary_dilation(fg, iterations=args.feather) & ~ndimage.binary_erosion(fg, iterations=args.feather)
        blur = np.asarray(
            Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(
                ImageFilter.GaussianBlur(args.feather)), dtype=np.float32) / 255.0
        alpha = np.where(boundary, blur, alpha)

    rgba = np.dstack((rgb.astype(np.uint8), np.rint(np.clip(alpha, 0, 1) * 255).astype(np.uint8)))
    img = Image.fromarray(rgba, "RGBA")
    img = img.crop((x0, y0, x0 + args.crop_w, y0 + args.crop_h))

    ow, oh = (int(v) for v in args.out_size.lower().split("x"))
    img = img.resize((ow, oh), Image.LANCZOS)

    if args.preview:
        plate = Image.new("RGB", img.size, (0xEE, 0xED, 0xEB))
        plate.paste(img, (0, 0), img)
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        plate.save(args.preview)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        img.save(args.output, "WEBP", quality=args.quality, method=6)
        print(f"{args.output}  {img.size}  {args.output.stat().st_size/1024:.0f} KB  crop_x0={x0}")


if __name__ == "__main__":
    main()
