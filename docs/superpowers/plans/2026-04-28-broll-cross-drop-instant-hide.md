# B-Roll Cross-Pipeline Drop: Instant Source-Hide + Pending Spinner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user drags a b-roll from one pipeline (variant) to another, hide the source instantly (no longer wait for the pre-flight target-fetch round-trip), and show a "saving" spinner on the optimistic target placement until the server PUT confirms.

**Architecture:** Two-phase source-hide. Phase 1 dispatches an `APPLY_ACTION` with provisional `crossMeta` (uses requested start + source duration) the moment the drop fires — source disappears in <16ms. Phase 2, after `computeFitDropPosition` returns the actual fitted range, patches the same undo-stack entry's `targetUserPlacementSnapshot` to the final values via a new `PATCH_UNDO_ENTRY` reducer action. The optimistic target synthetic carries a `pendingWrite: true` flag, which `BRollTrack` renders as a Loader2 overlay on top of the thumbnail. On any early-return (pre-flight fetch fail, fit-check fail, PUT fail) we revert via `CONDITIONAL_UNDO` of the source-hide action plus removal of the synthetic.

**Tech Stack:** React 19 + Vite frontend, Vitest for unit tests, happy-dom for hook tests. No backend changes.

**Out of scope:** Silent shrink threshold (separate decision). Failure toasts (could be added — current code uses `window.alert` for fit-check fail and silent for PUT fail; we keep the existing surface).

---

## File Structure

| File | Responsibility | Changes |
|---|---|---|
| `src/components/editor/brollReducer.js` | Reducer + action helpers | Add `PATCH_UNDO_ENTRY` action |
| `src/components/editor/useBRollEditorState.js:679-786` | `dragCrossPlacement` + new hide/revert/patch fns | Extract source-hide; add `hideSourceForCrossDrop`, `revertCrossDropHide`, `updateCrossDropSnapshot`; modify `dragCrossPlacement` to accept pre-hidden actionId |
| `src/components/editor/BRollEditor.jsx:419-518` | Cross-drop orchestration | Reorder: hide source first → fetch → fit-check (revert on fail) → insert with `pendingWrite` → commit; clear `pendingWrite` on success |
| `src/components/editor/BRollTrack.jsx:318-404` | Placement render | Render Loader2 overlay when `p.pendingWrite` |
| `src/components/editor/__tests__/brollReducer.test.js` | Reducer tests | Add `PATCH_UNDO_ENTRY` tests |
| `src/components/editor/__tests__/useBRollEditorState.test.jsx` | Hook surface tests | Verify new exports: `hideSourceForCrossDrop`, `revertCrossDropHide`, `updateCrossDropSnapshot` |

---

## Task 1: Add `PATCH_UNDO_ENTRY` reducer action

**Files:**
- Modify: `src/components/editor/brollReducer.js`
- Test: `src/components/editor/__tests__/brollReducer.test.js`

**Why first:** New reducer action has zero call-sites yet — pure additive change, easy to verify in isolation before any wiring.

- [ ] **Step 1: Write the failing test**

Append to `src/components/editor/__tests__/brollReducer.test.js`:

```js
describe('reducer PATCH_UNDO_ENTRY', () => {
  it('patches the matching entry crossMeta and leaves edits untouched', () => {
    const before = {
      undoStack: [
        { id: 'a', kind: 'drag-cross', placementKey: '0:1',
          targetPipelineId: 'pipe-X', targetUserPlacementId: 'u_1',
          targetUserPlacementSnapshot: { id: 'u_1', timelineStart: 5, timelineEnd: 6 },
          before: { editsSlot: { hidden: false } }, after: { editsSlot: { hidden: true } },
        },
      ],
      edits: { '0:1': { hidden: true } },
      redoStack: [], userPlacements: [], rawPlacements: [], placements: [],
    }
    const next = reducer(before, {
      type: 'PATCH_UNDO_ENTRY',
      payload: { entryId: 'a', patch: { targetUserPlacementSnapshot: { id: 'u_1', timelineStart: 5, timelineEnd: 7.5 } } },
    })
    expect(next.undoStack[0].targetUserPlacementSnapshot.timelineEnd).toBe(7.5)
    expect(next.edits).toBe(before.edits)
  })

  it('is a no-op when entryId is not in undoStack', () => {
    const before = {
      undoStack: [{ id: 'a', kind: 'drag-cross' }],
      edits: {}, redoStack: [], userPlacements: [], rawPlacements: [], placements: [],
    }
    const next = reducer(before, { type: 'PATCH_UNDO_ENTRY', payload: { entryId: 'z', patch: {} } })
    expect(next).toBe(before)
  })
})
```

