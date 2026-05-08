# B-Roll LLM Stages — Original-Time Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all B-roll LLM stages (Gemini video analysis, strategy creation, per-chapter plan) operate in the **original video time domain** — cut text removed from transcripts but kept words preserve their original timecodes; Gemini analyzes the **raw** video with explicit "ignore these cut ranges" guidance; placements come back in original time and get shifted to post-cut at the persistence boundary so editor storage stays canonical.

**Architecture:** Three behavioral changes:
1. `generatePostCutTranscript` stops shifting timecodes — only filters cut words.
2. Stage 2 (`export_post_cut_video`) is removed — Gemini analyzes the raw video. Stage 3 prompt receives a `{{cut_ranges}}` block listing time ranges to ignore.
3. `persistPlacementOutput` shifts placement timestamps `original → post-cut` before save (using `computeEffectiveCuts` + a cumulative-offset helper). Storage format is unchanged from today's "post-cut canonical" layout, so the editor (`useBRollEditorState`, post-cut placements) needs no changes.

**Tech Stack:** Node.js + Express server, Vitest tests, Postgres via `db.prepare`, Gemini video LLM. All work in `server/services/broll.js` (~7000-line pipeline file) and `server/seed/create-broll-plan-strategy.js`.

---

## File Structure

**Modified files:**
- `server/services/broll.js` — `generatePostCutTranscript`, `persistPlacementOutput`, all 5 `replacePlaceholders` closures, removal of `export_post_cut_video` action branch
- `server/seed/create-broll-plan-strategy.js` — drop Stage 2 entry, update Stage 3 prompt
- `server/services/__tests__/persist-placement-output-postcut.test.js` — invert post-cut assertion to expect shift

**New files:**
- `server/services/__tests__/post-cut-transcript-original-time.test.js` — coverage for the no-shift transcript
- `server/services/__tests__/cut-time-helpers.test.js` — coverage for the new pure helpers

**Helpers added in `broll.js` (exported)**:
- `getCumulativeCutOffset(time, effectiveCuts)` — pulled out of `generatePostCutTranscript`'s inline `getOffset`
- `shiftOriginalToPostCut(time, effectiveCuts)` — `time - getCumulativeCutOffset(time, effectiveCuts)`
- `formatCutRangesForPrompt(effectiveCuts)` — produces the human-readable cut block for `{{cut_ranges}}`

---

## Task 1: Extract cumulative-offset helper from `generatePostCutTranscript`

**Files:**
- Modify: `server/services/broll.js:1014-1092` (extract inline `getOffset` to top-level export)
- Test: `server/services/__tests__/cut-time-helpers.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `server/services/__tests__/cut-time-helpers.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { getCumulativeCutOffset, shiftOriginalToPostCut } from '../broll.js'

describe('getCumulativeCutOffset', () => {
  it('returns 0 when no cuts precede time', () => {
    const cuts = [{ start: 100, end: 110 }]
    expect(getCumulativeCutOffset(50, cuts)).toBe(0)
  })

  it('returns total duration of cuts ending before time', () => {
    const cuts = [{ start: 10, end: 15 }, { start: 30, end: 35 }]
    expect(getCumulativeCutOffset(50, cuts)).toBe(10)
  })

  it('excludes cuts whose end equals time (half-open at end)', () => {
    const cuts = [{ start: 10, end: 15 }]
    expect(getCumulativeCutOffset(15, cuts)).toBe(0)
  })

  it('handles empty cuts array', () => {
    expect(getCumulativeCutOffset(50, [])).toBe(0)
  })
})

