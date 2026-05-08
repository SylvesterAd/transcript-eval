/**
 * Side panel showing the content removed by a single cut span.
 *
 * Filters raw transcript words to those starting within [origStart, origEnd)
 * and joins them. End is exclusive so a word starting exactly at origEnd —
 * which belongs to the next kept segment — is not included.
 *
 * Phase B (deferred): A-roll thumb + waveform peaks for the cut span.
 *
 * @param {object} props
 * @param {number} props.origStart - cut start in original-time seconds
 * @param {number} props.origEnd - cut end in original-time seconds
 * @param {number} props.cutDuration - removed duration
 * @param {Array<{word:string, start:number, end:number}>} [props.words] - raw transcript words
 * @param {() => void} props.onClose
 */
export default function CutContentPanel({ origStart, origEnd, cutDuration, words = [], onClose }) {
  const removedWords = words.filter(w => w.start >= origStart && w.start < origEnd)
  const text = removedWords.map(w => w.word).join(' ')

  const fmtTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  return (
    <div
      data-testid="cut-content-panel"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: 360,
        height: '100%',
        background: '#1f2937',
        padding: 16,
        color: '#e5e7eb',
        zIndex: 100,
        overflowY: 'auto',
        boxShadow: '-2px 0 12px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Removed content</h3>
        <button
          data-testid="cut-content-panel-close"
          onClick={onClose}
          style={{
            background: 'transparent',
            border: '1px solid #4b5563',
            color: '#e5e7eb',
            borderRadius: 4,
            padding: '4px 8px',
            cursor: 'pointer',
          }}
        >
          Close
        </button>
      </div>
      <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px 0' }}>
        {fmtTime(origStart)} — {fmtTime(origEnd)} ({cutDuration.toFixed(1)}s removed)
      </p>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          color: '#d1d5db',
          whiteSpace: 'pre-wrap',
        }}
      >
        {text || <em style={{ color: '#6b7280' }}>(no transcript words in this range)</em>}
      </div>
      {/* TODO Phase B: A-roll thumb + waveform peaks for the cut span */}
    </div>
  )
}