You also need to import `reducer` if not already at the top of the file. Check the existing imports — likely already there from prior tests.

- [ ] **Step 2: Run the test to confirm it fails**

Run from project root:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run src/components/editor/__tests__/brollReducer.test.js -t "PATCH_UNDO_ENTRY"
```

Expected: 2 failures (`PATCH_UNDO_ENTRY` is not handled — the reducer falls through default and returns state, so the assertions about `targetUserPlacementSnapshot.timelineEnd === 7.5` will fail; second test should pass since default-return IS the same reference).

- [ ] **Step 3: Add the reducer case**

In `src/components/editor/brollReducer.js`, find the existing `case 'CONDITIONAL_UNDO':` block. Add the new case immediately after it:

```js
    case 'PATCH_UNDO_ENTRY': {
      const { entryId, patch } = action.payload || {}
      if (!entryId || !patch) return state
      const idx = state.undoStack.findIndex(e => e.id === entryId)
      if (idx === -1) return state
      const updated = { ...state.undoStack[idx], ...patch }
      const nextStack = [...state.undoStack.slice(0, idx), updated, ...state.undoStack.slice(idx + 1)]
      return { ...state, undoStack: nextStack }
    }
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run src/components/editor/__tests__/brollReducer.test.js -t "PATCH_UNDO_ENTRY"
```

Expected: both tests pass.

- [ ] **Step 5: Run the full reducer test suite to ensure no regression**

```bash
npx vitest run src/components/editor/__tests__/brollReducer.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/brollReducer.js src/components/editor/__tests__/brollReducer.test.js
git commit -m "feat(broll): add PATCH_UNDO_ENTRY reducer action

Allows in-place updates to undo-stack entry metadata (crossMeta) without
mutating edits or other state slots. Used by the upcoming two-phase
cross-drop source-hide refactor."
```

---

## Task 2: Refactor `useBRollEditorState` — extract source-hide

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js:679-786`
- Test: `src/components/editor/__tests__/useBRollEditorState.test.jsx`

**Why now:** Adds the new API surface that BRollEditor will consume in Task 3. After this task, `dragCrossPlacement` keeps its old behavior when called without the new param — back-compat with existing tests.

- [ ] **Step 1: Write the failing surface test**

Append to `src/components/editor/__tests__/useBRollEditorState.test.jsx` inside the existing `describe('useBRollEditorState — surface', ...)` block (extend the existing `it`, or add a new `it`):

```js
  it('exposes hideSourceForCrossDrop, revertCrossDropHide, and updateCrossDropSnapshot', () => {
    hookHandle = renderHook(() => useBRollEditorState('pipe-A'))
    const { result } = hookHandle
    expect(typeof result.current.hideSourceForCrossDrop).toBe('function')
    expect(typeof result.current.revertCrossDropHide).toBe('function')
    expect(typeof result.current.updateCrossDropSnapshot).toBe('function')
  })
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/components/editor/__tests__/useBRollEditorState.test.jsx -t "exposes hideSource"
```

Expected: failure — `result.current.hideSourceForCrossDrop` is undefined.

- [ ] **Step 3: Add the three new functions inside `useBRollEditorState`**

Locate `dragCrossPlacement` at `src/components/editor/useBRollEditorState.js:679`. Insert the three new functions IMMEDIATELY BEFORE it. Paste this block verbatim:

