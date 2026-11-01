#!/usr/bin/env python3
"""Render the ABYSS PROTOCOL boot film and looping background.

Everything is generated procedurally from the DeepSeek whale mark, so the
plugin ships original footage instead of borrowed stock video.
"""
from __future__ import annotations

import argparse
import math
import multiprocessing
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "whale-source.png")

W, H = 1920, 1080
FPS = 30
BOOT_SECONDS = 10.0
BG_SECONDS = 12.0
BG_FPS = 24

C_BG = np.array([2.0, 5.0, 12.0])
C_CYAN = np.array([64.0, 240.0, 255.0])
C_TEAL = np.array([24.0, 188.0, 214.0])
C_BLUE = np.array([58.0, 110.0, 255.0])
C_VIOLET = np.array([172.0, 86.0, 255.0])
C_GOLD = np.array([255.0, 190.0, 96.0])
C_WHITE = np.array([224.0, 246.0, 255.0])


def smoothstep(a: float, b: float, x: float) -> float:
    if a == b:
        return 1.0 if x >= b else 0.0
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def ease(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3.0 - 2.0 * x)


def load_whale() -> tuple[Image.Image, Image.Image]:
    img = Image.open(SRC).convert("RGBA")
    arr = np.asarray(img, dtype=np.float32)
    lum = arr[..., 0] * 0.2126 + arr[..., 1] * 0.7152 + arr[..., 2] * 0.0722
    # The app icon stores transparent pixels as black; alpha is the only reliable
    # way to keep the rounded-square backdrop out of the mask.
    solid = (lum < 118.0) & (arr[..., 3] > 200.0)
    ys, xs = np.where(solid)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    m = Image.fromarray((solid[box[1]:box[3], box[0]:box[2]] * 255).astype(np.uint8), "L")
    # A light blur keeps the silhouette from looking like a cut-out sticker.
    m = m.filter(ImageFilter.GaussianBlur(0.8))
    scale = 1000.0 / m.width
    m = m.resize((1000, max(1, round(m.height * scale))), Image.LANCZOS)
    edge = m.filter(ImageFilter.MaxFilter(5))
    edge = Image.fromarray(
        np.clip(np.asarray(edge, dtype=np.int16) - np.asarray(m.filter(ImageFilter.MinFilter(5)), dtype=np.int16), 0, 255).astype(np.uint8),
        "L",
    )
    return m, edge


WHALE, WHALE_EDGE = load_whale()


def radial_base() -> np.ndarray:
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    nx = (xx - W * 0.5) / (W * 0.5)
    ny = (yy - H * 0.46) / (H * 0.5)
    r = np.sqrt(nx * nx * 0.72 + ny * ny)
    glow = np.clip(1.0 - r * 0.9, 0.0, 1.0) ** 2.2
    out = np.zeros((H, W, 3), dtype=np.float32)
    out[..., 0] = C_BG[0] + 7.0 * glow
    out[..., 1] = C_BG[1] + 20.0 * glow
    out[..., 2] = C_BG[2] + 42.0 * glow
    return out


BASE = radial_base()


def vignette() -> np.ndarray:
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    nx = (xx - W / 2) / (W / 2)
    ny = (yy - H / 2) / (H / 2)
    r2 = nx * nx + ny * ny
    return np.clip(1.08 - 0.26 * r2, 0.35, 1.0)[..., None]


VIGNETTE = vignette()


def scanlines() -> np.ndarray:
    yy = np.arange(H, dtype=np.float32)
    s = 1.0 - 0.045 * ((yy % 4.0) < 1.0)
    return np.repeat(s[:, None, None], W, axis=1)


SCAN = scanlines()


def star_field(count: int, seed: int):
    rng = np.random.default_rng(seed)
    x = rng.uniform(0, W, count)
    y = rng.uniform(0, H, count)
    z = rng.uniform(0.25, 1.0, count)
    phase = rng.uniform(0, math.tau, count)
    return x, y, z, phase


STARS = star_field(260, 7)
STARS_FAR = star_field(420, 19)


def add_points(canvas: np.ndarray, xs, ys, zs, phase, t: float, color, gain: float, twinkle: float = 0.4):
    for x, y, z, ph in zip(xs, ys, zs, phase):
        a = (0.35 + twinkle * (0.5 + 0.5 * math.sin(t * 1.7 + ph))) * z * gain
        if a <= 0.002:
            continue
        xi, yi = int(x) % W, int(y) % H
        rad = 1.0 + 2.2 * z
        x0, x1 = max(0, int(xi - rad - 2)), min(W, int(xi + rad + 3))
        y0, y1 = max(0, int(yi - rad - 2)), min(H, int(yi + rad + 3))
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        d2 = (xx - xi) ** 2 + (yy - yi) ** 2
        spot = np.exp(-d2 / (2.0 * rad * rad))
        canvas[y0:y1, x0:x1] += spot[..., None] * color * a


def draw_rays(canvas: np.ndarray, t: float, strength: float, seed: int = 3):
    rng = np.random.default_rng(seed)
    for i in range(9):
        phase = rng.uniform(0, math.tau)
        drift = 120 * math.sin(t * 0.22 + phase)
        topx = W * (0.18 + 0.64 * i / 8) + drift
        width_top = 30 + 70 * rng.random()
        width_bot = 190 + 360 * rng.random()
        alpha = (0.035 + 0.035 * (0.5 + 0.5 * math.sin(t * 0.4 + phase * 2))) * strength
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        prog = yy / H
        cx = topx + (W * 0.5 - topx) * prog * 0.4
        half = width_top + (width_bot - width_top) * prog
        d = np.abs(xx - cx) / np.maximum(half, 1.0)
        beam = np.clip(1.0 - d, 0.0, 1.0) ** 2.4
        beam *= np.clip(1.0 - prog * 0.45, 0.0, 1.0)
        canvas += beam[..., None] * C_TEAL * alpha
    # soft haze at the waterline
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    haze = np.exp(-((yy - H * 0.70) ** 2) / (2 * (H * 0.20) ** 2))
    haze *= 0.5 + 0.5 * np.sin(xx * 0.004 + t * 0.5)
    canvas += np.clip(haze, 0, 1)[..., None] * C_TEAL * 0.012 * strength


def draw_grid(canvas: np.ndarray, t: float, strength: float):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    horizon = int(H * 0.70)
    # horizontal receding lines
    for i in range(1, 17):
        p = (i / 17.0) ** 1.9
        y = int(horizon + (H - horizon) * p)
        a = int(26 * (1.0 - p * 0.7) * strength)
        d.line([(0, y), (W, y)], fill=(40, 190, 220, a), width=1)
    # vanishing-point lines
    vp = (W // 2, horizon)
    for i in range(-12, 13):
        x_bottom = W // 2 + i * 170
        a = int(22 * strength)
        d.line([vp, (x_bottom, H)], fill=(30, 160, 210, a), width=1)
    # moving data pulses along the grid
    off = (t * 0.11) % 1.0
    for i in range(5):
        p = (i / 5.0 + off) % 1.0
        y = int(horizon + (H - horizon) * (p ** 1.9))
        a = int(55 * (1.0 - p) * strength)
        d.line([(0, y), (W, y)], fill=(90, 240, 255, a), width=1)
    layer = layer.filter(ImageFilter.GaussianBlur(0.4))
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)


def whale_layer(t: float, *, cx: float, cy: float, width: int, rotate: float, alpha: float, rim: float, glow: float):
    m = WHALE.copy()
    if rotate:
        m = m.rotate(rotate, resample=Image.BICUBIC, expand=True)
        e = WHALE_EDGE.rotate(rotate, resample=Image.BICUBIC, expand=True)
    else:
        e = WHALE_EDGE.copy()
    ratio = width / m.width
    size = (max(1, int(width)), max(1, int(round(m.height * ratio))))
    m = m.resize(size, Image.BILINEAR)
    e = e.resize(size, Image.BILINEAR)
    x = int(cx - size[0] / 2)
    y = int(cy - size[1] / 2)
    full = Image.new("L", (W, H), 0)
    full.paste(m, (x, y))
    edge_full = Image.new("L", (W, H), 0)
    edge_full.paste(e, (x, y))
    return full, edge_full, (x, y, size[0], size[1])


