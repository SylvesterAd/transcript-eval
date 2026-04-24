// src/pages/admin/_helpers.jsx
// Shared admin-page UI helpers. Extracted from ExportDetail.jsx so
// SupportBundle.jsx (WebApp.4) can reuse them without duplication.
// Zero behavior change from the ExportDetail originals — pure cut
// and paste.

export function StatusBadge({ status }) {
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

export function EventBadge({ event }) {
  const isFailure = event === 'item_failed' || event === 'rate_limit_hit' || event === 'session_expired'
  const cls = isFailure
    ? 'bg-red-900/40 text-red-300 border-red-800/60'
    : 'bg-zinc-800 text-zinc-300 border-zinc-700'
  return <span className={`inline-block px-1.5 py-0.5 text-xs rounded border font-mono ${cls}`}>{event}</span>
}

export function formatTimestamp(ms) {
  if (!ms && ms !== 0) return '—'
  const d = new Date(ms)
  return d.toISOString().replace('T', ' ').replace('Z', '')
}
