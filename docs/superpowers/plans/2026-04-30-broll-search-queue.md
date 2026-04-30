# B-Roll Search Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the parallel/racy GPU search execution in `executeSearchBatch` with a single-process worker (gated by Postgres advisory lock) so all GPU calls go through one sequential queue, fix the lost `api_log_id` on failed rows, and add reclaim-with-retry for stuck rows.

**Architecture:** Single async worker loop owns all GPU search execution. All API routes become enqueue-only (INSERT into `broll_searches`, return `brollSearchId`). A periodic reclaimer recovers rows stuck at `status='running'` past 20 min, with `retry_count` < 3.

**Tech Stack:** Node 20, ESM, `pg` (Pool), `vitest`, Express, PostgreSQL (Supavisor transaction-mode pool), advisory locks.

**Spec:** [docs/superpowers/specs/2026-04-30-broll-search-queue-design.md](../specs/2026-04-30-broll-search-queue-design.md)

---

## File Map

**Create:**
- `server/services/broll-search-worker.js` — worker module (lock acquisition, drain loop, reclaimer)
- `server/services/__tests__/broll-search-worker.test.js` — unit tests
- `server/services/__tests__/broll-search-worker.integration.test.js` — integration test against real Postgres

**Modify:**
- `server/db.js` — add `retry_count` column + 2 partial indexes in migration block
- `server/schema-pg.sql` — add `retry_count` + indexes to fresh-install schema
- `server/index.js` — call `startWorker()` after `app.listen`, register `stopWorker()` on SIGTERM
- `server/services/broll.js` — `executeSearchBatch`: delete Phase 0, replace Phase 3 with no-op return after Phase 2.5
- `server/routes/broll.js` — change `/pipeline/:pipelineId/search-placement` and `/pipeline/:pipelineId/search-user-placement` to enqueue + return `brollSearchId`; add `/pipeline/search-status/:brollSearchId`

---

## Phase A — PR 1: Worker scaffolding (lands as no-op from user POV)

### Task 1: Schema migration — `retry_count` column + indexes

**Files:**
- Modify: `server/db.js` (add to existing migration block)
- Modify: `server/schema-pg.sql` (for fresh installs)

- [ ] **Step 1: Add column + indexes to `server/db.js` migration block**

Find the line `await pool.query(\`CREATE INDEX IF NOT EXISTS idx_broll_searches_uuid …` (currently around line 150) and insert these queries directly after it:

```js
    // ── 2026-04-30: B-roll search queue (worker + reclaimer) ────────────
    await pool.query(`ALTER TABLE broll_searches ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_broll_searches_status_waiting ON broll_searches(id) WHERE status = 'waiting'`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_broll_searches_status_running ON broll_searches(started_at) WHERE status = 'running'`)