describe('shiftOriginalToPostCut', () => {
  it('subtracts cumulative offset from original time', () => {
    const cuts = [{ start: 10, end: 15 }, { start: 30, end: 35 }]
    expect(shiftOriginalToPostCut(50, cuts)).toBe(40)
  })

  it('returns original time when no preceding cuts', () => {
    expect(shiftOriginalToPostCut(5, [{ start: 10, end: 15 }])).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/__tests__/cut-time-helpers.test.js`
Expected: FAIL — `getCumulativeCutOffset is not defined` (and `shiftOriginalToPostCut`).

- [ ] **Step 3: Add helpers to `broll.js`**

In `server/services/broll.js`, immediately above `export async function generatePostCutTranscript` (currently at line 1014), add:

```js
/**
 * Cumulative duration of effective cuts ending at or before `time`.
 * Pure function — `effectiveCuts` must already be sorted by start
 * (use `computeEffectiveCuts` to produce the input).
 */
export function getCumulativeCutOffset(time, effectiveCuts) {
  if (!effectiveCuts || !effectiveCuts.length) return 0
  let offset = 0
  for (const c of effectiveCuts) {
    if (c.end <= time) offset += (c.end - c.start)
    else break
  }
  return offset
}

/**
 * Convert an original-video timestamp to the post-cut domain by subtracting
 * the cumulative duration of all cuts ending at or before it.
 */
export function shiftOriginalToPostCut(time, effectiveCuts) {
  return time - getCumulativeCutOffset(time, effectiveCuts)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/__tests__/cut-time-helpers.test.js`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/__tests__/cut-time-helpers.test.js
git commit -m "feat(broll): export cumulative-cut-offset + shift-original-to-post-cut helpers"
```

---

## Task 2: Add `formatCutRangesForPrompt` helper

**Files:**
- Modify: `server/services/broll.js` (next to the helpers added in Task 1)
- Test: `server/services/__tests__/cut-time-helpers.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `server/services/__tests__/cut-time-helpers.test.js`:

```js
import { formatCutRangesForPrompt } from '../broll.js'

describe('formatCutRangesForPrompt', () => {
  it('returns empty string when there are no cuts', () => {
    expect(formatCutRangesForPrompt([])).toBe('')
  })

  it('formats each cut as a [HH:MM:SS] - [HH:MM:SS] line', () => {
    const out = formatCutRangesForPrompt([{ start: 0, end: 122 }, { start: 255, end: 278 }])
    expect(out).toContain('[00:00:00] - [00:02:02]')
    expect(out).toContain('[00:04:15] - [00:04:38]')
  })

  it('rounds sub-second start/end to nearest second for the prompt', () => {
    const out = formatCutRangesForPrompt([{ start: 122.49, end: 124.51 }])
    expect(out).toContain('[00:02:02] - [00:02:05]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/__tests__/cut-time-helpers.test.js`
Expected: FAIL — `formatCutRangesForPrompt is not defined`.

- [ ] **Step 3: Add helper in `broll.js`**

Append (after `shiftOriginalToPostCut` from Task 1):

```js
/**
 * Format effective cut ranges as a human-readable block for LLM prompts.
 * Returns '' when there are no cuts, otherwise newline-separated lines like
 *   [00:00:00] - [00:02:02]
 * Sub-second values are rounded to the nearest whole second so the LLM gets a
 * clean, easy-to-match block.
 */
export function formatCutRangesForPrompt(effectiveCuts) {
  if (!effectiveCuts || !effectiveCuts.length) return ''
  const tc = (s) => {
    const r = Math.round(s)
    const h = String(Math.floor(r / 3600)).padStart(2, '0')
    const m = String(Math.floor((r % 3600) / 60)).padStart(2, '0')
    const sec = String(r % 60).padStart(2, '0')
    return `[${h}:${m}:${sec}]`
  }
  return effectiveCuts.map(c => `${tc(c.start)} - ${tc(c.end)}`).join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/__tests__/cut-time-helpers.test.js`
Expected: PASS — 9 tests passing total.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/__tests__/cut-time-helpers.test.js
git commit -m "feat(broll): add formatCutRangesForPrompt helper for {{cut_ranges}} block"
```

---

## Task 3: Make `generatePostCutTranscript` preserve original timecodes

**Files:**
- Modify: `server/services/broll.js:1014-1092`
- Test: `server/services/__tests__/post-cut-transcript-original-time.test.js` (new)

The current implementation filters cut words AND shifts kept words via `getOffset`. New behavior: filter only — kept words keep their original `start` / `end` and the rendered transcript shows original timecodes.

- [ ] **Step 1: Write the failing test**

Create `server/services/__tests__/post-cut-transcript-original-time.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrepare } = vi.hoisted(() => ({
  mockPrepare: vi.fn(() => ({ get: vi.fn().mockResolvedValue(null) })),
}))
vi.mock('../../db.js', () => ({ default: { prepare: (...a) => mockPrepare(...a) } }))

import { generatePostCutTranscript } from '../broll.js'

const fakeWords = [
  // Cut region: 10–15
  { word: 'Before',  start: 5,  end: 6 },
  { word: 'cut.',    start: 6,  end: 7 },
  { word: 'Inside',  start: 11, end: 12 },  // midpoint 11.5 → cut
  { word: 'cut.',    start: 12, end: 13 },  // midpoint 12.5 → cut
  { word: "Let's",   start: 122.0, end: 122.3 },
  { word: 'clear',   start: 122.3, end: 122.6 },
  { word: 'this.',   start: 122.6, end: 122.9 },
]

beforeEach(() => {
  mockPrepare.mockReset()
  mockPrepare.mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({ word_timestamps_json: JSON.stringify(fakeWords) }),
  }))
})

describe('generatePostCutTranscript (original-time)', () => {
  it('removes words whose midpoint falls inside a cut', async () => {
    const out = await generatePostCutTranscript(123, [{ start: 10, end: 15 }], [])
    expect(out).not.toContain('Inside')
  })

  it('preserves original timecodes on kept words', async () => {
    const out = await generatePostCutTranscript(123, [{ start: 10, end: 15 }], [])
    // First sentence is "Before cut." with start=5
    expect(out).toContain('[00:00:05] Before cut.')
    // "Let's clear this." starts at 122.0 — original time, NOT shifted
    expect(out).toContain("[00:02:02] Let's clear this.")
  })

  it('renders gap markers using original-time differences (cuts are visible as gaps)', async () => {
    const out = await generatePostCutTranscript(123, [{ start: 10, end: 15 }], [])
    // Between "Before cut." (ends 7) and "Let's clear this." (starts 122) there is
    // a 115s gap in original time (cuts are part of that gap).
    expect(out).toContain('[115s]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/__tests__/post-cut-transcript-original-time.test.js`
Expected: FAIL — current impl shifts so the second sentence renders at `[00:00:02]` (5s offset), not `[00:02:02]`.

- [ ] **Step 3: Replace the function body to skip the shift**

In `server/services/broll.js`, replace the entire body of `generatePostCutTranscript` (currently lines 1014–1092) with:

```js
export async function generatePostCutTranscript(videoId, cuts, cutExclusions = []) {
  const t = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(videoId)
  if (!t?.word_timestamps_json) throw new Error(`No word timestamps for video ${videoId}`)
  const words = JSON.parse(t.word_timestamps_json)

  const effectiveCuts = computeEffectiveCuts(cuts, cutExclusions)

  // Filter out words whose midpoint falls inside any cut. Kept words keep
  // their ORIGINAL start/end timestamps — no shifting. The cut text vanishes
  // from the transcript but timecodes remain in the original-video domain.
  const keptWords = words.filter(w => {
    const mid = (w.start + w.end) / 2
    return !effectiveCuts.some(c => mid >= c.start && mid < c.end)
  })

  const toTC = (s) => {
    const h = String(Math.floor(s / 3600)).padStart(2, '0')
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
    const sec = String(Math.floor(s % 60)).padStart(2, '0')
    const cs = Math.round((s % 1) * 100)
    const base = `${h}:${m}:${sec}`
    return cs > 0 ? `[${base}.${String(cs).padStart(2, '0')}]` : `[${base}]`
  }

  const lines = []
  let currentLine = []
  let lineStartTime = null
  let prevLineEnd = null

  for (let i = 0; i < keptWords.length; i++) {
    const w = keptWords[i]
    if (lineStartTime === null) lineStartTime = w.start
    currentLine.push(w.word)

    const endsWithPunctuation = /[.!?]$/.test(w.word.trim())
    const isLastWord = i === keptWords.length - 1

    if (endsWithPunctuation || isLastWord) {
      if (prevLineEnd !== null) {
        const gap = Math.round(lineStartTime - prevLineEnd)
        if (gap > 1) lines.push(`[${gap}s]`)
      }
      const tc = toTC(lineStartTime)
      const text = currentLine.join(' ').replace(/\s+([.,!?;:])/g, '$1')
      lines.push(`${tc} ${text.trim()}`)
      prevLineEnd = keptWords[i].end
      currentLine = []
      lineStartTime = null
    }
  }

  return lines.join('\n\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/__tests__/post-cut-transcript-original-time.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/__tests__/post-cut-transcript-original-time.test.js
git commit -m "feat(broll): generatePostCutTranscript preserves original timecodes"
```

---

## Task 4: Update existing post-cut-canonical persist test to expect a shift

**Files:**
- Modify: `server/services/__tests__/persist-placement-output-postcut.test.js`

The existing test asserts placements pass through unchanged ("LLM emits in post-cut domain"). New invariant: LLM emits in **original** time, `persistPlacementOutput` shifts to post-cut. Rewrite the test to encode the new invariant. (The actual implementation change is Task 5 — this task locks the spec.)

- [ ] **Step 1: Replace the test file body**

Replace the entire contents of `server/services/__tests__/persist-placement-output-postcut.test.js` with:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrepare } = vi.hoisted(() => ({
  mockPrepare: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    get: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue([]),
  })),
}))
vi.mock('../../db.js', () => ({ default: { prepare: (...a) => mockPrepare(...a) } }))

import { persistPlacementOutput } from '../broll.js'

const fakeWords = [
  { word: 'There', start: 19.94, end: 20.10 },
  { word: 'is',    start: 20.10, end: 20.18 },
  { word: 'a',     start: 20.18, end: 20.21 },
  { word: 'bad',   start: 20.21, end: 20.50 },
  { word: 'piece', start: 20.50, end: 20.78 },
]

beforeEach(() => {
  mockPrepare.mockReset()
  mockPrepare.mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({ word_timestamps_json: JSON.stringify(fakeWords) }),
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    all: vi.fn().mockResolvedValue([]),
  }))
})

// LLM now emits ORIGINAL-time placements; persist shifts to the post-cut
// domain so storage stays canonical for the editor.
describe('persistPlacementOutput (original→post-cut shift)', () => {
  // Cut [10,15] removes 5s. So original 19.94 → post-cut 14.94.
  const editorCuts = { cuts: [{ start: 10, end: 15 }], cutExclusions: [] }

  it('shifts placement start/end by the cumulative cut offset', async () => {
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:19.94]', end: '[00:00:23.94]',
        start_seconds: 19.94, end_seconds: 23.94,
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

  it('still attaches anchor_word_idx (anchor lookup unaffected by shift)', async () => {
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:19.94]', end: '[00:00:23.94]',
        start_seconds: 19.94, end_seconds: 23.94,
        audio_anchor: 'There is a bad piece',
      }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    expect(JSON.parse(out).placements[0].anchor_word_idx).toBe(0)
  })

  it('passes times through unchanged when there are no cuts', async () => {
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:19.94]', end: '[00:00:23.94]',
        start_seconds: 19.94, end_seconds: 23.94,
        audio_anchor: 'There is a bad piece',
      }],
    })
    const out = await persistPlacementOutput(stageOutput, { cuts: [], cutExclusions: [] }, 449)
    const p = JSON.parse(out).placements[0]
    expect(p.start_seconds).toBeCloseTo(19.94, 2)
    expect(p.end_seconds).toBeCloseTo(23.94, 2)
    expect(p.start).toBe('[00:00:19.94]')
  })

  it('handles {chapters: [{placements:[…]}]} shape', async () => {
    const stageOutput = JSON.stringify({
      chapters: [{
        chapter_number: 1,
        placements: [{
          start: '[00:00:19.94]', end: '[00:00:23.94]',
          start_seconds: 19.94, end_seconds: 23.94,
          audio_anchor: 'There is a bad piece',
        }],
      }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const p = JSON.parse(out).chapters[0].placements[0]
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.anchor_word_idx).toBe(0)
  })

  it('handles top-level array of placements', async () => {
    const stageOutput = JSON.stringify([{
      start: '[00:00:19.94]', end: '[00:00:23.94]',
      start_seconds: 19.94, end_seconds: 23.94,
      audio_anchor: 'There is a bad piece',
    }])
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const p = JSON.parse(out)[0]
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.anchor_word_idx).toBe(0)
  })

  it('passes through unchanged when videoId omitted', async () => {
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:19.94]', end: '[00:00:23.94]',
        start_seconds: 19.94, end_seconds: 23.94,
        audio_anchor: 'There is a bad piece',
      }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    expect(out).toBe(stageOutput)
  })
})
```

- [ ] **Step 2: Run test — confirm it fails on the shift assertions**

Run: `npx vitest run server/services/__tests__/persist-placement-output-postcut.test.js`
Expected: FAIL — the first/third/fourth/fifth tests fail because the current implementation does not shift.

- [ ] **Step 3: Commit the spec change**

```bash
git add server/services/__tests__/persist-placement-output-postcut.test.js
git commit -m "test(broll): expect persistPlacementOutput to shift original→post-cut"
```

---

## Task 5: Implement the shift inside `persistPlacementOutput`

**Files:**
- Modify: `server/services/broll.js:1155-1194`

- [ ] **Step 1: Replace the function body**

Replace the entire current `persistPlacementOutput` function (lines 1155–1194) with:

```js
/**
 * Persists LLM placement output. Two responsibilities:
 *
 *   1. Attach `anchor_word_idx` to each placement (audio_anchor → raw word index)
 *      for stable identity across cut edits.
 *   2. Shift placement timestamps from the LLM's ORIGINAL-time domain into the
 *      post-cut canonical storage format used by the editor.
 *
 * Handles three shapes:
 *   - Top-level array: [{ start, end, audio_anchor, ... }, ...]
 *   - Wrapped in chapters: { chapters: [{ placements: [...] }, ...] }
 *   - Per-chapter sub-run: { placements: [{ start, end, audio_anchor }] }
 *
 * @param {string} stageOutput - LLM output (possibly markdown-fenced JSON)
 * @param {{cuts:Array, cutExclusions:Array}|null} editorCuts - cuts used to
 *        shift original→post-cut. When null/empty, no shift is applied.
 * @param {number|null} videoId - main video ID for word_timestamps lookup; if
 *        null/undefined, returns stageOutput unchanged.
 * @returns {Promise<string>} stage output with anchor_word_idx + post-cut times
 */
