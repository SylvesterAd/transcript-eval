/**
 * Text Expander — normalizes transcript text by expanding contractions
 * to full words and converting digits/numbers to their word forms.
 * Does NOT modify the original text; returns a new expanded string.
 */

// ── Contraction expansions ──────────────────────────────────────────────
const CONTRACTIONS = {
  // Pronoun contractions
  "i'm":       "I am",
  "i've":      "I have",
  "i'll":      "I will",
  "i'd":       "I would",
  "you're":    "you are",
  "you've":    "you have",
  "you'll":    "you will",
  "you'd":     "you would",
  "he's":      "he is",
  "he'll":     "he will",
  "he'd":      "he would",
  "she's":     "she is",
  "she'll":    "she will",
  "she'd":     "she would",
  "it's":      "it is",
  "it'll":     "it will",
  "we're":     "we are",
  "we've":     "we have",
  "we'll":     "we will",
  "we'd":      "we would",
  "they're":   "they are",
  "they've":   "they have",
  "they'll":   "they will",
  "they'd":    "they would",
  // Common contractions
  "that's":    "that is",
  "there's":   "there is",
  "here's":    "here is",
  "what's":    "what is",
  "who's":     "who is",
  "how's":     "how is",
  "where's":   "where is",
  "when's":    "when is",
  "why's":     "why is",
  "let's":     "let us",
  "that'll":   "that will",
  "there'll":  "there will",
  "who'll":    "who will",
  "what'll":   "what will",
  // Negations
  "can't":     "cannot",
  "won't":     "will not",
  "don't":     "do not",
  "doesn't":   "does not",
  "didn't":    "did not",
  "isn't":     "is not",
  "aren't":    "are not",
  "wasn't":    "was not",
  "weren't":   "were not",
  "hasn't":    "has not",
  "haven't":   "have not",
  "hadn't":    "had not",
  "couldn't":  "could not",
  "wouldn't":  "would not",
  "shouldn't": "should not",
  "mustn't":   "must not",
  "needn't":   "need not",
  "mightn't":  "might not",
  "shan't":    "shall not",
  // Verb contractions
  "would've":  "would have",
  "could've":  "could have",
  "should've": "should have",
  "might've":  "might have",
  "must've":   "must have",
  "gonna":     "going to",
  "gotta":     "got to",
  "wanna":     "want to",
  "kinda":     "kind of",
  "sorta":     "sort of",
  "dunno":     "do not know",
  "ain't":     "is not",
  "y'all":     "you all",
  "ma'am":     "madam",
  "o'clock":   "of the clock",
  "'cause":    "because",
  "cause":     "because",
}

// ── Number to words ─────────────────────────────────────────────────────
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function numberToWords(n) {
  if (n < 0) return 'negative ' + numberToWords(-n)
  if (n === 0) return 'zero'

  if (n < 20) return ONES[n]
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]
    const o = n % 10
    return o ? `${t}-${ONES[o]}` : t
  }
  if (n < 1000) {
    const h = ONES[Math.floor(n / 100)] + ' hundred'
    const rem = n % 100
    return rem ? `${h} ${numberToWords(rem)}` : h
  }
  if (n < 1_000_000) {
    const th = numberToWords(Math.floor(n / 1000)) + ' thousand'
    const rem = n % 1000
    return rem ? `${th} ${numberToWords(rem)}` : th
  }
  if (n < 1_000_000_000) {
    const m = numberToWords(Math.floor(n / 1_000_000)) + ' million'
    const rem = n % 1_000_000
    return rem ? `${m} ${numberToWords(rem)}` : m
  }
  if (n < 1_000_000_000_000) {
    const b = numberToWords(Math.floor(n / 1_000_000_000)) + ' billion'
    const rem = n % 1_000_000_000
    return rem ? `${b} ${numberToWords(rem)}` : b
  }
  // For very large numbers, return as-is
  return String(n)
}

/**
 * Convert a numeric string (possibly with commas, decimals, %, $) to words.
 * Returns null if it's not a recognizable number pattern.
 */