```js
  // Cross-drop helpers — split out so callers can hide source FIRST (instant visual)
  // and only do the network round-trip after. The two-phase shape lets us update the
  // undo entry's targetUserPlacementSnapshot once computeFitDropPosition produces the
  // final adjusted range. Phase 1 hide uses provisional values; Phase 2 patches them.
  const hideSourceForCrossDrop = useCallback(({ sourceIndex, mode, targetPipelineId, uuid, provisionalSnapshot }) => {
    if (mode !== 'move') return null
    const placement = state.placements.find(p => p.index === sourceIndex)
    if (!placement) return null
    const actionId = generateActionId()
    const crossMeta = {
      targetPipelineId,
      targetUserPlacementId: uuid,
      targetUserPlacementSnapshot: provisionalSnapshot,
    }
    const placementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    let sourceAction = null
    if (placementKey) {
      const prev = state.edits[placementKey] || {}
      sourceAction = {
        id: actionId, ts: Date.now(), kind: 'drag-cross', placementKey,
        ...crossMeta,
        before: { editsSlot: { hidden: !!prev.hidden } },
        after:  { editsSlot: { hidden: true } },
      }
    } else if (placement.userPlacementId) {
      sourceAction = {
        id: actionId, ts: Date.now(), kind: 'drag-cross', userPlacementId: placement.userPlacementId,
        ...crossMeta,
        before: { userPlacementCreate: state.userPlacements.find(u => u.id === placement.userPlacementId) },
        after:  { userPlacementDelete: true },
      }
    }
    if (!sourceAction) return null
    dispatch({ type: 'APPLY_ACTION', payload: sourceAction })
    return { actionId, placement }
  }, [state.placements, state.edits, state.userPlacements])

  const revertCrossDropHide = useCallback((actionId) => {
    if (!actionId) return
    dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: actionId } })
  }, [])

  const updateCrossDropSnapshot = useCallback((actionId, patch) => {
    if (!actionId || !patch) return
    dispatch({ type: 'PATCH_UNDO_ENTRY', payload: { entryId: actionId, patch } })
  }, [])

```

- [ ] **Step 4: Modify `dragCrossPlacement` to accept and honor a pre-hidden actionId**

In `src/components/editor/useBRollEditorState.js`, find the signature line:

```js
  const dragCrossPlacement = useCallback(async ({ sourceIndex, targetPipelineId, targetStartSec, targetDurationSec, mode, uuid: externalUuid }) => {
```

Replace it with:

```js
  const dragCrossPlacement = useCallback(async ({ sourceIndex, targetPipelineId, targetStartSec, targetDurationSec, mode, uuid: externalUuid, presourceActionId, presourcePlacement }) => {
```

Then find the lookup line:

```js
    const placement = state.placements.find(p => p.index === sourceIndex)
    if (!placement) {
      throw new Error('source placement not found')
    }
```

Replace with:

```js
    const placement = presourcePlacement || state.placements.find(p => p.index === sourceIndex)
    if (!placement) {
      throw new Error('source placement not found')
    }
```

Then find the source-hide block (the `if (mode === 'move') { ... if (sourceAction) { dispatch(...) } }` section, lines roughly 716-744). Wrap the dispatch in a check for `presourceActionId`. Specifically, change:

```js
      if (sourceAction) {
        dispatch({ type: 'APPLY_ACTION', payload: sourceAction })
      }
```

to:

```js
      if (sourceAction && !presourceActionId) {
        dispatch({ type: 'APPLY_ACTION', payload: sourceAction })
      }
```

Finally, find the failure-path revert (`if (sourceAction) { dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: sourceAction.id } }) }`) and update it to use the pre-hidden id when present. Replace:

```js
        if (sourceAction) {
          dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: sourceAction.id } })
        }
```

with:

```js
        const revertId = presourceActionId || sourceAction?.id
        if (revertId) {
          dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: revertId } })
        }
```

- [ ] **Step 5: Export the three new functions from the hook return**

Find the `return useMemo(() => ({ ... }))` block (around line 840). Add the three new functions to the returned object, alongside `dragCrossPlacement`:

```js
    dragCrossPlacement,
    hideSourceForCrossDrop,
    revertCrossDropHide,
    updateCrossDropSnapshot,
```

Then add the three names to the dependency array of that `useMemo` (around line 880):

```js
    copyPlacement, pastePlacement, resetPlacement, dragCrossPlacement,
    hideSourceForCrossDrop, revertCrossDropHide, updateCrossDropSnapshot,
```

- [ ] **Step 6: Run the surface test**

```bash
npx vitest run src/components/editor/__tests__/useBRollEditorState.test.jsx -t "exposes hideSource"
```

Expected: pass.

