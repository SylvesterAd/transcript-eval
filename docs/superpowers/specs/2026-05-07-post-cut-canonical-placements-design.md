# Post-Cut Canonical B-Roll Placements — Design Spec

**Date:** 2026-05-07
**Status:** Pending user review
**Scope:** Storage model for `editor_state_json.broll.placements`, b-roll editor timeline UI (cuts collapse to thin bars), pipeline persist path (delete un-shift chokepoint), XMEML/FCP-XML export translation, dual-cut-system fix between server X1 hook and frontend `TranscriptEditor`.

## Problem

The just-shipped "cuts-as-source-of-truth" feature stores placements in **original time** (LLM emits in post-cut, server un-shifts to original on persist). User testing surfaced three connected issues:

1. **Placements appear inside cut spans**: an "intro mood" placement at `[00:00:00]-[00:00:36.56]` lands inside the frontend's [0–134.1s] cut. Root cause: LLM emitted post-cut `[00:00:00]` (start of chapter 1), chokepoint un-shifted to `[00:00:00]` (correct under the small server-cut set active at plan time), then frontend later added a wider chapter-merged cut that covers it. The two cut systems coexist instead of replacing each other.
2. **Cuts visualised as gaps in the b-roll editor make the timeline noisy.** User edits visually in post-cut domain but sees big skip-region overlays + raw transcript + raw thumbnails for cut content that's never going to render.
3. **The un-shift round-trip is fragile.** LLM rounds timestamps slightly (~0.5–1s drift), and the chokepoint can't tell "this is post-cut t=0 because LLM hallucinated 'opening hook'" from "this is post-cut t=0 because LLM legitimately means the very start of kept content". Both produce original `[00:00:00]` after un-shift, but only the second is what the user wants.

Architectural reframing: the **post-cut timeline is what the user actually edits**. Original time is what the NLE consumes at export. Storage should match the user's mental model.

## Solution

Adopt **post-cut canonical placements** (B2 from brainstorm). `editor_state_json.broll.placements[i].start_seconds/end_seconds` are POST-CUT seconds. The un-shift chokepoint is deleted. LLM emits post-cut → store post-cut. The pipeline stays as-is otherwise.

When a user edits a cut, all placement timecodes get recomputed from a stable per-placement anchor: the **original-time anchor word index** captured at placement-creation time. Anchor word index is a stable identity that survives cut edits — moving a cut never reassigns words, only renumbers their post-cut positions.

The b-roll editor renders the post-cut timeline as the primary view. Cut spans collapse to thin purple vertical bars at the join location. Click a bar → side panel reveals the cut span with removed transcript, A-roll thumbs, and waveform. Default render hides cut content entirely.

XMEML/FCP-XML export translates post-cut placements + cuts → original-time coordinates for the NLE.

### Goals

- Placements always sit on kept content. Never inside a cut span. Edit-cuts → placements re-anchor cleanly.
- The b-roll editor timeline is **continuous** in post-cut time — no visible gaps, no skip overlays, no cut content rendered by default.
- Single source of truth for cuts between server X1 hook and frontend `TranscriptEditor` — they produce equivalent shape so opening the editor doesn't append a duplicate cut set.
- Existing production placements migrate cleanly to post-cut format on a one-shot script.
- The un-shift chokepoint and its ~6 test files go away.

### Non-goals

- Not changing rough-cut runner output (`annotations_json` still raw-time, comes BEFORE cuts exist).
- Not changing how cuts themselves are stored (`editor_state_json.cuts` stays raw-time, sorted by `start`).
- Not building a "real-time multi-tab cut sync" — placements re-anchor on save/refetch, not on every keystroke.
- Not auto-invalidating existing pipeline output (broll_runs rows). Old runs keep their original-time data; only `editor_state_json.broll.placements` migrates to post-cut.
- Not touching the rough cut editor — it keeps showing cuts as visible spans (you need to see them to edit them).
- Not building a websocket layer for cross-tab cut sync.

## Architecture

### Data flow

