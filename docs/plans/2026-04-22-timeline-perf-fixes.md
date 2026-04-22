# Timeline & B-Roll Editor Performance Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the playback marker jumpiness and the remaining variant-switch blank frame in the b-roll editor at `/editor/:id/brolls/edit/:detail`, and eliminate the secondary render-cascade perf issues that make both symptoms worse as more b-rolls are added.

**Architecture:** Changes cluster into five waves. Wave 1 fixes the two user-visible symptoms directly. Wave 2 stops the 10 Hz render cascade that amplifies every other issue. Wave 3 stabilizes the rAF playback engine so it doesn't restart on unrelated state changes. Wave 4 tightens the remaining slow useMemos and fixes the stale-progressive-search data bug. Wave 5 removes dead code. Each wave is independently verifiable and shippable.

**Tech Stack:** React 19.2 (with StrictMode + automatic batching), Vite 8, no test framework — verification is manual via browser + Chrome DevTools + React DevTools Profiler.

---

## File Structure

Only files already in the codebase are modified — no new files.

- **Modify:** `src/components/editor/Timeline.jsx` — remove React write on playhead transform, memoize inline computations, gate currentTime-keyed useMemos, skip layoutEffect when zoom unchanged
- **Modify:** `src/components/editor/EditorView.jsx` — memoize EditorContext value, split tick's live-vs-stable deps, remove `state.cuts` from tick deps, drop stale `startPlayheadTime` reset on tick recreation
- **Modify:** `src/components/editor/useEditorState.js` — memoize `totalDuration`, return a stable object
- **Modify:** `src/components/editor/useBRollEditorState.js` — skip `SET_LOADING` when pre-seeded, fix `MERGE_SEARCH_RESULTS` to also update `placements`, remove dead `SET_DATA` case, guard first-load transcript race
- **Modify:** `src/components/editor/BRollEditor.jsx` — memoize BRollContext value, use AbortController for inactive-variant race guard
- **Modify:** `src/components/editor/BRollTrack.jsx` — wrap component in `React.memo`, stabilize prop refs from parent
- **Modify:** `src/components/editor/VideoFrameTrack.jsx` — wrap exported components in `React.memo`
- **Modify:** `src/components/editor/TimelineTrack.jsx` — wrap `AudioTrack`, `VideoTrack`, `CompositeAudioTrack` in `React.memo`
- **Modify:** `src/components/editor/BRollPreview.jsx` — move currentTime dependency to a ref read driven by rAF (not React re-render)

---

## Verification Conventions

No test framework exists, so each wave ends with a **manual verification checkpoint**. Open Chrome DevTools with Performance and React DevTools Profiler installed.

Unless a step says otherwise:
- **Dev server:** `npm run dev` (runs both client + server). Open `http://localhost:5173/editor/223/brolls/edit/0`.
- **Reset:** hard reload (Cmd-Shift-R) between checkpoints to clear state.
- **Profiler setup:** open React DevTools → Profiler tab → click record.

---

## Wave 1 — Fix the two visible bugs (P0)

Independent of all other waves. Ship after verification.

### Task 1: Make tick the sole writer of `playheadRef.current.style.transform`

**Root cause (Problem 1A):** The playhead's `style.transform` is written both by the 60 Hz rAF tick (with the live video clock) and by React on every Timeline re-render (with the 10 Hz-throttled `state.currentTime`). React's write lands after the tick's write, overriding the live value with a 0–100 ms-stale value. Every ~100 ms the marker jumps backward by the staleness.

**Files:**
- Modify: `src/components/editor/Timeline.jsx` — the playhead `<div>` at line 736-742 and `playheadX` at line 218
- Modify: `src/components/editor/EditorView.jsx:597-600` and `EditorView.jsx:654-656` — already the good path; nothing to add here

**Strategy:** Remove `transform` from the React-controlled style prop entirely. Add a `useLayoutEffect` that writes the initial/seek position synchronously on mount and whenever `state.zoom` changes (because zoom × currentTime = px, and zoom changes are user-driven, not 60 Hz).

- [ ] **Step 1: Remove `transform` from the playhead's `style` prop**

In `src/components/editor/Timeline.jsx` around line 736-742, change:

```jsx
          {/* Unified playhead — spans ruler + all tracks */}
          <div
            ref={playheadRef}
            className="absolute top-0 h-full w-[2px] bg-primary-fixed pointer-events-none z-20"
            style={{ transform: `translateX(${playheadX}px)`, left: '9rem' }}
          >
            <div className="sticky top-1 w-3.5 h-3.5 bg-primary-fixed rotate-45 rounded-sm" style={{ marginLeft: '-6px' }} />
          </div>
```

to:

```jsx
          {/* Unified playhead — spans ruler + all tracks.
              Transform is owned exclusively by the rAF playback engine (EditorView tick + seek)
              and by the zoom useLayoutEffect below. Do NOT bind transform from React render state
              or the 60fps engine and 10Hz React will fight and the marker will jump. */}
          <div
            ref={playheadRef}
            className="absolute top-0 h-full w-[2px] bg-primary-fixed pointer-events-none z-20"
            style={{ left: '9rem' }}
          >
            <div className="sticky top-1 w-3.5 h-3.5 bg-primary-fixed rotate-45 rounded-sm" style={{ marginLeft: '-6px' }} />
          </div>
```

- [ ] **Step 2: Delete the now-unused `playheadX` constant**

In `src/components/editor/Timeline.jsx` around line 218, delete:

```jsx
  const playheadX = state.currentTime * state.zoom
```

Run a sanity grep from the repo root:

```bash
grep -n "playheadX" src/components/editor/Timeline.jsx
```

Expected: no matches.

- [ ] **Step 3: Add a `useLayoutEffect` to write the playhead position on zoom change and on paused/seeked state**

In `src/components/editor/Timeline.jsx`, immediately after the existing `useLayoutEffect` block at lines 156-176 (the zoom-scroll adjuster), add a new `useLayoutEffect` that writes the playhead DOM transform synchronously when state changes that would otherwise be missed by the tick — initial mount, zoom change, and seeks while paused.

```jsx
  // Own the playhead transform for render-driven updates (mount, zoom change, paused-seek).
  // During playback the rAF engine in EditorView writes transform directly at 60fps;
  // this effect just covers the non-playing cases.
  useLayoutEffect(() => {
    if (!playheadRef.current) return
    playheadRef.current.style.transform = `translateX(${state.currentTime * state.zoom}px)`
  }, [state.zoom, state.currentTime, playheadRef])
```

Keep both existing effects (auto-scroll at 181-205 and paused-seek scroll at 208-216). They use `currentTimeRef` / read from DOM — they still work.

- [ ] **Step 4: Verify tick's direct DOM write still uses the latest zoom**

In `src/components/editor/EditorView.jsx` around line 597-600, confirm the code reads:

```jsx
    // Update playhead via ref (60fps, no React re-render)
    if (playheadRef.current) {
      const x = newTime * state.zoom
      playheadRef.current.style.transform = `translateX(${x}px)`
    }
```

No change needed — `state.zoom` is in tick's dep array, so tick gets the current zoom. Do NOT remove `state.zoom` from tick's deps in this task.

- [ ] **Step 5: Manual verification**

1. Restart dev server: `npm run dev`.
2. Navigate to `http://localhost:5173/editor/223/brolls/edit/0`.
3. Press space to play. Watch the marker closely at zoom 100+ (use the `+` button).
4. Expected: marker moves smoothly. No periodic backward jumps every ~100 ms.
5. Pause. Seek by clicking the ruler. Expected: marker jumps to the click location cleanly (driven by the new layout effect + `playbackEngine.seek`).
6. Change zoom with the +/- buttons while paused. Expected: marker stays anchored at `state.currentTime`.
7. Change zoom with Ctrl-wheel while playing. Expected: marker stays anchored at the cursor point (existing wheel-anchor logic).

- [ ] **Step 6: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/Timeline.jsx
git commit -m "fix(editor): make rAF tick the sole writer of playhead transform

React was writing state.currentTime * zoom to the playhead's style.transform
on every Timeline render (10Hz during playback), overriding the live 60fps
DOM writes from the tick with a 0-100ms-stale value. Every throttle interval
the marker jumped backward by the staleness. Remove the transform binding
from the JSX and cover mount/zoom/paused-seek with a useLayoutEffect."
```

---

### Task 2: Don't clobber the seeded cache — skip `SET_LOADING` when the pipeline already has fresh data

**Root cause (Problem 2A):** `handleVariantActivate` calls `seedFromCache` which dispatches `SET_DATA_RESOLVED` to populate `placements` from the inactive-variant cache. Then `setActiveVariantIdx` triggers a render; the load effect in `useBRollEditorState.js:141-151` sees `planPipelineId` changed and immediately dispatches `SET_LOADING`, which wipes the seed. The visible active-variant row goes empty until the fetch returns.

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` — extend `seedFromCache` to also mark the pipelineId as "fresh"; have the load effect skip `SET_LOADING` and the refetch when the fresh marker matches

