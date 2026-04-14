import { useContext, useEffect, useRef, useState, useMemo } from 'react'
import { EditorContext } from './EditorView.jsx'
import { BRollContext } from './useBRollEditorState.js'
import RoughCutPreview from './RoughCutPreview.jsx'

export default function BRollPreview() {
  const { state } = useContext(EditorContext)
  const broll = useContext(BRollContext)
  const brollVideoRef = useRef(null)
  const [showBRoll, setShowBRoll] = useState(false)
  const lastPlacementRef = useRef(null)

  const activePlacement = useMemo(() => {
    if (!broll) return null
    return broll.activePlacementAtTime(state.currentTime)
  }, [broll, state.currentTime])

  // Get the selected result for the active placement
  const activeResult = useMemo(() => {
    if (!activePlacement) return null
    const resultIdx = broll?.selectedResults[activePlacement.index] ?? 0
    return activePlacement.results?.[resultIdx] || null
  }, [activePlacement, broll?.selectedResults])

  // Switch between main video and B-Roll
  useEffect(() => {
    if (activeResult) {
      setShowBRoll(true)
      // If it's a different placement or result, update video src
      if (brollVideoRef.current) {
        const url = activeResult.preview_url || activeResult.url
        if (brollVideoRef.current.src !== url) {
          brollVideoRef.current.src = url
        }
        // Seek to correct position within the B-Roll clip
        const localTime = state.currentTime - activePlacement.timelineStart
        const clampedTime = Math.max(0, Math.min(localTime, activeResult.duration || 30))
        if (Math.abs(brollVideoRef.current.currentTime - clampedTime) > 0.5) {
          brollVideoRef.current.currentTime = clampedTime
        }
        // Sync play state
        if (state.isPlaying && brollVideoRef.current.paused) {
          brollVideoRef.current.play().catch(() => {})
        } else if (!state.isPlaying && !brollVideoRef.current.paused) {
          brollVideoRef.current.pause()
        }
      }
    } else {
      setShowBRoll(false)
      if (brollVideoRef.current && !brollVideoRef.current.paused) {
        brollVideoRef.current.pause()
      }
    }
    lastPlacementRef.current = activePlacement
  }, [activeResult, activePlacement, state.currentTime, state.isPlaying])

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center">
      {/* Main video (always rendered, hidden when B-Roll active) */}
      <div className={showBRoll ? 'opacity-0 absolute inset-0' : 'w-full h-full flex items-center justify-center'}>
        <RoughCutPreview />
      </div>

      {/* B-Roll video overlay */}
      <video
        ref={brollVideoRef}
        className={`max-w-full max-h-full object-contain ${showBRoll ? '' : 'hidden'}`}
        preload="metadata"
        playsInline
        muted
      />

      {/* B-Roll indicator badge */}
      {showBRoll && (
        <div className="absolute top-3 left-3 px-2 py-1 rounded bg-teal-600/80 text-[10px] font-bold text-white uppercase tracking-wider">
          B-Roll
        </div>
      )}
    </div>
  )
}
