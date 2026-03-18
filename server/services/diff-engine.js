import { diffWords } from 'diff'

// Regex for timecodes [00:01:23] and pause markers [2.3s]
const TIMECODE_RE = /\[\d{2}:\d{2}:\d{2}\]/g
const PAUSE_RE = /\[\d+\.?\d*s\]/g
const SPECIAL_TOKEN_RE = /(\[\d{2}:\d{2}:\d{2}\]|\[\d+\.?\d*s\])/g

/**
 * Normalize text for word-focused comparison:
 * - Strip timecodes and pause markers
 * - Lowercase
 * - Strip punctuation
 * - Collapse whitespace
 */
// Number words → digits
const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
  twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30',
  forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', million: '1000000', billion: '1000000000',
}

// Symbol ↔ word equivalences (normalized to same form)
const SYMBOL_WORDS = {
  dollar: '$', dollars: '$', '$': '$',
  percent: '%', '%': '%',
  '&': 'and', and: 'and',
  '@': 'at', at: 'at',
  plus: '+', '+': '+',
}

function normalizeForDiff(text) {
  if (!text) return ''
  return text
    .replace(TIMECODE_RE, ' ')
    .replace(PAUSE_RE, ' ')
    .toLowerCase()
    .replace(/[.,!?;:'"()\-—…""''«»\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => {
      // Normalize number words to digits
      if (NUMBER_WORDS[w]) return NUMBER_WORDS[w]
      // Normalize symbol/word equivalences
      if (SYMBOL_WORDS[w]) return SYMBOL_WORDS[w]
      return w
    })
    .join(' ')
}

/**
 * Tokenize transcript into words while preserving timecodes and pause markers as atomic tokens.
 * Returns array of { text, type } where type is 'word' | 'timecode' | 'pause' | 'whitespace'
 */
export function tokenize(text) {
  if (!text) return []
  const tokens = []
  const parts = text.split(SPECIAL_TOKEN_RE)

  for (const part of parts) {
    if (TIMECODE_RE.test(part)) {
      tokens.push({ text: part, type: 'timecode' })
      TIMECODE_RE.lastIndex = 0
    } else if (PAUSE_RE.test(part)) {
      tokens.push({ text: part, type: 'pause' })
      PAUSE_RE.lastIndex = 0
    } else {
      // Split remaining text into words and whitespace
      const wordParts = part.split(/(\s+)/)
      for (const wp of wordParts) {
        if (!wp) continue
        if (/^\s+$/.test(wp)) {
          tokens.push({ text: wp, type: 'whitespace' })
        } else {
          tokens.push({ text: wp, type: 'word' })
        }
      }
    }
  }

  return tokens
}

/**
 * Levenshtein edit distance between two strings.
 */
function editDistance(a, b) {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const matrix = []
  for (let i = 0; i <= b.length; i++) matrix[i] = [i]
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = a[j - 1] === b[i - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
    }
  }
  return matrix[b.length][a.length]
}

/**
 * Post-process diff to merge near-identical remove/add pairs.
 * "s corporation" vs "scorporation" (edit distance <= 2) → treat as unchanged.
 */
function applyFuzzyTolerance(diff) {
  const result = []
  let i = 0
  while (i < diff.length) {
    // Look for removed+added pair
    if (i < diff.length - 1 && diff[i].removed && diff[i + 1].added) {
      const removed = diff[i].value.replace(/\s+/g, '')
      const added = diff[i + 1].value.replace(/\s+/g, '')
      const maxLen = Math.max(removed.length, added.length)
      const dist = editDistance(removed, added)
      // Tolerate: edit distance <= 2 OR <= 15% of word length (for longer words)
      if (dist <= 2 || (maxLen > 6 && dist / maxLen <= 0.15)) {
        result.push({ value: diff[i + 1].value, added: false, removed: false })
        i += 2
        continue
      }
    }
    // Also check added+removed (opposite order)
    if (i < diff.length - 1 && diff[i].added && diff[i + 1].removed) {
      const added = diff[i].value.replace(/\s+/g, '')
      const removed = diff[i + 1].value.replace(/\s+/g, '')
      const maxLen = Math.max(removed.length, added.length)
      const dist = editDistance(removed, added)
      if (dist <= 2 || (maxLen > 6 && dist / maxLen <= 0.15)) {
        result.push({ value: diff[i].value, added: false, removed: false })
        i += 2
        continue
      }
    }
    result.push(diff[i])
    i++
  }
  return result
}

/**
 * Compute word-level diff between two transcripts.
 * Normalizes text first: strips timecodes, punctuation, and case.
 * Applies fuzzy tolerance for minor transcription differences.
 * Returns array of { value, added, removed } chunks.
 */