def add_whale(canvas: np.ndarray, t: float, **kw):
    mask, edge, box = whale_layer(t, **kw)
    ma = np.asarray(mask, dtype=np.float32) / 255.0
    ea = np.asarray(edge.filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float32) / 255.0
    x, y, w, h = box
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    u = np.clip((xx - x) / max(w, 1), 0, 1)
    v = np.clip((yy - y) / max(h, 1), 0, 1)
    # body fill: cyan crown → violet belly, very translucent so the reef shows through
    body = (
        np.array([32.0, 126.0, 190.0]) * (1 - v[..., None])
        + np.array([84.0, 56.0, 210.0]) * v[..., None]
    )
    body += np.array([30.0, 90.0, 120.0]) * (1.0 - u[..., None]) * 0.25
    canvas += body * (ma * kw.get("alpha", 0.18))[..., None]
    # rim light: hot cyan on one side, violet on the other
    rim_col = C_CYAN * (0.78 - 0.48 * u[..., None]) + C_VIOLET * (0.20 + 0.52 * u[..., None]) + C_WHITE * 0.10
    canvas += rim_col * (ea * kw.get("rim", 0.85))[..., None]
    # a second, offset edge reads as chromatic dispersion
    ghost = Image.fromarray((np.asarray(edge, dtype=np.float32) * 0.65).astype(np.uint8), "L")
    ghost = ghost.transform(ghost.size, Image.AFFINE, (1, 0, -2.2, 0, 1, 1.4), resample=Image.BILINEAR)
    gaa = np.asarray(ghost.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32) / 255.0
    canvas += C_VIOLET * (gaa * kw.get("rim", 0.85) * 0.34)[..., None]
    # soft outer bloom
    halo = np.asarray(mask.filter(ImageFilter.GaussianBlur(26)), dtype=np.float32) / 255.0
    canvas += (C_BLUE * 0.45 + C_CYAN * 0.25) * (halo * kw.get("glow", 0.24))[..., None]
    # neural traces inside the body: flowing horizontal fibres, no graph paper
    lines = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(lines)
    for i in range(1, 7):
        yy0 = y + h * (0.14 + 0.105 * i)
        pts = []
        for j in range(0, 61):
            uu = j / 60
            pts.append((x + w * uu, yy0 + math.sin(uu * math.tau * 1.7 + i * 0.9 + t * 0.9) * h * 0.022))
        d.line(pts, fill=110, width=1)
    lines = Image.fromarray(np.clip(np.asarray(lines, dtype=np.float32) * ma * 255, 0, 255).astype(np.uint8), "L")
    lines = lines.filter(ImageFilter.GaussianBlur(0.6))
    la = np.asarray(lines, dtype=np.float32) / 255.0
    canvas += (C_CYAN * 0.45 + C_BLUE * 0.55) * (la * 0.12)[..., None]
    # eye: a single hot point at the head
    ex, ey = x + w * 0.545, y + h * 0.495
    yy2, xx2 = np.mgrid[0:H, 0:W].astype(np.float32)
    d2 = (xx2 - ex) ** 2 + (yy2 - ey) ** 2
    spot = np.exp(-d2 / (2 * 5.5 ** 2))
    canvas += C_WHITE * (spot * 0.9)[..., None]
    canvas += C_CYAN * (np.exp(-d2 / (2 * 26.0 ** 2)) * 0.16)[..., None]
    return box


def add_foreground(canvas: np.ndarray, t: float, strength: float):
    rng = np.random.default_rng(41)
    for i in range(70):
        speed = 0.12 + 0.5 * rng.random()
        x = (rng.uniform(0, W) + t * speed * 40) % W
        y = (rng.uniform(0, H) - t * speed * 18) % H
        r = 0.6 + 2.2 * rng.random() ** 2
        a = (0.10 + 0.22 * rng.random()) * strength
        color = C_CYAN if i % 3 else C_GOLD
        yy, xx = np.mgrid[max(0, int(y) - 3):min(H, int(y) + 4), max(0, int(x) - 3):min(W, int(x) + 4)].astype(np.float32)
        if xx.size == 0:
            continue
        d2 = (xx - x) ** 2 + (yy - y) ** 2
        canvas[max(0, int(y) - 3):min(H, int(y) + 4), max(0, int(x) - 3):min(W, int(x) + 4)] += (
            np.exp(-d2 / (2 * r * r))[..., None] * color * a
        )


def sonar(canvas: np.ndarray, t: float, strength: float):
    for k in range(4):
        p = ((t * 0.24 + k * 0.25) % 1.0)
        if p < 0.02:
            continue
        r = 70 + p * 780
        a = (1.0 - p) ** 2 * 0.5 * strength
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        d = np.sqrt((xx - W * 0.5) ** 2 + (yy - H * 0.46) ** 2)
        ring = np.exp(-((d - r) ** 2) / (2 * 5.0 ** 2))
        canvas += C_CYAN * (ring * a)[..., None]
        ring2 = np.exp(-((d - r) ** 2) / (2 * 26.0 ** 2))
        canvas += C_TEAL * (ring2 * a * 0.18)[..., None]


def warp(canvas: np.ndarray, t: float, start: float = 7.2, end: float = 9.0):
    p = smoothstep(start, end, t)
    if p <= 0:
        return
    rng = np.random.default_rng(99)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = W * 0.5, H * 0.47
    for i in range(95):
        ang = rng.uniform(0, math.tau)
        r0 = 120 + 620 * rng.random()
        ln = (80 + 700 * rng.random()) * p
        a = int(118 * p * (0.3 + 0.7 * rng.random()))
        x0 = cx + math.cos(ang) * r0
        y0 = cy + math.sin(ang) * r0
        x1 = cx + math.cos(ang) * (r0 + ln)
        y1 = cy + math.sin(ang) * (r0 + ln)
        d.line([(x0, y0), (x1, y1)], fill=(120, 235, 255, a), width=1 if i % 3 else 2)
    layer = layer.filter(ImageFilter.GaussianBlur(0.7))
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 1.65)


def flash(canvas: np.ndarray, t: float):
    f = math.exp(-((t - 8.55) ** 2) / (2 * 0.10 ** 2)) * 0.55
    f += math.exp(-((t - 9.15) ** 2) / (2 * 0.16 ** 2)) * 0.12
    if f > 0.001:
        canvas += C_CYAN * f


def grade(canvas: np.ndarray, t: float, grain: float = 3.4):
    canvas *= VIGNETTE
    canvas *= SCAN
    # teal-lift in shadows, warm highlight kiss
    lum = canvas.mean(axis=2, keepdims=True)
    canvas += (C_TEAL * 0.012) * (1 - np.clip(lum / 90.0, 0, 1))
    canvas += (C_GOLD * 0.010) * np.clip((lum - 120.0) / 120.0, 0, 1)
    rng = np.random.default_rng(int(t * 1000) + 3)
    canvas += rng.normal(0, grain, (H, W, 1)).astype(np.float32)
    return np.clip(canvas, 0, 255).astype(np.uint8)


def tech_ring(canvas: np.ndarray, t: float, cx: float, cy: float, radius: float, strength: float):
    if strength <= 0.002:
        return
    layer = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(layer)
    rot = t * 7.0
    # three broken arcs with different radii and speeds
    specs = [(1.00, 0.6, 0.0, 2.0), (1.06, 0.28, 2.1, 1.0), (0.93, 0.22, 4.2, 3.0)]
    for scale, alpha, phase, width in specs:
        r = radius * scale
        start = rot * (1.0 if scale >= 1 else -1.2) + phase * 57.0
        for k in range(3):
            a0 = start + k * 120.0
            a1 = a0 + 78.0
            bb = (cx - r, cy - r, cx + r, cy + r)
            d.arc(bb, a0, a1, fill=int(255 * alpha), width=int(width))
    # radial ticks
    for i in range(48):
        ang = math.radians(i * 7.5 + rot * 0.25)
        r0 = radius * (1.12 if i % 4 else 1.15)
        r1 = radius * (1.18 if i % 4 else 1.22)
        a = 70 if i % 4 else 130
        d.line([
            (cx + math.cos(ang) * r0, cy + math.sin(ang) * r0),
            (cx + math.cos(ang) * r1, cy + math.sin(ang) * r1),
        ], fill=a, width=1)
    layer = layer.filter(ImageFilter.GaussianBlur(0.45))
    la = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += (C_CYAN * 0.75 + C_BLUE * 0.25) * (la * 0.34 * strength)[..., None]
    # bloom pass
    lb = np.asarray(layer.filter(ImageFilter.GaussianBlur(18.0)), dtype=np.float32) / 255.0
    canvas += C_TEAL * (lb * 0.10 * strength)[..., None]


def data_rain(canvas: np.ndarray, t: float, strength: float):
    if strength <= 0.002:
        return
    rng = np.random.default_rng(77)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(46):
        x = rng.uniform(0, W)
        speed = rng.uniform(40, 160)
        yy = (rng.uniform(0, H) + t * speed) % (H + 260) - 130
        ln = rng.uniform(26, 130)
        a = int(rng.uniform(10, 34) * strength)
        col = (70, 220, 255, a) if i % 5 else (150, 110, 255, a)
        d.line([(x, yy), (x, yy + ln)], fill=col, width=1)
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)