**Strategy:** Track the pipelineId the seed was written for. The load effect skips `SET_LOADING` and the fetch entirely when the seed is for the current pipelineId and is still fresh (reducer state isn't empty).

- [ ] **Step 1: Add a `seededPipelineIdRef` and include pipelineId in the seed payload**

In `src/components/editor/useBRollEditorState.js`, inside the `useBRollEditorState` hook body (after `const pollRef = useRef(null)` at line 108), add:

```jsx
  // Tracks which pipelineId the current reducer state was seeded for — so the load effect
  // can skip SET_LOADING + fetch when a cached seed already populated placements.
  const seededPipelineIdRef = useRef(null)
```

- [ ] **Step 2: Record the seeded pipelineId in `seedFromCache`**

In the same file, change the `seedFromCache` implementation at lines 134-139:

```jsx
  // Seed cached placements synchronously (called by BRollEditor before variant switch)
  const seedFromCache = useCallback((rawPlacements, searchProgress) => {
    const visible = rawPlacements.filter(p => !p.hidden)
    const resolved = matchPlacementsToTranscript(visible, transcriptWordsRef.current)
    dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements, placements: resolved, searchProgress: searchProgress || null } })
  }, [])
```

to:

```jsx
  // Seed cached placements synchronously. Called by BRollEditor BEFORE setActiveVariantIdx,
  // so the pipelineId passed here is the INCOMING one.
  const seedFromCache = useCallback((pipelineId, rawPlacements, searchProgress) => {
    const visible = rawPlacements.filter(p => !p.hidden)
    const resolved = matchPlacementsToTranscript(visible, transcriptWordsRef.current)
    seededPipelineIdRef.current = pipelineId
    dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements, placements: resolved, searchProgress: searchProgress || null } })
  }, [])
```

- [ ] **Step 3: Update `BRollEditor.jsx` to pass the new pipelineId argument**

In `src/components/editor/BRollEditor.jsx` around line 84-87, change:

```jsx
    if (cached?.length) {
      // Seed synchronously — the fetch useEffect will still fire and refresh, but we won't flash empty
      brollState.seedFromCache(cached)
    }
```

to:

```jsx
    if (cached?.length) {
      // Seed synchronously. The load effect will see the seededPipelineIdRef match
      // and skip the SET_LOADING clear, avoiding a blank frame.
      brollState.seedFromCache(newPid, cached)
    }
```

- [ ] **Step 4: Make the load effect skip `SET_LOADING` and fetch when the seed matches**

In `src/components/editor/useBRollEditorState.js` at lines 141-151, change:

```jsx
  useEffect(() => {
    if (!planPipelineId) return
    dispatch({ type: 'SET_LOADING' })
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => {
        const visible = (data.placements || []).filter(p => !p.hidden)
        const resolved = matchPlacementsToTranscript(visible, transcriptWordsRef.current)
        dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements: data.placements, placements: resolved, searchProgress: data.searchProgress } })
      })
      .catch(err => dispatch({ type: 'SET_ERROR', payload: err.message }))
  }, [planPipelineId])
```

to:

```jsx
  useEffect(() => {
    if (!planPipelineId) return

    // If seedFromCache just populated the reducer for this exact pipelineId, skip the
    // LOADING→fetch→RESOLVED round-trip. The caller will get a live refresh via the
    // inactive-variant polling loop in BRollEditor if a search is running.
    if (seededPipelineIdRef.current === planPipelineId) {
      seededPipelineIdRef.current = null
      return
    }

    dispatch({ type: 'SET_LOADING' })
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => {
        const visible = (data.placements || []).filter(p => !p.hidden)
        const resolved = matchPlacementsToTranscript(visible, transcriptWordsRef.current)
        dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements: data.placements, placements: resolved, searchProgress: data.searchProgress } })
      })
      .catch(err => dispatch({ type: 'SET_ERROR', payload: err.message }))
  }, [planPipelineId])
```

- [ ] **Step 5: Manual verification**

1. Restart dev server. Navigate to `http://localhost:5173/editor/223/brolls/edit/0`.
2. Ensure at least two variants exist (the scenario that triggers the bug).
3. Let both variants load fully (thumbnails visible on inactive rows).
4. Click a b-roll on the **inactive** variant's row.
5. Expected: the active variant row switches and shows the cached thumbnails IMMEDIATELY, with no empty frame. The previously-active row transitions to the inactive style without blanking.
6. Open React DevTools Profiler. Record a click on an inactive variant's b-roll. Expected: no commit where the active BRollTrack's visible-children list goes empty.
7. Click back and forth between variants several times. Verify each switch is seamless.

- [ ] **Step 6: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/useBRollEditorState.js src/components/editor/BRollEditor.jsx
git commit -m "fix(broll): skip SET_LOADING when variant switch pre-seeded from cache

handleVariantActivate seeds placements from rawInactivePlacements via
seedFromCache, but the load useEffect immediately dispatched SET_LOADING
afterward, clobbering the seed and producing a blank active row until the
refetch returned. Track the pipelineId the seed was written for in a ref;
the load effect now short-circuits when the seed matches the incoming
pipelineId."
```

---

### Wave 1 checkpoint

Run through the full b-roll edit flow once more: play, seek, zoom, switch variants at high zoom. Both visible bugs should be gone. Commit any incidental fixes before moving to Wave 2. If a regression appeared, revert the two commits and investigate before continuing.

---

## Wave 2 — Stop the 10 Hz render cascade (P1)

Every 100 ms during playback, `SET_CURRENT_TIME` dispatches → `state` changes → EditorView re-renders → `<EditorContext.Provider value={{...}}>` creates a fresh object → every consumer re-renders → Timeline re-renders all children → no `React.memo` stops the cascade. Wave 2 cuts this off at three points: the two context values and the track leaf components.

### Task 3: Memoize `useEditorState`'s return value

**Root cause (Problem 3C):** `useEditorState.js:697` returns a fresh `{ state, dispatch, totalDuration, formatTime, canUndo, canRedo }` every render. This feeds the context value in Task 4.

**Files:**
- Modify: `src/components/editor/useEditorState.js` — memoize `totalDuration` and the return object

- [ ] **Step 1: Memoize `totalDuration`**

In `src/components/editor/useEditorState.js` around line 695, change:

```jsx
  const totalDuration = state.tracks.reduce((max, t) => Math.max(max, t.offset + t.duration), 0)

  return { state, dispatch, totalDuration, formatTime, canUndo, canRedo }
```

to:

```jsx
  const totalDuration = useMemo(
    () => state.tracks.reduce((max, t) => Math.max(max, t.offset + t.duration), 0),
    [state.tracks]
  )

  return useMemo(
    () => ({ state, dispatch, totalDuration, formatTime, canUndo, canRedo }),
    [state, totalDuration, canUndo, canRedo]
  )
```

Note: `dispatch` is a stable reference from `useReducer`. `formatTime` is imported — already stable. `canUndo` / `canRedo` are plain values; including them as deps is correct if they're computed earlier in the hook. If they aren't — grep first:

```bash
grep -n "canUndo\|canRedo" src/components/editor/useEditorState.js
```

If either is a function reference that changes every render, that function must be wrapped in `useCallback` first. If either is a boolean / number, no change needed. Report and adjust if grep reveals unexpected shape.

- [ ] **Step 2: Verify `useMemo` is imported**

At the top of `src/components/editor/useEditorState.js`, check the React import line. If `useMemo` is missing, add it to the import.

- [ ] **Step 3: Sanity check — no production code change in behavior**

Navigate to any editor tab. Expected: everything still works. `state` is a new object after every dispatch (by reducer semantics), so the memo dep `state` still changes on every dispatch — the memoization only helps when `state` didn't change (idle renders triggered from parent).

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/useEditorState.js
git commit -m "perf(editor): memoize useEditorState totalDuration + return object

Reduces churn in the EditorContext value in the next task."
```

---

### Task 4: Memoize the `EditorContext.Provider` value

**Root cause (Problem 1B):** `EditorView.jsx:787` creates a fresh `value={{...}}` object on every render. Every `SET_CURRENT_TIME` dispatch triggers a new context value → all ~20 consumers re-render at 10 Hz.

**Files:**
- Modify: `src/components/editor/EditorView.jsx:787`

- [ ] **Step 1: Wrap the context value in `useMemo`**

In `src/components/editor/EditorView.jsx`, the Provider is declared inline on line 787. Above the `return (` on line 786, add a memoized value, then use it in the Provider.

Find the block near line 786:

```jsx
  return (
    <EditorContext.Provider value={{ state, dispatch, videoRefs, playbackEngine, playheadRef, totalDuration, formatTime, refetchDetail, refetchTimestamps, flowRunState, cutDragRef, tokenBalance, handleStartAIRoughCut, estimationLoading }}>
```

Change to:

```jsx
  const editorContextValue = useMemo(
    () => ({ state, dispatch, videoRefs, playbackEngine, playheadRef, totalDuration, formatTime, refetchDetail, refetchTimestamps, flowRunState, cutDragRef, tokenBalance, handleStartAIRoughCut, estimationLoading }),
    [state, dispatch, totalDuration, formatTime, refetchDetail, refetchTimestamps, flowRunState, tokenBalance, handleStartAIRoughCut, estimationLoading]
  )

  return (
    <EditorContext.Provider value={editorContextValue}>
```

Place the `useMemo` call **before** the early `if (loading)` / `if (error)` / `if (isAssembling)` returns around lines 753-784 — otherwise React's rules-of-hooks will complain about conditional hook calls. Put it immediately after the last `useEffect` block (around line 751, after the keyboard shortcuts `useEffect`) and before the first conditional return.

`videoRefs`, `playbackEngine`, `playheadRef`, `cutDragRef` are `useRef` results — stable across renders, no need to list them as deps (they never change identity). `dispatch` is stable from `useReducer`.

- [ ] **Step 2: Verify `useMemo` is imported**

The import at line 1 of `EditorView.jsx` already includes `useMemo`. No change.

- [ ] **Step 3: Manual verification with React DevTools Profiler**

1. Restart dev server. Navigate to `http://localhost:5173/editor/223/brolls/edit/0`.
2. Open React DevTools Profiler, click record, press space to play for 2 seconds, stop recording.
3. In the Profiler flame graph, find `BRollDetailPanel` (if a placement is selected). Expected: ~20 commits in 2 seconds (one per `SET_CURRENT_TIME`) but each commit for `BRollDetailPanel` shows **"Did not render"** (gray in Profiler's "render reason" column) because its inputs from context didn't change.
4. Before this task it would re-render on every commit.
5. Repeat for `PlaybackControls`, `VideoPreviewGrid`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/EditorView.jsx
git commit -m "perf(editor): memoize EditorContext provider value

Value was a fresh object literal every render, causing all ~20 consumers
to re-render at 10Hz (the SET_CURRENT_TIME dispatch rate during playback).
useMemo gates the value object so consumers only re-render when their
specific slice actually changed."
```

---

### Task 5: Memoize the `BRollContext.Provider` value

**Root cause (Problem 1B, B-Roll half):** `BRollEditor.jsx:165` — `<BRollContext.Provider value={brollState}>`. `brollState` is the return object of `useBRollEditorState`, which is a fresh object per render.

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js:253-273` — wrap the return in `useMemo`

- [ ] **Step 1: Wrap the hook's return value in `useMemo`**

In `src/components/editor/useBRollEditorState.js` around line 253, change:

```jsx
  return {
    rawPlacements: state.rawPlacements,
    placements: state.placements,
    seedFromCache,
    selectedIndex: state.selectedIndex,
    selectedPlacement,
    selectedResults: state.selectedResults,
    searchProgress: state.searchProgress,
    loading: state.loading,
    error: state.error,
    selectPlacement,
    selectResult,
    activePlacementAtTime,
    searchPlacement,
    searchPlacementCustom,
    hidePlacement,
    updatePlacementPosition,
    resetAllPlacements: useCallback(() => dispatch({ type: 'RESET_ALL_PLACEMENTS' }), []),
    refetchEditorData,
    planPipelineId,
  }
```

**Step 1a:** Lift the inlined `useCallback` for `resetAllPlacements` out to a named callback above the return — a `useCallback` call inside an object literal at return time recreates the callback every render even if deps are stable (because it's run inside the render, always). Above the `return` block, add:

```jsx
  const resetAllPlacements = useCallback(() => dispatch({ type: 'RESET_ALL_PLACEMENTS' }), [])
```

**Step 1b:** Replace the return with:

```jsx
  return useMemo(() => ({
    rawPlacements: state.rawPlacements,
    placements: state.placements,
    seedFromCache,
    selectedIndex: state.selectedIndex,
    selectedPlacement,
    selectedResults: state.selectedResults,
    searchProgress: state.searchProgress,
    loading: state.loading,
    error: state.error,
    selectPlacement,
    selectResult,
    activePlacementAtTime,
    searchPlacement,
    searchPlacementCustom,
    hidePlacement,
    updatePlacementPosition,
    resetAllPlacements,
    refetchEditorData,
    planPipelineId,
  }), [
    state.rawPlacements, state.placements, state.selectedIndex, selectedPlacement,
    state.selectedResults, state.searchProgress, state.loading, state.error,
    seedFromCache, selectPlacement, selectResult, activePlacementAtTime,
    searchPlacement, searchPlacementCustom, hidePlacement, updatePlacementPosition,
    resetAllPlacements, refetchEditorData, planPipelineId,
  ])
```

Most of the callbacks are already `useCallback` wrapped in the existing code. `selectedPlacement` is a `useMemo` — stable when `[selectedIndex, placements]` unchanged. The memo dep list will only change on real data/selection changes, not on every render.

- [ ] **Step 2: Manual verification**

Same as Task 4 — open Profiler, record a 2-second playback, confirm `BRollTrack`, `BRollDetailPanel`, `BRollPreview` no longer re-render on every `SET_CURRENT_TIME` commit. (They may re-render for other reasons, like state.currentTime dependencies elsewhere. We'll fix those in later tasks.)

- [ ] **Step 3: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/useBRollEditorState.js
git commit -m "perf(broll): memoize useBRollEditorState return object

BRollContext consumers were re-rendering at 10Hz because the hook returned
a new object on every render, feeding directly into BRollContext.Provider
value. useMemo stabilizes the returned shape."
```

---

### Task 6: Add `React.memo` to `BRollTrack`

**Root cause (Problem 3A):** No memoized leaf components in the editor tree. `BRollTrack` is rendered up to `N_variants` times per Timeline render; each re-render walks all its placements.

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx` — wrap default export in `React.memo`
- Modify: `src/components/editor/Timeline.jsx` — ensure the `onActivate` prop is stable

- [ ] **Step 1: Stabilize `onActivate` in Timeline**

In `src/components/editor/Timeline.jsx` around line 644-652, the `onActivate` handler is defined inline:

```jsx
                        onActivate={(selectIndex) => onVariantActivate?.(vi, selectIndex)}
```

This closure is fresh every render. With `React.memo`, this would defeat the memoization. Instead, hoist a memoized factory above the render.

**Step 1a:** Above the `return (` at line 474, just after `handleTrackDragStart` (line 472), add:

```jsx
  // Stable per-variant onActivate factories for BRollTrack memoization
  const variantActivators = useMemo(() => {
    const out = []
    for (let vi = 0; vi < brollVariantCount; vi++) {
      out.push((selectIndex) => onVariantActivate?.(vi, selectIndex))
    }
    return out
  }, [brollVariantCount, onVariantActivate])
```

**Step 1b:** Change the BRollTrack usage at line 644-652:

```jsx
                    <div className={`flex-1 relative z-0 ${!isActiveVariant ? 'opacity-40' : ''}`}>
                      <BRollTrack
                        zoom={state.zoom}
                        scrollRef={scrollRef}
                        scrollX={scrollX}
                        isActive={isActiveVariant}
                        onActivate={(selectIndex) => onVariantActivate?.(vi, selectIndex)}
                        overridePlacements={!isActiveVariant ? inactiveVariantPlacements?.[variants?.[vi]?.id] : undefined}
                      />
                    </div>
```

to:

```jsx
                    <div className={`flex-1 relative z-0 ${!isActiveVariant ? 'opacity-40' : ''}`}>
                      <BRollTrack
                        zoom={state.zoom}
                        scrollRef={scrollRef}
                        scrollX={scrollX}
                        isActive={isActiveVariant}
                        onActivate={variantActivators[vi]}
                        overridePlacements={!isActiveVariant ? inactiveVariantPlacements?.[variants?.[vi]?.id] : undefined}
                      />
                    </div>
```

Note: `scrollRef` is a `useRef` — stable. `scrollX` is a number, stable when unchanged. `state.zoom` is a number. `isActiveVariant` is a boolean. `overridePlacements` stabilizes in Task 9.

- [ ] **Step 2: Wrap `BRollTrack` in `React.memo`**

In `src/components/editor/BRollTrack.jsx`, change the default export. Replace:

```jsx
export default function BRollTrack({ zoom, scrollRef, scrollX, isActive = true, onActivate, overridePlacements }) {
```

to:

```jsx
function BRollTrack({ zoom, scrollRef, scrollX, isActive = true, onActivate, overridePlacements }) {
```

and at the bottom of the file, change:

```jsx
export { TRACK_H as BROLL_TRACK_H }
```

to:

```jsx
export default memo(BRollTrack)
export { TRACK_H as BROLL_TRACK_H }
```

Wait — there's already a `export default function BRollTrack` at the top. We can't have two default exports. Fix by:

1. At the top, remove `default` from the declaration: `function BRollTrack(...)`.
2. At the bottom, ensure only **one** `export default` line.

The final file structure:

```jsx
import { useMemo, useContext, useCallback, memo } from 'react'
// ... rest of imports
const TRACK_H = 60

function BRollTrack({ zoom, scrollRef, scrollX, isActive = true, onActivate, overridePlacements }) {
  // ... body unchanged
}

export default memo(BRollTrack)
export { TRACK_H as BROLL_TRACK_H }
```

- [ ] **Step 3: Manual verification**

1. Restart dev server. Open Profiler.
2. Navigate to the b-roll edit view. Record 2 s of playback.
3. Expand commits. Find `BRollTrack`. Expected: "Did not render" on every commit during playback (props unchanged).
4. Click an inactive variant. Expected: one render commit per BRollTrack instance (props actually changed) — then quiet again.

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/BRollTrack.jsx src/components/editor/Timeline.jsx
git commit -m "perf(broll): memo BRollTrack + stabilize onActivate prop

BRollTrack was re-rendering at 10Hz with every parent render even when its
props were identical. Wrapping in React.memo and stabilizing the inline
onActivate closure in Timeline cuts the re-renders to only when real
inputs change."
```

---

### Task 7: Add `React.memo` to `AudioTrack`, `VideoTrack`, `CompositeAudioTrack`, `VideoFrameTrack`, `CompositeFrameTrack`

**Root cause (Problem 3A):** Same as Task 6 but for the non-b-roll tracks. These components render a waveform / video frame strip per audio or video track. Currently re-rendering at 10 Hz.

**Files:**
- Modify: `src/components/editor/TimelineTrack.jsx` — `AudioTrack`, `VideoTrack`, `CompositeAudioTrack`
- Modify: `src/components/editor/VideoFrameTrack.jsx` — default export `VideoFrameTrack`, named export `CompositeFrameTrack`

- [ ] **Step 1: Wrap each export in `memo`**

For each component above, follow the same pattern as Task 6. Expose the memoized version while keeping the name.

Example for `AudioTrack` in `TimelineTrack.jsx`:

Find the existing export (likely `export function AudioTrack(...)` or `export default`). Convert to:

```jsx
import { memo /*, other imports */ } from 'react'

function AudioTrack({ /* props */ }) {
  // body unchanged
}

export const AudioTrack = memo(AudioTrackImpl)
```

Actually simpler: rename the function to `AudioTrackImpl` and add `export const AudioTrack = memo(AudioTrackImpl)`. Repeat for each of `VideoTrack`, `CompositeAudioTrack`.

For `VideoFrameTrack.jsx` (default export), use the same pattern as Task 6 — rename the function, add `export default memo(VideoFrameTrack)`. For `CompositeFrameTrack` (named export), same rename + `export const CompositeFrameTrack = memo(CompositeFrameTrackImpl)`.

Before editing, grep each file for its export shape:

```bash
grep -n "^export\|^function " src/components/editor/TimelineTrack.jsx src/components/editor/VideoFrameTrack.jsx
```

Adjust the conversion per the actual shape — do not assume.

- [ ] **Step 2: Check props are stable — `cuts` prop is a fresh array every render**

In `Timeline.jsx` line 722-724, `AudioTrack` and `VideoFrameTrack` receive `cuts={isRoughCut ? mergedDisplayCuts : []}` and `cuts={isRoughCut ? state.cuts : null}`. `mergedDisplayCuts` is memoized — stable when `state.cuts`/`state.tracks` unchanged. The `[]` literal on the falsy branch is a fresh array every render.

**Step 2a:** Near the top of the Timeline component body (after the `useState`/`useRef` declarations around line 18), add:

```jsx
  // Stable empty-cuts reference for the falsy branch of track `cuts` props
  const EMPTY_CUTS = useMemo(() => [], [])
```

**Step 2b:** At the usage site around lines 722-724, change `isRoughCut ? mergedDisplayCuts : []` to `isRoughCut ? mergedDisplayCuts : EMPTY_CUTS`. Leave the `state.cuts : null` branch alone — `null` is a stable primitive.

- [ ] **Step 3: Manual verification**

Open Profiler. Record 2 s of playback. Find `AudioTrack` / `VideoFrameTrack` instances. Expected: "Did not render" on commits during playback.

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/TimelineTrack.jsx src/components/editor/VideoFrameTrack.jsx src/components/editor/Timeline.jsx
git commit -m "perf(editor): memo audio/video track leaf components

AudioTrack, VideoTrack, CompositeAudioTrack, VideoFrameTrack, and
CompositeFrameTrack were re-rendering on every parent render even when
their props were unchanged. Wrapping each in React.memo + stabilizing
the empty-cuts fallback in Timeline cuts the cascade."
```

---

### Wave 2 checkpoint

Open React DevTools Profiler, record 3 seconds of playback with the b-roll editor open and multiple variants. Expected: the bulk of commits during playback should show only `EditorView`, `Timeline`, `TranscriptEditor` (if visible), and `BRollPreview` as actually rendering. All track components should be "Did not render". Commit count-per-second should be ~10 (matching the SET_CURRENT_TIME throttle). No visual regressions.

---

## Wave 3 — Stabilize the rAF playback engine (P1-P2)

### Task 8: Split `tick`'s deps into live (refs) and effectful (state) — stop rAF restarts on unrelated state changes

**Root cause (Problem 1C):** `tick`'s `useCallback` has 11 deps. Any change recreates `tick`, the start/stop effect at line 619-629 tears down and re-creates the rAF loop, and `startPlayheadTime.current = state.currentTime` resets the baseline to a stale (10 Hz-throttled) value.

**Files:**
- Modify: `src/components/editor/EditorView.jsx` — introduce refs that mirror the hot state tick reads, keep tick's deps to ones that should genuinely restart the loop (`dispatch`, stable refs)

**Strategy:** Mirror every `state.*` read inside `tick` into a ref assigned at the top of the component body. `tick` reads from refs. Its `useCallback` deps drop to `[]` (or only `dispatch`, which is stable). The start/stop effect now depends on `state.isPlaying` only — it won't fire on any other state change.

- [ ] **Step 1: Add live-state refs**

In `src/components/editor/EditorView.jsx` after the existing refs around line 72-79, add:

```jsx
  // Mirror all state values that tick reads, so tick's useCallback deps can be empty
  // and the rAF loop doesn't restart on every unrelated state change.
  const stateRefs = useRef({
    tracks: state.tracks,
    playbackRate: state.playbackRate,
    zoom: state.zoom,
    volume: state.volume,
    activeTab: state.activeTab,
    roughCutTrackMode: state.roughCutTrackMode,
    segmentVideoOverrides: state.segmentVideoOverrides,
    segmentAudioOverrides: state.segmentAudioOverrides,
    totalDuration,
  })
  stateRefs.current.tracks = state.tracks
  stateRefs.current.playbackRate = state.playbackRate
  stateRefs.current.zoom = state.zoom
  stateRefs.current.volume = state.volume
  stateRefs.current.activeTab = state.activeTab
  stateRefs.current.roughCutTrackMode = state.roughCutTrackMode
  stateRefs.current.segmentVideoOverrides = state.segmentVideoOverrides
  stateRefs.current.segmentAudioOverrides = state.segmentAudioOverrides
  stateRefs.current.totalDuration = totalDuration
```

Place this above the `tick` useCallback declaration (which is around line 412).

- [ ] **Step 2: Rewrite tick to read from `stateRefs.current`**

Rewrite the `tick` `useCallback` to read state from the ref. Every occurrence of `state.tracks`, `state.playbackRate`, etc., inside tick's body becomes `stateRefs.current.tracks`, etc. `totalDuration` becomes `stateRefs.current.totalDuration`.

Full rewrite — replace the existing tick (`EditorView.jsx:412-609`) with:

```jsx
  const tick = useCallback(() => {
    const now = performance.now()
    const s = stateRefs.current
    const videoTracks = s.tracks.filter(t => t.type === 'video')

    // Find master element: prefer unmuted active track, fall back to any playing track
    let masterEl = null
    let masterTrack = null
    for (const track of videoTracks) {
      const el = videoRefs.current[track.videoId]
      if (!el || el.paused || el.readyState < 2) continue
      const audioTrack = s.tracks.find(t => t.type === 'audio' && t.videoId === track.videoId)
      const isUnmuted = audioTrack && !audioTrack.muted
      if (isUnmuted || !masterEl) {
        masterEl = el
        masterTrack = track
        if (isUnmuted) break
      }
    }

    let newTime
    if (masterEl) {
      newTime = masterEl.currentTime + masterTrack.offset
      startPlayheadTime.current = newTime
      startRealTime.current = now
    } else {
      const shouldBeActive = videoTracks.some(t => {
        if (!videoRefs.current[t.videoId]) return false
        const localTime = startPlayheadTime.current - t.offset
        return localTime >= 0 && localTime <= t.duration
      })
      if (shouldBeActive) {
        newTime = startPlayheadTime.current
      } else {
        const elapsed = (now - startRealTime.current) / 1000
        newTime = startPlayheadTime.current + elapsed * s.playbackRate
      }
    }

    if (newTime >= s.totalDuration) {
      dispatch({ type: 'SET_CURRENT_TIME', payload: s.totalDuration })
      dispatch({ type: 'PAUSE' })
      stopAllVideos()
      return
    }

    const regions = skipRegionsRef.current
    if (s.activeTab === 'roughcut' && regions.length > 0) {
      const preSkipTime = newTime
      let skipping = true
      while (skipping) {
        skipping = false
        for (const region of regions) {
          if (newTime >= region.start && newTime < region.end) {
            newTime = region.end
            skipping = true
            break
          }
        }
      }
      if (newTime !== preSkipTime) {
        startPlayheadTime.current = newTime
        startRealTime.current = now
        for (const vt of videoTracks) {
          const el = videoRefs.current[vt.videoId]
          if (el) {
            const lt = newTime - vt.offset
            if (lt >= 0 && lt <= vt.duration) el.currentTime = lt
          }
        }
        if (newTime >= s.totalDuration) {
          dispatch({ type: 'SET_CURRENT_TIME', payload: s.totalDuration })
          dispatch({ type: 'PAUSE' })
          stopAllVideos()
          return
        }
      }
    }

    const isMainMode = s.activeTab === 'roughcut' && s.roughCutTrackMode === 'main'
    let mainActiveVideoId = null
    let mainActiveAudioId = null
    let mainSegIdx = -1
    if (isMainMode) {
      const sorted = [...videoTracks].sort((a, b) => a.offset - b.offset)
      const segments = []
      let cur = null
      for (const t of sorted) {
        const tEnd = t.offset + t.duration
        if (cur && t.offset < cur.end) {
          cur.end = Math.max(cur.end, tEnd)
        } else {
          cur = { start: t.offset, end: tEnd, videoId: t.videoId }
          segments.push(cur)
        }
      }
      if (segments.length) {
        for (let i = segments.length - 1; i >= 0; i--) {
          if (newTime >= segments[i].start) {
            mainActiveVideoId = segments[i].videoId
            mainSegIdx = i
            break
          }
        }
        if (!mainActiveVideoId) {
          mainActiveVideoId = segments[0].videoId
          mainSegIdx = 0
        }
      }

      if (mainSegIdx >= 0) {
        const vidOv = s.segmentVideoOverrides[mainSegIdx]
        if (vidOv) {
          const ovTrack = videoTracks.find(t => t.videoId === vidOv)
          if (ovTrack && newTime >= ovTrack.offset && newTime < ovTrack.offset + ovTrack.duration) {
            mainActiveVideoId = vidOv
          }
        }
      }

      mainActiveAudioId = mainActiveVideoId
      if (mainSegIdx >= 0) {
        const audioOv = s.segmentAudioOverrides[mainSegIdx]
        if (audioOv) {
          const ovTrack = videoTracks.find(t => t.videoId === audioOv)
          if (ovTrack && newTime >= ovTrack.offset && newTime < ovTrack.offset + ovTrack.duration) {
            mainActiveAudioId = audioOv
          }
        }
      }
    }

    for (const track of videoTracks) {
      const el = videoRefs.current[track.videoId]
      if (!el) continue
      const localTime = newTime - track.offset
      if (localTime >= 0 && localTime <= track.duration) {
        if (el !== masterEl && Math.abs(el.currentTime - localTime) > 0.3) {
          el.currentTime = localTime
        }
        el.playbackRate = s.playbackRate

        const audioTrack = s.tracks.find(t => t.type === 'audio' && t.videoId === track.videoId)
        if (isMainMode) {
          if (track.videoId === mainActiveAudioId) {
            el.muted = false
            el.volume = s.volume
          } else {
            el.muted = true
          }
        } else if (audioTrack && !audioTrack.muted) {
          el.muted = false
          el.volume = s.volume
        } else {
          el.muted = true
        }

        if (el.paused && (track.visible || (!el.muted))) {
          el.play().catch(() => {})
        }
      } else {
        if (!el.paused) el.pause()
        el.muted = true
      }
    }

    if (playheadRef.current) {
      const x = newTime * s.zoom
      playheadRef.current.style.transform = `translateX(${x}px)`
    }

    if (now - throttleRef.current > 100) {
      throttleRef.current = now
      dispatch({ type: 'SET_CURRENT_TIME', payload: newTime })
    }

    rafId.current = requestAnimationFrame(tick)
  }, [dispatch, stopAllVideos])
```

Note the deps: `[dispatch, stopAllVideos]`. `dispatch` is stable. `stopAllVideos` is already `useCallback([])`. `tick` will now essentially never recreate.

- [ ] **Step 3: Change the start/stop effect to remove the stale `startPlayheadTime` reset**

The effect at lines 619-629 currently resets `startPlayheadTime.current = state.currentTime` every time tick changes. Since tick is now stable, this is no longer fired spuriously. But the effect is also triggered on `state.isPlaying` toggles — which is the correct signal for play/pause.

Replace the effect body at lines 619-629:

```jsx
  useEffect(() => {
    if (state.isPlaying) {
      startRealTime.current = performance.now()
      startPlayheadTime.current = state.currentTime
      rafId.current = requestAnimationFrame(tick)
    } else {
      cancelAnimationFrame(rafId.current)
      stopAllVideos()
    }
    return () => cancelAnimationFrame(rafId.current)
  }, [state.isPlaying, tick, stopAllVideos])
```

with:

```jsx
  useEffect(() => {
    if (state.isPlaying) {
      // Seed the rAF baseline from the current state at the moment play begins.
      // This runs only on play-toggle, not on every tick-recreation.
      startRealTime.current = performance.now()
      startPlayheadTime.current = state.currentTime
      rafId.current = requestAnimationFrame(tick)
    } else {
      cancelAnimationFrame(rafId.current)
      stopAllVideos()
    }
    return () => cancelAnimationFrame(rafId.current)
  }, [state.isPlaying]) // tick is stable (only deps on dispatch/stopAllVideos — both stable); state.currentTime intentionally not a dep (only read on play-start)
```

The disable-exhaustive-deps comment is encoded in the trailing comment. If the project uses eslint-plugin-react-hooks and this triggers a warning, add `// eslint-disable-next-line react-hooks/exhaustive-deps` above the `}, [state.isPlaying])` line.

- [ ] **Step 4: Sanity grep**

```bash
grep -n "state\." src/components/editor/EditorView.jsx | grep -v "^[0-9]*:\s*//" | head -40
```

Skim — ensure `state.*` reads inside tick's body have all been replaced with `s.*` reads. Inside other functions (`stopAllVideos`, `playbackEngine`, keyboard handlers) they're fine.

- [ ] **Step 5: Manual verification**

1. Restart dev server.
2. Play. Expected: marker moves smoothly; no hiccups when annotations/cuts get updated in the background (e.g., hover over transcript).
3. Drag a b-roll placement while playing. Expected: no backward jump of the marker (previously would reset on `state.cuts` change — not that this path triggers cuts, but catches the general class).
4. Toggle roughCutTrackMode (main/all). Expected: playback continues smoothly.
5. Change zoom while playing via +/- buttons. Expected: marker stays attached to its logical time position.

- [ ] **Step 6: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/EditorView.jsx
git commit -m "perf(editor): read hot playback state from refs inside tick

tick's useCallback had 11 state deps; any change recreated tick, tore down
the rAF loop, and reset startPlayheadTime.current to the stale (10Hz-
throttled) state.currentTime — causing visible backward marker jumps when
unrelated state changed during playback. Mirror hot state into a ref
updated on every render; tick reads from the ref; tick's deps collapse
to [dispatch, stopAllVideos] and are effectively stable."
```

---

## Wave 4 — Tighten the remaining slow useMemos + fix stale-search data (P2)

### Task 9: Stabilize the `inactiveVariantPlacements` prop identity

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx`

**Root cause:** `inactiveVariantPlacements` is a fresh object every time `rawInactivePlacements` or `transcriptWords` changes, **even if the keys-and-values are the same**. It's passed through Timeline to BRollTrack as `overridePlacements`. With Task 6's `React.memo`, this prop identity still causes re-renders when the actual data hasn't changed.

- [ ] **Step 1: Skip recomputation when inputs haven't changed (already happens via useMemo) — but stabilize the inner per-pid array identity**

In `src/components/editor/BRollEditor.jsx` around line 93-99, replace:

```jsx
  const inactiveVariantPlacements = useMemo(() => {
    const resolved = {}
    for (const [pid, placements] of Object.entries(rawInactivePlacements)) {
      resolved[pid] = matchPlacementsToTranscript(placements, transcriptWords)
    }
    return resolved
  }, [rawInactivePlacements, transcriptWords])
```

with a version that memoizes per-pid results so individual array references stay stable when only one variant's raw changed:

```jsx
  const resolvedCacheRef = useRef(new Map())
  const inactiveVariantPlacements = useMemo(() => {
    const cache = resolvedCacheRef.current
    const out = {}
    const seen = new Set()
    for (const [pid, placements] of Object.entries(rawInactivePlacements)) {
      seen.add(pid)
      const cached = cache.get(pid)
      if (cached && cached.raw === placements && cached.words === transcriptWords) {
        out[pid] = cached.resolved
        continue
      }
      const resolved = matchPlacementsToTranscript(placements, transcriptWords)
      cache.set(pid, { raw: placements, words: transcriptWords, resolved })
      out[pid] = resolved
    }
    // Evict stale entries
    for (const pid of cache.keys()) {
      if (!seen.has(pid)) cache.delete(pid)
    }
    return out
  }, [rawInactivePlacements, transcriptWords])
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/BRollEditor.jsx
git commit -m "perf(broll): stable per-pid refs in inactiveVariantPlacements

Previously every recomputation produced a fresh object AND fresh arrays
per pid, triggering React.memo in BRollTrack to treat every re-render as
a prop change. Cache per-pid resolved arrays keyed on (raw, words)."
```

---

### Task 10: Fix `MERGE_SEARCH_RESULTS` not updating `placements` (stale thumbnails during active search)

**Root cause (Problem 2B latent):** `useBRollEditorState.js:42-52` — `MERGE_SEARCH_RESULTS` updates `state.rawPlacements` but not `state.placements`. Because `matchPlacementsToTranscript` creates new objects via `{ ...p }`, the `results` and `searchStatus` on `placements[i]` are frozen at the time of the last `SET_DATA_RESOLVED`. The BRollTrack renders `placements`, so progressive search results never show until transcriptWords happens to change.

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Update the `MERGE_SEARCH_RESULTS` reducer case to also update placements**

In `useBRollEditorState.js` around line 42-52, replace:

```jsx
    case 'MERGE_SEARCH_RESULTS': {
      const { placements: newPlacements, searchProgress } = action.payload
      const merged = state.rawPlacements.map((existing, i) => {
        if (existing.hidden) return existing
        const updated = newPlacements[i]
        if (!updated) return existing
        if (existing.searchStatus === 'complete' && updated.searchStatus === 'pending') return existing
        return { ...existing, results: updated.results, searchStatus: updated.searchStatus }
      })
      return { ...state, rawPlacements: merged, searchProgress }
    }
```

with:

```jsx
    case 'MERGE_SEARCH_RESULTS': {
      const { placements: newPlacements, searchProgress } = action.payload
      const merged = state.rawPlacements.map((existing, i) => {
        if (existing.hidden) return existing
        const updated = newPlacements[i]
        if (!updated) return existing
        if (existing.searchStatus === 'complete' && updated.searchStatus === 'pending') return existing
        return { ...existing, results: updated.results, searchStatus: updated.searchStatus }
      })
      // Also propagate the updated results/searchStatus into the already-resolved placements
      // array so BRollTrack (which reads placements, not rawPlacements) shows progressive
      // search updates without waiting for a transcriptWords change.
      const mergedPlacements = state.placements.map(resolved => {
        const raw = merged.find(r => r.chapterIndex === resolved.chapterIndex && r.placementIndex === resolved.placementIndex)
        if (!raw) return resolved
        if (resolved.results === raw.results && resolved.searchStatus === raw.searchStatus) return resolved
        return { ...resolved, results: raw.results, searchStatus: raw.searchStatus }
      })
      return { ...state, rawPlacements: merged, placements: mergedPlacements, searchProgress }
    }
```

Note: the match key is `(chapterIndex, placementIndex)`. Grep to confirm both `chapterIndex` and `placementIndex` exist on placements:

```bash
grep -n "chapterIndex\|placementIndex" src/components/editor/useBRollEditorState.js
```

If the join key is actually something else in this codebase (e.g., `index`), adjust the `.find(...)` accordingly. Likely `resolved.index === raw.index` because `BRollTrack.jsx` uses `p.index` as a key (line 124).

If `index` is the right key, use:

```jsx
        const raw = merged.find(r => r.index === resolved.index)
```

Verify first:

```bash
grep -n "placement.index\|p.index\|placementIndex" src/components/editor/useBRollEditorState.js src/components/editor/BRollTrack.jsx src/components/editor/brollUtils.js | head
```

- [ ] **Step 2: Manual verification**

1. Start a b-roll search (click "Search next 10" in the search status bar).
2. Watch the active variant's BRollTrack. Expected: placements transition from `pending` → `searching` (spinner) → `complete` (thumbnail) in real time as the 5 s polling returns results.
3. Before this fix, the tracks stayed in `pending` state until a full page refresh.

- [ ] **Step 3: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/useBRollEditorState.js
git commit -m "fix(broll): MERGE_SEARCH_RESULTS also updates placements

MERGE_SEARCH_RESULTS only updated rawPlacements, leaving the resolved
placements array stale. BRollTrack reads placements, not rawPlacements,
so progressive search results never became visible until a transcriptWords
change happened to trigger a SET_RESOLVED. Propagate results+searchStatus
into the resolved array too."
```

---

### Task 11: Guard first-load transcript race in useBRollEditorState

**Root cause (Problem 2E):** If the b-roll fetch resolves before the transcript words arrive, `matchPlacementsToTranscript` returns placements without `timelineStart`, `BRollTrack` filters them all out, and the track renders empty until the transcript words trigger `SET_RESOLVED`.

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Delay the fetch until transcript words are available**

Currently at line 141-151:

```jsx
  useEffect(() => {
    if (!planPipelineId) return
    if (seededPipelineIdRef.current === planPipelineId) {
      seededPipelineIdRef.current = null
      return
    }
    dispatch({ type: 'SET_LOADING' })
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => {
        const visible = (data.placements || []).filter(p => !p.hidden)
        const resolved = matchPlacementsToTranscript(visible, transcriptWordsRef.current)
        dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements: data.placements, placements: resolved, searchProgress: data.searchProgress } })
      })
      .catch(err => dispatch({ type: 'SET_ERROR', payload: err.message }))
  }, [planPipelineId])
