# Slip-Edit + Source-Clamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `source_in_seconds` slip-edit + source-duration clamp to b-roll placements; expose a double-click inline panel for users to slip the source within a placement's fixed slot.

**Architecture:** Client-side Pass 4 in the reducer auto-clamps `timelineEnd` against probed source duration. Slip and toggle actions write to per-placement `edits[uuid]` via the existing APPLY_ACTION/undo infrastructure. `BRollSlipPanel` is a new inline-expansion UI rendered below the double-clicked placement; it owns the source-strip + drag interaction and calls back into the editor state. XMEML generator reads the new fields to emit correct `<in>/<out>`.

**Tech Stack:** React + vitest (web), node + vitest (server), reducer pattern with undo/redo, existing edits-by-uuid persistence, XMEML v5 generator.

**Spec reference:** `docs/superpowers/specs/2026-05-15-slip-edit-and-source-clamp-design.md`

---

## File Structure

**Client (`src/components/editor/`):**
- `brollReducer.js` — add `PROBE_DATA_RECEIVED` case (modify)
- `brollUtils.js` — `matchPlacementsToTranscript` reads new edit fields (modify)
- `useBRollEditorState.js` — add `slipPlacement` and `toggleKeepOriginal` action creators; wire probe-data ingestion (modify)
- `BRollSlipPanel.jsx` — new component (create)
- `BRollTrack.jsx` — add double-click expansion + badges (modify)
- `__tests__/brollReducer.slip.test.js` — reducer tests (create)
- `__tests__/brollUtils.slip.test.js` — resolve tests (create)
- `__tests__/BRollSlipPanel.test.jsx` — component tests (create)
- `__tests__/BRollTrack-slip.test.jsx` — double-click + badges (create)

**Server (`server/services/`):**
- `xmeml-generator.js` — read `source_in_seconds`, `keep_original_duration`, `original_timeline_duration` (modify)
- `exports.js` — telemetry enum mirror (modify)
- `__tests__/xmeml-generator.slip.test.js` — XMEML tests (create)

**Extension (`extension/`):**
- `config.js` — add slip telemetry events to `TELEMETRY_EVENT_ENUM` (modify)

---

## Conventions

- All edits live in `state.edits[placement.uuid]`. The four new fields are:
  - `source_in_seconds: number` (default 0)
  - `keep_original_duration: boolean` (default false)
  - `original_timeline_duration: number` (auto-set by Pass 4 on first clamp)
  - `auto_clamp_applied: boolean` (set true by Pass 4)
- User-initiated mutations use the existing `APPLY_ACTION` / `APPLY_ACTION_COALESCE` infrastructure for undo support. Automated mutations (Pass 4) use new direct reducer cases that bypass undo.
- Test pattern follows `src/components/editor/__tests__/brollReducer.test.js`: `import { describe, it, expect } from 'vitest'`.
- Run web tests: `npm test -- --project=web`. Server: `--project=server`.

---

## Task 1: Add `PROBE_DATA_RECEIVED` reducer case (Pass 4)

**Files:**
- Modify: `src/components/editor/brollReducer.js` (add case to `reducer` switch starting at line 162)
- Test: `src/components/editor/__tests__/brollReducer.slip.test.js` (create)

- [ ] **Step 1: Write failing tests**

Create `src/components/editor/__tests__/brollReducer.slip.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { reducer, initialState } from '../brollReducer.js'

describe('reducer PROBE_DATA_RECEIVED', () => {
  it('clamps timelineEnd when source is shorter than placement', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ uuid: 'p1', timelineStart: 10, timelineEnd: 17 }],
      edits: {},
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'p1', durationSeconds: 6.17, timelineDuration: 7.0 },
    })
    expect(next.edits.p1.original_timeline_duration).toBe(7.0)
    expect(next.edits.p1.auto_clamp_applied).toBe(true)
    expect(next.edits.p1.timelineEnd).toBeCloseTo(16.17, 3)
  })

  it('does not clamp when source is longer than placement', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ uuid: 'p1', timelineStart: 10, timelineEnd: 13 }],
      edits: {},
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'p1', durationSeconds: 10.0, timelineDuration: 3.0 },
    })
    expect(next.edits.p1?.auto_clamp_applied).toBeFalsy()
    expect(next.edits.p1?.timelineEnd).toBeUndefined()
    expect(next.edits.p1?.original_timeline_duration).toBe(3.0)
  })

  it('does not clamp when keep_original_duration is already true', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ uuid: 'p1', timelineStart: 10, timelineEnd: 17 }],
      edits: { p1: { keep_original_duration: true } },
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'p1', durationSeconds: 6.17, timelineDuration: 7.0 },
    })
    expect(next.edits.p1.timelineEnd).toBeUndefined()
    expect(next.edits.p1.auto_clamp_applied).toBeFalsy()
  })

  it('preserves original_timeline_duration across repeated probe updates', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ uuid: 'p1', timelineStart: 10, timelineEnd: 17 }],
      edits: { p1: { original_timeline_duration: 7.0, auto_clamp_applied: true, timelineEnd: 16.17 } },
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'p1', durationSeconds: 5.0, timelineDuration: 7.0 },
    })
    expect(next.edits.p1.original_timeline_duration).toBe(7.0)
    expect(next.edits.p1.timelineEnd).toBeCloseTo(15.0, 3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollReducer.slip`
Expected: FAIL — no `PROBE_DATA_RECEIVED` case (default branch returns state unchanged).

- [ ] **Step 3: Add the case**

In `src/components/editor/brollReducer.js`, add the case immediately before `case 'SAVE_SUCCESS':`:

```js
    case 'PROBE_DATA_RECEIVED': {
      const { uuid, durationSeconds, timelineDuration } = action.payload
      if (!uuid || typeof durationSeconds !== 'number' || typeof timelineDuration !== 'number') return state
      const prev = state.edits[uuid] || {}
      const next = { ...prev }
      // Always record the pre-clamp duration on first probe
      if (next.original_timeline_duration == null) {
        next.original_timeline_duration = timelineDuration
      }
      // Only clamp when not explicitly opted out
      if (!next.keep_original_duration && durationSeconds < timelineDuration) {
        // edits.timelineEnd is consumed by matchPlacementsToTranscript to override resolved duration
        const placement = state.rawPlacements.find(p => p.uuid === uuid)
        const tStart = placement?.timelineStart ?? 0
        next.timelineEnd = tStart + durationSeconds
        next.auto_clamp_applied = true
      }
      // No structural change if nothing was added
      if (Object.keys(next).length === 0) return state
      return { ...state, edits: { ...state.edits, [uuid]: next }, dirty: true }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollReducer.slip`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/brollReducer.js src/components/editor/__tests__/brollReducer.slip.test.js
