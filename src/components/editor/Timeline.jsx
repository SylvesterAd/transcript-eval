import { useContext, useRef, useCallback, useEffect, useLayoutEffect, useState, useMemo } from 'react'
import { EditorContext } from './EditorView.jsx'
import { formatTime, formatTimeRuler } from './useEditorState.js'
import { VideoTrack, AudioTrack, CompositeAudioTrack } from './TimelineTrack.jsx'
import VideoFrameTrack, { CompositeFrameTrack } from './VideoFrameTrack.jsx'

const COMPOSITE_H = 80
const COMPOSITE_AUDIO_H = 56

export default function Timeline() {
  const { state, dispatch, totalDuration, playbackEngine, playheadRef } = useContext(EditorContext)
  const scrollRef = useRef(null)
  const rulerRef = useRef(null)
  const [scrollX, setScrollX] = useState(0)
  const prevZoomRef = useRef(state.zoom)
  const zoomAnchorRef = useRef(null) // { time, screenX } — set by wheel, null for +/- buttons

  // Track horizontal scroll for virtualized tick rendering
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setScrollX(el.scrollLeft))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [])

  const contentWidth = Math.max(totalDuration * state.zoom, 800)

  // Adaptive 3-tier interval selection: major (labeled) → minor → sub-minor
  const INTERVALS = [
    { major: 0.01,  minor: 0.005, sub: 0.001 },
    { major: 0.05,  minor: 0.01,  sub: 0.005 },
    { major: 0.1,   minor: 0.05,  sub: 0.01  },
    { major: 0.2,   minor: 0.05,  sub: 0.01  },
    { major: 0.5,   minor: 0.1,   sub: 0.05  },
    { major: 1,     minor: 0.5,   sub: 0.1   },
    { major: 2,     minor: 1,     sub: 0.5   },
    { major: 5,     minor: 1,     sub: 0.5   },
    { major: 10,    minor: 5,     sub: 1     },
    { major: 30,    minor: 10,    sub: 5     },
    { major: 60,    minor: 30,    sub: 10    },
    { major: 120,   minor: 60,    sub: 30    },
    { major: 300,   minor: 60,    sub: 30    },
  ]

  const iv = (() => {
    for (const entry of INTERVALS) {
      if (entry.major * state.zoom >= 80) return entry
    }
    return INTERVALS[INTERVALS.length - 1]
  })()

  const minorPx = iv.minor * state.zoom
  const subPx = iv.sub * state.zoom

  // Only generate marks visible in the viewport (+ buffer)
  const viewW = scrollRef.current?.clientWidth || 1200
  const visStartTime = Math.max(0, (scrollX - 300) / state.zoom)
  const visEndTime = (scrollX + viewW + 300) / state.zoom

  // Snap to major interval boundaries so we always get complete tick groups
  const firstMajor = Math.floor(visStartTime / iv.major) * iv.major
  const lastMajor = Math.ceil(visEndTime / iv.major) * iv.major

  const majorMarks = (() => {
    const marks = []
    for (let t = firstMajor; t <= Math.min(lastMajor, totalDuration + iv.major); t += iv.major) {
      const time = Math.round(t * 1000) / 1000
      marks.push({ time, label: formatTimeRuler(time, iv.major), x: time * state.zoom })
    }
    return marks
  })()

  // Scrub on ruler click
  const handleRulerClick = useCallback((e) => {
    const rect = rulerRef.current?.getBoundingClientRect()
    if (!rect) return
    // getBoundingClientRect already accounts for scroll — no scrollLeft needed.
    const x = e.clientX - rect.left
    const time = Math.max(0, x / state.zoom)
    dispatch({ type: 'SET_CURRENT_TIME', payload: time })
    playbackEngine.current?.seek(time)
  }, [state.zoom, dispatch, playbackEngine])

  // Zoom with Ctrl+wheel — non-passive listener to block browser page zoom
  const zoomRef = useRef(state.zoom)
  zoomRef.current = state.zoom
  useEffect(() => {
    const container = scrollRef.current?.parentElement
    if (!container) return
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const el = scrollRef.current
      if (!el) return
      const zoom = zoomRef.current
      const step = Math.max(1, Math.round(zoom * 0.05)) // 5% of current zoom
      const delta = e.deltaY > 0 ? -step : step
      const newZoom = Math.max(5, Math.min(1000, zoom + delta))
      if (newZoom === zoom) return
      const labelW = 144
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const timeAtCursor = (el.scrollLeft + cursorX - labelW) / zoom
      // Store anchor — useEffect will adjust scroll after React re-renders
      zoomAnchorRef.current = { time: timeAtCursor, screenX: cursorX }
      dispatch({ type: 'SET_ZOOM', payload: newZoom })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [dispatch])

  // Adjust scroll after zoom change — useLayoutEffect runs synchronously after DOM update,
  // before paint, so content width is already correct and scrollLeft won't get clamped.
  useLayoutEffect(() => {
    const oldZoom = prevZoomRef.current
    if (oldZoom === state.zoom) return
    prevZoomRef.current = state.zoom
    const el = scrollRef.current
    if (!el) return
    const labelW = 144
    const anchor = zoomAnchorRef.current
    if (anchor) {
      // Wheel zoom: keep cursor point stable
      el.scrollLeft = anchor.time * state.zoom - anchor.screenX + labelW
      zoomAnchorRef.current = null
    } else {
      // +/- buttons: keep playhead at same screen position
      const playheadScreenX = state.currentTime * oldZoom - el.scrollLeft + labelW
      const viewW = el.clientWidth
      if (playheadScreenX >= 0 && playheadScreenX <= viewW) {
        el.scrollLeft = state.currentTime * state.zoom - playheadScreenX + labelW
      }
    }
  }, [state.zoom, state.currentTime])

  // Auto-scroll during playback
  useEffect(() => {
    if (!state.isPlaying || !scrollRef.current) return
    const interval = setInterval(() => {
      const el = scrollRef.current
      if (!el) return
      const playheadX = state.currentTime * state.zoom
      const { scrollLeft, clientWidth } = el
      if (playheadX > scrollLeft + clientWidth - 100) {
        el.scrollLeft = playheadX - clientWidth / 2
      }
    }, 200)
    return () => clearInterval(interval)
  }, [state.isPlaying, state.currentTime, state.zoom])

  const playheadX = state.currentTime * state.zoom

  // Stable numbering: based on original load order, never changes on reorder
  const trackNumber = useCallback((track) => {
    const order = state.originalVideoOrder || []
    const videoId = track.type === 'video' ? track.id : `v-${track.videoId}`
    const idx = order.indexOf(videoId)
    return idx >= 0 ? idx + 1 : 1
  }, [state.originalVideoOrder])

  // Visible tracks (respects audioOnly) with layout for mixed-height drag
  const isRoughCut = state.activeTab === 'roughcut'
  const isMainMode = isRoughCut && state.roughCutTrackMode === 'main'

  // In MAIN mode, compute non-overlapping segments from video tracks.
  // Sorted by offset (earliest first) — the track that starts earliest gets priority.
  const mainTrackSegments = useMemo(() => {
    if (!isMainMode) return null
    const videoTracks = state.tracks
      .filter(t => t.type === 'video')
      .sort((a, b) => a.offset - b.offset)
    if (!videoTracks.length) return []
    const segments = []
    let covered = 0
    for (const track of videoTracks) {
      const trackEnd = track.offset + track.duration
      if (trackEnd <= covered) continue
      const segStart = Math.max(track.offset, covered)
      if (segStart >= trackEnd) continue
      segments.push({ start: segStart, end: trackEnd, videoId: track.videoId, trackId: track.id, title: track.title, offset: track.offset, duration: track.duration, filePath: track.filePath, groupId: track.groupId })
      covered = trackEnd
    }
    return segments
  }, [isMainMode, state.tracks])

  const visibleLayout = useMemo(() => {
    const items = []
    let y = isMainMode ? COMPOSITE_H + COMPOSITE_AUDIO_H : 0
    for (let i = 0; i < state.tracks.length; i++) {
      const t = state.tracks[i]
      if (t.type === 'video' && ((!isRoughCut && state.audioOnly) || isMainMode)) continue
      if (t.type === 'audio' && isMainMode) continue
      const h = t.type === 'video' ? (isRoughCut ? 80 : 24) : (t.showTranscript ? 112 : 56)
      items.push({ absIdx: i, y, h })
      y += h
    }
    return items
  }, [state.tracks, state.audioOnly, isRoughCut, isMainMode])

  // Context menu
  const ctxTrack = state.contextMenu ? state.tracks.find(t => t.id === state.contextMenu.trackId) : null

  // Unified track drag reorder — any track can be moved to any position
  const [dragState, setDragState] = useState({ dragging: false, fromAbsIdx: -1, overAbsIdx: -1, dy: 0 })
  const dragDidMove = useRef(false)
  const mouseYRef = useRef(0)
  const scrollRafRef = useRef(0)

  // Auto-scroll when dragging near edges of scroll container
  const startAutoScroll = useCallback(() => {
    const tick = () => {
      const el = scrollRef.current
      if (!el) { scrollRafRef.current = requestAnimationFrame(tick); return }
      const rect = el.getBoundingClientRect()
      const y = mouseYRef.current
      const edge = 60
      if (y > rect.top && y < rect.top + edge) {
        el.scrollTop -= Math.max(2, (edge - (y - rect.top)) * 0.3)
      } else if (y < rect.bottom && y > rect.bottom - edge) {
        el.scrollTop += Math.max(2, (edge - (rect.bottom - y)) * 0.3)
      }
      scrollRafRef.current = requestAnimationFrame(tick)
    }
    scrollRafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopAutoScroll = useCallback(() => {
    cancelAnimationFrame(scrollRafRef.current)
  }, [])

  const handleTrackDragStart = useCallback((e, absIdx) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startY = e.clientY
    const startScrollTop = scrollRef.current?.scrollTop || 0
    dragDidMove.current = false
    mouseYRef.current = e.clientY

    const layout = visibleLayout
    const visIdx = layout.findIndex(l => l.absIdx === absIdx)
    if (visIdx === -1) return
    const startTrackY = layout[visIdx].y
    const trackH = layout[visIdx].h
    let dropAbsIdx = absIdx

    const onMove = (ev) => {
      mouseYRef.current = ev.clientY
      const scrollDelta = (scrollRef.current?.scrollTop || 0) - startScrollTop
      const dy = ev.clientY - startY
      const logicalDy = dy + scrollDelta
      if (!dragDidMove.current && Math.abs(dy) < 5) return
      if (!dragDidMove.current) {
        dragDidMove.current = true
        setDragState({ dragging: true, fromAbsIdx: absIdx, overAbsIdx: absIdx, dy: 0 })
        startAutoScroll()
      }
      // Find target slot using cumulative heights
      const targetCenterY = startTrackY + trackH / 2 + logicalDy
      let dropVisIdx = visIdx
      for (let i = 0; i < layout.length; i++) {
        if (targetCenterY >= layout[i].y && targetCenterY < layout[i].y + layout[i].h) {
          dropVisIdx = i
          break
        }
      }
      if (targetCenterY < 0) dropVisIdx = 0
      if (targetCenterY >= layout[layout.length - 1].y + layout[layout.length - 1].h) dropVisIdx = layout.length - 1
      dropAbsIdx = layout[dropVisIdx].absIdx
      setDragState(prev => ({ ...prev, overAbsIdx: dropAbsIdx, dy }))
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      stopAutoScroll()
      setDragState({ dragging: false, fromAbsIdx: -1, overAbsIdx: -1, dy: 0 })
      if (dragDidMove.current && absIdx !== dropAbsIdx) {
        dispatch({ type: 'REORDER_TRACK', payload: { fromIndex: absIdx, toIndex: dropAbsIdx } })
      } else if (!dragDidMove.current) {
        dispatch({
          type: 'SELECT_TRACK',
          payload: { trackId: state.tracks[absIdx]?.id, shift: ev.shiftKey, meta: ev.metaKey || ev.ctrlKey }
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [visibleLayout, state.tracks, dispatch, startAutoScroll, stopAutoScroll])

  return (
    <div
      className="h-full bg-surface-container-low rounded-xl flex flex-col overflow-hidden relative border border-white/5"
      onClick={() => state.contextMenu && dispatch({ type: 'CLOSE_CONTEXT_MENU' })}
    >
      {/* Single scroll container for everything */}
      <div ref={scrollRef} className="flex-1 overflow-auto editor-scroll relative bg-surface-dim">
        <div className="relative" style={{ minWidth: `${contentWidth + 128}px` }}>

          {/* Ruler row — sticky top */}
          <div className="sticky top-0 z-20 flex h-10 border-b border-white/5">
            {/* Corner */}
            <div className="sticky left-0 w-36 shrink-0 bg-surface-container z-30" />
            {/* Ruler */}
            <div
              ref={rulerRef}
              className="flex-1 relative bg-surface-container cursor-pointer overflow-hidden"
              onClick={handleRulerClick}
            >
              <div className="relative h-full" style={{ minWidth: `${contentWidth}px` }}>
                {/* Sub-minor ticks — CSS gradient, zero DOM elements */}
                {subPx >= 2 && (
                  <div className="absolute bottom-0 pointer-events-none" style={{
                    left: 0, right: 0, height: '4px',
                    backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.08) 0px, rgba(255,255,255,0.08) 1px, transparent 1px, transparent ${subPx}px)`,
                  }} />
                )}
                {/* Minor ticks — CSS gradient, zero DOM elements */}
                {minorPx >= 2 && (
                  <div className="absolute bottom-0 pointer-events-none" style={{
                    left: 0, right: 0, height: '8px',
                    backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.15) 0px, rgba(255,255,255,0.15) 1px, transparent 1px, transparent ${minorPx}px)`,
                  }} />
                )}
                {/* Major ticks + centered labels */}
                {majorMarks.map((m) => (
                  <div key={m.time} className="absolute bottom-0" style={{ left: `${m.x}px` }}>
                    <div className="absolute bottom-0 w-px bg-white/30" style={{ height: '14px' }} />
                    <span
                      className={`absolute bottom-3.5 text-[9px] font-mono whitespace-nowrap ${
                        Math.abs(m.time - state.currentTime) < iv.major * 0.5 ? 'text-primary-fixed font-bold opacity-100' : 'opacity-30'
                      }`}
                      style={{ transform: m.time === 0 ? 'none' : 'translateX(-50%)' }}
                    >
                      {m.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Composite video + audio tracks in MAIN mode */}
          {isMainMode && mainTrackSegments?.length > 0 && (
            <>
              <div className="relative">
                <div className="flex">
                  <div className="sticky left-0 w-36 shrink-0 border-b border-r border-white/10 flex items-center pl-2 pr-3 text-[10px] font-bold gap-1.5 z-10 bg-surface-container text-on-surface-variant" style={{ height: '80px' }}>
                    <span className="material-symbols-outlined text-[12px] shrink-0 opacity-30">drag_indicator</span>
                    <span className="w-5 shrink-0">V</span>
                  </div>
                  <div className="flex-1 relative">
                    <CompositeFrameTrack segments={mainTrackSegments} zoom={state.zoom} cuts={state.cuts} scrollRef={scrollRef} scrollX={scrollX} />
                  </div>
                </div>
              </div>
              <div className="relative">
                <div className="flex">
                  <div className="sticky left-0 w-36 shrink-0 border-b border-r border-white/5 flex items-center pl-2 pr-3 text-[10px] font-bold gap-1.5 z-10 bg-surface-container text-on-surface-variant" style={{ height: '56px' }}>
                    <span className="material-symbols-outlined text-[12px] shrink-0 opacity-30">drag_indicator</span>
                    <span className="w-5 shrink-0">A</span>
                  </div>
                  <div className="flex-1 relative">
                    <CompositeAudioTrack segments={mainTrackSegments} zoom={state.zoom} cuts={state.cuts} scrollRef={scrollRef} scrollX={scrollX} />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Track rows — unified list, any track can be dragged to any position */}
          {state.tracks.map((track, absIdx) => {
            if (track.type === 'video' && ((!isRoughCut && state.audioOnly) || isMainMode)) return null
            if (track.type === 'audio' && isMainMode) return null
            const selected = state.selectedTrackIds.has(track.id)
            const num = trackNumber(track)
            const isDragSource = dragState.dragging && dragState.fromAbsIdx === absIdx
            const showInsertBefore = dragState.dragging && dragState.overAbsIdx === absIdx && absIdx < dragState.fromAbsIdx
            const showInsertAfter = dragState.dragging && dragState.overAbsIdx === absIdx && absIdx > dragState.fromAbsIdx
            const isVideo = track.type === 'video'

            return (
              <div
                key={track.id}
                className="relative"
                style={isDragSource ? { opacity: 0.5, zIndex: 30, transform: `translateY(${dragState.dy}px)`, pointerEvents: 'none' } : undefined}
              >
                {showInsertBefore && (
                  <div className="absolute top-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />
                )}
                <div className="flex">
                  {/* Sticky label — drag to reorder */}
                  <div
                    onMouseDown={(e) => handleTrackDragStart(e, absIdx)}
                    style={isVideo ? (isRoughCut ? { height: '80px' } : undefined) : { height: track.showTranscript ? '112px' : '56px' }}
                    className={`sticky left-0 w-36 shrink-0 ${isVideo ? 'h-6 border-b border-r border-white/10' : 'border-b border-r border-white/5'} flex items-center pl-2 pr-3 text-[10px] font-bold gap-1.5 cursor-grab active:cursor-grabbing select-none z-10 bg-surface-container ${
                      selected ? 'text-primary-fixed bg-primary-container/5' : 'text-on-surface-variant'
                    } ${isDragSource ? 'ring-1 ring-primary-fixed bg-primary-fixed/10' : ''}`}
                  >
                    <span className={`material-symbols-outlined text-[12px] shrink-0 ${isDragSource ? 'text-primary-fixed opacity-100' : 'opacity-30'}`}>drag_indicator</span>
                    <span className="w-5 shrink-0">{isVideo ? `V${num}` : `A${num}`}</span>
                    <div className={`h-3 w-[1px] shrink-0 ${selected ? 'bg-primary-fixed/30' : 'bg-white/30'}`} />
                    {isVideo ? (
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_VISIBILITY', payload: track.id }) }}
                        className="material-symbols-outlined text-[9px] shrink-0"
                        style={track.visible ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                      >
                        {track.visible ? 'visibility' : 'visibility_off'}
                      </button>
                    ) : (
                      <>
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_MUTE', payload: track.id }) }}
                          className="material-symbols-outlined text-[9px] shrink-0"
                          style={!track.muted ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                        >
                          {track.muted ? 'volume_off' : 'volume_up'}
                        </button>
                        <div className={`h-3 w-[1px] shrink-0 ${selected ? 'bg-primary-fixed/30' : 'bg-white/30'}`} />
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_TRANSCRIPT', payload: track.id }) }}
                          className="material-symbols-outlined text-[9px] shrink-0"
                          style={track.showTranscript ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                        >
                          text_fields
                        </button>
                      </>
                    )}
                  </div>
                  <div className="flex-1 relative">
                    {isVideo
                      ? (isRoughCut
                          ? <VideoFrameTrack track={track} zoom={state.zoom} cuts={state.cuts} scrollRef={scrollRef} scrollX={scrollX} />
                          : <VideoTrack track={track} zoom={state.zoom} />)
                      : <AudioTrack track={track} zoom={state.zoom} cuts={isRoughCut ? state.cuts : null} scrollRef={scrollRef} scrollX={scrollX} />
                    }
                  </div>
                </div>
                {showInsertAfter && (
                  <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />
                )}
              </div>
            )
          })}

          {/* Unified playhead — spans ruler + all tracks */}
          <div
            ref={playheadRef}
            className="absolute top-0 h-full w-[2px] bg-primary-fixed pointer-events-none z-20"
            style={{ transform: `translateX(${playheadX}px)`, left: '9rem' }}
          >
            <div className="sticky top-1 -left-1.5 w-3.5 h-3.5 bg-primary-fixed rotate-45 rounded-sm" />
          </div>
        </div>
      </div>

      {/* Time display overlay */}
      <div className="absolute bottom-4 right-6 flex items-center gap-4 bg-surface-dim/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/5 pointer-events-none z-30">
        <span className="text-[10px] font-mono text-on-surface-variant">
          Position: {formatTime(state.currentTime)}
        </span>
        <span className="text-[10px] font-mono text-on-surface-variant">
          Total: {formatTime(totalDuration)}
        </span>
        {isRoughCut && state.cuts.length > 0 && (
          <span className="text-[10px] font-mono text-primary-fixed">
            After cuts: {formatTime(Math.max(0, totalDuration - state.cuts.reduce((s, c) => s + Math.max(0, Math.min(c.end, totalDuration) - Math.max(c.start, 0)), 0)))}
          </span>
        )}
      </div>

      {/* Context menu */}
      {state.contextMenu && ctxTrack && (
        <div
          className="fixed z-50 bg-surface-container-high border border-white/10 rounded-lg shadow-2xl py-1 min-w-[160px]"
          style={{ left: state.contextMenu.x, top: state.contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxTrack.groupId && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 text-on-surface"
              onClick={() => {
                dispatch({ type: 'UNGROUP_TRACK', payload: { trackId: ctxTrack.id } })
                dispatch({ type: 'CLOSE_CONTEXT_MENU' })
              }}
            >
              Ungroup track
            </button>
          )}
          {!ctxTrack.groupId && state.selectedTrackIds.size >= 2 && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 text-on-surface"
              onClick={() => {
                dispatch({ type: 'GROUP_TRACKS', payload: { trackIds: [...state.selectedTrackIds] } })
                dispatch({ type: 'CLOSE_CONTEXT_MENU' })
              }}
            >
              Group selected tracks
            </button>
          )}
          {ctxTrack.offset !== ctxTrack.originalOffset && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 text-[#ff7351]"
              onClick={() => {
                dispatch({ type: 'RESYNC_TRACK', payload: ctxTrack.id })
                dispatch({ type: 'CLOSE_CONTEXT_MENU' })
              }}
            >
              Re-sync to original
            </button>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 text-on-surface"
            onClick={() => {
              dispatch({ type: 'SPLIT_TRACK', payload: { trackId: ctxTrack.id, time: state.currentTime } })
              dispatch({ type: 'CLOSE_CONTEXT_MENU' })
            }}
          >
            Split at playhead
          </button>
        </div>
      )}
    </div>
  )
}
