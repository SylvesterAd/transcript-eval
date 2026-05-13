# Extension FPS Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Premiere XML export emit per-file metadata (FPS, NTSC flag, embedded SMPTE timecode, source duration) that matches the actual bytes on disk, by probing each downloaded file in the Chrome extension via a `file://` fetch and a hand-written MP4/MOV box parser. Fix the "File not found in search directories" import failures caused by today's preview-URL-only server-side probe.

**Architecture:** Extension probes each downloaded clip (A-roll + b-rolls) after `chrome.downloads` reports `complete`. A pure-JS MP4/MOV box parser reads the first ~1 MB (or last ~1 MB if the file is non-faststart) and extracts `{frameRate, ntsc, width, height, durationSeconds, embeddedTimecode}`. Probe result attaches to `state.items[i].probed_metadata`. Web app's `buildVariantsPayload()` merges those probed values into each variant's placements with **probed > manifest > null** precedence — no backend change for storage. Server-side ffprobe stays as fallback when the user hasn't granted the `file://` toggle. A new `fps_probe_enabled` field on `/api/ext-config` provides a remote kill switch.

**Tech Stack:** Chrome MV3 service worker (vanilla JS, no bundler at runtime), Vitest in workspace projects (`extension`, `web`, `server`), Better-SQLite3 + Express on the server, `ffmpeg` (build-time only, for generating test fixtures).

---

## File Structure

**New files:**
- `extension/modules/mp4-probe.js` — pure-JS MP4/MOV box parser + `probeMp4File()` public surface
- `extension/modules/__tests__/mp4-probe.test.js` — parser unit tests against fixtures
- `extension/modules/__tests__/queue-probe.test.js` — queue integration test
- `extension/scripts/generate-mp4-fixtures.sh` — committed shell script that regenerates fixtures
- `extension/fixtures/mp4/` — 11 small synthesized MP4/MOV files (committed binaries)
- `server/routes/__tests__/exports-result.test.js` — backend snapshot test for variants persistence + XMEML output

**Modified files:**
- `extension/manifest.json` — add `host_permissions: ["file:///*"]`, bump version `0.9.5` → `1.0.0`
- `extension/modules/queue.js` — call `probeMp4File()` on `chrome.downloads` completion, store on `state.items[i].probed_metadata`
- `extension/modules/config-fetch.js` — accept `fps_probe_enabled` field, fall-open to `true`
- `extension/popup.html` — add second `config-banner` slot for the file-access onboarding
- `extension/popup.js` — file-access banner state machine + `chrome://extensions` deep-link
- `extension/popup.css` — minor styling (reuse existing `.config-banner` classes; no new color tokens needed)
- `extension/service_worker.js` — emit `export_started_without_fps_probe` telemetry pre-export when permission denied
- `server/services/ext-config.js` — add `fps_probe_enabled` to config response
- `src/hooks/useExportXmlKickoff.js` (or wherever `buildVariantsPayload` lives) — merge `probed_metadata` from state items into variant placements with precedence rule

---

## Task 0: Worktree setup

**Files:**
- New branch: `feature/extension-fps-probe` off `main`
- Worktree path: `.worktrees/extension-fps-probe`

- [ ] **Step 1: Verify clean main**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git status --short | grep -v "^??" | head
```
Expected: empty output (no tracked-file changes). Untracked files OK — they belong to other in-progress work.

- [ ] **Step 2: Create worktree**

Run:
```bash
git worktree add -b feature/extension-fps-probe .worktrees/extension-fps-probe main
cd .worktrees/extension-fps-probe
```
Expected: "Preparing worktree (new branch 'feature/extension-fps-probe')" then "HEAD is now at <sha>".

- [ ] **Step 3: Install dependencies in worktree**

Run:
```bash
npm install
```
Expected: clean install, no errors. (Memory note: worktrees get their own `node_modules`.)

- [ ] **Step 4: Verify vitest works in worktree**

Run:
```bash
npx vitest run --reporter=basic 2>&1 | tail -5
```
Expected: "Test Files <N> passed" with a non-zero file count and all green. If anything fails, stop and debug — don't proceed with a broken baseline.

---

## Task 1: Generate MP4/MOV test fixtures

**Files:**
- Create: `extension/scripts/generate-mp4-fixtures.sh` (committed)
- Create: `extension/fixtures/mp4/` (11 committed binary fixtures, ~30-80 KB each)
- Modify: `.gitignore` (verify `extension/fixtures/` is **not** ignored — fixtures must be tracked)

- [ ] **Step 1: Verify ffmpeg available**

Run:
```bash
which ffmpeg && ffmpeg -version | head -1
```
Expected: a path + a version line. If missing, install via `brew install ffmpeg` before continuing.

- [ ] **Step 2: Write the fixture generator script**

Create `extension/scripts/generate-mp4-fixtures.sh`:

```bash
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

# Moov-at-end (non-faststart)
gen "moov_at_end" "30/1" "mp4" "-movflags +nofaststart"

# Embedded SMPTE timecode
gen "with_tmcd" "30/1" "mov" "-timecode 18:16:14:04"

# Variable frame rate (use VFR mode and varying input rate)
ffmpeg -loglevel error -y \
  -f lavfi -i "color=size=160x90:duration=1:rate=30" \
  -vsync vfr -r 24 \
  "$OUT_DIR/vfr.mp4"

# Corrupt: truncate 30_cfr.mp4 to its first 8 KB
head -c 8192 "$OUT_DIR/30_cfr.mp4" > "$OUT_DIR/corrupt_truncated.mp4"

echo "Generated $(ls -1 "$OUT_DIR" | wc -l | tr -d ' ') fixtures in $OUT_DIR"
ls -lh "$OUT_DIR"
```

- [ ] **Step 3: Run the script and commit fixtures**

Run:
```bash
chmod +x extension/scripts/generate-mp4-fixtures.sh
./extension/scripts/generate-mp4-fixtures.sh
ls -l extension/fixtures/mp4/
```
Expected: 11 files, sizes 8K-80K each. The script prints "Generated 11 fixtures".

- [ ] **Step 4: Confirm fixtures are tracked**

Run:
```bash
git check-ignore -v extension/fixtures/mp4/30_cfr.mp4 || echo "not ignored — good"
```
Expected: "not ignored — good". If output shows an ignore rule, edit `.gitignore` to exclude `extension/fixtures/` from any matching pattern.

- [ ] **Step 5: Commit**

Run:
```bash
git add extension/scripts/generate-mp4-fixtures.sh extension/fixtures/mp4/
git commit -m "test(ext): add MP4/MOV fixtures for mp4-probe parser tests"
```

---

## Task 2: Byte reader helpers in `mp4-probe.js`

**Files:**
- Create: `extension/modules/mp4-probe.js`
- Create: `extension/modules/__tests__/mp4-probe.test.js`

- [ ] **Step 1: Write failing tests for byte readers**

Create `extension/modules/__tests__/mp4-probe.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { _internal } from '../mp4-probe.js'

describe('mp4-probe byte readers', () => {
  const buf = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
                              0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00]).buffer
  const view = new DataView(buf)

  it('readU32BE returns big-endian uint32', () => {
    expect(_internal.readU32BE(view, 0)).toBe(0x00000010)
    expect(_internal.readU32BE(view, 4)).toBe(0x66747970)  // 'ftyp'
  })

  it('readU64BE returns big-endian uint64 as BigInt', () => {
    expect(_internal.readU64BE(view, 0)).toBe(0x0000001066747970n)
  })

  it('readFourCC returns ASCII fourCC at offset', () => {
    expect(_internal.readFourCC(view, 4)).toBe('ftyp')
    expect(_internal.readFourCC(view, 8)).toBe('mp42')
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

Run:
```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js 2>&1 | tail -10
```
Expected: FAIL with "Cannot find module" or similar — `mp4-probe.js` doesn't exist yet.

- [ ] **Step 3: Implement byte readers**

Create `extension/modules/mp4-probe.js`:

```js
// MP4/MOV box parser for the Chrome extension. Reads files via file:// fetch
// and extracts authoritative {frameRate, ntsc, width, height, durationSeconds,
// embeddedTimecode}. Pure functions; no DOM, no chrome.* APIs.
//
// Spec: docs/superpowers/specs/2026-05-13-extension-fps-probe-design.md

function readU32BE(view, offset) {
  return view.getUint32(offset, false)
}

function readU64BE(view, offset) {
  return view.getBigUint64(offset, false)
}

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

export const _internal = { readU32BE, readU64BE, readFourCC }
```

- [ ] **Step 4: Run test, expect PASS**

Run:
```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js 2>&1 | tail -10
```
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): add byte-reader helpers for mp4-probe parser"
```

---

## Task 3: Box header parser + iteration

**Files:**
- Modify: `extension/modules/mp4-probe.js`
- Modify: `extension/modules/__tests__/mp4-probe.test.js`

ISO BMFF box header: 4 bytes big-endian size, 4 bytes ASCII type. If size === 1, next 8 bytes are extended-64bit size. If size === 0, box runs to end of file. Otherwise size includes the 8-byte header.

- [ ] **Step 1: Write failing tests for box iteration**

Append to `extension/modules/__tests__/mp4-probe.test.js`:

```js
describe('mp4-probe box iteration', () => {
  it('parses a 32-bit-size ftyp box header', () => {
    // size=0x18, type='ftyp', then 16 bytes payload
    const bytes = new Uint8Array(0x18)
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0)
    const view = new DataView(bytes.buffer)
    const box = _internal.readBoxHeader(view, 0, bytes.length)
    expect(box).toEqual({
      type: 'ftyp', size: 0x18, headerSize: 8, payloadStart: 8, payloadEnd: 0x18,
    })
  })

  it('parses a 64-bit-size extended box header', () => {
    // size=1 marker, type='mdat', then 8-byte extended size
    const bytes = new Uint8Array(32)
    bytes.set([0x00, 0x00, 0x00, 0x01, 0x6d, 0x64, 0x61, 0x74,
               0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20], 0)
    const view = new DataView(bytes.buffer)
    const box = _internal.readBoxHeader(view, 0, bytes.length)
    expect(box).toEqual({
      type: 'mdat', size: 32, headerSize: 16, payloadStart: 16, payloadEnd: 32,
    })
  })

  it('returns null for box header that runs past buffer', () => {
    // size=0x100 but only 8 bytes of buffer
    const bytes = new Uint8Array(8)
    bytes.set([0x00, 0x00, 0x01, 0x00, 0x66, 0x74, 0x79, 0x70], 0)
    const view = new DataView(bytes.buffer)
    expect(_internal.readBoxHeader(view, 0, bytes.length)).toBeNull()
  })

  it('iterateBoxes yields top-level boxes in order', () => {
    const bytes = new Uint8Array(0x20)
    // ftyp size=0x10
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70], 0)
    // moov size=0x10
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x76], 0x10)
    const view = new DataView(bytes.buffer)
    const types = []
    for (const box of _internal.iterateBoxes(view, 0, bytes.length)) {
      types.push(box.type)
    }
    expect(types).toEqual(['ftyp', 'moov'])
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

