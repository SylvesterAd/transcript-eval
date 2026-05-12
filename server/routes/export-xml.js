// POST /api/exports/:id/generate-xml
//
// Called by the transcript-eval web app AFTER the Chrome extension
// signals export completion (i.e. after Phase 1's `export_completed`
// telemetry event has landed and updated exports.result_json).
//
// Auth: Bearer JWT via requireAuth (reuses Supabase JWT). The export
// must belong to req.auth.userId, else 404 (missing-vs-not-owned
// collapsed to prevent enumeration).
//
// Request body: { variants: ["A", "C", ...] }  — subset of labels the
// user opted into. Each must match a label in the export's result_json.
//
// Response: { xml_by_variant: { "A": "<?xml ...?>...", "C": "..." } }
//
// Error shape: { error: <string>, detail?: <string> } with HTTP codes:
//   400 — bad input (variants missing/non-array, unknown labels)
//   401 — missing/invalid JWT (from requireAuth)
//   404 — export not found, not owned, or result_json not populated
//   500 — generator threw (unexpected; surfaces as JSON)

import { Router } from 'express'
import { requireAuth } from '../auth.js'
import db from '../db.js'
import { getExportResult } from '../services/exports.js'
import { generateXmeml } from '../services/xmeml-generator.js'
import { computeEffectiveCuts } from '../services/broll.js'
import { unshiftPostCutTime } from '../services/time-translation.js'

/**
 * Given a sorted, non-overlapping cuts array (output of computeEffectiveCuts)
 * and a total duration, return the COMPLEMENT — the list of kept segments
 * that span [0, totalDuration]. Each segment is {start, end} in seconds.
 *
 * Used by the export route to convert cuts → arollSegments for XMEML.
 *
 * Examples:
 *   complementSegments([], 60) → [{start: 0, end: 60}]              // no cuts
 *   complementSegments([{start: 20, end: 30}], 60)
 *     → [{start: 0, end: 20}, {start: 30, end: 60}]                 // single cut splits
 *   complementSegments([{start: 0, end: 10}], 60)
 *     → [{start: 10, end: 60}]                                       // cut at start
 *   complementSegments([{start: 50, end: 60}], 60)
 *     → [{start: 0, end: 50}]                                        // cut at end
 */
function complementSegments(cutsArr, totalDuration) {
  const segs = []
  let cursor = 0
  for (const c of cutsArr) {
    if (c.start > cursor + 0.001) segs.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < totalDuration - 0.001) segs.push({ start: cursor, end: totalDuration })
  return segs
}

/**
 * Pick the cuts that should drive a-roll segmentation in the XMEML export.
 *
 * Mirrors the source filter applied by:
 *   - src/components/editor/Timeline.jsx (userCuts useMemo)
 *   - src/components/editor/useBRollEditorState.js (effectiveCutsForTrigger)
 *   - server/services/broll.js (getBRollEditorData, line ~6161)
 *
 * Annotation-source cuts are LLM suggestions that don't ripple-delete
 * anything in the rough-cut timeline or in /brolls/edit — they're
 * visual highlights only, written to state.cuts by the orchestrator's
 * ensureEditorCutsFromAnnotations so b-roll search has context, not as
 * user-applied cuts. The NLE export must use the SAME cut topology
 * those views show, otherwise the exported a-roll's first kept clip
 * lands seconds later than what the user sees in /editor/:id/roughcut.
 *
 * Exported for direct unit testing — the route also calls it inline.
 *
 * @param {Array} cuts - raw editor_state_json.cuts
 * @returns {Array} cuts with `source === 'annotation'` removed
 */
export function selectExportCuts(cuts) {
  if (!Array.isArray(cuts)) return []
  return cuts.filter(c => c && c.source !== 'annotation')
}

/**
 * Translate b-roll placement timeline times from post-cut canonical
 * (Task 4) back to original-time before handing them to generateXmeml.
 *
 * NLEs (Premiere/Resolve/FCP) consume original-time of the source
 * media — their imported sequence places clipitems at sequence-timeline
 * coordinates that match the user's source video on the timeline (which
 * is the original, uncut video). Our placements are stored in post-cut
 * coordinates after Task 4. This function applies unshiftPostCutTime to
 * each placement's timelineStart (kind='start') and the implied end
 * (timelineStart + timelineDuration, kind='end'), then derives a new
 * timelineDuration from the original-time pair.
 *
 * Notes:
 *   - When effectiveCuts is empty/identity, returns the input array
 *     unchanged (cheap reference identity, not a copy).
 *   - Placements without finite timelineStart or timelineDuration are
 *     passed through untouched — generateXmeml's own validation will
 *     surface a helpful error.
 *   - When a cut lies INSIDE the placement's original-time span, the
 *     resulting duration is longer than the post-cut duration — this
 *     is correct: the b-roll lays continuously over the timeline,
 *     including any cut region (the user can re-trim in their NLE).
 *
 * Exported for direct unit testing; the route also calls it inline.
 */
