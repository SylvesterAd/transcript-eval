#!/usr/bin/env bash
# Generate small synthesized MP4/MOV fixtures for mp4-probe.js tests.
# Committed binaries — only regenerate when adding new rates or fixing a parser bug.
# Each fixture is a 1-second 160x90 solid-color clip; total ~30-80 KB.

set -euo pipefail
OUT_DIR="$(dirname "$0")/../fixtures/mp4"
mkdir -p "$OUT_DIR"

gen() {
  local name=$1 rate=$2 ext=$3 extra=${4:-}
  ffmpeg -loglevel error -y \
    -f lavfi -i "color=size=160x90:duration=1:rate=$rate" \
    $extra "$OUT_DIR/$name.$ext"
}

# Seven common rates (CFR, faststart)
gen "23976_ntsc" "24000/1001" "mov"
gen "25_pal"     "25/1"       "mp4"
gen "2997_ntsc"  "30000/1001" "mov"
gen "30_cfr"     "30/1"       "mp4"
gen "50_pal"     "50/1"       "mp4"
gen "5994_ntsc"  "60000/1001" "mov"
gen "60_cfr"     "60/1"       "mp4"

# Moov-at-end (non-faststart): ffmpeg default is moov-at-end; no extra flag needed.
# The seven CFR fixtures above already use default placement; this one is an explicit
# named fixture so tests can refer to a file whose name signals the layout.
gen "moov_at_end" "30/1" "mp4"

# Embedded SMPTE timecode
gen "with_tmcd" "30/1" "mov" "-timecode 18:16:14:04"

# Variable frame rate: use -fps_mode vfr (ffmpeg 5+ syntax) so the container
# records a VFR stream (no fixed frame-rate atom in stts).
ffmpeg -loglevel error -y \
  -f lavfi -i "color=size=160x90:duration=1:rate=30" \
  -fps_mode vfr \
  "$OUT_DIR/vfr.mp4"

# Corrupt: truncate 30_cfr.mp4 to its first 512 bytes (fits ftyp but truncates mid-box)
head -c 512 "$OUT_DIR/30_cfr.mp4" > "$OUT_DIR/corrupt_truncated.mp4"

echo "Generated $(ls -1 "$OUT_DIR" | wc -l | tr -d ' ') fixtures in $OUT_DIR"
ls -lh "$OUT_DIR"
