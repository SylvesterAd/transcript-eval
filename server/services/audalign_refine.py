#!/usr/bin/env python3
"""Refine audio sync offset using audalign's CorrelationRecognizer.

Takes two video files and a rough transcript-based offset.
Extracts short audio clips from the overlapping region, then runs
sample-level cross-correlation to get a precise offset.

Usage: python audalign_refine.py <primary_path> <secondary_path> <rough_offset_sec> [max_lags]
Output: JSON line on stdout with refined offset.
"""
import sys, json, os, tempfile, subprocess

CLIP_DURATION = 30   # seconds of audio to compare
MARGIN = 2           # seconds into overlap to skip (avoid edge artifacts)
SAMPLE_RATE = 8000   # CorrelationRecognizer default

def extract_clip(src, dst, start_sec, duration_sec):
    """Extract mono WAV clip with ffmpeg."""
    subprocess.run([
        'ffmpeg', '-y', '-i', src,
        '-ss', str(max(0, start_sec)), '-t', str(duration_sec),
        '-vn', '-ac', '1', '-ar', str(SAMPLE_RATE), '-f', 'wav', dst
    ], capture_output=True, check=True)

def main():
    primary_path = sys.argv[1]
    secondary_path = sys.argv[2]
    rough_offset = float(sys.argv[3])
    max_lags = int(sys.argv[4]) if len(sys.argv) > 4 else 10

    # Extract clips from the overlapping region.
    # rough_offset = timeline position where secondary starts (primary starts at 0).
    # Overlap starts at: primary_time = max(0, rough_offset), secondary_time = max(0, -rough_offset)
    if rough_offset >= 0:
        primary_start = rough_offset + MARGIN
        secondary_start = MARGIN
    else:
        primary_start = MARGIN
        secondary_start = -rough_offset + MARGIN

    with tempfile.TemporaryDirectory() as tmpdir:
        primary_clip = os.path.join(tmpdir, 'primary.wav')
        secondary_clip = os.path.join(tmpdir, 'secondary.wav')

        extract_clip(primary_path, primary_clip, primary_start, CLIP_DURATION)
        extract_clip(secondary_path, secondary_clip, secondary_start, CLIP_DURATION)

        # Verify clips have content
        for clip_path, name in [(primary_clip, 'primary'), (secondary_clip, 'secondary')]:
            size = os.path.getsize(clip_path)
            if size < 1000:
                print(json.dumps({
                    'offset': rough_offset,
                    'confidence': 0,
                    'error': f'{name} clip too short ({size} bytes)',
                    'method': 'fallback'
                }))
                return

        import audalign as ad

        rec = ad.CorrelationRecognizer()
        rec.config.max_lags = max_lags

        results = ad.recognize(primary_clip, secondary_clip, recognizer=rec)

        match_info = results.get('match_info', {})
        if match_info:
            key = list(match_info.keys())[0]
            info = match_info[key]
            offsets = info.get('offset_seconds', [])
            confidences = info.get('confidence', [])

            if offsets:
                audalign_correction = offsets[0]
                confidence = float(confidences[0]) if confidences else 0

                # Clips were cut so they roughly align:
                #   primary_clip[t]  = primary_video[primary_start + t]
                #   secondary_clip[t] = secondary_video[secondary_start + t]
                # audalign_correction: how much secondary needs to shift to align.
                # precise_offset = (primary_start - secondary_start) + audalign_correction
                #                = rough_offset + audalign_correction
                precise_offset = rough_offset + audalign_correction

                print(json.dumps({
                    'offset': round(precise_offset, 6),
                    'confidence': confidence,
                    'correction': round(audalign_correction, 6),
                    'rough_offset': rough_offset,
                    'method': 'audalign_correlation'
                }))
                return

        print(json.dumps({
            'offset': rough_offset,
            'confidence': 0,
            'error': 'No correlation match found',
            'method': 'fallback'
        }))

if __name__ == '__main__':
    main()
