/**
 * Parse a timecode string like "[00:25:28]" or "00:25:28" to seconds.
 */
export function parseTimecode(tc) {
  if (!tc) return 0
  const cleaned = tc.replace(/[[\]]/g, '')
  const parts = cleaned.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

/**
 * Normalize text for matching: lowercase, strip punctuation, collapse whitespace.
 */
function normalize(text) {
  return (text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Match B-Roll placements to transcript word timestamps.
 *
 * For each placement, finds the transcript word whose surrounding text
 * best matches the audio_anchor within ±30s of the plan's start timecode.
 * Returns placements with resolved `timelineStart` and `timelineDuration`.
 *
 * @param {Array} placements - from the assembled plan
 * @param {Array} words - transcript words [{word, start, end}, ...]
 * @returns {Array} placements with timelineStart, timelineEnd, timelineDuration added
 */
export function matchPlacementsToTranscript(placements, words, editsByKey = null) {
  if (!placements?.length || !words?.length) return placements || []

  // Step 1: Position each placement independently based on audio_anchor
  const resolved = placements.map(p => {
    // Prefer editsByKey lookup if provided; fall back to inline userTimelineStart/End
    const editKey = p.chapterIndex != null && p.placementIndex != null
      ? `${p.chapterIndex}:${p.placementIndex}`
      : null
    const edit = editKey && editsByKey ? editsByKey[editKey] : null
    const uStart = edit?.timelineStart ?? p.userTimelineStart
    const uEnd   = edit?.timelineEnd   ?? p.userTimelineEnd
    if (uStart != null && uEnd != null) {
      return {
        ...p,
        timelineStart: uStart,
        timelineEnd: uEnd,
        timelineDuration: uEnd - uStart,
      }
    }

    const planStart = parseTimecode(p.start)
    const planEnd = parseTimecode(p.end)
    const planDuration = Math.max(planEnd - planStart, 1)
    const anchor = normalize(p.audio_anchor)

    if (!anchor) {
      // No anchor — use plan timecodes directly
      return { ...p, timelineStart: planStart, timelineEnd: planEnd, timelineDuration: planDuration }
    }

    const anchorWords = anchor.split(' ')
    const windowStart = Math.max(0, planStart - 30)
    const windowEnd = planEnd + 30

    // Find words within the time window
    let bestScore = 0
    let bestWordIdx = -1

    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (w.start < windowStart || w.start > windowEnd) continue

      // Build a phrase from this word onward (same length as anchor)
      const phraseWords = []
      for (let j = i; j < Math.min(i + anchorWords.length + 2, words.length); j++) {
        phraseWords.push(normalize(words[j].word))
      }
      const phrase = phraseWords.join(' ')

      // Score: count matching anchor words in sequence
      let score = 0
      let phraseIdx = 0
      for (const aw of anchorWords) {
        const found = phrase.indexOf(aw, phraseIdx)
        if (found >= 0) {
          score++
          phraseIdx = found + aw.length
        }
      }

      if (score > bestScore) {
        bestScore = score
        bestWordIdx = i
      }
    }

    if (bestWordIdx >= 0) {
      const matchedWord = words[bestWordIdx]
      return {
        ...p,
        timelineStart: matchedWord.start,
        timelineEnd: matchedWord.start + planDuration,
        timelineDuration: planDuration,
      }
    }

    // Fallback: use plan timecodes directly
    return { ...p, timelineStart: planStart, timelineEnd: planEnd, timelineDuration: planDuration }
  })

  // Step 2: Fix overlaps — audio_anchor position has priority.
  // Sort by timelineStart, then trim earlier placement's end if it overlaps
  // the next placement's anchor-based start.
  const sorted = [...resolved].sort((a, b) => a.timelineStart - b.timelineStart)
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i]
    const next = sorted[i + 1]
    if (curr.timelineEnd > next.timelineStart) {
      // Trim current placement's end to where the next one starts
      curr.timelineEnd = next.timelineStart
      curr.timelineDuration = Math.max(0, curr.timelineEnd - curr.timelineStart)
    }
  }

  return sorted
}
