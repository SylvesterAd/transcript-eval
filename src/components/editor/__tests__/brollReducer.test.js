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

describe('reducer PATCH_UNDO_ENTRY', () => {
  it('patches the matching entry crossMeta and leaves edits untouched', () => {
    const before = {
      undoStack: [
        { id: 'a', kind: 'drag-cross', placementKey: '0:1',
          targetPipelineId: 'pipe-X', targetUserPlacementId: 'u_1',
          targetUserPlacementSnapshot: { id: 'u_1', timelineStart: 5, timelineEnd: 6 },
          before: { editsSlot: { hidden: false } }, after: { editsSlot: { hidden: true } },
        },
      ],
      edits: { '0:1': { hidden: true } },
      redoStack: [], userPlacements: [], rawPlacements: [], placements: [],
    }
    const next = reducer(before, {
      type: 'PATCH_UNDO_ENTRY',
      payload: { entryId: 'a', patch: { targetUserPlacementSnapshot: { id: 'u_1', timelineStart: 5, timelineEnd: 7.5 } } },
    })
    expect(next.undoStack[0].targetUserPlacementSnapshot.timelineEnd).toBe(7.5)
    expect(next.edits).toBe(before.edits)
  })

  it('is a no-op when entryId is not in undoStack', () => {
    const before = {
      undoStack: [{ id: 'a', kind: 'drag-cross' }],
      edits: {}, redoStack: [], userPlacements: [], rawPlacements: [], placements: [],
    }
    const next = reducer(before, { type: 'PATCH_UNDO_ENTRY', payload: { entryId: 'z', patch: {} } })
    expect(next).toBe(before)
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

describe('reducer REMOVE_ORPHAN_RAW_PLACEMENT', () => {
  it('removes the matching synthetic from rawPlacements AND placements', () => {
    const base = {
      ...initialState,
      rawPlacements: [
        { index: 'user:u_a', userPlacementId: 'u_a', isUserPlacement: true },
        { index: 'user:u_b', userPlacementId: 'u_b', isUserPlacement: true },
      ],
      placements: [
        { index: 'user:u_a', userPlacementId: 'u_a' },
        { index: 'user:u_b', userPlacementId: 'u_b' },
      ],
    }
    const next = reducer(base, { type: 'REMOVE_ORPHAN_RAW_PLACEMENT', payload: { userPlacementId: 'u_a' } })
    expect(next.rawPlacements.map(p => p.userPlacementId)).toEqual(['u_b'])
    expect(next.placements.map(p => p.userPlacementId)).toEqual(['u_b'])
  })

  it('returns same state ref when userPlacementId does not match anything', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ index: 'user:u_b', userPlacementId: 'u_b', isUserPlacement: true }],
      placements: [{ index: 'user:u_b', userPlacementId: 'u_b' }],
    }
    const next = reducer(base, { type: 'REMOVE_ORPHAN_RAW_PLACEMENT', payload: { userPlacementId: 'nope' } })
    expect(next).toBe(base)
  })

  it('returns same state ref when payload is missing/malformed', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ index: 'user:u_b', userPlacementId: 'u_b', isUserPlacement: true }],
    }
    expect(reducer(base, { type: 'REMOVE_ORPHAN_RAW_PLACEMENT' })).toBe(base)
    expect(reducer(base, { type: 'REMOVE_ORPHAN_RAW_PLACEMENT', payload: {} })).toBe(base)
  })
})

describe('reducer SET_LOAD_ERROR / CLEAR_LOAD_ERROR', () => {
  it('SET_LOAD_ERROR sets state.loadError', () => {
    const next = reducer(initialState, { type: 'SET_LOAD_ERROR', payload: '502 Bad Gateway' })
    expect(next.loadError).toBe('502 Bad Gateway')
  })

  it('CLEAR_LOAD_ERROR sets state.loadError to null', () => {
    const base = { ...initialState, loadError: 'oops' }
    const next = reducer(base, { type: 'CLEAR_LOAD_ERROR' })
    expect(next.loadError).toBe(null)
  })

  it('CLEAR_LOAD_ERROR is a no-op (same ref) when already null', () => {
    const next = reducer(initialState, { type: 'CLEAR_LOAD_ERROR' })
    expect(next).toBe(initialState)
  })
})
