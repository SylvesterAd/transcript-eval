# B-Roll Editor Marker No-Recenter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the b-roll editor's timeline from auto-scrolling/centering to the marker on (a) zoom and (b) the click-broll → play → stop sequence. Rough cut behavior must be unchanged.

**Architecture:** All three offending behaviors live as `useEffect`/`useLayoutEffect` blocks in the shared `Timeline.jsx`. Gate each one with `state.activeTab !== 'brolls'` so they early-return when the b-roll editor is the active surface. No new files, no new state, no prop plumbing — the same `EditorContext` already exposes `state.activeTab`, and the file already uses that exact discriminator at `Timeline.jsx:240-241`.

**Tech Stack:** React 18, Vitest (existing test runner). No new dependencies.

---

## How it works today (investigation summary)

The timeline view is a single component (`src/components/editor/Timeline.jsx`) used by both editors:
- **Rough cut editor:** mounted in `EditorView.jsx:1100` as `<Timeline />` with no props.
- **B-roll editor:** mounted in `BRollEditor.jsx:437` as `<Timeline variants=… activeVariantIdx=… onVariantActivate=… inactiveVariantPlacements=… onCrossDrop=… onCrossPaste=… />`.

Both share the same `EditorContext` (state/dispatch). The discriminator already used elsewhere in the file is `state.activeTab === 'roughcut'` vs `'brolls'` (see `Timeline.jsx:240`, `EditorView.jsx:925`).

There are exactly three places that move `scrollRef.current.scrollLeft` to follow the marker. None of them are gated by mode today, which is why both editors get the behavior:

### Behavior A — auto-center on zoom in/out
**Location:** `Timeline.jsx:162-179` (`useLayoutEffect` with `[state.zoom]` dep).

```jsx
useLayoutEffect(() => {
  const oldZoom = prevZoomRef.current
  if (oldZoom === state.zoom) return
  prevZoomRef.current = state.zoom
  const el = scrollRef.current
  if (!el) return
  const labelW = 144
  const anchor = zoomAnchorRef.current
  if (anchor) {
    // Wheel zoom: keep cursor point stable
    el.scrollLeft = anchor.time * state.zoom - anchor.screenX + labelW
    zoomAnchorRef.current = null
  } else {
    // +/- buttons: keep playhead at the CENTER of viewport
    const viewW = el.clientWidth
    el.scrollLeft = state.currentTime * state.zoom - viewW / 2 + labelW
  }
}, [state.zoom])
```

Two zoom sources: Ctrl/Cmd+Wheel (`Timeline.jsx:135-158`, sets `zoomAnchorRef`) and the +/- buttons in `PlaybackControls.jsx:232,241` (no anchor → falls into the else branch that centers on playhead).

The "always gets to the center" complaint maps to the **else branch (lines 174-178)**. The wheel branch only keeps the cursor's underlying time stable — that's not "centering" unless the cursor happens to be in the middle.

### Behavior B.1 — auto-scroll to marker after seek/stop (when paused)
**Location:** `Timeline.jsx:220-229` (`useEffect` with `[state.isPlaying, state.currentTime, state.zoom]`).

```jsx
useEffect(() => {
  if (state.isPlaying || !scrollRef.current) return
  const el = scrollRef.current
  const playheadX = state.currentTime * state.zoom
  const { scrollLeft, clientWidth } = el
  if (playheadX < scrollLeft + 100 || playheadX > scrollLeft + clientWidth - 100) {
    el.scrollLeft = playheadX - clientWidth / 3
  }
}, [state.isPlaying, state.currentTime, state.zoom])
```

This fires whenever the user is paused and `currentTime` changes (e.g., on stop, when `isPlaying` flips false and `currentTime` is wherever playback halted). If the marker is outside a 100px margin, it slams `scrollLeft` to put the marker ~1/3 from the left. **This is the primary cause of the "click b-roll → play → stop → snaps back to marker" bug.**

(Note: clicking a b-roll placement does **not** dispatch `SET_CURRENT_TIME` — `selectPlacement` in `useBRollEditorState.js:385` only updates selection. So the snap happens on **stop**, not on the click itself.)

