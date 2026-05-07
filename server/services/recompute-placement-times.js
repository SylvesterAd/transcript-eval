import { computeEffectiveCuts } from './broll.js'
import { postCutTime } from './time-translation.js'

/**
 * Recompute post-cut start_seconds/end_seconds for each placement using its
 * anchor_word_idx + the new cut set. Preserves duration. Flags orphaned and
 * anchor_in_cut placements for UI display.
 *
 * @param {Array} placements
 * @param {Array<{start:number,end:number}>} cuts raw cuts from editor_state_json
 * @param {Array<{start:number,end:number}>} exclusions cutExclusions from editor_state_json
 * @param {Array<{word:string,start:number,end:number}>} words raw transcript word_timestamps
 * @returns {Array} new placements with updated start_seconds/end_seconds
 */
export function recomputePlacementsForCuts(placements, cuts, exclusions, words) {
  const effective = computeEffectiveCuts(cuts || [], exclusions || [])
  return placements.map(p => {
    const next = { ...p }
    delete next.anchor_orphaned
    delete next.anchor_in_cut
    if (p.anchor_word_idx == null || p.anchor_word_idx < 0) {
      next.anchor_orphaned = true
      return next
    }
    const w = words[p.anchor_word_idx]
    if (!w) {
      next.anchor_orphaned = true
      return next
    }
    const inCut = effective.some(c => w.start >= c.start && w.start < c.end)
    if (inCut) next.anchor_in_cut = true
    const duration = (p.end_seconds ?? 0) - (p.start_seconds ?? 0)
    const newStart = postCutTime(w.start, effective)
    next.start_seconds = newStart
    next.end_seconds = newStart + duration
    return next
  })
}
