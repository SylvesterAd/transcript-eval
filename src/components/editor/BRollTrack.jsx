import { useMemo, useContext, useCallback, useState, memo } from 'react'
import { BRollContext } from './useBRollEditorState.js'
import { Loader2, Copy } from 'lucide-react'
import BRollContextMenu from './BRollContextMenu.jsx'
import { getClipboard } from './brollClipboard.js'

const TRACK_H = 60

export function resolveDisplayResultIdx(placement, isActive, selectedResults) {
  if (isActive) {
    const transient = selectedResults?.[placement.index]
    if (transient != null) return transient
  }
  return placement.persistedSelectedResult ?? 0
}

function BRollTrack({ zoom, viewW = 1200, scrollX, isActive = true, onActivate, overridePlacements, variants, activeVariantIdx, onCrossDrop }) {
  const broll = useContext(BRollContext)
  if (!broll && !overridePlacements) return null

  const placements = overridePlacements || broll?.placements || []
  const { selectedIndex, selectedResults, selectPlacement, updatePlacementPosition } = broll || {}

  const [menuState, setMenuState] = useState(null)

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
  }, [placements, scrollX, zoom, viewW])

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
        updatePlacementPosition(placement.index, newStart, origEnd, { kind: 'resize' })
      } else {
        const newEnd = Math.min(nextStart, Math.max(origStart + 0.5, origEnd + dt))
        updatePlacementPosition(placement.index, origStart, newEnd, { kind: 'resize' })
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

    if (!isActive) {
      // Pass stable identity so the new variant can resolve THIS placement post-switch.
      // Bare numeric `index` is per-variant — the same number means a different placement
      // (or no placement) in the activated variant. chapterIndex+placementIndex identify
      // chapter-derived placements; userPlacementId identifies pastes/cross-drag results.
      onActivate?.({
        chapterIndex: placement.chapterIndex ?? null,
        placementIndex: placement.placementIndex ?? null,
        userPlacementId: placement.userPlacementId ?? null,
      })
      return
    }

    const startX = e.clientX
    const startY = e.clientY
    const origStart = placement.timelineStart
    const origEnd = placement.timelineEnd
    const duration = origEnd - origStart
    const { prevEnd, nextStart } = getNeighborBounds(placement)
    let moved = false
    let crossMode = null
    let inVariantDispatched = false  // tracks whether we've moved the source placement in-variant during this drag

    // Variant row lookup for hit-testing. Query once per drag start.
    const variantRows = (variants || []).map((v, vi) => {
      const row = document.querySelector(`[data-broll-variant="${vi}"]`)
      return row ? { vi, rect: row.getBoundingClientRect(), variant: v } : null
    }).filter(Boolean)

    // Capture where within the placement the user grabbed, so cross-variant drop
    // can place the clip such that the grabbed point lands under the cursor.
    const labelW = 144
    const srcRow = variantRows.find(r => r.vi === (activeVariantIdx ?? 0))
    const srcTrackLeft = srcRow ? srcRow.rect.left + labelW : 0
    const placementLeftPx = srcTrackLeft + placement.timelineStart * zoom
    const grabOffsetSec = (startX - placementLeftPx) / zoom

    console.log('[broll-drag] start', {
      placementIndex: placement.index,
      activeVariantIdx,
      duration,
      grabOffsetSec: grabOffsetSec.toFixed(2),
      variantRows: variantRows.map(r => ({ vi: r.vi, top: r.rect.top, bottom: r.rect.bottom, variantId: r.variant.id })),
    })

    // Ghost element that follows the cursor
    const ghost = document.createElement('div')
    ghost.style.position = 'fixed'
    ghost.style.pointerEvents = 'none'
    ghost.style.zIndex = '999'
    ghost.style.opacity = '0.6'
    ghost.style.background = 'rgba(206,252,0,0.3)'
    ghost.style.border = '1px solid #cefc00'
    ghost.style.borderRadius = '4px'
    ghost.style.width = Math.max(60, duration * zoom) + 'px'
    ghost.style.height = '60px'
    document.body.appendChild(ghost)

    // Yellow insertion marker on the target row
    const marker = document.createElement('div')
    marker.style.position = 'fixed'
    marker.style.pointerEvents = 'none'
    marker.style.zIndex = '998'
    marker.style.height = '60px'
    marker.style.width = '2px'
    marker.style.background = '#cefc00'
    marker.style.boxShadow = '0 0 6px rgba(206,252,0,0.7)'
    marker.style.display = 'none'
    document.body.appendChild(marker)

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 3 && Math.abs(ev.clientY - startY) < 3) return
      moved = true

      ghost.style.left = (ev.clientX - 20) + 'px'
      ghost.style.top = (ev.clientY - 30) + 'px'

      // Detect the variant row under the cursor
      let overRow = null
      for (const row of variantRows) {
        if (ev.clientY >= row.rect.top && ev.clientY <= row.rect.bottom) { overRow = row; break }
      }

      if (!onMove._lastLog || Date.now() - onMove._lastLog > 200) {
        onMove._lastLog = Date.now()
        console.log('[broll-drag] move', {
          clientY: ev.clientY,
          overRowVi: overRow?.vi ?? null,
          activeVariantIdx,
          isCross: !!(overRow && overRow.vi !== (activeVariantIdx ?? 0)),
        })
      }

      if (overRow && overRow.vi !== (activeVariantIdx ?? 0)) {
        // Cross-mode active. If we previously moved the placement in-variant, revert
        // to its drag-start position so the source doesn't end up at a weird spot
        // (and so undo of the cross-drop returns the placement to where it started).
        if (inVariantDispatched) {
          updatePlacementPosition(placement.index, origStart, origEnd)
          inVariantDispatched = false
        }
        const trackLeft = overRow.rect.left + labelW
        const timeAtPointer = (ev.clientX - trackLeft) / zoom
        const dropStart = Math.max(0, timeAtPointer - grabOffsetSec)
        const dropLeftPx = trackLeft + dropStart * zoom
        crossMode = { variantIdx: overRow.vi, dropStart, variant: overRow.variant }
        marker.style.display = 'block'
        marker.style.left = dropLeftPx + 'px'
        marker.style.top = overRow.rect.top + 'px'
        // Snap ghost to the projected drop position so it visually matches the marker
        ghost.style.left = dropLeftPx + 'px'
        ghost.style.top = overRow.rect.top + 'px'
      } else {
        crossMode = null
        marker.style.display = 'none'
        // In-variant drag: recompute neighbors against the cursor position so the dragged
        // clip can tunnel past intermediate placements into a wider gap further along.
        // Static drag-start neighbors clamp the cursor inside the original gap forever.
        const dt = dx / zoom
        const cursorTime = origStart + dt
        const others = placements
          .filter(p => p.index !== placement.index)
          .filter(p => Number.isFinite(p.timelineStart) && Number.isFinite(p.timelineEnd))
          .sort((a, b) => a.timelineStart - b.timelineStart)
        let target = Math.max(0, cursorTime)
        const inside = others.find(o => target >= o.timelineStart && target < o.timelineEnd)
        if (inside) {
          // Pick whichever side of the placement is nearer so the user can pull either way.
          const distToStart = target - inside.timelineStart
          const distToEnd = inside.timelineEnd - target
          target = distToStart < distToEnd
            ? Math.max(0, inside.timelineStart - duration - 0.05)
            : inside.timelineEnd + 0.05
        }
        const next = others.find(o => o.timelineStart >= target)
        const prev = [...others].reverse().find(o => o.timelineEnd <= target)
        const dynPrevEnd = prev ? prev.timelineEnd : 0
        const dynNextStart = next ? next.timelineStart : Infinity
        const minStart = dynPrevEnd
        const maxStart = Number.isFinite(dynNextStart) ? dynNextStart - duration : Infinity
        if (maxStart - minStart < 0) {
          // No gap big enough at this cursor location; skip dispatch this frame.
          return
        }
        const newStart = Math.max(minStart, Math.min(target, maxStart))
        updatePlacementPosition(placement.index, newStart, newStart + duration)
        inVariantDispatched = true
      }
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost)
      if (marker.parentNode) marker.parentNode.removeChild(marker)

      console.log('[broll-drag] drop', {
        moved,
        crossMode,
        altKey: ev.altKey,
        finalMode: crossMode ? (ev.altKey ? 'copy' : 'move') : 'in-variant',
      })

      if (!moved) { selectPlacement(placement.index); return }

      if (crossMode) {
        const mode = ev.altKey ? 'copy' : 'move'
        onCrossDrop?.({
          sourceIndex: placement.index,
          targetPipelineId: crossMode.variant.id,
          targetStartSec: crossMode.dropStart,
          mode,
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [zoom, getNeighborBounds, updatePlacementPosition, selectPlacement, isActive, onActivate, variants, activeVariantIdx, onCrossDrop])

  const buildMenuItems = (menu) => {
    const p = menu.placement
    const hasClipboard = !!getClipboard()
    const hasEditOverride = p && broll?.edits?.[`${p.chapterIndex}:${p.placementIndex}`]
    const items = []
    if (p) {
      items.push({ label: 'Copy',   shortcut: '⌘C', onClick: () => broll.copyPlacement(p.index) })
      items.push({ label: 'Cut',    shortcut: '⌘X', onClick: () => broll.copyPlacement(p.index, { cut: true }) })
    }
    items.push({
      label: 'Paste', shortcut: '⌘V', disabled: !hasClipboard,
      onClick: () => {
        const targetStart = p ? p.timelineEnd + 0.05 : menu.emptyAreaTime
        broll.pastePlacement(targetStart)
      },
    })
    if (p) {
      items.push({ divider: true })
      items.push({ label: 'Delete', shortcut: 'Del', onClick: () => { broll.hidePlacement(p.index); broll.selectPlacement(null) } })
      if (hasEditOverride || p.isUserPlacement) {
        items.push({ divider: true })
        items.push({ label: 'Reset to original', onClick: () => broll.resetPlacement(p.index) })
      }
    }
    return items
  }

  return (
    <div
      className="relative"
      style={{ height: TRACK_H, width: totalWidth, minWidth: '100%' }}
      onContextMenu={(e) => {
        if (e.defaultPrevented) return
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        const labelW = 144
        const timeAtClick = ((e.clientX - rect.left) + (scrollX || 0) - labelW) / zoom
        setMenuState({ x: e.clientX, y: e.clientY, emptyAreaTime: Math.max(0, timeAtClick) })
      }}
    >
      {visible.map(p => {
        const left = p.timelineStart * zoom
        const width = Math.max(p.timelineDuration * zoom, 4)
        const isSelected = isActive && p.index === selectedIndex
        const resultIdx = resolveDisplayResultIdx(p, isActive, selectedResults)
        const result = p.results?.[resultIdx]
        const hasResult = p.searchStatus === 'complete' && result
        const isSearching = p.searchStatus === 'searching'
        const isKeywordsReady = p.searchStatus === 'keywords_ready'
        const isWaiting = p.searchStatus === 'waiting'
        const isPending = p.searchStatus === 'pending'
        const isFailed = p.searchStatus === 'failed'

        return (
          <div
            key={p.index}
            className={`absolute top-0 rounded overflow-hidden ${isActive ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} transition-shadow ${
              isSelected
                ? 'ring-2 ring-primary-fixed z-10'
                : 'ring-1 ring-white/10 hover:ring-white/30'
            }`}
            style={{ left, width, height: TRACK_H }}
            onMouseDown={(e) => handleBoxMove(p, e)}
            onContextMenu={(e) => {
              e.preventDefault(); e.stopPropagation()
              setMenuState({ x: e.clientX, y: e.clientY, placement: p })
            }}
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
              <div className="w-full h-full bg-primary-fixed/10 flex items-center justify-center gap-1 pointer-events-none">
                <Loader2 size={12} className="text-primary-fixed animate-spin" />
                {width > 60 && <span className="text-[9px] text-primary-fixed">Searching</span>}
              </div>
            ) : isKeywordsReady ? (
              <div className="w-full h-full bg-primary-fixed/5 flex items-center justify-center pointer-events-none">
                {width > 50 && <span className="text-[9px] text-primary-fixed/50">Keywords</span>}
              </div>
            ) : isWaiting ? (
              <div className="w-full h-full bg-primary-fixed/5 flex items-center justify-center pointer-events-none">
                {width > 50 && <span className="text-[9px] text-primary-fixed/40">Queued</span>}
              </div>
            ) : isPending ? (
              <div className="w-full h-full bg-zinc-800/50 animate-pulse flex items-center justify-center pointer-events-none">
                {width > 50 && <span className="text-[9px] text-zinc-500">Waiting</span>}
              </div>
            ) : isFailed ? (
              <div className="w-full h-full bg-red-900/20 flex items-center justify-center pointer-events-none">
                {width > 50 && <span className="text-[9px] text-red-400/60">Failed</span>}
              </div>
            ) : (
              <div className="w-full h-full bg-zinc-800/30 flex items-center justify-center pointer-events-none">
                {width > 50 && <span className="text-[9px] text-zinc-600">No results</span>}
              </div>
            )}

            {p.isUserPlacement && (
              <div className="absolute top-1 right-1 z-10 bg-black/50 rounded p-0.5 pointer-events-none" title="Copied clip">
                <Copy size={8} className="text-white/70" />
              </div>
            )}

            {/* Left resize handle (active track only) */}
            {isActive && <div
              className="absolute left-0 top-0 h-full w-2 cursor-col-resize hover:bg-primary-fixed/20 z-20 transition-colors"
              onMouseDown={(e) => handleEdgeDrag(p, 'left', e)}
            />}
            {/* Right resize handle (active track only) */}
            {isActive && <div
              className="absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-primary-fixed/20 z-20 transition-colors"
              onMouseDown={(e) => handleEdgeDrag(p, 'right', e)}
            />}
          </div>
        )
      })}
      {menuState && (
        <BRollContextMenu
          x={menuState.x}
          y={menuState.y}
          onClose={() => setMenuState(null)}
          items={buildMenuItems(menuState)}
        />
      )}
    </div>
  )
}

export default memo(BRollTrack)
export { TRACK_H as BROLL_TRACK_H }
