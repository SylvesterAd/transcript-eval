// Pure function: detect interruption clusters around audio_event tokens.
// Spec: §find_interruption_clusters tool.
//
// Algorithm: scan audio_events; for each, expand left/right while adjacent
// elements are short (<3s) utterances or other audio_events with gap <
// maxGapSec; emit the expanded span.

const SHORT_UTTERANCE_SEC = 3
const DEFAULT_MAX_GAP = 5

// Audio events come in two shapes depending on data source:
//  - Unit-test fixtures: explicit { type: 'audio_event' }
//  - Production word_timestamps: word text wrapped in square brackets, no type field
function isAudioEvent(word) {
  if (word.type === 'audio_event') return true
  return typeof word.word === 'string' && /^\[.*\]$/.test(word.word.trim())
}

function isShortUtterance(word) {
  if (isAudioEvent(word)) return false
  const dur = word.end - word.start
  return dur > 0 && dur < SHORT_UTTERANCE_SEC
}

/**
 * @param {Array<{word: string, start: number, end: number, type?: string}>} words
 * @param {{maxGapSec?: number, scope?: {start: number, end: number}}} [opts]
 * @returns {Array<{start: number, end: number, elements: Array<object>, suggested_category: string}>}
 */
export function findInterruptionClusters(words, opts = {}) {
  const maxGap = opts.maxGapSec ?? DEFAULT_MAX_GAP
  const scope = opts.scope || null
  if (!Array.isArray(words) || words.length === 0) return []

  const inScope = (w) =>
    !scope || (w.end >= scope.start && w.start <= scope.end)

  const clusters = []
  const used = new Set()

  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue
    if (!isAudioEvent(words[i])) continue
    if (!inScope(words[i])) continue

    let lo = i
    let hi = i

    // Expand left
    while (lo > 0) {
      const prev = words[lo - 1]
      const gap = words[lo].start - prev.end
      if (gap > maxGap) break
      if (!isAudioEvent(prev) && !isShortUtterance(prev)) break
      lo--
    }

    // Expand right
    while (hi < words.length - 1) {
      const next = words[hi + 1]
      const gap = next.start - words[hi].end
      if (gap > maxGap) break
      if (!isAudioEvent(next) && !isShortUtterance(next)) break
      hi++
    }

    for (let j = lo; j <= hi; j++) used.add(j)

    clusters.push({
      start: words[lo].start,
      end: words[hi].end,
      elements: words.slice(lo, hi + 1),
      suggested_category: 'meta_commentary',
    })
  }

  return clusters
}