def frame_boot(t: float) -> Image.Image:
    canvas = BASE.copy()
    fade_in = smoothstep(0.0, 1.2, t)
    draw_rays(canvas, t, 0.9 * fade_in)
    add_points(canvas, *STARS_FAR, t, C_TEAL, 0.55 * fade_in, 0.6)
    add_points(canvas, *STARS, t, C_CYAN, 0.85 * fade_in, 0.4)
    draw_grid(canvas, t, 0.8 * smoothstep(1.0, 3.0, t))
    sonar(canvas, t, smoothstep(0.3, 1.5, t) * (1 - smoothstep(6.0, 7.5, t)))
    data_rain(canvas, t, 0.65)
    tech_ring(canvas, t, W * 0.5, H * 0.455, 590, smoothstep(1.2, 3.4, t) * (1 - smoothstep(7.8, 9.2, t)))
    # whale entrance: particles gather, then the body resolves
    appear = smoothstep(1.7, 4.6, t)
    push = ease(smoothstep(5.2, 8.6, t))
    width = int(860 + 130 * push + 10 * math.sin(t * 0.8))
    cx = W * 0.5 + 18 * math.sin(t * 0.55) + 10 * push
    cy = H * 0.455 - 8 * push
    add_whale(
        canvas,
        t,
        cx=cx,
        cy=cy,
        width=width,
        rotate=-4.0 + 1.3 * math.sin(t * 0.5),
        alpha=0.20 * appear,
        rim=1.05 * appear,
        glow=0.34 * appear,
    )
    # a constellation of motes around the mark, converging in the first 4s
    rng = np.random.default_rng(5)
    for i in range(150):
        ang = rng.uniform(0, math.tau)
        base_r = 240 + 620 * rng.random()
        rr = base_r * (1.0 - 0.82 * appear)
        x = cx + math.cos(ang) * rr + 12 * math.sin(t + i)
        y = cy + math.sin(ang) * rr * 0.55 + 8 * math.cos(t * 0.8 + i)
        a = (0.25 + 0.5 * rng.random()) * (0.3 + 0.7 * appear)
        color = C_CYAN if i % 4 else C_GOLD
        xi, yi = int(x), int(y)
        if 0 <= xi < W and 0 <= yi < H:
            canvas[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2] += color * a * 0.30
    add_foreground(canvas, t, 0.8)
    warp(canvas, t)
    flash(canvas, t)
    # slow push-in on the eye
    return Image.fromarray(grade(canvas, t))


def frame_bg(t: float) -> Image.Image:
    # t is 0..BG_SECONDS and every motion term is periodic over the loop.
    canvas = BASE.copy() * 0.92
    draw_rays(canvas, t, 0.7)
    add_points(canvas, *STARS_FAR, t * 0.35, C_TEAL, 0.4, 0.7)
    add_points(canvas, *STARS, t * 0.5, C_CYAN, 0.55, 0.5)
    draw_grid(canvas, t, 0.55)
    # distant whale on the left, almost a rumour
    add_whale(
        canvas,
        t,
        cx=W * 0.24 + 34 * math.sin(math.tau * t / BG_SECONDS),
        cy=H * 0.56 + 10 * math.sin(math.tau * t / (BG_SECONDS / 2)),
        width=530,
        rotate=-5 + 1.2 * math.sin(math.tau * t / BG_SECONDS),
        alpha=0.075,
        rim=0.32,
        glow=0.12,
    )
    # hero whale on the right, breathing in place
    add_whale(
        canvas,
        t,
        cx=W * 0.775 + 46 * math.sin(math.tau * t / BG_SECONDS + 1.1),
        cy=H * 0.43 + 16 * math.sin(math.tau * t / (BG_SECONDS / 2) + 0.4),
        width=790 + 12 * math.sin(math.tau * t / (BG_SECONDS / 2)),
        rotate=-7 + 1.5 * math.sin(math.tau * t / BG_SECONDS + 0.4),
        alpha=0.105,
        rim=0.46,
        glow=0.18,
    )
    add_foreground(canvas, t * 0.35, 0.6)
    # gentle breathing bloom
    canvas += C_TEAL * (0.006 * (0.5 + 0.5 * math.sin(math.tau * t / (BG_SECONDS / 3))))
    return Image.fromarray(grade(canvas, t, grain=2.0))


def _render_chunk(job):
    """Worker: render [start, end) into one raw RGB file."""
    name, start, end, fps, part = job
    frames = globals()[name]
    with open(part, "wb") as out:
        for i in range(start, end):
            img = frames(i / fps)
            out.write(np.asarray(img, dtype=np.uint8).tobytes())
            if i % 10 == 0:
                print(f"  {name}: {i}/{end}", flush=True)
    return part


