import { describe, it, expect } from 'vitest'
import { reducer } from '../useEditorState.js'
import { ADD_CUT } from '../sharedCutLogic.js'

// Reducer behavior: ADD_CUT should extend a cut back to 0 when it covers
// the first transcribed word. Mirrors the annotation-cut head-trim already
// applied by TranscriptEditor.jsx so the timeline-origin sliver (silence,
// throat-clear before the first detected word) is included in the cut.

function baseState(firstWordStart = 0.20) {
  return {
    cuts: [],
    cutExclusions: [],
    tracks: [
      {
        id: 'a1',
        type: 'audio',
        duration: 60,
        offset: 0,
        transcriptWords: [
          { start: firstWordStart, end: firstWordStart + 0.35, word: '[clears throat]' },
          { start: firstWordStart + 4.0, end: firstWordStart + 4.5, word: "you've" },
        ],
      },
    ],
  }
}

describe('ADD_CUT reducer — head-trim to timeline origin', () => {
  it('snaps cut.start to 0 when the cut covers the first transcribed word', () => {
    const state = baseState(0.20)
    const next = reducer(state, {
      type: ADD_CUT,
      payload: { id: 'c1', start: 0.20, end: 4.50, source: 'transcript' },
    })
    expect(next.cuts).toHaveLength(1)
    expect(next.cuts[0].start).toBe(0)
    expect(next.cuts[0].end).toBe(4.50)
    expect(next.cuts[0].source).toBe('transcript')
  })

  it('keeps cut.start unchanged when the cut is in the middle of the transcript', () => {
    const state = baseState(0.20)
    const next = reducer(state, {
      type: ADD_CUT,
      payload: { id: 'c1', start: 10, end: 15, source: 'transcript' },
    })
    expect(next.cuts[0].start).toBe(10)
    expect(next.cuts[0].end).toBe(15)
  })

  it('leaves zero-width splits alone (no head-trim on razor markers)', () => {
    // A razor at the first word should remain a marker at firstWord.start —
    // not extend backwards into a 0-length region that visually appears as a
    // start-of-timeline cut.
    const state = baseState(0.20)
    const next = reducer(state, {
      type: ADD_CUT,
      payload: { id: 's1', start: 0.20, end: 0.20, source: 'split', splitPoint: 0.20 },
    })
    expect(next.cuts[0].start).toBe(0.20)
    expect(next.cuts[0].end).toBe(0.20)
  })

  it('does not snap when there is no transcribed audio track', () => {
    const state = { ...baseState(0.20), tracks: [] }
    const next = reducer(state, {
      type: ADD_CUT,
      payload: { id: 'c1', start: 0.20, end: 4.50, source: 'transcript' },
    })
    expect(next.cuts[0].start).toBe(0.20)
  })

  it('respects the primary audio track offset when locating the first word', () => {
    // Audio track with transcriptWords starting at 0 but offset by 1.5 →
    // effective first-word start is 1.5. A cut starting at 1.5 should snap
    // to 0.
    const state = {
      cuts: [],
      cutExclusions: [],
      tracks: [
        {
          id: 'a1',
          type: 'audio',
          duration: 60,
          offset: 1.5,
          transcriptWords: [
            { start: 0, end: 0.35, word: '[clears throat]' },
          ],
        },
      ],
    }
    const next = reducer(state, {
      type: ADD_CUT,
      payload: { id: 'c1', start: 1.5, end: 4.5, source: 'transcript' },
    })
    expect(next.cuts[0].start).toBe(0)
  })
})
