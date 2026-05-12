import crypto from 'node:crypto'
import { postCutTime } from './time-translation.js'
import { parseTimecode } from './placement-match.js'

/**
 * Find the cut whose interval (start, end) strictly contains `t`. Returns null
 * if `t` lies outside every cut.
 */
function cutContaining(t, effectiveCuts) {
  for (const c of effectiveCuts) {
    if (t >= c.start && t < c.end) return c
  }
  return null
}

/**
 * Same as cutContaining but for the END side: a cut with c.start < t <= c.end
 * is considered to "contain" the end (because the placement's end inside that
 * cut means the visible portion stops at the cut's start).
 */
function cutContainingEnd(t, effectiveCuts) {
  for (const c of effectiveCuts) {
    if (t > c.start && t <= c.end) return c
  }
  return null
}

/**
 * Materialize a per-placement remap from LLM-emitted timecodes + effective cuts.
 *
 * Start-time precedence (first match wins):
 *   1. words[p.anchor_word_idx].start — anchor_word_idx is computed at plan
 *      generation time against the same raw transcript, so it disambiguates
 *      repeated phrases (the LLM picked which occurrence it meant). Using
 *      the word's actual start gets sub-second precision the LLM's whole-
 *      second timecode lacks. End is offset by the LLM-intended duration
 *      (parseTimecode(p.end) - parseTimecode(p.start)).
 *   2. parseTimecode(p.start) — fallback when anchor_word_idx is missing,
 *      -1, out of range, or its word lacks a finite start.
 *
 * Then for each placement:
 *   - If start lands inside a cut → push start forward to the cut's end (the
 *     next visible moment).
 *   - If end lands inside a cut → pull end back to the cut's start (the last
 *     visible moment).
 *   - If those adjustments leave start >= end (placement is fully consumed by
 *     a cut) → mark hidden:true so the caller skips it. The placement returns
 *     to view automatically when the user shrinks/removes the offending cut.
 *   - Shift the (clipped) original-time range through the effective cuts via
 *     postCutTime to get post-cut start/end. Cuts that lie *between* the
 *     adjusted start and end naturally collapse via postCutTime (placement
 *     visually shortens to its kept-content duration).
 *
 * Pure function — no DB, no I/O. Caller is responsible for computing
 * `effectiveCuts` (via computeEffectiveCuts in broll.js).
 *
 * Returns Map<uuid, { start_seconds, end_seconds, anchor_state, hidden? }>.
 *
 * `anchor_state`: 'word_snapped' | 'shifted' | 'overlap_squeezed' | 'cut_clipped'.
 */
export function materializePlacementRemap(placements, effectiveCuts, words) {
  const MIN_DURATION = 0.5
  const wordsList = Array.isArray(words) ? words : []

  const resolved = []
  for (const p of placements) {
    if (!p.uuid) continue

    const llmStart = parseTimecode(p.start)
    const llmEnd = parseTimecode(p.end)
    const llmDuration = llmEnd - llmStart

    // Prefer the actual transcript word position when the LLM-assigned
    // anchor_word_idx points to a real word. Falls back to the LLM timecode
    // for legacy placements (no idx), unmatched anchors (idx === -1), or
    // post-edit drift (idx now out of range).
    const idx = p.anchor_word_idx
    const idxValid =
      Number.isInteger(idx) &&
      idx >= 0 &&
      idx < wordsList.length &&
      Number.isFinite(wordsList[idx]?.start)
    const usedWordSnap = idxValid
    const startOrig = usedWordSnap ? wordsList[idx].start : llmStart
    const endOrig = usedWordSnap ? startOrig + llmDuration : llmEnd

    // Clip the placement to the visible (non-cut) portion of the timeline.
    const startCut = cutContaining(startOrig, effectiveCuts)
    const endCut = cutContainingEnd(endOrig, effectiveCuts)
    const adjStart = startCut ? startCut.end : startOrig
    const adjEnd = endCut ? endCut.start : endOrig

    if (adjStart >= adjEnd) {
      // Placement is fully inside a cut (or both adjustments collide). Hide
      // it from the timeline; it'll reappear on next remap when the cut
      // changes via the existing hash-diff trigger.
      resolved.push({ uuid: p.uuid, hidden: true })
      continue
    }

    const startSec = postCutTime(adjStart, effectiveCuts)
    const endSec = postCutTime(adjEnd, effectiveCuts)
    const dur = Math.max(MIN_DURATION, endSec - startSec)
    const wasClipped = (adjStart !== startOrig) || (adjEnd !== endOrig)

    let state
    if (wasClipped) state = 'cut_clipped'
    else if (usedWordSnap) state = 'word_snapped'
    else state = 'shifted'

    resolved.push({
      uuid: p.uuid,
      startSec,
      endSec: startSec + dur,
      state,
    })
  }

  // Sort visible placements by start, trim overlaps, flag squeezed.
  const visible = resolved.filter(r => !r.hidden)
  visible.sort((a, b) => a.startSec - b.startSec)
  for (let i = 0; i < visible.length - 1; i++) {
    const cur = visible[i]
    const nxt = visible[i + 1]
    if (cur.endSec > nxt.startSec) {
      cur.endSec = nxt.startSec
      if (cur.endSec - cur.startSec < MIN_DURATION) {
        cur.state = 'overlap_squeezed'
      }
    }
  }

  const out = new Map()
  for (const r of resolved) {
    if (r.hidden) {
      out.set(r.uuid, { hidden: true })
    } else {
      out.set(r.uuid, { start_seconds: r.startSec, end_seconds: r.endSec, anchor_state: r.state })
    }
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
