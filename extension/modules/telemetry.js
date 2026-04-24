// Ext.6 telemetry — /api/export-events emitter with offline queue +
// exponential-backoff retry.
//
// This module is the singleton owner of the telemetry buffer + flush
// loop. MV3 SW termination means the in-memory ring buffer is LOST on
// shutdown unless persisted — we use storage as the source of truth
// and treat the in-memory buffer as a write-through cache.
//
// Public API:
//   emit(event, payload)          — fire-and-forget; synchronous accept
//   flushNow()                    — force one flush attempt (Task 3)
//   pauseForAuthRefresh()         — auth.js calls on 401 (Task 3)
//   resumeAfterAuthRefresh()      — auth.js calls after refresh (Task 3)
//   getBufferStats()              — {buffer_size, queue_size,
//                                   paused_for_auth, overflow_total}
//
// See docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md
// for the full invariants — specifically:
//   #1  MV3 SW termination means persist-before-flush
//   #4  TELEMETRY_EVENT_ENUM client-side drift assert
//   #6  meta size cap (4 KB server-side; client belt-and-braces)
//   #8  emit is fire-and-forget

import {
  TELEMETRY_BUFFER_SIZE,
  TELEMETRY_MAX_QUEUE_SIZE,
  TELEMETRY_EVENT_ENUM,
  TELEMETRY_RETRY_BASE_MS,
  TELEMETRY_RETRY_MAX_MS,
  TELEMETRY_RETRY_JITTER,
  TELEMETRY_FLUSH_INTERVAL_MS,
  BACKEND_URL,
} from '../config.js'
import { attachBearer, onSessionRefreshed } from './auth.js'

const STORAGE_KEY_QUEUE = 'telemetry_queue'
const STORAGE_KEY_OVERFLOW_TOTAL = 'telemetry_overflow_total'
const META_SOFT_CAP_BYTES = 4096

// In-memory ring buffer. Writes are the happy-path fast lane; the
// flush loop drains both the ring AND the persisted queue, unifying
// them before POSTing.
const ring = []

// Drift-check allowed-event set, derived once.
const ALLOWED = new Set(TELEMETRY_EVENT_ENUM)

// ------------------- Public API -------------------

export function emit(event, payload) {
  // Invariant #4: drift assert. Unknown events are dropped with a
  // warn, not thrown — a typo here must not crash the queue worker.
  if (!ALLOWED.has(event)) {
    console.warn('[telemetry] unknown event dropped:', event)
    return
  }
  const entry = buildEntry(event, payload)
  if (entry == null) return  // buildEntry rejected (e.g. missing export_id)

  // Ring buffer: fast path. If the ring is full, shift the oldest into
  // persistence before appending the new one.
  if (ring.length >= TELEMETRY_BUFFER_SIZE) {
    const shifted = ring.shift()
    persistAppend(shifted).catch(err => {
      console.warn('[telemetry] persist on ring shift failed', err)
    })
  }
  ring.push(entry)

  // Fire-and-forget persist. Even happy-path events are persisted so a
  // SW termination between ring enqueue and flush-success doesn't lose
  // them. The flush loop dedupes ring+persisted before POSTing.
  persistAppend(entry).catch(err => {
    console.warn('[telemetry] persistAppend failed', err)
  })
}

export async function getBufferStats() {
  const { [STORAGE_KEY_QUEUE]: queue, [STORAGE_KEY_OVERFLOW_TOTAL]: overflow } =
    await chrome.storage.local.get([STORAGE_KEY_QUEUE, STORAGE_KEY_OVERFLOW_TOTAL])
  return {
    buffer_size: ring.length,
    queue_size: Array.isArray(queue) ? queue.length : 0,
    paused_for_auth: pausedForAuth,
    overflow_total: overflow || 0,
  }
}

// ------------------- Internals -------------------