Run:
```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "box iteration" 2>&1 | tail -10
```
Expected: FAIL with "readBoxHeader is not a function".

- [ ] **Step 3: Implement box header + iteration**

Append to `extension/modules/mp4-probe.js` (above the `_internal` export — move the export to the bottom of the file once helpers grow):

```js
function readBoxHeader(view, offset, bufferEnd) {
  if (offset + 8 > bufferEnd) return null
  let size = readU32BE(view, offset)
  const type = readFourCC(view, offset + 4)
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > bufferEnd) return null
    const big = readU64BE(view, offset + 8)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(big)
    headerSize = 16
  } else if (size === 0) {
    // Runs to end-of-buffer
    size = bufferEnd - offset
  }
  if (size < headerSize) return null
  if (offset + size > bufferEnd) return null
  return {
    type,
    size,
    headerSize,
    payloadStart: offset + headerSize,
    payloadEnd: offset + size,
  }
}

function* iterateBoxes(view, start, end) {
  let cursor = start
  while (cursor < end) {
    const box = readBoxHeader(view, cursor, end)
    if (!box) return
    yield box
    cursor = box.payloadEnd
  }
}
```

Update the `_internal` export at the bottom of the file:

```js
export const _internal = { readU32BE, readU64BE, readFourCC, readBoxHeader, iterateBoxes }
```

- [ ] **Step 4: Run test, expect PASS**

