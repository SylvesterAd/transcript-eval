import { useState, useCallback, useRef } from 'react'
import { BRollContext, useBRollEditorState } from './useBRollEditorState.js'
import BRollPreview from './BRollPreview.jsx'
import BRollDetailPanel from './BRollDetailPanel.jsx'
import Timeline from './Timeline.jsx'
import PlaybackControls from './PlaybackControls.jsx'
import { Loader2 } from 'lucide-react'

export default function BRollEditor({ groupId, videoId, planPipelineId }) {
  const brollState = useBRollEditorState(planPipelineId)
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
      <main ref={splitRef} className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
        {/* Top area: video preview + detail sidebar */}
        <div className="flex-1 flex min-h-0">
          {/* Video preview */}
          <div className="flex-1 flex flex-col min-h-0">
            <BRollPreview />
          </div>

          {/* Detail sidebar (appears when placement selected) */}
          {brollState.selectedPlacement && <BRollDetailPanel />}
        </div>

        {/* Search progress bar */}
        {brollState.searchProgress?.status === 'running' && (
          <div className="px-4 py-1.5 bg-teal-900/20 border-t border-teal-800/30 flex items-center gap-2">
            <Loader2 size={12} className="text-teal-400 animate-spin" />
            <span className="text-xs text-teal-400">
              Searching B-Roll: {brollState.searchProgress.subDone}/{brollState.searchProgress.subTotal}
            </span>
            <div className="flex-1 h-1 bg-teal-900/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-teal-500 rounded-full transition-all"
                style={{ width: `${(brollState.searchProgress.subDone / brollState.searchProgress.subTotal) * 100}%` }}
              />
            </div>
          </div>
        )}

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
    </BRollContext.Provider>
  )
}
