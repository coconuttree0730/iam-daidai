#!/usr/bin/env python3
"""Matte the blog-office image keeping only the character (largest component), dropping text."""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def sample_background(rgb: np.ndarray, margin: int = 40) -> np.ndarray:
    strips = [rgb[:margin], rgb[-margin:], rgb[:, :margin], rgb[:, -margin:]]
    px = np.concatenate([s.reshape(-1, 3) for s in strips], axis=0)
    return np.median(px, axis=0)


def lab_distance(rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    def srgb_to_linear(c):
        c = c.astype(np.float32) / 255.0
        return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

    def xyz_to_lab(xyz):
        ref = np.array([95.047, 100.0, 108.883], dtype=np.float32)
        xyz = xyz / ref
        eps = 216.0 / 24389.0
        k = 24389.0 / 27.0
        f = np.where(xyz > eps, xyz ** (1.0 / 3.0), (k * xyz + 16.0) / 116.0)
        L = 116.0 * f[..., 1] - 16.0
        a = 500.0 * (f[..., 0] - f[..., 1])
        b = 200.0 * (f[..., 1] - f[..., 2])
        return np.stack([L, a, b], axis=-1)

    def rgb_to_lab(c):
        c = srgb_to_linear(c)
        r, g, bb = c[..., 0], c[..., 1], c[..., 2]
        x = r * 0.4124564 + g * 0.3575761 + bb * 0.1804375
        y = r * 0.2126729 + g * 0.7151522 + bb * 0.0721750
        z = r * 0.0193339 + g * 0.1191920 + bb * 0.9503041
        return xyz_to_lab(np.stack([x, y, z], axis=-1) * 100.0)

    lab = rgb_to_lab(rgb)
    bg_lab = rgb_to_lab(bg.reshape(1, 1, 3))
    return np.linalg.norm(lab - bg_lab, axis=-1)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


class DSU:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        p = self.parent
        root = x
        while p[root] != root:
            root = p[root]
        while p[x] != root:
            p[x], x = root, p[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # attach smaller to larger arbitrarily (root label kept)
            self.parent[ra] = rb


def binary_erode(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    out = np.zeros_like(mask)
    # 4-connected erosion
    out[1:-1, 1:-1] = (
        mask[1:-1, 1:-1] &
        mask[0:-2, 1:-1] &
        mask[2:, 1:-1] &
        mask[1:-1, 0:-2] &
        mask[1:-1, 2:]
    )
    return out


def label_components(mask: np.ndarray):
    """Two-pass 4-connected labeling. Returns (labels, n)."""
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    dsu = DSU()
    cur = 1
    for y in range(h):
        row = labels[y]
        mrow = mask[y]
        up = labels[y - 1] if y > 0 else None
        for x in range(w):
            if not mrow[x]:
                continue
            left_lbl = row[x - 1] if x > 0 else 0
            up_lbl = up[x] if up is not None else 0
            if left_lbl == 0 and up_lbl == 0:
                labels[y, x] = cur
                dsu.parent[cur] = cur
                cur += 1
            elif left_lbl != 0 and up_lbl != 0:
                if left_lbl != up_lbl:
                    dsu.union(left_lbl, up_lbl)
                labels[y, x] = dsu.find(up_lbl)
            elif left_lbl != 0:
                labels[y, x] = dsu.find(left_lbl)
            else:
                labels[y, x] = dsu.find(up_lbl)
    # resolve
    out = np.zeros_like(labels)
    for y in range(h):
        for x in range(w):
            if labels[y, x]:
                out[y, x] = dsu.find(labels[y, x])
    return out, cur - 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--min-area", type=int, default=2000)
    ap.add_argument("--threshold-low", type=float, default=8.0)
    ap.add_argument("--threshold-high", type=float, default=35.0)
    ap.add_argument("--feather", type=int, default=2)
    ap.add_argument("--keep-overlapping", action="store_true",
                    help="also keep components that overlap the largest component horizontally")
    ap.add_argument("--inspect", action="store_true")
    args = ap.parse_args()

    img = Image.open(args.source).convert("RGB")
    rgb = np.asarray(img, dtype=np.float32)
    h, w = rgb.shape[:2]
    bg = sample_background(rgb)
    dist = lab_distance(rgb, bg)
    alpha = smoothstep(args.threshold_low, args.threshold_high, dist)
    mask = alpha > 0.5

    labels, n = label_components(mask)
    comps = []
    for c in range(1, n + 1):
        ys, xs = np.where(labels == c)
        if ys.size == 0:
            continue
        area = int(ys.size)
        if area < args.min_area:
            continue
        comps.append({
            "id": int(c),
            "area": area,
            "cx": float(xs.mean()),
            "cy": float(ys.mean()),
            "x0": int(xs.min()), "x1": int(xs.max()),
            "y0": int(ys.min()), "y1": int(ys.max()),
        })
    comps.sort(key=lambda d: -d["area"])

    if args.inspect:
        print(f"bg={bg.tolist()} total_components(>= {args.min_area}px)={len(comps)}")
        for d in comps[:12]:
            print(d)

    # Keep the largest component (the character). Also keep any component that
    # horizontally overlaps the largest one's core (to catch split hair/shadow).
    if not comps:
        raise SystemExit("no foreground component found")
    main = comps[0]
    keep_ids = {main["id"]}
    if args.keep_overlapping:
        for d in comps[1:]:
            overlap = not (d["x1"] < main["x0"] - 20 or d["x0"] > main["x1"] + 20)
            if overlap:
                keep_ids.add(d["id"])

    keep_mask = np.isin(labels, list(keep_ids))

    # Fill holes inside the kept component(s) so that light skin/shirt areas
    # close to the background color remain solid instead of turning transparent.
    bg_labels, bg_n = label_components(~keep_mask)
    border_mask = np.zeros_like(keep_mask)
    border_mask[0, :] = True
    border_mask[-1, :] = True
    border_mask[:, 0] = True
    border_mask[:, -1] = True
    exterior_bg_ids = set()
    for c in range(1, bg_n + 1):
        comp_mask = bg_labels == c
        if np.any(comp_mask & border_mask):
            exterior_bg_ids.add(c)
    all_bg_ids = set(range(1, bg_n + 1))
    hole_ids = all_bg_ids - exterior_bg_ids
    for c in hole_ids:
        keep_mask |= bg_labels == c

    # Build RGBA
    alpha8 = np.rint(alpha * 255).astype(np.uint8)
    # feather
    alpha_pil = Image.fromarray(alpha8, "L")
    if args.feather:
        alpha_pil = alpha_pil.filter(ImageFilter.GaussianBlur(args.feather))
    alpha_f = np.asarray(alpha_pil, dtype=np.float32) / 255.0
    # apply keep mask
    alpha_f = alpha_f * keep_mask.astype(np.float32)

    # Shrink alpha by 1 px to remove light background fringe on the outer edge.
    alpha_f = alpha_f * binary_erode(alpha_f > 0.01).astype(np.float32)

    # Solidify interior: pixels well inside the kept component become fully opaque,
    # so light skin/shadow details that happen to be close to the background color
    # do not turn into holes. Edge pixels keep their feathered alpha for anti-aliasing.
    solid_mask = keep_mask.copy()
    for _ in range(max(1, args.feather)):
        solid_mask = binary_erode(solid_mask)
    alpha_f = np.where(solid_mask, 1.0, alpha_f)

    rgba = np.dstack((rgb.astype(np.uint8), np.rint(alpha_f * 255).astype(np.uint8)))
    out = Image.fromarray(rgba, "RGBA")

    # tight crop around kept region with padding
    ys, xs = np.where(keep_mask)
    pad = 6
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(w, int(xs.max()) + pad + 1)
    y0 = max(0, int(ys.min()) - pad)
    y1 = min(h, int(ys.max()) + pad + 1)
    out = out.crop((x0, y0, x1, y1))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.output)
    print(args.output, "size", out.size, "kept_components", len(keep_ids))


if __name__ == "__main__":
    main()
