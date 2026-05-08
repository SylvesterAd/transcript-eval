# B-Roll Placement Remap on First Editor Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user opens the b-roll editor (or returns to it after editing cuts), placements appear at correct post-cut times — anchored to spoken words via `audio_anchor`, with no overlaps and a 0.5s minimum duration.

**Architecture:** Single trigger (cut-hash diff inside `getBRollEditorData`). Server materializes a remap (`anchor_word_idx` → raw word time → effective cuts → post-cut time, plus 0.5s min + overlap trim) into `broll_editor_state.state_json.remappedPositions` keyed by placement uuid, gated by `lastRemappedCutsHash`. Modern path only — drop the dead recompute on legacy `editor_state.broll.placements`.

**Tech Stack:** Node 20, vitest 1.6 (workspace: server/web/extension), Postgres via `server/db.js`, React 18 + happy-dom for component tests, Express routes.

**Spec:** `docs/superpowers/specs/2026-05-08-broll-placement-remap-design.md`

---

## File Structure

**Create:**
- `server/services/placement-remap.js` — `cutsHash`, `materializePlacementRemap`, internal `fuzzyMatchAnchorOriginalTime` helper. Pure functions; no DB.
- `server/services/__tests__/placement-remap.test.js` — unit tests for the new module.

**Modify:**
- `server/services/broll.js` — `persistPlacementOutput` (parse timecode strings when seconds missing); `getBRollEditorData` (hash-diff remap injection).
- `server/services/__tests__/persist-placement-output-postcut.test.js` — new case for timecode-only LLM input.
- `server/routes/videos.js` — drop `recomputePlacementsForCuts` call on legacy storage in `_putEditorStateHandler`.
- `server/routes/__tests__/editor-state-cut-edit.test.js` — update assertions: cut PUT no longer mutates legacy `editor_state.broll.placements`.
- `src/components/editor/TranscriptEditor.jsx` — fix the regression that stopped strike-through display on the rough-cut tab (Task 8 — diagnose-then-fix).
- `src/components/editor/__tests__/TranscriptEditor-rough-cut-strike.test.jsx` (NEW) — render-time regression guard.

---

## Pre-flight

Working tree is in worktree `.worktrees/cuts-as-source-of-truth`. The spec file exists as untracked: `docs/superpowers/specs/2026-05-08-broll-placement-remap-design.md`. Commit it as part of Task 1.

Test commands you will use (vitest 1.6 workspace):
- All tests: `npm test`
- Single file: `npx vitest run server/services/__tests__/placement-remap.test.js`
- Single test by name: `npx vitest run server/services/__tests__/placement-remap.test.js -t "happy path"`
- Watch mode: `npx vitest server/services/__tests__/placement-remap.test.js`

Module loads import `server/db.js` which throws at top-level if `DATABASE_URL` is missing. Either set it in `.env` (already present in worktree) or mock the db module in every test file that imports anything from `server/services/broll.js`. The pattern is in `cut-time-helpers.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockReturnValue({ changes: 0 }),
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
    })),
  },
}))
```

---

## Task 1: Fix `persistPlacementOutput` to parse timecode strings when `start_seconds` missing

**Why:** This is the root cause of the 2:08 bug. The LLM emits `start: "[00:02:22]"` and no numeric `start_seconds`. Today's gate `if (typeof p.start_seconds === 'number')` skips the shift, leaving the placement in original time. Without this fix, "initial map = assumed cuts" never works, so every later task is built on a broken foundation.

**Files:**
- Modify: `server/services/broll.js` — `shiftPlacement` closure inside `persistPlacementOutput` (around line 1191).
- Test: `server/services/__tests__/persist-placement-output-postcut.test.js` (existing — add one case).

- [ ] **Step 1: Commit the spec doc and start a clean change**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/cuts-as-source-of-truth"
git add docs/superpowers/specs/2026-05-08-broll-placement-remap-design.md
git commit -m "docs(broll): spec for placement remap on first editor open"
```

- [ ] **Step 2: Add the failing test for timecode-only LLM input**

Open `server/services/__tests__/persist-placement-output-postcut.test.js`. Inside the existing `describe('persistPlacementOutput (original→post-cut shift)', () => { ... })` block, add:

```js
it('parses start/end timecode strings when start_seconds/end_seconds missing', async () => {
  const stageOutput = JSON.stringify({
    placements: [{
      start: '[00:00:19.94]',
      end: '[00:00:23.94]',
      // No start_seconds / end_seconds — mirrors what the LLM actually emits.
      audio_anchor: 'There is a bad piece',
    }],
  })
  const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
  const p = JSON.parse(out).placements[0]
  expect(p.start_seconds).toBeCloseTo(14.94, 2)
  expect(p.end_seconds).toBeCloseTo(18.94, 2)
  expect(p.start).toBe('[00:00:14.94]')
  expect(p.end).toBe('[00:00:18.94]')
})
```

- [ ] **Step 3: Run the test and verify it fails**

```
npx vitest run server/services/__tests__/persist-placement-output-postcut.test.js -t "parses start/end timecode strings when start_seconds/end_seconds missing"
```

Expected: FAIL — `expected undefined to be close to 14.94`. The shift is gated on numeric `start_seconds`, which isn't present, so the placement passes through unchanged with no `start_seconds`.

- [ ] **Step 4: Locate the shift block in `broll.js`**

Open `server/services/broll.js` and find the `shiftPlacement` closure inside `persistPlacementOutput`. The current shape (around line 1191):

```js
const shiftPlacement = (p) => {
  const next = { ...p, anchor_word_idx: findAnchorWordIdx(words, p.audio_anchor) }
  if (!effectiveCuts.length) return next
  if (typeof p.start_seconds === 'number') {
    next.start_seconds = shiftOriginalToPostCut(p.start_seconds, effectiveCuts)
    next.start = tc(next.start_seconds)
  }
  if (typeof p.end_seconds === 'number') {
    next.end_seconds = shiftOriginalToPostCut(p.end_seconds, effectiveCuts)
    next.end = tc(next.end_seconds)
  }
  return next
}
```

- [ ] **Step 5: Replace the shift block with timecode-fallback parsing**

Replace the block above with:

```js
const shiftPlacement = (p) => {
  const next = { ...p, anchor_word_idx: findAnchorWordIdx(words, p.audio_anchor) }
  if (!effectiveCuts.length) return next

  // Resolve numeric seconds from either explicit field or the timecode string.
  const startOrig = typeof p.start_seconds === 'number'
    ? p.start_seconds
    : (p.start ? parseTimecode(p.start) : null)
  const endOrig = typeof p.end_seconds === 'number'
    ? p.end_seconds
    : (p.end ? parseTimecode(p.end) : null)

  if (startOrig != null) {
    next.start_seconds = shiftOriginalToPostCut(startOrig, effectiveCuts)
    next.start = tc(next.start_seconds)
  }
  if (endOrig != null) {
    next.end_seconds = shiftOriginalToPostCut(endOrig, effectiveCuts)
    next.end = tc(next.end_seconds)
  }
  return next
}
```

- [ ] **Step 6: Add the `parseTimecode` import at the top of `broll.js`**

`broll.js` already imports many helpers near the top. Add `parseTimecode` to the existing `placement-match.js` import (verify it isn't already present; if absent, add):

```js
import { parseTimecode } from './placement-match.js'
```

If the file already has a `placement-match.js` import line, append `parseTimecode` to its named-imports list rather than adding a duplicate import.

- [ ] **Step 7: Run the new test and verify it passes**

```
npx vitest run server/services/__tests__/persist-placement-output-postcut.test.js -t "parses start/end timecode strings when start_seconds/end_seconds missing"
```

Expected: PASS.

- [ ] **Step 8: Run the full file to confirm no regressions**

```
npx vitest run server/services/__tests__/persist-placement-output-postcut.test.js
```

Expected: all tests in the file pass.

- [ ] **Step 9: Commit**

```bash
git add server/services/broll.js server/services/__tests__/persist-placement-output-postcut.test.js
git commit -m "fix(broll): persist placements parse start/end timecodes when start_seconds missing

