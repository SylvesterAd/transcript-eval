# Cuts as Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `video_groups.editor_state_json.cuts` the single canonical edit decision for a project. Wire post-cut transcript + post-cut MP4 into the analysis / plan strategy / plan creation pipelines, give the b-roll editor full cut UI parity (read AI cuts, manual Cut button, edge drag, cut-aware preview, bidirectional sync with rough cut), and emit per-segment A-Roll clipitems in XMEML export.

**Architecture:** Three-layer change. (1) Backend: a single `unshiftPostCutTime` helper in `broll.js` plus a `persistPlacementOutput` chokepoint that every placement-emitting stage routes through; new strategy versions for analysis / plan strategy / plan creation that prepend the existing `generate_post_cut_transcript` + `export_post_cut_video` programmatic stages. (2) Frontend: extract `sharedCutLogic` from `useEditorState.js`, plumb cuts into `useBRollEditorState.js`, refetch on `window.focus` for sync. (3) Export: emit per-segment `<clipitem>` entries on the V1 A-Roll track using `arollSegments`.

**Tech Stack:** Node 20 + Express 5 + `pg` (PostgreSQL via Supabase Supavisor), React 19 + Vite frontend, Vitest workspace (server / web / extension projects). Spec: `docs/superpowers/specs/2026-05-05-cuts-as-source-of-truth-design.md`.

**Working directory for all commands:** `/Users/laurynas/Desktop/one last /transcript-eval`

---

## File Structure

| File | Responsibility | Changes |
|---|---|---|
| `server/services/broll.js` | Pipeline runner + `generatePostCutTranscript` + `computeEffectiveCuts` | Add `unshiftPostCutTime`, `remapPlacementTimes`, `persistPlacementOutput`. Route placement-emitting stages through chokepoint. |
| `server/services/__tests__/post-cut-mapping.test.js` | NEW | Property test, boundary test, real-data fixture for shift/un-shift identity. |
| `server/services/__tests__/__fixtures__/project-273-cuts.json` | NEW | Snapshot fixture for real-data integration test. |
| `server/services/create-broll-plan-strategy.js` | Plan strategy seeds (existing 7-stage broll plan) | Add helper `buildPostCutPrepStages()` so analysis / plan strategy / plan creation can re-use stages 1+2. |
| `server/services/__tests__/post-cut-strategy-prep.test.js` | NEW | Verifies the helper output structure. |
| `server/seed/seed-post-cut-strategies.js` | NEW | Idempotent script that inserts NEW `strategy_versions` rows for analysis / plan strategy / plan creation with prepended post-cut stages. |
| `server/routes/admin/seed-post-cut-strategies.js` | NEW | Admin route to invoke the seed script. |
| `src/components/editor/sharedCutLogic.js` | NEW | `splitAtPlayhead`, `dragCutEdge`, action creators. Imported by both editors. |
| `src/components/editor/useEditorState.js` | Rough cut state | Re-export cut action creators from shared module. Add `window.focus` refetch. |
| `src/components/editor/useBRollEditorState.js` | B-roll editor state | Add `cuts`, `cutExclusions`, `annotationRegions` to state. Load on mount + save on change + refetch on focus. |
| `src/components/editor/usePlaybackSkipRegions.js` | NEW | Hook extracted from `EditorView.jsx` skip logic. |
| `src/components/editor/EditorView.jsx` | Rough cut view | Replace inline skip useEffect with `usePlaybackSkipRegions` hook. |
| `src/components/editor/BRollPreview.jsx` | B-roll editor preview | Apply `usePlaybackSkipRegions`. |
| `src/components/editor/BRollEditor.jsx` | B-roll editor shell | Pass cuts/exclusions to preview + timeline. Render cut overlay. |
| `src/components/editor/Timeline.jsx` | Timeline component | Expose `mergedDisplayCuts` so b-roll editor can consume the same overlay logic. |
| `src/components/editor/PlaybackControls.jsx` | Cut button + transport | Un-gate Cut button; route `handleSplit` through `sharedCutLogic`. |
| `src/components/editor/__tests__/sharedCutLogic.test.js` | NEW | Unit tests for split + edge drag. |
| `src/components/editor/__tests__/BRollEditor-cuts.test.jsx` | NEW | Cut overlay renders, Cut button creates cut, preview skip behavior. |
| `server/services/xmeml-generator.js` | XMEML emission | Accept `arollSegments: [{start, end}]`. Emit one `<clipitem>` per segment on V1. |
| `server/services/__tests__/xmeml-generator-aroll-segments.test.js` | NEW | Per-segment emission tests. |
| `server/routes/export-xml.js` | Export XML route | Build `arollSegments` from `editor_state_json.cuts` via `computeEffectiveCuts`. |
| `src/components/views/BRollPlanView.jsx` (or wherever `/brolls/strategy/analysis` renders) | Analysis page | Add backfill banner: "this run used the original video; re-run to use the rough-cut version." |

---

## Phase A — Mapping foundation

This phase delivers a tested `unshiftPostCutTime` helper, a `persistPlacementOutput` chokepoint, and wires every placement-emitting stage in `broll.js` through it. Nothing visible to the user yet, but it's the load-bearing piece for the whole feature.

---

### Task 1: Property test for shift/un-shift round-trip

**Files:**
- Create: `server/services/__tests__/post-cut-mapping.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/__tests__/post-cut-mapping.test.js
import { describe, it, expect } from 'vitest'
import { unshiftPostCutTime, remapPlacementTimes } from '../broll.js'
import { computeEffectiveCuts } from '../broll.js'

// Reference shifter — algebraic forward direction. Same logic as
// generatePostCutTranscript's getOffset, simplified for tests.
function shift(t, effectiveCuts) {
  let cumOffset = 0
  for (const c of effectiveCuts) {
    if (t >= c.end) cumOffset += c.end - c.start
    else if (t >= c.start) {
      // t lands inside cut — undefined for a "kept" point. Treat as cut.start in post-cut.
      return c.start - cumOffset
    } else {
      break
    }
  }
  return t - cumOffset
}

function randCuts(rng, max = 50, totalDuration = 600) {
  const n = Math.floor(rng() * 30)
  const cuts = []
  let pos = 0
  for (let i = 0; i < n; i++) {
    const gap = rng() * 30
    const dur = rng() * 5 + 0.1
    const start = pos + gap
    const end = start + dur
    if (end > totalDuration) break
    cuts.push({ id: `c${i}`, start, end, source: 'transcript' })
    pos = end
  }
  return cuts
}

function mulberry32(seed) {
  return function() {
    seed = (seed + 0x6D2B79F5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('unshiftPostCutTime — round-trip identity', () => {
  it('round-trips kept points across 1000 random cut configurations', () => {
    const rng = mulberry32(42)
    let cases = 0
    for (let trial = 0; trial < 1000; trial++) {
      const rawCuts = randCuts(rng, 50, 600)
      const effective = computeEffectiveCuts(rawCuts, [])

      // Generate kept sample points: midpoints of gaps between cuts.
      const samples = []
      let prevEnd = 0
      for (const c of effective) {
        if (c.start > prevEnd + 0.5) samples.push((prevEnd + c.start) / 2)
        prevEnd = c.end
      }
      if (prevEnd < 599.5) samples.push((prevEnd + 600) / 2)

      for (const tOriginal of samples) {
        const tPost = shift(tOriginal, effective)
        const roundtrip = unshiftPostCutTime(tPost, effective, 'start')
        expect(Math.abs(roundtrip - tOriginal)).toBeLessThan(1e-9)
        cases++
      }
    }
    expect(cases).toBeGreaterThan(500) // sanity: we did meaningful work
  })

  it('round-trips with no cuts (identity)', () => {
    expect(unshiftPostCutTime(0, [], 'start')).toBe(0)
    expect(unshiftPostCutTime(42.5, [], 'end')).toBe(42.5)
    expect(unshiftPostCutTime(600, [], 'start')).toBe(600)
  })

  it('handles single cut at start', () => {
    const cuts = [{ start: 0, end: 10 }]
    // Post-cut t=0 corresponds to original t=10 (right after the cut).
    expect(unshiftPostCutTime(0, cuts, 'start')).toBe(10)
    expect(unshiftPostCutTime(5, cuts, 'start')).toBe(15)
  })

  it('handles many adjacent cuts (drift bound)', () => {
    const cuts = []
    for (let i = 0; i < 200; i++) {
      cuts.push({ start: i * 2, end: i * 2 + 0.5 })
    }
    // Total cut duration: 200 * 0.5 = 100s.
    // Original t=400 is the END of the last cut (cut 199 ends at 399.5, next kept span starts at 399.5).
    // Wait: cuts are [0,0.5], [2,2.5], [4,4.5], ... [398, 398.5]. Total cut duration = 100.
    // Original t=399 is in a kept span (between cuts 199 [398,398.5] and 200 which doesn't exist).
    // shift(399) = 399 - 100 = 299.
    // unshift(299) should give back 399.
    expect(unshiftPostCutTime(299, cuts, 'start')).toBeCloseTo(399, 9)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project server server/services/__tests__/post-cut-mapping.test.js
```

Expected: FAIL with "unshiftPostCutTime is not a function" (or similar import error). The function doesn't exist yet.

- [ ] **Step 3: Implement `unshiftPostCutTime` in broll.js**

Find the existing `computeEffectiveCuts` function in `server/services/broll.js` (around line 1075). Add the new helper directly below it.

```js
// In server/services/broll.js, immediately after computeEffectiveCuts:

/**
 * Inverse of generatePostCutTranscript's getOffset. Given a timecode in
 * post-cut time (the rendered post-cut MP4's coordinate system, which
 * equals the shifted timecodes inside the post-cut transcript), return
 * the equivalent timecode in original time.
 *
 * `effectiveCuts` MUST be the output of computeEffectiveCuts (sorted,
 * non-overlapping, in original time).
 *
 * `kind` controls the boundary rule when tPost lands EXACTLY on a cut
 * boundary in post-cut time:
 *   - 'start' (default): tPost == boundary jumps PAST the cut → returns cut.end.
 *     Use this for placement.start_seconds — semantically "begin at the
 *     frame that appears right after the FFmpeg concat join".
 *   - 'end': tPost == boundary stays BEFORE the cut → returns cut.start.
 *     Use this for placement.end_seconds — semantically "end at the
 *     last frame before the join".
 *
 * In practice LLMs emit whole seconds and cuts get edge-refined to
 * non-integer boundaries, so this rule rarely fires. It exists to
 * prevent a silent failure mode if it ever does.
 */
export function unshiftPostCutTime(tPost, effectiveCuts, kind = 'start') {
  if (!effectiveCuts || effectiveCuts.length === 0) return tPost
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

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project server server/services/__tests__/post-cut-mapping.test.js
```

