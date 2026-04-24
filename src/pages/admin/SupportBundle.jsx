// src/pages/admin/SupportBundle.jsx
// /admin/support — upload an Ext.8 diagnostic bundle, see parsed JSON,
// and see the matching exports row side-by-side. Stateless on the
// server (no DB writes); this page is also stateless across reloads
// (no caching — re-upload to see again). See WebApp.4 plan for scope.

import { useState } from 'react'
import { apiGet } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'
import { StatusBadge, EventBadge, formatTimestamp } from './_helpers.jsx'

// Where the parse endpoint lives. Mirrors apiGet's base-URL resolution.
const API_BASE = import.meta.env.VITE_API_URL || '/api'

// Mirror the getAuthHeaders helper from useApi.js — we need the
// same Supabase JWT when calling /parse directly via fetch.
async function getAuthHeaders(extraHeaders = {}) {
  if (!supabase) return extraHeaders
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) return extraHeaders
  return { ...extraHeaders, Authorization: `Bearer ${token}` }
}

export default function SupportBundle() {
  const [bundle, setBundle] = useState(null)          // parsed-bundle JSON (from /parse) or null
  const [error, setError] = useState(null)            // { error, ...detail } or string
  const [uploading, setUploading] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState(null) // which run to correlate
  const [correlatedExport, setCorrelatedExport] = useState(null)  // { export, events, aggregates } or null
  const [correlationError, setCorrelationError] = useState(null)

  async function correlate(runId) {
    setSelectedRunId(runId)
    setCorrelatedExport(null)
    setCorrelationError(null)
    try {
      const events = await apiGet(`/admin/exports/${encodeURIComponent(runId)}/events`)
      setCorrelatedExport(events)
    } catch (e) {
      setCorrelationError(e?.message || 'no_match')
    }
  }

  async function handleFile(file) {
    setUploading(true)
    setError(null)
    setBundle(null)
    setCorrelatedExport(null)
    setCorrelationError(null)
    setSelectedRunId(null)
    try {
      const headers = await getAuthHeaders({ 'Content-Type': 'application/zip' })
      const res = await fetch(`${API_BASE}/admin/support-bundles/parse`, {
        method: 'POST',
        body: file,
        headers,
      })
      const data = await res.json().catch(() => ({ error: 'non_json_response' }))
      if (!res.ok) {
        setError({ status: res.status, ...data })
        return
      }
      setBundle(data)

      // Correlate with exports table (Q2 logic) — pick most recent run.
      const runs = data?.queue?.runs || []
      if (runs.length > 0) {
        const run = runs.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]
        await correlate(run.run_id)
      }
    } catch (e) {
      setError({ message: e?.message || 'upload_failed' })
    } finally {
      setUploading(false)
    }
  }

  const isUnsupportedVersion = error?.error === 'unsupported_bundle_version'
  const runs = bundle?.queue?.runs || []

  return (
    <div className="p-6 text-zinc-200">
      <h1 className="text-xl font-semibold mb-4">Support Diagnostics</h1>

      <UploadForm onFile={handleFile} uploading={uploading} />

      {isUnsupportedVersion && (
        <div className="mt-4 p-3 border border-amber-800 bg-amber-950/40 rounded text-sm">
          <div className="font-medium text-amber-300">Unsupported bundle version</div>
          <div className="mt-1 text-amber-200/80">
            This admin UI only supports schema_version in {JSON.stringify(error?.supported_versions || [1])}.
            Bundle reports schema_version = {JSON.stringify(error?.got)}. Ask the user to update the extension.
          </div>
        </div>
      )}
      {error && !isUnsupportedVersion && (
        <div className="mt-4 p-3 border border-red-800 bg-red-950/40 rounded text-sm">
          <div className="font-medium text-red-300">{error.error || 'Error'}</div>
          {error.missing && <div className="text-red-200/80">Missing file: {error.missing}</div>}
          {error.file && <div className="text-red-200/80">Problem in: {error.file}</div>}
          {error.field && <div className="text-red-200/80">Problem field: {error.field}</div>}
          {error.message && <div className="text-red-200/80">{error.message}</div>}
        </div>
      )}

      {bundle && (
        <div className="mt-6 grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div>
            <BundleMeta meta={bundle.meta} />
            <BundleQueue
              queue={bundle.queue}
              selectedRunId={selectedRunId}
              onSelectRun={correlate}
            />
            <BundleEvents events={bundle.events?.events || []} />
            <BundleEnvironment environment={bundle.environment} />
          </div>
          <div>
            <CorrelatedExportPanel
              runs={runs}
              selectedRunId={selectedRunId}
              correlated={correlatedExport}
              error={correlationError}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function UploadForm({ onFile, uploading }) {
  return (
    <label className="block cursor-pointer">
      <input
        type="file"
        accept=".zip,application/zip"
        disabled={uploading}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }}
        className="block text-sm"
      />
      {uploading && <span className="ml-3 text-xs text-zinc-500">Parsing bundle…</span>}
    </label>
  )
}

function BundleMeta({ meta }) {
  if (!meta) return null
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Bundle Meta</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-zinc-500">schema_version</dt><dd>{meta.schema_version}</dd>
        <dt className="text-zinc-500">ext_version</dt><dd>{meta.ext_version}</dd>
        <dt className="text-zinc-500">manifest_version</dt><dd>{meta.manifest_version || '—'}</dd>
        <dt className="text-zinc-500">generated_at</dt><dd>{meta.generated_at}</dd>
        <dt className="text-zinc-500">browser_family</dt><dd>{meta.browser_family || '—'}</dd>
        <dt className="text-zinc-500">bundle_window_ms</dt><dd>{meta.bundle_window_ms ?? '—'}</dd>
        <dt className="text-zinc-500">bundle_max_events</dt><dd>{meta.bundle_max_events ?? '—'}</dd>
      </dl>
    </section>
  )
}

