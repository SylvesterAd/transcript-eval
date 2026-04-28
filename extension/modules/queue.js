// Ext.5 queue — state machine + worker pools + Port broadcast.
//
// This module is the singleton owner of the current run's in-memory
// RunState. MV3 SW termination means every field here must be
// reconstructable from chrome.storage.local (Task 8 wires the save
// path; Task 9 wires the load path). In this Phase-1 commit, the
// queue is in-memory only; force-closing the SW loses the run.
//
// Public API:
//   startRun, pauseRun, resumeRun, cancelRun, getRunState,
//   autoResumeIfActiveRun (stub — filled in Task 9).
//
// Module side effect: a top-level chrome.downloads.onChanged listener
// is registered on import — must be at module scope so it's wired up
// the moment the SW wakes (not inside startRun).

import {
  MAX_ENVATO_RESOLVER_CONCURRENCY,
  MAX_ENVATO_LICENSE_CONCURRENCY,
  MAX_DOWNLOAD_CONCURRENCY,
  PROGRESS_COALESCE_MS,
  DOWNLOAD_NETWORK_RETRY_CAP,
  MESSAGE_VERSION,
  FREEPIK_URL_REFETCH_CAP,
  INTEGRITY_TOLERANCE,
} from '../config.js'
import { resolveOldIdToNewUuid, getSignedDownloadUrl } from './envato.js'
import { fetchPexelsUrl, fetchFreepikUrl } from './sources.js'
import { broadcastToPort } from './port.js'
import {
  saveRunState, loadRunState, deleteRunState,
  getActiveRunId, setActiveRunId, clearActiveRunId,
  markCompleted,
  isDenied,
  addToDenyList,
  shouldAlertForDeny,
  markAlertEmitted,
  incrementDailyCount,
  checkDailyCapThreshold,
} from './storage.js'
import { emit as emitTelemetry, normalizeErrorCode } from './telemetry.js'
import {
  classifyResolverError,
  classifyLicenseError,
  classifySourceMintError,
  classifyDownloadInterrupt,
  classifyIntegrityError,
  parseRetryAfter,
} from './classifier.js'

// -------- Adapter shims so queue code reads like the spec --------

function broadcast(msg) {
  // Inject version if the caller didn't supply one.
  if (msg && typeof msg === 'object' && msg.version == null) {
    msg.version = MESSAGE_VERSION
  }
  return broadcastToPort(msg)
}

// Unified signed-URL fetcher for non-Envato sources (JIT).
// Envato has its own two-phase resolver/licenser so the queue
// calls resolveOldIdToNewUuid + getSignedDownloadUrl directly.
async function getSignedUrlForSource(source, itemId) {
  if (source === 'pexels') {
    const data = await fetchPexelsUrl({ itemId })
    return { url: data?.url, size_bytes: data?.size_bytes || null }
  }
  if (source === 'freepik') {
    const data = await fetchFreepikUrl({ itemId })
    return { url: data?.url, expires_at: data?.expires_at || null, size_bytes: data?.size_bytes || null }
  }
  throw new Error(`unknown source: ${source}`)
}

// -------- Module-scoped state --------

// In-memory RunState | null. Task 8 writes to chrome.storage.local
// mirror on every transition; Task 9 rehydrates.
let state = null
let acquiredKeepAwake = false
const lastProgressPush = new Map() // seq -> last-push-epoch-ms

// Currently-active counts per phase (in-flight).
const active = { resolving: 0, licensing: 0, downloading: 0 }

// ------------------- Public API -------------------

export async function startRun({ runId, manifest, targetFolder, options, userId, _config_check_passed } = {}) {
  // Ext.9 — defensive guard. The SW's {type:"export"} handler MUST call
  // enforceConfigBeforeExport and pass _config_check_passed: true in
  // params. If this flag is missing, the SW was bypassed (either a test
  // harness or a future code path). Warn-log but PROCEED — Ext.9's
  // contract is single-site enforcement, not defense-in-depth.
  if (_config_check_passed !== true) {
    console.warn('[queue] startRun called without _config_check_passed — config gate bypassed')
  }
  if (!runId || typeof runId !== 'string') {
    return { ok: false, reason: 'bad_input', detail: 'runId required' }
  }
  // 1. In-memory guard (short-circuit if this SW instance still has
  // a live run mid-flight).
  if (state && state.run_state === 'running') {
    return { ok: false, reason: 'run_already_active', active_run_id: state.runId }
  }
  // 2. Persistent CAS lock — survives SW restarts. This is the
  // authoritative single-active-run check.
  const lockResult = await setActiveRunId(runId)
  if (!lockResult.ok) {
    return { ok: false, reason: 'run_already_active', active_run_id: lockResult.activeRunId }
  }
  // 3. Build initial RunState
  state = buildInitialRunState({ runId, manifest, targetFolder, options, userId })
  // 4. Persist FIRST — invariant #1. If the SW dies before we
  // broadcast, the persisted state is the truth.
  await persist()
  // 5. Acquire keepAwake
  await acquireKeepAwake()
  // 6. Broadcast initial state
  broadcast({ type: 'state', export: snapshot() })
  // Ext.6 telemetry: export_started. Fire-and-forget.
  const sourceBreakdown = { envato: 0, pexels: 0, freepik: 0 }
  let totalBytesEst = 0
  for (const item of state.items) {
    if (sourceBreakdown[item.source] != null) sourceBreakdown[item.source]++
    if (typeof item.total_bytes === 'number') totalBytesEst += item.total_bytes
  }
  emitTelemetry('export_started', {
    export_id: state.runId,
    t: state.started_at,
    meta: {
      total_items: state.items.length,
      total_bytes_est: totalBytesEst,
      source_breakdown: sourceBreakdown,
    },
  })
  // 7. Kick worker pools
  schedule()
  return { ok: true, runId }
}

