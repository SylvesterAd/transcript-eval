/**
 * ScoreCard — displays the weighted total score with breakdown bars.
 */

const WEIGHT_LABELS = {
  humanMatch: 'Human Match',
  correctRemovals: 'Correct Removals',
  avoidWrongRemovals: 'Avoid Wrong Removals',
  timecodePreservation: 'Timecode Preservation',
  pausePreservation: 'Pause Preservation',
}

const WEIGHT_COLORS = {
  humanMatch: 'bg-blue-500',
  correctRemovals: 'bg-emerald-500',
  avoidWrongRemovals: 'bg-amber-500',
  timecodePreservation: 'bg-purple-500',
  pausePreservation: 'bg-cyan-500',
}

export default function ScoreCard({ score }) {
  if (!score) return null

  const { totalScore, breakdown, weights } = score
  const pct = Math.round(totalScore * 100)

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
      {/* Total score */}
      <div className="flex items-center gap-4">
        <div className={`text-3xl font-bold ${scoreColor(pct)}`}>
          {pct}%
        </div>
        <div>
          <div className="text-sm font-medium text-zinc-300">Weighted Score</div>
          <div className="text-xs text-zinc-500">Based on human-edited reference</div>
        </div>
      </div>

      {/* Breakdown bars */}
      <div className="space-y-2">
        {Object.entries(breakdown).map(([key, value]) => (
          <div key={key} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-zinc-400">
                {WEIGHT_LABELS[key]} <span className="text-zinc-600">({Math.round(weights[key] * 100)}%)</span>
              </span>
              <span className="text-zinc-300">{Math.round(value * 100)}%</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${WEIGHT_COLORS[key]}`}
                style={{ width: `${Math.round(value * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function scoreColor(pct) {
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}