function buildEntry(event, payload) {
  const p = payload || {}
  if (!p.export_id || typeof p.export_id !== 'string') {
    console.warn('[telemetry] dropping event with no export_id:', event, p)
    return null
  }
  // Shape per extension spec § "Request/response shapes".
  const entry = {
    export_id:   p.export_id,
    event,
    t:           typeof p.t === 'number' ? p.t : Date.now(),
  }
  if (p.item_id != null)     entry.item_id     = String(p.item_id)
  if (p.source != null)      entry.source      = p.source
  if (p.phase != null)       entry.phase       = p.phase
  if (p.error_code != null)  entry.error_code  = p.error_code
  if (p.http_status != null) entry.http_status = p.http_status
  if (p.retry_count != null) entry.retry_count = p.retry_count
  if (p.meta != null) {
    // Invariant #6 belt-and-braces: server rejects >4 KB meta with a
    // 400; that would loop the retry. Drop oversized meta with a warn
    // but keep the event — the backend accepts meta: null.
    try {
      const serialized = JSON.stringify(p.meta)
      if (new Blob([serialized]).size > META_SOFT_CAP_BYTES) {
        console.warn('[telemetry] meta too large, dropping from event:', event)
      } else {
        entry.meta = p.meta
      }
    } catch (err) {
      console.warn('[telemetry] meta not serializable, dropping:', err)
    }
  }
  return entry
}

async function persistAppend(entry) {
  const { [STORAGE_KEY_QUEUE]: existing } = await chrome.storage.local.get(STORAGE_KEY_QUEUE)
  const queue = Array.isArray(existing) ? existing : []

  // Hard cap with oldest-drop (spec: 500).
  let droppedThisCall = 0
  while (queue.length >= TELEMETRY_MAX_QUEUE_SIZE) {
    queue.shift()
    droppedThisCall++
  }
  queue.push(entry)

  const updates = { [STORAGE_KEY_QUEUE]: queue }
  if (droppedThisCall > 0) {
    const { [STORAGE_KEY_OVERFLOW_TOTAL]: prev } = await chrome.storage.local.get(STORAGE_KEY_OVERFLOW_TOTAL)
    updates[STORAGE_KEY_OVERFLOW_TOTAL] = (prev || 0) + droppedThisCall
    console.warn('[telemetry] queue overflow — dropped', droppedThisCall, 'oldest events')
  }
  await chrome.storage.local.set(updates)
}

// Exposed for Task 3's flush loop — reads the full persisted queue so
// the flush can drain in-order.
export async function _readPersistedQueue() {
  const { [STORAGE_KEY_QUEUE]: existing } = await chrome.storage.local.get(STORAGE_KEY_QUEUE)
  return Array.isArray(existing) ? existing : []
}

// Exposed for Task 3's flush loop — removes N events from the front
// after a successful 202 batch.
export async function _dropFromFrontOfQueue(count) {
  if (count <= 0) return
  const { [STORAGE_KEY_QUEUE]: existing } = await chrome.storage.local.get(STORAGE_KEY_QUEUE)
  const queue = Array.isArray(existing) ? existing : []
  queue.splice(0, count)
  await chrome.storage.local.set({ [STORAGE_KEY_QUEUE]: queue })
}

// Exposed for Task 3 — re-enqueue at the FRONT (used on 401 when the
// in-flight event goes back so it flushes first after refresh).
export async function _unshiftToQueue(entry) {
  const { [STORAGE_KEY_QUEUE]: existing } = await chrome.storage.local.get(STORAGE_KEY_QUEUE)
  const queue = Array.isArray(existing) ? existing : []
  queue.unshift(entry)
  await chrome.storage.local.set({ [STORAGE_KEY_QUEUE]: queue })
}

// ------------------- Error-code normalization -------------------
//
// The extension spec pins 15 error_code values for item_failed
// telemetry. Ext.5's queue records free-form strings
// (resolve_failed, download_failed, network_failed, disk_failed:<reason>,
// cancelled, download_interrupt:<reason>, network_resume_failed:<msg>,
// etc.). Ext.6 maps those strings into the enum at emit time;
// unmappable raw strings normalize to null. Ext.7's failure-matrix
// work will push the raw strings into well-known branches — this
// mapper then becomes lossless.

