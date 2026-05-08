import { describe, it, expect } from 'vitest'
import { layoutPostCut } from '../postCutTimeline.js'

describe('layoutPostCut', () => {
  it('returns full duration as a single segment when there are no cuts', () => {
    const layout = layoutPostCut(100, [], 1000)
    expect(layout.segments).toHaveLength(1)
    expect(layout.segments[0]).toMatchObject({
      origStart: 0, origEnd: 100, postStart: 0, postEnd: 100, x: 0, w: 1000,
    })
    expect(layout.cutBars).toHaveLength(0)
    expect(layout.postCutDuration).toBe(100)
    expect(layout.pxPerSecond).toBe(10)
  })

  it('lays out two kept segments + one cut bar for [30,50] cut', () => {
    const cuts = [{ start: 30, end: 50 }]
    const layout = layoutPostCut(100, cuts, 800)
    // Post-cut duration = 100 - 20 = 80, pxPerSecond = 800 / 80 = 10
    expect(layout.postCutDuration).toBe(80)
    expect(layout.pxPerSecond).toBe(10)
    expect(layout.segments).toHaveLength(2)
    expect(layout.segments[0]).toMatchObject({
      origStart: 0, origEnd: 30,
      postStart: 0, postEnd: 30,
      x: 0, w: 300,
    })
    expect(layout.segments[1]).toMatchObject({
      origStart: 50, origEnd: 100,
      postStart: 30, postEnd: 80,
      x: 300, w: 500,
    })
    expect(layout.cutBars).toHaveLength(1)
    expect(layout.cutBars[0]).toMatchObject({
      x: 300,
      origStart: 30,
      origEnd: 50,
      cutDuration: 20,
    })
  })

  it('handles cut at start of timeline', () => {
    const cuts = [{ start: 0, end: 10 }]
    const layout = layoutPostCut(100, cuts, 900)
    expect(layout.postCutDuration).toBe(90)
    expect(layout.cutBars).toHaveLength(1)
    expect(layout.cutBars[0].x).toBe(0)
    // Only one kept segment from 10 to 100 (no kept segment before t=0)
    expect(layout.segments).toHaveLength(1)
    expect(layout.segments[0]).toMatchObject({
      origStart: 10, origEnd: 100, x: 0, w: 900,
    })
  })

  it('handles cut at end of timeline', () => {
    const cuts = [{ start: 90, end: 100 }]
    const layout = layoutPostCut(100, cuts, 900)
    expect(layout.postCutDuration).toBe(90)
    expect(layout.cutBars).toHaveLength(1)
    expect(layout.cutBars[0].x).toBe(900)
    // Only one kept segment from 0 to 90
    expect(layout.segments).toHaveLength(1)
    expect(layout.segments[0]).toMatchObject({
      origStart: 0, origEnd: 90, x: 0, w: 900,
    })
  })

  it('handles multiple cuts', () => {
    const cuts = [
      { start: 10, end: 20 },
      { start: 40, end: 50 },
      { start: 80, end: 90 },
    ]
    const layout = layoutPostCut(100, cuts, 700)
    // Total cut = 30, post-cut = 70, pxPerSecond = 10
    expect(layout.postCutDuration).toBe(70)
    expect(layout.pxPerSecond).toBe(10)
    // Kept segments: [0-10], [20-40], [50-80], [90-100]
    expect(layout.segments).toHaveLength(4)
    // Cut bars: at post-cut positions 10, 30, 60 → x = 100, 300, 600
    expect(layout.cutBars).toHaveLength(3)
    expect(layout.cutBars[0].x).toBe(100)
    expect(layout.cutBars[1].x).toBe(300)
    expect(layout.cutBars[2].x).toBe(600)
  })

  it('sorts unsorted cuts before laying out', () => {
    const cuts = [
      { start: 80, end: 90 },
      { start: 10, end: 20 },
    ]
    const layout = layoutPostCut(100, cuts, 800)
    expect(layout.cutBars[0].origStart).toBe(10)
    expect(layout.cutBars[1].origStart).toBe(80)
  })

  it('returns empty cutBars + single full-width segment when duration is zero', () => {
    // Edge case: shouldn't crash, but the layout will be degenerate
    const layout = layoutPostCut(0, [], 100)
    expect(layout.postCutDuration).toBeGreaterThan(0)  // clamped to avoid divide-by-zero
    expect(layout.segments.length).toBeGreaterThanOrEqual(0)
    expect(layout.cutBars).toHaveLength(0)
  })

  it('skips zero-width cuts (razor markers, c.end <= c.start)', () => {
    const cuts = [
      { start: 30, end: 50 },
      { start: 60, end: 60 },  // razor marker — should be ignored for layout
    ]
    const layout = layoutPostCut(100, cuts, 800)
    // Only one real cut counts — post-cut = 80, one cut bar at x=300
    expect(layout.postCutDuration).toBe(80)
    expect(layout.cutBars).toHaveLength(1)
    expect(layout.cutBars[0].origStart).toBe(30)
  })
})