def write_video(path: str, frames, seconds: float, crf: int, fps: int = FPS, jobs: int = 4):
    n = int(round(seconds * fps))
    jobs = max(1, min(jobs, n))
    tmpdir = tempfile.mkdtemp(prefix="abyss-frames-")
    parts = []
    try:
        if jobs == 1:
            parts.append(_render_chunk((frames.__name__, 0, n, fps, os.path.join(tmpdir, "part-000.raw"))))
        else:
            ctx = multiprocessing.get_context("fork")
            chunk = (n + jobs - 1) // jobs
            work = []
            for j in range(jobs):
                start = j * chunk
                end = min(n, start + chunk)
                if start >= end:
                    continue
                work.append((frames.__name__, start, end, fps, os.path.join(tmpdir, f"part-{j:03d}.raw")))
            with ctx.Pool(len(work)) as pool:
                parts.extend(pool.map(_render_chunk, work))

        ff = [
            "ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
            "-an", "-c:v", "libx264", "-preset", "slow", "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{seconds:.3f}", path,
        ]
        p = subprocess.Popen(ff, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        assert p.stdin is not None
        for part in parts:
            with open(part, "rb") as source:
                shutil.copyfileobj(source, p.stdin, 4 * 1024 * 1024)
        p.stdin.close()
        err = p.stderr.read().decode("utf-8", "replace") if p.stderr else ""
        if p.wait() != 0:
            raise SystemExit(err[-4000:])
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def make_audio(path: str):
    sr = 48000
    n = int(BOOT_SECONDS * sr)
    t = np.arange(n, dtype=np.float64) / sr
    rng = np.random.default_rng(12)
    # deep drone with a slow beat
    drone = (
        0.28 * np.sin(math.tau * 36.71 * t + 0.2)
        + 0.14 * np.sin(math.tau * 55.0 * t + 1.1)
        + 0.08 * np.sin(math.tau * 73.42 * t + 2.3)
    )
    drone *= 0.6 + 0.4 * np.sin(math.tau * 0.13 * t)
    # rising pad, a minor chord that opens up
    pad = np.zeros(n)
    for f, a, ph in [(110.0, 0.10, 0.2), (164.81, 0.07, 1.3), (220.0, 0.055, 2.1), (329.63, 0.035, 0.8)]:
        det = 0.15 * np.sin(math.tau * 0.07 * t + ph)
        pad += a * np.sin(math.tau * (f + det) * t + ph)
    pad *= np.clip(t / 2.4, 0, 1) * np.clip((9.6 - t) / 1.2, 0, 1)
    # sonar pings
    ping = np.zeros(n)
    for at, f0 in [(0.85, 1046.5), (4.55, 880.0), (7.65, 1318.5)]:
        i0 = int(at * sr)
        m = min(n - i0, int(1.2 * sr))
        tt = np.arange(m) / sr
        env = np.exp(-tt * 4.2)
        ping[i0:i0 + m] += 0.10 * env * np.sin(math.tau * (f0 * tt - 140 * tt * tt))
        # echo
        d = int(0.19 * sr)
        if i0 + d + m < n:
            ping[i0 + d:i0 + d + m] += 0.035 * env * np.sin(math.tau * (f0 * 0.99 * tt))
    # whale call: a downward glissando with vibrato and a soft harmonic
    call = np.zeros(n)
    i0 = int(2.35 * sr)
    m = min(n - i0, int(3.4 * sr))
    tt = np.arange(m) / sr
    f = 190 - 115 * (tt / 3.4) + 6 * np.sin(math.tau * 5.1 * tt)
    phase = math.tau * np.cumsum(f) / sr
    env = np.clip(tt / 0.45, 0, 1) * np.clip((3.4 - tt) / 1.1, 0, 1)
    call[i0:i0 + m] += 0.12 * env * (np.sin(phase) + 0.35 * np.sin(2 * phase) + 0.12 * np.sin(3 * phase))
    # riser into the warp
    riser = np.zeros(n)
    i0 = int(6.7 * sr)
    m = n - i0
    tt = np.arange(m) / sr
    f = 180 * np.exp(tt * 0.30) + 40
    phase = math.tau * np.cumsum(f) / sr
    env = np.clip(tt / 1.7, 0, 1) ** 2
    riser[i0:] += 0.055 * env * np.sin(phase)
    noise = rng.normal(0, 1, n)
    # cheap spectral shaping: one-pole low-pass + high-pass
    lp = np.zeros(n)
    a = 0.008
    for i in range(1, n):
        lp[i] = lp[i - 1] + a * (noise[i] - lp[i - 1])
    hp = noise - lp
    noise_env = np.clip((t - 6.8) / 1.8, 0, 1) ** 2 * np.clip((9.1 - t) / 0.4, 0, 1)
    riser += 0.035 * hp * noise_env
    # impact
    impact = np.zeros(n)
    i0 = int(8.55 * sr)
    m = min(n - i0, int(1.4 * sr))
    tt = np.arange(m) / sr
    impact[i0:i0 + m] += (0.38 * np.exp(-tt * 3.0) * np.sin(math.tau * (48 * tt - 10 * tt * tt))
                          + 0.10 * np.exp(-tt * 7.0) * rng.normal(0, 1, m))
    # simple stereo width
    left = drone + pad + ping + call + riser + impact
    right = drone + pad * 0.96 + ping * 0.9 + call * 1.03 + riser + impact
    # a couple of stereo delays for space
    for delay, gain in [(0.13, 0.16), (0.27, 0.10), (0.41, 0.06)]:
        d = int(delay * sr)
        left[d:] += right[:-d] * gain
        right[d:] += left[:-d] * gain * 0.9
    mix = np.stack([left, right], axis=1)
    # gentle saturation and fades
    mix = np.tanh(mix * 1.25) * 0.9
    fade = np.ones(n)
    fade[: int(0.4 * sr)] = np.linspace(0, 1, int(0.4 * sr))
    fade[-int(0.7 * sr):] = np.linspace(1, 0, int(0.7 * sr))
    mix *= fade[:, None]
    peak = np.max(np.abs(mix)) or 1.0
    mix = (mix / peak * 0.92 * 32767).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(mix.tobytes())


def make_neon_audio(path: str):
    sr = 48000
    n = int(NEON_SECONDS * sr)
    t = np.arange(n, dtype=np.float64) / sr
    rng = np.random.default_rng(44)
    mix = np.zeros(n)
    # 90 BPM sub pulses
    beat = 60.0 / 90.0
    for k in range(int(NEON_SECONDS / beat) + 1):
        i0 = int(k * beat * sr)
        m = min(n - i0, int(0.55 * sr))
        if m <= 0:
            break
        tt = np.arange(m) / sr
        env = np.exp(-tt * 9.0)
        mix[i0:i0 + m] += 0.30 * env * np.sin(math.tau * (52 - 18 * tt) * tt)
        mix[i0:i0 + m] += 0.09 * env * np.sin(math.tau * 104 * tt)
    # minor pad
    pad = np.zeros(n)
    for f, a, ph in ((110.0, 0.09, 0.2), (130.81, 0.07, 1.1), (164.81, 0.06, 2.4), (220.0, 0.04, 0.7)):
        pad += a * np.sin(math.tau * f * t + ph + 0.5 * np.sin(math.tau * 0.09 * t))
    pad *= np.clip(t / 1.2, 0, 1) * np.clip((7.2 - t) / 0.7, 0, 1)
    mix += pad
    # 16th-note arpeggio, slightly detuned and panned by delay
    notes = [220.0, 261.63, 329.63, 440.0, 329.63, 261.63]
    step = beat / 4
    arp = np.zeros(n)
    for k in range(int(NEON_SECONDS / step)):
        i0 = int(k * step * sr)
        m = min(n - i0, int(0.22 * sr))
        if m <= 0:
            break
        tt = np.arange(m) / sr
        f = notes[k % len(notes)] * 2
        env = np.exp(-tt * 18.0)
        arp[i0:i0 + m] += 0.055 * env * (
            np.sin(math.tau * f * tt) + 0.35 * np.sin(math.tau * 2 * f * tt)
        )
    mix += arp
    # digital glitch bursts
    for at, dur in ((2.05, 0.09), (4.7, 0.07), (5.9, 0.05)):
        i0 = int(at * sr)
        m = min(n - i0, int(dur * sr))
        tt = np.arange(m) / sr
        mix[i0:i0 + m] += 0.12 * np.exp(-tt * 8) * rng.normal(0, 1, m)
    # riser + impact
    i0 = int(5.0 * sr)
    m = n - i0
    tt = np.arange(m) / sr
    f = 160 * np.exp(tt * 0.55) + 40
    ph = math.tau * np.cumsum(f) / sr
    mix[i0:] += 0.06 * (np.clip(tt / 1.25, 0, 1) ** 2) * np.sin(ph)
    noise = rng.normal(0, 1, m)
    lp = np.zeros(m)
    a = 0.02
    for i in range(1, m):
        lp[i] = lp[i - 1] + a * (noise[i] - lp[i - 1])
    mix[i0:] += 0.05 * (noise - lp) * (np.clip(tt / 1.25, 0, 1) ** 2)
    i0 = int(6.25 * sr)
    m = min(n - i0, int(1.2 * sr))
    tt = np.arange(m) / sr
    mix[i0:i0 + m] += 0.42 * np.exp(-tt * 4.0) * np.sin(math.tau * (46 * tt - 8 * tt * tt))
    mix[i0:i0 + m] += 0.12 * np.exp(-tt * 9.0) * rng.normal(0, 1, m)
    # stereo delay
    left = mix.copy()
    right = mix.copy()
    for delay, gain in ((0.12, 0.18), (0.24, 0.11), (0.36, 0.06)):
        d = int(delay * sr)
        left[d:] += right[:-d] * gain
        right[d:] += left[:-d] * gain * 0.85
    stereo = np.stack([left, right], axis=1)
    stereo = np.tanh(stereo * 1.35) * 0.9
    fade = np.ones(n)
    fade[: int(0.15 * sr)] = np.linspace(0, 1, int(0.15 * sr))
    fade[-int(0.6 * sr):] = np.linspace(1, 0, int(0.6 * sr))
    stereo *= fade[:, None]
    peak = np.max(np.abs(stereo)) or 1.0
    stereo = (stereo / peak * 0.94 * 32767).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(stereo.tobytes())


def make_neon_poster(path: str):
    frame_bg = neon_bg(3.0)
    frame_bg.resize((1280, 720), Image.LANCZOS).save(path, "JPEG", quality=88, optimize=True)


def mux_audio(video: str, audio: str, out: str):
    subprocess.run([
        "ffmpeg", "-y", "-i", video, "-i", audio,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
        "-movflags", "+faststart", out,
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["preview", "boot", "bg", "all", "neon", "neon-preview", "vermilion"], default="preview")
    ap.add_argument("--time", type=float, default=4.2)
    ap.add_argument("--jobs", type=int, default=4)
    args = ap.parse_args()
    os.makedirs(os.path.join(ROOT, "skins", "abyss"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "preview"), exist_ok=True)
    if args.mode in ("preview", "boot", "all"):
        frame_boot(args.time).save(os.path.join(ROOT, "preview", "boot-frame.png"))
        print("saved preview/boot-frame.png")
    if args.mode in ("preview", "bg", "all"):
        frame_bg(args.time % BG_SECONDS).save(os.path.join(ROOT, "preview", "bg-frame.png"))
        print("saved preview/bg-frame.png")
    if args.mode in ("boot", "all"):
        tmp = os.path.join(ROOT, "skins", "abyss", "boot-video.mp4")
        wav = os.path.join(ROOT, "skins", "abyss", "boot.wav")
        out = os.path.join(ROOT, "skins", "abyss", "boot.mp4")
        write_video(tmp, frame_boot, BOOT_SECONDS, 21, jobs=args.jobs)
        make_audio(wav)
        mux_audio(tmp, wav, out)
        os.remove(tmp)
        os.remove(wav)
        print("saved skins/abyss/boot.mp4")
    if args.mode in ("bg", "all"):
        out = os.path.join(ROOT, "skins", "abyss", "background.mp4")
        write_video(out, frame_bg, BG_SECONDS, 25, fps=BG_FPS, jobs=args.jobs)
        frame_bg(3.0).resize((1280, 720), Image.LANCZOS).save(
            os.path.join(ROOT, "skins", "abyss", "poster.jpg"), "JPEG", quality=88, optimize=True
        )
        print("saved skins/abyss/{background.mp4,poster.jpg}")
    if args.mode == "neon-preview":
        neon_boot(args.time).save(os.path.join(ROOT, "preview", "neon-boot-preview.png"))
        neon_bg(args.time % NEON_BG_SECONDS).save(os.path.join(ROOT, "preview", "neon-bg-preview.png"))
        print("saved neon previews")
    if args.mode == "vermilion":
        skin = os.path.join(ROOT, "skins", "vermilion")
        os.makedirs(skin, exist_ok=True)
        tmp = os.path.join(skin, "boot-video.mp4")
        wav = os.path.join(skin, "boot.wav")
        boot = os.path.join(skin, "boot.mp4")
        bg = os.path.join(skin, "background.mp4")
        write_video(tmp, vermilion_boot, VERMILION_SECONDS, 21, fps=VERMILION_FPS, jobs=args.jobs)
        make_vermilion_audio(wav)
        mux_audio(tmp, wav, boot)
        os.remove(tmp)
        os.remove(wav)
        write_video(bg, vermilion_bg, VERMILION_BG_SECONDS, 24, fps=VERMILION_BG_FPS, jobs=args.jobs)
        make_vermilion_poster(os.path.join(skin, "poster.jpg"))
        print("saved skins/vermilion/{boot.mp4,background.mp4,poster.jpg}")
    if args.mode == "neon":
        skin = os.path.join(ROOT, "skins", "neon")
        os.makedirs(skin, exist_ok=True)
        tmp = os.path.join(skin, "boot-video.mp4")
        wav = os.path.join(skin, "boot.wav")
        boot = os.path.join(skin, "boot.mp4")
        bg = os.path.join(skin, "background.mp4")
        write_video(tmp, neon_boot, NEON_SECONDS, 21, fps=NEON_FPS, jobs=args.jobs)
        make_neon_audio(wav)
        mux_audio(tmp, wav, boot)
        os.remove(tmp)
        os.remove(wav)
        write_video(bg, neon_bg, NEON_BG_SECONDS, 24, fps=NEON_BG_FPS, jobs=args.jobs)
        make_neon_poster(os.path.join(skin, "poster.jpg"))
        print("saved skins/neon/{boot.mp4,background.mp4,poster.jpg}")




# ═════════════════════ NEON GRID skin ═════════════════════
C_MAGENTA = np.array([255.0, 58.0, 214.0])
C_CYAN2 = np.array([80.0, 250.0, 245.0])
C_LIME = np.array([190.0, 255.0, 110.0])
NEON_SECONDS = 8.0
NEON_BG_SECONDS = 12.0
NEON_FPS = 30
NEON_BG_FPS = 24


def neon_base() -> np.ndarray:
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    nx = (xx - W * 0.5) / (W * 0.5)
    ny = (yy - H * 0.56) / (H * 0.5)
    r = np.sqrt(nx * nx * 0.55 + ny * ny)
    horizon = np.clip(1.0 - np.abs(ny) * 2.2, 0, 1) ** 3
    out = np.zeros((H, W, 3), dtype=np.float32)
    out[..., 0] = 5.0 + 30.0 * horizon + 3.0 * (1 - r)
    out[..., 1] = 3.0 + 7.0 * horizon + 1.5 * (1 - r)
    out[..., 2] = 12.0 + 50.0 * horizon + 5.0 * (1 - r)
    return out


NEON_BASE = neon_base()


def neon_grid(canvas: np.ndarray, t: float, strength: float, speed: float = 0.18):
    if strength <= 0.002:
        return
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    horizon = int(H * 0.56)
    vp = (W // 2, horizon)
    # floor + ceiling receding lines
    for i in range(22):
        p = ((i / 22.0 + t * speed) % 1.0)
        for direction, base_y in ((1, H), (-1, 0)):
            span = abs(base_y - horizon)
            y = int(horizon + direction * span * (p ** 2.35))
            a = int((112 if direction > 0 else 55) * (1.0 - p * 0.55) * strength)
            col = (110, 255, 255, a) if i % 3 else (255, 80, 225, a)
            d.line([(0, y), (W, y)], fill=col, width=2 if i % 4 == 0 else 1)
    # side walls: converge to vp
    for i in range(-26, 27):
        xb = W // 2 + i * (W / 19.0)
        a = int(70 * strength)
        d.line([vp, (xb, H)], fill=(80, 235, 255, a), width=1)
        d.line([vp, (xb, 0)], fill=(255, 80, 210, int(a * 0.6)) if i % 3 else (80, 235, 255, a), width=1)
    # bright traveling rails
    for k in range(4):
        p = ((k / 4.0 + t * speed * 1.7) % 1.0)
        y = int(horizon + (H - horizon) * (p ** 2.35))
        a = int(150 * (1.0 - p) * strength)
        d.line([(0, y), (W, y)], fill=(210, 255, 255, a), width=3)
    layer = layer.filter(ImageFilter.GaussianBlur(0.5))
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)


def neon_city(canvas: np.ndarray, t: float, strength: float):
    if strength <= 0.002:
        return
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    horizon = H * 0.56
    rng = np.random.default_rng(2027)
    for side in (-1, 1):
        for i in range(11):
            depth = i / 10.0
            w = (40 + 54 * rng.random()) * (1.2 - depth * 0.4)
            h = (80 + 390 * rng.random()) * (1.25 - depth * 0.55)
            x = W * 0.5 + side * (W * (0.09 + depth * 0.34))
            y0 = horizon - h
            x0 = x - w / 2
            x1 = x + w / 2
            a = int((130 - depth * 52) * strength)
            col = (255, 80, 225, a) if i % 2 else (80, 240, 255, a)
            d.rectangle([x0, y0, x1, horizon], outline=col, width=2)
            for wy in range(int(y0 + 10), int(horizon - 5), 14):
                for wx in range(int(x0 + 6), int(x1 - 4), 12):
                    if rng.random() < 0.22:
                        d.rectangle([wx, wy, wx + 3, wy + 4], fill=(180, 250, 255, int(a * 0.7)))
    layer = layer.filter(ImageFilter.GaussianBlur(0.55))
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)


def neon_core(canvas: np.ndarray, t: float, cx: float, cy: float, radius: float, charge: float, spin: float = 1.0):
    if charge <= 0.002:
        return
    layer = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(layer)
    rot = t * 28.0 * spin
    # outer segmented rings
    for idx, (scale, width, speed, alpha) in enumerate(
        ((1.0, 2, 1.0, 190), (1.12, 1, -0.7, 90), (0.86, 1, 1.5, 120))
    ):
        r = radius * scale
        start = rot * speed + idx * 41
        for k in range(6):
            a0 = start + k * 60
            d.arc([cx - r, cy - r, cx + r, cy + r], a0, a0 + 34, fill=alpha, width=width)
    # diamond core
    s = radius * (0.33 + 0.12 * math.sin(t * 2.4))
    pts = [(cx, cy - s), (cx + s, cy), (cx, cy + s), (cx - s, cy)]
    d.polygon(pts, outline=255, width=2)
    inner = s * 0.48
    d.polygon([(cx, cy - inner), (cx + inner, cy), (cx, cy + inner), (cx - inner, cy)], outline=200, width=1)
    d.line([(cx - s * 1.6, cy), (cx + s * 1.6, cy)], fill=110, width=1)
    d.line([(cx, cy - s * 1.6), (cx, cy + s * 1.6)], fill=110, width=1)
    layer = layer.filter(ImageFilter.GaussianBlur(0.6))
    la = np.asarray(layer, dtype=np.float32) / 255.0
    glow = np.asarray(layer.filter(ImageFilter.GaussianBlur(radius * 0.16)), dtype=np.float32) / 255.0
    canvas += (C_CYAN2 * 0.65 + C_MAGENTA * 0.35) * (la * 1.25 * charge)[..., None]
    canvas += (C_MAGENTA * 0.55 + C_CYAN2 * 0.3) * (glow * 0.58 * charge)[..., None]
    # hot centre
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d2 = (xx - cx) ** 2 + (yy - cy) ** 2
    canvas += C_WHITE * (np.exp(-d2 / (2 * (radius * 0.025) ** 2)) * 0.85 * charge)[..., None]


def neon_bloom(canvas: np.ndarray, strength: float = 0.9):
    lum = canvas.max(axis=2)
    mask = np.clip((lum - 100.0) / 155.0, 0.0, 1.0)
    layer = Image.fromarray((mask * 255.0).astype(np.uint8), "L")
    blurred = np.asarray(layer.filter(ImageFilter.GaussianBlur(26.0)), dtype=np.float32) / 255.0
    canvas += canvas * (blurred * strength)[..., None]
    canvas += (C_MAGENTA * 0.5 + C_CYAN2 * 0.5) * (blurred * 18.0 * strength)[..., None]


def neon_boot(t: float) -> Image.Image:
    canvas = NEON_BASE.copy()
    fade = smoothstep(0.0, 0.9, t)
    rush = smoothstep(0.9, 4.4, t)
    charge = smoothstep(0.7, 2.8, t)
    warp_t = smoothstep(5.2, 6.35, t)
    neon_grid(canvas, t, 0.9 * fade, 0.12 + 0.35 * rush + 0.9 * warp_t)
    neon_city(canvas, t, 0.65 * fade)
    add_points(canvas, *STARS_FAR, t, C_CYAN2, 0.38 * fade, 0.5)
    add_points(canvas, *STARS, t, C_MAGENTA, 0.45 * fade, 0.35)
    data_rain(canvas, t, 1.1 * fade)
    neon_core(canvas, t, W * 0.5, H * 0.5, 205 + 35 * charge, charge, 1.0 + 3.0 * warp_t)
    # tunnel speed lines
    if warp_t > 0:
        rng = np.random.default_rng(303)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        for i in range(120):
            ang = rng.uniform(0, math.tau)
            r0 = 160 + 760 * rng.random()
            ln = (40 + 520 * rng.random()) * warp_t
            a = int(120 * warp_t * (0.2 + 0.8 * rng.random()))
            col = (255, 80, 230, a) if i % 2 else (120, 255, 255, a)
            d.line(
                [
                    (W / 2 + math.cos(ang) * r0, H / 2 + math.sin(ang) * r0),
                    (W / 2 + math.cos(ang) * (r0 + ln), H / 2 + math.sin(ang) * (r0 + ln)),
                ],
                fill=col,
                width=1,
            )
        layer = layer.filter(ImageFilter.GaussianBlur(0.8))
        arr = np.asarray(layer, dtype=np.float32) / 255.0
        canvas += arr[..., :3] * (arr[..., 3:4] * 1.4)
    neon_glitch(canvas, t, max(0.0, math.sin(t * 2.1) - 0.82) * 5.0 + warp_t * 0.7)
    neon_flash(canvas, t)
    neon_bloom(canvas, 0.68)
    return Image.fromarray(grade(canvas, t), "RGB")


def neon_bg(t: float) -> Image.Image:
    canvas = NEON_BASE.copy()
    neon_grid(canvas, t, 0.7, 0.16)
    neon_city(canvas, t, 0.5)
    add_points(canvas, *STARS_FAR, t * 0.3, C_CYAN2, 0.28, 0.5)
    add_points(canvas, *STARS, t * 0.4, C_MAGENTA, 0.32, 0.4)
    data_rain(canvas, t, 0.9)
    neon_core(
        canvas,
        t,
        W * 0.64 + 40 * math.sin(math.tau * t / NEON_BG_SECONDS),
        H * 0.46 + 12 * math.sin(math.tau * t / (NEON_BG_SECONDS / 2)),
        175 + 8 * math.sin(math.tau * t / (NEON_BG_SECONDS / 3)),
        0.9,
        0.3,
    )
    neon_glitch(canvas, t, max(0.0, math.sin(t * 1.3) - 0.9) * 3.0)
    neon_bloom(canvas, 0.48)
    return Image.fromarray(grade(canvas, t, grain=1.8), "RGB")


def neon_glitch(canvas: np.ndarray, t: float, amount: float):
    if amount <= 0.01:
        return
    rng = np.random.default_rng(int(t * 1000) + 17)
    for _ in range(int(2 + amount * 5)):
        y0 = int(rng.uniform(0, H - 40))
        h = int(rng.uniform(6, 46))
        shift = int(rng.uniform(-26, 26) * min(1.0, amount))
        canvas[y0:y0 + h] = np.roll(canvas[y0:y0 + h], shift, axis=1)
        if rng.random() < 0.45:
            canvas[y0:y0 + h, :, 0] += 18 * amount
            canvas[y0:y0 + h, :, 2] += 12 * amount
    # chromatic tear
    canvas[..., 0] = np.roll(canvas[..., 0], 1, axis=1)
    canvas[..., 2] = np.roll(canvas[..., 2], -1, axis=1)


def neon_flash(canvas: np.ndarray, t: float):
    f = math.exp(-((t - 6.25) ** 2) / (2 * 0.10 ** 2)) * 0.62
    f += math.exp(-((t - 7.2) ** 2) / (2 * 0.18 ** 2)) * 0.10
    if f > 0.001:
        canvas += (C_MAGENTA * 0.55 + C_CYAN2 * 0.45) * f


# ═════════════════════ VERMILION DAWN skin ═════════════════════
C_CRIMSON = np.array([196.0, 22.0, 36.0])
C_RED = np.array([236.0, 48.0, 54.0])
C_GOLD = np.array([255.0, 197.0, 96.0])
C_IVORY = np.array([255.0, 244.0, 218.0])
VERMILION_SECONDS = 8.0
VERMILION_BG_SECONDS = 12.0
VERMILION_FPS = 30
VERMILION_BG_FPS = 24


def vermilion_base() -> np.ndarray:
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    nx = (xx - W * 0.5) / (W * 0.5)
    ny = (yy - H * 0.64) / (H * 0.5)
    r = np.sqrt(nx * nx * 0.7 + ny * ny)
    horizon = np.clip(1.0 - np.abs(ny) * 2.1, 0, 1) ** 2.6
    out = np.zeros((H, W, 3), dtype=np.float32)
    out[..., 0] = 12.0 + 58.0 * horizon + 3.0 * (1 - r)
    out[..., 1] = 2.0 + 11.0 * horizon + 1.0 * (1 - r)
    out[..., 2] = 4.0 + 18.0 * horizon + 2.0 * (1 - r)
    return out


VERMILION_BASE = vermilion_base()


def star_points(cx: float, cy: float, radius: float, inner: float = 0.42, rotation: float = -math.pi / 2):
    pts = []
    for i in range(10):
        ang = rotation + i * math.pi / 5
        rr = radius if i % 2 == 0 else radius * inner
        pts.append((cx + math.cos(ang) * rr, cy + math.sin(ang) * rr))
    return pts


def vermilion_clouds(canvas: np.ndarray, t: float, strength: float):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rng = np.random.default_rng(818)
    for i in range(26):
        y = H * (0.12 + 0.52 * rng.random())
        x = (W * (0.05 + 0.9 * rng.random()) + t * (4 + 9 * rng.random())) % (W + 400) - 200
        w = 180 + 420 * rng.random()
        h = 18 + 64 * rng.random()
        a = int((10 + 18 * rng.random()) * strength)
        col = (180, 30, 26, a) if i % 3 else (220, 84, 46, a)
        d.ellipse([x - w / 2, y - h / 2, x + w / 2, y + h / 2], fill=col)
    layer = layer.filter(ImageFilter.GaussianBlur(26))
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)