```

- [ ] **Step 2: Add same column + indexes to `server/schema-pg.sql`**

Find the `CREATE TABLE … broll_searches (…)` block in `server/schema-pg.sql`. Add `retry_count INT NOT NULL DEFAULT 0,` to the column list (anywhere is fine — convention seems to be near the bottom before timestamps). After the `CREATE TABLE` block, add:

```sql
CREATE INDEX IF NOT EXISTS idx_broll_searches_status_waiting ON broll_searches(id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_broll_searches_status_running ON broll_searches(started_at) WHERE status = 'running';
```

- [ ] **Step 3: Verify the migration runs cleanly on the existing dev DB**

Run:
```bash
DATABASE_URL='<existing dev DB URL from .env>' node -e "import('./server/db.js')"
```
Expected: completes within ~3 s, prints `[db] Schema initialized`, exits 0. No errors about duplicate columns or indexes.

- [ ] **Step 4: Verify column exists**

Run:
```bash
DATABASE_URL='<dev DB URL>' node -e "
import('pg').then(async pgmod => {
  const c = new pgmod.default.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  const r = await c.query(\`SELECT column_name FROM information_schema.columns WHERE table_name='broll_searches' AND column_name='retry_count'\`)
  console.log(r.rows)
  await c.end()
})"
```
Expected: prints `[ { column_name: 'retry_count' } ]`.

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/schema-pg.sql
git commit -m "feat(broll): add retry_count and partial indexes for search queue"
```

---

### Task 2: Worker module skeleton + lock acquisition test

**Files:**
- Create: `server/services/broll-search-worker.js`
- Create: `server/services/__tests__/broll-search-worker.test.js`

- [ ] **Step 1: Write failing test for `startWorker()` lock acquisition**

Create `server/services/__tests__/broll-search-worker.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock db before importing the worker
const mockPool = {
  query: vi.fn(),
}
vi.mock('../../db.js', () => ({
  default: { pool: mockPool, prepare: vi.fn() },
}))
vi.mock('../broll.js', () => ({
  searchSinglePlacement: vi.fn(),
  abortedBrollPipelines: new Set(),
}))

import { startWorker, stopWorker, _resetForTest } from '../broll-search-worker.js'

describe('broll-search-worker — lock acquisition', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    _resetForTest()
  })
  afterEach(async () => {
    await stopWorker()
  })

  it('acquires the advisory lock and starts draining', async () => {
    mockPool.query.mockImplementation(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    })

    await startWorker()

    // Lock query should have been called
    const lockCalls = mockPool.query.mock.calls.filter(c => c[0].includes('pg_try_advisory_lock'))
    expect(lockCalls.length).toBe(1)
  })

  it('stays idle when another instance holds the lock', async () => {
    mockPool.query.mockImplementation(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: false }] }
      return { rows: [], rowCount: 0 }
    })

    await startWorker()

    // Should not have polled the queue
    const pollCalls = mockPool.query.mock.calls.filter(c => c[0].includes('SELECT id, plan_pipeline_id'))
    expect(pollCalls.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test — verify it fails**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js
```
Expected: FAIL — module `../broll-search-worker.js` not found.

- [ ] **Step 3: Create the worker module skeleton**

Create `server/services/broll-search-worker.js`:

```js
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
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js
```
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll-search-worker.js server/services/__tests__/broll-search-worker.test.js
git commit -m "feat(broll-worker): add module skeleton with advisory-lock acquisition"
```

---

### Task 3: Drain loop — empty queue handling

**Files:**
- Modify: `server/services/broll-search-worker.js`
- Modify: `server/services/__tests__/broll-search-worker.test.js`

- [ ] **Step 1: Add failing test for empty-queue polling**

Append to `server/services/__tests__/broll-search-worker.test.js`:

```js
describe('broll-search-worker — empty queue', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    _resetForTest()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await stopWorker()
  })

  it('polls every 1s when queue is empty', async () => {
    mockPool.query.mockImplementation(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    })

    await startWorker()
    // Let setImmediate fire
    await vi.advanceTimersByTimeAsync(0)

    const pollsBefore = mockPool.query.mock.calls.filter(c => c[0].includes('SELECT id, plan_pipeline_id')).length
    expect(pollsBefore).toBeGreaterThanOrEqual(1)

    // After 1s, should poll again
    await vi.advanceTimersByTimeAsync(1100)
    const pollsAfter = mockPool.query.mock.calls.filter(c => c[0].includes('SELECT id, plan_pipeline_id')).length
    expect(pollsAfter).toBeGreaterThan(pollsBefore)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'empty queue'
```
Expected: FAIL — `pollsBefore` is 0 (drainLoop is empty).

- [ ] **Step 3: Implement the empty-queue branch in `drainLoop`**

In `server/services/broll-search-worker.js`, replace the empty `drainLoop` body with:

```js
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
    // Row processing — implemented in Task 4.
  } catch (err) {
    console.error('[broll-worker] drainLoop error:', err.message)
    drainTimer = setTimeout(drainLoop, 5000)
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'empty queue'
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll-search-worker.js server/services/__tests__/broll-search-worker.test.js
git commit -m "feat(broll-worker): add drain loop with empty-queue polling"
```

---

### Task 4: Drain loop — process one waiting row (success path)

**Files:**
- Modify: `server/services/broll-search-worker.js`
- Modify: `server/services/__tests__/broll-search-worker.test.js`

- [ ] **Step 1: Add failing test for the success path**

Append to `server/services/__tests__/broll-search-worker.test.js`:

```js
import { searchSinglePlacement } from '../broll.js'

describe('broll-search-worker — success path', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    searchSinglePlacement.mockReset()
    _resetForTest()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await stopWorker()
  })

  it('claims a waiting row, calls searchSinglePlacement, writes complete', async () => {
    let queueRows = [{
      id: 100, plan_pipeline_id: 'plan-1', placement_uuid: 'p_abc',
      chapter_index: 0, placement_index: 1, batch_id: 'b-1',
    }]
    const updates = []
    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.startsWith(`\n      SELECT id, plan_pipeline_id`) || sql.includes('SELECT id, plan_pipeline_id')) {
        return { rows: queueRows.slice(0, 1) }
      }
      if (sql.includes(`UPDATE broll_searches\n    SET status='running'`)) {
        queueRows = []
        return { rowCount: 1 }
      }
      if (sql.includes(`UPDATE broll_searches\n      SET status=`)) {
        updates.push({ sql, params })
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    searchSinglePlacement.mockResolvedValue({
      results: [{ id: 'r1' }, { id: 'r2' }],
      duration: 5000,
      apiLogId: 999,
      gpuJobStatus: null,
      error: null,
    })

    await startWorker()
    await vi.advanceTimersByTimeAsync(50)
    // Yield to allow async work
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)

    expect(searchSinglePlacement).toHaveBeenCalledWith('plan-1', {
      placementUuid: 'p_abc', chapterIndex: 0, placementIndex: 1,
    })
    expect(updates.length).toBe(1)
    // Params order: status, results_json, num_results, duration_ms, api_log_id, error, id
    expect(updates[0].params).toEqual([
      'complete',
      JSON.stringify([{ id: 'r1' }, { id: 'r2' }]),
      2,
      5000,
      999,
      null,
      100,
    ])
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'success path'
```
Expected: FAIL — `searchSinglePlacement` never called, no UPDATE matching the success-path SQL.

- [ ] **Step 3: Implement the success path in `drainLoop`**

Open `server/services/broll-search-worker.js`. Replace the placeholder comment `// Row processing — implemented in Task 4.` with:

```js
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
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'success path'
```
Expected: PASS.

- [ ] **Step 5: Run full worker test file**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js
```
Expected: all 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/broll-search-worker.js server/services/__tests__/broll-search-worker.test.js
git commit -m "feat(broll-worker): implement success path of drain loop"
```

---

### Task 5: Drain loop — catch path with `apiLogId` (Bug 1 fix)

**Files:**
- Modify: `server/services/broll-search-worker.js`
- Modify: `server/services/__tests__/broll-search-worker.test.js`

- [ ] **Step 1: Add failing test for the catch path persisting `apiLogId`**

Append to `server/services/__tests__/broll-search-worker.test.js`:

```js
describe('broll-search-worker — catch path (Bug 1 regression)', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    searchSinglePlacement.mockReset()
    _resetForTest()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await stopWorker()
  })

  it('persists err.apiLogId on the failed row', async () => {
    let queueRows = [{
      id: 200, plan_pipeline_id: 'plan-1', placement_uuid: 'p_xyz',
      chapter_index: 1, placement_index: 0, batch_id: 'b-2',
    }]
    const updates = []
    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) {
        return { rows: queueRows.slice(0, 1) }
      }
      if (sql.includes(`UPDATE broll_searches\n      SET status='running'`)) {
        queueRows = []
        return { rowCount: 1 }
      }
      if (sql.includes(`SET status='failed'`)) {
        updates.push({ sql, params })
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const err = new Error('GPU exploded')
    err.apiLogId = 4242
    searchSinglePlacement.mockRejectedValue(err)

    await startWorker()
    await vi.advanceTimersByTimeAsync(50)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)

    expect(updates.length).toBe(1)
    // Params: error, api_log_id, id
    expect(updates[0].params).toEqual(['GPU exploded', 4242, 200])
  })

  it('uses null api_log_id when err.apiLogId is missing', async () => {
    let queueRows = [{
      id: 201, plan_pipeline_id: 'plan-1', placement_uuid: 'p_xyz',
      chapter_index: 1, placement_index: 0, batch_id: 'b-2',
    }]
    const updates = []
    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) return { rows: queueRows.slice(0, 1) }
      if (sql.includes(`UPDATE broll_searches\n      SET status='running'`)) { queueRows = []; return { rowCount: 1 } }
      if (sql.includes(`SET status='failed'`)) { updates.push({ params }); return { rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    })
    searchSinglePlacement.mockRejectedValue(new Error('no apiLogId on me'))

    await startWorker()
    await vi.advanceTimersByTimeAsync(50)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)

    expect(updates[0].params).toEqual(['no apiLogId on me', null, 201])
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'catch path'
```
Expected: FAIL — no UPDATE with `status='failed'` is issued.

- [ ] **Step 3: Implement the catch path**

In `server/services/broll-search-worker.js`, replace:

```js
    } catch (err) {
      // Catch path — implemented in Task 5.
      console.error('[broll-worker] (catch path TODO):', err.message)
    }
```

with:

```js
    } catch (err) {
      console.error(`[broll-worker] search failed for row ${row.id}: ${err.message}`)
      await db.pool.query(`
      UPDATE broll_searches
      SET status='failed', error=$1, api_log_id=$2, completed_at=NOW()
      WHERE id=$3
    `, [err.message, err.apiLogId || null, row.id])
    }
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'catch path'
```
Expected: PASS — both subtests green.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll-search-worker.js server/services/__tests__/broll-search-worker.test.js
git commit -m "fix(broll-worker): persist api_log_id on failed search rows (Bug 1)"
```

---

### Task 6: Drain loop — honor `abortedBrollPipelines`

**Files:**
- Modify: `server/services/broll-search-worker.js`
- Modify: `server/services/__tests__/broll-search-worker.test.js`

- [ ] **Step 1: Add failing test for the abort branch**

Append to `server/services/__tests__/broll-search-worker.test.js`:

```js
import { abortedBrollPipelines } from '../broll.js'

describe('broll-search-worker — abort honored', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    searchSinglePlacement.mockReset()
    abortedBrollPipelines.clear()
    _resetForTest()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await stopWorker()
  })

  it('marks row stopped without calling searchSinglePlacement when batch aborted', async () => {
    let queueRows = [{
      id: 300, plan_pipeline_id: 'plan-1', placement_uuid: 'p_abc',
      chapter_index: 0, placement_index: 0, batch_id: 'aborted-batch',
    }]
    const updates = []
    abortedBrollPipelines.add('aborted-batch')
    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) return { rows: queueRows.slice(0, 1) }
      if (sql.includes(`SET status='stopped'`)) { queueRows = []; updates.push({ params }); return { rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    })

    await startWorker()
    await vi.advanceTimersByTimeAsync(50)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)

    expect(searchSinglePlacement).not.toHaveBeenCalled()
    expect(updates.length).toBe(1)
    expect(updates[0].params[0]).toBe(300)  // id
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'abort honored'
```
Expected: FAIL — `searchSinglePlacement` called when it shouldn't be.

- [ ] **Step 3: Implement abort check before claim**

In `server/services/broll-search-worker.js`, replace:

```js
    const row = rows[0]
    const claim = await db.pool.query(`
      UPDATE broll_searches
      SET status='running', started_at=NOW()
      WHERE id=$1 AND status='waiting'
    `, [row.id])
