import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { supabase } from '../../lib/supabaseClient.js'
import { apiPost } from '../../hooks/useApi.js'
import { EditorContext } from './EditorView.jsx'
import { matchPlacementsToTranscript } from './brollUtils.js'
import { getClipboard, setClipboard } from './brollClipboard.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

// Editor-state action kinds. Each APPLY_ACTION payload is of this shape:
//   { id: string, ts: number, kind: string, ...action-specific fields }
// `before` and `after` capture just the mutated slots so the action can be reversed.
const MAX_UNDO = 50

function generateActionId() {
  return 'act_' + (crypto.randomUUID?.() || (Math.random().toString(36).slice(2) + Date.now().toString(36))).slice(0, 12)
}

export const BRollContext = createContext(null)

export async function authFetchBRollData(planPipelineId, signal) {
  return authFetch(`/broll/pipeline/${planPipelineId}/editor-data`, signal)
}

async function authFetch(path, signal) {
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  const res = await fetch(`${API_BASE}${path}`, { headers, signal })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

async function authPut(path, body, signal) {
  const headers = { 'Content-Type': 'application/json' }
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  const res = await fetch(`${API_BASE}${path}`, { method: 'PUT', headers, body: JSON.stringify(body), signal })
  if (res.status === 409) {
    const parsed = await res.json().catch(() => ({}))
    const err = new Error('conflict')
    err.conflict = parsed
    throw err
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

// Applies just the mutation side of an action to the reducer's editor-state slots.
// Used by APPLY_ACTION (with action.after), UNDO (with entry.before), and REDO (with entry.after).
function applyMutation(state, entry, side /* 'before' | 'after' */) {
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

function reducer(state, action) {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, rawPlacements: [], placements: [], selectedIndex: null, selectedResults: {}, loading: true, error: null }
    case 'SET_DATA_RESOLVED':
      // Clearing selectedIndex is required on variant switches: the old variant's
      // index would otherwise resolve against the new variant's placements and open
      // the wrong placement. The pending-selection effect in BRollEditor re-applies
      // the correct index when the user clicked an inactive-variant b-roll.
      return { ...state, rawPlacements: action.payload.rawPlacements, placements: action.payload.placements, selectedIndex: null, selectedResults: {}, searchProgress: action.payload.searchProgress, loading: false, error: null }
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

const initialState = {
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
}

export function useBRollEditorState(planPipelineId) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const editorCtx = useContext(EditorContext)
  const pollRef = useRef(null)
  // Tracks which pipelineId the current reducer state was seeded for — so the load effect
  // can skip SET_LOADING + fetch when a cached seed already populated placements.
  const seededPipelineIdRef = useRef(null)

  // Fetch editor data on mount or when pipeline changes (variant switch)
  const refetchEditorData = useCallback(() => {
    if (!planPipelineId) return
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => dispatch({ type: 'MERGE_SEARCH_RESULTS', payload: data }))
      .catch(() => {})
  }, [planPipelineId])

  // Resolve placements against transcript words
  const transcriptWords = useMemo(() => {
    if (!editorCtx?.state?.tracks) return []
    const audioTrack = editorCtx.state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    if (!audioTrack) return []
    return audioTrack.transcriptWords.map(w => ({
      word: w.word,
      start: w.start + (audioTrack.offset || 0),
      end: w.end + (audioTrack.offset || 0),
    }))
  }, [editorCtx?.state?.tracks])
  const transcriptWordsRef = useRef(transcriptWords)
  transcriptWordsRef.current = transcriptWords

  const editsRef = useRef(state.edits)
  editsRef.current = state.edits

  const userPlacementsRef = useRef(state.userPlacements)
  userPlacementsRef.current = state.userPlacements

  // Seed cached placements synchronously. Called by BRollEditor BEFORE setActiveVariantIdx,
  // so the pipelineId passed here is the INCOMING one.
  const seedFromCache = useCallback((pipelineId, rawPlacements, searchProgress) => {
    const visible = rawPlacements.filter(p => !p.hidden)
    const resolved = matchPlacementsToTranscript(
      [...visible, ...userPlacementsRef.current.map(up => ({
        ...(up.snapshot || {}),
        index: `user:${up.id}`,
        userPlacementId: up.id,
        isUserPlacement: true,
        userTimelineStart: up.timelineStart,
        userTimelineEnd: up.timelineEnd,
        results: up.results,
        searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
        chapterIndex: null,
        placementIndex: null,
      }))],
      transcriptWordsRef.current,
      editsRef.current,
    )
    seededPipelineIdRef.current = pipelineId
    dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements, placements: resolved, searchProgress: searchProgress || null } })
  }, [])

  useEffect(() => {
    if (!planPipelineId) return

    // If seedFromCache just populated the reducer for this exact pipelineId, skip the
    // LOADING→fetch→RESOLVED round-trip. If the seeded searchProgress.status is 'running',
    // the active-pipeline poll below will live-refresh results. If the search finished
    // between the last inactive-poll and the seed, results may be transiently stale
    // until the user takes another action — acceptable trade-off to avoid the blank frame.
    if (seededPipelineIdRef.current === planPipelineId) {
      seededPipelineIdRef.current = null
      return
    }

    if (!transcriptWords.length) {
      // Wait for transcript words before fetching — otherwise placements resolve with no
      // timelineStart and BRollTrack filters them all out (producing an empty-looking track).
      return
    }
    dispatch({ type: 'SET_LOADING' })
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => {
        const visible = (data.placements || []).filter(p => !p.hidden)
        const resolved = matchPlacementsToTranscript(
          [...visible, ...userPlacementsRef.current.map(up => ({
            ...(up.snapshot || {}),
            index: `user:${up.id}`,
            userPlacementId: up.id,
            isUserPlacement: true,
            userTimelineStart: up.timelineStart,
            userTimelineEnd: up.timelineEnd,
            results: up.results,
            searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
            chapterIndex: null,
            placementIndex: null,
          }))],
          transcriptWordsRef.current,
          editsRef.current,
        )
        dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements: data.placements, placements: resolved, searchProgress: data.searchProgress } })
      })
      .catch(err => dispatch({ type: 'SET_ERROR', payload: err.message }))
  }, [planPipelineId, transcriptWords])

  // Load editor-state in parallel with editor-data. We do a dedicated fetch to get the
  // full state (edits/userPlacements/undo/redo) — editor-data only merges it into placements.
  useEffect(() => {
    if (!planPipelineId) return
    let cancelled = false
    authFetch(`/broll/pipeline/${planPipelineId}/editor-state`)
      .then(data => {
        if (cancelled) return
        dispatch({ type: 'LOAD_EDITOR_STATE', payload: data })
      })
      .catch(() => { /* non-fatal; empty state stays */ })
    return () => { cancelled = true }
  }, [planPipelineId])

  // Re-resolve when transcript words change (rare — only on initial track load)
  useEffect(() => {
    if (!state.rawPlacements.length) return
    if (!transcriptWords.length) return
    const visible = state.rawPlacements.filter(p => !p.hidden)
    const resolved = matchPlacementsToTranscript(
      [...visible, ...userPlacementsRef.current.map(up => ({
        ...(up.snapshot || {}),
        index: `user:${up.id}`,
        userPlacementId: up.id,
        isUserPlacement: true,
        userTimelineStart: up.timelineStart,
        userTimelineEnd: up.timelineEnd,
        results: up.results,
        searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
        chapterIndex: null,
        placementIndex: null,
      }))],
      transcriptWords,
      editsRef.current,
    )
    dispatch({ type: 'SET_RESOLVED', payload: resolved })
  }, [transcriptWords])

  // Poll for progressive search updates
  useEffect(() => {
    if (!planPipelineId || state.searchProgress?.status !== 'running') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(() => {
      authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
        .then(data => dispatch({ type: 'MERGE_SEARCH_RESULTS', payload: data }))
        .catch(() => {})
    }, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [planPipelineId, state.searchProgress?.status])

  // Refs for debounced save
  const saveTimerRef = useRef(null)
  const savingRef = useRef(false)
  const pendingSaveRef = useRef(false)
  const savePayloadRef = useRef(null)

  const flushSave = useCallback(async () => {
    if (!planPipelineId) return
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (savingRef.current) {
      // A save is already in flight — flag a follow-up
      pendingSaveRef.current = true
      return
    }
    const payload = savePayloadRef.current
    if (!payload) return
    savingRef.current = true
    try {
      const res = await authPut(`/broll/pipeline/${planPipelineId}/editor-state`, payload)
      dispatch({ type: 'SAVE_SUCCESS', payload: { version: res.version } })
    } catch (err) {
      if (err.conflict) {
        dispatch({ type: 'MERGE_REMOTE_STATE', payload: err.conflict })
        pendingSaveRef.current = true
      } else {
        console.error('[broll-editor-state] save failed:', err.message)
      }
    } finally {
      savingRef.current = false
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false
        setTimeout(() => flushSave(), 100)
      }
    }
  }, [planPipelineId])

  // Keep savePayloadRef fresh
  useEffect(() => {
    savePayloadRef.current = {
      state: {
        edits: state.edits,
        userPlacements: state.userPlacements,
        undoStack: state.undoStack,
        redoStack: state.redoStack,
      },
      version: state.editorStateVersion,
    }
  }, [state.edits, state.userPlacements, state.undoStack, state.redoStack, state.editorStateVersion])

  // Debounced save on dirty
  useEffect(() => {
    if (!state.dirty || !planPipelineId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => flushSave(), 500)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [state.dirty, planPipelineId, flushSave])

  // beforeunload — sendBeacon the pending save so edits aren't lost on tab close
  useEffect(() => {
    const handler = (e) => {
      if (!state.dirty) return
      const payload = savePayloadRef.current
      if (payload && navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        navigator.sendBeacon(`${API_BASE}/broll/pipeline/${planPipelineId}/editor-state?beacon=1`, blob)
      }
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [state.dirty, planPipelineId])

  const selectPlacement = useCallback((index) => {
    dispatch({ type: 'SELECT_PLACEMENT', payload: index })
  }, [])

  const selectResult = useCallback((placementIndex, resultIndex) => {
    dispatch({ type: 'SELECT_RESULT', payload: { placementIndex, resultIndex } })
  }, [])

  const selectedPlacement = useMemo(() => {
    if (state.selectedIndex == null) return null
    return state.placements.find(p => p.index === state.selectedIndex) || null
  }, [state.selectedIndex, state.placements])

  // Find which placement covers a given time
  const activePlacementAtTime = useCallback((time) => {
    for (const p of state.placements) {
      if (p.timelineStart <= time && p.timelineEnd > time) return p
    }
    return null
  }, [state.placements])

  // Search a single placement
  const searchPlacement = useCallback(async (index) => {
    const placement = state.rawPlacements[index]
    if (!placement || !planPipelineId) return
    dispatch({ type: 'SET_PLACEMENT_SEARCHING', payload: index })
    try {
      const result = await apiPost(`/broll/pipeline/${planPipelineId}/search-placement`, {
        chapterIndex: placement.chapterIndex,
        placementIndex: placement.placementIndex,
      })
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results: result.results || [],
        searchStatus: result.results?.length ? 'complete' : 'no_results',
      }})
    } catch (err) {
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results: [],
        searchStatus: 'failed',
      }})
    }
  }, [state.rawPlacements, planPipelineId])

  // Search with custom overrides (from edit modal)
  const searchPlacementCustom = useCallback(async (index, overrides) => {
    const placement = state.rawPlacements[index]
    if (!placement || !planPipelineId) return
    dispatch({ type: 'SET_PLACEMENT_SEARCHING', payload: index })
    try {
      const result = await apiPost(`/broll/pipeline/${planPipelineId}/search-placement`, {
        chapterIndex: placement.chapterIndex,
        placementIndex: placement.placementIndex,
        ...overrides,
      })
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results: result.results || [],
        searchStatus: result.results?.length ? 'complete' : 'no_results',
      }})
    } catch (err) {
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results: [],
        searchStatus: 'failed',
      }})
    }
  }, [state.rawPlacements, planPipelineId])

  const searchUserPlacement = useCallback(async (userPlacementId, overrides = {}) => {
    if (!planPipelineId) return
    try {
      await apiPost(`/broll/pipeline/${planPipelineId}/search-user-placement`, {
        userPlacementId, ...overrides,
      })
      // Reload editor-state to pick up new results on the userPlacement
      const data = await authFetch(`/broll/pipeline/${planPipelineId}/editor-state`)
      dispatch({ type: 'LOAD_EDITOR_STATE', payload: data })
    } catch (err) {
      console.error('[broll] user placement search failed:', err.message)
    }
  }, [planPipelineId])

  const hidePlacement = useCallback((index) => {
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const placementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    const userPlacementId = placement.userPlacementId || null

    if (placementKey) {
      const prev = state.edits[placementKey] || {}
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: 'delete',
        placementKey,
        before: { editsSlot: { hidden: !!prev.hidden } },
        after:  { editsSlot: { hidden: true } },
      }
      dispatch({ type: 'APPLY_ACTION', payload: entry })
    } else if (userPlacementId) {
      const up = state.userPlacements.find(u => u.id === userPlacementId)
      if (!up) return
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: 'delete',
        userPlacementId,
        before: { userPlacementCreate: up },
        after:  { userPlacementDelete: true },
      }
      dispatch({ type: 'APPLY_ACTION', payload: entry })
    }
  }, [state.placements, state.edits, state.userPlacements])

  const undo = useCallback(() => dispatch({ type: 'UNDO' }), [])
  const redo = useCallback(() => dispatch({ type: 'REDO' }), [])

  const copyPlacement = useCallback((index, { cut = false } = {}) => {
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const resultIdx = state.selectedResults[index] ?? placement.persistedSelectedResult ?? 0
    const entry = {
      sourcePipelineId: placement.isUserPlacement ? placement.sourcePipelineId : planPipelineId,
      sourceChapterIndex: placement.chapterIndex ?? null,
      sourcePlacementIndex: placement.placementIndex ?? null,
      sourceUserPlacementId: placement.userPlacementId ?? null,
      selectedResult: resultIdx,
      results: JSON.parse(JSON.stringify(placement.results || [])),
      snapshot: {
        description: placement.description,
        audio_anchor: placement.audio_anchor,
        function: placement.function,
        type_group: placement.type_group,
        source_feel: placement.source_feel,
        style: placement.style,
      },
      durationSec: placement.timelineDuration,
      copiedAt: Date.now(),
    }
    setClipboard(entry)
    if (cut) hidePlacement(index)
  }, [state.placements, state.selectedResults, planPipelineId, hidePlacement])

  const pastePlacement = useCallback((targetStartSec) => {
    const entry = getClipboard()
    if (!entry) return
    const uuid = 'u_' + (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12)
    const timelineStart = Math.max(0, targetStartSec)
    const timelineEnd = timelineStart + Math.max(0.5, entry.durationSec || 1)
    const up = {
      id: uuid,
      sourcePipelineId: entry.sourcePipelineId,
      sourceChapterIndex: entry.sourceChapterIndex,
      sourcePlacementIndex: entry.sourcePlacementIndex,
      timelineStart, timelineEnd,
      selectedResult: entry.selectedResult,
      results: entry.results,
      snapshot: entry.snapshot,
    }
    const action = {
      id: generateActionId(),
      ts: Date.now(),
      kind: 'paste',
      userPlacementId: uuid,
      before: { userPlacementDelete: true },
      after:  { userPlacementCreate: up },
    }
    dispatch({ type: 'APPLY_ACTION', payload: action })
  }, [])

  const resetPlacement = useCallback((index) => {
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const placementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    if (!placementKey) return
    const prev = state.edits[placementKey]
    if (!prev) return
    dispatch({ type: 'APPLY_ACTION', payload: {
      id: generateActionId(), ts: Date.now(), kind: 'reset', placementKey,
      before: { editsSlot: prev },
      after:  { editsSlot: null },
    }})
  }, [state.placements, state.edits])

  const dragCrossPlacement = useCallback(async ({ sourceIndex, targetPipelineId, targetStartSec, mode }) => {
    const placement = state.placements.find(p => p.index === sourceIndex)
    if (!placement) return
    const resultIdx = state.selectedResults[sourceIndex] ?? placement.persistedSelectedResult ?? 0
    const uuid = 'u_' + (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12)
    const actionId = generateActionId()
    const up = {
      id: uuid,
      sourcePipelineId: planPipelineId,
      sourceChapterIndex: placement.chapterIndex ?? null,
      sourcePlacementIndex: placement.placementIndex ?? null,
      timelineStart: targetStartSec,
      timelineEnd: targetStartSec + Math.max(0.5, placement.timelineDuration || 1),
      selectedResult: resultIdx,
      results: JSON.parse(JSON.stringify(placement.results || [])),
      snapshot: {
        description: placement.description,
        audio_anchor: placement.audio_anchor,
        function: placement.function,
        type_group: placement.type_group,
        source_feel: placement.source_feel,
        style: placement.style,
      },
    }

    // Write to target pipeline's editor-state with optimistic concurrency.
    try {
      const remote = await authFetch(`/broll/pipeline/${targetPipelineId}/editor-state`)
      const next = {
        edits: remote.state?.edits || {},
        userPlacements: [...(remote.state?.userPlacements || []), up],
        undoStack: [...(remote.state?.undoStack || []), {
          id: generateActionId(), ts: Date.now(), kind: 'drag-cross', userPlacementId: uuid,
          before: { userPlacementDelete: true }, after: { userPlacementCreate: up },
        }].slice(-MAX_UNDO),
        redoStack: [],
      }
      await authPut(`/broll/pipeline/${targetPipelineId}/editor-state`, { state: next, version: remote.version })
    } catch (err) {
      console.error('[broll-drag-cross] Failed to write target:', err.message)
      return
    }

    // Source side: if mode === 'move', hide the original (or remove the userPlacement).
    if (mode === 'move') {
      const placementKey = placement.chapterIndex != null && placement.placementIndex != null
        ? `${placement.chapterIndex}:${placement.placementIndex}`
        : null
      if (placementKey) {
        const prev = state.edits[placementKey] || {}
        dispatch({ type: 'APPLY_ACTION', payload: {
          id: actionId, ts: Date.now(), kind: 'drag-cross', placementKey,
          before: { editsSlot: { hidden: !!prev.hidden } },
          after:  { editsSlot: { hidden: true } },
        }})
      } else if (placement.userPlacementId) {
        dispatch({ type: 'APPLY_ACTION', payload: {
          id: actionId, ts: Date.now(), kind: 'drag-cross', userPlacementId: placement.userPlacementId,
          before: { userPlacementCreate: state.userPlacements.find(u => u.id === placement.userPlacementId) },
          after:  { userPlacementDelete: true },
        }})
      }
    }
  }, [state.placements, state.selectedResults, state.edits, state.userPlacements, planPipelineId])

  const updatePlacementPosition = useCallback((index, timelineStart, timelineEnd, opts = {}) => {
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const placementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    const userPlacementId = placement.userPlacementId || null

    const COALESCE_KINDS = new Set(['move', 'resize'])

    if (placementKey) {
      const prev = state.edits[placementKey] || {}
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: opts.kind || 'move',
        placementKey,
        before: { editsSlot: { timelineStart: prev.timelineStart, timelineEnd: prev.timelineEnd } },
        after:  { editsSlot: { timelineStart, timelineEnd } },
      }
      const last = state.undoStack[state.undoStack.length - 1]
      const sameTarget = last
        && COALESCE_KINDS.has(entry.kind)
        && (last.kind === entry.kind)
        && (last.placementKey === entry.placementKey)
        && (last.userPlacementId === entry.userPlacementId)
        && (Date.now() - (last.ts || 0) < 800)
      dispatch({ type: sameTarget ? 'APPLY_ACTION_COALESCE' : 'APPLY_ACTION', payload: entry })
    } else if (userPlacementId) {
      const up = state.userPlacements.find(u => u.id === userPlacementId)
      if (!up) return
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: opts.kind || 'move',
        userPlacementId,
        before: { userPlacementPatch: { timelineStart: up.timelineStart, timelineEnd: up.timelineEnd } },
        after:  { userPlacementPatch: { timelineStart, timelineEnd } },
      }
      const last = state.undoStack[state.undoStack.length - 1]
      const sameTarget = last
        && COALESCE_KINDS.has(entry.kind)
        && (last.kind === entry.kind)
        && (last.placementKey === entry.placementKey)
        && (last.userPlacementId === entry.userPlacementId)
        && (Date.now() - (last.ts || 0) < 800)
      dispatch({ type: sameTarget ? 'APPLY_ACTION_COALESCE' : 'APPLY_ACTION', payload: entry })
    }
  }, [state.placements, state.edits, state.userPlacements, state.undoStack])

  const resetAllPlacements = useCallback(() => dispatch({ type: 'RESET_ALL_PLACEMENTS' }), [])

  return useMemo(() => ({
    rawPlacements: state.rawPlacements,
    placements: state.placements,
    seedFromCache,
    selectedIndex: state.selectedIndex,
    selectedPlacement,
    selectedResults: state.selectedResults,
    searchProgress: state.searchProgress,
    loading: state.loading,
    error: state.error,
    selectPlacement,
    selectResult,
    activePlacementAtTime,
    searchPlacement,
    searchPlacementCustom,
    searchUserPlacement,
    hidePlacement,
    undo,
    redo,
    copyPlacement,
    pastePlacement,
    resetPlacement,
    dragCrossPlacement,
    updatePlacementPosition,
    resetAllPlacements,
    refetchEditorData,
    planPipelineId,
    edits: state.edits,
    userPlacements: state.userPlacements,
    undoStack: state.undoStack,
    redoStack: state.redoStack,
    editorStateVersion: state.editorStateVersion,
    dirty: state.dirty,
    flushSave,
  }), [
    state.rawPlacements, state.placements, state.selectedIndex, selectedPlacement,
    state.selectedResults, state.searchProgress, state.loading, state.error,
    seedFromCache, selectPlacement, selectResult, activePlacementAtTime,
    searchPlacement, searchPlacementCustom, searchUserPlacement, hidePlacement, undo, redo,
    copyPlacement, pastePlacement, resetPlacement, dragCrossPlacement,
    updatePlacementPosition,
    resetAllPlacements, refetchEditorData, planPipelineId,
    state.edits, state.userPlacements, state.undoStack, state.redoStack, state.editorStateVersion, state.dirty,
    flushSave,
  ])
}
