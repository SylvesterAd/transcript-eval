// Pure reducer for the State D progress snapshot. Applies Port messages
// from the extension queue (Ext.5) onto a cached shape the component
// renders from.
//
// Kept separate from the hook so it's trivially unit-testable in Node
// (no chrome.runtime, no React) and so the component doesn't re-derive
// expensive aggregates on every message — it reads from the snapshot
// plus memoized selectors below.
//
// Port message shapes (consumed here):
//
//   {type:"state", version:1, export: {
//      runId, export_id, plan_pipeline_id, variant_labels, target_folder,
//      items: [
//        { seq, source, source_item_id, target_filename,
//          phase,            // queued|resolving|licensing|downloading|done|failed
//          bytes_received, total_bytes, download_id,
//          error_code, started_at, completed_at }
//      ],
//      stats: { ok_count, fail_count, total_bytes_downloaded, total_bytes_est },
//      run_state,            // running|paused|cancelling|cancelled|complete|partial
//      started_at, updated_at
//   }}
//
//   {type:"progress", version:1, item_id, phase, bytes, total_bytes}
//   {type:"item_done", version:1, item_id, result: {ok:bool, bytes, duration_ms, error_code?}}
//   {type:"complete",  version:1, ok_count, fail_count, folder_path, xml_paths: []}
//
// The reducer treats anything unknown as a no-op (forward-compat with
// Ext.5 bumping its schema; we'll upgrade intentionally).

export const INITIAL_PROGRESS_STATE = Object.freeze({
  // Port lifecycle
  portStatus: 'idle',     // idle | connecting | connected | disconnected | reconnecting | failed
  portError: null,

  // Snapshot — null until the first {type:"state"} arrives
  snapshot: null,

  // Terminal
  complete: null,         // {ok_count, fail_count, folder_path, xml_paths} once {type:"complete"} arrives

  // Optimistic UI — set on manual_action_sent, cleared when a snapshot echoes back the expected run_state
  pendingAction: null,    // {action:"pause"|"resume"|"cancel", sentAt:ms}
})

export function progressReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return INITIAL_PROGRESS_STATE

    case 'port_connecting':
      return { ...state, portStatus: 'connecting', portError: null }

    case 'port_connected':
      return { ...state, portStatus: 'connected', portError: null }

    case 'port_disconnected':
      return {
        ...state,
        portStatus: 'disconnected',
        portError: action.reason || null,
      }

    case 'port_reconnecting':
      return { ...state, portStatus: 'reconnecting', portError: null }

    case 'port_failed':
      return {
        ...state,
        portStatus: 'failed',
        portError: action.error || 'unknown port error',
      }

    case 'message_state': {
      // Full snapshot replace. Extension is the source of truth; we
      // don't merge field-by-field because partial snapshots are not
      // in Ext.5's contract.
      const snap = action.payload
      // If the pending action has been echoed back in the new
      // run_state, clear it.
      let pending = state.pendingAction
      if (pending && snap?.run_state) {
        const expect = {
          pause: 'paused',
          resume: 'running',
          cancel: ['cancelling', 'cancelled'],
        }[pending.action]
        const match = Array.isArray(expect)
          ? expect.includes(snap.run_state)
          : snap.run_state === expect
        if (match) pending = null
      }
      return { ...state, snapshot: snap, pendingAction: pending }
    }

    case 'message_progress': {
      // Incremental per-item bytes update. If we haven't received a
      // snapshot yet, drop the update (we'll catch up on the next
      // {type:"state"}).
      if (!state.snapshot || !Array.isArray(state.snapshot.items)) return state
      const { item_id, phase, bytes, total_bytes } = action.payload
      let touched = false
      const items = state.snapshot.items.map(it => {
        if (it.source_item_id !== item_id) return it
        touched = true
        return {
          ...it,
          phase: phase ?? it.phase,
          bytes_received: typeof bytes === 'number' ? bytes : it.bytes_received,
          total_bytes: typeof total_bytes === 'number' ? total_bytes : it.total_bytes,
        }
      })
      if (!touched) return state
      return {
        ...state,
        snapshot: { ...state.snapshot, items, updated_at: Date.now() },
      }
    }

    case 'message_item_done': {
      if (!state.snapshot || !Array.isArray(state.snapshot.items)) return state
      const { item_id, result } = action.payload
      const items = state.snapshot.items.map(it => {
        if (it.source_item_id !== item_id) return it
        return {
          ...it,
          phase: result?.ok ? 'done' : 'failed',
          bytes_received: result?.bytes ?? it.bytes_received ?? 0,
          total_bytes: result?.bytes ?? it.total_bytes ?? 0,
          error_code: result?.ok ? null : (result?.error_code || 'unknown'),
          completed_at: Date.now(),
        }
      })
      // Adjust stats locally (extension will also emit a fresh
      // {type:"state"} shortly; this is a fast local catch-up).
      const prevStats = state.snapshot.stats || { ok_count: 0, fail_count: 0, total_bytes_downloaded: 0 }
      const stats = {
        ...prevStats,
        ok_count: prevStats.ok_count + (result?.ok ? 1 : 0),
        fail_count: prevStats.fail_count + (result?.ok ? 0 : 1),
        total_bytes_downloaded: (prevStats.total_bytes_downloaded || 0) + (result?.bytes || 0),
      }
      return {
        ...state,
        snapshot: { ...state.snapshot, items, stats, updated_at: Date.now() },
      }
    }

    case 'message_complete':
      return {
        ...state,
        complete: {
          ok_count: action.payload.ok_count,
          fail_count: action.payload.fail_count,
          folder_path: action.payload.folder_path || null,
          xml_paths: Array.isArray(action.payload.xml_paths) ? action.payload.xml_paths : [],
        },
      }

    case 'manual_action_sent':
      return {
        ...state,
        pendingAction: { action: action.action, sentAt: Date.now() },
      }

    case 'manual_action_cleared':
      return { ...state, pendingAction: null }

    default:
      return state
  }
}

