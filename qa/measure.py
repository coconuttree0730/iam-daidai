"""像素级测量：把用户截图里的卡片位置量出来，避免靠肉眼估。

用法：python qa/measure.py 图片路径 [图片路径...]

输出：
  1. 图像尺寸与"内容区"（去掉手机截图的深色外框）
  2. 底部黑条（infobar）的上下沿 → 反推 CSS→图像 的缩放比
  3. 卡片外框：由"深色描边连通域"给出 bbox；bbox 中心 = 卡片中心
  4. 红色像素连通域（PERSONAL / About Me / 角标）
"""
import sys
from collections import deque

import numpy as np
from PIL import Image
from scipy import ndimage


def content_bbox(rgb):
    """手机截图有深色 bezel：取亮度 > 200 的最大区域的外接矩形。"""
    lum = rgb.mean(axis=2)
    bright = lum > 200
    lbl, n = ndimage.label(bright)
    if n == 0:
        return (0, 0, rgb.shape[1], rgb.shape[0])
    sizes = ndimage.sum(bright, lbl, range(1, n + 1))
    big = int(np.argmax(sizes)) + 1
    ys, xs = np.where(lbl == big)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def dark_components(rgb, thr=170, min_w=45, min_h=35, max_fill=0.55):
    lum = rgb.mean(axis=2)
    mask = lum < thr
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3)))
    lbl, n = ndimage.label(mask)
    out = []
    sl = ndimage.find_objects(lbl)
    for i, s in enumerate(sl, start=1):
        if s is None:
            continue
        y0, y1 = s[0].start, s[0].stop
        x0, x1 = s[1].start, s[1].stop
        w, h = x1 - x0, y1 - y0
        if w < min_w or h < min_h:
            continue
        area = int((lbl[s] == i).sum())
        fill = area / (w * h)
        out.append(dict(x0=x0, y0=y0, x1=x1, y1=y1, w=w, h=h, area=area, fill=round(fill, 3)))
    out.sort(key=lambda d: -d["area"])
    return out


def red_components(rgb, min_area=60):
    r = rgb[:, :, 0].astype(int)
    g = rgb[:, :, 1].astype(int)
    b = rgb[:, :, 2].astype(int)
    mask = (r > 130) & (r - g > 55) & (r - b > 55)
    lbl, n = ndimage.label(mask)
    out = []
    sl = ndimage.find_objects(lbl)
    for i, s in enumerate(sl, start=1):
        if s is None:
            continue
        y0, y1 = s[0].start, s[0].stop
        x0, x1 = s[1].start, s[1].stop
        area = int((lbl[s] == i).sum())
        if area < min_area:
            continue
        out.append(dict(x0=x0, y0=y0, x1=x1, y1=y1, w=x1 - x0, h=y1 - y0, area=area))
    out.sort(key=lambda d: -d["area"])
    return out


def bottom_bar(rgb, min_dark_ratio=0.75):
    """返回底部横跨全宽的深色条的 (top, bottom)。"""
    lum = rgb.mean(axis=2)
    H, W = lum.shape
    rows = []
    for y in range(H - 1, -1, -1):
        ratio = (lum[y] < 90).mean()
        rows.append((y, ratio))
        if ratio < min_dark_ratio and len(rows) > 4:
            break
    if not rows:
        return None
    ys = [y for y, r in rows if r >= min_dark_ratio]
    if not ys:
        return None
    return (min(ys), max(ys))


def report(path):
    im = Image.open(path).convert("RGB")
    rgb = np.asarray(im)
    H, W = rgb.shape[:2]
    print(f"\n===== {path.split('/')[-1]}  {W}x{H}  ratio={W/H:.4f} =====")

    cb = content_bbox(rgb)
    print(f"内容区 bbox = {cb}   尺寸 {cb[2]-cb[0]}x{cb[3]-cb[1]}")

    bar = bottom_bar(rgb)
    print(f"底部黑条 y = {bar}  高 = {bar[1]-bar[0]+1 if bar else None}")

    comps = dark_components(rgb)
    print(f"深色连通域 {len(comps)} 个（按面积降序，前 14）：")
    for c in comps[:14]:
        cx = (c["x0"] + c["x1"]) / 2
        cy = (c["y0"] + c["y1"]) / 2
        print(
            f"  bbox=({c['x0']:>4},{c['y0']:>4})-({c['x1']:>4},{c['y1']:>4}) "
            f"{c['w']:>4}x{c['h']:<4} 中心=({cx:>6.1f},{cy:>6.1f}) "
            f"area={c['area']:>7} fill={c['fill']}"
        )

    reds = red_components(rgb)
    print(f"红色连通域 {len(reds)} 个（前 6）：")
    for c in reds[:6]:
        print(
            f"  bbox=({c['x0']:>4},{c['y0']:>4})-({c['x1']:>4},{c['y1']:>4}) "
            f"{c['w']:>4}x{c['h']:<4} area={c['area']}"
        )


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
