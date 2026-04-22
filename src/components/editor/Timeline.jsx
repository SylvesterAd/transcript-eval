import { useContext, useRef, useCallback, useEffect, useLayoutEffect, useState, useMemo } from 'react'
import { EditorContext } from './EditorView.jsx'
import { formatTime, formatTimeRuler } from './useEditorState.js'
import { VideoTrack, AudioTrack, CompositeAudioTrack } from './TimelineTrack.jsx'
import VideoFrameTrack, { CompositeFrameTrack } from './VideoFrameTrack.jsx'
import BRollTrack, { BROLL_TRACK_H } from './BRollTrack.jsx'
import { BRollContext } from './useBRollEditorState.js'

const COMPOSITE_H = 80
const COMPOSITE_AUDIO_H = 56

export default function Timeline({ variants, activeVariantIdx, onVariantActivate, inactiveVariantPlacements }) {
  const { state, dispatch, totalDuration, playbackEngine, playheadRef } = useContext(EditorContext)
  const scrollRef = useRef(null)
  const rulerRef = useRef(null)
  const [scrollX, setScrollX] = useState(0)
  const prevZoomRef = useRef(state.zoom)
  const zoomAnchorRef = useRef(null) // { time, screenX } — set by wheel, null for +/- buttons

  // Merge cuts for display and refine edges using waveform
  const mergedDisplayCuts = useMemo(() => {
    if (!state.cuts.length) return []

    // Build word list and waveform helpers
    const primaryAudio = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    const words = primaryAudio?.transcriptWords?.map(w => ({
      start: w.start + (primaryAudio.offset || 0),
      end: w.end + (primaryAudio.offset || 0),
    })) || []
    // Separate zero-width cuts (razor markers) from real cuts
    const zeroWidth = state.cuts.filter(c => c.end <= c.start + 0.01 && c.end >= c.start)
    const valid = state.cuts.filter(c => c.end > c.start + 0.01)
    if (!valid.length) return [...zeroWidth]
    const sorted = [...valid].sort((a, b) => a.start - b.start)
    const merged = [{ ...sorted[0] }]
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1]
      if (sorted[i].start <= last.end + 0.05) {
        last.end = Math.max(last.end, sorted[i].end)
      } else {
        const hasWord = words.some(w => w.start >= last.end - 0.05 && w.end <= sorted[i].start + 0.05)
        if (!hasWord) {
          last.end = Math.max(last.end, sorted[i].end)
        } else {
          merged.push({ ...sorted[i] })
        }
      }
    }

    return [...merged, ...zeroWidth]
  }, [state.cuts, state.tracks])

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

  // Own the playhead transform for render-driven updates (mount, zoom change, paused seek).
  // During playback the rAF engine in EditorView writes transform directly at 60fps — this
  // effect must NOT fire then, or it would overwrite the live value with a 10Hz-stale one
  // (the same class of bug this task was created to fix).
  useLayoutEffect(() => {
    if (!playheadRef.current) return
    if (state.isPlaying) return
    playheadRef.current.style.transform = `translateX(${state.currentTime * state.zoom}px)`
  }, [state.zoom, state.currentTime, state.isPlaying, playheadRef])

  // Auto-scroll during playback — smooth follow, playhead stays at ~1/5 from left
  const currentTimeRef = useRef(state.currentTime)
  currentTimeRef.current = state.currentTime
  useEffect(() => {
    if (!state.isPlaying || !scrollRef.current) return
    let raf
    let following = false
    const tick = () => {
      const el = scrollRef.current
      const ph = playheadRef.current
      if (!el || !ph) { raf = requestAnimationFrame(tick); return }
      // Read playhead pixel position directly from DOM (updated at 60fps by playback engine)
      const match = ph.style.transform.match(/translateX\(([^)]+)px\)/)
      const playheadX = match ? parseFloat(match[1]) : currentTimeRef.current * zoomRef.current
      const { scrollLeft, clientWidth } = el
      const screenPos = playheadX - scrollLeft

      if (!following && screenPos > clientWidth * 0.8) {
        following = true
      }
      if (following) {
        el.scrollLeft = playheadX - clientWidth * 0.8
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state.isPlaying])

  // Scroll timeline into view on seek (word click, etc.) when not playing
  useEffect(() => {
    if (state.isPlaying || !scrollRef.current) return
    const el = scrollRef.current
    const playheadX = state.currentTime * state.zoom
    const { scrollLeft, clientWidth } = el
    if (playheadX < scrollLeft + 100 || playheadX > scrollLeft + clientWidth - 100) {
      el.scrollLeft = playheadX - clientWidth / 3
    }
  }, [state.isPlaying, state.currentTime, state.zoom])

  // Stable numbering: based on original load order, never changes on reorder
  const trackNumber = useCallback((track) => {
    const order = state.originalVideoOrder || []
    const videoId = track.type === 'video' ? track.id : `v-${track.videoId}`
    const idx = order.indexOf(videoId)
    return idx >= 0 ? idx + 1 : 1
  }, [state.originalVideoOrder])

  // Visible tracks (respects audioOnly) with layout for mixed-height drag
  const isRoughCut = state.activeTab === 'roughcut'
  const showVideoFrames = isRoughCut || state.activeTab === 'brolls'
  const isMainMode = isRoughCut && state.roughCutTrackMode === 'main'

  // In MAIN mode, compute merged segments from video tracks.
  // Overlapping tracks are merged into one segment — the earliest track is the default camera,
  // and the segment extends to the max end of all overlapping tracks.
  const mainTrackSegments = useMemo(() => {
    if (!isMainMode) return null
    const videoTracks = state.tracks
      .filter(t => t.type === 'video')
      .sort((a, b) => a.offset - b.offset)
    if (!videoTracks.length) return []
    const segments = []
    let cur = null
    for (const track of videoTracks) {
      const trackEnd = track.offset + track.duration
      if (cur && track.offset < cur.end) {
        // Overlapping — extend segment end
        cur.end = Math.max(cur.end, trackEnd)
      } else {
        // New segment — first track is the default camera
        cur = { start: track.offset, end: trackEnd, videoId: track.videoId, trackId: track.id, title: track.title, offset: track.offset, duration: track.duration, filePath: track.filePath, groupId: track.groupId }
        segments.push(cur)
      }
    }
    return segments
  }, [isMainMode, state.tracks])

  // Available cameras per segment (stable, only recomputes on track changes)
  const segmentCameras = useMemo(() => {
    if (!mainTrackSegments?.length) return []
    return mainTrackSegments.map(seg => {
      return state.tracks
        .filter(t => t.type === 'video' && t.offset < seg.end && t.offset + t.duration > seg.start)
        .map(t => ({ videoId: t.videoId, trackId: t.id, number: trackNumber(t) }))
    })
  }, [mainTrackSegments, state.tracks, trackNumber])

  // Which segment contains the playhead (search backwards for robustness at boundaries)
  const currentSegmentIndex = useMemo(() => {
    if (!mainTrackSegments?.length) return 0
    for (let i = mainTrackSegments.length - 1; i >= 0; i--) {
      if (state.currentTime >= mainTrackSegments[i].start) return i
    }
    return 0
  }, [mainTrackSegments, state.currentTime])

  // Effective video segments with overrides applied
  const effectiveVideoSegments = useMemo(() => {
    if (!mainTrackSegments?.length) return mainTrackSegments
    return mainTrackSegments.map((seg, i) => {
      const ov = state.segmentVideoOverrides[i]
      if (!ov || ov === seg.videoId) return seg
      const t = state.tracks.find(t => t.type === 'video' && t.videoId === ov)
      if (!t || t.offset >= seg.end || t.offset + t.duration <= seg.start) return seg
      return { ...seg, videoId: ov, trackId: t.id, title: t.title, filePath: t.filePath, groupId: t.groupId, offset: t.offset, duration: t.duration }
    })
  }, [mainTrackSegments, state.segmentVideoOverrides, state.tracks])

  // Effective audio segments with overrides applied
  const effectiveAudioSegments = useMemo(() => {
    if (!mainTrackSegments?.length) return mainTrackSegments
    return mainTrackSegments.map((seg, i) => {
      const ov = state.segmentAudioOverrides[i]
      if (!ov || ov === seg.videoId) return seg
      const t = state.tracks.find(t => t.type === 'video' && t.videoId === ov)
      if (!t || t.offset >= seg.end || t.offset + t.duration <= seg.start) return seg
      return { ...seg, videoId: ov, trackId: t.id, title: t.title, filePath: t.filePath, groupId: t.groupId, offset: t.offset, duration: t.duration }
    })
  }, [mainTrackSegments, state.segmentAudioOverrides, state.tracks])

  // Active video/audio IDs for the current segment (with override + fallback)
  const activeVideoId = useMemo(() => {
    const seg = mainTrackSegments?.[currentSegmentIndex]
    if (!seg) return null
    const ov = state.segmentVideoOverrides[currentSegmentIndex]
    if (ov) {
      const t = state.tracks.find(t => t.type === 'video' && t.videoId === ov)
      if (t && state.currentTime >= t.offset && state.currentTime < t.offset + t.duration) return ov
    }
    return seg.videoId
  }, [mainTrackSegments, currentSegmentIndex, state.segmentVideoOverrides, state.tracks, state.currentTime])

  const activeAudioId = useMemo(() => {
    const seg = mainTrackSegments?.[currentSegmentIndex]
    if (!seg) return null
    const ov = state.segmentAudioOverrides[currentSegmentIndex]
    if (ov) {
      const t = state.tracks.find(t => t.type === 'video' && t.videoId === ov)
      if (t && state.currentTime >= t.offset && state.currentTime < t.offset + t.duration) return ov
    }
    return seg.videoId
  }, [mainTrackSegments, currentSegmentIndex, state.segmentAudioOverrides, state.tracks, state.currentTime])

  const currentCameras = segmentCameras[currentSegmentIndex] || []

  // Resolve B-Roll track position: -1 means "after last audio track"
  const broll = useContext(BRollContext)
  const hasBrollTrack = !!broll?.placements?.length || (inactiveVariantPlacements && Object.values(inactiveVariantPlacements).some(p => p?.length > 0))
  const brollVariantCount = variants?.length > 1 ? variants.length : 1
  const resolvedBrollPosition = useMemo(() => {
    if (!hasBrollTrack) return -2 // no B-Roll track to show
    const pos = state.brollTrackPosition
    if (pos >= 0 && pos <= state.tracks.length) return pos
    // Default: after last audio track
    let lastAudioIdx = -1
    for (let i = 0; i < state.tracks.length; i++) {
      if (state.tracks[i].type === 'audio') lastAudioIdx = i
    }
    return lastAudioIdx + 1
  }, [state.brollTrackPosition, state.tracks, hasBrollTrack])

  const visibleLayout = useMemo(() => {
    const items = []
    const compositeAudioH = state.compositeShowTranscript ? 112 : 56
    let y = isMainMode ? COMPOSITE_H + compositeAudioH : 0
    let trackSlot = 0 // counts visible track slots for B-Roll insertion
    let brollInserted = false
    for (let i = 0; i < state.tracks.length; i++) {
      const t = state.tracks[i]
      if (t.type === 'video' && ((!isRoughCut && state.audioOnly) || isMainMode)) continue
      if (t.type === 'audio' && isMainMode) continue
      // Insert B-Roll rows before this track if position matches
      if (!brollInserted && hasBrollTrack && resolvedBrollPosition <= i) {
        for (let vi = 0; vi < brollVariantCount; vi++) {
          items.push({ absIdx: -1 - vi, y, h: BROLL_TRACK_H, isBroll: true, variantIdx: vi })
          y += BROLL_TRACK_H
        }
        brollInserted = true
      }
      const h = t.type === 'video' ? (showVideoFrames ? 80 : 24) : (t.showTranscript ? 112 : 56)
      items.push({ absIdx: i, y, h })
      y += h
      trackSlot++
    }
    // B-Roll at the end if not yet inserted
    if (!brollInserted && hasBrollTrack) {
      for (let vi = 0; vi < brollVariantCount; vi++) {
        items.push({ absIdx: -1 - vi, y, h: BROLL_TRACK_H, isBroll: true, variantIdx: vi })
        y += BROLL_TRACK_H
      }
    }
    return items
  }, [state.tracks, state.audioOnly, isRoughCut, showVideoFrames, isMainMode, state.compositeShowTranscript, hasBrollTrack, resolvedBrollPosition, brollVariantCount])

  // Context menu
  const ctxTrack = state.contextMenu ? state.tracks.find(t => t.id === state.contextMenu.trackId) : null

  // Unified track drag reorder — any track can be moved to any position
  const [dragState, setDragState] = useState({ dragging: false, fromAbsIdx: -2, overAbsIdx: -2, dy: 0 })
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
      setDragState({ dragging: false, fromAbsIdx: -2, overAbsIdx: -2, dy: 0 })
      if (dragDidMove.current && absIdx !== dropAbsIdx) {
        if (absIdx === -1) {
          // Dragging B-Roll track: find the real track index at the drop position
          const dropItem = layout.find(l => l.absIdx === dropAbsIdx)
          const targetIdx = dropItem && !dropItem.isBroll ? dropAbsIdx : resolvedBrollPosition
          dispatch({ type: 'MOVE_BROLL_TRACK', payload: targetIdx })
        } else if (dropAbsIdx === -1) {
          // Dropping a regular track at the B-Roll row position — reorder to B-Roll's slot
          dispatch({ type: 'REORDER_TRACK', payload: { fromIndex: absIdx, toIndex: resolvedBrollPosition } })
        } else {
          dispatch({ type: 'REORDER_TRACK', payload: { fromIndex: absIdx, toIndex: dropAbsIdx } })
        }
      } else if (!dragDidMove.current && absIdx >= 0) {
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
                  <div className="sticky left-0 w-36 shrink-0 border-b border-r border-white/10 flex items-center pl-2 pr-2 text-[10px] font-bold gap-1 z-30 bg-surface-container text-on-surface-variant" style={{ height: '80px' }}>
                    <span className="material-symbols-outlined text-[12px] shrink-0 opacity-30">drag_indicator</span>
                    <div className="grid grid-cols-2 gap-px flex-1 min-w-0">
                      {currentCameras.map(cam => {
                        const isActive = cam.videoId === activeVideoId
                        const t = state.tracks.find(t => t.type === 'video' && t.videoId === cam.videoId)
                        const trackCoversNow = t && state.currentTime >= t.offset && state.currentTime < t.offset + t.duration
                        return (
                          <button key={cam.videoId}
                            disabled={!trackCoversNow}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_SEGMENT_VIDEO_OVERRIDE', payload: { segIndex: currentSegmentIndex, videoId: cam.videoId } }) }}
                            className={`text-[8px] font-bold rounded px-1 py-0.5 transition-colors ${!trackCoversNow ? 'cursor-not-allowed' : ''}`}
                            style={isActive
                              ? { color: '#cefc00', backgroundColor: 'rgba(206,252,0,0.15)' }
                              : trackCoversNow
                                ? { color: '#fff', opacity: 0.7 }
                                : { opacity: 0.2 }}
                          >
                            V{cam.number}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="flex-1 relative z-0">
                    <CompositeFrameTrack segments={effectiveVideoSegments} zoom={state.zoom} cuts={mergedDisplayCuts} scrollRef={scrollRef} scrollX={scrollX} />
                  </div>
                </div>
              </div>
              <div className="relative">
                <div className="flex">
                  <div className="sticky left-0 w-36 shrink-0 border-b border-r border-white/5 flex items-center pl-2 pr-2 text-[10px] font-bold gap-1 z-30 bg-surface-container text-on-surface-variant" style={{ height: state.compositeShowTranscript ? '112px' : '56px' }}>
                    <span className="material-symbols-outlined text-[12px] shrink-0 opacity-30">drag_indicator</span>
                    <div className="grid grid-cols-2 gap-px flex-1 min-w-0">
                      {currentCameras.map(cam => {
                        const isActive = cam.videoId === activeAudioId
                        const t = state.tracks.find(t => t.type === 'video' && t.videoId === cam.videoId)
                        const trackCoversNow = t && state.currentTime >= t.offset && state.currentTime < t.offset + t.duration
                        return (
                          <button key={cam.videoId}
                            disabled={!trackCoversNow}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_SEGMENT_AUDIO_OVERRIDE', payload: { segIndex: currentSegmentIndex, videoId: cam.videoId } }) }}
                            className={`text-[8px] font-bold rounded px-1 py-0.5 transition-colors ${!trackCoversNow ? 'cursor-not-allowed' : ''}`}
                            style={isActive
                              ? { color: '#cefc00', backgroundColor: 'rgba(206,252,0,0.15)' }
                              : trackCoversNow
                                ? { color: '#fff', opacity: 0.7 }
                                : { opacity: 0.2 }}
                          >
                            A{cam.number}
                          </button>
                        )
                      })}
                    </div>
                    <div className="h-3 w-[1px] shrink-0 bg-white/30" />
                    <button
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => dispatch({ type: 'TOGGLE_COMPOSITE_TRANSCRIPT' })}
                      className="material-symbols-outlined text-[9px] shrink-0"
                      style={state.compositeShowTranscript ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                    >
                      text_fields
                    </button>
                  </div>
                  <div className="flex-1 relative z-0">
                    <CompositeAudioTrack segments={effectiveAudioSegments} zoom={state.zoom} cuts={mergedDisplayCuts} scrollRef={scrollRef} scrollX={scrollX} showTranscript={state.compositeShowTranscript} />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Track rows — unified list including B-Roll, any track can be dragged to any position */}
          {visibleLayout.map((item) => {
            const absIdx = item.absIdx
            const isDragSource = dragState.dragging && dragState.fromAbsIdx === absIdx
            const showInsertBefore = dragState.dragging && dragState.overAbsIdx === absIdx && dragState.fromAbsIdx > absIdx
            const showInsertAfter = dragState.dragging && dragState.overAbsIdx === absIdx && dragState.fromAbsIdx < absIdx

            // B-Roll track row (one per variant)
            if (item.isBroll) {
              const vi = item.variantIdx ?? 0
              const isActiveVariant = vi === (activeVariantIdx ?? 0)
              const variantLabel = variants?.[vi]?.label || 'B-Roll'
              return (
                <div key={`broll-track-${vi}`} className="relative" style={isDragSource ? { opacity: 0.5, zIndex: 30, transform: `translateY(${dragState.dy}px)`, pointerEvents: 'none' } : undefined}>
                  {showInsertBefore && vi === 0 && <div className="absolute top-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />}
                  <div className="flex">
                    <div
                      onMouseDown={isActiveVariant ? (e) => handleTrackDragStart(e, -1) : undefined}
                      className={`sticky left-0 w-36 shrink-0 border-b border-r border-white/5 flex items-center pl-2 text-[10px] font-bold z-30 bg-surface-container select-none ${
                        isActiveVariant ? 'text-primary-fixed cursor-grab active:cursor-grabbing' : 'text-zinc-500'
                      } ${isDragSource && isActiveVariant ? 'ring-1 ring-primary-fixed bg-primary-fixed/10' : ''}`}
                      style={{ height: `${BROLL_TRACK_H}px` }}
                    >
                      <span className={`material-symbols-outlined text-[12px] shrink-0 mr-1 ${isDragSource ? 'text-primary-fixed opacity-100' : 'opacity-30'}`}>drag_indicator</span>
                      <span className="truncate">{variantLabel}</span>
                      {variants?.length > 1 && (
                        <>
                          <div className="h-3 w-[1px] shrink-0 bg-white/10 mx-1" />
                          <button
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); onVariantActivate?.(vi) }}
                            className="material-symbols-outlined text-[9px] shrink-0"
                            style={isActiveVariant ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                          >
                            {isActiveVariant ? 'visibility' : 'visibility_off'}
                          </button>
                        </>
                      )}
                    </div>
                    <div className={`flex-1 relative z-0 ${!isActiveVariant ? 'opacity-40' : ''}`}>
                      <BRollTrack
                        zoom={state.zoom}
                        scrollRef={scrollRef}
                        scrollX={scrollX}
                        isActive={isActiveVariant}
                        onActivate={(selectIndex) => onVariantActivate?.(vi, selectIndex)}
                        overridePlacements={!isActiveVariant ? inactiveVariantPlacements?.[variants?.[vi]?.id] : undefined}
                      />
                    </div>
                  </div>
                  {showInsertAfter && vi === brollVariantCount - 1 && <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />}
                </div>
              )
            }

            // Regular audio/video track row
            const track = state.tracks[absIdx]
            if (!track) return null
            const selected = state.selectedTrackIds.has(track.id)
            const num = trackNumber(track)
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
                    className={`sticky left-0 w-36 shrink-0 ${isVideo ? 'h-6 border-b border-r border-white/10' : 'border-b border-r border-white/5'} flex items-center pl-2 pr-3 text-[10px] font-bold gap-1.5 cursor-grab active:cursor-grabbing select-none z-30 bg-surface-container ${
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
                      ? (showVideoFrames
                          ? <VideoFrameTrack track={track} zoom={state.zoom} cuts={isRoughCut ? mergedDisplayCuts : []} scrollRef={scrollRef} scrollX={scrollX} />
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

          {/* Unified playhead — spans ruler + all tracks.
              Transform is owned exclusively by the rAF playback engine (EditorView tick + seek)
              and by the zoom useLayoutEffect below. Do NOT bind transform from React render state
              or the 60fps engine and 10Hz React will fight and the marker will jump. */}
          <div
            ref={playheadRef}
            className="absolute top-0 h-full w-[2px] bg-primary-fixed pointer-events-none z-20"
            style={{ left: '9rem' }}
          >
            <div className="sticky top-1 w-3.5 h-3.5 bg-primary-fixed rotate-45 rounded-sm" style={{ marginLeft: '-6px' }} />
          </div>
        </div>
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

