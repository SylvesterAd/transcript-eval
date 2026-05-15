# Slip-Edit + Source-Clamp Design

**Status:** Draft
**Date:** 2026-05-15
**Author:** transcript-eval / Claude pair-design

## Goal

Give the user control over which portion of a b-roll source file fills a placement on the master timeline, and prevent the "video stops showing partway" bug when a source is shorter than its placement slot.

Two coupled changes:

1. **Source-clamp pass ("Pass 4")** — when probe data arrives, normalize each placement so `source_in_seconds = 0` and `timelineDuration ≤ sourceDurationSeconds`. User can override per-placement to keep the original (too-long) duration.

2. **Inline slip-edit UI** — double-clicking a placement expands the b-roll row to show the full source as a horizontal strip with a draggable in/out window. Dragging the window slips the source under a fixed-length placement slot. The main editor preview seeks live to the current slip position.

## Background

The export pipeline currently has no concept of "where in the source the clip starts." Effectively, every placement is hard-coded to `source_in = 0` (or, for files with edit-list / embedded TC, `source_in = elst_offset + tc_offset` after v1.1.6 compensation).

Two recent bugs surface the gap:

- **Item 016 (Pexels 5072388):** source = 6.17s / 185 frames. Placement `timelineDuration` = 7.0s. XMEML emits `<out>=212`, past the file's last frame (185). DaVinci shows the first ~6.1s then goes black.
- **No mechanism for the user to pick a different portion of a source.** If the editor auto-selects an opening that isn't the best part of the clip, the user has no way to slip without re-searching.

This design fixes both by making `source_in_seconds` an explicit, user-editable field, and by clamping `timelineDuration` against the actual source duration.

## Out of Scope

- Trim edits (changing `timelineDuration` by dragging an edge). Slip preserves duration.
- Replacing the source file (already covered by retry/re-search flow).
- Zoom controls on the source strip. Long-source-short-window stays narrow in v1.
- Cross-placement ripple / undo stacks beyond the existing editor's behavior.
- Roundtrip into existing search-overrides EditModal (separate UI).

## User-Facing Behavior

### Auto-clamp (Pass 4)

When probe data (`probed_metadata.durationSeconds`) arrives for a placement:

- If `keep_original_duration` is false (default) **and** `sourceDurationSeconds < timelineDuration`:
  - Set `timelineDuration := sourceDurationSeconds`
  - Set `auto_clamp_applied := true`
  - Adjust downstream `<end>` accordingly when XML is built
- A small clock icon appears on auto-clamped placements in the b-roll track so the user can see which were trimmed.
- `source_in_seconds` defaults to 0 and is not touched by this pass.

### Slip-edit panel (inline expansion)

Double-clicking a b-roll placement on the timeline expands an inline panel attached to that placement's row. The panel contains:

- **Source strip:** a horizontal bar whose full width represents the source file's full duration, scaled to fit the panel width.
- **Green window:** the portion of the source currently mapped to the placement (from `source_in_seconds` to `source_in_seconds + effectiveDuration`). Width of green = `effectiveDuration / sourceDuration * stripWidth`.
- **Dimmed regions:** the source outside the green window rendered at ~40% opacity.
- **Overflow indicator:** if `keep_original_duration = true` and `source_in_seconds + timelineDuration > sourceDurationSeconds`, the right portion of the green window that extends past the source is rendered with a red-striped overlay labeled "no source here."
- **Keep original duration checkbox:** toggles `keep_original_duration` for this placement. When flipped on, `timelineDuration` reverts to its pre-clamp value (stored as `original_timeline_duration`). When flipped off, `timelineDuration` re-clamps.
- **Playhead marker:** a thin vertical line on the strip showing what frame the main preview is currently displaying.

Closing:

- Press Esc
- Click outside the panel (on another area of the timeline)
- Double-click the same placement again

Only one panel is open at a time; opening a second auto-closes the first.

### Slip interaction

- The user drags the green window (or its body, not its edges) left or right.
- The window width does not change (pure slip).
- Slip bounds:
  - Lower: `source_in_seconds ≥ 0`
  - Upper: when clamp active, `source_in_seconds ≤ sourceDurationSeconds − timelineDuration`. When `keep_original_duration = true`, upper bound is `max(0, sourceDurationSeconds − minVisibleDuration)` where `minVisibleDuration = 1 frame` — i.e., at least one source frame must remain in the window.
- Drag snaps to source frames (integer source frames).
- During drag, the main editor preview seeks to `source_in_seconds + playheadOffsetInWindow`, throttled to ~30Hz via rAF. On drag-end, the slip is committed to the placement's `edits` entry.
- Clicking on the strip outside the green window moves the playhead (and seeks the preview) but does not slip.

### Layout / overflow

- Expanded panel is positioned **below** the placement bar.
- Minimum panel width: **480px**.
- If the placement bar is narrower than 480px, the panel overflows right (and left if needed) past the bar's bounds.
- If the panel would extend past the visible timeline viewport, the timeline auto-scrolls so the panel is fully visible when slip opens.
- While slip is active, other placements on the same b-roll track are visually unaffected but cannot be interacted with (clicks pass through to the panel-close handler when outside the panel).