```
                  ┌──────────────────────────────────┐
                  │ Raw upload + transcripts.raw     │
                  └─────────────┬────────────────────┘
                                │
                  rough-cut-runner ──► annotations_json
                                │
                                ▼
                  ┌──────────────────────────────────┐
                  │ ensureEditorCutsFromAnnotations  │  X1 hook (UPDATED)
                  │  produces SAME cut shape as      │  — extends each annotation
                  │  TranscriptEditor would          │  region back/fwd to nearest
                  │                                  │  uncut word, like the FE does
                  └─────────────┬────────────────────┘
                                │
                                ▼
                  ┌──────────────────────────────────┐
                  │ editor_state_json.cuts           │  ◄── single source of truth
                  │   (raw-time, sorted)             │
                  └─────────────┬────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   Rough cut editor       B-roll editor (NEW)     Pipeline (unchanged)
   shows cuts as          shows cuts as           plan_prep ► strategy ► plan
   visible spans          collapsed purple bars   reads from post-cut transcript
                          + click-to-expand panel LLM emits post-cut times
                                                        │
                                                        ▼
                  ┌──────────────────────────────────┐
                  │ persistPlacementOutput           │
                  │  (un-shift DELETED)              │
                  │  ► passes LLM emit through       │  ◄── new behaviour
                  │    untouched                     │
                  └─────────────┬────────────────────┘
                                │
                                ▼
                  ┌──────────────────────────────────┐
                  │ editor_state_json.broll          │
                  │   .placements[i].start_seconds   │  POST-CUT seconds
                  │   .placements[i].end_seconds     │
                  │   .placements[i].anchor_word_idx │  raw-transcript word idx
                  │   .placements[i].uuid            │  stable identity
                  └─────────────┬────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   B-roll editor           Cut-edit handler        Export to XMEML/FCP-XML
   renders directly        recomputes              translates post-cut +
   from post-cut times     start/end_seconds       cuts → original-time
                           when cuts change        clipitem coordinates
```

### Component-by-component

#### Storage model

`editor_state_json.broll.placements[i]` shape (today → after):

```jsonc
// today (original-time canonical):
{
  "uuid": "abc-123",
  "start_seconds": 134.18,    // original
  "end_seconds": 138.18,      // original
  "audio_anchor": "There's that bad piece of advice",
  // ... other fields
}

// after (post-cut canonical):
{
  "uuid": "abc-123",
  "start_seconds": 19.94,     // POST-CUT
  "end_seconds": 23.94,       // POST-CUT
  "anchor_word_idx": 256,     // NEW: index into transcripts.word_timestamps_json
  "audio_anchor": "There's that bad piece of advice",
  // ... other fields
}
```

`anchor_word_idx` is the position in the raw transcript's `word_timestamps` array of the first word matching `audio_anchor`. It's computed once at placement-creation time and never re-derived. On cut edit, we look up `words[anchor_word_idx].start` (original) → recompute `start_seconds` (post-cut) using the new cuts.

#### `persistPlacementOutput` (server/services/broll.js)

Today: parses LLM output, calls `remapPlacementTimes` / `remapPlacementTimesString` to un-shift each placement's start/end from post-cut to original.

After: parses LLM output, computes `anchor_word_idx` for each placement by string-matching `audio_anchor` against `transcripts.word_timestamps_json`, attaches the index to each placement, returns. **No time conversion.** The chokepoint shrinks from ~80 lines to ~20.

`remapPlacementTimes`, `remapPlacementTimesString`, `unshiftPostCutTime` — all deleted (only one usage of un-shift remains, in the export path).

#### Cut-edit handler (server/routes/videos.js)

`PUT /api/videos/groups/:id/editor-state` accepts the full editor state. Today it just writes `editor_state_json` to DB.

After: when `state.cuts` differs from the DB version, before writing, recompute `start_seconds/end_seconds` for every placement in `state.broll.placements`:

