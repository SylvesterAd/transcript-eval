/**
 * MetricsTable — displays similarity metrics, deletion stats, and reason-aware accuracy.
 */

export default function MetricsTable({ data }) {
  if (!data) return null

  return (
    <div className="space-y-4">
      {/* Similarity metrics */}
      {data.similarity && <SimilaritySection similarity={data.similarity} />}

      {/* Deletion stats */}
      {data.deletions && <DeletionStatsSection deletions={data.deletions} />}

      {/* Reason-aware scores */}
      {data.reasonScores && <ReasonScoresSection scores={data.reasonScores} />}

      {/* Reason breakdown */}
      {data.reasonStats && <ReasonBreakdownSection stats={data.reasonStats} />}
    </div>
  )
}

function SimilaritySection({ similarity }) {
  const comparisons = [
    { label: 'Human vs Current', data: similarity.humanVsCurrent, important: true },
    { label: 'Raw vs Human', data: similarity.rawVsHuman },
    { label: 'Raw vs Current', data: similarity.rawVsCurrent },
  ].filter(c => c.data)

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400 font-medium">Similarity</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-left">
            <th className="px-4 py-1.5">Comparison</th>
            <th className="px-4 py-1.5 text-right">Similarity</th>
            <th className="px-4 py-1.5 text-right">Diff</th>
          </tr>
        </thead>
        <tbody>
          {comparisons.map(c => (
            <tr key={c.label} className={`border-b border-zinc-800/50 ${c.important ? 'bg-zinc-800/20' : ''}`}>
              <td className={`px-4 py-1.5 ${c.important ? 'text-white font-medium' : 'text-zinc-400'}`}>
                {c.label} {c.important && <span className="text-xs text-blue-400 ml-1">primary</span>}
              </td>
              <td className="px-4 py-1.5 text-right">
                <span className={simColor(c.data.similarityPercent)}>{c.data.similarityPercent}%</span>
              </td>
              <td className="px-4 py-1.5 text-right text-zinc-400">{c.data.diffPercent}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DeletionStatsSection({ deletions }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400 font-medium">Deletion Analysis</div>
      <div className="grid grid-cols-5 gap-px bg-zinc-800">
        <StatBox label="Human Deleted" value={deletions.humanTotal} />
        <StatBox label="Workflow Deleted" value={deletions.workflowTotal} />
        <StatBox label="Correct" value={deletions.correct} color="text-emerald-400" />
        <StatBox label="Wrong" value={deletions.wrong} color="text-red-400" />
        <StatBox label="Missed" value={deletions.missed} color="text-amber-400" />
      </div>
      <div className="px-4 py-2 text-xs text-zinc-500 border-t border-zinc-800">
        Correct rate: {Math.round(deletions.correctRate * 100)}% · Wrong rate: {Math.round(deletions.wrongRate * 100)}% · Missed rate: {Math.round(deletions.missedRate * 100)}%
      </div>
    </div>
  )
}

function ReasonScoresSection({ scores }) {
  const reasons = ['filler_word', 'false_start', 'meta_commentary']
  const labels = { filler_word: 'Filler Words', false_start: 'False Starts', meta_commentary: 'Meta Commentary' }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400 font-medium">Reason-Aware Accuracy</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-left">
            <th className="px-4 py-1.5">Type</th>
            <th className="px-4 py-1.5 text-right">Human Total</th>
            <th className="px-4 py-1.5 text-right">Correct</th>
            <th className="px-4 py-1.5 text-right">Missed</th>
            <th className="px-4 py-1.5 text-right">Wrong</th>
            <th className="px-4 py-1.5 text-right">Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {reasons.map(r => {
            const s = scores[r]
            if (!s) return null
            return (
              <tr key={r} className="border-b border-zinc-800/50">
                <td className="px-4 py-1.5 text-zinc-300">{labels[r]}</td>
                <td className="px-4 py-1.5 text-right text-zinc-400">{s.humanTotal}</td>
                <td className="px-4 py-1.5 text-right text-emerald-400">{s.correct}</td>
                <td className="px-4 py-1.5 text-right text-amber-400">{s.missed}</td>
                <td className="px-4 py-1.5 text-right text-red-400">{s.wrong}</td>
                <td className="px-4 py-1.5 text-right">
                  {s.accuracy !== null ? (
                    <span className={simColor(s.accuracy * 100)}>{Math.round(s.accuracy * 100)}%</span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ReasonBreakdownSection({ stats }) {
  const sections = [
    { key: 'humanDeletions', label: 'Human Deletions' },
    { key: 'workflowDeletions', label: 'Workflow Deletions' },
    { key: 'correct', label: 'Correct Deletions' },
    { key: 'wrong', label: 'Wrong Deletions' },
    { key: 'missed', label: 'Missed Deletions' },
  ]

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400 font-medium">Reason Breakdown</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-left">
            <th className="px-4 py-1.5">Category</th>
            <th className="px-4 py-1.5 text-right">Total</th>
            <th className="px-4 py-1.5 text-right">Filler</th>
            <th className="px-4 py-1.5 text-right">False Start</th>
            <th className="px-4 py-1.5 text-right">Meta</th>
            <th className="px-4 py-1.5 text-right">Other</th>
          </tr>
        </thead>
        <tbody>
          {sections.map(({ key, label }) => {
            const s = stats[key]
            if (!s) return null
            return (
              <tr key={key} className="border-b border-zinc-800/50">
                <td className="px-4 py-1.5 text-zinc-300">{label}</td>
                <td className="px-4 py-1.5 text-right text-zinc-400">{s.total}</td>
                <td className="px-4 py-1.5 text-right text-orange-400">{s.filler_word?.count || 0}</td>
                <td className="px-4 py-1.5 text-right text-purple-400">{s.false_start?.count || 0}</td>
                <td className="px-4 py-1.5 text-right text-cyan-400">{s.meta_commentary?.count || 0}</td>
                <td className="px-4 py-1.5 text-right text-zinc-500">{s.unclassified?.count || 0}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StatBox({ label, value, color = 'text-white' }) {
  return (
    <div className="bg-zinc-900 p-3 text-center">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-0.5">{label}</div>
    </div>
  )
}

function simColor(pct) {
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}
