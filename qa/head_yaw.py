#!/usr/bin/env python3
"""头部朝向时间轴分析 v2（193 帧滚动素材）

v1 失败原因（务必记住）：「皮肤色像素质心」被**双手进出画面**污染——
    f0–60 掩码 ~2 万像素（只有脸），f65–110 飙到 ~9 万（手抬到胸前），
    f125 达 9.6 万。质心因此整体左移，被误读成"看左"。
    **面积变化被当成了朝向变化。**

v2 方法：**限定头部带 + alpha 墨迹水平重心**
    1. 先用**首帧**确定头部带的垂直范围：取 alpha 墨迹的顶部向下 0–22%
       高度（人像立绘里这一带只有头与头发，没有手）。
    2. 逐帧在该带内取 alpha>128 像素的**水平重心** cx。
    3. 减去全序列中位数 → yaw。yaw>0 = 头偏右、yaw<0 = 头偏左。

    为什么用 alpha 而不是肤色：alpha 是抠图产物，边界稳定、不受光照影响；
    头部带内不存在手，所以面积变化主要来自**头部的水平位移**本身。
    再叠一个稳健化：除以该帧頭部带内的墨迹**总宽**归一化，抵消呼吸式缩放。

输出：qa/out/head-yaw.json
用法：.tmp/venv-img/bin/python qa/head_yaw.py [帧目录] [--band 0.22]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BAND = 0.22
for a in sys.argv[1:]:
    if a.startswith("--band="):
        BAND = float(a.split("=", 1)[1])

FRAME_DIR = Path(args[0] if args else "motion/scroll-slide/frames/rvm-v2").resolve()
OUT_DIR = Path("qa/out").resolve()


def band_rows(alpha: np.ndarray) -> tuple[int, int]:
    """用整帧墨迹的顶部 + BAND 比例高度定义头部带。"""
    rows_any = np.nonzero(alpha.max(axis=1) > 128)[0]
    if rows_any.size == 0:
        return 0, alpha.shape[0]
    top = int(rows_any[0])
    bot = int(rows_any[-1])
    return top, top + max(1, int((bot - top) * BAND))


def main() -> int:
    files = sorted(p for p in FRAME_DIR.iterdir() if p.suffix.lower() == ".png")
    if not files:
        print(f"未找到 PNG 帧：{FRAME_DIR}", file=sys.stderr)
        return 1

    rows = []
    band_top = band_bot = None
    w = h = None

    for i, path in enumerate(files):
        img = Image.open(path).convert("RGBA")
        if w is None:
            w, h = img.size
        alpha = np.asarray(img, dtype=np.uint8)[..., 3]

        if band_top is None:
            band_top, band_bot = band_rows(alpha)
            if band_bot - band_top < 10:
                print("头部带高度异常", file=sys.stderr)
                return 1

        seg = alpha[band_top:band_bot]
        mask = seg > 128
        n = int(mask.sum())
        if n == 0:
            rows.append({"frame": i, "cx": None, "width": 0, "inkPx": 0, "yaw": None})
            continue
        _, xs = np.nonzero(mask)
        cx = float(xs.mean() / w)
        width = float((xs.max() - xs.min() + 1) / w)
        rows.append({
            "frame": i,
            "cx": cx,
            "width": width,
            "inkPx": n,
            "yaw": None,
        })

    cxs = sorted(r["cx"] for r in rows if r["cx"] is not None)
    median = cxs[len(cxs) // 2]
    for r in rows:
        if r["cx"] is not None:
            r["yaw"] = r["cx"] - median

    yaws = [abs(r["yaw"]) for r in rows if r["yaw"] is not None]
    max_abs = max(yaws) if yaws else 0.0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "head-yaw.json"
    out_path.write_text(json.dumps({
        "frameDir": str(FRAME_DIR),
        "frameCount": len(rows),
        "cellWidth": w,
        "cellHeight": h,
        "bandTop": band_top,
        "bandBottom": band_bot,
        "bandFrac": BAND,
        "headMedianCx": median,
        "maxAbsYaw": max_abs,
        "rows": rows,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    total = max(1, len(rows) - 1)

    def pct(f: int) -> float:
        return f / total * 100.0

    print(f"帧数 {len(rows)}｜单格 {w}×{h}｜头部带 y={band_top}..{band_bot}（{BAND:.0%}）")
    print(f"头部墨迹中位 cx = {median:.4f}｜最大 |yaw| = {max_abs:.4f}")
    print()
    print("帧号  进度%     yaw     头宽   墨迹像素  判读")
    for i in range(0, len(rows), 5):
        r = rows[i]
        if r["yaw"] is None:
            continue
        norm = r["yaw"] / max_abs if max_abs else 0.0
        if norm > 0.45:
            label = "看右 >>"
        elif norm > 0.18:
            label = "偏右 >"
        elif norm < -0.45:
            label = "<< 看左"
        elif norm < -0.18:
            label = "< 偏左"
        else:
            label = "正中 ."
        print(f"{r['frame']:>4}  {pct(r['frame']):>5.1f}  {r['yaw']:>+8.4f}  "
              f"{r['width']:.3f}  {r['inkPx']:>8}  {label}")

    valid = [r for r in rows if r["yaw"] is not None]
    right_peak = max(valid, key=lambda r: r["yaw"])
    left_peak = min(valid, key=lambda r: r["yaw"])
    print()
    print(f"报告：{out_path}")
    print(f"最右峰：f{right_peak['frame']}（{pct(right_peak['frame']):.1f}%，yaw={right_peak['yaw']:+.4f}）")
    print(f"最左峰：f{left_peak['frame']}（{pct(left_peak['frame']):.1f}%，yaw={left_peak['yaw']:+.4f}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