def vermilion_hall(canvas: np.ndarray, t: float, strength: float, reveal: float, glow: float):
    if strength <= 0.002:
        return
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = W * 0.5
    hz = H * 0.80
    red_fill = (72, 7, 12, int(160 * strength))
    gold = (255, 197, 96, int(210 * strength))
    gold_soft = (255, 197, 96, int(95 * strength))

    # platform, three receding steps
    for i, (w, y) in enumerate(((1420, 0.875), (1320, 0.905), (1220, 0.935))):
        yy = int(H * y)
        d.rectangle([cx - w / 2, yy, cx + w / 2, yy + 18], fill=(48, 5, 9, int(190 * strength)), outline=gold_soft, width=1)

    # side wings
    for side in (-1, 1):
        x0 = cx + side * 760
        x1 = cx + side * 430
        y0 = int(H * 0.520)
        y1 = hz
        d.rectangle([min(x0, x1), y0, max(x0, x1), y1], fill=red_fill, outline=gold_soft, width=2)
        for k in range(4):
            xx = min(x0, x1) + 34 + k * 74
            d.line([(xx, y0 + 28), (xx, y1 - 18)], fill=gold_soft, width=2)

    # central body
    body_top = int(H * 0.455)
    d.rectangle([cx - 500, body_top, cx + 500, hz], fill=red_fill, outline=gold, width=3)

    # columns (the colonnade)
    for i in range(-6, 7):
        if i == 0:
            continue
        x = cx + i * 78
        top = body_top + 50
        d.rectangle([x - 11, top, x + 11, hz - 8], fill=(88, 9, 14, int(180 * strength)), outline=gold, width=2)
        # capital / base
        d.rectangle([x - 18, top - 9, x + 18, top], fill=(110, 12, 16, int(180 * strength)), outline=gold_soft, width=1)
        d.rectangle([x - 18, hz - 18, x + 18, hz - 8], fill=(110, 12, 16, int(180 * strength)), outline=gold_soft, width=1)

    # central doorway with warm light
    door_w = 118
    door_top = int(H * 0.585)
    d.rectangle([cx - door_w / 2, door_top, cx + door_w / 2, hz], fill=(255, 186, 92, int(120 * strength)), outline=gold, width=3)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d2 = ((xx - cx) / (door_w * 0.55)) ** 2 + ((yy - (door_top + 60)) / 120.0) ** 2
    door_glow = np.exp(-d2 * 3.0) * 0.20 * strength
    canvas += C_GOLD * door_glow[..., None]

    # double-eave roof
    roof = [
        (cx - 660, int(H * 0.455)),
        (cx - 540, int(H * 0.385)),
        (cx - 420, int(H * 0.345)),
        (cx, int(H * 0.305)),
        (cx + 420, int(H * 0.345)),
        (cx + 540, int(H * 0.385)),
        (cx + 660, int(H * 0.455)),
    ]
    d.polygon(roof, fill=(58, 5, 10, int(220 * strength)), outline=gold)
    # upturned eave tips
    for side in (-1, 1):
        x = cx + side * 660
        d.line([(x, int(H * 0.455)), (x + side * 70, int(H * 0.438))], fill=gold, width=3)
        d.line([(x + side * 70, int(H * 0.438)), (x + side * 84, int(H * 0.452))], fill=gold, width=2)
    # second, smaller roof
    roof2 = [
        (cx - 360, int(H * 0.345)),
        (cx - 260, int(H * 0.300)),
        (cx, int(H * 0.266)),
        (cx + 260, int(H * 0.300)),
        (cx + 360, int(H * 0.345)),
    ]
    d.polygon(roof2, fill=(52, 4, 9, int(230 * strength)), outline=gold)

    # gold circuit traces on the facade
    for i in range(3):
        yy0 = int(H * (0.49 + i * 0.075))
        d.line([(cx - 490, yy0), (cx + 490, yy0)], fill=gold_soft, width=1)
        for k in range(-5, 6):
            xx = cx + k * 90
            d.line([(xx, yy0), (xx, yy0 + 16)], fill=gold_soft, width=1)

    # central plaque + star
    plaque_y = int(H * 0.505)
    d.rectangle([cx - 78, plaque_y - 52, cx + 78, plaque_y + 28], fill=(118, 10, 16, int(210 * strength)), outline=gold, width=2)
    d.polygon(star_points(cx, plaque_y - 12, 30 + 4 * math.sin(t * 2.0), 0.43), fill=(255, 208, 112, int(225 * strength)), outline=(255, 240, 200, int(245 * strength)))

    # reveal: a rising gold scan line that "builds" the hall
    if reveal < 0.995:
        cutoff = int(H * (0.94 - 0.66 * reveal))
        alpha = layer.split()[3]
        mask = np.zeros((H, W), dtype=np.uint8)
        mask[cutoff:, :] = 255
        alpha = Image.fromarray(np.minimum(np.asarray(alpha, dtype=np.uint16), 255 - mask).astype(np.uint8), "L")
        layer.putalpha(alpha)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        line = np.exp(-((yy - cutoff) ** 2) / (2 * 4.0 ** 2)) * 0.7
        canvas += C_GOLD * line[..., None]

    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)
    # bloom
    glow_layer = layer.filter(ImageFilter.GaussianBlur(24))
    ga = np.asarray(glow_layer, dtype=np.float32) / 255.0
    canvas += (C_GOLD * 0.55 + C_RED * 0.25) * (ga[..., 3:4] * 0.12 * glow)


