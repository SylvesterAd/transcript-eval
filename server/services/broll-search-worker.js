// Single-process GPU search worker. Acquires a Postgres advisory lock so only
// one instance across the cluster runs the drain loop. All API routes that
// trigger b-roll searches enqueue rows in broll_searches; this loop is the
// sole caller of searchSinglePlacement for queued work.
//
// Spec: docs/superpowers/specs/2026-04-30-broll-search-queue-design.md

import db from '../db.js'

const WORKER_KEY = '4774063583137677164'  // arbitrary stable 64-bit constant
const EMPTY_QUEUE_POLL_MS = 1000
const LOCK_RETRY_MS = 30_000
const RECLAIMER_INTERVAL_MS = 120_000
const STUCK_THRESHOLD_MIN = 20
const MAX_RETRIES = 3

let stopping = false
let lockAcquired = false
let drainTimer = null
let reclaimerTimer = null

export async function startWorker() {
  if (stopping) return
  const result = await db.pool.query('SELECT pg_try_advisory_lock($1::bigint) AS got', [WORKER_KEY])
  if (!result.rows[0].got) {
    console.log('[broll-worker] another instance holds the lock — staying idle')
    drainTimer = setTimeout(startWorker, LOCK_RETRY_MS)
    return
  }
  lockAcquired = true
  console.log('[broll-worker] lock acquired, starting drain loop')
  setImmediate(drainLoop)
  reclaimerTimer = setInterval(() => { reclaimerSweep().catch(err => console.error('[broll-worker] reclaimer error:', err.message)) }, RECLAIMER_INTERVAL_MS)
}

export async function stopWorker() {
  stopping = true
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
  if (reclaimerTimer) { clearInterval(reclaimerTimer); reclaimerTimer = null }
  if (lockAcquired) {
    try {
      await db.pool.query('SELECT pg_advisory_unlock($1::bigint)', [WORKER_KEY])
    } catch (err) {
      console.warn('[broll-worker] unlock failed:', err.message)
    }
    lockAcquired = false
  }
}

async function drainLoop() {
  // Implemented in Task 3.
}

async function reclaimerSweep() {
  // Implemented in Task 7.
}

// Test helper — resets module-level state so tests can re-init.
export function _resetForTest() {
  stopping = false
  lockAcquired = false
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
  if (reclaimerTimer) { clearInterval(reclaimerTimer); reclaimerTimer = null }
}
