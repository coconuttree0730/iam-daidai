"""按绝对像素坐标采样 PNG 颜色。

环境里没有 PIL/Pillow，所以借 ffmpeg 把整图转成 rgb24 裸流再按偏移取值。
用法： python3 qa/probe-pixels.py <img> <x,y> [<x,y> ...]
"""
import subprocess
import sys
import os

img = sys.argv[1]
pts = [tuple(int(v) for v in a.split(",")) for a in sys.argv[2:]]

# 先问 ffmpeg 要尺寸，避免依赖文件头解析
probe = subprocess.run(
    ["ffprobe", "-v", "error", "-select_streams", "v:0",
     "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", img],
    capture_output=True, text=True, check=True,
)
w, h = (int(v) for v in probe.stdout.strip().split("x"))

raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", img, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    capture_output=True, check=True,
).stdout

print(f"{os.path.basename(img)}  {w}x{h}  raw={len(raw)} bytes")
for x, y in pts:
    if not (0 <= x < w and 0 <= y < h):
        print(f"  ({x},{y}) -> 越界")
        continue
    o = (y * w + x) * 3
    r, g, b = raw[o], raw[o + 1], raw[o + 2]
    luma = round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    print(f"  ({x},{y}) -> rgb({r},{g},{b})  luma={luma}")