```

Extend the dependency to include `transcriptWords` so the fetch re-runs once words are available. Add a guard so we don't thrash:

```jsx
  useEffect(() => {
    if (!planPipelineId) return
    if (seededPipelineIdRef.current === planPipelineId) {
      seededPipelineIdRef.current = null
      return
    }
    if (!transcriptWords.length) {
      // Wait for transcript words before fetching — otherwise placements resolve with no
      // timelineStart and BRollTrack filters them all out (producing an empty-looking track).
      return
    }
    dispatch({ type: 'SET_LOADING' })
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => {
        const visible = (data.placements || []).filter(p => !p.hidden)
        const resolved = matchPlacementsToTranscript(visible, transcriptWordsRef.current)
        dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements: data.placements, placements: resolved, searchProgress: data.searchProgress } })
      })
      .catch(err => dispatch({ type: 'SET_ERROR', payload: err.message }))
  }, [planPipelineId, transcriptWords])
```

(`transcriptWords` is already computed at lines 119-130 in the same hook.)

Since `transcriptWords` is an array that can change reference even when empty ↔ populated is the only real transition, also remove the now-redundant useEffect at lines 154-159 (the "re-resolve when transcript words change" effect). The fetch effect handles both — when words go from empty to populated, it re-fetches and dispatches a SET_DATA_RESOLVED with resolved placements.

Actually — don't remove it yet. Users may have `placements` already loaded from a previous page visit (won't happen here — the hook mounts fresh per page). But also, transcriptWords might change _after_ we've successfully fetched (e.g., if SET_WORD_TIMESTAMPS fires later). In that case, we want to re-resolve without re-fetching. Keep the useEffect at 154-159 but narrow its condition.

Update the existing effect at lines 154-159:

```jsx
  useEffect(() => {
    if (!state.rawPlacements.length) return
    if (!transcriptWords.length) return
    const visible = state.rawPlacements.filter(p => !p.hidden)
    const resolved = matchPlacementsToTranscript(visible, transcriptWords)
    dispatch({ type: 'SET_RESOLVED', payload: resolved })
  }, [transcriptWords])