function expandNumber(token) {
  // Currency: $123 or $1,234.56
  const currencyMatch = token.match(/^\$([0-9,]+\.?\d*)$/)
  if (currencyMatch) {
    const num = parseFloat(currencyMatch[1].replace(/,/g, ''))
    if (isNaN(num)) return null
    const intPart = Math.floor(num)
    const decPart = Math.round((num - intPart) * 100)
    let result = numberToWords(intPart) + ' dollar' + (intPart !== 1 ? 's' : '')
    if (decPart > 0) result += ' and ' + numberToWords(decPart) + ' cent' + (decPart !== 1 ? 's' : '')
    return result
  }

  // Percentage: 45% or 3.5%
  const percentMatch = token.match(/^([0-9,]+\.?\d*)%$/)
  if (percentMatch) {
    const num = parseFloat(percentMatch[1].replace(/,/g, ''))
    if (isNaN(num)) return null
    if (Number.isInteger(num)) return numberToWords(num) + ' percent'
    const [intStr, decStr] = percentMatch[1].split('.')
    return numberToWords(parseInt(intStr)) + ' point ' +
      decStr.split('').map(d => numberToWords(parseInt(d))).join(' ') + ' percent'
  }

  // Ordinals: 1st, 2nd, 3rd, 4th...
  const ordinalMatch = token.match(/^(\d+)(st|nd|rd|th)$/i)
  if (ordinalMatch) {
    const num = parseInt(ordinalMatch[1])
    return toOrdinalWord(num)
  }

  // Plain integer or comma-separated: 123 or 1,234
  const intMatch = token.match(/^[0-9,]+$/)
  if (intMatch) {
    const num = parseInt(token.replace(/,/g, ''), 10)
    if (isNaN(num) || num > 999_999_999_999) return null
    return numberToWords(num)
  }

  // Decimal: 3.5
  const decMatch = token.match(/^(\d+)\.(\d+)$/)
  if (decMatch) {
    const intPart = parseInt(decMatch[1])
    const decDigits = decMatch[2]
    return numberToWords(intPart) + ' point ' +
      decDigits.split('').map(d => numberToWords(parseInt(d))).join(' ')
  }

  return null
}

const ORDINAL_SPECIAL = {
  1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth',
  9: 'ninth', 12: 'twelfth',
}

function toOrdinalWord(n) {
  if (ORDINAL_SPECIAL[n]) return ORDINAL_SPECIAL[n]
  if (n < 20) return ONES[n] + 'th'
  if (n < 100 && n % 10 === 0) return TENS[n / 10].replace(/y$/, 'ieth')
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]
    const o = n % 10
    return t + '-' + (ORDINAL_SPECIAL[o] || ONES[o] + 'th')
  }
  // For larger ordinals, just append "th" to the cardinal
  const words = numberToWords(n)
  if (words.endsWith('y')) return words.replace(/y$/, 'ieth')
  return words + 'th'
}

// ── Main expander ───────────────────────────────────────────────────────

// Regex to match contractions (word boundaries, case-insensitive)
const CONTRACTION_RE = new RegExp(
  '\\b(' + Object.keys(CONTRACTIONS)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length) // longest first
    .join('|') + ')\\b',
  'gi'
)

// Regex to match numbers (standalone tokens)
const NUMBER_TOKEN_RE = /(?<!\w)(\$?[0-9][0-9,]*\.?\d*%?(?:st|nd|rd|th)?)(?!\w)/g

/**
 * Expand a transcript text:
 * - Contractions → full words
 * - Numbers/digits → word form
 * Preserves timecodes [00:01:23] and pause markers [2.3s] untouched.
 */
export function expandText(text) {
  if (!text) return ''

  // Step 1: Protect timecodes and pause markers from modification
  const PROTECTED_RE = /(\[\d{2}:\d{2}:\d{2}\]|\[\d+\.?\d*s\])/g
  const protectedSlots = []
  let protected_ = text.replace(PROTECTED_RE, (match) => {
    protectedSlots.push(match)
    return `\x00PROT${protectedSlots.length - 1}\x00`
  })

  // Step 2: Expand contractions (dictionary)
  protected_ = protected_.replace(CONTRACTION_RE, (match) => {
    const expanded = CONTRACTIONS[match.toLowerCase()]
    if (!expanded) return match
    // Preserve capitalization of the first character
    if (match[0] === match[0].toUpperCase()) {
      return expanded[0].toUpperCase() + expanded.slice(1)
    }
    return expanded
  })

  // Step 2b: Catch-all 's → " is" for any remaining <word>'s
  // (covers "one's", "everyone's", "something's", etc.)
  // In spoken transcripts 's is almost always "is", not possessive.
  protected_ = protected_.replace(/\b(\w+)'s\b/gi, (match, word) => {
    // Skip if already expanded by dictionary above (shouldn't happen, but guard)
    if (CONTRACTIONS[match.toLowerCase()]) return match
    return word + ' is'
  })

  // Step 3: Expand numbers
  protected_ = protected_.replace(NUMBER_TOKEN_RE, (match) => {
    const expanded = expandNumber(match)
    return expanded !== null ? expanded : match
  })

  // Step 4: Restore protected tokens
  protected_ = protected_.replace(/\x00PROT(\d+)\x00/g, (_, idx) => {
    return protectedSlots[parseInt(idx)]
  })

  return protected_
}
