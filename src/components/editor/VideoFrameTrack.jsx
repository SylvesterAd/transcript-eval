import { useRef, useEffect, useState, useMemo, useContext, useCallback } from 'react'
import { EditorContext } from './EditorView.jsx'
import { GROUP_COLORS } from './useEditorState.js'

// Display dimensions
const FRAME_H = 80
const FRAME_W = 142
const FRAME_INTERVAL = 1 // server extracts 1 frame per second

/**
 * Build the server URL for a pre-extracted frame.
 * Frames live at /uploads/frames/{videoId}/{second}.jpg
 */
function frameUrl(videoId, time) {
  return `/uploads/frames/${videoId}/${Math.round(time)}.jpg`
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
      slots.push({ time: t, x: t * zoom, src: frameUrl(track.videoId, nearest) })
    }
    return slots
  }, [track.filePath, track.videoId, scrollX, left, buffer, zoom, labelW, viewW, displayInterval, track.duration])

  // Cut edge drag handler
  const handleEdgeDrag = useCallback((cutId, edge, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const cut = state.cuts.find(c => c.id === cutId)
    if (!cut) return
    const startVal = edge === 'left' ? cut.start : cut.end

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      const dt = dx / zoom
      const newVal = Math.max(0, startVal + dt)
      dispatch({
        type: 'UPDATE_CUT',
        payload: {
          id: cutId,
          updates: edge === 'left' ? { start: newVal } : { end: newVal },
        }
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [state.cuts, zoom, dispatch])

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

        {/* Cut overlays with draggable edges */}
        {cuts.map(cut => {
          const cutLocalStart = Math.max(0, cut.start - track.offset)
          const cutLocalEnd = Math.min(track.duration, cut.end - track.offset)
          const cutLeft = cutLocalStart * zoom
          const cutWidth = (cutLocalEnd - cutLocalStart) * zoom
          if (cutWidth <= 0) return null

          return (
            <div
              key={cut.id}
              className="absolute inset-y-0 bg-black/60 z-10 group/cut"
              style={{ left: `${cutLeft}px`, width: `${cutWidth}px` }}
            >
              <span className="material-symbols-outlined absolute top-1 left-1 text-white/40" style={{ fontSize: '12px' }}>content_cut</span>
              {/* Left edge handle */}
              <div
                className="absolute left-0 top-0 w-1 h-full cursor-col-resize hover:bg-primary-fixed/50 transition-colors z-20"
                onMouseDown={(e) => handleEdgeDrag(cut.id, 'left', e)}
              />
              {/* Right edge handle */}
              <div
                className="absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-primary-fixed/50 transition-colors z-20"
                onMouseDown={(e) => handleEdgeDrag(cut.id, 'right', e)}
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
  const handleEdgeDrag = useCallback((cutId, edge, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const cut = state.cuts.find(c => c.id === cutId)
    if (!cut) return
    const startVal = edge === 'left' ? cut.start : cut.end
    const onMove = (ev) => {
      const dx = ev.clientX - startX
      const newVal = Math.max(0, startVal + dx / zoom)
      dispatch({ type: 'UPDATE_CUT', payload: { id: cutId, updates: edge === 'left' ? { start: newVal } : { end: newVal } } })
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [state.cuts, zoom, dispatch])

  return (
    <div className="relative border-b border-white/10" style={{ height: `${FRAME_H}px` }}>
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
          slots.push({ t, x: t * zoom, src: frameUrl(seg.videoId, nearest) })
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

            {/* Source label at top-right */}
            <div className="absolute top-1 right-1 bg-black/60 px-1.5 py-0.5 rounded text-[8px] font-bold z-10" style={{ color }}>
              {seg.title || `V${si + 1}`}
            </div>
          </div>
        )
      })}

      {/* Cut overlays — span across all segments */}
      {cuts.map(cut => {
        const totalStart = segments[0]?.start || 0
        const totalEnd = segments[segments.length - 1]?.end || 0
        const cStart = Math.max(totalStart, cut.start)
        const cEnd = Math.min(totalEnd, cut.end)
        if (cEnd <= cStart) return null
        return (
          <div
            key={cut.id}
            className="absolute inset-y-0 bg-black/60 z-20"
            style={{ left: `${cStart * zoom}px`, width: `${(cEnd - cStart) * zoom}px` }}
          >
            <span className="material-symbols-outlined absolute top-1 left-1 text-white/40" style={{ fontSize: '12px' }}>content_cut</span>
            <div className="absolute left-0 top-0 w-1 h-full cursor-col-resize hover:bg-primary-fixed/50 transition-colors z-20" onMouseDown={(e) => handleEdgeDrag(cut.id, 'left', e)} />
            <div className="absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-primary-fixed/50 transition-colors z-20" onMouseDown={(e) => handleEdgeDrag(cut.id, 'right', e)} />
          </div>
        )
      })}
    </div>
  )
}
