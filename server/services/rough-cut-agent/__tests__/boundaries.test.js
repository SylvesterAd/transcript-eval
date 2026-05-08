import { describe, it, expect } from 'vitest'
import { createState } from '../state.js'
import { dispatchTool } from '../tools.js'

// Build a fake acoustic sidecar with controllable shape so we can verify the
// percentile-rank scorer treats quiet-vs-noisy videos comparably.
function fakeAcoustic({
  baselineRms,         // typical speech RMS (dB)
  baselineNoise,       // typical silence/non-speech RMS (dB)
  boundaryAtSeconds,   // where to inject a "real" boundary
  durationSec = 30,
}) {
  const hop = 0.1
  const frames = []
  for (let i = 0; i < durationSec / hop; i++) {
    const t = +(i * hop).toFixed(1)
    // Pre-boundary: speech. Post-boundary: silence-then-speech.
    let rms, voiced
    if (t < boundaryAtSeconds - 1) {
      rms = baselineRms; voiced = 1
    } else if (t < boundaryAtSeconds) {
      rms = baselineNoise; voiced = 0   // 1 second of silence before boundary
    } else if (t < boundaryAtSeconds + 0.1) {
      rms = baselineRms; voiced = 1     // boundary frame
    } else {
      rms = baselineRms; voiced = 1
    }
    frames.push([t, rms, voiced ? 140 : 0, voiced, 1500, 0.05])
  }
  return {
    hop_ms: 100,
    duration_s: durationSec,
    features: ['rms_db', 'f0', 'f0_voiced', 'spectral_centroid', 'zcr'],
    frames,
  }
}

function fakeWords(starts) {
  return starts.map(s => ({ word: 'w', start: s, end: s + 0.3 }))
}

describe('find_acoustic_boundaries', () => {
  it('returns empty when acoustic features are missing', async () => {
    const state = createState({ assembledTranscript: '', wordTimestamps: [] })
    const r = await dispatchTool('find_acoustic_boundaries', {}, state)
    expect(r.available).toBe(false)
  })

  it('detects a boundary in a quiet video (low absolute RMS, big relative drop)', async () => {
    const acoustic = fakeAcoustic({
      baselineRms: -55, baselineNoise: -75,    // very quiet recording
      boundaryAtSeconds: 10,
    })
    // Words: speech ends ~9s, resumes ~10s
    const words = fakeWords([1, 3, 5, 7, 8.5, 10, 12, 15, 18, 22])
    const state = createState({
      assembledTranscript: '',
      wordTimestamps: words,
      acousticFeatures: acoustic,
    })
    const r = await dispatchTool('find_acoustic_boundaries', {}, state)
    expect(r.available).toBe(true)
    expect(r.boundaries.length).toBeGreaterThan(0)
    // Boundary near t=10 should be in results
    const near10 = r.boundaries.find(b => Math.abs(b.t - 10) < 0.5)
    expect(near10).toBeDefined()
  })

  it('detects a comparable boundary in a noisy video (high absolute RMS, same shape)', async () => {
    const acoustic = fakeAcoustic({
      baselineRms: -25, baselineNoise: -45,    // outdoor/noisy: 30dB louder than quiet test
      boundaryAtSeconds: 10,
    })
    const words = fakeWords([1, 3, 5, 7, 8.5, 10, 12, 15, 18, 22])
    const state = createState({
      assembledTranscript: '',
      wordTimestamps: words,
      acousticFeatures: acoustic,
    })
    const r = await dispatchTool('find_acoustic_boundaries', {}, state)
    expect(r.available).toBe(true)
    expect(r.boundaries.length).toBeGreaterThan(0)
    const near10 = r.boundaries.find(b => Math.abs(b.t - 10) < 0.5)
    expect(near10).toBeDefined()
  })

  it('returns boundaries in score order, highest first', async () => {
    const acoustic = fakeAcoustic({
      baselineRms: -32, baselineNoise: -55,
      boundaryAtSeconds: 10,
    })
    const words = fakeWords([1, 3, 5, 7, 8.5, 10, 12])
    const state = createState({
      assembledTranscript: '',
      wordTimestamps: words,
      acousticFeatures: acoustic,
    })
    const r = await dispatchTool('find_acoustic_boundaries', {}, state)
    for (let i = 1; i < r.boundaries.length; i++) {
      expect(r.boundaries[i].score).toBeLessThanOrEqual(r.boundaries[i - 1].score)
    }
  })

  it('includes both relative percentile and absolute raw values per candidate', async () => {
    const acoustic = fakeAcoustic({
      baselineRms: -32, baselineNoise: -55,
      boundaryAtSeconds: 10,
    })
    const words = fakeWords([1, 3, 5, 7, 8.5, 10, 12])
    const state = createState({
      assembledTranscript: '',
      wordTimestamps: words,
      acousticFeatures: acoustic,
    })
    const r = await dispatchTool('find_acoustic_boundaries', {}, state)
    if (r.boundaries.length > 0) {
      const b = r.boundaries[0]
      expect(b.t).toBeTypeOf('number')
      expect(b.type).toBeTypeOf('string')
      expect(b.score).toBeTypeOf('number')
      expect(b.signals).toBeDefined()       // percentile-rank signals
      expect(b.raw).toBeDefined()           // absolute values for the agent's reason
    }
  })

  it('respects scope filter', async () => {
    const acoustic = fakeAcoustic({
      baselineRms: -32, baselineNoise: -55,
      boundaryAtSeconds: 10, durationSec: 30,
    })
    const words = fakeWords([1, 3, 5, 7, 8.5, 10, 12, 15, 18, 22, 25])
    const state = createState({
      assembledTranscript: '',
      wordTimestamps: words,
      acousticFeatures: acoustic,
    })
    const all = await dispatchTool('find_acoustic_boundaries', {}, state)
    const scoped = await dispatchTool('find_acoustic_boundaries', {
      scope: { start: 12, end: 30 }
    }, state)
    expect(scoped.boundaries.every(b => b.t >= 12 && b.t <= 30)).toBe(true)
    expect(scoped.boundaries.length).toBeLessThanOrEqual(all.boundaries.length)
  })
})
