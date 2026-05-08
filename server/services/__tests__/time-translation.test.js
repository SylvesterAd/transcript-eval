import { describe, it, expect } from 'vitest'
import { postCutTime, unshiftPostCutTime } from '../time-translation.js'

describe('postCutTime', () => {
  const cuts = [{ start: 10, end: 15 }, { start: 20, end: 25 }]

  it('identity for time before any cut', () => {
    expect(postCutTime(5, cuts)).toBe(5)
  })

  it('shifts time inside a cut to cut.start in post-cut domain (collapses to start of next kept span)', () => {
    // tOrig=12 is inside [10,15]; cumOffset before this cut = 0;
    // postCutTime returns c.start - cumOffset = 10 - 0 = 10.
    expect(postCutTime(12, cuts)).toBe(10)
  })

  it('shifts time after first cut by cum offset', () => {
    expect(postCutTime(18, cuts)).toBe(13) // 18 - 5 (first cut) = 13
  })

  it('shifts time after both cuts by total cum offset', () => {
    expect(postCutTime(30, cuts)).toBe(20) // 30 - 5 - 5 = 20
  })

  it('identity when no cuts', () => {
    expect(postCutTime(42.5, [])).toBe(42.5)
    expect(postCutTime(0, null)).toBe(0)
    expect(postCutTime(7, undefined)).toBe(7)
  })
})

describe('round-trip identity', () => {
  const cuts = [{ start: 10, end: 15 }, { start: 20, end: 25 }]

  it('postCutTime ∘ unshiftPostCutTime is identity for kept times', () => {
    for (const t of [5, 8, 16, 17, 26, 30]) {
      const pc = postCutTime(t, cuts)
      expect(unshiftPostCutTime(pc, cuts, 'start')).toBe(t)
    }
  })
})