```

Adding the `!transcriptWords.length` guard prevents a SET_RESOLVED with broken placements if transcriptWords transitions to empty.

- [ ] **Step 2: Manual verification**

1. Hard reload the b-roll edit page with dev-tools network tab open.
2. Throttle network to "Fast 3G" to amplify race conditions.
3. Expected: once transcript words arrive, track populates immediately. No empty-looking intermediate state where the track row is there but has no thumbnails for several seconds.

- [ ] **Step 3: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/useBRollEditorState.js
git commit -m "fix(broll): wait for transcriptWords before fetching editor data

If the b-roll fetch resolved before transcript words arrived,
matchPlacementsToTranscript returned placements without timelineStart,
BRollTrack filtered them all out, and the track rendered as empty until
a later SET_RESOLVED happened. Gate the fetch on transcriptWords, and
guard the separate re-resolve effect against empty words."
```

---

### Task 12: Abort inactive-variant fetches on variant switch to avoid late-arriving races

**Root cause (Problem 2D):** `BRollEditor.jsx:55-71` fires fetches for all inactive pipeline IDs. If the user switches variants before those fetches return, the late responses still dispatch `setRawInactivePlacements` with possibly-stale data, overwriting fresh cache entries the new active variant may have seeded.

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx`

- [ ] **Step 1: Add AbortController-based cancellation**

In `BRollEditor.jsx` around lines 55-71, change:

```jsx
  useEffect(() => {
    if (variants.length <= 1) return
    const inactiveIds = variants.filter((_, i) => i !== activeVariantIdx).map(v => v.id)
    function fetchInactive() {
      for (const pid of inactiveIds) {
        authFetchBRollData(pid)
          .then(data => setRawInactivePlacements(prev => ({ ...prev, [pid]: data.placements || [] })))
          .catch(() => {})
      }
    }
    fetchInactive()
    const isRunning = brollState.searchProgress?.status === 'running'
    if (!isRunning) return
    const interval = setInterval(fetchInactive, 5000)
    return () => clearInterval(interval)
  }, [variants, activeVariantIdx, brollState.searchProgress?.status])
