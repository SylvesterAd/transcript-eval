import { useContext, useState, useCallback } from 'react'
import { EditorContext } from './EditorView.jsx'
import { BRollContext } from './useBRollEditorState.js'
import { apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
async function authFetch(path, opts = {}) {
  const headers = { ...opts.headers }
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return fetch(`${API_BASE}${path}`, { ...opts, headers })
}

async function pollUntilDone(groupId, signal) {
  while (!signal.aborted) {
    await new Promise(r => setTimeout(r, 1500))
    if (signal.aborted) return null
    const res = await authFetch(`/videos/groups/${groupId}/status`)
    const { assembly_status, assembly_error } = await res.json()
    if (assembly_status === 'done') return 'done'
    if (assembly_status === 'error') throw new Error(assembly_error || 'Sync failed')
    // Any other status (pending, syncing, transcribing, building_timeline, etc.) — keep polling
  }
  return null
}

const speeds = [0.5, 1, 1.5, 2]

export default function PlaybackControls() {
  const { state, dispatch, playbackEngine, refetchDetail, refetchTimestamps } = useContext(EditorContext)
  const broll = useContext(BRollContext)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState(null)
  const [resuming, setResuming] = useState(false)

  const togglePlay = () => {
    if (state.isPlaying) {
      dispatch({ type: 'PAUSE' })
      playbackEngine.current?.pause()
    } else {
      dispatch({ type: 'PLAY' })
      playbackEngine.current?.play()
    }
  }

  const skip = (delta) => {
    const t = Math.max(0, state.currentTime + delta)
    dispatch({ type: 'SET_CURRENT_TIME', payload: t })
    playbackEngine.current?.seek(t)
  }

  const cycleSpeed = () => {
    const idx = speeds.indexOf(state.playbackRate)
    const next = speeds[(idx + 1) % speeds.length]
    dispatch({ type: 'SET_PLAYBACK_RATE', payload: next })
    playbackEngine.current?.setRate(next)
  }

  const handleSplit = () => {
    if (state.activeTab === 'roughcut') {
      // Razor split at the playhead position.
      // If inside an existing cut, split that cut into two at the playhead,
      // creating a visible seam the user can drag to resize either half.
      const t = state.currentTime
      const overlapping = state.cuts.filter(c => c.start < t && c.end > t && c.end > c.start + 0.01)
      if (overlapping.length > 0) {
        // Split all overlapping cuts at the playhead
        for (const c of overlapping) {
          dispatch({ type: 'UPDATE_CUT', payload: { id: c.id, updates: { end: t } } })
          dispatch({ type: 'ADD_CUT', payload: { id: `cut-${Date.now()}-r`, start: t, end: c.end, source: 'split' } })
        }
        // Add exclusion at the split point so AI doesn't re-merge
        dispatch({ type: 'ADD_EXCLUSION', payload: { start: t - 0.5, end: t + 0.5 } })
      } else {
        // No existing cut — create a zero-width razor for the user to drag open
        dispatch({
          type: 'ADD_CUT',
          payload: { id: `cut-${Date.now()}`, start: t, end: t, source: 'split', splitPoint: t },
        })
      }
      return
    }
    const selected = [...state.selectedTrackIds]
    if (selected.length === 1) {
      dispatch({ type: 'SPLIT_TRACK', payload: { trackId: selected[0], time: state.currentTime } })
    }
  }

  return (
    <div className="h-12 flex items-center justify-between px-8 bg-surface-container-low rounded-xl relative shrink-0 border border-white/5">
      {/* Left: skip + audio only */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <button onClick={() => skip(-5)} className="flex items-center justify-center text-on-surface/60 hover:text-primary-fixed transition-colors">
            <span className="material-symbols-outlined text-lg">keyboard_double_arrow_left</span>
          </button>
          <button onClick={() => skip(5)} className="flex items-center justify-center text-on-surface/60 hover:text-primary-fixed transition-colors">
            <span className="material-symbols-outlined text-lg">keyboard_double_arrow_right</span>
          </button>
        </div>
        <div className="flex items-center gap-3 ml-4 border-l border-white/10 pl-4">
          {state.activeTab === 'roughcut' ? (
            <button
              onClick={() => dispatch({ type: 'SET_ROUGH_CUT_TRACK_MODE', payload: state.roughCutTrackMode === 'main' ? 'all' : 'main' })}
              className="flex items-center bg-surface-container-highest rounded-full p-0.5 relative cursor-pointer"
              style={{ width: '7.5rem' }}
            >
              <div className={`absolute h-3.5 rounded-full transition-all ${
                state.roughCutTrackMode === 'all' ? 'left-[calc(100%-4.375rem)] bg-primary-fixed/30 w-[4.125rem]' : 'left-0.5 bg-surface-variant w-[3.75rem]'
              }`} />
              <span className={`flex-1 text-center text-[7px] font-bold z-10 whitespace-nowrap ${state.roughCutTrackMode === 'main' ? 'text-on-surface' : 'text-on-surface/30'}`}>Main track</span>
              <span className={`flex-1 text-center text-[7px] font-bold z-10 whitespace-nowrap ${state.roughCutTrackMode === 'all' ? 'text-primary-fixed' : 'text-on-surface/30'}`}>All tracks</span>
            </button>
          ) : state.activeTab !== 'brolls' ? (
            <>
              <span className="text-[9px] font-bold uppercase tracking-wider text-on-surface/40">Audio</span>
              <button
                onClick={() => dispatch({ type: 'TOGGLE_AUDIO_ONLY' })}
                className="flex items-center bg-surface-container-highest rounded-full p-0.5 w-14 relative cursor-pointer group"
              >
                <div className={`absolute w-6 h-3.5 rounded-full transition-all ${
                  state.audioOnly ? 'left-[calc(100%-1.625rem)] bg-primary-fixed/30' : 'left-0.5 bg-surface-variant'
                }`} />
                <span className={`flex-1 text-center text-[7px] font-bold z-10 ${!state.audioOnly ? 'text-on-surface' : 'text-on-surface/30'}`}>OFF</span>
                <span className={`flex-1 text-center text-[7px] font-bold z-10 ${state.audioOnly ? 'text-primary-fixed' : 'text-on-surface/30'}`}>ON</span>
              </button>
            </>
          ) : null}
        </div>
        {state.activeTab === 'brolls' && broll?.placements?.length > 0 ? (
          <BRollSearchStatus broll={broll} resuming={resuming} setResuming={setResuming} />
        ) : state.activeTab !== 'roughcut' ? (
          <div className="border-l border-white/10 pl-3">
            <button
              onClick={async () => {
                if (!state.groupId || syncing) return
                setSyncing(true)
                setSyncError(null)
                dispatch({ type: 'MARK_CLEAN' }) // stop auto-save from racing with sync
                dispatch({ type: 'PAUSE' })
                try {
                  await apiPost(`/videos/groups/${state.groupId}/start-assembly`, { sync_mode: 'sync' })
                  // Refetch immediately so EditorView sees in-progress status and shows SyncingScreen
                  refetchDetail()
                } catch (e) {
                  console.error('Re-sync failed:', e)
                  setSyncError(e.message)
                  setTimeout(() => setSyncError(null), 5000)
                  setSyncing(false)
                }
              }}
              disabled={syncing || !state.groupId}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-on-surface hover:text-primary-fixed transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className={`material-symbols-outlined text-sm ${syncing ? 'animate-spin' : ''}`}>
                {syncing ? 'progress_activity' : syncError ? 'error' : 'sync'}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider">
                {syncing ? 'Syncing...' : syncError ? 'Failed' : 'Re-sync'}
              </span>
            </button>
          </div>
        ) : null}
      </div>

      {/* Center: play, speed, split */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-4">
        <button
          onClick={togglePlay}
          className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container shadow-lg shadow-primary-container/20 active:scale-95 transition-transform"
        >
          <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: '"FILL" 1' }}>
            {state.isPlaying ? 'pause' : 'play_arrow'}
          </span>
        </button>
        <div className="flex items-center gap-3 ml-1">
          <button onClick={cycleSpeed} className="text-xs font-medium text-on-surface hover:text-primary-fixed transition-colors">
            {state.playbackRate}x
          </button>
          <button
            onClick={handleSplit}
            disabled={state.activeTab !== 'roughcut' && state.selectedTrackIds.size !== 1}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-on-surface hover:text-primary-fixed transition-all disabled:opacity-30 disabled:cursor-not-allowed group"
          >
            <span className="material-symbols-outlined text-sm">content_cut</span>
            <span className="text-[10px] font-bold uppercase tracking-wider">{state.activeTab === 'roughcut' ? 'Cut' : 'Split'}</span>
          </button>
        </div>
      </div>

      {/* Right: volume + zoom */}
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px] opacity-60">volume_up</span>
          <div className="relative w-20 h-1 bg-surface-container-highest rounded-full overflow-hidden">
            <div className="h-full bg-primary-fixed rounded-full" style={{ width: `${state.volume * 100}%` }} />
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={state.volume}
              onChange={e => dispatch({ type: 'SET_VOLUME', payload: parseFloat(e.target.value) })}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 border-l border-white/10 pl-6">
          <button
            onClick={() => dispatch({ type: 'SET_ZOOM', payload: state.zoom - 10 })}
            className="w-6 h-6 flex items-center justify-center rounded bg-white/5 hover:bg-white/10 transition-colors"
          >
            <span className="material-symbols-outlined text-base">remove</span>
          </button>
          <span className="text-[9px] font-mono font-bold text-primary-fixed w-8 text-center">
            {Math.round(state.zoom * 2)}%
          </span>
          <button
            onClick={() => dispatch({ type: 'SET_ZOOM', payload: state.zoom + 10 })}
            className="w-6 h-6 flex items-center justify-center rounded bg-white/5 hover:bg-white/10 transition-colors"
          >
            <span className="material-symbols-outlined text-base">add</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function BRollSearchStatus({ broll, resuming, setResuming }) {
  const completed = broll.placements?.filter(p => p.searchStatus === 'complete').length || 0
  const total = broll.placements?.length || 0
  const pending = total - completed
  const isRunning = broll.searchProgress?.status === 'running'

  async function handleResume() {
    if (!broll.planPipelineId) return
    setResuming(true)
    try {
      await apiPost(`/broll/pipeline/${broll.planPipelineId}/run-broll-search`, {})
    } catch (err) {
      console.error('Resume failed:', err)
    }
    setResuming(false)
  }

  if (isRunning) {
    const done = broll.searchProgress.subDone || 0
    const subTotal = broll.searchProgress.subTotal || total
    return (
      <div className="border-l border-white/10 pl-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-sm text-teal-400 animate-spin">progress_activity</span>
        <span className="text-[10px] font-bold uppercase tracking-wider text-teal-400">
          {done}/{subTotal}
        </span>
      </div>
    )
  }

  async function handleResetAndSearch() {
    if (!broll.planPipelineId) return
    broll.resetAllPlacements()
    setResuming(true)
    try {
      await apiPost(`/broll/pipeline/${broll.planPipelineId}/run-broll-search`, {})
    } catch (err) {
      console.error('Reset & search failed:', err)
    }
    setResuming(false)
  }

  if (pending > 0) {
    return (
      <div className="border-l border-white/10 pl-3 flex items-center gap-2">
        <span className="text-[10px] text-zinc-500">{completed}/{total}</span>
        {completed > 0 && (
          <button
            onClick={handleResetAndSearch}
            disabled={resuming || !broll.planPipelineId}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider text-zinc-400 bg-white/5 hover:bg-white/10 transition-all disabled:opacity-40"
          >
            Reset
          </button>
        )}
        <button
          onClick={handleResume}
          disabled={resuming || !broll.planPipelineId}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider text-teal-400 bg-white/5 hover:bg-white/10 transition-all disabled:opacity-40"
        >
          {resuming ? 'Starting...' : completed > 0 ? 'Continue Search' : 'Search All'}
        </button>
      </div>
    )
  }

  if (completed === total && total > 0) {
    return (
      <div className="border-l border-white/10 pl-3 flex items-center gap-2">
        <span className="text-[10px] text-zinc-500">{completed}/{total} found</span>
      </div>
    )
  }

  return null
}