```

with:

```js
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
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'abort honored'
```
Expected: PASS.

- [ ] **Step 5: Run full worker test file**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/broll-search-worker.js server/services/__tests__/broll-search-worker.test.js
git commit -m "feat(broll-worker): honor abortedBrollPipelines flag before processing row"
```

---

### Task 7: Reclaimer — requeue stuck rows under max retries

**Files:**
- Modify: `server/services/broll-search-worker.js`
- Modify: `server/services/__tests__/broll-search-worker.test.js`

- [ ] **Step 1: Add failing test for requeue branch**

Append to `server/services/__tests__/broll-search-worker.test.js`:

```js
import { reclaimerSweep as _reclaimerSweep } from '../broll-search-worker.js'

describe('broll-search-worker — reclaimer (requeue under max retries)', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    _resetForTest()
  })

  it('requeues a stuck row, increments retry_count, clears data columns', async () => {
    const updates = []
    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql.includes(`status='running' AND started_at`)) {
        return { rows: [{ id: 500, retry_count: 0 }] }
      }
      if (sql.includes(`status='waiting', retry_count=retry_count+1`)) {
        updates.push({ sql, params })
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    await _reclaimerSweep()

    expect(updates.length).toBe(1)
    expect(updates[0].params).toEqual([500])
    expect(updates[0].sql).toContain('api_log_id=NULL')
    expect(updates[0].sql).toContain('error=NULL')
    expect(updates[0].sql).toContain('results_json=NULL')
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'reclaimer .requeue'
```
Expected: FAIL — `reclaimerSweep` is empty; no UPDATE issued.

- [ ] **Step 3: Implement reclaimer requeue branch**

In `server/services/broll-search-worker.js`, replace the empty `reclaimerSweep` body with:

```js
async function reclaimerSweep() {
  if (stopping) return
  const { rows: stuck } = await db.pool.query(`
    SELECT id, retry_count FROM broll_searches
    WHERE status='running' AND started_at < NOW() - INTERVAL '${STUCK_THRESHOLD_MIN} minutes'
  `)
  for (const r of stuck) {
    if (r.retry_count >= MAX_RETRIES) {
      // Implemented in Task 8.
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
```