```

**Step 1a:** Extend `authFetchBRollData` in `useBRollEditorState.js:11-13` to accept an optional `AbortSignal`:

```jsx
export async function authFetchBRollData(planPipelineId, signal) {
  return authFetch(`/broll/pipeline/${planPipelineId}/editor-data`, signal)
}
```

and propagate the signal in `authFetch`:

```jsx
async function authFetch(path, signal) {
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  const res = await fetch(`${API_BASE}${path}`, { headers, signal })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}
```

**Step 1b:** In `BRollEditor.jsx`, adjust the effect:

```jsx
  useEffect(() => {
    if (variants.length <= 1) return
    const inactiveIds = variants.filter((_, i) => i !== activeVariantIdx).map(v => v.id)
    const controller = new AbortController()
    function fetchInactive() {
      for (const pid of inactiveIds) {
        authFetchBRollData(pid, controller.signal)
          .then(data => setRawInactivePlacements(prev => ({ ...prev, [pid]: data.placements || [] })))
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

- [ ] **Step 2: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/BRollEditor.jsx src/components/editor/useBRollEditorState.js
git commit -m "fix(broll): abort inactive-variant fetches on variant switch

Late-arriving fetches from a prior variant state could overwrite fresh
rawInactivePlacements entries. AbortController cancels on effect cleanup."
```

---

### Task 13: Memoize Timeline's inline ruler computations

**Root cause (Problem 1D):** `iv`, `minorPx`, `subPx`, `viewW`, `visStartTime`, `visEndTime`, `firstMajor`, `lastMajor`, `majorMarks` in `Timeline.jsx:87-113` are recomputed on every render. `majorMarks` loops to build tick marks.

**Files:**
- Modify: `src/components/editor/Timeline.jsx`

- [ ] **Step 1: Memoize the ruler computations**

In `src/components/editor/Timeline.jsx` around lines 87-113, change:

```jsx
  const iv = (() => {
    for (const entry of INTERVALS) {
      if (entry.major * state.zoom >= 80) return entry
    }
    return INTERVALS[INTERVALS.length - 1]
  })()

  const minorPx = iv.minor * state.zoom
  const subPx = iv.sub * state.zoom

  // Only generate marks visible in the viewport (+ buffer)
  const viewW = scrollRef.current?.clientWidth || 1200
  const visStartTime = Math.max(0, (scrollX - 300) / state.zoom)
  const visEndTime = (scrollX + viewW + 300) / state.zoom

  // Snap to major interval boundaries so we always get complete tick groups
  const firstMajor = Math.floor(visStartTime / iv.major) * iv.major
  const lastMajor = Math.ceil(visEndTime / iv.major) * iv.major

  const majorMarks = (() => {
    const marks = []
    for (let t = firstMajor; t <= Math.min(lastMajor, totalDuration + iv.major); t += iv.major) {
      const time = Math.round(t * 1000) / 1000
      marks.push({ time, label: formatTimeRuler(time, iv.major), x: time * state.zoom })
    }
    return marks
  })()
```

to:

```jsx
  const { iv, minorPx, subPx, majorMarks } = useMemo(() => {
    let iv = INTERVALS[INTERVALS.length - 1]
    for (const entry of INTERVALS) {
      if (entry.major * state.zoom >= 80) { iv = entry; break }
    }
    const minorPx = iv.minor * state.zoom
    const subPx = iv.sub * state.zoom
    const viewW = scrollRef.current?.clientWidth || 1200
    const visStartTime = Math.max(0, (scrollX - 300) / state.zoom)
    const visEndTime = (scrollX + viewW + 300) / state.zoom
    const firstMajor = Math.floor(visStartTime / iv.major) * iv.major
    const lastMajor = Math.ceil(visEndTime / iv.major) * iv.major
    const marks = []
    for (let t = firstMajor; t <= Math.min(lastMajor, totalDuration + iv.major); t += iv.major) {
      const time = Math.round(t * 1000) / 1000
      marks.push({ time, label: formatTimeRuler(time, iv.major), x: time * state.zoom })
    }
    return { iv, minorPx, subPx, majorMarks: marks }
  }, [state.zoom, scrollX, totalDuration])
```

Reading `scrollRef.current?.clientWidth` inside the useMemo is still a DOM read, but only when deps change. For cases where the scroll container width changes without a state update (window resize), a later task (14) adds a ResizeObserver. For now the 1200 default is acceptable.

- [ ] **Step 2: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/Timeline.jsx
git commit -m "perf(editor): memoize Timeline ruler computations

iv, minorPx, subPx, majorMarks are re-computed only when zoom, scrollX,
or totalDuration change — not on every 10Hz context update."
```

---

### Task 14: Track `viewW` via ResizeObserver instead of ad-hoc DOM reads

**Root cause (Problem 3E/3F):** `scrollRef.current?.clientWidth` is read inline in Timeline and BRollTrack on every render, forcing a layout flush.

**Files:**
- Modify: `src/components/editor/Timeline.jsx` — central owner
- Modify: `src/components/editor/BRollTrack.jsx` — consumer

- [ ] **Step 1: Add a `viewW` state in Timeline, updated by ResizeObserver**

In `src/components/editor/Timeline.jsx` near the existing `useState` declarations around line 16, add:

```jsx
  const [viewW, setViewW] = useState(1200)
```

Add a ResizeObserver effect after the existing scroll-listen effect around line 56-66:

```jsx
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth || 1200)
    })
    ro.observe(el)
    setViewW(el.clientWidth || 1200)
    return () => ro.disconnect()
  }, [])
```

- [ ] **Step 2: Replace the two `scrollRef.current?.clientWidth` reads with `viewW`**

In the ruler useMemo from Task 13, change `const viewW = scrollRef.current?.clientWidth || 1200` to remove that line — use the `viewW` state directly. The useMemo dep list gains `viewW`:

```jsx
  const { iv, minorPx, subPx, majorMarks } = useMemo(() => {
    // ... viewW now comes from closure (state) ...
  }, [state.zoom, scrollX, totalDuration, viewW])
```

Similarly, the play-follow tick inside the `useEffect` at lines 181-205 reads `el.clientWidth`. That's inside an rAF tick — leave as-is (rAF doesn't synchronously flush layout mid-frame).

- [ ] **Step 3: Pass `viewW` to BRollTrack; drop its own clientWidth read**

In `Timeline.jsx`, change the BRollTrack usage at line 645-652 (current state after Task 6):

```jsx
                      <BRollTrack
                        zoom={state.zoom}
                        scrollRef={scrollRef}
                        scrollX={scrollX}
                        isActive={isActiveVariant}
                        onActivate={variantActivators[vi]}
                        overridePlacements={!isActiveVariant ? inactiveVariantPlacements?.[variants?.[vi]?.id] : undefined}
                      />
```

to:

```jsx
                      <BRollTrack
                        zoom={state.zoom}
                        viewW={viewW}
                        scrollX={scrollX}
                        isActive={isActiveVariant}
                        onActivate={variantActivators[vi]}
                        overridePlacements={!isActiveVariant ? inactiveVariantPlacements?.[variants?.[vi]?.id] : undefined}
                      />
```

In `src/components/editor/BRollTrack.jsx`, change the component signature to accept `viewW` and drop the `scrollRef` dependency:

```jsx
function BRollTrack({ zoom, viewW = 1200, scrollX, isActive = true, onActivate, overridePlacements }) {
  // ... remove: const viewW = scrollRef?.current?.clientWidth || 1200
```

Remove the line `const viewW = scrollRef?.current?.clientWidth || 1200` (currently line 14). Keep `labelW`, `buffer`. Update the useMemo at line 19-29 to drop `scrollRef` from deps (it's gone) and keep `viewW`:

The dep list was `[placements, scrollX, zoom, viewW, labelW, buffer]`. `labelW` and `buffer` are literal constants inside the component — they never change. Simplify to `[placements, scrollX, zoom, viewW]`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/Timeline.jsx src/components/editor/BRollTrack.jsx
git commit -m "perf(editor): track viewport width via ResizeObserver

scrollRef.current.clientWidth was read inline in Timeline and BRollTrack
on every render, forcing layout flushes. Observe the scroll container's
width once and thread it as a number prop."
```

---

### Task 15: Skip useLayoutEffect for zoom-scroll adjust when zoom didn't change

**Root cause (Problem 3 — Timeline `useLayoutEffect` at 156-176):** effect depends on `[state.zoom, state.currentTime]` so it runs at 10 Hz during playback. The first body statement is `if (oldZoom === state.zoom) return` — which works, but the effect still runs, allocating the closure and doing the comparison.

**Files:**
- Modify: `src/components/editor/Timeline.jsx`

- [ ] **Step 1: Remove `state.currentTime` from the dep array**

In `src/components/editor/Timeline.jsx` at line 176, change:

```jsx
  }, [state.zoom, state.currentTime])
```

to:

```jsx
  }, [state.zoom])
