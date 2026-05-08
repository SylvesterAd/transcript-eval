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

describe('materializePlacementRemap', () => {
  it('shifts placement to post-cut time using LLM-emitted timecode (no anchor re-matching)', () => {
    // Cut [10,15] removes 5s. Placement at original 19.94s shifts to 14.94s.
    const placements = [{
      uuid: 'p_a',
      start: '[00:00:19.94]',
      end: '[00:00:21.94]',
      audio_anchor: 'There is a bad piece',
      // anchor_word_idx ignored — we trust the LLM timecode directly.
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], [])
    const p = out.get('p_a')
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.end_seconds).toBeCloseTo(16.94, 2)
    expect(p.anchor_state).toBe('shifted')
  })

  it('passes through original-time when there are no effective cuts', () => {
    const placements = [{
      uuid: 'p_b',
      start: '[00:02:14]',
      end: '[00:02:17]',
      audio_anchor: "There's that bad piece of advice floating around the internet",
    }]
    const out = materializePlacementRemap(placements, [], [])
    const p = out.get('p_b')
    expect(p.start_seconds).toBeCloseTo(134, 2)
    expect(p.end_seconds).toBeCloseTo(137, 2)
  })

  it('trusts the LLM timecode regardless of where the anchor phrase repeats in the transcript', () => {
    // The phrase "bad piece" appears at words[1-2] AND words[8-9]. Without
    // anchor matching, the placement stays at the LLM's emitted [00:02:14] =
    // 134s — NOT the earlier "bad piece" occurrence at 128.86s.
    const words = [
      { word: 'a', start: 100, end: 100.1 },
      { word: 'bad', start: 128.86, end: 129.0 },
      { word: 'piece', start: 129.0, end: 129.4 },
      { word: 'of', start: 129.4, end: 129.6 },
      { word: 'something', start: 129.6, end: 130 },
      { word: 'else', start: 130, end: 130.5 },
      { word: "There's", start: 134.18, end: 134.5 },
      { word: 'that', start: 134.5, end: 134.7 },
      { word: 'bad', start: 134.76, end: 135 },
      { word: 'piece', start: 135, end: 135.3 },
    ]
    const placements = [{
      uuid: 'p_c',
      start: '[00:02:14]', end: '[00:02:17]',
      audio_anchor: 'bad piece',
    }]
    const out = materializePlacementRemap(placements, [], words)
    const p = out.get('p_c')
    expect(p.start_seconds).toBeCloseTo(134, 2)
  })

  it('enforces 0.5s minimum duration', () => {
    const placements = [{
      uuid: 'p_short',
      start: '[00:00:05.00]', end: '[00:00:05.30]',
      audio_anchor: 'There',
    }]
    const out = materializePlacementRemap(placements, [], [])
    const p = out.get('p_short')
    expect(p.end_seconds - p.start_seconds).toBeCloseTo(0.5, 2)
  })

  it('trims earlier end when two placements overlap', () => {
    const placements = [
      { uuid: 'p_first',  start: '[00:00:10.00]', end: '[00:00:11.50]', audio_anchor: 'A' },
      { uuid: 'p_second', start: '[00:00:10.80]', end: '[00:00:12.00]', audio_anchor: 'B' },
    ]
    const out = materializePlacementRemap(placements, [], [])
    const a = out.get('p_first')
    const b = out.get('p_second')
    expect(a.end_seconds).toBeCloseTo(10.8, 2)
    expect(b.start_seconds).toBeCloseTo(10.8, 2)
  })

  it('marks overlap_squeezed when trim forces duration below 0.5s', () => {
    const placements = [
      { uuid: 'p_first',  start: '[00:00:10.00]', end: '[00:00:11.00]', audio_anchor: 'A' },
      { uuid: 'p_second', start: '[00:00:10.30]', end: '[00:00:11.30]', audio_anchor: 'B' },
    ]
    const out = materializePlacementRemap(placements, [], [])
    const a = out.get('p_first')
    expect(a.anchor_state).toBe('overlap_squeezed')
    expect(a.end_seconds).toBeCloseTo(10.3, 2)
  })

  describe('cut clipping', () => {
    it('hides a placement that is fully inside a cut', () => {
      const placements = [{
        uuid: 'p_inside',
        start: '[00:00:12.00]', end: '[00:00:14.00]',
        audio_anchor: 'inside the cut',
      }]
      const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], [])
      const p = out.get('p_inside')
      expect(p.hidden).toBe(true)
      expect(p.start_seconds).toBeUndefined()
    })

    it('clips end to cut.start when placement starts before cut and ends inside it', () => {
      // Placement 8-12. Cut [10, 15]. Visible portion: 8-10 → post-cut 8-10.
      const placements = [{
        uuid: 'p_overruns',
        start: '[00:00:08.00]', end: '[00:00:12.00]',
        audio_anchor: 'overruns into cut',
      }]
      const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], [])
      const p = out.get('p_overruns')
      expect(p.start_seconds).toBeCloseTo(8, 2)
      expect(p.end_seconds).toBeCloseTo(10, 2)
      expect(p.anchor_state).toBe('cut_clipped')
    })

    it('clips start to cut.end when placement starts inside cut and ends after it', () => {
      // Placement 12-18. Cut [10, 15]. Visible portion: 15-18 → post-cut 10-13.
      const placements = [{
        uuid: 'p_underruns',
        start: '[00:00:12.00]', end: '[00:00:18.00]',
        audio_anchor: 'underruns from cut',
      }]
      const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], [])
      const p = out.get('p_underruns')
      expect(p.start_seconds).toBeCloseTo(10, 2)
      expect(p.end_seconds).toBeCloseTo(13, 2)
      expect(p.anchor_state).toBe('cut_clipped')
    })

    it('preserves placement that spans across a cut (start before, end after)', () => {
      // Placement 8-18 across cut [10, 15]. Both edges outside → no clipping
      // flag, but postCutTime collapses the middle. Post-cut: 8 → 13 (5s gone).
      const placements = [{
        uuid: 'p_spans',
        start: '[00:00:08.00]', end: '[00:00:18.00]',
        audio_anchor: 'spans across cut',
      }]
      const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], [])
      const p = out.get('p_spans')
      expect(p.start_seconds).toBeCloseTo(8, 2)
      expect(p.end_seconds).toBeCloseTo(13, 2)
      expect(p.anchor_state).toBe('shifted')
    })
  })

  it('skips placements without uuid', () => {
    const out = materializePlacementRemap(
      [{ start: '[00:00:01]', end: '[00:00:02]' }],
      [], []
    )
    expect(out.size).toBe(0)
  })
})