// -----------------------------------------------------------------
// Selectors — pure functions off the snapshot. Called under useMemo
// in the component to avoid re-deriving on every message.
// -----------------------------------------------------------------

/**
 * Derive totals for the header (done / total / bytes).
 */
export function selectTotals(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) {
    return { done: 0, failed: 0, remaining: 0, total: 0, bytesDone: 0, bytesTotal: 0 }
  }
  let done = 0, failed = 0, bytesDone = 0, bytesTotal = 0
  for (const it of snapshot.items) {
    if (it.phase === 'done') done += 1
    else if (it.phase === 'failed') failed += 1
    bytesDone += Math.max(0, it.bytes_received || 0)
    bytesTotal += Math.max(0, it.total_bytes || it.est_size_bytes || 0)
  }
  return {
    done,
    failed,
    remaining: Math.max(0, snapshot.items.length - done - failed),
    total: snapshot.items.length,
    bytesDone,
    bytesTotal,
  }
}

/**
 * Identify the "current item" — the spec's State D mockup calls out a
 * single featured current-item card. Pick the in-flight downloading
 * item with the most bytes_received (most advanced), falling back to
 * the first non-terminal item.
 */
export function selectCurrentItem(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return null
  let best = null
  for (const it of snapshot.items) {
    if (it.phase === 'done' || it.phase === 'failed') continue
    if (it.phase === 'downloading') {
      if (!best || (it.bytes_received || 0) > (best.bytes_received || 0)) best = it
    } else if (!best) {
      best = it
    }
  }
  return best
}

/**
 * Compute an instant throughput estimate + ETA string using the
 * snapshot's started_at + bytes totals. Returns { speedMbps, etaMin }.
 *
 * Not a rolling average — keeps the component simple. Displays "—" in
 * the UI for the first few seconds when the fraction is too small to
 * be meaningful (see StateD_InProgress).
 */
export function selectSpeedAndEta(snapshot) {
  if (!snapshot || !snapshot.started_at) return { speedMbps: 0, etaMin: null, etaSeconds: null }
  const elapsedSec = Math.max(1, (Date.now() - snapshot.started_at) / 1000)
  const { bytesDone, bytesTotal } = selectTotals(snapshot)
  const bitsPerSec = (bytesDone * 8) / elapsedSec
  const speedMbps = bitsPerSec / (1024 * 1024)
  const remainingBytes = Math.max(0, bytesTotal - bytesDone)
  const etaSeconds = bitsPerSec > 0 ? Math.round((remainingBytes * 8) / bitsPerSec) : null
  const etaMin = etaSeconds != null ? Math.max(1, Math.round(etaSeconds / 60)) : null
  return { speedMbps, etaMin, etaSeconds }
}