- [ ] **Step 7: Run the full hook test suite to verify the existing 409-retry test still passes**

```bash
npx vitest run src/components/editor/__tests__/useBRollEditorState.test.jsx
```

Expected: all tests pass (the existing test calls `dragCrossPlacement` without `presourceActionId` so the legacy code path is exercised).

- [ ] **Step 8: Commit**

```bash
git add src/components/editor/useBRollEditorState.js src/components/editor/__tests__/useBRollEditorState.test.jsx
git commit -m "refactor(broll): expose hideSourceForCrossDrop / revertCrossDropHide / updateCrossDropSnapshot

Splits the source-hide step out of dragCrossPlacement so callers can hide
the source IMMEDIATELY on drop, then complete the pre-flight fetch and
PUT afterwards. dragCrossPlacement accepts presourceActionId and skips
its internal hide when given. Failure-path revert uses the pre-hidden id."
```

---

## Task 3: Update `BRollEditor` cross-drop handler — instant hide + pending flag

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx:419-518`

- [ ] **Step 1: Replace the `onCrossDrop` handler body**

Open `src/components/editor/BRollEditor.jsx`. The existing `onCrossDrop={async (args) => { ... }}` runs from approximately line 419 to line 518. Replace the ENTIRE function body (everything between the opening `(args) => {` and the matching closing `}`) with this implementation:

```js
async (args) => {
  const sourcePlacement = brollState.placements.find(p => p.index === args.sourceIndex)
  if (!sourcePlacement) return
  const sourceDur = Math.max(0.5, sourcePlacement?.timelineDuration || 1)
  const mode = args.mode || 'move'
  const targetIsActive = args.targetPipelineId === variants[activeVariantIdx]?.id

  // Mint uuid up front so the optimistic synthetic and the server-saved entry share an id.
  const uuid = 'u_' + (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12)
  const resultIdx = brollState.selectedResults?.[args.sourceIndex] ?? sourcePlacement.persistedSelectedResult ?? 0
  const buildSnapshot = (start, dur) => ({
    id: uuid,
    sourcePipelineId: variants[activeVariantIdx]?.id,
    sourceChapterIndex: sourcePlacement.chapterIndex ?? null,
    sourcePlacementIndex: sourcePlacement.placementIndex ?? null,
    timelineStart: start,
    timelineEnd: start + dur,
    selectedResult: resultIdx,
    results: sourcePlacement.results || [],
    snapshot: {
      description: sourcePlacement.description,
      audio_anchor: sourcePlacement.audio_anchor,
      function: sourcePlacement.function,
      type_group: sourcePlacement.type_group,
      source_feel: sourcePlacement.source_feel,
      style: sourcePlacement.style,
    },
  })

  // PHASE 1: hide source IMMEDIATELY using a provisional snapshot (requested start + source duration).
  // The snapshot is patched to the final adjusted values after fit-check.
  const provisionalSnapshot = buildSnapshot(args.targetStartSec, sourceDur)
  const hideHandle = brollState.hideSourceForCrossDrop({
    sourceIndex: args.sourceIndex,
    mode,
    targetPipelineId: args.targetPipelineId,
    uuid,
    provisionalSnapshot,
  })

  // PHASE 2: refresh inactive target placements so fit-check sees current data.
  let targetPlacements
  if (targetIsActive) {
    targetPlacements = brollState.placements
  } else {
    try {
      const data = await authFetchBRollData(args.targetPipelineId)
      const serverPlacements = data.placements || []
      const serverIds = new Set(serverPlacements.filter(p => p.userPlacementId).map(p => p.userPlacementId))
      const localOptimistic = (rawInactivePlacements[args.targetPipelineId] || [])
        .filter(p => p.isUserPlacement && p.userPlacementId && !serverIds.has(p.userPlacementId))
      const merged = [...serverPlacements, ...localOptimistic]
      targetPlacements = matchPlacementsToTranscript(merged, transcriptWords)
      setRawInactivePlacements(prev => ({ ...prev, [args.targetPipelineId]: merged }))
    } catch (err) {
      console.error('[broll-cross-drop] fit-check refresh failed:', err.message)
      if (hideHandle) brollState.revertCrossDropHide(hideHandle.actionId)
      window.alert('Could not load target variant. Try again in a moment.')
      return
    }
  }

  const adjusted = computeFitDropPosition(targetPlacements, args.targetStartSec, sourceDur)
  if (!adjusted) {
    if (hideHandle) brollState.revertCrossDropHide(hideHandle.actionId)
    window.alert('Not enough space at this drop position.')
    return
  }

  // Patch the source-hide undo entry to carry the FINAL snapshot (so undo/redo is correct).
  const finalSnapshot = buildSnapshot(adjusted.start, adjusted.duration)
  if (hideHandle) {
    brollState.updateCrossDropSnapshot(hideHandle.actionId, { targetUserPlacementSnapshot: finalSnapshot })
  }

  // PHASE 3: optimistic insert into target with pendingWrite spinner flag.
  const synthetic = { ...userPlacementToRawEntry(finalSnapshot), pendingWrite: true }
  let optimisticInserted = false
  if (!targetIsActive) {
    setRawInactivePlacements(prev => ({
      ...prev,
      [args.targetPipelineId]: [...(prev[args.targetPipelineId] || []), synthetic],
    }))
    optimisticInserted = true
  }

  // PHASE 4: server PUT. dragCrossPlacement skips its internal source-hide because we pre-hid.
  try {
    await brollState.dragCrossPlacement({
      ...args,
      mode,
      targetStartSec: adjusted.start,
      targetDurationSec: adjusted.duration,
      uuid,
      presourceActionId: hideHandle?.actionId,
      presourcePlacement: hideHandle?.placement,
    })
    // Clear pendingWrite on success.
    if (optimisticInserted) {
      setRawInactivePlacements(prev => ({
        ...prev,
        [args.targetPipelineId]: (prev[args.targetPipelineId] || []).map(p =>
          p.userPlacementId === uuid ? { ...p, pendingWrite: false } : p
        ),
      }))
    }
  } catch (err) {
    // Server write failed — dragCrossPlacement already reverted the source-hide.
    // Remove the optimistic synthetic so the target row reflects reality.
    if (optimisticInserted) {
      setRawInactivePlacements(prev => ({
        ...prev,
        [args.targetPipelineId]: (prev[args.targetPipelineId] || []).filter(p => p.userPlacementId !== uuid),
      }))
    }
  }
}
```

Note: the existing `args.mode` is provided by `BRollTrack` ([BRollTrack.jsx:257-262](../../src/components/editor/BRollTrack.jsx#L257)) — `'copy'` if alt-key was held, otherwise `'move'`. `hideSourceForCrossDrop` returns `null` for `'copy'` so source stays put — correct copy semantics preserved.

- [ ] **Step 2: Verify imports are present**

The new code uses these already-imported names. Confirm at the top of `BRollEditor.jsx` that all are imported (check around line 3):

- `userPlacementToRawEntry` — already imported (existing usage at line 470).
- `authFetchBRollData` — already imported.
- `matchPlacementsToTranscript` — confirm it's imported. Search the file: `grep -n matchPlacementsToTranscript src/components/editor/BRollEditor.jsx`. If missing, add to the import line. (Existing handler used it, so it should already be there.)

- [ ] **Step 3: Run the related tests to ensure no regression**

```bash
npx vitest run src/components/editor/__tests__/BRollEditor.test.jsx
```

Expected: all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/BRollEditor.jsx
git commit -m "fix(broll): hide source instantly on cross-pipeline drop

Reorders onCrossDrop so the source-hide dispatch fires BEFORE the
pre-flight target-fetch round-trip. Removes the visible 'b-roll
stuck in old place for a couple of seconds' lag.

Adds revert paths for new early-returns: pre-flight fetch failure
and computeFitDropPosition returning null both un-hide the source
via revertCrossDropHide. Patches the undo entry's
targetUserPlacementSnapshot with the final adjusted range after
fit-check so undo/redo round-trips correctly.

The optimistic target synthetic carries pendingWrite: true until
the server PUT confirms — Task 4 renders the spinner."
```

