import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { supabase } from '../../lib/supabaseClient.js'
import { apiPost } from '../../hooks/useApi.js'
import { EditorContext } from './EditorView.jsx'
import { getClipboard, setClipboard } from './brollClipboard.js'
import {
  reducer,
  initialState,
  applyMutation,
  resolvePlacements,
  userPlacementToRawEntry,
  generateActionId,
  MAX_UNDO,
} from './brollReducer.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

// Tab-session boundary: undo entries with ts < PAGE_LOAD_TS belong to a previous
// session and are filtered out on LOAD_EDITOR_STATE. Prevents accidentally
// undoing actions from a previous tab session.
const PAGE_LOAD_TS = Date.now()

function filterToSession(entries) {
  if (!Array.isArray(entries)) return []
  return entries.filter(e => (e?.ts || 0) >= PAGE_LOAD_TS)
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

export function useBRollEditorState(planPipelineId) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const editorCtx = useContext(EditorContext)
  const pollRef = useRef(null)
  // Tracks which pipelineId the current reducer state was seeded for — so the load effect
  // can skip SET_LOADING + fetch when a cached seed already populated placements.
  const seededPipelineIdRef = useRef(null)
  // Tracks the last pipeline that was loaded/seeded; lets seedFromCache and the load effect
  // detect a pipeline switch and dispatch RESET_PIPELINE_STATE so the outgoing pipeline's
  // userPlacements/edits don't bleed into the new view.
  const lastLoadedPipelineIdRef = useRef(null)

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

  const editorStateLoadedRef = useRef(state.editorStateLoaded)
  editorStateLoadedRef.current = state.editorStateLoaded

  // Seed cached placements synchronously. Called by BRollEditor BEFORE setActiveVariantIdx,
  // so the pipelineId passed here is the INCOMING one.
  const seedFromCache = useCallback((pipelineId, rawPlacements, searchProgress) => {
    const isPipelineSwitch = lastLoadedPipelineIdRef.current !== null && lastLoadedPipelineIdRef.current !== pipelineId
    if (isPipelineSwitch) {
      // Drop outgoing pipeline's userPlacements/edits/undoStack before resolving, so the
      // server-baked rawPlacements (which already include the new pipeline's userPlacements)
      // are treated as authoritative until LOAD_EDITOR_STATE arrives for the new pipeline.
      dispatch({ type: 'RESET_PIPELINE_STATE' })
    }
    lastLoadedPipelineIdRef.current = pipelineId
    seededPipelineIdRef.current = pipelineId
    // After RESET, editorStateLoaded is false so resolvePlacements uses server-as-is mode.
    // For same-pipeline reseeds (no RESET), we use the existing local-authoritative mode.
    const useServerMode = isPipelineSwitch
    const resolved = resolvePlacements({
      rawPlacements,
      userPlacements: useServerMode ? [] : userPlacementsRef.current,
      edits: useServerMode ? {} : editsRef.current,
      transcriptWords: transcriptWordsRef.current,
      editorStateLoaded: !useServerMode && editorStateLoadedRef.current,
    })
    dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements, placements: resolved, searchProgress: searchProgress || null, pipelineChanged: isPipelineSwitch } })
  }, [])

  useEffect(() => {
    if (!planPipelineId) return

    const wasSeeded = seededPipelineIdRef.current === planPipelineId
    if (wasSeeded) {
      seededPipelineIdRef.current = null
      // Background revalidate: fetch fresh data without flashing the loading state.
      // Cached seed data may be 30s+ old; this silently refreshes rawPlacements.
      // lastLoadedPipelineIdRef is NOT updated here — seedFromCache already set it.
      let cancelled = false
      authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
        .then(data => {
          if (cancelled) return
          const resolved = resolvePlacements({
            rawPlacements: data.placements || [],
            userPlacements: userPlacementsRef.current,
            edits: editsRef.current,
            transcriptWords: transcriptWordsRef.current,
            editorStateLoaded: editorStateLoadedRef.current,
          })
          dispatch({ type: 'SET_DATA_RESOLVED', payload: {
            rawPlacements: data.placements,
            placements: resolved,
            searchProgress: data.searchProgress,
            pipelineChanged: false,  // same pipeline — preserve selection (T5)
          }})
        })
        .catch(() => {})
      return () => { cancelled = true }
    }

    if (!transcriptWords.length) {
      // Wait for transcript words before fetching — otherwise placements resolve with no
      // timelineStart and BRollTrack filters them all out (producing an empty-looking track).
      return
    }

    const isPipelineSwitch = lastLoadedPipelineIdRef.current !== null && lastLoadedPipelineIdRef.current !== planPipelineId
    if (isPipelineSwitch) {
      // Drop outgoing pipeline's local state before fetching new data; LOAD_EDITOR_STATE
      // for the new pipeline will repopulate userPlacements/edits/undoStack.
      dispatch({ type: 'RESET_PIPELINE_STATE' })
    }
    lastLoadedPipelineIdRef.current = planPipelineId

    dispatch({ type: 'SET_LOADING' })
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => {
        // Resolve using server-as-is mode if editor-state hasn't loaded yet for this pipeline.
        // The resolve useEffect will re-render with local-authoritative mode once
        // LOAD_EDITOR_STATE dispatches (the parallel effect below).
        const resolved = resolvePlacements({
          rawPlacements: data.placements || [],
          userPlacements: userPlacementsRef.current,
          edits: editsRef.current,
          transcriptWords: transcriptWordsRef.current,
          editorStateLoaded: editorStateLoadedRef.current,
        })
        dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements: data.placements, placements: resolved, searchProgress: data.searchProgress, pipelineChanged: isPipelineSwitch } })
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
        const sessionScoped = {
          ...data,
          state: data?.state ? {
            ...data.state,
            undoStack: filterToSession(data.state.undoStack),
            redoStack: filterToSession(data.state.redoStack),
          } : data?.state,
        }
        dispatch({ type: 'LOAD_EDITOR_STATE', payload: sessionScoped })
      })
      .catch(() => { /* non-fatal; empty state stays */ })
    return () => { cancelled = true }
  }, [planPipelineId])

  // Re-resolve when transcript words, edits, userPlacements, or editor-state-loaded flag change.
  // The editorStateLoaded dep is critical: when it flips true (LOAD_EDITOR_STATE arrives),
  // resolution switches from server-as-is to local-authoritative — without this dep, a brief
  // flash where unsaved local edits aren't reflected can occur.
  useEffect(() => {
    if (!state.rawPlacements.length) return
    if (!transcriptWords.length) return
    const resolved = resolvePlacements({
      rawPlacements: state.rawPlacements,
      userPlacements: state.userPlacements,
      edits: state.edits,
      transcriptWords,
      editorStateLoaded: state.editorStateLoaded,
    })
    dispatch({ type: 'SET_RESOLVED', payload: resolved })
  }, [transcriptWords, state.edits, state.userPlacements, state.rawPlacements, state.editorStateLoaded])

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
    // Update transient session state for immediate UI feedback.
    dispatch({ type: 'SELECT_RESULT', payload: { placementIndex, resultIndex } })

    // Persist via APPLY_ACTION so the choice survives reloads / variant switches.
    // Without this, RESET_PIPELINE_STATE clears selectedResults and the renderer falls
    // back to persistedSelectedResult — which was never saved, so it defaults to 0.
    const placement = state.placements.find(p => p.index === placementIndex)
    if (!placement) return

    if (placement.userPlacementId) {
      const up = state.userPlacements.find(u => u.id === placement.userPlacementId)
      if (!up || up.selectedResult === resultIndex) return
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: 'select-result',
        userPlacementId: placement.userPlacementId,
        before: { userPlacementPatch: { selectedResult: up.selectedResult } },
        after:  { userPlacementPatch: { selectedResult: resultIndex } },
      }
      // Coalesce rapid back-and-forth picks within 800ms (same window as move/resize)
      // so clicking through options doesn't spam the undo stack.
      const last = state.undoStack[state.undoStack.length - 1]
      const sameTarget = last
        && last.kind === 'select-result'
        && last.userPlacementId === placement.userPlacementId
        && (Date.now() - (last.ts || 0) < 800)
      dispatch({ type: sameTarget ? 'APPLY_ACTION_COALESCE' : 'APPLY_ACTION', payload: entry })
      return
    }

    if (placement.chapterIndex != null && placement.placementIndex != null) {
      const placementKey = `${placement.chapterIndex}:${placement.placementIndex}`
      const prev = state.edits[placementKey] || {}
      if (prev.selectedResult === resultIndex) return
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: 'select-result',
        placementKey,
        before: { editsSlot: { selectedResult: prev.selectedResult } },
        after:  { editsSlot: { selectedResult: resultIndex } },
      }
      const last = state.undoStack[state.undoStack.length - 1]
      const sameTarget = last
        && last.kind === 'select-result'
        && last.placementKey === placementKey
        && (Date.now() - (last.ts || 0) < 800)
      dispatch({ type: sameTarget ? 'APPLY_ACTION_COALESCE' : 'APPLY_ACTION', payload: entry })
    }
  }, [state.placements, state.userPlacements, state.edits, state.undoStack])

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
        placementUuid: placement.uuid,
        chapterIndex: placement.chapterIndex,   // kept for legacy server fallback
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
        placementUuid: placement.uuid,
        chapterIndex: placement.chapterIndex,   // kept for legacy server fallback
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
      const sessionScoped = {
        ...data,
        state: data?.state ? {
          ...data.state,
          undoStack: filterToSession(data.state.undoStack),
          redoStack: filterToSession(data.state.redoStack),
        } : data?.state,
      }
      dispatch({ type: 'LOAD_EDITOR_STATE', payload: sessionScoped })
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

  // Async undo/redo: cross-pipeline drag actions carry targetPipelineId +
  // targetUserPlacementSnapshot. Undoing them must also remove the userPlacement
  // from the target pipeline's editor-state on the server (and redo must add it back).
  // If the server PUT fails, we roll back the local UNDO/REDO so source and target stay
  // in sync. Non-cross actions stay synchronous via the bare dispatch.
  //
  // Concurrency: a per-target mutex guards against overlapping cross-pipeline ops, so two
  // rapid undos against the same target don't both fetch the same `version` and lose one
  // to a 409. Rollback also verifies the stack head still matches the action we popped —
  // if the user has dispatched another action since, we don't blindly REDO/UNDO and corrupt
  // the wrong entry.
  const crossPipelineLockRef = useRef(new Map()) // pid -> Promise

  const inactiveCacheSetterRef = useRef(null)
  const registerInactiveCacheSetter = useCallback((fn) => {
    inactiveCacheSetterRef.current = fn
  }, [])

  const runWithTargetLock = useCallback(async (pid, fn) => {
    const prev = crossPipelineLockRef.current.get(pid) || Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    crossPipelineLockRef.current.set(pid, next)
    try { return await next } finally {
      if (crossPipelineLockRef.current.get(pid) === next) {
        crossPipelineLockRef.current.delete(pid)
      }
    }
  }, [])

  const undo = useCallback(async () => {
    const top = state.undoStack[state.undoStack.length - 1]
    if (!top) return
    dispatch({ type: 'UNDO' })
    if (top.kind !== 'drag-cross') return
    // Source-side perspective: entry has target refs → cleanup target pipeline
    // (delete userPlacement on target).
    if (top.targetPipelineId && top.targetUserPlacementId) {
      await runWithTargetLock(top.targetPipelineId, async () => {
        try {
          const remote = await authFetch(`/broll/pipeline/${top.targetPipelineId}/editor-state`)
          const next = {
            edits: remote.state?.edits || {},
            userPlacements: (remote.state?.userPlacements || []).filter(u => u.id !== top.targetUserPlacementId),
            undoStack: (Array.isArray(remote.state?.undoStack) ? remote.state.undoStack : [])
              .filter(e => !(e.kind === 'drag-cross' && e.userPlacementId === top.targetUserPlacementId)),
            redoStack: (Array.isArray(remote.state?.redoStack) ? remote.state.redoStack : [])
              .filter(e => !(e.kind === 'drag-cross' && e.userPlacementId === top.targetUserPlacementId)),
          }
          await authPut(`/broll/pipeline/${top.targetPipelineId}/editor-state`, { state: next, version: remote.version })
          // Inform the editor to drop the optimistic synthetic from its inactive cache.
          inactiveCacheSetterRef.current?.(top.targetPipelineId, (prev) =>
            (prev || []).filter(p => p.userPlacementId !== top.targetUserPlacementId)
          )
        } catch (err) {
          console.error('[broll-undo] cross-pipeline cleanup failed:', err.message)
          // Only roll back if this entry is still at the top of redoStack — otherwise the
          // user has done other things since and a blind REDO would corrupt unrelated state.
          dispatch({ type: 'CONDITIONAL_REDO', payload: { entryId: top.id } })
          window.alert('Undo failed — could not contact target pipeline. Try again.')
        }
      })
    }
    // Target-side perspective: entry has source refs → restore source on the
    // source pipeline (un-hide chapter-derived placement OR re-add userPlacement).
    if (top.sourcePipelineId && (top.sourcePlacementKey || top.sourceUserPlacementId)) {
      await runWithTargetLock(top.sourcePipelineId, async () => {
        try {
          const remote = await authFetch(`/broll/pipeline/${top.sourcePipelineId}/editor-state`)
          let nextEdits = { ...(remote.state?.edits || {}) }
          let nextUserPlacements = [...(remote.state?.userPlacements || [])]
          if (top.sourcePlacementKey) {
            const e = nextEdits[top.sourcePlacementKey]
            if (e?.hidden) {
              nextEdits[top.sourcePlacementKey] = { ...e, hidden: false }
            }
          }
          if (top.sourceUserPlacementId && top.sourceUserPlacementSnapshot) {
            if (!nextUserPlacements.some(u => u.id === top.sourceUserPlacementId)) {
              nextUserPlacements.push(top.sourceUserPlacementSnapshot)
            }
          }
          // Drop the matching source-hide entry from source's undo/redo stacks.
          const cleanedUndo = (Array.isArray(remote.state?.undoStack) ? remote.state.undoStack : [])
            .filter(e => !(e.kind === 'drag-cross' && e.targetUserPlacementId === top.userPlacementId))
          const cleanedRedo = (Array.isArray(remote.state?.redoStack) ? remote.state.redoStack : [])
            .filter(e => !(e.kind === 'drag-cross' && e.targetUserPlacementId === top.userPlacementId))
          const next = {
            edits: nextEdits,
            userPlacements: nextUserPlacements,
            undoStack: cleanedUndo,
            redoStack: cleanedRedo,
          }
          await authPut(`/broll/pipeline/${top.sourcePipelineId}/editor-state`, { state: next, version: remote.version })
          // Invalidate source pipeline's inactive cache so the next refetch shows the un-hidden source.
          inactiveCacheSetterRef.current?.(top.sourcePipelineId, () => null)
        } catch (err) {
          console.error('[broll-undo] target-side source cleanup failed:', err.message)
          dispatch({ type: 'CONDITIONAL_REDO', payload: { entryId: top.id } })
          window.alert('Undo failed — could not contact source pipeline. Try again.')
        }
      })
    }
  }, [state.undoStack, runWithTargetLock])

  const redo = useCallback(async () => {
    const top = state.redoStack[state.redoStack.length - 1]
    if (!top) return
    dispatch({ type: 'REDO' })
    if (top.kind !== 'drag-cross') return
    // Source-side perspective: entry has target snapshot → re-create userPlacement on target.
    if (top.targetPipelineId && top.targetUserPlacementSnapshot) {
      await runWithTargetLock(top.targetPipelineId, async () => {
        try {
          const remote = await authFetch(`/broll/pipeline/${top.targetPipelineId}/editor-state`)
          // Guard: don't double-create if the snapshot is already present (e.g. if the user
          // independently redid on the target side first).
          const ups = remote.state?.userPlacements || []
          const alreadyPresent = ups.some(u => u.id === top.targetUserPlacementId)
          const remoteUndo = Array.isArray(remote.state?.undoStack) ? remote.state.undoStack : []
          const hasCreateEntry = remoteUndo.some(e => e.kind === 'drag-cross' && e.userPlacementId === top.targetUserPlacementId)
          const next = {
            edits: remote.state?.edits || {},
            userPlacements: alreadyPresent ? ups : [...ups, top.targetUserPlacementSnapshot],
            undoStack: hasCreateEntry
              ? remoteUndo
              : [...remoteUndo, {
                  id: generateActionId(), ts: Date.now(), kind: 'drag-cross', userPlacementId: top.targetUserPlacementId,
                  before: { userPlacementDelete: true }, after: { userPlacementCreate: top.targetUserPlacementSnapshot },
                }].slice(-MAX_UNDO),
            redoStack: Array.isArray(remote.state?.redoStack) ? remote.state.redoStack : [],
          }
          await authPut(`/broll/pipeline/${top.targetPipelineId}/editor-state`, { state: next, version: remote.version })
          // Re-add the userPlacement to the local cache (using the rebuilt entry shape).
          const reAdded = userPlacementToRawEntry(top.targetUserPlacementSnapshot)
          inactiveCacheSetterRef.current?.(top.targetPipelineId, (prev) => {
            const without = (prev || []).filter(p => p.userPlacementId !== top.targetUserPlacementId)
            return [...without, reAdded]
          })
        } catch (err) {
          console.error('[broll-redo] cross-pipeline cleanup failed:', err.message)
          dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: top.id } })
          window.alert('Redo failed — could not contact target pipeline. Try again.')
        }
      })
    }
    // Target-side perspective: entry has source refs → re-hide source / re-delete source userPlacement.
    if (top.sourcePipelineId && (top.sourcePlacementKey || top.sourceUserPlacementId)) {
      await runWithTargetLock(top.sourcePipelineId, async () => {
        try {
          const remote = await authFetch(`/broll/pipeline/${top.sourcePipelineId}/editor-state`)
          let nextEdits = { ...(remote.state?.edits || {}) }
          let nextUserPlacements = [...(remote.state?.userPlacements || [])]
          if (top.sourcePlacementKey) {
            const e = nextEdits[top.sourcePlacementKey] || {}
            nextEdits[top.sourcePlacementKey] = { ...e, hidden: true }
          }
          if (top.sourceUserPlacementId) {
            nextUserPlacements = nextUserPlacements.filter(u => u.id !== top.sourceUserPlacementId)
          }
          const next = {
            edits: nextEdits,
            userPlacements: nextUserPlacements,
            undoStack: Array.isArray(remote.state?.undoStack) ? remote.state.undoStack : [],
            redoStack: Array.isArray(remote.state?.redoStack) ? remote.state.redoStack : [],
          }
          await authPut(`/broll/pipeline/${top.sourcePipelineId}/editor-state`, { state: next, version: remote.version })
          inactiveCacheSetterRef.current?.(top.sourcePipelineId, () => null)
        } catch (err) {
          console.error('[broll-redo] target-side source replay failed:', err.message)
          dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: top.id } })
          window.alert('Redo failed — could not contact source pipeline. Try again.')
        }
      })
    }
  }, [state.redoStack, runWithTargetLock])

  const copyPlacement = useCallback((index, { cut = false } = {}) => {
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const resultIdx = state.selectedResults[index] ?? placement.persistedSelectedResult ?? 0
    const allResults = placement.results || []
    const slim = allResults[resultIdx] ? [allResults[resultIdx]] : []
    const entry = {
      sourcePipelineId: placement.isUserPlacement ? placement.sourcePipelineId : planPipelineId,
      sourceChapterIndex: placement.chapterIndex ?? null,
      sourcePlacementIndex: placement.placementIndex ?? null,
      sourceUserPlacementId: placement.userPlacementId ?? null,
      selectedResult: 0,
      results: slim,
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

    // Compute available gap at targetStartSec.
    // Combine all current placements (originals + userPlacements) sorted by timelineStart.
    const all = state.placements
      .map(p => ({ start: p.timelineStart, end: p.timelineEnd }))
      .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end))
      .sort((a, b) => a.start - b.start)

    // If targetStartSec falls inside an existing placement, snap to that placement's end.
    let effectiveStart = Math.max(0, targetStartSec)
    const inside = all.find(r => effectiveStart >= r.start && effectiveStart < r.end)
    if (inside) effectiveStart = inside.end + 0.05

    // Find next placement starting after effectiveStart — that bounds the gap.
    const next = all.find(r => r.start >= effectiveStart)
    const rightBoundary = next ? next.start : Infinity
    const gap = rightBoundary - effectiveStart
    if (gap < 0.5) {
      console.warn('[broll-paste] Not enough space at', targetStartSec.toFixed(2), '- gap is', gap.toFixed(2))
      window.alert('Not enough space to paste here.')
      return
    }

    const sourceDur = Math.max(0.5, entry.durationSec || 1)
    const duration = Math.min(sourceDur, gap - 0.05)

    const uuid = 'u_' + (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12)
    const timelineStart = effectiveStart
    const timelineEnd = effectiveStart + duration

    // Defensive overlap check: if any existing placement intersects [timelineStart,
    // timelineEnd], reject. The math above should prevent this, but a partially-
    // resolved placements list (e.g., chapter-derived clips with no timelineStart
    // because transcript words weren't loaded yet) silently allowed overlap before.
    const overlap = all.find(r => r.start < timelineEnd && r.end > timelineStart)
    if (overlap) {
      console.warn('[broll-paste] Computed range overlaps existing placement', { timelineStart, timelineEnd, overlap })
      window.alert('Not enough space to paste here.')
      return
    }

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
  }, [state.placements])

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

  // Cross-drop helpers — split out so callers can hide source FIRST (instant visual)
  // and only do the network round-trip after. The two-phase shape lets us update the
  // undo entry's targetUserPlacementSnapshot once computeFitDropPosition produces the
  // final adjusted range. Phase 1 hide uses provisional values; Phase 2 patches them.
  const hideSourceForCrossDrop = useCallback(({ sourceIndex, mode, targetPipelineId, uuid, provisionalSnapshot }) => {
    if (mode !== 'move') return null
    const placement = state.placements.find(p => p.index === sourceIndex)
    if (!placement) return null
    const actionId = generateActionId()
    const crossMeta = {
      targetPipelineId,
      targetUserPlacementId: uuid,
      targetUserPlacementSnapshot: provisionalSnapshot,
    }
    const placementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    let sourceAction = null
    if (placementKey) {
      const prev = state.edits[placementKey] || {}
      sourceAction = {
        id: actionId, ts: Date.now(), kind: 'drag-cross', placementKey,
        ...crossMeta,
        before: { editsSlot: { hidden: !!prev.hidden } },
        after:  { editsSlot: { hidden: true } },
      }
    } else if (placement.userPlacementId) {
      sourceAction = {
        id: actionId, ts: Date.now(), kind: 'drag-cross', userPlacementId: placement.userPlacementId,
        ...crossMeta,
        before: { userPlacementCreate: state.userPlacements.find(u => u.id === placement.userPlacementId) },
        after:  { userPlacementDelete: true },
      }
    }
    if (!sourceAction) return null
    dispatch({ type: 'APPLY_ACTION', payload: sourceAction })
    return { actionId, placement }
  }, [state.placements, state.edits, state.userPlacements])

  const revertCrossDropHide = useCallback((actionId) => {
    if (!actionId) return
    dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: actionId } })
  }, [])

  const updateCrossDropSnapshot = useCallback((actionId, patch) => {
    if (!actionId || !patch) return
    dispatch({ type: 'PATCH_UNDO_ENTRY', payload: { entryId: actionId, patch } })
  }, [])

  const dragCrossPlacement = useCallback(async ({ sourceIndex, targetPipelineId, targetStartSec, targetDurationSec, mode, uuid: externalUuid, presourceActionId, presourcePlacement }) => {
    const placement = presourcePlacement || state.placements.find(p => p.index === sourceIndex)
    if (!placement) {
      throw new Error('source placement not found')
    }
    const resultIdx = state.selectedResults[sourceIndex] ?? placement.persistedSelectedResult ?? 0
    const allResults = placement.results || []
    const slim = allResults[resultIdx] ? [allResults[resultIdx]] : []
    // Caller may supply a uuid so an optimistic insert into the target's track shares the same
    // id with the eventually-saved server entry — that lets React reconcile by key without remount.
    const uuid = externalUuid || ('u_' + (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12))
    const actionId = generateActionId()
    const dur = Math.max(0.5, targetDurationSec ?? placement.timelineDuration ?? 1)
    const up = {
      id: uuid,
      sourcePipelineId: planPipelineId,
      sourceChapterIndex: placement.chapterIndex ?? null,
      sourcePlacementIndex: placement.placementIndex ?? null,
      timelineStart: targetStartSec,
      timelineEnd: targetStartSec + dur,
      selectedResult: 0,
      results: slim,
      snapshot: {
        description: placement.description,
        audio_anchor: placement.audio_anchor,
        function: placement.function,
        type_group: placement.type_group,
        source_feel: placement.source_feel,
        style: placement.style,
      },
    }

    // Source-side: dispatch hide IMMEDIATELY for instant visual feedback.
    // We'll revert this if the remote write fails. We tag the action with
    // targetPipelineId + targetUserPlacementSnapshot so undo can asynchronously
    // delete the userPlacement on the target pipeline, and redo can re-create it.
    let sourceAction = null
    if (mode === 'move') {
      const crossMeta = {
        targetPipelineId,
        targetUserPlacementId: uuid,
        targetUserPlacementSnapshot: up,
      }
      const placementKey = placement.chapterIndex != null && placement.placementIndex != null
        ? `${placement.chapterIndex}:${placement.placementIndex}`
        : null
      if (placementKey) {
        const prev = state.edits[placementKey] || {}
        sourceAction = {
          id: actionId, ts: Date.now(), kind: 'drag-cross', placementKey,
          ...crossMeta,
          before: { editsSlot: { hidden: !!prev.hidden } },
          after:  { editsSlot: { hidden: true } },
        }
      } else if (placement.userPlacementId) {
        sourceAction = {
          id: actionId, ts: Date.now(), kind: 'drag-cross', userPlacementId: placement.userPlacementId,
          ...crossMeta,
          before: { userPlacementCreate: state.userPlacements.find(u => u.id === placement.userPlacementId) },
          after:  { userPlacementDelete: true },
        }
      }
      if (sourceAction && !presourceActionId) {
        dispatch({ type: 'APPLY_ACTION', payload: sourceAction })
      }
    }

    // Source refs embedded in the TARGET's undo entry so undo-on-target can also
    // un-hide / restore the source on this pipeline (otherwise undoing from B
    // only deletes the userPlacement on B, leaving source hidden on A).
    const sourcePlacementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    const sourceUserPlacementSnapshot = placement.userPlacementId
      ? state.userPlacements.find(u => u.id === placement.userPlacementId) || null
      : null

    // Write to target pipeline's editor-state with optimistic concurrency.
    // runWithTargetLock serialises concurrent cross-drags to the same target
    // pipeline, preventing 409 version conflicts (Bug #11).
    await runWithTargetLock(targetPipelineId, async () => {
      const writeOnce = async () => {
        const remote = await authFetch(`/broll/pipeline/${targetPipelineId}/editor-state`)
        const next = {
          edits: remote.state?.edits || {},
          userPlacements: [...(remote.state?.userPlacements || []), up],
          undoStack: [...(remote.state?.undoStack || []), {
            id: generateActionId(), ts: Date.now(), kind: 'drag-cross', userPlacementId: uuid,
            sourcePipelineId: planPipelineId,
            sourcePlacementKey,
            sourceUserPlacementId: placement.userPlacementId || null,
            sourceUserPlacementSnapshot,
            before: { userPlacementDelete: true }, after: { userPlacementCreate: up },
          }].slice(-MAX_UNDO),
          redoStack: [],
        }
        return authPut(`/broll/pipeline/${targetPipelineId}/editor-state`, { state: next, version: remote.version })
      }
      try {
        try {
          await writeOnce()
        } catch (err) {
          if (err.message === 'conflict') {
            // Conflict: another writer bumped the target. Retry once with fresh version.
            await writeOnce()
          } else {
            throw err
          }
        }
      } catch (err) {
        console.error('[broll-drag-cross] Failed to write target after retry:', err.message)
        // Revert the source-side action only if it is still at the top of the
        // undo stack — CONDITIONAL_UNDO is a no-op when the user has dispatched
        // another action in the meantime (Bug #1).
        const revertId = presourceActionId || sourceAction?.id
        if (revertId) {
          dispatch({ type: 'CONDITIONAL_UNDO', payload: { entryId: revertId } })
        }
        // Propagate so the caller can revert any optimistic target-side insert.
        throw err
      }
    })
  }, [state.placements, state.selectedResults, state.edits, state.userPlacements, planPipelineId, runWithTargetLock])

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
    hideSourceForCrossDrop,
    revertCrossDropHide,
    updateCrossDropSnapshot,
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
    registerInactiveCacheSetter,
  }), [
    state.rawPlacements, state.placements, state.selectedIndex, selectedPlacement,
    state.selectedResults, state.searchProgress, state.loading, state.error,
    seedFromCache, selectPlacement, selectResult, activePlacementAtTime,
    searchPlacement, searchPlacementCustom, searchUserPlacement, hidePlacement, undo, redo,
    copyPlacement, pastePlacement, resetPlacement, dragCrossPlacement,
    hideSourceForCrossDrop, revertCrossDropHide, updateCrossDropSnapshot,
    updatePlacementPosition,
    resetAllPlacements, refetchEditorData, planPipelineId,
    state.edits, state.userPlacements, state.undoStack, state.redoStack, state.editorStateVersion, state.dirty,
    flushSave, registerInactiveCacheSetter,
  ])
}

export { userPlacementToRawEntry } from './brollReducer.js'
