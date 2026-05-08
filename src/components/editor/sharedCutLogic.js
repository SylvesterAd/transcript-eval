// Shared cut action constants + creators used by both the rough cut editor
// (useEditorState.js) and the b-roll editor (useBRollEditorState.js, Task 15).
//
// Action shapes match the reducer in useEditorState.js exactly:
//   ADD_CUT:    { type, payload: { id, start, end, source } }
//   REMOVE_CUT: { type, payload: id }
//   UPDATE_CUT: { type, payload: { id, updates: { start?, end? } } }
//
// State shape (must match useEditorState.js):
//   cuts: Array<{ id: string, start: number, end: number, source: 'transcript'|'split'|'manual' }>
//   cutExclusions: Array<{ start: number, end: number }>

export const ADD_CUT = 'ADD_CUT'
export const UPDATE_CUT = 'UPDATE_CUT'
export const REMOVE_CUT = 'REMOVE_CUT'

let cutIdCounter = 0
function nextCutId() {
  cutIdCounter++
  return `cut-${Date.now()}-${cutIdCounter}`
}

/**
 * Compute the action to dispatch when the user clicks "Cut" / razor at the
 * current playhead. Returns null if the click would be a no-op (playhead is
 * already strictly inside an existing cut).
 *
 * Mirrors the zero-width-razor branch of handleSplit in PlaybackControls.jsx.
 *
 * Boundary: a playhead exactly at a cut's start or end is treated as
 * "outside" the cut — splitting there is allowed. Only strictly-interior
 * positions (with a small tolerance) return null.
 *
 * @param {{ playheadTime: number, cuts: Array, cutExclusions: Array }} opts
 * @returns {{ type: 'ADD_CUT', payload: { id: string, start: number, end: number, source: string } } | null}
 */
export function splitAtPlayhead({ playheadTime, cuts, cutExclusions = [] }) {
  if (typeof playheadTime !== 'number' || !Number.isFinite(playheadTime)) return null
  for (const c of cuts || []) {
    if (playheadTime > c.start + 0.001 && playheadTime < c.end - 0.001) return null
  }
  return {
    type: ADD_CUT,
    payload: {
      id: nextCutId(),
      start: playheadTime,
      end: playheadTime,
      source: 'split',
      splitPoint: playheadTime,
    },
  }
}

/**
 * Compute the action to dispatch when the user drags a cut edge handle.
 *
 * Always returns UPDATE_CUT — mirroring the existing handleEdgeDrag behavior
 * in TimelineTrack.jsx, which dispatches UPDATE_CUT for every source type.
 *
 * @param {{ cut: object, edge: 'start'|'end', newTime: number, cuts: Array }} opts
 * @returns {{ type: 'UPDATE_CUT', payload: { id: string, updates: object } } | null}
 */
export function resolveEdgeDrag({ cut, edge, newTime }) {
  if (!cut || (edge !== 'start' && edge !== 'end')) return null
  if (typeof newTime !== 'number' || !Number.isFinite(newTime)) return null

  return {
    type: UPDATE_CUT,
    payload: {
      id: cut.id,
      updates: edge === 'start' ? { start: newTime } : { end: newTime },
    },
  }
}
