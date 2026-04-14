import { useState } from 'react'
import { useApi } from '../../hooks/useApi.js'
import { ChevronDown, ChevronRight, Clock, AlertCircle, CheckCircle, Copy, Check } from 'lucide-react'

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  return (
    <button
      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition-colors"
      title="Copy"
    >
      {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
    </button>
  )
}

function JsonBlock({ label, content }) {
  const [open, setOpen] = useState(true)
  if (!content) return null

  let formatted
  try { formatted = JSON.stringify(JSON.parse(content), null, 2) } catch { formatted = content }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-200">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {label}
        </button>
        <CopyButton text={formatted} />
      </div>
      {open && (
        <pre className="p-3 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-300 overflow-x-auto max-h-96 whitespace-pre-wrap">
          {formatted}
        </pre>
      )}
    </div>
  )
}

function StatusBadge({ status, error }) {
  if (error) return <span className="inline-flex items-center gap-1 text-xs text-red-400"><AlertCircle size={12} /> Error</span>
  if (status >= 200 && status < 300) return <span className="inline-flex items-center gap-1 text-xs text-green-400"><CheckCircle size={12} /> {status}</span>
  if (status >= 400) return <span className="inline-flex items-center gap-1 text-xs text-amber-400"><AlertCircle size={12} /> {status}</span>
  return <span className="text-xs text-zinc-400">{status || '—'}</span>
}

function LogDetail({ log }) {
  return (
    <div className="space-y-3 mt-3">
      {/* URL + Method */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono font-bold text-blue-400">{log.method}</span>
        <code className="text-xs text-zinc-300 font-mono flex-1 truncate">{log.url}</code>
        <CopyButton text={`${log.method} ${log.url}`} />
      </div>

      <JsonBlock label="Request Body" content={log.request_body} />
      <JsonBlock label="Response Body" content={log.response_body} />
    </div>
  )
}

export default function ApiLogsView() {
  const [page, setPage] = useState(0)
  const [sourceFilter, setSourceFilter] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const limit = 30
  const queryParams = `/admin/api-logs?limit=${limit}&offset=${page * limit}${sourceFilter ? `&source=${encodeURIComponent(sourceFilter)}` : ''}`
  const { data, loading, error } = useApi(queryParams, [page, sourceFilter])

  const { data: detail } = useApi(expandedId ? `/admin/api-logs/${expandedId}` : null, [expandedId])

  if (loading && !data) return <div className="p-6 text-zinc-400">Loading...</div>
  if (error) return <div className="p-6 text-red-400">Error: {error}</div>

  const logs = data?.logs || []
  const total = data?.total || 0

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">API Logs</h2>
          <p className="text-sm text-zinc-500 mt-1">{total} total request{total !== 1 ? 's' : ''} logged</p>
        </div>
        <input
          type="text"
          placeholder="Filter by source..."
          value={sourceFilter}
          onChange={e => { setSourceFilter(e.target.value); setPage(0) }}
          className="px-3 py-1.5 rounded border border-zinc-800 bg-zinc-900 text-sm text-zinc-200 outline-none focus:border-zinc-600 w-56"
        />
      </div>

      <div className="space-y-2">
        {logs.map(log => (
          <div key={log.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            <button
              onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-800/30 transition-colors"
            >
              {expandedId === log.id ? <ChevronDown size={14} className="text-zinc-500 shrink-0" /> : <ChevronRight size={14} className="text-zinc-500 shrink-0" />}
              <span className="text-xs font-mono font-medium text-blue-400 w-12 shrink-0">{log.method}</span>
              <span className="text-sm text-zinc-200 truncate flex-1 font-mono">{log.url.replace(/^https?:\/\//, '')}</span>
              <StatusBadge status={log.response_status} error={log.error} />
              <span className="flex items-center gap-1 text-xs text-zinc-500 shrink-0">
                <Clock size={11} />
                {log.duration_ms}ms
              </span>
              {log.source && <span className="text-[10px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded shrink-0">{log.source}</span>}
              <span className="text-xs text-zinc-600 shrink-0 w-36 text-right">
                {new Date(log.created_at).toLocaleString()}
              </span>
            </button>

            {expandedId === log.id && detail && (
              <div className="px-4 pb-4 border-t border-zinc-800">
                <LogDetail log={detail} />
              </div>
            )}
          </div>
        ))}
      </div>

      {total > limit && (
        <div className="flex items-center justify-center gap-4 pt-2">
          <button
            disabled={page === 0}
            onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 text-sm rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
          >
            Prev
          </button>
          <span className="text-xs text-zinc-500">
            Page {page + 1} of {Math.ceil(total / limit)}
          </span>
          <button
            disabled={(page + 1) * limit >= total}
            onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 text-sm rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
