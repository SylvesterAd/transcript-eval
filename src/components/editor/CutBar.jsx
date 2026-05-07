import { useState } from 'react'
import CutContentPanel from './CutContentPanel.jsx'

/**
 * Thin vertical junction at a cut-join position on the b-roll editor's
 * post-cut timeline. CapCut-style: stays a thin bar at all times. Click to
 * select; selected bar shows mini left/right drag handles for trim adjust.
 *
 * Two modes:
 *   - Uncontrolled (no `onToggle` / `onDragLeft` / `onDragRight`):
 *     click toggles an internal side panel showing the removed content.
 *     Used by tests.
 *   - Controlled (handlers provided):
 *     click calls `onToggle()`; when `selected` is true, mini drag handles
 *     are rendered on each side of the bar and wired to the drag callbacks.
 *
 * @param {object} props
 * @param {number} props.x - left position in px (post-cut pixel space)
 * @param {number} props.cutDuration - removed duration in seconds
 * @param {number} props.origStart - cut start in original-time seconds
 * @param {number} props.origEnd - cut end in original-time seconds
 * @param {Array<{word:string, start:number, end:number}>} [props.words]
 * @param {boolean} [props.selected]
 * @param {() => void} [props.onToggle]
 * @param {(e: MouseEvent) => void} [props.onDragLeft]
 * @param {(e: MouseEvent) => void} [props.onDragRight]
 */
export default function CutBar({ x, cutDuration, origStart, origEnd, words = [], selected = false, onToggle, onDragLeft, onDragRight }) {
  const [open, setOpen] = useState(false)
  const controlled = typeof onToggle === 'function'

  // Selected bar widens slightly + glows; stays thin (no overlay/expansion).
  const barWidth = selected ? 6 : 4
  const barColor = selected ? '#cefc00' : '#8b5cf6'

  return (
    <>
      <div
        data-testid="cut-bar"
        title={`${cutDuration.toFixed(1)}s removed`}
        onClick={() => {
          if (controlled) onToggle()
          else setOpen(o => !o)
        }}
        style={{
          position: 'absolute',
          left: `${x - (barWidth - 4) / 2}px`,
          top: '4px',
          bottom: '4px',
          width: `${barWidth}px`,
          background: barColor,
          cursor: 'pointer',
          zIndex: 5,
          pointerEvents: 'auto',
          borderRadius: `${barWidth}px`,
          boxShadow: selected ? '0 0 6px rgba(206,252,0,0.7)' : 'none',
        }}
      />
      {controlled && selected && onDragLeft && (
        <div
          data-testid="cut-drag-left"
          title="Drag to adjust cut start"
          onMouseDown={onDragLeft}
          style={{
            position: 'absolute',
            left: `${x - 10}px`,
            top: 0,
            bottom: 0,
            width: '8px',
            cursor: 'col-resize',
            background: 'rgba(206,252,0,0.18)',
            zIndex: 6,
            pointerEvents: 'auto',
            borderLeft: '2px solid #cefc00',
          }}
        />
      )}
      {controlled && selected && onDragRight && (
        <div
          data-testid="cut-drag-right"
          title="Drag to adjust cut end"
          onMouseDown={onDragRight}
          style={{
            position: 'absolute',
            left: `${x + barWidth + 2}px`,
            top: 0,
            bottom: 0,
            width: '8px',
            cursor: 'col-resize',
            background: 'rgba(206,252,0,0.18)',
            zIndex: 6,
            pointerEvents: 'auto',
            borderRight: '2px solid #cefc00',
          }}
        />
      )}
      {!controlled && open && (
        <CutContentPanel
          origStart={origStart}
          origEnd={origEnd}
          cutDuration={cutDuration}
          words={words}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
