import { describe, it, expect } from 'vitest'
import { reducer, initialState } from '../brollReducer.js'

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
