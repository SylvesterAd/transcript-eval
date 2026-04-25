import { describe, it, expect } from 'vitest'
import { reducer, initialState, userPlacementToRawEntry } from '../brollReducer.js'

describe('reducer SET_DATA_RESOLVED', () => {
  it('clears selectedIndex when payload.pipelineChanged is true', () => {
    const base = { ...initialState, selectedIndex: 5, selectedResults: { 5: 2 } }
    const next = reducer(base, { type: 'SET_DATA_RESOLVED', payload: {
      rawPlacements: [], placements: [], searchProgress: null, pipelineChanged: true,
    }})
    expect(next.selectedIndex).toBe(null)
    expect(next.selectedResults).toEqual({})
  })

  it('preserves selectedIndex when payload.pipelineChanged is false', () => {
    const base = { ...initialState, selectedIndex: 5, selectedResults: { 5: 2 } }
    const next = reducer(base, { type: 'SET_DATA_RESOLVED', payload: {
      rawPlacements: [], placements: [], searchProgress: null, pipelineChanged: false,
    }})
    expect(next.selectedIndex).toBe(5)
    expect(next.selectedResults).toEqual({ 5: 2 })
  })
})

describe('reducer APPLY_ACTION_COALESCE', () => {
  it('coalesces consecutive resize actions on same placementKey', () => {
    const base = {
      ...initialState,
      undoStack: [{
        id: 'a1', ts: Date.now(), kind: 'resize', placementKey: '0:0',
        before: { editsSlot: { timelineStart: 0, timelineEnd: 1 } },
        after:  { editsSlot: { timelineStart: 0, timelineEnd: 1.5 } },
      }],
      edits: { '0:0': { timelineStart: 0, timelineEnd: 1.5 } },
    }
    const next = reducer(base, { type: 'APPLY_ACTION_COALESCE', payload: {
      id: 'a2', ts: Date.now(), kind: 'resize', placementKey: '0:0',
      before: { editsSlot: { timelineStart: 0, timelineEnd: 1.5 } },
      after:  { editsSlot: { timelineStart: 0, timelineEnd: 2.0 } },
    }})
    expect(next.undoStack.length).toBe(1)
    expect(next.undoStack[0].after.editsSlot.timelineEnd).toBe(2.0)
    expect(next.edits['0:0'].timelineEnd).toBe(2.0)
  })
})

describe('reducer CONDITIONAL_UNDO', () => {
  it('rolls back when entry.id matches stack head', () => {
    const entry = {
      id: 'e1', ts: 0, kind: 'drag-cross', placementKey: '0:0',
      before: { editsSlot: { hidden: false } },
      after:  { editsSlot: { hidden: true } },
    }
    const base = { ...initialState, undoStack: [entry], edits: { '0:0': { hidden: true } } }
    const next = reducer(base, { type: 'CONDITIONAL_UNDO', payload: { entryId: 'e1' } })
    expect(next.undoStack).toEqual([])
    expect(next.edits['0:0']?.hidden).toBe(false)
  })
  it('does NOT roll back when entry.id is no longer at stack head', () => {
    const entry1 = {
      id: 'e1', ts: 0, kind: 'drag-cross', placementKey: '0:0',
      before: { editsSlot: { hidden: false } }, after: { editsSlot: { hidden: true } },
    }
    const entry2 = {
      id: 'e2', ts: 0, kind: 'select-result', placementKey: '0:1',
      before: { editsSlot: { selectedResult: 0 } }, after: { editsSlot: { selectedResult: 3 } },
    }
    const base = { ...initialState, undoStack: [entry1, entry2], edits: { '0:0': { hidden: true }, '0:1': { selectedResult: 3 } } }
    const next = reducer(base, { type: 'CONDITIONAL_UNDO', payload: { entryId: 'e1' } })
    expect(next.undoStack.map(e => e.id)).toEqual(['e1', 'e2'])
    expect(next.edits['0:0']?.hidden).toBe(true)
  })
})

describe('userPlacementToRawEntry', () => {
  it('preserves provided results array as-is', () => {
    const out = userPlacementToRawEntry({
      id: 'u_x', timelineStart: 0, timelineEnd: 1, selectedResult: 0,
      results: [{ id: 'r1' }, { id: 'r2' }],
    })
    expect(out.results.length).toBe(2)
    expect(out.searchStatus).toBe('complete')
  })
  it('marks status pending when results empty', () => {
    const out = userPlacementToRawEntry({
      id: 'u_x', timelineStart: 0, timelineEnd: 1, selectedResult: 0, results: [],
    })
    expect(out.searchStatus).toBe('pending')
  })
})
