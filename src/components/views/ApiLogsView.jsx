import { useState, useEffect } from 'react'
import { useApi, apiPost } from '../../hooks/useApi.js'
import { ChevronDown, ChevronRight, Clock, AlertCircle, CheckCircle, Copy, Check, Loader2, RotateCw } from 'lucide-react'

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

function JsonBlock({ label, content, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
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

function EventTimeline({ events }) {
  if (!events?.length) return null

  const stageColors = {
    machine: 'text-purple-400 border-purple-800/50',
    search: 'text-blue-400 border-blue-800/50',
    siglip: 'text-cyan-400 border-cyan-800/50',
    rerank: 'text-amber-400 border-amber-800/50',
  }

  return (
    <div>
      <div className="text-xs font-medium text-zinc-400 mb-2">SSE Events ({events.length})</div>
      <div className="space-y-1">
        {events.map((ev, i) => {
          const colors = stageColors[ev.data?.stage] || 'text-zinc-400 border-zinc-800/50'
          const time = ev.received_at ? new Date(ev.received_at).toLocaleTimeString() : ''
          return (
            <div key={i} className={`flex items-center gap-3 px-3 py-1.5 rounded border bg-zinc-950/50 ${colors}`}>
              <span className="text-[10px] font-mono text-zinc-600 w-16 shrink-0">{time}</span>
              <span className={`text-xs font-medium w-16 shrink-0 ${ev.event === 'error' ? 'text-red-400' : ev.event === 'result' ? 'text-green-400' : ''}`}>
                {ev.event}
              </span>
              {ev.data?.stage && <span className="text-xs font-mono">{ev.data.stage}</span>}
              {ev.data?.status && <span className="text-xs text-zinc-500">{ev.data.status}</span>}
              {ev.event === 'result' && <span className="text-xs text-green-500">{ev.data?.results?.length || 0} results</span>}
              {ev.event === 'error' && <span className="text-xs text-red-400">{ev.data?.error || JSON.stringify(ev.data)}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RetryButton({ log, onRetry }) {
  const [retrying, setRetrying] = useState(false)

  // Only show for GPU search calls
  if (!log.url?.includes('/broll/search')) return null

  async function handleRetry(e) {
    e.stopPropagation()
    setRetrying(true)
    try {
      let body = {}
      if (log.request_body) {
        try { body = JSON.parse(log.request_body) } catch {}
      }
      // Remove stream flag — the backend adds it
      delete body.stream
      await apiPost('/admin/test-search', body)
      if (onRetry) onRetry()
    } catch (err) {
      console.error('Retry failed:', err)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <button
      onClick={handleRetry}
      disabled={retrying}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 transition-colors"
      title="Retry this request"
    >
      <RotateCw size={12} className={retrying ? 'animate-spin' : ''} />
      {retrying ? 'Sending...' : 'Retry'}
    </button>
  )
}

function LogDetail({ log, onRetry }) {
  // Parse response body to extract events if it's a streaming response
  let events = null
  if (log.response_body) {
    try {
      const parsed = JSON.parse(log.response_body)
      if (parsed.events?.length) events = parsed.events
    } catch {}
  }

  return (
    <div className="space-y-3 mt-3">
      {/* URL + Method + Retry */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono font-bold text-blue-400">{log.method}</span>
        <code className="text-xs text-zinc-300 font-mono flex-1 truncate">{log.url}</code>
        <RetryButton log={log} onRetry={onRetry} />
        <CopyButton text={`${log.method} ${log.url}`} />
      </div>

      <JsonBlock label="Request Body" content={log.request_body} />
      {events && <EventTimeline events={events} />}
      <JsonBlock label="Response Body" content={log.response_body} defaultOpen={!events} />
    </div>
  )
}

function ActiveStreamCard({ stream }) {
  const [expanded, setExpanded] = useState(true)
  const elapsed = Math.round((Date.now() - new Date(stream.started_at).getTime()) / 1000)
  const lastEvent = stream.events?.[stream.events.length - 1]

  return (
    <div className="rounded-lg border border-blue-800/50 bg-blue-950/20 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-blue-900/10 transition-colors"
      >
        {expanded ? <ChevronDown size={14} className="text-blue-400 shrink-0" /> : <ChevronRight size={14} className="text-blue-400 shrink-0" />}
        <Loader2 size={14} className="text-blue-400 animate-spin shrink-0" />
        <span className="text-xs font-mono font-medium text-blue-400 w-12 shrink-0">{stream.method}</span>
        <span className="text-sm text-zinc-200 truncate flex-1 font-mono">{stream.url.replace(/^https?:\/\//, '')}</span>
        {stream.lastStage && (
          <span className="text-xs text-cyan-400 shrink-0">
            {stream.lastStage}{stream.lastStatus ? `: ${stream.lastStatus}` : ''}
          </span>
        )}
        <span className="flex items-center gap-1 text-xs text-blue-400 shrink-0">
          <Clock size={11} />
          {elapsed}s
        </span>
        {stream.source && <span className="text-[10px] text-blue-400/70 bg-blue-900/30 px-1.5 py-0.5 rounded shrink-0">{stream.source}</span>}
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-blue-800/30 space-y-3 mt-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-bold text-blue-400">{stream.method}</span>
            <code className="text-xs text-zinc-300 font-mono flex-1 truncate">{stream.url}</code>
            <CopyButton text={`${stream.method} ${stream.url}`} />
          </div>
          <JsonBlock label="Request Body" content={stream.request_body} />
          {stream.events?.length > 0 && <EventTimeline events={stream.events} />}
        </div>
      )}
    </div>
  )
}

export default function ApiLogsView() {
  const [page, setPage] = useState(0)
  const [sourceFilter, setSourceFilter] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [activeData, setActiveData] = useState(null)
  const limit = 30
  const queryParams = `/admin/api-logs?limit=${limit}&offset=${page * limit}${sourceFilter ? `&source=${encodeURIComponent(sourceFilter)}` : ''}`
  const { data, loading, error, refetch } = useApi(queryParams, [page, sourceFilter])
  const { data: detail } = useApi(expandedId ? `/admin/api-logs/${expandedId}` : null, [expandedId])

  // Poll for active streams every 2s
  useEffect(() => {
    let active = true
    async function poll() {
      try {
        const { getAuthHeaders } = await import('../../hooks/useApi.js')
        // Use the same auth pattern as useApi
        const { supabase } = await import('../../lib/supabaseClient.js')
        const headers = {}
        if (supabase) {
          const { data } = await supabase.auth.getSession()
          if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
        }
        const base = import.meta.env.VITE_API_URL || '/api'
        const res = await fetch(`${base}/admin/api-logs/active`, { headers })
        if (res.ok && active) {
          const d = await res.json()
          setActiveData(d)
          // If streams just finished, refresh the completed logs list
          if (d.streams?.length === 0 && activeData?.streams?.length > 0) {
            refetch()
          }
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => { active = false; clearInterval(interval) }
  }, [activeData?.streams?.length])

  if (loading && !data) return <div className="p-6 text-zinc-400">Loading...</div>
  if (error) return <div className="p-6 text-red-400">Error: {error}</div>

  const logs = data?.logs || []
  const total = data?.total || 0
  const activeStreams = activeData?.streams || []

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">API Logs</h2>
          <p className="text-sm text-zinc-500 mt-1">
            {total} logged request{total !== 1 ? 's' : ''}
            {activeStreams.length > 0 && <span className="text-blue-400 ml-2">({activeStreams.length} active)</span>}
          </p>
        </div>
        <input
          type="text"
          placeholder="Filter by source..."
          value={sourceFilter}
          onChange={e => { setSourceFilter(e.target.value); setPage(0) }}
          className="px-3 py-1.5 rounded border border-zinc-800 bg-zinc-900 text-sm text-zinc-200 outline-none focus:border-zinc-600 w-56"
        />
      </div>

      {/* Active streams */}
      {activeStreams.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-blue-400 uppercase tracking-wider">Active Streams</div>
          {activeStreams.map(stream => (
            <ActiveStreamCard key={stream.id} stream={stream} />
          ))}
        </div>
      )}

      {/* Completed logs */}
      <div className="space-y-2">
        {logs.map(log => (
          <div key={log.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            <button
              onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-800/30 transition-colors"
            >
              {expandedId === log.id ? <ChevronDown size={14} className="text-zinc-500 shrink-0" /> : <ChevronRight size={14} className="text-zinc-500 shrink-0" />}
              <span className="text-[10px] font-mono text-zinc-600 w-8 shrink-0">#{log.id}</span>
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
                <LogDetail log={detail} onRetry={() => refetch()} />
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