---

## Task 4: Render `pendingWrite` spinner overlay in `BRollTrack`

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx:318-404`

- [ ] **Step 1: Add the overlay**

Open `src/components/editor/BRollTrack.jsx`. Find the `isUserPlacement` badge block (around line 386):

```jsx
            {p.isUserPlacement && (
              <div className="absolute top-1 right-1 z-10 bg-black/50 rounded p-0.5 pointer-events-none" title="Copied clip">
                <Copy size={8} className="text-white/70" />
              </div>
            )}
```

Insert this BEFORE that block, so the spinner sits on top of the thumbnail/title regardless of whether the placement also has the `Copy` badge:

```jsx
            {p.pendingWrite && (
              <div className="absolute inset-0 z-20 bg-black/40 flex items-center justify-center pointer-events-none" title="Saving…">
                <Loader2 size={14} className="text-primary-fixed animate-spin" />
              </div>
            )}
```

`Loader2` is already imported in this file (existing usage at line 361 in the `isSearching` branch).

- [ ] **Step 2: Visual verification — manual smoke**

Start the dev server:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npm run dev
```

In another terminal, start the API server (read `package.json` if uncertain — typically `npm run server` or check `scripts`).

Open the browser at the editor URL with multiple variants. Steps:
1. Drop a b-roll from the active variant onto an inactive variant.
2. **Expected:** source disappears from the active row INSTANTLY (no ~couple-second lag).
3. **Expected:** the synthetic in the inactive row shows a spinner overlay until the PUT completes (typically <1s if backend is warm).
4. **Expected:** spinner clears on success.

