import { useMemo, useContext } from 'react'
import { BRollContext } from './useBRollEditorState.js'
import { Loader2 } from 'lucide-react'

const TRACK_H = 60

export default function BRollTrack({ zoom, scrollRef, scrollX }) {
  const broll = useContext(BRollContext)
  if (!broll) return null

  const { placements, selectedIndex, selectedResults, selectPlacement } = broll

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
            className={`absolute top-0 rounded overflow-hidden cursor-pointer transition-all ${
              isSelected
                ? 'ring-2 ring-teal-400 z-10'
                : 'ring-1 ring-white/10 hover:ring-white/30'
            }`}
            style={{ left, width, height: TRACK_H }}
            onClick={() => selectPlacement(p.index)}
          >
            {hasResult ? (
              <>
                <img
                  src={result.preview_url || result.url}
                  alt=""
                  className="w-full h-full object-cover"
                  loading="lazy"
                  draggable={false}
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5">
                  <span className="text-[9px] text-white/80 truncate block">{result.title || result.source}</span>
                </div>
              </>
            ) : isSearching ? (
              <div className="w-full h-full bg-teal-900/30 flex items-center justify-center gap-1">
                <Loader2 size={12} className="text-teal-400 animate-spin" />
                {width > 60 && <span className="text-[9px] text-teal-400">Searching</span>}
              </div>
            ) : isPending ? (
              <div className="w-full h-full bg-zinc-800/50 animate-pulse flex items-center justify-center">
                {width > 50 && <span className="text-[9px] text-zinc-500">Pending</span>}
              </div>
            ) : (
              <div className="w-full h-full bg-zinc-800/30 flex items-center justify-center">
                {width > 50 && <span className="text-[9px] text-zinc-600">No results</span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export { TRACK_H as BROLL_TRACK_H }
