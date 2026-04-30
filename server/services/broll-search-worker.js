// Single-process GPU search worker. Acquires a Postgres advisory lock so only
// one instance across the cluster runs the drain loop. All API routes that
// trigger b-roll searches enqueue rows in broll_searches; this loop is the
// sole caller of searchSinglePlacement for queued work.
//
// Spec: docs/superpowers/specs/2026-04-30-broll-search-queue-design.md

import db from '../db.js'

const WORKER_KEY = '4774063583137677164'  // arbitrary stable 64-bit constant
const EMPTY_QUEUE_POLL_MS = 1000
const ERROR_RETRY_MS = 5000
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
  if (stopping) return
  try {
    const { rows } = await db.pool.query(`
      SELECT id, plan_pipeline_id, placement_uuid, chapter_index, placement_index, batch_id
      FROM broll_searches
      WHERE status = 'waiting'
      ORDER BY id
      LIMIT 1
    `)
    if (!rows.length) {
      drainTimer = setTimeout(drainLoop, EMPTY_QUEUE_POLL_MS)
      return
    }
    const row = rows[0]
    const claim = await db.pool.query(`
      UPDATE broll_searches
      SET status='running', started_at=NOW()
      WHERE id=$1 AND status='waiting'
    `, [row.id])
    if (claim.rowCount === 0) { setImmediate(drainLoop); return }

    const { searchSinglePlacement } = await import('./broll.js')
    try {
      const result = await searchSinglePlacement(row.plan_pipeline_id, {
        placementUuid: row.placement_uuid,
        chapterIndex: row.chapter_index,
        placementIndex: row.placement_index,
      })
      const status = result.gpuJobStatus === 'running' ? 'timeout'
                   : result.gpuJobStatus === 'failed'  ? 'failed'
                   : 'complete'
      await db.pool.query(`
      UPDATE broll_searches
      SET status=$1, results_json=$2, num_results=$3, duration_ms=$4,
          api_log_id=$5, error=$6, completed_at=NOW()
      WHERE id=$7
    `, [
        status,
        JSON.stringify(result.results || []),
        (result.results || []).length,
        result.duration || null,
        result.apiLogId || null,
        result.error || null,
        row.id,
      ])
    } catch (err) {
      // Catch path — implemented in Task 5.
      console.error('[broll-worker] (catch path TODO):', err.message)
    }
    setImmediate(drainLoop)
  } catch (err) {
    console.error('[broll-worker] drainLoop error:', err.message)
    drainTimer = setTimeout(drainLoop, ERROR_RETRY_MS)
  }
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
