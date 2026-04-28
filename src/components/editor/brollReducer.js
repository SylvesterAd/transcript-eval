import { matchPlacementsToTranscript } from './brollUtils.js'

// Editor-state action kinds. Each APPLY_ACTION payload is of this shape:
//   { id: string, ts: number, kind: string, ...action-specific fields }
// `before` and `after` capture just the mutated slots so the action can be reversed.
export const MAX_UNDO = 50

export function generateActionId() {
  return 'act_' + (crypto.randomUUID?.() || (Math.random().toString(36).slice(2) + Date.now().toString(36))).slice(0, 12)
}

// Applies just the mutation side of an action to the reducer's editor-state slots.
// Used by APPLY_ACTION (with action.after), UNDO (with entry.before), and REDO (with entry.after).
export function applyMutation(state, entry, side /* 'before' | 'after' */) {
  const patch = entry[side] || {}
  let nextEdits = state.edits
  let nextUserPlacements = state.userPlacements

  if (entry.placementKey != null) {
    // Mutation targets an original placement's `edits[key]` slot.
    const key = entry.placementKey
    if (patch.editsSlot === null) {
      // Delete the edits slot entirely (e.g. "reset to original")
      nextEdits = { ...nextEdits }
      delete nextEdits[key]
    } else if (patch.editsSlot) {
      nextEdits = { ...nextEdits, [key]: { ...(nextEdits[key] || {}), ...patch.editsSlot } }
    }
  }

  if (entry.userPlacementId != null) {
    // Mutation targets a userPlacement.
    if (patch.userPlacementDelete) {
      nextUserPlacements = nextUserPlacements.filter(up => up.id !== entry.userPlacementId)
    } else if (patch.userPlacementCreate) {
      // Only create if not already present (avoid dup on repeated redo)
      if (!nextUserPlacements.some(up => up.id === entry.userPlacementId)) {
        nextUserPlacements = [...nextUserPlacements, patch.userPlacementCreate]
      }
    } else if (patch.userPlacementPatch) {
      nextUserPlacements = nextUserPlacements.map(up =>
        up.id === entry.userPlacementId ? { ...up, ...patch.userPlacementPatch } : up
      )
    }
  }

  return { ...state, edits: nextEdits, userPlacements: nextUserPlacements, dirty: true }
}

// Build a placement entry matching the server's merged userPlacement shape (broll.js:5181),
// adapted for client-side resolution. chapterIndex/placementIndex are set to null (not the
// source indices) so the entry doesn't pick up the source placement's edits[key] overrides
// — userPlacements have their own timeline/result fields and are not edit-key keyed.
export function userPlacementToRawEntry(up) {
  return {
    ...(up.snapshot || {}),
    index: `user:${up.id}`,
    userPlacementId: up.id,
    isUserPlacement: true,
    sourcePipelineId: up.sourcePipelineId,
    chapterIndex: null,
    placementIndex: null,
    userTimelineStart: up.timelineStart,
    userTimelineEnd: up.timelineEnd,
    persistedSelectedResult: up.selectedResult,
    results: up.results || [],
    searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
  }
}

// Resolve placements, choosing between server-authoritative (no local editor-state yet)
// and local-authoritative (after LOAD_EDITOR_STATE has populated state.userPlacements/edits).
// Both modes filter hidden placements; local mode strips server's userPlacements and re-adds
// from local state so unsaved local edits to userPlacements are reflected.
export function resolvePlacements({ rawPlacements, userPlacements, edits, transcriptWords, editorStateLoaded }) {
  if (!editorStateLoaded) {
    const visible = rawPlacements.filter(p => !p.hidden)
    return matchPlacementsToTranscript(visible, transcriptWords)
  }
  const visible = rawPlacements.filter(p => !p.hidden && !p.isUserPlacement)
  return matchPlacementsToTranscript(
    [...visible, ...userPlacements.map(userPlacementToRawEntry)],
    transcriptWords,
    edits,
  )
}