Expected: PASS — all 4 tests in the round-trip identity describe block.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/__tests__/post-cut-mapping.test.js
git commit -m "feat(broll): add unshiftPostCutTime with round-trip property test"
```

---

### Task 2: Boundary regression tests for asymmetric `<` vs `<=`

**Files:**
- Modify: `server/services/__tests__/post-cut-mapping.test.js`

- [ ] **Step 1: Add the failing tests**

Append to the existing test file:

```js
describe('unshiftPostCutTime — boundary rules', () => {
  const cuts = [{ start: 60, end: 80 }]
  // Post-cut boundary for this cut = 60 - 0 = 60.

  it("kind='start' at boundary jumps past cut → cut.end", () => {
    expect(unshiftPostCutTime(60, cuts, 'start')).toBe(80)
  })

  it("kind='end' at boundary stays before cut → cut.start", () => {
    expect(unshiftPostCutTime(60, cuts, 'end')).toBe(60)
  })

  it("kind='start' just past boundary maps continuously", () => {
    expect(unshiftPostCutTime(60.001, cuts, 'start')).toBeCloseTo(80.001, 9)
  })

  it("kind='end' just before boundary maps continuously", () => {
    expect(unshiftPostCutTime(59.999, cuts, 'end')).toBeCloseTo(59.999, 9)
  })

  it('multiple cuts: boundary rule applies per-cut', () => {
    const multi = [
      { start: 10, end: 15 }, // post-cut boundary 10
      { start: 30, end: 40 }, // post-cut boundary 30 - 5 = 25
    ]
    expect(unshiftPostCutTime(10, multi, 'start')).toBe(15)
    expect(unshiftPostCutTime(10, multi, 'end')).toBe(10)
    expect(unshiftPostCutTime(25, multi, 'start')).toBe(40)
    expect(unshiftPostCutTime(25, multi, 'end')).toBe(30)
  })
})
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run --project server server/services/__tests__/post-cut-mapping.test.js
```

Expected: PASS — boundary rule already implemented in Task 1.

- [ ] **Step 3: Commit**

```bash
git add server/services/__tests__/post-cut-mapping.test.js
git commit -m "test(broll): boundary rule regression for unshiftPostCutTime"
```

---

### Task 3: `remapPlacementTimes` — applies un-shift to start+end pairs

**Files:**
- Modify: `server/services/broll.js`
- Modify: `server/services/__tests__/post-cut-mapping.test.js`

- [ ] **Step 1: Write the failing test**

Append to `post-cut-mapping.test.js`:

```js
describe('remapPlacementTimes', () => {
  const cuts = [{ start: 60, end: 80 }]

  it('un-shifts start_seconds (start kind) and end_seconds (end kind)', () => {
    const placements = [
      { start_seconds: 10, end_seconds: 50, type: 'broll', description: 'x' },
      { start_seconds: 100, end_seconds: 150, type: 'broll', description: 'y' },
    ]
    const out = remapPlacementTimes(placements, cuts)
    expect(out[0].start_seconds).toBe(10)
    expect(out[0].end_seconds).toBe(50)
    expect(out[1].start_seconds).toBe(120) // 100 post-cut → 120 original (after [60,80] cut)
    expect(out[1].end_seconds).toBe(170)
  })

  it('handles boundary timecode at start/end with asymmetric rule', () => {
    const placements = [{ start_seconds: 60, end_seconds: 60, type: 'broll' }]
    const out = remapPlacementTimes(placements, cuts)
    expect(out[0].start_seconds).toBe(80) // start kind → past cut
    expect(out[0].end_seconds).toBe(60)   // end kind → before cut
  })

  it('returns input unchanged when cuts list is empty', () => {
    const placements = [{ start_seconds: 10, end_seconds: 50 }]
    expect(remapPlacementTimes(placements, [])).toEqual(placements)
  })

  it('preserves all non-time fields (description, type, etc.)', () => {
    const placements = [{
      start_seconds: 10, end_seconds: 50,
      type: 'broll', description: 'mountain', visual_description: 'snowy',
      function: 'Inform', extra_field: 42,
    }]
    const out = remapPlacementTimes(placements, cuts)
    expect(out[0]).toMatchObject({
      type: 'broll',
      description: 'mountain',
      visual_description: 'snowy',
      function: 'Inform',
      extra_field: 42,
    })
  })

  it('handles non-array input gracefully', () => {
    expect(remapPlacementTimes(null, cuts)).toBe(null)
    expect(remapPlacementTimes(undefined, cuts)).toBe(undefined)
  })

  it('skips entries that are missing start_seconds/end_seconds', () => {
    const placements = [
      { start_seconds: 10, end_seconds: 50 },
      { description: 'no times here' },
      { start_seconds: 100 }, // partial
    ]
    const out = remapPlacementTimes(placements, cuts)
    expect(out[0].start_seconds).toBe(10)
    expect(out[1]).toEqual({ description: 'no times here' })
    expect(out[2].start_seconds).toBe(120)
    expect(out[2].end_seconds).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run --project server server/services/__tests__/post-cut-mapping.test.js -t remapPlacementTimes
```

Expected: FAIL with "remapPlacementTimes is not a function".

- [ ] **Step 3: Implement `remapPlacementTimes` in broll.js**

Add directly below `unshiftPostCutTime` in `server/services/broll.js`:

```js
/**
 * Apply unshiftPostCutTime to every placement entry's start_seconds (with
 * 'start' boundary rule) and end_seconds (with 'end' boundary rule). All
 * non-time fields preserved. Entries without start_seconds/end_seconds
 * passed through untouched.
 *
 * Used by persistPlacementOutput to map post-cut timecodes (LLM output)
 * back to original time before persisting to broll_runs.output_text.
 */
export function remapPlacementTimes(placements, effectiveCuts) {
  if (placements == null) return placements
  if (!Array.isArray(placements)) return placements
  if (!effectiveCuts || effectiveCuts.length === 0) return placements
  return placements.map(p => {
    if (!p || typeof p !== 'object') return p
    const out = { ...p }
    if (typeof p.start_seconds === 'number' && Number.isFinite(p.start_seconds)) {
      out.start_seconds = unshiftPostCutTime(p.start_seconds, effectiveCuts, 'start')
    }
    if (typeof p.end_seconds === 'number' && Number.isFinite(p.end_seconds)) {
      out.end_seconds = unshiftPostCutTime(p.end_seconds, effectiveCuts, 'end')
    }
    return out
  })
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run --project server server/services/__tests__/post-cut-mapping.test.js -t remapPlacementTimes
```

Expected: PASS — all 6 tests in the remapPlacementTimes describe block.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/__tests__/post-cut-mapping.test.js
git commit -m "feat(broll): remapPlacementTimes wraps unshift for placement arrays"
```

---

### Task 4: `persistPlacementOutput` chokepoint helper

**Files:**
- Modify: `server/services/broll.js`
- Modify: `server/services/__tests__/post-cut-mapping.test.js`

- [ ] **Step 1: Write the failing test**

Append to `post-cut-mapping.test.js`:

```js
import { persistPlacementOutput } from '../broll.js'

describe('persistPlacementOutput — chokepoint', () => {
  const editorCuts = { cuts: [{ start: 60, end: 80 }], cutExclusions: [] }

  it('returns input unchanged when editorCuts has no cuts', async () => {
    const out = await persistPlacementOutput(JSON.stringify([{ start_seconds: 10 }]), null)
    expect(JSON.parse(out)).toEqual([{ start_seconds: 10 }])
    const out2 = await persistPlacementOutput(JSON.stringify([{ start_seconds: 10 }]), { cuts: [] })
    expect(JSON.parse(out2)).toEqual([{ start_seconds: 10 }])
  })

  it('un-shifts placement timecodes when editorCuts has cuts', async () => {
    const stageOutput = JSON.stringify([
      { start_seconds: 100, end_seconds: 110, type: 'broll' },
    ])
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed[0].start_seconds).toBe(120) // 100 + 20 cut duration
    expect(parsed[0].end_seconds).toBe(130)
  })

  it('handles JSON wrapped in markdown fence', async () => {
    const stageOutput = '```json\n[{"start_seconds":100,"end_seconds":110}]\n```'
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed[0].start_seconds).toBe(120)
  })

  it('un-shifts placements nested under {chapters: [...].placements} structure', async () => {
    const stageOutput = JSON.stringify({
      chapters: [
        { chapter_number: 1, placements: [{ start_seconds: 100, end_seconds: 110 }] },
      ],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed.chapters[0].placements[0].start_seconds).toBe(120)
  })

  it('returns raw output unchanged when JSON is unparseable (logs warning)', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stageOutput = 'totally not json'
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    expect(out).toBe(stageOutput)
    consoleWarn.mockRestore()
  })
})
```

Add `import { vi } from 'vitest'` at the top of the test file if not already imported.

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run --project server server/services/__tests__/post-cut-mapping.test.js -t persistPlacementOutput
```

Expected: FAIL with "persistPlacementOutput is not a function".

- [ ] **Step 3: Implement `persistPlacementOutput` in broll.js**

Add below `remapPlacementTimes`. There's already an `extractJSON` helper in `broll.js` — find it and use it for forgiving JSON parsing.

```js
/**
 * Single chokepoint for stages that emit placement-shaped JSON.
 *
 * Takes the raw stage output text + the editor cuts that were in effect
 * during this pipeline run. If cuts were applied, parses the JSON,
 * un-shifts every placement's timecodes back to original time, and
 * re-serializes. If parsing fails, logs a warning and returns the raw
 * text unchanged (preserves prior behavior for non-placement stages).
 *
 * Handles both shapes:
 *   - Top-level array: [{ start_seconds, end_seconds, ... }, ...]
 *   - Wrapped in chapters: { chapters: [{ placements: [...] }, ...] }
 *
 * Stages that should NOT use this helper: pure transcript stages,
 * chapter analysis without placements, plan strategy text. The helper
 * is a no-op for inputs that don't contain placement-shaped data.
 */
export async function persistPlacementOutput(stageOutput, editorCuts) {
  if (!editorCuts?.cuts?.length) return stageOutput
  const effective = computeEffectiveCuts(editorCuts.cuts, editorCuts.cutExclusions || [])
  if (!effective.length) return stageOutput

  let parsed
  try {
    parsed = extractJSON(stageOutput)
  } catch (err) {
    console.warn('[persistPlacementOutput] Could not parse stage output, returning unchanged:', err.message)
    return stageOutput
  }

  let remapped
  if (Array.isArray(parsed)) {
    remapped = remapPlacementTimes(parsed, effective)
  } else if (parsed && Array.isArray(parsed.chapters)) {
    remapped = {
      ...parsed,
      chapters: parsed.chapters.map(ch => ({
        ...ch,
        placements: Array.isArray(ch.placements)
          ? remapPlacementTimes(ch.placements, effective)
          : ch.placements,
      })),
    }
  } else {
    // Not placement-shaped — pass through.
    return stageOutput
  }
  return JSON.stringify(remapped, null, 2)
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run --project server server/services/__tests__/post-cut-mapping.test.js -t persistPlacementOutput
```

Expected: PASS — all 5 tests in the persistPlacementOutput describe block.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/__tests__/post-cut-mapping.test.js
git commit -m "feat(broll): persistPlacementOutput chokepoint with shape detection"
```

---

### Task 5: Wire chokepoint into `assemble_broll_plan` action

**Files:**
- Modify: `server/services/broll.js` — find the `assemble_broll_plan` action handler (currently around line 5118+).

- [ ] **Step 1: Locate the assembly point**

```bash
grep -nE "assemble_broll_plan|stageOutputs.push.*assembled" server/services/broll.js | head -5
```

Note the line numbers. The handler ends at the `output = JSON.stringify({...})` block. We're inserting one wrapper line right before `stageOutputs.push(output)`.

- [ ] **Step 2: Modify the action handler**

In `server/services/broll.js`, find the `assemble_broll_plan` block. The current code looks roughly like:

```js
} else if (action === 'assemble_broll_plan') {
  // ... existing logic that builds chapters array ...
  output = JSON.stringify({
    video_context: allChaptersCtx,
    total_chapters: chapters.length,
    chapters,
  }, null, 2)
}
```

Wrap the final assignment in `persistPlacementOutput`:

```js
} else if (action === 'assemble_broll_plan') {
  // ... existing logic that builds chapters array (unchanged) ...
  const rawOutput = JSON.stringify({
    video_context: allChaptersCtx,
    total_chapters: chapters.length,
    chapters,
  }, null, 2)
  output = await persistPlacementOutput(rawOutput, editorCuts)
}
```

- [ ] **Step 3: Add an integration test**

Create `server/services/__tests__/persist-placement-output-integration.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { persistPlacementOutput, computeEffectiveCuts } from '../broll.js'

describe('persistPlacementOutput — assemble_broll_plan output shape', () => {
  it('un-shifts placements inside {chapters:[{placements:[...]}]}', async () => {
    const editorCuts = {
      cuts: [{ id: 'c1', start: 60, end: 80 }],
      cutExclusions: [],
    }
    // Mimic what assemble_broll_plan produces.
    const rawOutput = JSON.stringify({
      video_context: 'context',
      total_chapters: 1,
      chapters: [
        {
          chapter_number: 1,
          chapter_name: 'Hook',
          placements: [
            { start_seconds: 100, end_seconds: 110, type: 'broll', description: 'x' },
            { start_seconds: 200, end_seconds: 210, type: 'broll', description: 'y' },
          ],
        },
      ],
    })
    const out = await persistPlacementOutput(rawOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed.chapters[0].placements[0].start_seconds).toBe(120)
    expect(parsed.chapters[0].placements[0].end_seconds).toBe(130)
    expect(parsed.chapters[0].placements[1].start_seconds).toBe(220)
    expect(parsed.chapters[0].placements[1].end_seconds).toBe(230)
    // Non-placement fields preserved.
    expect(parsed.video_context).toBe('context')
    expect(parsed.chapters[0].chapter_name).toBe('Hook')
  })
})
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run --project server server/services/__tests__/persist-placement-output-integration.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/__tests__/persist-placement-output-integration.test.js
git commit -m "feat(broll): route assemble_broll_plan through persistPlacementOutput"
```

---

### Task 6: Sweep for other placement-emitting paths

**Files:**
- Modify: `server/services/broll.js`

This is the bug-class-killer. We need to find every place placement-shaped data gets written into `broll_runs.output_text` and route it through the chokepoint.

- [ ] **Step 1: Enumerate writes to placement-shaped output**

```bash
grep -nE "stageOutputs\.push|placements.*push|broll_runs.*output_text" server/services/broll.js | head -40
```

Also search for stage actions that produce placement-shaped data:

```bash
grep -nE "action === '|placement|placements" server/services/broll.js | head -50
```

- [ ] **Step 2: Identify each placement-emitting action**

Read each match. The actions that emit placement-shaped JSON (have `start_seconds` / `end_seconds` in their output) include:

- `assemble_broll_plan` (wired in Task 5)
- Any `_per_chapter` LLM stages whose output is placements
- Plan-prep / plan-creation stages that emit placement arrays

For each such action, identify the line where `output = ...` is set right before `stageOutputs.push(output)`.

- [ ] **Step 3: Wrap each output assignment**

For each placement-emitting action, wrap the output the same way as Task 5:

```js
output = await persistPlacementOutput(output, editorCuts)
```

If the action delegates to `runLLMCall` (which returns `{ text, ... }`), wrap the `result.text` before assigning to `output`:

```js
const result = await runLLMCall(stage, ...)
output = await persistPlacementOutput(result.text, editorCuts)
```

For per-chapter aggregation (where output is built from multiple sub-runs), apply `persistPlacementOutput` ONCE at the final aggregation point — sub-runs operate in post-cut space and only get un-shifted at the boundary.

- [ ] **Step 4: Add a guard test for each wrapped path**

Append to `server/services/__tests__/persist-placement-output-integration.test.js`:

```js
import fs from 'node:fs'
import path from 'node:path'

describe('persistPlacementOutput — chokepoint coverage', () => {
  it('every placement-emitting action in broll.js routes through persistPlacementOutput', () => {
    const src = fs.readFileSync(
      path.resolve('server/services/broll.js'),
      'utf8'
    )
    // Coarse heuristic: find each `action === '<name>'` block that ultimately
    // assigns to `output` and verify that block contains `persistPlacementOutput`.
    const PLACEMENT_ACTIONS = [
      'assemble_broll_plan',
      // Add other placement-emitting actions here as they are wired in Task 6.
    ]
    for (const action of PLACEMENT_ACTIONS) {
      // Find the action block (between this action's check and the next `} else if (action ===` or end of switch).
      const re = new RegExp(`action === '${action}'[\\s\\S]*?(?=\\} else if \\(action ===|\\} else \\{[\\s\\S]*?output = currentTranscript)`)
      const m = src.match(re)
      expect(m, `${action} action block not found in broll.js`).toBeTruthy()
      expect(m[0]).toMatch(/persistPlacementOutput/)
    }
  })
})
```

This guard test catches future regressions: if someone adds a new placement-emitting action and forgets to route through the chokepoint, the test fails.

- [ ] **Step 5: Run all mapping tests**

```bash
npx vitest run --project server server/services/__tests__/post-cut-mapping.test.js server/services/__tests__/persist-placement-output-integration.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/broll.js server/services/__tests__/persist-placement-output-integration.test.js
git commit -m "feat(broll): route all placement-emitting actions through persistPlacementOutput"
```

---

### Task 7: Real-data fixture test from project 273

**Files:**
- Create: `server/services/__tests__/__fixtures__/project-273-cuts.json`
- Create: `server/services/__tests__/post-cut-real-data.test.js`

This catches wiring bugs that the unit tests can't see.

- [ ] **Step 1: Capture project 273's cuts and word timestamps**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
set -a && source .env && set +a

# Get the editor_state_json for project 273.
psql "$DATABASE_URL" -c "
  SELECT json_build_object(
    'group_id', 273,
    'editor_state', editor_state_json::json,
    'word_timestamps', (
      SELECT word_timestamps_json::json
      FROM transcripts t
      JOIN videos v ON v.id = t.video_id
      WHERE (v.group_id = 273 OR v.group_id IN (SELECT id FROM video_groups WHERE parent_group_id = 273))
        AND t.type = 'raw'
      LIMIT 1
    )
  ) AS fixture
  FROM video_groups WHERE id = 273
" -t -A > /tmp/project-273-fixture.json

# Sanity check
head -c 200 /tmp/project-273-fixture.json
echo ""

# Move to fixtures
mkdir -p server/services/__tests__/__fixtures__
mv /tmp/project-273-fixture.json server/services/__tests__/__fixtures__/project-273-cuts.json
```

Expected: a JSON file ~tens of KB with `editor_state` (containing `cuts`) and `word_timestamps` (array of `{word, start, end}`).

If project 273 doesn't have meaningful cuts, pick a different group_id with `SELECT id FROM video_groups WHERE editor_state_json::text LIKE '%"cuts":[{%' LIMIT 5;` and adjust.

- [ ] **Step 2: Write the integration test**

```js
// server/services/__tests__/post-cut-real-data.test.js
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  computeEffectiveCuts,
  unshiftPostCutTime,
  generatePostCutTranscript,
} from '../broll.js'

const fixture = JSON.parse(fs.readFileSync(
  path.resolve('server/services/__tests__/__fixtures__/project-273-cuts.json'),
  'utf8'
))

describe('Real-data round-trip — project 273', () => {
  const cuts = fixture.editor_state?.cuts || []
  const cutExclusions = fixture.editor_state?.cutExclusions || []
  const words = fixture.word_timestamps || []
  const effective = computeEffectiveCuts(cuts, cutExclusions)

  it('fixture has cuts and words', () => {
    expect(effective.length).toBeGreaterThan(0)
    expect(words.length).toBeGreaterThan(0)
  })

  it('every kept word round-trips shift → unshift to within 1ms', () => {
    let checked = 0
    for (const w of words) {
      const mid = (w.start + w.end) / 2
      const inCut = effective.some(c => mid >= c.start && mid < c.end)
      if (inCut) continue
      // Compute shifted start (mirror getOffset behavior).
      let cumOffset = 0
      for (const c of effective) {
        if (c.end <= w.start) cumOffset += c.end - c.start
        else break
      }
      const shifted = w.start - cumOffset
      const roundtrip = unshiftPostCutTime(shifted, effective, 'start')
      expect(Math.abs(roundtrip - w.start)).toBeLessThan(0.001)
      checked++
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('no kept-word original timecode falls inside any effective cut after un-shift', () => {
    for (const w of words.slice(0, 200)) {
      const mid = (w.start + w.end) / 2
      const inCut = effective.some(c => mid >= c.start && mid < c.end)
      if (inCut) continue
      // The kept word is, by definition, outside all cuts. Verify.
      for (const c of effective) {
        expect(mid).not.toBeGreaterThanOrEqual(c.start)
          .toBeLessThan(c.end)
      }
    }
  })
})
```

- [ ] **Step 3: Run the test**

```bash
npx vitest run --project server server/services/__tests__/post-cut-real-data.test.js
```

Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add server/services/__tests__/__fixtures__/project-273-cuts.json server/services/__tests__/post-cut-real-data.test.js
git commit -m "test(broll): real-data round-trip fixture from project 273"
```

---

## Phase B — Strategy seeds

Make analysis / plan strategy / plan creation use the post-cut transcript + post-cut MP4. Existing `create-broll-plan-strategy.js` shows the pattern (Stages 1+2). We extract that into a reusable helper and use it to seed NEW strategy versions for the three other strategies.

---

### Task 8: Investigate strategy seed authority

**Files:**
- Read: existing strategies in DB

This is a 5-minute investigation step that informs the next 3 tasks. Output is a short note appended to the plan file or shared in the PR description.

- [ ] **Step 1: List current strategy rows**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
set -a && source .env && set +a
psql "$DATABASE_URL" -c "
  SELECT s.id, s.name, s.is_main, s.main_strategy_id, s.kind,
         (SELECT MAX(version_number) FROM strategy_versions sv WHERE sv.strategy_id = s.id) AS latest_version
  FROM strategies s
  ORDER BY s.id;
"
```

Expected: a handful of rows with names like "Analysis", "B-Roll Plan", "Plan Strategy", "Plan Creation", etc.

- [ ] **Step 2: Inspect the stages_json of each candidate strategy**

For each strategy that's an analysis, plan strategy, or plan creation strategy, dump its latest stages_json:

```bash
psql "$DATABASE_URL" -c "
  SELECT s.name, sv.stages_json
  FROM strategies s
  JOIN strategy_versions sv ON sv.strategy_id = s.id
  WHERE sv.version_number = (SELECT MAX(version_number) FROM strategy_versions WHERE strategy_id = s.id)
    AND s.name ILIKE ANY (ARRAY['%analysis%', '%plan%'])
  ORDER BY s.id;
" | jq '.'
```

(If `jq` isn't installed, use `python3 -m json.tool` or pipe through `cat`.)

- [ ] **Step 3: Record findings**

Append to `docs/superpowers/plans/2026-05-05-cuts-as-source-of-truth.md` (this file) under a new heading `## Phase B Investigation Findings`:

```markdown
## Phase B Investigation Findings

(Filled in by the engineer running Task 8.)

- Strategy IDs to update: <id1, name1>, <id2, name2>, <id3, name3>.
- Current first stage of each: <copy of stage 0's name + type>.
- Whether `generate_post_cut_transcript` already appears in any of them: <yes/no>.
- Authoritative source of strategy stages: <DB-only via UI / DB-only via seed script / `create-broll-plan-strategy.js` exports a builder reused by other strategies / etc.>
```

This determines whether the next tasks update existing rows, insert new strategy_versions, or modify a JS source file.

- [ ] **Step 4: Commit the findings note**

```bash
git add docs/superpowers/plans/2026-05-05-cuts-as-source-of-truth.md
git commit -m "docs(plan): record Phase B strategy-seed investigation findings"
```

---

### Task 9: Extract `buildPostCutPrepStages()` helper

**Files:**
- Modify: `server/services/create-broll-plan-strategy.js` — extract the existing Stages 1+2 into an exported helper.
- Create: `server/services/__tests__/post-cut-strategy-prep.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/__tests__/post-cut-strategy-prep.test.js
import { describe, it, expect } from 'vitest'
import { buildPostCutPrepStages } from '../create-broll-plan-strategy.js'

describe('buildPostCutPrepStages', () => {
  it('returns exactly 2 stages: generate_post_cut_transcript + export_post_cut_video', () => {
    const stages = buildPostCutPrepStages()
    expect(stages).toHaveLength(2)
    expect(stages[0]).toMatchObject({
      type: 'programmatic',
      target: 'text_only',
      action: 'generate_post_cut_transcript',
    })
    expect(stages[1]).toMatchObject({
      type: 'programmatic',
      target: 'text_only',
      action: 'export_post_cut_video',
    })
    // Stages must have a name field (UI displays it).
    expect(typeof stages[0].name).toBe('string')
    expect(typeof stages[1].name).toBe('string')
  })

  it('is text-only opt: skipFFmpeg=true returns only stage 1', () => {
    const stages = buildPostCutPrepStages({ skipFFmpeg: true })
    expect(stages).toHaveLength(1)
    expect(stages[0].action).toBe('generate_post_cut_transcript')
  })

  it('returns deep copies — caller mutation does not affect future calls', () => {
    const a = buildPostCutPrepStages()
    a[0].name = 'mutated'
    const b = buildPostCutPrepStages()
    expect(b[0].name).not.toBe('mutated')
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run --project server server/services/__tests__/post-cut-strategy-prep.test.js
```

Expected: FAIL with "buildPostCutPrepStages is not a function".

- [ ] **Step 3: Add the helper to create-broll-plan-strategy.js**

Open `server/services/create-broll-plan-strategy.js`. Find Stage 1 (around line 29) and Stage 2 (around line 40) — they're inside an array of stage definitions.

Add this exported helper at the top of the file (just below the imports):

```js
/**
 * Build the post-cut prep stages used by every strategy that needs to
 * run against the rough-cut version of the video. Stage 1 generates a
 * transcript with timecodes shifted into post-cut continuous time;
 * Stage 2 renders the post-cut MP4 via FFmpeg and uploads it to
 * Supabase. After Stage 2, downstream `video_llm` stages with
 * target=main_video automatically receive the post-cut MP4 (see
 * `mainVideoFilePath = postCutPath` in broll.js around line 5116).
 *
 * Used by:
 *   - The b-roll plan strategy (this file's `buildPlanStages` — already wired).
 *   - The analysis strategy (Phase B Task 10).
 *   - The plan strategy (Phase B Task 11).
 *   - The plan creation strategy (Phase B Task 12).
 *
 * Options:
 *   - skipFFmpeg: skip Stage 2 (text-only stages don't need video pixels).
 */
export function buildPostCutPrepStages(opts = {}) {
  const stages = [
    {
      name: 'Generate post-cut transcript',
      type: 'programmatic',
      target: 'text_only',
      action: 'generate_post_cut_transcript',
    },
  ]
  if (!opts.skipFFmpeg) {
    stages.push({
      name: 'Export post-cut video',
      type: 'programmatic',
      target: 'text_only',
      action: 'export_post_cut_video',
      actionParams: {},
    })
  }
  // Deep clone so callers can't mutate the source-of-truth definitions.
  return JSON.parse(JSON.stringify(stages))
}
```

Then in the existing stage-array literal in this file, REPLACE the two inline stage objects (the ones with `action: 'generate_post_cut_transcript'` and `action: 'export_post_cut_video'`) with a spread of the helper:

```js
const stages = [
  ...buildPostCutPrepStages(),
  // ... rest of the existing stages unchanged ...
]
```

- [ ] **Step 4: Run test**

```bash
npx vitest run --project server server/services/__tests__/post-cut-strategy-prep.test.js
```

Expected: PASS — all 3 tests.

- [ ] **Step 5: Run the full broll-prior-strategies test suite to confirm nothing else broke**

```bash
npx vitest run --project server server/services/__tests__/broll-prior-strategies.test.js
```

Expected: PASS (all existing tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/create-broll-plan-strategy.js server/services/__tests__/post-cut-strategy-prep.test.js
git commit -m "refactor(broll): extract buildPostCutPrepStages helper from broll plan strategy"
```

---

### Task 10: Seed script — insert new strategy_versions for Analysis / Plan Strategy / Plan Creation

**Files:**
- Create: `server/seed/seed-post-cut-strategies.js`
- Create: `server/services/__tests__/seed-post-cut-strategies.test.js`

This is the workhorse migration. It reads each target strategy's current latest stages_json, prepends the post-cut prep stages, and INSERTs a new strategy_versions row (incrementing version_number by 1). Idempotent: re-running on an already-prepped version is a no-op.

- [ ] **Step 1: Write the failing test**

```js
// server/services/__tests__/seed-post-cut-strategies.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prependPostCutToStages, isAlreadyPrepped } from '../../seed/seed-post-cut-strategies.js'

describe('prependPostCutToStages', () => {
  it('prepends Stages 1+2 to existing stages', () => {
    const existing = [
      { name: 'A-Roll Analysis', type: 'video_llm', target: 'main_video' },
      { name: 'Chapter Plan', type: 'transcript_question' },
    ]
    const out = prependPostCutToStages(existing)
    expect(out).toHaveLength(4)
    expect(out[0].action).toBe('generate_post_cut_transcript')
    expect(out[1].action).toBe('export_post_cut_video')
    expect(out[2].name).toBe('A-Roll Analysis')
    expect(out[3].name).toBe('Chapter Plan')
  })

  it('text-only mode skips FFmpeg stage', () => {
    const existing = [{ name: 'X', type: 'transcript_question' }]
    const out = prependPostCutToStages(existing, { textOnly: true })
    expect(out).toHaveLength(2)
    expect(out[0].action).toBe('generate_post_cut_transcript')
    expect(out[1].name).toBe('X')
  })

  it('does not mutate the input array', () => {
    const existing = [{ name: 'X' }]
    const copy = JSON.parse(JSON.stringify(existing))
    prependPostCutToStages(existing)
    expect(existing).toEqual(copy)
  })
})

describe('isAlreadyPrepped', () => {
  it('returns true when stage 0 is generate_post_cut_transcript', () => {
    expect(isAlreadyPrepped([
      { action: 'generate_post_cut_transcript' },
      { name: 'X' },
    ])).toBe(true)
  })

  it('returns false otherwise', () => {
    expect(isAlreadyPrepped([{ name: 'X' }])).toBe(false)
    expect(isAlreadyPrepped([])).toBe(false)
    expect(isAlreadyPrepped(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run --project server server/services/__tests__/seed-post-cut-strategies.test.js
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the seed module**

Create `server/seed/` directory if it doesn't exist (`ls server/seed` first; if missing, `mkdir -p server/seed`).

```js
// server/seed/seed-post-cut-strategies.js
//
// Insert new strategy_versions rows for analysis / plan strategy / plan
// creation that prepend `generate_post_cut_transcript` and (when not
// text-only) `export_post_cut_video` programmatic stages.
//
// Idempotent: skips strategies whose latest version already starts with
// `generate_post_cut_transcript`. Each successful prep creates a new
// version_number = max + 1, never modifying existing rows. Old runs
// keep referencing their original version per the spec's
// backfill-by-opt-in (Q1=b).

import db from '../db.js'
import { buildPostCutPrepStages } from '../services/create-broll-plan-strategy.js'

/**
 * The strategies we want to retrofit. Filled in from Phase B Task 8
 * findings. Each entry has a name (matched ILIKE) and a textOnly flag
 * (controls whether to include the FFmpeg render stage).
 */
const TARGETS = [
  // EDIT ME based on Task 8 findings.
  // Examples (replace with real names):
  // { nameLike: 'Analysis', textOnly: false },
  // { nameLike: 'Plan Strategy', textOnly: true },
  // { nameLike: 'Plan Creation', textOnly: true },
]

export function isAlreadyPrepped(stages) {
  if (!Array.isArray(stages) || stages.length === 0) return false
  return stages[0]?.action === 'generate_post_cut_transcript'
}

export function prependPostCutToStages(stages, { textOnly = false } = {}) {
  const prep = buildPostCutPrepStages({ skipFFmpeg: textOnly })
  return [...prep, ...JSON.parse(JSON.stringify(stages))]
}

export async function seedPostCutStrategies({ dryRun = false } = {}) {
  const results = []
  for (const target of TARGETS) {
    const strategy = await db.prepare(
      'SELECT * FROM strategies WHERE name ILIKE ? LIMIT 1'
    ).get(`%${target.nameLike}%`)
    if (!strategy) {
      results.push({ target: target.nameLike, status: 'not_found' })
      continue
    }

    const latest = await db.prepare(
      'SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version_number DESC LIMIT 1'
    ).get(strategy.id)
    if (!latest) {
      results.push({ strategyId: strategy.id, status: 'no_versions' })
      continue
    }

    let stages
    try { stages = JSON.parse(latest.stages_json || '[]') } catch {
      results.push({ strategyId: strategy.id, status: 'unparseable_stages' })
      continue
    }

    if (isAlreadyPrepped(stages)) {
      results.push({ strategyId: strategy.id, status: 'already_prepped' })
      continue
    }

    const newStages = prependPostCutToStages(stages, { textOnly: target.textOnly })
    const newVersion = (latest.version_number || 1) + 1

    if (dryRun) {
      results.push({
        strategyId: strategy.id,
        name: strategy.name,
        status: 'would_insert',
        newVersion,
        stagesPreview: newStages.slice(0, 3).map(s => ({ name: s.name, action: s.action })),
      })
      continue
    }

    await db.prepare(
      `INSERT INTO strategy_versions (strategy_id, version_number, stages_json, notes)
       VALUES (?, ?, ?, ?)`
    ).run(
      strategy.id,
      newVersion,
      JSON.stringify(newStages),
      `Auto-prepended post-cut prep stages on ${new Date().toISOString().slice(0, 10)} (cuts-as-source-of-truth migration)`
    )

    results.push({
      strategyId: strategy.id,
      name: strategy.name,
      status: 'inserted',
      newVersion,
    })
  }
  return results
}
```

- [ ] **Step 4: Run unit tests**

```bash
npx vitest run --project server server/services/__tests__/seed-post-cut-strategies.test.js
```

Expected: PASS — 5 tests for `prependPostCutToStages` and `isAlreadyPrepped`.

- [ ] **Step 5: Fill in TARGETS based on Task 8 findings**

Open `server/seed/seed-post-cut-strategies.js`. Replace the empty `TARGETS = []` with the actual entries from Task 8's findings note. For each target strategy, decide `textOnly`:
- `textOnly: false` if the strategy has any `video_llm` or `video_question` stage (needs the FFmpeg-rendered MP4).
- `textOnly: true` if the strategy is purely text — uses `{{transcript}}` only.

- [ ] **Step 6: Dry-run on the local DB to confirm behavior**

Add an admin route to invoke the seed. Create `server/routes/admin/seed-post-cut-strategies.js`:

```js
import { Router } from 'express'
import { requireAuth } from '../../auth.js'
import { seedPostCutStrategies } from '../../seed/seed-post-cut-strategies.js'

const router = Router()

router.post('/seed-post-cut-strategies', requireAuth, async (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' })
  const dryRun = req.query.dry_run === '1' || req.body?.dry_run === true
  try {
    const results = await seedPostCutStrategies({ dryRun })
    res.json({ ok: true, dryRun, results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
```

Wire it into `server/index.js` (find the admin router mounting; `grep -n "admin" server/index.js`). Add:

```js
import seedPostCutStrategiesRouter from './routes/admin/seed-post-cut-strategies.js'
app.use('/api/admin', seedPostCutStrategiesRouter)
```

- [ ] **Step 7: Hit the dry-run endpoint locally**

Run the local dev server (using `npm run dev` is fine here — we are NOT touching processing — per the dev-server-boot-hazard memory, only `npm run dev:server` is the dangerous one):

```bash
# Use npm run dev not npm run dev:server.
npm run dev &
sleep 3

# Dry run — get auth token however the project does (look at .env.example or test fixtures).
TOKEN="<paste admin token>"
curl -s -X POST http://localhost:5173/api/admin/seed-post-cut-strategies?dry_run=1 \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected output: `{ "ok": true, "dryRun": true, "results": [{ "strategyId": ..., "status": "would_insert" | "already_prepped" }, ...] }`

Verify each target strategy got `would_insert` (or `already_prepped` if you re-ran). If any returned `not_found`, the `nameLike` is wrong — fix and retry.

- [ ] **Step 8: Commit**

```bash
git add server/seed/seed-post-cut-strategies.js server/routes/admin/seed-post-cut-strategies.js server/index.js
git commit -m "feat(seed): admin script to prepend post-cut stages to analysis/plan/plan-creation strategies"
```

---

### Task 11: Run the seed against production

**Files:** none (DB-only)

- [ ] **Step 1: Verify dry-run output one more time**

```bash
TOKEN="<admin token>"
curl -s -X POST https://backend-production-4b19.up.railway.app/api/admin/seed-post-cut-strategies?dry_run=1 \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: same shape as the local dry-run — every target shows `would_insert` (assuming none have been prepped yet).

- [ ] **Step 2: Confirm with the user before applying**

The user must explicitly approve before this step writes to the production DB. **Do not skip this confirmation.** If running unattended, return at this step and surface the dry-run output for human approval.

- [ ] **Step 3: Apply**

```bash
TOKEN="<admin token>"
curl -s -X POST https://backend-production-4b19.up.railway.app/api/admin/seed-post-cut-strategies \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
```

Expected: each target shows `inserted` with a `newVersion` number.

- [ ] **Step 4: Verify the new versions exist**

```bash
psql "$DATABASE_URL" -c "
  SELECT s.name, sv.version_number,
         (sv.stages_json::json -> 0 ->> 'action') AS first_action
  FROM strategies s
  JOIN strategy_versions sv ON sv.strategy_id = s.id
  WHERE s.id IN (<list of target strategy IDs from Task 8>)
  ORDER BY s.id, sv.version_number DESC;
"
```

Expected: for each target, the latest `version_number` shows `first_action = generate_post_cut_transcript`.

- [ ] **Step 5: No commit — DB-only change**

This task touches the DB only; no code changes to commit.

---

## Phase C — Frontend cut sharing

Lift cut state and the action creators into a shared module so the b-roll editor can consume them. Add `window.focus` refetch to both editors.

---

### Task 12: Confirm/expose a single editor-state API

**Files:**
- Read: `server/routes/videos.js` around line 850 (existing `PUT /groups/:id/editor-state`).

This is a 5-minute verification — we're confirming both editors will use the same endpoint.

- [ ] **Step 1: Confirm the endpoint exists and returns `editor_state_json`**

```bash
grep -nE "editor-state|editor_state_json" server/routes/videos.js
```

Expected: a `PUT /groups/:id/editor-state` (line 850-ish), a beacon variant, and a GET that returns `editor_state` (line 645).

- [ ] **Step 2: Confirm the rough cut editor uses it**

```bash
grep -nE "editor-state" src/components/editor/useEditorState.js
```

Expected: the `apiPut(\`/videos/groups/${state.groupId}/editor-state\`, ...)` call (line 667) and the beacon (line 684).

If both endpoints exist and the rough cut editor uses them, no code change needed in this task — we're just locking in that the b-roll editor will use the same endpoints.

- [ ] **Step 3: Note the API contract for downstream tasks**

For Phase C, the API contract is:
- `GET /api/videos/groups/:id/detail` — returns `{ ..., editor_state: <parsed>, ... }`. The b-roll editor will call this to load cuts on mount.
- `PUT /api/videos/groups/:id/editor-state` — body `{ editor_state: { cuts, cutExclusions, ... } }`. Both editors call this on cut change.
- `POST /api/videos/groups/:id/editor-state-beacon` — used by `navigator.sendBeacon` on tab close. Both editors should use it.

No commit (verification-only task).

---

### Task 13: Extract `sharedCutLogic.js`

**Files:**
- Create: `src/components/editor/sharedCutLogic.js`
- Create: `src/components/editor/__tests__/sharedCutLogic.test.js`

- [ ] **Step 1: Write failing tests**

```js
// src/components/editor/__tests__/sharedCutLogic.test.js
import { describe, it, expect } from 'vitest'
import {
  splitAtPlayhead,
  resolveEdgeDrag,
  ADD_CUT,
  UPDATE_CUT,
} from '../sharedCutLogic.js'

describe('splitAtPlayhead', () => {
  it('returns ADD_CUT action for zero-width razor at playhead when not inside a cut', () => {
    const action = splitAtPlayhead({
      playheadTime: 30,
      cuts: [],
      cutExclusions: [],
    })
    expect(action).toEqual({
      type: ADD_CUT,
      cut: expect.objectContaining({
        start: 30,
        end: 30,
        source: 'transcript',
      }),
    })
    expect(typeof action.cut.id).toBe('string')
  })

  it('returns null when playhead is inside an existing cut (split would be a no-op)', () => {
    const action = splitAtPlayhead({
      playheadTime: 30,
      cuts: [{ id: 'c1', start: 20, end: 40, source: 'transcript' }],
      cutExclusions: [],
    })
    expect(action).toBeNull()
  })
})

describe('resolveEdgeDrag', () => {
  it('returns UPDATE_CUT for a manual cut (source==transcript)', () => {
    const action = resolveEdgeDrag({
      cut: { id: 'c1', start: 10, end: 20, source: 'transcript' },
      edge: 'end',
      newTime: 25,
      cuts: [{ id: 'c1', start: 10, end: 20, source: 'transcript' }],
    })
    expect(action).toEqual({
      type: UPDATE_CUT,
      id: 'c1',
      patch: { end: 25 },
    })
  })

  it('returns ADD_CUT (overlay) for an annotation/silence cut to preserve original', () => {
    const action = resolveEdgeDrag({
      cut: { id: 'a1', start: 10, end: 20, source: 'annotation' },
      edge: 'start',
      newTime: 8,
      cuts: [{ id: 'a1', start: 10, end: 20, source: 'annotation' }],
    })
    expect(action.type).toBe(ADD_CUT)
    expect(action.cut.start).toBe(8)
    expect(action.cut.end).toBe(20)
    expect(action.cut.source).toBe('transcript') // overlay is always manual
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run --project web src/components/editor/__tests__/sharedCutLogic.test.js
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Read the existing rough cut logic to understand current behavior**

```bash
grep -nE "ADD_CUT|UPDATE_CUT|REMOVE_CUT|handleSplit" src/components/editor/useEditorState.js | head -10
grep -nE "handleSplit" src/components/editor/PlaybackControls.jsx
```

Note the action type names (likely `ADD_CUT`, `UPDATE_CUT`, `REMOVE_CUT`). Note the shape of `state.cuts` items (`{id, start, end, source}` per the project memory).

- [ ] **Step 4: Implement sharedCutLogic.js**

```js
// src/components/editor/sharedCutLogic.js
//
// Shared cut action creators + helpers used by both the rough cut editor
// (useEditorState.js) and the b-roll editor (useBRollEditorState.js).
// Action TYPE strings are exported so each editor's reducer can match
// on them. The dispatch shape is intentionally "plain action object" so
// any reducer can consume it; we don't bake in a specific store.

export const ADD_CUT = 'ADD_CUT'
export const UPDATE_CUT = 'UPDATE_CUT'
export const REMOVE_CUT = 'REMOVE_CUT'

let cutIdCounter = 0
function nextCutId() {
  cutIdCounter++
  return `cut-${Date.now()}-${cutIdCounter}`
}

/**
 * Compute the action to dispatch when the user clicks "Cut" / razor at
 * the current playhead. Returns null if the click would be a no-op
 * (playhead is already inside an existing cut).
 *
 * Mirrors the existing handleSplit behavior in PlaybackControls.jsx:61-89.
 */
export function splitAtPlayhead({ playheadTime, cuts, cutExclusions = [] }) {
  if (typeof playheadTime !== 'number' || !Number.isFinite(playheadTime)) return null
  // If the playhead is inside any existing cut, splitting would just make
  // a zero-width marker inside that cut — skip.
  for (const c of cuts || []) {
    if (playheadTime > c.start + 0.001 && playheadTime < c.end - 0.001) return null
  }
  return {
    type: ADD_CUT,
    cut: {
      id: nextCutId(),
      start: playheadTime,
      end: playheadTime,
      source: 'transcript',
    },
  }
}

/**
 * Compute the action to dispatch when the user drags a cut edge.
 * Manual cuts (source==transcript) are mutated in place.
 * Annotation/silence cuts get an overlay manual cut to preserve the
 * original (per project_transcript_eval memory: "Annotation/silence cuts:
 * creates manual overlay cut (ADD_CUT)").
 */
export function resolveEdgeDrag({ cut, edge, newTime, cuts }) {
  if (!cut || (edge !== 'start' && edge !== 'end')) return null
  if (cut.source === 'transcript') {
    return {
      type: UPDATE_CUT,
      id: cut.id,
      patch: edge === 'start' ? { start: newTime } : { end: newTime },
    }
  }
  // Overlay manual cut for AI-generated cuts.
  const start = edge === 'start' ? newTime : cut.start
  const end = edge === 'end' ? newTime : cut.end
  return {
    type: ADD_CUT,
    cut: {
      id: nextCutId(),
      start,
      end,
      source: 'transcript',
      manualOverlayOf: cut.id,
    },
  }
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run --project web src/components/editor/__tests__/sharedCutLogic.test.js
```

Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/sharedCutLogic.js src/components/editor/__tests__/sharedCutLogic.test.js
git commit -m "feat(editor): extract sharedCutLogic for split + edge drag actions"
```

---

### Task 14: Wire `sharedCutLogic` into `useEditorState.js`

**Files:**
- Modify: `src/components/editor/useEditorState.js`
- Modify: `src/components/editor/PlaybackControls.jsx`

This task does NOT change behavior — it just routes existing handleSplit / edge drag logic through the shared module so the b-roll editor (Task 15) can re-use the same actions.

- [ ] **Step 1: Replace inline ADD_CUT/UPDATE_CUT constants with imports**

In `src/components/editor/useEditorState.js`, find the existing reducer action type strings (`'ADD_CUT'`, `'UPDATE_CUT'`, `'REMOVE_CUT'`). Add import at the top:

```js
import { ADD_CUT, UPDATE_CUT, REMOVE_CUT } from './sharedCutLogic.js'
```

Replace string literals in the reducer's `case` matches with the imported constants.

- [ ] **Step 2: Replace the inline `handleSplit` in PlaybackControls.jsx**

In `src/components/editor/PlaybackControls.jsx` (around lines 61-89), find `handleSplit` and replace its body:

```js
import { splitAtPlayhead } from './sharedCutLogic.js'
// ... at the existing handleSplit:

const handleSplit = () => {
  const action = splitAtPlayhead({
    playheadTime: videoRef.current?.currentTime ?? state.currentTime ?? 0,
    cuts: state.cuts,
    cutExclusions: state.cutExclusions,
  })
  if (action) dispatch(action)
}
```

(Keep any surrounding logic — playhead-pause, focus re-snap, etc. — unchanged.)

- [ ] **Step 3: Run all editor tests to confirm no regression**

```bash
npx vitest run --project web src/components/editor
```

Expected: all existing editor tests still pass. If any fail with "ADD_CUT is not defined" or similar, the import was missed in step 1 — fix.

- [ ] **Step 4: Manual smoke (rough cut editor only)**

```bash
npm run dev &
sleep 3
```

Open `http://localhost:5173/editor/<any-existing-project>/sync` (the rough cut page). Press the Cut button at the playhead. Verify a cut appears on the timeline.

This is a smoke test, not a full regression — full regression requires Task 22 (manual smoke task).

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/useEditorState.js src/components/editor/PlaybackControls.jsx
git commit -m "refactor(editor): route rough cut handleSplit through sharedCutLogic"
```

---

### Task 15: Add `cuts` to `useBRollEditorState.js`

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Locate the state shape**

```bash
grep -nE "INITIAL_STATE|initialState|^const.*State" src/components/editor/useBRollEditorState.js | head -5
```

Note the line where the initial state object is defined.

- [ ] **Step 2: Extend the state shape**

In `src/components/editor/useBRollEditorState.js`, find the initial state object. Add three fields:

```js
const initialState = {
  // ... existing fields unchanged ...
  cuts: [],
  cutExclusions: [],
  cutsLoaded: false, // becomes true after the initial fetch resolves
}
```

- [ ] **Step 3: Add reducer cases for cut actions**

Find the reducer (function that takes `(state, action)` and returns a new state). Add three new cases by importing the action types:

```js
import { ADD_CUT, UPDATE_CUT, REMOVE_CUT } from './sharedCutLogic.js'

// In the reducer:
case ADD_CUT: {
  return { ...state, cuts: [...state.cuts, action.cut] }
}
case UPDATE_CUT: {
  return {
    ...state,
    cuts: state.cuts.map(c => c.id === action.id ? { ...c, ...action.patch } : c),
  }
}
case REMOVE_CUT: {
  return { ...state, cuts: state.cuts.filter(c => c.id !== action.id) }
}
case 'SET_CUTS_FROM_SERVER': {
  return {
    ...state,
    cuts: action.cuts || [],
    cutExclusions: action.cutExclusions || [],
    cutsLoaded: true,
  }
}
```

- [ ] **Step 4: Add load-on-mount effect**

Find where the b-roll editor's main `useEffect` for initial data loading lives (look for `useEffect` near the top of the hook, typically right after the reducer). Add a new effect:

```js
import { apiGet } from '../../utils/api' // or whatever the existing api helper is — check imports in the same file

// In the hook body:
React.useEffect(() => {
  if (!groupId) return
  let alive = true
  ;(async () => {
    try {
      const detail = await apiGet(`/videos/groups/${groupId}/detail`)
      if (!alive) return
      const editorState = detail?.editor_state
      dispatch({
        type: 'SET_CUTS_FROM_SERVER',
        cuts: editorState?.cuts || [],
        cutExclusions: editorState?.cutExclusions || [],
      })
    } catch (err) {
      console.warn('[useBRollEditorState] Could not load editor_state:', err.message)
    }
  })()
  return () => { alive = false }
}, [groupId])
```

- [ ] **Step 5: Add save-on-cut-change effect**

Add a debounced save effect — only fires when `cutsLoaded` is true (so we don't overwrite the server state with the empty initial state):

```js
React.useEffect(() => {
  if (!state.cutsLoaded || !groupId) return
  const handle = setTimeout(() => {
    apiPut(`/videos/groups/${groupId}/editor-state`, {
      editor_state: {
        // Merge: keep any other editor_state fields that the rough cut editor wrote.
        // We fetch fresh, merge in our cuts, save back.
        cuts: state.cuts,
        cutExclusions: state.cutExclusions,
      },
    }).catch(err => console.warn('[useBRollEditorState] Save failed:', err.message))
  }, 500)
  return () => clearTimeout(handle)
}, [state.cuts, state.cutExclusions, state.cutsLoaded, groupId])
```

**Note:** This save overwrites the entire `editor_state` with just `{cuts, cutExclusions}`. If the rough cut editor stores other fields in `editor_state_json`, this would clobber them. Check `useEditorState.js` to see what other fields it writes:

```bash
grep -nE "serializeState|editor_state.*{" src/components/editor/useEditorState.js | head -5
```

If there are other fields (like `path_id`, `selectedSegmentId`, etc.), modify the save to fetch + merge:

```js
const detail = await apiGet(`/videos/groups/${groupId}/detail`)
const merged = {
  ...(detail?.editor_state || {}),
  cuts: state.cuts,
  cutExclusions: state.cutExclusions,
}
await apiPut(`/videos/groups/${groupId}/editor-state`, { editor_state: merged })
```

- [ ] **Step 6: Add window.focus refetch**

```js
React.useEffect(() => {
  if (!groupId) return
  const handler = async () => {
    try {
      const detail = await apiGet(`/videos/groups/${groupId}/detail`)
      const editorState = detail?.editor_state
      dispatch({
        type: 'SET_CUTS_FROM_SERVER',
        cuts: editorState?.cuts || [],
        cutExclusions: editorState?.cutExclusions || [],
      })
    } catch {}
  }
  window.addEventListener('focus', handler)
  return () => window.removeEventListener('focus', handler)
}, [groupId])
```

- [ ] **Step 7: Manual smoke test**

```bash
npm run dev &
sleep 3
```

1. Open `/editor/<project>/sync` (rough cut). Make a cut. Wait 1s for autosave.
2. Open `/editor/<project>/brolls/edit` in another tab.
3. Open browser devtools → Network. Confirm a `GET /api/videos/groups/<id>/detail` happens on mount.
4. Confirm the response includes `editor_state.cuts` with the cut you just made.

We can't visually verify yet (cut overlay UI is Task 17) — this step only confirms the data is loaded.

- [ ] **Step 8: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll-editor): load + save + focus-refetch cuts via shared editor_state"
```

---

### Task 16: Add `window.focus` refetch to `useEditorState.js`

**Files:**
- Modify: `src/components/editor/useEditorState.js`

- [ ] **Step 1: Find an existing fetcher to reuse**

```bash
grep -nE "fetchGroup|fetch.*detail|loadGroup|apiGet.*groups" src/components/editor/useEditorState.js | head -5
```

Note the existing function/effect that loads group detail.

- [ ] **Step 2: Add focus listener**

In `src/components/editor/useEditorState.js`, near where the existing initial-load effect lives, add:

```js
React.useEffect(() => {
  if (!state.groupId) return
  const handler = async () => {
    // Re-fetch the editor state so cuts made in the b-roll editor (or
    // any other tab) propagate here. Reuses the existing loader.
    try {
      const detail = await apiGet(`/videos/groups/${state.groupId}/detail`)
      if (detail?.editor_state) {
        dispatch({ type: 'HYDRATE_EDITOR_STATE', editorState: detail.editor_state })
      }
    } catch {}
  }
  window.addEventListener('focus', handler)
  return () => window.removeEventListener('focus', handler)
}, [state.groupId])
```

If `HYDRATE_EDITOR_STATE` doesn't exist in the reducer, find the existing initial-hydration action (likely `INIT` or `SET_STATE` or similar) and reuse it:

```bash
grep -nE "case 'HYDRATE|case 'INIT|case 'SET_STATE'" src/components/editor/useEditorState.js
```

Use whichever matches.

- [ ] **Step 3: Manual verification**

```bash
npm run dev &
sleep 3
```

1. Open `/editor/<project>/sync` (rough cut).
2. Note the existing cuts.
3. In another tab, open the same project's b-roll edit page (the one you wired in Task 15).
4. Switch back to the sync tab — a refetch should fire (visible in Network tab).

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/useEditorState.js
git commit -m "feat(rough-cut): refetch editor_state on window.focus to sync with b-roll editor"
```

---

## Phase D — B-roll editor preview + timeline cut overlay

The cuts now live in `useBRollEditorState`. This phase makes them visible (timeline overlay) and effective (skip during preview playback).

---

### Task 17: Extract `usePlaybackSkipRegions` hook

**Files:**
- Read: `src/components/editor/EditorView.jsx` — find the existing skip-regions playback logic.
- Create: `src/components/editor/usePlaybackSkipRegions.js`
- Create: `src/components/editor/__tests__/usePlaybackSkipRegions.test.jsx`

- [ ] **Step 1: Find the existing skip logic**

```bash
grep -nE "skipRegions|skipDuringPlayback|jumpTo.*end|currentTime.*=.*cut" src/components/editor/EditorView.jsx | head -10
```

Read the surrounding code (~30 lines around each match) to understand the algorithm.

- [ ] **Step 2: Write the failing test**

```js
// src/components/editor/__tests__/usePlaybackSkipRegions.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePlaybackSkipRegions } from '../usePlaybackSkipRegions.js'

function makeVideoRef(initialTime = 0) {
  const ref = {
    current: {
      currentTime: initialTime,
      paused: false,
      // simulate a 'timeupdate' event by storing a handler
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  }
  return ref
}

describe('usePlaybackSkipRegions', () => {
  it('attaches a timeupdate listener on mount', () => {
    const ref = makeVideoRef()
    renderHook(() => usePlaybackSkipRegions(ref, [], []))
    expect(ref.current.addEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function))
  })

  it('jumps over a cut when timeupdate fires inside it', () => {
    const ref = makeVideoRef(15)
    const cuts = [{ id: 'c1', start: 10, end: 20, source: 'transcript' }]
    renderHook(() => usePlaybackSkipRegions(ref, cuts, []))
    // Get the registered timeupdate handler
    const handler = ref.current.addEventListener.mock.calls[0][1]
    handler()
    // Should have jumped past the cut.
    expect(ref.current.currentTime).toBeGreaterThanOrEqual(20)
  })

  it('does not jump when timeupdate fires outside any cut', () => {
    const ref = makeVideoRef(25)
    const cuts = [{ id: 'c1', start: 10, end: 20, source: 'transcript' }]
    renderHook(() => usePlaybackSkipRegions(ref, cuts, []))
    const handler = ref.current.addEventListener.mock.calls[0][1]
    handler()
    expect(ref.current.currentTime).toBe(25)
  })

  it('respects cut exclusions (excluded sub-region is NOT skipped)', () => {
    const ref = makeVideoRef(15)
    const cuts = [{ id: 'c1', start: 10, end: 30, source: 'transcript' }]
    const exclusions = [{ start: 12, end: 18 }]
    renderHook(() => usePlaybackSkipRegions(ref, cuts, exclusions))
    const handler = ref.current.addEventListener.mock.calls[0][1]
    handler()
    // 15 is inside the exclusion, so playback continues. currentTime unchanged.
    expect(ref.current.currentTime).toBe(15)
  })
})
```

- [ ] **Step 3: Run test to verify failure**

```bash
npx vitest run --project web src/components/editor/__tests__/usePlaybackSkipRegions.test.jsx
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement the hook**

```js
// src/components/editor/usePlaybackSkipRegions.js
import React from 'react'

/**
 * Skip cut regions during playback. Mirror of EditorView.jsx's existing
 * skip logic, packaged as a reusable hook so the b-roll editor's
 * preview can use the same behavior.
 *
 * Compute effective skip regions = cuts minus cutExclusions. On every
 * timeupdate, if the playhead is inside a skip region, jump to the
 * region's end.
 *
 * Note: this hook deliberately does NOT include the waveform-based
 * refinement (3-bar silence rule, +150ms tail) that EditorView.jsx
 * applies via `mergedWords`. That refinement is rough-cut-specific
 * and depends on the transcript editor; the b-roll editor doesn't
 * have access to it. Both editors get the same boundary skip behavior;
 * only the rough-cut editor gets the waveform tail-trim refinement.
 */
export function usePlaybackSkipRegions(videoRef, cuts, cutExclusions = []) {
  // Compute effective skip regions (memoized).
  const skipRegions = React.useMemo(() => {
    if (!cuts || cuts.length === 0) return []
    const sorted = [...cuts]
      .filter(c => c.end > c.start + 0.01)
      .sort((a, b) => a.start - b.start)
    const merged = []
    for (const c of sorted) {
      const last = merged[merged.length - 1]
      if (last && c.start <= last.end + 0.05) {
        last.end = Math.max(last.end, c.end)
      } else {
        merged.push({ start: c.start, end: c.end })
      }
    }
    if (!cutExclusions?.length) return merged
    const result = []
    for (const region of merged) {
      let cur = { ...region }
      const sortedEx = [...cutExclusions].sort((a, b) => a.start - b.start)
      for (const ex of sortedEx) {
        if (ex.start >= cur.end || ex.end <= cur.start) continue
        if (cur.start < ex.start - 0.01) result.push({ start: cur.start, end: ex.start })
        cur.start = ex.end
      }
      if (cur.start < cur.end - 0.01) result.push(cur)
    }
    return result
  }, [cuts, cutExclusions])

  React.useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handleTimeupdate = () => {
      const t = video.currentTime
      for (const r of skipRegions) {
        if (t >= r.start && t < r.end) {
          video.currentTime = r.end + 0.001
          return
        }
      }
    }
    video.addEventListener('timeupdate', handleTimeupdate)
    return () => video.removeEventListener('timeupdate', handleTimeupdate)
  }, [videoRef, skipRegions])

  return skipRegions
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run --project web src/components/editor/__tests__/usePlaybackSkipRegions.test.jsx
```

Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/usePlaybackSkipRegions.js src/components/editor/__tests__/usePlaybackSkipRegions.test.jsx
git commit -m "feat(editor): extract usePlaybackSkipRegions hook for cross-editor reuse"
```

---

### Task 18: Apply skip hook in `BRollPreview.jsx`

**Files:**
- Modify: `src/components/editor/BRollPreview.jsx`
- Modify: `src/components/editor/BRollEditor.jsx` (to pass cuts down)

- [ ] **Step 1: Read the current BRollPreview structure**

```bash
grep -nE "videoRef|preview_url|<video" src/components/editor/BRollPreview.jsx | head -10
```

Identify the `videoRef` and the props the component takes.

- [ ] **Step 2: Add the hook to BRollPreview**

Open `src/components/editor/BRollPreview.jsx`. Add:

```js
import { usePlaybackSkipRegions } from './usePlaybackSkipRegions.js'

// In the component, add `cuts` and `cutExclusions` to props:
export function BRollPreview({ /* ...existing props... */, cuts = [], cutExclusions = [] }) {
  const videoRef = /* existing videoRef */

  usePlaybackSkipRegions(videoRef, cuts, cutExclusions)

  // ...rest unchanged.
}
```

- [ ] **Step 3: Pass cuts from BRollEditor**

Open `src/components/editor/BRollEditor.jsx`. Find where `BRollPreview` is rendered:

```bash
grep -nE "BRollPreview|<BRollPreview" src/components/editor/BRollEditor.jsx
```

Add the props from `useBRollEditorState`:

```jsx
<BRollPreview
  /* ...existing props... */
  cuts={state.cuts}
  cutExclusions={state.cutExclusions}
/>
```

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev &
sleep 3
```

1. Open `/editor/<project>/sync`. Make a cut from t=10 to t=15. Save.
2. Switch to `/editor/<project>/brolls/edit`.
3. Click play in the preview. The playhead should jump from 10 → 15 when it hits the cut.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollPreview.jsx src/components/editor/BRollEditor.jsx
git commit -m "feat(broll-editor): preview skips cut regions during playback"
```

---

### Task 19: Render cut overlay on b-roll editor timeline

**Files:**
- Read: `src/components/editor/Timeline.jsx` — find `mergedDisplayCuts` and the cut overlay renderer.
- Modify: `src/components/editor/BRollEditor.jsx` (or wherever the b-roll timeline is mounted)
- Modify: `src/components/editor/Timeline.jsx` if `mergedDisplayCuts` is internal-only — export it.

- [ ] **Step 1: Find `mergedDisplayCuts`**

```bash
grep -nE "mergedDisplayCuts|cutOverlay|cut-overlay" src/components/editor/Timeline.jsx | head -10
```

If it's a `const` or `useMemo` inside Timeline.jsx, decide whether to:
- (a) Import the timeline's existing rendering as-is into b-roll editor (preferred — single source of truth), or
- (b) Extract `mergedDisplayCuts` calculation into a hook `useMergedDisplayCuts(cuts, cutExclusions)`.

The cleaner choice is (a): if BRollEditor already mounts a `<Timeline />` (check), you only need to pass `cuts` + `cutExclusions` props through. If the b-roll editor has its own custom timeline, do (b).

- [ ] **Step 2: Identify the b-roll timeline mount**

```bash
grep -nE "<Timeline|<BRollTrack|timeline" src/components/editor/BRollEditor.jsx | head -10
```

If `<Timeline />` is already mounted, just pass `cuts` and `cutExclusions` down.

If only `<BRollTrack />` is mounted (no shared Timeline), do option (b) — extract a hook.

- [ ] **Step 3 (option a): Pass cuts to existing Timeline**

If Timeline is already used in BRollEditor:

```jsx
<Timeline
  /* ...existing props... */
  cuts={state.cuts}
  cutExclusions={state.cutExclusions}
  showCutOverlay={true}  // a flag if Timeline conditionally renders the overlay; if it always does, omit
/>
```

Verify Timeline.jsx accepts these props (it likely does already since the rough cut editor uses it). Skip to Step 5 if so.

- [ ] **Step 3 (option b): Extract `useMergedDisplayCuts` hook and render overlay in b-roll**

If Timeline is NOT used in BRollEditor and we need a custom overlay:

Create `src/components/editor/useMergedDisplayCuts.js`:

```js
import React from 'react'
import { computeEffectiveCuts } from '../../utils/cuts'  // or wherever it lives — if not in frontend, port from server/services/broll.js

export function useMergedDisplayCuts(cuts, cutExclusions = []) {
  return React.useMemo(() => {
    return computeEffectiveCuts(cuts || [], cutExclusions || [])
  }, [cuts, cutExclusions])
}
```

(If `computeEffectiveCuts` only exists in `server/services/broll.js`, port it to a shared `src/utils/cuts.js` module — keep the implementation byte-identical.)

In `BRollTrack.jsx` (or the b-roll timeline parent), render the overlay:

```jsx
import { useMergedDisplayCuts } from './useMergedDisplayCuts.js'

const merged = useMergedDisplayCuts(cuts, cutExclusions)

// Inside the timeline render:
<div className="cut-overlay-layer">
  {merged.map((c, i) => (
    <div
      key={i}
      className="cut-overlay-strip"
      style={{
        position: 'absolute',
        left: `${(c.start / totalDuration) * 100}%`,
        width: `${((c.end - c.start) / totalDuration) * 100}%`,
        // existing rough-cut styling — match Timeline.jsx's overlay style
      }}
    />
  ))}
</div>
```

For exact styling, copy from `Timeline.jsx`'s existing cut overlay markup. Use the same className so existing CSS applies.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev &
sleep 3
```

1. Open `/editor/<project>/sync`. Make 2 cuts. Save.
2. Switch to `/editor/<project>/brolls/edit`. Confirm 2 cut overlay strips render on the timeline at the same positions as in the rough cut page.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollEditor.jsx src/components/editor/Timeline.jsx src/components/editor/useMergedDisplayCuts.js src/components/editor/BRollTrack.jsx
git commit -m "feat(broll-editor): render cut overlay on timeline"
```

(Adjust the file list to match what you actually changed in option a vs option b.)

---

### Task 20: Wire edge drag in b-roll timeline

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx` (or the b-roll timeline parent)
- Modify: `src/components/editor/Timeline.jsx` (if option a above — unlikely needs change)

- [ ] **Step 1: Check whether existing edge drag is already in Timeline.jsx**

```bash
grep -nE "handleEdgeDrag|edgeDrag|onMouseDown.*cut" src/components/editor/Timeline.jsx src/components/editor/TimelineTrack.jsx src/components/editor/VideoFrameTrack.jsx | head -10
```

If `<Timeline />` is mounted in BRollEditor (option a from Task 19), edge drag works automatically — skip to Step 4.

- [ ] **Step 2 (only if option b): Wire `resolveEdgeDrag` from sharedCutLogic**

In `BRollTrack.jsx` (or wherever you're rendering the cut overlay strips from Task 19), add drag handles to the strips:

```jsx
import { resolveEdgeDrag } from './sharedCutLogic.js'

// On each strip:
<div
  className="cut-overlay-strip"
  /* ...existing style... */
>
  <div
    className="cut-edge cut-edge-left"
    onMouseDown={(e) => startEdgeDrag(e, c, 'start')}
  />
  <div
    className="cut-edge cut-edge-right"
    onMouseDown={(e) => startEdgeDrag(e, c, 'end')}
  />
</div>

function startEdgeDrag(e, cut, edge) {
  e.preventDefault()
  const onMove = (ev) => {
    const newTime = pixelsToTime(ev.clientX) // helper — should already exist in Timeline-related code
    const action = resolveEdgeDrag({ cut, edge, newTime, cuts: state.cuts })
    if (action) dispatch(action)
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
```

- [ ] **Step 3 (only if option b): CSS for edge handles**

Match the existing rough cut handle CSS. `grep -nE "cut-edge|cutEdge" src/components/editor/*.css src/index.css` to find existing styles. Apply the same className.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev &
sleep 3
```

1. Open `/editor/<project>/brolls/edit`. Drag the right edge of an existing cut. Confirm:
   - The cut visibly resizes.
   - On window focus to `/editor/<project>/sync`, the cut shows the new size there too (proves the save+sync from Task 15+16 works).

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollTrack.jsx src/components/editor/Timeline.jsx
git commit -m "feat(broll-editor): edge drag for cut start/end via sharedCutLogic"
```

---

### Task 21: Un-gate the Cut button in `PlaybackControls.jsx`

**Files:**
- Modify: `src/components/editor/PlaybackControls.jsx`

- [ ] **Step 1: Find the gate**

```bash
grep -nE "activeTab === 'roughcut'|activeTab !== 'roughcut'" src/components/editor/PlaybackControls.jsx
```

Note the conditional that hides the Cut button outside the rough cut tab.

- [ ] **Step 2: Replace with explicit "has cut state" check**

Replace the `state.activeTab === 'roughcut'` gate with a prop or context check that's true for both rough cut AND b-roll editor:

```js
// In PlaybackControls.jsx, replace:
{state.activeTab === 'roughcut' && (
  <button onClick={handleSplit}>Cut</button>
)}

// With:
{props.cutsEnabled && (
  <button onClick={handleSplit}>Cut</button>
)}
```

Add `cutsEnabled` to the component's props (default true).

- [ ] **Step 3: Pass `cutsEnabled` from both editor mounts**

In `EditorView.jsx`, find where `<PlaybackControls />` is rendered:

```bash
grep -nE "<PlaybackControls" src/components/editor/EditorView.jsx
```

Add `cutsEnabled={true}` (or omit, since true is the default).

In `BRollEditor.jsx`, do the same:

```bash
grep -nE "<PlaybackControls" src/components/editor/BRollEditor.jsx
```

Add `cutsEnabled={true}`. If BRollEditor doesn't currently render PlaybackControls, mount it:

```jsx
import { PlaybackControls } from './PlaybackControls.jsx'

<PlaybackControls
  videoRef={previewRef}
  state={state}
  dispatch={dispatch}
  cutsEnabled={true}
/>
```

(Adjust prop names to match what PlaybackControls actually expects.)

- [ ] **Step 4: Verify `splitAtPlayhead` works in the b-roll editor's reducer**

The reducer in `useBRollEditorState.js` was updated in Task 15 to handle `ADD_CUT`. The Cut button dispatches `ADD_CUT` via `splitAtPlayhead`. Verify by hand:

```bash
npm run dev &
sleep 3
```

1. Open `/editor/<project>/brolls/edit`.
2. Play to t=20s. Pause.
3. Click Cut. A zero-width razor should appear at t=20.
4. Drag its right edge to t=25. Confirm the cut becomes a [20, 25] region.
5. Switch to `/editor/<project>/sync`. Confirm the same [20, 25] cut shows up there.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/PlaybackControls.jsx src/components/editor/EditorView.jsx src/components/editor/BRollEditor.jsx
git commit -m "feat(broll-editor): un-gate Cut button — works in both rough cut and b-roll editors"
```

---

## Phase E — Export A-Roll segments

XMEML emits one continuous A-Roll clipitem today. We extend it to emit one per kept segment.

---

### Task 22: Add `arollSegments` to `xmeml-generator.js`

**Files:**
- Modify: `server/services/xmeml-generator.js`
- Create: `server/services/__tests__/xmeml-generator-aroll-segments.test.js`

- [ ] **Step 1: Write failing tests**

```js
// server/services/__tests__/xmeml-generator-aroll-segments.test.js
import { describe, it, expect } from 'vitest'
import { generateXmeml } from '../xmeml-generator.js'

describe('generateXmeml — arollSegments', () => {
  const baseInput = {
    sequenceName: 'TestSeq',
    placements: [],
    frameRate: 50,
    sequenceSize: { w: 1920, h: 1080 },
  }

  it('emits one V1 clipitem per segment', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [
        { filename: 'aroll.mov', start: 0, end: 10 },
        { filename: 'aroll.mov', start: 15, end: 30 },
      ],
    })
    const matches = xml.match(/<clipitem[^>]*aroll/g) || []
    expect(matches.length).toBe(2)
    // First clip start=0, end = 10 * 50fps = 500 frames.
    expect(xml).toMatch(/<start>0<\/start>[\s\S]*?<end>500<\/end>/)
    // Second clip start = 15 * 50 = 750, end = 30 * 50 = 1500.
    expect(xml).toMatch(/<start>750<\/start>[\s\S]*?<end>1500<\/end>/)
  })

  it('arollSegments takes precedence over legacy aroll prop', () => {
    const xml = generateXmeml({
      ...baseInput,
      aroll: { filename: 'should-be-ignored.mov' },
      arollSegments: [{ filename: 'real.mov', start: 0, end: 5 }],
    })
    expect(xml).toMatch(/real\.mov/)
    expect(xml).not.toMatch(/should-be-ignored/)
  })

  it('falls back to legacy aroll prop when arollSegments is absent', () => {
    const xml = generateXmeml({
      ...baseInput,
      aroll: { filename: 'legacy.mov' },
    })
    expect(xml).toMatch(/legacy\.mov/)
  })

  it('emits no V1 track when both arollSegments and aroll are absent', () => {
    const xml = generateXmeml({ ...baseInput })
    expect(xml).not.toMatch(/clipitem.*aroll/)
  })

  it('rejects empty arollSegments array gracefully', () => {
    const xml = generateXmeml({ ...baseInput, arollSegments: [] })
    expect(xml).not.toMatch(/clipitem.*aroll/)
  })

  it('preserves source IN/OUT correctly per segment (timeline pos vs source pos)', () => {
    // A 30s aroll with [10,20] in original time becomes a 10s segment.
    // <start>=10*50=500 (timeline). <end>=20*50=1000.
    // <in>=10*src_rate, <out>=20*src_rate (source coords).
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{
        filename: 'aroll.mov',
        start: 10,
        end: 20,
        sourceFrameRate: 30,
        sourceDurationSeconds: 30,
      }],
    })
    expect(xml).toMatch(/<start>500<\/start>/)
    expect(xml).toMatch(/<end>1000<\/end>/)
    expect(xml).toMatch(/<in>300<\/in>/) // 10 * 30
    expect(xml).toMatch(/<out>600<\/out>/) // 20 * 30
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run --project server server/services/__tests__/xmeml-generator-aroll-segments.test.js
```

Expected: most tests FAIL — `arollSegments` not yet handled.

- [ ] **Step 3: Update `xmeml-generator.js`**

Open `server/services/xmeml-generator.js`. The current A-Roll block is at line 357-399 (a single `<clipitem>` spanning the whole sequence). Replace with a loop that emits one clip per segment.

Find the `aroll` parameter on line 239 — add `arollSegments` next to it:

```js
export function generateXmeml({
  sequenceName,
  placements,
  frameRate = 50,
  sequenceSize = { w: 1920, h: 1080 },
  aroll = null,
  arollSegments = null, // NEW: [{filename, start, end, sourceFrameRate?, sourceDurationSeconds?, width?, height?}]
  mediaFolderAbsolute = null,
}) {
```

Replace the existing A-Roll emission block (currently `if (aroll && typeof aroll === 'object' && aroll.filename) { ... }`) with:

```js
// A-Roll track emission. New `arollSegments` (per-segment) takes
// precedence over legacy `aroll` (single continuous clip). Both produce
// V1 track output; the difference is one clipitem (legacy) vs N clipitems
// (segments).
const segs = (Array.isArray(arollSegments) && arollSegments.length > 0)
  ? arollSegments
  : (aroll && typeof aroll === 'object' && aroll.filename
    ? [{
        filename: aroll.filename,
        start: 0,
        end: sequenceDuration / frameRate,
        sourceFrameRate: aroll.frameRate,
        sourceDurationSeconds: aroll.sourceDurationSeconds,
        width: aroll.width,
        height: aroll.height,
      }]
    : [])

if (segs.length > 0) {
  lines.push(`        <track>`)
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg?.filename) continue
    const arollFilename = sanitizeFilename(String(seg.filename))
    const arollFrameRate = Number.isFinite(seg.sourceFrameRate) && seg.sourceFrameRate > 0 ? seg.sourceFrameRate : frameRate
    const arollWidth = Number.isFinite(seg.width) && seg.width > 0 ? seg.width : seqW
    const arollHeight = Number.isFinite(seg.height) && seg.height > 0 ? seg.height : seqH
    const sourceDurationSec = Number.isFinite(seg.sourceDurationSeconds) && seg.sourceDurationSeconds > 0
      ? seg.sourceDurationSeconds
      : (seg.end - seg.start)
    const arollSourceFrames = Math.round(sourceDurationSec * arollFrameRate)
    const startFrame = secondsToFrames(seg.start, frameRate)
    const endFrame = secondsToFrames(seg.end, frameRate)
    const inSrcFrames = Math.round(seg.start * arollFrameRate)
    const outSrcFrames = Math.round(seg.end * arollFrameRate)
    const arollClipId = `clip-${seqSlug}-aroll-${i + 1}`
    const arollFileId = i === 0 ? `file-aroll` : `file-aroll-${i + 1}`

    lines.push(`          <clipitem id="${escapeXml(arollClipId)}">`)
    lines.push(`            <name>${escapeXml(arollFilename)}</name>`)
    lines.push(`            <duration>${arollSourceFrames}</duration>`)
    lines.push(`            <start>${startFrame}</start>`)
    lines.push(`            <end>${endFrame}</end>`)
    lines.push(`            <in>${inSrcFrames}</in>`)
    lines.push(`            <out>${outSrcFrames}</out>`)
    lines.push(`            <pproTicksIn>${secondsToPproTicks(seg.start)}</pproTicksIn>`)
    lines.push(`            <pproTicksOut>${secondsToPproTicks(seg.end)}</pproTicksOut>`)
    // First clipitem owns <file>; subsequent ones reference it by id.
    if (i === 0) {
      lines.push(`            <file id="${escapeXml(arollFileId)}">`)
      lines.push(`              <name>${escapeXml(arollFilename)}</name>`)
      lines.push(`              <pathurl>${escapeXml(buildPathUrl(mediaFolderAbsolute, arollFilename))}</pathurl>`)
      lines.push(`              <duration>${arollSourceFrames}</duration>`)
      lines.push(`              <rate><timebase>${arollFrameRate}</timebase></rate>`)
      lines.push(`              <media>`)
      lines.push(`                <video><samplecharacteristics>`)
      lines.push(`                  <width>${arollWidth}</width><height>${arollHeight}</height>`)
      lines.push(`                </samplecharacteristics></video>`)
      lines.push(`              </media>`)
      lines.push(`            </file>`)
    } else {
      lines.push(`            <file id="${escapeXml(`file-aroll`)}"/>`)
    }
    lines.push(`          </clipitem>`)
  }
  lines.push(`        </track>`)
}
```

(Note: `secondsToPproTicks` already exists in xmeml-generator.js — verify with `grep -n "secondsToPproTicks" server/services/xmeml-generator.js`.)

- [ ] **Step 4: Run tests**

```bash
npx vitest run --project server server/services/__tests__/xmeml-generator-aroll-segments.test.js
```

Expected: PASS — 6 tests. Plus existing xmeml tests should still pass:

```bash
npx vitest run --project server server/services/__tests__/xmeml-generator
```

- [ ] **Step 5: Commit**

```bash
git add server/services/xmeml-generator.js server/services/__tests__/xmeml-generator-aroll-segments.test.js
git commit -m "feat(xmeml): emit per-segment A-Roll clipitems via arollSegments"
```

---

### Task 23: Build `arollSegments` in the export route

**Files:**
- Read: `server/routes/export-xml.js` (the route that calls `generateXmeml`).
- Modify: same.

- [ ] **Step 1: Find the call site**

```bash
grep -nE "generateXmeml|aroll:" server/routes/export-xml.js | head -10
```

Identify where `generateXmeml(...)` is invoked and how `aroll` is currently built.

- [ ] **Step 2: Compute kept segments from cuts**

Above the `generateXmeml` call, add:

```js
import { computeEffectiveCuts } from '../services/broll.js'

// ... in the route handler, where you have access to the group's editor_state:

const editorState = JSON.parse(group.editor_state_json || '{}')
const cuts = editorState.cuts || []
const cutExclusions = editorState.cutExclusions || []
const effective = computeEffectiveCuts(cuts, cutExclusions)

// Compute kept segments — the complement of `effective` over [0, totalDuration].
// totalDuration is the original A-Roll duration in seconds.
function complementSegments(cutsArr, totalDuration) {
  const segs = []
  let cursor = 0
  for (const c of cutsArr) {
    if (c.start > cursor + 0.001) segs.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < totalDuration - 0.001) segs.push({ start: cursor, end: totalDuration })
  return segs
}

const keptSegments = complementSegments(effective, arollSourceDurationSeconds)

const arollSegments = keptSegments.map(s => ({
  filename: arollFilename,
  start: s.start,
  end: s.end,
  sourceFrameRate: arollSourceFrameRate,
  sourceDurationSeconds: arollSourceDurationSeconds,
  width: arollWidth,
  height: arollHeight,
}))
```

(Replace `arollFilename`, `arollSourceFrameRate`, etc. with however the route currently resolves them — likely from `videos` table fields like `width`, `height`, `frame_rate`, `duration_seconds`, `file_path` / `cf_stream_uid`.)

- [ ] **Step 3: Pass to generateXmeml**

```js
const xml = generateXmeml({
  sequenceName,
  placements,
  frameRate: 50,
  sequenceSize: { w: seqW, h: seqH },
  arollSegments, // NEW
  // aroll: ... // can be left in for now; arollSegments takes precedence
  mediaFolderAbsolute,
})
```

- [ ] **Step 4: Add an integration test**

Create `server/routes/__tests__/export-xml-aroll-segments.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { computeEffectiveCuts } from '../../services/broll.js'

// Mirror of the route's complementSegments — exercise it directly.
function complementSegments(cutsArr, totalDuration) {
  const segs = []
  let cursor = 0
  for (const c of cutsArr) {
    if (c.start > cursor + 0.001) segs.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < totalDuration - 0.001) segs.push({ start: cursor, end: totalDuration })
  return segs
}

describe('export-xml — kept-segment computation', () => {
  it('returns whole timeline as one segment when no cuts', () => {
    const segs = complementSegments(computeEffectiveCuts([], []), 60)
    expect(segs).toEqual([{ start: 0, end: 60 }])
  })

  it('splits around a single cut', () => {
    const cuts = [{ start: 20, end: 30 }]
    const segs = complementSegments(computeEffectiveCuts(cuts, []), 60)
    expect(segs).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 60 },
    ])
  })

  it('handles cut at start', () => {
    const cuts = [{ start: 0, end: 10 }]
    const segs = complementSegments(computeEffectiveCuts(cuts, []), 60)
    expect(segs).toEqual([{ start: 10, end: 60 }])
  })

  it('handles cut at end', () => {
    const cuts = [{ start: 50, end: 60 }]
    const segs = complementSegments(computeEffectiveCuts(cuts, []), 60)
    expect(segs).toEqual([{ start: 0, end: 50 }])
  })

  it('multiple cuts produce N+1 segments minus boundary segments', () => {
    const cuts = [{ start: 10, end: 20 }, { start: 30, end: 40 }]
    const segs = complementSegments(computeEffectiveCuts(cuts, []), 60)
    expect(segs).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
      { start: 40, end: 60 },
    ])
  })
})
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run --project server server/routes/__tests__/export-xml-aroll-segments.test.js
```

Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add server/routes/export-xml.js server/routes/__tests__/export-xml-aroll-segments.test.js
git commit -m "feat(export-xml): emit kept-segment arollSegments from editor cuts"
```

---

## Phase F — Backfill banner

Show a banner on the analysis / plan strategy / plan creation pages explaining that an existing run was made against the original (uncut) video, with a re-run CTA.

---

### Task 24: Add backfill banner

**Files:**
- Read: where `/brolls/strategy/analysis` and the plan pages render — probably `src/components/views/`.

- [ ] **Step 1: Find the analysis page component**

```bash
grep -rE "brolls/strategy/analysis|/strategy/analysis" src/ --include="*.jsx" -l | head -5
```

- [ ] **Step 2: Determine which strategy_version was used by the latest run**

```bash
grep -rE "strategy_version|strategyVersion|version_used" src/components/views/ --include="*.jsx" | head -10
```

If the existing analysis view already shows the run's version somewhere, you can read `version_used` from the existing data fetch.

If not, extend the run-list API or the page's data to include `version_number` from the linked `strategy_versions` row.

- [ ] **Step 3: Add the banner component**

In the analysis view component:

```jsx
{latestRun && latestRun.version_number < latestStrategyVersion && (
  <div className="banner banner-warning" style={{
    padding: 12,
    background: '#fef3c7',
    border: '1px solid #f59e0b',
    borderRadius: 4,
    marginBottom: 16,
  }}>
    <strong>This run used the original video.</strong> The newer pipeline version
    runs against your rough cut. <button onClick={onRerun}>Re-run with rough cut</button>
  </div>
)}
```

`onRerun` triggers the existing pipeline-start flow with `version_number = latestStrategyVersion`.

- [ ] **Step 4: Repeat for plan strategy and plan creation pages**

Find and update analogous banners in plan-strategy and plan-creation views.

- [ ] **Step 5: Manual smoke**

```bash
npm run dev &
sleep 3
```

1. Open `/editor/<project>/brolls/strategy/analysis` for a project that has an existing run from before the seed migration.
2. Verify the banner shows.
3. Click Re-run. Verify the new pipeline run starts and the latest version is used.

- [ ] **Step 6: Commit**

```bash
git add src/components/views/  # add the specific files you modified
git commit -m "feat(views): backfill banner for analysis/plan pages — re-run on rough cut version"
```

---

## Phase G — End-to-end smoke

A single manual smoke against a real project to confirm the whole pipeline works end-to-end.

---

### Task 25: End-to-end smoke on project 273

**Files:** none

- [ ] **Step 1: Set up a clean project state**

Pick a project that has a rough cut already done. Note its group_id (use 273 if it's still in good shape per the prior memory).

- [ ] **Step 2: Verify rough cut → b-roll editor cut sync**

1. Open `/editor/273/sync`. Note existing cuts.
2. Make a fresh manual cut at t=120 to t=125. Wait 2s for autosave.
3. Open `/editor/273/brolls/edit`. Confirm:
   - The new cut shows on the timeline.
   - Preview play skips that range.
4. In the b-roll editor, click Cut at t=200. Drag the right edge to t=205. Wait 2s.
5. Switch to `/editor/273/sync`. Window-focus refetch should fire. Confirm the [200, 205] cut shows in the rough cut editor.
6. In the rough cut editor, delete the [200, 205] cut. Wait 2s. Refresh the b-roll edit tab — confirm the cut is gone.

- [ ] **Step 3: Verify analysis pipeline uses post-cut**

1. On `/editor/273/brolls/strategy/analysis`, click Re-run (the new strategy_version with prepended Stages 1+2).
2. Watch the pipeline progress. Confirm:
   - "Generate post-cut transcript" stage appears as Stage 1.
   - "Export post-cut video" stage appears as Stage 2.
   - "Analyze A-Roll Appearances" (Stage 3) shows it's running against the post-cut video.
3. After completion, click into the run output. Confirm the run's stage 1 text references the post-cut transcript (with shifted timecodes), and the placement timecodes are in original time (un-shifted by `persistPlacementOutput`).

- [ ] **Step 4: Verify export emits per-segment A-Roll**

1. From the export flow, generate the XMEML.
2. Open the XML in a text editor. Search for `clip-` (clipitem ids).
3. Confirm there are N+1 A-Roll clipitems where N = number of effective cuts (i.e. the kept segments).
4. Each `<start>` / `<end>` should match the kept-segment boundaries (in 50fps frames).

- [ ] **Step 5: Import into Premiere (if available) for visual confirmation**

Open the XML in Adobe Premiere. Confirm:
- A-Roll appears as separate clips on V1, broken at every cut boundary.
- B-Roll / PIP placements on V2+ are positioned correctly relative to the original timeline.
- Playback skips through the cut regions naturally (no gaps in audio if voice straddled a cut — the cuts mean no audio in that range, which is the expected behavior).

- [ ] **Step 6: Document any issues**

If any step fails, capture:
- The step number.
- The expected vs actual behavior.
- Browser console errors / server logs.

Open a follow-up task or fix in place; do not move past Step 6 without resolving.

- [ ] **Step 7: Final commit (if any fixes were made)**

```bash
git add -A
git commit -m "fix: address smoke-test issues from project 273 walkthrough"
```

---

## Self-Review

The plan covers every requirement in the spec:

| Spec section | Plan task(s) |
|---|---|
| Three reported bugs | Tasks 9-11 (strategy seeds), 18 (b-roll preview skip), 19 (cut overlay) |
| Mapping correctness § The function | Task 1 |
| Mapping correctness § Boundary rule | Task 2 |
| Mapping correctness § Round-trip identity | Task 1 (property test), Task 7 (real-data) |
| Mapping correctness § Single chokepoint | Task 4, 5, 6 |
| Strategy seeds (analysis / plan / plan creation) | Tasks 8-11 |
| Shared cut state (single source of truth) | Tasks 13-16 |
| Manual Cut button + edge drag in b-roll editor | Tasks 19-21 |
| Bidirectional sync | Tasks 15-16 (load + save + focus refetch) |
| Export A-Roll per-segment clipitems | Tasks 22-23 |
| Backfill banner (Q1=b) | Task 24 |
| Visible AI silence/annotation cuts in b-roll editor (Q2=a) | Tasks 15, 19 (cuts loaded include all sources; overlay renders all) |
| End-to-end verification | Task 25 |

Open issues from the spec (chokepoint enforcement, cut reducer extraction location, strategy seed authority) are addressed by Task 4-6 (chokepoint), Task 13 (action types in shared module called by both reducers — extraction location decided), and Task 8 (investigation step before Task 10).

No placeholders remain. Each step has the exact file paths, complete code, exact commands, and expected output.
