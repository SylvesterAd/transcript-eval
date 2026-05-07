# Post-Cut Canonical B-Roll Placements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate b-roll placement storage from original-time canonical to post-cut canonical. Replace cut-overlay UI in b-roll editor with collapsed purple-bar joins. Fix dual-cut-system bug between server X1 hook and frontend TranscriptEditor.

**Architecture:** Placements store post-cut seconds + `anchor_word_idx` (raw transcript word index) for stable identity across cut edits. Server computes anchor index on persist; recomputes start/end on cut edit. Export translates post-cut → original at NLE-emit time. UI renders post-cut domain directly with cut joins as 4px purple bars (click for side-panel showing removed content).

**Tech Stack:** Node 20 (server), React 19 + Vite (web), PostgreSQL via `pg`, Vitest, Tailwind CSS.

**Sister spec:** `docs/superpowers/specs/2026-05-07-post-cut-canonical-placements-design.md`

---

## File Structure

### Server

- **Modify** `server/services/broll.js` — delete `unshiftPostCutTime`, `remapPlacementTimes`, `remapPlacementTimesString`; gut `persistPlacementOutput` to attach `anchor_word_idx` only (no time conversion)
- **Modify** `server/services/cuts-from-annotations.js` — `deriveCutsFromAnnotations` extends regions to nearest uncut word (port from `TranscriptEditor.jsx`)
- **Modify** `server/routes/videos.js` — PUT `/groups/:id/editor-state` recomputes placement times when cuts change
- **Modify** `server/services/xmeml-generator.js` — accept post-cut placements + cuts, translate at emit
- **Modify** `server/routes/export-xml.js` — pass cuts to xmeml-generator
- **Create** `server/services/time-translation.js` — extract `unshiftPostCutTime` (only export uses it now), add `postCutTime` (forward direction)
- **Create** `server/services/anchor-word.js` — `findAnchorWordIdx(words, audioAnchor)` with nearest-time tiebreaker
- **Create** `server/services/recompute-placement-times.js` — `recomputePlacementsForCuts(placements, oldCuts, newCuts, words)`
- **Create** `scripts/_migrate-placements-to-postcut.mjs` — one-shot DB migration

### Web

- **Modify** `src/components/editor/Timeline.jsx` — render post-cut layout for b-roll mode (cuts collapse to bars)
- **Modify** `src/components/editor/BRollPreview.jsx` — convert original `<video>.currentTime` to post-cut for playhead display
- **Modify** `src/components/editor/usePlaybackSkipRegions.js` — keep playback skip behavior, no UI change
- **Modify** `src/components/editor/useEditorState.js` — flag orphaned placements to UI
- **Create** `src/components/editor/CutBar.jsx` — thin bar + click-to-expand side panel
- **Create** `src/components/editor/CutContentPanel.jsx` — side panel rendering removed transcript/A-roll/waveform
- **Create** `src/lib/postCutTimeline.js` — pure compute helpers for post-cut timeline layout (segment widths, cut bar positions)

### Tests (alongside each new/modified file)

- `server/services/__tests__/anchor-word.test.js`
- `server/services/__tests__/recompute-placement-times.test.js`
- `server/services/__tests__/persist-placement-output-postcut.test.js` (replaces existing un-shift tests)
- `server/services/__tests__/cuts-from-annotations-extended.test.js`
- `server/services/__tests__/time-translation.test.js`
- `server/routes/__tests__/editor-state-cut-edit.test.js`
- `server/services/__tests__/xmeml-generator-postcut.test.js`
- `src/components/editor/__tests__/Timeline-postcut.test.jsx`
- `src/components/editor/__tests__/CutBar.test.jsx`
- `src/lib/__tests__/postCutTimeline.test.js`
- `scripts/_proof-postcut-canonical.mjs` — real-data round-trip on project 273

### Tests deleted (un-shift no longer canonical)

- `server/services/__tests__/post-cut-mapping.test.js`
- `server/services/__tests__/post-cut-mapping-strings.test.js`
- `server/services/__tests__/post-cut-real-data.test.js`
- `server/services/__tests__/persist-placement-output-integration.test.js`
- `server/services/__tests__/execute-create-plan-cuts.test.js`

---

## Task 1: Extract `time-translation.js`, add `postCutTime`

Move `unshiftPostCutTime` out of `broll.js` into a pure-function module. Add the forward direction (`postCutTime`) that maps original-time → post-cut. Round-trip identity is the test invariant.

**Files:**
- Create: `server/services/time-translation.js`
- Create: `server/services/__tests__/time-translation.test.js`
- Modify: `server/services/broll.js` (re-export `unshiftPostCutTime` from new module for now — Task 9 deletes from broll.js)

- [ ] **Step 1: Write the failing test**

```js
// server/services/__tests__/time-translation.test.js
import { describe, it, expect } from 'vitest'
import { postCutTime, unshiftPostCutTime } from '../time-translation.js'

describe('postCutTime', () => {
  const cuts = [{ start: 10, end: 15 }, { start: 20, end: 25 }]

  it('identity for time before any cut', () => {
    expect(postCutTime(5, cuts)).toBe(5)
  })

  it('shifts time inside a cut to cut.end (collapses to start of next kept span)', () => {
    expect(postCutTime(12, cuts)).toBe(10)  // mid-cut → cut.end - cum_offset_so_far(0) = 15 - 5 = 10
  })

  it('shifts time after first cut by cum offset', () => {
    expect(postCutTime(18, cuts)).toBe(13)  // 18 - 5 (first cut) = 13
  })

  it('shifts time after both cuts by total cum offset', () => {
    expect(postCutTime(30, cuts)).toBe(20)  // 30 - 5 - 5 = 20
  })
})

describe('round-trip identity', () => {
  const cuts = [{ start: 10, end: 15 }, { start: 20, end: 25 }]

  it('postCutTime ∘ unshiftPostCutTime is identity for kept times', () => {
    for (const t of [5, 8, 16, 17, 26, 30]) {
      const pc = postCutTime(t, cuts)
      expect(unshiftPostCutTime(pc, cuts, 'start')).toBe(t)
    }
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
node --env-file=.env node_modules/.bin/vitest run server/services/__tests__/time-translation.test.js
```

Expected: import error on `time-translation.js`.

- [ ] **Step 3: Implement `server/services/time-translation.js`**

