function normalize(s) {
  return String(s || '').toLowerCase().replace(/[,.;:?!"'`’]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Find the index of the first word in `words` that begins the phrase
 * `audioAnchor`. Whole-word match, case-insensitive, punctuation-insensitive.
 *
 * If the full phrase doesn't match anywhere, falls back to matching just the
 * first token of the anchor (covers single-word anchors and partial-phrase
 * anchors where later words drift slightly).
 *
 * Returns -1 if no match found, or on empty/null input.
 *
 * Tie-breaker for ambiguous phrases: returns earliest occurrence (lowest
 * index, equivalent to nearest-to-t=0 since words are time-sorted).
 */
export function findAnchorWordIdx(words, audioAnchor) {
  if (!Array.isArray(words) || !words.length) return -1
  const target = normalize(audioAnchor)
  if (!target) return -1
  const targetTokens = target.split(' ')
  const N = targetTokens.length
  for (let i = 0; i <= words.length - N; i++) {
    let ok = true
    for (let j = 0; j < N; j++) {
      if (normalize(words[i + j].word) !== targetTokens[j]) { ok = false; break }
    }
    if (ok) return i
  }
  // Fallback: match just the first targetToken (single-word anchor or partial phrase).
  // Allow prefix-equivalence so contractions like "There's" → "theres" still
  // align with the bare word "there" in the transcript (and vice versa).
  // The bare-prefix relaxation is what lets a contraction-bearing anchor
  // recover when the post-strip token ("theres") doesn't equal any single
  // transcript word ("there", "is", ...) but is built by concatenation.
  if (N >= 1) {
    const first = targetTokens[0]
    for (let i = 0; i < words.length; i++) {
      const w = normalize(words[i].word)
      if (w === first || w.startsWith(first) || first.startsWith(w)) return i
    }
  }
  return -1
}