(Note: the second `export` line is intentional — `reclaimerSweep` is also called via `setInterval`, but tests want to call it directly.)

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'reclaimer .requeue'
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll-search-worker.js server/services/__tests__/broll-search-worker.test.js
git commit -m "feat(broll-worker): reclaim stuck rows with retry counter increment"
```

---

### Task 8: Reclaimer — fail rows after max retries

**Files:**
- Modify: `server/services/broll-search-worker.js`
- Modify: `server/services/__tests__/broll-search-worker.test.js`

- [ ] **Step 1: Add failing test for max-retries branch**

Append to `server/services/__tests__/broll-search-worker.test.js`:

```js
describe('broll-search-worker — reclaimer (max retries)', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    _resetForTest()
  })

  it('fails permanently when retry_count >= 3', async () => {
    const updates = []
    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql.includes(`status='running' AND started_at`)) {
        return { rows: [{ id: 600, retry_count: 3 }] }
      }
      if (sql.includes(`status='failed', error='reclaimed: stuck after`)) {
        updates.push({ params })
        return { rowCount: 1 }
      }
      if (sql.includes(`status='waiting', retry_count=retry_count+1`)) {
        throw new Error('should not requeue at max retries')
      }
      return { rows: [], rowCount: 0 }
    })

    await _reclaimerSweep()

    expect(updates.length).toBe(1)
    expect(updates[0].params).toEqual([600])
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'reclaimer .max retries'
```
Expected: FAIL — currently `continue` is the only thing in the >=MAX branch.

- [ ] **Step 3: Implement the max-retries branch**

In `server/services/broll-search-worker.js`, replace:

```js
    if (r.retry_count >= MAX_RETRIES) {
      // Implemented in Task 8.
      continue
    }
```

with:

```js
    if (r.retry_count >= MAX_RETRIES) {
      await db.pool.query(`
        UPDATE broll_searches
        SET status='failed', error='reclaimed: stuck after ${MAX_RETRIES} retries', completed_at=NOW()
        WHERE id=$1
      `, [r.id])
      console.warn(`[broll-worker] row ${r.id} failed permanently after ${MAX_RETRIES} retries`)
      continue
    }
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js -t 'reclaimer .max retries'
```
Expected: PASS.

- [ ] **Step 5: Run full worker test file**

Run:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/broll-search-worker.js server/services/__tests__/broll-search-worker.test.js
git commit -m "feat(broll-worker): fail rows permanently after max retries"
```

---

### Task 9: Wire `startWorker`/`stopWorker` into `server/index.js`

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Read current server boot sequence**

Open `server/index.js` and find `app.listen(PORT, async () => { … })` (around line 107).

- [ ] **Step 2: Add worker start after `startGpuFailurePoller()`**

Replace:

```js
app.listen(PORT, async () => {
  console.log(`Transcript Eval API running on http://localhost:${PORT}`)
  console.log(`[auth] ${hasServerAuthConfig ? 'Supabase JWT verification enabled' : 'Supabase JWT verification disabled'}`)
  if (storageEnabled()) {
    await initBuckets()
  }
  startGpuFailurePoller()
})
```

with:

```js
import { startWorker as startBrollSearchWorker, stopWorker as stopBrollSearchWorker } from './services/broll-search-worker.js'

app.listen(PORT, async () => {
  console.log(`Transcript Eval API running on http://localhost:${PORT}`)
  console.log(`[auth] ${hasServerAuthConfig ? 'Supabase JWT verification enabled' : 'Supabase JWT verification disabled'}`)
  if (storageEnabled()) {
    await initBuckets()
  }
  startGpuFailurePoller()
  startBrollSearchWorker().catch(err => console.error('[startup] broll-search-worker failed:', err.message))
})

async function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, stopping broll-search-worker`)
  try { await stopBrollSearchWorker() } catch (err) { console.warn('[shutdown] worker stop:', err.message) }
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
```

(Move the `import` statement to the top of the file with the other imports — do not leave it inside `app.listen`.)

- [ ] **Step 3: Verify boot doesn't crash**

