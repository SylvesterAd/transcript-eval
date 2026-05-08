import { describe, it, expect } from 'vitest'
import { cutsHash, materializePlacementRemap } from '../placement-remap.js'

describe('cutsHash', () => {
  it('returns the same hash regardless of input order', () => {
    const a = cutsHash([{ start: 30, end: 35 }, { start: 10, end: 15 }], [])
    const b = cutsHash([{ start: 10, end: 15 }, { start: 30, end: 35 }], [])
    expect(a).toBe(b)
  })

  it('differs when cut times change', () => {
    const a = cutsHash([{ start: 10, end: 15 }], [])
    const b = cutsHash([{ start: 10, end: 16 }], [])
    expect(a).not.toBe(b)
  })

  it('differs when an exclusion is added', () => {
    const cuts = [{ start: 10, end: 15 }]
    const a = cutsHash(cuts, [])
    const b = cutsHash(cuts, [{ start: 12, end: 13 }])
    expect(a).not.toBe(b)
  })

  it('ignores cut id field (only times matter)', () => {
    const a = cutsHash([{ id: 'cut-1', start: 10, end: 15 }], [])
    const b = cutsHash([{ id: 'cut-different', start: 10, end: 15 }], [])
    expect(a).toBe(b)
  })

  it('returns a stable string for empty inputs', () => {
    expect(cutsHash([], [])).toBe(cutsHash([], []))
    expect(cutsHash([], []).length).toBeGreaterThan(0)
  })
})

const W = (...spec) => spec.map(([word, start, end]) => ({ word, start, end }))

describe('materializePlacementRemap — anchor_word_idx happy path', () => {
  it('shifts placement to post-cut time using the anchor word', () => {
    // Words: "There" at 19.94 in original time. Cuts remove [10,15] = 5s.
    // Expected post-cut start: 19.94 - 5 = 14.94.
    const words = W(
      ['There', 19.94, 20.10],
      ['is', 20.10, 20.18],
      ['a', 20.18, 20.21],
      ['bad', 20.21, 20.50],
      ['piece', 20.50, 20.78],
    )
    const placements = [{
      uuid: 'p_a',
      start: '[00:00:19.94]', end: '[00:00:21.94]',
      audio_anchor: 'There is a bad piece',
      anchor_word_idx: 0,
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    const p = out.get('p_a')
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.end_seconds).toBeCloseTo(16.94, 2)
    expect(p.anchor_state).toBe('idx')
  })

  it('falls back to in_cut when anchor word lands inside a cut', () => {
    const words = W(
      ['Filler', 11.0, 11.5],   // inside cut [10,15]
      ['There', 19.94, 20.10],
    )
    const placements = [{
      uuid: 'p_b',
      start: '[00:00:11.00]', end: '[00:00:13.00]',
      audio_anchor: 'Filler',
      anchor_word_idx: 0,
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    expect(out.get('p_b').anchor_state).toBe('in_cut')
  })
})
