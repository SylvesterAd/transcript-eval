import { describe, it, expect } from 'vitest'
import { reducer, initialState } from '../brollReducer.js'

describe('reducer PROBE_DATA_RECEIVED', () => {
  it('clamps timelineEnd when source is shorter than placement', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ uuid: 'p1', timelineStart: 10, timelineEnd: 17 }],
      edits: {},
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'p1', durationSeconds: 6.17, timelineDuration: 7.0 },
    })
    expect(next.edits.p1.original_timeline_duration).toBe(7.0)
    expect(next.edits.p1.auto_clamp_applied).toBe(true)
    expect(next.edits.p1.timelineEnd).toBeCloseTo(16.17, 3)
  })

  it('does not clamp when source is longer than placement', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ uuid: 'p1', timelineStart: 10, timelineEnd: 13 }],
      edits: {},
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'p1', durationSeconds: 10.0, timelineDuration: 3.0 },
    })
    expect(next.edits.p1?.auto_clamp_applied).toBeFalsy()
    expect(next.edits.p1?.timelineEnd).toBeUndefined()
    expect(next.edits.p1?.original_timeline_duration).toBe(3.0)
  })

  it('does not clamp when keep_original_duration is already true', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ uuid: 'p1', timelineStart: 10, timelineEnd: 17 }],
      edits: { p1: { keep_original_duration: true } },
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'p1', durationSeconds: 6.17, timelineDuration: 7.0 },
    })
    expect(next.edits.p1.timelineEnd).toBeUndefined()
    expect(next.edits.p1.auto_clamp_applied).toBeFalsy()
  })

  it('preserves original_timeline_duration across repeated probe updates', () => {
    const base = {
      ...initialState,
      rawPlacements: [{ uuid: 'p1', timelineStart: 10, timelineEnd: 17 }],
      edits: { p1: { original_timeline_duration: 7.0, auto_clamp_applied: true, timelineEnd: 16.17 } },
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'p1', durationSeconds: 5.0, timelineDuration: 7.0 },
    })
    expect(next.edits.p1.original_timeline_duration).toBe(7.0)
    expect(next.edits.p1.timelineEnd).toBeCloseTo(15.0, 3)
  })

  it('uses userPlacements.timelineStart when uuid matches a user-pasted clip', () => {
    const base = {
      ...initialState,
      rawPlacements: [],
      userPlacements: [{ id: 'u1', timelineStart: 20, timelineEnd: 27 }],
      edits: {},
    }
    const next = reducer(base, {
      type: 'PROBE_DATA_RECEIVED',
      payload: { uuid: 'u1', durationSeconds: 6.17, timelineDuration: 7.0 },
    })
    expect(next.edits.u1.timelineEnd).toBeCloseTo(26.17, 3)
    expect(next.edits.u1.auto_clamp_applied).toBe(true)
  })
})
