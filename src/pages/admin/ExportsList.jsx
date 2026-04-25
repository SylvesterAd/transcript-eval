// src/pages/admin/ExportsList.jsx
//
// /admin/exports — paginated list of export runs with filters.
// Read-only. Row click navigates to /admin/exports/:id (the Detail
// page). Data source: GET /api/admin/exports via apiGet.
//
// Filter defaults (per WebApp.3 open question #3): `since` is
// now - 7 days, applied client-side on mount. The operator can
// override via the since/until inputs. `failures_only` defaults off.
// `user_id` is empty (all users).

import { useMemo, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../../hooks/useApi.js'

const DEFAULT_SINCE_DAYS = 7
const PAGE_SIZE = 50

function toIsoDayStart(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    in_progress: 'bg-blue-900/50 text-blue-400 border-blue-800',
    complete: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
    failed: 'bg-red-900/50 text-red-400 border-red-800',
    partial: 'bg-amber-900/50 text-amber-400 border-amber-800',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 text-xs rounded border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

export default function ExportsList() {
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [userId, setUserId] = useState('')
  const [since, setSince] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - DEFAULT_SINCE_DAYS)
    return toIsoDayStart(d)
  })
  const [until, setUntil] = useState('')
  const [offset, setOffset] = useState(0)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const queryString = useMemo(() => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(offset))
    if (failuresOnly) p.set('failures_only', 'true')
    if (userId) p.set('user_id', userId)
    if (since) p.set('since', since)
    if (until) p.set('until', until)
    return p.toString()
  }, [failuresOnly, userId, since, until, offset])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet(`/admin/exports?${queryString}`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [queryString])

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">Exports</h2>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={e => { setFailuresOnly(e.target.checked); setOffset(0) }}
          />
          Failures only
        </label>
        <label className="flex flex-col text-xs text-zinc-400">
          user_id
          <input
            type="text"
            value={userId}
            onChange={e => { setUserId(e.target.value); setOffset(0) }}
            placeholder="uuid or blank for all"
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 w-72"
          />
        </label>
        <label className="flex flex-col text-xs text-zinc-400">
          since (ISO)
          <input
            type="text"
            value={since}
            onChange={e => { setSince(e.target.value); setOffset(0) }}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 w-60"
          />
        </label>
        <label className="flex flex-col text-xs text-zinc-400">
          until (ISO, optional)
          <input
            type="text"
            value={until}
            onChange={e => { setUntil(e.target.value); setOffset(0) }}
            placeholder="leave blank for now"
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 w-60"
          />
        </label>
      </div>

      {loading && <div className="text-sm text-zinc-400">Loading…</div>}
      {error && <div className="text-sm text-red-400">Error: {error}</div>}

      {data && (
        <>
          <div className="text-xs text-zinc-500 mb-2">
            {data.total} total · page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(data.total / PAGE_SIZE))}
          </div>

          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-xs text-zinc-400 border-b border-zinc-800">
                <th className="text-left py-2 pr-4">id</th>
                <th className="text-left py-2 pr-4">user_id</th>
                <th className="text-left py-2 pr-4">pipeline</th>
                <th className="text-left py-2 pr-4">variants</th>
                <th className="text-left py-2 pr-4">status</th>
                <th className="text-right py-2 pr-4">ok</th>
                <th className="text-right py-2 pr-4">fail</th>
                <th className="text-left py-2 pr-4">created</th>
              </tr>
            </thead>
            <tbody>
              {data.exports.map(row => (
                <tr
                  key={row.id}
                  className="border-b border-zinc-900 hover:bg-zinc-900/50"
                  data-testid="export-row"
                >
                  <td className="py-2 pr-4">
                    <Link to={`/admin/exports/${row.id}`} className="text-blue-400 hover:underline font-mono text-xs">
                      {row.id}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-400 truncate max-w-[12rem]">
                    {row.user_id || '—'}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-400 truncate max-w-[10rem]">
                    {row.plan_pipeline_id}
                  </td>
                  <td className="py-2 pr-4 text-xs text-zinc-300">{row.variant_labels}</td>
                  <td className="py-2 pr-4"><StatusBadge status={row.status} /></td>
                  <td className="py-2 pr-4 text-right text-emerald-400">{row.downloaded_count}</td>
                  <td className="py-2 pr-4 text-right text-red-400">{row.failed_count}</td>
                  <td className="py-2 pr-4 text-xs text-zinc-400 whitespace-nowrap">
                    {row.created_at}
                  </td>
                </tr>
              ))}
              {data.exports.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-sm text-zinc-500">
                    No exports match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-3 py-1 rounded border border-zinc-700 text-sm text-zinc-300 disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= data.total}
              className="px-3 py-1 rounded border border-zinc-700 text-sm text-zinc-300 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  )
}