export async function persistPlacementOutput(stageOutput, editorCuts, videoId) {
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
    return stageOutput
  }
  if (!words.length) return stageOutput

  const effectiveCuts = computeEffectiveCuts(editorCuts?.cuts || [], editorCuts?.cutExclusions || [])

  const tc = (s) => {
    if (s == null || Number.isNaN(s)) return null
    const h = String(Math.floor(s / 3600)).padStart(2, '0')
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
    const sec = String(Math.floor(s % 60)).padStart(2, '0')
    const cs = Math.round((s % 1) * 100)
    const base = `${h}:${m}:${sec}`
    return cs > 0 ? `[${base}.${String(cs).padStart(2, '0')}]` : `[${base}]`
  }

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

  const annotate = (placements) => placements.map(shiftPlacement)

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

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run server/services/__tests__/persist-placement-output-postcut.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 3: Commit**

```bash
git add server/services/broll.js
git commit -m "feat(broll): persistPlacementOutput shifts original→post-cut at boundary"
```

---

## Task 6: Wire `{{cut_ranges}}` into all `replacePlaceholders` sites

**Files:**
- Modify: `server/services/broll.js` — add `{{cut_ranges}}` substitution in each of the 5 closures at lines 1483, 2858, 3290, 3839, 4292

There are five `replacePlaceholders` closures (one per pipeline branch — `runAltPlanPipeline`, `runHookPlanPipeline`, etc.). Each needs the same one-line addition. The `effectiveCuts` value comes from `editorCuts` which is already in scope at all five sites.