### Behavior B.2 — auto-follow during playback
**Location:** `Timeline.jsx:191-218` (`useEffect` with `[state.isPlaying]`, runs a rAF loop).

```jsx
useEffect(() => {
  if (!state.isPlaying || !scrollRef.current) return
  let raf
  let following = false
  const tick = () => {
    /* … reads playhead transform from DOM … */
    if (!following && screenPos > clientWidth * 0.8) following = true
    if (following) el.scrollLeft = playheadX - clientWidth * 0.8
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}, [state.isPlaying])
```

Once playing, if the marker drifts past 80% of viewport width, the timeline starts dragging itself rightward to keep the marker in view. In the user's reported flow (scroll right past marker, then play) this loop's gate `screenPos > clientWidth * 0.8` is initially false (marker is to the left of viewport, screenPos is negative), so it does not fire — but the moment playback advances enough that the marker re-enters and crosses 80%, it locks on. To fully "delete" the auto-follow feeling for b-roll, this one is removed too.

### Untouched: playhead transform update
`Timeline.jsx:185-189` updates the playhead element's CSS `translateX` so the marker line itself moves to the correct pixel as zoom changes. **This is required and stays as-is** — without it the visual marker would desync from `state.currentTime`.

---

## File Structure

Only one file changes. No new files.

- **Modify:** `src/components/editor/Timeline.jsx` — add a single `isBroll` derived constant near the existing `isRoughCut` (line 240) and use it to gate the three effects above. Three localized edits, no structural changes.
- **Test:** No automated test added. The behaviors are DOM-layout-effects on `scrollRef.current.scrollLeft` after a paint; reliably testing them requires a JSDOM layout shim that this codebase does not have, and the change is three boolean gates. Manual verification is in Task 4.

---

### Task 1: Add `isBroll` derived flag

**Files:**
- Modify: `src/components/editor/Timeline.jsx` (insert near line 240)

The discriminator `state.activeTab === 'brolls'` is already used in this file at line 241 inline. Hoist a named constant so all three subsequent gates read clearly.

- [ ] **Step 1: Add the `isBroll` constant**

In `Timeline.jsx`, find the top of the component body. Currently around line 12-19 the component declares `state`, refs, etc. Add `isBroll` early so the effects above (lines 162, 191, 220) can reference it. The cleanest spot is right after `const { state, dispatch, totalDuration, playbackEngine, playheadRef } = useContext(EditorContext)` at line 13:

```jsx
const { state, dispatch, totalDuration, playbackEngine, playheadRef } = useContext(EditorContext)
const isBroll = state.activeTab === 'brolls'
const scrollRef = useRef(null)
```

- [ ] **Step 2: Verify the file still parses**

Run: `npx vitest run src/components/editor/__tests__/BRollEditor.test.jsx`
Expected: PASS (this test imports from BRollEditor.jsx which imports Timeline.jsx, so a syntax error here would fail the import).

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/Timeline.jsx
git commit -m "refactor(timeline): hoist isBroll discriminator constant"
```

---

### Task 2: Gate Behavior A — disable +/- button center-on-playhead in b-roll

**Files:**
- Modify: `src/components/editor/Timeline.jsx:162-179`

**Decision:** Preserve the wheel cursor-anchor branch in b-roll mode (it is good UX — the point under the cursor stays put on wheel zoom). Only disable the else branch that centers on the playhead, which is what fires for the +/- buttons in `PlaybackControls.jsx`. After the change, +/- in b-roll will leave `scrollLeft` alone and the content scales in place.

If the user later reports that even wheel zoom feels "centering" in b-roll, swap to a full early-return at the top of the effect — see "Alternative" below.

- [ ] **Step 1: Add the gate to the else branch**

Replace lines 174-178:

```jsx
  } else {
    // +/- buttons: keep playhead at the CENTER of viewport
    const viewW = el.clientWidth
    el.scrollLeft = state.currentTime * state.zoom - viewW / 2 + labelW
  }
```

with:

```jsx
  } else if (!isBroll) {
    // +/- buttons (rough cut only): keep playhead at the CENTER of viewport.
    // B-roll editor leaves scrollLeft alone — user explicitly does not want recentering.
    const viewW = el.clientWidth
    el.scrollLeft = state.currentTime * state.zoom - viewW / 2 + labelW
  }
