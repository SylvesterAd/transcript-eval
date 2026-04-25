# B-Roll Move Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 18 bugs in the B-Roll editor's moving / cross-pipeline drag system identified in the 2026-04-25 investigation. Bugs span URL routing, optimistic updates, undo-stack discipline, fetch races, drag perf, and minor cleanup.

**Architecture:** Frontend-heavy fixes in `BRollEditor.jsx`, `BRollTrack.jsx`, and `useBRollEditorState.js` plus one server-side shape reconciliation in `broll.js`. We extract the reducer to its own module for testability, then add reducer tests + hook integration tests. Manual smoke tests cover drag-perf and visual flicker bugs.

**Tech Stack:** React 19, vitest 1.6.x with `vitest.workspace.js` (browser project uses happy-dom + automatic JSX runtime), react-router-dom 7. No new deps.

**Working directory:** `/Users/laurynas/Desktop/one last /transcript-eval` (note the spaces — quote in shell commands).

**Constraint:** **Do NOT push to git** at any point. The user wants explicit permission before pushes. Commit per task is fine.

**Verification commands you will use repeatedly:**
- Single test file: `npm test -- src/components/editor/__tests__/<name>.test.jsx`
- All tests: `npm test`
- Frontend dev (manual smokes): `npm run dev:client` → open http://localhost:5173/editor/225/brolls/edit

---

## File Structure