export function translatePlacementsForExport(placements, effectiveCuts) {
  if (!Array.isArray(placements)) return placements
  if (!effectiveCuts || effectiveCuts.length === 0) return placements
  return placements.map(p => {
    if (!p || typeof p !== 'object') return p
    const startPost = p.timelineStart
    const durPost = p.timelineDuration
    if (!Number.isFinite(startPost) || !Number.isFinite(durPost)) return p
    const startOrig = unshiftPostCutTime(startPost, effectiveCuts, 'start')
    const endOrig = unshiftPostCutTime(startPost + durPost, effectiveCuts, 'end')
    return { ...p, timelineStart: startOrig, timelineDuration: endOrig - startOrig }
  })
}

const router = Router()

router.post('/:id/generate-xml', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth?.userId
    if (!userId) {
      // requireAuth should have already 401'd, but defense in depth.
      return res.status(401).json({ error: 'Authentication required' })
    }

    const { id } = req.params
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'export id required' })
    }

    const { variants, target_folder_absolute } = req.body || {}
    if (!Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({ error: 'variants must be a non-empty array of labels' })
    }
    if (!variants.every((v) => typeof v === 'string' && v)) {
      return res.status(400).json({ error: 'each variant must be a non-empty string' })
    }
    // Optional. The web app forwards complete.folder_path_absolute (the
    // OS-resolved download folder reported by the extension) so we can
    // emit absolute file:// URLs in <pathurl>. When missing or invalid,
    // the generator falls back to bare filenames — Premiere relinks
    // those via Match File Properties → File Name in the XML's folder.
    const mediaFolderAbsolute =
      typeof target_folder_absolute === 'string' && target_folder_absolute.startsWith('/')
        ? target_folder_absolute
        : null

    // Fetch + owner-check. getExportResult collapses missing/not-owned to
    // null, so from here on we can 404 uniformly.
    const result = await getExportResult(id, { userId })
    if (!result) {
      return res.status(404).json({ error: 'export not found or not ready' })
    }

    // Load editor_state_json for cut-aware A-roll segmentation.
    // The export's plan_pipeline_id encodes the videoId as 'plan-<videoId>-...'.
    // From videoId we reach video_groups.editor_state_json which holds cuts/cutExclusions.
    // If the chain fails at any step (legacy pipeline IDs, missing rows) we fall through
    // gracefully — editorCuts stays [] and the legacy aroll single-clip path is used.
    let editorCuts = []
    let editorCutExclusions = []
    let editorWords = null
    try {
      const exportRow = await db.prepare(
        'SELECT plan_pipeline_id FROM exports WHERE id = ?'
      ).get(id)
      const planPipelineId = exportRow?.plan_pipeline_id || ''
      const planMatch = planPipelineId.match(/^plan-(\d+)-/)
      if (planMatch) {
        const videoId = parseInt(planMatch[1], 10)
        const vRow = await db.prepare(
          'SELECT group_id FROM videos WHERE id = ?'
        ).get(videoId)
        const groupId = vRow?.group_id || null
        if (groupId) {
          const gRow = await db.prepare(
            'SELECT editor_state_json FROM video_groups WHERE id = ?'
          ).get(groupId)
          if (gRow?.editor_state_json) {
            const editorState = typeof gRow.editor_state_json === 'string'
              ? JSON.parse(gRow.editor_state_json)
              : gRow.editor_state_json
            // Strip annotation-source cuts before computing kept segments —
            // those are LLM suggestions, not user-applied cuts. See
            // selectExportCuts above for the full rationale and the three
            // other call sites that apply the same filter.
            editorCuts = selectExportCuts(editorState.cuts)
            editorCutExclusions = editorState.cutExclusions || []
          }
        }
        // Raw transcript words drive the word-aware cut merge in
        // computeEffectiveCuts: two cuts separated by a word-less gap merge
        // into one. /brolls/edit and the rough cut UI already pass words
        // (see server/services/broll.js getBRollEditorData ~line 6171 and
        // src/components/editor/useBRollEditorState.js effectiveCutsForTrigger);
        // without it here, the export produces tiny "kept" slivers between
        // cuts that the editor views never show.
        const tRow = await db.prepare(
          "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'"
        ).get(videoId)
        if (tRow?.word_timestamps_json) {
          try {
            const parsed = JSON.parse(tRow.word_timestamps_json)
            if (Array.isArray(parsed) && parsed.length > 0) editorWords = parsed
          } catch { /* malformed JSON: fall through to non-word-aware merge */ }
        }
      }
    } catch (cutLoadErr) {
      // Non-fatal: cut/word loading failed, fall back to legacy single-clip A-roll.
      console.warn('[export-xml] editor cut load failed; using legacy aroll:', cutLoadErr.message)
    }

    // Index variants by label for O(1) lookup; reject any requested
    // variant the export doesn't carry.
    const byLabel = new Map(result.variants.map((v) => [v.label, v]))
    const unknown = variants.filter((v) => !byLabel.has(v))
    if (unknown.length > 0) {
      return res.status(400).json({
        error: 'unknown variant label(s)',
        detail: unknown.join(','),
      })
    }

    // A-roll lookup: result_json for the export carries each placement's
    // source/sourceItemId/filename. The A-roll, when present, was
    // injected into the manifest with seq=0 + source='aroll' by the
    // manifest endpoint at /api/broll-searches/:pipelineId/manifest.
    // Pull it out here so we can hand the V1 track to generateXmeml.
    function pickAroll(placements) {
      if (!Array.isArray(placements)) return null
      const a = placements.find((p) => p && (p.source === 'aroll' || p.seq === 0))
      if (!a) return null
      return {
        filename: a.filename || `aroll.mp4`,
        frameRate: Number.isFinite(a.sourceFrameRate) ? a.sourceFrameRate : null,
        ntsc: a.ntsc === true,
        width: Number.isFinite(a.width) ? a.width : null,
        height: Number.isFinite(a.height) ? a.height : null,
        // A-roll's source duration (when known) — feeds <file><duration>.
        // Falls back to the timeline span inside the generator.
        sourceDurationSeconds: Number.isFinite(a.sourceDurationSeconds) ? a.sourceDurationSeconds : null,
      }
    }

    // Hoist effective cuts once — both the arollSegments build below and
    // the b-roll placement translation use the same cut topology, and the
    // computation is per-group, not per-variant. Pass editorWords so the
    // word-aware merge collapses cuts that span word-less gaps; matches
    // /brolls/edit and the rough cut UI.
    const effectiveCuts = computeEffectiveCuts(editorCuts, editorCutExclusions, editorWords)

    // Generate per variant. Loop is sequential since each call is
    // CPU-bound microseconds of string concat — no benefit to Promise.all.
    const xml_by_variant = {}
    for (const label of variants) {
      const v = byLabel.get(label)
      const allPlacements = v.placements || []
      const aroll = pickAroll(allPlacements)
      // Strip the A-roll out of the b-roll placements list — it's emitted
      // separately on V1 by generateXmeml's `aroll` arg, not as a regular
      // b-roll clipitem.
      const brollPlacementsPostCut = allPlacements.filter((p) => !p || (p.source !== 'aroll' && p.seq !== 0))
      // Use post-cut canonical times directly — the editor (/brolls/edit)
      // shows ripple-deleted timeline (cuts collapsed); the NLE export
      // must match. Previous behavior translated to original-source time
      // via translatePlacementsForExport, which left every cut as a
      // visible gap in DaVinci/Premiere even though the editor view had
      // no gap. translatePlacementsForExport is kept exported for
      // historical consumers / tests that still want source-time layout.
      const brollPlacements = brollPlacementsPostCut

      // Build arollSegments from editor cuts when cuts are present.
      // If no cuts (empty array), pass null so generateXmeml uses the legacy
      // aroll single-clip path — preserves behaviour for projects without cuts.
      //
      // Each segment carries TWO coordinate systems:
      //   sourceStart/sourceEnd  — where in the original aroll file
      //                            (used for <in>/<out> = source slice)
      //   timelineStart/timelineEnd — ripple-deleted timeline position
      //                            (used for <start>/<end> on the timeline)
      // timelineStart = sourceStart minus the cumulative cut duration
      // that lies before sourceStart, so consecutive kept segments lay
      // contiguous on the NLE timeline with no gaps where cuts used to be.
      let arollSegments = null
      if (editorCuts.length > 0 && aroll) {
        const arollDurationSeconds = aroll.sourceDurationSeconds
        if (Number.isFinite(arollDurationSeconds) && arollDurationSeconds > 0) {
          const keptSegments = complementSegments(effectiveCuts, arollDurationSeconds)
          // Cumulative cut duration strictly BEFORE a given source-time.
          // Cuts are non-overlapping + sorted (computeEffectiveCuts contract).
          const cutsBefore = (sourceTime) => {
            let sum = 0
            for (const c of effectiveCuts) {
              if (c.end <= sourceTime) sum += (c.end - c.start)
              else break
            }
            return sum
          }
          arollSegments = keptSegments.map(s => {
            const offset = cutsBefore(s.start)
            return {
              filename: aroll.filename,
              sourceStart: s.start,
              sourceEnd: s.end,
              timelineStart: s.start - offset,
              timelineEnd: s.end - offset,
              sourceFrameRate: aroll.frameRate,
              ntsc: aroll.ntsc === true,
              sourceDurationSeconds: arollDurationSeconds,
              width: aroll.width,
              height: aroll.height,
            }
          })
        }
      }

      xml_by_variant[label] = generateXmeml({
        sequenceName: v.sequenceName || `Variant ${label}`,
        placements: brollPlacements,
        aroll,
        arollSegments,
        mediaFolderAbsolute,
        // frameRate + sequenceSize fall through to generator defaults;
        // future manifest fields could override here.
      })
    }

    res.json({ xml_by_variant })
  } catch (err) {
    // Unexpected (e.g. generator assertion fires on malformed
    // per-placement data). Log and surface a generic 500 — the
    // generator's own error messages already name the offending field.
    next(err)
  }
})

export default router