```

The effect uses `state.currentTime` internally (line 170-173) to compute the playhead's screen position for the +/- buttons path. That read happens once when zoom changes, which is correct. Reading `state.currentTime` during the effect's body uses the *current* render's value — which is right.

- [ ] **Step 2: Manual verification**

1. Play. Expected: smooth playback, no hitch every 100 ms.
2. Change zoom with +/- buttons while playing. Expected: playhead stays anchored (the effect body still runs on zoom change).
3. Change zoom via Ctrl-wheel while playing. Expected: same — the wheel-anchor path in the effect handles it.

- [ ] **Step 3: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/Timeline.jsx
git commit -m "perf(editor): drop state.currentTime from zoom-scroll effect deps

The effect early-returns when zoom is unchanged. state.currentTime was in
the deps to capture the latest value when zoom DOES change — but the body
reads it via closure already, so the dep is redundant and caused the effect
to fire at 10Hz during playback."
```

---

### Task 16: Drop `state.currentTime` dependencies from Timeline's active-id useMemos, use ref reads

**Root cause (Problem 1D):** `currentSegmentIndex`, `activeVideoId`, `activeAudioId` useMemos at Timeline.jsx:269-322 depend on `state.currentTime`. They recompute at 10 Hz. They're used to light up track-label camera buttons in MAIN mode.

