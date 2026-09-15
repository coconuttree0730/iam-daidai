#!/usr/bin/env python3
"""Edge-aware matte for cartoon character on uniform background.

Separates foreground from background by flood-filling the background from the
image borders, using intensity edges as barriers. Light skin tones that are
close to the background color are still captured because they are enclosed by
dark outlines.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def binary_dilate(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    out = mask.copy()
    for _ in range(radius):
        out = (
            out
            | np.roll(out, 1, axis=0)
            | np.roll(out, -1, axis=0)
            | np.roll(out, 1, axis=1)
            | np.roll(out, -1, axis=1)
        )
    return out


def binary_erode(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    out = mask.copy()
    for _ in range(radius):
        out = (
            out
            & np.roll(out, 1, axis=0)
            & np.roll(out, -1, axis=0)
            & np.roll(out, 1, axis=1)
            & np.roll(out, -1, axis=1)
        )
    return out


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
            self.parent[ra] = rb


def label_components(mask: np.ndarray):
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    dsu = DSU()
    cur = 1
    for y in range(h):
        for x in range(w):
            if not mask[y, x]:
                continue
            left_lbl = labels[y, x - 1] if x > 0 else 0
            up_lbl = labels[y - 1, x] if y > 0 else 0
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
    ap.add_argument("--edge-threshold", type=float, default=18.0)
    ap.add_argument("--edge-dilate", type=int, default=2)
    ap.add_argument("--bg-feather", type=int, default=2)
    ap.add_argument("--solidify", type=int, default=3,
                    help="erode the kept component by this many pixels; interior becomes solid")
    ap.add_argument("--inspect", action="store_true")
    args = ap.parse_args()

    img = Image.open(args.source).convert("RGB")
    rgb = np.asarray(img, dtype=np.float32)
    h, w = rgb.shape[:2]

    # Intensity gradient as edge detector
    gray = rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114
    dx = np.abs(np.roll(gray, -1, axis=1) - np.roll(gray, 1, axis=1))
    dy = np.abs(np.roll(gray, -1, axis=0) - np.roll(gray, 1, axis=0))
    grad = np.hypot(dx, dy)
    edge = grad > args.edge_threshold
    edge = binary_dilate(edge, args.edge_dilate)

    # Flood fill background from borders, blocked by edge barrier
    background = np.zeros((h, w), dtype=bool)
    background[0, :] = ~edge[0, :]
    background[-1, :] = ~edge[-1, :]
    background[:, 0] = ~edge[:, 0]
    background[:, -1] = ~edge[:, -1]

    prev = np.zeros_like(background)
    iteration = 0
    while not np.array_equal(background, prev):
        prev = background.copy()
        background = binary_dilate(background, 3) & ~edge
        iteration += 1
        if iteration > 500:
            break

    foreground = ~background

    # Keep largest right-side component as the character
    labels, n = label_components(foreground)
    comps = []
    for c in range(1, n + 1):
        ys, xs = np.where(labels == c)
        if ys.size == 0:
            continue
        comps.append({
            "id": int(c),
            "area": int(ys.size),
            "cx": float(xs.mean()),
            "x0": int(xs.min()), "x1": int(xs.max()),
            "y0": int(ys.min()), "y1": int(ys.max()),
        })
    comps.sort(key=lambda d: -d["area"])

    if not comps:
        raise SystemExit("no foreground component found")

    if args.inspect:
        print(f"components: {len(comps)}")
        for d in comps[:8]:
            print(d)

    # Prefer component on the right half; if largest is on left (text), pick the
    # largest one with centroid in right half.
    right_half = [d for d in comps if d["cx"] > w * 0.45]
    main = right_half[0] if right_half else comps[0]
    keep_id = main["id"]
    keep_mask = labels == keep_id

    # Build alpha: solid interior + feathered boundary
    alpha = keep_mask.astype(np.float32)
    if args.solidify > 0:
        solid = keep_mask.copy()
        for _ in range(args.solidify):
            solid = binary_erode(solid)
        alpha = np.where(solid, 1.0, alpha)

    # Feather only the boundary region (do not blur the solid interior)
    if args.bg_feather > 0:
        boundary = binary_dilate(keep_mask, args.bg_feather) & ~binary_erode(keep_mask, args.bg_feather)
        alpha8 = (alpha * 255).astype(np.uint8)
        blurred = np.asarray(Image.fromarray(alpha8, "L").filter(ImageFilter.GaussianBlur(args.bg_feather)), dtype=np.float32) / 255.0
        alpha = np.where(boundary, blurred, alpha)

    rgba = np.dstack((rgb.astype(np.uint8), np.rint(np.clip(alpha, 0, 1) * 255).astype(np.uint8)))
    out = Image.fromarray(rgba, "RGBA")

    # Tight crop
    ys, xs = np.where(keep_mask)
    pad = 4
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(w, int(xs.max()) + pad + 1)
    y0 = max(0, int(ys.min()) - pad)
    y1 = min(h, int(ys.max()) + pad + 1)
    out = out.crop((x0, y0, x1, y1))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.output)
    print(args.output, "size", out.size, "kept_area", main["area"])


if __name__ == "__main__":
    main()
