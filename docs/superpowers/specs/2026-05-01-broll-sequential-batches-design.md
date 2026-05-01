# B-Roll Search: Sequential 3-Batch During Upload — Design Spec

**Date:** 2026-05-01
**Status:** Approved by user, ready for implementation plan
**Scope:** `auto-orchestrator.js` Phase 4, `broll-runner.js`, `ProcessingModal.jsx`

## Problem

During the full-auto upload chain, Phase 4 enqueues exactly one batch of 10 b-roll search rows per variant (`server/services/auto-orchestrator.js:558` → `server/services/broll-runner.js:387` → `server/services/broll.js:2155`). The chain immediately marks `broll_chain_status='done'` after enqueue, regardless of GPU completion.

Result:
- Each variant gets only 10 placements searched per upload
- The user must manually click "search next batch" in the editor to fetch more results
- The "done" status reflects enqueue, not actual search completion

## Solution

Run the existing 10-per-variant batch **three times sequentially** during Phase 4. Each iteration waits for its `broll_searches` rows to drain (status leaves `waiting`/`running`) before the next begins. The chain marks `done` only after all three batches have actually been searched.

End state: up to 30 placements per variant searched (or fewer if a variant runs out) by the time the processing modal flips to "Done".

### Goals

- 30 placements per variant searched on upload (up from 10)
- Chain `done` reflects real GPU completion of all enqueued searches
- Each batch's keyword generation stays tightly coupled to that batch's 10 rows
- Cancellation respected between batches

### Non-goals

- Configurable batch count / batch size from the UI (`BROLL_SEARCH_BATCHES = 3` is a source constant)
- Per-batch UI sub-stages ("1 of 3" / "2 of 3") — single label update is enough
- Changing existing `batchSize=10` semantics, interleaving order, or keyword logic
- Touching the worker, reclaimer, or `_getPendingGpuPlacements`

## Architecture

```
Phase 4 (broll_chain_substage='search')
  ↓
for i in 1..BROLL_SEARCH_BATCHES (=3):
    if cancelled → break
    { searchPipelineId } = runBrollSearchFirst10(...)   // enqueues 10/variant, returns immediately
    waitForSearchBatchComplete(searchPipelineId)        // polls broll_searches.batch_id until drained
  ↓
broll_chain_status = 'done'
```

**Key invariant unchanged:** `_getPendingGpuPlacements` (`server/services/broll.js:2412-2420`) already excludes placements whose `broll_searches` row is `waiting`/`running`/`complete`. Each iteration's `executeSearchBatch` therefore picks the next 10 unsearched placements per variant — no double-picking, no special coordination required.

## Components

### New code

**`server/services/broll-runner.js`** — add `waitForSearchBatchComplete(searchPipelineId, opts)`:

- Polls `SELECT count(*) FROM broll_searches WHERE batch_id = $1 AND status IN ('waiting','running')` every `pollIntervalMs` (default 3000)
- Resolves when count hits 0
- Rejects on `maxWaitMs` timeout (default 15 min)
- If `isCancelled()` callback returns true, returns early without throwing (chain handles cancel)
- Tolerates 0-row batches (count is already 0 → resolves immediately on first poll)

Mirrors the shape of the existing `waitForPipelinesComplete` helper.

### Modified code

**`server/services/auto-orchestrator.js`**

- Add module-level constant `const BROLL_SEARCH_BATCHES = 3`
- Replace single `runBrollSearchFirst10` call at three sites with a loop that calls `runBrollSearchFirst10` then `waitForSearchBatchComplete` per iteration:
  - `runFullAutoBrollChain` Phase 4 (line 558)
  - `resumeChain` `fromStage='plan'` final search step (line 611)
  - `resumeChain` `fromStage='search'` (line 617)
- Each iteration checks `isCancelled(subGroupId)` first

**`src/components/views/ProcessingModal.jsx`**

- Line 70: change label `'B-roll search (first 10)'` → `'B-roll search (first 30)'`
- No structural change to the stages array

## Data flow

