#!/usr/bin/env python3
"""Build MUSE gallery poster and boot film from user-supplied images.

Usage:
  python3 tools/render_muse.py            # use skins/muse/images/*
  python3 tools/render_muse.py --place   # use the abstract placeholder poster only

The script never downloads images. It only reads images you own/are licensed
to use, and writes poster.jpg / boot.mp4 inside skins/muse/.
"""
from __future__ import annotations

import argparse
import math
import os
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIN = os.path.join(ROOT, "skins", "muse")
IMG_DIR = os.path.join(SKIN, "images")
W, H = 1920, 1080
FPS = 30
SECONDS = 8.0
SAFE = (".jpg", ".jpeg", ".png", ".webp")


def images() -> list[str]:
    if not os.path.isdir(IMG_DIR):
        return []
    return [
        os.path.join(IMG_DIR, name)
        for name in sorted(os.listdir(IMG_DIR))
        if os.path.splitext(name)[1].lower() in SAFE and os.path.isfile(os.path.join(IMG_DIR, name))
    ][:8]


def cover(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    scale = max(W / img.width, H / img.height)
    img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
    x = (img.width - W) // 2
    y = (img.height - H) // 2
    return img.crop((x, y, x + W, y + H))


def gallery_wall(img: Image.Image) -> Image.Image:
    """Use a blurred full-bleed fill behind the complete image (no face crop)."""
    if img.width / img.height >= 1.55:
        return cover(img)
    bg = cover(img).filter(ImageFilter.GaussianBlur(42))
    bg = Image.eval(bg, lambda p: int(p * 0.42))
    canvas = bg.convert("RGBA")
    fh = int(H * 0.94)
    fw = max(1, int(img.width * fh / img.height))
    if fw > int(W * 0.72):
        fw = int(W * 0.72)
        fh = max(1, int(img.height * fw / img.width))
    fg = img.convert("RGB").resize((fw, fh), Image.LANCZOS)
    x = (W - fw) // 2
    y = (H - fh) // 2
    # shadow / gold frame
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(shadow)
    d.rectangle([x - 18, y - 18, x + fw + 18, y + fh + 18], fill=(0, 0, 0, 120))
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(18)))
    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(frame)
    d.rectangle([x - 3, y - 3, x + fw + 3, y + fh + 3], outline=(235, 190, 160, 170), width=2)
    canvas = Image.alpha_composite(canvas, frame)
    canvas.paste(fg, (x, y))
    # soft vignette
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    nx = (xx - W / 2) / (W / 2)
    ny = (yy - H / 2) / (H / 2)
    v = np.clip(1.06 - 0.3 * (nx * nx + ny * ny), 0.4, 1.0)[..., None]
    arr = np.asarray(canvas, dtype=np.float32)[..., :3] * v
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def make_poster(files: list[str], out: str = "user-poster.jpg") -> None:
    if files:
        img = gallery_wall(Image.open(files[0]))
    else:
        img = Image.open(os.path.join(SKIN, "poster.jpg")).convert("RGB")
    img.save(os.path.join(SKIN, out), "JPEG", quality=90, optimize=True)