```

**Alternative (only if user later asks for wheel zoom to also stop adjusting scroll in b-roll):** instead of the per-branch gate, add an early return at the top of the effect:

```jsx
useLayoutEffect(() => {
  const oldZoom = prevZoomRef.current
  if (oldZoom === state.zoom) return
  prevZoomRef.current = state.zoom
  if (isBroll) { zoomAnchorRef.current = null; return }
  // … rest unchanged …
}, [state.zoom, isBroll])
```

Do not apply the alternative unless asked — wheel cursor-anchoring is generally desirable.

- [ ] **Step 2: Manual verify in dev**

Open `http://localhost:5173/editor/225/brolls/edit` in a browser. With a placement loaded:
- Click the **+** button in PlaybackControls. Expected: timeline zooms in, scroll position stays where it was (no jump to marker). Pre-fix it would jump.
- Click the **-** button. Expected: same.
- Ctrl/Cmd+wheel over a specific b-roll placement. Expected: that placement stays under the cursor (cursor anchor preserved).

Then in rough cut (`/editor/225` or whichever route uses roughcut tab):
- Click + and -. Expected: timeline still centers on playhead (unchanged from before).

If a dev server is not already running, **do not start it just for this** — see the user's standing rule about `npm run dev:server` triggering b-roll auto-resume side effects. Verify manually in whatever browser tab the user already has open, or ask the user to verify.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/Timeline.jsx
git commit -m "fix(broll): don't center timeline on marker when zooming with +/- buttons"
```

---

### Task 3: Gate Behavior B.1 — disable post-stop / post-seek snap-back in b-roll

**Files:**
- Modify: `src/components/editor/Timeline.jsx:220-229`

This is the primary fix for the "click b-roll → play → stop → snaps to marker" bug.

- [ ] **Step 1: Add the gate**

Replace lines 220-229:

```jsx
// Scroll timeline into view on seek (word click, etc.) when not playing
useEffect(() => {
  if (state.isPlaying || !scrollRef.current) return
  const el = scrollRef.current
  const playheadX = state.currentTime * state.zoom
  const { scrollLeft, clientWidth } = el
  if (playheadX < scrollLeft + 100 || playheadX > scrollLeft + clientWidth - 100) {
    el.scrollLeft = playheadX - clientWidth / 3
  }
}, [state.isPlaying, state.currentTime, state.zoom])
```

with:

```jsx
// Scroll timeline into view on seek (word click, etc.) when not playing.
// Disabled in b-roll editor — user wants the viewport to stay where they put it.
useEffect(() => {
  if (isBroll) return
  if (state.isPlaying || !scrollRef.current) return
  const el = scrollRef.current
  const playheadX = state.currentTime * state.zoom
  const { scrollLeft, clientWidth } = el
  if (playheadX < scrollLeft + 100 || playheadX > scrollLeft + clientWidth - 100) {
    el.scrollLeft = playheadX - clientWidth / 3
  }
}, [isBroll, state.isPlaying, state.currentTime, state.zoom])
```

Note: `isBroll` is added to the dep array so that switching tabs while paused does not strand the effect on a stale value.

- [ ] **Step 2: Manual verify in dev**

In the b-roll editor:
- Scroll the timeline horizontally past the marker so the marker is off-screen.
- Click any b-roll placement. Expected: scroll position does NOT change.
- Click Play. Wait a moment. Click Stop. Expected: scroll position does NOT snap back to the marker.
- Click a word in the transcript pane while in b-roll (if applicable). Expected: timeline does not auto-scroll.

In rough cut:
- Same flow — clicking a word should still scroll the timeline to keep the playhead visible (unchanged behavior).

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/Timeline.jsx
git commit -m "fix(broll): don't snap timeline to marker on seek/stop in b-roll editor"
```

---

### Task 4: Gate Behavior B.2 — disable auto-follow during playback in b-roll

**Files:**
- Modify: `src/components/editor/Timeline.jsx:191-218`