- [ ] **Step 1: Locate all five sites**

Run: `grep -n "function replacePlaceholders" server/services/broll.js`

Expected output: five lines, around 1483, 2858, 3290, 3839, 4292.

- [ ] **Step 2: At each site, compute `cutRangesText` once before the closure and inject the substitution**

For **each** of the five closures, do two edits:

**(a)** Just BEFORE `function replacePlaceholders(text) {`, add this line (use the `editorCuts` variable already in scope at each site):

```js
const cutRangesText = formatCutRangesForPrompt(computeEffectiveCuts(editorCuts?.cuts || [], editorCuts?.cutExclusions || []))
```

**(b)** Inside the closure, immediately after the existing `.replace(/\{\{transcript\}\}/g, currentTranscript)` call, add:

```js
        .replace(/\{\{cut_ranges\}\}/g, cutRangesText)
```

So a closure like the one at line 1483 becomes:

```js
const cutRangesText = formatCutRangesForPrompt(computeEffectiveCuts(editorCuts?.cuts || [], editorCuts?.cutExclusions || []))

function replacePlaceholders(text) {
  let result = text
    .replace(/\{\{transcript\}\}/g, currentTranscript)
    .replace(/\{\{cut_ranges\}\}/g, cutRangesText)
    .replace(/\{\{llm_answer\}\}/g, llmAnswer)
    // …
```