def make_audio(path: str) -> None:
    sr = 48000
    n = int(SECONDS * sr)
    t = np.arange(n, dtype=np.float64) / sr
    mix = np.zeros(n)
    # soft minor-seventh pad
    for f, a, ph in ((220.0, 0.09, 0.2), (261.63, 0.07, 1.2), (329.63, 0.06, 2.4), (392.0, 0.035, 0.8)):
        mix += a * (np.sin(math.tau * f * t + ph) + 0.25 * np.sin(math.tau * 2 * f * t + ph))
    # sparse glass arpeggio
    for i, f in enumerate((880.0, 1046.5, 1318.5, 1046.5, 880.0, 659.25)):
        at = 0.6 + i * 0.95
        i0 = int(at * sr)
        m = min(n - i0, int(0.9 * sr))
        if m <= 0:
            continue
        tt = np.arange(m) / sr
        env = np.exp(-tt * 3.2) * np.clip(tt / 0.04, 0, 1)
        note = 0.035 * env * (np.sin(math.tau * f * tt) + 0.3 * np.sin(math.tau * 2 * f * tt))
        mix[i0:i0 + m] += note
    mix *= np.clip(t / 0.8, 0, 1) * np.clip((7.7 - t) / 0.8, 0, 1)
    # stereo width
    left = mix.copy()
    right = mix.copy()
    for delay, gain in ((0.19, 0.18), (0.37, 0.1)):
        d = int(delay * sr)
        left[d:] += right[:-d] * gain
        right[d:] += left[:-d] * gain * 0.9
    stereo = np.stack([left, right], axis=1)
    stereo = np.tanh(stereo * 1.2) * 0.9
    peak = np.max(np.abs(stereo)) or 1.0
    stereo = (stereo / peak * 0.55 * 32767).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(stereo.tobytes())


def frame(sources: list[Image.Image], t: float) -> Image.Image:
    if len(sources) == 1:
        return sources[0]
    span = SECONDS / len(sources)
    idx = min(len(sources) - 1, int(t / span))
    local = (t - idx * span) / span
    current = sources[idx]
    if idx + 1 < len(sources) and local > 0.68:
        nxt = sources[idx + 1]
        alpha = (local - 0.68) / 0.32
        img = Image.blend(current, nxt, alpha)
    else:
        img = current
    # slow push-in
    scale = 1.0 + 0.035 * (t / SECONDS)
    nw, nh = int(W * scale), int(H * scale)
    zoom = img.resize((nw, nh), Image.LANCZOS)
    x = (nw - W) // 2
    y = (nh - H) // 2
    out = zoom.crop((x, y, x + W, y + H))
    arr = np.asarray(out, dtype=np.float32)
    rng = np.random.default_rng(int(t * 1000) + 3)
    arr += rng.normal(0, 1.8, (H, W, 1))
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def make_boot(files: list[str], out_name: str = "user-boot.mp4") -> None:
    if files:
        sources = [gallery_wall(Image.open(f)) for f in files[:5]]
    else:
        sources = [Image.open(os.path.join(SKIN, "poster.jpg")).convert("RGB")]
    silent = os.path.join(SKIN, "boot-silent.mp4")
    raw = os.path.join(SKIN, "boot.raw")
    wav = os.path.join(SKIN, "boot.wav")
    out = os.path.join(SKIN, out_name)
    frames = int(SECONDS * FPS)
    with open(raw, "wb") as fh:
        for i in range(frames):
            fh.write(np.asarray(frame(sources, i / FPS), dtype=np.uint8).tobytes())
            if i % 30 == 0:
                print(f"  muse boot {i}/{frames}", flush=True)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{W}x{H}", "-r", str(FPS), "-i", raw, "-an", "-c:v", "libx264",
        "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-t", f"{SECONDS:.3f}", silent,
    ], check=True)
    os.remove(raw)
    make_audio(wav)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", silent, "-i", wav,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest",
        "-movflags", "+faststart", out,
    ], check=True)
    os.remove(silent)
    os.remove(wav)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--place", action="store_true", help="write the built-in placeholder poster/boot")
    ap.add_argument("--poster-only", action="store_true", help="only regenerate user-poster.jpg; keep a custom boot video")
    args = ap.parse_args()
    files = [] if args.place else images()
    if args.place:
        make_poster([], "poster.jpg")
        make_boot([], "boot.mp4")
        print("muse: placeholder -> poster.jpg + boot.mp4")
        return
    make_poster(files, "user-poster.jpg")
    if args.poster_only:
        print(f"muse: {len(files)} image(s) -> user-poster.jpg (boot kept)")
        return
    make_boot(files, "user-boot.mp4")
    print(f"muse: {len(files)} image(s) -> user-poster.jpg + user-boot.mp4")


if __name__ == "__main__":
    main()
