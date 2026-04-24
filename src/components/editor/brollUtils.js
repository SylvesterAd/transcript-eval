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

  // Step 0: Filter out placements hidden via local user-edits
  const filtered = editsByKey
    ? placements.filter(p => {
        if (p.chapterIndex == null || p.placementIndex == null) return true // userPlacements are deleted by removal from state.userPlacements, not via edits[key].hidden
        const e = editsByKey[`${p.chapterIndex}:${p.placementIndex}`]
        return !e?.hidden
      })
    : placements

  // Step 1: Position each placement independently based on audio_anchor
  const resolved = filtered.map(p => {
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

  // Step 2: Two-pass soft displacement.
  // Fixed clips (user-edited OR user-created) are immovable landmarks;
  // free clips flow left-to-right through the gaps, clipped by fixed neighbors.
  for (const p of resolved) {
    const hasEditsOverride = editsByKey && p.chapterIndex != null && p.placementIndex != null
      && editsByKey[`${p.chapterIndex}:${p.placementIndex}`]?.timelineStart != null
    p.isFixed = !!p.isUserPlacement || hasEditsOverride
    p.naturalStart = p.timelineStart
    p.naturalEnd   = p.timelineEnd
  }

  const sorted = [...resolved].sort((a, b) => a.naturalStart - b.naturalStart)

  // Pass 1: fixed clips stay at natural positions
  for (const p of sorted) {
    if (p.isFixed) {
      p.timelineStart = p.naturalStart
      p.timelineEnd   = p.naturalEnd
    }
  }

  // Pass 2: walk free clips, clipped by the next fixed clip to their right
  let prevEnd = 0
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]
    if (c.isFixed) {
      prevEnd = Math.max(prevEnd, c.timelineEnd)
      continue
    }
    let rightBoundary = Infinity
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].isFixed) { rightBoundary = sorted[j].naturalStart; break }
    }
    const naturalDur = Math.max(0, c.naturalEnd - c.naturalStart)
    let timelineStart = Math.max(c.naturalStart, prevEnd)
    let timelineEnd   = Math.min(timelineStart + naturalDur, rightBoundary)
    if (timelineEnd - timelineStart < 0.5) {
      // Squeezed out past the fixed clip
      timelineStart = rightBoundary
      timelineEnd   = rightBoundary + naturalDur
    }
    c.timelineStart   = timelineStart
    c.timelineEnd     = timelineEnd
    c.timelineDuration = Math.max(0, timelineEnd - timelineStart)
    prevEnd = Math.max(prevEnd, timelineEnd)
  }

  return sorted
}
