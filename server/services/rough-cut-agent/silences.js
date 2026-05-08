// Pure function: derive silence spans from word timestamps.
// No DB, no side effects.

/**
 * @param {Array<{word: string, start: number, end: number}>} words
 * @param {number} minDuration — seconds; gaps shorter than this are skipped
 * @param {{start: number, end: number}} [scope] — optional time range filter.
 *   A gap is kept if any part overlaps scope; returned spans are NOT clipped
 *   to scope bounds.
 * @returns {Array<{start: number, end: number, duration: number}>}
 */
export function deriveSilences(words, minDuration = 0.75, scope = null) {
  if (!Array.isArray(words) || words.length < 2) return []
  const out = []
  for (let i = 1; i < words.length; i++) {
    const prevEnd = words[i - 1].end
    const currStart = words[i].start
    const gap = currStart - prevEnd
    if (gap < minDuration) continue
    if (scope) {
      if (prevEnd < scope.start || currStart > scope.end) continue
    }
    out.push({ start: prevEnd, end: currStart, duration: gap })
  }
  return out
}
