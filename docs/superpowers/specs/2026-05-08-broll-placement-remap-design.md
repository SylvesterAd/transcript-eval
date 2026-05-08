# B-Roll Placement Remap on First Editor Open — Design

**Date:** 2026-05-08
**Branch:** `cuts-as-source-of-truth`
**Status:** Design

## Problem

Group 374 (`/editor/374/brolls/edit/0`) renders the first b-roll placement at 2:08–2:11, but the audio anchor "bad piece of advice floating around the internet" actually plays at ~0:03 in the post-cut timeline. Every placement in the project is offset by the cumulative cut duration (134s+ from the first cut alone).

Root cause: the LLM emits placements with `start: "[00:02:22]"` (timecode string in original time) and **no numeric `start_seconds`**. The persist function gates the original→post-cut shift on `typeof p.start_seconds === 'number'`, so for every modern plan the shift silently no-ops. Placements are stored in original time. The editor's `matchPlacementsToTranscript` then anchor-matches within a ±30s window around the LLM timecode, but the actual word in the post-cut transcript sits 134s+ away from that window, so the match fails and the editor falls back to the (wrong) LLM timecode.

A second, structural problem: `_putEditorStateHandler` calls `recomputePlacementsForCuts` on `editor_state.broll.placements` — a legacy storage path. The b-roll editor reads from `broll_runs.output_text` (chapter sub-runs) merged with `broll_editor_state` (user overrides). The "remap on cut save" wired today touches data the modern editor never reads.

## Goal

When the user opens the b-roll editor (or returns to it after editing cuts), placements appear at correct post-cut times — anchored to the spoken words via `audio_anchor`, with no overlaps and a 0.5s minimum duration. Materialize the remap into `broll_editor_state` so the editor and export pipeline read the same numbers, and so the work isn't repeated on every render.

## Architecture

Single trigger: cut-hash diff inside `getBRollEditorData`. Three layers of placement state:

1. **LLM-emitted (immutable).** Chapter sub-runs in `broll_runs.output_text`. Each placement has `start`/`end` (timecode strings, post-cut after Fix 1), `audio_anchor`, `anchor_word_idx`, `uuid`.
2. **Materialized remap (server-derived).** New fields on `broll_editor_state.state_json`:
   - `remappedPositions: { [uuid]: { start_seconds, end_seconds, anchor_state } }`
   - `lastRemappedCutsHash: string | null`
3. **User overrides (manual).** Existing `state.edits[uuid].timelineStart/timelineEnd` and `state.userPlacements`. Wins over remapped positions (current precedence preserved).

Why hash and not flag: a flag answers "has this run before?" but not "is it still correct?" Hash answers both. First open ≡ stored hash is null. Cut edit ≡ stored hash ≠ current hash. Same code path either way.

## Components

### New: `server/services/placement-remap.js`

```js
export function cutsHash(cuts, exclusions) { /* sha1 of canonical-sorted JSON */ }
export function materializePlacementRemap(placements, effectiveCuts, words) { /* … */ }
```

**`cutsHash(cuts, exclusions)`** — stable hash. Sort each array by `start`, JSON.stringify with `[start, end]` tuples only (drop ids), sha1 hex. Exclusions in the hash because they affect effective cuts.

**`materializePlacementRemap(placements, effectiveCuts, words)`** — pure function. For each placement:

1. **Anchor resolve.** If `anchor_word_idx >= 0` and `words[idx]` exists and `words[idx].start` is NOT inside any effective cut → use `words[idx].start` as the anchor's original-time position.
2. **Anchor fallback.** Else fuzzy-match `audio_anchor` against the **raw** transcript words across the whole transcript, skipping any word whose `start` falls inside an effective cut (those words are gone from the kept content). Reuse the scoring loop from `placement-match.js` but with no ±30s time window — that window is the bug that swallows the first 134s gap. The matched word's `start` is already in original time; pass straight to step 4. Tie-break: prefer the earliest match (matches `findAnchorWordIdx` semantics).
3. **Anchor orphan.** Else leave the LLM-emitted post-cut time as-is, mark `anchor_state: 'orphaned'`.
4. **Shift to post-cut.** `newStart = postCutTime(anchorOriginalTime, effectiveCuts)` from `time-translation.js`.
5. **Duration.** `origDuration = parseTimecode(p.end) - parseTimecode(p.start)`. `newDuration = Math.max(0.5, origDuration)`.
6. **Overlap trim** (after sorting all placements by `newStart`): for each adjacent pair, if `placements[i].end > placements[i+1].start`, set `placements[i].end = placements[i+1].start`. After trim, if duration is below 0.5s, mark `anchor_state: 'overlap_squeezed'` and let it stay short rather than re-pushing the next placement.