Repeat for each of the five sites. (If a site doesn't have `editorCuts` in scope, fall through to `''` — see Step 3.)

- [ ] **Step 3: Verify `editorCuts` is in scope at every site**

Run: `grep -n "editorCuts" server/services/broll.js | head -40`

For each of the five `replacePlaceholders` lines, confirm there's an `editorCuts` reference earlier in the same function. If a site doesn't have it (e.g., a sub-pipeline that wasn't passed cuts), use:

```js
const cutRangesText = '' // editorCuts not in scope at this site
```

…and add a TODO comment line `// TODO: thread editorCuts through this branch when cut-aware prompts are needed`. Do not silently skip — explicit empty string keeps the placeholder defined.

- [ ] **Step 4: Run vitest to confirm no regressions**

Run: `npx vitest run server/services/__tests__/`
Expected: PASS — pre-existing test count unchanged plus the new tests added in Tasks 1–5.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js
git commit -m "feat(broll): wire {{cut_ranges}} placeholder into all replacePlaceholders closures"
```

---

## Task 7: Remove the `export_post_cut_video` action handler

**Files:**
- Modify: `server/services/broll.js:5297-5340` (the `else if (action === 'export_post_cut_video')` branch)
- Modify: `server/services/broll.js:4020` (`VIDEO_ONLY_PROGRAMMATIC_ACTIONS`)

Stage 2 is being dropped (Task 8 removes it from the seed). The handler in the executor still needs deletion so a stale strategy_version_json containing `export_post_cut_video` would short-circuit cleanly (the executor will see no matching action and skip — preserving idempotency on resumed pipelines). We also remove the `mainVideoFilePath = postCutPath` reassignment so Stage 3 always sees the original video file.

- [ ] **Step 1: Delete the action branch**

In `server/services/broll.js`, find the block starting at:

```js
        } else if (action === 'export_post_cut_video') {
```

…and ending at the matching closing `}` (currently line 5340 — the line that does `mainVideoFilePath = postCutPath`). Delete the entire `else if` branch including its body.

The neighbour above (`generate_post_cut_transcript`) and below (`assemble_broll_plan`) should now be adjacent:

```js
        } else if (action === 'generate_post_cut_transcript') {
          // ...existing body...
        } else if (action === 'assemble_broll_plan') {
          // ...existing body...
        }
