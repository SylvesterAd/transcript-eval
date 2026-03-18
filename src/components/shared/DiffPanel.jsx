/**
 * DiffPanel — renders a word-level diff with color-coded deletions/additions,
 * timecode highlighting, pause marker highlighting, and deletion reason labels.
 */

const REASON_COLORS = {
  filler_word: { bg: 'bg-orange-900/30', text: 'text-orange-300', border: 'border-orange-700', label: 'Filler' },
  false_start: { bg: 'bg-purple-900/30', text: 'text-purple-300', border: 'border-purple-700', label: 'False Start' },
  meta_commentary: { bg: 'bg-cyan-900/30', text: 'text-cyan-300', border: 'border-cyan-700', label: 'Meta' },
  unclassified: { bg: 'bg-zinc-800/50', text: 'text-zinc-400', border: 'border-zinc-600', label: 'Other' },
}

export function DeletionReasonBadge({ reason }) {
  const style = REASON_COLORS[reason] || REASON_COLORS.unclassified
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] rounded border ${style.bg} ${style.text} ${style.border} ml-1`}>
      {style.label}
    </span>
  )
}

export default function DiffPanel({ diff, deletions, title, showReasons = true }) {
  if (!diff || diff.length === 0) {
    return <div className="text-zinc-500 text-sm p-4">No diff data available.</div>
  }

  // Build a lookup for deletion reasons by matching text
  const reasonMap = new Map()
  if (deletions) {
    for (const d of deletions) {
      reasonMap.set(d.text?.trim(), d.reason)
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      {title && (
        <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400 font-medium">
          {title}
        </div>
      )}
      <div className="p-4 text-sm font-mono leading-relaxed whitespace-pre-wrap">
        {diff.map((part, i) => {
          if (part.added) {
            return (
              <span key={i} className="bg-emerald-900/40 text-emerald-300 rounded px-0.5">
                {highlightSpecialTokens(part.value)}
              </span>
            )
          }
          if (part.removed) {
            const reason = showReasons ? findReason(part.value.trim(), reasonMap) : null
            return (
              <span key={i} className="relative group">
                <span className="bg-red-900/40 text-red-300 line-through rounded px-0.5">
                  {highlightSpecialTokens(part.value)}
                </span>
                {reason && <DeletionReasonBadge reason={reason} />}
              </span>
            )
          }
          return <span key={i}>{highlightSpecialTokens(part.value)}</span>
        })}
      </div>
    </div>
  )
}

function findReason(text, reasonMap) {
  if (reasonMap.has(text)) return reasonMap.get(text)
  // Try partial match for longer spans
  for (const [key, reason] of reasonMap) {
    if (text.includes(key) || key.includes(text)) return reason
  }
  return null
}

function highlightSpecialTokens(text) {
  const parts = text.split(/(\[\d{2}:\d{2}:\d{2}\]|\[\d+\.?\d*s\])/g)
  return parts.map((part, i) => {
    if (/^\[\d{2}:\d{2}:\d{2}\]$/.test(part)) {
      return <span key={i} className="text-blue-400">{part}</span>
    }
    if (/^\[\d+\.?\d*s\]$/.test(part)) {
      return <span key={i} className="text-amber-400">{part}</span>
    }
    return part
  })
}
