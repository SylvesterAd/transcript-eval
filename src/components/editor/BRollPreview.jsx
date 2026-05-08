import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContext } from './EditorView.jsx'
import { BRollContext } from './useBRollEditorState.js'
import RoughCutPreview from './RoughCutPreview.jsx'
import { computeSkipRegions } from './usePlaybackSkipRegions.js'
import { postCutTime } from '../../lib/timeTranslation.js'
import { Loader2 } from 'lucide-react'
import { attachVideoSource, detachVideoSource } from '../../hooks/useHlsSource.js'

export default function BRollPreview() {
  const { state, videoRefs } = useContext(EditorContext)
  const broll = useContext(BRollContext)
  const brollVideoRef = useRef(null)
  const [showBRoll, setShowBRoll] = useState(false)
  const [videoLoadState, setVideoLoadState] = useState('idle')
  const fallbackIdxRef = useRef(0)

  const stateRef = useRef(state); stateRef.current = state
  const brollRef = useRef(broll); brollRef.current = broll

  // Compute skip regions from the editor's cut state (same cuts as the rough-cut
  // editor — synced via editor_state_json). Annotation-source cuts are visual
  // suggestions only — they don't drive playback skipping. Mirror the filter
  // used by TranscriptEditor.isItemCut + Timeline.userCuts.
  // The actual timeupdate listeners are attached below to every a-roll video
  // element in videoRefs (there can be multiple tracks), so we call
  // computeSkipRegions directly instead of the hook.
  const skipRegions = useMemo(
    () => computeSkipRegions(state.cuts.filter(c => c.source !== 'annotation'), state.cutExclusions),
    [state.cuts, state.cutExclusions],
  )
  const skipRegionsRef = useRef(skipRegions)
  skipRegionsRef.current = skipRegions

  useEffect(() => {
    const videoRefsMap = videoRefs.current
    if (!skipRegionsRef.current.length) return
    const handlers = []
    const attach = () => {
      Object.values(videoRefsMap).forEach(el => {
        if (!el) return
        const handleTimeupdate = () => {
          const t = el.currentTime
          for (const r of skipRegionsRef.current) {
            if (t >= r.start && t < r.end) {
              el.currentTime = r.end + 0.001
              return
            }
          }
        }
        el.addEventListener('timeupdate', handleTimeupdate)
        handlers.push({ el, handleTimeupdate })
      })
    }
    attach()
    return () => {
      handlers.forEach(({ el, handleTimeupdate }) =>
        el.removeEventListener('timeupdate', handleTimeupdate)
      )
    }
  }, [videoRefs, skipRegions])

  useEffect(() => {
    let rafId = 0
    const tick = () => {
      const s = stateRef.current
      const b = brollRef.current
      const activePlacement = b ? b.activePlacementAtTime(s.currentTime) : null
      const resultIdx = activePlacement ? (b.selectedResults[activePlacement.index] ?? activePlacement.persistedSelectedResult ?? 0) : 0
      const activeResult = activePlacement?.results?.[resultIdx] || null

      if (activeResult) {
        if (!showBRoll) setShowBRoll(true)
        if (brollVideoRef.current) {
          const v = brollVideoRef.current
          const urlChain = [activeResult.preview_url, activeResult.preview_url_hq, activeResult.url].filter(Boolean)
          const desired = urlChain[0] || ''
          // Compare via the helper's tracked URL — for HLS, hls.js sets v.src
          // to an internal blob: URL so a `v.src !== url` check always
          // mismatches and would re-attach every frame.
          if (v._currentSourceUrl !== desired) {
            fallbackIdxRef.current = 0
            setVideoLoadState('loading')
            attachVideoSource(v, desired)
          }
          // Visual time = where the playhead sits on the post-cut ruler. Each
          // placement's timelineStart/End are in those same post-cut seconds
          // (b-rolls render at `timelineStart * zoom` with no translation), so
          // the elapsed-within-clip is `visualTime - placement.timelineStart`.
          const visualTime = postCutTime(s.currentTime, skipRegionsRef.current)
          const localTime = visualTime - activePlacement.timelineStart
          const clampedTime = Math.max(0, Math.min(localTime, activeResult.duration || 30))
          if (Math.abs(v.currentTime - clampedTime) > 0.5) v.currentTime = clampedTime
          if (s.isPlaying && v.paused) v.play().catch(() => {})
          else if (!s.isPlaying && !v.paused) v.pause()
        }
      } else {
        if (showBRoll) setShowBRoll(false)
        if (brollVideoRef.current && !brollVideoRef.current.paused) brollVideoRef.current.pause()
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [showBRoll])

  // Cleanup any active hls.js instance when the component unmounts. Without
  // this, switching projects leaves the previous Hls Worker alive in
  // memory (small leak, but compounds across navigations).
  useEffect(() => {
    return () => {
      if (brollVideoRef.current) detachVideoSource(brollVideoRef.current)
    }
  }, [])

  const handleLoadedData = () => setVideoLoadState('ready')
  const handleError = () => {
    const b = brollRef.current
    const s = stateRef.current
    const p = b?.activePlacementAtTime?.(s.currentTime)
    const ri = p ? (b.selectedResults[p.index] ?? p.persistedSelectedResult ?? 0) : 0
    const r = p?.results?.[ri]
    const chain = r ? [r.preview_url, r.preview_url_hq, r.url].filter(Boolean) : []
    if (fallbackIdxRef.current + 1 < chain.length) {
      fallbackIdxRef.current += 1
      console.log('[broll-preview] URL failed, trying fallback', fallbackIdxRef.current, chain[fallbackIdxRef.current])
      if (brollVideoRef.current) {
        setVideoLoadState('loading')
        attachVideoSource(brollVideoRef.current, chain[fallbackIdxRef.current])
      }
    } else {
      console.log('[broll-preview] all URL fallbacks exhausted')
      setVideoLoadState('error')
    }
  }

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center">
      <div className={showBRoll ? 'opacity-0 absolute inset-0' : 'absolute inset-0 flex flex-col'}>
        <RoughCutPreview useHls />
      </div>

      <video
        ref={brollVideoRef}
        className={`w-full h-full object-contain ${showBRoll ? '' : 'hidden'}`}
        preload="auto"
        playsInline
        muted
        onLoadedData={handleLoadedData}
        onError={handleError}
      />

      {showBRoll && videoLoadState === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black pointer-events-none">
          <Loader2 size={24} className="text-primary-fixed animate-spin" />
          <span className="text-xs text-primary-fixed/70">Loading clip…</span>
        </div>
      )}
      {showBRoll && videoLoadState === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-xs text-red-400 pointer-events-none">
          Preview unavailable
        </div>
      )}
    </div>
  )
}