```bash
DATABASE_URL='<dev DB URL>' GPU_INTERNAL_KEY=anything node server/index.js &
sleep 5
echo $? && kill %1
```
Expected: log line `[broll-worker] lock acquired, starting drain loop`, no crash. (If you can't run a real boot, skip — the integration test in Task 10 covers this.)

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(server): start broll-search-worker on boot, stop on SIGTERM"
```

---

### Task 10: Integration test — real Postgres, mocked GPU

**Files:**
- Create: `server/services/__tests__/broll-search-worker.integration.test.js`

- [ ] **Step 1: Write the integration test**

Create `server/services/__tests__/broll-search-worker.integration.test.js`:

```js
// Integration test against a real Postgres DB. Uses DATABASE_URL from env.
// Mocks only the network call (fetch) to the GPU; everything else is real.
//
// Skips automatically if DATABASE_URL is missing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const skip = !process.env.DATABASE_URL

const d = skip ? describe.skip : describe

d('broll-search-worker integration', () => {
  let db, startWorker, stopWorker, _resetForTest
  let testRowIds = []

  beforeEach(async () => {
    db = (await import('../../db.js')).default
    const w = await import('../broll-search-worker.js')
    startWorker = w.startWorker
    stopWorker = w.stopWorker
    _resetForTest = w._resetForTest

    // Insert a fixture row directly
    const r = await db.prepare(`
      INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, status)
      VALUES (?, ?, ?, ?, 'waiting') RETURNING id
    `).run('integration-test-plan', 'integration-test-batch', 0, 0)
    testRowIds.push(r.lastInsertRowid)

    // Stub fetch to avoid real GPU call
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ results: [{ id: 'fake-result' }], search_count: 1 }),
      clone() { return this },
      text: async () => '{}',
    })
  })

  afterEach(async () => {
    await stopWorker()
    _resetForTest()
    if (testRowIds.length) {
      await db.prepare(`DELETE FROM broll_searches WHERE id = ANY($1)`).run(testRowIds)
      testRowIds = []
    }
    vi.restoreAllMocks()
  })

  it('drains a fixture row to a terminal status', async () => {
    await startWorker()

    // Poll the row for up to 30s waiting for status to change from 'waiting'
    const id = testRowIds[0]
    let row
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      row = await db.prepare(`SELECT id, status, api_log_id FROM broll_searches WHERE id = ?`).get(id)
      if (row && row.status !== 'waiting') break
    }

    expect(row.status).not.toBe('waiting')
    expect(row.status).not.toBe('running')
    // Worker may produce 'failed' if GPU stub returns nothing usable; either way row was processed.
    expect(['complete', 'failed', 'timeout']).toContain(row.status)
  }, 60_000)
})
```

- [ ] **Step 2: Run the integration test**

Run:
```bash
DATABASE_URL='<dev DB URL>' npm test -- server/services/__tests__/broll-search-worker.integration.test.js
```
Expected: PASS within ~60s. (The GPU fetch stub may cause 'failed' status — that's fine. We're verifying the loop drained the row.)

- [ ] **Step 3: Verify nothing else regressed**

Run the full worker test file plus the existing broll runner tests:
```bash
npm test -- server/services/__tests__/broll-search-worker.test.js server/services/__tests__/broll-runner.test.js
```
Expected: all worker tests pass; broll-runner tests in their pre-existing state (3 unrelated failures noted in baseline).

- [ ] **Step 4: Commit**

```bash
git add server/services/__tests__/broll-search-worker.integration.test.js
git commit -m "test(broll-worker): add integration test against real Postgres"
```

---

### Task 11: PR 1 checkpoint — verify worker is no-op for users

- [ ] **Step 1: Confirm executeSearchBatch and routes are unchanged**

```bash
git diff main..HEAD -- server/services/broll.js server/routes/broll.js
```
Expected: empty output (no changes to those files in PR 1).

- [ ] **Step 2: Confirm worker is the only new behavior**

```bash
git log main..HEAD --oneline
```
Expected: list shows only the worker module, schema migration, and `index.js` wiring commits — nothing in `broll.js` or `broll/routes`.

- [ ] **Step 3: Confirm fresh schema is consistent**

```bash
grep -n retry_count server/schema-pg.sql
```
Expected: one match in the `broll_searches` table definition.

- [ ] **Step 4: Stop here for PR 1 review**

PR 1 is complete and ready to deploy. The worker idles harmlessly in production (no `'waiting'` rows because `executeSearchBatch` still does its own Phase 3). After PR 1 has soaked for ~24 h with no issues, proceed to Phase B.

---

## Phase B — PR 2: Cutover (routes + executeSearchBatch enqueue-only)

### Task 12: One-time data migration — fail old stuck rows

**Files:**
- Modify: `server/db.js`

- [ ] **Step 1: Add idempotent fail-old-stuck migration**

In `server/db.js`, find the migration block from Task 1. Directly after the partial-index `CREATE` statements, add:

```js
    // 2026-04-30: PR 2 cutover — fail any rows currently stuck under the old code path.
    // The new worker handles future stuck rows via the reclaimer, but pre-existing ones
    // never had a retry_count, so we just mark them failed once.
    await pool.query(`
      UPDATE broll_searches
      SET status='failed',
          error='reclaimed during queue migration',
          completed_at=NOW()
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '20 minutes'
    `)
```

This is idempotent — re-running it on subsequent boots changes 0 rows because they're already `'failed'`.

- [ ] **Step 2: Verify the migration runs cleanly**

```bash
DATABASE_URL='<dev DB URL>' node -e "import('./server/db.js')"
```
Expected: completes within ~3 s, prints `[db] Schema initialized`, exits 0.

- [ ] **Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat(broll): one-time fail of pre-cutover stuck rows in migration"
```

---

### Task 13: `executeSearchBatch` — delete Phase 0 and Phase 3 (enqueue-only)

**Files:**
- Modify: `server/services/broll.js`

- [ ] **Step 1: Read current `executeSearchBatch` (lines 2133-2336)**

```bash
sed -n '2133,2336p' server/services/broll.js
```

Identify three regions to remove:
- Phase 0 (lines ~2147-2171, the `existingResumable` branch)
- Phase 3 entirely (lines ~2259-2321, the `for (let i = 0; i < toSearch.length; i++) { … }` loop and the surrounding progress updates)

The keyword phases (1, 1.5, 2) and Phase 2.5 (INSERT rows) remain.

- [ ] **Step 2: Remove Phase 0**

In `server/services/broll.js`, replace:

```js
  try {
    // Phase 0: Check for existing waiting/running entries from a previous interrupted batch
    const existingResumable = await db.prepare(
      `SELECT * FROM broll_searches WHERE plan_pipeline_id IN (${planPipelineIds.map(() => '?').join(',')}) AND status IN ('waiting', 'running', 'failed', 'stopped') ORDER BY id`
    ).all(...planPipelineIds)

    let toSearch = []

    if (existingResumable.length) {
      // Resume existing queue — skip keywords, go straight to GPU search
      console.log(`[search-batch] Resuming ${existingResumable.length} existing queue entries (${existingResumable.map(r => r.status).join(', ')})`)
      // Reset stuck/failed/stopped entries back to 'waiting'
      for (const row of existingResumable) {
        if (row.status !== 'waiting') {
          await db.prepare(`UPDATE broll_searches SET status = 'waiting', started_at = NULL, completed_at = NULL, error = NULL WHERE id = ?`).run(row.id)
        }
      }
      toSearch = existingResumable.map(row => ({
        pid: row.plan_pipeline_id,
        uuid: row.placement_uuid || null,
        chapterIndex: row.chapter_index,
        placementIndex: row.placement_index,
        brollSearchId: row.id,
        variantLabel: row.variant_label || 'Variant',
      }))
    } else {
      // No existing queue — full flow: keywords + create new entries
```

with:

```js
  try {
    let toSearch = []

    // Phase 0 removed — the worker (server/services/broll-search-worker.js)
    // and reclaimer now own resumption. Re-running this batch with the same
    // planPipelineIds simply enqueues new rows; if old 'waiting' rows still
    // exist for the plan, the worker will drain them in id order.
    {
      // Full flow: keywords + create new entries
```

- [ ] **Step 3: Find the matching close brace**

Find the `}` closing the `} else {` block (it was the `else` branch of `if (existingResumable.length)`). It's around line 2257 — the line just before `// Phase 3: Sequential GPU search`. Leave the brace as the close of the new outer block introduced in Step 2.

