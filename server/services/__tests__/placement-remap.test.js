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
  it('shifts placement to post-cut time using LLM-emitted timecode when no anchor_word_idx', () => {
    // Cut [10,15] removes 5s. Placement at original 19.94s shifts to 14.94s.
    const placements = [{
      uuid: 'p_a',
      start: '[00:00:19.94]',
      end: '[00:00:21.94]',
      audio_anchor: 'There is a bad piece',
    }]
    const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], [])
    const p = out.get('p_a')
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.end_seconds).toBeCloseTo(16.94, 2)
    expect(p.anchor_state).toBe('shifted')
  })

  it('passes through original-time when there are no effective cuts and no anchor_word_idx', () => {
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

  it('trusts the LLM timecode (no anchor_word_idx) regardless of where the anchor phrase repeats in the transcript', () => {
    // The phrase "bad piece" appears at words[1-2] AND words[8-9]. The
    // placement has no anchor_word_idx — without runtime re-matching it
    // stays at the LLM's emitted [00:02:14] = 134s, NOT the earlier "bad
    // piece" occurrence at 128.86s. This is exactly why anchor_word_idx
    // is used when present: the LLM picked it at plan time, locking the
    // intended occurrence.
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

  describe('anchor_word_idx word-snap', () => {
    it('snaps start to the actual word time, recovering sub-second precision the LLM timecode lost', () => {
      // Real-world case: LLM emits [00:08:00] (480s, rounded down to a whole
      // second). Actual word "Soviet" at idx 1068 starts at 481.71s.
      // anchor_word_idx wins, end shifts by the same offset so LLM-intended
      // duration (6s) is preserved.
      const words = []
      for (let i = 0; i < 1070; i++) words.push({ word: `w${i}`, start: i * 0.45, end: i * 0.45 + 0.1 })
      words[1068] = { word: 'Soviet', start: 481.71, end: 482.29 }
      const placements = [{
        uuid: 'p_soviet',
        start: '[00:08:00]', end: '[00:08:06]',
        audio_anchor: 'Soviet tanks potentially heading west',
        anchor_word_idx: 1068,
      }]
      const out = materializePlacementRemap(placements, [], words)
      const p = out.get('p_soviet')
      expect(p.start_seconds).toBeCloseTo(481.71, 2)
      expect(p.end_seconds).toBeCloseTo(487.71, 2)
      expect(p.anchor_state).toBe('word_snapped')
    })

    it('shifts the word-snapped start through cuts and preserves LLM-intended duration', () => {
      const words = [
        { word: 'placeholder', start: 0, end: 0.1 },
        { word: 'Soviet', start: 25, end: 25.5 },
      ]
      // Cut [5,15] removes 10s. Word at 25 → post-cut 15. Duration 6s preserved.
      const placements = [{
        uuid: 'p_x',
        start: '[00:00:24]', end: '[00:00:30]',
        audio_anchor: 'Soviet',
        anchor_word_idx: 1,
      }]
      const out = materializePlacementRemap(placements, [{ start: 5, end: 15 }], words)
      const p = out.get('p_x')
      expect(p.start_seconds).toBeCloseTo(15, 2)
      expect(p.end_seconds).toBeCloseTo(21, 2)
      expect(p.anchor_state).toBe('word_snapped')
    })

    it('falls back to LLM timecode when anchor_word_idx points far from the LLM start (>30s)', () => {
      // Real-world case from project 367: LLM emits start=[00:02:52] (172s),
      // but findAnchorWordIdx fell back to first-token match and returned
      // idx=21 → word "and" at 12.4s. Without the sanity gate the placement
      // would snap to 12.4s (off by 160s). With the gate it falls back to
      // the LLM's 172s.
      const words = []
      for (let i = 0; i < 200; i++) words.push({ word: `w${i}`, start: i * 0.9, end: i * 0.9 + 0.2 })
      words[21] = { word: 'and', start: 12.4, end: 12.62 }
      const placements = [{
        uuid: 'p_offgate',
        start: '[00:02:52]', end: '[00:03:07]',
        audio_anchor: 'And speaking of not done buying, Switzerland holds more gold',
        anchor_word_idx: 21,
      }]
      const out = materializePlacementRemap(placements, [], words)
      const p = out.get('p_offgate')
      expect(p.start_seconds).toBeCloseTo(172, 2)
      expect(p.end_seconds).toBeCloseTo(187, 2)
      expect(p.anchor_state).toBe('shifted')
    })

    it('keeps word-snap when the word is within the ±30s gate of the LLM start', () => {
      // 28s offset — within the gate, snap wins.
      const words = [{ word: 'target', start: 100, end: 100.5 }]
      const placements = [{
        uuid: 'p_within',
        start: '[00:01:12]', end: '[00:01:14]',  // 72s, 28s off
        audio_anchor: 'target',
        anchor_word_idx: 0,
      }]
      const out = materializePlacementRemap(placements, [], words)
      const p = out.get('p_within')
      expect(p.start_seconds).toBeCloseTo(100, 2)
      expect(p.anchor_state).toBe('word_snapped')
    })

    it('falls back to LLM timecode when anchor_word_idx is -1 (anchor not found at plan time)', () => {
      const words = [{ word: 'Soviet', start: 25, end: 25.5 }]
      const placements = [{
        uuid: 'p_y',
        start: '[00:00:24]', end: '[00:00:26]',
        audio_anchor: 'Soviet',
        anchor_word_idx: -1,
      }]
      const out = materializePlacementRemap(placements, [], words)
      const p = out.get('p_y')
      expect(p.start_seconds).toBeCloseTo(24, 2)
      expect(p.anchor_state).toBe('shifted')
    })

    it('falls back to LLM timecode when anchor_word_idx is out of range (transcript edited away)', () => {
      const words = [{ word: 'Soviet', start: 25, end: 25.5 }]
      const placements = [{
        uuid: 'p_z',
        start: '[00:00:24]', end: '[00:00:26]',
        audio_anchor: 'Soviet',
        anchor_word_idx: 999,  // out of range
      }]
      const out = materializePlacementRemap(placements, [], words)
      const p = out.get('p_z')
      expect(p.start_seconds).toBeCloseTo(24, 2)
      expect(p.anchor_state).toBe('shifted')
    })

    it('falls back to LLM timecode when the indexed word has no finite start', () => {
      const words = [{ word: 'broken', start: null, end: 25.5 }]
      const placements = [{
        uuid: 'p_w',
        start: '[00:00:24]', end: '[00:00:26]',
        audio_anchor: 'broken',
        anchor_word_idx: 0,
      }]
      const out = materializePlacementRemap(placements, [], words)
      const p = out.get('p_w')
      expect(p.start_seconds).toBeCloseTo(24, 2)
      expect(p.anchor_state).toBe('shifted')
    })

    it('hides a placement whose anchor word lands inside a cut (no visible start)', () => {
      const words = [{ word: 'Soviet', start: 12, end: 12.5 }]
      const placements = [{
        uuid: 'p_incut',
        start: '[00:00:11.50]', end: '[00:00:13.00]',
        audio_anchor: 'Soviet',
        anchor_word_idx: 0,
      }]
      // Cut [10,15] covers the word at 12 AND the LLM-derived end at 13 (= word+1.5s).
      // adjStart = 15 (cut end), adjEnd = 10 (cut start) → adjStart >= adjEnd → hidden.
      const out = materializePlacementRemap(placements, [{ start: 10, end: 15 }], words)
      const p = out.get('p_incut')
      expect(p.hidden).toBe(true)
    })

    it('overlap trim still wins when two word-snapped placements collide', () => {
      const words = [
        { word: 'one', start: 10, end: 10.5 },
        { word: 'two', start: 10.8, end: 11 },
      ]
      const placements = [
        { uuid: 'p_first',  start: '[00:00:10]', end: '[00:00:12]', audio_anchor: 'one', anchor_word_idx: 0 },
        { uuid: 'p_second', start: '[00:00:11]', end: '[00:00:13]', audio_anchor: 'two', anchor_word_idx: 1 },
      ]
      const out = materializePlacementRemap(placements, [], words)
      const a = out.get('p_first')
      const b = out.get('p_second')
      // First placement: word at 10, intended duration 2 → end 12. But next starts at 10.8 → trim end to 10.8.
      expect(a.end_seconds).toBeCloseTo(10.8, 2)
      expect(b.start_seconds).toBeCloseTo(10.8, 2)
    })
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