def vermilion_lanterns(canvas: np.ndarray, t: float, strength: float):
    if strength <= 0.002:
        return
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    items = []
    for i in range(4):
        x = W * (0.075 + i * 0.055)
        items.append((x, H * 0.10, 16 + i * 2))
    for i in range(4):
        x = W * (0.925 - i * 0.055)
        items.append((x, H * 0.10, 16 + i * 2))
    for i in range(3):
        x = W * (0.16 + i * 0.07)
        items.append((x, H * 0.22, 11))
    for i in range(3):
        x = W * (0.84 - i * 0.07)
        items.append((x, H * 0.22, 11))
    for x, y, r in items:
        sway = math.sin(t * 0.9 + x * 0.01) * 6
        xx = x + sway
        d.line([(x, 0), (xx, y - r)], fill=(255, 200, 120, int(50 * strength)), width=1)
        d.ellipse([xx - r * 0.72, y - r, xx + r * 0.72, y + r], fill=(210, 24, 30, int(150 * strength)), outline=(255, 205, 120, int(180 * strength)), width=2)
        d.rectangle([xx - r * 0.42, y - r - 5, xx + r * 0.42, y - r + 3], fill=(255, 197, 96, int(200 * strength)))
        d.line([(xx, y + r), (xx, y + r + 22)], fill=(255, 197, 96, int(130 * strength)), width=2)
    layer = layer.filter(ImageFilter.GaussianBlur(0.5))
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)
    glow = layer.filter(ImageFilter.GaussianBlur(16))
    ga = np.asarray(glow, dtype=np.float32) / 255.0
    canvas += C_RED * (ga[..., 3:4] * 0.08)


