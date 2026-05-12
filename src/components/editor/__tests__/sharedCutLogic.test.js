import { describe, it, expect } from 'vitest'
import {
  splitAtPlayhead,
  resolveEdgeDrag,
  snapCutStartToTimelineStart,
  ADD_CUT,
  UPDATE_CUT,
  REMOVE_CUT,
} from '../sharedCutLogic.js'

describe('sharedCutLogic — action constants', () => {
  it('exports the action type strings', () => {
    expect(ADD_CUT).toBe('ADD_CUT')
    expect(UPDATE_CUT).toBe('UPDATE_CUT')
    expect(REMOVE_CUT).toBe('REMOVE_CUT')
  })
})

describe('splitAtPlayhead', () => {
  it('returns ADD_CUT action for zero-width razor when playhead is not inside any cut', () => {
    const action = splitAtPlayhead({
      playheadTime: 30,
      cuts: [],
      cutExclusions: [],
    })
    // Reducer shape: { type: 'ADD_CUT', payload: { id, start, end, source } }
    expect(action).toMatchObject({
      type: ADD_CUT,
      payload: expect.objectContaining({
        start: 30,
        end: 30,
        source: 'split',
      }),
    })
    expect(typeof action.payload.id).toBe('string')
    expect(action.payload.id.length).toBeGreaterThan(0)
  })

  it('returns null when playhead is strictly inside an existing cut', () => {
    const action = splitAtPlayhead({
      playheadTime: 30,
      cuts: [{ id: 'c1', start: 20, end: 40, source: 'split' }],
      cutExclusions: [],
    })
    expect(action).toBeNull()
  })

  it('treats cut boundaries as outside (playhead exactly at start)', () => {
    const action = splitAtPlayhead({
      playheadTime: 20,
      cuts: [{ id: 'c1', start: 20, end: 40, source: 'split' }],
      cutExclusions: [],
    })
    // Playhead AT the very start of an existing cut is treated as outside —
    // splitting there is allowed.
    expect(action).not.toBeNull()
    expect(action.type).toBe(ADD_CUT)
  })

  it('returns null for invalid playhead time', () => {
    expect(splitAtPlayhead({ playheadTime: NaN, cuts: [], cutExclusions: [] })).toBeNull()
    expect(splitAtPlayhead({ playheadTime: undefined, cuts: [], cutExclusions: [] })).toBeNull()
    expect(splitAtPlayhead({ playheadTime: null, cuts: [], cutExclusions: [] })).toBeNull()
  })

  it('generates unique cut ids across rapid calls', () => {
    const a = splitAtPlayhead({ playheadTime: 10, cuts: [], cutExclusions: [] })
    const b = splitAtPlayhead({ playheadTime: 10, cuts: [], cutExclusions: [] })
    expect(a.payload.id).not.toBe(b.payload.id)
  })
})

