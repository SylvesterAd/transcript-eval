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
} from '../config.js'
import { resolveOldIdToNewUuid, getSignedDownloadUrl } from './envato.js'
import { fetchPexelsUrl, fetchFreepikUrl } from './sources.js'
import { broadcastToPort } from './port.js'
import {
  saveRunState, loadRunState, deleteRunState,
  getActiveRunId, setActiveRunId, clearActiveRunId,
  markCompleted,
} from './storage.js'

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
    return data?.url
  }
  if (source === 'freepik') {
    const data = await fetchFreepikUrl({ itemId })
    return data?.url
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

export async function startRun({ runId, manifest, targetFolder, options, userId }) {
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
  // 7. Kick worker pools
  schedule()
  return { ok: true, runId }
}

export async function pauseRun() {
  if (!state || state.run_state !== 'running') return { ok: false }
  state.run_state = 'paused'
  await releaseKeepAwake()
  await persistAndBroadcast()
  return { ok: true }
}

export async function resumeRun() {
  if (!state || state.run_state !== 'paused') return { ok: false }
  state.run_state = 'running'
  await acquireKeepAwake()
  await persistAndBroadcast()
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
  await persistAndBroadcast()
  try {
    const uuid = await resolveOldIdToNewUuid(item.envato_item_url)
    item.resolved_uuid = uuid
    item.phase = 'licensing'
    item.claimed = false
    await persistAndBroadcast()
  } catch (err) {
    await failItem(item, err?.message || 'resolve_failed')
  }
}

async function runLicenser(item) {
  item.claimed = true
  // item.phase is already 'licensing'
  await persistAndBroadcast()
  try {
    // JIT URL fetching: we're milliseconds away from chrome.downloads.download
    const signedUrl = await getSignedDownloadUrl(item.resolved_uuid)
    item.signed_url = signedUrl
    item.phase = 'downloading'
    item.claimed = false
    await persistAndBroadcast()
  } catch (err) {
    await failItem(item, err?.message || 'license_failed')
  }
}

async function runDownloader(item) {
  item.claimed = true
  // item.phase is 'downloading' already
  try {
    // JIT URL fetch for Pexels/Freepik (they skip resolving/licensing)
    if (item.source !== 'envato' && !item.signed_url) {
      item.signed_url = await getSignedUrlForSource(item.source, item.source_item_id)
    }
    const downloadId = await chrome.downloads.download({
      url: item.signed_url,
      filename: `${state.target_folder_path}/${item.target_filename}`,
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
  if (reason.startsWith('NETWORK_')) {
    if (item.retries < DOWNLOAD_NETWORK_RETRY_CAP) {
      item.retries++
      chrome.downloads.resume(item.download_id).catch(async err => {
        await failItem(item, `network_resume_failed:${err?.message}`)
        item.__settle?.()
      })
      await persistAndBroadcast()
      return
    }
    await failItem(item, 'network_failed')
    item.__settle?.()
  } else if (reason.startsWith('FILE_')) {
    // Disk is broken — hard stop the whole queue.
    await failItem(item, `disk_failed:${reason}`)
    item.__settle?.()
    await hardStopQueue('disk_failed')
  } else if (reason === 'USER_CANCELED') {
    await failItem(item, 'cancelled')
    item.__settle?.()
  } else {
    await failItem(item, `download_interrupt:${reason}`)
    item.__settle?.()
  }
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

function buildInitialRunState({ runId, manifest, targetFolder, options, userId }) {
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
      signed_url: null,
      claimed: false,
    })),
    stats: { ok_count: 0, fail_count: 0, total_bytes_downloaded: 0 },
    run_state: 'running',
    download_id_to_seq: {},
    userId, // for storage.markCompleted wiring in Task 8
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
  item.phase = 'failed'
  item.error_code = errorCode
  item.claimed = false
  state.stats.fail_count++
  await persistAndBroadcast()
  broadcast({ type: 'item_done', item_id: item.source_item_id, result: 'failed' })
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