```js
for (const p of state.broll.placements) {
  if (p.anchor_word_idx == null) continue
  const w = words[p.anchor_word_idx]
  if (!w) continue  // stale anchor - flag as orphaned
  const duration = p.end_seconds - p.start_seconds
  const newStart = postCutTime(w.start, state.cuts, state.cutExclusions)
  p.start_seconds = newStart
  p.end_seconds = newStart + duration
}
```

`postCutTime(originalT, cuts, exclusions)` is a new helper — the inverse direction of `unshiftPostCutTime`. It already exists conceptually inside `generatePostCutTranscript.getOffset` — extract and export.

If `anchor_word_idx` is null (legacy placement) or the word at that index doesn't match `audio_anchor` substring (annotations changed since placement was made), mark `p.anchor_orphaned = true` and skip the recompute. The UI flags orphaned placements with a warning badge.

#### B-roll editor timeline (src/components/editor/Timeline.jsx + new CutBar.jsx)

Today: timeline shows full original-time duration. `usePlaybackSkipRegions` masks cuts during playback. Cuts appear as faded regions.

After: timeline shows POST-CUT duration. Cuts collapse to thin purple bars at the join positions. The bar is ~4px wide, centered on the join. Hover shows tooltip with cut duration ("3.2s removed"). Click opens a side panel.

**Width math:** post-cut total duration = original duration − sum(effective cut durations). Each kept segment occupies `(segment.end - segment.start) / postCutTotal × timelineWidth` px. Cut bars are the visual joiner between consecutive segment renders.

New component `CutBar.jsx`:
- Renders the bar (positioned absolutely on the timeline at the join x-coordinate)
- Click → toggle side panel state
- Side panel: shows cut start/end (raw timecodes), removed transcript snippet, A-roll thumb (one frame from the middle of the cut), waveform peaks for the cut span
- Close button collapses the panel

`usePlaybackSkipRegions` becomes effectively a no-op for the b-roll editor (the underlying `<video>` element still receives the original MP4 with cut spans intact, and the existing skip logic does the actual jump-during-playback). The visual layer just hides the cut spans.

`BRollPreview.jsx` `currentTime` rendering: convert original-time `<video>.currentTime` to post-cut for the playhead position via `postCutTime()`.

#### Export translation (server/services/xmeml-generator.js + export-xml.js)

Today: builds XMEML from original-time placements directly.

After: takes post-cut placements + cuts, computes `unshiftPostCutTime(p.start_seconds, cuts)` per placement to get original-time, emits clipitems with original-time coordinates. NLEs (Premiere, DaVinci Resolve, FCP) work in original-time of the source media.

This is the ONLY remaining usage of `unshiftPostCutTime`. We keep that function but move it to a small `time-translation.js` module.

#### X1 hook fix (server/services/cuts-from-annotations.js)

Today: `deriveCutsFromAnnotations` produces tight per-annotation cuts (one cut per `annotations_json` entry, exact bounds).

After: produces the SAME shape the frontend's `TranscriptEditor.jsx:432-470` produces — extend each annotation backward to nearest preceding uncut word's `end`, forward to nearest following uncut word's `start`. Merge adjacent extended regions. This way, when the frontend opens the editor, it regenerates the same cuts and no `cut-ai-ann-N` duplicates get appended.

Behaviour after this fix: editor_state_json.cuts has ONE shape, regardless of whether the user opened the editor or not.

### Migration

Existing production has placements in original-time. One-shot script:

```js
// scripts/_migrate-placements-to-postcut.mjs
for (const group of allGroups) {
  const state = JSON.parse(group.editor_state_json || '{}')
  if (!state.broll?.placements?.length) continue
  if (state.broll.schema_version === 'post-cut') continue  // already migrated
  const cuts = state.cuts || []
  const exclusions = state.cutExclusions || []
  const words = await loadWordsForGroup(group.id)
  for (const p of state.broll.placements) {
    p.start_seconds = postCutTime(p.start_seconds, cuts, exclusions)
    p.end_seconds = postCutTime(p.end_seconds, cuts, exclusions)
    p.anchor_word_idx = findAnchorWordIdx(words, p.audio_anchor)
  }
  state.broll.schema_version = 'post-cut'
  await db.prepare('UPDATE video_groups SET editor_state_json = ? WHERE id = ?').run(JSON.stringify(state), group.id)
}
```