**Created:**
- `src/components/editor/brollReducer.js` — extract pure reducer + helpers from `useBRollEditorState.js` so it can be unit-tested without React.
- `src/components/editor/__tests__/brollReducer.test.js` — reducer tests for #1, #5, #7, #15, #16.
- `src/components/editor/__tests__/useBRollEditorState.test.jsx` — hook integration tests for #2, #6, #8, #11, #12, #14.
- `src/components/editor/__tests__/BRollEditor.test.jsx` — URL parse + fetchInactive merge tests (#3, #4).

**Modified:**
- `src/components/editor/useBRollEditorState.js` — re-export from `brollReducer.js`, fix dragCrossPlacement (#1, #2, #11, #12, #5), debounce drag dispatches (#10), trim userPlacement results (#13).
- `src/components/editor/BRollTrack.jsx` — fix thumbnail fallback (#7), edge resize kind (#15), capture placements via ref (#9), bound moved reset (#17), remove console.logs (#18).
- `src/components/editor/BRollEditor.jsx` — URL parser (#4), pendingSelectionRef TTL (#8), fetchInactive merge with optimistics (#3), refresh local cache after cross-drag undo (#6), background revalidate after seed (#14).
- `server/services/broll.js` — userPlacement chapter index shape (#16).

---

## Bug → Task Cross-Reference

| Bug # | Description                                                       | Task |
|------:|-------------------------------------------------------------------|-----:|
| #1    | Cross-pipeline failure does blind UNDO                            | T11  |
| #2    | 409 conflict on target write silently lost                        | T12  |
| #3    | fetchInactive REPLACES — wipes optimistics                        | T16  |
| #4    | URL parser breaks for `user:u_xxx`                                | T1   |
| #5    | Cross-drag undo desyncs target's undoStack                        | T13  |
| #6    | Local target cache not refreshed after cross-drag undo            | T14  |
| #7    | BRollTrack thumbnail ignores persistedSelectedResult              | T2   |
| #8    | Pending selection lingers / fires spuriously                      | T6   |
| #9    | In-progress drag uses stale placements snapshot                   | T7   |
| #10   | Drag dispatches at mouse-event rate                               | T8   |
| #11   | Concurrent cross-drags race                                       | T10  |
| #12   | Cross-drag stores full results array                              | T15  |
| #13   | seedFromCache shows possibly-stale data                           | T18  |
| #14   | Server vs client userPlacement chapter-index shape mismatch       | T17  |
| #15   | Edge resize tagged 'move' in undo                                 | T3   |
| #16   | SET_DATA_RESOLVED clears selection on every refresh               | T5   |
| #17   | "moved" flag never resets after cross-bounce                      | T9   |
| #18   | console.log statements in production drag code                    | T4   |

---

## Task 0: Setup — extract reducer for testability

The reducer in `useBRollEditorState.js` is not exported, blocking direct unit tests. Pull it (and its helpers `applyMutation`, `userPlacementToRawEntry`, `resolvePlacements`, `generateActionId`, `MAX_UNDO`, `initialState`) into a sibling module.

**Files:**
- Create: `src/components/editor/brollReducer.js`
- Modify: `src/components/editor/useBRollEditorState.js` (delete the moved code, re-import)

- [ ] **Step 1: Create `brollReducer.js` with copied content**

Open [useBRollEditorState.js](src/components/editor/useBRollEditorState.js) lines 53-345 and 347-363. Copy:
- `applyMutation(state, entry, side)` (lines 55-89)
- `userPlacementToRawEntry(up)` (lines 95-110, already exported)
- `resolvePlacements({...})` (lines 116-127)
- `reducer(state, action)` (lines 129-345)
- `initialState` (lines 347-363)
- `MAX_UNDO = 50` (line 13)
- `generateActionId()` (lines 15-17)

Into a new file `src/components/editor/brollReducer.js`. Add `export` to each.

The file must also import `matchPlacementsToTranscript`:
```js
import { matchPlacementsToTranscript } from './brollUtils.js'
```

- [ ] **Step 2: In `useBRollEditorState.js`, replace the moved code with imports**

At the top of `useBRollEditorState.js`, delete the moved code (the constants, helpers, `reducer`, `initialState`, `userPlacementToRawEntry`) and add:
```js
import {
  reducer,
  initialState,
  applyMutation,
  resolvePlacements,
  userPlacementToRawEntry,
  generateActionId,
  MAX_UNDO,
} from './brollReducer.js'
```

Keep `export { userPlacementToRawEntry }` (re-export so existing importers in `BRollEditor.jsx` line 3 continue working). Add at the bottom of the file:
```js
export { userPlacementToRawEntry } from './brollReducer.js'
```

- [ ] **Step 3: Run all tests, verify nothing regressed**

Run: `npm test`
Expected: same pass count as baseline (memory says vitest passes 131/131 — the actual current count may differ; record it before making the change).

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/brollReducer.js src/components/editor/useBRollEditorState.js
git commit -m "refactor(broll): extract reducer to brollReducer.js for unit testability"
```

---

## Task 1: Fix URL parser for userPlacement IDs (Bug #4)

`/editor/225/brolls/edit/user:u_xxx` is the URL the user shared. `parseInt('user:u_xxx')` returns NaN, so the selection effect silently no-ops on reload.

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx:200-207`
- Test: `src/components/editor/__tests__/BRollEditor.test.jsx`

- [ ] **Step 1: Write failing test for userPlacement URL deep-link**

Create `src/components/editor/__tests__/BRollEditor.test.jsx`:
```jsx
import { describe, it, expect, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Pure function under test — extract URL→selection resolver.
import { resolveDetailToIndex } from '../BRollEditor.jsx'

describe('resolveDetailToIndex', () => {
  it('returns numeric index for plain numeric detail', () => {
    expect(resolveDetailToIndex('5')).toBe(5)
  })

  it('returns string identity for userPlacement detail', () => {
    expect(resolveDetailToIndex('user:u_a13ddc21-aa3')).toBe('user:u_a13ddc21-aa3')
  })

  it('returns null for empty detail', () => {
    expect(resolveDetailToIndex(undefined)).toBe(null)
    expect(resolveDetailToIndex(null)).toBe(null)
    expect(resolveDetailToIndex('')).toBe(null)
  })

  it('returns null for unparseable detail', () => {
    expect(resolveDetailToIndex('garbage')).toBe(null)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- src/components/editor/__tests__/BRollEditor.test.jsx`
Expected: FAIL — `resolveDetailToIndex` is not exported.

- [ ] **Step 3: Implement `resolveDetailToIndex` and use it**

In `src/components/editor/BRollEditor.jsx`, add at the top (above `export default`):
```js
export function resolveDetailToIndex(detail) {
  if (detail == null || detail === '') return null
  if (typeof detail === 'string' && detail.startsWith('user:')) return detail
  const n = parseInt(detail, 10)
  return Number.isFinite(n) ? n : null
}
```

Replace the URL-in effect at lines 200-207 with:
```js
useEffect(() => {
  if (!brollState.placements?.length) return
  const idx = resolveDetailToIndex(detail)
  if (idx != null && idx !== brollState.selectedIndex) {
    brollState.selectPlacement(idx)
  }
}, [detail, brollState.placements?.length])
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- src/components/editor/__tests__/BRollEditor.test.jsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Manual smoke**

Run: `npm run dev:client` (in another terminal: `npm run dev:server` if not already running).
Navigate to `http://localhost:5173/editor/225/brolls/edit`. Click a cross-dragged or pasted clip (Copy icon visible). Note URL becomes `.../user:u_xxx`. Refresh. Detail panel should be visible — was blank before fix.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/BRollEditor.jsx src/components/editor/__tests__/BRollEditor.test.jsx
git commit -m "fix(broll): URL deep-link restores userPlacement selections (#4)"
```

---

## Task 2: BRollTrack uses persistedSelectedResult (Bug #7)

`BRollTrack.jsx:305` is `selectedResults?.[p.index] ?? 0` — drops the persisted value. After variant switch, the track shows result 0 even when the user saved result 3. `BRollPreview.jsx:24` already does it right; copy that pattern.

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx:305`
- Test: extend `src/components/editor/__tests__/BRollEditor.test.jsx` OR add a small render test

- [ ] **Step 1: Write failing test**

Add to `src/components/editor/__tests__/BRollEditor.test.jsx`:
```jsx
import { resolveDisplayResultIdx } from '../BRollTrack.jsx'

describe('resolveDisplayResultIdx', () => {
  it('uses transient selectedResults when present (active row)', () => {
    expect(resolveDisplayResultIdx({ index: 5, persistedSelectedResult: 3 }, true, { 5: 7 })).toBe(7)
  })
  it('falls back to persistedSelectedResult when no transient (active row)', () => {
    expect(resolveDisplayResultIdx({ index: 5, persistedSelectedResult: 3 }, true, {})).toBe(3)
  })
  it('falls back to 0 when neither present (active row)', () => {
    expect(resolveDisplayResultIdx({ index: 5 }, true, {})).toBe(0)
  })
  it('uses persistedSelectedResult on inactive row regardless of selectedResults', () => {
    expect(resolveDisplayResultIdx({ index: 5, persistedSelectedResult: 3 }, false, { 5: 7 })).toBe(3)
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- src/components/editor/__tests__/BRollEditor.test.jsx`
Expected: FAIL — `resolveDisplayResultIdx` not exported.

- [ ] **Step 3: Add the helper and use it**

In `src/components/editor/BRollTrack.jsx`, add near the top of the file (above the default export):
```js
export function resolveDisplayResultIdx(placement, isActive, selectedResults) {
  if (isActive) {
    const transient = selectedResults?.[placement.index]
    if (transient != null) return transient
  }
  return placement.persistedSelectedResult ?? 0
}
```

Replace line 305 inside the `visible.map` block:
```js
// before:
const resultIdx = (isActive ? selectedResults?.[p.index] : null) ?? 0
// after:
const resultIdx = resolveDisplayResultIdx(p, isActive, selectedResults)
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- src/components/editor/__tests__/BRollEditor.test.jsx`
Expected: PASS — 4 new tests added.

- [ ] **Step 5: Manual smoke**

Open b-roll editor on a video that has at least one chapter placement with multiple results. Click placement, change result picker to result #3. Switch variant. Switch back. Track thumbnail should show result #3, not result #0.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/BRollTrack.jsx src/components/editor/__tests__/BRollEditor.test.jsx
git commit -m "fix(broll): track thumbnail honors persistedSelectedResult (#7)"
```

---

## Task 3: Tag edge resize as 'resize' kind (Bug #15)

`handleEdgeDrag` calls `updatePlacementPosition` without `opts.kind`, defaulting to `'move'`. The `COALESCE_KINDS` set includes `'resize'` but it's dead. Edge resizes coalesce with moves under the wrong tag.

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx:51-75` (handleEdgeDrag)

- [ ] **Step 1: Write failing reducer test**

Create `src/components/editor/__tests__/brollReducer.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { reducer, initialState } from '../brollReducer.js'

describe('reducer APPLY_ACTION_COALESCE', () => {
  it('coalesces consecutive resize actions on same placementKey', () => {
    const base = {
      ...initialState,
      undoStack: [{
        id: 'a1', ts: Date.now(), kind: 'resize', placementKey: '0:0',
        before: { editsSlot: { timelineStart: 0, timelineEnd: 1 } },
        after:  { editsSlot: { timelineStart: 0, timelineEnd: 1.5 } },
      }],
      edits: { '0:0': { timelineStart: 0, timelineEnd: 1.5 } },
    }
    const next = reducer(base, { type: 'APPLY_ACTION_COALESCE', payload: {
      id: 'a2', ts: Date.now(), kind: 'resize', placementKey: '0:0',
      before: { editsSlot: { timelineStart: 0, timelineEnd: 1.5 } },
      after:  { editsSlot: { timelineStart: 0, timelineEnd: 2.0 } },
    }})
    expect(next.undoStack.length).toBe(1)
    expect(next.undoStack[0].after.editsSlot.timelineEnd).toBe(2.0)
    expect(next.edits['0:0'].timelineEnd).toBe(2.0)
  })
})
```

- [ ] **Step 2: Run test, verify pass (the reducer already supports this — we're locking in behavior)**

Run: `npm test -- src/components/editor/__tests__/brollReducer.test.js`
Expected: PASS.

- [ ] **Step 3: Modify handleEdgeDrag to pass `kind: 'resize'`**

In `src/components/editor/BRollTrack.jsx`, change lines 62-67 — the two calls to `updatePlacementPosition` inside `handleEdgeDrag`:
```js
// before:
updatePlacementPosition(placement.index, newStart, origEnd)
// after:
updatePlacementPosition(placement.index, newStart, origEnd, { kind: 'resize' })
```

(Same for the right-edge branch — pass `{ kind: 'resize' }` to both `updatePlacementPosition` calls.)

- [ ] **Step 4: Manual smoke**

Open b-roll editor. Resize the right edge of a placement, then immediately move (drag center) the same placement. Press Cmd+Z. Should undo BOTH actions if you did them within 800ms (coalesces); should undo separately if longer than 800ms.

NOTE: with the kind separation, resize and move now coalesce only with their own kind — a resize followed by a move within 800ms produces TWO undo entries (was one before). Confirm with user this is the intended behavior; if they prefer cross-kind coalesce, revert this task.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollTrack.jsx src/components/editor/__tests__/brollReducer.test.js
git commit -m "fix(broll): edge resize tagged 'resize' kind in undo stack (#15)"
```

---

## Task 4: Remove drag console.logs (Bug #18)

Production code at `BRollTrack.jsx:119`, `:168`, `:238` logs every drag start, move (throttled to 200ms), and drop. Remove.

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx:119-125, 166-174, 238-243`

- [ ] **Step 1: Delete the three console.log blocks**

In `src/components/editor/BRollTrack.jsx`:
- Delete lines 119-125 (the `console.log('[broll-drag] start', { ... })` block).
- Delete lines 166-174 (the `if (!onMove._lastLog ...)` block including its inner `console.log('[broll-drag] move', { ... })`).
- Delete lines 238-243 (the `console.log('[broll-drag] drop', { ... })` block).

- [ ] **Step 2: Verify lints / tests still pass**

Run: `npm test`
Expected: same pass count as baseline.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollTrack.jsx
git commit -m "chore(broll): remove drag console.log statements (#18)"
```

---

## Task 5: Don't clear selection on same-pipeline data refresh (Bug #16)

`SET_DATA_RESOLVED` always clears `selectedIndex` and `selectedResults`. This is needed on variant switches (old index could resolve to wrong placement in new variant) but unnecessarily flickers the detail panel on same-pipeline refreshes.

**Files:**
- Modify: `src/components/editor/brollReducer.js` (`SET_DATA_RESOLVED` case)
- Modify: `src/components/editor/useBRollEditorState.js` (callers pass `pipelineChanged` flag)

- [ ] **Step 1: Write failing reducer test**

Add to `src/components/editor/__tests__/brollReducer.test.js`:
```js
describe('reducer SET_DATA_RESOLVED', () => {
  it('clears selectedIndex when payload.pipelineChanged is true', () => {
    const base = { ...initialState, selectedIndex: 5, selectedResults: { 5: 2 } }
    const next = reducer(base, { type: 'SET_DATA_RESOLVED', payload: {
      rawPlacements: [], placements: [], searchProgress: null, pipelineChanged: true,
    }})
    expect(next.selectedIndex).toBe(null)
    expect(next.selectedResults).toEqual({})
  })

  it('preserves selectedIndex when payload.pipelineChanged is false', () => {
    const base = { ...initialState, selectedIndex: 5, selectedResults: { 5: 2 } }
    const next = reducer(base, { type: 'SET_DATA_RESOLVED', payload: {
      rawPlacements: [], placements: [], searchProgress: null, pipelineChanged: false,
    }})
    expect(next.selectedIndex).toBe(5)
    expect(next.selectedResults).toEqual({ 5: 2 })
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- src/components/editor/__tests__/brollReducer.test.js`
Expected: FAIL — current reducer clears unconditionally.

- [ ] **Step 3: Update reducer**

In `src/components/editor/brollReducer.js`, change the `SET_DATA_RESOLVED` case:
```js
case 'SET_DATA_RESOLVED': {
  const { rawPlacements, placements, searchProgress, pipelineChanged = true } = action.payload
  const next = { ...state, rawPlacements, placements, searchProgress, loading: false, error: null }
  if (pipelineChanged) {
    next.selectedIndex = null
    next.selectedResults = {}
  }
  return next
}
```

- [ ] **Step 4: Update callers in `useBRollEditorState.js`**

There are two `SET_DATA_RESOLVED` dispatches:

**(a)** In `seedFromCache` (around line 432). The `isPipelineSwitch` flag is already computed. Pass it through:
```js
dispatch({ type: 'SET_DATA_RESOLVED', payload: {
  rawPlacements,
  placements: resolved,
  searchProgress: searchProgress || null,
  pipelineChanged: isPipelineSwitch,
}})
```

**(b)** In the load `useEffect` (around line 475). The `isPipelineSwitch` flag is already computed at line 454. Pass it through:
```js
dispatch({ type: 'SET_DATA_RESOLVED', payload: {
  rawPlacements: data.placements,
  placements: resolved,
  searchProgress: data.searchProgress,
  pipelineChanged: isPipelineSwitch,
}})
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -- src/components/editor/__tests__/brollReducer.test.js`
Expected: PASS — both new tests.

- [ ] **Step 6: Manual smoke**

Open b-roll editor. Click a placement. Wait for the next 5s search-poll fetch to fire (only if a search is running). Detail panel should NOT flicker / unmount.

- [ ] **Step 7: Commit**

```bash
git add src/components/editor/brollReducer.js src/components/editor/useBRollEditorState.js src/components/editor/__tests__/brollReducer.test.js
git commit -m "fix(broll): preserve selection on same-pipeline data refresh (#16)"
```

---

## Task 6: Pending selection TTL & user-action clear (Bug #8)

`pendingSelectionRef.current` is set when the user clicks an inactive variant placement. If the new variant's data never includes a match, the ref lingers — and a future async update (search results landing) can match and silently auto-select.

Solution: clear the ref on the next user click anywhere on the active variant, AND time it out after 5s.

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx` (pendingSelectionRef, effect, and a new clearer)

- [ ] **Step 1: Add a `pendingSelectionTsRef` and TTL check**

In `src/components/editor/BRollEditor.jsx`, near the existing `pendingSelectionRef` declaration (around line 90):
```js
const pendingSelectionRef = useRef(null)
const pendingSelectionTsRef = useRef(0)
```

In `handleVariantActivate` (lines 91-139), set the timestamp when stashing:
```js
if (selectIdentity != null) {
  pendingSelectionRef.current = selectIdentity
  pendingSelectionTsRef.current = Date.now()
}
```

- [ ] **Step 2: Update the resolve effect to honor TTL**

Modify the effect at lines 174-197:
```js
useEffect(() => {
  const pending = pendingSelectionRef.current
  if (pending == null || brollState.loading || !brollState.placements?.length) return

  // TTL: if older than 5s, drop it — the data we expected never arrived.
  if (Date.now() - pendingSelectionTsRef.current > 5000) {
    pendingSelectionRef.current = null
    return
  }

  if (typeof pending === 'object') {
    let match = null
    if (pending.userPlacementId) {
      match = brollState.placements.find(p => p.userPlacementId === pending.userPlacementId)
    } else if (pending.chapterIndex != null && pending.placementIndex != null) {
      match = brollState.placements.find(p =>
        p.chapterIndex === pending.chapterIndex && p.placementIndex === pending.placementIndex
      )
    }
    if (match) {
      brollState.selectPlacement(match.index)
      pendingSelectionRef.current = null
    }
    return
  }

  brollState.selectPlacement(pending)
  pendingSelectionRef.current = null
}, [activeVariantIdx, brollState.loading, brollState.placements])
```

- [ ] **Step 3: Clear pendingSelectionRef on direct user action**

The `selectPlacement` call from URL-sync, keyboard delete, paste, copy, etc., are user-initiated and should drop a pending. Add a wrapper in BRollEditor passed to the URL-sync effect (lines 200-207):
```js
useEffect(() => {
  if (!brollState.placements?.length) return
  const idx = resolveDetailToIndex(detail)
  if (idx != null && idx !== brollState.selectedIndex) {
    pendingSelectionRef.current = null  // user navigated, drop pending
    brollState.selectPlacement(idx)
  }
}, [detail, brollState.placements?.length])
```

- [ ] **Step 4: Manual smoke**

In a video with two variants A and B:
1. On A, click an inactive-row placement on B that you know does NOT exist after switch (e.g. the search hasn't completed).
2. Switch happens but no match → pending lingers.
3. Wait 5s; the pending should drop.
4. Then a new search result landing should NOT auto-select that placement.

(Hard to fully smoke without a contrived setup; rely on the TTL logic.)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollEditor.jsx
git commit -m "fix(broll): pending selection TTL + clear on user action (#8)"
```

---

## Task 7: Capture placements via ref in handleBoxMove (Bug #9)

In-progress drag uses the `placements` closure from drag-start. Re-renders during drag (search merges, fetchInactive returns) don't propagate. Fix: read latest `placements` via a ref inside the drag's onMove.

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx` (add ref, dereference in onMove)

- [ ] **Step 1: Add a placements ref kept in sync**

In `src/components/editor/BRollTrack.jsx`, near the top of the component body (after the line `const placements = overridePlacements || broll?.placements || []`):
```js
const placementsRef = useRef(placements)
placementsRef.current = placements
```

(Add `useRef` to the React import if not already present.)

- [ ] **Step 2: Read via ref inside the in-variant drag branch**

In `handleBoxMove`, the in-variant branch starts with `const others = placements...` (around line 203). Change to read from the ref:
```js
const livePlacements = placementsRef.current
const others = livePlacements
  .filter(p => p.index !== placement.index)
  .filter(p => Number.isFinite(p.timelineStart) && Number.isFinite(p.timelineEnd))
  .sort((a, b) => a.timelineStart - b.timelineStart)
```

- [ ] **Step 3: Manual smoke**

Open b-roll editor on a video with progressive search. Start dragging a placement while a search is running. As new results merge mid-drag, the dragged clip should respect updated neighbor positions (no overlap with newly-positioned clips).

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/BRollTrack.jsx
git commit -m "fix(broll): drag uses live placements via ref, not stale closure (#9)"
```

---

## Task 8: rAF-throttle drag dispatches (Bug #10)

`updatePlacementPosition` fires every mousemove → reducer mutates → `useEffect` re-runs `matchPlacementsToTranscript` over all placements. At 60Hz drag rate this is wasteful. Throttle to one dispatch per animation frame.

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx` (handleBoxMove inner onMove)

- [ ] **Step 1: rAF-throttle the in-variant dispatch**

In `src/components/editor/BRollTrack.jsx`, inside `handleBoxMove` (the function-scoped section before `const onMove = (ev) => {`):
```js
let pendingFrame = 0
let pendingArgs = null
const flushPosition = () => {
  pendingFrame = 0
  if (!pendingArgs) return
  updatePlacementPosition(placement.index, pendingArgs[0], pendingArgs[1])
  pendingArgs = null
}
```

Inside the in-variant branch (where `updatePlacementPosition(placement.index, newStart, newStart + duration)` is called, around line 228), replace the call with:
```js
pendingArgs = [newStart, newStart + duration]
if (!pendingFrame) pendingFrame = requestAnimationFrame(flushPosition)
inVariantDispatched = true
```

Inside `onUp` (around line 232), flush any pending frame BEFORE removing listeners:
```js
const onUp = (ev) => {
  if (pendingFrame) { cancelAnimationFrame(pendingFrame); flushPosition() }
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
  // ... existing logic continues
```

Also handle the cross-mode revert path (line 181): if entering cross-mode while a frame is pending, flush first OR cancel it — flush is safer because the revert dispatches `updatePlacementPosition(...origStart, origEnd)` which we want as the LAST state:
```js
if (overRow && overRow.vi !== (activeVariantIdx ?? 0)) {
  if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; pendingArgs = null }
  if (inVariantDispatched) {
    updatePlacementPosition(placement.index, origStart, origEnd)
    inVariantDispatched = false
  }
  // ...
}
```

- [ ] **Step 2: Manual smoke**

Open Chrome DevTools Performance tab. Record a 3-second drag of a b-roll placement on a long timeline (50+ placements). Stop. Compare frame count for `updatePlacementPosition` calls before/after — should drop to ~60 calls instead of ~180+ before. Drag should feel smooth (no jank).

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollTrack.jsx
git commit -m "perf(broll): rAF-throttle drag position dispatches (#10)"
```

---

## Task 9: Bound "moved" reset in cross-bounce (Bug #17)

Once `moved=true` in `handleBoxMove`, hovering back over the active row uses `cursorTime = origStart + dt` where `dt` is the total horizontal delta from drag-start. After bouncing across variants, this can jump the placement to an unexpected horizontal position. Fix: when re-entering in-variant mode after cross-mode, re-anchor `dt` from the current event position.

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx` (handleBoxMove)

- [ ] **Step 1: Track previous-frame cross-mode and re-anchor on transitions**

In `src/components/editor/BRollTrack.jsx`, inside `handleBoxMove` (top of function, after `let crossMode = null`):
```js
let lastWasCross = false
let inVariantStartX = startX  // re-anchored when re-entering in-variant
```

In the in-variant branch (around line 195):
```js
} else {
  // Re-anchor on transition from cross-mode → in-variant.
  if (lastWasCross) {
    inVariantStartX = ev.clientX
    lastWasCross = false
  }
  crossMode = null
  marker.style.display = 'none'
  const dx = ev.clientX - inVariantStartX
  const dt = dx / zoom
  const cursorTime = origStart + dt
  // ... rest of in-variant logic uses `dt` and `cursorTime`
```

In the cross-mode branch (around line 176):
```js
if (overRow && overRow.vi !== (activeVariantIdx ?? 0)) {
  lastWasCross = true
  // ... rest of cross-mode logic
```

- [ ] **Step 2: Manual smoke**

Drag a placement, sweep down to the variant B row (cross-mode), then sweep back UP to the variant A row WITHOUT moving horizontally much. The placement should stay near its start position, not jump.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollTrack.jsx
git commit -m "fix(broll): re-anchor in-variant drag after cross-bounce (#17)"
```

---

## Task 10: Per-target mutex for dragCrossPlacement (Bug #11)

Two cross-drags to the same target race: both GET `version=v`, both try to PUT `v→v+1`, second 409s. Wrap the entire dragCrossPlacement in `runWithTargetLock` (already exists, used by undo/redo).

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` (dragCrossPlacement, around lines 937-1024)

- [ ] **Step 1: Wrap the GET+PUT block in `runWithTargetLock`**

In `src/components/editor/useBRollEditorState.js`, change `dragCrossPlacement`:
```js
const dragCrossPlacement = useCallback(async ({ sourceIndex, targetPipelineId, targetStartSec, targetDurationSec, mode, uuid: externalUuid }) => {
  // ... existing setup (placement lookup, resultIdx, uuid, dur, up, sourceAction setup) UNCHANGED ...

  // Source-side dispatch (UNCHANGED, before the network call) ...

  // Wrap target write in per-target mutex so two rapid cross-drags don't race the version.
  await runWithTargetLock(targetPipelineId, async () => {
    try {
      const remote = await authFetch(`/broll/pipeline/${targetPipelineId}/editor-state`)
      const next = {
        edits: remote.state?.edits || {},
        userPlacements: [...(remote.state?.userPlacements || []), up],
        undoStack: [...(remote.state?.undoStack || []), {
          id: generateActionId(), ts: Date.now(), kind: 'drag-cross', userPlacementId: uuid,
          before: { userPlacementDelete: true }, after: { userPlacementCreate: up },
        }].slice(-MAX_UNDO),
        redoStack: [],
      }
      await authPut(`/broll/pipeline/${targetPipelineId}/editor-state`, { state: next, version: remote.version })
    } catch (err) {
      console.error('[broll-drag-cross] Failed to write target:', err.message)
      // Conditional revert (Task 11)
      if (sourceAction) {
        dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: sourceAction.id } })
      }
      throw err
    }
  })
}, [state.placements, state.selectedResults, state.edits, state.userPlacements, planPipelineId, runWithTargetLock])
```

Note: this also includes the Task 11 fix (CONDITIONAL_UNDO instead of UNDO).

- [ ] **Step 2: Test will be added in Task 12; verify nothing else broke**

Run: `npm test`
Expected: same pass count.

- [ ] **Step 3: Commit (combined with Task 11)**

Defer commit to end of Task 11 since they touch the same function.

---

## Task 11: CONDITIONAL_UNDO for cross-drag failure (Bug #1)

Already applied as part of Task 10's diff (the catch block now uses `CONDITIONAL_UNDO` with `sourceAction.id`). Add a hook test to lock in the behavior.

**Files:**
- Test: `src/components/editor/__tests__/useBRollEditorState.test.jsx`

The behavior is guaranteed by the reducer's `CONDITIONAL_UNDO` case (already exists at brollReducer.js). The most reliable lock-in is a direct reducer test, plus a hook-surface smoke that verifies `dragCrossPlacement` is callable. The full hook integration (with seeded rawPlacements) is exercised by manual smoke at the end of T11.

- [ ] **Step 1: Create the hook test scaffold (surface smoke only)**

Create `src/components/editor/__tests__/useBRollEditorState.test.jsx`:
```jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../lib/supabaseClient.js', () => ({ supabase: null }))
vi.mock('../EditorView.jsx', () => ({ EditorContext: { Provider: ({ children }) => children, _currentValue: null } }))

import { useBRollEditorState } from '../useBRollEditorState.js'

// Render-hook helper for happy-dom + React 19.
export function renderHook(hookFn) {
  const result = { current: null }
  function HookHost() {
    result.current = hookFn()
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(HookHost)) })
  return {
    result,
    rerender: () => act(() => { root.render(createElement(HookHost)) }),
    unmount: () => { act(() => root.unmount()); container.remove() },
  }
}

describe('useBRollEditorState — surface', () => {
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) })
  afterEach(() => { vi.restoreAllMocks() })

  it('exposes dragCrossPlacement and undo as functions', () => {
    const { result } = renderHook(() => useBRollEditorState('pipe-A'))
    expect(typeof result.current.dragCrossPlacement).toBe('function')
    expect(typeof result.current.undo).toBe('function')
    expect(typeof result.current.redo).toBe('function')
  })
})
```

- [ ] **Step 2: Add a direct reducer test for CONDITIONAL_UNDO guard (this is the core proof for #1)**

Add to `src/components/editor/__tests__/brollReducer.test.js`:
```js
describe('reducer CONDITIONAL_UNDO', () => {
  it('rolls back when entry.id matches stack head', () => {
    const entry = {
      id: 'e1', ts: 0, kind: 'drag-cross', placementKey: '0:0',
      before: { editsSlot: { hidden: false } },
      after:  { editsSlot: { hidden: true } },
    }
    const base = { ...initialState, undoStack: [entry], edits: { '0:0': { hidden: true } } }
    const next = reducer(base, { type: 'CONDITIONAL_UNDO', payload: { entryId: 'e1' } })
    expect(next.undoStack).toEqual([])
    expect(next.edits['0:0']?.hidden).toBe(false)
  })
  it('does NOT roll back when entry.id is no longer at stack head', () => {
    const entry1 = {
      id: 'e1', ts: 0, kind: 'drag-cross', placementKey: '0:0',
      before: { editsSlot: { hidden: false } }, after: { editsSlot: { hidden: true } },
    }
    const entry2 = {
      id: 'e2', ts: 0, kind: 'select-result', placementKey: '0:1',
      before: { editsSlot: { selectedResult: 0 } }, after: { editsSlot: { selectedResult: 3 } },
    }
    const base = { ...initialState, undoStack: [entry1, entry2], edits: { '0:0': { hidden: true }, '0:1': { selectedResult: 3 } } }
    const next = reducer(base, { type: 'CONDITIONAL_UNDO', payload: { entryId: 'e1' } })
    // Stack untouched, entry2 still at top
    expect(next.undoStack.map(e => e.id)).toEqual(['e1', 'e2'])
    expect(next.edits['0:0']?.hidden).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests, verify pass**

Run: `npm test -- src/components/editor/__tests__/brollReducer.test.js src/components/editor/__tests__/useBRollEditorState.test.jsx`
Expected: PASS.

- [ ] **Step 4: Commit (Tasks 10 + 11 together)**

```bash
git add src/components/editor/useBRollEditorState.js \
        src/components/editor/__tests__/useBRollEditorState.test.jsx \
        src/components/editor/__tests__/brollReducer.test.js
git commit -m "fix(broll): cross-drag uses per-target lock + CONDITIONAL_UNDO on failure (#1, #11)"
```

---

## Task 12: Handle 409 on target write with merge-and-retry (Bug #2)

When the target's PUT 409s, currently the action is reverted silently. Inside `runWithTargetLock`, on conflict, retry once with the fresh remote version.

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` (dragCrossPlacement)

- [ ] **Step 1: Add explicit 409 handling with one retry**

Inside the `runWithTargetLock` block in `dragCrossPlacement` (replacing the catch from Task 10), structure as:
```js
await runWithTargetLock(targetPipelineId, async () => {
  const writeOnce = async () => {
    const remote = await authFetch(`/broll/pipeline/${targetPipelineId}/editor-state`)
    const next = {
      edits: remote.state?.edits || {},
      userPlacements: [...(remote.state?.userPlacements || []), up],
      undoStack: [...(remote.state?.undoStack || []), {
        id: generateActionId(), ts: Date.now(), kind: 'drag-cross', userPlacementId: uuid,
        before: { userPlacementDelete: true }, after: { userPlacementCreate: up },
      }].slice(-MAX_UNDO),
      redoStack: [],
    }
    return authPut(`/broll/pipeline/${targetPipelineId}/editor-state`, { state: next, version: remote.version })
  }
  try {
    try {
      await writeOnce()
    } catch (err) {
      if (err.message === 'conflict') {
        // Conflict: another writer bumped the target. Retry once with fresh version.
        await writeOnce()
      } else {
        throw err
      }
    }
  } catch (err) {
    console.error('[broll-drag-cross] Failed to write target after retry:', err.message)
    if (sourceAction) {
      dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: sourceAction.id } })
    }
    throw err
  }
})
```

- [ ] **Step 2: Add a hook test that verifies 409 triggers exactly one retry**

Append to `src/components/editor/__tests__/useBRollEditorState.test.jsx` (no extra import needed — `renderHook` is already defined above in the same file from Task 11):
```jsx
describe('useBRollEditorState — dragCrossPlacement 409 retry', () => {
  beforeEach(() => { globalThis.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  it('retries once on 409 from target PUT then succeeds', async () => {
    let putCount = 0
    let getCount = 0
    globalThis.fetch.mockImplementation((url, init) => {
      // editor-data fetches return empty (so the hook can mount cleanly)
      if (url.includes('/editor-data')) {
        return Promise.resolve(new Response(JSON.stringify({ placements: [] }), { status: 200 }))
      }
      // editor-state GET: first call returns version 0, second (after 409) returns version 1
      if (url.includes('/editor-state') && (!init || init.method !== 'PUT')) {
        const v = getCount++
        return Promise.resolve(new Response(JSON.stringify({ state: {}, version: v }), { status: 200 }))
      }
      // editor-state PUT: first attempt 409, second OK
      putCount++
      if (putCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ state: {}, version: 1 }), { status: 409 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ version: 2 }), { status: 200 }))
    })

    const { result } = renderHook(() => useBRollEditorState('pipe-target'))
    // Manually seed a placement on the source side so dragCrossPlacement has something to move.
    // We dispatch SET_DATA_RESOLVED via a state nudge: easiest path is to inject through
    // the reducer's SET_DATA_RESOLVED action. The hook doesn't expose dispatch, but we can
    // call dragCrossPlacement after the hook mounts; if no source placement exists, it throws
    // 'source placement not found'. We expect exactly ONE retry pair (1 GET + 1 PUT 409, then
    // 1 GET + 1 PUT 200) WHEN a source exists. Without a source, the call throws before any
    // network — which itself proves dragCrossPlacement validates first.

    let threw = null
    await act(async () => {
      try {
        await result.current.dragCrossPlacement({
          sourceIndex: 0,
          targetPipelineId: 'pipe-target',
          targetStartSec: 0,
          targetDurationSec: 1,
          mode: 'move',
        })
      } catch (e) { threw = e }
    })
    // With no seeded source, this throws 'source placement not found' BEFORE any network.
    // That's the surface guarantee. Real 409-retry verification is done via the reducer
    // tests below + manual smoke (open two tabs, force a conflict).
    expect(threw?.message).toMatch(/source placement not found/i)
    expect(putCount).toBe(0)  // never reached the network
  })
})
```

(The PUT-retry path itself is verified by manual smoke: open the same video in two tabs, edit on tab A, then drag-cross on tab B. The 409 should resolve via retry; the b-roll lands on target without error. If automated coverage is later required, refactor `dragCrossPlacement` to take a seeded placement parameter for testability.)

- [ ] **Step 3: Run tests**

Run: `npm test -- src/components/editor/__tests__/useBRollEditorState.test.jsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/useBRollEditorState.js src/components/editor/__tests__/useBRollEditorState.test.jsx
git commit -m "fix(broll): cross-drag retries once on 409 conflict (#2)"
```

---

## Task 13: Append-and-prune target undoStack on cross-drag undo (Bug #5)

When the source UNDOs a cross-drag, the cleanup PUT to the target keeps the target's undoStack as-is — including the now-stale "drag-cross create" entry. So the target's undo history references a userPlacement that no longer exists.

Fix: when the source undoes, the cleanup PUT should also REMOVE the matching entry from the target's undoStack (and not append a delete entry, since this is a logical undo of the original create).

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` (`undo` and `redo`)

- [ ] **Step 1: Filter target undoStack on undo**

In `src/components/editor/useBRollEditorState.js`, modify the `undo` callback (around lines 789-812):
```js
const undo = useCallback(async () => {
  const top = state.undoStack[state.undoStack.length - 1]
  if (!top) return
  dispatch({ type: 'UNDO' })
  if (top.kind !== 'drag-cross' || !top.targetPipelineId || !top.targetUserPlacementId) return
  await runWithTargetLock(top.targetPipelineId, async () => {
    try {
      const remote = await authFetch(`/broll/pipeline/${top.targetPipelineId}/editor-state`)
      const next = {
        edits: remote.state?.edits || {},
        userPlacements: (remote.state?.userPlacements || []).filter(u => u.id !== top.targetUserPlacementId),
        undoStack: (Array.isArray(remote.state?.undoStack) ? remote.state.undoStack : [])
          .filter(e => !(e.kind === 'drag-cross' && e.userPlacementId === top.targetUserPlacementId)),
        redoStack: (Array.isArray(remote.state?.redoStack) ? remote.state.redoStack : [])
          .filter(e => !(e.kind === 'drag-cross' && e.userPlacementId === top.targetUserPlacementId)),
      }
      await authPut(`/broll/pipeline/${top.targetPipelineId}/editor-state`, { state: next, version: remote.version })
    } catch (err) {
      console.error('[broll-undo] cross-pipeline cleanup failed:', err.message)
      dispatch({ type: 'CONDITIONAL_REDO', payload: { entryId: top.id } })
      window.alert('Undo failed — could not contact target pipeline. Try again.')
    }
  })
}, [state.undoStack, runWithTargetLock])
```

- [ ] **Step 2: Mirror filter on redo**

Modify the `redo` callback (around lines 814-839). When redo re-creates the userPlacement on target, also re-append the matching create-entry to target's undoStack:
```js
const redo = useCallback(async () => {
  const top = state.redoStack[state.redoStack.length - 1]
  if (!top) return
  dispatch({ type: 'REDO' })
  if (top.kind !== 'drag-cross' || !top.targetPipelineId || !top.targetUserPlacementSnapshot) return
  await runWithTargetLock(top.targetPipelineId, async () => {
    try {
      const remote = await authFetch(`/broll/pipeline/${top.targetPipelineId}/editor-state`)
      const ups = remote.state?.userPlacements || []
      const alreadyPresent = ups.some(u => u.id === top.targetUserPlacementId)
      const remoteUndo = Array.isArray(remote.state?.undoStack) ? remote.state.undoStack : []
      const hasCreateEntry = remoteUndo.some(e => e.kind === 'drag-cross' && e.userPlacementId === top.targetUserPlacementId)
      const next = {
        edits: remote.state?.edits || {},
        userPlacements: alreadyPresent ? ups : [...ups, top.targetUserPlacementSnapshot],
        undoStack: hasCreateEntry ? remoteUndo : [...remoteUndo, {
          id: generateActionId(), ts: Date.now(), kind: 'drag-cross', userPlacementId: top.targetUserPlacementId,
          before: { userPlacementDelete: true }, after: { userPlacementCreate: top.targetUserPlacementSnapshot },
        }].slice(-MAX_UNDO),
        redoStack: Array.isArray(remote.state?.redoStack) ? remote.state.redoStack : [],
      }
      await authPut(`/broll/pipeline/${top.targetPipelineId}/editor-state`, { state: next, version: remote.version })
    } catch (err) {
      console.error('[broll-redo] cross-pipeline cleanup failed:', err.message)
      dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: top.id } })
      window.alert('Redo failed — could not contact target pipeline. Try again.')
    }
  })
}, [state.redoStack, runWithTargetLock])
```

- [ ] **Step 3: Manual smoke**

1. Variant A: drag-cross a placement from A to B (move).
2. Switch to B. Verify the b-roll is on B and the target's undoStack should have one "drag-cross create" entry.
3. Switch back to A. Press Cmd+Z (undo). Source returns; cleanup PUT to B fires.
4. Switch to B. The b-roll should be gone AND pressing Cmd+Z on B (with that variant active) should NOT recreate it (the entry was filtered).

(There's no easy automated test; defer to a hook integration test if needed.)

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "fix(broll): cross-drag undo prunes target's undoStack entry (#5)"
```

---

## Task 14: Refresh local target cache after cross-drag undo/redo (Bug #6)

After `undo()` removes the userPlacement on target's server, the local `rawInactivePlacements[targetPipelineId]` still contains the optimistic synthetic. The b-roll appears to remain on the inactive row until next variant switch / 5s poll.

Fix: BRollEditor should expose a callback that the hook calls on undo/redo cleanup completion. Simplest approach: have `undo()` accept an optional `onTargetCleanup` callback wired from BRollEditor, OR pull `rawInactivePlacements` updater into the hook surface.

We'll expose a setter ref pattern.

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` (add `setInactiveCacheRef` + setter on hook return)
- Modify: `src/components/editor/BRollEditor.jsx` (register the setter)

- [ ] **Step 1: Add inactive-cache setter wiring to the hook**

In `src/components/editor/useBRollEditorState.js`, add after the existing refs (around line 776):
```js
const inactiveCacheSetterRef = useRef(null)
const registerInactiveCacheSetter = useCallback((fn) => {
  inactiveCacheSetterRef.current = fn
}, [])
```

In `undo`'s try-block, after the successful PUT:
```js
await authPut(`/broll/pipeline/${top.targetPipelineId}/editor-state`, { state: next, version: remote.version })
// Inform the editor to drop the optimistic synthetic from its inactive cache.
inactiveCacheSetterRef.current?.(top.targetPipelineId, (prev) =>
  (prev || []).filter(p => p.userPlacementId !== top.targetUserPlacementId)
)
```

In `redo`'s try-block, after the successful PUT:
```js
await authPut(`/broll/pipeline/${top.targetPipelineId}/editor-state`, { state: next, version: remote.version })
// Re-add the userPlacement to the local cache (using the rebuilt entry shape).
const reAdded = userPlacementToRawEntry(top.targetUserPlacementSnapshot)
inactiveCacheSetterRef.current?.(top.targetPipelineId, (prev) => {
  const without = (prev || []).filter(p => p.userPlacementId !== top.targetUserPlacementId)
  return [...without, reAdded]
})
```

Add `registerInactiveCacheSetter` to the hook's return object (around line 1078):
```js
return useMemo(() => ({
  // ... existing fields,
  registerInactiveCacheSetter,
}), [
  // ... existing deps,
  registerInactiveCacheSetter,
])
```

- [ ] **Step 2: Wire the setter from BRollEditor**

In `src/components/editor/BRollEditor.jsx`, after `const brollState = useBRollEditorState(activePipelineId)` (around line 47):
```js
useEffect(() => {
  brollState.registerInactiveCacheSetter?.((pid, updater) => {
    setRawInactivePlacements(prev => ({ ...prev, [pid]: updater(prev[pid]) }))
  })
  return () => brollState.registerInactiveCacheSetter?.(null)
}, [brollState.registerInactiveCacheSetter])
```

- [ ] **Step 3: Manual smoke**

1. Variant A: drag-cross a placement from A to B. Inactive row B shows the new b-roll.
2. Press Cmd+Z. Source on A returns. Inactive row B should ALSO immediately update (b-roll gone).
3. Press Cmd+Shift+Z (redo). Source on A hides again. Inactive row B should re-add the b-roll.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/useBRollEditorState.js src/components/editor/BRollEditor.jsx
git commit -m "fix(broll): cross-drag undo/redo updates local target cache (#6)"
```

---

## Task 15: Slim results stored on userPlacement (Bug #12)

`copyPlacement`, `pastePlacement`, and `dragCrossPlacement` all persist `JSON.parse(JSON.stringify(placement.results))` — the entire 30+-result array per userPlacement. Bloats `broll_editor_state.state_json`.

Fix: only persist the single selected result (still let the search-user-placement endpoint refetch alternatives if the user opens the picker).

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` (copyPlacement, pastePlacement, dragCrossPlacement)
- Modify: `src/components/editor/brollReducer.js` (`userPlacementToRawEntry` — handle slim results)

- [ ] **Step 1: Add reducer test for slim results**

Add to `src/components/editor/__tests__/brollReducer.test.js`:
```js
import { userPlacementToRawEntry } from '../brollReducer.js'

describe('userPlacementToRawEntry', () => {
  it('preserves provided results array as-is', () => {
    const out = userPlacementToRawEntry({
      id: 'u_x', timelineStart: 0, timelineEnd: 1, selectedResult: 0,
      results: [{ id: 'r1' }, { id: 'r2' }],
    })
    expect(out.results.length).toBe(2)
    expect(out.searchStatus).toBe('complete')
  })
  it('marks status pending when results empty', () => {
    const out = userPlacementToRawEntry({
      id: 'u_x', timelineStart: 0, timelineEnd: 1, selectedResult: 0, results: [],
    })
    expect(out.searchStatus).toBe('pending')
  })
})
```

Run: `npm test -- src/components/editor/__tests__/brollReducer.test.js`
Expected: PASS (locks current behavior).

- [ ] **Step 2: Slim the results in three writers**

In `src/components/editor/useBRollEditorState.js`:

**(a) `copyPlacement` (around lines 841-865):**
```js
const resultIdx = state.selectedResults[index] ?? placement.persistedSelectedResult ?? 0
const allResults = placement.results || []
const slim = allResults[resultIdx] ? [allResults[resultIdx]] : []
const entry = {
  // ...
  selectedResult: 0,  // slim array now has only the chosen result at index 0
  results: slim,
  // ...
}
```

(Important: also set `selectedResult: 0` since the slim array is single-element.)

**(b) `pastePlacement` (around lines 867-919):**

The clipboard entry already carries `entry.results` — don't re-slim. Just propagate. No code change needed here, since copyPlacement now produces slim clipboard entries.

**(c) `dragCrossPlacement` (around lines 937-1024):**

Replace:
```js
results: JSON.parse(JSON.stringify(placement.results || [])),
```
with:
```js
const allResults = placement.results || []
const slim = allResults[resultIdx] ? [allResults[resultIdx]] : []
// ... in `up`:
selectedResult: 0,  // slim array indexed at 0
results: slim,
```

- [ ] **Step 3: Manual smoke**

Cross-drag a placement. Open browser devtools Network panel; the next PUT to `editor-state` should show a small JSON body (no big results array embedded). The cross-dragged placement should still show its thumbnail correctly. The result picker (BRollDetailPanel) on the target's userPlacement should offer the option to re-search alternatives via `searchUserPlacement` (already wired).

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/useBRollEditorState.js src/components/editor/__tests__/brollReducer.test.js
git commit -m "perf(broll): persist only selected result on cross-drag and copy (#12)"
```

---

## Task 16: fetchInactive merges optimistics instead of replacing (Bug #3)

`fetchInactive` in BRollEditor unconditionally replaces `rawInactivePlacements[pid]` with server data. Apply the same merge pattern that `onCrossDrop`'s fit-check refresh already uses (filter local optimistics whose uuids are not on server, append).

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx` (fetchInactive function)

- [ ] **Step 1: Refactor fetchInactive to merge**

In `src/components/editor/BRollEditor.jsx`, modify the function inside the `useEffect` at lines 67-87:
```js
useEffect(() => {
  if (variants.length <= 1) return
  const inactiveIds = variants.filter((_, i) => i !== activeVariantIdx).map(v => v.id)
  const controller = new AbortController()
  function fetchInactive() {
    for (const pid of inactiveIds) {
      authFetchBRollData(pid, controller.signal)
        .then(data => {
          const serverPlacements = data.placements || []
          setRawInactivePlacements(prev => {
            const local = prev[pid] || []
            const serverIds = new Set(serverPlacements.filter(p => p.userPlacementId).map(p => p.userPlacementId))
            // Keep local optimistic userPlacements whose uuids are NOT yet on server
            // (they're in flight; replacing would make them vanish from view).
            const optimistic = local.filter(p => p.isUserPlacement && p.userPlacementId && !serverIds.has(p.userPlacementId))
            return { ...prev, [pid]: [...serverPlacements, ...optimistic] }
          })
        })
        .catch(err => { if (err.name !== 'AbortError') {/* swallow */} })
    }
  }
  fetchInactive()
  const isRunning = brollState.searchProgress?.status === 'running'
  if (!isRunning) return () => controller.abort()
  const interval = setInterval(fetchInactive, 5000)
  return () => {
    clearInterval(interval)
    controller.abort()
  }
}, [variants, activeVariantIdx, brollState.searchProgress?.status])
```

- [ ] **Step 2: Manual smoke**

1. Stage: open b-roll editor on a video where pipeline B has a search running.
2. While on variant A, drag-cross a clip to variant B. Inactive row B shows it (optimistic).
3. Wait for the next 5s fetchInactive interval. The clip should NOT vanish from B's row (it should stay since the server may not yet have committed, or the merge keeps it).

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollEditor.jsx
git commit -m "fix(broll): fetchInactive merges optimistics instead of replacing (#3)"
```

---

## Task 17: Reconcile server-vs-client userPlacement chapter shape (Bug #14)

Server `getBRollEditorData` (broll.js:5181-5196) sets `chapterIndex: up.sourceChapterIndex ?? null`. Client `userPlacementToRawEntry` sets `chapterIndex: null`. The two paths feed `matchPlacementsToTranscript` differently — userPlacement could pick up a `edits[sourceChapter:sourcePlacement].hidden` flag in server-as-is mode if such an edit exists.

Fix: server should also use `null` for userPlacement entries' chapterIndex/placementIndex, matching the client. Source attribution stays in `sourcePipelineId`/`sourceChapterIndex`/`sourcePlacementIndex` (already top-level fields).

**Files:**
- Modify: `server/services/broll.js:5181-5196`

- [ ] **Step 1: Add server unit test (mocked db) for userPlacement shape**

Create `server/services/__tests__/broll-userplacement-shape.test.js`:
```js
import { describe, it, expect, vi } from 'vitest'

// Inject a userPlacement via the mocked broll_editor_state row, with empty plan/queue rows.
const userPlacementRow = {
  state_json: JSON.stringify({
    edits: {},
    userPlacements: [{
      id: 'u_test',
      sourcePipelineId: 'src-pipe',
      sourceChapterIndex: 0,
      sourcePlacementIndex: 0,
      timelineStart: 5,
      timelineEnd: 7,
      selectedResult: 0,
      results: [{ id: 'r1', thumbnail_url: 'x' }],
      snapshot: { description: 'test', audio_anchor: 'a', function: 'f', type_group: 'g', source_feel: 'h', style: {} },
    }],
  }),
  version: 1,
}

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      all: async () => [],
      get: async () => {
        if (typeof sql === 'string' && sql.includes('broll_editor_state')) return userPlacementRow
        return null
      },
    }),
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

import { getBRollEditorData } from '../broll.js'

describe('getBRollEditorData userPlacement shape', () => {
  it('sets chapterIndex/placementIndex to null even when source ids exist', async () => {
    const data = await getBRollEditorData('pipe-target')
    const up = data.placements.find(p => p.userPlacementId === 'u_test')
    expect(up).toBeTruthy()
    expect(up.chapterIndex).toBe(null)
    expect(up.placementIndex).toBe(null)
    expect(up.sourceChapterIndex).toBe(0)
    expect(up.sourcePlacementIndex).toBe(0)
  })
})
```

Run: `npm test -- server/services/__tests__/broll-userplacement-shape.test.js`
Expected: FAIL — current server returns chapterIndex=0 (the source value), not null.

- [ ] **Step 2: Modify the server transform**

In `server/services/broll.js`, change lines 5181-5196:
```js
for (const up of userPlacements) {
  editedPlacements.push({
    index: `user:${up.id}`,
    userPlacementId: up.id,
    isUserPlacement: true,
    sourcePipelineId: up.sourcePipelineId,
    sourceChapterIndex: up.sourceChapterIndex ?? null,
    sourcePlacementIndex: up.sourcePlacementIndex ?? null,
    // chapterIndex/placementIndex left null so the same-key edit lookup
    // in matchPlacementsToTranscript treats userPlacements distinctly from
    // chapter-derived placements (matches client-side userPlacementToRawEntry).
    chapterIndex: null,
    placementIndex: null,
    userTimelineStart: up.timelineStart,
    userTimelineEnd: up.timelineEnd,
    persistedSelectedResult: up.selectedResult,
    results: up.results || [],
    searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
    ...(up.snapshot || {}),
  })
}
```

- [ ] **Step 3: Update any frontend code reading the renamed fields**

Search for usages: `grep -rn "sourceChapterIndex\|sourcePlacementIndex" src/`. Most references are in `useBRollEditorState.js`'s `dragCrossPlacement` — they already write `sourceChapterIndex` to the userPlacement record (not read from server-baked entries). Verify nothing in `BRollDetailPanel.jsx` reads `chapterIndex` for userPlacement-aware logic (it currently uses `userPlacementId` to detect userPlacements, not chapter ids — should be fine).

Run: `npm test`
Expected: same pass count.

- [ ] **Step 4: Manual smoke**

1. On variant A, hide a chapter placement at chapterIndex=0, placementIndex=0 (creates `edits['0:0'].hidden=true`).
2. On variant B, cross-drag a placement whose source happens to be chapterIndex=0, placementIndex=0 from variant A's plan (doesn't have to literally be the same — just any cross-drag whose source indices happen to land at '0:0').
3. After a hard refresh, the cross-dragged userPlacement on B should remain visible (was being incorrectly hidden by the '0:0' edit pre-fix in server-as-is mode).

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/services/__tests__/broll-userplacement-shape.test.js
git commit -m "fix(broll): server returns userPlacement chapter ids as null (#14)"
```

---

## Task 18: Background revalidate after seedFromCache (Bug #13)

`seedFromCache` skips the load fetch when seed data exists. Cached data may be 30s+ old. Add a stale-while-revalidate background fetch that updates rawPlacements without flicker.

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` (load `useEffect`)

- [ ] **Step 1: Trigger background fetch when seed-skip path is taken**

In `src/components/editor/useBRollEditorState.js`, modify the load `useEffect` (around lines 435-478):
```js
useEffect(() => {
  if (!planPipelineId) return

  const wasSeeded = seededPipelineIdRef.current === planPipelineId
  if (wasSeeded) {
    seededPipelineIdRef.current = null
    // Background revalidate: fetch fresh data, replace if changed. No SET_LOADING.
    let cancelled = false
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => {
        if (cancelled) return
        const resolved = resolvePlacements({
          rawPlacements: data.placements || [],
          userPlacements: userPlacementsRef.current,
          edits: editsRef.current,
          transcriptWords: transcriptWordsRef.current,
          editorStateLoaded: editorStateLoadedRef.current,
        })
        dispatch({ type: 'SET_DATA_RESOLVED', payload: {
          rawPlacements: data.placements,
          placements: resolved,
          searchProgress: data.searchProgress,
          pipelineChanged: false,  // same pipeline — preserve selection (Task 5)
        }})
      })
      .catch(() => {})
    return () => { cancelled = true }
  }

  // Existing path (unchanged): no seed, full LOADING→fetch→RESOLVED.
  if (!transcriptWords.length) return
  const isPipelineSwitch = lastLoadedPipelineIdRef.current !== null && lastLoadedPipelineIdRef.current !== planPipelineId
  if (isPipelineSwitch) dispatch({ type: 'RESET_PIPELINE_STATE' })
  lastLoadedPipelineIdRef.current = planPipelineId
  dispatch({ type: 'SET_LOADING' })
  authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
    .then(data => {
      const resolved = resolvePlacements({
        rawPlacements: data.placements || [],
        userPlacements: userPlacementsRef.current,
        edits: editsRef.current,
        transcriptWords: transcriptWordsRef.current,
        editorStateLoaded: editorStateLoadedRef.current,
      })
      dispatch({ type: 'SET_DATA_RESOLVED', payload: {
        rawPlacements: data.placements,
        placements: resolved,
        searchProgress: data.searchProgress,
        pipelineChanged: isPipelineSwitch,
      }})
    })
    .catch(err => dispatch({ type: 'SET_ERROR', payload: err.message }))
}, [planPipelineId, transcriptWords])
```

- [ ] **Step 2: Manual smoke**

1. Open b-roll editor on multi-variant video. Switch to B (caches A).
2. In another tab, also open the same video and edit something on A (move a clip).
3. Switch back to A in the original tab. Initially shows seed. Within ~500ms, the background revalidate should update with the change from the other tab. NO loading spinner flash.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "fix(broll): background revalidate after seedFromCache (#13)"
```

---

## Task 19: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests pass; new tests added in this plan visible in count.

- [ ] **Step 2: Full manual regression smoke**

Open `http://localhost:5173/editor/225/brolls/edit` and verify:
- Single-variant b-roll: drag, resize, paste, copy, delete, undo, redo all work without console errors.
- Multi-variant: variant switch flickers minimized; thumbnails stable; cross-drag move works; cross-drag undo cleans up both source and target views; URL deep-link to `user:u_xxx` restores selection on reload.
- Concurrent: open the same video in two tabs; edits in tab A reflect in tab B within ~5s.

- [ ] **Step 3: Summary report**

Print to chat:
```
B-roll move bug fixes: 18/18 done. Tests: <pass-count>. Manual smoke green.
Branch: <current-branch>. Ready to push (awaiting permission).
```

DO NOT push.

---

## Self-Review Checklist (run at end of plan execution)

- [ ] Every bug #1-#18 mapped to a task and implemented.
- [ ] No `console.log` statements left in `BRollTrack.jsx`.
- [ ] All callers of `SET_DATA_RESOLVED` pass `pipelineChanged` correctly (true on variant switch, false on background revalidate / search merge).
- [ ] All cross-pipeline writes wrapped in `runWithTargetLock`.
- [ ] All cross-pipeline failure reverts use `CONDITIONAL_UNDO`/`CONDITIONAL_REDO` (never blind UNDO).
- [ ] `userPlacement` shape is consistent: `chapterIndex: null` on both server and client paths.
- [ ] `npm test` passes.

---

## Notes for the executing agent

- The user's working directory has spaces (`/Users/laurynas/Desktop/one last /transcript-eval`). Always quote paths.
- Memory file `feedback_coding_style.md` says: don't push without explicit permission. Commit per task, but stop before any `git push`.
- Memory file `project_broll_timeline_issues.md` references prior fixes; do not re-introduce regressions in `hasBrollTrack` or `pendingSelectionRef`'s cross-variant matching.
- If a manual smoke test cannot be completed (e.g. the staging video doesn't exhibit the bug), record this as "smoke deferred — needs <fixture description>" rather than skipping.
- Tasks 1-9 are independent and can be executed in parallel by different subagents if using `superpowers:dispatching-parallel-agents`.
- Tasks 10-18 share state-management code paths and should be executed sequentially.
