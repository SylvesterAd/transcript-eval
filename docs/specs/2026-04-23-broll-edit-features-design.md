# B-Roll Editor — Delete/Undo, Persistence, Copy/Paste, Preview Fix, Lazy Load

**Date:** 2026-04-23
**Branch:** `feature/broll-edit-features`
**Worktree:** `.worktrees/broll-edit-features`
**Scope:** 5 features for the B-Roll edit view at `/editor/:id/brolls/edit/:detail`

---

## Background

The b-roll edit view (`src/components/editor/BRollEditor.jsx` + `BRollTrack.jsx` + `useBRollEditorState.js`) lets the user review AI-generated placements, swap result videos, hide placements, and drag to reposition. Today:

- All user edits (hide, manual position, selected result) live only in the frontend reducer. They never persist to the DB. They are cleared by `SET_LOADING` on variant switch and by any full refetch, and they are lost on page reload.
- There is no delete undo.
- The main preview `<video>` uses `preview_url_hq` first. For Pexels, `preview_url_hq` is a client-side regex guess at a 1080p URL that does not exist for every video, so it 403s and the preview shows black. The sidebar avoids this by using `preview_url` first.
- There is no cross-variant copy/paste, no clipboard, no drag-between-timelines.
- Videos load on demand; slow connections show black frames until the data arrives.

This spec covers:

1. **Delete with undo/redo** — Delete/Backspace to remove a placement; CMD+Z/Ctrl+Z to undo, CMD+Shift+Z to redo; visible toolbar icons.
2. **Persistence of all user edits** — manual position, selected result, hidden state, user-created placements, and the undo/redo stacks all persist to the DB per variant timeline.
3. **Pexels preview fix** — main preview video uses the URL order that works, with onerror fallback.
4. **Copy / paste / drag b-rolls** — within the same timeline and between variants. Right-click menu + keyboard shortcuts + Alt-drag for copy. Soft displacement with spring-back.
5. **Lazy load + preload + loading state** — preload upcoming clips, show a spinner instead of black while a clip is loading.

---

## Data Model

### New table

