// Derive deletion cuts from annotations_json server-side.
//
// Mirrors the frontend's TranscriptEditor.jsx annotation→cuts conversion,
// minus the waveform-dependent edge refinement (which we don't have access
// to server-side). When `words` are provided, we additionally bridge
// adjacent annotation regions (when no uncut word lies in the gap) and
// extend each region's edges to the nearest uncut word — producing the
// SAME cut shape the frontend would generate. This eliminates the
// dual-cut-set bug where editor_state_json contained both tight
// `cut-ann-server-` cuts AND extended `cut-ai-ann-` cuts simultaneously.
//
// Steps performed (order matches TranscriptEditor.jsx):
//   1. Filter annotations to type='deletion' for cuttable categories.
//   2. Sort by startTime, merge overlapping regions.
//   3. Subtract cutExclusions if present (split regions around "keep" zones).
//   4. (when words present) Bridge adjacent regions when no uncut word in gap.
//   5. (when words present) Extend each region back to prev uncut word's end
//        and forward to next uncut word's start, never crossing exclusions.
//
// NOT performed (frontend-only):
//   - Unsafe-filler filtering (waveform 3-bar silence rule).
//   - Head/tail trim to timeline edges.

import db from '../db.js'

const CUTTABLE_CATEGORIES = ['false_starts', 'filler_words', 'meta_commentary']

/**
 * Convert annotations + cutExclusions (+ optional words) into a cut array.
 * Each output cut has {id, start, end, source: 'annotation'}.
 *
 * Pure function — no DB access. Exported for tests.
 *
 * @param {object} annotations - {items: [...]} from annotations_json.
 * @param {Array}  cutExclusions - [{start, end}, ...] right-click "keep" zones.
 * @param {Array|null} words - [{word, start, end}, ...] from word_timestamps_json.
 *   When null/undefined, skips bridging + extension and produces tight cuts.
 */
