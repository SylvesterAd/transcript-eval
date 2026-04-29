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
import { getExportResult } from '../services/exports.js'
import { generateXmeml } from '../services/xmeml-generator.js'

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
        width: Number.isFinite(a.width) ? a.width : null,
        height: Number.isFinite(a.height) ? a.height : null,
        // A-roll's source duration (when known) — feeds <file><duration>.
        // Falls back to the timeline span inside the generator.
        sourceDurationSeconds: Number.isFinite(a.sourceDurationSeconds) ? a.sourceDurationSeconds : null,
      }
    }

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
      const brollPlacements = allPlacements.filter((p) => !p || (p.source !== 'aroll' && p.seq !== 0))
      xml_by_variant[label] = generateXmeml({
        sequenceName: v.sequenceName || `Variant ${label}`,
        placements: brollPlacements,
        aroll,
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
