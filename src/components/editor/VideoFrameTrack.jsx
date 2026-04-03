import { useRef, useEffect, useState, useMemo, useContext, useCallback } from 'react'
import { EditorContext } from './EditorView.jsx'
import { GROUP_COLORS } from './useEditorState.js'

// Display dimensions
const FRAME_H = 80
const FRAME_W = 142
const FRAME_INTERVAL = 1 // server extracts 1 frame per second

/**
 * Build the URL for a frame thumbnail.
 * Prefers Cloudflare Stream thumbnails (auto-generated, no extraction needed).
 * Falls back to pre-extracted frames in Supabase Storage or local.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
function frameUrl(videoId, time, cfStreamUid) {
  if (cfStreamUid) {
    return `https://videodelivery.net/${cfStreamUid}/thumbnails/thumbnail.jpg?time=${Math.round(time)}s&width=160&height=90`
  }
  const path = `${videoId}/${Math.round(time)}.jpg`
  if (SUPABASE_URL) return `${SUPABASE_URL}/storage/v1/object/public/frames/${path}`
  return `/uploads/frames/${path}`
}

export default function VideoFrameTrack({ track, zoom, cuts, scrollRef, scrollX }) {
  const { state, dispatch } = useContext(EditorContext)
  const group = track.groupId ? state.groups[track.groupId] : null
  const color = group?.color || '#acaaad'

  const left = track.offset * zoom
  const width = Math.max(track.duration * zoom, 4)

  // Visible display slots (zoom-dependent, viewport-clipped)
  const displayInterval = Math.max(0.1, FRAME_W / zoom)
  const viewW = scrollRef?.current?.clientWidth || 1200
  const labelW = 144
  const buffer = FRAME_W * 2

  const visibleSlots = useMemo(() => {
    if (!track.filePath) return []
    const vStart = Math.max(0, ((scrollX || 0) - labelW - left - buffer) / zoom)
    const vEnd = ((scrollX || 0) - labelW - left + viewW + buffer) / zoom
    const slots = []
    const start = Math.max(0, Math.floor(vStart / displayInterval) * displayInterval)
    for (let t = start; t < Math.min(track.duration, vEnd); t += displayInterval) {
      const nearest = Math.round(t / FRAME_INTERVAL) * FRAME_INTERVAL
      slots.push({ time: t, x: t * zoom, src: frameUrl(track.videoId, nearest, track.cfStreamUid) })
    }
    return slots
  }, [track.filePath, track.videoId, scrollX, left, buffer, zoom, labelW, viewW, displayInterval, track.duration])

  // Cut edge drag handler — blocks AI regeneration during drag, sets exclusion on release
  const { cutDragRef } = useContext(EditorContext)
  const handleEdgeDrag = useCallback((mergedStart, mergedEnd, edge, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const overlapping = state.cuts
      .filter(c => c.start < mergedEnd + 0.05 && c.end > mergedStart - 0.05)
    if (!overlapping.length) return
    const primaryCut = edge === 'left'
      ? overlapping.reduce((a, b) => a.start <= b.start ? a : b)
      : overlapping.reduce((a, b) => a.end >= b.end ? a : b)
    const startVal = edge === 'left' ? primaryCut.start : primaryCut.end
    const splitPoint = primaryCut.splitPoint
    const allOverlappingIds = overlapping.map(c => c.id)
    cutDragRef.current = true
    const onMove = (ev) => {
      const dx = ev.clientX - startX
      let newVal = Math.max(0, startVal + dx / zoom)
      if (splitPoint != null) {
        if (edge === 'left') newVal = Math.min(newVal, splitPoint)
        else newVal = Math.max(newVal, splitPoint)
      }
      dispatch({ type: 'UPDATE_CUT', payload: { id: primaryCut.id, updates: edge === 'left' ? { start: newVal } : { end: newVal } } })
      for (const cId of allOverlappingIds) {
        if (cId === primaryCut.id) continue
        const c = state.cuts.find(x => x.id === cId)
        if (!c) continue
        if (edge === 'right' && c.end > newVal) {
          dispatch({ type: 'UPDATE_CUT', payload: { id: cId, updates: c.start < newVal ? { end: newVal } : { start: newVal, end: newVal } } })
        } else if (edge === 'left' && c.start < newVal) {
          dispatch({ type: 'UPDATE_CUT', payload: { id: cId, updates: c.end > newVal ? { start: newVal } : { start: newVal, end: newVal } } })
        }
      }
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      cutDragRef.current = false
      const finalDx = ev.clientX - startX
      const finalVal = Math.max(0, startVal + finalDx / zoom)
      if (edge === 'left' && finalVal > startVal + 0.05) {
        dispatch({ type: 'ADD_EXCLUSION', payload: { start: Math.max(0, startVal - 2), end: finalVal } })
      } else if (edge === 'right' && finalVal < startVal - 0.05) {
        dispatch({ type: 'ADD_EXCLUSION', payload: { start: finalVal, end: startVal + 2 } })
      } else if (edge === 'left' && finalVal < startVal - 0.05) {
        dispatch({ type: 'REMOVE_EXCLUSIONS_IN_RANGE', payload: { start: finalVal, end: startVal } })
        dispatch({ type: 'ADD_CUT', payload: { id: `cut-manual-${Date.now()}`, start: finalVal, end: startVal, source: 'manual' } })
      } else if (edge === 'right' && finalVal > startVal + 0.05) {
        dispatch({ type: 'REMOVE_EXCLUSIONS_IN_RANGE', payload: { start: startVal, end: finalVal } })
        dispatch({ type: 'ADD_CUT', payload: { id: `cut-manual-${Date.now()}`, start: startVal, end: finalVal, source: 'manual' } })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [state.cuts, state.cutExclusions, zoom, dispatch, cutDragRef])

  return (
    <div className="relative border-b border-white/10" style={{ height: `${FRAME_H}px` }}>
      <div
        className="absolute top-0 h-full overflow-hidden"
        style={{ left: `${left}px`, width: `${width}px` }}
      >
        {/* Background accent */}
        <div className="absolute inset-0" style={{ backgroundColor: `${color}15`, borderLeft: `2px solid ${color}` }} />

        {/* Frame thumbnails — server-extracted, loaded on demand */}
        {visibleSlots.map(slot => (
          <div
            key={slot.time}
            className="absolute top-0"
            style={{ left: `${slot.x}px`, width: `${FRAME_W}px`, height: `${FRAME_H}px` }}
          >
            <img
              src={slot.src}
              className="w-full h-full object-cover opacity-70"
              alt=""
              draggable={false}
              loading="lazy"
              onError={(e) => { e.target.style.display = 'none' }}
            />
          </div>
        ))}

        {/* Cut overlays with draggable edges — rounded clip edges like FCP */}
        {cuts.map(cut => {
          const cutLocalStart = Math.max(0, cut.start - track.offset)
          const cutLocalEnd = Math.min(track.duration, cut.end - track.offset)
          const cutLeft = cutLocalStart * zoom
          const rawWidth = (cutLocalEnd - cutLocalStart) * zoom
          if (cutLocalEnd < cutLocalStart) return null

          const MIN_GAP = 4
          const gapWidth = Math.max(MIN_GAP, rawWidth)
          const gapOffset = rawWidth < MIN_GAP ? (MIN_GAP - rawWidth) / 2 : 0
          const R = 6 // corner radius

          return (
            <div
              key={cut.id}
              className="absolute inset-y-0 z-10 group/cut"
              style={{ left: `${cutLeft - gapOffset - R}px`, width: `${gapWidth + R * 2}px` }}
            >
              {/* Left rounded corner mask — rounds the right edge of the left clip */}
              <div className="absolute left-0 top-0 h-full bg-black/70 rounded-r-md" style={{ width: `${R}px` }} />
              {/* Dark gap center */}
              <div className="absolute top-0 h-full bg-black/70" style={{ left: `${R}px`, width: `${gapWidth}px` }} />
              {/* Right rounded corner mask — rounds the left edge of the right clip */}
              <div className="absolute right-0 top-0 h-full bg-black/70 rounded-l-md" style={{ width: `${R}px` }} />
              {gapWidth > 40 && (
                <span className="material-symbols-outlined absolute top-1 text-white/40 z-10" style={{ fontSize: '12px', left: `${R + 4}px` }}>content_cut</span>
              )}
              {/* Left edge drag handle */}
              <div
                className="absolute left-0 top-0 h-full cursor-col-resize hover:bg-primary-fixed/20 transition-colors z-20"
                style={{ width: `${R + 4}px` }}
                onMouseDown={(e) => handleEdgeDrag(cut.start, cut.end, 'left', e)}
              />
              {/* Right edge drag handle */}
              <div
                className="absolute right-0 top-0 h-full cursor-col-resize hover:bg-primary-fixed/20 transition-colors z-20"
                style={{ width: `${R + 4}px` }}
                onMouseDown={(e) => handleEdgeDrag(cut.start, cut.end, 'right', e)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Composite frame track — single row showing segments from multiple video sources.
 * Each segment shows frames from a different camera. Cut markers appear at transitions.
 * segments: [{start, end, videoId, offset, duration, filePath, groupId}]
 */
export function CompositeFrameTrack({ segments, zoom, cuts, scrollRef, scrollX }) {
  const { state, dispatch } = useContext(EditorContext)

  // Viewport clipping
  const displayInterval = Math.max(0.1, FRAME_W / zoom)
  const viewW = scrollRef?.current?.clientWidth || 1200
  const labelW = 144
  const buffer = FRAME_W * 2
  const vStartTime = Math.max(0, ((scrollX || 0) - labelW - buffer) / zoom)
  const vEndTime = ((scrollX || 0) - labelW + viewW + buffer) / zoom

  // Cut edge drag
  const handleEdgeDrag = useCallback((mergedStart, mergedEnd, edge, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const overlapping = state.cuts
      .filter(c => c.start < mergedEnd + 0.05 && c.end > mergedStart - 0.05)
    if (!overlapping.length) return
    // Pick the cut that actually defines the boundary being dragged
    const cut = edge === 'left'
      ? overlapping.reduce((a, b) => a.start <= b.start ? a : b)
      : overlapping.reduce((a, b) => a.end >= b.end ? a : b)
    const startVal = edge === 'left' ? cut.start : cut.end
    const onMove = (ev) => {
      const dx = ev.clientX - startX
      const newVal = Math.max(0, startVal + dx / zoom)
      dispatch({ type: 'UPDATE_CUT', payload: { id: cut.id, updates: edge === 'left' ? { start: newVal } : { end: newVal } } })
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const finalDx = ev.clientX - startX
      const finalVal = Math.max(0, startVal + finalDx / zoom)
      if (edge === 'left' && finalVal > startVal + 0.05) {
        dispatch({ type: 'SET_EXCLUSIONS', payload: [...(state.cutExclusions || []), { start: Math.max(0, startVal - 2), end: finalVal }] })
      } else if (edge === 'right' && finalVal < startVal - 0.05) {
        dispatch({ type: 'SET_EXCLUSIONS', payload: [...(state.cutExclusions || []), { start: finalVal, end: startVal + 2 }] })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [state.cuts, state.cutExclusions, zoom, dispatch])

  const totalEnd = segments[segments.length - 1]?.end || 0
  const contentWidth = totalEnd * zoom

  return (
    <div className="relative border-b border-white/10 overflow-hidden" style={{ height: `${FRAME_H}px` }}>
      {/* Segments */}
      {segments.map((seg, si) => {
        const group = seg.groupId ? state.groups[seg.groupId] : null
        const color = group?.color || GROUP_COLORS[si % GROUP_COLORS.length]
        const segLeft = seg.start * zoom
        const segWidth = (seg.end - seg.start) * zoom

        // Frame slots within this segment
        const localStart = Math.max(0, vStartTime - seg.start)
        const localEnd = Math.min(seg.end - seg.start, vEndTime - seg.start)
        const slotStart = Math.max(0, Math.floor(localStart / displayInterval) * displayInterval)
        const slots = []
        for (let t = slotStart; t < localEnd; t += displayInterval) {
          // Local time in the source video file
          const videoLocalTime = (seg.start + t) - seg.offset
          const nearest = Math.round(videoLocalTime / FRAME_INTERVAL) * FRAME_INTERVAL
          slots.push({ t, x: t * zoom, src: frameUrl(seg.videoId, nearest, seg.cfStreamUid) })
        }

        return (
          <div
            key={`${seg.videoId}-${seg.start}`}
            className="absolute top-0 h-full overflow-hidden"
            style={{ left: `${segLeft}px`, width: `${segWidth}px` }}
          >
            {/* Background */}
            <div className="absolute inset-0" style={{ backgroundColor: `${color}15`, borderLeft: `2px solid ${color}` }} />

            {/* Frames */}
            {slots.map(slot => (
              <div key={slot.t} className="absolute top-0" style={{ left: `${slot.x}px`, width: `${FRAME_W}px`, height: `${FRAME_H}px` }}>
                <img
                  src={slot.src}
                  className="w-full h-full object-cover opacity-70"
                  alt=""
                  draggable={false}
                  loading="lazy"
                  onError={(e) => { e.target.style.display = 'none' }}
                />
              </div>
            ))}

            {/* Segment transition marker (skip first) */}
            {si > 0 && (
              <div className="absolute left-0 top-0 w-[2px] h-full bg-white/40 z-10" />
            )}

            {/* Source label at top-left */}
            <div className="absolute top-1 left-1 bg-black/60 px-1.5 py-0.5 rounded text-[8px] font-bold z-10" style={{ color }}>
              {seg.title || `V${si + 1}`}
            </div>
          </div>
        )
      })}

      {/* Cut overlays — rounded clip edges */}
      {cuts.map(cut => {
        const totalStart = segments[0]?.start || 0
        const totalEnd = segments[segments.length - 1]?.end || 0
        const cStart = Math.max(totalStart, cut.start)
        const cEnd = Math.min(totalEnd, cut.end)
        if (cEnd < cStart) return null
        const rawWidth = (cEnd - cStart) * zoom
        const MIN_GAP = 4
        const gapWidth = Math.max(MIN_GAP, rawWidth)
        const gapOffset = rawWidth < MIN_GAP ? (MIN_GAP - rawWidth) / 2 : 0
        const R = 6

        return (
          <div
            key={cut.id}
            className="absolute inset-y-0 z-20"
            style={{ left: `${cStart * zoom - gapOffset - R}px`, width: `${gapWidth + R * 2}px` }}
          >
            <div className="absolute left-0 top-0 h-full bg-black/70 rounded-r-md" style={{ width: `${R}px` }} />
            <div className="absolute top-0 h-full bg-black/70" style={{ left: `${R}px`, width: `${gapWidth}px` }} />
            <div className="absolute right-0 top-0 h-full bg-black/70 rounded-l-md" style={{ width: `${R}px` }} />
            {gapWidth > 40 && (
              <span className="material-symbols-outlined absolute top-1 text-white/40 z-10" style={{ fontSize: '12px', left: `${R + 4}px` }}>content_cut</span>
            )}
            <div className="absolute left-0 top-0 h-full cursor-col-resize hover:bg-primary-fixed/20 transition-colors z-20" style={{ width: `${R + 4}px` }} onMouseDown={(e) => handleEdgeDrag(cut.start, cut.end, 'left', e)} />
            <div className="absolute right-0 top-0 h-full cursor-col-resize hover:bg-primary-fixed/20 transition-colors z-20" style={{ width: `${R + 4}px` }} onMouseDown={(e) => handleEdgeDrag(cut.start, cut.end, 'right', e)} />
          </div>
        )
      })}
    </div>
  )
}
