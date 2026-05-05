# Cuts as Source of Truth — Design Spec

**Date:** 2026-05-05
**Status:** Pending user review
**Scope:** Pipeline strategies (analysis / plan strategy / plan creation), `BRollEditor.jsx` family, `xmeml-generator.js`, shared cut state on `video_groups.editor_state_json`.

## Problem

Three concrete bugs and one architectural mismatch:

1. **Analysis strategy ignores rough cut.** `/editor/:id/brolls/strategy/analysis` runs against the raw upload — `getVideoFilePath(videoId)` resolves `videos.cf_stream_uid` / `videos.file_path`, which is the original. The seeded analysis strategy doesn't include the `generate_post_cut_transcript` / `export_post_cut_video` programmatic stages that `create-broll-plan-strategy.js:29-48` already provides for the b-roll plan strategy.
2. **Plan strategy + plan creation ignore rough cut** for the same reason: `{{transcript}}` resolves to the raw transcript, `main_video` resolves to the raw upload.
3. **`/editor/:id/brolls/edit` shows uncut video.** `useBRollEditorState.js` is an isolated state machine that has no awareness of `state.cuts` from `useEditorState.js`. Preview plays straight through cut regions; timeline shows no cut markers; there is no Cut button or edge drag.

Architectural mismatch: today the system half-renders ("export post-cut MP4 just for analysis stages, then forget it") and half-uses-cut-lists ("XMEML export emits cut decisions"). The ask is to settle on **cuts as the canonical edit decision throughout** — Adobe Premiere model — while keeping the existing post-cut MP4 render only as a stage-level intermediate for the few stages that genuinely need video pixels.

## Solution

Adopt cuts-as-source-of-truth (Option A from brainstorm). `video_groups.editor_state_json.cuts` is the single canonical edit decision for a project. Both editors (rough cut + b-roll) read and write the same store. Pipeline stages that take transcript or timecode input get the post-cut transcript (already implemented). Stages that need video pixels get the rendered post-cut MP4 (already implemented). Export emits A-Roll cuts as separate clips on track 1 in XMEML.

### Goals

- The three reported bugs go away: analysis, plan strategy, and plan creation all run against the post-cut version.
- The b-roll editor has full cut UI parity with the rough cut editor: visible AI silence/annotation cuts, manual Cut button, edge drag, cut-aware preview.
- Cut edits in the b-roll editor immediately reflect in the rough cut editor and vice versa (single shared store).
- Export XMEML encodes A-Roll cuts as separate clipitems on track 1 — Premiere imports them as individually-editable clips, not one continuous A-Roll.

### Non-goals

