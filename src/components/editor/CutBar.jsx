import { useState } from 'react'
import CutContentPanel from './CutContentPanel.jsx'

/**
 * Thin purple vertical bar at a cut-join position on the b-roll editor's
 * post-cut timeline. Click toggles a side panel showing the removed content
 * (transcript snippet + duration + original-time range).
 *
 * Consumed by Timeline.jsx (integration deferred to a later task — see
 * docs/plans/cuts-as-source-of-truth-b2.md). Layout produced by
 * src/lib/postCutTimeline.js (`cutBars[]`).
 *
 * @param {object} props
 * @param {number} props.x - left position in px (post-cut pixel space)
 * @param {number} props.cutDuration - removed duration in seconds
 * @param {number} props.origStart - cut start in original-time seconds
 * @param {number} props.origEnd - cut end in original-time seconds
 * @param {Array<{word:string, start:number, end:number}>} [props.words] - raw transcript words
 */
export default function CutBar({ x, cutDuration, origStart, origEnd, words = [] }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <div
        data-testid="cut-bar"
        title={`${cutDuration.toFixed(1)}s removed`}
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'absolute',
          left: `${x}px`,
          top: 0,
          bottom: 0,
          width: '4px',
          background: '#8b5cf6',
          cursor: 'pointer',
          zIndex: 5,
        }}
      />
      {open && (
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
