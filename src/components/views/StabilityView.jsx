import { useParams, Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi.js'

export default function StabilityView() {
  const { experimentId } = useParams()
  const { data, loading } = useApi(`/experiments/${experimentId}/stability`)
  const { data: experiment } = useApi(`/experiments/${experimentId}`)

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading stability analysis...</div>
  if (!data) return <div className="p-6 text-red-400 text-sm">No stability data available</div>

  const { overall, perVideo } = data

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <div className="text-sm text-zinc-500 mb-1">
          <Link to="/experiments" className="hover:text-zinc-300">Experiments</Link>
          <span className="mx-2">→</span>
          {experiment?.name || `Experiment #${experimentId}`}
          <span className="mx-2">→</span>
          Stability
        </div>
        <h2 className="text-xl font-semibold">Stability Analysis</h2>
        <p className="text-sm text-zinc-400 mt-1">Score variance and output consistency across repeated runs</p>
      </div>

      {/* Overall stats */}
      {overall && overall.count > 0 && (
        <div>
          <h3 className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Overall Score Distribution</h3>
          <div className="grid grid-cols-5 gap-3">
            <StatBox label="Mean" value={fmtPct(overall.mean)} color={scoreColor(overall.mean)} />
            <StatBox label="Min" value={fmtPct(overall.min)} color={scoreColor(overall.min)} />
            <StatBox label="Max" value={fmtPct(overall.max)} color={scoreColor(overall.max)} />
            <StatBox label="Std Dev" value={fmtNum(overall.stddev)} color={overall.stddev < 0.02 ? 'text-emerald-400' : 'text-amber-400'} />
            <StatBox label="Range" value={fmtNum(overall.range)} color={overall.range < 0.05 ? 'text-emerald-400' : 'text-amber-400'} />
          </div>
        </div>
      )}

      {/* Per-video stability */}
      <div className="space-y-4">
        <h3 className="text-xs text-zinc-500 uppercase tracking-wide">Per-Video Stability</h3>
        {Object.entries(perVideo).map(([videoId, { video, stability }]) => (
          <VideoStabilityCard key={videoId} video={video} stability={stability} />
        ))}
      </div>
    </div>
  )
}

