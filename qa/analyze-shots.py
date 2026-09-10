"""对 CDP 截图做像素级核验 —— DOM 读数证明不了「合成结果对不对」。

要回答的问题：
  1) 页面底色是否与参考图一致（抠色是否真的透出纸面，而不是黑块/绿块）
  2) 立绘区域是否真的有内容（不是空白）
  3) 绿幕残留：g 明显高于 r/b 的像素占比（应≈0）
  4) 红色点缀（#cf0a1a 系）是否出现
  5) 相邻帧截图是否真的发生变化（帧随动生效的像素级证据）

用法： python qa/analyze-shots.py qa/out <参考图>
"""
import sys, json, glob, os
import numpy as np
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else "qa/out"
REF = sys.argv[2] if len(sys.argv) > 2 else None


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.int16)


def paper_color(a, m=28):
    """取四边内缩区域的中位色，避开中心立绘"""
    h, w, _ = a.shape
    strips = [a[:m, :, :].reshape(-1, 3), a[-m:, :, :].reshape(-1, 3),
              a[:, :m, :].reshape(-1, 3), a[:, -m:, :].reshape(-1, 3)]
    return np.median(np.concatenate(strips), axis=0)


def green_residue(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    m = (g > r + 45) & (g > b + 45) & (g > 90)
    return float(m.mean()), int(m.sum())


def stats(a, name):
    h, w, _ = a.shape
    pc = paper_color(a)
    gr, gn = green_residue(a)
    # 立绘区域（中列、上 2/3）
    fig = a[int(h * 0.10):int(h * 0.72), int(w * 0.36):int(w * 0.64)]
    fig_std = float(fig.reshape(-1, 3).std(axis=0).mean())
    # 极暗像素占比 —— 黑块残留的特征
    dark = float((fig.reshape(-1, 3).max(axis=1) < 48).mean())
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    red = float(((r > 140) & (r > g + 70) & (r > b + 70)).mean())
    return {"file": os.path.basename(name), "size": [h, w],
            "paper_rgb": [int(x) for x in pc], "green_residue_ratio": round(gr, 6),
            "green_px": gn, "figure_std": round(fig_std, 2), "figure_dark_ratio": round(dark, 4),
            "red_ratio": round(red, 5)}


shots = sorted(glob.glob(os.path.join(OUT, "scan-*.png")))
if not shots:
    print("没有找到 scan-*.png"); sys.exit(1)

base = load(shots[0])
print("=== 逐帧像素统计 ===")
rows = []
for p in shots:
    s = stats(load(p), p)
    rows.append(s)
    print(f"  {s['file']:16s} paper={s['paper_rgb']} 绿残留={s['green_residue_ratio']:.2e}({s['green_px']}px) "
          f"立绘std={s['figure_std']:6.2f} 暗块={s['figure_dark_ratio']:.3f} 红={s['red_ratio']:.4f}")

print("\n=== 帧随动的像素级证据（相邻帧立绘区差异）===")
for a, b in zip(shots, shots[1:]):
    A, B = load(a), load(b)
    h, w, _ = A.shape
    reg = (slice(int(h * 0.10), int(h * 0.72)), slice(int(w * 0.36), int(w * 0.64)))
    diff = np.abs(A[reg] - B[reg]).mean()
    changed = float((np.abs(A[reg] - B[reg]).max(axis=2) > 12).mean())
    print(f"  {os.path.basename(a)} → {os.path.basename(b)}  平均差={diff:6.2f}  变化像素占比={changed:.3f}")

if REF and os.path.exists(REF):
    r = load(REF)
    rp = paper_color(r, 20)
    h, w, _ = r.shape
    r_all = r.reshape(-1, 3)
    rr, rg, rb = r[..., 0], r[..., 1], r[..., 2]
    ref_red = float(((rr > 140) & (rr > rg + 70) & (rr > rb + 70)).mean())
    print("\n=== 与参考图对比 ===")
    print(f"  参考图尺寸 {w}x{h}   纸面色 {[int(x) for x in rp]}   红占比={ref_red:.4f}")
    print(f"  实现纸面色 {rows[0]['paper_rgb']}   红占比={rows[0]['red_ratio']:.4f}")
    print(f"  纸面色差 Δ={[int(abs(int(a)-int(b))) for a, b in zip(rows[0]['paper_rgb'], rp)]}")
    gr, gn = green_residue(r)
    print(f"  参考图绿残留={gr:.2e}  实现={rows[0]['green_residue_ratio']:.2e}")

print("\n=== 判定 ===")
ok = True
for s in rows:
    for chk, cond in [
        ("无绿幕残留", s["green_residue_ratio"] < 1e-4),
        ("立绘区有内容", s["figure_std"] > 8),
        ("无黑块残留", s["figure_dark_ratio"] < 0.02),
        ("红色点缀存在", s["red_ratio"] > 1e-4),
    ]:
        if not cond:
            ok = False
            print(f"  ❌ {s['file']}: {chk}")
print("  ✅ 全部截图通过像素核验" if ok else "  ⚠ 存在未通过项")
