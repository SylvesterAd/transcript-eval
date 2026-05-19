import { useEffect, useRef, useState } from 'react'

const MIN_PANEL_WIDTH = 480
const MAX_OVERFLOW_WIDTH_PCT = 20

export default function BRollSlipPanel({
  placement,
  onSlipChange,
  onClampToggle,
  onPreviewSeek,
  onReset,
  onClose,
}) {
  const sourceDur = placement.sourceDurationSeconds || 0
  const sourceIn = Math.max(0, placement.source_in_seconds ?? 0) // defensive parity with XMEML generator
  const effectiveDuration = placement.keep_original_duration
    ? (placement.original_timeline_duration ?? placement.timelineDuration)
    : Math.min(placement.timelineDuration, Math.max(0, sourceDur - sourceIn))

  const stripRef = useRef(null)
  const dragStateRef = useRef(null)
  const seekStateRef = useRef({ pending: null, rafId: 0 })
  const [, force] = useState(0) // force re-render during drag

  // Stable handler refs so addEventListener/removeEventListener use the same reference
  const onDocMouseMoveRef = useRef(null)
  const onDocMouseUpRef = useRef(null)

  // Latest-callback refs so mount-only effect always calls current prop
  const onSlipChangeRef = useRef(onSlipChange)
  const onPreviewSeekRef = useRef(onPreviewSeek)
  useEffect(() => { onSlipChangeRef.current = onSlipChange })
  useEffect(() => { onPreviewSeekRef.current = onPreviewSeek })

  const scheduleSeek = (absSec) => {
    seekStateRef.current.pending = absSec
    if (!seekStateRef.current.rafId) {
      seekStateRef.current.rafId = requestAnimationFrame(() => {
        seekStateRef.current.rafId = 0
        const s = seekStateRef.current.pending
        seekStateRef.current.pending = null
        onPreviewSeekRef.current?.(s)
      })
    }
  }

  // Build stable handlers on mount; capture mutable values via refs
  useEffect(() => {
    onDocMouseMoveRef.current = (e) => {
      const ds = dragStateRef.current
      if (!ds) return
      const deltaPx = e.clientX - ds.startClientX
      const deltaSec = deltaPx / ds.pxPerSecond
      const proposed = ds.startSourceIn + deltaSec
      const snapped = Math.round(proposed * ds.fps) / ds.fps
      const clamped = Math.max(0, Math.min(ds.maxSourceIn, snapped))
      ds.currentSourceIn = clamped
      scheduleSeek(clamped)
      force((v) => v + 1)
    }

    onDocMouseUpRef.current = () => {
      document.removeEventListener('mousemove', onDocMouseMoveRef.current)
      const ds = dragStateRef.current
      if (!ds) return
      if (ds.currentSourceIn !== ds.startSourceIn) {
        onSlipChangeRef.current?.(ds.currentSourceIn)
      }
      dragStateRef.current = null
    }

    return () => {
      document.removeEventListener('mousemove', onDocMouseMoveRef.current)
      document.removeEventListener('mouseup', onDocMouseUpRef.current)
      if (seekStateRef.current.rafId) cancelAnimationFrame(seekStateRef.current.rafId)
      dragStateRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onWindowMouseDown = (e) => {
    e.preventDefault()
    const rect = stripRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const pxPerSecond = rect.width / sourceDur
    const fps = placement.sourceFrameRate || 30
    const minVisibleSec = 1 / fps
    const maxSourceIn = placement.keep_original_duration
      ? Math.max(0, sourceDur - minVisibleSec)
      : Math.max(0, sourceDur - effectiveDuration)
    dragStateRef.current = {
      startClientX: e.clientX,
      startSourceIn: sourceIn,
      pxPerSecond,
      maxSourceIn,
      fps,
      currentSourceIn: sourceIn,
    }
    document.addEventListener('mousemove', onDocMouseMoveRef.current)
    document.addEventListener('mouseup', onDocMouseUpRef.current, { once: true })
  }

  const displaySourceIn = dragStateRef.current?.currentSourceIn ?? sourceIn
  const windowStart = displaySourceIn
  const windowEnd = displaySourceIn + effectiveDuration
  const windowStartPct = sourceDur > 0 ? (windowStart / sourceDur) * 100 : 0
  const windowEndPct = sourceDur > 0 ? (Math.min(windowEnd, sourceDur) / sourceDur) * 100 : 0
  const overflowsRight = windowEnd > sourceDur && sourceDur > 0
  const overflowWidthPct = overflowsRight
    ? Math.min(MAX_OVERFLOW_WIDTH_PCT, ((windowEnd - sourceDur) / sourceDur) * 100)
    : 0

  return (
    <div className="broll-slip-panel" style={{ minWidth: MIN_PANEL_WIDTH, padding: 8 }}>
      <div
        ref={stripRef}
        className="slip-source-strip"
        data-testid="slip-source-strip"
        data-source-duration={String(sourceDur)}
        style={{ position: 'relative', height: 48, background: 'rgba(34, 34, 34, 0.4)' }}
      >
        <div
          className="slip-green-window"
          data-testid="slip-green-window"
          data-window-start={String(windowStart)}
          data-window-end={String(windowEnd)}
          onMouseDown={onWindowMouseDown}
          style={{
            position: 'absolute',
            left: `${windowStartPct}%`,
            width: `${Math.max(0, windowEndPct - windowStartPct)}%`,
            top: 0,
            bottom: 0,
            background: 'rgba(0, 230, 100, 0.35)',
            outline: '1px solid rgba(0, 230, 100, 0.9)',
            cursor: 'grab',
          }}
        />
        {overflowsRight && (
          <div
            className="slip-overflow-stripe"
            data-testid="slip-overflow-stripe"
            style={{
              position: 'absolute',
              left: '100%',
              width: `${overflowWidthPct}%`,
              top: 0,
              bottom: 0,
              background:
                'repeating-linear-gradient(45deg, rgba(255,0,0,0.4) 0 6px, transparent 6px 12px)',
            }}
          />
        )}
      </div>
      <div
        className="slip-controls"
        style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}
      >
        <label>
          <input
            type="checkbox"
            checked={!!placement.keep_original_duration}
            onChange={(e) => onClampToggle(e.target.checked)}
          />
          {' '}Keep original duration
        </label>
        <button type="button" onClick={onReset}>
          Reset
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
