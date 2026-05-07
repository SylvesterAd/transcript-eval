// server/routes/__tests__/export-xml-postcut.test.js
//
// Verifies that the XMEML export route translates b-roll placements from
// post-cut canonical (Task 4 storage shape) back to original-time before
// passing them to generateXmeml. NLEs (Premiere/Resolve/FCP) place
// imported clipitems at sequence-timeline coordinates that match the
// user's source video on their NLE timeline — that source IS the
// original (uncut) video, so clipitem <start>/<end> must be in
// original-time, not post-cut time.
//
// Pattern: tests the pure helper translatePlacementsForExport directly.
// One integration-style test pipes the translated output through
// generateXmeml to confirm the resulting <start>/<end> frame values
// match the original-time expectation. Avoids the DB-bound route
// handler entirely — that surface is already covered by other tests.

import { describe, it, expect } from 'vitest'
import { translatePlacementsForExport } from '../export-xml.js'
import { generateXmeml } from '../../services/xmeml-generator.js'

describe('translatePlacementsForExport', () => {
  it('shifts post-cut start=5,dur=3 to original start=7,dur=3 with cut [2,4]', () => {
    const placements = [
      { seq: 1, source: 'envato', sourceItemId: 'X', filename: 'b1.mp4',
        timelineStart: 5, timelineDuration: 3 },
    ]
    const out = translatePlacementsForExport(placements, [{ start: 2, end: 4 }])
    expect(out).toHaveLength(1)
    expect(out[0].timelineStart).toBe(7)
    expect(out[0].timelineDuration).toBe(3)
    // Other fields preserved.
    expect(out[0].seq).toBe(1)
    expect(out[0].filename).toBe('b1.mp4')
  })

  it('returns input identity when effective cuts is empty (no translation)', () => {
    const placements = [
      { seq: 1, filename: 'b1.mp4', timelineStart: 5, timelineDuration: 3 },
    ]
    const out = translatePlacementsForExport(placements, [])
    // Reference-identity short-circuit: no allocation when there's nothing to translate.
    expect(out).toBe(placements)
    expect(out[0].timelineStart).toBe(5)
    expect(out[0].timelineDuration).toBe(3)
  })

  it('returns input identity when effective cuts is null/undefined', () => {
    const placements = [
      { seq: 1, filename: 'b1.mp4', timelineStart: 5, timelineDuration: 3 },
    ]
    expect(translatePlacementsForExport(placements, null)).toBe(placements)
    expect(translatePlacementsForExport(placements, undefined)).toBe(placements)
  })

  it('stretches duration when a cut lies INSIDE the original-time span', () => {
    // Post-cut placement [3, 8], duration=5. Cut [5,6] in original-time.
    // In post-cut time, original [0,5] is post-cut [0,5], original [6,11] is post-cut [5,10].
    // Unshift start=3 (3 < 5 boundary): 3.
    // Unshift end=8 (kind='end'): 8 > 5 boundary, cumOffset becomes 1 → 8 + 1 = 9.
    // Original-time span is [3, 9] → duration 6 (was 5; the +1 covers the cut).
    const placements = [
      { seq: 1, filename: 'b.mp4', timelineStart: 3, timelineDuration: 5 },
    ]
    const out = translatePlacementsForExport(placements, [{ start: 5, end: 6 }])
    expect(out[0].timelineStart).toBe(3)
    expect(out[0].timelineDuration).toBe(6)
  })

  it('handles multiple cuts with cumulative offsets', () => {
    // Cuts [10,15] and [20,25] in original (5s + 5s removed).
    // Post-cut placement at start=18, dur=4 → end=22 in post-cut.
    // First cut: post-cut boundary at 10 (10 - 0 cum). 18 > 10, cum=5.
    // Second cut: post-cut boundary at 15 (20 - 5 cum). 18 > 15, cum=10.
    // Past all cuts → unshift start=18 + 10 = 28.
    // End=22: post-cut boundary at 10. 22 > 10, cum=5. Boundary 15. 22 > 15, cum=10.
    //   → unshift end = 22 + 10 = 32.
    // Original-time span [28, 32] → duration 4 (no cut inside this span).
    const cuts = [{ start: 10, end: 15 }, { start: 20, end: 25 }]
    const placements = [
      { seq: 1, filename: 'b.mp4', timelineStart: 18, timelineDuration: 4 },
    ]
    const out = translatePlacementsForExport(placements, cuts)
    expect(out[0].timelineStart).toBe(28)
    expect(out[0].timelineDuration).toBe(4)
  })

  it('passes through placements missing finite timelineStart/timelineDuration unchanged', () => {
    const placements = [
      { seq: 1, filename: 'b.mp4' /* no times */ },
      { seq: 2, filename: 'b2.mp4', timelineStart: 'oops', timelineDuration: 3 },
      { seq: 3, filename: 'b3.mp4', timelineStart: 5, timelineDuration: NaN },
    ]
    const out = translatePlacementsForExport(placements, [{ start: 2, end: 4 }])
    // Each problematic entry is the same object reference (no mutation).
    expect(out[0]).toBe(placements[0])
    expect(out[1]).toBe(placements[1])
    expect(out[2]).toBe(placements[2])
  })

  it('returns non-array inputs unchanged', () => {
    expect(translatePlacementsForExport(null, [{ start: 2, end: 4 }])).toBe(null)
    expect(translatePlacementsForExport(undefined, [{ start: 2, end: 4 }])).toBe(undefined)
  })

  it('preserves order and does not mutate input array elements', () => {
    const placements = [
      { seq: 1, filename: 'a.mp4', timelineStart: 5, timelineDuration: 3 },
      { seq: 2, filename: 'b.mp4', timelineStart: 12, timelineDuration: 2 },
    ]
    const snapshotZero = { ...placements[0] }
    const snapshotOne = { ...placements[1] }
    const out = translatePlacementsForExport(placements, [{ start: 2, end: 4 }])
    expect(out).toHaveLength(2)
    expect(out[0].seq).toBe(1)
    expect(out[1].seq).toBe(2)
    // Originals unchanged.
    expect(placements[0]).toEqual(snapshotZero)
    expect(placements[1]).toEqual(snapshotOne)
  })
})

