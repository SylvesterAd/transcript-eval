import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: { prepare: vi.fn() },
}))

import { deriveCutsFromAnnotations } from '../cuts-from-annotations.js'

// These tests exercise the EXTENDED cut shape produced when `words` are
// supplied to deriveCutsFromAnnotations. The algorithm mirrors
// TranscriptEditor.jsx (bridging + edge extension) so that server-generated
// cuts have the same shape the frontend would generate, eliminating the
// dual-cut-set bug where editor_state_json contained both `cut-ann-server-`
// (tight) AND `cut-ai-ann-` (extended) variants simultaneously.

describe('deriveCutsFromAnnotations — extended cut shape with words', () => {
  describe('bridging adjacent annotations', () => {
    // Two annotations separated by a tiny silence-region word that's covered
    // by annotation 1 with the algorithm's 0.05s boundary tolerance.
    // ann1 [2.36, 8.6], ann2 [8.64, 12.06], silenceWord [8.62, 8.64]
    //   silenceWord.start=8.62 >= ann1.start - 0.05 = 2.31  ✓
    //   silenceWord.end  =8.64 <= ann1.end   + 0.05 = 8.65  ✓
    // → silenceWord IS covered by ann1 with tolerance → no uncut word in gap
    // → bridging FIRES.
    const words = [
      { word: 'kept1',       start: 0,    end: 1.0 },
      { word: 'cutA',        start: 2.36, end: 8.6 },
      { word: 'silenceWord', start: 8.62, end: 8.64 }, // covered by ann1 w/ tolerance
      { word: 'cutB',        start: 8.64, end: 12.06 },
      { word: 'kept2',       start: 12.5, end: 13 },
    ]
    const annotations = {
      items: [
        { type: 'deletion', category: 'filler_words', startTime: 2.36, endTime: 8.6 },
        { type: 'deletion', category: 'filler_words', startTime: 8.64, endTime: 12.06 },
      ],
    }

    it('bridges two annotations into one cut when no uncut word lies in their gap', () => {
      const cuts = deriveCutsFromAnnotations(annotations, [], words)
      // Bridging fires → single merged region.
      // Extension: back to kept1.end=1.0, forward to kept2.start=12.5.
      expect(cuts.length).toBe(1)
      expect(cuts[0].start).toBeCloseTo(1.0, 2)
      expect(cuts[0].end).toBeCloseTo(12.5, 2)
    })

    it('does NOT bridge when a true uncut word lies in the gap', () => {
      // Move annotations apart so the silence-word is genuinely outside both.
      // ann1 [2.36, 8.6], ann2 [9.0, 12.06], gapWord [8.7, 8.9]
      //   gapWord.start=8.7 >= ann1.start - 0.05 = 2.31 ✓
      //   gapWord.end  =8.9 <= ann1.end   + 0.05 = 8.65 ✗ (8.9 > 8.65)
      //   gapWord.start=8.7 >= ann2.start - 0.05 = 8.95 ✗
      // → gapWord NOT covered by either annotation → uncut word in gap
      // → bridging SKIPPED.
      const wordsWithGap = [
        { word: 'kept1',   start: 0,    end: 1.0 },
        { word: 'cutA',    start: 2.36, end: 8.6 },
        { word: 'gapWord', start: 8.7,  end: 8.9 },
        { word: 'cutB',    start: 9.0,  end: 12.06 },
        { word: 'kept2',   start: 12.5, end: 13 },
      ]
      const annsWithGap = {
        items: [
          { type: 'deletion', category: 'filler_words', startTime: 2.36, endTime: 8.6 },
          { type: 'deletion', category: 'filler_words', startTime: 9.0,  endTime: 12.06 },
        ],
      }
      const cuts = deriveCutsFromAnnotations(annsWithGap, [], wordsWithGap)
      // Two separate cuts, each independently extended:
      //   region 1: extend back to kept1.end=1.0, forward to gapWord.start=8.7
      //   region 2: extend back to gapWord.end=8.9, forward to kept2.start=12.5
      expect(cuts.length).toBe(2)
      expect(cuts[0].start).toBeCloseTo(1.0, 2)
      expect(cuts[0].end).toBeCloseTo(8.7, 2)
      expect(cuts[1].start).toBeCloseTo(8.9, 2)
      expect(cuts[1].end).toBeCloseTo(12.5, 2)
    })

    it('does NOT bridge when an exclusion zone crosses the gap', () => {
      // Same fixture as the bridging test, but with an exclusion in the gap.
      const exclusions = [{ start: 8.6, end: 8.64 }]
      const cuts = deriveCutsFromAnnotations(annotations, exclusions, words)
      // Bridging skipped → two regions. Each gets extended independently.
      // After extension:
      //   region 1 [2.36, 8.6]: extend back to kept1.end=1.0, forward stops at
      //     exclusion.start=8.6 (next uncut word silenceWord covered by ann1
      //     with tolerance, so algorithm finds cutB then silenceWord again — but
      //     since silenceWord is covered, scan continues). Actually next uncut
      //     word is kept2 at 12.5; but exclusion.start=8.6 caps newEnd to 8.6.
      //   region 2 [8.64, 12.06]: extend back stops at exclusion.end=8.64,
      //     forward to kept2.start=12.5.
      // Then Step 3 (subtraction) tries to subtract exclusion from these
      // regions — but exclusion [8.6, 8.64] sits exactly between them,
      // so neither region overlaps it. Final regions unchanged.
      expect(cuts.length).toBe(2)
      expect(cuts[0].start).toBeCloseTo(1.0, 2)
      expect(cuts[0].end).toBeCloseTo(8.6, 2)
      expect(cuts[1].start).toBeCloseTo(8.64, 2)
      expect(cuts[1].end).toBeCloseTo(12.5, 2)
    })
  })

  describe('edge extension', () => {
    it('falls back to tight cuts when words is null', () => {
      const annotations = {
        items: [
          { type: 'deletion', category: 'filler_words', startTime: 2.36, endTime: 8.6 },
          { type: 'deletion', category: 'filler_words', startTime: 8.64, endTime: 12.06 },
        ],
      }
      const cuts = deriveCutsFromAnnotations(annotations, [], null)
      expect(cuts.length).toBe(2)
      expect(cuts[0].start).toBeCloseTo(2.36, 2)
      expect(cuts[0].end).toBeCloseTo(8.6, 2)
      expect(cuts[1].start).toBeCloseTo(8.64, 2)
      expect(cuts[1].end).toBeCloseTo(12.06, 2)
    })

    it('falls back to tight cuts when words is empty array', () => {
      const annotations = {
        items: [{ type: 'deletion', category: 'filler_words', startTime: 5, endTime: 10 }],
      }
      const cuts = deriveCutsFromAnnotations(annotations, [], [])
      expect(cuts.length).toBe(1)
      expect(cuts[0].start).toBeCloseTo(5, 2)
      expect(cuts[0].end).toBeCloseTo(10, 2)
    })

    it('does not extend past an exclusion zone on the start side', () => {
      // ann [5, 10]. prev uncut word kept1 ends at 1.0. Without exclusion,
      // extension would push start back to 1.0. With exclusion [3, 4] in
      // between, the algorithm caps newStart at exclusion.end = 4.0.
      const words = [
        { word: 'kept1', start: 0, end: 1.0 },
        { word: 'cut1',  start: 5, end: 10 },
        { word: 'kept2', start: 12, end: 13 },
      ]
      const annotations = {
        items: [{ type: 'deletion', category: 'filler_words', startTime: 5, endTime: 10 }],
      }
      const exclusions = [{ start: 3, end: 4 }]
      const cuts = deriveCutsFromAnnotations(annotations, exclusions, words)
      expect(cuts.length).toBe(1)
      // Start capped at exclusion.end = 4.0 (would otherwise extend to 1.0).
      expect(cuts[0].start).toBeCloseTo(4.0, 2)
      // End extends to next uncut word kept2.start = 12.0.
      expect(cuts[0].end).toBeCloseTo(12.0, 2)
    })

    it('does not extend past an exclusion zone on the end side', () => {
      // ann [5, 10]. next uncut word kept2 starts at 15. Without exclusion,
      // extension pushes end forward to 15. With exclusion [12, 13],
      // algorithm caps newEnd at exclusion.start = 12.
      const words = [
        { word: 'kept1', start: 0, end: 1.0 },
        { word: 'cut1',  start: 5, end: 10 },
        { word: 'kept2', start: 15, end: 16 },
      ]
      const annotations = {
        items: [{ type: 'deletion', category: 'filler_words', startTime: 5, endTime: 10 }],
      }
      const exclusions = [{ start: 12, end: 13 }]
      const cuts = deriveCutsFromAnnotations(annotations, exclusions, words)
      expect(cuts.length).toBe(1)
      // Start extends back to kept1.end = 1.0.
      expect(cuts[0].start).toBeCloseTo(1.0, 2)
      // End capped at exclusion.start = 12.0 (would otherwise extend to 15.0).
      expect(cuts[0].end).toBeCloseTo(12.0, 2)
    })

    it('extends a single annotation cut to fill word-less gaps on both sides', () => {
      const words = [
        { word: 'kept1', start: 0, end: 1.0 },
        { word: 'cut1',  start: 5, end: 10 },
        { word: 'kept2', start: 15, end: 16 },
      ]
      const annotations = {
        items: [{ type: 'deletion', category: 'filler_words', startTime: 5, endTime: 10 }],
      }
      const cuts = deriveCutsFromAnnotations(annotations, [], words)
      expect(cuts.length).toBe(1)
      expect(cuts[0].start).toBeCloseTo(1.0, 2)  // back to kept1.end
      expect(cuts[0].end).toBeCloseTo(15.0, 2)   // forward to kept2.start
    })
  })

  describe('annotationRegions snapshot (no aliasing during extension)', () => {
    it('extension uses pre-extension region bounds (no mutation aliasing across regions)', () => {
      // Two annotations + a word in the gap that would be classified differently
      // depending on whether annotationRegions reflects the in-progress mutated state
      // or a snapshot taken before extension.
      //
      // Setup: ann1 [5, 10], ann2 [15, 20]. Word at [12, 12.04] in the gap.
      // Words: [{0,1}, {12,12.04}, {25,26}]
      //
      // Pre-fix (aliasing bug): after ann1.end extends to 12 (because [12,12.04]
      // is the next uncut word), the membership check for ann2's reverse scan
      // sees [12,12.04] as covered by the now-mutated ann1=[5,12] (12.04 ≤ 12.05),
      // skipping it. prevUncutWord becomes the previous one (or undefined),
      // so ann2.start either stays at 15 or extends to 1 (kept0.end), depending
      // on what other words exist.
      //
      // Post-fix (snapshot): annotationRegions captures [{5,10},{15,20}] before
      // extension. The check for [12,12.04] sees it covered by [5,10]?
      // 12.04 ≤ 10.05? No. NOT covered. So [12,12.04] is the prevUncutWord.
      // ann2.start = 12.04.
      const annotations = {
        items: [
          { type: 'deletion', category: 'filler_words', startTime: 5, endTime: 10 },
          { type: 'deletion', category: 'filler_words', startTime: 15, endTime: 20 },
        ],
      }
      const words = [
        { word: 'kept0', start: 0, end: 1 },
        { word: 'gapWord', start: 12, end: 12.04 },
        { word: 'kept2', start: 25, end: 26 },
      ]
      const cuts = deriveCutsFromAnnotations(annotations, [], words)
      // ann1 extends back to kept0.end=1, forward to gapWord.start=12 → [1, 12]
      expect(cuts.length).toBe(2)
      expect(cuts[0].start).toBeCloseTo(1, 2)
      expect(cuts[0].end).toBeCloseTo(12, 2)
      // ann2 extends back to gapWord.end=12.04 (matches frontend) → [12.04, 25]
      expect(cuts[1].start).toBeCloseTo(12.04, 2)
      expect(cuts[1].end).toBeCloseTo(25, 2)
    })
  })

  describe('output shape', () => {
    it('produces cut-ann-server- prefixed IDs and source=annotation', () => {
      const words = [
        { word: 'kept1', start: 0, end: 1 },
        { word: 'cut1',  start: 5, end: 8 },
        { word: 'kept2', start: 10, end: 11 },
        { word: 'cut2',  start: 13, end: 15 },
        { word: 'kept3', start: 17, end: 18 },
      ]
      const annotations = {
        items: [
          { type: 'deletion', category: 'filler_words', startTime: 5,  endTime: 8 },
          { type: 'deletion', category: 'filler_words', startTime: 13, endTime: 15 },
        ],
      }
      const cuts = deriveCutsFromAnnotations(annotations, [], words)
      expect(cuts).toHaveLength(2)
      expect(cuts[0].id).toBe('cut-ann-server-0')
      expect(cuts[1].id).toBe('cut-ann-server-1')
      expect(cuts[0].source).toBe('annotation')
      expect(cuts[1].source).toBe('annotation')
    })
  })
})
