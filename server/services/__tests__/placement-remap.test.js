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

describe('materializePlacementRemap — fuzzy fallback', () => {
  it('uses anchor text to find the word when anchor_word_idx is missing', () => {
    // Words: "From a tax standpoint" at 8.0s; "There" filler also exists.
    const words = W(
      ['Filler', 11.0, 11.5],
      ['From', 8.0, 8.3],
      ['a', 8.3, 8.4],
      ['tax', 8.4, 8.7],
      ['standpoint', 8.7, 9.2],
    )
    const placements = [{
      uuid: 'p_c',
      start: '[00:00:08.00]', end: '[00:00:10.00]',
      audio_anchor: 'From a tax standpoint',
      // no anchor_word_idx
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    const p = out.get('p_c')
    expect(p.anchor_state).toBe('fuzzy')
    expect(p.start_seconds).toBeCloseTo(8.0, 2)
  })

  it('skips fuzzy candidates that fall inside an effective cut', () => {
    // "There" appears twice — once inside cut [10,15], once at 19.94.
    const words = W(
      ['There', 11.5, 11.7],   // in cut
      ['Filler', 12.0, 12.5],
      ['There', 19.94, 20.10], // valid candidate
      ['is', 20.10, 20.18],
    )
    const placements = [{
      uuid: 'p_d',
      start: '[00:00:11.50]', end: '[00:00:13.50]',
      audio_anchor: 'There is',
      // no anchor_word_idx
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    const p = out.get('p_d')
    expect(p.anchor_state).toBe('fuzzy')
    // post-cut: 19.94 - 5 = 14.94
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
  })

  it('marks orphaned when neither idx nor fuzzy match works', () => {
    const words = W(['Hello', 1.0, 1.2], ['World', 1.2, 1.5])
    const placements = [{
      uuid: 'p_e',
      start: '[00:00:50.00]', end: '[00:00:52.00]',
      audio_anchor: 'completely unmatched phrase',
    }]
    const out = materializePlacementRemap(placements, [], words)
    const p = out.get('p_e')
    expect(p.anchor_state).toBe('orphaned')
    expect(p.start_seconds).toBeCloseTo(50.0, 2) // falls back to LLM time
  })

  it('promotes in_cut to fuzzy when idx points into a cut but anchor text exists in kept content', () => {
    const words = W(
      ['Filler', 11.0, 11.5],         // in cut [10,15] — anchor_word_idx points here
      ['From', 19.0, 19.3],           // valid post-cut candidate
      ['a', 19.3, 19.4],
      ['tax', 19.4, 19.7],
    )
    const placements = [{
      uuid: 'p_recover',
      start: '[00:00:11.00]', end: '[00:00:13.00]',
      audio_anchor: 'From a tax',
      anchor_word_idx: 0,             // points to in-cut "Filler"
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
    const p = out.get('p_recover')
    expect(p.anchor_state).toBe('fuzzy')   // promoted from in_cut
    expect(p.start_seconds).toBeCloseTo(14.0, 2) // 19.0 - 5
  })
})
