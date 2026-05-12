import { describe, it, expect, vi } from 'vitest'

// db.js is imported transitively by broll.js; stub it so the import side-
// effects (UPDATE experiment_runs at module load) don't try to hit a real DB.
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

const { computeEffectiveCuts } = await import('../broll.js')

describe('computeEffectiveCuts', () => {
  it('returns empty for null/empty input', () => {
    expect(computeEffectiveCuts(null)).toEqual([])
    expect(computeEffectiveCuts([])).toEqual([])
  })

  it('filters zero-width razor markers', () => {
    expect(computeEffectiveCuts([{ start: 10, end: 10 }])).toEqual([])
    expect(computeEffectiveCuts([{ start: 10, end: 10.005 }])).toEqual([])
  })

  it('merges adjacent cuts within 50ms basic threshold', () => {
    const out = computeEffectiveCuts([
      { start: 10, end: 12 },
      { start: 12.04, end: 14 },
    ])
    expect(out).toEqual([{ start: 10, end: 14 }])
  })

  it('keeps non-adjacent cuts separate without word context', () => {
    const out = computeEffectiveCuts([
      { start: 10, end: 12 },
      { start: 13, end: 14 },
    ])
    expect(out).toEqual([{ start: 10, end: 12 }, { start: 13, end: 14 }])
  })

  it('word-aware merge: collapses adjacent cuts when no transcript word in the gap', () => {
    // The project 367 case: ai-silence ends at 176.23, user's Backspace cut
    // starts at 176.43. "[clears throat]" word starts AT 176.48 — outside
    // the padded gap (176.18, 176.48). No word fits → merge.
    const cuts = [
      { start: 175.69, end: 176.23 },
      { start: 176.43, end: 178.15 },
    ]
    const words = [
      { start: 175.08, end: 175.519 },
      { start: 176.48, end: 177.74 },
      { start: 178.22, end: 178.46 },
    ]
    expect(computeEffectiveCuts(cuts, [], words)).toEqual([{ start: 175.69, end: 178.15 }])
  })

  it('word-aware merge: keeps cuts separate when a word fits inside the gap', () => {
    const cuts = [
      { start: 10, end: 12 },
      { start: 14, end: 16 },
    ]
    const words = [{ start: 12.5, end: 13.5 }]
    expect(computeEffectiveCuts(cuts, [], words)).toEqual([
      { start: 10, end: 12 },
      { start: 14, end: 16 },
    ])
  })

  it('exclusions still carve a kept sub-region out of a word-merged region', () => {
    const cuts = [
      { start: 10, end: 12 },
      { start: 13, end: 15 },
    ]
    const exclusions = [{ start: 11, end: 14 }]
    const out = computeEffectiveCuts(cuts, exclusions, [])
    expect(out).toEqual([
      { start: 10, end: 11 },
      { start: 14, end: 15 },
    ])
  })

  it('legacy callers (no words arg) use the basic 50ms merge only', () => {
    const out = computeEffectiveCuts([
      { start: 10, end: 12 },
      { start: 13, end: 15 },
    ])
    expect(out).toEqual([{ start: 10, end: 12 }, { start: 13, end: 15 }])
  })
})