**Files:**
- Modify: `src/components/editor/Timeline.jsx`

**Strategy:** These useMemos' outputs change at most a few times per playback session (at segment boundaries). Recomputing at 10 Hz to produce the same value is wasteful. Gate them on a derived "segment-boundary tick" — a value that only changes when the segment containing the playhead changes.

- [ ] **Step 1: Introduce a currentTime-free segment tracker**

This requires threading segment-boundary changes outside of the render cycle, which adds complexity. **Simpler pragmatic alternative:** keep the memos' output by value. Since the output is a string (`videoId`), React.memo-protected children receive the same value → no re-render. The cost is just the iteration inside the memo, which is small.

Measure first. Open Profiler, find Timeline's self-render time during playback. If it's under 2 ms, SKIP this task — not worth the complexity.

If it's over 2 ms, move to Step 2.

- [ ] **Step 2: Conditional — only if measurement in Step 1 says it's worth it**

Gate `currentSegmentIndex` on a pre-computed array of segment boundaries. Replace the three memos with equivalents keyed on a `segmentBoundaryKey` that you compute via a ref-read scheme tied to rAF. This is non-trivial; recommend a separate mini-plan if needed.

For the scope of this plan, proceed to Task 17.

---

### Task 17: Move `BRollPreview.activePlacement` off `state.currentTime` dep

