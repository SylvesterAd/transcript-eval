import { useMemo } from 'react'

const MIN_PANEL_WIDTH = 480
const DIM_OPACITY = 0.4

export default function BRollSlipPanel({
  placement,
  onSlipChange,
  onClampToggle,
  onPreviewSeek,
  onReset,
  onClose,
}) {
  const sourceDur = placement.sourceDurationSeconds || 0
  const sourceIn = placement.source_in_seconds ?? 0
  const effectiveDuration = placement.keep_original_duration
    ? (placement.original_timeline_duration ?? placement.timelineDuration)
    : Math.min(placement.timelineDuration, Math.max(0, sourceDur - sourceIn))

  const windowStart = sourceIn
  const windowEnd = sourceIn + effectiveDuration
  const windowStartPct = sourceDur > 0 ? (windowStart / sourceDur) * 100 : 0
  const windowEndPct = sourceDur > 0 ? (Math.min(windowEnd, sourceDur) / sourceDur) * 100 : 0
  const overflowsRight = windowEnd > sourceDur && sourceDur > 0
  const overflowWidthPct = overflowsRight
    ? Math.min(20, ((windowEnd - sourceDur) / sourceDur) * 100)
    : 0

  return (
    <div className="broll-slip-panel" style={{ minWidth: MIN_PANEL_WIDTH, padding: 8 }}>
      <div
        className="slip-source-strip"
        data-testid="slip-source-strip"
        data-source-duration={String(sourceDur)}
        style={{ position: 'relative', height: 48, background: '#222', opacity: DIM_OPACITY }}
      >
        <div
          className="slip-green-window"
          data-testid="slip-green-window"
          data-window-start={String(windowStart)}
          data-window-end={String(windowEnd)}
          style={{
            position: 'absolute',
            left: `${windowStartPct}%`,
            width: `${Math.max(0, windowEndPct - windowStartPct)}%`,
            top: 0,
            bottom: 0,
            background: 'rgba(0, 230, 100, 0.35)',
            outline: '1px solid rgba(0, 230, 100, 0.9)',
            opacity: 1 / DIM_OPACITY,
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