To force the failure path: open DevTools → Network → throttle to "Offline" right after starting the drag, then drop. Expected:
- Source still hides instantly (optimistic).
- Synthetic appears with spinner.
- PUT fails after `runWithTargetLock` retries.
- Synthetic disappears, source re-appears (revert).

To force the fit-check fail path: drop into a fully-occupied region of the target. Expected:
- Source briefly hides, then re-appears (revert).
- `alert('Not enough space at this drop position.')` shows.
- No synthetic appears.

To force the pre-flight fetch fail: stop the API server, then drop. Expected:
- Source briefly hides, then re-appears.
- `alert('Could not load target variant. Try again in a moment.')` shows.

Report: do all four scenarios behave as expected? If any deviates, debug before committing.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollTrack.jsx
git commit -m "feat(broll): show spinner overlay on optimistic target placement

Renders a Loader2 spinner over placements with pendingWrite=true so
users get clear in-flight feedback during cross-pipeline drops. The
overlay sits at z-20 above the thumbnail and the isUserPlacement
badge."
```

---

## Task 5: Full vitest run + final smoke

- [ ] **Step 1: Run all editor tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run src/components/editor/__tests__/
```

Expected: 100% pass.

- [ ] **Step 2: Run full vitest suite (sanity)**

```bash
npx vitest run
```

Expected: 131/131 pass (matches the project's known baseline per memory).

- [ ] **Step 3: Final manual smoke on a Vercel preview branch (if user pushes)**

Per repo convention, do NOT push without explicit user approval. If the user approves a push, the Vercel preview at `https://transcript-eval-sylvesterads-projects.vercel.app/editor/225/brolls/edit` will rebuild — test the four scenarios from Task 4 there to verify production-like behavior.

---

## Self-review checklist (run before handing off)

1. **Spec coverage:**
   - "Hide source instantly on cross-pipeline drop" → Task 2 + Task 3 ✓
   - "Show spinner on optimistic target placement" → Task 4 ✓
   - "Revert on failure (PUT, fetch, fit-check)" → Task 3 ✓
   - "Preserve copy mode (alt-key)" → Task 2 (`hideSourceForCrossDrop` returns null when mode !== 'move') + Task 3 (passes mode through) ✓
   - "Preserve undo/redo correctness" → Task 1 + Task 3 (PATCH_UNDO_ENTRY snapshot patch) ✓

2. **Type/name consistency:**
   - `hideSourceForCrossDrop` named identically across hook export, BRollEditor call, and tests ✓
   - `presourceActionId` / `presourcePlacement` named identically in dragCrossPlacement signature and call site ✓
   - `pendingWrite` flag name consistent in BRollEditor synthetic creation/clear and BRollTrack render ✓
   - `actionId` returned by `hideSourceForCrossDrop` consumed as `hideHandle.actionId` everywhere ✓

3. **No placeholders:** every code block above is the literal change. No "TODO", no "similar to X". ✓