const ERROR_CODE_ENUM = Object.freeze([
  'envato_403',
  'envato_402_tier',
  'envato_429',
  'envato_session_401',
  'envato_unavailable',
  'envato_unsupported_filetype',
  'freepik_404',
  'freepik_429',
  'freepik_unconfigured',
  'pexels_404',
  'network_failed',
  'disk_failed',
  'integrity_failed',
  'resolve_failed',
  'url_expired_refetch_failed',
])
const ERROR_CODE_SET = new Set(ERROR_CODE_ENUM)

export function normalizeErrorCode(raw) {
  if (raw == null) return null
  const s = String(raw)
  // Direct hit.
  if (ERROR_CODE_SET.has(s)) return s
  // Prefix matches for the colon-separated variants Ext.5's queue
  // produces (e.g. "disk_failed:FILE_ACCESS_DENIED",
  // "download_interrupt:SERVER_UNAUTHORIZED", "network_resume_failed:<msg>").
  const beforeColon = s.split(':', 1)[0]
  if (ERROR_CODE_SET.has(beforeColon)) return beforeColon

  // Ext.5's legacy raw-string mappings (pre-Ext.7 classifier).
  if (beforeColon === 'download_interrupt') return 'network_failed'
  if (beforeColon === 'network_resume_failed') return 'network_failed'
  if (beforeColon === 'license_failed') return 'envato_unavailable'
  if (beforeColon === 'download_failed') return null

  // Ext.7 additions — classifier may still pass through some raw codes
  // via failItem (e.g. envato_http_500, envato_session_missing,
  // pexels_daily_cap_exceeded).
  if (s === 'envato_session_missing') return 'envato_session_401'
  if (s === 'envato_session_missing_preflight') return 'envato_session_401'
  if (s === 'envato_preflight_error') return 'envato_unavailable'
  if (s === 'envato_402') return 'envato_402_tier'
  if (s.startsWith('envato_http_5')) return 'envato_unavailable'
  if (s.startsWith('envato_http_4')) return 'envato_unavailable'  // 4xx that aren't 401/402/403/429
  if (s === 'freepik_url_expired') return 'url_expired_refetch_failed'
  if (s.endsWith('_daily_cap_exceeded')) return null  // no matching enum entry; raw in meta.raw_error
  if (s === 'unknown_verdict') return null
  if (s === 'cancelled') return null  // user-cancelled isn't in the enum; null + raw
  if (s === 'resolve_timeout') return 'resolve_failed'
  if (s === 'resolve_error') return 'resolve_failed'
  if (s === 'bad_input') return null

  // Unknown — return null so the event still posts; the raw string
  // lives in meta.raw_error for admin triage.
  return null
}

export { ERROR_CODE_ENUM }

// ------------------- Flush loop -------------------

// State for the flush loop. All module-scoped so SW restarts reset
// (we rely on persistence for correctness, not flush-loop state).
let pausedForAuth = false
let flushInFlight = false
let nextBackoffMs = TELEMETRY_RETRY_BASE_MS
let flushIntervalHandle = null

// Kick a background loop that tries to flush every
// TELEMETRY_FLUSH_INTERVAL_MS. The loop is a no-op when the persisted
// queue is empty. When there's work to do, we drain eagerly until
// empty or until a failure pauses us.
function ensureFlushLoopRunning() {
  if (flushIntervalHandle != null) return
  flushIntervalHandle = setInterval(() => {
    flushNow().catch(err => {
      console.warn('[telemetry] flush loop error', err)
    })
  }, TELEMETRY_FLUSH_INTERVAL_MS)
}

// Stop the loop — used only in tests to prevent timers leaking.
// Unused in the real SW (the SW terminates and restarts, which
// naturally clears the interval).
function stopFlushLoop() {
  if (flushIntervalHandle != null) {
    clearInterval(flushIntervalHandle)
    flushIntervalHandle = null
  }
}

