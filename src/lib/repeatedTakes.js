/**
 * Repeated Take Detector
 *
 * Finds sequential, near-identical paragraphs in transcript text.
 * Port of find_repeated_takes.py for in-browser use.
 */

const TIMESTAMP_RE = /\[\d{2}:\d{2}:\d{2}\]/g
const PAUSE_RE = /\[\d+\.?\d*s\]/g
const WORD_RE = /\b[a-zA-Z]+\b/g

const MIN_WORDS = 8
const THRESHOLD = 0.85

/** Strip timestamps, pauses, punctuation → lowercase word array */
function cleanText(text) {
  const stripped = text.replace(TIMESTAMP_RE, ' ').replace(PAUSE_RE, ' ')
  const words = stripped.match(WORD_RE)
  return words ? words.map(w => w.toLowerCase()) : []
}

/** Split transcript into paragraphs (blank lines → lines → timestamps) */
function splitParagraphs(text) {
  // 1) Blank-line split
  let paras = text.trim().split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  if (paras.length > 1) return paras

  // 2) Single-line split
  paras = text.trim().split('\n').map(p => p.trim()).filter(Boolean)
  if (paras.length > 1) return paras

  // 3) Timestamp split
  paras = text.trim().split(/(?=\[\d{2}:\d{2}:\d{2}\])/).map(p => p.trim()).filter(Boolean)
  return paras.length > 1 ? paras : [text.trim()]
}

/**
 * SequenceMatcher.ratio() equivalent — uses LCS-based similarity.
 * Returns 2 * matches / (len(a) + len(b))
 */
function sequenceRatio(a, b) {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0

  const m = a.length, n = b.length
  // LCS via DP (O(m*n) space — fine for paragraph-sized inputs)
  const dp = []
  for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1)
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const lcs = dp[m][n]
  return (2 * lcs) / (m + n)
}

/**
 * Find groups of sequential similar paragraphs.
 *
 * Returns { paragraphs, cleaned, groups }
 *   paragraphs: string[] — original text of each paragraph
 *   cleaned: string[][] — cleaned word arrays
 *   groups: number[][] — each group is an array of paragraph indices
 */
export function detectRepeatedTakes(text) {
  if (!text) return { paragraphs: [], cleaned: [], groups: [] }

  const paragraphs = splitParagraphs(text)
  const cleaned = paragraphs.map(cleanText)
  const n = paragraphs.length

  const groups = []
  const inGroup = new Set()

  let i = 0
  while (i < n) {
    if (inGroup.has(i) || cleaned[i].length < MIN_WORDS) {
      i++
      continue
    }

    const group = [i]
    let j = i + 1

    while (j < n) {
      if (cleaned[j].length < MIN_WORDS) {
        j++
        continue
      }

      const lastWords = cleaned[group[group.length - 1]]
      const currWords = cleaned[j]

      // Boundary rule: same first & last word
      if (lastWords[0] !== currWords[0] || lastWords[lastWords.length - 1] !== currWords[currWords.length - 1]) {
        break
      }

      const ratio = sequenceRatio(lastWords, currWords)
      if (ratio >= THRESHOLD) {
        group.push(j)
        j++
      } else {
        break
      }
    }

    if (group.length > 1) {
      groups.push(group)
      for (const idx of group) inGroup.add(idx)
    }

    i++
  }

  return { paragraphs, cleaned, groups }
}
