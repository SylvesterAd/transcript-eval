import { useContext, useEffect, useRef, useState } from 'react'
import { EditorContext } from './EditorView.jsx'
import { BRollContext } from './useBRollEditorState.js'
import RoughCutPreview from './RoughCutPreview.jsx'

export default function BRollPreview() {
  const { state } = useContext(EditorContext)
  const broll = useContext(BRollContext)
  const brollVideoRef = useRef(null)
  const [showBRoll, setShowBRoll] = useState(false)

  // Live refs so the rAF tick loop reads the latest values without re-rendering
  const stateRef = useRef(state)
  stateRef.current = state
  const brollRef = useRef(broll)
  brollRef.current = broll

  useEffect(() => {
    let rafId = 0
    const tick = () => {
      const s = stateRef.current
      const b = brollRef.current
      const activePlacement = b ? b.activePlacementAtTime(s.currentTime) : null
      const resultIdx = activePlacement ? (b.selectedResults[activePlacement.index] ?? 0) : 0
      const activeResult = activePlacement?.results?.[resultIdx] || null

      if (activeResult) {
        if (!showBRoll) setShowBRoll(true)
        if (brollVideoRef.current) {
          const url = activeResult.preview_url || activeResult.preview_url_hq || activeResult.url
          if (brollVideoRef.current.src !== url) brollVideoRef.current.src = url
          const localTime = s.currentTime - activePlacement.timelineStart
          const clampedTime = Math.max(0, Math.min(localTime, activeResult.duration || 30))
          if (Math.abs(brollVideoRef.current.currentTime - clampedTime) > 0.5) {
            brollVideoRef.current.currentTime = clampedTime
          }
          if (s.isPlaying && brollVideoRef.current.paused) {
            brollVideoRef.current.play().catch(() => {})
          } else if (!s.isPlaying && !brollVideoRef.current.paused) {
            brollVideoRef.current.pause()
          }
        }
      } else {
        if (showBRoll) setShowBRoll(false)
        if (brollVideoRef.current && !brollVideoRef.current.paused) brollVideoRef.current.pause()
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
    // showBRoll in deps is deliberate: the captured value inside tick serves as the
    // setState deduplication guard (only toggle on transitions). Re-running the effect
    // with a fresh closure when showBRoll commits keeps that guard current.
  }, [showBRoll])

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center">
      {/* Main video (always rendered, hidden when B-Roll active) */}
      <div className={showBRoll ? 'opacity-0 absolute inset-0' : 'w-full h-full flex items-center justify-center'}>
        <RoughCutPreview />
      </div>

      {/* B-Roll video overlay */}
      <video
        ref={brollVideoRef}
        className={`w-full h-full object-contain ${showBRoll ? '' : 'hidden'}`}
        preload="metadata"
        playsInline
        muted
      />
    </div>
  )
}