def vermilion_fireworks(canvas: np.ndarray, t: float, strength: float):
    if strength <= 0.002:
        return
    bursts = [(4.35, 0.22, 0.30), (4.85, 0.78, 0.24), (5.45, 0.30, 0.38), (6.05, 0.70, 0.32)]
    for start, bx, by in bursts:
        age = t - start
        if age < 0 or age > 1.15:
            continue
        cx, cy = W * bx, H * by
        grad = 1.0 - age / 1.15
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        for i in range(46):
            ang = i / 46 * math.tau + 0.2
            sp = 90 + (i * 37 % 130)
            r0 = 18 + age * sp
            x0 = cx + math.cos(ang) * r0
            y0 = cy + math.sin(ang) * r0 + age * age * 34
            x1 = cx + math.cos(ang) * (r0 - 16)
            y1 = cy + math.sin(ang) * (r0 - 16) + age * age * 34
            col = (255, 205, 110, int(230 * grad)) if i % 3 else (255, 85, 70, int(210 * grad))
            d.line([(x0, y0), (x1, y1)], fill=col, width=1 if i % 4 else 2)
        layer = layer.filter(ImageFilter.GaussianBlur(0.6))
        arr = np.asarray(layer, dtype=np.float32) / 255.0
        canvas += arr[..., :3] * (arr[..., 3:4] * 255.0 * strength)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        d2 = (xx - cx) ** 2 + (yy - cy) ** 2
        canvas += C_GOLD * (np.exp(-d2 / (2 * 40 ** 2)) * 0.12 * grad * strength)[..., None]


def vermilion_ribbons(canvas: np.ndarray, t: float, strength: float):
    if strength <= 0.002:
        return
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for side in (-1, 1):
        for j in range(3):
            pts_top = []
            pts_bot = []
            for k in range(41):
                u = k / 40
                x = W * 0.5 + side * (W * (0.18 + 0.46 * u))
                y = H * (0.94 - 0.13 * u + 0.045 * math.sin(u * 5.0 + t * 1.3 + j * 0.8))
                pts_top.append((x, y - 10 - j * 4))
                pts_bot.append((x, y + 10 + j * 4))
            d.polygon(pts_top + list(reversed(pts_bot)), fill=(150, 14, 22, int(50 * strength)))
            d.line(pts_top, fill=(255, 180, 90, int(90 * strength)), width=2)
            d.line(pts_bot, fill=(255, 180, 90, int(50 * strength)), width=1)
    layer = layer.filter(ImageFilter.GaussianBlur(2.0))
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)


