import { useMemo, useContext, useCallback } from 'react'
import { BRollContext } from './useBRollEditorState.js'
import { Loader2 } from 'lucide-react'

const TRACK_H = 60

export default function BRollTrack({ zoom, scrollRef, scrollX }) {
  const broll = useContext(BRollContext)
  if (!broll) return null

  const { placements, selectedIndex, selectedResults, selectPlacement, updatePlacementPosition } = broll

  const viewW = scrollRef?.current?.clientWidth || 1200
  const labelW = 144
  const buffer = 200

  // Only render placements visible in viewport
  const visible = useMemo(() => {
    if (!placements?.length) return []
    const vStartPx = (scrollX || 0) - labelW - buffer
    const vEndPx = (scrollX || 0) - labelW + viewW + buffer
    return placements.filter(p => {
      if (!p.timelineStart && p.timelineStart !== 0) return false
      const left = p.timelineStart * zoom
      const right = (p.timelineStart + p.timelineDuration) * zoom
      return right >= vStartPx && left <= vEndPx
    })
  }, [placements, scrollX, zoom, viewW, labelW, buffer])

  // Total timeline width
  const totalWidth = useMemo(() => {
    if (!placements?.length) return 0
    const last = placements[placements.length - 1]
    return last ? (last.timelineStart + last.timelineDuration) * zoom + 200 : 0
  }, [placements, zoom])

  // Compute neighbor boundaries for a placement (collision prevention)
  const getNeighborBounds = useCallback((placement) => {
    const sorted = [...placements].sort((a, b) => a.timelineStart - b.timelineStart)
    const si = sorted.findIndex(s => s.index === placement.index)
    const prevEnd = si > 0 ? sorted[si - 1].timelineEnd : 0
    const nextStart = si < sorted.length - 1 ? sorted[si + 1].timelineStart : Infinity
    return { prevEnd, nextStart }
  }, [placements])

  // Edge resize drag handler
  const handleEdgeDrag = useCallback((placement, edge, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const origStart = placement.timelineStart
    const origEnd = placement.timelineEnd
    const { prevEnd, nextStart } = getNeighborBounds(placement)

    const onMove = (ev) => {
      const dt = (ev.clientX - startX) / zoom
      if (edge === 'left') {
        const newStart = Math.max(prevEnd, Math.min(origStart + dt, origEnd - 0.5))
        updatePlacementPosition(placement.index, newStart, origEnd)
      } else {
        const newEnd = Math.min(nextStart, Math.max(origStart + 0.5, origEnd + dt))
        updatePlacementPosition(placement.index, origStart, newEnd)
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [zoom, getNeighborBounds, updatePlacementPosition])

  // Whole-box move drag handler
  const handleBoxMove = useCallback((placement, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const origStart = placement.timelineStart
    const origEnd = placement.timelineEnd
    const duration = origEnd - origStart
    const { prevEnd, nextStart } = getNeighborBounds(placement)
    let moved = false

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 3) return
      moved = true
      const dt = dx / zoom
      const newStart = Math.max(prevEnd, Math.min(origStart + dt, nextStart - duration))
      updatePlacementPosition(placement.index, newStart, newStart + duration)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (!moved) selectPlacement(placement.index)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [zoom, getNeighborBounds, updatePlacementPosition, selectPlacement])

  return (
    <div className="relative" style={{ height: TRACK_H, width: totalWidth, minWidth: '100%' }}>
      {visible.map(p => {
        const left = p.timelineStart * zoom
        const width = Math.max(p.timelineDuration * zoom, 4)
        const isSelected = p.index === selectedIndex
        const resultIdx = selectedResults[p.index] ?? 0
        const result = p.results?.[resultIdx]
        const hasResult = p.searchStatus === 'complete' && result
        const isSearching = p.searchStatus === 'searching'
        const isPending = p.searchStatus === 'pending'

        return (
          <div
            key={p.index}
            className={`absolute top-0 rounded overflow-hidden cursor-grab active:cursor-grabbing transition-shadow ${
              isSelected
                ? 'ring-2 ring-teal-400 z-10'
                : 'ring-1 ring-white/10 hover:ring-white/30'
            }`}
            style={{ left, width, height: TRACK_H }}
            onMouseDown={(e) => handleBoxMove(p, e)}
          >
            {hasResult ? (
              <>
                <img
                  src={result.thumbnail_url || result.preview_url || result.url}
                  alt=""
                  className="w-full h-full object-cover pointer-events-none"
                  loading="lazy"
                  draggable={false}
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5 pointer-events-none">
                  <span className="text-[9px] text-white/80 truncate block">{result.title || result.source}</span>
                </div>
              </>
            ) : isSearching ? (
              <div className="w-full h-full bg-teal-900/30 flex items-center justify-center gap-1 pointer-events-none">
                <Loader2 size={12} className="text-teal-400 animate-spin" />
                {width > 60 && <span className="text-[9px] text-teal-400">Searching</span>}
              </div>
            ) : isPending ? (
              <div className="w-full h-full bg-zinc-800/50 animate-pulse flex items-center justify-center pointer-events-none">
                {width > 50 && <span className="text-[9px] text-zinc-500">Pending</span>}
              </div>
            ) : (
              <div className="w-full h-full bg-zinc-800/30 flex items-center justify-center pointer-events-none">
                {width > 50 && <span className="text-[9px] text-zinc-600">No results</span>}
              </div>
            )}

            {/* Left resize handle */}
            <div
              className="absolute left-0 top-0 h-full w-2 cursor-col-resize hover:bg-teal-400/20 z-20 transition-colors"
              onMouseDown={(e) => handleEdgeDrag(p, 'left', e)}
            />
            {/* Right resize handle */}
            <div
              className="absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-teal-400/20 z-20 transition-colors"
              onMouseDown={(e) => handleEdgeDrag(p, 'right', e)}
            />
          </div>
        )
      })}
    </div>
  )
}

export { TRACK_H as BROLL_TRACK_H }
