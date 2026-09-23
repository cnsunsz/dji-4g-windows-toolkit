#!/usr/bin/env python3
"""Generate transparent Mac-style squircle app icon (PNG + multi-size ICO). MIT."""
from __future__ import annotations

import io
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'build')
SIZE = 1024
ICO_SIZES = [256, 128, 64, 48, 32, 16]


def squircle_mask(size: int, margin: float = 18, n: float = 5.0) -> Image.Image:
    ss = 4
    big = Image.new('L', (size * ss, size * ss), 0)
    px = big.load()
    R = ((size / 2.0) - margin) * ss
    CX = CY = (size * ss - 1) / 2.0
    for y in range(size * ss):
        for x in range(size * ss):
            nx = abs(x - CX) / R
            ny = abs(y - CY) / R
            if nx ** n + ny ** n <= 1.0:
                px[x, y] = 255
    big = big.filter(ImageFilter.GaussianBlur(radius=ss * 0.55))
    return big.resize((size, size), Image.Resampling.LANCZOS)


def scrub_fringe(im: Image.Image) -> Image.Image:
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 10:
                px[x, y] = (0, 0, 0, 0)
            elif a < 48 and r > 235 and g > 235 and b > 235:
                px[x, y] = (0, 0, 0, 0)
    return im


def make_icon(size: int = SIZE) -> Image.Image:
    grad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / (size - 1)
        r = int(29 + (96 - 29) * t)
        g = int(78 + (165 - 78) * t)
        b = int(216 + (250 - 216) * t)
        gdraw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    hi = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hi).ellipse(
        [size * 0.05, -size * 0.15, size * 0.95, size * 0.55],
        fill=(255, 255, 255, 55),
    )
    hi = hi.filter(ImageFilter.GaussianBlur(radius=size * 0.04))
    grad = Image.alpha_composite(grad, hi)

    shaped = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    shaped.paste(grad, (0, 0))
    shaped.putalpha(squircle_mask(size, margin=int(size * 0.018), n=5.0))

    draw = ImageDraw.Draw(shaped)
    bar_w = int(size * 0.055)
    gap = int(size * 0.028)
    base_x = int(size * 0.22)
    base_y = int(size * 0.68)
    for i, h in enumerate([0.22, 0.36, 0.52, 0.70]):
        bh = int(size * h * 0.42)
        x0 = base_x + i * (bar_w + gap)
        draw.rounded_rectangle(
            [x0, base_y - bh, x0 + bar_w, base_y],
            radius=max(1, bar_w // 2),
            fill=(255, 255, 255, 245),
        )

    bx0, by0 = int(size * 0.48), int(size * 0.30)
    bx1, by1 = int(size * 0.82), int(size * 0.58)
    draw.rounded_rectangle(
        [bx0, by0, bx1, by1],
        radius=int(size * 0.06),
        fill=(255, 255, 255, 250),
    )
    draw.polygon(
        [
            (int(size * 0.55), by1 - 2),
            (int(size * 0.52), int(size * 0.68)),
            (int(size * 0.64), by1 - 2),
        ],
        fill=(255, 255, 255, 250),
    )
    dy = int((by0 + by1) / 2)
    cx = int((bx0 + bx1) / 2)
    dr = max(2, int(size * 0.018))
    for dx in (-int(size * 0.055), 0, int(size * 0.055)):
        draw.ellipse(
            [cx + dx - dr, dy - dr, cx + dx + dr, dy + dr],
            fill=(37, 99, 235, 230),
        )
    return scrub_fringe(shaped)


def write_ico(path: str, images: list[Image.Image]) -> None:
    """PNG-compressed multi-size ICO (Windows + electron-builder friendly)."""

    def png_bytes(im: Image.Image) -> bytes:
        buf = io.BytesIO()
        im.save(buf, format='PNG')
        return buf.getvalue()

    entries = []
    blobs = []
    offset = 6 + 16 * len(images)
    for im in images:
        blob = png_bytes(im)
        w = 0 if im.width >= 256 else im.width
        h = 0 if im.height >= 256 else im.height
        entries.append(struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(blob), offset))
        blobs.append(blob)
        offset += len(blob)
    with open(path, 'wb') as f:
        f.write(struct.pack('<HHH', 0, 1, len(images)))
        for e in entries:
            f.write(e)
        for b in blobs:
            f.write(b)


def verify(im: Image.Image, label: str) -> None:
    w, h = im.size
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        r, g, b, a = im.getpixel(xy)
        if a != 0:
            raise SystemExit(f'{label} corner {xy} not transparent: {(r, g, b, a)}')
    print(f'OK {label} {w}x{h} corners transparent, center={im.getpixel((w // 2, h // 2))}')


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    icon = make_icon(SIZE)
    png_path = os.path.join(OUT, 'icon.png')
    icon.save(png_path, 'PNG')
    verify(icon, 'icon.png')

    imgs = [scrub_fringe(icon.resize((s, s), Image.Resampling.LANCZOS)) for s in ICO_SIZES]
    for im, s in zip(imgs, ICO_SIZES):
        verify(im, f'{s}px')
    ico_path = os.path.join(OUT, 'icon.ico')
    write_ico(ico_path, imgs)
    print(f'Wrote {png_path} ({os.path.getsize(png_path)} bytes)')
    print(f'Wrote {ico_path} ({os.path.getsize(ico_path)} bytes) sizes={ICO_SIZES}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
