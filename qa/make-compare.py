"""把参考图与实现截图拼成对照图 —— 让用户不必起服务也能直接看效果。

用法： python qa/make-compare.py qa/out <参考图> qa/out/compare.png
"""
import sys, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
REF = sys.argv[2]
DEST = sys.argv[3]

W = 1280
GAP = 14
PAD = 16
LABEL_H = 30
BG = (28, 28, 30)
FG = (235, 235, 238)
ACCENT = (207, 10, 26)


def font(sz):
    for p in ["/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/TTF/DejaVuSans.ttf"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()


def fit(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    return im.resize((W, int(h * W / w)), Image.LANCZOS)


panels = [("参考目标（原始效果图）", fit(REF), True)]
for tag, label in [("scan-t0", "实现 · 指针在最左  t=0"),
                   ("scan-t50", "实现 · 指针居中  t=0.5"),
                   ("scan-t100", "实现 · 指针在最右  t=1")]:
    p = os.path.join(OUT, f"{tag}.png")
    if os.path.exists(p):
        panels.append((label, fit(p), False))

f_lab = font(20)
f_small = font(15)
heights = [im.size[1] + LABEL_H for _, im, _ in panels]
total_h = PAD * 2 + sum(heights) + GAP * (len(panels) - 1)
canvas = Image.new("RGB", (W + PAD * 2, total_h), BG)
d = ImageDraw.Draw(canvas)

y = PAD
for label, im, is_ref in panels:
    col = ACCENT if is_ref else FG
    d.rectangle([PAD, y, PAD + W, y + LABEL_H - 6], fill=(38, 38, 42) if not is_ref else (52, 12, 16))
    d.text((PAD + 10, y + 4), label, font=f_lab, fill=col)
    y += LABEL_H
    canvas.paste(im, (PAD, y))
    d.rectangle([PAD - 1, y - 1, PAD + W, y + im.size[1]], outline=(70, 70, 74))
    y += im.size[1] + GAP

d.text((PAD, total_h - 24),
       f"canvas {canvas.size[0]}x{canvas.size[1]}   ·   CDP 截图 1600x900@1x   ·   参考图 1920x1080",
       font=f_small, fill=(150, 150, 156))
canvas.save(DEST)
print(f"对照图已写出: {DEST}  {canvas.size[0]}x{canvas.size[1]}")
