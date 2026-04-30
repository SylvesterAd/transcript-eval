import { matchPlacementsToTranscript } from './brollUtils.js'

// Editor-state action kinds. Each APPLY_ACTION payload is of this shape:
//   { id: string, ts: number, kind: string, ...action-specific fields }
// `before` and `after` capture just the mutated slots so the action can be reversed.
export const MAX_UNDO = 50

export function generateActionId() {
  return 'act_' + (crypto.randomUUID?.() || (Math.random().toString(36).slice(2) + Date.now().toString(36))).slice(0, 12)
}

// Migrate legacy edit keys "${chIdx}:${pIdx}" → "${uuid}" using the freshly-loaded
// rawPlacements list. Keys already starting with `p_` (chapter-derived uuid) or `u_`
// (user-injected uuid) pass through unchanged. Keys whose chIdx:pIdx pair has no
// matching placement also pass through (graceful degradation — preserves the entry
// for a later migration pass once the placement appears).
//
// Idempotent: applying twice is a no-op (uuid keys are detected by prefix).
export function migrateEditsToUuid(edits, rawPlacements) {
  if (!edits || typeof edits !== 'object') return edits || {}
  if (!rawPlacements?.length) return edits
  const out = {}
  // Pass 1: copy uuid-keyed entries first. If a legacy "${ch}:${pl}" entry maps
  // to the same uuid (because a writer landed at the new key while migration
  // was queued), the uuid value is the freshest — pass 2 won't overwrite it.
  for (const [key, value] of Object.entries(edits)) {
    if (key.startsWith('p_') || key.startsWith('u_')) {
      out[key] = value
    }
  }
  // Pass 2: legacy keys → uuid (or pass through if no match).
  for (const [key, value] of Object.entries(edits)) {
    if (key.startsWith('p_') || key.startsWith('u_')) continue
    const colonIdx = key.indexOf(':')
    if (colonIdx === -1) {
      if (!(key in out)) out[key] = value
      continue
    }
    const chIdx = Number(key.slice(0, colonIdx))
    const pIdx = Number(key.slice(colonIdx + 1))
    if (!Number.isFinite(chIdx) || !Number.isFinite(pIdx)) {
      if (!(key in out)) out[key] = value
      continue
    }
    const match = rawPlacements.find(p => p.chapterIndex === chIdx && p.placementIndex === pIdx)
    const newKey = match?.uuid || key
    // Don't clobber: a uuid-keyed entry is fresher than its legacy counterpart.
    if (!(newKey in out)) out[newKey] = value
  }
  return out
}

// Migrate the `placementKey` field on a single undo/redo entry. Used when re-loading
// state from the server: action entries reference edits by key, so they need to be
// rekeyed alongside the dict itself. Returns the entry unchanged if its placementKey
// is already uuid-shaped or if no matching placement is found.
export function migrateActionPlacementKey(entry, rawPlacements) {
  if (!entry || typeof entry !== 'object') return entry
  const key = entry.placementKey
  if (!key) return entry
  if (key.startsWith('p_') || key.startsWith('u_')) return entry
  const colonIdx = key.indexOf(':')
  if (colonIdx === -1) return entry
  const chIdx = Number(key.slice(0, colonIdx))
  const pIdx = Number(key.slice(colonIdx + 1))
  if (!Number.isFinite(chIdx) || !Number.isFinite(pIdx)) return entry
  if (!rawPlacements?.length) return entry
  const match = rawPlacements.find(p => p.chapterIndex === chIdx && p.placementIndex === pIdx)
  if (!match?.uuid) return entry
  return { ...entry, placementKey: match.uuid }
}

function migrateActionStack(stack, rawPlacements) {
  if (!Array.isArray(stack) || !stack.length) return stack
  if (!rawPlacements?.length) return stack
  let changed = false
  const out = stack.map(e => {
    const next = migrateActionPlacementKey(e, rawPlacements)
    if (next !== e) changed = true
    return next
  })
  return changed ? out : stack
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
      // Migrate legacy edit keys "${chIdx}:${pIdx}" → "${uuid}" if rawPlacements
      // are already loaded. If they're not yet, the MIGRATE_EDIT_KEYS effect runs
      // a second pass once they arrive (load-order is non-deterministic).
      const rawForMigration = state.rawPlacements || []
      const loadedEdits = loaded.edits || {}
      const migratedEdits = migrateEditsToUuid(loadedEdits, rawForMigration)
      const loadedUndo = Array.isArray(loaded.undoStack) ? loaded.undoStack : []
      const loadedRedo = Array.isArray(loaded.redoStack) ? loaded.redoStack : []
      return {
        ...state,
        edits: migratedEdits,
        userPlacements: Array.isArray(loaded.userPlacements) ? loaded.userPlacements : [],
        undoStack: migrateActionStack(loadedUndo, rawForMigration),
        redoStack: migrateActionStack(loadedRedo, rawForMigration),
        editorStateVersion: version || 0,
        dirty: false,
        editorStateLoaded: true,
      }
    }
    case 'MIGRATE_EDIT_KEYS': {
      // Second-pass migration once rawPlacements have arrived. No-op if every
      // edits key is already uuid-shaped.
      const raw = state.rawPlacements
      if (!raw?.length) return state
      const migratedEdits = migrateEditsToUuid(state.edits, raw)
      const migratedUndo = migrateActionStack(state.undoStack, raw)
      const migratedRedo = migrateActionStack(state.redoStack, raw)
      if (
        migratedEdits === state.edits &&
        migratedUndo === state.undoStack &&
        migratedRedo === state.redoStack
      ) {
        return state
      }
      // dirty=true so the next debounced save persists the migrated shape back
      // to the server. Without this, a pure migration (no other edits) wouldn't
      // get written and the server would keep returning legacy keys.
      return { ...state, edits: migratedEdits, undoStack: migratedUndo, redoStack: migratedRedo, dirty: true }
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
      // Migrate remote edits/stacks the same way LOAD_EDITOR_STATE does — server
      // may still be returning legacy "${chIdx}:${pIdx}" keys for a pipeline whose
      // editor-state predates this migration.
      const rawForMigration = state.rawPlacements || []
      const remoteEditsMigrated = migrateEditsToUuid(remoteState.edits || {}, rawForMigration)
      const remoteUndoSrc = Array.isArray(remoteState.undoStack) ? remoteState.undoStack : []
      const remoteUndo = migrateActionStack(remoteUndoSrc, rawForMigration)
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
      const remoteRedoSrc = Array.isArray(remoteState.redoStack) ? remoteState.redoStack : []
      const remoteRedo = migrateActionStack(remoteRedoSrc, rawForMigration)
      let next = {
        ...state,
        edits: remoteEditsMigrated,
        userPlacements: Array.isArray(remoteState.userPlacements) ? remoteState.userPlacements : [],
        undoStack: remoteUndo,
        redoStack: remoteRedo,
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
}
