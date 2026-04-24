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
  // 1. Check lock (Task 8 wires the real storage-backed version;
  // this in-memory guard is the Phase-1 placeholder).
  if (state && state.run_state === 'running') {
    return { ok: false, reason: 'run_already_active', active_run_id: state.runId }
  }
  // 2. Build initial RunState
  state = buildInitialRunState({ runId, manifest, targetFolder, options, userId })
  // 3. Acquire keepAwake
  await acquireKeepAwake()
  // 4. Broadcast initial state
  broadcast({ type: 'state', export: snapshot() })
  // 5. Kick worker pools
  schedule()
  return { ok: true, runId }
}

export async function pauseRun() {
  if (!state || state.run_state !== 'running') return { ok: false }
  state.run_state = 'paused'
  await releaseKeepAwake()
  broadcast({ type: 'state', export: snapshot() })
  return { ok: true }
}

export async function resumeRun() {
  if (!state || state.run_state !== 'paused') return { ok: false }
  state.run_state = 'running'
  await acquireKeepAwake()
  broadcast({ type: 'state', export: snapshot() })
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
  broadcast({ type: 'state', export: snapshot() })
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
  if (everyoneDone) finalize()
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
  broadcastItemTransition(item)
  try {
    const uuid = await resolveOldIdToNewUuid(item.envato_item_url)
    item.resolved_uuid = uuid
    item.phase = 'licensing'
    item.claimed = false
    broadcastItemTransition(item)
  } catch (err) {
    failItem(item, err?.message || 'resolve_failed')
  }
}

async function runLicenser(item) {
  item.claimed = true
  // item.phase is already 'licensing'
  broadcastItemTransition(item)
  try {
    // JIT URL fetching: we're milliseconds away from chrome.downloads.download
    const signedUrl = await getSignedDownloadUrl(item.resolved_uuid)
    item.signed_url = signedUrl
    item.phase = 'downloading'
    item.claimed = false
    broadcastItemTransition(item)
  } catch (err) {
    failItem(item, err?.message || 'license_failed')
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
    broadcastItemTransition(item)
    // The rest happens via chrome.downloads.onChanged — we return
    // and let the listener finalize the item on 'complete' or
    // 'interrupted'. The worker's Promise resolves when the listener
    // flips phase to 'done' or 'failed' (we hand-resolve via a per-
    // item awaiter).
    await waitForDownloadSettled(item)
    item.claimed = false
  } catch (err) {
    failItem(item, err?.message || 'download_failed')
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
  handleDownloadEvent(item, delta)
})

function handleDownloadEvent(item, delta) {
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
      broadcastItemTransition(item)
      broadcast({ type: 'item_done', item_id: item.source_item_id, result: 'ok' })
      item.__settle?.()
    } else if (next === 'interrupted') {
      handleDownloadInterrupt(item, delta)
    }
  }
}

function handleDownloadInterrupt(item, delta) {
  const reason = delta.error?.current || 'UNKNOWN'
  if (reason.startsWith('NETWORK_')) {
    if (item.retries < DOWNLOAD_NETWORK_RETRY_CAP) {
      item.retries++
      chrome.downloads.resume(item.download_id).catch(err => {
        failItem(item, `network_resume_failed:${err?.message}`)
        item.__settle?.()
      })
      broadcastItemTransition(item)
      return
    }
    failItem(item, 'network_failed')
    item.__settle?.()
  } else if (reason.startsWith('FILE_')) {
    // Disk is broken — hard stop the whole queue.
    failItem(item, `disk_failed:${reason}`)
    item.__settle?.()
    hardStopQueue('disk_failed')
  } else if (reason === 'USER_CANCELED') {
    failItem(item, 'cancelled')
    item.__settle?.()
  } else {
    failItem(item, `download_interrupt:${reason}`)
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

function broadcastItemTransition(_item) {
  broadcast({ type: 'state', export: snapshot() })
}

function failItem(item, errorCode) {
  item.phase = 'failed'
  item.error_code = errorCode
  item.claimed = false
  state.stats.fail_count++
  broadcastItemTransition(item)
  broadcast({ type: 'item_done', item_id: item.source_item_id, result: 'failed' })
}

function finalize() {
  state.run_state = 'complete'
  broadcast({
    type: 'complete',
    ok_count: state.stats.ok_count,
    fail_count: state.stats.fail_count,
    folder_path: state.target_folder_path,
    xml_paths: [], // web app generates XMLs
  })
  releaseKeepAwake()
  // Don't null `state` — keep for {type:"status"} inspection until
  // next startRun clears it. Task 8 also saves state here and clears
  // active_run_id.
}

function hardStopQueue(reason) {
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
  broadcast({ type: 'state', export: snapshot() })
  releaseKeepAwake()
}

// ------------------- keepAwake -------------------

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

// ------------------- Auto-resume stub (real impl in Task 9) -------------------

export async function autoResumeIfActiveRun() {
  // Task 9 fills this in.
  return { resumed: false }
}
