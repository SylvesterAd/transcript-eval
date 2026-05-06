// Derive deletion cuts from annotations_json server-side.
//
// Mirrors the frontend's TranscriptEditor.jsx annotation→cuts conversion,
// minus the waveform-dependent edge refinement (which we don't have access
// to server-side). The simpler conversion is correct for the post-cut
// transcript filter, which only checks word-midpoint inclusion in cut
// regions; sub-100ms boundary differences don't change the kept-words set.
//
// Steps performed:
//   1. Filter annotations to type='deletion' for cuttable categories.
//   2. Sort by startTime, merge overlapping regions.
//   3. Subtract cutExclusions if present.
//
// NOT performed (frontend-only):
//   - Unsafe-filler filtering (waveform 3-bar silence rule).
//   - Adjacent-region bridging (depends on mergedWords).
//   - Head/tail trim to timeline edges.
//   - Edge extension to fill wordless gaps.

import db from '../db.js'

const CUTTABLE_CATEGORIES = ['false_starts', 'filler_words', 'meta_commentary']

/**
 * Convert annotations + cutExclusions into a cut array.
 * Each output cut has {id, start, end, source: 'annotation'}.
 *
 * Pure function — no DB access. Exported for tests.
 */
export function deriveCutsFromAnnotations(annotations, cutExclusions = []) {
  if (!annotations?.items?.length) return []

  // Step 1: collect deletion regions for cuttable categories.
  const regions = []
  for (const ann of annotations.items) {
    if (ann.type !== 'deletion') continue
    if (!CUTTABLE_CATEGORIES.includes(ann.category)) continue
    if (typeof ann.startTime !== 'number' || typeof ann.endTime !== 'number') continue
    if (ann.endTime <= ann.startTime) continue
    regions.push({ start: ann.startTime, end: ann.endTime })
  }
  if (!regions.length) return []

  // Step 2: sort + merge overlaps.
  regions.sort((a, b) => a.start - b.start)
  const merged = [{ ...regions[0] }]
  for (let i = 1; i < regions.length; i++) {
    const last = merged[merged.length - 1]
    if (regions[i].start <= last.end) last.end = Math.max(last.end, regions[i].end)
    else merged.push({ ...regions[i] })
  }

  // Step 3: subtract cutExclusions (the user's right-click "keep this word" list).
  let final = merged
  if (cutExclusions?.length) {
    const sortedEx = [...cutExclusions].sort((a, b) => a.start - b.start)
    final = []
    for (const region of merged) {
      let cur = { ...region }
      for (const ex of sortedEx) {
        if (ex.start >= cur.end || ex.end <= cur.start) continue
        if (cur.start < ex.start - 0.01) {
          final.push({ start: cur.start, end: ex.start })
        }
        cur.start = ex.end
      }
      if (cur.start < cur.end - 0.01) final.push(cur)
    }
  }

  return final.map((r, i) => ({
    id: `cut-ann-server-${i}`,
    start: r.start,
    end: r.end,
    source: 'annotation',
  }))
}

/**
 * Read the group's annotations_json + editor_state_json. Derive cuts
 * server-side. If the derived set differs from the existing editor_state_json.cuts,
 * write the new cuts (preserving manual cuts and other editor_state fields).
 *
 * Idempotent: re-running with no annotation changes is a no-op.
 *
 * Called from runFullAutoBrollChain at chain start so the chain reads
 * a populated cuts array.
 */
export async function ensureEditorCutsFromAnnotations(groupId) {
  if (!groupId) return { changed: false, reason: 'no_group_id' }

  const row = await db.prepare(
    'SELECT annotations_json, editor_state_json FROM video_groups WHERE id = ?'
  ).get(groupId)
  if (!row) return { changed: false, reason: 'group_not_found' }

  let annotations
  try {
    annotations = row.annotations_json
      ? (typeof row.annotations_json === 'string' ? JSON.parse(row.annotations_json) : row.annotations_json)
      : null
  } catch {
    return { changed: false, reason: 'annotations_unparseable' }
  }
  if (!annotations?.items?.length) return { changed: false, reason: 'no_annotations' }

  let editorState
  try {
    editorState = row.editor_state_json
      ? (typeof row.editor_state_json === 'string' ? JSON.parse(row.editor_state_json) : row.editor_state_json)
      : {}
  } catch {
    editorState = {}
  }

  const existingCuts = editorState.cuts || []
  const existingExclusions = editorState.cutExclusions || []

  // Preserve manual cuts (source !== 'annotation'). Replace annotation-derived cuts.
  const manualCuts = existingCuts.filter(c => c.source !== 'annotation')
  const derivedAnnCuts = deriveCutsFromAnnotations(annotations, existingExclusions)

  // Compare derived set against existing annotation cuts to decide if we
  // need to write. Compare by sorted (start, end) tuples — id is regenerated
  // each call so we can't compare ids directly.
  const existingAnnCuts = existingCuts.filter(c => c.source === 'annotation')
  const sameLen = existingAnnCuts.length === derivedAnnCuts.length
  const sameContent = sameLen && existingAnnCuts.every((c, i) => {
    return Math.abs(c.start - derivedAnnCuts[i].start) < 0.001 &&
           Math.abs(c.end - derivedAnnCuts[i].end) < 0.001
  })
  if (sameContent) return { changed: false, reason: 'already_in_sync', annCuts: existingAnnCuts.length }

  const newCuts = [...manualCuts, ...derivedAnnCuts]
  const newEditorState = { ...editorState, cuts: newCuts }

  await db.prepare(
    'UPDATE video_groups SET editor_state_json = ? WHERE id = ?'
  ).run(JSON.stringify(newEditorState), groupId)

  return {
    changed: true,
    reason: 'synced',
    derivedAnnCuts: derivedAnnCuts.length,
    preservedManualCuts: manualCuts.length,
  }
}