export function deriveCutsFromAnnotations(annotations, cutExclusions = [], words = null) {
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
  let merged = [{ ...regions[0] }]
  for (let i = 1; i < regions.length; i++) {
    const last = merged[merged.length - 1]
    if (regions[i].start <= last.end) last.end = Math.max(last.end, regions[i].end)
    else merged.push({ ...regions[i] })
  }

  // Step 3: subtract cutExclusions (the user's right-click "keep this word"
  // list). MUST happen BEFORE bridging + extension to match
  // TranscriptEditor.jsx ordering — splitting a partially-overlapping
  // exclusion first prevents bridge/extend from later producing fragments
  // the frontend wouldn't.
  if (cutExclusions?.length) {
    const sortedEx = [...cutExclusions].sort((a, b) => a.start - b.start)
    const split = []
    for (const region of merged) {
      let cur = { ...region }
      for (const ex of sortedEx) {
        if (ex.start >= cur.end || ex.end <= cur.start) continue
        if (cur.start < ex.start - 0.01) {
          split.push({ start: cur.start, end: ex.start })
        }
        cur.start = ex.end
      }
      if (cur.start < cur.end - 0.01) split.push(cur)
    }
    merged = split
  }

  // Step 4: Bridge adjacent annotation regions when no uncut word lies in
  // their gap. Mirrors TranscriptEditor.jsx — prevents fragmented cuts where
  // two annotations are separated by silence (no transcribed words) which the
  // user would expect to be one continuous cut.
  if (words?.length && merged.length > 1) {
    // "Annotation regions" for coverage check are the raw merged regions
    // (before bridging) — matches frontend's annotationRegions semantics.
    const annotationRegions = merged
    const bridged = [{ ...merged[0] }]
    for (let i = 1; i < merged.length; i++) {
      const last = bridged[bridged.length - 1]
      const gapStart = last.end
      const gapEnd = merged[i].start

      // Don't bridge if exclusion zone crosses the gap.
      const exclusionCrosses = (cutExclusions || []).some(ex => ex.start < gapEnd && ex.end > gapStart)
      if (exclusionCrosses) {
        bridged.push({ ...merged[i] })
        continue
      }

      // Has any uncut word in the gap? "Uncut" = not covered by any annotation
      // region (with 0.05s tolerance — matches frontend).
      const hasUncutWordInGap = words.some(w => {
        const wEnd = Math.max(w.end, w.start + 0.01)
        if (w.start < gapStart || wEnd > gapEnd) return false
        const isCoveredByAnn = annotationRegions.some(r => w.start >= r.start - 0.05 && wEnd <= r.end + 0.05)
        return !isCoveredByAnn
      })
      if (!hasUncutWordInGap) {
        last.end = merged[i].end
      } else {
        bridged.push({ ...merged[i] })
      }
    }
    merged = bridged
  }

  // Step 5: Extend each region's edges to the nearest uncut word, never
  // crossing exclusion zones. Mirrors TranscriptEditor.jsx — produces the same
  // cut shape the frontend would generate, eliminating the dual-cut-set bug.
  if (words?.length) {
    // SNAPSHOT pre-extension bounds. The frontend uses an unmutated
    // `annotationRegions` reference (from a useMemo above the extend loop),
    // so region[0]'s edge extension does NOT change the membership-check
    // input for region[1]'s extension. We MUST do the same — aliasing
    // `merged` directly here would make region[0]'s end-extension widen
    // the coverage window seen during region[1]'s reverse scan, producing
    // different "is this word covered" answers in narrow tolerance cases.
    // Do not "optimize" this back to `const annotationRegions = merged`.
    const annotationRegions = merged.map(r => ({ start: r.start, end: r.end }))
    for (const region of merged) {
      // Extend end forward: stretch to next uncut word's start.
      const nextUncutWord = words.find(w => w.start >= region.end - 0.01 &&
        !annotationRegions.some(r => w.start >= r.start - 0.05 && w.end <= r.end + 0.05))
      if (nextUncutWord) {
        const hasUncutBetween = words.some(w => {
          if (w === nextUncutWord) return false
          const wEnd = Math.max(w.end, w.start + 0.01)
          return w.start >= region.end - 0.01 && wEnd <= nextUncutWord.start + 0.01 &&
            !annotationRegions.some(r => w.start >= r.start - 0.05 && wEnd <= r.end + 0.05)
        })
        if (!hasUncutBetween) {
          let newEnd = nextUncutWord.start
          for (const ex of (cutExclusions || [])) {
            if (ex.start > region.end - 0.01 && ex.start < newEnd) newEnd = Math.min(newEnd, ex.start)
          }
          region.end = newEnd
        }
      }
      // Extend start backward: stretch to prev uncut word's end.
      const prevUncutWord = [...words].reverse().find(w => w.end <= region.start + 0.01 &&
        !annotationRegions.some(r => w.start >= r.start - 0.05 && w.end <= r.end + 0.05))
      if (prevUncutWord) {
        let newStart = prevUncutWord.end
        for (const ex of (cutExclusions || [])) {
          if (ex.end < region.start + 0.01 && ex.end > newStart) newStart = Math.max(newStart, ex.end)
        }
        region.start = Math.max(newStart, prevUncutWord.end)
      }
    }
  }

  return merged.map((r, i) => ({
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

  // Load words for the group's main raw video, so deriveCutsFromAnnotations
  // can produce the extended cut shape the frontend generates (bridging +
  // edge extension). If no words available, falls back to tight cuts.
  let words = null
  try {
    const mainVideo = await db.prepare(
      "SELECT id FROM videos WHERE group_id = ? AND video_type = 'raw' LIMIT 1"
    ).get(groupId)
    if (mainVideo) {
      const t = await db.prepare(
        "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw' LIMIT 1"
      ).get(mainVideo.id)
      if (t?.word_timestamps_json) {
        const parsed = typeof t.word_timestamps_json === 'string'
          ? JSON.parse(t.word_timestamps_json)
          : t.word_timestamps_json
        words = Array.isArray(parsed) ? parsed : null
      }
    }
  } catch (err) {
    console.warn(`[ensureEditorCutsFromAnnotations] failed to load words for group ${groupId}:`, err.message)
  }

  const existingCuts = editorState.cuts || []
  const existingExclusions = editorState.cutExclusions || []

  // Preserve manual cuts (source !== 'annotation'). Replace annotation-derived cuts.
  const manualCuts = existingCuts.filter(c => c.source !== 'annotation')
  const derivedAnnCuts = deriveCutsFromAnnotations(annotations, existingExclusions, words)

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
