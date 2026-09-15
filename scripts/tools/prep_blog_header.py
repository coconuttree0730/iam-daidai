#!/usr/bin/env python3
"""博客页头两件套素材加工（2026-09-12）。

输入（只读，不改原件）:
  temp/办公-博客.jpeg            2048x1024 横幅（纸底 + NOTES/博客 文字 + 内嵌人物 + 基线）
  temp/办公-博客-character.png   639x929 抠图人物（alpha 已侵蚀 1px）

输出:
  public/motion/blog-banner.webp     横幅：背景重映射为站纸色 #eeedeb，内嵌人物抹除（纸色填充+羽化），
                                     内嵌地面阴影剥离填纸（基线细线原样保留，单次编码无二次压缩）
  public/motion/blog-character.webp  人物层：裁到 alpha 紧包围盒 623x915
  public/motion/blog-shadow.webp     阴影层（2026-09-12 新增第三件）：从横幅反解出的 RGBA 阴影，
                                     DOM 里与人物层独立定位，可单独位移（人物左移阴影跟随）

配准: .tmp/blog-reg.npy 记录抠图内容在横幅中的落点（xor 最优 (1150,55)，7.6% 残差=噪声级）。
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
PAPER = np.array([238, 237, 235], np.float32)  # 站纸 #eeedeb

banner = np.array(Image.open(ROOT / 'temp/办公-博客.jpeg').convert('RGB'), np.float32)
cut = np.array(Image.open(ROOT / 'temp/办公-博客-character.png').convert('RGBA'), np.float32)
H, W, _ = banner.shape
ox, oy, cx0, cy0, cx1, cy1 = np.load(ROOT / '.tmp/blog-reg.npy')
cw, chh = cx1 - cx0 + 1, cy1 - cy0 + 1  # 623 x 915

# ── 1. 联合（尺度，偏移）配准：抠图与横幅存在 ~1% 尺度差，逐级细搜 ──
bg = np.array([254, 255, 250], np.float32)
bfg = np.abs(banner - bg).sum(2) > 26
core_img = Image.fromarray(((cut[..., 3] > 40) * 255).astype(np.uint8))
best = None
for scale in (0.99, 0.995, 1.0, 1.005, 1.01, 1.015, 1.02):
    nw, nh = round(cw * scale), round(chh * scale)
    m = np.asarray(core_img.resize((nw, nh), Image.NEAREST)) > 127
    x0 = ox if scale <= 1 else ox - 10  # 放大时左上角回退，覆盖中心不变
    y0 = oy if scale <= 1 else oy - 10
    for dy in range(0, 21, 1):
        for dx in range(0, 21, 1):
            cx_, cy_ = x0 + dx, y0 + dy
            if cx_ < 0 or cy_ < 0 or cx_ + nw > W or cy_ + nh > H:
                continue
            xor = np.logical_xor(bfg[cy_:cy_ + nh, cx_:cx_ + nw], m).sum()
            if best is None or xor < best[0]:
                best = (xor, scale, nw, nh, cx_, cy_)
xor, scale, nw, nh, ox, oy = best
print(f'精配准: scale {scale} 落点 ({ox},{oy}) 尺寸 {nw}x{nh} xor {xor} ({xor / (nw * nh) * 100:.2f}%)')
# cw/chh 更新为内容在横幅中的实际占位尺寸
cw, chh = nw, nh

# ── 2. 背景软重映射 → 站纸色（只动近纸色像素，人物/文字原样保留）──
d = np.abs(banner - bg).sum(2)
t = np.clip((d - 8) / 24.0, 0, 1)[..., None]  # dsum<8 → 全纸色; >32 → 原色
recol = PAPER * (1 - t) + banner * t

# ── 3. 抹除内嵌人物：alpha 外扩 4px + σ2 羽化，填充站纸色 ──
amask = np.zeros((H, W), np.float32)
alpha_crop = Image.fromarray(cut[..., 3][cy0:cy1 + 1, cx0:cx1 + 1].astype(np.uint8))
if (cw, chh) != alpha_crop.size:
    alpha_crop = alpha_crop.resize((cw, chh), Image.LANCZOS)
amask[oy:oy + chh, ox:ox + cw] = np.asarray(alpha_crop, np.float32) / 255.0
# 分域外扩：上半身 13px（清发顶飘丝，S 字母实测 >13px 距离不会被咬）；
# 下半身 4px（保住地面阴影与基线 y945-948 的完整性；DOM 人物层足迹比 alpha
# 大 ~2%（≈6px），4px 环会被人物层盖住）。中间 80px 线性过渡避免接缝。
small = np.asarray(Image.fromarray((amask * 255).astype(np.uint8)).filter(
    ImageFilter.MaxFilter(9)), np.float32) / 255.0
big = np.asarray(Image.fromarray((amask * 255).astype(np.uint8)).filter(
    ImageFilter.MaxFilter(27)), np.float32) / 255.0
ramp = np.clip((np.arange(H) - 600) / 80.0, 0, 1)[:, None]  # y<600→big, y>680→small
mraw = big * (1 - ramp) + small * ramp
mimg = Image.fromarray((mraw * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.5))
m = np.asarray(mimg, np.float32)[..., None] / 255.0
out = recol * (1 - m) + PAPER * m

# ── 3b. 清障：落点框内（外扩 8px）残留的深色碎片（alpha 洞隙漏网，如膝侧残笔）──
# 豁免：NOTES 的 S（x<1180 且 y<500）、基线细线与地面阴影（亮度 ≥180 的浅色）
lum = out.mean(2)
bx0, by0 = max(ox - 8, 0), max(oy - 8, 0)
bx1, by1 = min(ox + cw + 8, W), min(oy + chh + 8, H)
zone = np.zeros((H, W), bool)
zone[by0:by1, bx0:bx1] = True
debris = zone & (lum < 180) & ~((np.arange(W)[None, :] < 1180) & (np.arange(H)[:, None] < 500))
dimg = Image.fromarray((debris * 255).astype(np.uint8)).filter(
    ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1))
dm = np.asarray(dimg, np.float32)[..., None] / 255.0
out = out * (1 - dm) + PAPER * dm
print(f'清障 pass: 深色碎片 {int(debris.sum())} px')

# ── 3c. 地面阴影剥离（2026-09-12）：阴影抽成独立 RGBA 图层，横幅原位填纸 ──
# 人物层左移后底图阴影掉队 → 阴影也要能独立位移。阴影 = 半透明灰叠纸：
# pix = PAPER*(1-a) + C*a，反解 a 与 C 后合成回纸上与原图逐像素一致。
# 基线细线（深色，y≈945-948）用暗核竖向膨胀保护，横幅与阴影层都不含它。
out_dir = ROOT / 'public/motion'
pre = out.copy()  # 剥离前快照（残差校验基准）
lum3 = out.mean(2)
d3 = np.abs(out - PAPER).sum(2)
DC = 142.0  # |C-PAPER| 标定：阴影最深色 ~(193,192,183) 的 sum-abs
zx0, zx1, zy0, zy1 = 1080, 1840, 900, 990  # 阴影感兴趣区（实测 bbox 外扩）
zzone = np.zeros((H, W), bool)
zzone[zy0:zy1, zx0:zx1] = True
dark_core = zzone & (lum3 < 172)
# MaxFilter 只有方形核：转置后水平膨胀 7 等价竖向 ±3px（护住细线抗锯齿边）
dc_i = Image.fromarray((dark_core * 255).astype(np.uint8)).transpose(Image.ROTATE_90)
baseline = np.asarray(dc_i.filter(ImageFilter.MaxFilter(7)).transpose(Image.ROTATE_270),
                      np.float32) / 255.0 > 0
smask = zzone & (d3 > 8) & (lum3 >= 172) & ~baseline
sa = np.zeros((H, W), np.float32)
sa[smask] = np.clip((d3[smask] - 4) / DC, 0.02, 1.0)
sa = np.asarray(Image.fromarray((sa * 255).astype(np.uint8)).filter(
    ImageFilter.GaussianBlur(1.2)), np.float32) / 255.0
sa[~zzone] = 0.0
sa[baseline] = 0.0
sac = np.maximum(sa, 1e-3)[..., None]
scolor = np.clip(PAPER + (out - PAPER) / sac, 0, 255)
sys_, sxs_ = np.where(sa > 0.01)
sx0_, sx1_, sy0_, sy1_ = sxs_.min(), sxs_.max(), sys_.min(), sys_.max()
print(f'阴影 bbox: x {sx0_}..{sx1_}  y {sy0_}..{sy1_}  '
      f'({sx1_-sx0_+1}x{sy1_-sy0_+1})  px {len(sxs_)}')
srgba = np.dstack([scolor, sa * 255]).astype(np.uint8)
Image.fromarray(srgba, 'RGBA').crop((sx0_, sy0_, sx1_ + 1, sy1_ + 1)).save(
    out_dir / 'blog-shadow.webp', quality=90, method=6)
# 横幅填纸：阴影掩码轻微外扩+羽化，基线区域绝对不动
em = np.asarray(Image.fromarray(((sa > 0.005) * 255).astype(np.uint8)).filter(
    ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1)),
    np.float32)[..., None] / 255.0
em[baseline] = 0.0
out = out * (1 - em) + PAPER * em
comp = PAPER[None, None, :] * (1 - sa[..., None]) + scolor * sa[..., None]
serr = np.abs(comp - pre).sum(2)
serr = serr[(sa > 0.05) & ~baseline]
print(f'阴影合成残差: mean {serr.mean():.1f} max {serr.max():.0f} (≤20 视为一致)')
print(f'---- 阴影层 DOM 定位（banner 2048x1024, shadow {sx1_-sx0_+1}x{sy1_-sy0_+1}）----')
print(f'left   {sx0_ / W * 100:.4f}%')
print(f'top    {sy0_ / H * 100:.4f}%')
print(f'width  {(sx1_ - sx0_ + 1) / W * 100:.4f}%')
print(f'height {(sy1_ - sy0_ + 1) / H * 100:.4f}%')

# ── 4. 导出 ──
out_dir = ROOT / 'public/motion'
out_dir.mkdir(parents=True, exist_ok=True)
bi = Image.fromarray(out.astype(np.uint8))
bi.save(out_dir / 'blog-banner.webp', quality=82, method=6)
ci = Image.fromarray(cut.astype(np.uint8), 'RGBA').crop((cx0, cy0, cx1 + 1, cy1 + 1))
ci.save(out_dir / 'blog-character.webp', quality=90, method=6)

# ── 5. 校验 + DOM 百分比 ──
res = np.abs(out - PAPER).sum(2)
hole = m[..., 0] > 0.95
print(f'填充区残差: mean {res[hole].mean():.1f} max {res[hole].max():.0f} (sum-abs-diff, ≤30 视为干净)')
for f in ('blog-banner.webp', 'blog-character.webp'):
    p = out_dir / f
    print(f'{f}: {p.stat().st_size / 1024:.1f} KB')
print('---- DOM 定位（banner 2048x1024, character 623x915）----')
print(f'left   {ox / W * 100:.4f}%')
print(f'top    {oy / H * 100:.4f}%')
print(f'width  {cw / W * 100:.4f}%')
print(f'height {chh / H * 100:.4f}%')