export async function flushNow() {
  if (flushInFlight) return
  if (pausedForAuth) return
  flushInFlight = true
  try {
    const queue = await _readPersistedQueue()
    if (queue.length === 0) return
    // Drain eagerly: pop a batch, POST, repeat until empty or failure.
    // We POST one event per request per the spec's schema (the endpoint
    // accepts a single event; no bulk shape defined). Concurrency: 1.
    while (queue.length > 0) {
      if (pausedForAuth) return
      const entry = queue[0]
      const result = await postSingleEvent(entry)
      if (result.ok) {
        await _dropFromFrontOfQueue(1)
        queue.shift()
        nextBackoffMs = TELEMETRY_RETRY_BASE_MS
      } else if (result.pauseForAuth) {
        // 401 — leave the entry at the front, set the pause flag. The
        // auth-refreshed callback resumes us.
        pausedForAuth = true
        console.warn('[telemetry] paused for auth refresh')
        return
      } else if (result.dropEvent) {
        // 400 from the backend — the event shape is wrong. Drop it
        // rather than loop forever on a permanent failure. This is a
        // DEVELOPMENT bug signal, not a production one (the enum
        // check in emit() should prevent 400s in production).
        console.warn('[telemetry] dropping bad event after 400:', entry, result.detail)
        await _dropFromFrontOfQueue(1)
        queue.shift()
      } else {
        // Transient (5xx / network / timeout). Back off and return —
        // the flush loop's next tick retries.
        await sleep(jittered(nextBackoffMs))
        nextBackoffMs = Math.min(nextBackoffMs * 2, TELEMETRY_RETRY_MAX_MS)
        return
      }
    }
  } finally {
    flushInFlight = false
  }
}

async function postSingleEvent(entry) {
  const headers = { 'Content-Type': 'application/json' }
  try {
    await attachBearer(headers)
  } catch (err) {
    // No JWT — treat as "pause for auth" so the loop sleeps until
    // auth comes back. Same code path as 401.
    return { ok: false, pauseForAuth: true, detail: 'no_jwt' }
  }
  if (!headers['Authorization']) {
    return { ok: false, pauseForAuth: true, detail: 'no_jwt' }
  }
  let resp
  try {
    resp = await fetch(BACKEND_URL + '/api/export-events', {
      method: 'POST',
      headers,
      body: JSON.stringify(entry),
    })
  } catch (err) {
    // Network error — transient, back off.
    return { ok: false, transient: true, detail: String(err?.message || err) }
  }
  if (resp.status === 202 || resp.status === 200) return { ok: true }
  if (resp.status === 401) return { ok: false, pauseForAuth: true, detail: 'http_401' }
  if (resp.status >= 400 && resp.status < 500) {
    // 400 / 404 / 403 / 429 — all but 429 indicate a bad client-side
    // request. 429 we treat as transient. The backend does not
    // currently 429 on this endpoint, but be defensive.
    if (resp.status === 429) return { ok: false, transient: true, detail: 'http_429' }
    return { ok: false, dropEvent: true, detail: 'http_' + resp.status }
  }
  // 5xx — transient.
  return { ok: false, transient: true, detail: 'http_' + resp.status }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function jittered(ms) {
  const j = ms * TELEMETRY_RETRY_JITTER
  return Math.floor(ms + (Math.random() * 2 - 1) * j)
}

// ------------------- Auth-refresh integration -------------------

export function pauseForAuthRefresh() {
  pausedForAuth = true
}

export function resumeAfterAuthRefresh() {
  pausedForAuth = false
  // Eager drain on resume — don't wait for the next interval tick.
  flushNow().catch(err => console.warn('[telemetry] post-refresh flush error', err))
}

// Subscribe to auth.js's session-refreshed event so the pause unwinds
// automatically when the queue's Port-driven refresh completes.
try {
  onSessionRefreshed(() => resumeAfterAuthRefresh())
} catch (err) {
  // auth.js may not have onSessionRefreshed yet (during Task 3's
  // transient import gap — see plan rationale). Log and continue;
  // Task 5 lands the real onSessionRefreshed.
  console.warn('[telemetry] onSessionRefreshed subscribe deferred:', err?.message)
}

// Bootstrap: start the flush loop on module load. The SW wakes, imports
// this module, and the loop begins. Pending events from the previous
// SW incarnation drain on the first tick.
ensureFlushLoopRunning()
// Also try an immediate drain — events queued from a just-concluded
// cancelled run should flush within seconds of the SW waking up.
flushNow().catch(err => console.warn('[telemetry] initial flush error', err))