export function computeDiff(textA, textB) {
  const a = normalizeForDiff(textA)
  const b = normalizeForDiff(textB)
  if (!a && !b) return []
  if (!a) return [{ value: b, added: true, removed: false }]
  if (!b) return [{ value: a, added: false, removed: true }]

  const raw = diffWords(a, b)
  return applyFuzzyTolerance(raw)
}

/**
 * Extract all deleted spans from a diff result.
 * Returns array of { text, position }
 */
export function extractDeletions(diffResult) {
  const deletions = []
  let position = 0

  for (const part of diffResult) {
    if (part.removed) {
      deletions.push({
        text: part.value.trim(),
        position_start: position,
        position_end: position + part.value.length,
        raw: part.value
      })
    }
    if (!part.added) {
      position += part.value.length
    }
  }

  return deletions.filter(d => d.text.length > 0)
}

/**
 * Extract all additions from a diff result.
 */
export function extractAdditions(diffResult) {
  const additions = []
  let position = 0

  for (const part of diffResult) {
    if (part.added) {
      additions.push({
        text: part.value.trim(),
        position_start: position,
        position_end: position + part.value.length,
        raw: part.value
      })
    }
    if (!part.removed) {
      position += part.value.length
    }
  }

  return additions.filter(a => a.text.length > 0)
}

/**
 * Calculate similarity metrics between two texts.
 * Uses normalized text (no timecodes, case-insensitive, no punctuation).
 * Returns { diffPercent, similarityPercent, stats }
 */
export function calculateSimilarity(textA, textB) {
  const a = normalizeForDiff(textA)
  const b = normalizeForDiff(textB)
  if (!a && !b) return { diffPercent: 0, similarityPercent: 100, stats: {} }
  if (!a || !b) return { diffPercent: 100, similarityPercent: 0, stats: {} }

  const diff = computeDiff(textA, textB)

  let unchanged = 0
  let removed = 0
  let added = 0

  for (const part of diff) {
    const len = part.value.length
    if (part.added) added += len
    else if (part.removed) removed += len
    else unchanged += len
  }

  const totalOriginal = unchanged + removed
  const totalChanged = removed + added
  const diffPercent = totalOriginal > 0 ? (totalChanged / (totalOriginal + added)) * 100 : 0
  const similarityPercent = 100 - diffPercent

  return {
    diffPercent: round(diffPercent),
    similarityPercent: round(similarityPercent),
    stats: {
      unchanged,
      removed,
      added,
      totalOriginal,
      totalNew: unchanged + added
    }
  }
}

/**
 * Check timecode preservation between two texts.
 * Returns { score (0-1), total, preserved, missing, corrupted }
 */
export function checkTimecodePreservation(original, current) {
  const origTimecodes = (original || '').match(TIMECODE_RE) || []
  const currTimecodes = (current || '').match(TIMECODE_RE) || []

  if (origTimecodes.length === 0) return { score: 1, total: 0, preserved: 0, missing: 0 }

  const currSet = new Set(currTimecodes)
  let preserved = 0
  const missing = []

  for (const tc of origTimecodes) {
    if (currSet.has(tc)) {
      preserved++
    } else {
      missing.push(tc)
    }
  }

  return {
    score: round(preserved / origTimecodes.length),
    total: origTimecodes.length,
    preserved,
    missing
  }
}

/**
 * Check pause marker preservation between two texts.
 * Returns { score (0-1), total, preserved, missing }
 */
export function checkPausePreservation(original, current) {
  const origPauses = (original || '').match(PAUSE_RE) || []
  const currPauses = (current || '').match(PAUSE_RE) || []

  if (origPauses.length === 0) return { score: 1, total: 0, preserved: 0, missing: [] }

  const currList = [...currPauses]
  let preserved = 0
  const missing = []

  for (const p of origPauses) {
    const idx = currList.indexOf(p)
    if (idx !== -1) {
      preserved++
      currList.splice(idx, 1)
    } else {
      missing.push(p)
    }
  }

  return {
    score: round(preserved / origPauses.length),
    total: origPauses.length,
    preserved,
    missing
  }
}

/**
 * Full comparison between two transcripts.
 * Returns everything needed for display and scoring.
 */
export function fullComparison(textA, textB, rawText) {
  const diff = computeDiff(textA, textB)
  const similarity = calculateSimilarity(textA, textB)
  const deletions = extractDeletions(diff)
  const additions = extractAdditions(diff)

  // Use raw text as reference for timecode/pause preservation if provided
  const refText = rawText || textA
  const timecodes = checkTimecodePreservation(refText, textB)
  const pauses = checkPausePreservation(refText, textB)

  return {
    diff,
    similarity,
    deletions,
    additions,
    timecodes,
    pauses
  }
}

function round(n) {
  return Math.round(n * 100) / 100
}
