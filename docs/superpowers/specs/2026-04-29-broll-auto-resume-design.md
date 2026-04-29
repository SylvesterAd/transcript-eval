# B-Roll Auto-Resume & In-Stage Retry — Design

**Date:** 2026-04-29
**Status:** Design approved, ready for implementation plan

## Problem

B-roll pipelines die when the server restarts. Today the user must visit `/admin/broll-runs` and manually click **Resume** on each interrupted pipeline. Separately, transient stage failures (network blips, CF 502s, GPU 503s) mark a pipeline `failed` even when a single retry would have succeeded.

A chain-level auto-resume already exists (`server/services/auto-orchestrator.js:396` — `resumeStuckFullAutoChains`), but it re-fires entire chains from scratch via `runFullAutoBrollChain`. On 2026-04-29 this caused ~50 spurious analysis sub-runs for video 401 / refs ex388, ex400 — the function does not honor the substage marker that records progress.

## Goal

Two surgical changes:

1. **In-stage retry** — auto-retry sub-run / main-stage LLM calls 2× before failing the pipeline.
2. **Smart chain resume on boot** — for any `video_groups` row with `broll_chain_status='running'`, resume interrupted pipelines via the smart per-pipeline resume endpoint and advance the chain from the recorded substage. Replaces the dangerous re-fire-from-scratch behavior.

## Scope

### In scope

- `executePipeline` and stages it owns directly (`server/services/broll.js`).
- `resumeStuckFullAutoChains` and `runFullAutoBrollChain` (`server/services/auto-orchestrator.js`).
- Refactor of `POST /broll/pipeline/:id/resume` route body into a callable `resumePipeline(pipelineId, opts)` so the boot path can call it directly.

### Out of scope

- Error classification (transient vs deterministic). Retry-everything per user decision.
- Pipeline-level boot resume for chains *not* in `running` state. Abandoned/failed chains stay manual via existing Resume button.
- Schema changes for liveness / heartbeat tracking. Existing inference (expected stages > completed) remains the source of truth.
- Cost ceiling per pipeline.
- Changes to manual buttons (Resume, Restart, per-stage Re-run) — they keep working unchanged.
- Alt-plan / keywords / b-roll-search pipelines (`alt-` / `kw-` / `bs-` prefixed pipelineIds). The existing resume endpoint already rejects these and they have dedicated re-trigger endpoints. Same exclusion applies to in-stage retry — only `executePipeline`'s own LLM calls get wrapped.
- Admin-UI changes (no badge, no retry-count column). Ship retries silent except for server logs; revisit if rates warrant a UI surface.

## Design

### Piece 1 — In-stage retry

**Helper** in `server/services/broll.js`:

```js
async function withRetry(fn, { tries = 3, backoff = [5_000, 30_000], pipelineId, label }) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (abortedBrollPipelines.has(pipelineId)) throw new Error('Aborted')
    try { return await fn() }
    catch (err) {
      if (attempt === tries) throw err
      console.log(`[broll-retry] ${label} attempt ${attempt}/${tries} failed: ${err.message}, retrying in ${backoff[attempt - 1]}ms`)
      await new Promise(r => setTimeout(r, backoff[attempt - 1]))
    }
  }
}
```

`tries = 3` = 1 initial attempt + 2 retries with backoff at 5s and 30s. Abort check runs before each attempt so a user-clicked Stop kills the loop within ~30s worst case.

**Wrap points** (only inside `executePipeline` — not alt/kw/bs):

1. The `callLLM(...)` invocation inside each sub-run iteration of stages that fan out per chapter / window.
2. The `callLLM(...)` invocation for main stages without sub-runs.

**Not wrapped:** alt/kw/bs pipelines, `storeSubRun` / DB writes, the whole `executePipeline` body.

**Final-failure semantics unchanged:** after retries exhausted, the existing throw → catch → mark-failed path runs. Pipeline status becomes `failed`; the failed sub-run is not stored as `complete`; existing failure UI surfaces it.

