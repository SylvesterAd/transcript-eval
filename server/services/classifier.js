/**
 * Deletion reason classifier.
 * Classifies deleted text spans into categories:
 * - filler_word: um, uh, like, you know, basically, etc.
 * - false_start: repeated/rephrased beginnings
 * - meta_commentary: subscribe prompts, sponsor mentions, outros
 * - unclassified: everything else
 */

const FILLER_PATTERNS = [
  /^(um|uh|erm|ah|oh)$/i,
  /^(um|uh|erm|ah)\b/i,
  /\b(um|uh|erm|ah)\b/i,
  /^(you know|I mean|like|basically|actually|literally|honestly|right|so yeah|so)$/i,
  /^(sort of|kind of|I guess|I think)$/i,
]

const FILLER_WORDS_SET = new Set([
  'um', 'uh', 'erm', 'ah', 'oh',
  'like', 'basically', 'actually', 'literally', 'honestly',
  'right', 'so', 'well', 'yeah',
])

const META_PATTERNS = [
  /subscribe/i,
  /like button/i,
  /smash that/i,
  /hit that/i,
  /before we (dive in|get started|begin)/i,
  /make sure to/i,
  /let me know in the comments/i,
  /leave a comment/i,
  /link in the description/i,
  /check out my/i,
  /today's sponsor/i,
  /sponsored by/i,
  /I'll see you in the next one/i,
  /trying to hit \d+K/i,
  /thank you (so much )?for \d+K/i,
  /if you're new here/i,
  /we cover the latest/i,
  /let me know .* how it turned out/i,
  /are you going to upgrade/i,
]

const FALSE_START_PATTERNS = [
  // "I'm going to I'm going to" — repeated phrase
  /(\b\w+(?:\s+\w+){0,3})\s+\1\b/i,
  // "it's it's" — single word repeat
  /\b(\w+)\s+\1\b/i,
  // "that's that's basically"
  /\b(\w+)\s+\1\s+/i,
  // "you're going to need um you're going to need"
  /\bum\s+/i,
  // "can now be um can now be"
  /(\b\w+(?:\s+\w+){1,4})\s+um\s+\1/i,
]

/**
 * Classify a deleted text span.
 * Returns 'filler_word' | 'false_start' | 'meta_commentary' | 'unclassified'
 */
export function classifyDeletion(text) {
  if (!text || !text.trim()) return 'unclassified'
  const trimmed = text.trim()

  // Check filler words first (short spans)
  if (isFillerWord(trimmed)) return 'filler_word'

  // Check meta commentary (longer spans)
  if (isMetaCommentary(trimmed)) return 'meta_commentary'

  // Check false starts
  if (isFalseStart(trimmed)) return 'false_start'

  // Check if it's mostly filler within a larger span
  if (isFillerHeavy(trimmed)) return 'filler_word'

  return 'unclassified'
}

function isFillerWord(text) {
  const lower = text.toLowerCase().trim()

  // Direct match
  if (FILLER_WORDS_SET.has(lower)) return true

  // Pattern match
  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(lower)) return true
  }

  // Very short text that's likely a filler
  if (lower.length <= 3 && /^[a-z]+$/.test(lower)) return true

  return false
}

function isMetaCommentary(text) {
  for (const pattern of META_PATTERNS) {
    if (pattern.test(text)) return true
  }
  return false
}

function isFalseStart(text) {
  // Check for repeated words/phrases
  const words = text.toLowerCase().split(/\s+/)

  // Single word repeated: "it's it's"
  if (words.length >= 2) {
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === words[i + 1] && words[i].length > 1) return true
    }
  }

  // Phrase repeated: "I'm going to I'm going to"
  for (let phraseLen = 2; phraseLen <= Math.floor(words.length / 2); phraseLen++) {
    for (let i = 0; i <= words.length - phraseLen * 2; i++) {
      const phrase1 = words.slice(i, i + phraseLen).join(' ')
      const phrase2 = words.slice(i + phraseLen, i + phraseLen * 2).join(' ')
      if (phrase1 === phrase2) return true
    }
  }

  // "word um word" pattern (restart after filler)
  if (/\b\w+\s+um\s+\w+/i.test(text)) return true

  return false
}

function isFillerHeavy(text) {
  const words = text.toLowerCase().split(/\s+/)
  if (words.length === 0) return false
  const fillerCount = words.filter(w => FILLER_WORDS_SET.has(w)).length
  return fillerCount / words.length >= 0.5
}

/**
 * Classify an array of deletions.
 * Returns the deletions with a `reason` field added.
 */
export function classifyDeletions(deletions) {
  return deletions.map(d => ({
    ...d,
    reason: classifyDeletion(d.text)
  }))
}

/**
 * Compute reason-aware stats from classified deletions.
 */
export function reasonStats(classifiedDeletions) {
  const stats = {
    filler_word: { count: 0, texts: [] },
    false_start: { count: 0, texts: [] },
    meta_commentary: { count: 0, texts: [] },
    unclassified: { count: 0, texts: [] },
    total: classifiedDeletions.length
  }

  for (const d of classifiedDeletions) {
    const reason = d.reason || 'unclassified'
    stats[reason].count++
    stats[reason].texts.push(d.text)
  }

  return stats
}
