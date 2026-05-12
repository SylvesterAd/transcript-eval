import { useMemo, useEffect } from 'react'

/**
 * Pure function: compute the effective skip regions from a cuts list and
 * cutExclusions list. Sorts and merges overlapping cuts, then subtracts
 * any excluded sub-regions.
 *
 * Used by:
 *   - usePlaybackSkipRegions (the hook below) — single-video case
 *   - BRollPreview (which manages multiple video refs) — direct call
 *
 * Both inputs in seconds. Output is a sorted, non-overlapping array of
 * {start, end} regions.
 *
 * Words-aware merge: when `words` is provided and the gap between two
 * adjacent cuts contains no transcript word (with a ±0.05s pad on each
 * side), the cuts are merged across the gap. This mirrors the predicate
 * already used by `EditorView.skipRegions` for rough-cut playback — it
 * prevents a ~0.2s silent sliver from being kept in the b-roll layout
 * just because two cuts (an ai-silence cut and a Backspace-applied user
 * cut) didn't quite touch end-to-end. Without `words`, the merge falls
 * back to the basic 50ms threshold.
 */
export function computeSkipRegions(cuts, cutExclusions = [], words = null) {
  if (!cuts || cuts.length === 0) return []
  const sorted = [...cuts]
    .filter(c => c.end > c.start + 0.01)
    .sort((a, b) => a.start - b.start)
  const wordsList = Array.isArray(words) ? words : null
  const merged = []
  for (const c of sorted) {
    const last = merged[merged.length - 1]
    if (!last) {
      merged.push({ start: c.start, end: c.end })
      continue
    }
    if (c.start <= last.end + 0.05) {
      last.end = Math.max(last.end, c.end)
      continue
    }
    if (wordsList && !wordsList.some(w => w.start >= last.end - 0.05 && w.end <= c.start + 0.05)) {
      last.end = Math.max(last.end, c.end)
      continue
    }
    merged.push({ start: c.start, end: c.end })
  }
  if (!cutExclusions?.length) return merged
  const result = []
  for (const region of merged) {
    let cur = { ...region }
    const sortedEx = [...cutExclusions].sort((a, b) => a.start - b.start)
    for (const ex of sortedEx) {
      if (ex.start >= cur.end || ex.end <= cur.start) continue
      if (cur.start < ex.start - 0.01) result.push({ start: cur.start, end: ex.start })
      cur.start = ex.end
    }
    if (cur.start < cur.end - 0.01) result.push(cur)
  }
  return result
}

/**
 * Skip cut regions during video playback. Reusable across editor views.
 *
 * Computes effective skip regions = cuts minus cutExclusions (with overlap
 * merging) by delegating to computeSkipRegions. On every `timeupdate` event
 * of the video element, if the playhead is inside a skip region, jumps to
 * the region's end + a tiny epsilon to avoid re-triggering on the same frame.
 *
 * Note: this hook does NOT include the waveform-based refinement
 * (3-bar silence rule, +150ms tail) that the rough cut editor applies
 * via `mergedWords`. That refinement is rough-cut-specific and depends
 * on the transcript editor; the b-roll editor doesn't have access to it.
 * Both editors get the same boundary skip behavior; only the rough cut
 * editor adds the waveform tail-trim refinement (kept in EditorView.jsx).
 *
 * @param {React.RefObject} videoRef React ref pointing to an HTMLVideoElement (or test stub)
 * @param {Array<{start: number, end: number}>} cuts
 * @param {Array<{start: number, end: number}>} cutExclusions
 * @returns {Array<{start: number, end: number}>} effective skip regions, useful for callers that want to display cut overlay too
 */
export function usePlaybackSkipRegions(videoRef, cuts, cutExclusions = []) {
  const skipRegions = useMemo(
    () => computeSkipRegions(cuts, cutExclusions),
    [cuts, cutExclusions],
  )

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handleTimeupdate = () => {
      const t = video.currentTime
      for (const r of skipRegions) {
        if (t >= r.start && t < r.end) {
          video.currentTime = r.end + 0.001
          return
        }
      }
    }
    video.addEventListener('timeupdate', handleTimeupdate)
    return () => video.removeEventListener('timeupdate', handleTimeupdate)
  }, [videoRef, skipRegions])

  return skipRegions
}