**Observability:** console log on each retry with `pipelineId`, label, attempt count, error message. No DB write, no schema change, no admin-UI change.

### Piece 2 — Smart chain resume on boot

**Refactor first:** extract the body of `POST /broll/pipeline/:id/resume` (`server/routes/broll.js:795-940`) into `resumePipeline(pipelineId, opts)` exported from `server/services/broll.js`. The HTTP route becomes a thin wrapper. Returns the same `{ pipelineId, resumed, completedStages }` shape and exposes the underlying `executePipeline` promise so the caller can await completion.

**Modify `runFullAutoBrollChain`** to accept `{ resumeFromSubstage }`. When set, the function reads `broll_runs` for the group's videos (and reference videos for the `refs` substage) and skips any phase whose outputs already exist. Existing callers pass nothing and keep current behavior — only the boot path passes the new option.

**Rewrite the second loop in `resumeStuckFullAutoChains`** (`auto-orchestrator.js:409-415`). The first loop ("stuck" chains where `broll_chain_status IS NULL`) is unchanged.

Algorithm per group, executed serially with the existing 3-second startup delay:

```
for each video_group with broll_chain_status='running':
  substage = group.broll_chain_substage   // 'refs' | 'strategy' | 'plan' | 'search' | NULL

  # Step 1: resume any interrupted pipeline for this group
  interruptedPipelineIds = scan broll_runs joined to videos in this group
                           (and to reference videos when substage='refs'),
                           grouped by pipelineId,
                           where expectedStages from metadata > completed stages count
  for pid in interruptedPipelineIds:
    await resumePipeline(pid)

  # Step 2: advance the chain from the current substage
  if substage in ('plan', 'search'):
    await resumeChain(group.id, substage)
  else if substage in ('refs', 'strategy', NULL):
    await runFullAutoBrollChain(group.id, { resumeFromSubstage: substage || 'refs' })
```

**Concurrency:** serial across groups (matches existing for-loop pattern). Within a group, serial across pipelines.

**Failure handling per group:** if `resumePipeline` or the chain advance throws, log and continue to the next group. Group's `broll_chain_status` stays `running`; will be retried on next boot. Boots are infrequent so this is a bounded retry by human action.

**Logging at boot:** `[startup] resumed N interrupted pipelines across M chains; advanced K chains from substage`.

**No schema change.** `broll_chain_substage` column already exists (commit `6adc025`).

## Interactions

- Manual Resume / Restart / per-stage Re-run buttons on `/admin/broll-runs` keep working unchanged. Boot resume is just an automatic invocation of `resumePipeline` — same function the manual button hits.
- The `Stop` button still works mid-retry. `withRetry` checks `abortedBrollPipelines` before each attempt and throws `Aborted`.

## Edge cases

1. **Two boots in quick succession.** A boot resume mid-flight when the server restarts: second boot sees the same `broll_chain_status='running'` and resumes again. `resumePipeline` is idempotent (skips already-completed sub-runs), so at most one stage repeats once.
2. **Group's video deleted between crash and boot.** `resumePipeline` throws; per-group failure handling logs and continues.
3. **Strategy edited between crash and boot.** Existing resume logic maps stage outputs to the new template by `stageName` and skips stages no longer in the template (`broll.js:866-874`). Inherited.
4. **Retry succeeds, next sub-run fails permanently.** Pipeline marked `failed`; sub-runs stored individually; manual Resume from admin UI works as today.
5. **Stale substage marker** (crash mid-substage transition). The per-phase output detection in modified `runFullAutoBrollChain` is the source of truth — phase with outputs is skipped regardless of marker.
6. **Reference-video analysis pipelines** (the cause of the 50-run incident). Step 1's SQL must include videos that are reference videos of the group when `substage='refs'`. Implementation must verify the join covers this case; regression test required.

## Risks