export function reducer(state, action) {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, rawPlacements: [], placements: [], selectedIndex: null, selectedResults: {}, loading: true, error: null }
    case 'RESET_PIPELINE_STATE':
      // Clear all per-pipeline state. Used when switching to a different planPipelineId so
      // the outgoing pipeline's userPlacements/edits/undoStack don't leak into the new view
      // before LOAD_EDITOR_STATE arrives.
      return {
        ...state,
        edits: {},
        userPlacements: [],
        undoStack: [],
        redoStack: [],
        editorStateVersion: 0,
        dirty: false,
        editorStateLoaded: false,
        selectedIndex: null,
        selectedResults: {},
      }
    case 'SET_DATA_RESOLVED': {
      // Clearing selectedIndex is required on variant switches: the old variant's
      // index would otherwise resolve against the new variant's placements and open
      // the wrong placement. The pending-selection effect in BRollEditor re-applies
      // the correct index when the user clicked an inactive-variant b-roll.
      // On same-pipeline refreshes (pipelineChanged=false), preserve selection to
      // avoid flickering the detail panel during 5s polling updates.
      const { rawPlacements, placements, searchProgress, pipelineChanged = true } = action.payload
      const next = { ...state, rawPlacements, placements, searchProgress, loading: false, error: null }
      if (pipelineChanged) {
        next.selectedIndex = null
        next.selectedResults = {}
      }
      return next
    }
    case 'SET_RESOLVED':
      return { ...state, placements: action.payload }
    case 'SET_ERROR':
      return { ...state, error: action.payload, loading: false }
    case 'SELECT_PLACEMENT':
      return { ...state, selectedIndex: action.payload }
    case 'SELECT_RESULT':
      return { ...state, selectedResults: { ...state.selectedResults, [action.payload.placementIndex]: action.payload.resultIndex } }
    case 'MERGE_SEARCH_RESULTS': {
      const { placements: newPlacements, searchProgress } = action.payload
      const merged = state.rawPlacements.map((existing, i) => {
        if (existing.hidden) return existing
        const updated = newPlacements[i]
        if (!updated) return existing
        if (existing.searchStatus === 'complete' && updated.searchStatus === 'pending') return existing
        return { ...existing, results: updated.results, searchStatus: updated.searchStatus }
      })
      // Also propagate the updated results/searchStatus into the already-resolved placements
      // array so BRollTrack (which reads placements, not rawPlacements) shows progressive
      // search updates without waiting for a transcriptWords change.
      const mergedPlacements = state.placements.map(resolved => {
        const raw = merged.find(r => r.index === resolved.index)
        if (!raw) return resolved
        if (resolved.results === raw.results && resolved.searchStatus === raw.searchStatus) return resolved
        return { ...resolved, results: raw.results, searchStatus: raw.searchStatus }
      })
      return { ...state, rawPlacements: merged, placements: mergedPlacements, searchProgress }
    }
    case 'SET_PLACEMENT_SEARCHING': {
      const updated = state.rawPlacements.map((p, i) =>
        i === action.payload ? { ...p, searchStatus: 'searching' } : p
      )
      return { ...state, rawPlacements: updated }
    }
    case 'SET_PLACEMENT_RESULTS': {
      const { index, results, searchStatus } = action.payload
      const updated = state.rawPlacements.map((p, i) =>
        i === index ? { ...p, results, searchStatus } : p
      )
      return { ...state, rawPlacements: updated }
    }
    case 'RESET_ALL_PLACEMENTS': {
      const reset = state.rawPlacements.map(p => ({
        ...p,
        hidden: false,
        userTimelineStart: undefined,
        userTimelineEnd: undefined,
        results: [],
        searchStatus: 'pending',
      }))
      return { ...state, rawPlacements: reset, selectedResults: {}, searchProgress: null }
    }
    case 'LOAD_EDITOR_STATE': {
      const { state: loaded, version } = action.payload
      return {
        ...state,
        edits: loaded.edits || {},
        userPlacements: Array.isArray(loaded.userPlacements) ? loaded.userPlacements : [],
        undoStack: Array.isArray(loaded.undoStack) ? loaded.undoStack : [],
        redoStack: Array.isArray(loaded.redoStack) ? loaded.redoStack : [],
        editorStateVersion: version || 0,
        dirty: false,
        editorStateLoaded: true,
      }
    }
    case 'APPLY_ACTION': {
      const entry = action.payload
      const applied = applyMutation(state, entry, 'after')
      const newUndoStack = [...state.undoStack, entry].slice(-MAX_UNDO)
      return { ...applied, undoStack: newUndoStack, redoStack: [] }
    }
    case 'APPLY_ACTION_COALESCE': {
      const entry = action.payload
      if (!state.undoStack.length) {
        // No previous action to coalesce with — behave like APPLY_ACTION
        const applied = applyMutation(state, entry, 'after')
        const newUndoStack = [...state.undoStack, entry].slice(-MAX_UNDO)
        return { ...applied, undoStack: newUndoStack, redoStack: [] }
      }
      const last = state.undoStack[state.undoStack.length - 1]
      // Build merged entry: keep last's before, take current's after, bump ts
      const merged = {
        ...last,
        ts: entry.ts,
        after: entry.after,
      }
      const applied = applyMutation(state, merged, 'after')
      return {
        ...applied,
        undoStack: [...state.undoStack.slice(0, -1), merged],
        redoStack: [],
      }
    }
    case 'UNDO': {
      const stack = state.undoStack
      if (!stack.length) return state
      const entry = stack[stack.length - 1]
      const applied = applyMutation(state, entry, 'before')
      return {
        ...applied,
        undoStack: stack.slice(0, -1),
        redoStack: [...state.redoStack, entry],
      }
    }
    case 'CONDITIONAL_UNDO': {
      // Roll back only if the head of undoStack matches the action we expect.
      // Used by async cross-pipeline redo when the server PUT fails: we need to
      // un-redo the local change, but only if no unrelated action has been pushed
      // on top in the meantime (otherwise we'd corrupt that entry instead).
      const stack = state.undoStack
      if (!stack.length) return state
      const entry = stack[stack.length - 1]
      if (entry.id !== action.payload?.entryId) return state
      const applied = applyMutation(state, entry, 'before')
      return {
        ...applied,
        undoStack: stack.slice(0, -1),
        redoStack: [...state.redoStack, entry],
      }
    }
    case 'PATCH_UNDO_ENTRY': {
      const { entryId, patch } = action.payload || {}
      if (!entryId || !patch) return state
      const idx = state.undoStack.findIndex(e => e.id === entryId)
      if (idx === -1) return state
      const updated = { ...state.undoStack[idx], ...patch }
      const nextStack = [...state.undoStack.slice(0, idx), updated, ...state.undoStack.slice(idx + 1)]
      return { ...state, undoStack: nextStack }
    }
    case 'REDO': {
      const stack = state.redoStack
      if (!stack.length) return state
      const entry = stack[stack.length - 1]
      const applied = applyMutation(state, entry, 'after')
      return {
        ...applied,
        redoStack: stack.slice(0, -1),
        undoStack: [...state.undoStack, entry].slice(-MAX_UNDO),
      }
    }
    case 'CONDITIONAL_REDO': {
      // Mirror of CONDITIONAL_UNDO — used by async cross-pipeline undo on failure.
      const stack = state.redoStack
      if (!stack.length) return state
      const entry = stack[stack.length - 1]
      if (entry.id !== action.payload?.entryId) return state
      const applied = applyMutation(state, entry, 'after')
      return {
        ...applied,
        redoStack: stack.slice(0, -1),
        undoStack: [...state.undoStack, entry].slice(-MAX_UNDO),
      }
    }
    case 'MERGE_REMOTE_STATE': {
      // Used after a 409: replace base with remote state, then replay any pending
      // local actions (undoStack entries whose ids are NOT in the remote stack).
      const { state: remoteState, version } = action.payload
      const remoteUndo = Array.isArray(remoteState.undoStack) ? remoteState.undoStack : []
      const remoteIds = new Set(remoteUndo.map(e => e.id))
      // Collect targets the remote has also mutated — we'll skip any local pending
      // entry that targets the same key/userPlacement to avoid corrupting shared state
      // via mis-captured `before` snapshots.
      const remoteTargets = new Set()
      for (const e of remoteUndo) {
        if (e.placementKey) remoteTargets.add('pk:' + e.placementKey)
        if (e.userPlacementId) remoteTargets.add('up:' + e.userPlacementId)
      }
      const pending = state.undoStack.filter(e => {
        if (remoteIds.has(e.id)) return false
        const keyTag = e.placementKey ? 'pk:' + e.placementKey : null
        const upTag  = e.userPlacementId ? 'up:' + e.userPlacementId : null
        if ((keyTag && remoteTargets.has(keyTag)) || (upTag && remoteTargets.has(upTag))) {
          console.warn('[broll-merge] dropping pending action — remote also mutated', e.kind, e.placementKey || e.userPlacementId)
          return false
        }
        return true
      })
      let next = {
        ...state,
        edits: remoteState.edits || {},
        userPlacements: Array.isArray(remoteState.userPlacements) ? remoteState.userPlacements : [],
        undoStack: remoteUndo,
        redoStack: Array.isArray(remoteState.redoStack) ? remoteState.redoStack : [],
        editorStateVersion: version,
        dirty: pending.length > 0,
        editorStateLoaded: true,
      }
      for (const entry of pending) {
        next = applyMutation(next, entry, 'after')
        next = { ...next, undoStack: [...next.undoStack, entry].slice(-MAX_UNDO) }
      }
      return next
    }
    case 'SAVE_SUCCESS': {
      return { ...state, editorStateVersion: action.payload.version, dirty: false }
    }
    case 'REMOVE_ORPHAN_RAW_PLACEMENT': {
      const { userPlacementId } = action.payload || {}
      if (!userPlacementId) return state
      const filtered = state.rawPlacements.filter(p => p.userPlacementId !== userPlacementId)
      if (filtered.length === state.rawPlacements.length) return state
      return {
        ...state,
        rawPlacements: filtered,
        placements: state.placements.filter(p => p.userPlacementId !== userPlacementId),
      }
    }
    case 'SET_LOAD_ERROR':
      return { ...state, loadError: action.payload }
    case 'CLEAR_LOAD_ERROR':
      if (state.loadError == null) return state
      return { ...state, loadError: null }
    default:
      return state
  }
}

export const initialState = {
  rawPlacements: [],
  placements: [],      // resolved with timelineStart/timelineDuration
  selectedIndex: null,
  selectedResults: {},  // { [placementIndex]: resultIndex }
  searchProgress: null,
  loading: true,
  error: null,
  // Editor state — persisted per pipeline
  edits: {},                  // { "chapterIdx:placementIdx": { hidden?, timelineStart?, timelineEnd?, selectedResult? } }
  userPlacements: [],          // array of user-created placements (pastes, cross-variant copies)
  undoStack: [],               // array of action objects
  redoStack: [],               // array of action objects
  editorStateVersion: 0,       // for optimistic concurrency
  dirty: false,                // true while a debounced save is pending
  editorStateLoaded: false,    // true once LOAD_EDITOR_STATE has populated for the current pipeline
  loadError: null,
}
