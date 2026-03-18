import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi.js'
import { Trophy } from 'lucide-react'

export default function DashboardView() {
  const { data: videos, loading: vLoading } = useApi('/videos')
  const { data: strategies } = useApi('/strategies')
  const { data: experiments } = useApi('/experiments')
  const { data: rankings, loading: rLoading } = useApi('/rankings')
  const { data: stageComparison } = useApi('/rankings/stages')
  const [videoDiffs, setVideoDiffs] = useState({})

  useEffect(() => {
    if (!videos || videos.length === 0) return
    for (const v of videos) {
      fetch(`/api/diffs/video/${v.id}/raw-vs-human`)
        .then(r => r.json())
        .then(d => setVideoDiffs(prev => ({ ...prev, [v.id]: d })))
        .catch(() => {})
    }
  }, [videos])

  if (vLoading) return <Loading />

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-xl font-semibold">Dashboard</h2>

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Benchmark Videos" value={videos?.length || 0} />
        <StatCard label="Strategies" value={strategies?.length || 0} />
        <StatCard label="Experiments" value={experiments?.length || 0} />
        <StatCard label="Best Score" value={rankings?.[0] ? Math.round(rankings[0].avg_score * 100) + '%' : '—'} highlight />
      </div>

      {/* Strategy Rankings */}
      {rankings?.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3 flex items-center gap-2">
            <Trophy size={14} /> Strategy Rankings
          </h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                  <th className="px-4 py-2 w-8">#</th>
                  <th className="px-4 py-2">Experiment</th>
                  <th className="px-4 py-2">Strategy</th>
                  <th className="px-4 py-2 text-right">Avg Score</th>
                  {videos?.map(v => (
                    <th key={v.id} className="px-3 py-2 text-right text-xs truncate max-w-24" title={v.title}>
                      V{v.id}
                    </th>
                  ))}
                  <th className="px-4 py-2 text-right">Runs</th>
                  <th className="px-4 py-2 text-right">Avg Tokens</th>
                  <th className="px-4 py-2 text-right">Avg Runtime</th>
                  <th className="px-4 py-2 text-right">Avg Cost</th>
                </tr>
              </thead>
              <tbody>
                {rankings.map((r, i) => (
                  <tr key={r.experiment_id} className={`border-b border-zinc-800/50 hover:bg-zinc-800/30 ${i === 0 ? 'bg-emerald-900/10' : ''}`}>
                    <td className="px-4 py-2 text-zinc-500 font-mono">{i + 1}</td>
                    <td className="px-4 py-2 font-medium">{r.experiment_name}</td>
                    <td className="px-4 py-2 text-zinc-400">{r.strategy_name} v{r.version_number}</td>
                    <td className="px-4 py-2 text-right">
                      <span className={`font-bold ${scoreColor(r.avg_score)}`}>{Math.round(r.avg_score * 100)}%</span>
                    </td>
                    {videos?.map(v => {
                      const vs = r.videoScores?.find(s => s.video_id === v.id)
                      return (
                        <td key={v.id} className="px-3 py-2 text-right">
                          {vs ? <span className={scoreColor(vs.avg_score)}>{Math.round(vs.avg_score * 100)}%</span> : <span className="text-zinc-600">—</span>}
                        </td>
                      )
                    })}
                    <td className="px-4 py-2 text-right text-zinc-500">{r.completed_runs}</td>
                    <td className="px-4 py-2 text-right text-zinc-500">{r.avg_tokens ? Math.round(r.avg_tokens).toLocaleString() : '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-500">{r.avg_runtime_ms ? `${(r.avg_runtime_ms / 1000).toFixed(1)}s` : '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-500">{r.avg_cost ? `$${Number(r.avg_cost).toFixed(4)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Stage Comparison */}
      {stageComparison?.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Stage-by-Stage Comparison (Human vs Current)</h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                  <th className="px-4 py-2">Experiment</th>
                  <th className="px-4 py-2">Stages →</th>
                </tr>
              </thead>
              <tbody>
                {stageComparison.map(exp => (
                  <tr key={exp.experiment_id} className="border-b border-zinc-800/50">
                    <td className="px-4 py-2 text-zinc-300 text-xs">{exp.experiment_name}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2 items-center">
                        {exp.stages.map((s, i) => (
                          <div key={i} className="flex items-center gap-1">
                            {i > 0 && <span className="text-zinc-600 text-xs">→</span>}
                            <div className="bg-zinc-800 rounded px-2 py-1 text-center">
                              <div className="text-xs text-zinc-500">{s.stage_name}</div>
                              <div className={`text-sm font-medium ${simColor(s.avg_similarity)}`}>{s.avg_similarity}%</div>
                              {s.avg_delta !== null && (
                                <div className={`text-[10px] ${s.avg_delta < 0 ? 'text-emerald-400' : s.avg_delta > 0 ? 'text-red-400' : 'text-zinc-500'}`}>
                                  {s.avg_delta > 0 ? '+' : ''}{s.avg_delta}pp
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Benchmark Videos */}
      <section>
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Benchmark Videos</h3>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2 text-right">Raw→Human Sim</th>
                <th className="px-4 py-2 text-right">Deletions</th>
                <th className="px-4 py-2 text-right">Filler</th>
                <th className="px-4 py-2 text-right">Meta</th>
                <th className="px-4 py-2 text-right">Timecodes</th>
                <th className="px-4 py-2 text-right">Pauses</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {videos?.map(v => {
                const d = videoDiffs[v.id]
                return (
                  <tr key={v.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-4 py-2 font-medium">{v.title}</td>
                    <td className="px-4 py-2 text-zinc-400">{v.duration_seconds ? formatDuration(v.duration_seconds) : '—'}</td>
                    <td className="px-4 py-2 text-right">
                      {d ? <span className={simColor(d.similarity?.similarityPercent)}>{d.similarity?.similarityPercent}%</span> : <Spinner />}
                    </td>
                    <td className="px-4 py-2 text-right text-zinc-400">{d?.deletions?.length ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-orange-400">{d?.reasonStats?.filler_word?.count ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-cyan-400">{d?.reasonStats?.meta_commentary?.count ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-400">{d ? `${d.timecodes?.preserved}/${d.timecodes?.total}` : '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-400">{d ? `${d.pauses?.preserved}/${d.pauses?.total}` : '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <Link to={`/videos/${v.id}`} className="text-zinc-500 hover:text-white text-xs transition-colors">View →</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function StatCard({ label, value, highlight }) {
  return (
    <div className={`bg-zinc-900 border rounded-lg p-4 ${highlight ? 'border-emerald-800/50' : 'border-zinc-800'}`}>
      <div className={`text-2xl font-bold ${highlight ? 'text-emerald-400' : ''}`}>{value}</div>
      <div className="text-sm text-zinc-400 mt-1">{label}</div>
    </div>
  )
}

function Spinner() {
  return <span className="text-zinc-600 text-xs">...</span>
}

function Loading() {
  return <div className="p-6"><div className="text-zinc-500 text-sm">Loading...</div></div>
}

function scoreColor(score) {
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

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
