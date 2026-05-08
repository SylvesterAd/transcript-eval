import crypto from 'node:crypto'
import { postCutTime } from './time-translation.js'
import { parseTimecode } from './placement-match.js'

const isInCut = (t, effectiveCuts) =>
  effectiveCuts.some(c => t >= c.start && t < c.end)

/**
 * Materialize a per-placement remap from anchor + effective cuts.
 *
 * Pure function — no DB, no I/O. Caller is responsible for computing
 * `effectiveCuts` (via computeEffectiveCuts in broll.js) and providing the
 * raw transcript `words` ([{word,start,end}, ...]).
 *
 * Returns Map<uuid, { start_seconds, end_seconds, anchor_state }>.
 *
 * `anchor_state`: 'idx' | 'fuzzy' | 'in_cut' | 'orphaned' | 'overlap_squeezed'.
 */
export function materializePlacementRemap(placements, effectiveCuts, words) {
  const out = new Map()
  for (const p of placements) {
    if (!p.uuid) continue

    let anchorOriginal = null
    let state = null

    if (typeof p.anchor_word_idx === 'number' && p.anchor_word_idx >= 0) {
      const w = words[p.anchor_word_idx]
      if (!w) {
        state = 'orphaned'
      } else if (isInCut(w.start, effectiveCuts)) {
        state = 'in_cut'
      } else {
        anchorOriginal = w.start
        state = 'idx'
      }
    }

    if (anchorOriginal == null && state === null) {
      // No idx attached at all — leave for fuzzy fallback (Task 4).
      state = 'orphaned'
    }

    let startSec, endSec
    if (anchorOriginal != null) {
      startSec = postCutTime(anchorOriginal, effectiveCuts)
      const origDur = parseTimecode(p.end) - parseTimecode(p.start)
      endSec = startSec + (origDur > 0 ? origDur : 0.5)
    } else {
      // Fall back to LLM-emitted post-cut times (already shifted by persist).
      startSec = parseTimecode(p.start)
      endSec = parseTimecode(p.end)
    }

    out.set(p.uuid, { start_seconds: startSec, end_seconds: endSec, anchor_state: state })
  }
  return out
}

/**
 * Stable hash of (cuts, exclusions). Reorderings produce the same hash;
 * any change to start/end times or exclusion content produces a different
 * hash. Cut ids are ignored — only timing matters for the remap result.
 */
export function cutsHash(cuts, exclusions) {
  const norm = (arr) => (arr || []).slice()
    .sort((a, b) => (a.start - b.start) || (a.end - b.end))
    .map(c => [c.start, c.end])
  const payload = JSON.stringify({ cuts: norm(cuts), exclusions: norm(exclusions) })
  return crypto.createHash('sha1').update(payload).digest('hex')
}
