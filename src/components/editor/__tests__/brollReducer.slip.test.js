import { describe, it, expect } from 'vitest'
import { reducer, initialState, buildToggleKeepOriginalEntry } from '../brollReducer.js'

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

describe('buildToggleKeepOriginalEntry', () => {
  it('off→on restores original_timeline_duration into timelineEnd', () => {
    const placement = { uuid: 'p1', timelineStart: 10, timelineEnd: 16.17 }
    const currentEdits = { auto_clamp_applied: true, original_timeline_duration: 7.0, timelineEnd: 16.17 }
    const entry = buildToggleKeepOriginalEntry({ placement, currentEdits, nextValue: true })
    expect(entry.placementKey).toBe('p1')
    expect(entry.after.editsSlot.keep_original_duration).toBe(true)
    expect(entry.after.editsSlot.timelineEnd).toBeCloseTo(17.0, 3)
    expect(entry.after.editsSlot.auto_clamp_applied).toBe(false)
    expect(entry.before.editsSlot.keep_original_duration).toBeUndefined()
    expect(entry.before.editsSlot.timelineEnd).toBeCloseTo(16.17, 3)
    expect(entry.before.editsSlot.auto_clamp_applied).toBe(true)
  })

  it('on→off re-clamps using sourceDurationSeconds', () => {
    const placement = { uuid: 'p1', timelineStart: 10, timelineEnd: 17 }
    const currentEdits = { keep_original_duration: true, original_timeline_duration: 7.0 }
    const entry = buildToggleKeepOriginalEntry({
      placement,
      currentEdits,
      nextValue: false,
      sourceDurationSeconds: 6.17,
    })
    expect(entry.after.editsSlot.keep_original_duration).toBe(false)
    expect(entry.after.editsSlot.timelineEnd).toBeCloseTo(16.17, 3)
    expect(entry.after.editsSlot.auto_clamp_applied).toBe(true)
  })

  it('on→off with longer source removes clamp (no timelineEnd override)', () => {
    const placement = { uuid: 'p1', timelineStart: 10, timelineEnd: 17 }
    const currentEdits = { keep_original_duration: true, original_timeline_duration: 7.0 }
    const entry = buildToggleKeepOriginalEntry({
      placement,
      currentEdits,
      nextValue: false,
      sourceDurationSeconds: 20.0,
    })
    expect(entry.after.editsSlot.keep_original_duration).toBe(false)
    expect(entry.after.editsSlot.timelineEnd).toBeUndefined()
    expect(entry.after.editsSlot.auto_clamp_applied).toBe(false)
  })
})