Returns `Map<uuid, { start_seconds, end_seconds, anchor_state }>`.

### Modified: `server/services/broll.js`

**`persistPlacementOutput`** (Fix 1) — when `p.start_seconds`/`p.end_seconds` aren't numeric, parse `p.start`/`p.end` timecodes via `parseTimecode` and assign before applying `shiftOriginalToPostCut`. The shift runs once per call regardless of which input form was present.

**`getBRollEditorData`** — after loading placements (around line 5788) and before merging user edits:

```js
const group = await db.prepare('SELECT id, editor_state_json FROM video_groups …').get(groupIdForPipeline)
const groupState = JSON.parse(group.editor_state_json || '{}')
const cuts = groupState.cuts || []
const exclusions = groupState.cutExclusions || []
const currentHash = cutsHash(cuts, exclusions)

const editorState = await loadBrollEditorState(planPipelineId)
if (editorState.state.lastRemappedCutsHash !== currentHash) {
  const effective = computeEffectiveCuts(cuts, exclusions)
  const words = await loadWordTimestamps(videoId) // raw transcript
  const remap = materializePlacementRemap(placements, effective, words)
  const nextState = {
    ...editorState.state,
    remappedPositions: Object.fromEntries(remap),
    lastRemappedCutsHash: currentHash,
  }
  await saveBrollEditorState(planPipelineId, nextState, editorState.version)
  editorState.state = nextState
}
```

In the existing user-edits merge loop (~line 5995), inject remapped positions as the baseline `userTimelineStart`/`userTimelineEnd` when no `edits[uuid]` override exists.

### Modified: `server/routes/videos.js`

`_putEditorStateHandler` — drop the `recomputePlacementsForCuts` call on legacy `editor_state.broll.placements`. The modern path is now handled by hash-diff in editor-data GET. Cut PUT just updates cuts; the next b-roll editor visit triggers remap automatically.

### Investigated separately: rough-cut tab strike-through regression (Fix 2)

`TranscriptEditor.jsx:842` already wires `line-through` for cut words on the rough-cut tab, but the user reports cuts now visually disappear. Repro on group 374, locate the change that broke it (likely in the data-flow into `displayItems` or `cut`/`isGap` boolean), fix in same PR.

## Data flow

**Plan completes:**
1. Per-chapter sub-runs persisted to `broll_runs.output_text`. `persistPlacementOutput` parses `start`/`end` timecodes (Fix 1), shifts to post-cut using `editor_state.cuts` at run time, attaches `anchor_word_idx`, writes back.
2. No `broll_editor_state` row yet (created lazily on first save).

**User opens b-roll editor (first time):**
1. `GET /broll/pipeline/:pid/editor-data`.
2. Server loads chapter sub-run placements. Loads `editor_state.cuts/cutExclusions` from the group. Computes `currentHash`.
3. Loads `broll_editor_state.state_json` — `lastRemappedCutsHash` is null. Hash differs.
4. Runs `materializePlacementRemap`. Writes `state.remappedPositions` + `state.lastRemappedCutsHash` + bumps version.
5. Returns placements with `userTimelineStart`/`userTimelineEnd` populated from `remappedPositions[uuid]`.
6. Frontend `resolvePlacements` merges (precedence: `edits[uuid]` > `userPlacements` > `remappedPositions` > LLM `start`/`end`). Editor renders at correct post-cut time.

**User edits cuts on rough-cut tab:**
1. Autosave fires `PUT /videos/groups/:id/editor-state` (1500ms debounced).
2. `_putEditorStateHandler` updates cuts. No remap fired here.
3. User navigates to b-roll editor → `GET /editor-data` → cuts hash differs from stored → re-runs remap → returns updated positions.