- [ ] **Step 4: Replace Phase 3 with enqueue-only return**

Find the block starting with `// Phase 3: Sequential GPU search` (around line 2259) through the end of the for loop (`}` after `await db.prepare(`UPDATE broll_searches SET status = 'failed'…`).run(err.message, item.brollSearchId)` — about line 2311). Replace the entire Phase 3 block plus the trailing pipeline-completion lines (2313-2322) with:

```js
    // Phase 3 removed — rows have been enqueued. The worker drains them
    // sequentially. The route returned the pipelineId before this function
    // even started, so the UI is already polling progress / per-row status.
    brollPipelineProgress.set(pipelineId, {
      ...brollPipelineProgress.get(pipelineId),
      status: 'enqueued', stageName: `Enqueued ${toSearch.length} searches`,
      subDone: 0, subTotal: toSearch.length,
    })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    pipelineAbortControllers.delete(pipelineId)
    console.log(`[search-batch] Enqueued ${toSearch.length} placements (${((Date.now() - pipelineStart) / 1000).toFixed(0)}s)`)

    return { pipelineId, enqueued: toSearch.length, total: toSearch.length }
```

- [ ] **Step 5: Run the existing tests for `broll.js` to spot regressions**

```bash
npm test -- server/services/__tests__/broll-runner.test.js server/services/__tests__/broll-userplacement-shape.test.js
```
Expected: no NEW failures beyond the pre-existing baseline (auto-orchestrator, uuid migration, StepRoughCut).

- [ ] **Step 6: Commit**

```bash
git add server/services/broll.js
git commit -m "refactor(broll): delete Phase 0 and Phase 3 from executeSearchBatch (cutover)"
```

---

### Task 14: New status endpoint `/pipeline/search-status/:brollSearchId`

**Files:**
- Modify: `server/routes/broll.js`

- [ ] **Step 1: Add the status endpoint**

In `server/routes/broll.js`, find the existing `/pipeline/:pipelineId/snapshot` route (around line 816). Insert this new endpoint directly above it:

```js
// Returns the state of one b-roll search row by its primary key.
// UI polls this for completion when it has a brollSearchId from an enqueue.
router.get('/pipeline/search-status/:brollSearchId', requireAuth, async (req, res) => {
  const id = parseInt(req.params.brollSearchId, 10)
  if (!id) return res.status(400).json({ error: 'invalid brollSearchId' })
  const row = await db.prepare(`
    SELECT id, status, plan_pipeline_id, placement_uuid, chapter_index, placement_index,
           num_results, results_json, error, api_log_id, retry_count,
           created_at, started_at, completed_at, duration_ms
    FROM broll_searches WHERE id = ?
  `).get(id)
  if (!row) return res.status(404).json({ error: 'brollSearchId not found' })
  let results = null
  if (row.results_json) {
    try { results = JSON.parse(row.results_json) } catch {}
  }
  res.json({ ...row, results, results_json: undefined })
})
```

- [ ] **Step 2: Smoke-test the route by hand**

Pick a known `broll_searches.id` (e.g., 410 from the bug investigation) and curl:
```bash
curl -s 'http://localhost:3000/broll/pipeline/search-status/410' -H 'Authorization: Bearer <auth-token>'
```
Expected: JSON body with `status`, `num_results`, `results` array, etc.

- [ ] **Step 3: Commit**

```bash
git add server/routes/broll.js
git commit -m "feat(broll): add /pipeline/search-status/:brollSearchId endpoint"
```

---

### Task 15: `/pipeline/:pipelineId/search-placement` → enqueue + return `brollSearchId`

**Files:**
- Modify: `server/routes/broll.js`
- Modify: `server/services/broll.js` (export a small enqueue helper)

- [ ] **Step 1: Add a `enqueueSearchPlacement` helper to `server/services/broll.js`**

Open `server/services/broll.js`. Find the existing `searchSinglePlacement` declaration (line 5912). Directly above it, add:

```js
// Enqueue a single placement search instead of executing it inline. Used by
// the /pipeline/:pipelineId/search-placement route after the queue cutover.
// The worker (server/services/broll-search-worker.js) is the sole executor.
export async function enqueueSearchPlacement(planPipelineId, identity, overrides = {}) {
  const { placementUuid, chapterIndex, placementIndex } = identity || {}
  if (chapterIndex == null || placementIndex == null) {
    // Resolve indices from uuid if needed (mirrors searchSinglePlacement's contract)
    if (!placementUuid) throw new Error('enqueueSearchPlacement: needs uuid OR (chapterIndex, placementIndex)')
    const { ensurePlanUuids } = await import('./broll-placement-uuid.js')
    const uuidsByChapter = await ensurePlanUuids(planPipelineId)
    let resolved = null
    outer: for (const [chIdx, m] of uuidsByChapter.entries()) {
      for (const [pIdx, u] of m.entries()) {
        if (u === placementUuid) { resolved = { chapterIndex: chIdx, placementIndex: pIdx }; break outer }
      }
    }
    if (!resolved) throw new Error(`enqueueSearchPlacement: uuid ${placementUuid} not found in plan ${planPipelineId}`)
    identity = { ...identity, ...resolved }
  }

  // Build brief/keywords/description so the row carries the same payload as a batch row.
  const { brief, keywords, description, uuid: builtUuid } = await _buildSearchParams(
    planPipelineId, identity.chapterIndex, identity.placementIndex, placementUuid,
  )
  if (!keywords.length) {
    throw new Error(`enqueueSearchPlacement: no keywords for ch${identity.chapterIndex} p${identity.placementIndex} — generate keywords first`)
  }

  const batchId = `single-${Date.now()}`
  const variantLabel = overrides.variantLabel || 'Variant'
  const ins = await db.prepare(`
    INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, placement_uuid, variant_label, description, brief, keywords_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting')
  `).run(planPipelineId, batchId, identity.chapterIndex, identity.placementIndex, placementUuid || builtUuid || null, variantLabel, description, brief, JSON.stringify(keywords))

  return { brollSearchId: ins.lastInsertRowid, batchId }
}
```

