import crypto from 'node:crypto'
import { postCutTime } from './time-translation.js'
import { parseTimecode } from './placement-match.js'

const isInCut = (t, effectiveCuts) =>
  effectiveCuts.some(c => t >= c.start && t < c.end)

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Fuzzy-match audio_anchor against raw words, skipping any word inside an
 * effective cut. Returns the matched word's `start` (original time) or null.
 *
 * Mirrors the scoring loop from placement-match.js:matchPlacementsToTranscript
 * but with NO time window (anchor may be hundreds of seconds away from the
 * LLM-emitted timecode after our original→post-cut shift) and a cut-skip
 * filter on each candidate.
 */
function fuzzyMatchAnchorOriginalTime(audioAnchor, words, effectiveCuts) {
  const target = normalize(audioAnchor)
  if (!target) return null
  const targetTokens = target.split(' ')
  const N = targetTokens.length

  let bestScore = 0
  let bestStart = null

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (isInCut(w.start, effectiveCuts)) continue

    const phraseWords = []
    for (let j = i; j < Math.min(i + N + 2, words.length); j++) {
      phraseWords.push(normalize(words[j].word))
    }
    const phrase = phraseWords.join(' ')

    let score = 0
    let phraseIdx = 0
    for (const aw of targetTokens) {
      const found = phrase.indexOf(aw, phraseIdx)
      if (found >= 0) { score++; phraseIdx = found + aw.length }
    }

    if (score > bestScore) {
      bestScore = score
      bestStart = w.start
    }
  }

  // Require at least one matched token (any score > 0). Earlier match wins
  // on ties via the strict `>` above.
  return bestStart
}

/**
 * Materialize a per-placement remap from anchor + effective cuts.
 *
 * Pure function — no DB, no I/O. Caller is responsible for computing
 * `effectiveCuts` (via computeEffectiveCuts in broll.js) and providing the
 * raw transcript `words` ([{word,start,end}, ...]).
 *
 * Returns Map<uuid, { start_seconds, end_seconds, anchor_state }>.
 *
 * `anchor_state`: 'idx' | 'fuzzy' | 'in_cut' | 'orphaned' | 'overlap_squeezed'.
 */
export function materializePlacementRemap(placements, effectiveCuts, words) {
  const MIN_DURATION = 0.5

  // Pass 1 — anchor resolve + initial post-cut times + 0.5s minimum.
  const resolved = []
  for (const p of placements) {
    if (!p.uuid) continue

    let anchorOriginal = null
    let state = null

    if (typeof p.anchor_word_idx === 'number' && p.anchor_word_idx >= 0) {
      const w = words[p.anchor_word_idx]
      if (!w) state = 'orphaned'
      else if (isInCut(w.start, effectiveCuts)) state = 'in_cut'
      else { anchorOriginal = w.start; state = 'idx' }
    }

    if (anchorOriginal == null) {
      const fuzzy = fuzzyMatchAnchorOriginalTime(p.audio_anchor, words, effectiveCuts)
      if (fuzzy != null) {
        anchorOriginal = fuzzy
        state = 'fuzzy'
      } else if (state === null) {
        state = 'orphaned'
      }
    }

    let startSec, endSec
    if (anchorOriginal != null) {
      startSec = postCutTime(anchorOriginal, effectiveCuts)
      const origDur = parseTimecode(p.end) - parseTimecode(p.start)
      endSec = startSec + Math.max(MIN_DURATION, origDur > 0 ? origDur : MIN_DURATION)
    } else {
      startSec = parseTimecode(p.start)
      endSec = parseTimecode(p.end)
      if (endSec - startSec < MIN_DURATION) endSec = startSec + MIN_DURATION
    }

    resolved.push({ uuid: p.uuid, startSec, endSec, state })
  }

  // Pass 2 — sort by start, trim overlaps, flag squeezed.
  resolved.sort((a, b) => a.startSec - b.startSec)
  for (let i = 0; i < resolved.length - 1; i++) {
    const cur = resolved[i]
    const nxt = resolved[i + 1]
    if (cur.endSec > nxt.startSec) {
      cur.endSec = nxt.startSec
      if (cur.endSec - cur.startSec < MIN_DURATION) {
        cur.state = 'overlap_squeezed'
      }
    }
  }

  const out = new Map()
  for (const r of resolved) {
    out.set(r.uuid, { start_seconds: r.startSec, end_seconds: r.endSec, anchor_state: r.state })
  }
  return out
}

/**
 * Stable hash of (cuts, exclusions). Reorderings produce the same hash;
 * any change to start/end times or exclusion content produces a different
 * hash. Cut ids are ignored — only timing matters for the remap result.
 */
export function cutsHash(cuts, exclusions) {
  const norm = (arr) => (arr || []).slice()
    .sort((a, b) => (a.start - b.start) || (a.end - b.end))
    .map(c => [c.start, c.end])
  const payload = JSON.stringify({ cuts: norm(cuts), exclusions: norm(exclusions) })
  return crypto.createHash('sha1').update(payload).digest('hex')
}