describe('XMEML export (post-cut canonical) — integration with generateXmeml', () => {
  it('emits clipitem <start>/<end> in original-time frames after translation', () => {
    // Setup: post-cut placement at start=5, end=8 (duration=3) with cut [2,4].
    // Expected: original-time placement at start=7, dur=3 → end=10.
    // At default sequence frameRate=50:
    //   <start> = round(7 * 50)  = 350
    //   <end>   = round(10 * 50) = 500
    const placements = [
      { seq: 1, source: 'envato', sourceItemId: 'X1', filename: 'b1.mp4',
        timelineStart: 5, timelineDuration: 3 },
    ]
    const translated = translatePlacementsForExport(placements, [{ start: 2, end: 4 }])
    const xml = generateXmeml({ sequenceName: 'Variant A', placements: translated })
    expect(xml).toContain('<start>350</start>')
    expect(xml).toContain('<end>500</end>')
  })

  it('emits original-time clipitems unchanged when there are no cuts', () => {
    // Sanity: cuts=[] → identity translation → frames match raw input.
    const placements = [
      { seq: 1, source: 'envato', sourceItemId: 'X1', filename: 'b1.mp4',
        timelineStart: 5, timelineDuration: 3 },
    ]
    const translated = translatePlacementsForExport(placements, [])
    const xml = generateXmeml({ sequenceName: 'Variant A', placements: translated })
    // start=5*50=250, end=8*50=400.
    expect(xml).toContain('<start>250</start>')
    expect(xml).toContain('<end>400</end>')
  })
})