git commit -m "feat(editor): add PROBE_DATA_RECEIVED reducer case for source-duration clamp"
```

---

## Task 2: Add `TOGGLE_KEEP_ORIGINAL` reducer behavior

**Files:**
- Modify: `src/components/editor/brollReducer.js` (extend existing logic — toggle uses APPLY_ACTION with editsSlot patches; add helper that produces the correct before/after patches)
- Test: `src/components/editor/__tests__/brollReducer.slip.test.js` (extend)

The toggle is a user action and must go through the existing APPLY_ACTION undo path. The complexity is the restore behavior when toggling on→off (re-clamp) vs off→on (restore original duration).

- [ ] **Step 1: Write failing tests**

Append to `src/components/editor/__tests__/brollReducer.slip.test.js`:

```js
import { buildToggleKeepOriginalEntry } from '../brollReducer.js'

describe('buildToggleKeepOriginalEntry', () => {
  it('off→on restores original_timeline_duration into timelineEnd', () => {
    const placement = { uuid: 'p1', timelineStart: 10, timelineEnd: 16.17 }
    const currentEdits = { auto_clamp_applied: true, original_timeline_duration: 7.0, timelineEnd: 16.17 }
    const entry = buildToggleKeepOriginalEntry({ placement, currentEdits, nextValue: true })
    expect(entry.placementKey).toBe('p1')
    expect(entry.after.editsSlot.keep_original_duration).toBe(true)
    expect(entry.after.editsSlot.timelineEnd).toBeCloseTo(17.0, 3)
    expect(entry.after.editsSlot.auto_clamp_applied).toBe(false)
    expect(entry.before.editsSlot.keep_original_duration).toBeUndefined()
    expect(entry.before.editsSlot.timelineEnd).toBeCloseTo(16.17, 3)
    expect(entry.before.editsSlot.auto_clamp_applied).toBe(true)
  })

  it('on→off re-clamps using sourceDurationSeconds', () => {
    const placement = { uuid: 'p1', timelineStart: 10, timelineEnd: 17 }
    const currentEdits = { keep_original_duration: true, original_timeline_duration: 7.0 }
    const entry = buildToggleKeepOriginalEntry({
      placement,
      currentEdits,
      nextValue: false,
      sourceDurationSeconds: 6.17,
    })
    expect(entry.after.editsSlot.keep_original_duration).toBe(false)
    expect(entry.after.editsSlot.timelineEnd).toBeCloseTo(16.17, 3)
    expect(entry.after.editsSlot.auto_clamp_applied).toBe(true)
  })

  it('on→off with longer source removes clamp (no timelineEnd override)', () => {
    const placement = { uuid: 'p1', timelineStart: 10, timelineEnd: 17 }
    const currentEdits = { keep_original_duration: true, original_timeline_duration: 7.0 }
    const entry = buildToggleKeepOriginalEntry({
      placement,
      currentEdits,
      nextValue: false,
      sourceDurationSeconds: 20.0,
    })
    expect(entry.after.editsSlot.keep_original_duration).toBe(false)
    expect(entry.after.editsSlot.timelineEnd).toBeUndefined()
    expect(entry.after.editsSlot.auto_clamp_applied).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollReducer.slip`
Expected: FAIL — `buildToggleKeepOriginalEntry` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/components/editor/brollReducer.js`, add near the top after the other exported helpers (around line 87, before `applyMutation`):

```js
export function buildToggleKeepOriginalEntry({ placement, currentEdits, nextValue, sourceDurationSeconds }) {
  const tStart = placement.timelineStart ?? 0
  const originalDuration = currentEdits.original_timeline_duration
  let nextTimelineEnd
  let nextAutoClamp
  if (nextValue === true) {
    // off → on: restore original duration
    nextTimelineEnd = originalDuration != null ? tStart + originalDuration : undefined
    nextAutoClamp = false
  } else {
    // on → off: re-apply clamp if source is shorter than original
    if (originalDuration != null && sourceDurationSeconds != null && sourceDurationSeconds < originalDuration) {
      nextTimelineEnd = tStart + sourceDurationSeconds
      nextAutoClamp = true
    } else {
      nextTimelineEnd = undefined
      nextAutoClamp = false
    }
  }
  return {
    id: generateActionId(),
    ts: Date.now(),
    kind: 'toggle-keep-original',
    placementKey: placement.uuid,
    before: {
      editsSlot: {
        keep_original_duration: currentEdits.keep_original_duration,
        timelineEnd: currentEdits.timelineEnd,
        auto_clamp_applied: currentEdits.auto_clamp_applied,
      },
    },
    after: {
      editsSlot: {
        keep_original_duration: nextValue,
        timelineEnd: nextTimelineEnd,
        auto_clamp_applied: nextAutoClamp,
      },
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollReducer.slip`
Expected: PASS (3 new tests pass; 4 from Task 1 still pass)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/brollReducer.js src/components/editor/__tests__/brollReducer.slip.test.js
git commit -m "feat(editor): add buildToggleKeepOriginalEntry helper for keep-original toggle"
```

---

## Task 3: Add `buildSlipEntry` helper for slip drag commits

**Files:**
- Modify: `src/components/editor/brollReducer.js`
- Test: `src/components/editor/__tests__/brollReducer.slip.test.js` (extend)

- [ ] **Step 1: Write failing tests**

Append to `src/components/editor/__tests__/brollReducer.slip.test.js`:

```js
import { buildSlipEntry } from '../brollReducer.js'

describe('buildSlipEntry', () => {
  it('produces APPLY_ACTION entry with new source_in_seconds', () => {
    const placement = { uuid: 'p1' }
    const currentEdits = { source_in_seconds: 0 }
    const entry = buildSlipEntry({ placement, currentEdits, nextSourceIn: 1.5 })
    expect(entry.placementKey).toBe('p1')
    expect(entry.kind).toBe('slip')
    expect(entry.before.editsSlot.source_in_seconds).toBe(0)
    expect(entry.after.editsSlot.source_in_seconds).toBe(1.5)
  })

  it('encodes undefined previous source_in as 0', () => {
    const placement = { uuid: 'p1' }
    const currentEdits = {}
    const entry = buildSlipEntry({ placement, currentEdits, nextSourceIn: 0.75 })
    expect(entry.before.editsSlot.source_in_seconds).toBe(0)
  })

  it('clamps nextSourceIn to non-negative', () => {
    const placement = { uuid: 'p1' }
    const entry = buildSlipEntry({ placement, currentEdits: {}, nextSourceIn: -0.5 })
    expect(entry.after.editsSlot.source_in_seconds).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollReducer.slip`
Expected: FAIL — `buildSlipEntry` not exported.

- [ ] **Step 3: Implement the helper**

In `src/components/editor/brollReducer.js`, add immediately after `buildToggleKeepOriginalEntry`:

```js
export function buildSlipEntry({ placement, currentEdits, nextSourceIn }) {
  const safeNext = Math.max(0, nextSourceIn)
  return {
    id: generateActionId(),
    ts: Date.now(),
    kind: 'slip',
    placementKey: placement.uuid,
    before: { editsSlot: { source_in_seconds: currentEdits.source_in_seconds ?? 0 } },
    after:  { editsSlot: { source_in_seconds: safeNext } },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollReducer.slip`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/brollReducer.js src/components/editor/__tests__/brollReducer.slip.test.js
git commit -m "feat(editor): add buildSlipEntry helper for slip-edit commits"
```

---

## Task 4: Pass `source_in_seconds` through `matchPlacementsToTranscript`

**Files:**
- Modify: `src/components/editor/brollUtils.js` (around line 35–88)
- Test: `src/components/editor/__tests__/brollUtils.slip.test.js` (create)

Currently `matchPlacementsToTranscript` returns resolved placements with `timelineStart`, `timelineEnd`, `timelineDuration`. We need to also propagate `source_in_seconds`, `keep_original_duration`, `original_timeline_duration`, and `auto_clamp_applied` from the edit slot into the resolved placement (consumers like XMEML and the slip panel need these on the resolved object).

- [ ] **Step 1: Write failing tests**

Create `src/components/editor/__tests__/brollUtils.slip.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { matchPlacementsToTranscript } from '../brollUtils.js'

describe('matchPlacementsToTranscript slip fields', () => {
  const placement = {
    uuid: 'p1',
    chapterIndex: 0,
    placementIndex: 0,
    start: '00:00:10:00',
    end: '00:00:17:00',
    audio_anchor: '',
  }

  it('propagates source_in_seconds from edits to resolved placement', () => {
    const edits = { p1: { source_in_seconds: 1.5 } }
    const [resolved] = matchPlacementsToTranscript([placement], [], edits)
    expect(resolved.source_in_seconds).toBe(1.5)
  })

  it('propagates keep_original_duration and original_timeline_duration', () => {
    const edits = { p1: { keep_original_duration: true, original_timeline_duration: 7.0 } }
    const [resolved] = matchPlacementsToTranscript([placement], [], edits)
    expect(resolved.keep_original_duration).toBe(true)
    expect(resolved.original_timeline_duration).toBe(7.0)
  })

  it('propagates auto_clamp_applied', () => {
    const edits = { p1: { auto_clamp_applied: true, timelineEnd: 16.17 } }
    const [resolved] = matchPlacementsToTranscript([placement], [], edits)
    expect(resolved.auto_clamp_applied).toBe(true)
    expect(resolved.timelineEnd).toBeCloseTo(16.17, 3)
  })

  it('defaults source_in_seconds to 0 when not in edits', () => {
    const [resolved] = matchPlacementsToTranscript([placement], [], {})
    expect(resolved.source_in_seconds).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollUtils.slip`
Expected: FAIL — resolved placements do not currently carry these fields.

- [ ] **Step 3: Update `matchPlacementsToTranscript`**

In `src/components/editor/brollUtils.js`, in the `.map` block at line 66 (and the fallback that creates resolved entries), spread the slip fields onto the returned object. Add this helper before the `.map`:

```js
const slipFieldsFrom = (edit) => ({
  source_in_seconds: edit?.source_in_seconds ?? 0,
  keep_original_duration: edit?.keep_original_duration ?? false,
  original_timeline_duration: edit?.original_timeline_duration,
  auto_clamp_applied: edit?.auto_clamp_applied ?? false,
})
```

Then, in every return statement within `.map` (the three branches: edit-override, no-anchor, anchor-matched), add `...slipFieldsFrom(edit)` to the returned object. Example (edit-override branch at line 71–78):

```js
    if (uStart != null && uEnd != null) {
      return {
        ...p,
        timelineStart: uStart,
        timelineEnd: uEnd,
        timelineDuration: uEnd - uStart,
        ...slipFieldsFrom(edit),
      }
    }
```

Apply the same `...slipFieldsFrom(edit)` to the other return paths in the same `.map`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollUtils.slip`
Expected: PASS (4/4)

Then run the full editor test suite to confirm no regressions:

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run brollReducer brollUtils brollResolve`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/brollUtils.js src/components/editor/__tests__/brollUtils.slip.test.js
git commit -m "feat(editor): propagate slip fields from edits into resolved placements"
```

---

## Task 5: XMEML generator reads new fields

**Files:**
- Modify: `server/services/xmeml-generator.js` (the b-roll `<in>`/`<out>` calculation, near the existing `_videoEditListOffsetFrames` logic)
- Test: `server/services/__tests__/xmeml-generator.slip.test.js` (create)

- [ ] **Step 1: Read current b-roll emit code**

Open `server/services/xmeml-generator.js` and locate where b-roll `<in>` / `<out>` are computed. Per the spec and prior FPS-probe work, this is around line 307 (per-placement `sourceFrameRate` override) and line 600+ (where `tcOffset`, `inFrame`, `outFrame` are built). Capture the exact variable names being used so the patch matches surrounding style.

- [ ] **Step 2: Write failing tests**

Create `server/services/__tests__/xmeml-generator.slip.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { generateXmeml } from '../xmeml-generator.js'

function basePlacement(overrides = {}) {
  return {
    seq: 1,
    filename: 'pexels_test.mp4',
    timelineStart: 10,
    timelineDuration: 5.0,
    source: 'pexels',
    sourceItemId: 'pex_1',
    sourceFrameRate: 29.97,
    sourceDurationSeconds: 10.0,
    width: 1920,
    height: 1080,
    ...overrides,
  }
}

function extractInOut(xml, filename) {
  const seg = xml.split(filename)[1] || ''
  const inMatch = seg.match(/<in>(-?\d+)<\/in>/)
  const outMatch = seg.match(/<out>(-?\d+)<\/out>/)
  return { in: Number(inMatch?.[1]), out: Number(outMatch?.[1]) }
}

describe('generateXmeml slip-edit + clamp', () => {
  it('source_in_seconds = 1.5 shifts <in> by 1.5 * sourceFps frames', () => {
    const xml = generateXmeml({
      sequenceFrameRate: 50,
      placements: [basePlacement({ source_in_seconds: 1.5 })],
      arollClips: [],
    })
    const { in: inF, out: outF } = extractInOut(xml, 'pexels_test.mp4')
    expect(inF).toBe(Math.round(1.5 * 29.97))
    expect(outF - inF).toBe(Math.round(5.0 * 29.97))
  })

  it('keep_original_duration=true emits <out> past source end (with warning)', () => {
    const placement = basePlacement({
      timelineDuration: 7.0,
      sourceDurationSeconds: 6.17,
      keep_original_duration: true,
      original_timeline_duration: 7.0,
    })
    const { xml, warnings } = generateXmeml({
      sequenceFrameRate: 50,
      placements: [placement],
      arollClips: [],
    }, { returnWarnings: true })
    const { in: inF, out: outF } = extractInOut(xml, 'pexels_test.mp4')
    expect(outF - inF).toBe(Math.round(7.0 * 29.97))
    expect(warnings.some(w => w.includes('source ends before placement'))).toBe(true)
  })

  it('clamp default: source shorter than placement uses min', () => {
    const placement = basePlacement({
      timelineDuration: 7.0,
      sourceDurationSeconds: 6.17,
    })
    const xml = generateXmeml({
      sequenceFrameRate: 50,
      placements: [placement],
      arollClips: [],
    })
    const { in: inF, out: outF } = extractInOut(xml, 'pexels_test.mp4')
    expect(outF - inF).toBeLessThanOrEqual(Math.round(6.17 * 29.97))
  })

  it('source_in combined with elst offset adds both', () => {
    const placement = basePlacement({
      source_in_seconds: 1.0,
      videoEditListMediaTimeSeconds: 0.067, // ~2 frames at 29.97
    })
    const xml = generateXmeml({
      sequenceFrameRate: 50,
      placements: [placement],
      arollClips: [],
    })
    const { in: inF } = extractInOut(xml, 'pexels_test.mp4')
    expect(inF).toBe(Math.round(1.0 * 29.97) + Math.round(0.067 * 29.97))
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=server --run xmeml-generator.slip`
Expected: FAIL — `source_in_seconds` is not yet consumed.

- [ ] **Step 4: Update the generator**

In `server/services/xmeml-generator.js`, locate the b-roll `<in>` / `<out>` computation block. Update it to:

```js
const sourceInSeconds = Math.max(0, p.source_in_seconds || 0)
const sourceInFrames = Math.round(sourceInSeconds * sourceFrameRate)
const embeddedTcFrames = parseEmbeddedTimecodeToFrames(p.embeddedTimecode, sourceFrameRate) || 0
const elstOffsetFrames = Math.round((p.videoEditListMediaTimeSeconds || 0) * sourceFrameRate)
const tcOffset = embeddedTcFrames + elstOffsetFrames

const sourceDur = typeof p.sourceDurationSeconds === 'number' ? p.sourceDurationSeconds : null
const requestedDuration = p.keep_original_duration
  ? (p.original_timeline_duration ?? p.timelineDuration)
  : (sourceDur != null
      ? Math.min(p.timelineDuration, Math.max(0, sourceDur - sourceInSeconds))
      : p.timelineDuration)

const durationFrames = Math.round(requestedDuration * sourceFrameRate)
const inFrame  = tcOffset + sourceInFrames
const outFrame = inFrame + durationFrames

if (p.keep_original_duration && sourceDur != null && sourceInSeconds + (p.original_timeline_duration ?? p.timelineDuration) > sourceDur) {
  warnings.push(`Placement ${p.seq || p.filename} source ends before placement; DaVinci will go black for ${(sourceInSeconds + (p.original_timeline_duration ?? p.timelineDuration) - sourceDur).toFixed(2)}s`)
}
```

Also adjust the `<end>` calculation to reflect clamped duration when applicable:
```js
const effectiveTimelineDuration = requestedDuration
const sequenceEndFrame = Math.round(p.timelineStart * sequenceFrameRate) + Math.round(effectiveTimelineDuration * sequenceFrameRate)
```

Use this `sequenceEndFrame` where `<end>` is emitted.

Adapt `generateXmeml`'s signature to optionally return warnings:
```js
export function generateXmeml(input, options = {}) {
  // ... existing logic ...
  const warnings = []
  // ... emit logic builds warnings as above ...
  return options.returnWarnings ? { xml, warnings } : xml
}
```

If the function already returns a string, this becomes a backward-compatible additive change. If `parseEmbeddedTimecodeToFrames` does not exist, find the equivalent in the current generator and reuse its name.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=server --run xmeml-generator`
Expected: PASS (4 new tests pass; existing xmeml tests still pass).

- [ ] **Step 6: Commit**

```bash
git add server/services/xmeml-generator.js server/services/__tests__/xmeml-generator.slip.test.js
git commit -m "feat(xmeml): emit slip-aware <in>/<out> and clamp <end> to source duration"
```

---

## Task 6: Telemetry event allowlist

**Files:**
- Modify: `extension/config.js` (`TELEMETRY_EVENT_ENUM`)
- Modify: `server/services/exports.js` (mirror — find the matching set/array)

- [ ] **Step 1: Add events to extension config**

In `extension/config.js`, find `TELEMETRY_EVENT_ENUM` and add (preserve existing entries):

```js
  'slip_panel_opened',
  'slip_committed',
  'keep_original_toggled',
  'auto_clamp_applied',
```

- [ ] **Step 2: Add events to server mirror**

In `server/services/exports.js`, find the corresponding telemetry-event allowlist (same shape as extension's enum) and append the same four event names.

- [ ] **Step 3: Verify alignment**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && grep -c "slip_panel_opened\|slip_committed\|keep_original_toggled\|auto_clamp_applied" extension/config.js server/services/exports.js`
Expected: both files report `4` (4 matches each).

- [ ] **Step 4: Commit**

```bash
git add extension/config.js server/services/exports.js
git commit -m "feat(telemetry): allowlist slip-edit and clamp events"
```

---

## Task 7: `BRollSlipPanel` component — skeleton

**Files:**
- Create: `src/components/editor/BRollSlipPanel.jsx`
- Create: `src/components/editor/__tests__/BRollSlipPanel.test.jsx`

- [ ] **Step 1: Write failing tests**

Create `src/components/editor/__tests__/BRollSlipPanel.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import BRollSlipPanel from '../BRollSlipPanel.jsx'

const placement = {
  uuid: 'p1',
  filename: 'test.mp4',
  timelineStart: 10,
  timelineDuration: 5.0,
  source_in_seconds: 1.0,
  keep_original_duration: false,
  original_timeline_duration: 5.0,
  sourceDurationSeconds: 12.0,
  sourceFrameRate: 29.97,
}

describe('BRollSlipPanel rendering', () => {
  it('renders a source strip with width representing full source duration', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const strip = screen.getByTestId('slip-source-strip')
    expect(strip).toBeTruthy()
    // Strip data attribute carries the source duration so tests can assert without pixel math
    expect(strip.dataset.sourceDuration).toBe('12')
  })

  it('renders a green window at source_in_seconds → source_in_seconds+duration', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const window = screen.getByTestId('slip-green-window')
    expect(window.dataset.windowStart).toBe('1')
    expect(window.dataset.windowEnd).toBe('6')
  })

  it('renders Keep original duration checkbox reflecting current state', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const cb = screen.getByLabelText(/keep original duration/i)
    expect(cb).toBeTruthy()
    expect(cb.checked).toBe(false)
  })

  it('renders Reset button', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /reset/i })).toBeTruthy()
  })
})
```

If `@testing-library/react` isn't already in the project devDeps, see what other tests in `src/components/editor/__tests__/*.test.jsx` use — match their import style. (`BRollPreloadPool.test.jsx` is a good reference.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollSlipPanel`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the component**

Create `src/components/editor/BRollSlipPanel.jsx`:

```jsx
import { useMemo } from 'react'

const MIN_PANEL_WIDTH = 480

export default function BRollSlipPanel({
  placement,
  onSlipChange,
  onClampToggle,
  onPreviewSeek,
  onReset,
  onClose,
}) {
  const sourceDur = placement.sourceDurationSeconds || 0
  const sourceIn = placement.source_in_seconds ?? 0
  const effectiveDuration = placement.keep_original_duration
    ? (placement.original_timeline_duration ?? placement.timelineDuration)
    : Math.min(placement.timelineDuration, Math.max(0, sourceDur - sourceIn))

  const windowStart = sourceIn
  const windowEnd = sourceIn + effectiveDuration
  const windowStartPct = sourceDur > 0 ? (windowStart / sourceDur) * 100 : 0
  const windowEndPct = sourceDur > 0 ? (Math.min(windowEnd, sourceDur) / sourceDur) * 100 : 0
  const overflowsRight = windowEnd > sourceDur

  return (
    <div className="broll-slip-panel" style={{ minWidth: MIN_PANEL_WIDTH }}>
      <div
        className="slip-source-strip"
        data-testid="slip-source-strip"
        data-source-duration={String(sourceDur)}
        style={{ position: 'relative', height: 48, background: '#222' }}
      >
        <div
          className="slip-green-window"
          data-testid="slip-green-window"
          data-window-start={String(windowStart)}
          data-window-end={String(windowEnd)}
          style={{
            position: 'absolute',
            left: `${windowStartPct}%`,
            width: `${windowEndPct - windowStartPct}%`,
            top: 0, bottom: 0,
            background: 'rgba(0, 230, 100, 0.35)',
            outline: '1px solid rgba(0, 230, 100, 0.9)',
          }}
        />
        {overflowsRight && (
          <div
            className="slip-overflow-stripe"
            data-testid="slip-overflow-stripe"
            style={{
              position: 'absolute',
              left: `${(sourceDur / sourceDur) * 100}%`,
              width: `${Math.min(20, ((windowEnd - sourceDur) / sourceDur) * 100)}%`,
              top: 0, bottom: 0,
              background: 'repeating-linear-gradient(45deg, rgba(255,0,0,0.4) 0 6px, transparent 6px 12px)',
            }}
          />
        )}
      </div>
      <div className="slip-controls" style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
        <label>
          <input
            type="checkbox"
            checked={!!placement.keep_original_duration}
            onChange={(e) => onClampToggle(e.target.checked)}
          />
          {' '}Keep original duration
        </label>
        <button type="button" onClick={onReset}>Reset</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollSlipPanel`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollSlipPanel.jsx src/components/editor/__tests__/BRollSlipPanel.test.jsx
git commit -m "feat(editor): add BRollSlipPanel skeleton with source strip and controls"
```

---

## Task 8: Slip drag interaction

**Files:**
- Modify: `src/components/editor/BRollSlipPanel.jsx`
- Modify: `src/components/editor/__tests__/BRollSlipPanel.test.jsx`

- [ ] **Step 1: Write failing test**

Append to `src/components/editor/__tests__/BRollSlipPanel.test.jsx`:

```jsx
import { fireEvent } from '@testing-library/react'

describe('BRollSlipPanel drag interaction', () => {
  it('mouse-drag on green window calls onPreviewSeek (throttled) and onSlipChange on mouseup', () => {
    const onSlipChange = vi.fn()
    const onPreviewSeek = vi.fn()
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={onSlipChange}
        onClampToggle={() => {}}
        onPreviewSeek={onPreviewSeek}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const window = screen.getByTestId('slip-green-window')
    const strip = screen.getByTestId('slip-source-strip')
    // Mock getBoundingClientRect so px math is deterministic.
    strip.getBoundingClientRect = () => ({ left: 0, width: 1200, right: 1200, top: 0, bottom: 48, height: 48 })

    fireEvent.mouseDown(window, { clientX: 200 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document, { clientX: 300 })

    // Source duration = 12s; 1200px wide; drag delta = +100px = +1s
    expect(onSlipChange).toHaveBeenCalledTimes(1)
    const newSourceIn = onSlipChange.mock.calls[0][0]
    expect(newSourceIn).toBeCloseTo(1.0 + 1.0, 2) // started at sourceIn=1, dragged +1s
  })

  it('respects upper bound: source_in <= sourceDur - effectiveDuration when clamp on', () => {
    const onSlipChange = vi.fn()
    render(
      <BRollSlipPanel
        placement={{ ...placement, source_in_seconds: 6 }}
        onSlipChange={onSlipChange}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const win = screen.getByTestId('slip-green-window')
    const strip = screen.getByTestId('slip-source-strip')
    strip.getBoundingClientRect = () => ({ left: 0, width: 1200, right: 1200, top: 0, bottom: 48, height: 48 })

    fireEvent.mouseDown(win, { clientX: 600 })
    fireEvent.mouseMove(document, { clientX: 1100 }) // big right-drag past end
    fireEvent.mouseUp(document, { clientX: 1100 })

    const finalIn = onSlipChange.mock.calls[0][0]
    // sourceDur=12, effectiveDuration=5 → max sourceIn = 7
    expect(finalIn).toBeLessThanOrEqual(7)
  })
})
```

Add `import { vi } from 'vitest'` to the top of the test file if not present.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollSlipPanel`
Expected: FAIL — no drag handling yet.

- [ ] **Step 3: Implement drag handling**

Update `src/components/editor/BRollSlipPanel.jsx` to add mouse-drag handlers on the green window. Use a `useRef` to hold drag state and `useEffect` to attach document-level mousemove/mouseup listeners while dragging.

```jsx
import { useEffect, useMemo, useRef, useState } from 'react'

// ... inside component, before the return:

const stripRef = useRef(null)
const dragStateRef = useRef(null)
const [, force] = useState(0) // force re-render during drag

// Throttled preview seek via rAF
const previewSeekRef = useRef(null)
const scheduleSeek = (absSec) => {
  previewSeekRef.current = absSec
  if (!scheduleSeek.rafQueued) {
    scheduleSeek.rafQueued = true
    requestAnimationFrame(() => {
      scheduleSeek.rafQueued = false
      onPreviewSeek(previewSeekRef.current)
    })
  }
}

const onWindowMouseDown = (e) => {
  e.preventDefault()
  const rect = stripRef.current?.getBoundingClientRect()
  if (!rect) return
  const pxPerSecond = rect.width / sourceDur
  dragStateRef.current = {
    startClientX: e.clientX,
    startSourceIn: sourceIn,
    pxPerSecond,
    maxSourceIn: placement.keep_original_duration
      ? Math.max(0, sourceDur - (1 / (placement.sourceFrameRate || 30))) // at least 1 frame visible
      : Math.max(0, sourceDur - effectiveDuration),
    currentSourceIn: sourceIn,
  }
  document.addEventListener('mousemove', onDocMouseMove)
  document.addEventListener('mouseup', onDocMouseUp, { once: true })
}

const onDocMouseMove = (e) => {
  const ds = dragStateRef.current
  if (!ds) return
  const deltaPx = e.clientX - ds.startClientX
  const deltaSec = deltaPx / ds.pxPerSecond
  const proposed = ds.startSourceIn + deltaSec
  // Snap to source frames
  const fps = placement.sourceFrameRate || 30
  const snapped = Math.round(proposed * fps) / fps
  const clamped = Math.max(0, Math.min(ds.maxSourceIn, snapped))
  ds.currentSourceIn = clamped
  scheduleSeek(clamped) // preview shows the new in-point
  force((v) => v + 1)
}

const onDocMouseUp = () => {
  document.removeEventListener('mousemove', onDocMouseMove)
  const ds = dragStateRef.current
  if (!ds) return
  if (ds.currentSourceIn !== ds.startSourceIn) {
    onSlipChange(ds.currentSourceIn)
  }
  dragStateRef.current = null
}

useEffect(() => {
  return () => {
    document.removeEventListener('mousemove', onDocMouseMove)
  }
}, [])

// Use dragStateRef.current?.currentSourceIn (if dragging) for live display:
const displaySourceIn = dragStateRef.current?.currentSourceIn ?? sourceIn
```

Then replace the `<div className="slip-source-strip">` line to attach `ref={stripRef}`, and the `<div className="slip-green-window">`'s `onMouseDown={onWindowMouseDown}`. Recompute `windowStart`/`windowStartPct` from `displaySourceIn` not `sourceIn`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollSlipPanel`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollSlipPanel.jsx src/components/editor/__tests__/BRollSlipPanel.test.jsx
git commit -m "feat(editor): implement slip drag on BRollSlipPanel with frame snapping"
```

---

## Task 9: Wire `slipPlacement` and `toggleKeepOriginal` from `useBRollEditorState`

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` (export new action creators in the returned `broll` object)

- [ ] **Step 1: Find the existing action-creator pattern**

In `useBRollEditorState.js`, search for an existing action creator that uses `APPLY_ACTION_COALESCE` (e.g., a resize handler). Match its shape.

- [ ] **Step 2: Add action creators**

Add two functions inside the hook (`useBRollEditorState`), and include them in the returned API. Approximate shape:

```js
import { buildSlipEntry, buildToggleKeepOriginalEntry } from './brollReducer.js'

// ... inside the hook:

const slipPlacement = useCallback((placement, nextSourceIn) => {
  const currentEdits = state.edits[placement.uuid] || {}
  const entry = buildSlipEntry({ placement, currentEdits, nextSourceIn })
  dispatch({ type: 'APPLY_ACTION_COALESCE', payload: entry })
  emitTelemetry('slip_committed', {
    placement_id: placement.uuid,
    source_in_seconds: nextSourceIn,
    slipped_by_s: nextSourceIn - (currentEdits.source_in_seconds || 0),
  })
}, [state.edits])

const toggleKeepOriginal = useCallback((placement, nextValue) => {
  const currentEdits = state.edits[placement.uuid] || {}
  const sourceDurationSeconds = placement.sourceDurationSeconds
  const entry = buildToggleKeepOriginalEntry({ placement, currentEdits, nextValue, sourceDurationSeconds })
  dispatch({ type: 'APPLY_ACTION', payload: entry })
  emitTelemetry('keep_original_toggled', { placement_id: placement.uuid, new_value: nextValue })
}, [state.edits])
```

If a telemetry emitter function exists with a different name, use that.

Add `slipPlacement` and `toggleKeepOriginal` to the object returned from the hook (alongside the existing exposed actions like `searchPlacement`, etc.).

- [ ] **Step 3: Wire probe-data ingestion**

Find where `item.probed_metadata` arrives from the extension (most likely a snapshot-merge effect or message handler in `useBRollEditorState.js` or a sibling hook). For each placement whose probe data has just arrived, dispatch:

```js
dispatch({
  type: 'PROBE_DATA_RECEIVED',
  payload: {
    uuid: placement.uuid,
    durationSeconds: probedMetadata.durationSeconds,
    timelineDuration: placement.timelineDuration,
  },
})
emitTelemetry('auto_clamp_applied', {
  placement_id: placement.uuid,
  original_duration_s: placement.timelineDuration,
  clamped_duration_s: Math.min(placement.timelineDuration, probedMetadata.durationSeconds),
})
```

Only emit the `auto_clamp_applied` telemetry if the clamp actually fires (durationSeconds < timelineDuration AND not opted out).

- [ ] **Step 4: Smoke test manually (no automated test for the wiring layer)**

Run `npm test -- --project=web` to confirm no existing tests break.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(editor): expose slipPlacement/toggleKeepOriginal and wire probe-data clamp dispatch"
```

---

## Task 10: `BRollTrack` double-click handler + render `BRollSlipPanel`

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx`
- Test: `src/components/editor/__tests__/BRollTrack-slip.test.jsx` (create)

- [ ] **Step 1: Write failing test**

Create `src/components/editor/__tests__/BRollTrack-slip.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BRollTrack from '../BRollTrack.jsx'

const placement = {
  uuid: 'p1',
  filename: 'pexels_test.mp4',
  timelineStart: 10,
  timelineEnd: 15,
  timelineDuration: 5.0,
  source_in_seconds: 0,
  sourceDurationSeconds: 12.0,
  sourceFrameRate: 29.97,
}

describe('BRollTrack double-click expansion', () => {
  it('opens BRollSlipPanel on double-click of a placement bar', () => {
    render(
      <BRollTrack
        placements={[placement]}
        slipPlacement={() => {}}
        toggleKeepOriginal={() => {}}
        onPreviewSeek={() => {}}
        // Pass any other required props from the existing BRollTrack signature
      />
    )
    expect(screen.queryByTestId('slip-source-strip')).toBeNull()
    fireEvent.doubleClick(screen.getByTestId(`broll-bar-${placement.uuid}`))
    expect(screen.getByTestId('slip-source-strip')).toBeTruthy()
  })

  it('double-clicking a second placement closes the first panel', () => {
    const p2 = { ...placement, uuid: 'p2', filename: 'b.mp4' }
    render(<BRollTrack placements={[placement, p2]} slipPlacement={() => {}} toggleKeepOriginal={() => {}} onPreviewSeek={() => {}} />)
    fireEvent.doubleClick(screen.getByTestId(`broll-bar-${placement.uuid}`))
    fireEvent.doubleClick(screen.getByTestId(`broll-bar-${p2.uuid}`))
    const panels = screen.getAllByTestId('slip-source-strip')
    expect(panels.length).toBe(1)
  })

  it('Esc closes an open panel', () => {
    render(<BRollTrack placements={[placement]} slipPlacement={() => {}} toggleKeepOriginal={() => {}} onPreviewSeek={() => {}} />)
    fireEvent.doubleClick(screen.getByTestId(`broll-bar-${placement.uuid}`))
    expect(screen.getByTestId('slip-source-strip')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('slip-source-strip')).toBeNull()
  })
})
```

The exact `BRollTrack` prop list may differ — examine the existing `BRollTrack.jsx` file and the existing test setup before writing. Add `data-testid={\`broll-bar-${uuid}\`}` to the placement bar elements as part of the implementation in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollTrack-slip`
Expected: FAIL — no expansion behavior.

- [ ] **Step 3: Add expansion state and render panel**

In `BRollTrack.jsx`:

```jsx
import { useState, useEffect, useRef } from 'react'
import BRollSlipPanel from './BRollSlipPanel.jsx'

// ... inside the component:
const [expandedUuid, setExpandedUuid] = useState(null)
const panelRefs = useRef(new Map())

useEffect(() => {
  if (!expandedUuid) return
  const onKey = (e) => { if (e.key === 'Escape') setExpandedUuid(null) }
  const onClickOutside = (e) => {
    const panelEl = panelRefs.current.get(expandedUuid)
    if (panelEl && !panelEl.contains(e.target)) {
      setExpandedUuid(null)
    }
  }
  document.addEventListener('keydown', onKey)
  document.addEventListener('mousedown', onClickOutside)
  return () => {
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('mousedown', onClickOutside)
  }
}, [expandedUuid])

// ... where placement bars are rendered, attach:
<div
  data-testid={`broll-bar-${p.uuid}`}
  onDoubleClick={() => setExpandedUuid(prev => prev === p.uuid ? null : p.uuid)}
  // ... existing props ...
>
  {/* existing bar contents */}
  {expandedUuid === p.uuid && (
    <div ref={(el) => { if (el) panelRefs.current.set(p.uuid, el); else panelRefs.current.delete(p.uuid) }}>
      <BRollSlipPanel
        placement={p}
        onSlipChange={(sourceIn) => slipPlacement(p, sourceIn)}
        onClampToggle={(value) => toggleKeepOriginal(p, value)}
        onPreviewSeek={onPreviewSeek}
        onReset={() => slipPlacement(p, 0)}
        onClose={() => setExpandedUuid(null)}
      />
    </div>
  )}
</div>
```

`slipPlacement`, `toggleKeepOriginal`, `onPreviewSeek` come from props passed by the parent (BRollEditor or wherever BRollTrack is used). Wire those through.

Telemetry: when `expandedUuid` transitions from null → a uuid, call `emitTelemetry('slip_panel_opened', { placement_id: uuid, source_duration_s: p.sourceDurationSeconds })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollTrack-slip`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollTrack.jsx src/components/editor/__tests__/BRollTrack-slip.test.jsx
git commit -m "feat(editor): double-click placement opens BRollSlipPanel inline"
```

---

## Task 11: Panel overflow positioning

**Files:**
- Modify: `src/components/editor/BRollSlipPanel.jsx` or `BRollTrack.jsx` (wherever the panel is positioned)
- Test: extend `__tests__/BRollSlipPanel.test.jsx`

Goal: panel renders at 480px min width, anchored to placement bar's left edge, overflowing right (or left) if needed; auto-scrolls timeline if would render off-viewport.

- [ ] **Step 1: Write failing test**

Append to `src/components/editor/__tests__/BRollSlipPanel.test.jsx`:

```jsx
describe('BRollSlipPanel positioning', () => {
  it('uses MIN_PANEL_WIDTH (480) when placement bar is narrower', () => {
    render(
      <BRollSlipPanel placement={placement} onSlipChange={() => {}} onClampToggle={() => {}} onPreviewSeek={() => {}} onReset={() => {}} onClose={() => {}} />
    )
    const panel = screen.getByTestId('slip-source-strip').closest('.broll-slip-panel')
    expect(panel.style.minWidth).toBe('480px')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

(Skip — Task 7 already added `minWidth: MIN_PANEL_WIDTH`. If the test fails because the closest() selector misses, the implementation already covers this; just verify.)

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollSlipPanel`
Expected: PASS for this test directly (already implemented in Task 7).

- [ ] **Step 3: Add timeline auto-scroll-into-view**

In `BRollTrack.jsx`, after the panel opens (in the `setExpandedUuid` handler or a `useEffect` watching `expandedUuid`), call `scrollIntoView` on the panel element:

```jsx
useEffect(() => {
  if (!expandedUuid) return
  const id = requestAnimationFrame(() => {
    const el = document.querySelector(`[data-testid="broll-bar-${expandedUuid}"] .broll-slip-panel`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  })
  return () => cancelAnimationFrame(id)
}, [expandedUuid])
```

- [ ] **Step 4: Verify the full slip panel suite**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollSlipPanel BRollTrack-slip`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollTrack.jsx src/components/editor/__tests__/BRollSlipPanel.test.jsx
git commit -m "feat(editor): auto-scroll timeline into view when slip panel opens"
```

---

## Task 12: Main preview override channel

**Files:**
- Locate the existing main video preview component (likely under `src/components/editor/` — names to check: `EditorView.jsx`, `BRollEditor.jsx`, `PlayerPreview.jsx`, `VideoPreview.jsx`).
- Modify whichever component owns the `<video>` element + playhead.
- Modify: `useBRollEditorState.js` or a new tiny context to broker the preview-seek calls.

The slip panel's `onPreviewSeek(absoluteSourceSeconds)` callback (passed from `BRollTrack`) must reach the preview. Two acceptable mechanisms:

**Mechanism A (imperative ref):** the preview component accepts an imperative ref. `BRollEditor` holds the ref and exposes a function `previewSeek(uuid, absoluteSec)` that loads the placement's source URL + seeks. `BRollTrack` passes that function down as `onPreviewSeek`.

**Mechanism B (context):** a `PreviewControlContext` is provided at the top of the editor; consumers (slip panel, BRollTrack) call `previewControl.seekToPlacementSource(uuid, absoluteSec)`. Provider holds the actual ref/video state.

Pick whichever matches the codebase's existing pattern. If the preview already accepts external seeks (e.g., for transcript scrubbing), reuse that mechanism.

- [ ] **Step 1: Identify the preview component**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && grep -rln "<video" src/components/editor/ | head -3`

Open the matched file and locate the `<video>` element + seek/playback control.

- [ ] **Step 2: Add the override entry point**

Following whichever mechanism the existing preview uses, add a function with signature `previewSlipSource(placementUuid, absoluteSourceSeconds)`. It should:

1. Look up the placement (by uuid) to get its source URL (`finalUrl`, `download_url`, or whatever field the codebase uses).
2. If the `<video>`'s current src isn't this URL, set it and wait for `loadedmetadata`.
3. Seek to `absoluteSourceSeconds` (clamped to source duration).

If the preview is currently driven by master-timeline playback, gate this override behind a "slip mode" state — when slip mode is active, render the slip source; when not, revert to master-timeline rendering.

- [ ] **Step 3: Wire the prop chain**

Pass `previewSlipSource` from `BRollEditor` → `BRollTrack` → `BRollSlipPanel` (as `onPreviewSeek`). The slip panel's existing `scheduleSeek` (Task 8) calls it.

- [ ] **Step 4: Manual smoke**

(Cannot meaningfully unit-test this without mocking the preview. Verify manually in Task 14.)

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web`
Expected: all existing tests still pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/
git commit -m "feat(editor): wire slip panel to main preview override channel"
```

---

## Task 13: Timeline badges (auto-clamp clock + slip indicator)

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx`
- Test: extend `__tests__/BRollTrack-slip.test.jsx`

- [ ] **Step 1: Write failing test**

Append to `src/components/editor/__tests__/BRollTrack-slip.test.jsx`:

```jsx
describe('BRollTrack badges', () => {
  it('shows clock icon on auto-clamped placements', () => {
    const clamped = { ...placement, auto_clamp_applied: true }
    render(<BRollTrack placements={[clamped]} slipPlacement={() => {}} toggleKeepOriginal={() => {}} onPreviewSeek={() => {}} />)
    expect(screen.getByTestId(`broll-bar-${clamped.uuid}-clock`)).toBeTruthy()
  })

  it('shows slip indicator on placements with source_in_seconds > 0', () => {
    const slipped = { ...placement, source_in_seconds: 1.5 }
    render(<BRollTrack placements={[slipped]} slipPlacement={() => {}} toggleKeepOriginal={() => {}} onPreviewSeek={() => {}} />)
    expect(screen.getByTestId(`broll-bar-${slipped.uuid}-slip`)).toBeTruthy()
  })

  it('does not show badges on a default placement', () => {
    render(<BRollTrack placements={[placement]} slipPlacement={() => {}} toggleKeepOriginal={() => {}} onPreviewSeek={() => {}} />)
    expect(screen.queryByTestId(`broll-bar-${placement.uuid}-clock`)).toBeNull()
    expect(screen.queryByTestId(`broll-bar-${placement.uuid}-slip`)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollTrack-slip`
Expected: FAIL — badges not rendered.

- [ ] **Step 3: Render badges**

Inside the placement bar render in `BRollTrack.jsx`:

```jsx
{p.auto_clamp_applied && (
  <span
    data-testid={`broll-bar-${p.uuid}-clock`}
    title={`Auto-clamped from ${p.original_timeline_duration?.toFixed(2)}s to ${p.timelineDuration.toFixed(2)}s`}
    style={{ position: 'absolute', top: 2, right: 14, fontSize: 10 }}
  >🕒</span>
)}
{(p.source_in_seconds ?? 0) > 0 && (
  <span
    data-testid={`broll-bar-${p.uuid}-slip`}
    title={`Slipped to ${p.source_in_seconds.toFixed(2)}s into source`}
    style={{ position: 'absolute', top: 2, right: 2, fontSize: 10 }}
  >↔</span>
)}
```

(Use real SVG icons consistent with the codebase's existing icon style if the placeholder emojis don't fit.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test -- --project=web --run BRollTrack-slip`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollTrack.jsx src/components/editor/__tests__/BRollTrack-slip.test.jsx
git commit -m "feat(editor): timeline badges for auto-clamped and slipped placements"
```

---

## Task 14: Manual smoke verification

No code changes — verify the feature end-to-end in the running editor.

- [ ] **Step 1: Run all automated tests**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm test`
Expected: all projects (server, web, extension) pass.

- [ ] **Step 2: Launch the editor**

⚠️ Per project conventions, do NOT use `npm run dev:server` (it auto-resumes stuck b-roll chains). Use the existing running dev server or the Vercel preview deployment.

- [ ] **Step 3: Smoke 1 — auto-clamp + DaVinci playback**

1. Open an existing export with a known-short Pexels source (e.g., the 016 case from spec context: 6.17s source in a 7.0s slot).
2. Wait for probe data to arrive (extension snapshot).
3. Confirm the placement now displays a clock badge.
4. Export XML, open in DaVinci. Confirm the clip plays without going offline; the master-timeline slot is now ~6.17s.

- [ ] **Step 4: Smoke 2 — slip drag + preview**

1. Open a placement whose source is comfortably longer than its slot (e.g., 12s source, 5s slot).
2. Double-click the placement bar — slip panel expands below.
3. Drag the green window right. Confirm:
   - Window position updates live during drag.
   - Main preview seeks to the new in-point (live).
   - On release, the slip indicator badge appears on the placement bar.
4. Export XML, confirm `<in>` reflects the new `source_in_seconds * sourceFps`.

- [ ] **Step 5: Smoke 3 — keep-original toggle + overflow**

1. On the auto-clamped 016 case, double-click → toggle "Keep original duration" ON.
2. Confirm:
   - Master-timeline slot grows back to the original 7.0s.
   - Slip panel shows the red overflow stripe past the source end.
   - Clock badge disappears.
3. Toggle OFF — confirm the placement re-clamps and the clock badge returns.

- [ ] **Step 6: Smoke 4 — Esc / click-outside / re-open**

1. Open a slip panel. Press Esc → closes.
2. Open one panel; double-click a second placement → first closes, second opens.
3. Double-click the same placement twice → panel toggles closed.

- [ ] **Step 7: Smoke 5 — Reset button**

1. Slip a placement to source_in = 2.0.
2. Open the panel, click Reset.
3. Confirm `source_in_seconds` returns to 0 and the slip badge disappears.

- [ ] **Step 8: Final commit (if there were any minor cosmetic tweaks during smokes)**

```bash
git add src/components/editor/
git commit -m "chore(editor): minor cosmetic adjustments from slip-edit smoke testing"
```

(Skip if no further changes were needed.)

---

## Final verification

- [ ] All tests pass: `npm test`
- [ ] All 5 manual smokes pass.
- [ ] XML output for the 016-class regression no longer asks DaVinci for frames past file end (verify by inspecting the exported XML).
- [ ] Editor save-state persists `source_in_seconds`, `keep_original_duration`, `original_timeline_duration`, `auto_clamp_applied` (reload editor, verify badges + slip positions are restored).