```

- [ ] **Step 2: Remove `export_post_cut_video` from `VIDEO_ONLY_PROGRAMMATIC_ACTIONS`**

Find line 4020:

```js
const VIDEO_ONLY_PROGRAMMATIC_ACTIONS = new Set(['export_post_cut_video'])
```

Replace with:

```js
const VIDEO_ONLY_PROGRAMMATIC_ACTIONS = new Set()
```

(Leaving the `Set` empty rather than deleting the constant preserves the audio-defense filter logic that references it.)

- [ ] **Step 3: Verify nothing else references `export_post_cut_video`**

Run: `grep -n "export_post_cut_video" server/services/broll.js`
Expected: zero matches.

Run: `grep -rn "export_post_cut_video" server/ --include='*.js' | grep -v node_modules | grep -v __tests__/broll-audio-stage-filter`
Expected: zero matches outside the audio-stage-filter test (we'll inspect that test in Step 4).

- [ ] **Step 4: Update the audio-stage-filter test if needed**

Run: `grep -n "export_post_cut_video" server/services/__tests__/broll-audio-stage-filter.test.js`

If the test uses `export_post_cut_video` as a fixture for "video-only programmatic stage", change the fixture to use a non-existent action like `'video_only_unused_action_for_test'` so the test still exercises the filter. Otherwise leave the test unchanged.

- [ ] **Step 5: Run vitest**

Run: `npx vitest run server/services/__tests__/`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add server/services/broll.js server/services/__tests__/broll-audio-stage-filter.test.js
git commit -m "refactor(broll): drop export_post_cut_video action — stage 3 now uses raw video"
```

---

## Task 8: Update the plan strategy seed

**Files:**
- Modify: `server/seed/create-broll-plan-strategy.js`

Drop Stage 2 from the `stages` array. Update Stage 3's prompt and description to reference the raw video and inject `{{cut_ranges}}`.

- [ ] **Step 1: Delete Stage 2 from the seed**

