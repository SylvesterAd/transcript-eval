import crypto from 'node:crypto'
import { postCutTime } from './time-translation.js'
import { parseTimecode } from './placement-match.js'

/**
 * Materialize a per-placement remap from LLM-emitted timecodes + effective cuts.
 *
 * Trusts the timecodes the LLM emitted during plan generation as the canonical
 * original-time anchor positions. Does NOT re-run anchor-text matching at runtime —
 * matching is the LLM's job (once, during plan generation). At display time we
 * just shift those original-time positions through the current effective cuts to
 * get the placement's post-cut time.
 *
 * Pure function — no DB, no I/O. Caller is responsible for computing
 * `effectiveCuts` (via computeEffectiveCuts in broll.js).
 *
 * `words` is unused but kept in the signature for backwards compatibility with
 * callers from earlier iterations.
 *
 * Returns Map<uuid, { start_seconds, end_seconds, anchor_state }>.
 *
 * `anchor_state`: 'shifted' | 'overlap_squeezed'.
 */
export function materializePlacementRemap(placements, effectiveCuts, words) {
  const MIN_DURATION = 0.5

  const resolved = []
  for (const p of placements) {
    if (!p.uuid) continue

    const startOrig = parseTimecode(p.start)
    const endOrig = parseTimecode(p.end)
    const origDur = endOrig - startOrig
    const dur = origDur > 0 ? Math.max(MIN_DURATION, origDur) : MIN_DURATION

    const startSec = postCutTime(startOrig, effectiveCuts)
    const endSec = startSec + dur

    resolved.push({ uuid: p.uuid, startSec, endSec, state: 'shifted' })
  }

  // Sort by start, trim overlaps, flag squeezed.
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