## Data Model

Per-placement, persisted into the existing `edits` dict in `useBRollEditorState` (keyed by placement UUID). All fields optional; defaults applied when absent.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `source_in_seconds` | number | 0 | Where in the source file the clip starts. |
| `keep_original_duration` | boolean | false | If true, ignore source-clamp; allow `<out>` to extend past source end. |
| `original_timeline_duration` | number | — | Saved before first clamp so the user can restore. Set by Pass 4 on first clamp. |
| `auto_clamp_applied` | boolean | false | True when Pass 4 has shrunk the placement. |

These fields ride alongside the existing edits (`description`, `style`, etc.). The reducer merges them into the canonical placement when computing derived state.

`source_out_seconds` is derived, not stored: `min(source_in_seconds + timelineDuration, sourceDurationSeconds)` if clamp, else `source_in_seconds + timelineDuration` (may exceed source).

## Pass 4 Pipeline Location

Runs **on the client**, inside `useBRollEditorState`'s reducer.

Trigger: a new `PROBE_DATA_RECEIVED` reducer action carrying `probed_metadata` for a given placement, dispatched from the existing probe-data ingestion path that already writes `item.probed_metadata` (see `extension/modules/queue.js:962`).

Effect:
1. Load placement + current edits.
2. If `edits.original_timeline_duration` is unset, set it to the current `timelineDuration` (preserves the pre-clamp value for later restore).
3. If `edits.keep_original_duration !== true` and `probed_metadata.durationSeconds < timelineDuration`:
   - Set `edits.timelineDuration := probed_metadata.durationSeconds` (or equivalent — `edits` already supports `timelineDuration` overrides via existing infrastructure; if not, add it).
   - Set `edits.auto_clamp_applied := true`.

This deliberately does **not** run on the server. The server holds raw placements; the editor state is where probe data merges with user intent. The XMEML generator already reads from the saved editor state (`/broll/pipeline/:id/save-editor-state`).

### Toggle handling

When the user flips `keep_original_duration`:

- **On → off (back to auto):** apply Pass 4 logic again, restoring clamp if applicable.
- **Off → on (keep original):** restore `timelineDuration := original_timeline_duration` (if set). Clear `auto_clamp_applied`.

## UI Architecture

### New component: `BRollSlipPanel`

Location: `src/components/editor/BRollSlipPanel.jsx`

Props:

- `placement` — the placement currently being edited (with edits merged)
- `probedMetadata` — must include `durationSeconds`, `frameRate`
- `onSlipChange(sourceInSeconds)` — fires on drag-end
- `onClampToggle(keepOriginal)` — fires on checkbox toggle
- `onPreviewSeek(absoluteSourceSeconds)` — fires throttled during drag and on strip-click
- `onClose()`

Renders:
- Source strip (`<div>` with absolutely-positioned children for the window, dim regions, overflow stripe, and playhead)
- Checkbox row
- Frame-accurate readout: "Source in: 00:00:01:14 — Source out: 00:00:04:08" (SMPTE TC formatted at source rate)

### Changes to `BRollTrack.jsx`

- Add `onDoubleClick` handler on placement bars. Sets a local `expandedPlacementId` state (or lifts to editor state).
- When `expandedPlacementId` matches a placement, render `<BRollSlipPanel>` below the placement bar with the overflow-aware positioning logic described above.
- Compute the panel's left/right offsets based on placement bar position + minimum width + viewport bounds.

### Changes to `useBRollEditorState.js`

- Add reducer cases:
  - `SLIP_PLACEMENT(placementId, sourceInSeconds)` — writes to `edits[placementId].source_in_seconds`
  - `TOGGLE_KEEP_ORIGINAL(placementId, value)` — writes to `edits[placementId].keep_original_duration` and applies the clamp-restore logic above
  - `PROBE_DATA_RECEIVED(placementId, probedMetadata)` — runs Pass 4
- Ensure `getMergedPlacement(id)` returns `timelineDuration` reflecting the clamp.

### Main preview integration

The existing main video preview component must accept an external "preview source" override:

- During slip-edit, the slip panel calls `onPreviewSeek(sourceFile, absoluteSeconds)` (throttled via rAF).
- The preview swaps its `src` to the slip-target source (if not already loaded) and seeks to `absoluteSeconds`.
- On slip-panel close, the preview reverts to the master-timeline program playback.

If the existing preview doesn't expose this hook, add an imperative ref or a context-based "preview override" channel. Concrete API to be chosen at implementation time; the slip panel's contract is just `onPreviewSeek`.

## XMEML Generator Changes

File: `server/services/xmeml-generator.js`

For each b-roll placement:

