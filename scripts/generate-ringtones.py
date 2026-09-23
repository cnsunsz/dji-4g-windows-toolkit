#!/usr/bin/env python3
"""Generate original short loopable ringtone WAVs (style approximations only).

These are ORIGINAL synthesized tones — NOT Apple Reflection, Xiaomi stock,
Samsung Over the Horizon, or any other proprietary ringtone.
"""
from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

SR = 44100
OUT = Path(__file__).resolve().parents[1] / "assets" / "ringtones"


def write_wav(path: Path, samples: list[float], sr: int = SR) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Soft peak normalize
    peak = max(abs(x) for x in samples) or 1.0
    scale = 0.72 / peak
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for x in samples:
            v = int(max(-1.0, min(1.0, x * scale)) * 32767)
            frames += struct.pack("<h", v)
        w.writeframes(frames)
    print(f"wrote {path} ({len(samples)/sr:.2f}s)")


def env_adsr(i: int, n: int, a=0.01, d=0.08, s=0.55, r=0.18) -> float:
    t = i / n if n else 0
    if t < a:
        return t / a if a else 1.0
    if t < a + d:
        return 1.0 - (1.0 - s) * ((t - a) / d if d else 0)
    if t > 1.0 - r:
        return s * max(0.0, (1.0 - t) / r if r else 0)
    return s


def tone(freq: float, dur: float, kind: str = "sine", vel: float = 1.0) -> list[float]:
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        phase = 2 * math.pi * freq * t
        if kind == "marimba":
            # Bright mallet: fundamental + soft harmonics, fast decay
            sig = (
                math.sin(phase)
                + 0.35 * math.sin(2 * phase) * math.exp(-6 * t)
                + 0.12 * math.sin(3 * phase) * math.exp(-10 * t)
            )
            e = math.exp(-3.2 * t) * (1.0 - math.exp(-90 * t))
        elif kind == "pulse":
            # Soft electronic pulse (band-limited-ish square via tanh)
            sig = math.tanh(2.4 * math.sin(phase))
            e = env_adsr(i, n, a=0.02, d=0.12, s=0.45, r=0.25)
        elif kind == "warm":
            sig = (
                math.sin(phase)
                + 0.28 * math.sin(2 * phase + 0.2)
                + 0.08 * math.sin(0.5 * phase)
            )
            e = env_adsr(i, n, a=0.04, d=0.15, s=0.6, r=0.3)
        else:
            sig = math.sin(phase)
            e = env_adsr(i, n)
        out.append(sig * e * vel)
    return out


def mix(tracks: list[list[float]], gap: int = 0) -> list[float]:
    total = sum(len(t) for t in tracks) + gap * max(0, len(tracks) - 1)
    out = [0.0] * total
    pos = 0
    for t in tracks:
        for i, v in enumerate(t):
            out[pos + i] += v
        pos += len(t) + gap
    return out


def apple_style() -> list[float]:
    """Clean bright melodic marimba-like short loop (~3.2s). Original notes."""
    # C major-ish arpeggio motif (Hz) — original sequence
    notes = [523.25, 659.25, 783.99, 1046.50, 783.99, 659.25]
    durs = [0.38, 0.38, 0.38, 0.55, 0.38, 0.55]
    parts = [tone(f, d, "marimba", 0.95) for f, d in zip(notes, durs)]
    # Short rest at end for loop seam
    parts.append([0.0] * int(SR * 0.35))
    return mix(parts, gap=int(SR * 0.04))


def xiaomi_style() -> list[float]:
    """Modern electronic / soft synth pulse loop (~3.0s). Original."""
    # Soft ascending pulse + filtered feel
    motif = [
        (392.00, 0.22),
        (493.88, 0.22),
        (587.33, 0.28),
        (659.25, 0.40),
        (587.33, 0.22),
        (493.88, 0.22),
        (392.00, 0.45),
    ]
    parts = []
    for f, d in motif:
        parts.append(tone(f, d, "pulse", 0.85))
        # subtle octave shimmer
        shimmer = tone(f * 2, d * 0.85, "sine", 0.18)
        base = parts[-1]
        for i in range(min(len(base), len(shimmer))):
            base[i] += shimmer[i]
    parts.append([0.0] * int(SR * 0.4))
    # soft low drone under (very quiet)
    drone_n = sum(len(p) for p in parts)
    drone = []
    for i in range(drone_n):
        t = i / SR
        drone.append(0.08 * math.sin(2 * math.pi * 98 * t) * (0.5 + 0.5 * math.sin(2 * math.pi * 0.7 * t)))
    out = mix(parts)
    for i in range(min(len(out), len(drone))):
        out[i] += drone[i]
    return out


def samsung_style() -> list[float]:
    """Warm ascending motif / soft orchestral-electronic feel (~3.5s). Original."""
    # Ascending warm motif (not Over the Horizon)
    notes = [
        (261.63, 0.35),
        (329.63, 0.35),
        (392.00, 0.35),
        (523.25, 0.55),
        (493.88, 0.40),
        (392.00, 0.50),
    ]
    parts = [tone(f, d, "warm", 0.9) for f, d in notes]
    # soft pad swell between notes
    pad = []
    total_est = sum(int(SR * d) for _, d in notes) + int(SR * 0.45)
    for i in range(total_est):
        t = i / SR
        pad.append(
            0.12
            * math.sin(2 * math.pi * 196 * t)
            * (0.4 + 0.6 * math.sin(math.pi * t / (total_est / SR)))
        )
    parts.append([0.0] * int(SR * 0.4))
    out = mix(parts, gap=int(SR * 0.05))
    for i in range(min(len(out), len(pad))):
        out[i] += pad[i]
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write_wav(OUT / "apple-style.wav", apple_style())
    write_wav(OUT / "xiaomi-style.wav", xiaomi_style())
    write_wav(OUT / "samsung-style.wav", samsung_style())
    readme = OUT / "README.txt"
    readme.write_text(
        "Original synthesized ringtone style approximations.\n"
        "NOT official Apple / Xiaomi / Samsung ringtones.\n"
        "Generated by scripts/generate-ringtones.py (MIT project).\n"
        "Files: apple-style.wav, xiaomi-style.wav, samsung-style.wav\n",
        encoding="utf-8",
    )
    print("done ->", OUT)


if __name__ == "__main__":
    main()
