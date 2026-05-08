// server/services/rough-cut-agent/boundaries.js
//
// Per-video relative boundary detection. Computes a video's own distribution
// of acoustic signals (typical speech RMS, typical pause duration, etc.) and
// flags candidates that are anomalous FOR THIS VIDEO — not against fixed
// dB / second thresholds. A quiet podcast and a noisy outdoor recording both
// surface the same semantic boundaries despite very different absolute numbers.

function percentileOf(sortedAsc, value) {
  // Returns percentile rank (0..100) of `value` in `sortedAsc`.
  if (sortedAsc.length === 0) return 0
  let lo = 0, hi = sortedAsc.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedAsc[mid] < value) lo = mid + 1
    else hi = mid
  }
  return (lo / sortedAsc.length) * 100
}

function median(sortedAsc) {
  if (sortedAsc.length === 0) return 0
  const m = Math.floor(sortedAsc.length / 2)
  return sortedAsc.length % 2 ? sortedAsc[m] : (sortedAsc[m - 1] + sortedAsc[m]) / 2
}

/**
 * Compute per-video baselines from frames + word timings. Lazy — call once
 * per agent run, cache the result.
 *
 * Returns:
 *   {
 *     rms_speech_med, rms_speech_iqr,    // typical voiced-speech energy
 *     pause_p50, pause_p90, pause_p99,    // pause-duration distribution
 *     rms_drop_dist: number[] (sorted),   // word-to-word drop magnitudes
 *     pause_dist:    number[] (sorted),   // pause durations between words
 *   }
 */
export function computeBaselines(frames, words) {
  // Energy distribution across voiced speech frames.
  const voicedRms = frames.filter(f => f[3] === 1).map(f => f[1]).sort((a, b) => a - b)
  const rms_speech_med = median(voicedRms)
  const q1 = voicedRms[Math.floor(voicedRms.length * 0.25)] ?? 0
  const q3 = voicedRms[Math.floor(voicedRms.length * 0.75)] ?? 0

  // Word-edge distributions.
  const pauseDurations = []
  const rmsDrops = []
  const hop_s = 0.1
  const frameAt = (t) => {
    const i = Math.max(0, Math.min(frames.length - 1, Math.round(t / hop_s)))
    return frames[i]
  }
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]
    const curr = words[i]
    const pause = curr.start - prev.end
    if (pause > 0) pauseDurations.push(pause)

    // Average RMS over the previous word vs over the pause that follows it
    const prevFrames = frames.filter(f => f[0] >= prev.start && f[0] < prev.end)
    const pauseFrames = frames.filter(f => f[0] >= prev.end && f[0] < curr.start)
    if (prevFrames.length && pauseFrames.length) {
      const prevRms = prevFrames.reduce((a, f) => a + f[1], 0) / prevFrames.length
      const pauseRms = pauseFrames.reduce((a, f) => a + f[1], 0) / pauseFrames.length
      rmsDrops.push(prevRms - pauseRms)   // positive = energy fell into the pause
    }
  }
  pauseDurations.sort((a, b) => a - b)
  rmsDrops.sort((a, b) => a - b)

  return {
    rms_speech_med,
    rms_speech_iqr: [q1, q3],
    pause_dist: pauseDurations,
    rms_drop_dist: rmsDrops,
    pause_p50: pauseDurations[Math.floor(pauseDurations.length * 0.50)] ?? 0,
    pause_p90: pauseDurations[Math.floor(pauseDurations.length * 0.90)] ?? 0,
    pause_p99: pauseDurations[Math.floor(pauseDurations.length * 0.99)] ?? 0,
    rms_drop_p50: rmsDrops[Math.floor(rmsDrops.length * 0.50)] ?? 0,
    rms_drop_p95: rmsDrops[Math.floor(rmsDrops.length * 0.95)] ?? 0,
  }
}

/**
 * Find boundary candidates by scoring each word-edge against this video's own
 * distributions. Returns sorted top-N by score (high → low).
 *
 * A "boundary" is a word-edge where one or more of:
 *   - rms_drop_before is in the top tail of this video's drop distribution
 *   - pause_before is in the top tail of this video's pause distribution
 *   - the pause window has voicing collapse (voiced_ratio ≈ 0 across it)
 *
 * Score = max of percentile-based subscores. Each subscore in [0, 1].
 *
 * @param {Object[]} frames    - acoustic frame array (5-tuple per row)
 * @param {Object[]} words     - word timestamp array
 * @param {Object}   baselines - precomputed per-video distributions
 * @param {Object}   opts
 * @param {{start, end}} [opts.scope]
 * @param {number}   [opts.minScore=0.7]    - boundaries below this are dropped
 */
export function findAcousticBoundaries(frames, words, baselines, opts = {}) {
  const { scope, minScore = 0.7 } = opts
  const out = []
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]
    const curr = words[i]
    if (scope && (curr.start < scope.start || curr.start > scope.end)) continue

    const pause = curr.start - prev.end
    if (pause < 0) continue
    const prevFrames = frames.filter(f => f[0] >= prev.start && f[0] < prev.end)
    const pauseFrames = frames.filter(f => f[0] >= prev.end && f[0] < curr.start)
    if (!pauseFrames.length || !prevFrames.length) continue

    const prevRms = prevFrames.reduce((a, f) => a + f[1], 0) / prevFrames.length
    const pauseRms = pauseFrames.reduce((a, f) => a + f[1], 0) / pauseFrames.length
    const rmsDrop = prevRms - pauseRms
    const voicedRatio = pauseFrames.reduce((a, f) => a + (f[3] || 0), 0) / pauseFrames.length

    // Percentile-rank each signal against the video's own distribution.
    // High percentile = "this is in the top N% for THIS video" = boundary-like.
    const rmsDropPctl = percentileOf(baselines.rms_drop_dist, rmsDrop) / 100
    const pausePctl   = percentileOf(baselines.pause_dist, pause) / 100
    const voicingScore = 1 - voicedRatio   // 1 = fully unvoiced pause

    // Each criterion alone can flag a candidate. Score is the max.
    const score = Math.max(rmsDropPctl, pausePctl, voicingScore)
    if (score < minScore) continue

    // Decide a primary type label from the dominant signal.
    let type = 'soft_boundary'
    if (voicingScore > 0.85 && pausePctl > 0.85) type = 'speech_resume_after_silence'
    else if (rmsDropPctl > 0.90) type = 'energy_drop'
    else if (pausePctl > 0.90) type = 'long_pause_before'
    else if (voicingScore > 0.80) type = 'voicing_collapse'

    out.push({
      t: +curr.start.toFixed(3),
      word_at: curr.word,
      type,
      score: +score.toFixed(3),
      signals: {
        rms_drop_pctl:    +(rmsDropPctl * 100).toFixed(1),
        pause_duration_pctl: +(pausePctl * 100).toFixed(1),
        pause_voiced_ratio: +voicedRatio.toFixed(2),
      },
      raw: {
        rms_before:       +prevRms.toFixed(1),
        rms_pause:        +pauseRms.toFixed(1),
        rms_drop:         +rmsDrop.toFixed(1),
        pause_duration:   +pause.toFixed(2),
      },
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}
