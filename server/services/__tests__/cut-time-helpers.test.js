import { describe, it, expect, vi } from 'vitest'

// broll.js → llm-runner.js / db imports require a live DATABASE_URL at module
// load. Mock the db module so module load succeeds in unit tests. Mirrors the
// pattern used by broll-audio-stage-filter.test.js.
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockReturnValue({ changes: 0 }),
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
    })),
  },
}))

import { getCumulativeCutOffset, shiftOriginalToPostCut } from '../broll.js'

describe('getCumulativeCutOffset', () => {
  it('returns 0 when no cuts precede time', () => {
    const cuts = [{ start: 100, end: 110 }]
    expect(getCumulativeCutOffset(50, cuts)).toBe(0)
  })

  it('returns total duration of cuts ending before time', () => {
    const cuts = [{ start: 10, end: 15 }, { start: 30, end: 35 }]
    expect(getCumulativeCutOffset(50, cuts)).toBe(10)
  })

  it('excludes cuts whose end equals time (half-open at end)', () => {
    const cuts = [{ start: 10, end: 15 }]
    expect(getCumulativeCutOffset(15, cuts)).toBe(0)
  })

  it('handles empty cuts array', () => {
    expect(getCumulativeCutOffset(50, [])).toBe(0)
  })
})

describe('shiftOriginalToPostCut', () => {
  it('subtracts cumulative offset from original time', () => {
    const cuts = [{ start: 10, end: 15 }, { start: 30, end: 35 }]
    expect(shiftOriginalToPostCut(50, cuts)).toBe(40)
  })

  it('returns original time when no preceding cuts', () => {
    expect(shiftOriginalToPostCut(5, [{ start: 10, end: 15 }])).toBe(5)
  })
})
