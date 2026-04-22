import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { supabase } from '../../lib/supabaseClient.js'
import { apiPost } from '../../hooks/useApi.js'
import { EditorContext } from './EditorView.jsx'
import { matchPlacementsToTranscript } from './brollUtils.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

export const BRollContext = createContext(null)

export async function authFetchBRollData(planPipelineId) {
  return authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
}

async function authFetch(path) {
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  const res = await fetch(`${API_BASE}${path}`, { headers })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, rawPlacements: [], placements: [], selectedIndex: null, selectedResults: {}, loading: true, error: null }
    case 'SET_DATA':
      return { ...state, rawPlacements: action.payload.placements, selectedResults: {}, searchProgress: action.payload.searchProgress, loading: false, error: null }
    case 'SET_DATA_RESOLVED':
      return { ...state, rawPlacements: action.payload.rawPlacements, placements: action.payload.placements, selectedResults: {}, searchProgress: action.payload.searchProgress, loading: false, error: null }
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
      return { ...state, rawPlacements: merged, searchProgress }
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
    case 'UPDATE_PLACEMENT_POSITION': {
      const { index, timelineStart, timelineEnd } = action.payload
      const updated = state.rawPlacements.map((p, i) =>
        i === index ? { ...p, userTimelineStart: timelineStart, userTimelineEnd: timelineEnd } : p
      )
      return { ...state, rawPlacements: updated }
    }
    case 'HIDE_PLACEMENT': {
      const updated = state.rawPlacements.map((p, i) =>
        i === action.payload ? { ...p, hidden: true } : p
      )
      return { ...state, rawPlacements: updated }
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

  // Seed cached placements synchronously. Called by BRollEditor BEFORE setActiveVariantIdx,
  // so the pipelineId passed here is the INCOMING one.
  const seedFromCache = useCallback((pipelineId, rawPlacements, searchProgress) => {
    const visible = rawPlacements.filter(p => !p.hidden)
    const resolved = matchPlacementsToTranscript(visible, transcriptWordsRef.current)
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

    dispatch({ type: 'SET_LOADING' })
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => {
        const visible = (data.placements || []).filter(p => !p.hidden)
        const resolved = matchPlacementsToTranscript(visible, transcriptWordsRef.current)
        dispatch({ type: 'SET_DATA_RESOLVED', payload: { rawPlacements: data.placements, placements: resolved, searchProgress: data.searchProgress } })
      })
      .catch(err => dispatch({ type: 'SET_ERROR', payload: err.message }))
  }, [planPipelineId])

  // Re-resolve when transcript words change (rare — only on initial track load)
  useEffect(() => {
    if (!state.rawPlacements.length) return
    const visible = state.rawPlacements.filter(p => !p.hidden)
    const resolved = matchPlacementsToTranscript(visible, transcriptWords)
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

  const hidePlacement = useCallback((index) => {
    dispatch({ type: 'HIDE_PLACEMENT', payload: index })
  }, [])

  const updatePlacementPosition = useCallback((index, timelineStart, timelineEnd) => {
    dispatch({ type: 'UPDATE_PLACEMENT_POSITION', payload: { index, timelineStart, timelineEnd } })
  }, [])

  return {
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
    hidePlacement,
    updatePlacementPosition,
    resetAllPlacements: useCallback(() => dispatch({ type: 'RESET_ALL_PLACEMENTS' }), []),
    refetchEditorData,
    planPipelineId,
  }
}