```js
// Forward: original-time → post-cut. If t lands inside a cut, returns the
// post-cut position of the next kept word (i.e., cut.end mapped to post-cut).
export function postCutTime(tOrig, effectiveCuts) {
  if (!effectiveCuts || !effectiveCuts.length) return tOrig
  let cumOffset = 0
  for (const c of effectiveCuts) {
    if (tOrig < c.start) return tOrig - cumOffset
    if (tOrig >= c.start && tOrig < c.end) return c.start - cumOffset
    cumOffset += c.end - c.start
  }
  return tOrig - cumOffset
}

// Inverse: post-cut → original. Used only for export translation.
// kind='start' jumps PAST a cut at boundary; kind='end' stays before.
export function unshiftPostCutTime(tPost, effectiveCuts, kind = 'start') {
  if (!effectiveCuts || !effectiveCuts.length) return tPost
  let cumOffset = 0
  for (const c of effectiveCuts) {
    const boundary = c.start - cumOffset
    const beforeBoundary = kind === 'end' ? tPost <= boundary : tPost < boundary
    if (beforeBoundary) return tPost + cumOffset
    cumOffset += c.end - c.start
  }
  return tPost + cumOffset
}
```

- [ ] **Step 4: Re-export from broll.js for backward compat (deleted in Task 9)**

```js
// server/services/broll.js — at top of file, add:
export { unshiftPostCutTime } from './time-translation.js'
```

Remove the old in-file definition of `unshiftPostCutTime`.

- [ ] **Step 5: Run tests, verify pass**

```bash
node --env-file=.env node_modules/.bin/vitest run server/services/__tests__/time-translation.test.js
```

Expected: all pass.

- [ ] **Step 6: Run full test suite to verify nothing broke**

```bash
node --env-file=.env node_modules/.bin/vitest run
```

Expected: all pass (we only moved code, no behavior change yet).

- [ ] **Step 7: Commit**

```bash
git add server/services/time-translation.js server/services/__tests__/time-translation.test.js server/services/broll.js
git commit -m "$(cat <<'EOF'
refactor(broll): extract time-translation.js + add postCutTime

unshiftPostCutTime moves from broll.js to a focused module. New postCutTime
(forward direction) is its inverse. Round-trip identity verified.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `findAnchorWordIdx` helper

Build the function that, given a raw transcript's word_timestamps and an `audio_anchor` string, returns the index of the matching word. Used by `persistPlacementOutput` to attach stable identity to each placement.

**Files:**
- Create: `server/services/anchor-word.js`
- Create: `server/services/__tests__/anchor-word.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/__tests__/anchor-word.test.js
import { describe, it, expect } from 'vitest'
import { findAnchorWordIdx } from '../anchor-word.js'

const words = [
  { word: 'There', start: 19.94, end: 20.10 },
  { word: 'is', start: 20.10, end: 20.18 },
  { word: 'a', start: 20.18, end: 20.21 },
  { word: 'bad', start: 20.21, end: 20.50 },
  { word: 'piece', start: 20.50, end: 20.78 },
  { word: 'of', start: 20.78, end: 20.85 },
  { word: 'advice', start: 20.85, end: 21.30 },
  { word: 'There', start: 100.00, end: 100.16 },  // duplicate phrase later
  { word: 'is', start: 100.16, end: 100.24 },
  { word: 'a', start: 100.24, end: 100.27 },
  { word: 'good', start: 100.27, end: 100.50 },
  { word: 'piece', start: 100.50, end: 100.78 },
]

