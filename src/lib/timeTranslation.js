/**
 * Client-side time translation between original-time (where the raw video
 * actually plays) and post-cut time (where the user sees content on the
 * b-roll editor's collapsed-cuts timeline).
 *
 * Mirror of server/services/time-translation.js — kept as a separate file
 * to avoid coupling the React bundle to the server module path.
 *
 * Both functions assume `effectiveCuts` is sorted by `start` and
 * non-overlapping (the same precondition the server uses).
 */

/**
 * Forward: original-time → post-cut.
 * If t lands inside a cut, returns the post-cut position of cut.start
 * (i.e., the start of the next kept span after the cut, in post-cut domain).
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
 * Inverse: post-cut → original-time. Used when interpreting a post-cut
 * timecode (e.g., a placement's stored start_seconds) for purposes that
 * need the corresponding original-time position (e.g., XMEML export).
 *
 * `kind` controls boundary semantics:
 *   - 'start' (default): tPost == boundary jumps PAST cut → returns cut.end.
 *   - 'end': tPost == boundary stays BEFORE cut → returns cut.start.
 */
export function unshiftPostCutTime(tPost, effectiveCuts, kind = 'start') {
  if (!effectiveCuts || !effectiveCuts.length) return tPost
  let cumOffset = 0
  for (const c of effectiveCuts) {
    const boundary = c.start - cumOffset
    const beforeBoundary = kind === 'end' ? tPost <= boundary : tPost < boundary
    if (beforeBoundary) return tPost + cumOffset
    cumOffset += c.end - c.start
  }
  return tPost + cumOffset
}