def vermilion_grid(canvas: np.ndarray, t: float, strength: float):
    if strength <= 0.002:
        return
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    hz = int(H * 0.80)
    vp = (W // 2, hz)
    for i in range(16):
        y = int(hz + (H - hz) * ((i / 16) ** 1.8))
        d.line([(0, y), (W, y)], fill=(255, 190, 90, int(28 * strength)), width=1)
    for i in range(-10, 11):
        d.line([vp, (W // 2 + i * 160, H)], fill=(255, 190, 90, int(22 * strength)), width=1)
    layer = layer.filter(ImageFilter.GaussianBlur(0.5))
    arr = np.asarray(layer, dtype=np.float32) / 255.0
    canvas += arr[..., :3] * (arr[..., 3:4] * 255.0)


def vermilion_bloom(canvas: np.ndarray, strength: float):
    lum = canvas.max(axis=2)
    mask = np.clip((lum - 110.0) / 145.0, 0.0, 1.0)
    layer = Image.fromarray((mask * 255).astype(np.uint8), "L")
    blurred = np.asarray(layer.filter(ImageFilter.GaussianBlur(24.0)), dtype=np.float32) / 255.0
    canvas += canvas * (blurred * strength)[..., None]
    canvas += (C_GOLD * 0.55 + C_RED * 0.45) * (blurred * 0.12 * strength)[..., None]


def vermilion_grade(canvas: np.ndarray, t: float, grain: float = 2.4):
    canvas *= VIGNETTE
    canvas *= SCAN
    lum = canvas.mean(axis=2, keepdims=True)
    canvas += (C_RED * 0.018) * (1 - np.clip(lum / 100.0, 0, 1))
    canvas += (C_GOLD * 0.012) * np.clip((lum - 120.0) / 120.0, 0, 1)
    rng = np.random.default_rng(int(t * 1000) + 71)
    canvas += rng.normal(0, grain, (H, W, 1)).astype(np.float32)
    return np.clip(canvas, 0, 255).astype(np.uint8)


def vermilion_boot(t: float) -> Image.Image:
    canvas = VERMILION_BASE.copy()
    fade = smoothstep(0.0, 1.0, t)
    reveal = smoothstep(0.8, 3.6, t)
    ignite = smoothstep(2.6, 4.4, t)
    push = smoothstep(5.2, 6.3, t)
    vermilion_clouds(canvas, t, 1.0 * fade)
    vermilion_grid(canvas, t, 0.55 * fade)
    # dawn glow
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    glow = np.exp(-(((xx - W * 0.5) / (W * 0.42)) ** 2 + ((yy - H * 0.62) / (H * 0.16)) ** 2))
    canvas += (C_RED * 0.7 + C_GOLD * 0.3) * (glow * 0.16 * fade)[..., None]
    vermilion_hall(canvas, t, fade, reveal, ignite)
    vermilion_lanterns(canvas, t, ignite)
    vermilion_ribbons(canvas, t, 0.8 * fade)
    vermilion_fireworks(canvas, t, ignite)
    # gold dust
    add_points(canvas, *STARS_FAR, t, C_GOLD, 0.45 * fade, 0.5)
    add_points(canvas, *STARS, t, C_RED, 0.40 * fade, 0.4)
    # camera push
    if push > 0:
        canvas += (C_GOLD * 0.06 + C_RED * 0.04) * push
    vermilion_bloom(canvas, 0.34)
    return Image.fromarray(vermilion_grade(canvas, t), "RGB")


def vermilion_bg(t: float) -> Image.Image:
    canvas = VERMILION_BASE.copy()
    vermilion_clouds(canvas, t, 0.85)
    vermilion_grid(canvas, t, 0.4)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    glow = np.exp(-(((xx - W * 0.5) / (W * 0.46)) ** 2 + ((yy - H * 0.63) / (H * 0.18)) ** 2))
    canvas += (C_RED * 0.7 + C_GOLD * 0.3) * (glow * 0.12)[..., None]
    vermilion_hall(canvas, t, 1.0, 1.0, 1.0)
    vermilion_lanterns(canvas, t, 0.8)
    vermilion_ribbons(canvas, t, 0.55)
    add_points(canvas, *STARS_FAR, t * 0.3, C_GOLD, 0.35, 0.5)
    add_points(canvas, *STARS, t * 0.4, C_RED, 0.3, 0.4)
    vermilion_bloom(canvas, 0.2)
    return Image.fromarray(vermilion_grade(canvas, t, grain=1.8), "RGB")


def make_vermilion_audio(path: str):
    """8s original welcome-march-style score. No quoted melody, no recordings."""
    sr = 48000
    n = int(VERMILION_SECONDS * sr)
    rng = np.random.default_rng(1949)
    mix = np.zeros(n)

    def place(sig, at, gain=1.0):
        i0 = int(max(0.0, at) * sr)
        m = min(n - i0, len(sig))
        if m > 0:
            mix[i0:i0 + m] += gain * sig[:m]

    def env(nn, attack, release, curve=1.6):
        e = np.ones(nn)
        a = min(nn, max(1, int(attack * sr)))
        r = min(nn, max(1, int(release * sr)))
        e[:a] = np.linspace(0, 1, a) ** (1 / curve)
        e[-r:] *= np.linspace(1, 0, r) ** curve
        return e

    def brass(freq, at, dur, gain=1.0, bright=1.0):
        nn = int(dur * sr)
        tt = np.arange(nn) / sr
        vib = 1.0 + 0.003 * np.sin(math.tau * 5.4 * tt + 0.3)
        sig = np.zeros(nn)
        for h in range(1, 9):
            sig += np.sin(math.tau * freq * h * vib * tt + h * 0.61) / (h ** (1.18 / bright))
        sig *= env(nn, 0.035, 0.09, 1.4)
        place(sig, at, gain)

    def lowbrass(freq, at, dur, gain=1.0):
        nn = int(dur * sr)
        tt = np.arange(nn) / sr
        sig = np.zeros(nn)
        for h in range(1, 5):
            sig += np.sin(math.tau * freq * h * tt + h * 0.4) / (h ** 1.1)
        sig *= env(nn, 0.05, 0.14, 1.2)
        place(sig, at, gain)

    def snare(at, gain=0.5, tone=1.0):
        dur = 0.12
        nn = int(dur * sr)
        tt = np.arange(nn) / sr
        noise = rng.normal(0, 1, nn)
        hp = noise - np.concatenate([[0], noise[:-1]])
        sig = 0.8 * hp * np.exp(-tt * 34) + 0.22 * np.sin(math.tau * 210 * tt) * np.exp(-tt * 28)
        place(sig, at, gain * tone)

    def bassdrum(at, gain=0.8):
        dur = 0.42
        nn = int(dur * sr)
        tt = np.arange(nn) / sr
        f = 44 + 38 * np.exp(-tt * 22)
        sig = np.sin(math.tau * np.cumsum(f) / sr) * np.exp(-tt * 7.5)
        sig += 0.12 * rng.normal(0, 1, nn) * np.exp(-tt * 40)
        place(sig, at, gain)

    def cymbal(at, gain=0.55):
        dur = 1.6
        nn = int(dur * sr)
        tt = np.arange(nn) / sr
        noise = rng.normal(0, 1, nn)
        hp = noise - np.concatenate([[0], noise[:-1]])
        sig = hp * np.exp(-tt * 2.2)
        place(sig, at, gain)

    def timpani(at, freq, gain=0.7):
        dur = 0.7
        nn = int(dur * sr)
        tt = np.arange(nn) / sr
        sig = np.sin(math.tau * freq * tt) * np.exp(-tt * 4.2)
        sig += 0.15 * rng.normal(0, 1, nn) * np.exp(-tt * 20)
        place(sig, at, gain)

    # 120 BPM: one bar = 2s, eighth = 0.25s, sixteenth = 0.125s
    # snare pattern: crisp march rudiments
    for bar in range(4):
        base = bar * 2.0
        for k in range(16):
            at = base + k * 0.125
            if bar == 0 and k < 8:
                continue
            accent = k % 4 == 0
            tone = 1.0 if accent else 0.6
            if bar == 3 and k >= 12:
                tone = 0.9
            snare(at, 0.30 if accent else 0.16, tone)
        # bass drum on 1 and 3
        bassdrum(base, 0.75)
        bassdrum(base + 1.0, 0.55)
        if bar >= 1:
            bassdrum(base + 0.5, 0.28)
            bassdrum(base + 1.5, 0.28)
        cymbal(base, 0.35 if bar == 0 else 0.5)

    # low brass pulse
    for k in range(16):
        at = k * 0.5
        lowbrass(58.27 if k % 4 in (0, 1) else 87.31, at, 0.42, 0.11)

    # fanfare chords: Bb - Eb - Bb - F - Bb
    chords = [
        (2.0, 1.0, [233.08, 293.66, 349.23, 466.16]),   # Bb
        (3.0, 1.0, [311.13, 392.0, 466.16, 622.25]),    # Eb
        (4.0, 1.0, [233.08, 293.66, 349.23, 466.16]),   # Bb
        (5.0, 1.0, [349.23, 440.0, 523.25, 698.46]),    # F
        (6.0, 2.0, [233.08, 293.66, 349.23, 466.16, 587.33]),  # Bb
    ]
    for at, dur, notes in chords:
        for f in notes:
            brass(f, at, dur, 0.075, 1.05)
            lowbrass(f / 2, at, dur, 0.045)

    # melody / counter-fanfare
    melody = [
        (2.0, 466.16, 0.45), (2.5, 587.33, 0.45), (3.0, 698.46, 0.45),
        (3.5, 622.25, 0.35), (4.0, 466.16, 0.45), (4.5, 587.33, 0.45),
        (5.0, 698.46, 0.45), (5.5, 880.0, 0.35), (6.0, 932.33, 0.9),
        (7.0, 932.33, 0.35), (7.5, 1174.66, 0.35),
    ]
    for at, f, dur in melody:
        brass(f, at, dur, 0.10, 1.15)

    # opening and closing hits
    bassdrum(0.0, 0.9)
    timpani(0.0, 58.27, 0.6)
    cymbal(0.0, 0.5)
    timpani(6.0, 58.27, 0.8)
    bassdrum(6.0, 0.95)
    cymbal(6.0, 0.85)
    cymbal(7.0, 0.35)

    # short military riser into the final bar
    rn = int(0.9 * sr)
    tt = np.arange(rn) / sr
    noise = rng.normal(0, 1, rn)
    lp = np.zeros(rn)
    for i in range(1, rn):
        lp[i] = lp[i - 1] + 0.03 * (noise[i] - lp[i - 1])
    rise = 0.045 * (noise - lp) * (tt / 0.9) ** 2
    rise += 0.035 * np.sin(math.tau * np.cumsum(180 * np.exp(tt * 1.2) + 40) / sr) * (tt / 0.9) ** 2
    place(rise, 5.1, 1.0)

    # tight stereo, mostly mono so it reads as a band
    left = mix.copy()
    right = mix.copy()
    for delay, gain in ((0.045, 0.08), (0.09, 0.05), (0.16, 0.03)):
        d = int(delay * sr)
        left[d:] += right[:-d] * gain
        right[d:] += left[:-d] * gain * 0.9
    stereo = np.stack([left, right], axis=1)
    stereo = np.tanh(stereo * 1.15) * 0.88
    fade = np.ones(n)
    fade[: int(0.08 * sr)] = np.linspace(0, 1, int(0.08 * sr))
    fade[-int(0.45 * sr):] = np.linspace(1, 0, int(0.45 * sr))
    stereo *= fade[:, None]
    peak = np.max(np.abs(stereo)) or 1.0
    stereo = (stereo / peak * 0.88 * 32767).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(stereo.tobytes())

def make_vermilion_poster(path: str):
    img = vermilion_bg(3.0).resize((1280, 720), Image.LANCZOS)
    img.save(path, "JPEG", quality=88, optimize=True)


if __name__ == "__main__":
    main()
