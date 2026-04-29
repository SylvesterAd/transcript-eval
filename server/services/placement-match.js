// Server-side mirror of src/components/editor/brollUtils.js
// matchPlacementsToTranscript. The b-roll editor refines each
// placement's start time client-side by snapping the plan's integer-
// second timecode to the nearest transcript word matching the
// placement's `audio_anchor`. If the export pipeline uses the raw plan
// timecode it shows a different start time than what the user sees in
// the editor (off by up to ~1 second per placement).
//
// Keep this in sync with the client implementation. Both must produce
// identical output given identical inputs (placements + transcript words).

export function parseTimecode(tc) {
  if (!tc) return 0
  const cleaned = String(tc).replace(/[[\]]/g, '')
  const parts = cleaned.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Match B-Roll placements to transcript word timestamps.
 *
 * For each placement, finds the transcript word whose surrounding text
 * best matches the audio_anchor within ±30s of the plan's start
 * timecode, and uses that word's start time as the resolved
 * timelineStart. Duration is preserved from plan (planEnd - planStart).
 *
 * Output: same placements, augmented with `timelineStart`,
 * `timelineEnd`, `timelineDuration` (numeric seconds).
 *
 * Per-placement editsByKey overrides (broll_editor_state.edits[key].
 * timelineStart/timelineEnd) win over both anchor-match and plan
 * timecode — matches the editor's precedence.
 */
export function matchPlacementsToTranscript(placements, words, editsByKey = null) {
  if (!placements?.length) return placements || []
  const wordsList = words || []

  const filtered = editsByKey
    ? placements.filter(p => {
        if (p.chapterIndex == null || p.placementIndex == null) return true
        const e = editsByKey[`${p.chapterIndex}:${p.placementIndex}`]
        return !e?.hidden
      })
    : placements

  const resolved = filtered.map(p => {
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
      return { ...p, timelineStart: planStart, timelineEnd: planEnd, timelineDuration: planDuration }
    }

    const anchorWords = anchor.split(' ')
    const windowStart = Math.max(0, planStart - 30)
    const windowEnd = planEnd + 30

    let bestScore = 0
    let bestWordIdx = -1

    for (let i = 0; i < wordsList.length; i++) {
      const w = wordsList[i]
      if (w.start < windowStart || w.start > windowEnd) continue

      const phraseWords = []
      for (let j = i; j < Math.min(i + anchorWords.length + 2, wordsList.length); j++) {
        phraseWords.push(normalize(wordsList[j].word))
      }
      const phrase = phraseWords.join(' ')

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
      const matchedWord = wordsList[bestWordIdx]
      return {
        ...p,
        timelineStart: matchedWord.start,
        timelineEnd: matchedWord.start + planDuration,
        timelineDuration: planDuration,
      }
    }

    return { ...p, timelineStart: planStart, timelineEnd: planEnd, timelineDuration: planDuration }
  })

  // Same overlap trim as the editor — sorted by start, trim earlier end
  // if it overlaps the next.
  const sorted = [...resolved].sort((a, b) => a.timelineStart - b.timelineStart)
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i]
    const next = sorted[i + 1]
    if (curr.timelineEnd > next.timelineStart) {
      curr.timelineEnd = next.timelineStart
      curr.timelineDuration = Math.max(0, curr.timelineEnd - curr.timelineStart)
    }
  }

  return sorted
}