**User drags a placement handle:**
1. `PUT /broll/pipeline/:pid/editor-state` writes `state.edits[uuid].timelineStart/End`.
2. Next `GET /editor-data` — cuts hash unchanged, no remap. Existing precedence puts `edits[uuid]` on top.

**Hash invalidation propagation.** Cuts live on `video_groups.editor_state_json` (group-level), but `lastRemappedCutsHash` lives per-pipeline in `broll_editor_state.state_json` (a group can have multiple plan pipelines for different variants). Each pipeline computes its own hash on read; no explicit invalidation from the cut-save side. Self-correcting: stale hash → next read recomputes.

## Error handling

- **Words missing** (no `word_timestamps_json`): skip remap entirely, log warn, do *not* update hash so a later retry can still fix it. Editor falls back to LLM `start`/`end` — same as today's broken state but no worse.
- **Anchor not findable** (idx is -1, word in cut, fuzzy match fails): leave at LLM post-cut time, mark `anchor_state: 'orphaned'`. Frontend can show a small UI flag (existing `anchor_orphaned` UI hook from `recompute-placement-times.js` translates here).
- **Anchor word lands in a cut** (idx valid but `word.start` is inside an effective cut): treat same as orphan — the word literally doesn't exist in the kept transcript. Mark `anchor_state: 'in_cut'`.
- **Concurrent remap writes**: `broll_editor_state` already uses optimistic `version` for conflict detection. Wrap remap write under the same: read version, write `WHERE version = ?`. On conflict, re-read state, recompute against fresh state, retry once.
- **Hash collision** (theoretical): worst case is stale display until next cut edit. sha1 of canonical JSON makes this practically impossible.

## Testing

### Unit — new: `placement-remap.test.js`

- `cutsHash` is stable across cut reorderings (input order shouldn't matter — sort first).
- `cutsHash` differs when cuts or exclusions change (one extra cut, one extended cut, one new exclusion).
- `materializePlacementRemap` happy path: 3 placements, 2 cuts, anchor in kept content → correct post-cut times.
- Anchor in cut → `anchor_state: 'in_cut'`, position falls back to LLM-emitted post-cut time.
- Anchor orphan (idx=-1 and fuzzy fails) → `anchor_state: 'orphaned'`.
- 0.5s minimum: placement with 0.3s LLM duration → 0.5s in remap output.
- Overlap trim: placements at [10s, 11s] and [10.8s, 12s] → first ends at 10.8s.
- Overlap squeeze below 0.5s: marked `'overlap_squeezed'`, doesn't push the next placement.

### Unit — modified: `persist-placement-output-postcut.test.js`

- Input with timecode-only fields (no `start_seconds`) → numeric values present in output, shift applied.
- Input with both timecode and seconds → seconds wins, shift applied once (no double-shift).

### Integration

- `getBRollEditorData`: first call (no hash) → remap fires, writes hash + positions. Second call (same cuts) → no remap. Third call after cut change → remap fires again.
- `_putEditorStateHandler`: cut-change PUT no longer mutates `editor_state.broll.placements`. Verify no regression in tests that relied on the legacy mutation.

### Regression: Fix 2

- TranscriptEditor render test: verify `line-through` class is present on cut words when `state.activeTab === 'roughcut'`.

### Manual smoke

- Run plan on a fresh project → chapter sub-run `output_text` has post-cut times in `start`/`end` (not original).
- Open `/editor/374/brolls/edit/0` → first placement shows ~0:08, not 2:08.
- Add a manual cut between two placements → reopen → verify placement times shifted.
- Edit transcript on rough-cut tab → cut words show strike-through, not removal.

## Out of scope

- Switching the canonical storage to original time (Option B from brainstorming). Would be cleaner but is a larger refactor; current path keeps post-cut canonical and materializes remap incrementally.
- Cleaning up the dead `editor_state.broll.placements` legacy storage. We stop writing to it and stop reading from it; deletion of historical data is a separate cleanup task.
- A first-open *visual* indicator (toast, banner). The remap is silent; orphaned/in-cut/squeezed placements use existing UI flags.
