"""沿一条直线打印亮度剖面，用来判断「卡片白底里有没有被人物像素打断」。

做法：先问 ffprobe 尺寸，再用 ffmpeg 输出 rgb24 裸流，最后按偏移取亮度。
若卡片在人物之上，卡片本体范围内应是一段连续高亮；若人物在上，
则中间会出现一段低亮度（发/肤色）。

用法： python3 qa/probe-line.py <img> <x0> <y0> <x1> <y1> <n>
"""
import subprocess
import sys
import os

img = sys.argv[1]
x0, y0, x1, y1, n = (float(v) for v in sys.argv[2:7])
n = int(n)

w, h = (int(v) for v in subprocess.run(
    ["ffprobe", "-v", "error", "-select_streams", "v:0",
     "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", img],
    capture_output=True, text=True, check=True).stdout.strip().split("x"))

raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", img, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    capture_output=True, check=True).stdout

print(f"{os.path.basename(img)}  {w}x{h}   线 ({x0:.0f},{y0:.0f}) -> ({x1:.0f},{y1:.0f})  {n} 点")
samples = []
for i in range(n):
    t = i / (n - 1)
    x, y = round(x0 + (x1 - x0) * t), round(y0 + (y1 - y0) * t)
    o = (y * w + x) * 3
    r, g, b = raw[o], raw[o + 1], raw[o + 2]
    samples.append((x, y, round(0.2126 * r + 0.7152 * g + 0.0722 * b)))

bar = "".join("#" if l < 90 else ("+" if l < 200 else ".") for _, _, l in samples)
print(f"  剖面(# = 暗, + = 中间, . = 亮): {bar}")
runs, cur, start = [], None, 0
for i, (_, _, l) in enumerate(samples):
    kind = "dark" if l < 90 else ("mid" if l < 200 else "light")
    if kind != cur:
        if cur is not None:
            runs.append((cur, start, i - 1))
        cur, start = kind, i
runs.append((cur, start, len(samples) - 1))
for kind, a, b in runs:
    xs, ys = samples[a][0], samples[b][0]
    print(f"    {kind:5}  %3d–%3d 点  x {xs}–{ys}")
