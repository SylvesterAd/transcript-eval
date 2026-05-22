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

/**
 * Re-derive, at remap time, how trustworthy a stored `anchor_word_idx` is — so
 * the caller can decide whether the word position may OVERRIDE the LLM's
 * emitted timecode (not merely refine it within a small gate).
 *
 *   - verbatim: words[idx..idx+N-1] reproduce the FULL normalized anchor
 *     phrase. This is the path findAnchorWordIdx takes for a real phrase match;
 *     its first-token fallback (which can land 100+s away — the reason
 *     materializePlacementRemap gates word-snap to ±10s) does NOT satisfy this.
 *   - unique: the full phrase occurs exactly once across `words`, so idx is
 *     unambiguous. Repeated phrases stay gated (the LLM timecode disambiguates
 *     which occurrence was meant).
 *
 * A confident anchor (verbatim && unique && multi-word) can be trusted over the
 * LLM timecode even when they disagree wildly — which rescues plans where the
 * model botched the numeric timecode but still anchored to the correct words.
 * `wordCount` is exposed so the caller can require a multi-word phrase: a lone
 * unique word is too weak to override a far-off LLM time.
 *
 * Returns { verbatim, unique, wordCount }.
 */
export function anchorMatchInfo(words, idx, audioAnchor) {
  if (!Array.isArray(words) || !words.length) return { verbatim: false, unique: false, wordCount: 0 }
  const target = normalize(audioAnchor)
  if (!target) return { verbatim: false, unique: false, wordCount: 0 }
  const tokens = target.split(' ')
  const N = tokens.length
  const matchesAt = (i) => {
    if (i < 0 || i + N > words.length) return false
    for (let j = 0; j < N; j++) {
      if (normalize(words[i + j].word) !== tokens[j]) return false
    }
    return true
  }
  const verbatim = Number.isInteger(idx) && matchesAt(idx)
  let count = 0
  for (let i = 0; i <= words.length - N; i++) {
    if (matchesAt(i)) { count++; if (count > 1) break }
  }
  return { verbatim, unique: count === 1, wordCount: N }
}
