import { diffWords } from 'diff'

// Regex for timecodes [00:01:23] or [01:23] and pause markers [2.3s]
const TIMECODE_RE = /\[\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,2})?)?\]/g
const PAUSE_RE = /\[\d+\.?\d*s\]/g
const SPECIAL_TOKEN_RE = /(\[\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,2})?)?\]|\[\d+\.?\d*s\])/g

/**
 * Normalize text for word-focused comparison:
 * - Strip timecodes and pause markers
 * - Lowercase
 * - Strip punctuation
 * - Collapse whitespace
 */
// Digits → words (all numbers become words for comparison)
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function numberToWords(n) {
  if (n < 0) return 'negative ' + numberToWords(-n)
  if (n < 10) return DIGIT_WORDS[n]
  if (n < 20) return TEENS[n - 10]
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + DIGIT_WORDS[n % 10] : '')
  if (n < 1000) return DIGIT_WORDS[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '')
  if (n < 1000000) return numberToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '')
  if (n < 1000000000) return numberToWords(Math.floor(n / 1000000)) + ' million' + (n % 1000000 ? ' ' + numberToWords(n % 1000000) : '')
  return numberToWords(Math.floor(n / 1000000000)) + ' billion' + (n % 1000000000 ? ' ' + numberToWords(n % 1000000000) : '')
}

// Number words that should stay as words (for reverse mapping when source has word form)
const NUMBER_WORD_SET = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion',
])

// Symbols → words (everything becomes long-form words)
const SYMBOL_TO_WORD = {
  '%': 'percent',
  '$': 'dollar',
  '&': 'and',
  '@': 'at',
  '+': 'plus',
}

export function normalizeForDiff(text) {
  if (!text) return ''
  return text
    // Strip timecodes and pause markers entirely
    .replace(TIMECODE_RE, ' ')
    .replace(PAUSE_RE, ' ')
    // Replace hyphens/dashes with spaces (S-Corporation → S Corporation)
    .replace(/[-—–]/g, ' ')
    .toLowerCase()
    // Remove all punctuation except % $ & @ + (we convert those to words below)
    .replace(/[.,!?;:'"()…""''«»\[\]{}\/\\#*_~`^|<>]/g, '')
    // Normalize common transcription variants
    .replace(/\bper\s+cent\b/g, 'percent')
    .replace(/\be[\s-]?mail\b/g, 'email')
    .replace(/\bco[\s-]?founder\b/g, 'cofounder')
    .replace(/\bon[\s-]?line\b/g, 'online')
    .replace(/\bblock[\s-]?chain\b/g, 'blockchain')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => {
      // Convert symbols to words: % → percent, $ → dollar
      if (SYMBOL_TO_WORD[w]) return SYMBOL_TO_WORD[w]
      // Convert numbers to words: 99 → ninety nine, 100 → one hundred
      // Handle numbers with attached symbols: 100% → one hundred percent, $50 → fifty dollar
      const symbolMatch = w.match(/^([%$&@+]?)(\d+)([%$&@+]?)$/)
      if (symbolMatch) {
        const [, pre, num, post] = symbolMatch
        const numWord = numberToWords(parseInt(num))
        // $50 → fifty dollars (prefix currency goes after number)
        if (pre === '$') return numWord + ' dollars'
        const parts = []
        if (pre && SYMBOL_TO_WORD[pre]) parts.push(SYMBOL_TO_WORD[pre])
        parts.push(numWord)
        if (post && SYMBOL_TO_WORD[post]) parts.push(SYMBOL_TO_WORD[post])
        return parts.join(' ')
      }
      // Keep number words as-is (they're already words)
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
      // Tolerate: edit distance <= 2 OR <= 20% of length (for longer words like ChatGPT/ChatPT)
      if (dist <= 2 || (maxLen > 5 && dist / maxLen <= 0.20)) {
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
      if (dist <= 2 || (maxLen > 5 && dist / maxLen <= 0.20)) {
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
