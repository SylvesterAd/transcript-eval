import { describe, it, expect } from 'vitest'
import {
  splitAtPlayhead,
  resolveEdgeDrag,
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