LLM emits start:'[00:02:22]' with no numeric start_seconds, so the existing
typeof-number gate skipped the original->post-cut shift entirely, leaving
placements stored in original time."
```

---

## Task 2: New `placement-remap.js` module — `cutsHash`

**Why:** The hash is the trigger for re-materializing the remap. Stable across cut reorderings, sensitive to cut/exclusion content changes.

**Files:**
- Create: `server/services/placement-remap.js`
- Test: `server/services/__tests__/placement-remap.test.js`

- [ ] **Step 1: Create the test file with the failing tests**

`server/services/__tests__/placement-remap.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { cutsHash } from '../placement-remap.js'

describe('cutsHash', () => {
  it('returns the same hash regardless of input order', () => {
    const a = cutsHash([{ start: 30, end: 35 }, { start: 10, end: 15 }], [])
    const b = cutsHash([{ start: 10, end: 15 }, { start: 30, end: 35 }], [])
    expect(a).toBe(b)
  })

  it('differs when cut times change', () => {
    const a = cutsHash([{ start: 10, end: 15 }], [])
    const b = cutsHash([{ start: 10, end: 16 }], [])
    expect(a).not.toBe(b)
  })

  it('differs when an exclusion is added', () => {
    const cuts = [{ start: 10, end: 15 }]
    const a = cutsHash(cuts, [])
    const b = cutsHash(cuts, [{ start: 12, end: 13 }])
    expect(a).not.toBe(b)
  })

  it('ignores cut id field (only times matter)', () => {
    const a = cutsHash([{ id: 'cut-1', start: 10, end: 15 }], [])
    const b = cutsHash([{ id: 'cut-different', start: 10, end: 15 }], [])
    expect(a).toBe(b)
  })

  it('returns a stable string for empty inputs', () => {
    expect(cutsHash([], [])).toBe(cutsHash([], []))
    expect(cutsHash([], []).length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```
npx vitest run server/services/__tests__/placement-remap.test.js
```

Expected: FAIL — module `../placement-remap.js` not found.

- [ ] **Step 3: Create `placement-remap.js` with `cutsHash`**

`server/services/placement-remap.js`:

```js
import crypto from 'node:crypto'

/**
 * Stable hash of (cuts, exclusions). Reorderings produce the same hash;
 * any change to start/end times or exclusion content produces a different
 * hash. Cut ids are ignored — only timing matters for the remap result.
 */
export function cutsHash(cuts, exclusions) {
  const norm = (arr) => (arr || []).slice()
    .sort((a, b) => (a.start - b.start) || (a.end - b.end))
    .map(c => [c.start, c.end])
  const payload = JSON.stringify({ cuts: norm(cuts), exclusions: norm(exclusions) })
  return crypto.createHash('sha1').update(payload).digest('hex')
}
```

- [ ] **Step 4: Run the test and verify it passes**

```
npx vitest run server/services/__tests__/placement-remap.test.js
```

Expected: PASS, 5/5 in the `cutsHash` block.

- [ ] **Step 5: Commit**

```bash
git add server/services/placement-remap.js server/services/__tests__/placement-remap.test.js
git commit -m "feat(broll): add cutsHash for placement remap trigger"
```

---

## Task 3: `materializePlacementRemap` — anchor resolve via `anchor_word_idx`

**Why:** Stable identity. The persist step already attaches `anchor_word_idx` (raw word index) to every placement. When the idx points to a word that's NOT inside any effective cut, that word's `start` is the canonical anchor location.

**Files:**
- Modify: `server/services/placement-remap.js`
- Test: `server/services/__tests__/placement-remap.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `server/services/__tests__/placement-remap.test.js`:

```js
import { materializePlacementRemap } from '../placement-remap.js'

const W = (...spec) => spec.map(([word, start, end]) => ({ word, start, end }))

describe('materializePlacementRemap — anchor_word_idx happy path', () => {
  it('shifts placement to post-cut time using the anchor word', () => {
    // Words: "There" at 19.94 in original time. Cuts remove [10,15] = 5s.
    // Expected post-cut start: 19.94 - 5 = 14.94.
    const words = W(
      ['There', 19.94, 20.10],
      ['is', 20.10, 20.18],
      ['a', 20.18, 20.21],
      ['bad', 20.21, 20.50],
      ['piece', 20.50, 20.78],
    )
    const placements = [{
      uuid: 'p_a',
      start: '[00:00:19.94]', end: '[00:00:21.94]',
      audio_anchor: 'There is a bad piece',
      anchor_word_idx: 0,
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    const p = out.get('p_a')
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.end_seconds).toBeCloseTo(16.94, 2)
    expect(p.anchor_state).toBe('idx')
  })

  it('falls back to in_cut when anchor word lands inside a cut', () => {
    const words = W(
      ['Filler', 11.0, 11.5],   // inside cut [10,15]
      ['There', 19.94, 20.10],
    )
    const placements = [{
      uuid: 'p_b',
      start: '[00:00:11.00]', end: '[00:00:13.00]',
      audio_anchor: 'Filler',
      anchor_word_idx: 0,
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    expect(out.get('p_b').anchor_state).toBe('in_cut')
  })
})
```

- [ ] **Step 2: Run and verify failures**

```
npx vitest run server/services/__tests__/placement-remap.test.js -t "materializePlacementRemap — anchor_word_idx happy path"
```

Expected: FAIL — `materializePlacementRemap is not a function`.

- [ ] **Step 3: Implement the anchor-resolve branch**

Add to `server/services/placement-remap.js`:

```js
import { postCutTime } from './time-translation.js'
import { parseTimecode } from './placement-match.js'

const isInCut = (t, effectiveCuts) =>
  effectiveCuts.some(c => t >= c.start && t < c.end)

/**
 * Materialize a per-placement remap from anchor + effective cuts.
 *
 * Pure function — no DB, no I/O. Caller is responsible for computing
 * `effectiveCuts` (via computeEffectiveCuts in broll.js) and providing the
 * raw transcript `words` ([{word,start,end}, ...]).
 *
 * Returns Map<uuid, { start_seconds, end_seconds, anchor_state }>.
 *
 * `anchor_state`: 'idx' | 'fuzzy' | 'in_cut' | 'orphaned' | 'overlap_squeezed'.
 */
export function materializePlacementRemap(placements, effectiveCuts, words) {
  const out = new Map()
  for (const p of placements) {
    if (!p.uuid) continue

    let anchorOriginal = null
    let state = null

    if (typeof p.anchor_word_idx === 'number' && p.anchor_word_idx >= 0) {
      const w = words[p.anchor_word_idx]
      if (!w) {
        state = 'orphaned'
      } else if (isInCut(w.start, effectiveCuts)) {
        state = 'in_cut'
      } else {
        anchorOriginal = w.start
        state = 'idx'
      }
    }

    if (anchorOriginal == null && state === null) {
      // No idx attached at all — leave for fuzzy fallback (Task 4).
      state = 'orphaned'
    }

    let startSec, endSec
    if (anchorOriginal != null) {
      startSec = postCutTime(anchorOriginal, effectiveCuts)
      const origDur = parseTimecode(p.end) - parseTimecode(p.start)
      endSec = startSec + (origDur > 0 ? origDur : 0.5)
    } else {
      // Fall back to LLM-emitted post-cut times (already shifted by persist).
      startSec = parseTimecode(p.start)
      endSec = parseTimecode(p.end)
    }

    out.set(p.uuid, { start_seconds: startSec, end_seconds: endSec, anchor_state: state })
  }
  return out
}
```

- [ ] **Step 4: Run and verify both new tests pass**

```
npx vitest run server/services/__tests__/placement-remap.test.js -t "materializePlacementRemap — anchor_word_idx happy path"
```

Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add server/services/placement-remap.js server/services/__tests__/placement-remap.test.js
git commit -m "feat(broll): materializePlacementRemap anchor resolve via anchor_word_idx"
```

---

## Task 4: `materializePlacementRemap` — fuzzy fallback over raw words (skipping cuts)

**Why:** When `anchor_word_idx` is missing or in-cut, the audio anchor text might still uniquely identify a word in the kept content. This is the path that recovers placements whose persist-time idx is stale (e.g., transcript was re-Whispered after persist, or the LLM emitted a slightly different anchor phrase than the words it pointed to).

**Files:**
- Modify: `server/services/placement-remap.js`
- Test: `server/services/__tests__/placement-remap.test.js`

- [ ] **Step 1: Add the failing test**

Append to `placement-remap.test.js`:

```js
describe('materializePlacementRemap — fuzzy fallback', () => {
  it('uses anchor text to find the word when anchor_word_idx is missing', () => {
    // Words: "From a tax standpoint" at 8.0s; "There" filler also exists.
    const words = W(
      ['Filler', 11.0, 11.5],
      ['From', 8.0, 8.3],
      ['a', 8.3, 8.4],
      ['tax', 8.4, 8.7],
      ['standpoint', 8.7, 9.2],
    )
    const placements = [{
      uuid: 'p_c',
      start: '[00:00:08.00]', end: '[00:00:10.00]',
      audio_anchor: 'From a tax standpoint',
      // no anchor_word_idx
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    const p = out.get('p_c')
    expect(p.anchor_state).toBe('fuzzy')
    expect(p.start_seconds).toBeCloseTo(8.0, 2)
  })

  it('skips fuzzy candidates that fall inside an effective cut', () => {
    // "There" appears twice — once inside cut [10,15], once at 19.94.
    const words = W(
      ['There', 11.5, 11.7],   // in cut
      ['Filler', 12.0, 12.5],
      ['There', 19.94, 20.10], // valid candidate
      ['is', 20.10, 20.18],
    )
    const placements = [{
      uuid: 'p_d',
      start: '[00:00:11.50]', end: '[00:00:13.50]',
      audio_anchor: 'There is',
      // no anchor_word_idx
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    const p = out.get('p_d')
    expect(p.anchor_state).toBe('fuzzy')
    // post-cut: 19.94 - 5 = 14.94
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
  })

  it('marks orphaned when neither idx nor fuzzy match works', () => {
    const words = W(['Hello', 1.0, 1.2], ['World', 1.2, 1.5])
    const placements = [{
      uuid: 'p_e',
      start: '[00:00:50.00]', end: '[00:00:52.00]',
      audio_anchor: 'completely unmatched phrase',
    }]
    const out = materializePlacementRemap(placements, [], words)
    const p = out.get('p_e')
    expect(p.anchor_state).toBe('orphaned')
    expect(p.start_seconds).toBeCloseTo(50.0, 2) // falls back to LLM time
  })
})
```

- [ ] **Step 2: Run and verify failures**

```
npx vitest run server/services/__tests__/placement-remap.test.js -t "fuzzy fallback"
```

Expected: FAIL on the first two cases (`fuzzy` state never set; idx-missing currently routes to `orphaned`). The third already passes incidentally — leave it; it locks in correctness.

- [ ] **Step 3: Add the fuzzy-match helper to `placement-remap.js`**

Insert between the `isInCut` definition and `materializePlacementRemap`:

```js
function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Fuzzy-match audio_anchor against raw words, skipping any word inside an
 * effective cut. Returns the matched word's `start` (original time) or null.
 *
 * Mirrors the scoring loop from placement-match.js:matchPlacementsToTranscript
 * but with NO time window (anchor may be hundreds of seconds away from the
 * LLM-emitted timecode after our original→post-cut shift) and a cut-skip
 * filter on each candidate.
 */
function fuzzyMatchAnchorOriginalTime(audioAnchor, words, effectiveCuts) {
  const target = normalize(audioAnchor)
  if (!target) return null
  const targetTokens = target.split(' ')
  const N = targetTokens.length

  let bestScore = 0
  let bestStart = null

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (isInCut(w.start, effectiveCuts)) continue

    const phraseWords = []
    for (let j = i; j < Math.min(i + N + 2, words.length); j++) {
      phraseWords.push(normalize(words[j].word))
    }
    const phrase = phraseWords.join(' ')

    let score = 0
    let phraseIdx = 0
    for (const aw of targetTokens) {
      const found = phrase.indexOf(aw, phraseIdx)
      if (found >= 0) { score++; phraseIdx = found + aw.length }
    }

    if (score > bestScore) {
      bestScore = score
      bestStart = w.start
    }
  }

  // Require at least one matched token (any score > 0). Earlier match wins
  // on ties via the strict `>` above.
  return bestStart
}
```

- [ ] **Step 4: Wire the fallback into `materializePlacementRemap`**

Inside the loop in `materializePlacementRemap`, replace the block:

```js
    if (anchorOriginal == null && state === null) {
      // No idx attached at all — leave for fuzzy fallback (Task 4).
      state = 'orphaned'
    }
```

with:

```js
    if (anchorOriginal == null) {
      const fuzzy = fuzzyMatchAnchorOriginalTime(p.audio_anchor, words, effectiveCuts)
      if (fuzzy != null) {
        anchorOriginal = fuzzy
        state = 'fuzzy'
      } else if (state === null) {
        state = 'orphaned'
      }
      // If state was already 'in_cut' from idx resolution, keep it (the
      // anchor text overlaps a cut region and fuzzy didn't recover it).
    }
```

- [ ] **Step 5: Run all `placement-remap.test.js` tests and verify**

```
npx vitest run server/services/__tests__/placement-remap.test.js
```

Expected: all pass (cutsHash 5, anchor idx 2, fuzzy 3 = 10 total).

- [ ] **Step 6: Commit**

```bash
git add server/services/placement-remap.js server/services/__tests__/placement-remap.test.js
git commit -m "feat(broll): fuzzy-match anchor fallback in materializePlacementRemap

Whole-transcript anchor-text scoring, skipping words inside effective
cuts. Recovers placements whose anchor_word_idx is missing or stale."
```

---

## Task 5: `materializePlacementRemap` — duration, 0.5s minimum, overlap trim

**Why:** Final two rules from the spec: placements shorter than 0.5s get bumped to 0.5s; overlapping placements get the earlier end trimmed back to the next start. If trim would push duration below 0.5s, the placement is marked `overlap_squeezed` rather than re-pushing the next placement (avoids cascading shifts).

**Files:**
- Modify: `server/services/placement-remap.js`
- Test: `server/services/__tests__/placement-remap.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `placement-remap.test.js`:

```js
describe('materializePlacementRemap — duration rules', () => {
  it('bumps duration below 0.5s up to 0.5s', () => {
    const words = W(['There', 5.0, 5.1])
    const placements = [{
      uuid: 'p_short',
      start: '[00:00:05.00]', end: '[00:00:05.30]',
      audio_anchor: 'There',
      anchor_word_idx: 0,
    }]
    const out = materializePlacementRemap(placements, [], words)
    const p = out.get('p_short')
    expect(p.end_seconds - p.start_seconds).toBeCloseTo(0.5, 2)
  })

  it('trims earlier end when two placements overlap', () => {
    const words = W(
      ['A', 10.0, 10.2],
      ['B', 10.8, 11.0],
    )
    const placements = [
      { uuid: 'p_first',  start: '[00:00:10.00]', end: '[00:00:11.50]', audio_anchor: 'A', anchor_word_idx: 0 },
      { uuid: 'p_second', start: '[00:00:10.80]', end: '[00:00:12.00]', audio_anchor: 'B', anchor_word_idx: 1 },
    ]
    const out = materializePlacementRemap(placements, [], words)
    const a = out.get('p_first')
    const b = out.get('p_second')
    expect(a.end_seconds).toBeCloseTo(10.8, 2)
    expect(b.start_seconds).toBeCloseTo(10.8, 2)
  })

  it('marks overlap_squeezed when trim forces duration below 0.5s', () => {
    const words = W(
      ['A', 10.0, 10.2],
      ['B', 10.3, 10.5],
    )
    const placements = [
      { uuid: 'p_first',  start: '[00:00:10.00]', end: '[00:00:11.00]', audio_anchor: 'A', anchor_word_idx: 0 },
      { uuid: 'p_second', start: '[00:00:10.30]', end: '[00:00:11.30]', audio_anchor: 'B', anchor_word_idx: 1 },
    ]
    const out = materializePlacementRemap(placements, [], words)
    const a = out.get('p_first')
    expect(a.anchor_state).toBe('overlap_squeezed')
    expect(a.end_seconds).toBeCloseTo(10.3, 2)  // trimmed, not re-pushed
  })
})
```

- [ ] **Step 2: Run and verify failures**

```
npx vitest run server/services/__tests__/placement-remap.test.js -t "duration rules"
```

Expected: 3/3 fail (no min-duration logic, no overlap trim).

- [ ] **Step 3: Replace the loop body in `materializePlacementRemap` with the rules-aware version**

Replace the entire body of `materializePlacementRemap` (the function body, keeping the signature) with:

```js
export function materializePlacementRemap(placements, effectiveCuts, words) {
  const MIN_DURATION = 0.5

  // Pass 1 — anchor resolve + initial post-cut times + 0.5s minimum.
  const resolved = []
  for (const p of placements) {
    if (!p.uuid) continue

    let anchorOriginal = null
    let state = null

    if (typeof p.anchor_word_idx === 'number' && p.anchor_word_idx >= 0) {
      const w = words[p.anchor_word_idx]
      if (!w) state = 'orphaned'
      else if (isInCut(w.start, effectiveCuts)) state = 'in_cut'
      else { anchorOriginal = w.start; state = 'idx' }
    }

    if (anchorOriginal == null) {
      const fuzzy = fuzzyMatchAnchorOriginalTime(p.audio_anchor, words, effectiveCuts)
      if (fuzzy != null) {
        anchorOriginal = fuzzy
        state = 'fuzzy'
      } else if (state === null) {
        state = 'orphaned'
      }
    }

    let startSec, endSec
    if (anchorOriginal != null) {
      startSec = postCutTime(anchorOriginal, effectiveCuts)
      const origDur = parseTimecode(p.end) - parseTimecode(p.start)
      endSec = startSec + Math.max(MIN_DURATION, origDur > 0 ? origDur : MIN_DURATION)
    } else {
      startSec = parseTimecode(p.start)
      endSec = parseTimecode(p.end)
      if (endSec - startSec < MIN_DURATION) endSec = startSec + MIN_DURATION
    }

    resolved.push({ uuid: p.uuid, startSec, endSec, state })
  }

  // Pass 2 — sort by start, trim overlaps, flag squeezed.
  resolved.sort((a, b) => a.startSec - b.startSec)
  for (let i = 0; i < resolved.length - 1; i++) {
    const cur = resolved[i]
    const nxt = resolved[i + 1]
    if (cur.endSec > nxt.startSec) {
      cur.endSec = nxt.startSec
      if (cur.endSec - cur.startSec < MIN_DURATION) {
        cur.state = 'overlap_squeezed'
      }
    }
  }

  const out = new Map()
  for (const r of resolved) {
    out.set(r.uuid, { start_seconds: r.startSec, end_seconds: r.endSec, anchor_state: r.state })
  }
  return out
}
```

- [ ] **Step 4: Run all `placement-remap.test.js` tests**

```
npx vitest run server/services/__tests__/placement-remap.test.js
```

Expected: 13/13 pass (5 cutsHash + 2 idx + 3 fuzzy + 3 duration rules).

- [ ] **Step 5: Commit**

```bash
git add server/services/placement-remap.js server/services/__tests__/placement-remap.test.js
git commit -m "feat(broll): apply 0.5s minimum and overlap trim in materializePlacementRemap"
```

---

## Task 6: Wire hash-diff remap into `getBRollEditorData`

**Why:** This is the integration point. Every editor-data fetch hashes the current cuts and re-runs the remap if the hash differs from the stored one. First open ≡ stored hash is null. Cut edit ≡ hashes differ.

**Files:**
- Modify: `server/services/broll.js` — `getBRollEditorData` (around line 5727).
- Test: `server/services/__tests__/get-broll-editor-data-remap.test.js` (NEW).

- [ ] **Step 1: Read the current shape of `getBRollEditorData` (orientation only)**

```
sed -n '5727,5800p' server/services/broll.js
```

Note where placements are flattened (around line 5788) and where `loadBrollEditorState` is called (around line 5981). The remap injection sits between those two — after placements are built, before user edits are merged.

- [ ] **Step 2: Create the failing integration test**

`server/services/__tests__/get-broll-editor-data-remap.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted to allow mockReset across tests.
const { mockPrepare, savedStates } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
  savedStates: new Map(),
}))

vi.mock('../../db.js', () => ({ default: { prepare: (...a) => mockPrepare(...a), pool: { connect: vi.fn() } } }))

import { getBRollEditorData } from '../broll.js'

// Minimal fixture: one chapter sub-run with a single placement that anchors
// to the word "There" at original-time 19.94. Cut [10,15] removes 5s, so
// post-cut anchor lands at 14.94.
const planPipelineId = 'plan-518-test'
const groupId = 374
const videoId = 518

const chapterRun = {
  id: 1,
  metadata_json: JSON.stringify({
    pipelineId: planPipelineId, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 0,
  }),
  output_text: JSON.stringify({
    placements: [{
      start: '[00:00:14.94]', end: '[00:00:16.94]',  // already post-cut (Task 1 invariant)
      audio_anchor: 'There is a bad piece',
      anchor_word_idx: 0,
    }],
  }),
}

const rawWords = [
  { word: 'There', start: 19.94, end: 20.10 },
  { word: 'is', start: 20.10, end: 20.18 },
]

beforeEach(() => {
  savedStates.clear()
  mockPrepare.mockReset()
  mockPrepare.mockImplementation((sql) => ({
    all: vi.fn().mockImplementation(async (...args) => {
      if (sql.includes('FROM broll_runs') && sql.includes("'pipelineId'")) return [chapterRun]
      if (sql.includes('FROM broll_searches')) return []
      return []
    }),
    get: vi.fn().mockImplementation(async (...args) => {
      if (sql.includes('FROM video_groups')) {
        return { id: groupId, editor_state_json: JSON.stringify({ cuts: [{ start: 10, end: 15 }], cutExclusions: [] }) }
      }
      if (sql.includes('FROM transcripts')) return { word_timestamps_json: JSON.stringify(rawWords) }
      if (sql.includes('FROM broll_editor_state')) {
        return savedStates.get(planPipelineId) || null
      }
      if (sql.includes('FROM broll_runs') && sql.includes('video_id')) return { video_id: videoId, group_id: groupId }
      return null
    }),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
  }))
})

describe('getBRollEditorData hash-diff remap', () => {
  it('runs the remap on first call (no stored hash) and returns post-cut times', async () => {
    const data = await getBRollEditorData(planPipelineId)
    expect(data.placements).toHaveLength(1)
    const p = data.placements[0]
    // userTimelineStart should be the remapped post-cut time.
    expect(p.userTimelineStart).toBeCloseTo(14.94, 1)
    expect(p.userTimelineEnd).toBeCloseTo(16.94, 1)
  })
})
```

This test will need stubs for the helpers `getBRollEditorData` calls into. Adapt the stubs to whatever the function actually queries — run it once to see the SQL, then add matchers as needed.

- [ ] **Step 3: Run and verify the test fails**

```
npx vitest run server/services/__tests__/get-broll-editor-data-remap.test.js
```

Expected: FAIL — `userTimelineStart` undefined or wrong (no remap injection yet).

- [ ] **Step 4: Add the imports at the top of `broll.js`**

In the existing imports near the top of `server/services/broll.js`, add:

```js
import { cutsHash, materializePlacementRemap } from './placement-remap.js'
```

- [ ] **Step 5: Add the remap injection inside `getBRollEditorData`**

Locate the existing `loaded.state` usage in the user-edits merge block (around line 5981). Just before that block, insert the remap pass:

```js
// ─── Cut-hash remap ───────────────────────────────────────────────
// Re-derive post-cut placement times from the *current* editor cuts
// any time they differ from the cuts the remap last ran against.
// First open: stored hash is null → always runs. Subsequent cut edits
// invalidate via hash diff.
try {
  const groupRow = await db.prepare(
    `SELECT vg.id AS group_id, vg.editor_state_json
       FROM video_groups vg
       JOIN videos v ON v.group_id = vg.id
       JOIN broll_runs br ON br.video_id = v.id
      WHERE (br.metadata_json::jsonb ->> 'pipelineId') = ?
      LIMIT 1`,
  ).get(planPipelineId)
  if (groupRow?.editor_state_json) {
    const groupState = JSON.parse(groupRow.editor_state_json)
    const cuts = groupState.cuts || []
    const exclusions = groupState.cutExclusions || []
    const currentHash = cutsHash(cuts, exclusions)

    const loadedForHash = await loadBrollEditorState(planPipelineId)
    if ((loadedForHash.state.lastRemappedCutsHash || null) !== currentHash) {
      const videoRow = await db.prepare(
        `SELECT v.id AS video_id
           FROM videos v JOIN broll_runs br ON br.video_id = v.id
          WHERE (br.metadata_json::jsonb ->> 'pipelineId') = ? LIMIT 1`,
      ).get(planPipelineId)
      let words = []
      if (videoRow?.video_id) {
        const t = await db.prepare(
          `SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw' LIMIT 1`,
        ).get(videoRow.video_id)
        if (t?.word_timestamps_json) {
          try { words = JSON.parse(t.word_timestamps_json) } catch {}
        }
      }
      if (words.length) {
        const effective = computeEffectiveCuts(cuts, exclusions)
        const remap = materializePlacementRemap(placements, effective, words)
        const remappedPositions = Object.fromEntries(remap)
        const nextState = {
          ...loadedForHash.state,
          remappedPositions,
          lastRemappedCutsHash: currentHash,
        }
        const saveResult = await saveBrollEditorState(planPipelineId, nextState, loadedForHash.version)
        if (saveResult.status !== 'conflict') {
          // Inject for the merge step below — read fresh state to avoid races.
          const refreshed = await loadBrollEditorState(planPipelineId)
          // Use refreshed.state so the user-edits merge block (next) sees it.
          loaded.state = refreshed.state
        }
      } else {
        // Words missing — skip the remap, do NOT update hash so a later retry recovers.
        console.warn(`[getBRollEditorData] remap skipped for ${planPipelineId}: no raw word_timestamps`)
      }
    }
  }
} catch (err) {
  console.warn(`[getBRollEditorData] remap pass failed for ${planPipelineId}:`, err.message)
}
```

Note: `loaded` is the existing variable from the user-edits merge block (`const loaded = await loadBrollEditorState(planPipelineId)` already in the function). The remap pass loads its own copy (`loadedForHash`) before mutating, then refreshes `loaded.state` in place if save succeeded so the downstream merge sees the new `remappedPositions`. If `loaded` doesn't exist yet at this point in the function (i.e., it's loaded only inside the merge block further down), declare it before this insertion: `let loaded = await loadBrollEditorState(planPipelineId)` and remove the duplicate assignment in the merge block.

- [ ] **Step 6: Update the user-edits merge to use `remappedPositions` as the baseline**

Locate the existing merge loop (around line 5995):

```js
const e = (p.uuid && edits[p.uuid]) || edits[`${p.chapterIndex}:${p.placementIndex}`] || null
if (e?.timelineStart != null && e?.timelineEnd != null) {
  p.userTimelineStart = e.timelineStart
  p.userTimelineEnd = e.timelineEnd
}
```

Extend it to fall back to `remappedPositions[uuid]` when no edit override exists:

```js
const remappedPositions = loaded.state.remappedPositions || {}
const e = (p.uuid && edits[p.uuid]) || edits[`${p.chapterIndex}:${p.placementIndex}`] || null
if (e?.timelineStart != null && e?.timelineEnd != null) {
  p.userTimelineStart = e.timelineStart
  p.userTimelineEnd = e.timelineEnd
} else if (p.uuid && remappedPositions[p.uuid]) {
  const r = remappedPositions[p.uuid]
  p.userTimelineStart = r.start_seconds
  p.userTimelineEnd = r.end_seconds
  p.anchor_state = r.anchor_state
}
```

- [ ] **Step 7: Run the integration test**

```
npx vitest run server/services/__tests__/get-broll-editor-data-remap.test.js
```

Expected: PASS.

- [ ] **Step 8: Add a second test — "no remap on second call (hash match)"**

Append to `get-broll-editor-data-remap.test.js`:

```js
it('does not re-run remap when cuts hash is unchanged', async () => {
  // Pre-seed the saved state to look like a prior remap completed.
  const { cutsHash: hashFn } = await import('../placement-remap.js')
  const stored = {
    plan_pipeline_id: planPipelineId,
    state_json: JSON.stringify({
      lastRemappedCutsHash: hashFn([{ start: 10, end: 15 }], []),
      remappedPositions: { 'whatever-uuid': { start_seconds: 14.94, end_seconds: 16.94, anchor_state: 'idx' } },
    }),
    version: 7,
  }
  savedStates.set(planPipelineId, stored)

  const writeSpy = vi.fn().mockResolvedValue({ changes: 1 })
  // Ensure the run() that would persist a new state doesn't fire.
  // (Implementation calls saveBrollEditorState only when hash differs.)
  let savedAgain = false
  mockPrepare.mockImplementation((sql) => ({
    all: async () => sql.includes('FROM broll_runs') && sql.includes("'pipelineId'") ? [chapterRun] : [],
    get: async () => {
      if (sql.includes('FROM video_groups')) return { id: groupId, editor_state_json: JSON.stringify({ cuts: [{ start: 10, end: 15 }], cutExclusions: [] }) }
      if (sql.includes('FROM transcripts')) return { word_timestamps_json: JSON.stringify(rawWords) }
      if (sql.includes('FROM broll_editor_state')) return stored
      return null
    },
    run: async () => { savedAgain = true; return { changes: 1 } },
  }))

  await getBRollEditorData(planPipelineId)
  expect(savedAgain).toBe(false)
})
```

(Adjust the second-test stubs to whatever signal the actual implementation surfaces for "save fired"; the spirit of the test is that the second call must not invoke a write when the hash matches.)

- [ ] **Step 9: Run all `get-broll-editor-data-remap.test.js` tests**

```
npx vitest run server/services/__tests__/get-broll-editor-data-remap.test.js
```

Expected: 2/2 pass.

- [ ] **Step 10: Commit**

```bash
git add server/services/broll.js server/services/__tests__/get-broll-editor-data-remap.test.js
git commit -m "feat(broll): hash-diff remap injected into getBRollEditorData

First open: stored hash is null, remap runs and persists. Subsequent
cut edits invalidate via hash; next editor-data fetch re-derives.
Self-correcting per pipeline; no explicit invalidation from cut-save."
```

---

## Task 7: Drop legacy `recomputePlacementsForCuts` from `_putEditorStateHandler`

**Why:** The handler runs a recompute on `editor_state.broll.placements` — a legacy storage path the modern b-roll editor never reads. Modern remap is now in `getBRollEditorData` (Task 6). Keeping the old call wastes work and risks future bugs from divergent state.

**Files:**
- Modify: `server/routes/videos.js` — `_putEditorStateHandler` (line 918–955).
- Test: `server/routes/__tests__/editor-state-cut-edit.test.js` (existing — flip assertions).

- [ ] **Step 1: Read the existing test to understand its current assertions**

```
sed -n '1,50p' server/routes/__tests__/editor-state-cut-edit.test.js
```

The test currently asserts that when cuts change, `editor_state.broll.placements` get recomputed. We're flipping that — placements must NOT be mutated.

- [ ] **Step 2: Update the test to assert no legacy mutation**

Find the existing test in `editor-state-cut-edit.test.js` that expects the recompute and rewrite its assertion. The existing test's "expected to be shifted" pattern flips to "expected to remain unchanged":

```js
it('does not mutate editor_state.broll.placements when cuts change (modern remap is in getBRollEditorData)', async () => {
  const initial = {
    cuts: [{ id: 'c1', start: 10, end: 15 }],
    broll: { placements: [{ uuid: 'p1', start_seconds: 20, end_seconds: 22, anchor_word_idx: 0 }] },
  }
  // ...existing test setup that PUTs new cuts...
  const newCuts = [{ id: 'c1', start: 10, end: 15 }, { id: 'c2', start: 30, end: 35 }]
  // Call handler with new cuts.
  // After: expect placements untouched.
  const after = JSON.parse(savedEditorState.editor_state_json)
  expect(after.broll.placements[0].start_seconds).toBe(20)
  expect(after.broll.placements[0].end_seconds).toBe(22)
})
```

(Carry over the test's existing fixture/mocking style; only the assertion flips.)

- [ ] **Step 3: Run the test, verify it currently fails because the recompute still fires**

```
npx vitest run server/routes/__tests__/editor-state-cut-edit.test.js
```

Expected: FAIL — placements were shifted by the legacy recompute.

- [ ] **Step 4: Remove the recompute block from `_putEditorStateHandler`**

In `server/routes/videos.js` (around line 935), delete this block:

```js
const cutsChanged = JSON.stringify(oldCuts) !== JSON.stringify(newCuts)
if (cutsChanged && editor_state.broll?.placements?.length) {
  // Load words for the main video in this group (raw type only).
  const mainVideo = await db.prepare("SELECT id FROM videos WHERE group_id = ? AND video_type = 'raw' LIMIT 1").get(req.params.id)
  if (mainVideo) {
    const t = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw' LIMIT 1").get(mainVideo.id)
    if (t?.word_timestamps_json) {
      const words = JSON.parse(t.word_timestamps_json)
      editor_state.broll.placements = recomputePlacementsForCuts(
        editor_state.broll.placements,
        newCuts,
        editor_state.cutExclusions || [],
        words,
      )
    }
  }
}
```

Also remove the now-unused import at the top of the file:

```js
import { recomputePlacementsForCuts } from '../services/recompute-placement-times.js'
```

If `oldCuts`/`newCuts` are no longer referenced after deletion, also remove their assignments:

```js
const oldState = group.editor_state_json ? JSON.parse(group.editor_state_json) : {}
const oldCuts = oldState.cuts || []
const newCuts = editor_state.cuts || []
```

Replace with just the unconditional save (the rest of the handler is unchanged).

- [ ] **Step 5: Re-run the test and verify it passes**

```
npx vitest run server/routes/__tests__/editor-state-cut-edit.test.js
```

Expected: PASS.

- [ ] **Step 6: Run the recompute-placement-times test to confirm it still passes (the helper is unused but the file remains)**

```
npx vitest run server/services/__tests__/recompute-placement-times.test.js
```

Expected: PASS. The function is now an unused export — leaving the file allows a future cleanup commit to remove it without touching this PR.

- [ ] **Step 7: Commit**

```bash
git add server/routes/videos.js server/routes/__tests__/editor-state-cut-edit.test.js
git commit -m "refactor(broll): drop legacy recomputePlacementsForCuts from cut-save handler

Modern path remaps via cutsHash diff inside getBRollEditorData. The
recompute on editor_state.broll.placements wrote to a storage the
modern b-roll editor never reads — pure dead work."
```

---

## Task 8: Diagnose and fix rough-cut tab strike-through regression

**Why:** User reports cut words now visually disappear on `/editor/:id/roughcut` instead of showing struck through. `TranscriptEditor.jsx:842` already wires the `line-through` className conditionally on `cut && !isUnsafeFiller`, so the regression is upstream — either `cut` is no longer being set, or `displayItems` is filtering cut words out, or the cuts aren't reaching the component.

**Files:**
- Modify: `src/components/editor/TranscriptEditor.jsx` (whatever lines turn out to be the bug).
- Create: `src/components/editor/__tests__/TranscriptEditor-rough-cut-strike.test.jsx`

- [ ] **Step 1: Reproduce on group 374**

Start the dev server (`npm run dev` if frontend-only is sufficient; otherwise spin up backend per project convention but be aware of the dev-server-boot hazard around stuck b-roll chains in this repo's memory). Open `/editor/374/roughcut` in a browser. Observe: cut words are missing entirely instead of struck through. Take note of any console warnings.

- [ ] **Step 2: Inspect the rendered DOM via the browser dev tools**

In dev tools, find a span that should be a cut word ("um", "uh", filler). Check whether:
- The span exists at all (if not: `displayItems` is filtering it out — bug is upstream of the JSX).
- The span exists but has no `line-through` class (bug is in the className expression — maybe `cut` is falsy).
- The span has `line-through` but `display: none` or `opacity: 0` (bug is in the className from `opacity-30` overriding visibility, or some other style).

- [ ] **Step 3: Bisect git log on TranscriptEditor.jsx + cut-detection helpers**

```bash
git log --oneline -20 -- src/components/editor/TranscriptEditor.jsx
git log --oneline -20 -- src/components/editor/brollUtils.js src/components/editor/useEditorState.js
```

Look for changes since the last known-good behavior. Likely suspects: a recent refactor of `displayItems` derivation, a change to how `cut` is computed per word, a change to gap-marker handling.

- [ ] **Step 4: Write the regression-guard test FIRST (lock in the contract)**

`src/components/editor/__tests__/TranscriptEditor-rough-cut-strike.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

// Mock supabase / api fetches the editor pulls in transitively.
vi.mock('../../../lib/supabaseClient.js', () => ({ supabase: null }))

import TranscriptEditor from '../TranscriptEditor.jsx'

describe('TranscriptEditor — rough-cut strike-through regression', () => {
  it('renders cut words with line-through className when activeTab=roughcut', () => {
    const words = [
      { word: 'Hello', start: 0, end: 0.5 },
      { word: 'um', start: 0.5, end: 0.8 },     // inside cut
      { word: 'world', start: 0.8, end: 1.2 },
    ]
    const cuts = [{ id: 'c1', start: 0.5, end: 0.8 }]
    const props = {
      // Whatever shape TranscriptEditor expects — copy from another existing
      // TranscriptEditor test file in __tests__ for the canonical fixture.
      transcriptWords: words,
      cuts,
      activeTab: 'roughcut',
      annotations: { items: [] },
      cutExclusions: [],
    }
    const { container } = render(<TranscriptEditor {...props} />)
    const allSpans = container.querySelectorAll('span')
    const umSpan = Array.from(allSpans).find(s => s.textContent.trim().startsWith('um'))
    expect(umSpan).toBeDefined()
    expect(umSpan.className).toContain('line-through')
  })
})
```

Look at any existing `TranscriptEditor.*test.jsx` (if absent, peer at sibling editor test files like `BRollEditor.test.jsx`) for the canonical context-mocking pattern in this codebase. Adjust the props to match what the component actually consumes.

- [ ] **Step 5: Run the test and verify it fails (as the live regression does)**

```
npx vitest run src/components/editor/__tests__/TranscriptEditor-rough-cut-strike.test.jsx
```

Expected: FAIL — span missing OR no `line-through` class. The specific failure tells you which of the three Step 2 buckets the regression sits in.

- [ ] **Step 6: Fix the broken contract**

Locate the upstream cause from Step 3 (git bisect) + Step 5 (test failure mode). Apply the smallest fix that restores the contract. Common shapes:

- **`displayItems` filtering out cut words:** the derivation must KEEP cut words (with a `cut: true` flag) for the rough-cut tab. If the filter was added recently, conditionally skip it when `activeTab === 'roughcut'`.
- **`cut` boolean falsy:** the per-word `cut` derivation may have lost its cut-membership check. Compare each word's start against the current `cuts` array.
- **CSS class override:** if `line-through` is present but visually hidden, the `opacity-30` override may be too aggressive or a higher-specificity rule was added.

The exact diff depends on what Step 5's failure says. Whatever it is — make the smallest change that flips the test to PASS without breaking other display states (selected, gap, unsafe filler).

- [ ] **Step 7: Re-run the regression test until it passes**

```
npx vitest run src/components/editor/__tests__/TranscriptEditor-rough-cut-strike.test.jsx
```

Expected: PASS.

- [ ] **Step 8: Run the full editor test suite to confirm no other display states regressed**

```
npx vitest run src/components/editor/__tests__
```

Expected: all editor tests pass.

- [ ] **Step 9: Visually re-verify on group 374**

Reload `/editor/374/roughcut` in the browser. Cut words appear struck through and dimmed. Selected words still highlight. Gap markers still render. Unsafe filler still gets the yellow background.

- [ ] **Step 10: Commit**

```bash
git add src/components/editor/TranscriptEditor.jsx src/components/editor/__tests__/TranscriptEditor-rough-cut-strike.test.jsx
git commit -m "fix(editor): restore strike-through display for cut words on rough-cut tab

Regression: cut words were visually disappearing instead of rendering
with line-through. Restored the [contract that broke per Step 5/6
diagnosis — fill in actual cause] and added a render-test guard."
```

---

## Task 9: Manual smoke verification on group 374

**Why:** The unit and integration tests prove the function pieces work. This task proves the complete path works end-to-end against real data, on the URL that surfaced the original bug.

**Files:** None — verification only.

- [ ] **Step 1: Start the dev server**

Per the repo's standard run script — but be cautious: `npm run dev:server` triggers auto-resume of stuck b-roll chains in this codebase (memory note). For pure verification of the editor display, the static frontend dev server is enough; do not start the backend if there are stuck chains in the DB.

- [ ] **Step 2: Open `/editor/374/brolls/edit/0` in a browser**

Verify: the first placement now shows ~0:08 (or whatever is the correct post-cut position of "From a tax standpoint" / "bad piece of advice floating around the internet"), NOT 2:08 / 2:14.

- [ ] **Step 3: Add a manual cut between two placements**

In `/editor/374/roughcut`, drag a new cut covering text between two known b-roll placements. Auto-save fires (1500ms debounce).

- [ ] **Step 4: Reopen `/editor/374/brolls/edit`**

Verify the placements after the new cut have shifted post-cut times reflecting the added cut. The placement BEFORE the new cut should be unchanged.

- [ ] **Step 5: Edit a transcript word on `/editor/374/roughcut`**

Confirm cut words appear struck through (not removed) — Task 8's regression fix is visible.

- [ ] **Step 6: Verify the database state**

Run a quick diagnostic against Postgres (DATABASE_URL is in .env) — example:

```bash
node --env-file=.env -e '
import("./server/db.js").then(async ({default: db}) => {
  const r = await db.prepare(`
    SELECT plan_pipeline_id, version, length(state_json) AS len
    FROM broll_editor_state
    WHERE plan_pipeline_id LIKE \'plan-518-%\'
  `).all()
  console.log(r)
  process.exit(0)
})
'
```

Expected: at least one row exists for a `plan-518-*` pipelineId, with non-trivial `state_json` length (the `remappedPositions` + `lastRemappedCutsHash` are now persisted).

- [ ] **Step 7: Final commit if any documentation tweaks shaken out**

If during smoke you discovered a doc gap or comment that needs updating, commit it now. Otherwise, this task is verification-only and doesn't produce a commit.

- [ ] **Step 8: Run the full test suite one final time**

```
npm test
```

Expected: 0 failures across server/web/extension projects.

---

## Self-Review (one-pass, before handoff)

**Spec coverage check:**
- Fix 1 (parse timecode in persistPlacementOutput) → Task 1 ✓
- Fix 2 (rough-cut strike-through regression) → Task 8 ✓
- Fix 3 (drop legacy recompute) → Task 7 ✓
- New file `placement-remap.js` with `cutsHash` + `materializePlacementRemap` → Tasks 2–5 ✓
- Anchor resolve via `anchor_word_idx` → Task 3 ✓
- Anchor fuzzy fallback (whole-transcript, skip cuts) → Task 4 ✓
- Orphan / in-cut state markers → Tasks 3 + 4 ✓
- 0.5s minimum + overlap trim + overlap_squeezed flag → Task 5 ✓
- Hash-diff integration into `getBRollEditorData` → Task 6 ✓
- Unit tests for `placement-remap` → Tasks 2–5 ✓
- Integration tests for `getBRollEditorData` hash hit/miss → Task 6 ✓
- Persist-time test for timecode-only input → Task 1 ✓
- Rough-cut render-test regression guard → Task 8 ✓
- Manual smoke (group 374 reproduction) → Task 9 ✓

**Type / signature consistency:**
- `cutsHash(cuts, exclusions)` — same signature in Tasks 2 + 6 + 9 fixture ✓
- `materializePlacementRemap(placements, effectiveCuts, words)` — same signature in Tasks 3, 4, 5, 6 ✓
- `anchor_state` enum: `'idx' | 'fuzzy' | 'in_cut' | 'orphaned' | 'overlap_squeezed'` — used consistently across Tasks 3–5 ✓
- `remappedPositions[uuid] = { start_seconds, end_seconds, anchor_state }` — same shape Tasks 5–6 ✓
- `lastRemappedCutsHash` — string, persisted in `broll_editor_state.state_json` — Tasks 6 + 9 ✓

**No placeholders:** every step has runnable commands or complete code, except Task 8 Steps 6 + 10 where the precise fix can't be specified without diagnosis (but the test that locks in the contract IS specified, and the diagnostic protocol is concrete).