export async function pauseRun() {
  if (!state || state.run_state !== 'running') return { ok: false }
  state.run_state = 'paused'
  await releaseKeepAwake()
  await persistAndBroadcast()
  emitTelemetry('queue_paused', {
    export_id: state.runId,
    t: Date.now(),
    meta: { reason: 'user' },
  })
  return { ok: true }
}

export async function resumeRun() {
  if (!state || state.run_state !== 'paused') return { ok: false }
  state.run_state = 'running'
  await acquireKeepAwake()
  await persistAndBroadcast()
  emitTelemetry('queue_resumed', {
    export_id: state.runId,
    t: Date.now(),
  })
  schedule()
  return { ok: true }
}

export async function cancelRun() {
  if (!state) return { ok: false }
  state.run_state = 'cancelled'
  // Cancel any in-flight chrome.downloads
  for (const it of state.items) {
    if (it.phase === 'downloading' && it.download_id != null) {
      try { await chrome.downloads.cancel(it.download_id) } catch {}
    }
  }
  emitTelemetry('export_completed', {
    export_id: state.runId,
    t: Date.now(),
    meta: {
      ok_count:         state.stats.ok_count,
      fail_count:       state.stats.fail_count,
      wall_seconds:     Math.round((Date.now() - state.started_at) / 1000),
      total_bytes:      state.stats.total_bytes_downloaded,
      reason:           'cancelled',
    },
  })
  await releaseKeepAwake()
  // Persist the terminal state (so status requests during cleanup see
  // 'cancelled'), then delete the run record and clear the lock.
  await persistAndBroadcast()
  const runId = state.runId
  await deleteRunState(runId)
  await clearActiveRunId()
  state = null
  return { ok: true }
}

export function getRunState() {
  return state ? snapshot() : null
}

// ------------------- Scheduler -------------------

function schedule() {
  if (!state || state.run_state !== 'running') return
  fillPool('resolving',   MAX_ENVATO_RESOLVER_CONCURRENCY, runResolver)
  fillPool('licensing',   MAX_ENVATO_LICENSE_CONCURRENCY,  runLicenser)
  fillPool('downloading', MAX_DOWNLOAD_CONCURRENCY,        runDownloader)
  // Terminal check: if every item is done or failed, finalize.
  const everyoneDone = state.items.every(i => i.phase === 'done' || i.phase === 'failed')
  if (everyoneDone) {
    // finalize is async but schedule is called from sync paths; fire
    // and forget, swallowing any errors with a log.
    finalize().catch(err => {
      console.error('[queue] finalize error', err)
    })
  }
}

function fillPool(phaseName, cap, runner) {
  while (active[phaseName] < cap) {
    const item = nextItemForPhase(phaseName)
    if (!item) return
    active[phaseName]++
    runner(item).finally(() => {
      active[phaseName]--
      schedule() // chain-pull: on completion, try to fill other pools
    })
  }
}

function nextItemForPhase(phaseName) {
  if (!state) return null
  // Claim semantics: we flip an in-memory `claimed` flag on the item.
  // Not persisted — a crashed SW redoes the claim on resume because
  // the phase-before-crash is what's persisted.
  if (phaseName === 'resolving') {
    return state.items.find(i => !i.claimed && i.source === 'envato' && i.phase === 'queued')
  }
  if (phaseName === 'licensing') {
    return state.items.find(i => !i.claimed && i.source === 'envato' && i.phase === 'licensing')
  }
  if (phaseName === 'downloading') {
    return state.items.find(i => !i.claimed && i.phase === 'downloading')
  }
  return null
}

// ------------------- Workers -------------------

async function runResolver(item) {
  item.claimed = true
  item.phase = 'resolving'
  item.resolve_started_at = Date.now()
  await persistAndBroadcast()
  try {
    const uuid = await resolveOldIdToNewUuid(item.envato_item_url)
    item.resolved_uuid = uuid
    item.phase = 'licensing'
    item.claimed = false
    emitTelemetry('item_resolved', {
      export_id: state.runId,
      item_id: item.source_item_id,
      source: 'envato',
      phase: 'resolve',
      t: Date.now(),
      meta: { resolve_ms: Date.now() - (item.resolve_started_at || Date.now()) },
    })
    await persistAndBroadcast()
  } catch (err) {
    item.resolve_attempts = (item.resolve_attempts || 0) + 1
    const verdict = classifyResolverError(err, item)
    await applyVerdict(item, verdict, { phase: 'resolve', err })
  }
}