- Not changing how `rough-cut-runner.js` produces `annotations_json` (still runs on raw — cuts come *out* of this stage; can't run on cuts that don't exist yet).
- Not auto-invalidating existing analysis / plan runs that used raw — old runs stay (per Q1=b). New runs use post-cut going forward.
- Not changing the existing FFmpeg post-cut render mechanism — it works.
- Not adding a transcript pane to the b-roll editor (visual timeline + cut UI only — per user's "I wouldn't be able to see Transcript Text Editor").
- Not changing pipeline progress UI, restart-from-stage, or `stages_snapshot_json` change-detection.
- Not building a websocket sync layer — refetch-on-focus is sufficient for the typical "one tab at a time" usage.

## Architecture

### Data flow

```
                    ┌────────────────────────────┐
                    │  Raw upload                │
                    │  (videos.cf_stream_uid)    │
                    └──────────────┬─────────────┘
                                   │
                                   ▼
          rough-cut-runner ──► annotations_json
                                   │
                                   ▼  (user reviews + manual edits)
                    ┌────────────────────────────┐
                    │ video_groups.              │
                    │   editor_state_json.cuts   │  ◄── single source of truth
                    │   .cutExclusions           │
                    └──────────────┬─────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                      ▼
    Rough cut editor        B-Roll editor          Pipeline stages
    (read+write cuts)       (read+write cuts)      ┌──────────────────────┐
            │                      │               │ Stage 1: gen post-   │
            │                      │               │   cut transcript     │
            │                      │               │ Stage 2: render post-│
            │                      │               │   cut MP4 (FFmpeg)   │
            │                      │               │ Stage 3+: video_llm  │
            │                      │               │   uses post-cut MP4  │
            │                      │               │   + post-cut         │
            │                      │               │   transcript         │
            │                      │               └──────────┬───────────┘
            │                      │                          │
            │                      │                          ▼
            │                      │             Placements emitted in
            │                      │             post-cut timecodes
            │                      │                          │
            │                      └──────────────────────────┘
            │                                                 │
            └──────────────────► Export ◄─────────────────────┘
                                    │
                                    ▼
                          XMEML for Premiere/FCPX:
                          Track 1: A-Roll clips per kept segment
                          Track 2+: B-Roll/PIP/overlay placements
```

### Coordinate systems

This is the part that bites.

- **Original time** — what the rough cut editor uses today. Word timestamps from raw transcript. `editor_state_json.cuts` are stored as `{start, end}` in original time. The original MP4 plays in original time.
- **Post-cut time** — what `generatePostCutTranscript` and `exportPostCutVideo` produce. Cumulative cut duration is subtracted; t=0 is the first kept word. The 360p MP4 produced by Stage 2 plays in post-cut time.

**Decision: editors and persisted DB state stay in original time. Pipeline output (placements) gets un-shifted back to original time before being saved.**

This differs from the original framing of "leave same timecodes in the post-cut transcript for easier mapping later". The reason: Analyze A-Roll + Chapters & Beats is a *combined* video+transcript stage — the rendered post-cut MP4 inherently has shifted timecodes (FFmpeg concat resets t=0), so the transcript sent alongside it must match. Keeping original timecodes in the transcript would create a mismatch between video time and transcript time inside the same prompt and confuse the LLM. Doing the un-shift on the *output* side gives you the same end result ("placements expressed in original time on the editor's timeline") without that mismatch.

Rationale for the decision:

- Both editors already operate in original time; changing them is risky and breaks the existing rough-cut codepath.
- Cuts in `editor_state_json` already exist as original-time `{start, end}` ranges. Keeping them that way avoids a destructive migration.
- The b-roll preview can show "post-cut content" simply by reusing `skipRegions` from `EditorView.jsx` — no coordinate change needed.
- Un-shifting placements is a pure function over the cuts array (add cumulative cut durations up to the placement's start). Cheap, deterministic, easy to test.

A small helper `unshiftPostCutTime(t, effectiveCuts)` lives in `server/services/broll.js` (next to `generatePostCutTranscript`). Pipeline code calls it on every placement timecode emitted by the post-cut-aware stages before writing to `broll_runs.output_text`. Unit-tested both ways (shift / un-shift round-trip).

### Mapping correctness

This is the highest-risk section of the design. Locking it down explicitly.

#### The function

```js
// effectiveCuts: sorted, non-overlapping {start, end} in ORIGINAL time
//                (output of computeEffectiveCuts in broll.js:1075)
// kind: 'start' | 'end' — controls the boundary rule (see below)
function unshiftPostCutTime(tPost, effectiveCuts, kind = 'start') {
  let cumOffset = 0
  for (const c of effectiveCuts) {
    const boundary = c.start - cumOffset  // tPost where this cut begins, in post-cut time
    const beforeBoundary = kind === 'end' ? tPost <= boundary : tPost < boundary
    if (beforeBoundary) return tPost + cumOffset
    cumOffset += c.end - c.start
  }
  return tPost + cumOffset
}
```

This is the algebraic inverse of `getOffset(time)` in `generatePostCutTranscript:1014-1023`. The same function handles both video timecodes (the rendered post-cut MP4 produced by `exportPostCutVideo`) and transcript timecodes (the shifted timecodes inside the `[HH:MM:SS]` markers of the post-cut transcript). Both share one coordinate system because FFmpeg concat resets t=0 at the same boundaries the transcript shift uses.

#### Boundary rule (the asymmetric `<` vs `<=`)

When `tPost` lands exactly on a cut boundary in post-cut time (the moment immediately after an FFmpeg concat join), there are two valid mappings:

- "End of the previous kept span" → maps to `cut.start` in original time.
- "Start of the next kept span" → maps to `cut.end` in original time.

Resolution depends on whether the timecode is a START or an END of a placement range:

| Field | Rule | At boundary `tPost == c.start - cumOffset` |
|---|---|---|
| `start_seconds` | strict `<` | jumps PAST the cut → `cut.end` |
| `end_seconds` | inclusive `<=` | stays BEFORE the cut → `cut.start` |

Why: a placement with `start_seconds = boundary` semantically begins at "the frame that appears right after the concat join" — that frame in the original is `cut.end`. A placement with `end_seconds = boundary` semantically ends at "the last frame before the join" — that's `cut.start`. The asymmetric rule ensures the placement is anchored to actual A-Roll frames rather than landing inside a cut.

In practice LLMs round to whole seconds and cuts rarely align with whole seconds (they get edge-refined to word boundaries with waveform padding), so boundary collisions are exceedingly rare. The rule exists so we don't have a silent failure mode if it ever happens.

#### Round-trip identity

For any word `w` in the raw transcript that is KEPT (its midpoint is not inside any effective cut):

```
unshiftPostCutTime(w_shifted.start, cuts, 'start') === w.start
unshiftPostCutTime(w_shifted.end,   cuts, 'end')   === w.end
```

Words whose midpoint is INSIDE a cut don't have a post-cut representation (filtered by `keptWords` at `broll.js:1001-1004`) so round-trip is undefined for them — that's correct, not a bug.

This identity is provable by construction (one function is the algebraic inverse of the other) and is the cornerstone test in the unit suite below.

#### Failure modes and handling

| # | Scenario | Handling |
|---|---|---|
| 1 | Placement spans a cut in original time (e.g. post-cut [50,70] → original [50,90] with cut [60,80] in between) | Accept. Premiere-style absolute positioning. B-roll editor draws cut overlay across [60,80] visually; the b-roll chip continues underneath. We persist `pipeline_cuts_snapshot` alongside placements for traceability. |
| 2 | Boundary-touching timecode (`tPost` exactly at a cut boundary) | Asymmetric `<` / `<=` rule above. Tested explicitly. |
| 3 | LLM emits `tPost` outside `[0, post_cut_duration]` (hallucination) | Reject the placement, log a warning, increment a counter. Don't clamp — clamping hides LLM regressions. |
| 4 | Floating-point drift across many cuts | JS doubles, sums of small float differences. Tested at 100+ cuts. Drift bounded by `O(n × ε)` where `ε ≈ 2.2e-16`; for 1000 cuts of ~1s each, max drift is ~2e-13s. Negligible at video frame rates. |
| 5 | User edits cuts AFTER pipeline ran | Placements stay in original time (already persisted). They may now visually span new cuts or sit in regions that used to be cut. `pipeline_cuts_snapshot` lets the UI optionally show "these placements were planned against a different cut state — re-run to refresh". |

#### Test plan (mapping-specific)

Three layers, each one independently catches a different class of bug:

| Layer | Catches | What it does |
|---|---|---|
| **Property test** | Algorithmic bugs in shift/un-shift | Generate random raw word lists (1–500 words) + random cut lists (0–50 cuts). Shift, then un-shift. Assert `|original - round_tripped| < 1e-9` for every kept word. Repeat 1000+ iterations. Includes adversarial inputs: cuts touching word boundaries, cuts of zero-ish duration filtered out, all-cut transcript, no-cut transcript. |
| **Boundary test (regression)** | Asymmetric `<` vs `<=` rule | Hand-picked fixtures: word at `cut.start` exactly, word at `cut.end` exactly, placement `start_seconds == boundary`, placement `end_seconds == boundary`. Each asserts the EXACT expected original-time mapping. |
| **Real-data fixture** | Wiring bugs (un-shift not called on every output path) | Snapshot `editor_state_json.cuts` and `word_timestamps_json` from project 273. Run the analysis pipeline against it. Assert every placement's `(start_seconds, end_seconds)` falls within a kept original-time region (i.e. no placement timecode lands inside any effective cut). |

The third test is the one that catches the actually-likely bug class: someone adds a new placement-emitting stage and forgets to route through the chokepoint helper. It's an integration test, runs slow, but is the only test that proves "every output path is wired correctly".

#### Single chokepoint

To prevent silent un-shift omission, every placement persistence point goes through one helper:

```js
// in broll.js, used by every stage that writes placement-shaped data
async function persistPlacementOutput(stageOutput, editorCuts, runMetadata) {
  if (!editorCuts?.cuts?.length) {
    // no cuts — output is already in original time
    return stageOutput
  }
  const effective = computeEffectiveCuts(editorCuts.cuts, editorCuts.cutExclusions || [])
  const remapped = remapPlacementTimes(stageOutput, effective)  // applies unshift to all start/end pairs
  return remapped
}
```

The implementation plan's first task is to grep `assemble_broll_plan`, per-chapter assemblers, plan-prep, and any other point that writes placement-shaped data into `broll_runs.output_text`, and route them all through `persistPlacementOutput`. Tests in the third layer above prove the wiring.

### Components

**Backend (mostly wiring, light code):**

1. **Strategy seeds** (`server/services/broll-prior-strategies.js` and any DB-seeded strategy versions):
   - Find the analysis strategy. Prepend Stages 1+2 from `create-broll-plan-strategy.js:29-48`.
   - Find the plan strategy. Same prepend.
   - Find the plan creation strategy. If it has video_llm stages, full prepend. If it's text-only with `{{transcript}}`, only prepend Stage 1 (`generate_post_cut_transcript`); skip the FFmpeg render.
   - Migration: existing `strategy_versions` rows are NOT modified. New behavior takes effect for the next version of each strategy. User triggers "create new version" in the strategies UI to opt in.

2. **`server/services/broll.js`:**
   - Add `unshiftPostCutTime(t, effectiveCuts)` helper.
   - In the per-chapter / per-beat placement assembly stages (`assemble_broll_plan` etc., around lines 5118+), iterate placement timecodes and call `unshiftPostCutTime` before persisting. Gated on whether `editorCuts` was non-empty (no-op when no cuts).

3. **`server/services/xmeml-generator.js`:**
   - Accept `aroll_segments: [{start, end}]` in input alongside `placements`.
   - Emit one `<clipitem>` per A-Roll segment on track 1 (existing logic emits one continuous clip; replace with a loop).
   - Existing b-roll/PIP/overlay tracks (2+) unchanged.
   - Round-trip tested: importing the generated XML into Premiere shows separate clips that can be moved or deleted individually.

4. **`server/routes/exports.js` / export manifest builder:**
   - Compute `aroll_segments` from `editor_state_json.cuts` via the existing `computeEffectiveCuts` (broll.js:1075). The complement of cuts over `[0, video_duration]` gives the kept segments.
   - Add `aroll_segments` to the manifest written via `writeExportResult`.

5. **API for editor state read/write:** confirm `PATCH /videos/groups/:id/editor-state` (or whatever the rough cut editor already calls for autosave) is the same endpoint the b-roll editor will use. If the rough cut editor uses a different mechanism, stand up one shared endpoint and route both editors through it. (Implementation plan investigates this — likely already exists, since `editor_state_json` is one column.)

**Frontend (real code):**

6. **`useBRollEditorState.js`:**
   - Extend state shape: add `cuts`, `cutExclusions`, `annotationRegions`, `annotations` (mirror of fields used by `useEditorState.js`).
   - Load on mount via `GET /videos/groups/:id/editor-state` (or whatever loader the rough cut editor uses).
   - Save on cut change via the shared PATCH endpoint.
   - Refetch on `window.focus` event to pick up edits made in another tab.

7. **`useEditorState.js`:**
   - Add `window.focus` refetch to mirror behavior — symmetric sync.

8. **New shared module: `src/components/editor/sharedCutLogic.js`:**
   - Lift `handleSplit` from `PlaybackControls.jsx:61-89`.
   - Lift `handleEdgeDrag` from `TimelineTrack.jsx` and `VideoFrameTrack.jsx`.
   - Both editors import from here. The reducer actions (`ADD_CUT`, `UPDATE_CUT`, `REMOVE_CUT`) stay in `useEditorState.js` for now and are called by reference from b-roll editor's reducer (or extracted to a shared cut-reducer module — implementation plan decides).

9. **`BRollEditor.jsx`:**
   - Subscribe to cuts from the extended `useBRollEditorState`.
   - Pass `cuts` + `cutExclusions` down to `BRollPreview` and `BRollTrack`.

10. **`BRollPreview.jsx` / `RoughCutPreview.jsx`:**
    - Reuse the `skipRegions` skip-during-playback behavior from `EditorView.jsx` — extract into a hook `usePlaybackSkipRegions(videoRef, cuts, cutExclusions, mergedWords)` that both previews use. Keep the waveform-aware refinement intact (`mergedWords` corrected ends + 3-bar silence rule) since it's already in `mergedWords` useMemo and `skipRegions` derivation.
    - When the playhead enters a cut, jump to cut end (existing behavior).

11. **`BRollTrack.jsx` (or its parent `Timeline.jsx` mounting):**
    - Reuse `mergedDisplayCuts` (`Timeline.jsx`) to render cut overlay strips on the b-roll editor's timeline.
    - Edge drag handles dispatched through `sharedCutLogic.handleEdgeDrag`.
    - The b-roll editor's existing placement track (b-roll chips) sits underneath the cut overlay — visual layering only, no logical change.

12. **`PlaybackControls.jsx`:**
    - Today the Cut button is gated on `state.activeTab === 'roughcut'` (line 207-ish). Remove that gate. The button is enabled in any editor view that has a valid cut state. `handleSplit` already operates on the playhead and dispatches `ADD_CUT` — the action works the same regardless of which editor triggers it.

### Sync model

- Single shared row: `video_groups.editor_state_json` is the only persistent store.
- Single shared API: `PATCH /videos/groups/:id/editor-state` (verified or stood up in implementation).
- Each editor saves on cut change (debounced 500ms — match existing rough cut autosave).
- Each editor refetches on window focus and on tab activation.
- Conflict resolution: last write wins. Acceptable because (a) typical workflow is one tab at a time, (b) cuts are additive and rarely directly conflicting, (c) user can always undo.

### Backfill / migration (Q1 = b)

- Existing analysis / plan / plan-creation runs that ran against raw stay as-is. No invalidation, no token re-spend.
- The seeded strategies get NEW versions with the prepended Stages 1+2. The user opts in by re-running.
- A small banner on `/brolls/strategy/analysis` and the plan pages: "This run used the original video. Re-run to use the rough-cut version." Clicking re-run goes through the new strategy version.
- Rationale: (b) over (a) avoids surprise token charges on revisit; user maintains control.

## Files to change

### Backend
- `server/services/broll-prior-strategies.js` — find + update analysis / plan / plan-creation strategy seeds (or DB migration to insert new strategy versions if seeds aren't authoritative)
- `server/services/broll.js` — add `unshiftPostCutTime`, call it in placement assembly stages
- `server/services/xmeml-generator.js` — emit per-segment A-Roll clipitems
- `server/routes/exports.js` (or wherever export manifest is built) — include `aroll_segments`
- `server/services/__tests__/broll-pipeline.test.js` — new tests for un-shift round-trip + strategy structure
- `server/services/__tests__/xmeml-generator.test.js` — new tests for `aroll_segments` emission

### Frontend
- `src/components/editor/useBRollEditorState.js` — cuts in state, load + save, refetch on focus
- `src/components/editor/useEditorState.js` — refetch on focus
- `src/components/editor/sharedCutLogic.js` — NEW shared module
- `src/components/editor/BRollEditor.jsx` — wire cuts to preview + timeline
- `src/components/editor/BRollPreview.jsx` — skip during playback
- `src/components/editor/RoughCutPreview.jsx` — extract shared skip hook
- `src/components/editor/BRollTrack.jsx` (or Timeline.jsx) — render cut overlay, edge drag
- `src/components/editor/PlaybackControls.jsx` — un-gate Cut button
- `src/components/editor/__tests__/BRollEditor.test.jsx` — cut overlay, Cut button, preview skip

## Open issues for implementation plan

These are decisions to make during plan-writing, not blockers for the spec:

- **Strategy seed authority.** Is the source of truth `broll-prior-strategies.js`, a DB seed migration, or in-DB rows that must be patched via a script? Implementation plan figures this out and chooses the right migration path.
- **Cut reducer extraction.** Whether to keep `ADD_CUT`/`UPDATE_CUT`/`REMOVE_CUT` actions in `useEditorState.js` and call them by reference from b-roll, or extract them to a third `useSharedCutsReducer.js`. Both work; implementation plan picks based on what reads cleaner.
- **Chokepoint enforcement.** Confirm during implementation that ALL pipeline output paths (per-chapter, plan-prep, full plan, any future stages) route through the single `persistPlacementOutput` helper described in Architecture § Mapping correctness. The real-data fixture test is what proves the wiring; if anyone adds a new placement-writing stage without routing through the helper, that test fails on the next run.

## Test plan

- **Backend unit:** Mapping correctness — see Architecture § Mapping correctness § Test plan for the three-layer suite (property, boundary regression, real-data fixture). `xmeml-generator` emits N clipitems for N segments.
- **Backend integration:** Trigger analysis pipeline on a project with cuts. Assert Stage 1 ran, Stage 2 produced an MP4 URL, Stage 3+ used the post-cut MP4 (check broll_runs.input_text). Verify final placements have original-time timecodes.
- **Frontend unit:** `BRollEditor` cut overlay renders against fixture cuts. Cut button creates a cut at playhead. Preview skips cut regions.
- **Frontend e2e (manual smoke):** Open project 273. Make a cut in rough cut editor. Switch to b-roll edit page — cut visible on timeline. Make a cut in b-roll editor. Switch back to rough cut — cut visible. Re-run analysis — verify post-cut version is used in resulting placements.
- **Export integration:** Export a project with cuts. Open the resulting XML in a text editor — assert multiple `<clipitem>` entries on track 1, one per kept segment.

## Implementation phases (rough cut)

The plan-writing skill expands these. Listed here only so reviewers see the order and can flag missing dependencies:

1. Backend wiring: strategies + `unshiftPostCutTime` + tests. (Unblocks correct pipeline output.)
2. Frontend cut sharing: extract `sharedCutLogic`, plumb cuts into `useBRollEditorState`, save/load via shared API. (Unblocks UI.)
3. B-roll preview skip + timeline cut overlay. (Visible bug fix.)
4. Cut button un-gate + edge drag in b-roll editor. (Manual cut feature.)
5. Export A-Roll segments in XMEML.
6. Smoke + manual verification on project 273.