In `server/seed/create-broll-plan-strategy.js`, find the entry beginning at line 40 (the `// ── Stage 2: Export post-cut video (programmatic) ──` block, lines 40–48). Delete the entire object including its preceding comment line. After deletion the array goes directly from Stage 1 (`generate_post_cut_transcript`) to what was Stage 3 (`Analyze A-Roll + Chapters & Beats`), now Stage 2.

- [ ] **Step 2: Renumber comments in the file**

In the same file, update the comments on each remaining stage so the numbering is sequential (`Stage 2`, `Stage 3`, `Stage 4`, `Stage 5`, `Stage 6` → was 3, 4, 5, 6, 7). For example:

```js
  // ── Stage 2: Analyze A-Roll + Chapters & Beats of post-cut video ──
```

becomes:

```js
  // ── Stage 2: Analyze A-Roll + Chapters & Beats ──
```

Repeat for the remaining four comment lines.

- [ ] **Step 3: Update the Analyze stage's `description` field**

Find the line in the (now Stage 2) Analyze entry:

```js
    description: 'Remove cut words and recalculate timecodes to match the post-rough-cut video',
```

…wait — that's the description on Stage 1 (`generate_post_cut_transcript`). Update **Stage 1's** description instead:

```js
    description: 'Remove cut words from the transcript while preserving original timecodes',
```

- [ ] **Step 4: Update the Analyze stage's prompt (was Stage 3, now Stage 2)**

Find the prompt string that begins:

```js
    prompt: `Watch this post-cut video and identify:
```

Replace the opening section of that template literal — from `Watch this post-cut video and identify:` through `## Post-cut transcript for context:` and the `{{transcript}}` line — with:

```
Watch this video and identify:
1. Every A-Roll scene (when location, framing, or setup changes — each gets its own entry)
2. All chapters (major phases of the video)
3. All beats within each chapter (moments where something changes)

## Definitions:
- Chapter: A bigger section made of multiple beats — a "phase" of the video (setup, conflict, resolution, conclusion).
- Beat: A single moment where something changes (a decision, a setback, a discovery, a reaction).
- A-Roll: When the camera setup, location, or framing changes significantly, it is a new A-Roll.

## Cut ranges to IGNORE
The following time ranges have been removed in the rough cut. Do NOT analyze
them, do NOT include chapters, beats, or A-Roll scenes within them, and do NOT
emit timestamps that fall inside them. Treat them as if they are not in the video:
{{cut_ranges}}

## Transcript (cut text already removed; timecodes are in the original video):
{{transcript}}
```

Leave the rest of the prompt (the JSON example output, the IMPORTANT note about timestamps) unchanged.

- [ ] **Step 5: Verify no other prompts in the file say "post-cut video"**

Run: `grep -n "post-cut video\|post-cut transcript" server/seed/create-broll-plan-strategy.js`

For each remaining match, decide:
- Mentions of "post-cut transcript" in stages that consume `{{transcript}}` → change to "transcript" (the transcript no longer shifts time).
- Any prompt outputs that need the LLM to emit original-time timestamps → no wording change is required because the transcript timecodes are already original.

- [ ] **Step 6: Stage 4 — `Create B-Roll strategy` — append `{{cut_ranges}}` reference**

In the Stage 4 prompt (`name: 'Create B-Roll strategy'`), find:

```
## New video transcript:
{{transcript}}
```

Replace with:

```
## Cut ranges removed from the new video (do not place anything inside these):
{{cut_ranges}}

## New video transcript (cut text removed; timecodes are original):
{{transcript}}
```

- [ ] **Step 7: Stage 6 — `Per-chapter B-Roll plan` — wire `{{cut_ranges}}`**

In the Stage 6 prompt (`name: 'Per-chapter B-Roll plan'`), find:

```
## ── CHAPTER TRANSCRIPT (use these timecodes for placements) ──
{{chapter_transcript}}
```

Insert directly above it:

```
## ── CUT RANGES (NEVER place anything inside these — they were removed in the rough cut) ──
{{cut_ranges}}

```

- [ ] **Step 8: Commit the seed changes**

```bash
git add server/seed/create-broll-plan-strategy.js
git commit -m "feat(seed): drop export_post_cut_video stage; pass raw video + {{cut_ranges}} to Gemini"
```

---

## Task 9: Re-run the seed against the local DB

**Files:** none (operational step).

Seeds are idempotent — they update existing strategy_versions with new `stages_json` and bump version notes.

