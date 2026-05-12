import { describe, it, expect, vi } from 'vitest'

// db.js is imported transitively by broll.js; stub it so the import side-
// effects don't try to hit a real DB.
vi.mock('../../db.js', () => ({
  default: {
    prepare: () => ({
      run: () => ({ changes: 0 }),
      get: () => null,
      all: () => [],
    }),
    pool: { connect: () => Promise.resolve({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

const { computeEffectiveCuts } = await import('../../services/broll.js')

// Mirror the route's complementSegments — exercise it directly without
// importing the route (avoids a potentially heavy import chain).
function complementSegments(cutsArr, totalDuration) {
  const segs = []
  let cursor = 0
  for (const c of cutsArr) {
    if (c.start > cursor + 0.001) segs.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < totalDuration - 0.001) segs.push({ start: cursor, end: totalDuration })
  return segs
}

describe('complementSegments', () => {
  it('returns whole timeline as one segment when no cuts', () => {
    expect(complementSegments([], 60)).toEqual([{ start: 0, end: 60 }])
  })

  it('splits around a single cut', () => {
    expect(complementSegments([{ start: 20, end: 30 }], 60)).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 60 },
    ])
  })

  it('handles cut at start', () => {
    expect(complementSegments([{ start: 0, end: 10 }], 60)).toEqual([
      { start: 10, end: 60 },
    ])
  })

  it('handles cut at end', () => {
    expect(complementSegments([{ start: 50, end: 60 }], 60)).toEqual([
      { start: 0, end: 50 },
    ])
  })

  it('multiple cuts produce N+1 segments minus boundary segments', () => {
    expect(complementSegments(
      [{ start: 10, end: 20 }, { start: 30, end: 40 }],
      60,
    )).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
      { start: 40, end: 60 },
    ])
  })

  it('returns empty array when cuts cover the entire duration', () => {
    expect(complementSegments([{ start: 0, end: 60 }], 60)).toEqual([])
  })
})

// Regression scenario: project 367 / video 511 / export plan-511-1778229647462.
// Two cuts span a word-less gap. The /brolls/edit view and rough cut UI
// already collapse them via word-aware merge; the export had been calling
// computeEffectiveCuts without the words argument, so the cuts stayed
// split and produced tiny "kept" slivers in the FCP XML's A-roll track
// (a 3-frame clipitem at source 1.47–1.57s placed at timeline 0–0.10s).
//
// This test pipes the route's pure-function chain end-to-end:
//   computeEffectiveCuts(cuts, exclusions, words) → complementSegments(...)
// and asserts no sliver kept segment survives.
describe('A-roll kept-segments (word-aware merge wired into export)', () => {
  // Two ai-silence cuts left a 100ms gap at 1.47–1.57s of the source A-roll
  // with no transcript word inside it; everything before the first kept
  // word [4.30, ...] should be a single merged cut. Without word-aware
  // merge the chain emits a sliver at [1.47, 1.57].
  const cuts = [
    { id: 'cut-ai-silence-a', source: 'ai-silence', start: 0, end: 1.47 },
    { id: 'cut-ai-silence-b', source: 'ai-silence', start: 1.57, end: 4.30 },
  ]
  const words = [
    { start: 4.30, end: 4.62 }, // first transcribed word after the gap
    { start: 4.65, end: 4.91 },
  ]
  const totalDuration = 60

  it('without words: 50ms threshold leaves a sliver kept segment (the bug)', () => {
    const effective = computeEffectiveCuts(cuts, [])
    expect(effective).toEqual([
      { start: 0, end: 1.47 },
      { start: 1.57, end: 4.30 },
    ])
    const kept = complementSegments(effective, totalDuration)
    // The leading sliver — what users saw as a 3-frame clipitem at timeline 0.
    expect(kept[0]).toEqual({ start: 1.47, end: 1.57 })
    expect(kept[1].start).toBe(4.30)
  })

  it('with words: word-aware merge collapses the gap, no sliver in kept segments', () => {
    const effective = computeEffectiveCuts(cuts, [], words)
    expect(effective).toEqual([{ start: 0, end: 4.30 }])
    const kept = complementSegments(effective, totalDuration)
    expect(kept).toEqual([{ start: 4.30, end: totalDuration }])
  })

})

// Hold-position placement: each kept A-roll segment is emitted at its
// original-time position on the NLE timeline (timelineStart === sourceStart).
// Cuts surface as visible gaps on the V1 track. This mirrors the rough cut's
// original-time ruler — scrubbing the NLE to second N reveals source second
// N of the A-roll. Previously the route applied ripple-delete via a
// cumulative-cuts offset; that produced a continuous V1 track but the
// timeline no longer matched the rough cut visually.
describe('A-roll kept-segments emit with hold-position (timelineStart = sourceStart)', () => {
  // Same project-367 fixture as above — two cuts, word-aware merge.
  const cuts = [
    { id: 'cut-ai-silence-a', source: 'ai-silence', start: 0, end: 1.47 },
    { id: 'cut-ai-silence-b', source: 'ai-silence', start: 1.57, end: 4.30 },
  ]
  const words = [{ start: 4.30, end: 4.62 }, { start: 4.65, end: 4.91 }]
  const totalDuration = 60

  // Mirrors the route's segment build (server/routes/export-xml.js).
  function buildArollSegments(effectiveCuts, durationSec) {
    const kept = complementSegments(effectiveCuts, durationSec)
    return kept.map(s => ({
      sourceStart: s.start,
      sourceEnd: s.end,
      timelineStart: s.start,
      timelineEnd: s.end,
    }))
  }

  it('places the first kept segment at its source-time, not at timeline 0', () => {
    const effective = computeEffectiveCuts(cuts, [], words)
    const segs = buildArollSegments(effective, totalDuration)
    expect(segs).toHaveLength(1)
    expect(segs[0].timelineStart).toBe(4.30)
    expect(segs[0].timelineEnd).toBe(totalDuration)
    expect(segs[0].timelineStart).toBe(segs[0].sourceStart)
    expect(segs[0].timelineEnd).toBe(segs[0].sourceEnd)
  })

  it('leaves a timeline gap equal to each cut between consecutive kept segments', () => {
    // Two cuts: [0, 4.29] and [60.24, 61.53] → three kept segments.
    const multiCuts = [
      { source: 'transcript', start: 0, end: 1.47 },
      { source: 'ai-silence', start: 1.57, end: 4.29 },
      { source: 'ai-silence', start: 60.24, end: 61.53 },
    ]
    const effective = computeEffectiveCuts(multiCuts, [], words)
    const segs = buildArollSegments(effective, 120)
    expect(segs).toHaveLength(2)
    // First segment occupies [4.29, 60.24] in both source and timeline.
    expect(segs[0].timelineStart).toBeCloseTo(4.29, 6)
    expect(segs[0].timelineEnd).toBeCloseTo(60.24, 6)
    // Gap on the timeline from 60.24 → 61.53 — that's the second cut visible
    // as a hole on V1 in the NLE.
    expect(segs[1].timelineStart).toBeCloseTo(61.53, 6)
    expect(segs[1].timelineEnd).toBeCloseTo(120, 6)
    expect(segs[1].timelineStart - segs[0].timelineEnd).toBeCloseTo(1.29, 6)
  })

  it('source slice and timeline placement use the same numbers', () => {
    const effective = computeEffectiveCuts(cuts, [], words)
    const segs = buildArollSegments(effective, totalDuration)
    for (const s of segs) {
      expect(s.timelineStart).toBe(s.sourceStart)
      expect(s.timelineEnd).toBe(s.sourceEnd)
    }
  })
})