```js
const sourceInFrames = Math.round((edits.source_in_seconds || 0) * sourceFrameRate)
const tcOffset = embeddedTcFrames + elstOffsetFrames

const effectiveDurationSeconds = (edits.keep_original_duration === true)
  ? edits.original_timeline_duration || timelineDuration
  : Math.min(timelineDuration, sourceDurationSeconds - (edits.source_in_seconds || 0))

const durationFrames = Math.round(effectiveDurationSeconds * sourceFrameRate)

const inFrame  = tcOffset + sourceInFrames
const outFrame = inFrame + durationFrames
```

Edge cases:
- If `keep_original_duration === true` and the resulting `outFrame > tcOffset + (sourceDurationSeconds * sourceFrameRate)`, emit a warning into the export log: "Placement <id> source ends before placement; DaVinci will go black for X.YYs". XML still emits the user-requested `<out>` value verbatim.
- If `source_in_seconds === 0` and no probe data is present (manifest-only export), behavior is unchanged from today.

Also update the timeline `<end>` value when clamped: `<end> = <start> + (effectiveDurationSeconds * sequenceFrameRate)`. This shrinks the slot on the master timeline to match the now-shorter clip.

## Visual Indicators on the Timeline

Two new badges on the b-roll placement bar:

- **Auto-clamp clock icon:** small 12×12 clock glyph in the top-right corner of the bar when `auto_clamp_applied = true`.
- **Slipped indicator:** small 12×12 arrow-shift glyph when `source_in_seconds > 0`.

Both are tooltips with the relevant numbers: "Auto-clamped from 7.0s to 6.17s" / "Slipped to 1.5s into source".

## Telemetry

Add these events to `extension/config.js` TELEMETRY_EVENT_ENUM (mirrored in `server/services/exports.js`):

- `slip_panel_opened` — `{ placement_id, source_duration_s }`
- `slip_committed` — `{ placement_id, source_in_seconds, slipped_by_s }`
- `keep_original_toggled` — `{ placement_id, new_value }`
- `auto_clamp_applied` — `{ placement_id, original_duration_s, clamped_duration_s }`

These all require `export_id` per the existing telemetry contract.

## Testing Plan

### Unit tests (vitest)

`useBRollEditorState` reducer:
- `PROBE_DATA_RECEIVED` with `sourceDur < timelineDuration` clamps and sets `auto_clamp_applied`.
- `PROBE_DATA_RECEIVED` with `sourceDur >= timelineDuration` no-op on duration; only sets probe data.
- `PROBE_DATA_RECEIVED` when `keep_original_duration === true` does not clamp.
- `TOGGLE_KEEP_ORIGINAL(true)` after a clamp restores `original_timeline_duration`.
- `TOGGLE_KEEP_ORIGINAL(false)` after restore re-clamps.
- `SLIP_PLACEMENT` writes `source_in_seconds` clamped to `[0, sourceDur - timelineDuration]`.

`xmeml-generator`:
- Placement with `source_in_seconds = 1.5`, sourceFps = 29.97 emits `<in>` = `tcOffset + 45` (1.5 * 29.97 rounded).
- Placement with `keep_original_duration = true` and source shorter than duration emits `<out>` past source end and a warning entry is recorded.
- Placement with clamp and slip together: `source_in = 1.0, timelineDuration = 5.0, sourceDur = 6.0` → `<out> - <in> = 5.0 * sourceFps`.

### Integration tests

- Probe data arriving via the extension's snapshot triggers Pass 4 and updates the placement's display in the editor.
- Saving editor state persists `source_in_seconds`, `keep_original_duration`, and `original_timeline_duration` to the DB; reloading restores them.

### Manual smokes

1. Export a project with a known-short source (Pexels clip with `duration < placement_duration`). Open in DaVinci, confirm clip plays for the clamped duration without going offline or black.
2. Open slip panel on a long-source placement. Drag the green window. Confirm preview seeks live and the saved `<in>` value reflects the slip.
3. Toggle "Keep original duration" on a clamped placement. Confirm `timelineDuration` restores and overflow stripe appears in the panel.
4. Open slip panel on a placement where source is exactly equal to placement duration. Confirm window cannot slip (or slip range is `[0, 0]`).
5. Verify the auto-clamp clock icon and slip indicator appear on the appropriate placements.

## Migration / Backfill

Existing placements have no `edits.source_in_seconds` / `keep_original_duration` — treated as defaults (0 / false). No DB migration required since `edits` is a JSON blob.

On first load of an export created before this feature: probe data may have already been merged, but no `original_timeline_duration` was recorded. Pass 4 should still run on next probe-data refresh / first edit-action, OR run a one-time "first open" normalization that captures `original_timeline_duration` for the current `timelineDuration` and applies clamp if needed.

## Open Questions

None blocking — all decisions resolved above. Items deferred to implementation:

- Concrete API for the main-preview "override" channel: imperative ref on the preview component, or a React context. Either is acceptable; pick whichever fits the existing preview's structure.
- Exact icon SVGs for the clock and slip badges.

Committed decisions (not deferred):

- The slip panel includes a **"Reset" button** that sets `source_in_seconds = 0` for the current placement. Does not affect `keep_original_duration`.
