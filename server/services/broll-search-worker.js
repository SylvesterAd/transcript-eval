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

// Restart / transport failures are transient: the GPU proxy pipeline is
// SSE-driven and can't resume a job whose process it dropped (a redeploy marks
// the orphaned job "process likely restarted"; a dropped connection surfaces as
// a transport error). Such a placement must be retried from the queue — but a
// proxy redeploy outage can last several minutes, so we must NOT burn all
// MAX_RETRIES instantly. Instead of hard-failing, we leave the row 'running'
// and let reclaimerSweep re-enqueue it after STUCK_THRESHOLD_MIN (bounded by
// MAX_RETRIES) — reusing the existing, spaced-out, capped retry path. Genuine
// failures (no candidates, GPU unhealthy, code errors) do NOT match and still
// fail immediately.
const TRANSIENT_GPU_ERROR_RE =
  /process likely restarted|stale job|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|other side closed|\bterminated\b|Bad Gateway|Service Unavailable|Gateway Time-?out|(?:status(?:\s*code)?|HTTP)\s*50[234]/i

export function isTransientGpuFailure(message) {
  return !!message && TRANSIENT_GPU_ERROR_RE.test(String(message))
}

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

    const { abortedBrollPipelines } = await import('./broll.js')
    if (abortedBrollPipelines.has(row.batch_id)) {
      await db.pool.query(`
      UPDATE broll_searches
      SET status='stopped', error='Stopped by user', completed_at=NOW()
      WHERE id=$1
    `, [row.id])
      setImmediate(drainLoop)
      return
    }

    const claim = await db.pool.query(`
      UPDATE broll_searches
      SET status='running', started_at=NOW()
      WHERE id=$1 AND status='waiting'
    `, [row.id])
    if (claim.rowCount === 0) { setImmediate(drainLoop); return }

    const { searchSinglePlacement, searchUserPlacement } = await import('./broll.js')
    try {
      let result
      if (row.placement_uuid && row.placement_uuid.startsWith('up-')) {
        const userPlacementId = row.placement_uuid.slice(3)
        result = await searchUserPlacement(row.plan_pipeline_id, userPlacementId)
      } else {
        result = await searchSinglePlacement(row.plan_pipeline_id, {
          placementUuid: row.placement_uuid,
          chapterIndex: row.chapter_index,
          placementIndex: row.placement_index,
        })
      }
      if (result.gpuJobStatus === 'failed' && isTransientGpuFailure(result.error)) {
        // Proxy restarted / dropped this job mid-flight. Leave the row 'running'
        // so reclaimerSweep re-enqueues it after STUCK_THRESHOLD_MIN (capped at
        // MAX_RETRIES) — see isTransientGpuFailure note above.
        console.warn(`[broll-worker] row ${row.id} transient GPU failure ("${result.error}") — left running for reclaimer retry`)
      } else {
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
      }
    } catch (err) {
      if (isTransientGpuFailure(err.message)) {
        // Transport-level drop during a proxy restart — leave 'running' for
        // reclaimerSweep (see isTransientGpuFailure note above).
        console.warn(`[broll-worker] row ${row.id} transient error ("${err.message}") — left running for reclaimer retry`)
      } else {
        console.error(`[broll-worker] search failed for row ${row.id}: ${err.message}`)
        await db.pool.query(`
      UPDATE broll_searches
      SET status='failed', error=$1, api_log_id=$2, completed_at=NOW()
      WHERE id=$3
    `, [err.message, err.apiLogId || null, row.id])
      }
    }
    setImmediate(drainLoop)
  } catch (err) {
    console.error('[broll-worker] drainLoop error:', err.message)
    drainTimer = setTimeout(drainLoop, ERROR_RETRY_MS)
  }
}

async function reclaimerSweep() {
  if (stopping) return
  const { rows: stuck } = await db.pool.query(`
    SELECT id, retry_count FROM broll_searches
    WHERE status='running' AND started_at < NOW() - INTERVAL '${STUCK_THRESHOLD_MIN} minutes'
  `)
  for (const r of stuck) {
    if (r.retry_count >= MAX_RETRIES) {
      await db.pool.query(`
        UPDATE broll_searches
        SET status='failed', error='reclaimed: stuck after ${MAX_RETRIES} retries', completed_at=NOW()
        WHERE id=$1
      `, [r.id])
      console.warn(`[broll-worker] row ${r.id} failed permanently after ${MAX_RETRIES} retries`)
      continue
    }
    await db.pool.query(`
      UPDATE broll_searches
      SET status='waiting', retry_count=retry_count+1,
          started_at=NULL,
          api_log_id=NULL, error=NULL, results_json=NULL,
          num_results=0, duration_ms=NULL
      WHERE id=$1
    `, [r.id])
    console.log(`[broll-worker] reclaimed row ${r.id} (retry ${r.retry_count + 1}/${MAX_RETRIES})`)
  }
}

// Test export — bypass module-level state for direct testing
export { reclaimerSweep }

// Test helper — resets module-level state so tests can re-init.
export function _resetForTest() {
  stopping = false
  lockAcquired = false
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
  if (reclaimerTimer) { clearInterval(reclaimerTimer); reclaimerTimer = null }
}