describe('resolveEdgeDrag', () => {
  it('returns UPDATE_CUT for dragging the end edge', () => {
    const cut = { id: 'c1', start: 10, end: 20, source: 'split' }
    const action = resolveEdgeDrag({
      cut,
      edge: 'end',
      newTime: 25,
      cuts: [cut],
    })
    // Reducer shape: { type: 'UPDATE_CUT', payload: { id, updates: { end } } }
    expect(action).toEqual({
      type: UPDATE_CUT,
      payload: {
        id: 'c1',
        updates: { end: 25 },
      },
    })
  })

  it('returns UPDATE_CUT with patched start when dragging the start edge', () => {
    const cut = { id: 'c1', start: 10, end: 20, source: 'split' }
    const action = resolveEdgeDrag({
      cut,
      edge: 'start',
      newTime: 8,
      cuts: [cut],
    })
    expect(action).toEqual({
      type: UPDATE_CUT,
      payload: {
        id: 'c1',
        updates: { start: 8 },
      },
    })
  })

  it('returns UPDATE_CUT for a manual cut (source==="manual")', () => {
    const cut = { id: 'm1', start: 10, end: 20, source: 'manual' }
    const action = resolveEdgeDrag({
      cut,
      edge: 'end',
      newTime: 22,
      cuts: [cut],
    })
    expect(action.type).toBe(UPDATE_CUT)
    expect(action.payload.id).toBe('m1')
    expect(action.payload.updates).toEqual({ end: 22 })
  })

  it('returns UPDATE_CUT for a transcript cut (source==="transcript")', () => {
    const cut = { id: 't1', start: 5, end: 15, source: 'transcript' }
    const action = resolveEdgeDrag({
      cut,
      edge: 'start',
      newTime: 3,
      cuts: [cut],
    })
    expect(action.type).toBe(UPDATE_CUT)
    expect(action.payload.id).toBe('t1')
    expect(action.payload.updates).toEqual({ start: 3 })
  })

  it('returns null for invalid cut', () => {
    expect(resolveEdgeDrag({ cut: null, edge: 'start', newTime: 5, cuts: [] })).toBeNull()
  })

  it('returns null for invalid edge', () => {
    expect(resolveEdgeDrag({ cut: { id: 'x', source: 'split' }, edge: 'middle', newTime: 5, cuts: [] })).toBeNull()
  })

  it('returns null for invalid newTime', () => {
    const cut = { id: 'c1', start: 10, end: 20, source: 'split' }
    expect(resolveEdgeDrag({ cut, edge: 'end', newTime: NaN, cuts: [] })).toBeNull()
    expect(resolveEdgeDrag({ cut, edge: 'start', newTime: undefined, cuts: [] })).toBeNull()
  })
})

describe('snapCutStartToTimelineStart', () => {
  // Mirrors the head-trim logic the annotation cut generator already applies
  // (TranscriptEditor.jsx ~lines 421-425): when a cut covers the first
  // transcribed word, extend the cut's start back to 0 so any pre-transcript
  // content (silence, lead-in, throat clears before the first detected word)
  // is included. Without this, a Backspace cut starting at the first word
  // leaves a tiny ~firstWord.start sliver uncut at the timeline origin.

  it('snaps to 0 when cut starts at the first word and covers it', () => {
    // Real case from project 367: user selects from displayItems[0]
    // ([clear throat] at 0.20s) through several later words. Cut start is
    // 0.20, end is ~4.50. Should snap to 0 so the pre-transcript 0–0.20s
    // sliver is included.
    const firstWord = { start: 0.20, end: 0.55 }
    expect(snapCutStartToTimelineStart(0.20, 4.50, firstWord)).toBe(0)
  })

  it('snaps to 0 when cut starts slightly before the first word (within tolerance)', () => {
    const firstWord = { start: 0.20, end: 0.55 }
    expect(snapCutStartToTimelineStart(0.18, 4.50, firstWord)).toBe(0)
  })

  it('snaps to 0 when cut starts slightly after the first word but still overlaps it', () => {
    // Edge drag could land the start just past firstWord.start; still
    // covers the word so the snap should fire.
    const firstWord = { start: 0.20, end: 0.55 }
    expect(snapCutStartToTimelineStart(0.24, 4.50, firstWord)).toBe(0)
  })

  it('does not snap when cut is entirely after the first word', () => {
    const firstWord = { start: 0.20, end: 0.55 }
    expect(snapCutStartToTimelineStart(2.0, 4.50, firstWord)).toBe(2.0)
  })

  it('does not snap when cut is entirely before the first word (no overlap)', () => {
    // Theoretical: tiny cut at 0.05-0.10, but first transcribed word is at 5s.
    // Cut does NOT cover the first word, so don't extend it to 0.
    const firstWord = { start: 5.0, end: 5.4 }
    expect(snapCutStartToTimelineStart(0.05, 0.10, firstWord)).toBe(0.05)
  })

  it('does not snap when there is no first word (empty transcript)', () => {
    expect(snapCutStartToTimelineStart(0.20, 4.50, null)).toBe(0.20)
    expect(snapCutStartToTimelineStart(0.20, 4.50, undefined)).toBe(0.20)
  })

  it('does not snap when start is already 0 (no-op)', () => {
    const firstWord = { start: 0.20, end: 0.55 }
    expect(snapCutStartToTimelineStart(0, 4.50, firstWord)).toBe(0)
  })
})