Schema version field on `state.broll.schema_version` — absent or `'original'` means legacy, `'post-cut'` means migrated. Server boot reads schema version and lazily migrates if absent.

### Edge cases

- **Placement whose anchor word is now inside a cut**: re-derive post-cut time for the original-time anchor word, but the word is filtered out → `postCutTime()` returns the time of the NEXT kept word AFTER the cut. Mark `p.anchor_in_cut = true` so the UI can flag it.
- **Cuts deleted (post-cut domain expands)**: anchor_word_idx → original-time → new post-cut time naturally. Placement reappears at its new (later) post-cut location.
- **Audio_anchor text doesn't match word_timestamps[anchor_word_idx]** (annotations re-ran, words shifted): set `p.anchor_orphaned = true`. UI shows a warning. User can manually re-anchor or delete.
- **LLM emits post-cut time past the post-cut total duration** (hallucinated time): clamp to `postCutTotal`. Log warning.
- **Two placements with overlapping post-cut ranges after a cut edit**: visually overlap in the b-roll editor. Today we already handle this — keep current behavior (z-stack by uuid, user manually resolves).
- **Group has no cuts at all**: post-cut domain == original domain. `postCutTime()` is identity. All placements equivalently encoded.

### Testing strategy

Unit tests:
- `cuts-from-annotations.test.js` — extend region logic matches frontend TranscriptEditor output for synthetic annotation+word fixture (golden test)
- `post-cut-time.test.js` — `postCutTime()` round-trip with `unshiftPostCutTime()` is identity
- `persist-placement-output.test.js` — chokepoint adds `anchor_word_idx`, doesn't shift times
- `recompute-placement-times.test.js` — new helper recomputes start/end correctly across cut edits
- `migrate-placements-to-postcut.test.js` — one-shot script idempotent + correct on real fixture (project 273)

Integration:
- `editor-state-cut-edit.test.js` — PUT /editor-state with new cut → placements recomputed → DB write reflects new times
- `xmeml-export-postcut.test.js` — post-cut placements + cuts → original-time XMEML clipitems

Real-data verification (`scripts/_proof-postcut-canonical.mjs`):
- Load project 273 fixture
- Migrate its placements to post-cut
- Apply cut edits (move, add, delete)
- Verify post-cut times re-anchor correctly (anchor_word_idx maps back to same original word position)
- Verify XMEML export still produces clipitems at correct original-time coordinates

UI:
- Storybook for `CutBar.jsx` (collapsed bar, hover tooltip, expanded panel)
- Vitest for `Timeline.jsx` post-cut layout math (segment widths add to 100%)
- Manual smoke: open b-roll editor on group with cuts → no gaps, purple bars at joins, click reveals removed content

## Out of scope (explicit)

- Frontend-side cut-edit handler (we do it server-side on PUT — single source of truth).
- Real-time placement-recompute as user drags a cut handle (recompute on save, not during drag).
- Migration tooling for `broll_runs.output_text` (kept in original-time for historical fidelity — only `editor_state_json.broll.placements` migrates).
- LLM prompt changes beyond "place only on kept content" (the prompt already shows post-cut transcript; explicit rule prevents `[00:00:00]` hallucinations).

## Risk register

| Risk | Mitigation |
|---|---|
| Migration script silently corrupts production data | Run on staging copy first, verify checksum of migrated JSON, gate behind feature flag for first deploy |
| Anchor word matching produces false positives (same phrase repeated) | Match whole-word + nearest-to-original-time tiebreaker |
| Cut edit during chain run leaves placements partially recomputed | PUT /editor-state acquires advisory lock for group_id, blocks during chain stages that read placements |
| Frontend regen produces cuts that ALMOST match server X1 but differ by < 0.05s | Tolerance check in computeEffectiveCuts already merges (we tested 0.05s threshold) — verify in regression test |