- [ ] **Step 2: Update the route handler**

In `server/routes/broll.js`, find:

```js
router.post('/pipeline/:pipelineId/search-placement', requireAuth, async (req, res) => {
  try {
    const { pipelineId } = req.params
    const { placementUuid, chapterIndex, placementIndex, description, style, sources } = req.body
    if (!placementUuid && (chapterIndex == null || placementIndex == null)) {
      return res.status(400).json({ error: 'placementUuid OR (chapterIndex, placementIndex) required' })
    }
    const overrides = {}
    if (description) overrides.description = description
    if (style) overrides.style = style
    if (sources) overrides.sources = sources
    const result = await searchSinglePlacement(pipelineId, { placementUuid, chapterIndex, placementIndex }, overrides)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

Replace with:

```js
router.post('/pipeline/:pipelineId/search-placement', requireAuth, async (req, res) => {
  try {
    const { pipelineId } = req.params
    const { placementUuid, chapterIndex, placementIndex, description, style, sources } = req.body
    if (!placementUuid && (chapterIndex == null || placementIndex == null)) {
      return res.status(400).json({ error: 'placementUuid OR (chapterIndex, placementIndex) required' })
    }
    const overrides = {}
    if (description) overrides.description = description
    if (style) overrides.style = style
    if (sources) overrides.sources = sources
    const { brollSearchId, batchId } = await enqueueSearchPlacement(
      pipelineId,
      { placementUuid, chapterIndex, placementIndex },
      overrides,
    )
    // Async semantics: poll GET /pipeline/search-status/:brollSearchId for completion.
    res.json({ brollSearchId, batchId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 3: Update the `enqueueSearchPlacement` import in `server/routes/broll.js`**

Find the existing block of imports from `'../services/broll.js'` (around line 40). Add `enqueueSearchPlacement,` to the named imports list.

- [ ] **Step 4: Smoke-test by hand**

```bash
curl -s -X POST 'http://localhost:3000/broll/pipeline/<some-real-plan-id>/search-placement' \
  -H 'Authorization: Bearer <auth-token>' \
  -H 'Content-Type: application/json' \
  -d '{"chapterIndex":0,"placementIndex":0}'
```
Expected: `{"brollSearchId": <new-id>, "batchId": "single-<timestamp>"}`. Then `GET /pipeline/search-status/<new-id>` shows progression to `'complete'` or `'failed'`.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/routes/broll.js
git commit -m "feat(broll): /search-placement enqueues + returns brollSearchId"
```

---

### Task 16: `/pipeline/:pipelineId/search-user-placement` → enqueue

**Files:**
- Modify: `server/routes/broll.js`
- Modify: `server/services/broll.js`

- [ ] **Step 1: Inspect current `searchUserPlacement` to understand its inputs**

```bash
sed -n '6163,6280p' server/services/broll.js
```

Note: this function's identity is a `userPlacementId`, not chapter/placement indices. The enqueue helper needs a different signature.

- [ ] **Step 2: Add `enqueueSearchUserPlacement` helper to `server/services/broll.js`**

Above `searchUserPlacement` (line 6163), add:

```js
// Enqueue a user-placement search. Mirrors enqueueSearchPlacement but identifies
// the placement by userPlacementId and resolves brief/keywords from the loaded
// editor state. The worker reads this row and calls searchUserPlacement.
export async function enqueueSearchUserPlacement(planPipelineId, userPlacementId, overrides = {}) {
  const loaded = await loadBrollEditorState(planPipelineId)
  const up = (loaded.state.userPlacements || []).find(u => u.id === userPlacementId)
  if (!up) throw new Error(`enqueueSearchUserPlacement: userPlacementId ${userPlacementId} not found`)

  const desc = overrides.description || up.snapshot?.description || ''
  const brief = desc ? `# ${desc}` : ''
  const keywords = up.snapshot?.search_keywords || []

  const batchId = `single-up-${Date.now()}`
  const variantLabel = overrides.variantLabel || 'Variant'
  const ins = await db.prepare(`
    INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, placement_uuid, variant_label, description, brief, keywords_json, status)
    VALUES (?, ?, -1, -1, ?, ?, ?, ?, ?, 'waiting')
  `).run(planPipelineId, batchId, `up-${userPlacementId}`, variantLabel, desc, brief, JSON.stringify(keywords))

  return { brollSearchId: ins.lastInsertRowid, batchId }
}
```

The `chapter_index = -1, placement_index = -1, placement_uuid = 'up-{id}'` is a sentinel pattern marking the row as a user-placement search. The worker (Task 17) recognises this sentinel and dispatches to `searchUserPlacement` instead of `searchSinglePlacement`.

- [ ] **Step 3: Update the worker to dispatch user-placement rows**

In `server/services/broll-search-worker.js`, locate the success-path call:

```js
    const { searchSinglePlacement } = await import('./broll.js')
    try {
      const result = await searchSinglePlacement(row.plan_pipeline_id, {
        placementUuid: row.placement_uuid,
        chapterIndex: row.chapter_index,
        placementIndex: row.placement_index,
      })
```

Replace the import + call with:

```js
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
```

- [ ] **Step 4: Update the route handler**

In `server/routes/broll.js`, find:

```js
router.post('/pipeline/:pipelineId/search-user-placement', requireAuth, async (req, res) => {
  try {
    const { userPlacementId, description, style, sources } = req.body || {}
    if (!userPlacementId) return res.status(400).json({ error: 'userPlacementId required' })
    const overrides = {}
    if (description) overrides.description = description
    if (style) overrides.style = style
    if (sources) overrides.sources = sources
    const result = await searchUserPlacement(req.params.pipelineId, userPlacementId, overrides)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

Replace with:

```js
router.post('/pipeline/:pipelineId/search-user-placement', requireAuth, async (req, res) => {
  try {
    const { userPlacementId, description, style, sources } = req.body || {}
    if (!userPlacementId) return res.status(400).json({ error: 'userPlacementId required' })
    const overrides = {}
    if (description) overrides.description = description
    if (style) overrides.style = style
    if (sources) overrides.sources = sources
    const { brollSearchId, batchId } = await enqueueSearchUserPlacement(req.params.pipelineId, userPlacementId, overrides)
    res.json({ brollSearchId, batchId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 5: Update the import block at the top of `server/routes/broll.js`**

Add `enqueueSearchUserPlacement,` to the named imports from `'../services/broll.js'`.

- [ ] **Step 6: Add a worker test for the user-placement dispatch**

Append to `server/services/__tests__/broll-search-worker.test.js`:

```js
import { searchUserPlacement } from '../broll.js'

describe('broll-search-worker — user-placement dispatch', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    searchSinglePlacement.mockReset()
    searchUserPlacement.mockReset()
    _resetForTest()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await stopWorker()
  })

  it('dispatches user-placement rows to searchUserPlacement', async () => {
    let queueRows = [{
      id: 700, plan_pipeline_id: 'plan-1', placement_uuid: 'up-abc',
      chapter_index: -1, placement_index: -1, batch_id: 'single-up-1',
    }]
    mockPool.query.mockImplementation(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) return { rows: queueRows.slice(0, 1) }
      if (sql.includes(`SET status='running'`)) { queueRows = []; return { rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    })
    searchUserPlacement.mockResolvedValue({ results: [], duration: 100, apiLogId: null })

    await startWorker()
    await vi.advanceTimersByTimeAsync(50)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)

    expect(searchUserPlacement).toHaveBeenCalledWith('plan-1', 'abc')
    expect(searchSinglePlacement).not.toHaveBeenCalled()
  })
})
```

You will need to update the existing `vi.mock('../broll.js', …)` block at the top of the file to also mock `searchUserPlacement`. Locate that mock block and change it to:

```js
vi.mock('../broll.js', () => ({
  searchSinglePlacement: vi.fn(),
  searchUserPlacement: vi.fn(),
  abortedBrollPipelines: new Set(),
}))
```

- [ ] **Step 7: Run worker tests**

```bash
npm test -- server/services/__tests__/broll-search-worker.test.js
```
Expected: all tests pass including the new user-placement test.

- [ ] **Step 8: Commit**

```bash
git add server/services/broll.js server/services/broll-search-worker.js server/routes/broll.js server/services/__tests__/broll-search-worker.test.js
git commit -m "feat(broll): /search-user-placement enqueues + worker dispatches by uuid"
```

---

### Task 17: PR 2 cutover smoke verification

- [ ] **Step 1: Run all worker tests**

```bash
npm test -- server/services/__tests__/broll-search-worker.test.js
```
Expected: all tests pass.

- [ ] **Step 2: Run integration test**

```bash
DATABASE_URL='<dev DB URL>' npm test -- server/services/__tests__/broll-search-worker.integration.test.js
```
Expected: passes within 60 s.

- [ ] **Step 3: Run full vitest suite**

```bash
npm test
```
Expected: no NEW failures beyond the pre-existing baseline (auto-orchestrator x3, uuid migration x2, StepRoughCut x2). Net: same 5 failing pre-existing tests + 0 new failures.

- [ ] **Step 4: Manual smoke checklist (after deploy to staging or production)**

Per memory: do NOT use `npm run dev:server` for verification — use the deployed Railway instance.

- [ ] Trigger `/pipeline/search-next-batch` for 5 placements via the UI. Confirm all 5 reach `status='complete'` or `'failed'` in the DB within expected wall-clock time (~5-10 min for 5 GPU calls).
- [ ] Trigger two batches in rapid succession (e.g., search next 10 twice within a few seconds). Confirm via `api_logs.created_at` timestamps that no two GPU calls overlap (the `created_at` for consecutive calls should differ by the GPU call duration, not be near-simultaneous).
- [ ] Click the single-search button on a placement. Confirm the response is `{ brollSearchId, batchId }` and that polling `/pipeline/search-status/:brollSearchId` shows progression to a terminal status.
- [ ] Kill the backend mid-search (`kill -9` the process), restart it. Confirm in logs that the reclaimer requeues any row whose `started_at` is > 20 min old; that row should reach a terminal status on a later sweep.
- [ ] Query `broll_searches` for rows updated in the last hour. Confirm zero rows exhibit the `completed_at < started_at` paradox or `started_at` going backwards within the same `batch_id`.

- [ ] **Step 5: Commit any final tweaks**

If smoke testing surfaces issues, fix them with new dedicated commits — do not amend.

---

## Self-Review Notes

**Spec coverage check** (from spec sections):
- ✅ Schema (retry_count + 2 indexes): Task 1
- ✅ Worker module + lock: Tasks 2-3
- ✅ Drain success path: Task 4
- ✅ Catch path / Bug 1 fix: Task 5
- ✅ Abort flag honored: Task 6
- ✅ Reclaimer requeue: Task 7
- ✅ Reclaimer max retries: Task 8
- ✅ Server boot wiring: Task 9
- ✅ Integration test: Task 10
- ✅ One-time data fix: Task 12
- ✅ executeSearchBatch enqueue-only: Task 13
- ✅ New status endpoint: Task 14
- ✅ search-placement enqueue: Task 15
- ✅ search-user-placement enqueue: Task 16
- ✅ Manual smoke checklist: Task 17 step 4

**Method/property name consistency:**
- `startWorker()` / `stopWorker()` / `_resetForTest()` / `reclaimerSweep()` exported consistently across worker and tests.
- `enqueueSearchPlacement` / `enqueueSearchUserPlacement` named consistently in service and routes.
- `brollSearchId` (camelCase) used consistently in route responses; `broll_searches.id` (snake_case) for DB column.

**Out of scope (deliberately not in plan):**
- UI changes to switch from inline-result to poll-for-completion. Backend leaves the contract change documented; frontend is its own follow-up PR.
- Removing the now-dead `searchSinglePlacement` direct callers (none remain after Task 13/15/16).
- Renaming `started_at` to better reflect "worker claim time" — keeping the existing column avoids unrelated downstream changes.
