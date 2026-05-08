/**
 * Time translation between original-time and post-cut time.
 *
 * `effectiveCuts` MUST be sorted, non-overlapping, in original-time
 * coordinates (the output of computeEffectiveCuts in broll.js).
 */

/**
 * Forward direction: original-time → post-cut.
 *
 * If `tOrig` lands inside a cut, returns the post-cut position of the
 * next kept word — i.e., `cut.start` mapped into the post-cut domain.
 * (The interior of a cut has no representation in post-cut time, so we
 * collapse to the start of the next kept span.)
 */
export function postCutTime(tOrig, effectiveCuts) {
  if (!effectiveCuts || !effectiveCuts.length) return tOrig
  let cumOffset = 0
  for (const c of effectiveCuts) {
    if (tOrig < c.start) return tOrig - cumOffset
    if (tOrig >= c.start && tOrig < c.end) return c.start - cumOffset
    cumOffset += c.end - c.start
  }
  return tOrig - cumOffset
}

/**
 * Inverse: post-cut → original. Used by the export path (XMEML
 * translation) to map placement timecodes back to original time.
 *
 * `kind` controls the boundary rule when `tPost` lands EXACTLY on a cut
 * boundary in post-cut time:
 *   - 'start' (default): tPost == boundary jumps PAST the cut → returns cut.end.
 *     Use this for placement.start_seconds — semantically "begin at the
 *     frame that appears right after the FFmpeg concat join".
 *   - 'end': tPost == boundary stays BEFORE the cut → returns cut.start.
 *     Use this for placement.end_seconds — semantically "end at the
 *     last frame before the join".
 *
 * In practice LLMs emit whole seconds and cuts get edge-refined to
 * non-integer boundaries, so this rule rarely fires. It exists to
 * prevent a silent failure mode if it ever does.
 */
export function unshiftPostCutTime(tPost, effectiveCuts, kind = 'start') {
  if (!effectiveCuts || effectiveCuts.length === 0) return tPost
  let cumOffset = 0
  for (const c of effectiveCuts) {
    const boundary = c.start - cumOffset
    const beforeBoundary = kind === 'end' ? tPost <= boundary : tPost < boundary
    if (beforeBoundary) return tPost + cumOffset
    cumOffset += c.end - c.start
  }
  return tPost + cumOffset
}
