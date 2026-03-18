/**
 * Transcript Segmenter — divides transcript into timed segments
 * for parallel processing.
 *
 * Strategy: split into segments of 40-80 seconds (by timecodes),
 * ending at sentence boundaries. Add 30s of context before and after.
 */

/**
 * Parse timecodes from transcript text.
 * Expects format: [HH:MM:SS] or [MM:SS] at line starts.
 * Returns array of { seconds, position, text } entries.
 */
function parseTimecodes(text) {
  const entries = []
  const regex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/g
  let match

  while ((match = regex.exec(text)) !== null) {
    const tc = match[1]
    const parts = tc.split(':').map(Number)
    let seconds
    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
    } else {
      seconds = parts[0] * 60 + parts[1]
    }

    // Get text until next timecode or end
    const start = match.index + match[0].length
    const nextMatch = text.indexOf('[', start)
    const end = nextMatch !== -1 ? nextMatch : text.length
    const segText = text.slice(start, end).trim()

    entries.push({
      seconds,
      position: match.index,
      endPosition: end,
      text: segText,
      timecode: match[0].trim(),
    })
  }

  return entries
}

/**
 * Segment transcript into chunks of minSeconds-maxSeconds,
 * ending at sentence boundaries.
 * Each segment includes contextSeconds of surrounding text.
 *
 * @returns Array of { mainText, beforeContext, afterContext, startTime, endTime, segmentIndex }
 */
export function segmentTranscript(text, {
  minSeconds = 40,
  maxSeconds = 80,
  contextSeconds = 30,
} = {}) {
  const entries = parseTimecodes(text)

  // If no timecodes found, fall back to text-based splitting
  if (entries.length === 0) {
    return segmentByText(text, { minChars: 800, maxChars: 2000, contextChars: 600 })
  }

  const segments = []
  let segStart = 0

  while (segStart < entries.length) {
    const startTime = entries[segStart].seconds

    // Find end of segment: at least minSeconds, at most maxSeconds, ending at sentence
    let segEnd = segStart
    let lastSentenceEnd = segStart

    for (let i = segStart; i < entries.length; i++) {
      const elapsed = entries[i].seconds - startTime

      // Track sentence endings (period, question mark, exclamation)
      if (/[.!?]\s*$/.test(entries[i].text)) {
        lastSentenceEnd = i
      }

      if (elapsed >= maxSeconds) break
      segEnd = i

      if (elapsed >= minSeconds && lastSentenceEnd > segStart) {
        // We've passed minimum and have a sentence boundary
        segEnd = lastSentenceEnd
        break
      }
    }

    // If we haven't found a sentence boundary, just use where we got to
    if (segEnd === segStart && segStart < entries.length - 1) {
      segEnd = Math.min(segStart + 3, entries.length - 1)
    }

    const endTime = entries[segEnd].seconds

    // Main text for this segment
    const mainText = entries.slice(segStart, segEnd + 1)
      .map(e => `${e.timecode} ${e.text}`)
      .join('\n\n')

    // Before context: entries within contextSeconds before startTime
    const beforeEntries = entries.filter(
      e => e.seconds < startTime && e.seconds >= startTime - contextSeconds
    )
    const beforeContext = beforeEntries
      .map(e => `${e.timecode} ${e.text}`)
      .join('\n\n')

    // After context: entries within contextSeconds after endTime
    const afterEntries = entries.filter(
      e => e.seconds > endTime && e.seconds <= endTime + contextSeconds
    )
    const afterContext = afterEntries
      .map(e => `${e.timecode} ${e.text}`)
      .join('\n\n')

    segments.push({
      segmentIndex: segments.length,
      startTime,
      endTime,
      mainText,
      beforeContext,
      afterContext,
      entryCount: segEnd - segStart + 1,
    })

    segStart = segEnd + 1
  }

  return segments
}

/**
 * Fallback: segment by character count when no timecodes present.
 */
function segmentByText(text, { minChars = 800, maxChars = 2000, contextChars = 600 }) {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const segments = []
  let current = []
  let currentLen = 0

  for (const sentence of sentences) {
    current.push(sentence)
    currentLen += sentence.length

    if (currentLen >= minChars) {
      const mainText = current.join(' ')

      // Context from surrounding segments
      const fullText = sentences.join(' ')
      const mainStart = fullText.indexOf(mainText)
      const beforeContext = fullText.slice(Math.max(0, mainStart - contextChars), mainStart).trim()
      const afterEnd = mainStart + mainText.length
      const afterContext = fullText.slice(afterEnd, afterEnd + contextChars).trim()

      segments.push({
        segmentIndex: segments.length,
        startTime: null,
        endTime: null,
        mainText,
        beforeContext,
        afterContext,
        entryCount: current.length,
      })

      current = []
      currentLen = 0
    }
  }

  // Remaining text
  if (current.length > 0) {
    const mainText = current.join(' ')
    const fullText = sentences.join(' ')
    const mainStart = fullText.indexOf(mainText)
    const beforeContext = fullText.slice(Math.max(0, mainStart - contextChars), mainStart).trim()

    segments.push({
      segmentIndex: segments.length,
      startTime: null,
      endTime: null,
      mainText,
      beforeContext,
      afterContext: '',
      entryCount: current.length,
    })
  }

  return segments
}

/**
 * Reassemble cleaned segments back into a single transcript.
 * Expects array of cleaned text strings (one per segment).
 */
export function reassembleSegments(cleanedTexts) {
  return cleanedTexts.join('\n\n')
}

/**
 * Apply deletions to text — removes identified text spans.
 */
export function applyDeletions(text, deletions) {
  if (!deletions || deletions.length === 0) return text

  let result = text
  // Sort by position descending to avoid offset issues
  const sorted = [...deletions].sort((a, b) => (b.position || 0) - (a.position || 0))

  for (const d of sorted) {
    if (d.text) {
      result = result.replace(d.text, '')
    }
  }

  // Clean up extra whitespace
  return result.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