async function runLicenser(item) {
  item.claimed = true
  // item.phase is already 'licensing'
  item.license_started_at = Date.now()

  // --- Ext.7 deny-list gate ---
  // Read BEFORE the license GET so we don't spend a license on a
  // known-bad filetype. Non-Envato sources don't reach this worker.
  try {
    if (await isDenied(item.source, item.source_item_id)) {
      await failItem(item, 'envato_unsupported_filetype')
      item.__settle?.()
      // Alert dedupe: only emit once per 24h.
      await maybeEmitDenyAlert(item, 'envato_unsupported_filetype', 'pre-deny-hit')
      return
    }
  } catch (err) {
    console.warn('[queue] deny-list read failed — proceeding', err)
  }

  await persistAndBroadcast()
  try {
    // JIT URL fetching: we're milliseconds away from chrome.downloads.download
    const signedUrl = await getSignedDownloadUrl(item.resolved_uuid)

    // Ext.7 post-license filetype check. Envato's own orchestrator
    // (envato.js `downloadEnvato`) does this for single-shot; the
    // queue does it here for the pool path.
    const cdnFilename = extractFilenameFromSignedUrl(signedUrl)
    if (cdnFilename && /\.(zip|aep|prproj)$/i.test(cdnFilename)) {
      // Write to deny-list THEN emit alert (persist-before-emit).
      await addToDenyList(item.source, item.source_item_id, `unsupported_filetype:${cdnFilename}`)
      await failItem(item, 'envato_unsupported_filetype')
      item.__settle?.()
      await maybeEmitDenyAlert(item, 'envato_unsupported_filetype', cdnFilename)
      return
    }

    item.signed_url = signedUrl
    item.phase = 'downloading'
    item.claimed = false
    emitTelemetry('item_licensed', {
      export_id: state.runId,
      item_id: item.source_item_id,
      source: 'envato',
      phase: 'license',
      t: Date.now(),
      meta: { license_ms: Date.now() - (item.license_started_at || Date.now()) },
    })
    await persistAndBroadcast()
  } catch (err) {
    item.license_attempts = (item.license_attempts || 0) + 1
    const verdict = classifyLicenseError(err, item)
    await applyVerdict(item, verdict, { phase: 'license', err })
  }
}

