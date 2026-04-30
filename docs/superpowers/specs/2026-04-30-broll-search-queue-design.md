# B-Roll Search Queue — Design Spec

**Date:** 2026-04-30
**Status:** Approved by user, ready for implementation plan
**Branch:** `feature/broll-search-queue`

## Problem

Two concurrent bugs observed in production `broll_searches` table:

1. **Lost `api_log_id` on failed rows.** Rows with `status='failed'` set by the Phase 3 catch path in `executeSearchBatch` ([broll.js:2261-2264](server/services/broll.js#L2261)) never persist `api_log_id`, even when the thrown error carries `err.apiLogId`. Forensic linkage to the actual GPU response is lost.
2. **Concurrent GPU calls for the same row.** Phase 0 of `executeSearchBatch` ([broll.js:2102-2116](server/services/broll.js#L2102)) selects rows with `status IN ('waiting', 'running', 'failed', 'stopped')` and resets them — including currently-in-flight rows from another batch. Combined with the standalone `/pipeline/:pipelineId/search-placement` route ([broll.js:887-903](server/routes/broll.js#L887)) that calls `searchSinglePlacement` directly with no row coordination, multiple GPU calls fire in parallel for the same placement.

### Evidence

DB query of rows 408–418 (batch_id `search-batch-1777529777024`) showed:

- Row 414 `started_at = 06:48:36`, row 413 `started_at = 06:48:58` — same batch, supposedly sequential, but 414 was started before 413.
- Row 413 `completed_at = 06:48:35` < `started_at = 06:48:58` — physically impossible without multiple updaters.
- Row 413 has `api_log_id = 409` (created 06:47:50) but `started_at = 06:48:58` — api_log was created in a previous run that no longer matches the row's current `started_at`.
- Phase 0 reset preserves `api_log_id, results_json, num_results, duration_ms` from the prior run while clearing `started_at, completed_at, error` — bleed-through inconsistent state.

## Solution

Introduce a single in-process worker that owns all GPU search execution, gated by a Postgres advisory lock so only one process across the cluster runs the worker. All callers (batch route, single-placement route, user-placement route) become **enqueue-only**: they INSERT `broll_searches` rows and return. The worker is the sole caller of `searchSinglePlacement` for queued work.

A reclaimer (every 2 min) recovers rows stuck at `status='running'` past 20 min, with a retry counter (max 3) before giving up.

### Goals

- One GPU search at a time, system-wide.
- Every search recorded as a `broll_searches` row (including single-placement).
- Failed rows always carry `api_log_id` when the underlying error has one.
- Stuck rows recover automatically with retry, then fail loudly.
- No regression in current UX (batch route still returns `pipelineId`, variant interleaving preserved).

### Non-Goals

- Multi-worker concurrency (worker is sequential by design).
- Replacing `batch_id` semantics — kept for grouping/observability.
- Refactoring keyword generation (Phase 1, 1.5, 2 of `executeSearchBatch` stay).
- Touching the auto-resume logic for plan/keyword pipelines.

## Architecture

```
                                         ┌─────────────────────┐
[API routes]                             │  GPU search worker  │
  /search-next-batch  ──┐                │  (single async loop)│
  /search-placement   ──┼─► INSERT row   │                     │
  /search-user-…      ──┘   status='waiting'                   │
                            (returns brollSearchId)            │
                                                               │
                                                               ▼
                                          pg_try_advisory_lock(WORKER_KEY)
                                              │
                                              ▼
                                          poll: SELECT … WHERE status='waiting'
                                              ORDER BY id LIMIT 1
                                              │
                                              ▼
                                          UPDATE status='running'
                                              │
                                              ▼
                                          searchSinglePlacement(...)
                                              │
                                              ▼
                                          UPDATE status='complete'/'failed'/'timeout',
                                                 api_log_id, results_json, …
                                              │
                                              ▼
                                          loop

[Reclaimer (every 2 min, in same process)]
  SELECT WHERE status='running' AND started_at < NOW() - 20 min
  if retry_count < 3 → status='waiting', retry_count++, full data reset
  else                → status='failed', error='reclaimed: stuck after N retries'
```

**Key invariant:** every GPU search goes through `broll_searches`. There is no other path.

## Components

### New files

- **`server/services/broll-search-worker.js`** — exports `startWorker()`, `stopWorker()`. Owns the advisory lock, the polling loop, and the reclaimer. Started from `server/index.js` on boot.
- **`server/services/__tests__/broll-search-worker.test.js`** — unit tests (lock, drain, catch-path, reclaimer, concurrency invariant).
- **`server/services/__tests__/broll-search-worker.integration.test.js`** — integration test (real Postgres, mocked GPU URL).

### Modified files

- **`server/services/broll.js`**
  - `executeSearchBatch`: keep keyword phases (1, 1.5, 2). DELETE Phase 0 (resumption logic moves to worker/reclaimer). Phase 2.5 still INSERTs `broll_searches` rows. DELETE Phase 3 (no more inline GPU calls). Returns immediately after enqueue.
  - `searchSinglePlacement`: unchanged — the worker still calls it.
  - `searchUserPlacement`: unchanged — the worker still calls it.
- **`server/routes/broll.js`**
  - `/pipeline/search-next-batch`: unchanged signature, still returns `{ pipelineId }` immediately.
  - `/pipeline/:pipelineId/search-placement`: change to enqueue + return `{ brollSearchId }`. Caller polls a status endpoint.
  - `/pipeline/:pipelineId/search-user-placement`: same enqueue treatment.
  - **NEW:** `/pipeline/search-status/:brollSearchId` returning row state + result if complete.
- **`server/index.js`**: call `startWorker()` on boot, `stopWorker()` on SIGTERM.
- **`server/db.js`**: idempotent migration block adding the new columns/indexes.
- **`server/schema-pg.sql`**: new columns/indexes for fresh installs.

### UI files (out of scope for backend PR but documented for follow-up)

- Components calling `/search-placement` need to switch from result-in-response to poll-for-completion via the new status endpoint.

## Schema

```sql
ALTER TABLE broll_searches ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_broll_searches_status_waiting
  ON broll_searches(id) WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_broll_searches_status_running
  ON broll_searches(started_at) WHERE status = 'running';
```

Only one new column — `retry_count`. `started_at` already exists and is the worker's claim timestamp. The two indexes are partial indexes on the hot statuses so the worker's poll and the reclaimer's sweep stay O(log N) as the table grows.

## Worker Implementation (pseudocode)

```js
const WORKER_KEY = 0x42425b726f6c6cn  // arbitrary stable 64-bit constant

let stopping = false
let lockAcquired = false
let drainTimer = null
let reclaimerTimer = null

export async function startWorker() {
  const { rows } = await pool.query('SELECT pg_try_advisory_lock($1) AS got', [WORKER_KEY])
  if (!rows[0].got) {
    console.log('[broll-worker] another instance holds the lock — staying idle')
    drainTimer = setTimeout(startWorker, 30_000)
    return
  }
  lockAcquired = true
  console.log('[broll-worker] lock acquired, starting drain loop')
  setImmediate(drainLoop)
  reclaimerTimer = setInterval(reclaimerSweep, 120_000)
}

export async function stopWorker() {
  stopping = true
  if (drainTimer) clearTimeout(drainTimer)
  if (reclaimerTimer) clearInterval(reclaimerTimer)
  if (lockAcquired) {
    await pool.query('SELECT pg_advisory_unlock($1)', [WORKER_KEY])
    lockAcquired = false
  }
}

async function drainLoop() {
  if (stopping) return
  const { rows } = await pool.query(`
    SELECT id, plan_pipeline_id, placement_uuid, chapter_index, placement_index, batch_id
    FROM broll_searches
    WHERE status = 'waiting'
    ORDER BY id
    LIMIT 1
  `)
  if (!rows.length) {
    drainTimer = setTimeout(drainLoop, 1000)
    return
  }
  const row = rows[0]

  // Honor abort flag for the row's batch
  if (abortedBrollPipelines.has(row.batch_id)) {
    await pool.query(
      `UPDATE broll_searches SET status='stopped', error='Stopped by user', completed_at=NOW() WHERE id=$1`,
      [row.id]
    )
    setImmediate(drainLoop)
    return
  }

  const claim = await pool.query(`
    UPDATE broll_searches
    SET status='running', started_at=NOW()
    WHERE id=$1 AND status='waiting'
  `, [row.id])
  if (claim.rowCount === 0) { setImmediate(drainLoop); return }  // defensive

  try {
    const result = await searchSinglePlacement(row.plan_pipeline_id, {
      placementUuid: row.placement_uuid,
      chapterIndex: row.chapter_index,
      placementIndex: row.placement_index,
    })
    const status = result.gpuJobStatus === 'running' ? 'timeout'
                 : result.gpuJobStatus === 'failed'  ? 'failed'
                 : 'complete'
    await pool.query(`
      UPDATE broll_searches
      SET status=$1, results_json=$2, num_results=$3, duration_ms=$4,
          api_log_id=$5, error=$6, completed_at=NOW()
      WHERE id=$7
    `, [status, JSON.stringify(result.results || []), (result.results||[]).length,
        result.duration, result.apiLogId, result.error, row.id])
  } catch (err) {
    await pool.query(`
      UPDATE broll_searches
      SET status='failed', error=$1, completed_at=NOW(), api_log_id=$2
      WHERE id=$3
    `, [err.message, err.apiLogId || null, row.id])  // ← Bug 1 fix: persist apiLogId from thrown error
  }
  setImmediate(drainLoop)
}

async function reclaimerSweep() {
  if (stopping) return
  const { rows: stuck } = await pool.query(`
    SELECT id, retry_count FROM broll_searches
    WHERE status='running' AND started_at < NOW() - INTERVAL '20 minutes'
  `)
  for (const r of stuck) {
    if (r.retry_count >= 3) {
      await pool.query(`
        UPDATE broll_searches
        SET status='failed', error='reclaimed: stuck after 3 retries', completed_at=NOW()
        WHERE id=$1
      `, [r.id])
    } else {
      await pool.query(`
        UPDATE broll_searches
        SET status='waiting', retry_count=retry_count+1,
            started_at=NULL,
            api_log_id=NULL, error=NULL, results_json=NULL,
            num_results=0, duration_ms=NULL
        WHERE id=$1
      `, [r.id])
    }
  }
}
```

Note the **full column reset** on requeue — fixes the bleed-through bug.

## Migration / One-Time Data Fix

On first deploy of PR 2 (cutover), run as part of the `db.js` migration block:

```sql
-- Fail any rows currently stuck from the old code path.
-- These won't have a retry_count, so we skip the retry loop and just mark failed.
UPDATE broll_searches
SET status='failed',
    error='reclaimed during queue migration',
    completed_at=NOW()
WHERE status IN ('running')
  AND started_at < NOW() - INTERVAL '20 minutes';
```

Anything legitimately `'waiting'` (created by old `executeSearchBatch` but never picked up) gets drained by the new worker on first boot — no special handling needed.

## Error Handling

| Failure | Behavior |
|---|---|
| `searchSinglePlacement` throws | Worker catches, UPDATE `status='failed'`, `error=err.message`, `api_log_id=err.apiLogId \|\| null`. **Bug 1 fix.** |
| AbortError (deploy/SIGTERM) | `stopping` flag prevents next iteration. In-flight call may be killed; reclaimer picks up the stuck row after 20 min. |
| DB connection lost | Loop's query throws; outer try wraps and reschedules in 5 s. Advisory lock auto-released by Postgres on connection drop; next boot reacquires. |
| Advisory lock contention | Loser sleeps 30 s and re-tries `pg_try_advisory_lock`. No spinning. |
| Reclaimer crashes mid-sweep | Each row update is independent. Next sweep retries. |
| `searchSinglePlacement` hangs forever | 20-min reclaimer threshold is the safety net. (Function itself has 20-min poll cap, so this should never trigger — defense in depth.) |

## Testing Strategy

### Unit tests (`server/services/__tests__/broll-search-worker.test.js`)

- **Lock acquisition:** only one of two `startWorker()` calls succeeds.
- **Drain loop:** enqueue 3 rows → all processed in order, `searchSinglePlacement` mocked.
- **Catch path (Bug 1 regression):** mock `searchSinglePlacement` to throw with `err.apiLogId=42` → DB row has `api_log_id=42`.
- **Reclaimer requeue:** insert a row with `started_at = NOW() - 21 min, status='running', retry_count=0` → reclaimer flips to `'waiting'`, `retry_count=1`, all data columns cleared.
- **Reclaimer max retries:** `retry_count=3` → flips to `'failed'`.
- **Concurrency invariant (Bug 2 regression):** spawn 5 fake "callers" enqueuing 10 rows each with mocked `searchSinglePlacement` that records call timestamps → assert no two calls overlap.
- **Abort honored:** row's `batch_id` is in `abortedBrollPipelines` → worker marks `'stopped'` without calling `searchSinglePlacement`.

### Integration test (`server/services/__tests__/broll-search-worker.integration.test.js`)

- Real Postgres (existing test DB), mocked GPU URL (intercept `fetch`).
- End-to-end: route enqueues → worker picks up → row reaches terminal state with correct `api_log_id`.

### Manual smoke (after deploy of PR 2, before declaring done)

1. `/pipeline/search-next-batch` for 5 placements → all complete sequentially within expected wall-clock.
2. Two batches fired ~simultaneously → 2nd batch's rows wait in queue, no parallel GPU calls (verify via `api_logs` timestamps).
3. Single-search button → returns `brollSearchId`, polls to completion.
4. Kill backend mid-search → restart → reclaimer requeues the stuck row, worker processes it.

**Per memory:** do NOT use `npm run dev:server` for verification (auto-resumes stuck b-roll chains). Use Railway-deployed instance OR a dedicated test harness that doesn't trigger auto-resume.

## Rollout

**PR 1 (this branch):** schema migration + worker + worker tests + Bug 1 catch-path fix in worker. `executeSearchBatch` and routes unchanged. Worker started but no callers — safe to deploy, verify lock acquisition + idle behavior in production logs for 24 h.

**PR 2 (follow-up branch):** flip `executeSearchBatch` to enqueue-only (remove Phase 0, Phase 3). Flip routes. Includes integration tests, migration data fix, and manual smoke checklist.

Splitting in two means PR 1 lands a no-op-from-user-perspective change, gives the worker time to prove itself in production, and PR 2 is a clean cutover.

**Rollback:** PR 2 can be reverted independently of PR 1 (worker idles harmlessly if no waiting rows). PR 1 can be reverted by dropping the new columns (still nullable, no data loss).

## Defaults

- `WORKER_KEY = 0x42425b726f6c6cn` (constant, unique to this app)
- `max_retries = 3`
- `stuck_threshold = 20 minutes` (matches existing GPU job poll cap)
- `reclaimer_interval = 2 minutes`
- `empty_queue_poll = 1 second`
- `lock_retry_interval = 30 seconds`
- New `batch_id` for single-search enqueues: `'single-{Date.now()}'`

## Out of Scope (intentionally excluded)

- Replacing `batch_id` semantics — kept for grouping/observability.
- Variant interleaving — already correct in Phase 2.5 enqueue order.
- The `pipelineAbortControllers` / abort flow — kept; worker honors `abortedBrollPipelines.has(batch_id)` before each row.
- Auto-resume-on-boot logic for plan/keyword pipelines (per memory, not for `broll_searches`; new worker replaces that need for searches).
- UI changes to poll the new status endpoint (separate frontend PR).
