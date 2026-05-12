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

  it('with words: cumulative-cut offset puts the first kept segment at timeline 0', () => {
    // Replicates the route's cutsBefore helper to verify timelineStart math.
    const effective = computeEffectiveCuts(cuts, [], words)
    const kept = complementSegments(effective, totalDuration)
    const cutsBefore = (sourceTime) => {
      let sum = 0
      for (const c of effective) {
        if (c.end <= sourceTime) sum += (c.end - c.start)
        else break
      }
      return sum
    }
    const first = kept[0]
    const offset = cutsBefore(first.start)
    expect(first.start - offset).toBeCloseTo(0, 6)
    expect(first.end - offset).toBeCloseTo(totalDuration - 4.30, 6)
  })
})