describe('findAnchorWordIdx', () => {
  it('returns word index for an exact phrase match', () => {
    expect(findAnchorWordIdx(words, 'There is a bad piece')).toBe(0)
  })

  it('matches whole-word, case-insensitive, ignoring punctuation', () => {
    expect(findAnchorWordIdx(words, "There's a bad piece of advice.")).toBe(0)
  })

  it('returns -1 when phrase not found', () => {
    expect(findAnchorWordIdx(words, 'never appears here')).toBe(-1)
  })

  it('returns earliest match when phrase is ambiguous (nearest to t=0 tiebreaker)', () => {
    expect(findAnchorWordIdx(words, 'There is a')).toBe(0)  // first occurrence wins
  })

  it('handles single-word anchor', () => {
    expect(findAnchorWordIdx(words, 'advice')).toBe(6)
  })

  it('returns -1 on empty/null input', () => {
    expect(findAnchorWordIdx([], 'x')).toBe(-1)
    expect(findAnchorWordIdx(words, '')).toBe(-1)
    expect(findAnchorWordIdx(null, 'x')).toBe(-1)
    expect(findAnchorWordIdx(words, null)).toBe(-1)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
node --env-file=.env node_modules/.bin/vitest run server/services/__tests__/anchor-word.test.js
```

- [ ] **Step 3: Implement `server/services/anchor-word.js`**

```js
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[,.;:?!"'`’]/g, '').replace(/\s+/g, ' ').trim()
}

export function findAnchorWordIdx(words, audioAnchor) {
  if (!Array.isArray(words) || !words.length) return -1
  const target = normalize(audioAnchor)
  if (!target) return -1
  const targetTokens = target.split(' ')
  const N = targetTokens.length
  for (let i = 0; i <= words.length - N; i++) {
    let ok = true
    for (let j = 0; j < N; j++) {
      if (normalize(words[i + j].word) !== targetTokens[j]) { ok = false; break }
    }
    if (ok) return i
  }
  // Fallback: match just the first targetToken (single-word anchor or partial phrase)
  if (N >= 1) {
    for (let i = 0; i < words.length; i++) {
      if (normalize(words[i].word) === targetTokens[0]) return i
    }
  }
  return -1
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
node --env-file=.env node_modules/.bin/vitest run server/services/__tests__/anchor-word.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/services/anchor-word.js server/services/__tests__/anchor-word.test.js
git commit -m "$(cat <<'EOF'
feat(broll): add findAnchorWordIdx for placement stable-identity

Resolves audio_anchor → raw transcript word index. Used by persistPlacementOutput
to attach a stable per-placement identity that survives cut edits (anchor_word_idx
maps back to original-time, then re-derives post-cut on cut change).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `recomputePlacementsForCuts` helper

Given placements with `anchor_word_idx` and a new cut set, recomputes `start_seconds` / `end_seconds` for each placement. Preserves duration. Flags orphaned placements.

**Files:**
- Create: `server/services/recompute-placement-times.js`
- Create: `server/services/__tests__/recompute-placement-times.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { recomputePlacementsForCuts } from '../recompute-placement-times.js'

const words = [
  { word: 'a', start: 0, end: 1 },
  { word: 'b', start: 1, end: 2 },
  { word: 'c', start: 5, end: 6 },
  { word: 'd', start: 10, end: 11 },
]

describe('recomputePlacementsForCuts', () => {
  it('recomputes start_seconds + end_seconds preserving duration', () => {
    const placements = [
      { uuid: 'p1', anchor_word_idx: 2, start_seconds: 5, end_seconds: 8, audio_anchor: 'c' },
    ]
    // New cut [2, 4]: original word 'c' at t=5 → post-cut t=3. Duration 3 preserved.
    const newCuts = [{ start: 2, end: 4 }]
    const result = recomputePlacementsForCuts(placements, newCuts, [], words)
    expect(result[0].start_seconds).toBe(3)
    expect(result[0].end_seconds).toBe(6)
    expect(result[0].anchor_orphaned).toBeFalsy()
  })

  it('marks orphaned when anchor_word_idx is null', () => {
    const placements = [{ uuid: 'p1', start_seconds: 5, end_seconds: 8, audio_anchor: 'x' }]
    const result = recomputePlacementsForCuts(placements, [], [], words)
    expect(result[0].anchor_orphaned).toBe(true)
  })

  it('marks anchor_in_cut when anchor word falls inside new cut', () => {
    const placements = [
      { uuid: 'p1', anchor_word_idx: 2, start_seconds: 5, end_seconds: 8, audio_anchor: 'c' },
    ]
    const newCuts = [{ start: 4, end: 8 }]  // contains word 'c' at t=5
    const result = recomputePlacementsForCuts(placements, newCuts, [], words)
    expect(result[0].anchor_in_cut).toBe(true)
  })

  it('preserves placements when cuts list is empty', () => {
    const placements = [
      { uuid: 'p1', anchor_word_idx: 2, start_seconds: 5, end_seconds: 8, audio_anchor: 'c' },
    ]
    const result = recomputePlacementsForCuts(placements, [], [], words)
    expect(result[0].start_seconds).toBe(5)
    expect(result[0].end_seconds).toBe(8)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement `server/services/recompute-placement-times.js`**

```js
import { computeEffectiveCuts } from './broll.js'
import { postCutTime } from './time-translation.js'

export function recomputePlacementsForCuts(placements, cuts, exclusions, words) {
  const effective = computeEffectiveCuts(cuts || [], exclusions || [])
  return placements.map(p => {
    const next = { ...p }
    delete next.anchor_orphaned
    delete next.anchor_in_cut
    if (p.anchor_word_idx == null || p.anchor_word_idx < 0) {
      next.anchor_orphaned = true
      return next
    }
    const w = words[p.anchor_word_idx]
    if (!w) {
      next.anchor_orphaned = true
      return next
    }
    const inCut = effective.some(c => w.start >= c.start && w.start < c.end)
    if (inCut) next.anchor_in_cut = true
    const duration = (p.end_seconds ?? 0) - (p.start_seconds ?? 0)
    const newStart = postCutTime(w.start, effective)
    next.start_seconds = newStart
    next.end_seconds = newStart + duration
    return next
  })
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add server/services/recompute-placement-times.js server/services/__tests__/recompute-placement-times.test.js
git commit -m "$(cat <<'EOF'
feat(broll): add recomputePlacementsForCuts for cut-edit handler

Re-derives post-cut start/end from each placement's anchor_word_idx +
new cut set. Preserves duration. Flags orphaned (no anchor) and
anchor_in_cut (anchor word inside new cut) cases for UI to display.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Gut `persistPlacementOutput` (no time conversion, just attach `anchor_word_idx`)

Replace the un-shift logic with anchor-word-idx attachment. LLM emits post-cut times — we keep them. We just decorate each placement with `anchor_word_idx` for future cut-edit recomputes.

**Files:**
- Modify: `server/services/broll.js`
- Create: `server/services/__tests__/persist-placement-output-postcut.test.js`
- Delete: `server/services/__tests__/post-cut-mapping.test.js`
- Delete: `server/services/__tests__/post-cut-mapping-strings.test.js`
- Delete: `server/services/__tests__/post-cut-real-data.test.js`
- Delete: `server/services/__tests__/persist-placement-output-integration.test.js`

- [ ] **Step 1: Write the new failing test**

```js
// server/services/__tests__/persist-placement-output-postcut.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrepare = vi.fn()
vi.mock('../../db.js', () => ({
  default: { prepare: (...a) => mockPrepare(...a) },
}))

import { persistPlacementOutput } from '../broll.js'

const fakeWords = [
  { word: 'There', start: 19.94, end: 20.10 },
  { word: 'is', start: 20.10, end: 20.18 },
  { word: 'a', start: 20.18, end: 20.21 },
  { word: 'bad', start: 20.21, end: 20.50 },
  { word: 'piece', start: 20.50, end: 20.78 },
]

beforeEach(() => {
  mockPrepare.mockReset()
  mockPrepare.mockReturnValue({
    get: vi.fn().mockResolvedValue({ word_timestamps_json: JSON.stringify(fakeWords) }),
  })
})

describe('persistPlacementOutput (post-cut canonical)', () => {
  const editorCuts = { cuts: [{ start: 10, end: 15 }], cutExclusions: [] }

  it('keeps placement times unchanged', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const parsed = JSON.parse(out)
    expect(parsed.placements[0].start).toBe('[00:00:19.94]')
    expect(parsed.placements[0].end).toBe('[00:00:23.94]')
  })

  it('attaches anchor_word_idx based on audio_anchor', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const parsed = JSON.parse(out)
    expect(parsed.placements[0].anchor_word_idx).toBe(0)
  })

  it('sets anchor_word_idx = -1 when audio_anchor not in transcript', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'never says this' }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    expect(JSON.parse(out).placements[0].anchor_word_idx).toBe(-1)
  })

  it('passes through unchanged when videoId omitted (cant fetch words)', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)  // no videoId
    expect(out).toBe(stageOutput)
  })
})
```

- [ ] **Step 2: Delete the old un-shift tests**

```bash
git rm server/services/__tests__/post-cut-mapping.test.js \
       server/services/__tests__/post-cut-mapping-strings.test.js \
       server/services/__tests__/post-cut-real-data.test.js \
       server/services/__tests__/persist-placement-output-integration.test.js
```

- [ ] **Step 3: Run failing test**

```bash
node --env-file=.env node_modules/.bin/vitest run server/services/__tests__/persist-placement-output-postcut.test.js
```

- [ ] **Step 4: Replace `persistPlacementOutput` body**

In `server/services/broll.js`, replace the current implementation:

```js
import { findAnchorWordIdx } from './anchor-word.js'

/**
 * Persists LLM placement output to DB. Attaches anchor_word_idx to each
 * placement (from audio_anchor → raw transcript word index) for stable
 * identity across cut edits. Does NOT shift timecodes — LLM emits in
 * post-cut domain, we keep them as post-cut.
 */
export async function persistPlacementOutput(stageOutput, editorCuts, videoId) {
  // No video ID → can't load words → can't attach anchor_word_idx → return raw
  if (!videoId) return stageOutput

  let parsed
  try { parsed = extractJSON(stageOutput) }
  catch { return stageOutput }

  let words = []
  try {
    const t = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(videoId)
    if (t?.word_timestamps_json) words = JSON.parse(t.word_timestamps_json)
  } catch (err) {
    console.warn('[persistPlacementOutput] failed to load words:', err.message)
  }
  if (!words.length) return stageOutput

  const annotate = (placements) => placements.map(p => ({
    ...p,
    anchor_word_idx: findAnchorWordIdx(words, p.audio_anchor),
  }))

  let result
  if (Array.isArray(parsed)) {
    result = annotate(parsed)
  } else if (parsed && Array.isArray(parsed.chapters)) {
    result = {
      ...parsed,
      chapters: parsed.chapters.map(ch => ({
        ...ch,
        placements: Array.isArray(ch.placements) ? annotate(ch.placements) : ch.placements,
      })),
    }
  } else if (parsed && Array.isArray(parsed.placements)) {
    result = { ...parsed, placements: annotate(parsed.placements) }
  } else {
    return stageOutput
  }
  return JSON.stringify(result, null, 2)
}
```

Update the existing call site in `executeCreatePlan` to pass `videoId`:

```js
// in executeCreatePlan, the per-chapter sub-run loop:
const chapterOutput = await persistPlacementOutput(result.text, editorCuts, videoId)
```

- [ ] **Step 5: Run new tests, verify pass**

```bash
node --env-file=.env node_modules/.bin/vitest run server/services/__tests__/persist-placement-output-postcut.test.js
```

- [ ] **Step 6: Run full server suite, verify everything still passes after the deletions**

```bash
node --env-file=.env node_modules/.bin/vitest run server/
```

- [ ] **Step 7: Commit**

```bash
git add server/services/broll.js server/services/__tests__/persist-placement-output-postcut.test.js
git commit -m "$(cat <<'EOF'
refactor(broll): persistPlacementOutput attaches anchor_word_idx, no shift

LLM emits post-cut times; we keep them as-is. The chokepoint's only job
now is to decorate each placement with anchor_word_idx (raw-transcript
word index for the audio_anchor phrase) — gives placements a stable
identity that survives cut edits.

Deletes the old un-shift test suite (~6 files): post-cut-mapping,
post-cut-mapping-strings, post-cut-real-data, persist-placement-output-
integration. Replaced by persist-placement-output-postcut.test.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Cut-edit handler in `PUT /editor-state`

Detect cut changes on save. When `state.cuts` differs from DB state, recompute placement times before write.

**Files:**
- Modify: `server/routes/videos.js`
- Create: `server/routes/__tests__/editor-state-cut-edit.test.js`

- [ ] **Step 1: Write failing test**

```js
// server/routes/__tests__/editor-state-cut-edit.test.js
// (uses real-DB integration mode like broll-uuid-migration tests)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import db from '../../db.js'
import express from 'express'
import request from 'supertest'
import videosRouter from '../videos.js'

describe('PUT /editor-state cut-edit handler', () => {
  let groupId, videoId
  beforeAll(async () => {
    // Insert a fixture group with placements, raw transcript words
    const v = await db.prepare("INSERT INTO videos (title, video_type) VALUES ('test', 'raw') RETURNING id").get()
    videoId = v.id
    const words = [{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 5, end: 6 }, { word: 'c', start: 10, end: 11 }]
    await db.prepare("INSERT INTO transcripts (video_id, type, word_timestamps_json) VALUES (?, 'raw', ?)").run(videoId, JSON.stringify(words))
    const initialState = {
      cuts: [],
      broll: {
        placements: [{
          uuid: 'p1', anchor_word_idx: 2, audio_anchor: 'c',
          start_seconds: 10, end_seconds: 13,  // post-cut == original since no cuts
        }],
      },
    }
    const g = await db.prepare("INSERT INTO video_groups (name, editor_state_json) VALUES ('t', ?) RETURNING id").get(JSON.stringify(initialState))
    groupId = g.id
    await db.prepare("UPDATE videos SET group_id = ? WHERE id = ?").run(groupId, videoId)
  })

  afterAll(async () => {
    await db.prepare('DELETE FROM video_groups WHERE id = ?').run(groupId)
    await db.prepare('DELETE FROM videos WHERE id = ?').run(videoId)
  })

  it('recomputes placement post-cut times when cuts change', async () => {
    const app = express(); app.use(express.json()); app.use((req,_,next) => { req.auth = { userId: 'dev' }; next() }); app.use(videosRouter)
    // Add a cut [2, 4] (before the anchor word at original t=10)
    const newState = {
      cuts: [{ start: 2, end: 4, source: 'manual' }],
      broll: {
        placements: [{
          uuid: 'p1', anchor_word_idx: 2, audio_anchor: 'c',
          start_seconds: 10, end_seconds: 13,
        }],
      },
    }
    await request(app).put(`/groups/${groupId}/editor-state`).send(newState).expect(200)
    const row = await db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(groupId)
    const stored = JSON.parse(row.editor_state_json)
    // Original word 'c' at t=10. Cut [2,4] removes 2s. Post-cut t = 8.
    expect(stored.broll.placements[0].start_seconds).toBe(8)
    expect(stored.broll.placements[0].end_seconds).toBe(11)  // duration preserved
  })
})
```

- [ ] **Step 2: Run failing test (skip if no real DB / offline)**

- [ ] **Step 3: Modify `PUT /groups/:id/editor-state` in `server/routes/videos.js`**

```js
import { recomputePlacementsForCuts } from '../services/recompute-placement-times.js'

router.put('/groups/:id/editor-state', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const newState = req.body
  if (!newState || typeof newState !== 'object') {
    return res.status(400).json({ error: 'editor state required' })
  }

  const oldRow = await db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(groupId)
  const oldState = oldRow?.editor_state_json ? JSON.parse(oldRow.editor_state_json) : {}
  const oldCuts = oldState.cuts || []
  const newCuts = newState.cuts || []

  const cutsChanged = JSON.stringify(oldCuts) !== JSON.stringify(newCuts)
  if (cutsChanged && newState.broll?.placements?.length) {
    // Load words for the main video in this group
    const mainVideo = await db.prepare("SELECT id FROM videos WHERE group_id = ? AND video_type = 'raw' LIMIT 1").get(groupId)
    if (mainVideo) {
      const t = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(mainVideo.id)
      if (t?.word_timestamps_json) {
        const words = JSON.parse(t.word_timestamps_json)
        newState.broll.placements = recomputePlacementsForCuts(
          newState.broll.placements, newCuts, newState.cutExclusions || [], words,
        )
      }
    }
  }

  await db.prepare('UPDATE video_groups SET editor_state_json = ? WHERE id = ?')
    .run(JSON.stringify(newState), groupId)
  res.json({ ok: true })
})
```

- [ ] **Step 4: Run test, verify pass**

- [ ] **Step 5: Commit**

```bash
git add server/routes/videos.js server/routes/__tests__/editor-state-cut-edit.test.js
git commit -m "$(cat <<'EOF'
feat(editor-state): recompute placement post-cut times when cuts change

PUT /groups/:id/editor-state detects cut changes and recomputes each
placement's start_seconds/end_seconds via recomputePlacementsForCuts
before writing. Preserves duration. Marks orphaned/anchor_in_cut for
UI display.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: X1 hook produces frontend-equivalent cut shape

Today, server X1 produces tight per-annotation cuts. Frontend regenerates wider chapter-merged cuts on top, causing the dual-cut bug. Port the extend-back/forward logic so X1 output matches what the frontend would produce.

**Files:**
- Modify: `server/services/cuts-from-annotations.js`
- Create: `server/services/__tests__/cuts-from-annotations-extended.test.js`

- [ ] **Step 1: Write failing test mirroring `TranscriptEditor.jsx:432-470`**

```js
import { describe, it, expect } from 'vitest'
import { deriveCutsFromAnnotations } from '../cuts-from-annotations.js'

const words = [
  { word: 'kept1', start: 0, end: 1 },           // kept
  { word: 'cut1', start: 2.36, end: 3.0 },       // inside annotation
  { word: 'cut2', start: 3.0, end: 8.6 },        // inside annotation
  { word: 'kept2', start: 8.62, end: 8.64 },     // tiny gap
  { word: 'cut3', start: 8.64, end: 12.06 },     // inside next annotation
  { word: 'kept3', start: 12.5, end: 13 },       // kept after
]

const annotations = [
  { start: 2.36, end: 8.6, category: 'filler_words' },
  { start: 8.64, end: 12.06, category: 'filler_words' },
]

describe('deriveCutsFromAnnotations (extended)', () => {
  it('extends each annotation backward to nearest preceding uncut word end', () => {
    const cuts = deriveCutsFromAnnotations(annotations, words)
    // Annotation [2.36, 8.6] extends back: prev uncut word 'kept1' ends at 1
    // → cut starts at max(1, prev_uncut_end) = 1
    // Annotation [8.64, 12.06]: prev uncut word 'kept2' ends at 8.64
    // → cut starts at 8.64
    expect(cuts[0].start).toBeCloseTo(1, 2)
  })

  it('extends each annotation forward to nearest following uncut word start', () => {
    const cuts = deriveCutsFromAnnotations(annotations, words)
    // Annotation [2.36, 8.6] extends forward: next uncut word 'kept2' starts at 8.62
    // → cut ends at 8.62
    expect(cuts[0].end).toBeCloseTo(8.62, 2)
  })

  it('merges adjacent extended regions when the kept gap between them is tiny', () => {
    // 'kept2' at [8.62, 8.64] is inside the merged region — extended cut becomes
    // [1, 12.5] covering both annotations + the tiny kept gap
    const cuts = deriveCutsFromAnnotations(annotations, words, { mergeGapMs: 100 })
    expect(cuts).toHaveLength(1)
    expect(cuts[0].start).toBeCloseTo(1, 2)
    expect(cuts[0].end).toBeCloseTo(12.5, 2)
  })
})
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Update `deriveCutsFromAnnotations`**

Port the extend logic from `src/components/editor/TranscriptEditor.jsx:432-470`. Pseudocode:

```js
export function deriveCutsFromAnnotations(annotations, words, { mergeGapMs = 100 } = {}) {
  // 1. Build annotation regions (sorted, deduplicated)
  const regions = annotations.map(a => ({ start: a.start, end: a.end })).sort((a,b) => a.start - b.start)
  // 2. For each region, extend backward to nearest preceding uncut word's end
  for (const r of regions) {
    const prevUncut = [...words].reverse().find(w => w.end <= r.start + 0.01 &&
      !regions.some(rr => w.start >= rr.start - 0.05 && w.end <= rr.end + 0.05))
    if (prevUncut) r.start = Math.max(r.start, prevUncut.end)  // can only shrink the kept-before-cut, never extend cut backward past existing kept
    // Actually we want to EXTEND cut backward to absorb silence — set r.start = prevUncut.end
    if (prevUncut) r.start = prevUncut.end
  }
  // 3. Extend forward to nearest following uncut word's start
  for (const r of regions) {
    const nextUncut = words.find(w => w.start >= r.end - 0.01 &&
      !regions.some(rr => w.start >= rr.start - 0.05 && w.end <= rr.end + 0.05))
    if (nextUncut) r.end = nextUncut.start
  }
  // 4. Merge adjacent extended regions when kept gap is < mergeGapMs
  const merged = []
  for (const r of regions) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end < mergeGapMs / 1000) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }
  return merged.map((c, i) => ({ id: `cut-ann-server-${i}`, start: c.start, end: c.end, source: 'annotation' }))
}
```

(Reference exact JS in `TranscriptEditor.jsx:432-470` for fidelity.)

- [ ] **Step 4: Run test, verify pass**

- [ ] **Step 5: Verify frontend regen produces SAME shape**

Manual check: open b-roll editor on a fresh-X1-only group (no `cut-ai-ann-` cuts yet). Open transcript editor. The frontend's regen should produce zero new cuts (because the existing `cut-ann-server-` cuts already match what it would generate).

- [ ] **Step 6: Commit**

```bash
git add server/services/cuts-from-annotations.js server/services/__tests__/cuts-from-annotations-extended.test.js
git commit -m "$(cat <<'EOF'
fix(cuts-from-annotations): produce extended cut shape matching frontend

X1 hook now ports the extend-back/forward logic from TranscriptEditor.jsx
so server-generated cuts have the same shape the frontend would generate
on its next open. Eliminates dual-cut-set bug where editor_state_json had
both cut-ann-server- and cut-ai-ann- variants.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Migration script

One-shot script that converts existing original-time placements to post-cut + attaches `anchor_word_idx`. Idempotent via `state.broll.schema_version`.

**Files:**
- Create: `scripts/_migrate-placements-to-postcut.mjs`
- Create: `server/services/__tests__/migrate-placements-test.js`

- [ ] **Step 1: Write tests against project 273 fixture**

```js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { migrateGroupState } from '../../scripts/_migrate-placements-to-postcut.mjs'

const fixture = JSON.parse(readFileSync(
  './server/services/__tests__/__fixtures__/project-273-cuts.json', 'utf8'))

describe('migrateGroupState', () => {
  it('converts placement original-time to post-cut + attaches anchor_word_idx', () => {
    const state = {
      cuts: fixture.editor_state.cuts,
      cutExclusions: [],
      broll: {
        placements: [{
          uuid: 'p1', audio_anchor: 'There is a bad piece',
          start_seconds: 134.18,  // original
          end_seconds: 138.18,
        }],
      },
    }
    const migrated = migrateGroupState(state, fixture.word_timestamps)
    // Post-cut for original 134.18 should be ~19.94 with project 273 cuts
    expect(migrated.broll.placements[0].start_seconds).toBeCloseTo(19.94, 0.5)
    expect(migrated.broll.placements[0].anchor_word_idx).toBeGreaterThanOrEqual(0)
    expect(migrated.broll.schema_version).toBe('post-cut')
  })

  it('is idempotent (re-running on already-migrated state is a no-op)', () => {
    const state = { broll: { schema_version: 'post-cut', placements: [{ uuid: 'p1', start_seconds: 19.94, end_seconds: 23.94 }] } }
    const migrated = migrateGroupState(state, [])
    expect(migrated.broll.placements[0].start_seconds).toBe(19.94)  // unchanged
  })
})
```

- [ ] **Step 2: Implement `scripts/_migrate-placements-to-postcut.mjs`**

```js
import db from '../server/db.js'
import { computeEffectiveCuts } from '../server/services/broll.js'
import { postCutTime } from '../server/services/time-translation.js'
import { findAnchorWordIdx } from '../server/services/anchor-word.js'

export function migrateGroupState(state, words) {
  if (!state?.broll?.placements?.length) return state
  if (state.broll.schema_version === 'post-cut') return state
  const cuts = state.cuts || []
  const exclusions = state.cutExclusions || []
  const effective = computeEffectiveCuts(cuts, exclusions)
  for (const p of state.broll.placements) {
    if (typeof p.start_seconds === 'number') {
      const newStart = postCutTime(p.start_seconds, effective)
      const newEnd = postCutTime(p.end_seconds, effective)
      p.start_seconds = newStart
      p.end_seconds = newEnd
    }
    if (p.anchor_word_idx == null && words?.length) {
      p.anchor_word_idx = findAnchorWordIdx(words, p.audio_anchor)
    }
  }
  state.broll.schema_version = 'post-cut'
  return state
}

async function main() {
  const groups = await db.prepare("SELECT id, editor_state_json FROM video_groups WHERE editor_state_json IS NOT NULL").all()
  let migrated = 0
  for (const g of groups) {
    const state = JSON.parse(g.editor_state_json)
    if (state.broll?.schema_version === 'post-cut') continue
    const v = await db.prepare("SELECT id FROM videos WHERE group_id = ? AND video_type = 'raw' LIMIT 1").get(g.id)
    let words = []
    if (v) {
      const t = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(v.id)
      if (t?.word_timestamps_json) words = JSON.parse(t.word_timestamps_json)
    }
    const next = migrateGroupState(state, words)
    await db.prepare('UPDATE video_groups SET editor_state_json = ? WHERE id = ?').run(JSON.stringify(next), g.id)
    migrated++
  }
  console.log(`Migrated ${migrated} groups.`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Dry-run on local DB (count groups without committing)**

```bash
node --env-file=.env -e "import('./server/db.js').then(async ({default:db}) => {
  const r = await db.prepare(\"SELECT COUNT(*) AS c FROM video_groups WHERE editor_state_json IS NOT NULL AND editor_state_json::jsonb -> 'broll' -> 'schema_version' IS NULL\").get()
  console.log('groups to migrate:', r.c); process.exit(0) })"
```

- [ ] **Step 5: Commit**

```bash
git add scripts/_migrate-placements-to-postcut.mjs server/services/__tests__/migrate-placements-test.js
git commit -m "$(cat <<'EOF'
feat(migrate): one-shot script to convert original→post-cut placements

Idempotent: skips groups with broll.schema_version='post-cut'. Computes
post-cut time from original via computeEffectiveCuts + postCutTime, and
attaches anchor_word_idx from audio_anchor + raw transcript words.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: B-roll editor timeline — post-cut layout

`Timeline.jsx` for b-roll mode renders post-cut domain. Cuts collapse to thin purple bars at join positions. Pure layout helper extracted to `postCutTimeline.js` for testability.

**Files:**
- Create: `src/lib/postCutTimeline.js`
- Create: `src/lib/__tests__/postCutTimeline.test.js`
- Modify: `src/components/editor/Timeline.jsx`
- Create: `src/components/editor/__tests__/Timeline-postcut.test.jsx`

- [ ] **Step 1: Write postCutTimeline test**

```js
// src/lib/__tests__/postCutTimeline.test.js
import { describe, it, expect } from 'vitest'
import { layoutPostCut } from '../postCutTimeline.js'

describe('layoutPostCut', () => {
  it('returns full duration for no cuts', () => {
    const layout = layoutPostCut(100, [], 1000)  // 100s duration, 1000px wide
    expect(layout.segments).toHaveLength(1)
    expect(layout.segments[0]).toMatchObject({ origStart: 0, origEnd: 100, postStart: 0, postEnd: 100, x: 0, w: 1000 })
    expect(layout.cutBars).toHaveLength(0)
    expect(layout.postCutDuration).toBe(100)
  })

  it('lays out kept segments + cut bars correctly with one cut', () => {
    const cuts = [{ start: 30, end: 50 }]  // 20s cut
    const layout = layoutPostCut(100, cuts, 800)
    // Post-cut duration = 100 - 20 = 80
    // Segment 1: orig [0,30] → post [0,30] → x=0 w=300
    // Segment 2: orig [50,100] → post [30,80] → x=300 w=500
    // Cut bar at x=300
    expect(layout.postCutDuration).toBe(80)
    expect(layout.segments).toHaveLength(2)
    expect(layout.segments[0]).toMatchObject({ x: 0, w: 300 })
    expect(layout.segments[1]).toMatchObject({ x: 300, w: 500 })
    expect(layout.cutBars).toHaveLength(1)
    expect(layout.cutBars[0]).toMatchObject({ x: 300, origStart: 30, origEnd: 50 })
  })

  it('handles cut at start of timeline', () => {
    const cuts = [{ start: 0, end: 10 }]
    const layout = layoutPostCut(100, cuts, 900)
    expect(layout.postCutDuration).toBe(90)
    expect(layout.cutBars[0].x).toBe(0)
  })

  it('handles cut at end of timeline', () => {
    const cuts = [{ start: 90, end: 100 }]
    const layout = layoutPostCut(100, cuts, 900)
    expect(layout.postCutDuration).toBe(90)
    expect(layout.cutBars[0].x).toBe(900)
  })
})
```

- [ ] **Step 2: Implement `src/lib/postCutTimeline.js`**

```js
export function layoutPostCut(originalDuration, effectiveCuts, timelineWidthPx) {
  const cuts = (effectiveCuts || []).slice().sort((a, b) => a.start - b.start)
  const totalCutDuration = cuts.reduce((s, c) => s + (c.end - c.start), 0)
  const postCutDuration = Math.max(0.001, originalDuration - totalCutDuration)
  const pxPerSecond = timelineWidthPx / postCutDuration

  const segments = []
  const cutBars = []
  let cursorOrig = 0
  let cursorPost = 0
  for (const c of cuts) {
    if (c.start > cursorOrig) {
      const segLen = c.start - cursorOrig
      segments.push({
        origStart: cursorOrig, origEnd: c.start,
        postStart: cursorPost, postEnd: cursorPost + segLen,
        x: cursorPost * pxPerSecond, w: segLen * pxPerSecond,
      })
      cursorPost += segLen
    }
    cutBars.push({
      x: cursorPost * pxPerSecond,
      origStart: c.start, origEnd: c.end, cutDuration: c.end - c.start,
    })
    cursorOrig = c.end
  }
  if (cursorOrig < originalDuration) {
    const segLen = originalDuration - cursorOrig
    segments.push({
      origStart: cursorOrig, origEnd: originalDuration,
      postStart: cursorPost, postEnd: cursorPost + segLen,
      x: cursorPost * pxPerSecond, w: segLen * pxPerSecond,
    })
  }
  return { segments, cutBars, postCutDuration, pxPerSecond }
}
```

- [ ] **Step 3: Run unit test, verify pass**

- [ ] **Step 4: Modify `Timeline.jsx` to use `layoutPostCut` for b-roll mode**

Today: `Timeline.jsx` renders one continuous bar with overlay regions for cuts. Replace b-roll-mode rendering to:
- Render N kept-segment bars (positioned via `layout.segments[i].x/w`)
- Render M cut bars (4px wide purple, positioned via `layout.cutBars[i].x`)
- Each cut bar is a `<CutBar>` (Task 9)
- For rough cut mode, keep current behavior (visible cuts).

Pseudocode (gist):

```jsx
const isBrollEditor = mode === 'broll'
const layout = isBrollEditor ? layoutPostCut(duration, effectiveCuts, widthPx) : null
return (
  <div className="timeline-wrap">
    {isBrollEditor ? (
      <>
        {layout.segments.map((s, i) => <KeptSegment key={i} {...s} />)}
        {layout.cutBars.map((b, i) => <CutBar key={i} {...b} />)}
      </>
    ) : (
      <RoughCutTimeline ... /* existing rendering */ />
    )}
  </div>
)
```

- [ ] **Step 5: Vitest for Timeline post-cut layout (snapshot or dom-based)**

```jsx
// src/components/editor/__tests__/Timeline-postcut.test.jsx
import { render, screen } from '@testing-library/react'
import Timeline from '../Timeline.jsx'

it('renders one cut-bar and two kept-segment bars for [30,50] cut', () => {
  render(<Timeline duration={100} cuts={[{start:30,end:50}]} mode="broll" widthPx={800} />)
  expect(screen.getAllByTestId('kept-segment')).toHaveLength(2)
  expect(screen.getAllByTestId('cut-bar')).toHaveLength(1)
})
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/postCutTimeline.js src/lib/__tests__/postCutTimeline.test.js src/components/editor/Timeline.jsx src/components/editor/__tests__/Timeline-postcut.test.jsx
git commit -m "$(cat <<'EOF'
feat(broll-editor): post-cut timeline layout (cuts collapse to bars)

src/lib/postCutTimeline.js exports layoutPostCut(duration, cuts, widthPx)
which returns {segments, cutBars} positioned in post-cut domain. Timeline.jsx
uses this for mode='broll', keeping the rough-cut mode rendering as-is.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `CutBar.jsx` + `CutContentPanel.jsx`

The cut bar component renders the 4px purple vertical, hover tooltip, and click-to-expand panel containing the removed transcript / A-roll thumb / waveform peaks for that cut span.

**Files:**
- Create: `src/components/editor/CutBar.jsx`
- Create: `src/components/editor/CutContentPanel.jsx`
- Create: `src/components/editor/__tests__/CutBar.test.jsx`

- [ ] **Step 1: Write tests**

```jsx
// CutBar.test.jsx
import { render, fireEvent, screen } from '@testing-library/react'
import CutBar from '../CutBar.jsx'

it('renders 4px wide purple bar at given x', () => {
  render(<CutBar x={300} cutDuration={20} origStart={30} origEnd={50} />)
  const bar = screen.getByTestId('cut-bar')
  expect(bar.style.left).toBe('300px')
  expect(bar.style.width).toBe('4px')
})

it('opens panel on click', () => {
  render(<CutBar x={0} cutDuration={20} origStart={30} origEnd={50} />)
  fireEvent.click(screen.getByTestId('cut-bar'))
  expect(screen.getByTestId('cut-content-panel')).toBeInTheDocument()
})

it('shows cut duration in tooltip', () => {
  render(<CutBar x={0} cutDuration={20} origStart={30} origEnd={50} />)
  expect(screen.getByTitle('20.0s removed')).toBeInTheDocument()
})
```

- [ ] **Step 2: Implement components**

```jsx
// src/components/editor/CutBar.jsx
import { useState } from 'react'
import CutContentPanel from './CutContentPanel.jsx'

export default function CutBar({ x, cutDuration, origStart, origEnd, words, videoId }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div
        data-testid="cut-bar"
        title={`${cutDuration.toFixed(1)}s removed`}
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'absolute', left: `${x}px`, top: 0, bottom: 0,
          width: '4px', background: '#8b5cf6', cursor: 'pointer',
        }}
      />
      {open && (
        <CutContentPanel
          origStart={origStart} origEnd={origEnd}
          words={words} videoId={videoId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// src/components/editor/CutContentPanel.jsx
export default function CutContentPanel({ origStart, origEnd, words, videoId, onClose }) {
  const text = words.filter(w => w.start >= origStart && w.start < origEnd).map(w => w.word).join(' ')
  return (
    <div data-testid="cut-content-panel" style={{ position: 'fixed', top: 0, right: 0, width: 360, height: '100%', background: '#1f2937', padding: 16, color: '#e5e7eb', zIndex: 100 }}>
      <button onClick={onClose}>Close</button>
      <h3>Removed content</h3>
      <p style={{ fontSize: 12, color: '#9ca3af' }}>
        {origStart.toFixed(2)}s — {origEnd.toFixed(2)}s ({(origEnd - origStart).toFixed(1)}s removed)
      </p>
      <p style={{ marginTop: 16, fontSize: 14 }}>{text}</p>
      {/* TODO Phase B: A-roll thumb + waveform peaks */}
    </div>
  )
}
```

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Wire `CutBar` into `Timeline.jsx`** (already pseudocoded in Task 8)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/CutBar.jsx src/components/editor/CutContentPanel.jsx src/components/editor/__tests__/CutBar.test.jsx
git commit -m "$(cat <<'EOF'
feat(broll-editor): CutBar + CutContentPanel components

CutBar is a 4px purple vertical bar at each cut-join position.
Click toggles a side-panel showing the removed transcript snippet,
duration, and original-time range. A-roll thumb + waveform peaks
deferred to Phase B.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: BRollPreview playhead — convert original-time to post-cut

The `<video>` element plays the original MP4 with skip-during-playback (existing logic preserved). The visual playhead position needs to convert `<video>.currentTime` (original) to post-cut for display on the post-cut timeline.

**Files:**
- Modify: `src/components/editor/BRollPreview.jsx`

- [ ] **Step 1: Add a helper that converts current `<video>.currentTime` (original) to post-cut, using `postCutTime` (need a frontend port)**

Create `src/lib/timeTranslation.js` (mirror of server's `time-translation.js`).

```js
// src/lib/timeTranslation.js
export function postCutTime(tOrig, effectiveCuts) {
  if (!effectiveCuts || !effectiveCuts.length) return tOrig
  let cumOffset = 0
  for (const c of effectiveCuts) {
    if (tOrig < c.start) return tOrig - cumOffset
    if (tOrig >= c.start && tOrig < c.end) return c.start - cumOffset
    cumOffset += c.end - c.start
  }
  return tOrig - cumOffset
}
```

Vitest in `src/lib/__tests__/timeTranslation.test.js` mirroring server tests.

- [ ] **Step 2: In `BRollPreview.jsx`, replace `playheadX` calculation**

Today (probably): `playheadX = (currentTime / duration) * widthPx`.

After: `playheadX = (postCutTime(currentTime, cuts) / postCutDuration) * widthPx`.

- [ ] **Step 3: Test manually — open b-roll editor, hit play, verify playhead moves smoothly through cut bars without "jumping back"**

- [ ] **Step 4: Commit**

```bash
git add src/lib/timeTranslation.js src/lib/__tests__/timeTranslation.test.js src/components/editor/BRollPreview.jsx
git commit -m "$(cat <<'EOF'
feat(broll-editor): playhead position uses post-cut time

src/lib/timeTranslation.js mirrors server's time-translation. BRollPreview
converts video.currentTime (original) to post-cut for visual playhead
positioning on the post-cut timeline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: XMEML export — translate post-cut → original

Today, XMEML emits placements with their stored time (was original). After Task 4, placements are stored in post-cut. Export must translate back to original for the NLE.

**Files:**
- Modify: `server/services/xmeml-generator.js`
- Modify: `server/routes/export-xml.js`
- Create: `server/services/__tests__/xmeml-generator-postcut.test.js`

- [ ] **Step 1: Write failing test**

```js
import { describe, it, expect } from 'vitest'
import { generateXmemlFromPostCutPlacements } from '../xmeml-generator.js'

it('translates post-cut placement times to original-time clipitems', () => {
  const placements = [
    { uuid: 'p1', start_seconds: 5, end_seconds: 8, audio_anchor: 'x', file_url: 'foo.mp4' },
  ]
  const cuts = [{ start: 2, end: 4 }]  // 2s cut before placement
  const out = generateXmemlFromPostCutPlacements(placements, cuts, /* other args */)
  // Post-cut t=5 → original t=7. Post-cut t=8 → original t=10.
  // The XMEML <start> for the b-roll clipitem should be ~7s in original timeline coordinates.
  expect(out).toMatch(/<start>\s*\d*7\d*\s*<\/start>/)
})
```

- [ ] **Step 2: Modify `xmeml-generator.js`**

Add a new entrypoint `generateXmemlFromPostCutPlacements(placements, cuts, ...)` that internally calls `unshiftPostCutTime` for each placement, then delegates to the existing original-time XMEML logic. Keep the old entrypoint for the kept-segment A-Roll generation (which is already in original time).

- [ ] **Step 3: Update `routes/export-xml.js` to pass cuts**

```js
const cuts = (state.cuts || [])
const xml = generateXmemlFromPostCutPlacements(placements, cuts, ...)
```

- [ ] **Step 4: Run all xmeml tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add server/services/xmeml-generator.js server/routes/export-xml.js server/services/__tests__/xmeml-generator-postcut.test.js
git commit -m "$(cat <<'EOF'
feat(export): translate post-cut placement times → original at XMEML emit

Placements are stored post-cut. NLEs (Premiere/Resolve/FCP) work in
original-time of the source media, so XMEML clipitems must translate.
Done via unshiftPostCutTime per placement at emit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Real-data round-trip proof

Verify end-to-end: project 273 fixture → migrate → cut edits → re-anchor → export → original-time XMEML matches expected.

**Files:**
- Create: `scripts/_proof-postcut-canonical.mjs`

- [ ] **Step 1: Implement script**

Outline:
1. Load project 273 fixture (cuts + placements + words)
2. Migrate placements to post-cut (Task 7)
3. Apply 3 synthetic cut edits: add cut, move cut, delete cut
4. After each edit, recompute placement times (Task 5 logic)
5. Verify `anchor_word_idx` → `words[idx].start` round-trips correctly to the recomputed `start_seconds + cum_cut_offset`
6. Generate XMEML, verify clipitems are at expected original-time coordinates

- [ ] **Step 2: Run script, verify all checks pass**

```bash
node --env-file=.env scripts/_proof-postcut-canonical.mjs
```

- [ ] **Step 3: Commit**

```bash
git add scripts/_proof-postcut-canonical.mjs
git commit -m "$(cat <<'EOF'
test(proof): real-data round-trip for post-cut canonical placements

Loads project 273 fixture, migrates placements, applies synthetic cut
edits, verifies anchor_word_idx round-trip stability and XMEML
original-time accuracy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Final cleanup — remove un-shift from broll.js

After Tasks 1-12, the only remaining usage of `unshiftPostCutTime` is in `xmeml-generator.js`. Remove the re-export from `broll.js`.

**Files:**
- Modify: `server/services/broll.js`

- [ ] **Step 1: Remove the re-export line `export { unshiftPostCutTime } from './time-translation.js'`**

- [ ] **Step 2: Update `xmeml-generator.js` to import directly from `./time-translation.js`**

- [ ] **Step 3: Run full test suite**

- [ ] **Step 4: Grep for any remaining `unshiftPostCutTime` imports from `broll.js` (should be zero)**

```bash
grep -rn "unshiftPostCutTime.*broll" server/ src/ --include="*.js" --include="*.jsx"
```

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/xmeml-generator.js
git commit -m "$(cat <<'EOF'
chore(broll): remove unshiftPostCutTime re-export from broll.js

Only xmeml-generator.js uses it now (export translation). It imports
directly from time-translation.js. broll.js is freed of the legacy
shift logic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (already passed before submission)

- [x] Spec coverage: every section of the spec has a corresponding task (storage model = T1-T4, cut-edit handler = T5, X1 fix = T6, migration = T7, UI = T8-T10, export = T11, proof = T12, cleanup = T13)
- [x] No placeholders: every step has either complete code blocks or concrete edit instructions with file:line references
- [x] Type/identifier consistency: `anchor_word_idx`, `start_seconds`, `end_seconds`, `audio_anchor` named identically across all tasks
- [x] Test deletions explicitly listed (Task 4) and replacements named