- **Modifying `runFullAutoBrollChain`** is the highest-risk change — it's the function whose existing behavior caused the incident. Mitigation: `resumeFromSubstage` is opt-in. Existing callers pass nothing and get unchanged behavior. Only the boot-resume path passes the new option.
- **`withRetry` wrapping the wrong calls** could turn a permanent failure into 3× the cost. Mitigation: scope limited to `executePipeline`'s own LLM calls; alt/kw/bs and DB writes explicitly out.

## Testing

**Per the memory's "Dev Server Boot Hazard" warning, never `npm run dev:server` for verification — booting fires the resume path. All tests are unit-level against the functions directly.**

1. **`withRetry`**:
   - succeeds on first try → no retry
   - fails twice, succeeds on third → 2 retries, returns value
   - fails 3 times → throws last error
   - aborted between attempts → throws `Aborted`, doesn't sleep further
   - backoff timing (use fake timers)

2. **`resumePipeline` extracted callable**:
   - move existing route-level coverage to call the new function directly
   - HTTP route test reduces to "thin wrapper passes through args"

3. **`runFullAutoBrollChain` with `resumeFromSubstage`**:
   - phase with existing outputs in `broll_runs` → skipped
   - phase without outputs → executed
   - default (no option) → unchanged behavior

4. **`resumeStuckFullAutoChains` second loop**:
   - group with `broll_chain_status='running'` and partial pipeline → calls `resumePipeline` for that pipelineId
   - group with substage='plan' and completed plan → skips Step 1, advances chain
   - group with substage='refs' and partial reference-video analysis → finds ref-video pipelines (regression test for the 50-run incident)
   - resume of one group throws → next group still processed

5. **SQL "find interrupted pipelines for group"**:
   - direct test against a seeded fixture; covers the join through reference videos when `substage='refs'`

**Manual smoke (deferred to human partner):**

- Kill dev server mid-pipeline → restart → confirm interrupted pipeline auto-resumes from the right sub-run, no duplicate work in `broll_runs`.
- Same scenario at `substage='refs'` with reference videos in flight → confirm no spurious analysis runs (50-run regression check).

**Out of test scope:**

- End-to-end LLM integration (cost, flakiness). Retries observed via production logs.
- Performance under many simultaneous interrupted chains — boot loop is serial, expected boot count small.

## File Touch List

| File | Change |
|------|--------|
| `server/services/broll.js` | Add `withRetry` helper. Wrap `callLLM` calls inside `executePipeline` sub-run loops and main stages. Extract `resumePipeline` from the route. Export it. |
| `server/routes/broll.js` | `POST /pipeline/:id/resume` becomes a thin wrapper around `resumePipeline`. |
| `server/services/auto-orchestrator.js` | Rewrite second loop in `resumeStuckFullAutoChains`. Add `{ resumeFromSubstage }` option to `runFullAutoBrollChain`; teach it to skip phases whose outputs exist. |

No schema migration. No frontend changes. No new files.

## Manual Smoke Checklist (post-merge)

Before merging to main, the human partner should verify:

1. **Interrupted pipeline at substage='plan' resumes correctly:**
   - Start a hands-off chain on a small test project.
   - Wait for it to enter the plan phase (admin/broll-runs shows an active plan pipeline with several sub-runs done).
   - Kill the dev server (Ctrl+C).
   - Restart `npm run dev:server`.
   - Within ~3 seconds, the admin page should show the plan pipeline back in "running" with its existing sub-runs preserved (no duplicates).
   - When the plan completes, the chain should advance to the search phase automatically.

2. **No spurious analysis runs (50-run regression check):**
   - Start a fresh hands-off chain.
   - Kill the server during the refs substage (while reference-video analysis pipelines are running).
   - Restart.
   - Verify in the admin/broll-runs page that no NEW analysis pipelines appear for already-analyzed reference videos. The interrupted analysis should resume in place; the rest of refs should be skipped.

3. **In-stage retry observed in logs:**
   - Tail server logs while a pipeline runs.
   - Look for `[broll-retry]` lines on transient failures (CF 502, GPU 503, network blip).
   - Each retry should sleep 5s then 30s. After 3 attempts (1 + 2 retries), if still failing, the existing failure handler kicks in.