**Root cause (Problem 1D):** `BRollPreview.jsx:13-17` — `activePlacement` useMemo depends on `state.currentTime`. Recomputes 10 Hz. Every recompute drives a useEffect that syncs the HTML `<video>` element's `src` and `currentTime`.

**Files:**
- Modify: `src/components/editor/BRollPreview.jsx`

**Strategy:** The outer `<video>` element is already driven by an imperative rAF-style pattern (the sync useEffect reads `state.currentTime` and writes to DOM directly). We can keep that effect — it only needs to run at 10 Hz — but we should stop `activePlacement` from causing a full React reconciliation of BRollPreview every 100 ms.

The tightest fix: compute `activePlacement` imperatively each tick inside a rAF loop driven by isPlaying, writing the video element's state directly. Don't use React state for this.

But that's a bigger refactor. **Quick win instead:** confirm BRollPreview's render output doesn't actually depend on `activePlacement` except to trigger the useEffect. Check by reading the JSX at lines 58-75:

```jsx
  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center">
      <div className={showBRoll ? 'opacity-0 absolute inset-0' : 'w-full h-full flex items-center justify-center'}>
        <RoughCutPreview />
      </div>
      <video
        ref={brollVideoRef}
        className={`w-full h-full object-contain ${showBRoll ? '' : 'hidden'}`}
        preload="metadata"
        playsInline
        muted
      />
    </div>
  )
```

The only dynamic output is `showBRoll` (a boolean state that toggles when `activeResult` changes). So BRollPreview's JSX changes ~once when b-roll toggles on/off, but its React tree still reconciles at 10 Hz because it re-renders.

- [ ] **Step 1: Wrap `BRollPreview` in `React.memo`**

After Wave 2, `BRollPreview` no longer re-renders from context churn (BRollContext and EditorContext are both memoized). It still re-renders when `state.currentTime` changes because of the direct `state.currentTime` read in the useMemo at line 16-17.

Rewrite the component to read `state.currentTime` via a ref updated each render, and drive the video-sync from a rAF loop tied to `state.isPlaying`. Full replacement:

```jsx
import { useContext, useEffect, useRef, useState } from 'react'
import { EditorContext } from './EditorView.jsx'
import { BRollContext } from './useBRollEditorState.js'
import RoughCutPreview from './RoughCutPreview.jsx'

export default function BRollPreview() {
  const { state } = useContext(EditorContext)
  const broll = useContext(BRollContext)
  const brollVideoRef = useRef(null)
  const [showBRoll, setShowBRoll] = useState(false)

  // Live refs so the rAF/tick loop reads the latest values without re-rendering
  const stateRef = useRef(state)
  stateRef.current = state
  const brollRef = useRef(broll)
  brollRef.current = broll
  const lastPlacementKeyRef = useRef(null)

  useEffect(() => {
    let rafId = 0
    const tick = () => {
      const s = stateRef.current
      const b = brollRef.current
      const activePlacement = b ? b.activePlacementAtTime(s.currentTime) : null
      const resultIdx = activePlacement ? (b.selectedResults[activePlacement.index] ?? 0) : 0
      const activeResult = activePlacement?.results?.[resultIdx] || null

      const placementKey = activeResult
        ? `${activePlacement.index}:${resultIdx}:${activeResult.url || activeResult.preview_url_hq || activeResult.preview_url}`
        : null

      if (activeResult) {
        if (!showBRoll) setShowBRoll(true)
        if (brollVideoRef.current) {
          const url = activeResult.preview_url_hq || activeResult.preview_url || activeResult.url
          if (brollVideoRef.current.src !== url) brollVideoRef.current.src = url
          const localTime = s.currentTime - activePlacement.timelineStart
          const clampedTime = Math.max(0, Math.min(localTime, activeResult.duration || 30))
          if (Math.abs(brollVideoRef.current.currentTime - clampedTime) > 0.5) {
            brollVideoRef.current.currentTime = clampedTime
          }
          if (s.isPlaying && brollVideoRef.current.paused) {
            brollVideoRef.current.play().catch(() => {})
          } else if (!s.isPlaying && !brollVideoRef.current.paused) {
            brollVideoRef.current.pause()
          }
        }
      } else {
        if (showBRoll) setShowBRoll(false)
        if (brollVideoRef.current && !brollVideoRef.current.paused) brollVideoRef.current.pause()
      }
      lastPlacementKeyRef.current = placementKey

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, []) // rAF loop lives for the lifetime of the preview

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center">
      <div className={showBRoll ? 'opacity-0 absolute inset-0' : 'w-full h-full flex items-center justify-center'}>
        <RoughCutPreview />
      </div>
      <video
        ref={brollVideoRef}
        className={`w-full h-full object-contain ${showBRoll ? '' : 'hidden'}`}
        preload="metadata"
        playsInline
        muted
      />
    </div>
  )
}
```

Key changes:
- Removed the `activePlacement` / `activeResult` useMemos with `state.currentTime` deps.
- The rAF loop owns all reads/writes from state + BRollContext.
- `setShowBRoll` still triggers a React re-render when the b-roll toggles on/off — **intentional**, so `opacity-0` class toggles correctly.

- [ ] **Step 2: Manual verification**

1. Play. At a timestamp where a b-roll exists, expected: the preview switches to the b-roll video smoothly.
2. Scrub. Expected: the preview follows without lag.
3. Profiler during playback: BRollPreview should now commit only when `showBRoll` toggles, not every 100 ms.

- [ ] **Step 3: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/BRollPreview.jsx
git commit -m "perf(broll): drive BRollPreview video sync from rAF, not currentTime renders

BRollPreview re-rendered every 100ms because activePlacement depended on
state.currentTime. Move the video-sync logic into a rAF loop that reads
live state/broll via refs; the component now renders only on the
show/hide transition."
```

---

## Wave 5 — Cleanup (P3)

### Task 18: Remove dead `SET_DATA` reducer case

**Root cause (Problem 2B):** `useBRollEditorState.js:30-31` defines a `SET_DATA` action that isn't dispatched anywhere. Confirmed by grep — only `SET_DATA_RESOLVED` is dispatched.

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Grep to confirm no dispatcher**

```bash
grep -n "type: 'SET_DATA'\|type:\"SET_DATA\"\|dispatch({ type: 'SET_DATA'" src/
```

Expected: no matches outside the reducer case itself. If there are matches, STOP and investigate — do not delete.

- [ ] **Step 2: Delete the dead case**

In `useBRollEditorState.js` around lines 30-31:

```jsx
    case 'SET_DATA':
      return { ...state, rawPlacements: action.payload.placements, selectedResults: {}, searchProgress: action.payload.searchProgress, loading: false, error: null }
```

Delete those two lines.

- [ ] **Step 3: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/useBRollEditorState.js
git commit -m "chore(broll): remove unused SET_DATA reducer case

Grep confirms no dispatcher calls SET_DATA; all call sites use
SET_DATA_RESOLVED for atomic raw+resolved updates."
```

---

## Final verification

Full regression sweep after all waves merged:

1. `npm run dev` — no console errors or warnings.
2. Navigate to `http://localhost:5173/editor/223/brolls/edit/0`.
3. **Playback marker:** play at 2x zoom, 10x zoom, 100x zoom. Confirm smooth motion at all zoom levels. No periodic jumps.
4. **Variant switch:** click between inactive and active variants rapidly. Confirm no blank frames on the active row.
5. **Progressive search:** trigger "Search next 10". Confirm placements transition from pending → searching → complete in real time on the timeline track.
6. **Profiler sanity:** record 3 s of playback. Commits ≈ 30 (one per 100 ms). Majority of commits show `EditorView`, `Timeline`, `BRollPreview` render only. Track components show "Did not render".
7. **Undo/redo:** Cmd-Z / Cmd-Shift-Z still work as expected.
8. **Transcript selection + Backspace:** still cuts/uncuts cleanly in rough cut mode (not in b-roll mode).
9. **Auto-save:** make a change (reorder tracks, change zoom). Wait 2 s. Refresh page. Change persists.
10. **Git log:** each commit is focused and self-contained.

---

## Notes on what is explicitly NOT in this plan

- **Task 16 (segment-id memos)** is left as a conditional placeholder — do it only if measurement says it's worth the complexity.
- **Replacing the reducer / context architecture with zustand/jotai/redux** — out of scope. Would be a bigger refactor.
- **Virtualizing long placement lists in BRollTrack** — not needed unless placements grow past a few hundred per variant.
- **Fixing the `useEditorState.js:219` SET_WORD_TIMESTAMPS cost (maps all tracks)** — this runs once per timestamps load, not a hot path.
- **Adding a test harness** — the codebase currently has none. Introducing vitest and react-testing-library is a prereq for proper regression coverage but is its own project.
