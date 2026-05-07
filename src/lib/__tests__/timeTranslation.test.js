import { describe, it, expect } from 'vitest'
import { postCutTime, unshiftPostCutTime } from '../timeTranslation.js'

describe('postCutTime (client mirror)', () => {
  const cuts = [{ start: 10, end: 15 }, { start: 20, end: 25 }]

  it('identity for time before any cut', () => {
    expect(postCutTime(5, cuts)).toBe(5)
  })

  it('mid-cut maps to cut.start - cumOffset', () => {
    expect(postCutTime(12, cuts)).toBe(10)
  })

  it('shifts time after first cut', () => {
    expect(postCutTime(18, cuts)).toBe(13)
  })

  it('shifts time after both cuts', () => {
    expect(postCutTime(30, cuts)).toBe(20)
  })

  it('identity when cuts list is empty', () => {
    expect(postCutTime(42, [])).toBe(42)
    expect(postCutTime(42, null)).toBe(42)
    expect(postCutTime(42, undefined)).toBe(42)
  })
})

describe('unshiftPostCutTime (client mirror)', () => {
  const cuts = [{ start: 10, end: 15 }, { start: 20, end: 25 }]

  it('identity for time before any cut', () => {
    expect(unshiftPostCutTime(5, cuts, 'start')).toBe(5)
  })

  it('boundary kind=start jumps PAST cut', () => {
    // post-cut t=10 lands at cut.start - cumOffset = 10 - 0 = 10
    // With kind='start': beforeBoundary = 10 < 10 = false; loop continues
    // cumOffset += 5; second cut at 20 - 5 = 15; tPost (10) < 15 = true → return 10 + 5 = 15
    expect(unshiftPostCutTime(10, cuts, 'start')).toBe(15)
  })

  it('boundary kind=end stays BEFORE cut', () => {
    // tPost=10, kind='end': beforeBoundary = 10 <= 10 = true → return 10 + 0 = 10
    expect(unshiftPostCutTime(10, cuts, 'end')).toBe(10)
  })

  it('post-cut t=11 maps to original t=16 (after first cut)', () => {
    // beforeBoundary check at first cut: tPost (11) < 10? No, kind='start': 11 < 10 false → cumOffset += 5
    // Second cut: tPost (11) < 20-5=15? Yes → return 11 + 5 = 16
    expect(unshiftPostCutTime(11, cuts, 'start')).toBe(16)
  })

  it('round-trip identity for kept times', () => {
    for (const t of [5, 8, 16, 17, 26, 30]) {
      const pc = postCutTime(t, cuts)
      expect(unshiftPostCutTime(pc, cuts, 'start')).toBe(t)
    }
  })
})