The user's reported flow (scroll right past marker, click b-roll, play, stop) is technically resolved by Task 3 alone — B.2's `screenPos > clientWidth * 0.8` gate would not have triggered with a marker scrolled off to the left. But the user said "I want to delete this as well" about the broader "timeline goes back to where the marker is" feeling, and B.2 will pull the timeline rightward to chase the marker once it crosses 80% of viewport on subsequent plays. To fully match user intent, disable B.2 in b-roll too.

- [ ] **Step 1: Add the gate**

Replace lines 194-218:

```jsx
useEffect(() => {
  if (!state.isPlaying || !scrollRef.current) return
  let raf
  let following = false
  const tick = () => {
    const el = scrollRef.current
    const ph = playheadRef.current
    if (!el || !ph) { raf = requestAnimationFrame(tick); return }
    // Read playhead pixel position directly from DOM (updated at 60fps by playback engine)
    const match = ph.style.transform.match(/translateX\(([^)]+)px\)/)
    const playheadX = match ? parseFloat(match[1]) : currentTimeRef.current * zoomRef.current
    const { scrollLeft, clientWidth } = el
    const screenPos = playheadX - scrollLeft

    if (!following && screenPos > clientWidth * 0.8) {
      following = true
    }
    if (following) {
      el.scrollLeft = playheadX - clientWidth * 0.8
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}, [state.isPlaying])
```

with:

```jsx
useEffect(() => {
  if (isBroll) return
  if (!state.isPlaying || !scrollRef.current) return
  let raf
  let following = false
  const tick = () => {
    const el = scrollRef.current
    const ph = playheadRef.current
    if (!el || !ph) { raf = requestAnimationFrame(tick); return }
    const match = ph.style.transform.match(/translateX\(([^)]+)px\)/)
    const playheadX = match ? parseFloat(match[1]) : currentTimeRef.current * zoomRef.current
    const { scrollLeft, clientWidth } = el
    const screenPos = playheadX - scrollLeft

    if (!following && screenPos > clientWidth * 0.8) {
      following = true
    }
    if (following) {
      el.scrollLeft = playheadX - clientWidth * 0.8
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}, [isBroll, state.isPlaying])
```

- [ ] **Step 2: Manual verify in dev**

In the b-roll editor:
- Position the timeline so the marker is visible near the left edge.
- Click Play. Let playback continue until the marker would normally cross 80% of the viewport.
- Expected: timeline does NOT scroll. Marker leaves the right edge of the viewport.
- Click Stop. Expected (combined with Task 3): timeline still does NOT scroll back to marker.

In rough cut:
- Same flow — timeline should still auto-follow during playback (unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/Timeline.jsx
git commit -m "fix(broll): don't auto-follow marker during playback in b-roll editor"
```

---

### Task 5: Run full test suite, sanity-check rough cut path

**Files:** none (verification only)

- [ ] **Step 1: Run vitest**

Run: `npx vitest run`
Expected: all existing tests still pass. The change is additive guards — no test should regress.

- [ ] **Step 2: Confirm rough cut behaviors are intact (manual)**

Open the rough cut editor. Verify the three behaviors still work as before:
1. +/- zoom buttons still center on playhead.
2. Clicking a transcript word still scrolls the timeline to bring the marker into view.
3. During playback, the timeline still auto-follows the marker once it crosses 80%.

- [ ] **Step 3: Final state**

Three commits on branch `feature/broll-marker-no-recenter`. No new files. `Timeline.jsx` has one new derived constant and three early-return guards. Open a PR with `gh pr create --base main --head feature/broll-marker-no-recenter` per user's standing ship workflow once the user confirms manual verification.

---

## Self-review notes

- **Spec coverage:** User's two requested removals (a) and (b) map to Tasks 2/3/4. Behavior A → Task 2 (with wheel anchor preserved by default; alternative documented). Behavior B → Tasks 3 + 4. Rough cut left intact via `isBroll` gating.
- **Placeholders:** none — every step shows the exact diff.
- **Type/name consistency:** the new `isBroll` constant is referenced consistently across all four edit sites and added to dep arrays where the gated effect's body uses it.
- **Risk:** very low. Three early-return guards in a single file. No state shape changes, no new props, no new dependencies. Easy to revert per task.
