import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { BRollContext, useBRollEditorState } from './useBRollEditorState.js'
import BRollPreview from './BRollPreview.jsx'
import BRollDetailPanel from './BRollDetailPanel.jsx'
import Timeline from './Timeline.jsx'
import PlaybackControls from './PlaybackControls.jsx'
import { apiPost } from '../../hooks/useApi.js'
import { Loader2, Square } from 'lucide-react'

export default function BRollEditor({ groupId, videoId, planPipelineId }) {
  const { id, placementId } = useParams()
  const navigate = useNavigate()
  const brollState = useBRollEditorState(planPipelineId)

  // Sync URL placementId → selection on mount / URL change
  useEffect(() => {
    if (placementId != null && brollState.placements?.length) {
      const idx = parseInt(placementId)
      if (!isNaN(idx) && idx !== brollState.selectedIndex) {
        brollState.selectPlacement(idx)
      }
    }
  }, [placementId, brollState.placements?.length])

  // Sync selection → URL
  useEffect(() => {
    const idx = brollState.selectedIndex
    const currentUrl = idx != null ? `/editor/${id}/brolls/${idx}` : `/editor/${id}/brolls`
    const expectedPlacementId = idx != null ? String(idx) : undefined
    if (expectedPlacementId !== placementId) {
      navigate(currentUrl, { replace: true })
    }
  }, [brollState.selectedIndex])
  const [bottomH, setBottomH] = useState(310)
  const splitRef = useRef(null)

  // Horizontal splitter (video/transcript vs timeline)
  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = bottomH
    const onMove = (ev) => {
      const dy = startY - ev.clientY
      setBottomH(Math.max(160, Math.min(600, startH + dy)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [bottomH])

  if (brollState.loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-dim">
        <Loader2 size={24} className="text-primary-fixed animate-spin" />
      </div>
    )
  }

  if (brollState.error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-dim">
        <div className="text-sm text-error">{brollState.error}</div>
      </div>
    )
  }

  return (
    <BRollContext.Provider value={brollState}>
      <div ref={splitRef} className="flex-1 flex bg-surface-dim overflow-hidden">
        {/* Left: video + timeline stacked */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Video preview */}
          <div className="flex-1 flex flex-col min-h-0">
            <BRollPreview />
          </div>

          {/* Horizontal splitter */}
          <div
            className="h-4 w-full flex items-center justify-center group relative z-40 shrink-0 cursor-ns-resize"
            onMouseDown={onMouseDown}
          >
            <div className="w-full h-px bg-white/5 group-hover:bg-primary-fixed/30 transition-colors" />
            <div className="absolute w-10 h-1 bg-outline-variant/50 rounded-full group-hover:bg-primary-fixed group-hover:shadow-[0_0_10px_rgba(206,252,0,0.5)] transition-all" />
          </div>

          {/* Bottom: playback controls + timeline */}
          <div className="flex flex-col gap-2 pb-4 shrink-0" style={{ height: `${bottomH}px` }}>
            <PlaybackControls />
            <div className="flex-1 min-h-0">
              <Timeline />
            </div>
          </div>
        </main>

        {/* Right: detail sidebar — full height from top to bottom */}
        {brollState.selectedPlacement && <BRollDetailPanel />}
      </div>
    </BRollContext.Provider>
  )
}

function SearchStatusBar({ placements, searchProgress, planPipelineId, onResume }) {
  const [stopping, setStopping] = useState(false)
  const [resuming, setResuming] = useState(false)

  const completed = placements?.filter(p => p.searchStatus === 'complete').length || 0
  const total = placements?.length || 0
  const pending = total - completed
  const isRunning = searchProgress?.status === 'running'

  async function handleStop() {
    setStopping(true)
    try {
      await apiPost('/broll/pipeline/stop-all', {})
    } catch (err) {
      console.error('Stop failed:', err)
    }
    setStopping(false)
  }

  async function handleResume() {
    if (!planPipelineId) return
    setResuming(true)
    try {
      await apiPost(`/broll/pipeline/${planPipelineId}/run-broll-search`, {})
    } catch (err) {
      console.error('Resume failed:', err)
    }
    setResuming(false)
  }

  if (!total) return null

  if (isRunning) {
    const done = searchProgress.subDone || 0
    const subTotal = searchProgress.subTotal || total
    const pct = subTotal > 0 ? Math.round((done / subTotal) * 100) : 0
    return (
      <div className="px-4 py-1.5 bg-teal-900/20 border-t border-teal-800/30 flex items-center gap-3">
        <Loader2 size={12} className="text-teal-400 animate-spin shrink-0" />
        <span className="text-xs text-teal-400 shrink-0">
          Searching: {done}/{subTotal} ({pct}%)
        </span>
        <div className="flex-1 h-1 bg-teal-900/30 rounded-full overflow-hidden">
          <div className="h-full bg-teal-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
        <button
          onClick={handleStop}
          disabled={stopping}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-40 shrink-0"
        >
          <Square size={10} fill="currentColor" />
          {stopping ? 'Stopping...' : 'Stop'}
        </button>
      </div>
    )
  }

  if (pending > 0 && completed > 0) {
    // Partially done — show resume option
    return (
      <div className="px-4 py-1.5 bg-zinc-900/50 border-t border-zinc-800/50 flex items-center gap-3">
        <span className="text-xs text-zinc-400 shrink-0">
          B-Roll: {completed}/{total} found
        </span>
        <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full bg-teal-600 rounded-full" style={{ width: `${(completed / total) * 100}%` }} />
        </div>
        <button
          onClick={handleResume}
          disabled={resuming}
          className="flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-teal-400 hover:bg-teal-900/20 border border-teal-800/30 transition-colors disabled:opacity-40 shrink-0"
        >
          {resuming ? <Loader2 size={10} className="animate-spin" /> : null}
          {resuming ? 'Resuming...' : 'Continue Search'}
        </button>
      </div>
    )
  }

  if (completed === total && total > 0) {
    return (
      <div className="px-4 py-1.5 bg-zinc-900/30 border-t border-zinc-800/30 flex items-center gap-2">
        <span className="text-xs text-zinc-500">{completed}/{total} B-Roll clips found</span>
      </div>
    )
  }

  return null
}