Run:
```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "box iteration" 2>&1 | tail -10
```
Expected: 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): mp4-probe box header parser + iteration"
```

---

## Task 4: ftyp brand validation

**Files:**
- Modify: `extension/modules/mp4-probe.js`
- Modify: `extension/modules/__tests__/mp4-probe.test.js`

- [ ] **Step 1: Write failing tests for brand validation**

Append:

```js
describe('mp4-probe brand validation', () => {
  it('accepts known MP4/MOV brands', () => {
    // ftyp size=0x18, major brand 'mp42', minor version 0, compat 'isom'
    const bytes = new Uint8Array(0x18)
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
               0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
               0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32], 0)
    const view = new DataView(bytes.buffer)
    const ftyp = _internal.readBoxHeader(view, 0, bytes.length)
    expect(_internal.validateFtypBrand(view, ftyp)).toBe(true)
  })

  it('rejects unknown brand', () => {
    const bytes = new Uint8Array(0x10)
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
               0x77, 0x65, 0x62, 0x6d, 0x00, 0x00, 0x00, 0x00], 0)  // 'webm'
    const view = new DataView(bytes.buffer)
    const ftyp = _internal.readBoxHeader(view, 0, bytes.length)
    expect(_internal.validateFtypBrand(view, ftyp)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "brand validation" 2>&1 | tail
```
Expected: FAIL — `validateFtypBrand is not a function`.

- [ ] **Step 3: Implement brand validation**

Append to `mp4-probe.js`:

```js
const ACCEPTED_BRANDS = new Set([
  'mp4 ', 'isom', 'iso2', 'iso4', 'iso5', 'iso6',
  'qt  ', 'mp41', 'mp42', 'MSNV', 'M4V ', 'M4A ',
  'avc1',
])

function validateFtypBrand(view, ftyp) {
  if (!ftyp || ftyp.type !== 'ftyp') return false
  // Major brand at payload offset 0
  if (ftyp.payloadEnd - ftyp.payloadStart < 8) return false
  const major = readFourCC(view, ftyp.payloadStart)
  if (ACCEPTED_BRANDS.has(major)) return true
  // Walk compatible brands (4 bytes each, starting at payload+8)
  for (let off = ftyp.payloadStart + 8; off + 4 <= ftyp.payloadEnd; off += 4) {
    if (ACCEPTED_BRANDS.has(readFourCC(view, off))) return true
  }
  return false
}
```

Update `_internal` export to include `validateFtypBrand, ACCEPTED_BRANDS`.

- [ ] **Step 4: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "brand validation"
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): mp4-probe ftyp brand validation"
```

---

## Task 5: moov walker + trak iteration + handler discrimination

**Files:**
- Modify: `extension/modules/mp4-probe.js`
- Modify: `extension/modules/__tests__/mp4-probe.test.js`

This task adds the ability to find `moov`, iterate its `trak` children, and read each trak's handler type (`vide` for video, `tmcd` for SMPTE timecode track, `soun` for audio — which we ignore).

- [ ] **Step 1: Write failing test using a real fixture**

Append:

```js
import { readFileSync } from 'fs'
import { resolve } from 'path'

function loadFixture(name) {
  const path = resolve(__dirname, '../../fixtures/mp4', name)
  const bytes = readFileSync(path)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

describe('mp4-probe moov + trak traversal', () => {
  it('finds moov in 30_cfr.mp4', () => {
    const view = loadFixture('30_cfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    expect(moov).not.toBeNull()
    expect(moov.type).toBe('moov')
  })

  it('iterates traks and identifies video handler', () => {
    const view = loadFixture('30_cfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    expect(traks.length).toBeGreaterThanOrEqual(1)
    const handlers = traks.map(t => _internal.readTrakHandler(view, t))
    expect(handlers).toContain('vide')
  })

  it('returns null when moov missing in faststart buffer', () => {
    // Build a fake buffer with only ftyp+mdat (moov-at-end scenario)
    const bytes = new Uint8Array(0x20)
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
               0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00], 0)
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x6d, 0x64, 0x61, 0x74], 0x10)
    const view = new DataView(bytes.buffer)
    expect(_internal.findMoov(view, 0, bytes.length)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "moov + trak"
```
Expected: FAIL — `findMoov is not a function`.

- [ ] **Step 3: Implement moov + trak helpers**

Append to `mp4-probe.js`:

```js
function findMoov(view, start, end) {
  for (const box of iterateBoxes(view, start, end)) {
    if (box.type === 'moov') return box
  }
  return null
}

function findChildBox(view, parent, type) {
  for (const box of iterateBoxes(view, parent.payloadStart, parent.payloadEnd)) {
    if (box.type === type) return box
  }
  return null
}

function* iterateTraks(view, moov) {
  for (const box of iterateBoxes(view, moov.payloadStart, moov.payloadEnd)) {
    if (box.type === 'trak') yield box
  }
}

function readTrakHandler(view, trak) {
  const mdia = findChildBox(view, trak, 'mdia')
  if (!mdia) return null
  const hdlr = findChildBox(view, mdia, 'hdlr')
  if (!hdlr) return null
  // hdlr layout: version(1) + flags(3) + pre_defined(4) + handler_type(4) + ...
  if (hdlr.payloadEnd - hdlr.payloadStart < 12) return null
  return readFourCC(view, hdlr.payloadStart + 8)
}
```

Update `_internal` export.

- [ ] **Step 4: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "moov + trak"
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): mp4-probe moov + trak iteration with handler discrimination"
```

---

## Task 6: mdhd + stts → frame rate + NTSC derivation

**Files:**
- Modify: `extension/modules/mp4-probe.js`
- Modify: `extension/modules/__tests__/mp4-probe.test.js`

Frame rate: read trak's `mdia → mdhd` for `timescale` (uint32) and `duration` (uint32 in v0, uint64 in v1). Read `mdia → minf → stbl → stts` for the sample-time table — first entry's `sample_delta` (in trak timescale units) gives `frameRate = timescale / sample_delta`. NTSC flag: true when `timescale` is `n * 1000` and `sample_delta * 1001 ≈ timescale` (i.e. `30000/1001`-style fractional rate).

- [ ] **Step 1: Write failing tests for frame rate derivation**

Append:

```js
describe('mp4-probe mdhd + stts frame rate', () => {
  it.each([
    ['30_cfr.mp4',     { frameRate: 30, ntsc: false }],
    ['25_pal.mp4',     { frameRate: 25, ntsc: false }],
    ['50_pal.mp4',     { frameRate: 50, ntsc: false }],
    ['60_cfr.mp4',     { frameRate: 60, ntsc: false }],
    ['2997_ntsc.mov',  { frameRate: 30, ntsc: true  }],
    ['23976_ntsc.mov', { frameRate: 24, ntsc: true  }],
    ['5994_ntsc.mov',  { frameRate: 60, ntsc: true  }],
  ])('reads %s as { frameRate: %s.frameRate, ntsc: %s.ntsc }', (filename, expected) => {
    const view = loadFixture(filename)
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    const videoTrak = traks.find(t => _internal.readTrakHandler(view, t) === 'vide')
    const { frameRate, ntsc } = _internal.readVideoTrakRate(view, videoTrak)
    expect(frameRate).toBe(expected.frameRate)
    expect(ntsc).toBe(expected.ntsc)
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "mdhd"
```
Expected: 7 tests fail — `readVideoTrakRate is not a function`.

- [ ] **Step 3: Implement mdhd + stts parsing**

Append to `mp4-probe.js`:

```js
function readMdhd(view, trak) {
  const mdia = findChildBox(view, trak, 'mdia')
  if (!mdia) return null
  const mdhd = findChildBox(view, mdia, 'mdhd')
  if (!mdhd) return null
  const versionFlags = view.getUint32(mdhd.payloadStart, false)
  const version = (versionFlags >>> 24) & 0xff
  // v0: creation(4) + mod(4) + timescale(4) + duration(4)
  // v1: creation(8) + mod(8) + timescale(4) + duration(8)
  const off = mdhd.payloadStart + 4
  if (version === 0) {
    if (mdhd.payloadEnd - off < 16) return null
    return {
      timescale: readU32BE(view, off + 8),
      duration: readU32BE(view, off + 12),
    }
  }
  if (version === 1) {
    if (mdhd.payloadEnd - off < 28) return null
    const big = readU64BE(view, off + 20)
    return {
      timescale: readU32BE(view, off + 16),
      duration: big > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(big),
    }
  }
  return null
}

function readSttsEntries(view, trak) {
  const mdia = findChildBox(view, trak, 'mdia')
  if (!mdia) return null
  const minf = findChildBox(view, mdia, 'minf')
  if (!minf) return null
  const stbl = findChildBox(view, minf, 'stbl')
  if (!stbl) return null
  const stts = findChildBox(view, stbl, 'stts')
  if (!stts) return null
  // stts: version(1) + flags(3) + entry_count(4) + entries[ count(4) + delta(4) ]
  const off = stts.payloadStart
  if (stts.payloadEnd - off < 8) return null
  const entryCount = readU32BE(view, off + 4)
  const entries = []
  let cursor = off + 8
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 8 > stts.payloadEnd) break
    entries.push({
      sampleCount: readU32BE(view, cursor),
      sampleDelta: readU32BE(view, cursor + 4),
    })
    cursor += 8
  }
  return entries
}

function readVideoTrakRate(view, trak) {
  const mdhd = readMdhd(view, trak)
  if (!mdhd || !mdhd.timescale) return { frameRate: null, ntsc: false }
  const entries = readSttsEntries(view, trak)
  if (!entries || entries.length === 0) return { frameRate: null, ntsc: false }
  // Use the first entry's sample_delta. For CFR, this is the only entry.
  // (VFR handling lives in Task 9.)
  const { sampleDelta } = entries[0]
  if (!sampleDelta) return { frameRate: null, ntsc: false }
  const exact = mdhd.timescale / sampleDelta  // e.g. 30000/1001 = 29.97
  const frameRate = Math.round(exact)
  // NTSC fractional flag: timescale ends in 000 AND ratio is close to but
  // not equal to its rounded integer. The classic check is the 1001-multiple:
  // 24000/1001, 30000/1001, 60000/1001.
  const ntsc = mdhd.timescale % 1000 === 0
    && sampleDelta === 1001
    && [24000, 30000, 60000, 48000].includes(mdhd.timescale)
  return { frameRate, ntsc }
}
```

Update `_internal` export.

- [ ] **Step 4: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "mdhd"
```
Expected: all 7 parametrized tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): mp4-probe mdhd + stts frame rate derivation"
```

---

## Task 7: tkhd → width/height + durationSeconds

**Files:**
- Modify: `extension/modules/mp4-probe.js`
- Modify: `extension/modules/__tests__/mp4-probe.test.js`

Width/height come from the trak's `tkhd` box. Per the FCP7-targeting spec, we don't emit per-file dims today — but we capture them for future use and (importantly) for the public return shape. Duration in seconds is `mdhd.duration / mdhd.timescale`.

- [ ] **Step 1: Write failing tests**

Append:

```js
describe('mp4-probe tkhd dimensions + duration', () => {
  it('reads 160x90 dims from 30_cfr.mp4', () => {
    const view = loadFixture('30_cfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    const videoTrak = traks.find(t => _internal.readTrakHandler(view, t) === 'vide')
    const { width, height } = _internal.readTkhdDims(view, videoTrak)
    expect(width).toBe(160)
    expect(height).toBe(90)
  })

  it('derives ~1.0s duration from 30_cfr.mp4', () => {
    const view = loadFixture('30_cfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    const videoTrak = traks.find(t => _internal.readTrakHandler(view, t) === 'vide')
    const sec = _internal.readVideoTrakDurationSeconds(view, videoTrak)
    expect(sec).toBeGreaterThan(0.9)
    expect(sec).toBeLessThan(1.1)
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "tkhd"
```
Expected: 2 tests fail.

- [ ] **Step 3: Implement tkhd + duration**

Append to `mp4-probe.js`:

```js
function readTkhdDims(view, trak) {
  const tkhd = findChildBox(view, trak, 'tkhd')
  if (!tkhd) return { width: null, height: null }
  const versionFlags = view.getUint32(tkhd.payloadStart, false)
  const version = (versionFlags >>> 24) & 0xff
  // v0: 4(vf) + 4(cre) + 4(mod) + 4(tid) + 4(rsv) + 4(dur) + 8(rsv) + 8(layer/group) + 2(vol) + 2(rsv) + 36(matrix) + 4(width) + 4(height)
  // v1: 4(vf) + 8(cre) + 8(mod) + 4(tid) + 4(rsv) + 8(dur) + 8(rsv) + 8(layer/group) + 2(vol) + 2(rsv) + 36(matrix) + 4(width) + 4(height)
  const fixedOff = tkhd.payloadEnd - 8
  if (fixedOff < tkhd.payloadStart) return { width: null, height: null }
  // tkhd width/height are 16.16 fixed-point
  const wRaw = readU32BE(view, fixedOff)
  const hRaw = readU32BE(view, fixedOff + 4)
  return { width: wRaw >>> 16, height: hRaw >>> 16 }
}

function readVideoTrakDurationSeconds(view, trak) {
  const mdhd = readMdhd(view, trak)
  if (!mdhd || !mdhd.timescale || !mdhd.duration) return null
  return mdhd.duration / mdhd.timescale
}
```

Update `_internal` export.

- [ ] **Step 4: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "tkhd"
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): mp4-probe tkhd dimensions + trak duration"
```

---

## Task 8: tmcd → embedded SMPTE timecode

**Files:**
- Modify: `extension/modules/mp4-probe.js`
- Modify: `extension/modules/__tests__/mp4-probe.test.js`

A trak with handler `tmcd` holds the file's embedded SMPTE start timecode. Its `stsd → tmcd` describes the timecode framerate; the first sample (in `mdat`, addressed by `stco`/`stsc`) is the start-frame value. Reading samples from `mdat` is tricky from a partial buffer — instead we use a simpler heuristic: derive the start TC from the `mdhd` of the tmcd trak, since the trak's mdhd duration is the file's TC duration in TC-timescale units and the trak's start_offset (from elst, edts) gives the TC start. **For our needs**, we just need the start TC string — `with_tmcd.mov` was generated with `-timecode 18:16:14:04`, and ffmpeg stores that in the `tmcd → name` box payload directly as ASCII.

Actually, the canonical way: read the first sample from `mdat` at offset given by `stco` (chunk offset table), then format using `tmcd.flags` (DF bit) and `stsd → tmcd` timescale. For a partial-buffer probe with `mdat` past the cut, we may not have the sample bytes. **Strategy:** try to read; if `mdat` is not in the buffer, return `null` for embeddedTimecode (degrade gracefully — the manifest's embedded_timecode flows through). Real-world Envato/Pexels files typically have small mdats and the sample is reachable.

- [ ] **Step 1: Write failing test**

Append:

```js
describe('mp4-probe tmcd embedded timecode', () => {
  it('extracts 18:16:14:04 from with_tmcd.mov', () => {
    const view = loadFixture('with_tmcd.mov')
    const tc = _internal.readEmbeddedTimecode(view, 0, view.byteLength)
    expect(tc).toBe('18:16:14:04')
  })

  it('returns null when no tmcd trak present', () => {
    const view = loadFixture('30_cfr.mp4')
    const tc = _internal.readEmbeddedTimecode(view, 0, view.byteLength)
    expect(tc).toBeNull()
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "tmcd"
```
Expected: 2 tests fail.

- [ ] **Step 3: Implement tmcd parsing**

Append to `mp4-probe.js`:

```js
function readEmbeddedTimecode(view, start, end) {
  const moov = findMoov(view, start, end)
  if (!moov) return null
  // Find the tmcd-handler trak.
  let tmcdTrak = null
  for (const trak of iterateTraks(view, moov)) {
    if (readTrakHandler(view, trak) === 'tmcd') { tmcdTrak = trak; break }
  }
  if (!tmcdTrak) return null
  // Walk: trak → mdia → minf → stbl → { stsd, stts, stsc, stco|co64 }
  const mdia = findChildBox(view, tmcdTrak, 'mdia')
  if (!mdia) return null
  const minf = findChildBox(view, mdia, 'minf')
  if (!minf) return null
  const stbl = findChildBox(view, minf, 'stbl')
  if (!stbl) return null
  const stsd = findChildBox(view, stbl, 'stsd')
  if (!stsd) return null
  // stsd: version(1) + flags(3) + entry_count(4) + entries...
  // each entry starts with size(4) + type(4), then sample-description-specific data
  // For tmcd: + reserved(6) + data_reference_index(2) + reserved(4) + flags(4) +
  //         + timescale(4) + frame_duration(4) + number_of_frames(1) + reserved(1)
  if (stsd.payloadEnd - stsd.payloadStart < 16) return null
  const firstEntryStart = stsd.payloadStart + 8
  if (firstEntryStart + 8 > stsd.payloadEnd) return null
  const entrySize = readU32BE(view, firstEntryStart)
  const entryType = readFourCC(view, firstEntryStart + 4)
  if (entryType !== 'tmcd') return null
  const tmcdDataStart = firstEntryStart + 8
  if (firstEntryStart + entrySize > stsd.payloadEnd) return null
  // Skip reserved(6) + dataRefIdx(2) + reserved(4) = 12 bytes
  const flagsOff = tmcdDataStart + 12
  if (flagsOff + 14 > stsd.payloadEnd) return null
  const tmcdFlags = readU32BE(view, flagsOff)
  const tmcdTimescale = readU32BE(view, flagsOff + 4)
  const tmcdFrameDur = readU32BE(view, flagsOff + 8)
  const numFrames = view.getUint8(flagsOff + 12)
  const dropFrame = (tmcdFlags & 0x1) !== 0
  if (!tmcdTimescale || !tmcdFrameDur || !numFrames) return null
  // First sample value (the start TC frame number) is stored in mdat at
  // the offset given by stco[0]. The sample is a 32-bit BE integer.
  const stco = findChildBox(view, stbl, 'stco') || findChildBox(view, stbl, 'co64')
  if (!stco) return null
  if (stco.payloadEnd - stco.payloadStart < 12) return null
  const offsetCount = readU32BE(view, stco.payloadStart + 4)
  if (offsetCount === 0) return null
  let sampleOffset
  if (stco.type === 'stco') {
    sampleOffset = readU32BE(view, stco.payloadStart + 8)
  } else {
    const big = readU64BE(view, stco.payloadStart + 8)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    sampleOffset = Number(big)
  }
  if (sampleOffset + 4 > end) return null
  const startFrames = readU32BE(view, sampleOffset)
  // Format as HH:MM:SS:FF (or HH:MM:SS;FF for DF)
  const fps = numFrames
  const totalFrames = startFrames
  const ff = totalFrames % fps
  const totalSec = Math.floor(totalFrames / fps)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60) % 60
  const hh = Math.floor(totalSec / 3600)
  const sep = dropFrame ? ';' : ':'
  const pad = n => String(n).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`
}
```

Update `_internal` export.

- [ ] **Step 4: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "tmcd"
```
Expected: 2 tests pass.

> **Note:** If the with_tmcd.mov fixture's TC sample lives in mdat beyond byte 1MB, our partial-buffer probe will return null. Fixture is 1-second 160x90 — mdat is ~30KB, well within the first 1MB. If a real Envato file ever has the sample past 1MB, the moov-at-end fallback (Task 10) will pull the tail bytes that contain the sample. Acceptable degradation.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): mp4-probe tmcd track → embedded SMPTE timecode"
```

---

## Task 9: VFR detection + bogus value rejection

**Files:**
- Modify: `extension/modules/mp4-probe.js`
- Modify: `extension/modules/__tests__/mp4-probe.test.js`

When `stts` has multiple entries with significantly different `sampleDelta` values, the source is VFR (variable frame rate). We compute a weighted average across all entries (each entry weighted by `sampleCount`) and flag the event in telemetry; we still emit the averaged rate. Reject any derived rate ≤ 0, NaN, or > 120.

- [ ] **Step 1: Write failing tests**

Append:

```js
describe('mp4-probe VFR + bogus value handling', () => {
  it('detects VFR and returns weighted average', () => {
    const view = loadFixture('vfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    const videoTrak = traks.find(t => _internal.readTrakHandler(view, t) === 'vide')
    const result = _internal.readVideoTrakRate(view, videoTrak)
    expect(result.frameRate).toBeGreaterThanOrEqual(20)
    expect(result.frameRate).toBeLessThanOrEqual(60)
    expect(result.isVfr).toBe(true)
  })

  it('rejects derived rate > 120 as bogus', () => {
    // Synthetic mdhd with timescale=10000000, sampleDelta=1 → rate=10M → reject
    expect(_internal.normalizeFrameRate(10_000_000, 1)).toEqual({
      frameRate: null, ntsc: false, isBogus: true,
    })
  })

  it('rejects sampleDelta=0 (NaN guard)', () => {
    expect(_internal.normalizeFrameRate(30000, 0)).toEqual({
      frameRate: null, ntsc: false, isBogus: true,
    })
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "VFR"
```
Expected: 3 tests fail.

- [ ] **Step 3: Refactor `readVideoTrakRate` for VFR + add `normalizeFrameRate`**

Replace `readVideoTrakRate` in `mp4-probe.js`:

```js
function normalizeFrameRate(timescale, sampleDelta) {
  if (!timescale || !sampleDelta || sampleDelta <= 0) {
    return { frameRate: null, ntsc: false, isBogus: true }
  }
  const exact = timescale / sampleDelta
  if (!Number.isFinite(exact) || exact <= 0 || exact > 120) {
    return { frameRate: null, ntsc: false, isBogus: true }
  }
  const frameRate = Math.round(exact)
  const ntsc = timescale % 1000 === 0
    && sampleDelta === 1001
    && [24000, 30000, 48000, 60000].includes(timescale)
  return { frameRate, ntsc, isBogus: false }
}

function readVideoTrakRate(view, trak) {
  const mdhd = readMdhd(view, trak)
  if (!mdhd || !mdhd.timescale) return { frameRate: null, ntsc: false, isVfr: false }
  const entries = readSttsEntries(view, trak)
  if (!entries || entries.length === 0) return { frameRate: null, ntsc: false, isVfr: false }
  if (entries.length === 1) {
    const norm = normalizeFrameRate(mdhd.timescale, entries[0].sampleDelta)
    return { ...norm, isVfr: false }
  }
  // VFR: weighted average of sampleDelta across all entries
  let totalSamples = 0
  let totalDuration = 0  // in timescale units
  let minDelta = Infinity
  let maxDelta = 0
  for (const e of entries) {
    totalSamples += e.sampleCount
    totalDuration += e.sampleCount * e.sampleDelta
    minDelta = Math.min(minDelta, e.sampleDelta)
    maxDelta = Math.max(maxDelta, e.sampleDelta)
  }
  if (totalSamples === 0 || totalDuration === 0) {
    return { frameRate: null, ntsc: false, isVfr: false }
  }
  const avgDelta = totalDuration / totalSamples
  const norm = normalizeFrameRate(mdhd.timescale, avgDelta)
  // VFR if the spread between min/max sampleDelta is > 10% of the average
  const isVfr = (maxDelta - minDelta) / avgDelta > 0.1
  return { ...norm, isVfr }
}
```

Update `_internal` export to include `normalizeFrameRate`.

- [ ] **Step 4: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "VFR"
```
Expected: 3 tests pass. Also re-run the earlier mdhd tests to ensure no regression:

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "mdhd"
```
Expected: 7 mdhd tests still pass (single-entry `stts` path returns `isVfr: false`).

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): mp4-probe VFR detection + bogus rate rejection"
```

---

## Task 10: Public `probeMp4File()` with moov-at-end fallback + telemetry

**Files:**
- Modify: `extension/modules/mp4-probe.js`
- Modify: `extension/modules/__tests__/mp4-probe.test.js`

This task assembles the public surface. `probeMp4File(fileUrl, opts)` fetches the first 1 MB, tries to parse. If moov is not in the first 1 MB and `mdat` was seen first (faststart=false), do a HEAD request, then a tail-range fetch. Emit named telemetry events for each outcome via an injected `emit` function (default no-op for tests; production wires it to the existing `telemetry.js` emit).

- [ ] **Step 1: Write failing tests**

Append:

```js
import { vi } from 'vitest'

describe('mp4-probe public probeMp4File', () => {
  function makeFetch(fixturePath, totalSize = null) {
    return vi.fn(async (url, opts) => {
      const bytes = readFileSync(resolve(__dirname, '../../fixtures/mp4', fixturePath))
      const size = totalSize ?? bytes.length
      if (opts?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': String(size) } })
      }
      const range = opts?.headers?.Range || ''
      const m = range.match(/bytes=(\d+)-(\d+)/)
      if (m) {
        const a = Number(m[1]), b = Math.min(Number(m[2]), bytes.length - 1)
        return new Response(bytes.slice(a, b + 1), { status: 206 })
      }
      return new Response(bytes, { status: 200 })
    })
  }

  it('returns success metadata for a faststart MP4', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = makeFetch('30_cfr.mp4')
    const result = await probeMp4File('file:///fake', { fetchFn, emit })
    expect(result).toMatchObject({
      frameRate: 30, ntsc: false, width: 160, height: 90,
    })
    expect(result.durationSeconds).toBeGreaterThan(0.9)
    expect(emit).toHaveBeenCalledWith('fps_probe_success', expect.any(Object))
  })

  it('handles moov-at-end via tail range', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = makeFetch('moov_at_end.mp4')
    const result = await probeMp4File('file:///fake', { fetchFn, emit, headRangeBytes: 256 })
    expect(result).toMatchObject({ frameRate: 30, ntsc: false })
    expect(emit).toHaveBeenCalledWith('fps_probe_success', expect.any(Object))
  })

  it('returns null + emits unsupported_brand for non-MP4', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
      0x77, 0x65, 0x62, 0x6d, 0x00, 0x00, 0x00, 0x00,
    ])))
    const result = await probeMp4File('file:///fake', { fetchFn, emit })
    expect(result).toBeNull()
    expect(emit).toHaveBeenCalledWith('fps_probe_failed_unsupported_brand', expect.any(Object))
  })

  it('returns null + emits timeout when fetch never resolves', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = () => new Promise(() => {})  // never resolves
    const result = await probeMp4File('file:///fake', { fetchFn, emit, timeoutMs: 50 })
    expect(result).toBeNull()
    expect(emit).toHaveBeenCalledWith('fps_probe_timeout', expect.any(Object))
  })

  it('returns null + emits failed_fetch on rejected fetch', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = vi.fn(async () => { throw new Error('OS error') })
    const result = await probeMp4File('file:///fake', { fetchFn, emit })
    expect(result).toBeNull()
    expect(emit).toHaveBeenCalledWith('fps_probe_failed_fetch', expect.objectContaining({
      error: expect.stringContaining('OS error'),
    }))
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js -t "public probeMp4File"
```
Expected: 5 tests fail — `probeMp4File` not exported.

- [ ] **Step 3: Implement `probeMp4File`**

Append to `mp4-probe.js`:

```js
const DEFAULT_HEAD_RANGE = 1024 * 1024  // 1 MB
const DEFAULT_TIMEOUT_MS = 10_000

function noopEmit() {}

async function fetchRange(fetchFn, url, start, end) {
  const headers = (start === 0 && end === undefined)
    ? {}
    : { Range: `bytes=${start}-${end ?? ''}` }
  const res = await fetchFn(url, { headers })
  if (!res.ok && res.status !== 206 && res.status !== 200) {
    throw new Error(`fetch returned ${res.status}`)
  }
  const ab = await res.arrayBuffer()
  return new DataView(ab)
}

function parseFromView(view, startInBuffer, endInBuffer) {
  let ftyp = null
  let moov = null
  let sawMdat = false
  for (const box of iterateBoxes(view, startInBuffer, endInBuffer)) {
    if (box.type === 'ftyp') ftyp = box
    else if (box.type === 'moov') { moov = box; break }
    else if (box.type === 'mdat') sawMdat = true
  }
  return { ftyp, moov, sawMdat }
}

function extractMetadataFromMoov(view, moov, bufferEnd) {
  const traks = [...iterateTraks(view, moov)]
  const videoTrak = traks.find(t => readTrakHandler(view, t) === 'vide')
  if (!videoTrak) return null
  const { frameRate, ntsc, isVfr, isBogus } = readVideoTrakRate(view, videoTrak)
  if (isBogus || frameRate === null) return { bogus: true }
  const { width, height } = readTkhdDims(view, videoTrak)
  const durationSeconds = readVideoTrakDurationSeconds(view, videoTrak)
  const embeddedTimecode = readEmbeddedTimecode(view, 0, bufferEnd)
  return { frameRate, ntsc, width, height, durationSeconds, embeddedTimecode, isVfr }
}

export async function probeMp4File(fileUrl, opts = {}) {
  const {
    fetchFn = globalThis.fetch,
    emit = noopEmit,
    headRangeBytes = DEFAULT_HEAD_RANGE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts

  const probeStart = Date.now()
  const ctx = { url: fileUrl }
  let timer

  try {
    const result = await Promise.race([
      (async () => {
        // First range: bytes=0-(headRangeBytes-1)
        let view
        try {
          view = await fetchRange(fetchFn, fileUrl, 0, headRangeBytes - 1)
        } catch (err) {
          emit('fps_probe_failed_fetch', { ...ctx, error: String(err?.message || err) })
          return null
        }
        if (view.byteLength < 16) {
          emit('fps_probe_failed_not_mp4', { ...ctx, byteLength: view.byteLength })
          return null
        }
        const { ftyp, moov: moovInHead, sawMdat } = parseFromView(view, 0, view.byteLength)
        if (!ftyp || !validateFtypBrand(view, ftyp)) {
          emit('fps_probe_failed_unsupported_brand', { ...ctx })
          return null
        }
        let moov = moovInHead
        let bufferEnd = view.byteLength
        if (!moov && sawMdat) {
          // Try tail range
          let total
          try {
            const headRes = await fetchFn(fileUrl, { method: 'HEAD' })
            total = Number(headRes.headers.get('content-length') || '0')
          } catch {
            emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'head_failed' })
            return null
          }
          if (!total || total <= headRangeBytes) {
            emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'no_total_size' })
            return null
          }
          let tailView
          try {
            tailView = await fetchRange(fetchFn, fileUrl, total - headRangeBytes, total - 1)
          } catch (err) {
            emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'tail_fetch_failed' })
            return null
          }
          const { moov: moovInTail } = parseFromView(tailView, 0, tailView.byteLength)
          if (!moovInTail) {
            emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'tail_no_moov' })
            return null
          }
          moov = moovInTail
          view = tailView
          bufferEnd = tailView.byteLength
        }
        if (!moov) {
          emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'not_in_head' })
          return null
        }
        let meta
        try {
          meta = extractMetadataFromMoov(view, moov, bufferEnd)
        } catch (err) {
          emit('fps_probe_failed_parse_error', { ...ctx, error: String(err?.message || err) })
          return null
        }
        if (!meta) {
          emit('fps_probe_failed_no_timing', ctx)
          return null
        }
        if (meta.bogus) {
          emit('fps_probe_failed_bogus_value', ctx)
          return null
        }
        if (meta.isVfr) {
          emit('fps_probe_vfr_detected', { ...ctx, frameRate: meta.frameRate })
        }
        emit('fps_probe_success', {
          ...ctx,
          frameRate: meta.frameRate,
          ntsc: meta.ntsc,
          width: meta.width,
          height: meta.height,
          durationSeconds: meta.durationSeconds,
          embeddedTimecode: meta.embeddedTimecode,
          elapsedMs: Date.now() - probeStart,
        })
        return {
          frameRate: meta.frameRate,
          ntsc: meta.ntsc,
          width: meta.width,
          height: meta.height,
          durationSeconds: meta.durationSeconds,
          embeddedTimecode: meta.embeddedTimecode,
        }
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          emit('fps_probe_timeout', { ...ctx, timeoutMs })
          resolve(null)
        }, timeoutMs)
      }),
    ])
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/mp4-probe.test.js
```
Expected: all tests in the file pass (~20 tests total).

- [ ] **Step 5: Commit**

```bash
git add extension/modules/mp4-probe.js extension/modules/__tests__/mp4-probe.test.js
git commit -m "feat(ext): mp4-probe public probeMp4File with moov-at-end fallback + telemetry"
```

---

## Task 11: Manifest update — file:// permission + version bump

**Files:**
- Modify: `extension/manifest.json`

- [ ] **Step 1: Read current manifest**

Run:
```bash
cat extension/manifest.json
```
Note the current `version` (should be `0.9.5`) and the `host_permissions` array. Confirm there's no existing `file:///*` entry.

- [ ] **Step 2: Bump version to 1.0.0 and add file:// permission**

Edit `extension/manifest.json` — change the `version` field from `"0.9.5"` to `"1.0.0"`, and append `"file:///*"` to the existing `host_permissions` array (preserving the existing six entries).

Resulting `host_permissions` value:
```json
[
  "https://elements.envato.com/*",
  "https://app.envato.com/*",
  "https://video-downloads.elements.envatousercontent.com/*",
  "https://videos.pexels.com/*",
  "https://images.pexels.com/*",
  "https://*.freepik.com/*",
  "file:///*"
]
```

- [ ] **Step 3: Verify manifest still parses**

Run:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('extension/manifest.json')).version)"
```
Expected: `1.0.0`.

- [ ] **Step 4: Update version constant if mirrored elsewhere**

Run:
```bash
grep -rn "0\.9\.5\|EXT_VERSION" extension/ --include="*.js" | head -20
```
If any module exports an `EXT_VERSION` constant (typically `extension/modules/version.js` or inline in `extension/manifest.json`-reading code), update it. If `EXT_VERSION` reads `chrome.runtime.getManifest().version`, no source change needed. If it's hardcoded, change to `'1.0.0'`.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json $(git status --short extension/ | grep "^.M" | awk '{print $2}')
git commit -m "feat(ext): manifest v1.0.0 — add file:// host permission for FPS probe"
```

---

## Task 12: Queue integration — probe after download, attach to `state.items[i]`

**Files:**
- Modify: `extension/modules/queue.js`
- Create: `extension/modules/__tests__/queue-probe.test.js`

The completion path lives in `queue.js` at the `chrome.downloads.onChanged` listener (around line 440 per investigation). After the listener detects `state === 'complete'` and writes `final_path` to the item, kick off `probeMp4File()` (gated by `chrome.extension.isAllowedFileSchemeAccess()`) and attach the result to `state.items[i].probed_metadata`. Probe runs async — it must not block the item-complete state transition.

- [ ] **Step 1: Read the current completion handler in queue.js**

Run:
```bash
grep -n "chrome.downloads.onChanged\|state === 'complete'\|final_path" extension/modules/queue.js | head -20
```
Identify the block that transitions an item to its terminal completed state.

- [ ] **Step 2: Write failing integration test**

Create `extension/modules/__tests__/queue-probe.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Minimal stub chrome.* — only the bits queue.js touches in the probe path
function setupChrome({ isAllowed = true } = {}) {
  globalThis.chrome = {
    extension: { isAllowedFileSchemeAccess: vi.fn(async () => isAllowed) },
    downloads: { download: vi.fn(), search: vi.fn(), onChanged: { addListener: vi.fn() } },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn() } },
    runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
  }
  globalThis.fetch = vi.fn(async (url, opts) => {
    const fixturePath = resolve(__dirname, '../../fixtures/mp4/30_cfr.mp4')
    const bytes = readFileSync(fixturePath)
    if (opts?.method === 'HEAD') {
      return new Response(null, { headers: { 'content-length': String(bytes.length) } })
    }
    return new Response(bytes, { status: 200 })
  })
}

describe('queue probe integration', () => {
  beforeEach(() => setupChrome())

  it('attaches probed_metadata to state.items[i] when permission granted', async () => {
    setupChrome({ isAllowed: true })
    const { runProbeForItem } = await import('../queue.js')
    const item = { seq: 1, final_path: '/Users/test/30_cfr.mp4', probed_metadata: undefined }
    await runProbeForItem(item)
    expect(item.probed_metadata).toMatchObject({ frameRate: 30, ntsc: false })
  })

  it('skips probe when permission denied; item.probed_metadata stays undefined', async () => {
    setupChrome({ isAllowed: false })
    const { runProbeForItem } = await import('../queue.js')
    const item = { seq: 1, final_path: '/Users/test/30_cfr.mp4', probed_metadata: undefined }
    await runProbeForItem(item)
    expect(item.probed_metadata).toBeUndefined()
  })

  it('emits fps_probe_skipped_no_permission once per run when denied', async () => {
    setupChrome({ isAllowed: false })
    const emit = vi.fn()
    const { runProbeForItem } = await import('../queue.js')
    const items = [
      { seq: 1, final_path: '/Users/test/a.mp4' },
      { seq: 2, final_path: '/Users/test/b.mp4' },
      { seq: 3, final_path: '/Users/test/c.mp4' },
    ]
    const ctx = { hasEmittedSkipForRun: false }
    for (const item of items) {
      await runProbeForItem(item, { emit, runContext: ctx })
    }
    const skipCalls = emit.mock.calls.filter(c => c[0] === 'fps_probe_skipped_no_permission')
    expect(skipCalls.length).toBe(1)
  })
})
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/queue-probe.test.js
```
Expected: FAIL — `runProbeForItem` not exported.

- [ ] **Step 4: Add `runProbeForItem` to queue.js**

In `extension/modules/queue.js`, add an import for `probeMp4File`:

```js
import { probeMp4File } from './mp4-probe.js'
```

(Match existing import style — likely top of file alongside other module imports.)

Add this exported function near the other helpers (above the main `startRun` function):

```js
// Probe a completed-download item's on-disk file via file:// fetch.
// Mutates `item.probed_metadata` on success. No-op when permission denied.
// `runContext` is an object that tracks per-run state (e.g. one-shot
// emission of the "no permission" telemetry event); when omitted, every
// permission-denied call emits its own skip event.
export async function runProbeForItem(item, { emit = noopEmit, runContext = null } = {}) {
  if (!item || !item.final_path) return
  const allowed = await chrome.extension.isAllowedFileSchemeAccess()
  if (!allowed) {
    if (runContext && !runContext.hasEmittedSkipForRun) {
      emit('fps_probe_skipped_no_permission', { reason: 'file_access_disabled' })
      runContext.hasEmittedSkipForRun = true
    } else if (!runContext) {
      emit('fps_probe_skipped_no_permission', { reason: 'file_access_disabled' })
    }
    return
  }
  const fileUrl = 'file://' + item.final_path
  const result = await probeMp4File(fileUrl, { emit })
  if (result) item.probed_metadata = result
}

function noopEmit() {}
```

(Use the queue.js file's existing `emit` import if it has one, instead of `noopEmit`. Check `import { emit } from './telemetry.js'` — if present, use it as the default in production callers, not in this helper signature.)

- [ ] **Step 5: Wire `runProbeForItem` into the `chrome.downloads.onChanged` complete handler**

Locate the block inside the `chrome.downloads.onChanged` listener that handles `state.current === 'complete'` (line ~440 per investigation). After the item's `final_path` is set and the item transitions to its terminal phase, fire-and-forget the probe:

```js
// Inside the 'complete' branch, after item.final_path = ... and item.phase = 'completed'
runProbeForItem(item, { emit, runContext: state._probeRunContext })
  .catch(err => emit('fps_probe_internal_error', { error: String(err?.message || err) }))
```

In the `startRun()` function (or wherever `state` is initialized), add:

```js
state._probeRunContext = { hasEmittedSkipForRun: false }
```

- [ ] **Step 6: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/queue-probe.test.js
```
Expected: 3 tests pass.

- [ ] **Step 7: Run the full extension test suite to check for regressions**

```bash
npx vitest run --project extension
```
Expected: all extension tests pass, including the prior queue tests.

- [ ] **Step 8: Commit**

```bash
git add extension/modules/queue.js extension/modules/__tests__/queue-probe.test.js
git commit -m "feat(ext): probe downloaded file FPS via file:// after chrome.downloads complete"
```

---

## Task 13: Surface `probed_metadata` in `state.items[i]` snapshot

**Files:**
- Modify: `extension/modules/queue.js` (snapshot builder, line ~715 per investigation)

The snapshot function constructs the per-item record sent to the web app via `{type:'state', export:snapshot()}`. We need to include `probed_metadata` in the snapshot so the web app can read it.

- [ ] **Step 1: Locate the snapshot builder**

Run:
```bash
grep -n "snapshot\|target_filename.*phase" extension/modules/queue.js | head -20
```
Find the function that builds `state.items[i]`-shaped objects for broadcasts (likely named `snapshot` or `buildSnapshot`).

- [ ] **Step 2: Write failing test for snapshot field**

Append to `extension/modules/__tests__/queue-probe.test.js`:

```js
describe('queue snapshot exposes probed_metadata', () => {
  it('snapshot.items[i] includes probed_metadata when set', async () => {
    setupChrome({ isAllowed: true })
    const { buildItemSnapshot } = await import('../queue.js')
    const item = {
      seq: 2, source: 'envato', source_item_id: 'NXG', target_filename: 'a.mov',
      phase: 'completed', bytes_received: 1000, total_bytes: 1000,
      error_code: null, final_path: '/Users/test/a.mov',
      probed_metadata: { frameRate: 30, ntsc: false, width: 1920, height: 1080,
                         durationSeconds: 12.3, embeddedTimecode: '01:00:00:00' },
    }
    const snap = buildItemSnapshot(item)
    expect(snap.probed_metadata).toEqual(item.probed_metadata)
  })

  it('snapshot.items[i] omits probed_metadata when undefined', async () => {
    setupChrome({ isAllowed: false })
    const { buildItemSnapshot } = await import('../queue.js')
    const item = {
      seq: 2, source: 'envato', source_item_id: 'NXG', target_filename: 'a.mov',
      phase: 'completed', bytes_received: 0, total_bytes: 0,
      error_code: null, final_path: null, probed_metadata: undefined,
    }
    const snap = buildItemSnapshot(item)
    expect(snap.probed_metadata).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/queue-probe.test.js -t "snapshot exposes"
```
Expected: FAIL — `buildItemSnapshot` not exported, or existing snapshot doesn't include `probed_metadata`.

- [ ] **Step 4: Modify the snapshot builder**

In `extension/modules/queue.js`, find the function that maps an internal item to the snapshot shape. Add `probed_metadata` to the returned object. If the function is anonymous (inline `.map(item => ({...}))`), extract it into a named export `buildItemSnapshot(item)` and call it from the inline mapper.

Example shape — after edit, the returned object should include:

```js
{
  seq: item.seq,
  source: item.source,
  source_item_id: item.source_item_id,
  target_filename: item.target_filename,
  phase: item.phase,
  bytes_received: item.bytes_received,
  total_bytes: item.total_bytes,
  error_code: item.error_code,
  final_path: item.final_path,
  // ... any existing Ext.6/Ext.7 retry counters ...
  ...(item.probed_metadata ? { probed_metadata: item.probed_metadata } : {}),
}
```

Use the spread-conditional pattern so the key is omitted (not `undefined`) when no probe ran — keeps wire format clean and lets web-app `if (item.probed_metadata)` checks read naturally.

- [ ] **Step 5: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/queue-probe.test.js -t "snapshot exposes"
```
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add extension/modules/queue.js extension/modules/__tests__/queue-probe.test.js
git commit -m "feat(ext): include probed_metadata in per-item snapshot"
```

---

## Task 14: Popup file-access banner state machine

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Modify: `extension/popup.css` (minor — only if existing `.config-banner` styles need extension)

- [ ] **Step 1: Read current popup banner pattern**

Run:
```bash
grep -n "config-banner\|data-severity" extension/popup.html extension/popup.css extension/popup.js | head -30
```
Note the existing markup and the `data-severity="warn"` styling at `extension/popup.css:161-177`. We'll reuse those classes.

- [ ] **Step 2: Add HTML slot for the file-access banner**

In `extension/popup.html`, alongside the existing `<div id="config-banner">`, add a second banner slot:

```html
<div id="file-access-banner" class="config-banner" data-severity="warn" hidden>
  <span class="config-banner-icon" aria-hidden="true">⚠</span>
  <div class="config-banner-body">
    <div class="config-banner-title">Enable FPS verification</div>
    <div class="config-banner-detail">Premiere may fail to find files if their actual frame rate differs from what the preview reports. Enable file access for accurate metadata.</div>
  </div>
  <button id="file-access-show-how" class="config-banner-action" type="button">Show me how</button>
  <button id="file-access-snooze" class="config-banner-snooze" type="button" aria-label="Not now">Not now</button>
</div>

<div id="file-access-howto" class="config-banner config-banner--howto" hidden>
  <ol>
    <li>Click the button below to open this extension's settings page.</li>
    <li>Scroll down and turn on <strong>Allow access to file URLs</strong>.</li>
    <li>Come back here — the banner will disappear automatically.</li>
  </ol>
  <button id="file-access-open-settings" class="config-banner-action" type="button">Open settings</button>
</div>
```

- [ ] **Step 3: Add JS state machine to `popup.js`**

In `extension/popup.js`, add — at the top alongside other imports / constants:

```js
const FILE_ACCESS_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000  // 7 days
```

Add near the existing config-banner handler:

```js
async function refreshFileAccessBanner() {
  const banner = document.getElementById('file-access-banner')
  const howto = document.getElementById('file-access-howto')
  if (!banner || !howto) return
  let allowed = false
  try {
    allowed = await chrome.extension.isAllowedFileSchemeAccess()
  } catch {
    return  // can't check — silently hide
  }
  if (allowed) {
    banner.hidden = true
    howto.hidden = true
    return
  }
  // Permission denied path
  const { run_history_count = 0, fps_banner_snoozed_until = 0 } =
    await chrome.storage.local.get(['run_history_count', 'fps_banner_snoozed_until'])
  const now = Date.now()
  if (run_history_count < 1 || fps_banner_snoozed_until > now) {
    banner.hidden = true
    return
  }
  banner.hidden = false
}

document.getElementById('file-access-show-how')?.addEventListener('click', () => {
  document.getElementById('file-access-banner').hidden = true
  document.getElementById('file-access-howto').hidden = false
})

document.getElementById('file-access-snooze')?.addEventListener('click', async () => {
  await chrome.storage.local.set({ fps_banner_snoozed_until: Date.now() + FILE_ACCESS_SNOOZE_MS })
  document.getElementById('file-access-banner').hidden = true
})

document.getElementById('file-access-open-settings')?.addEventListener('click', () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
})

// Hook into existing popup-open + focus events
refreshFileAccessBanner()
window.addEventListener('focus', refreshFileAccessBanner)
```

- [ ] **Step 4: Increment `run_history_count` when a run starts**

Find where `startRun` is called in the service worker. After a successful run start, increment the counter:

```js
const { run_history_count = 0 } = await chrome.storage.local.get('run_history_count')
await chrome.storage.local.set({ run_history_count: run_history_count + 1 })
```

If this counter already exists for other purposes, reuse it; if not, add it.

- [ ] **Step 5: Manual sanity check** (this can't be unit-tested cleanly because it's DOM glue)

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-fps-probe"
npm run ext:package
```
Expected: builds `extension/dist/extension-1.0.0.zip`. Load unpacked in `chrome://extensions`. Open popup. Verify:
- With file access OFF + no run history: banner is hidden.
- With file access OFF + after at least one run: banner appears.
- Click "Show me how" → instructions show.
- Click "Open settings" → new tab to this extension's Details page.
- Toggle "Allow access to file URLs" → reopen popup → banner gone.

Document the manual smoke result in the commit message.

- [ ] **Step 6: Commit**

```bash
git add extension/popup.html extension/popup.js extension/popup.css extension/service_worker.js
git commit -m "feat(ext): popup banner coaches user to enable file:// access for FPS probe

Manual smoke: file-access-OFF + 1 run history → banner shown;
'Show me how' reveals instructions; 'Open settings' deep-links to
chrome://extensions Details for this extension; toggling on +
reopening popup hides the banner."
```

---

## Task 15: Pre-export telemetry gate (no block)

**Files:**
- Modify: `extension/service_worker.js`

When the web app sends `{type:'export'}`, the existing `enforceConfigBeforeExport()` flow runs. Before that returns success, emit a one-off telemetry event if file access is denied. **Do not block** — the user has chosen their friction tolerance.

- [ ] **Step 1: Locate the pre-export gate**

Run:
```bash
grep -n "enforceConfigBeforeExport\|type.*'export'" extension/service_worker.js | head
```
Find the message handler block that receives `{type:'export'}` from the web app.

- [ ] **Step 2: Add the telemetry emit**

In the handler, right after `enforceConfigBeforeExport()` returns `ok: true` and before passing the manifest into `startRun()`, add:

```js
try {
  const allowed = await chrome.extension.isAllowedFileSchemeAccess()
  if (!allowed) {
    emit('export_started_without_fps_probe', { reason: 'file_access_disabled' })
  }
} catch {
  // best effort — don't break export on telemetry failure
}
```

- [ ] **Step 3: Smoke test by running a no-op export**

Manual check: with file access disabled, trigger an export from the web app. Look for `export_started_without_fps_probe` in the telemetry queue (`chrome.storage.local.get('telemetry_queue')` in the extension service worker console).

- [ ] **Step 4: Commit**

```bash
git add extension/service_worker.js
git commit -m "feat(ext): emit export_started_without_fps_probe telemetry when file access denied"
```

---

## Task 16: Backend `/api/ext-config` — add `fps_probe_enabled` flag

**Files:**
- Modify: `server/services/ext-config.js`
- Modify: `server/routes/__tests__/ext-config.test.js` (assume exists; if not, create)

- [ ] **Step 1: Locate and read the ext-config service**

Run:
```bash
cat server/services/ext-config.js | head -80
```
Note the response shape (lines 53-65 per investigation): existing fields are `min_ext_version`, `export_enabled`, `envato_enabled`, `pexels_enabled`, `freepik_enabled`, `daily_cap_override`, `slack_alerts_enabled`.

- [ ] **Step 2: Write failing test**

Edit `server/routes/__tests__/ext-config.test.js` (or create if missing) — add a test asserting the new field:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { app } from '../../app.js'  // adjust if app is exposed elsewhere

describe('GET /api/ext-config', () => {
  it('includes fps_probe_enabled in the response', async () => {
    const res = await request(app).get('/api/ext-config')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('fps_probe_enabled')
    expect(typeof res.body.fps_probe_enabled).toBe('boolean')
  })

  it('defaults fps_probe_enabled to true', async () => {
    const res = await request(app).get('/api/ext-config')
    expect(res.body.fps_probe_enabled).toBe(true)
  })
})
```

If `app` is not exposed as a named export, check existing test files like `server/routes/__tests__/exports.test.js` for the conventional import — match what those use.

- [ ] **Step 3: Run test, expect FAIL**

```bash
npx vitest run server/routes/__tests__/ext-config.test.js -t "fps_probe_enabled"
```
Expected: 2 tests fail with "expected response to have property fps_probe_enabled".

- [ ] **Step 4: Add the field**

In `server/services/ext-config.js`, find the function that builds the response (line ~53). Add the new field to the returned object:

```js
return {
  min_ext_version: getMinExtVersion(),
  export_enabled: getExportEnabled(),
  envato_enabled: getEnvatoEnabled(),
  pexels_enabled: getPexelsEnabled(),
  freepik_enabled: getFreepikEnabled(),
  daily_cap_override: getDailyCapOverride(),
  slack_alerts_enabled: getSlackAlertsEnabled(),
  fps_probe_enabled: getFpsProbeEnabled(),
}
```

And add the getter at the bottom of the file:

```js
function getFpsProbeEnabled() {
  const v = process.env.EXT_FPS_PROBE_ENABLED
  if (v === undefined || v === '' || v === 'true' || v === '1') return true
  return false
}
```

- [ ] **Step 5: Run test, expect PASS**

```bash
npx vitest run server/routes/__tests__/ext-config.test.js -t "fps_probe_enabled"
```
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/ext-config.js server/routes/__tests__/ext-config.test.js
git commit -m "feat(server): add fps_probe_enabled flag to /api/ext-config (default true)"
```

---

## Task 17: Extension config-fetch consumes `fps_probe_enabled`

**Files:**
- Modify: `extension/modules/config-fetch.js`
- Modify: `extension/modules/__tests__/config-fetch.test.js`
- Modify: `extension/modules/queue.js` (gate `runProbeForItem` on the flag)

- [ ] **Step 1: Read current config-fetch**

```bash
cat extension/modules/config-fetch.js | head -100
```
Note the fall-open defaults — find the object that gets returned when network/cache fail. We need `fps_probe_enabled: true` in the same place.

- [ ] **Step 2: Write failing test**

Add to `extension/modules/__tests__/config-fetch.test.js`:

```js
describe('fps_probe_enabled config field', () => {
  it('parses fps_probe_enabled from server response', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      min_ext_version: '0.1.0',
      export_enabled: true, envato_enabled: true, pexels_enabled: true,
      freepik_enabled: true, daily_cap_override: null, slack_alerts_enabled: true,
      fps_probe_enabled: false,
    }), { headers: { 'content-type': 'application/json' } }))
    const { fetchConfig } = await import('../config-fetch.js')
    const config = await fetchConfig()
    expect(config.fps_probe_enabled).toBe(false)
  })

  it('falls open to fps_probe_enabled=true when network fails', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('net') })
    chrome.storage.local.get = vi.fn(async () => ({}))  // no cache
    const { fetchConfig } = await import('../config-fetch.js')
    const config = await fetchConfig()
    expect(config.fps_probe_enabled).toBe(true)
  })
})
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/config-fetch.test.js -t "fps_probe_enabled"
```
Expected: FAIL — field missing in parsed config.

- [ ] **Step 4: Add `fps_probe_enabled` to parse + fall-open paths**

In `extension/modules/config-fetch.js`:

1. In the parse path (where the JSON response is normalized into the in-memory config), pass through `fps_probe_enabled` with a fallback to `true`:
   ```js
   fps_probe_enabled: typeof json.fps_probe_enabled === 'boolean' ? json.fps_probe_enabled : true,
   ```
2. In the fall-open defaults object, add:
   ```js
   fps_probe_enabled: true,
   ```

- [ ] **Step 5: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/config-fetch.test.js -t "fps_probe_enabled"
```
Expected: 2 tests pass.

- [ ] **Step 6: Gate `runProbeForItem` on the flag**

In `extension/modules/queue.js`, modify `runProbeForItem` to read the cached config and skip when disabled:

```js
import { getCachedConfig } from './config-fetch.js'

export async function runProbeForItem(item, { emit = noopEmit, runContext = null } = {}) {
  if (!item || !item.final_path) return
  const config = getCachedConfig()
  if (config && config.fps_probe_enabled === false) {
    if (runContext && !runContext.hasEmittedSkipForRun) {
      emit('fps_probe_skipped_remote_kill', { reason: 'fps_probe_enabled_false' })
      runContext.hasEmittedSkipForRun = true
    }
    return
  }
  // ... rest of the existing function (permission check + probe + emit)
}
```

- [ ] **Step 7: Add a test for the remote-kill gate**

Append to `extension/modules/__tests__/queue-probe.test.js`:

```js
describe('queue probe respects fps_probe_enabled flag', () => {
  it('skips probe when getCachedConfig returns fps_probe_enabled=false', async () => {
    setupChrome({ isAllowed: true })
    vi.doMock('../config-fetch.js', () => ({
      getCachedConfig: () => ({ fps_probe_enabled: false }),
    }))
    const { runProbeForItem } = await import('../queue.js?v=killed')
    const emit = vi.fn()
    const item = { seq: 1, final_path: '/Users/test/30_cfr.mp4', probed_metadata: undefined }
    await runProbeForItem(item, { emit, runContext: { hasEmittedSkipForRun: false } })
    expect(item.probed_metadata).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('fps_probe_skipped_remote_kill', expect.any(Object))
    vi.doUnmock('../config-fetch.js')
  })
})
```

> **Note:** vitest doesn't reload ESM modules cleanly across `vi.doMock`. The `?v=killed` query is one workaround; if it doesn't work in your vitest version, use `vi.resetModules()` + dynamic import in a `beforeEach`, or split this test into its own file.

- [ ] **Step 8: Run all queue-probe tests**

```bash
npx vitest run extension/modules/__tests__/queue-probe.test.js
```
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add extension/modules/config-fetch.js extension/modules/queue.js \
        extension/modules/__tests__/config-fetch.test.js \
        extension/modules/__tests__/queue-probe.test.js
git commit -m "feat(ext): gate FPS probe on fps_probe_enabled flag from /api/ext-config"
```

---

## Task 18: Web app — merge `probed_metadata` into variant placements with precedence

**Files:**
- Modify: `src/hooks/useExportXmlKickoff.js` (or wherever `buildVariantsPayload` lives — find via grep)
- Create or modify: a unit test file in `src/hooks/__tests__/` for the merge logic

This is the precedence point. When the web app builds the variants payload (after the extension's complete event), each placement in each variant gets its source-clip metadata. Today, placements carry `sourceFrameRate`/`ntsc`/`embeddedTimecode`/`sourceDurationSeconds`/`width`/`height` from the manifest. We add a step that overlays per-item probed values where present.

- [ ] **Step 1: Locate `buildVariantsPayload`**

Run:
```bash
grep -rn "buildVariantsPayload\|completed_items\|item.probed" src/ | head
```
Find the function that walks `state.items` and constructs the `{variants: [{label, placements: [...]}]}` payload for `POST /api/exports/:id/result`.

- [ ] **Step 2: Write failing unit test for the merge**

If `buildVariantsPayload` is not exported, export it (named export). Create or extend a test file:

```js
import { describe, it, expect } from 'vitest'
import { buildVariantsPayload } from '../useExportXmlKickoff.js'  // adjust path

describe('buildVariantsPayload precedence rule', () => {
  const items = [
    {
      seq: 0, source: 'aroll', source_item_id: 'aroll', target_filename: 'aroll.mp4',
      final_path: '/Users/test/aroll.mp4',
      probed_metadata: { frameRate: 29.97, ntsc: true, width: 1920, height: 1080,
                         durationSeconds: 60.5, embeddedTimecode: '01:00:00:00' },
    },
    {
      seq: 1, source: 'envato', source_item_id: 'NXG1', target_filename: 'broll1.mov',
      final_path: '/Users/test/broll1.mov',
      probed_metadata: { frameRate: 25, ntsc: false, width: 1920, height: 1080,
                         durationSeconds: 12.0, embeddedTimecode: null },
    },
    {
      seq: 2, source: 'pexels', source_item_id: 'PEX1', target_filename: 'broll2.mp4',
      final_path: '/Users/test/broll2.mp4',
      // No probed_metadata — manifest values must flow through
    },
  ]
  const manifestById = {
    aroll: { frame_rate: 30, ntsc: false, embedded_timecode: null, resolution: { width: 1280, height: 720 }, duration_seconds: 60 },
    NXG1:  { frame_rate: 30, ntsc: false, embedded_timecode: null, resolution: { width: 1280, height: 720 }, duration_seconds: 10 },
    PEX1:  { frame_rate: 50, ntsc: false, embedded_timecode: null, resolution: { width: 1920, height: 1080 }, duration_seconds: 8 },
  }
  const variantPlan = {
    A: [
      { source: 'aroll',  source_item_id: 'aroll', timelineStart: 0,   timelineDuration: 60 },
      { source: 'envato', source_item_id: 'NXG1',  timelineStart: 2,   timelineDuration: 4 },
      { source: 'pexels', source_item_id: 'PEX1',  timelineStart: 10,  timelineDuration: 3 },
    ],
  }

  it('probed values override manifest values when both present', () => {
    const payload = buildVariantsPayload({ items, manifestById, variantPlan })
    const arollPl = payload.variants[0].placements.find(p => p.source === 'aroll')
    expect(arollPl.sourceFrameRate).toBe(29.97)
    expect(arollPl.ntsc).toBe(true)
    expect(arollPl.width).toBe(1920)
    expect(arollPl.height).toBe(1080)
    expect(arollPl.sourceDurationSeconds).toBe(60.5)
  })

  it('manifest values flow through when probe absent', () => {
    const payload = buildVariantsPayload({ items, manifestById, variantPlan })
    const pexPl = payload.variants[0].placements.find(p => p.source === 'pexels')
    expect(pexPl.sourceFrameRate).toBe(50)
    expect(pexPl.ntsc).toBe(false)
    expect(pexPl.sourceDurationSeconds).toBe(8)
  })

  it('null/missing fields collapse to null (not undefined) for backend tolerance', () => {
    const payload = buildVariantsPayload({ items, manifestById, variantPlan })
    const arollPl = payload.variants[0].placements.find(p => p.source === 'aroll')
    expect(arollPl.embeddedTimecode).toBe('01:00:00:00')  // probed
    const broll1Pl = payload.variants[0].placements.find(p => p.source === 'envato')
    expect(broll1Pl.embeddedTimecode).toBeNull()  // manifest had null, probe had null
  })
})
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
npx vitest run src/hooks/__tests__/useExportXmlKickoff.test.js -t "precedence"
```
Expected: tests fail because either `buildVariantsPayload` is not exported, or the merge step doesn't exist.

- [ ] **Step 4: Implement the merge with precedence**

In `useExportXmlKickoff.js`, locate where placement objects are built. Add a helper:

```js
function mergeProbeIntoPlacement(placement, item, manifestItem) {
  const probe = item?.probed_metadata
  return {
    ...placement,
    sourceFrameRate:
      probe?.frameRate ??
      manifestItem?.frame_rate ??
      null,
    ntsc:
      probe?.ntsc ??
      manifestItem?.ntsc ??
      false,
    width:
      probe?.width ??
      manifestItem?.resolution?.width ??
      null,
    height:
      probe?.height ??
      manifestItem?.resolution?.height ??
      null,
    sourceDurationSeconds:
      probe?.durationSeconds ??
      manifestItem?.duration_seconds ??
      null,
    embeddedTimecode:
      (probe && 'embeddedTimecode' in probe ? probe.embeddedTimecode : undefined) ??
      manifestItem?.embedded_timecode ??
      null,
  }
}
```

Call `mergeProbeIntoPlacement` inside the existing placement-building loop. Look up `item` from `items.find(i => i.source_item_id === placement.source_item_id)` (or by filename if `source_item_id` is not the existing match key — look at the current code to confirm).

- [ ] **Step 5: Run test, expect PASS**

```bash
npx vitest run src/hooks/__tests__/useExportXmlKickoff.test.js -t "precedence"
```
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useExportXmlKickoff.js src/hooks/__tests__/useExportXmlKickoff.test.js
git commit -m "feat(web): merge extension probed_metadata into variant placements (probed > manifest)"
```

---

## Task 19: Backend XMEML snapshot regression — probed values land in emitted XML

**Files:**
- Create: `server/routes/__tests__/exports-result.test.js`
- (No source changes — this is a regression guard)

End-to-end check that the new probed_metadata flow reaches the generator. Persist a synthetic export with placements carrying probed-style metadata; call the generate-xml route; snapshot the output.

- [ ] **Step 1: Write the snapshot test**

Create `server/routes/__tests__/exports-result.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { app } from '../../app.js'
import db from '../../db.js'

describe('exports result → generate-xml carries probed metadata into XML', () => {
  let exportId
  beforeEach(async () => {
    // Set up a fake user + export row with result_json containing placements
    // that already have probed-style fields (sourceFrameRate=25, ntsc=false)
    const result_json = {
      variants: [
        {
          label: 'A',
          placements: [
            {
              seq: 0, source: 'aroll', source_item_id: 'aroll',
              filename: 'aroll.mp4',
              timelineStart: 0, timelineDuration: 10,
              sourceFrameRate: 29.97, ntsc: true,
              width: 1920, height: 1080,
              sourceDurationSeconds: 10, embeddedTimecode: '01:00:00:00',
            },
            {
              seq: 1, source: 'envato', source_item_id: 'NXG1',
              filename: 'broll1.mov',
              timelineStart: 2, timelineDuration: 3,
              sourceFrameRate: 25, ntsc: false,
              width: 1920, height: 1080,
              sourceDurationSeconds: 12, embeddedTimecode: null,
            },
          ],
        },
      ],
    }
    const row = await db.prepare(`
      INSERT INTO exports (user_id, plan_pipeline_id, manifest_json, result_json, status)
      VALUES (?, ?, ?, ?, ?)
    `).run('test-user', 'plan-1-test', '{}', JSON.stringify(result_json), 'completed')
    exportId = row.lastInsertRowid
  })

  it('emits b-roll <rate><timebase>25</timebase> when placement sourceFrameRate=25', async () => {
    const res = await request(app)
      .post(`/api/exports/${exportId}/generate-xml`)
      .set('Authorization', 'Bearer test-token')
      .send({ variants: ['A'] })
    expect(res.status).toBe(200)
    const xml = res.body.xml_by_variant.A
    // B-roll <file> block must reflect probed 25fps
    expect(xml).toMatch(/<rate><timebase>25<\/timebase><ntsc>FALSE<\/ntsc><\/rate>/)
  })

  it('emits A-roll <file><rate><timebase>30</timebase><ntsc>TRUE</ntsc> when probed FPS is 29.97', async () => {
    const res = await request(app)
      .post(`/api/exports/${exportId}/generate-xml`)
      .send({ variants: ['A'] })
    const xml = res.body.xml_by_variant.A
    // A-roll uses arollFrameRate inside its <file> block, with NTSC=TRUE
    expect(xml).toMatch(/<file id="file-aroll">[\s\S]*?<rate><timebase>30<\/timebase><ntsc>TRUE<\/ntsc>/)
  })
})
```

> **Note:** If auth in this test setup is awkward (`requireAuth` middleware), check existing test files in `server/routes/__tests__/` for the conventional way to stub or bypass auth — match what works for adjacent tests.

- [ ] **Step 2: Run test, expect PASS**

```bash
npx vitest run server/routes/__tests__/exports-result.test.js
```
Expected: 2 tests pass — this is a regression guard for the existing generator's behavior + the precedence-merged placements.

- [ ] **Step 3: Commit**

```bash
git add server/routes/__tests__/exports-result.test.js
git commit -m "test(server): regression guard — probed FPS/NTSC flows into XMEML output"
```

---

## Task 20: Documentation — add manual smoke + update extension version references

**Files:**
- Modify: a docs file listing the manual smoke checklist (search for one — possibly `docs/SMOKES.md` or inline in a roadmap doc)
- Modify: `README.md` if it lists extension features

- [ ] **Step 1: Find the manual smoke checklist**

Run:
```bash
grep -rn "manual smoke\|smoke test" docs/ --include="*.md" | head
```
Identify which file is the canonical "pending smokes" list (per memory, there are 11 pending smokes — find that doc).

- [ ] **Step 2: Add smoke #12**

Append to the canonical doc:

```markdown
12. **Ext.FPS — file:// probe end-to-end**
    - 5-item export across known framerates: one 23.976 Envato MOV, one 29.97 Pexels MP4, one 25 Pexels MP4, one 30 Freepik MP4, one user A-roll at 50fps (Supabase).
    - Acceptance: import generated XML to Premiere Pro. Every clip lands green (online) in project bin. No "File not found in search directories" errors. No rate-mismatch warnings in source monitor.
    - Negative path: disable "Allow access to file URLs" toggle, re-export. Expect probe to skip, manifest values to flow through (today's behavior), no regression in import success for clips where manifest already matched the file.
```

- [ ] **Step 3: Update README extension version line if present**

```bash
grep -n "v0\.9\|extension v" README.md 2>/dev/null
```
If a README line mentions the extension version, update to `v1.0.0`.

- [ ] **Step 4: Commit**

```bash
git add docs/ README.md
git commit -m "docs: add Ext.FPS manual smoke + bump extension version reference to v1.0.0"
```

---

## Task 21: Full suite green + final commit

**Files:** (no source changes — verification only)

- [ ] **Step 1: Run full vitest suite**

```bash
npx vitest run
```
Expected: all tests pass across all workspace projects. Note the test count vs the prior baseline (memory says 131/131 in 14 files — should now be ~155-165 in ~17 files after our additions).

- [ ] **Step 2: Run linter (if present)**

```bash
test -f package.json && grep -q '"lint"' package.json && npm run lint
```
Expected: clean (or skip if no lint script).

- [ ] **Step 3: Build the extension package**

```bash
npm run ext:package
ls -lh extension/dist/
```
Expected: `extension-1.0.0.zip` produced, deterministic hash logged. File size should be only marginally larger than v0.9.5 (parser + tests + fixtures don't ship to production: fixtures excluded by `extension/scripts/package.mjs`'s include-list per Ext.10).

- [ ] **Step 4: Verify fixtures are NOT in the packaged zip**

```bash
unzip -l extension/dist/extension-1.0.0.zip | grep -E "fixtures|__tests__" || echo "clean — no fixtures/tests in zip"
```
Expected: "clean — no fixtures/tests in zip". If anything appears, edit `extension/scripts/package.mjs` to add `fixtures/` to the exclude list (it should already be by Ext.10's design, but verify).

- [ ] **Step 5: Confirm git log is clean**

```bash
git log --oneline main..HEAD
```
Expected: ~21 commits (one per task plus the fixture commit), each with a focused message.

- [ ] **Step 6: Push branch (only if user explicitly approves)**

⚠ **Do not push without explicit user approval.** Per memory feedback, never push without asking. When approved:

```bash
git push -u origin feature/extension-fps-probe
```

---

## Self-Review

**Spec coverage check:** Each spec section has at least one task implementing it.

- ✅ Parser scope (`mp4-probe.js`) → Tasks 2-10
- ✅ Data flow (extension → state.items → web app merge) → Tasks 12, 13, 18
- ✅ A-roll vs B-roll asymmetry → handled by existing XMEML generator (no source change; verified by Task 19 regression test)
- ✅ Error handling table (all 10 named events) → emitted in Task 10's `probeMp4File`
- ✅ file:// permission onboarding UX → Tasks 11, 14
- ✅ Pre-export telemetry gate → Task 15
- ✅ Feature flag `fps_probe_enabled` → Tasks 16, 17
- ✅ Versioning bump 0.9.x → 1.0.0 → Task 11
- ✅ Tests (unit, integration, backend snapshot) → Tasks 2-10 (unit), 12-13 (integration), 19 (backend snapshot)
- ✅ Manual smoke documentation → Task 20

**Placeholder check:** No TBDs / TODOs / "add appropriate error handling". Each step has either exact code or an exact command.

**Type consistency:** Field names verified across tasks:
- `probed_metadata` is the per-item attached object → consistent in queue.js (Tasks 12, 13), web app merge (Task 18).
- `probed_metadata` shape: `{frameRate, ntsc, width, height, durationSeconds, embeddedTimecode}` — consistent across parser return (Task 10), queue test (Task 12), snapshot test (Task 13), web app test (Task 18).
- Placement field names: `sourceFrameRate`, `ntsc`, `width`, `height`, `sourceDurationSeconds`, `embeddedTimecode` — match the existing XMEML generator interface verified in spec.

**One nit caught:** Task 12's `runProbeForItem` uses `noopEmit` locally; Task 17 expects the same default. The export from queue.js should be consistent. Resolved: `runProbeForItem`'s `emit` default stays `noopEmit` for testability; production callers (inside `chrome.downloads.onChanged`) explicitly pass the queue's `emit` import. Tests verify both shapes.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-13-extension-fps-probe.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
