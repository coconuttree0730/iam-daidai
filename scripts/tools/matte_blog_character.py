#!/usr/bin/env python3
"""Color-based matte for 办公-博客.jpeg: remove background and left-side text, keep only the character."""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageMorph


def sample_background_color(rgb: np.ndarray, margin: int = 40) -> np.ndarray:
    """Median color of the four corner strips."""
    h, w = rgb.shape[:2]
    strips = [
        rgb[:margin, :],
        rgb[-margin:, :],
        rgb[:, :margin],
        rgb[:, -margin:],
    ]
    pixels = np.concatenate([s.reshape(-1, 3) for s in strips], axis=0)
    return np.median(pixels, axis=0)


def color_distance(rgb: np.ndarray, bg: np.ndarray, colorspace: str = "rgb") -> np.ndarray:
    if colorspace == "lab":
        # Simple sRGB -> linear RGB -> XYZ -> LAB approximation for perceptual distance.
        def srgb_to_linear(c: np.ndarray) -> np.ndarray:
            c = c.astype(np.float32) / 255.0
            return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

        def xyz_to_lab(xyz: np.ndarray) -> np.ndarray:
            ref = np.array([95.047, 100.0, 108.883], dtype=np.float32)
            xyz = xyz / ref
            eps = 216.0 / 24389.0
            k = 24389.0 / 27.0
            f = np.where(xyz > eps, xyz ** (1.0 / 3.0), (k * xyz + 16.0) / 116.0)
            L = 116.0 * f[..., 1] - 16.0
            a = 500.0 * (f[..., 0] - f[..., 1])
            b = 200.0 * (f[..., 1] - f[..., 2])
            return np.stack([L, a, b], axis=-1)

        def rgb_to_lab(c: np.ndarray) -> np.ndarray:
            c = srgb_to_linear(c)
            r, g, b_ = c[..., 0], c[..., 1], c[..., 2]
            x = r * 0.4124564 + g * 0.3575761 + b_ * 0.1804375
            y = r * 0.2126729 + g * 0.7151522 + b_ * 0.0721750
            z = r * 0.0193339 + g * 0.1191920 + b_ * 0.9503041
            return xyz_to_lab(np.stack([x, y, z], axis=-1) * 100.0)

        lab = rgb_to_lab(rgb)
        bg_lab = rgb_to_lab(bg.reshape(1, 1, 3))
        return np.linalg.norm(lab - bg_lab, axis=-1)

    return np.linalg.norm(rgb.astype(np.float32) - bg.astype(np.float32), axis=-1)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def matte_image(
    source: Path,
    output: Path,
    crop_left: int | None = None,
    colorspace: str = "lab",
    threshold_low: float = 8.0,
    threshold_high: float = 35.0,
    feather: int = 2,
    erode: int = 1,
    dilate: int = 1,
    debug: bool = False,
) -> dict:
    img = Image.open(source).convert("RGB")
    rgb = np.asarray(img, dtype=np.float32)
    bg = sample_background_color(rgb)

    dist = color_distance(rgb, bg, colorspace)

    # Distance -> alpha: close to background = transparent, far = opaque.
    alpha = smoothstep(threshold_low, threshold_high, dist)
    alpha = (alpha * 255).astype(np.uint8)

    # Morphological cleanup to remove noise and fill small holes.
    alpha_pil = Image.fromarray(alpha, "L")
    if erode > 0:
        alpha_pil = alpha_pil.filter(ImageFilter.MinFilter(erode * 2 + 1))
    if dilate > 0:
        alpha_pil = alpha_pil.filter(ImageFilter.MaxFilter(dilate * 2 + 1))
    if feather > 0:
        alpha_pil = alpha_pil.filter(ImageFilter.GaussianBlur(feather))
    alpha = np.asarray(alpha_pil, dtype=np.uint8)

    rgba = np.dstack((rgb.astype(np.uint8), alpha))
    result = Image.fromarray(rgba, "RGBA")

    if crop_left is not None:
        w, h = result.size
        crop_box = (crop_left, 0, w, h)
        result = result.crop(crop_box)

    output.parent.mkdir(parents=True, exist_ok=True)
    result.save(output)

    stats = {
        "bg_color": bg.tolist(),
        "mean_distance": float(dist.mean()),
        "opaque_pixels": int(np.count_nonzero(alpha > 250)),
    }
    if debug:
        print(stats)
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Matte blog office image")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--crop-left", type=int, default=None)
    parser.add_argument("--colorspace", choices=["rgb", "lab"], default="lab")
    parser.add_argument("--threshold-low", type=float, default=8.0)
    parser.add_argument("--threshold-high", type=float, default=35.0)
    parser.add_argument("--feather", type=int, default=2)
    parser.add_argument("--erode", type=int, default=1)
    parser.add_argument("--dilate", type=int, default=1)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    stats = matte_image(
        args.source,
        args.output,
        crop_left=args.crop_left,
        colorspace=args.colorspace,
        threshold_low=args.threshold_low,
        threshold_high=args.threshold_high,
        feather=args.feather,
        erode=args.erode,
        dilate=args.dilate,
        debug=args.debug,
    )
    print(args.output)
    print(stats)


if __name__ == "__main__":
    main()
