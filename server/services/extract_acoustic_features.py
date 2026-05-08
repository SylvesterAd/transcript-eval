#!/usr/bin/env python3
"""Extract per-frame acoustic features for the rough-cut agent.

Reads an audio (or video) file, returns 100ms-hop features as JSON on stdout:

    {
      "hop_ms": 100,
      "duration_s": 612.4,
      "features": ["rms_db", "f0", "f0_voiced", "spectral_centroid", "zcr"],
      "frames": [[t, rms_db, f0, voiced, sc, zcr], ...]
    }

Used by server/services/whisper.js after Scribe V2 transcription completes.
Feature choice rationale:
- rms_db: energy drops signal abandonment / sentence boundary / off-mic
- f0: pitch reset between sentences = real discourse-marker discriminator
- f0_voiced: distinguishes voiced speech from silence/noise
- spectral_centroid: tonal brightness — proxy for engagement
- zcr: breathiness / sigh / non-speech detector

Usage:
  python extract_acoustic_features.py <audio_or_video_path>

Exit codes:
  0  success, JSON on stdout
  1  file not found / unreadable
  2  decode failure
  3  feature computation failure
"""
import sys
import json
import math
import os

SR = 22050               # target sample rate
HOP_MS = 100             # frame hop in milliseconds
F0_MIN = 50              # Hz, lower bound for human voice
F0_MAX = 600             # Hz, upper bound. >=500 needed so pyin's pitch bin
                         # count exceeds its transition window width (~431).


def main():
    if len(sys.argv) != 2:
        print("usage: extract_acoustic_features.py <path>", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"file not found: {path}", file=sys.stderr)
        sys.exit(1)

    # Defer librosa import until after path validation so missing-arg errors
    # are fast and obvious.
    try:
        import librosa
        import numpy as np
    except ImportError as e:
        print(f"librosa/numpy not installed: {e}", file=sys.stderr)
        sys.exit(2)

    try:
        y, sr = librosa.load(path, sr=SR, mono=True)
    except Exception as e:
        print(f"decode failed: {e}", file=sys.stderr)
        sys.exit(2)

    duration_s = len(y) / sr if sr > 0 else 0.0
    hop_length = int(sr * HOP_MS / 1000)
    # Each extractor uses its appropriate frame_length:
    #  - rms / zcr: short time-domain windows (= hop_length * 2)
    #  - pyin / spectral_centroid: FFT-based, need standard 2048 window
    # Frame counts may differ by ±1; we align to the shortest at the end.
    n_fft = 2048
    td_frame = hop_length * 2

    try:
        # RMS in dB. Add small epsilon to avoid -inf for silent frames.
        rms = librosa.feature.rms(y=y, frame_length=td_frame, hop_length=hop_length)[0]
        rms_db = 20.0 * np.log10(np.maximum(rms, 1e-8))

        # F0 via pyin. Slower than yin but more accurate for speech.
        # Returns (f0, voiced_flag, voiced_prob); we keep the first two.
        f0, voiced_flag, _voiced_prob = librosa.pyin(
            y, fmin=F0_MIN, fmax=F0_MAX, sr=sr, hop_length=hop_length, frame_length=n_fft,
        )
        # NaN F0 means unvoiced — replace with 0 for compact JSON.
        f0 = np.where(np.isnan(f0), 0.0, f0)
        voiced_flag = voiced_flag.astype(int)

        # Spectral centroid in Hz
        sc = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop_length, n_fft=n_fft)[0]

        # Zero crossing rate (0..1)
        zcr = librosa.feature.zero_crossing_rate(y=y, frame_length=td_frame, hop_length=hop_length)[0]

        # Align to the shortest length (rare off-by-one between extractors).
        n = min(len(rms_db), len(f0), len(voiced_flag), len(sc), len(zcr))
        rms_db = rms_db[:n]
        f0 = f0[:n]
        voiced_flag = voiced_flag[:n]
        sc = sc[:n]
        zcr = zcr[:n]
    except Exception as e:
        print(f"feature extraction failed: {e}", file=sys.stderr)
        sys.exit(3)

    # Build frames as compact arrays — JSON size adds up fast on long videos.
    # Two decimals on most fields, one on f0_voiced (it's an int).
    frames = []
    for i in range(n):
        t = round((i * hop_length) / sr, 3)
        frames.append([
            t,
            round(float(rms_db[i]), 1),
            round(float(f0[i]), 1) if not math.isnan(float(f0[i])) else 0.0,
            int(voiced_flag[i]),
            round(float(sc[i]), 0),
            round(float(zcr[i]), 4),
        ])

    out = {
        "hop_ms": HOP_MS,
        "duration_s": round(duration_s, 3),
        "features": ["rms_db", "f0", "f0_voiced", "spectral_centroid", "zcr"],
        "frames": frames,
    }
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
