const STEP_LABELS = {
  brief_thinking: 'Thinking…',
  brief_replied: '✓ Reply received',
  render_queued: '✓ Render queued',
  render_started: 'Rendering…',
  frames_captured: '✓ Frames captured',
  critic_scored: '✓ Critic scored',
  retry_triggered: '↻ Refining',
  render_finished: '✓ Render complete',
  render_complete: '✓ Done',
}

export function PipelineStream({ events }) {
  if (!events || events.length === 0) return null
  return (
    <ul className="my-2 space-y-1 px-2 text-xs text-zinc-400">
      {events.map((e, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className="font-mono text-zinc-500">{e.step}</span>
          <span>{e.label || STEP_LABELS[e.step] || e.step}</span>
          {e.score != null && (
            <span className="text-amber-500">({e.score.toFixed(2)})</span>
          )}
        </li>
      ))}
    </ul>
  )
}
