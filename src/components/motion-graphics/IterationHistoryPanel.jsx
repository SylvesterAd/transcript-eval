function scoreBadgeClass(score) {
  if (score >= 0.8) return 'bg-emerald-900 text-emerald-200'
  if (score >= 0.6) return 'bg-amber-900 text-amber-200'
  return 'bg-red-900 text-red-200'
}

function CriteriaRow({ label, value }) {
  const pct = Math.round((value || 0) * 100)
  return (
    <div className="flex items-center gap-2 text-[11px] text-zinc-400">
      <span className="w-16 capitalize">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded bg-zinc-800">
        <div className="h-full bg-zinc-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums">{value?.toFixed?.(2) ?? '—'}</span>
    </div>
  )
}

function IterationCard({ iteration, isBest }) {
  const { iteration_index, frame_urls, critic_score, critic_criteria, critic_feedback } = iteration
  return (
    <div className="flex min-w-[240px] flex-col gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-200">Iteration {iteration_index}</span>
        <span className="flex items-center gap-1">
          {isBest && (
            <span className="rounded bg-amber-900 px-1.5 py-0.5 text-[10px] text-amber-200">
              ★ best
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${scoreBadgeClass(critic_score)}`}>
            {critic_score?.toFixed?.(2) ?? '—'}
          </span>
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {(frame_urls || []).map((url, i) => (
          <img
            key={i}
            src={url}
            alt={`Iteration ${iteration_index} frame ${i}`}
            className="aspect-video w-full rounded border border-zinc-800 object-cover"
          />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <CriteriaRow label="fidelity" value={critic_criteria?.fidelity} />
        <CriteriaRow label="legibility" value={critic_criteria?.legibility} />
        <CriteriaRow label="style" value={critic_criteria?.style} />
        <CriteriaRow label="timing" value={critic_criteria?.timing} />
      </div>
      <p className="text-[11px] leading-snug text-zinc-300">{critic_feedback}</p>
    </div>
  )
}

export function IterationHistoryPanel({ iterations, loading, error }) {
  if (loading) {
    return (
      <div className="px-4 py-3 text-xs text-zinc-400">Loading iteration history…</div>
    )
  }
  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-red-300">Failed to load: {error}</div>
    )
  }
  if (!iterations || iterations.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-zinc-500">No iterations recorded.</div>
    )
  }
  const bestScore = Math.max(...iterations.map((i) => i.critic_score ?? 0))
  return (
    <div className="flex gap-3 overflow-x-auto px-4 py-3">
      {iterations.map((it) => (
        <IterationCard
          key={it.id}
          iteration={it}
          isBest={(it.critic_score ?? 0) === bestScore}
        />
      ))}
    </div>
  )
}