Add to `server/schema-pg.sql` AND as a runtime `CREATE TABLE IF NOT EXISTS` in the schema bootstrap so it auto-creates on server start (the project's existing pattern):

```sql
CREATE TABLE IF NOT EXISTS broll_editor_state (
  plan_pipeline_id TEXT PRIMARY KEY,
  state_json       TEXT    NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 1,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
```

One row per variant (plan pipeline). One table only; no separate tables for edits, user placements, or the undo log. Matches the existing `video_groups.editor_state_json` pattern.

### Shape of `state_json`

```jsonc
{
  "edits": {
    // keys are "<chapterIndex>:<placementIndex>" — stable across LLM plan re-runs, unlike the flat `index`.
    "0:2": { "hidden": true,  "selectedResult": 1 },
    "1:0": { "timelineStart": 12.3, "timelineEnd": 17.8, "selectedResult": 0 }
  },
  "userPlacements": [
    {
      "id": "u_a8f3b1c2",                   // fresh uuid; used as React key and DB identifier
      "sourcePipelineId": "plan-225-1729...",
      "sourceChapterIndex": 1,
      "sourcePlacementIndex": 0,
      "timelineStart": 27.5,
      "timelineEnd": 31.0,
      "selectedResult": 2,
      "results": [/* full snapshot of source's results at copy time */],
      "snapshot": {
        "description": "...", "audio_anchor": "...",
        "function": "...", "type_group": "...", "source_feel": "...",
        "style": { /* colors, temperature, motion, ... */ }
      }
    }
  ],
  "undoStack": [ /* up to 50 actions; oldest evicted when full */ ],
  "redoStack": [ /* up to 50 actions; cleared on any new user action */ ]
}
```

### Why `chapter:placement` keys, not the flat `index`

The flat `placement.index` is computed by position in the flattened-per-chapter list inside `getBRollEditorData`. If any earlier chapter's plan sub-run is re-run, later placements' indexes shift. `chapterIndex` + `placementIndex` are stable across LLM plan re-runs.

### Action shape (undo/redo log entry)

Every user mutation is represented as an action object:

```jsonc
{
  "id":   "act_9f1e...",          // uuid; reused for cross-pipeline actions so linked pushes share one id
  "ts":   1745452800123,
  "kind": "delete" | "restore" | "move" | "resize" | "paste" | "cut" | "drag-cross" | "reset" | "select-result",
  "placementKey": "1:0",          // present for actions on an original placement
  "userPlacementId": "u_a8f3...", // present for actions on a user-created placement
  "before": { /* prior state of just the fields this action mutated */ },
  "after":  { /* new state */ }
}
```

Applying an action: merge `after` into the relevant slot. Undoing: merge `before`. Redoing: merge `after` again.

### Cross-pipeline actions

`drag-cross` (move or copy of a placement from variant A to variant B) is recorded once with a shared `id`, then pushed to the undo stacks of BOTH pipelines' `state_json`. Either side's undo finds the entry by `id`, performs the inverse on both sides, and issues two PUTs (one per pipeline). This keeps cross-variant undo consistent.

### Orphan handling

On `LOAD_EDITOR_STATE`:
- Any `edits[key]` whose `chapter:placement` does not exist in the current placements list → dropped.
- Any `userPlacements[i]` whose `sourcePipelineId` + `sourceChapterIndex` + `sourcePlacementIndex` resolve to a placement that no longer exists → dropped (the results are already snapshotted so the clip would still play, but the Retry/Search behavior depends on the snapshot, which we already keep — so we actually keep orphaned userPlacements; only drop them if their stored `results` is also empty).
- Any undo/redo action referencing a now-missing key → dropped from the stack.
- Total dropped count → one-time dismissible toast: *"N edits lost due to plan regeneration."*

---

## Backend

### New endpoints (in `server/routes/broll.js`)

```
GET  /broll/pipeline/:pid/editor-state           → { state, version }
PUT  /broll/pipeline/:pid/editor-state           body { state, version }
     → 200 { version: prev+1 } on success
     → 409 { version, state } on stale write (caller's version < current)
POST /broll/pipeline/:pid/search-user-placement  body { userPlacementId, description?, style?, sources? }
     → same response shape as existing /search-placement
```

### Extended endpoint

`GET /broll/pipeline/:pid/editor-data` (existing, `server/services/broll.js:getBRollEditorData`) gains an optional post-processing step that merges `broll_editor_state.state_json` into its response:

- Apply `edits[key].hidden` — drop hidden placements.
- Apply `edits[key].timelineStart/End` to the placement (same field names as the current frontend `userTimelineStart/End`, so `matchPlacementsToTranscript` already respects it).
- Apply `edits[key].selectedResult` by moving that result to index 0 of `results`, OR better, add a top-level `selectedResult` field on each placement the client reads.
- Append `userPlacements` to the returned list with resolved timeline positions.

This makes any non-editor consumer (future export/rendering pipeline) see the final edited timeline without having to implement the merge themselves.

### New service functions (in `server/services/broll.js`)

```js
// Load: reads the row, returns { state, version } or { state:{}, version:0 }.
export async function loadBrollEditorState(planPipelineId) { ... }

// Save with optimistic concurrency.
// Throws { status: 409, version, state } if the caller's version !== DB version.
export async function saveBrollEditorState(planPipelineId, state, version) { ... }

// Retry/search for a user-created placement — reuses the same GPU flow as
// searchSinglePlacement but loads keywords/style from the userPlacement snapshot
// instead of per-chapter plan sub-runs.
export async function searchUserPlacement(planPipelineId, userPlacementId, overrides = {}) { ... }
```

---

## Frontend State

### Reducer (`useBRollEditorState.js`)

New state fields: `edits`, `userPlacements`, `undoStack`, `redoStack`, `version`, `dirty` (true while debounced save is pending).

New reducer actions:

- `LOAD_EDITOR_STATE { state, version }` — hydrates on mount; runs orphan filter.
- `APPLY_ACTION { action }` — single entrypoint for every mutation. Applies `after`, pushes to `undoStack` (evicting the oldest if >50), clears `redoStack`, sets `dirty:true`.
- `UNDO` — pops last entry from `undoStack`, applies its `before`, pushes onto `redoStack`, sets `dirty:true`.
- `REDO` — pops last entry from `redoStack`, applies its `after`, pushes onto `undoStack`, sets `dirty:true`.
- `MERGE_REMOTE_STATE { state, version }` — used after a 409 refetch. Replaces base state with the remote one, then re-applies any pending local actions on top (we track pending actions between saves by index into `undoStack`).
- `SAVE_SUCCESS { version }` — clears `dirty`, bumps `version`.

Existing `UPDATE_PLACEMENT_POSITION` is replaced by `APPLY_ACTION({ kind:'move' | 'resize', ... })`. Existing `HIDE_PLACEMENT` is replaced by `APPLY_ACTION({ kind:'delete', ... })`. Existing `RESET_ALL_PLACEMENTS` becomes a single compound action so it can be undone.

### Placement resolution (`brollUtils.js:matchPlacementsToTranscript`)

Extended to:

1. Filter out originals where `edits[key].hidden === true`.
2. Apply `edits[key].timelineStart/End` as manual override (existing code already handles a similar field — just rename or alias).
3. Apply `edits[key].selectedResult` by exposing it on the placement object so `BRollTrack` + `BRollPreview` + `BRollDetailPanel` use it instead of the ephemeral `selectedResults` map (the ephemeral map continues to exist for unsaved selections; `edits[key].selectedResult` is the persisted choice).
4. Append user placements from `userPlacements`, each resolved with its stored `timelineStart`, `timelineEnd`, `timelineDuration`.
5. **Compute soft displacement** (see below) and set each placement's `timelineStart`/`timelineEnd` to the post-displacement values for rendering.

### Soft displacement (the spring-back)

The displacement is **not stored**. It is recomputed on every render from the persistent state.

Algorithm:

```
Let all = originals (respecting edits) + userPlacements
For each clip c in all, define:
  c.naturalStart = edits[key].timelineStart  OR  userPlacement.timelineStart  OR  LLM-resolved anchor position
  c.naturalEnd   = edits[key].timelineEnd    OR  userPlacement.timelineEnd    OR  naturalStart + planDuration
  c.isFixed      = (edits[key].timelineStart != null)      // user manually positioned
                || (c is a userPlacement)                  // pasted or cross-variant-copied
                || (c is currently being dragged)          // in-progress drag

Two-pass placement (fixed clips are immovable landmarks that define regions;
free clips flow through the remaining gaps):

PASS 1 — place all fixed clips at their natural positions:
  For each fixed clip f: f.currentStart = f.naturalStart, f.currentEnd = f.naturalEnd.
  (Fixed clips can overlap each other — last-written wins visually; collision
  avoidance during drag prevents this in practice.)

PASS 2 — place free clips left-to-right, constrained between fixed clips:
  Sort free clips by naturalStart.
  For each free clip c:
    leftBoundary  = max of (prev fixed clip's currentEnd) and (prev free clip's currentEnd)
    rightBoundary = next fixed clip's currentStart, or +Infinity if none
    c.currentStart = max(c.naturalStart, leftBoundary)
    desiredEnd     = c.currentStart + (c.naturalEnd - c.naturalStart)
    c.currentEnd   = min(desiredEnd, rightBoundary)
    if c.currentEnd - c.currentStart < 0.5:
      // No room at all in this gap — clip gets "squeezed out" beyond the fixed
      // clip. Re-run with leftBoundary = rightBoundary.
      c.currentStart = rightBoundary
      c.currentEnd   = c.currentStart + (c.naturalEnd - c.naturalStart)
```

Spring-back is automatic: when the fixed clip (the pasted one) is moved away, `rightBoundary` opens up and the free clip's `currentStart`/`currentEnd` drop back to its `naturalStart`/`naturalEnd`.

Special cases:
- Minimum pasted clip width 0.5s. If even 0.5s collides with a fixed neighbor, the pasted clip abuts the neighbor's end and takes whatever space is left (possibly pushed past timeline end — in which case the paste is rejected with a toast *"Not enough space to paste clip."*).
- Free clip shrunk to fit a gap: no persistent state change — it still has the same `naturalEnd`; the shrink is only visual. When the fixed cause is removed, it springs back to full duration.
- Free clip squeezed out past a fixed clip: rendered at its squeezed-out position; viewport culling may hide it if it's past the timeline end. Springs back when the fixed clip is removed.

### Write semantics (debounced PUT)

- Drag in progress → updates reducer only, no network.
- On drag end, resize end, or any other mutation → schedule `saveEditorState()` with a 500ms trailing debounce. Multiple rapid edits coalesce to one PUT.
- Delete / paste / cut / undo / redo / "reset to original" → immediate PUT (flush the debounce timer).
- `saveEditorState` body: `{ state: currentStateSnapshot, version }`. On 200 → `SAVE_SUCCESS`. On 409 → refetch (`LOAD_EDITOR_STATE`), `MERGE_REMOTE_STATE` replays any pending actions, then retry PUT once.

### Integration with existing variant-switch cache

The existing `seedFromCache` flow in `useBRollEditorState.js` / `BRollEditor.jsx` is preserved. When switching variants:
- Seed places cached raw placements immediately (no blank frame).
- The editor-state LOAD fetch fires in parallel to the placements fetch (or merges into one round-trip via the extended `editor-data` endpoint).

When a variant switch happens while a save is pending (`dirty:true`), flush the debounce immediately before switching, so no edits are lost to the variant swap.

A `beforeunload` handler attached on the editor route flushes any pending debounced save before tab close. If the synchronous flush cannot complete (rare), the `beforeunload` handler returns a string to prompt the standard "Leave site? Changes you made may not be saved." browser dialog.

---

## Feature 1 — Delete + Undo/Redo

### UX

- With a placement selected (either by clicking it in the timeline or having it in the detail sidebar), pressing **Delete** or **Backspace** deletes it.
- **CMD+Z** (macOS) / **Ctrl+Z** (Windows/Linux) → undo. **CMD+Shift+Z** / **Ctrl+Shift+Z** → redo.
- Keyboard handlers: attached at `BRollEditor.jsx` top level, only fire when focus is inside the b-roll editor AND the transcript editor does not have focus (so the existing transcript backspace behavior in `EditorView.jsx` is not overridden).
- A small toolbar strip above the timeline (just below the horizontal splitter) shows two icon buttons: **↶ Undo** and **↷ Redo**. Disabled and dimmed when their stack is empty. Tooltips show the action label e.g. "Undo: Delete placement 3" or "Redo: Paste clip".

### Context menu

Right-click any placement (active or inactive variant) opens a small dark menu matching the project's UI style (`bg-[#1a1a1c]`, `border-white/10`):

- **Copy** (CMD+C)
- **Cut** (CMD+X)
- **Paste** (CMD+V) — enabled only if clipboard has an entry
- **Delete** (Delete)
- divider
- **Reset to original** — shown only if the placement has any `edits[key]` set (or is a userPlacement that has been moved/resized); clears `edits[key]` or resets userPlacement to its source's position.

Right-click on empty timeline area → mini menu with just **Paste** at the click's time position.

### Action definitions

- `delete` on original: `before:{hidden:false}`, `after:{hidden:true}` under `edits[key]`.
- `delete` on userPlacement: stores the full userPlacement in `before`, removes it from the array in `after`.
- `restore` is the inverse of `delete` — fired by undo; not a user-facing action.
- `reset`: `before:{edits[key]: <current>}`, `after:{edits[key]: undefined}`.

---

## Feature 2 — Manual Edit Persistence

This feature is almost free once the reducer is refactored: every drag/resize that previously dispatched `UPDATE_PLACEMENT_POSITION` now dispatches `APPLY_ACTION({ kind:'move' | 'resize', placementKey, before, after })`, which persists via the debounced PUT.

Behavior after this feature:
- Drag a placement → release → 500ms later, saved.
- Reload the page → edit is there.
- Switch variants and come back → edit is there.
- Open the same variant in another tab → edit is there (up to one debounce-window of staleness).

State is per `plan_pipeline_id`, not per user — matching the existing `video_groups.editor_state_json` shared-edit pattern.

---

## Feature 3 — Pexels Preview Fix

Two changes in `BRollPreview.jsx`:

1. Change the URL resolution on **line 30**:
   ```js
   // Before:
   const url = activeResult.preview_url_hq || activeResult.preview_url || activeResult.url
   // After:
   const url = activeResult.preview_url || activeResult.preview_url_hq || activeResult.url
   ```
   Matches the sidebar's already-correct order, avoids the 403 guess.

2. Add an `onerror` handler to the `<video>` element that cycles through the URL chain. If `preview_url` fails (e.g. Storyblocks transient), try `preview_url_hq`, then `url`, then render the thumbnail as a still image with a small warning icon. Log each fallback to the console so future diagnosis is easy.

No changes needed to sidebar thumbnails (`BRollDetailPanel.jsx:BRollOptionThumbnail`) — they already use the correct order.

---

## Feature 4 — Copy / Paste / Drag

### Clipboard

In-memory singleton (module-level `let clipboard = null`) mirrored to `localStorage` under key `broll-clipboard`. Surviving a page reload and working across tabs on the same machine. The clipboard is cleared when:
- The user cuts a second item (overwrite).
- The user explicitly chooses "Clear clipboard" (not initially exposed, but hooked up for future).

Clipboard entry shape:

```jsonc
{
  "sourcePipelineId": "plan-225-...",
  "sourceChapterIndex": 1,
  "sourcePlacementIndex": 0,
  "sourceUserPlacementId": null,     // present if copying a userPlacement
  "selectedResult": 2,
  "results": [/* deep-copied */],
  "snapshot": { "description": ..., "style": ..., ... },
  "durationSec": 3.5,
  "copiedAt": 1745452800123
}
```

### Keyboard shortcuts

Registered at `BRollEditor.jsx` top level:

- **CMD+C / Ctrl+C** — copy the selected placement (no-op if none selected).
- **CMD+X / Ctrl+X** — cut (copy + delete).
- **CMD+V / Ctrl+V** — paste. If a placement is selected, paste immediately after it. Otherwise paste at the playhead time on the active variant.
- **Delete / Backspace** — delete selected placement.
- **CMD+Z / Ctrl+Z** — undo. **CMD+Shift+Z / Ctrl+Shift+Z** — redo.

Handlers are attached to a `keydown` listener on `document` while the b-roll editor route is mounted, and they ignore events whose `target` is an `<input>`, `<textarea>`, or `contenteditable` element (so the EditModal inputs and any future text entry still work normally).

### Context menu

Attached to each `<div>` in `BRollTrack.jsx` via `onContextMenu`, and to the empty timeline area. Renders a lightweight absolute-positioned menu (portal into document body to escape the scroll container). Items as listed in Feature 1.

### Paste behavior (soft displacement — approved option A)

Resolving the target start time in order of precedence:

1. Context menu "Paste" on a specific placement → `targetStart = that.placement.timelineEnd + 0.05`.
2. Context menu on empty timeline area → `targetStart = clickX-in-track / zoom`.
3. CMD+V with a placement selected → `targetStart = selected.timelineEnd + 0.05`.
4. CMD+V with no selection → `targetStart = playheadTime` (from `EditorContext.state.currentTime`).

Target end = `targetStart + clipboardEntry.durationSec`. If that exceeds the variant's last-placement end + reasonable padding, clip the end to `totalTimelineEnd`; if resulting duration < 0.5s, abort with a toast: *"Not enough space to paste clip."*

Insert a new entry into `userPlacements` with:
- Fresh `id` = `"u_" + crypto.randomUUID().slice(0,8)`.
- All source metadata from clipboard.
- `timelineStart/End` = target range.

The new clip is `isFixed=true`, so the soft-displacement walk treats it as an anchor. Other clips re-resolve on the fly; non-fixed neighbors get pushed; fixed neighbors (manually-edited originals or other user placements) stay put — if one is in the way, the new paste fits in the remaining space (possibly narrower than source).

Paste is wrapped in a single `APPLY_ACTION({ kind:'paste', userPlacement: <new> })`. Undo removes the new userPlacement and flushes.

### Drag between timelines

Extending `BRollTrack.jsx:handleBoxMove`:

- While dragging, track the pointer's Y position. Use the `visibleLayout` from `Timeline.jsx` to detect which track row the pointer is over.
- If the pointer is over a different variant's b-roll track row → enter "cross-drag" mode:
  - Render a **yellow insertion marker** (1px, `#cefc00`, the project's primary-fixed accent) on the target row at the projected drop time. If the drop time falls between two existing clips → marker is between them. If it falls inside a clip → marker is on the edge closest to the pointer (before or after that clip). Color changes:
    - **Yellow** `#cefc00` — clear drop (free space or between clips).
    - **Red** with icon — invalid (would push past timeline end and cannot fit).
  - Ghost: source clip at its original location gets `opacity:0.4`. A full-opacity 1:1 copy of the clip (img + label) follows the cursor, positioned with absolute + `pointer-events:none`, `z-index:100`.
- On release:
  - On same variant as source → existing in-place move behavior (updates `timelineStart/End` on the original placement or userPlacement).
  - On different variant → single `APPLY_ACTION({ kind:'drag-cross', ... })`:
    - Default: **move** — remove from source pipeline's state, add to target pipeline's `userPlacements`.
    - Hold **Alt/Option** at release → **copy** — source unchanged, target gets a new userPlacement.
  - Cross-pipeline action is pushed to both pipelines' undo stacks under one shared `actionId`.

Cursor feedback during drag:
- default: `cursor:grabbing`
- over invalid drop: `cursor:not-allowed`
- Alt held over other-variant drop: `cursor:copy`

### Pasted / user-created clips in the UI

Treated as equivalent to original placements:
- Same click → select in sidebar.
- Sidebar `BRollDetailPanel` shows same Edit / Retry / Delete buttons. Retry calls the new `POST /broll/pipeline/:pid/search-user-placement` with `userPlacementId` instead of `chapterIndex/placementIndex`.
- Can be edge-dragged (resize), moved, deleted, copied like any other clip.
- Visually indistinguishable from originals except a tiny "copied" icon in the corner (`material-symbols-outlined content_copy` at 8px, `opacity:0.5`), so the user knows which are AI-planned vs. user-created.

---

## Feature 5 — Lazy Load + Preload + Loading State

### Loading state in main preview (`BRollPreview.jsx`)

Add local state: `videoLoadState: 'idle' | 'loading' | 'ready' | 'error'`.

- When a b-roll clip becomes active and `brollVideoRef.current.readyState < 2` (HAVE_CURRENT_DATA), render over the video a loading backdrop:
  - Black background, `<Loader2 size={24} className="animate-spin text-primary-fixed" />` centered, caption *"Loading clip…"*.
- On `loadeddata` → `videoLoadState='ready'` → hide the backdrop.
- On `error` → step through fallback URLs (see Feature 3); after all fail → `videoLoadState='error'`, show the thumbnail (or the placement's `result.thumbnail_url`) as a still image with a tiny warning icon.

### Preloader (`src/components/editor/brollPreloader.js`, new file)

A small module managing an LRU cache of `<link rel="preload" as="video" fetchpriority="low" href={url}>` elements appended to `<head>`. Cap at 20 entries.

API:

```js
export function scheduleBrollPreload({ activePlacements, inactivePlacementsByPid, currentTime }) { ... }
export function clearBrollPreload() { ... }
```

Behavior: `scheduleBrollPreload` is called (debounced 250ms) whenever `currentTime` or `activeVariantIdx` changes in `BRollEditor.jsx`. It:
1. Picks the next **5** placements on the active variant whose `timelineStart >= currentTime - 1` (the -1s allows for brief seek-back).
2. Picks the next **2** placements on each inactive variant that has a cached `inactiveVariantPlacements` entry.
3. For each picked placement, resolves the `<video>` URL the same way `BRollPreview.jsx` does (`preview_url || preview_url_hq || url`).
4. Adds URLs not yet in the cache; evicts LRU entries not in the new set (max 20 concurrent).

### Sidebar alternative preload

In `BRollDetailPanel.jsx:BRollOptionThumbnail`, the current `<video preload="metadata">` already preloads metadata. Extend: for the top 4 alternatives of the currently-selected placement, set `preload="auto"` so swapping between results plays instantly.

---

## Phasing

### Phase A — persistence foundation + easy wins (features 1, 2, 3)

1. Migration + `loadBrollEditorState` / `saveBrollEditorState` service functions.
2. New routes `GET` / `PUT /broll/pipeline/:pid/editor-state`.
3. Reducer refactor: add `LOAD_EDITOR_STATE`, `APPLY_ACTION`, `UNDO`, `REDO`, `MERGE_REMOTE_STATE`, `SAVE_SUCCESS`. Replace `UPDATE_PLACEMENT_POSITION` and `HIDE_PLACEMENT` with `APPLY_ACTION` wrappers.
4. `matchPlacementsToTranscript` — honor `edits[key].hidden`, `timelineStart/End`, `selectedResult`.
5. Debounced save hook.
6. Keyboard handler for Delete/Backspace + CMD+Z/Ctrl+Z + CMD+Shift+Z/Ctrl+Shift+Z.
7. Undo/Redo toolbar icons above the timeline.
8. `BRollPreview.jsx` URL order fix + onerror fallback.
9. Manual test of: edit position → reload → check; delete → undo/redo → check; delete three → undo three → redo three; Pexels preview video plays.

### Phase B — copy/paste/drag (feature 4)

1. Clipboard module with localStorage mirror.
2. Context menu component for placements and empty track area.
3. Keyboard shortcuts CMD+C/X/V.
4. Soft-displacement implementation inside `matchPlacementsToTranscript`.
5. Paste action handler; duration-fit and "not enough space" toast.
6. Cross-variant drag: Y-tracking in `handleBoxMove`, yellow insertion marker, ghost clone, Alt=copy vs. default=move.
7. `drag-cross` action that writes both source and target pipelines' editor-state.
8. `POST /broll/pipeline/:pid/search-user-placement` endpoint + `searchUserPlacement` service.
9. "Reset to original" context menu item.
10. Manual test of: copy + paste same timeline, soft displacement visible, move the paste, neighbors spring back; paste in no-space situation; drag between variants; Alt-drag copy; cross-variant undo.

### Phase C — lazy load + preload + loading state (feature 5)

1. `brollPreloader.js` module with LRU preload cache.
2. Debounced scheduler wired to `currentTime` + `activeVariantIdx` in `BRollEditor.jsx`.
3. `BRollPreview.jsx` loading backdrop + `videoLoadState`.
4. Sidebar alternative preload.
5. Manual test of: throttle to Slow 3G, active clip shows spinner not black; preload cache never exceeds 20 entries (check `<head>` via DevTools).

---

## Testing Plan (manual, no automated suite)

### Phase A

- Drag a placement's edge to resize → release → wait 1s → reload page → position preserved.
- Drag body of a placement → reload → position preserved.
- Switch variants, then back → edits preserved.
- Click a placement, hit Delete → hidden. CMD+Z → restored. CMD+Shift+Z → hidden again.
- Delete 3 placements one after another. CMD+Z × 3 → all restored in reverse order. CMD+Shift+Z × 3 → all re-deleted.
- Undo/Redo toolbar: icons dim when stack empty; tooltips show action label.
- Open two tabs on same variant; edit in tab A; wait for save; edit in tab B → tab B hits 409 → auto-recovers and both edits end up persisted.
- Play a Pexels result in the main preview → video plays (previously showed black).
- Network request panel shows no 403s for Pexels HQ URLs when the preview loads (because we now try SD first).

### Phase B

- Select placement A; CMD+C. Right-click later placement B; "Paste" → new clip appears just after B.
- If the space between B and the next placement is smaller than A's duration, the pasted clip is still visible (min 0.5s); the next placement gets displaced; move the pasted clip far away → the displaced placement springs back to its original spot.
- Manually edit the displaced placement BEFORE the paste-move-away sequence → after moving paste away, the manually-edited one stays at the edited position (does not spring back).
- Right-click on empty track → Paste → clip placed at click position.
- CMD+V with no selection → paste at playhead.
- Cut with CMD+X → source gone, clipboard retains copy; paste elsewhere → lands.
- Drag a placement by body from variant A to variant B → release → moved (gone from A, appears in B). CMD+Z → back on A, gone from B.
- Alt+drag the same → release → A unchanged, B gets a copy.
- Cross-variant undo: undo from variant A's view → both sides rewind.
- Pasted clip's sidebar shows same Edit/Retry/Delete; click Retry → new search runs on the user placement; results update.
- "Reset to original" on an edited placement → `edits[key]` cleared → clip returns to LLM plan position.

### Phase C

- Chrome DevTools network throttle Slow 3G.
- Play the video; when transitioning to a b-roll clip, a loading spinner appears instead of black; clip plays once loaded.
- Scroll through timeline; DevTools `<head>` shows up to 20 `<link rel="preload" as="video">` tags, cycling in/out as the playhead moves.
- In sidebar, click a placement with multiple alternatives; rapidly click between them → swap is near-instant (because top 4 are preloaded).

---

## Non-Goals / Out of Scope

- **Multi-select** of placements (CMD-click to select many, then delete/copy/paste as a group). Not in the ask; can be added later.
- **Cross-video paste** (copy from one video's b-roll editor, paste into a different video). Out of scope — the clipboard is scoped per group implicitly because users navigate between videos via different URLs.
- **Automated tests.** The project has no test harness; only manual testing per the plan above.
- **Mobile / touch input.** Drag/drop is mouse-only for now.
- **Render pipeline integration.** Nothing here changes how the final export reads placements; but the extended `editor-data` response ensures a future render stage sees the edited timeline.

---

## Risks & Mitigations

- **Displacement algorithm correctness.** The spring-back logic must be deterministic and commutative (edit order should not matter for equivalent final state). Test a handful of tricky cases: paste between two fixed, paste adjacent to another pasted, chain of 3 natural clips pushed by one fixed.
- **Undo stack bloat.** Cap at 50 and evict oldest; state JSON stays under ~50KB for normal use.
- **409 storm.** Two tabs making rapid edits could ping-pong on 409. The refetch+replay loop with a 100ms jitter before retry keeps this stable; if 3 consecutive 409s happen, show a non-blocking warning *"Saving is contending with another session; latest save wins."*
- **Cross-pipeline action atomicity.** The drag-cross PUT writes to two pipelines. If the second PUT fails, roll back the first in memory and show a toast. The undo stack is still consistent because the action was rejected before being pushed.
- **Orphan toast noise.** If the user re-runs LLM plans frequently, the *"N edits lost"* toast could appear often. Mitigation: dismiss on click, rate-limit to once per load.

---

## Files Touched (summary)

### New

- `server/schema-pg.sql` — add `broll_editor_state` table.
- `server/services/broll.js` — add `loadBrollEditorState`, `saveBrollEditorState`, `searchUserPlacement`.
- `src/components/editor/brollPreloader.js` — new preload LRU module (Phase C).
- `src/components/editor/brollClipboard.js` — new clipboard singleton + localStorage mirror (Phase B).
- `src/components/editor/BRollContextMenu.jsx` — small right-click menu component (Phase B).

### Modified

- `server/routes/broll.js` — new GET/PUT editor-state routes, POST search-user-placement, extend editor-data response.
- `server/services/broll.js:getBRollEditorData` — merge edits + userPlacements into response.
- `src/components/editor/useBRollEditorState.js` — reducer refactor, new actions, debounced save, 409 recovery.
- `src/components/editor/brollUtils.js:matchPlacementsToTranscript` — filter, override, append, soft-displacement walk.
- `src/components/editor/BRollEditor.jsx` — editor-state load on mount, keyboard handlers, preloader wiring, undo/redo toolbar.
- `src/components/editor/BRollTrack.jsx` — context menu trigger, cross-variant drag, ghost clone, insertion marker, "copied" icon.
- `src/components/editor/BRollPreview.jsx` — URL order fix, onerror fallback, loading backdrop.
- `src/components/editor/BRollDetailPanel.jsx` — Retry for user placements, alternative preload, reset-to-original button visibility.
