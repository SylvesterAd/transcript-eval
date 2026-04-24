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
} from '../config.js'

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

export async function flushNow() {
  // Task 3 fills this in.
}

export function pauseForAuthRefresh() {
  // Task 3 fills this in.
}

export function resumeAfterAuthRefresh() {
  // Task 3 fills this in.
}

export async function getBufferStats() {
  const { [STORAGE_KEY_QUEUE]: queue, [STORAGE_KEY_OVERFLOW_TOTAL]: overflow } =
    await chrome.storage.local.get([STORAGE_KEY_QUEUE, STORAGE_KEY_OVERFLOW_TOTAL])
  return {
    buffer_size: ring.length,
    queue_size: Array.isArray(queue) ? queue.length : 0,
    paused_for_auth: false, // Task 3 wires this up
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
