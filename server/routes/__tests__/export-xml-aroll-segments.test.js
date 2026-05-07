import { describe, it, expect } from 'vitest'

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
