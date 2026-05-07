/**
 * Compute the post-cut timeline layout for the b-roll editor.
 *
 * Given the original (raw) video duration, an array of effective cuts (in
 * original time, sorted by start), and the timeline's pixel width, return:
 *
 * - segments: array of kept segments with their original time range, post-cut
 *   time range, and pixel x/w on the timeline.
 * - cutBars: array of cut markers with their pixel x position and original
 *   time range (so the side panel can show the removed content).
 * - postCutDuration: total post-cut duration in seconds.
 * - pxPerSecond: pixels per post-cut second.
 *
 * Zero-width cuts (razor markers, c.end <= c.start) are filtered out.
 * Cuts can be passed unsorted; this function sorts them internally.
 *
 * Edge case: if originalDuration is 0 or negative, postCutDuration is clamped
 * to a small positive value to avoid divide-by-zero in pxPerSecond. The
 * returned layout will be degenerate but won't crash callers.
 */
export function layoutPostCut(originalDuration, effectiveCuts, timelineWidthPx) {
  const cuts = (effectiveCuts || [])
    .filter(c => c && c.end > c.start + 0.001)  // filter zero-width
    .map(c => ({ start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start)

  const totalCutDuration = cuts.reduce((s, c) => s + (c.end - c.start), 0)
  const postCutDuration = Math.max(0.001, originalDuration - totalCutDuration)
  const pxPerSecond = timelineWidthPx / postCutDuration

  const segments = []
  const cutBars = []
  let cursorOrig = 0
  let cursorPost = 0

  for (const c of cuts) {
    if (c.start > cursorOrig) {
      const segLen = c.start - cursorOrig
      segments.push({
        origStart: cursorOrig,
        origEnd: c.start,
        postStart: cursorPost,
        postEnd: cursorPost + segLen,
        x: cursorPost * pxPerSecond,
        w: segLen * pxPerSecond,
      })
      cursorPost += segLen
    }
    cutBars.push({
      x: cursorPost * pxPerSecond,
      origStart: c.start,
      origEnd: c.end,
      cutDuration: c.end - c.start,
    })
    cursorOrig = c.end
  }

  if (cursorOrig < originalDuration) {
    const segLen = originalDuration - cursorOrig
    segments.push({
      origStart: cursorOrig,
      origEnd: originalDuration,
      postStart: cursorPost,
      postEnd: cursorPost + segLen,
      x: cursorPost * pxPerSecond,
      w: segLen * pxPerSecond,
    })
  }

  return { segments, cutBars, postCutDuration, pxPerSecond }
}
