# B-Roll Sequential 3-Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During the full-auto upload chain, search 30 placements per variant (3 sequential batches of 10) instead of 10, with the chain marking `done` only after all three batches actually finish on the GPU.

**Architecture:** Add a `waitForSearchBatchComplete` helper that polls `broll_searches.batch_id` until rows leave `waiting`/`running`. Wrap the existing single `runBrollSearchFirst10` call in `auto-orchestrator.js` with a 3-iteration loop that waits between iterations. `_getPendingGpuPlacements` (`server/services/broll.js:2412-2420`) already excludes already-queued placements, so each iteration naturally picks the next 10 per variant.

**Tech Stack:** Node.js, Postgres (pg), Vitest, React.

**Spec:** `docs/superpowers/specs/2026-05-01-broll-sequential-batches-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `server/services/broll-runner.js` | Add `waitForSearchBatchComplete` helper after `waitForPipelinesComplete` (~line 382). |
| `server/services/__tests__/broll-runner.test.js` | New `describe('waitForSearchBatchComplete')` block with 4 unit tests. |
| `server/services/auto-orchestrator.js` | Add module-level `BROLL_SEARCH_BATCHES = 3` constant. Replace 3 single-call sites (lines 558, 611, 617) with a loop. |
| `server/services/__tests__/run-full-auto-broll-chain-lock.test.js` | Update `runBrollSearchFirst10` mock to return `{ searchPipelineId }`, add `waitForSearchBatchComplete` mock, add test verifying 3 iterations with waits. |
| `src/components/views/ProcessingModal.jsx` | Line 70: change label `'B-roll search (first 10)'` → `'B-roll search (first 30)'`. |

---

## Task 1: Add `waitForSearchBatchComplete` helper (TDD)

**Files:**
- Modify: `server/services/broll-runner.js` (append after `waitForPipelinesComplete`, ~line 382)
- Test: `server/services/__tests__/broll-runner.test.js` (append new `describe` block)

### Step 1: Write the failing tests

Append to `server/services/__tests__/broll-runner.test.js` (after the existing `describe('runBrollSearchFirst10')` block at line 236):

```js
describe('waitForSearchBatchComplete', () => {
  // The helper hits db.prepare(...).get(searchPipelineId). The existing
  // db.js mock at the top of this file routes db.prepare based on SQL regex.
  // We extend it via per-test state on a new state.batchCountSeq array:
  // the mock returns { n: <next-value> } for the count query and pops the
  // array as it goes. Empty array → returns { n: 0 } (immediate resolve).
  //
  // The mock for db.prepare lives at the top of this file; ensure the
  // SELECT count(*) ... FROM broll_searches WHERE batch_id = ? branch
  // returns { n: state.batchCountSeq.shift() ?? 0 }.

  beforeEach(() => {
    state.batchCountSeq = []
  })

  it('resolves immediately when no rows are waiting/running', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js?wfsbc1=' + Date.now())
    state.batchCountSeq = [0]
    await expect(
      waitForSearchBatchComplete('search-batch-empty', { pollIntervalMs: 10, maxWaitMs: 1000 })
    ).resolves.toBeUndefined()
  })

  it('resolves once count reaches 0', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js?wfsbc2=' + Date.now())
    state.batchCountSeq = [3, 2, 1, 0]
    await expect(
      waitForSearchBatchComplete('search-batch-drain', { pollIntervalMs: 10, maxWaitMs: 1000 })
    ).resolves.toBeUndefined()
  })

  it('rejects on timeout when count never drains', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js?wfsbc3=' + Date.now())
    // Always returns 5 — never drains
    state.batchCountSeq = []
    state.batchCountAlways = 5
    await expect(
      waitForSearchBatchComplete('search-batch-stuck', { pollIntervalMs: 10, maxWaitMs: 50 })
    ).rejects.toThrow(/timed out/)
    state.batchCountAlways = undefined
  })

  it('returns early (no throw) when isCancelled callback returns true', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js?wfsbc4=' + Date.now())
    state.batchCountSeq = []
    state.batchCountAlways = 5
    let calls = 0
    const isCancelled = async () => { calls++; return calls >= 2 }
    await expect(
      waitForSearchBatchComplete('search-batch-cancel', {
        pollIntervalMs: 10, maxWaitMs: 5000, isCancelled,
      })
    ).resolves.toBeUndefined()
    state.batchCountAlways = undefined
  })
})
```

Update the existing `db.prepare()` mock at the top of `broll-runner.test.js` (around line 30-55, inside the SQL routing) to add a branch for the new query. Find the `prepare(sql) { return { ... } }` block and add inside its `get` handler, before the catch-all return:

```js
if (/SELECT count\(\*\)[\s\S]*FROM broll_searches[\s\S]*WHERE batch_id = \?/i.test(sql)) {
  if (state.batchCountAlways !== undefined) return { n: state.batchCountAlways }
  return { n: state.batchCountSeq.shift() ?? 0 }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/services/__tests__/broll-runner.test.js -t "waitForSearchBatchComplete"`

Expected: FAIL with "waitForSearchBatchComplete is not a function" (or similar export-missing error) on all four tests.

- [ ] **Step 3: Implement the helper**

Append to `server/services/broll-runner.js` immediately after the closing `}` of `waitForPipelinesComplete` (currently line 382):

```js
// waitForSearchBatchComplete — resolves when every broll_searches row tagged
// with this batch_id has left the waiting/running states. Polled because
// the GPU search worker (server/services/broll-search-worker.js) writes
// terminal status from another process — there is no in-memory signal
// available here. Tolerates 0-row batches: count is 0 on first poll → resolve.
//
// Used by the upload chain to gate "batch N done" before enqueuing batch N+1.
//
// Spec: docs/superpowers/specs/2026-05-01-broll-sequential-batches-design.md
export async function waitForSearchBatchComplete(searchPipelineId, {
  pollIntervalMs = 3000,
  maxWaitMs = 15 * 60_000,
  isCancelled = null,
} = {}) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    if (isCancelled && (await isCancelled())) return
    const row = await db.prepare(
      `SELECT count(*)::int AS n FROM broll_searches
       WHERE batch_id = ? AND status IN ('waiting', 'running')`
    ).get(searchPipelineId)
    if ((row?.n ?? 0) === 0) return
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  throw new Error(`waitForSearchBatchComplete: timed out after ${maxWaitMs}ms (batch ${searchPipelineId})`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/services/__tests__/broll-runner.test.js -t "waitForSearchBatchComplete"`

Expected: PASS — 4 tests passing.

- [ ] **Step 5: Run the full broll-runner test file (no regressions)**

Run: `npx vitest run server/services/__tests__/broll-runner.test.js`

Expected: PASS — all tests in the file (existing + new 4) pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/broll-runner.js server/services/__tests__/broll-runner.test.js
git commit -m "feat(broll): add waitForSearchBatchComplete helper

Polls broll_searches.batch_id until rows leave waiting/running.
Used by the upload chain to gate batch-N completion before enqueuing
batch N+1. Includes timeout, cancellation callback, and 0-row tolerance.

Spec: docs/superpowers/specs/2026-05-01-broll-sequential-batches-design.md"
```

---

## Task 2: Wire 3-iteration loop into the upload chain

**Files:**
- Modify: `server/services/auto-orchestrator.js` (3 call sites)
- Test: `server/services/__tests__/run-full-auto-broll-chain-lock.test.js`

### Step 1: Update existing chain test to expect the new behaviour (TDD)

Open `server/services/__tests__/run-full-auto-broll-chain-lock.test.js`. Update the runner mock (around line 70) to make `runBrollSearchFirst10` return a `searchPipelineId` and to add a `waitForSearchBatchComplete` mock:

```js
runBrollSearchFirst10: vi.fn(async () => {
  state.runnerCalls.push('runBrollSearchFirst10')
  return { searchPipelineId: `search-batch-mock-${state.runnerCalls.filter(c => c === 'runBrollSearchFirst10').length}` }
}),
waitForSearchBatchComplete: vi.fn(async () => {
  state.runnerCalls.push('waitForSearchBatchComplete')
}),
```

Add a new test inside `describe('runFullAutoBrollChain duplicate-fire guard', ...)` (or below it in the same file) — at the end of the file:

```js
describe('runFullAutoBrollChain Phase 4 sequential batches', () => {
  it('runs 3 sequential search batches with a wait between each', async () => {
    state.brollChainStatus = null
    state.brollChainHeartbeatAt = null
    await runFullAutoBrollChain(7)

    const searchCalls = state.runnerCalls.filter(c => c === 'runBrollSearchFirst10').length
    const waitCalls = state.runnerCalls.filter(c => c === 'waitForSearchBatchComplete').length
    expect(searchCalls).toBe(3)
    expect(waitCalls).toBe(3)

    // Verify ordering: each runBrollSearchFirst10 must be immediately
    // followed by a waitForSearchBatchComplete (no two enqueues in a row).
    const phase4 = state.runnerCalls.filter(
      c => c === 'runBrollSearchFirst10' || c === 'waitForSearchBatchComplete'
    )
    expect(phase4).toEqual([
      'runBrollSearchFirst10', 'waitForSearchBatchComplete',
      'runBrollSearchFirst10', 'waitForSearchBatchComplete',
      'runBrollSearchFirst10', 'waitForSearchBatchComplete',
    ])
  })
})
```

- [ ] **Step 2: Run the chain test to verify it fails**

Run: `npx vitest run server/services/__tests__/run-full-auto-broll-chain-lock.test.js -t "Phase 4 sequential"`

Expected: FAIL — `searchCalls` is 1 (current behaviour), expected 3. Or the new mock fields aren't picked up by the production code yet.

- [ ] **Step 3: Add the constant and refactor `runFullAutoBrollChain` Phase 4 (line 558)**

In `server/services/auto-orchestrator.js`:

Find the imports/top of the file. Add the constant near other module-level constants (or just below the imports if no other constants exist):

```js
// Number of sequential 10-per-variant batches to run during the upload
// chain's Phase 4. Each batch waits for the GPU worker to drain before
// the next enqueues. Spec:
// docs/superpowers/specs/2026-05-01-broll-sequential-batches-design.md
const BROLL_SEARCH_BATCHES = 3
```

Find Phase 4 in `runFullAutoBrollChain` (currently line 556-562). The current code is:

```js
    // Phase 4: search — always runs (idempotent re-run is safer than skipping)
    await db.prepare("UPDATE video_groups SET broll_chain_substage = 'search' WHERE id = ?").run(subGroupId)
    await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: plans.planPipelineIds })

    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
    ).run(subGroupId)
```

Replace with:

```js
    // Phase 4: search — always runs (idempotent re-run is safer than skipping).
    // Runs BROLL_SEARCH_BATCHES sequential batches of 10 per variant. Each
    // iteration waits for the GPU worker to drain before the next enqueues,
    // so broll_chain_status='done' reflects real GPU completion of all
    // ~30 placements/variant rather than just enqueue.
    await db.prepare("UPDATE video_groups SET broll_chain_substage = 'search' WHERE id = ?").run(subGroupId)
    for (let i = 0; i < BROLL_SEARCH_BATCHES; i++) {
      if (await isCancelled(subGroupId)) return
      const { searchPipelineId } = await runner.runBrollSearchFirst10({
        subGroupId, planPipelineIds: plans.planPipelineIds,
      })
      await runner.waitForSearchBatchComplete(searchPipelineId, {
        isCancelled: () => isCancelled(subGroupId),
      })
    }

    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
    ).run(subGroupId)
```

- [ ] **Step 4: Refactor `resumeChain` Phase 4 — `fromStage='plan'` branch (line 611)**

In `server/services/auto-orchestrator.js`, find inside `resumeChain` the `fromStage === 'plan'` branch (lines ~596-615). The current search call is:

```js
      await db.prepare("UPDATE video_groups SET broll_chain_substage = 'search' WHERE id = ?").run(subGroupId)
      await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: plans.planPipelineIds })
      await db.prepare(
        "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
      ).run(subGroupId)
```

Replace with:

```js
      await db.prepare("UPDATE video_groups SET broll_chain_substage = 'search' WHERE id = ?").run(subGroupId)
      for (let i = 0; i < BROLL_SEARCH_BATCHES; i++) {
        if (await isCancelled(subGroupId)) return
        const { searchPipelineId } = await runner.runBrollSearchFirst10({
          subGroupId, planPipelineIds: plans.planPipelineIds,
        })
        await runner.waitForSearchBatchComplete(searchPipelineId, {
          isCancelled: () => isCancelled(subGroupId),
        })
      }
      await db.prepare(
        "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
      ).run(subGroupId)
```

- [ ] **Step 5: Refactor `resumeChain` Phase 4 — `fromStage='search'` branch (line 617)**

Still in `resumeChain`, find the `else if (fromStage === 'search')` branch (lines ~616-621). The current code is:

```js
    } else if (fromStage === 'search') {
      await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: opts.planPipelineIds || [opts.planPipelineId] })
      await db.prepare(
        "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
      ).run(subGroupId)
```

Replace with:

```js
    } else if (fromStage === 'search') {
      const planPipelineIds = opts.planPipelineIds || [opts.planPipelineId]
      for (let i = 0; i < BROLL_SEARCH_BATCHES; i++) {
        if (await isCancelled(subGroupId)) return
        const { searchPipelineId } = await runner.runBrollSearchFirst10({
          subGroupId, planPipelineIds,
        })
        await runner.waitForSearchBatchComplete(searchPipelineId, {
          isCancelled: () => isCancelled(subGroupId),
        })
      }
      await db.prepare(
        "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
      ).run(subGroupId)
```

- [ ] **Step 6: Run the chain test to verify it now passes**

Run: `npx vitest run server/services/__tests__/run-full-auto-broll-chain-lock.test.js`

Expected: PASS — including the new `Phase 4 sequential batches` test (3+3 calls, correct interleaved ordering) and all existing tests (duplicate-fire guard etc.).

- [ ] **Step 7: Run the full server test suite (catch any regressions)**

Run: `npx vitest run server/`

Expected: PASS — every existing test still green; no test references the old single-call behaviour.

If any test fails, the most likely culprit is a stale runner mock for `runBrollSearchFirst10` returning `undefined` instead of `{ searchPipelineId }`. Update those mocks the same way as in Step 1.

- [ ] **Step 8: Commit**

```bash
git add server/services/auto-orchestrator.js server/services/__tests__/run-full-auto-broll-chain-lock.test.js
git commit -m "feat(broll): run 3 sequential search batches in upload chain

Phase 4 of runFullAutoBrollChain (and both resumeChain branches)
now loops 3 times: enqueue 10/variant, wait for GPU drain, repeat.
broll_chain_status='done' now reflects ~30 placements/variant
actually searched, not just enqueued.

Spec: docs/superpowers/specs/2026-05-01-broll-sequential-batches-design.md"
```

---

## Task 3: Update processing modal label

**Files:**
- Modify: `src/components/views/ProcessingModal.jsx:70`

- [ ] **Step 1: Apply the label change**

Open `src/components/views/ProcessingModal.jsx`. At line 70, change:

```jsx
    { id: 'broll_search',   label: 'B-roll search (first 10)', active: brollActive && brollSubstage === 'search', done: brollDone },
```

To:

```jsx
    { id: 'broll_search',   label: 'B-roll search (first 30)', active: brollActive && brollSubstage === 'search', done: brollDone },
```

- [ ] **Step 2: Verify no test asserts on the old label**

Run: `grep -rn "first 10" src/ server/`

Expected: 0 matches in source/test files (only in the spec/plan docs, which is fine).

If any test references `'first 10'`, update it to `'first 30'` in the same commit.

- [ ] **Step 3: Run the frontend test suite**

Run: `npx vitest run src/`

Expected: PASS — no failures.

- [ ] **Step 4: Commit**

```bash
git add src/components/views/ProcessingModal.jsx
git commit -m "feat(processing-modal): update b-roll search label to first 30

Reflects the new 3-batch sequential search in the upload chain
(10 placements/variant × 3 batches = 30 total).

Spec: docs/superpowers/specs/2026-05-01-broll-sequential-batches-design.md"
```

---

## Task 4: Manual smoke test

**No code changes — verification only. Skip if blocked on deployment.**

- [ ] **Step 1: Push to a deploy branch and let Vercel build**

```bash
git push origin <branch>
```

Wait for the Vercel deploy to complete (auto-deploys on push, but cancels unsigned commits — confirm it actually built).

- [ ] **Step 2: Upload a fresh project end-to-end**

Open `https://transcript-eval-sylvesterads-projects.vercel.app/?step=upload`.

Upload a video with enough placements (≥30 b-roll placements per variant in the plan) to actually exercise three batches. A 5-10 minute clip with normal density is typically sufficient.

- [ ] **Step 3: Watch the processing modal**

While processing, confirm:
- The b-roll search stage label reads "B-roll search (first 30)"
- The stage stays active substantially longer than before (≈3× the previous wall-clock for that stage, since searches now actually run, not just enqueue)
- Final stage flips to "Done" only after all GPU searches finish

- [ ] **Step 4: Inspect search results in the editor**

Open the resulting project. For each variant:
- Confirm ≈30 placements have been searched (look for thumbnail strips in placements 1-30)
- Confirm placement 31+ remains unsearched (still requires manual "search next batch")

- [ ] **Step 5: Test cancel mid-batch**

Start another upload. During the search stage (after batch 1 has begun draining), click Cancel.

Confirm:
- Chain stops; subsequent iterations do not enqueue new rows
- No phantom "Done" notification fires
- `broll_searches` rows for the cancelled batch hit terminal status (`stopped`, `failed`, or `complete` for already-running rows)

- [ ] **Step 6: Inspect the DB after a successful run (optional)**

```sql
SELECT batch_id, count(*), array_agg(DISTINCT status) AS statuses
FROM broll_searches
WHERE plan_pipeline_id = '<one of the plan pipeline ids from the run>'
GROUP BY batch_id
ORDER BY batch_id;
```

Expected: 3 distinct `batch_id` values (the three `search-batch-<ts>` ids), each with `count` ≈ 10 and `statuses` containing only terminal values (`complete`, `failed`, `stopped`, `timeout`).

---

## Self-Review

Spec coverage:
- 3 sequential batches with wait between → Tasks 1–2 ✓
- `done` reflects real GPU completion → Task 2 (loop awaits each wait before status update) ✓
- Cancellation respected between batches → Task 2 (`isCancelled` check at start of each iteration + passed into wait) ✓
- Frontend label update → Task 3 ✓
- Manual smoke → Task 4 ✓
- Edge cases: variant <10 left, all exhausted before iter 3, worker stuck, wait timeout → handled by existing mechanisms (worker reclaimer, executeSearchBatch's enqueue-only behavior, `_getPendingGpuPlacements` exclusion) — no extra task needed ✓

Placeholder scan: no TBD/TODO. All code blocks are concrete.

Type consistency: `searchPipelineId` is the same property name returned by `runBrollSearchFirst10` and consumed by `waitForSearchBatchComplete` everywhere. `BROLL_SEARCH_BATCHES` is the same constant in all three call sites. `isCancelled` keeps the same `() => Promise<boolean>` signature in helper and chain.

Non-goals respected: no UI sub-stages, no configurable batch count from UI, no integration test, no changes to `batchSize=10`, no worker/reclaimer touch.
