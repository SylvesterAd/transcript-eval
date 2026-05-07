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

/**
 * Compute kept segments + total post-cut width for a single track, in
 * track-local coordinates (relative to track.offset).
 *
 * Used by VideoFrameTrack / AudioTrack / TranscriptTrack to render only the
 * portions of their content that survive the cuts, positioned at post-cut
 * local x. Cuts are passed in global (track-shared) original-time space and
 * translated into the track's local origin here.
 *
 * @param {number} trackOffset - track.offset in seconds (global original-time)
 * @param {number} trackDuration - track.duration in seconds
 * @param {Array<{start:number,end:number}>} effectiveCuts - cuts in global original-time
 * @param {number} pxPerSecond - same scale used by the rest of the timeline
 * @returns {{segments: Array, postCutDuration: number, width: number}}
 */
export function getTrackPostCutLayout(trackOffset, trackDuration, effectiveCuts, pxPerSecond) {
  const localCuts = (effectiveCuts || [])
    .map(c => ({
      start: Math.max(0, c.start - trackOffset),
      end: Math.min(trackDuration, c.end - trackOffset),
    }))
    .filter(c => c.end > c.start + 0.001)
    .sort((a, b) => a.start - b.start)

  const segments = []
  let cursorOrig = 0
  let cursorPost = 0
  for (const c of localCuts) {
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
    cursorOrig = c.end
  }
  if (cursorOrig < trackDuration) {
    const segLen = trackDuration - cursorOrig
    segments.push({
      origStart: cursorOrig,
      origEnd: trackDuration,
      postStart: cursorPost,
      postEnd: cursorPost + segLen,
      x: cursorPost * pxPerSecond,
      w: segLen * pxPerSecond,
    })
    cursorPost += segLen
  }

  return {
    segments,
    postCutDuration: cursorPost,
    width: cursorPost * pxPerSecond,
  }
}