- [ ] **Step 1: Run the seed**

Run: `node server/seed/create-broll-plan-strategy.js`
Expected output: a "Updated" or "Inserted" line for the `'plan'` strategy. No exceptions.

- [ ] **Step 2: Spot-check the resulting stages_json in the DB**

Run:

```bash
node -e "
import('./server/db.js').then(async ({ default: db }) => {
  const v = await db.prepare(\`
    SELECT sv.stages_json
    FROM broll_strategies s
    JOIN broll_strategy_versions sv ON sv.strategy_id = s.id
    WHERE s.strategy_kind = 'plan'
    ORDER BY sv.version_number DESC LIMIT 1
  \`).get()
  const stages = JSON.parse(v.stages_json)
  console.log('stage count:', stages.length)
  console.log('actions:', stages.map(s => s.action || s.type))
})
"
```

Expected:
- `stage count: 6` (was 7 — Stage 2 dropped)
- `actions:` includes `'generate_post_cut_transcript'` but NOT `'export_post_cut_video'`

- [ ] **Step 3: Commit nothing (no code changed) — but write a note in the next commit**

Roll the seed-application note into the commit at the end of Task 10.

---

## Task 10: Full vitest sweep + manual smoke

**Files:** none for code (operational step).

- [ ] **Step 1: Run the full vitest suite**

Run: `npx vitest run`
Expected: all tests pass. The total count should be the previous baseline plus the new tests from Tasks 1, 2, 3 (and the test file body change in Task 4).

- [ ] **Step 2: If any pre-existing test fails, triage it**

The most likely failure modes:
- A test that mocked `export_post_cut_video` outputs → update mock to skip that stage.
- A test that asserted post-cut transcript shows shifted timecodes → update to assert original timecodes (we own the spec change).
- A test that used `editorCuts` fixtures and verified placement timecodes were unchanged → update to reflect the new shift.

For each failure, change the test to encode the new spec. Do NOT change implementation to satisfy old tests — the old tests encoded the old "post-cut canonical at LLM boundary" invariant which this work intentionally inverts.

- [ ] **Step 3: Manual smoke (running locally)**

(Skip if pipelines can't be exercised locally.)

1. Re-trigger the b-roll chain on a small group with cuts (admin tools or `runFullAutoBrollChain` directly).
2. Watch logs for `[broll-pipeline] No editor cuts — skipping post-cut video export` — should NOT appear (action is gone).
3. Confirm Gemini's Stage 2 (Analyze) output: chapter `start_seconds` should align with the original-video timecodes for the kept content.
4. Open `/admin/broll?id=8` and `?id=9` — confirm Stage 1 transcript output has cut text removed but kept words at original timecodes.

- [ ] **Step 4: Final commit summarizing the rollout**

```bash
git add -A
git commit -m "chore(broll): re-run plan strategy seed; verify vitest green after time-domain switch"
```

---

## Self-Review Notes

Spec coverage:
- "Drop Stage 2" → Tasks 7 + 8.
- "Show 'Let's clear this' at original 02:02" → Task 3 (no shift in transcript).
- "Don't show skipped words" → Task 3 (filter unchanged).
- "Tell Gemini ranges to ignore" → Tasks 2 + 6 + 8 (`formatCutRangesForPrompt` + `{{cut_ranges}}` placeholder + Stage 2 prompt update).
- "Storage stays canonical (post-cut)" → Tasks 4 + 5 (`persistPlacementOutput` shifts original→post-cut).
- "Single time domain for LLM, no editor changes" → covered by the persistence shift; editor reads the same post-cut placements as before.

No placeholders / type consistency:
- All function names match across tasks: `getCumulativeCutOffset`, `shiftOriginalToPostCut`, `formatCutRangesForPrompt`, `persistPlacementOutput`, `generatePostCutTranscript`, `computeEffectiveCuts`.
- Task 5 references `findAnchorWordIdx` which already exists in `broll.js` (`grep -n "function findAnchorWordIdx" server/services/broll.js` — line ~6680 in current tree).
- Task 6 explicitly handles the case where `editorCuts` is not in scope at a site (fall through to `''`) so no implicit reference rot.
- All seed changes preserve the existing JSON output schemas (the LLMs still emit `start_seconds` / `end_seconds` / `start_tc` / `end_tc`); only the time domain semantics changed.