async function runDownloader(item) {
  item.claimed = true
  // item.phase is 'downloading' already

  // --- Ext.7 daily-cap hard-stop gate ---
  // Check BEFORE starting a new download. The per-download-complete
  // check at the end of handleDownloadEvent handles the "crossed the
  // threshold mid-run" case.
  const capStatus = await checkDailyCapThreshold(item.source).catch(() => 'ok')
  if (capStatus === 'hard_stop') {
    await failItem(item, `${item.source}_daily_cap_exceeded`)
    item.__settle?.()
    return
  }
  if (capStatus === 'warn' && !state.daily_cap_warned?.[item.source]) {
    state.daily_cap_warned = state.daily_cap_warned || {}
    state.daily_cap_warned[item.source] = Date.now()
    broadcast({ type: 'warn', message: `Approaching daily ${item.source} cap (400/500)` })
    await persist()
  }

  try {
    // JIT URL fetch for Pexels/Freepik (they skip resolving/licensing)
    if (item.source !== 'envato' && !item.signed_url) {
      try {
        const mint = await getSignedUrlForSource(item.source, item.source_item_id)
        item.signed_url = mint.url
        item.signed_url_expires_at = mint.expires_at || null
        item.expected_size_bytes = mint.size_bytes || item.total_bytes || null
      } catch (err) {
        item.mint_attempts = (item.mint_attempts || 0) + 1
        const verdict = classifySourceMintError(err, item)
        await applyVerdict(item, verdict, { phase: 'download', err })
        return
      }
    }
    item.download_started_at = Date.now()
    // chrome.downloads.download requires a path RELATIVE to the user's
    // Downloads folder. The web app passes target_folder_path as a
    // display-friendly absolute string like "~/Downloads/transcript-eval/
    // export-<run>-a/" — strip the leading "~/Downloads/" (or any leading
    // "~/" / "/") and any redundant slashes before handing to Chrome,
    // otherwise downloads fail with "Invalid filename" before any byte
    // is written.
    const relFolder = String(state.target_folder_path || '')
      .replace(/^~\/Downloads\//, '')
      .replace(/^~\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
    const filename = relFolder
      ? `${relFolder}/${item.target_filename}`
      : item.target_filename
    const downloadId = await chrome.downloads.download({
      url: item.signed_url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    })
    item.download_id = downloadId
    state.download_id_to_seq[downloadId] = item.seq
    await persistAndBroadcast()
    // The rest happens via chrome.downloads.onChanged — we return
    // and let the listener finalize the item on 'complete' or
    // 'interrupted'. The worker's Promise resolves when the listener
    // flips phase to 'done' or 'failed' (we hand-resolve via a per-
    // item awaiter).
    await waitForDownloadSettled(item)
    item.claimed = false
  } catch (err) {
    await failItem(item, err?.message || 'download_failed')
    item.__settle?.()
  }
}

// Per-item "wait until settled" — resolves when chrome.downloads.onChanged
// flips the item to 'done' or 'failed'. Implementation: each item gets
// its own Promise whose resolver we stash on the item (not persisted
// — on SW wake, handleDownloadEvent re-sees the download_id via
// chrome.downloads.search and continues).
function waitForDownloadSettled(item) {
  return new Promise(resolve => { item.__settle = resolve })
}

// ------------------- chrome.downloads.onChanged routing -------------------

chrome.downloads.onChanged.addListener(delta => {
  if (!state) return
  const seq = state.download_id_to_seq[delta.id]
  if (seq == null) return
  const item = state.items.find(i => i.seq === seq)
  if (!item) return
  // The handler is async but the onChanged listener is sync — kick
  // off the async work and catch any rejections to avoid unhandled
  // rejections if persistence throws.
  handleDownloadEvent(item, delta).catch(err => {
    console.error('[queue] handleDownloadEvent error', err)
  })
})

async function handleDownloadEvent(item, delta) {
  // Byte progress — coalesced.
  if (delta.bytesReceived != null) {
    item.bytes_received = delta.bytesReceived.current
    maybePushProgress(item)
  }
  if (delta.totalBytes != null && delta.totalBytes.current != null) {
    item.total_bytes = delta.totalBytes.current
  }
  // State transitions.
  if (delta.state) {
    const next = delta.state.current
    if (next === 'complete') {
      // Ext.7 integrity check. chrome.downloads reports bytes_received;
      // the manifest carries est_size_bytes (stored as
      // item.expected_size_bytes or item.total_bytes). If
      // |actual - expected| > INTEGRITY_TOLERANCE AND > 1024 bytes
      // absolute, retry once (delete + re-mint + re-download); second
      // mismatch → integrity_failed. Placed BEFORE stats/daily-cap
      // so a failed-integrity item never counts toward either.
      const expected = item.expected_size_bytes || item.total_bytes
      const actual = item.bytes_received || 0
      if (expected && actual > 0) {
        const tol = expected * INTEGRITY_TOLERANCE
        if (Math.abs(actual - expected) > tol && Math.abs(actual - expected) > 1024) {
          const verdict = classifyIntegrityError(item)
          if (verdict.retry) {
            item.integrity_retries = (item.integrity_retries || 0) + 1
            // Delete the file so the redownload writes a fresh copy
            // (instead of chrome uniquifying the filename).
            try {
              await chrome.downloads.removeFile(item.download_id)
            } catch {}
            // Drop the download_id mapping so future onChanged events
            // for the old id don't re-enter this branch.
            if (item.download_id != null) {
              delete state.download_id_to_seq[item.download_id]
            }
            item.download_id = null
            item.signed_url = null
            item.bytes_received = 0
            item.phase = 'downloading'
            item.claimed = false
            await persistAndBroadcast()
            schedule()
            return
          }
          // verdict.skip path — already retried.
          await failItem(item, verdict.skip.error_code)
          item.__settle?.()
          return
        }
      }
      item.phase = 'done'
      state.stats.ok_count++
      state.stats.total_bytes_downloaded += item.bytes_received || 0
      // Record cross-run dedup entry.
      if (state.userId) {
        try {
          await markCompleted(state.userId, item.source, item.source_item_id, state.target_folder_path)
        } catch (err) {
          console.warn('[queue] markCompleted failed', err)
        }
      }
      // Ext.7: daily-cap increment. Happens on complete, not on
      // license commit — a hard-stop mid-download must NOT leak a
      // cap increment. Single write point; runDownloader's
      // pre-check handles the subsequent skip.
      try {
        await incrementDailyCount(item.source)
        const newStatus = await checkDailyCapThreshold(item.source)
        if (newStatus === 'warn' && !state.daily_cap_warned?.[item.source]) {
          state.daily_cap_warned = state.daily_cap_warned || {}
          state.daily_cap_warned[item.source] = Date.now()
          broadcast({ type: 'warn', message: `Approaching daily ${item.source} cap (400/500)` })
        }
        if (newStatus === 'hard_stop') {
          // Skip further items of this source; do NOT hard-stop the
          // whole queue (open question 3). A future item hitting the
          // runDownloader's pre-check will fail with source_daily_cap_exceeded.
          console.warn('[queue] daily cap hit for source:', item.source)
        }
      } catch (err) {
        console.warn('[queue] daily-cap increment failed', err)
      }
      emitTelemetry('item_downloaded', {
        export_id: state.runId,
        item_id: item.source_item_id,
        source: item.source,
        phase: 'download',
        t: Date.now(),
        meta: {
          bytes: item.bytes_received || 0,
          download_ms: Date.now() - (item.download_started_at || Date.now()),
          filename: item.target_filename,
        },
      })
      // Ext.7 (Task 10, uniquify-bundle extension side): emit the actual
      // on-disk filename so the web app's XMEML path generator can match
      // `001_envato_NX9WYGQ (1).mov` rather than the pre-uniquify name.
      // We populate item.final_path here so it lands in the persisted
      // state.items[] snapshot (and downstream in result_json). The
      // web-side consumer (useExportPort handler + State F UI) is
      // DEFERRED to a post-Wave-1 mini-PR to avoid merge conflict with
      // the in-parallel State F / WebApp.3 branches touching
      // src/hooks/useExportPort.js and src/pages/*.jsx.
      try {
        const results = await chrome.downloads.search({ id: item.download_id })
        const actual = results && results[0]
        const finalPath = actual?.filename || item.target_filename
        item.final_path = finalPath
        broadcast({
          type: 'item_finalized',
          item_id: item.source_item_id,
          seq: item.seq,
          final_path: finalPath,
          bytes: item.bytes_received,
        })
      } catch (err) {
        console.warn('[queue] item_finalized broadcast failed', err)
      }
      await persistAndBroadcast()
      broadcast({ type: 'item_done', item_id: item.source_item_id, result: 'ok' })
      item.__settle?.()
    } else if (next === 'interrupted') {
      await handleDownloadInterrupt(item, delta)
    }
  }
}

async function handleDownloadInterrupt(item, delta) {
  const reason = delta.error?.current || 'UNKNOWN'
  const verdict = classifyDownloadInterrupt(reason, item)

  // Special: url-expired maybe-refetch path. The classifier returned
  // skip with maybe_refetch; the queue decides whether to promote to
  // a refetch-retry based on source + refetch count.
  if (verdict.skip?.maybe_refetch && item.source === 'freepik') {
    if ((item.url_refetch_count || 0) < FREEPIK_URL_REFETCH_CAP) {
      item.url_refetch_count = (item.url_refetch_count || 0) + 1
      item.signed_url = null
      item.download_id = null
      item.bytes_received = 0
      item.phase = 'downloading'
      item.claimed = false
      await persistAndBroadcast()
      schedule()
      return
    }
    // Refetch cap hit — final verdict.
    await failItem(item, 'url_expired_refetch_failed')
    item.__settle?.()
    return
  }

  // Ext.6 telemetry: NETWORK_* retries emit rate_limit_hit (preserved
  // from the Ext.6 wiring). applyVerdict emits rate_limit_hit for
  // 429-status errors only, so do the chrome.downloads-specific
  // NETWORK_* case here before dispatching.
  if (verdict.retry?.use_chrome_resume) {
    emitTelemetry('rate_limit_hit', {
      export_id: state.runId,
      item_id: item.source_item_id,
      source: item.source,
      phase: 'download',
      t: Date.now(),
      http_status: null,
      retry_count: item.retries || 0,
      meta: { retry_after_sec: null, reason: reason },
    })
  }

  await applyVerdict(item, verdict, { phase: 'download', err: { reason } })
}

function maybePushProgress(item) {
  const now = Date.now()
  const last = lastProgressPush.get(item.seq) || 0
  if (now - last < PROGRESS_COALESCE_MS) return
  lastProgressPush.set(item.seq, now)
  broadcast({
    type: 'progress',
    item_id: item.source_item_id,
    phase: item.phase,
    bytes: item.bytes_received,
    total_bytes: item.total_bytes,
  })
}

// ------------------- State helpers -------------------

export function buildInitialRunState({ runId, manifest, targetFolder, options, userId }) {
  return {
    runId,
    started_at: Date.now(),
    updated_at: Date.now(),
    target_folder_path: targetFolder,
    options: { variants: options?.variants || [], force_redownload: !!options?.force_redownload },
    items: (manifest || []).map((m, i) => ({
      seq: i + 1,
      source: m.source,
      source_item_id: m.source_item_id,
      target_filename: m.target_filename,
      envato_item_url: m.envato_item_url || null,
      phase: m.source === 'envato' ? 'queued' : 'downloading', // non-Envato skip phases 1-2
      download_id: null,
      bytes_received: 0,
      total_bytes: m.est_size_bytes || null,
      error_code: null,
      retries: 0,
      resolved_uuid: null,
      // Pre-populated by the server for A-roll items (Cloudflare Stream
      // URL) so the queue skips the mint phase. Hardcoding null here
      // forced aroll into getSignedUrlForSource → unknown-source throw,
      // which the classifier mis-routed to freepik_404.
      signed_url: m.signed_url || null,
      claimed: false,
      // Ext.6: timing fields for telemetry meta. Set when the phase starts.
      resolve_started_at: null,
      license_started_at: null,
      download_started_at: null,
      // Ext.7: retry counters (per-phase + per-error). Persisted so a
      // SW restart remembers the retry state.
      resolve_attempts: 0,
      license_attempts: 0,
      rate_limit_429_count: 0,
      freepik_429_count: 0,
      mint_attempts: 0,
      url_refetch_count: 0,
      integrity_retries: 0,
      signed_url_expires_at: null,
      expected_size_bytes: null,
      // Ext.7 (Task 10): set on item_finalized from chrome.downloads.search.
      // null until the download completes; web app reads from the
      // persisted state.items[].final_path once State F / WebApp.3 wire
      // the consumer (deferred — see note above at the emit site).
      final_path: null,
    })),
    stats: { ok_count: 0, fail_count: 0, total_bytes_downloaded: 0 },
    run_state: 'running',
    download_id_to_seq: {},
    userId, // for storage.markCompleted wiring in Task 8
    // Ext.6: flag so we emit session_expired at most once per run.
    session_expired_emitted: false,
  }
}

function snapshot() {
  if (!state) return null
  // Hide in-memory-only fields (claimed, __settle) from Port pushes.
  return {
    runId: state.runId,
    started_at: state.started_at,
    updated_at: state.updated_at,
    target_folder_path: state.target_folder_path,
    options: state.options,
    items: state.items.map(({ claimed, __settle, ...rest }) => rest),
    stats: state.stats,
    run_state: state.run_state,
  }
}

// Strip in-memory-only fields before persisting to chrome.storage.local.
function stripInMemory(s) {
  return {
    ...s,
    items: s.items.map(({ claimed, __settle, ...rest }) => rest),
  }
}

// Persist the current RunState to chrome.storage.local. Invariant #1
// from the plan: every phase transition calls this BEFORE broadcasting
// to the Port. MV3 SW termination is designed-for — whatever's
// persisted is the truth if the SW dies mid-transition.
async function persist() {
  if (!state) return
  state.updated_at = Date.now()
  await saveRunState(state.runId, stripInMemory(state))
}

// Persist then broadcast — the single write-point every phase
// transition should use.
async function persistAndBroadcast() {
  await persist()
  broadcast({ type: 'state', export: snapshot() })
}

// Legacy helper retained for the chrome.downloads.onChanged path,
// where the listener is synchronous — it schedules a persist as a
// trailing await via the inner handler promise.
function broadcastItemTransition(_item) {
  // No-op for now: callers that are inside async workers have been
  // switched to `await persistAndBroadcast()`. Kept as a forwarder so
  // any stragglers inside the synchronous chrome.downloads.onChanged
  // handler still produce at least a Port push (persistence is added
  // to those paths via explicit await persist() calls).
  broadcast({ type: 'state', export: snapshot() })
}

async function failItem(item, errorCode) {
  // Capture the phase BEFORE we flip it to 'failed' so the telemetry
  // payload describes which stage actually failed.
  const phaseBeforeFailure = item.phase
  item.phase = 'failed'
  item.error_code = errorCode
  item.claimed = false
  state.stats.fail_count++
  await persistAndBroadcast()
  broadcast({ type: 'item_done', item_id: item.source_item_id, result: 'failed' })

  // Ext.6 telemetry. Fire-and-forget; do not await.
  emitTelemetry('item_failed', {
    export_id: state.runId,
    item_id: item.source_item_id,
    source: item.source,
    phase: phaseBeforeFailure === 'resolving' ? 'resolve' : phaseBeforeFailure === 'licensing' ? 'license' : 'download',
    t: Date.now(),
    error_code: normalizeErrorCode(errorCode),   // Task 8 lands normalizeErrorCode
    retry_count: item.retries || 0,
    meta: {
      attempts: (item.retries || 0) + 1,
      raw_error: errorCode, // keep the raw string so admin observability can triage unknowns
    },
  })

  // Session_expired side-emit (invariant #7-adjacent; at most once per run).
  if ((errorCode === 'envato_session_401' || String(errorCode).startsWith('envato_session_401')) && !state.session_expired_emitted) {
    state.session_expired_emitted = true
    emitTelemetry('session_expired', {
      export_id: state.runId,
      t: Date.now(),
      source: 'envato',
    })
  }
}

async function finalize() {
  state.run_state = 'complete'
  // Persist terminal state before clearing the lock so a SW crash
  // between the two writes still leaves the run visible.
  await persist()
  broadcast({ type: 'state', export: snapshot() })
  broadcast({
    type: 'complete',
    ok_count: state.stats.ok_count,
    fail_count: state.stats.fail_count,
    folder_path: state.target_folder_path,
    xml_paths: [], // web app generates XMLs
  })
  emitTelemetry('export_completed', {
    export_id: state.runId,
    t: Date.now(),
    meta: {
      ok_count:         state.stats.ok_count,
      fail_count:       state.stats.fail_count,
      wall_seconds:     Math.round((Date.now() - state.started_at) / 1000),
      total_bytes:      state.stats.total_bytes_downloaded,
      reason:           'complete',
    },
  })
  await releaseKeepAwake()
  await clearActiveRunId()
  // Keep run:<runId> in storage so the popup can show "last run" —
  // cleared on next startRun via the CAS (overwrite) and the web
  // app's post-complete acknowledge.
}

async function hardStopQueue(reason) {
  state.run_state = 'cancelled'
  state.error_code = reason
  for (const it of state.items) {
    if (it.phase === 'downloading' && it.download_id != null) {
      chrome.downloads.cancel(it.download_id).catch(() => {})
    }
    if (it.phase === 'queued' || it.phase === 'resolving' || it.phase === 'licensing' || it.phase === 'downloading') {
      it.phase = 'failed'
      it.error_code = reason
    }
  }
  emitTelemetry('export_completed', {
    export_id: state.runId,
    t: Date.now(),
    meta: {
      ok_count:         state.stats.ok_count,
      fail_count:       state.stats.fail_count,
      wall_seconds:     Math.round((Date.now() - state.started_at) / 1000),
      total_bytes:      state.stats.total_bytes_downloaded,
      reason:           'hard_stop:' + reason,
    },
  })
  await persistAndBroadcast()
  await releaseKeepAwake()
  await clearActiveRunId()
}

// ------------------- keepAwake -------------------
//
// Note on SW termination: we do NOT attempt to releaseKeepAwake on
// SW shutdown. MV3 doesn't expose a termination hook, and Chrome
// automatically releases keepAwake when the extension's SW is torn
// down. If we later see the laptop stay awake after a forced SW
// shutdown, investigate — but don't add a polyfill here before
// confirming the bug is real.

async function acquireKeepAwake() {
  if (acquiredKeepAwake) return
  try {
    chrome.power.requestKeepAwake('system')
    acquiredKeepAwake = true
  } catch (err) {
    // Non-fatal; log and continue
    console.warn('[queue] keepAwake failed', err)
  }
}

async function releaseKeepAwake() {
  if (!acquiredKeepAwake) return
  try {
    chrome.power.releaseKeepAwake()
  } catch {}
  acquiredKeepAwake = false
}

// ------------------- Auto-resume -------------------
//
// Called at module-init (every SW wake) and from chrome.runtime.
// onStartup + onInstalled. Reads active_run_id, loads the persisted
// RunState, rehydrates in-memory state, reconciles any in-flight
// chrome.downloads via chrome.downloads.search, and either resumes
// the scheduler (if the run was running before SW death) or holds
// (if the run was paused — auto-resume NEVER auto-unpauses).

export async function autoResumeIfActiveRun() {
  if (state) return { resumed: false, reason: 'already_in_memory' }
  const activeId = await getActiveRunId()
  if (!activeId) return { resumed: false, reason: 'no_active_run' }
  const persisted = await loadRunState(activeId)
  if (!persisted) {
    // Lock is orphaned — clear it.
    await clearActiveRunId()
    return { resumed: false, reason: 'orphaned_lock' }
  }
  // Rehydrate in-memory state.
  state = {
    ...persisted,
    download_id_to_seq: persisted.download_id_to_seq || {},
    items: persisted.items.map(i => ({
      ...i,
      claimed: false,       // re-claimable
      __settle: null,
    })),
  }
  // Any item whose persisted phase is 'downloading' but whose
  // chrome.downloads.search returns nothing got lost during SW death —
  // roll it back to 'queued' (or 'licensing' for envato items that
  // had already been resolved/licensed) so it re-fetches JIT.
  await reconcileInFlightDownloads()
  // Respect paused state — don't auto-unpause.
  if (state.run_state === 'running') {
    await acquireKeepAwake()
    broadcast({ type: 'state', export: snapshot() })
    schedule()
  } else {
    broadcast({ type: 'state', export: snapshot() })
  }
  return { resumed: true, runId: activeId, run_state: state.run_state }
}

async function reconcileInFlightDownloads() {
  if (!state) return
  for (const item of state.items) {
    if (item.phase !== 'downloading' || item.download_id == null) continue
    // Check if the download still exists and its state.
    let results = []
    try {
      results = await chrome.downloads.search({ id: item.download_id })
    } catch {
      results = []
    }
    const d = results[0]
    if (!d) {
      // Lost — roll back.
      item.download_id = null
      item.signed_url = null // force JIT refetch
      if (item.source === 'envato' && item.resolved_uuid) {
        item.phase = 'licensing' // resolved UUID is still valid
      } else {
        item.phase = 'queued'
      }
      continue
    }
    if (d.state === 'complete') {
      item.phase = 'done'
      item.bytes_received = d.bytesReceived
      state.stats.ok_count++
      state.stats.total_bytes_downloaded += d.bytesReceived
      continue
    }
    if (d.state === 'interrupted') {
      // Treat like a fresh interrupt — NETWORK_* gets a resume,
      // FILE_* hard-stops. Surface via handleDownloadInterrupt by
      // synthesizing a delta.
      await handleDownloadInterrupt(item, { error: { current: d.error || 'UNKNOWN' } })
      continue
    }
    // state === 'in_progress' — the download survived SW death. The
    // existing chrome.downloads.onChanged listener (registered at
    // module top level) will pick up subsequent events. We re-mark
    // the item as claimed so no new worker grabs it.
    item.claimed = true
    // Re-attach a per-item settle Promise inside a fresh worker run
    // so the scheduler's bookkeeping stays correct. Simplest: spawn
    // a downloader that immediately awaits waitForDownloadSettled.
    spawnReattachedDownloader(item)
  }
  // Persist the rolled-back state before the scheduler starts pulling.
  await persist()
}

function spawnReattachedDownloader(item) {
  // Race fix (see plan "Known plan risks" §1): it is possible for the
  // chrome.downloads.onChanged event that would settle this item to
  // fire between `chrome.downloads.search` returning and this function
  // running. Since item.__settle is attached INSIDE
  // waitForDownloadSettled, any earlier listener call finds
  // item.__settle undefined and drops it — leaving the worker dangling
  // forever. Mitigation: after attaching __settle, re-check the item's
  // phase; if it's already terminal (done/failed), resolve immediately.
  active.downloading++
  ;(async () => {
    try {
      const settle = waitForDownloadSettled(item)
      // Race guard: if the onChanged listener already flipped us to
      // terminal while we were setting up, resolve now.
      if (item.phase === 'done' || item.phase === 'failed') {
        item.__settle?.()
      }
      await settle
    } finally {
      active.downloading--
      item.claimed = false
      schedule()
    }
  })()
}

// ------------------- Ext.7 verdict dispatcher + helpers -------------------

// Central dispatcher for classifier verdicts. Called from runResolver,
// runLicenser, runDownloader, and handleDownloadInterrupt. Every
// verdict terminates by calling EXACTLY ONE of failItem /
// hardStopQueue (for skip/hardStop verdicts) OR schedules a retry
// (for retry/cooldownThenRetry verdicts). Never both — see invariant
// #1 in the plan.
async function applyVerdict(item, verdict, context) {
  if (verdict.skip) {
    // Special: freepik_unconfigured sets skip_whole_source so all
    // remaining freepik items bail out at once.
    if (verdict.skip.skip_whole_source) {
      const source = verdict.skip.skip_whole_source
      for (const it of state.items) {
        if (it === item) continue
        if (it.source === source && (it.phase === 'queued' || it.phase === 'licensing' || it.phase === 'downloading')) {
          it.phase = 'failed'
          it.error_code = verdict.skip.error_code
          state.stats.fail_count++
        }
      }
      await persistAndBroadcast()
    }
    await failItem(item, verdict.skip.error_code)
    // Signal settle so the worker's Promise doesn't dangle.
    item.__settle?.()
    return
  }
  if (verdict.hardStop) {
    await failItem(item, verdict.hardStop.error_code)
    item.__settle?.()
    await hardStopQueue(verdict.hardStop.error_code)
    return
  }
  if (verdict.retry) {
    // Emit a rate_limit_hit telemetry for 429 retries (so State F has
    // visibility into retry chains).
    if (context.err?.httpStatus === 429) {
      item.rate_limit_429_count = (item.rate_limit_429_count || 0) + 1
      const retryAfterSec = parseRetryAfter(context.err?.retryAfter)
      emitTelemetry('rate_limit_hit', {
        export_id: state.runId,
        item_id: item.source_item_id,
        source: item.source,
        phase: context.phase,
        t: Date.now(),
        http_status: 429,
        retry_count: item.rate_limit_429_count,
        meta: { retry_after_sec: retryAfterSec },
      })
    }
    if (verdict.retry.use_chrome_resume) {
      // Download-phase NETWORK_* retry. The existing
      // chrome.downloads.resume path handles it; caller should have
      // routed here via handleDownloadInterrupt.
      item.retries = (item.retries || 0) + 1
      chrome.downloads.resume(item.download_id).catch(async err => {
        await failItem(item, `network_resume_failed:${err?.message}`)
        item.__settle?.()
      })
      await persistAndBroadcast()
      return
    }
    // Normal retry: sleep, reset the relevant phase, let the scheduler
    // re-pick it on the next pass.
    if (verdict.retry.delay_ms > 0) {
      await sleep(verdict.retry.delay_ms)
    }
    // Reset phase so the worker re-picks.
    if (context.phase === 'resolve') {
      item.phase = 'queued'
    } else if (context.phase === 'license') {
      item.phase = 'licensing'
    } else {
      item.phase = 'downloading'
    }
    item.claimed = false
    item.signed_url = null // force JIT refetch on retry
    await persistAndBroadcast()
    schedule()
    return
  }
  if (verdict.cooldownThenRetry) {
    // Pause the queue for the cooldown, then resume with a final-retry
    // flag on the item. If the final retry fails, the classifier's
    // next verdict will be hardStop.
    item.rate_limit_429_count = (item.rate_limit_429_count || 0) + 1
    emitTelemetry('queue_paused', {
      export_id: state.runId,
      t: Date.now(),
      meta: { reason: `${verdict.cooldownThenRetry.error_code}_cooldown` },
    })
    state.run_state = 'paused'
    await persistAndBroadcast()
    setTimeout(async () => {
      if (!state || state.run_state !== 'paused') return
      // Resume only if we're still the same run.
      state.run_state = 'running'
      item.phase = context.phase === 'resolve' ? 'queued'
                  : context.phase === 'license' ? 'licensing'
                  : 'downloading'
      item.claimed = false
      item.signed_url = null
      await persistAndBroadcast()
      emitTelemetry('queue_resumed', { export_id: state.runId, t: Date.now() })
      schedule()
    }, verdict.cooldownThenRetry.cooldown_ms)
    return
  }
  // Unknown verdict — defensive skip.
  await failItem(item, 'unknown_verdict')
  item.__settle?.()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// Ext.7: 24h-deduped Slack-alert emitter for deny-list hits.
// Persists markAlertEmitted BEFORE the emit so a SW death between the
// two doesn't double-alert on next wake.
async function maybeEmitDenyAlert(item, errorCode, detail) {
  try {
    const should = await shouldAlertForDeny(item.source, item.source_item_id, errorCode)
    if (!should) return
    await markAlertEmitted(item.source, item.source_item_id, errorCode)
    emitTelemetry('item_failed', {
      export_id: state.runId,
      item_id: item.source_item_id,
      source: item.source,
      phase: 'license',
      t: Date.now(),
      error_code: errorCode,
      retry_count: 0,
      meta: { alert: true, detail, filename: detail },
    })
  } catch (err) {
    console.warn('[queue] maybeEmitDenyAlert failed', err)
  }
}

// Ext.7: Parse the CDN filename out of an AWS-flavored signed URL.
// Mirrors the private copy in envato.js so the pool-path license
// worker can run the same ZIP/AEP/PRPROJ safety net without a
// cross-module import. Future refactor: hoist to a shared util.
const QUEUE_CONTENT_DISPOSITION_RE = /response-content-disposition=([^&]+)/
const QUEUE_FILENAME_FROM_DISPOSITION_RE = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i

function extractFilenameFromSignedUrl(url) {
  if (typeof url !== 'string' || !url.length) return null
  const dispMatch = QUEUE_CONTENT_DISPOSITION_RE.exec(url)
  if (!dispMatch) return null
  let disposition
  try {
    disposition = decodeURIComponent(dispMatch[1])
  } catch {
    return null
  }
  const nameMatch = QUEUE_FILENAME_FROM_DISPOSITION_RE.exec(disposition)
  return nameMatch ? nameMatch[1] : null
}
