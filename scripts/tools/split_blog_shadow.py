#!/usr/bin/env python3
"""博客页头三件套化（2026-09-12）：把地面阴影从横幅底图剥离成独立图层。

背景：阴影原本烘焙在 blog-banner.webp 里（prep_blog_header.py 豁免保留），
人物层左移后底图阴影掉队，出现"空白"。本脚本把阴影抽成 blog-shadow.webp
（RGBA，alpha=变暗比例），横幅底图原位填回站纸色，基线细线原样保留。

输入（只读）: public/motion/blog-banner.webp 2048x1024（当前线上版）
输出:
  public/motion/blog-banner.webp  覆写：阴影区填纸色（基线不动）
  public/motion/blog-shadow.webp  阴影层（紧包围盒裁切）
并打印阴影层的 DOM 定位百分比。

原理：阴影 = 半透明灰色叠在纸上：pix = PAPER*(1-a) + C*a。
反解 a = |pix-PAPER|/|C-PAPER|，C = PAPER + (pix-PAPER)/a（逐像素反-premultiply），
合成回纸上与原图逐像素一致。基线（深色细线）用暗核竖向膨胀保护，两图都不含它。
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
PAPER = np.array([238, 237, 235], np.float32)

src = ROOT / 'public/motion/blog-banner.webp'
b = np.array(Image.open(src).convert('RGB'), np.float32)
H, W, _ = b.shape
lum = b.mean(2)
d = np.abs(b - PAPER).sum(2)
DC = 142.0  # |C-PAPER| 估标定：阴影最深色 ~ (193,192,183) → sum-abs 142

# ── 1. 感兴趣区（阴影 bbox 外扩）──
x0, x1, y0, y1 = 1080, 1840, 900, 990
zone = np.zeros((H, W), bool)
zone[y0:y1, x0:x1] = True

# ── 2. 基线保护：深色细线核心 + 竖向膨胀 3px ──
dark_core = zone & (lum < 172)
# MaxFilter 只有方形核：转置后做水平 MaxFilter(7) 等价于竖向膨胀 3px（保细线的横向连续）
dc_img = Image.fromarray((dark_core * 255).astype(np.uint8)).transpose(Image.ROTATE_90)
dc_img = dc_img.filter(ImageFilter.MaxFilter(7)).transpose(Image.ROTATE_270)
baseline = np.asarray(dc_img, np.float32) / 255.0 > 0

# ── 3. 阴影 alpha 反解 ──
smask = zone & (d > 8) & (lum >= 172) & ~baseline
a = np.zeros((H, W), np.float32)
a[smask] = np.clip((d[smask] - 4) / DC, 0.02, 1.0)
# 羽化 alpha 边缘
aimg = Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
a = np.asarray(aimg, np.float32) / 255.0
a[~zone] = 0.0
a[baseline] = 0.0

eps = 1e-3
ac = np.maximum(a, eps)[..., None]
color = PAPER + (b - PAPER) / ac
color = np.clip(color, 0, 255)

# 紧包围盒
ys, xs = np.where(a > 0.01)
sx0, sx1, sy0, sy1 = xs.min(), xs.max(), ys.min(), ys.max()
print(f'阴影 bbox: x {sx0}..{sx1}  y {sy0}..{sy1}  ({sx1-sx0+1}x{sy1-sy0+1})  px {len(xs)}')

rgba = np.dstack([color, a * 255]).astype(np.uint8)
si = Image.fromarray(rgba, 'RGBA').crop((sx0, sy0, sx1 + 1, sy1 + 1))
si.save(ROOT / 'public/motion/blog-shadow.webp', quality=90, method=6)

# ── 4. 横幅填回纸色（阴影掩码轻微外扩+羽化；基线区域绝对不动）──
em = Image.fromarray(((a > 0.005) * 255).astype(np.uint8)).filter(
    ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1))
em = np.asarray(em, np.float32)[..., None] / 255.0
em[baseline] = 0.0
out = b * (1 - em) + PAPER * em
Image.fromarray(out.astype(np.uint8)).save(src, quality=82, method=6)

# ── 5. 残差校验：阴影层合成回纸色 vs 原横幅 ──
recon = PAPER * (1 - a[..., None] / 255.0 * 0)  # 占位，真正校验如下
comp = PAPER[None, None, :] * (1 - a[..., None]) + color * a[..., None]
err = np.abs(comp - b).sum(2)[a > 0.05]
print(f'合成残差: mean {err.mean():.1f} max {err.max():.0f} (sum-abs, ≤20 视为一致)')
fill_res = np.abs(out - PAPER).sum(2)[(em[..., 0] > 0.95) & ~baseline]
print(f'填纸残差: mean {fill_res.mean():.1f} max {fill_res.max():.0f}')

# ── 6. DOM 定位 ──
print('---- DOM 定位（banner 2048x1024）----')
print(f'left   {sx0 / W * 100:.4f}%')
print(f'top    {sy0 / H * 100:.4f}%')
print(f'width  {(sx1 - sx0 + 1) / W * 100:.4f}%')
print(f'height {(sy1 - sy0 + 1) / H * 100:.4f}%')
for f in ('blog-banner.webp', 'blog-shadow.webp'):
    p = ROOT / 'public/motion' / f
    print(f'{f}: {p.stat().st_size / 1024:.1f} KB')
