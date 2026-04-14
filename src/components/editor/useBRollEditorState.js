import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { supabase } from '../../lib/supabaseClient.js'
import { EditorContext } from './EditorView.jsx'
import { matchPlacementsToTranscript } from './brollUtils.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

export const BRollContext = createContext(null)

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
    case 'SET_DATA':
      return { ...state, rawPlacements: action.payload.placements, searchProgress: action.payload.searchProgress, loading: false, error: null }
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
      // Merge new results into existing, preserving user selections
      const merged = state.rawPlacements.map((existing, i) => {
        const updated = newPlacements[i]
        if (!updated) return existing
        if (existing.searchStatus === 'complete' && updated.searchStatus === 'pending') return existing
        return { ...existing, results: updated.results, searchStatus: updated.searchStatus }
      })
      return { ...state, rawPlacements: merged, searchProgress }
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

  // Fetch editor data on mount
  useEffect(() => {
    if (!planPipelineId) return
    authFetch(`/broll/pipeline/${planPipelineId}/editor-data`)
      .then(data => dispatch({ type: 'SET_DATA', payload: data }))
      .catch(err => dispatch({ type: 'SET_ERROR', payload: err.message }))
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

  useEffect(() => {
    if (!state.rawPlacements.length) return
    const resolved = matchPlacementsToTranscript(state.rawPlacements, transcriptWords)
    dispatch({ type: 'SET_RESOLVED', payload: resolved })
  }, [state.rawPlacements, transcriptWords])

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
    return state.placements[state.selectedIndex] || null
  }, [state.selectedIndex, state.placements])

  // Find which placement covers a given time
  const activePlacementAtTime = useCallback((time) => {
    for (const p of state.placements) {
      if (p.timelineStart <= time && p.timelineEnd > time) return p
    }
    return null
  }, [state.placements])

  return {
    placements: state.placements,
    selectedIndex: state.selectedIndex,
    selectedPlacement,
    selectedResults: state.selectedResults,
    searchProgress: state.searchProgress,
    loading: state.loading,
    error: state.error,
    selectPlacement,
    selectResult,
    activePlacementAtTime,
  }
}