function BundleQueue({ queue, selectedRunId, onSelectRun }) {
  const runs = queue?.runs || []
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Queue State ({runs.length} runs)</h2>
      {runs.length === 0 ? (
        <div className="text-xs text-zinc-500">No runs in queue.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left py-1 pr-3">run_id</th>
              <th className="text-left py-1 pr-3">phase</th>
              <th className="text-left py-1 pr-3">ok</th>
              <th className="text-left py-1 pr-3">fail</th>
              <th className="text-left py-1 pr-3">items</th>
              <th className="text-left py-1 pr-3">updated_at</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run_id} className="border-t border-zinc-800">
                <td className="py-1 pr-3 font-mono">{r.run_id}</td>
                <td className="py-1 pr-3"><StatusBadge status={r.phase} /></td>
                <td className="py-1 pr-3">{r.stats?.ok_count ?? 0}</td>
                <td className="py-1 pr-3">{r.stats?.fail_count ?? 0}</td>
                <td className="py-1 pr-3">{(r.items || []).length}</td>
                <td className="py-1 pr-3 text-zinc-400">{formatTimestamp(r.updated_at)}</td>
                <td className="py-1 pr-3">
                  <button
                    type="button"
                    onClick={() => onSelectRun(r.run_id)}
                    className={`px-2 py-0.5 text-xs rounded border ${selectedRunId === r.run_id ? 'bg-blue-900/50 border-blue-800 text-blue-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
                  >
                    {selectedRunId === r.run_id ? 'selected' : 'correlate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function BundleEvents({ events }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Events ({events.length})</h2>
      {events.length === 0 ? (
        <div className="text-xs text-zinc-500">No events captured.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left py-1 pr-3 whitespace-nowrap">ts</th>
              <th className="text-left py-1 pr-3">event</th>
              <th className="text-left py-1 pr-3">export_id</th>
              <th className="text-left py-1 pr-3">meta</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => (
              <tr key={i} className="border-t border-zinc-800 align-top">
                <td className="py-1 pr-3 text-zinc-400 whitespace-nowrap">{formatTimestamp(ev.ts)}</td>
                <td className="py-1 pr-3"><EventBadge event={ev.event} /></td>
                <td className="py-1 pr-3 font-mono">{ev.export_id}</td>
                <td className="py-1 pr-3 font-mono text-zinc-400 break-all">
                  {ev.meta && Object.keys(ev.meta).length > 0 ? JSON.stringify(ev.meta) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function BundleEnvironment({ environment }) {
  if (!environment) return null
  const cookieEntries = Object.entries(environment.cookie_presence || {})
  const jwtEntries = Object.entries(environment.jwt_presence || {})
  const denyList = environment.deny_list || {}
  const daily = environment.daily_counts || {}
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Environment</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-zinc-500">user_agent</dt><dd className="break-all">{environment.user_agent}</dd>
        <dt className="text-zinc-500">platform</dt><dd>{environment.platform}</dd>
        <dt className="text-zinc-500">cookie_presence</dt>
        <dd>{cookieEntries.map(([k, v]) => `${k}=${String(v)}`).join(', ') || '—'}</dd>
        <dt className="text-zinc-500">jwt_presence</dt>
        <dd>{jwtEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') || '—'}</dd>
        <dt className="text-zinc-500">deny_list</dt>
        <dd>
          {Object.keys(denyList).length === 0
            ? '—'
            : Object.entries(denyList).map(([src, ids]) => `${src}: ${Array.isArray(ids) ? ids.length : 0}`).join(', ')}
        </dd>
        <dt className="text-zinc-500">daily_counts</dt>
        <dd>
          {Object.keys(daily).length === 0
            ? '—'
            : Object.entries(daily).map(([day, sources]) => (
                <div key={day}><span className="text-zinc-500">{day}:</span> {Object.entries(sources).map(([src, n]) => `${src}=${n}`).join(', ')}</div>
              ))}
        </dd>
        <dt className="text-zinc-500">telemetry_overflow_total</dt><dd>{environment.telemetry_overflow_total}</dd>
        <dt className="text-zinc-500">telemetry_opt_out</dt><dd>{String(environment.telemetry_opt_out)}</dd>
        <dt className="text-zinc-500">active_run_id</dt><dd>{environment.active_run_id || '—'}</dd>
      </dl>
    </section>
  )
}

function CorrelatedExportPanel({ runs, selectedRunId, correlated, error }) {
  if (runs.length === 0) {
    return <EmptyPanel title="Correlated Export" message="No run IDs in bundle — nothing to correlate." />
  }
  if (error) {
    return <EmptyPanel title="Correlated Export" message={`No matching export record (run_id ${selectedRunId || runs[0]?.run_id}).`} />
  }
  if (!correlated) return null
  const ex = correlated.export
  const events = correlated.events || []
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Correlated Export (DB)</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs mb-4">
        <dt className="text-zinc-500">id</dt><dd className="font-mono">{ex?.id}</dd>
        <dt className="text-zinc-500">user_id</dt><dd className="font-mono">{ex?.user_id}</dd>
        <dt className="text-zinc-500">status</dt><dd><StatusBadge status={ex?.status} /></dd>
        <dt className="text-zinc-500">created_at</dt><dd>{ex?.created_at}</dd>
        <dt className="text-zinc-500">completed_at</dt><dd>{ex?.completed_at || '—'}</dd>
        <dt className="text-zinc-500">folder_path</dt><dd className="break-all">{ex?.folder_path || '—'}</dd>
      </dl>

      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Timeline ({events.length})</h3>
      {events.length === 0 ? (
        <div className="text-xs text-zinc-500">No events for this export.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left py-1 pr-3 whitespace-nowrap">ts</th>
              <th className="text-left py-1 pr-3">event</th>
              <th className="text-left py-1 pr-3">source/item</th>
              <th className="text-left py-1 pr-3">error</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id} className="border-t border-zinc-800 align-top">
                <td className="py-1 pr-3 text-zinc-400 whitespace-nowrap">{formatTimestamp(ev.t)}</td>
                <td className="py-1 pr-3"><EventBadge event={ev.event} /></td>
                <td className="py-1 pr-3 font-mono">{[ev.source, ev.item_id].filter(Boolean).join('/') || '—'}</td>
                <td className="py-1 pr-3 text-red-300">{ev.error_code || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function EmptyPanel({ title, message }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">{title}</h2>
      <div className="text-xs text-zinc-500 p-3 border border-zinc-800 rounded">{message}</div>
    </section>
  )
}
