// src/pages/admin/ExportDetail.jsx
//
// /admin/exports/:id — per-export detail view:
//   1. Summary card (id, user_id, pipeline, variants, status,
//      created_at, completed_at, folder_path)
//   2. Failure-rate aggregates (by source, by error_code)
//   3. Event timeline in t-ASC order
//
// Data source: GET /api/admin/exports/:id/events.
// Read-only. No retry, no cancel, no delete.

import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { apiGet } from '../../hooks/useApi.js'

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    in_progress: 'bg-blue-900/50 text-blue-400 border-blue-800',
    complete: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
    failed: 'bg-red-900/50 text-red-400 border-red-800',
    partial: 'bg-amber-900/50 text-amber-400 border-amber-800',
  }
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

function EventBadge({ event }) {
  const isFailure = event === 'item_failed' || event === 'rate_limit_hit' || event === 'session_expired'
  const cls = isFailure
    ? 'bg-red-900/40 text-red-300 border-red-800/60'
    : 'bg-zinc-800 text-zinc-300 border-zinc-700'
  return <span className={`inline-block px-1.5 py-0.5 text-xs rounded border font-mono ${cls}`}>{event}</span>
}

function formatTimestamp(ms) {
  if (!ms && ms !== 0) return '—'
  const d = new Date(ms)
  return d.toISOString().replace('T', ' ').replace('Z', '')
}

export default function ExportDetail() {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet(`/admin/exports/${encodeURIComponent(id)}/events`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  if (loading) return <div className="p-6 text-sm text-zinc-400">Loading…</div>
  if (error) return <div className="p-6 text-sm text-red-400">Error: {error}</div>
  if (!data) return null

  const ex = data.export
  const { fail_count, success_count, by_source, by_error_code } = data.aggregates

  return (
    <div className="p-6 space-y-6">
      <div>
        <Link to="/admin/exports" className="text-xs text-blue-400 hover:underline">← Back to Exports</Link>
        <h2 className="text-lg font-semibold text-zinc-100 mt-1">Export {ex.id}</h2>
      </div>

      {/* Summary card */}
      <div className="rounded border border-zinc-800 bg-zinc-950/50 p-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div><span className="text-zinc-500">user_id:</span> <span className="font-mono text-xs text-zinc-300">{ex.user_id || '—'}</span></div>
        <div><span className="text-zinc-500">pipeline:</span> <span className="font-mono text-xs text-zinc-300">{ex.plan_pipeline_id}</span></div>
        <div><span className="text-zinc-500">variants:</span> <span className="text-zinc-300">{ex.variant_labels}</span></div>
        <div><span className="text-zinc-500">status:</span> <StatusBadge status={ex.status} /></div>
        <div><span className="text-zinc-500">created_at:</span> <span className="text-zinc-300">{ex.created_at}</span></div>
        <div><span className="text-zinc-500">completed_at:</span> <span className="text-zinc-300">{ex.completed_at || '—'}</span></div>
        <div className="col-span-2"><span className="text-zinc-500">folder_path:</span> <span className="font-mono text-xs text-zinc-300">{ex.folder_path || '—'}</span></div>
      </div>

      {/* Aggregates */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-200 mb-2">Summary</h3>
        <div className="text-sm text-zinc-300 mb-3">
          Downloaded: <span className="text-emerald-400">{success_count}</span> · Failed: <span className="text-red-400">{fail_count}</span>
        </div>

        {Object.keys(by_source).length > 0 && (
          <div className="mb-3">
            <div className="text-xs text-zinc-500 mb-1">By source</div>
            <table className="text-sm">
              <thead>
                <tr className="text-xs text-zinc-500"><th className="text-left pr-4">source</th><th className="text-right pr-4">ok</th><th className="text-right pr-4">fail</th><th className="text-right pr-4">rate</th></tr>
              </thead>
              <tbody>
                {Object.entries(by_source).map(([src, { succeeded, failed }]) => {
                  const total = succeeded + failed
                  const rate = total > 0 ? ((failed / total) * 100).toFixed(1) + '%' : '—'
                  return (
                    <tr key={src}>
                      <td className="pr-4 text-zinc-300">{src}</td>
                      <td className="pr-4 text-right text-emerald-400">{succeeded}</td>
                      <td className="pr-4 text-right text-red-400">{failed}</td>
                      <td className="pr-4 text-right text-zinc-300">{rate}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {Object.keys(by_error_code).length > 0 && (
          <div>
            <div className="text-xs text-zinc-500 mb-1">By error code</div>
            <table className="text-sm">
              <thead>
                <tr className="text-xs text-zinc-500"><th className="text-left pr-4">error_code</th><th className="text-right pr-4">count</th></tr>
              </thead>
              <tbody>
                {Object.entries(by_error_code).map(([code, count]) => (
                  <tr key={code}>
                    <td className="pr-4 text-zinc-300 font-mono text-xs">{code}</td>
                    <td className="pr-4 text-right text-red-400">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Timeline */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-200 mb-2">Timeline ({data.events.length} events)</h3>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-xs text-zinc-400 border-b border-zinc-800">
              <th className="text-left py-2 pr-4">t</th>
              <th className="text-left py-2 pr-4">event</th>
              <th className="text-left py-2 pr-4">item</th>
              <th className="text-left py-2 pr-4">source</th>
              <th className="text-left py-2 pr-4">phase</th>
              <th className="text-left py-2 pr-4">error</th>
              <th className="text-right py-2 pr-4">http</th>
              <th className="text-right py-2 pr-4">retry</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map(ev => (
              <tr key={ev.id} className="border-b border-zinc-900 hover:bg-zinc-900/50" data-testid="event-row">
                <td className="py-2 pr-4 text-xs text-zinc-400 whitespace-nowrap">{formatTimestamp(ev.t)}</td>
                <td className="py-2 pr-4"><EventBadge event={ev.event} /></td>
                <td className="py-2 pr-4 text-xs font-mono text-zinc-300">{ev.item_id || '—'}</td>
                <td className="py-2 pr-4 text-xs text-zinc-300">{ev.source || '—'}</td>
                <td className="py-2 pr-4 text-xs text-zinc-300">{ev.phase || '—'}</td>
                <td className="py-2 pr-4 text-xs font-mono text-red-400">{ev.error_code || '—'}</td>
                <td className="py-2 pr-4 text-right text-xs text-zinc-300">{ev.http_status || '—'}</td>
                <td className="py-2 pr-4 text-right text-xs text-zinc-300">{ev.retry_count ?? '—'}</td>
              </tr>
            ))}
            {data.events.length === 0 && (
              <tr><td colSpan={8} className="py-8 text-center text-sm text-zinc-500">No events recorded.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