function VideoStabilityCard({ video, stability }) {
  if (!stability || stability.runs < 2) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="font-medium">{video?.title || 'Unknown Video'}</div>
          <span className="text-xs text-zinc-500">{stability?.runs || 0} run{stability?.runs !== 1 ? 's' : ''} — need 2+ for stability</span>
        </div>
      </div>
    )
  }

  const { score, text, stageVariance, runtime, stable } = stability

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="p-4 flex items-center justify-between border-b border-zinc-800">
        <div>
          <div className="font-medium">{video?.title || 'Unknown Video'}</div>
          <div className="text-xs text-zinc-500 mt-0.5">{stability.runs} runs</div>
        </div>
        <StabilityBadge stable={stable} />
      </div>

      <div className="p-4 space-y-4">
        {/* Score distribution */}
        {score && score.count > 0 && (
          <div>
            <h4 className="text-xs text-zinc-500 mb-2">Score Distribution</h4>
            <div className="grid grid-cols-5 gap-2">
              <MiniStat label="Mean" value={fmtPct(score.mean)} />
              <MiniStat label="Min" value={fmtPct(score.min)} />
              <MiniStat label="Max" value={fmtPct(score.max)} />
              <MiniStat label="Std Dev" value={fmtNum(score.stddev)} />
              <MiniStat label="Range" value={fmtNum(score.range)} />
            </div>
            {/* Per-run scores */}
            {score.perRun && (
              <div className="flex gap-1 mt-2">
                {score.perRun.map((r, i) => (
                  <div key={i} className="flex-1 bg-zinc-800 rounded px-2 py-1 text-center text-xs">
                    <div className="text-zinc-500">Run {r.run}</div>
                    <div className={scoreColor(r.score)}>{fmtPct(r.score)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Text similarity between runs */}
        {text && text.count > 0 && (
          <div>
            <h4 className="text-xs text-zinc-500 mb-2">Output Text Similarity (Pairwise)</h4>
            <div className="grid grid-cols-4 gap-2">
              <MiniStat label="Mean" value={`${text.mean}%`} />
              <MiniStat label="Min" value={`${text.min}%`} />
              <MiniStat label="Max" value={`${text.max}%`} />
              <MiniStat label="Std Dev" value={fmtNum(text.stddev)} />
            </div>
            {text.pairs && text.pairs.length > 0 && (
              <div className="mt-2 space-y-1">
                {text.pairs.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-zinc-500">Run {p.runA} vs {p.runB}:</span>
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${simBgColor(p.similarity)}`} style={{ width: `${p.similarity}%` }} />
                    </div>
                    <span className={simColor(p.similarity)}>{p.similarity}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Stage variance */}
        {stageVariance && stageVariance.length > 0 && (
          <div>
            <h4 className="text-xs text-zinc-500 mb-2">Per-Stage Similarity Variance</h4>
            <div className="bg-zinc-800/50 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-700 text-zinc-500">
                    <th className="px-3 py-1 text-left">Stage</th>
                    <th className="px-3 py-1 text-right">Mean Sim</th>
                    <th className="px-3 py-1 text-right">Std Dev</th>
                    <th className="px-3 py-1 text-right">Range</th>
                  </tr>
                </thead>
                <tbody>
                  {stageVariance.map(sv => (
                    <tr key={sv.stage_index} className="border-b border-zinc-700/50">
                      <td className="px-3 py-1 text-zinc-300">Stage {sv.stage_index}</td>
                      <td className="px-3 py-1 text-right"><span className={simColor(sv.stats.mean)}>{sv.stats.mean ?? '—'}%</span></td>
                      <td className="px-3 py-1 text-right text-zinc-400">{sv.stats.stddev ?? '—'}</td>
                      <td className="px-3 py-1 text-right text-zinc-400">{sv.stats.range ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Runtime variance */}
        {runtime && runtime.count > 0 && (
          <div>
            <h4 className="text-xs text-zinc-500 mb-2">Runtime Variance</h4>
            <div className="grid grid-cols-4 gap-2">
              <MiniStat label="Mean" value={fmtMs(runtime.mean)} />
              <MiniStat label="Min" value={fmtMs(runtime.min)} />
              <MiniStat label="Max" value={fmtMs(runtime.max)} />
              <MiniStat label="Std Dev" value={fmtMs(runtime.stddev)} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StabilityBadge({ stable }) {
  if (stable === null) return <span className="text-xs text-zinc-500 px-2 py-0.5 rounded border border-zinc-700">Insufficient data</span>
  return stable
    ? <span className="text-xs text-emerald-400 px-2 py-0.5 rounded border border-emerald-800 bg-emerald-900/30">Stable</span>
    : <span className="text-xs text-amber-400 px-2 py-0.5 rounded border border-amber-800 bg-amber-900/30">Unstable</span>
}

function StatBox({ label, value, color = 'text-white' }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
    </div>
  )
}

function MiniStat({ label, value }) {
  return (
    <div className="bg-zinc-800 rounded px-2 py-1 text-center">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-sm text-zinc-300 font-medium">{value}</div>
    </div>
  )
}

function fmtPct(v) { return v !== null && v !== undefined ? `${Math.round(v * 100)}%` : '—' }
function fmtNum(v) { return v !== null && v !== undefined ? v.toFixed(4) : '—' }
function fmtMs(v) { return v !== null && v !== undefined ? `${(v / 1000).toFixed(1)}s` : '—' }

function scoreColor(score) {
  if (score === null || score === undefined) return 'text-zinc-400'
  const pct = score * 100
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}

function simColor(pct) {
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}

function simBgColor(pct) {
  if (pct >= 80) return 'bg-emerald-500'
  if (pct >= 60) return 'bg-amber-500'
  return 'bg-red-500'
}