```
[upload chain]
  classify → sync → rough_cut → broll_refs → strategy → plan
  ↓
  Phase 4: search
    iteration 1:
      runBrollSearchFirst10(planPipelineIds, batchSize=10)
        → executeSearchBatch
            → _getPendingGpuPlacements(pid).slice(0, 10)   // first 10/variant
            → keywords for missing
            → INSERT broll_searches rows (status='waiting', batch_id=searchPipelineId_1)
            → return { searchPipelineId_1 }
      waitForSearchBatchComplete(searchPipelineId_1)
        → poll: count waiting+running where batch_id=searchPipelineId_1
        → broll-search-worker drains rows one at a time
        → resolve when count=0

    iteration 2: (same, but _getPendingGpuPlacements now excludes the 10 already 'complete' → returns next 10)
    iteration 3: (same, returns placements 21-30 if available)
  ↓
  broll_chain_status='done'
```

## Edge cases

| Case | Behavior |
|------|----------|
| Variant has <10 unsearched in iteration N | `executeSearchBatch` enqueues whatever is available; worker drains; loop continues |
| All variants exhausted before iteration 3 | Subsequent iterations enqueue 0 rows; `waitForSearchBatchComplete` returns immediately (count is already 0); harmless |
| User cancels mid-batch | `isCancelled(subGroupId)` checked at start of each iteration; in-flight rows handled by existing `abortedBrollPipelines` mechanism in the worker |
| Worker stuck on a row (>20min) | Existing reclaimer (`broll-search-worker.js:130-156`) retries up to 3× then marks failed; `waitForSearchBatchComplete` sees terminal status either way |
| Single row fails permanently | `'failed'` is a terminal status — the wait does not block on it |
| Wait hits 15-min timeout | Throws; chain's existing catch sets `broll_chain_status='failed'` |
| Process restart mid-batch | Worker auto-resumes draining the queue. The chain's auto-resume (`resumeStuckFullAutoChains`) re-enters Phase 4 and starts a fresh 3-iteration loop. Already-searched placements are excluded by `_getPendingGpuPlacements`, so re-entry is idempotent for the search phase. |
| Keyword generation fails in iteration N | Existing `executeSearchBatch` catch path marks remaining `waiting`/`running` rows as `failed`; the loop's wait sees terminal status; loop continues to iteration N+1 (which will skip the already-failed placements via `_getPendingGpuPlacements` exclusion of `'complete'` — note: `'failed'` rows are NOT currently excluded, so they would be re-attempted; this matches today's behavior and is out of scope) |

## Tests

### Unit

- `waitForSearchBatchComplete`:
  - Resolves when DB count of waiting+running for `batch_id` reaches 0
  - Rejects with timeout error after `maxWaitMs`
  - Returns early (no throw) when `isCancelled()` callback returns true
  - Resolves immediately for batch with 0 rows
- Auto-orchestrator chain (mocked runner):
  - `runBrollSearchFirst10` called exactly 3 times
  - `waitForSearchBatchComplete` called between iterations with the right `searchPipelineId`
  - Loop breaks early on cancellation between iterations

### Integration

- Real Postgres + mocked GPU URL: run the loop end-to-end
- Verify `_getPendingGpuPlacements` advances `0 → 10 → 20 → 30` placements per variant across the three iterations
- Verify final `broll_searches` row count for the chain = sum of placements actually picked

### Manual smoke

- Upload via `https://transcript-eval-sylvesterads-projects.vercel.app/?step=processing&group=<new>`:
  - Watch processing modal: "B-roll search (first 30)" stage active
  - After completion, editor shows ~30 search results per variant
  - Cancel during batch 2 → chain stops, no further enqueues

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Wall-clock time of upload roughly triples (3× search wait) | Acceptable — search is non-blocking for the user (they can leave the modal); the `done` notification still fires when actually done |
| 15-min wait timeout too short for slow GPU days | Existing reclaimer + retry mechanism keeps rows progressing; if a single batch genuinely cannot finish in 15 min, that's already a degraded state that needs investigation |
| Auto-resume after server restart | Re-enters Phase 4 with fresh 3-iteration loop. Worst case: a fourth or fifth batch effectively runs for the same variant if the resume happens after iteration 3 enqueued. In practice, `_getPendingGpuPlacements` exclusion bounds it: once 30 are searched, subsequent iterations enqueue 0. |

## Implementation order

1. Add `waitForSearchBatchComplete` to `broll-runner.js` + unit tests
2. Refactor `auto-orchestrator.js` Phase 4 (3 sites) to use the loop + constant
3. Add chain-level unit test for 3-iteration loop
4. Add integration test
5. Update `ProcessingModal.jsx` label
6. Manual smoke on a fresh upload

Each step independently mergeable.
