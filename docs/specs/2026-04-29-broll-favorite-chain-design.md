# B-Roll Strategy Favorite-First Chain — Design

**Date:** 2026-04-29
**Status:** Approved by user, awaiting written-spec final review
**Author/Driver:** Laurynas (with Claude assistance)
**Related branch:** `feature/broll-audience-placeholder`
**Working directory:** `/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/broll-audience/`

> All file paths in this document are relative to the worktree above. Code edits, new files, tests, and the design doc itself live ONLY inside that worktree. Commits land on `feature/broll-audience-placeholder`, not main.

## Problem

After reference analyses complete, `runStrategies()` fires every per-reference `executeCreateStrategy` plus the single `executeCreateCombinedStrategy` in parallel (fire-and-forget at [server/services/broll-runner.js:160-197](../../server/services/broll-runner.js)). With multiple references, the resulting per-reference strategies frequently overlap — same beat angles, same visual approaches — because each variant runs blind to what the others are producing. The combined strategy partially compensates, but the per-reference variants are not differentiated from one another.

## Goal

Differentiate non-favorite (Variant) reference videos' strategies from the Favorite by:

1. Firing the **Favorite's CreateStrategy** and the **CombinedStrategy** immediately and in parallel (unchanged behavior).
2. Sequencing Variants in a **chain after Favorite completes**: Variant B sees Favorite's chapter+beat strategy, Variant C sees Favorite + Variant B's, Variant D sees Favorite + B + C, and so on.
3. Injecting each prior strategy's **chapter-matched slim output** (chapter `strategy` + `beat_strategies`) into each Variant's per-chapter prompt with a "do NOT produce a similar strategy" directive.

CombinedStrategy is unaffected — it still fires immediately and runs alongside Favorite.

## Non-goals

- Plan stage (downstream of strategy) is unchanged
- CombinedStrategy seed is unchanged
- No retry/backoff logic for Variant chain failures (loud-fail per existing pattern)
- No UI changes — orchestration is server-side

## Architecture

### High-level flow (3-reference example)

```
Refs: [Favorite F, Variant B, Variant C]

t=0 :  brollPipelineProgress.set(F.pid, B.pid, C.pid, Combined.pid)  // all reserved upfront
       executeCreateStrategy(F)           // fire and forget, no priors
       executeCreateCombinedStrategy()    // fire and forget, independent
       spawn async chain { ... }          // single fire-and-forget for the chain

t=Tf:  F completes
       executeCreateStrategy(B, priors=[F.pid])    awaited
t=Tb:  B completes
       executeCreateStrategy(C, priors=[F.pid, B.pid])    awaited
t=Tc:  C completes; chain done
```

### File-level changes

#### 1. [server/services/broll-runner.js](../../server/services/broll-runner.js) — modify `runStrategies()`

- Map each `analysisPipelineId` to its reference video by extracting the `-ex<videoId>` suffix already encoded in the ID (line 81 already uses this regex for dedup).
- Call `loadExampleVideos(subGroupId)` to find which video has `isFavorite === true`. If none (defensive — UI enforces favorite at upload), fall back to `exampleVideos[0]` to match existing pattern at [broll.js:1080](../../server/services/broll.js).
- Sort `analysisPipelineIds`: Favorite first, then Variants in the order they appear in `loadExampleVideos`'s return (which is insertion order from `broll_example_sources` rows). Map analysis IDs back to videos via the `-ex<videoId>` suffix regex; if any analysis ID fails to match, throw with the offending ID rather than silently dropping it.
- Reserve all strategy pipeline IDs (Favorite, all Variants, Combined) upfront in `brollPipelineProgress`. The caller's `waitForPipelinesComplete(strategyPipelineIds)` continues to work unchanged.
- **Fire immediately:**
  - Favorite's `executeCreateStrategy` with `priorStrategyPipelineIds=[]`
  - The single `executeCreateCombinedStrategy` (untouched)
- **Spawn one fire-and-forget async chain** for Variants:
  ```
  ;(async () => {
    await waitForPipelinesComplete([favoritePid])
    const completed = [favoritePid]
    for (const variant of variants) {
      await executeCreateStrategy(prepPipelineId, variant.analysisPipelineId,
        mainVideoId, subGroupId, variant.pid, completed.slice())
      completed.push(variant.pid)
    }
  })().catch(err => {
    console.error(`[broll-chain] chain failed: ${err.message}`)
    // Mark every variant pipeline still in 'running' as failed:
    for (const v of variants) {
      const p = brollPipelineProgress.get(v.pid)
      if (p && p.status === 'running') {
        brollPipelineProgress.set(v.pid, { ...p, status: 'failed', error: err.message })
      }
    }
  })
  ```
- Return `{ strategyPipelineIds, combinedPipelineId }` immediately — return shape unchanged.

#### 2. [server/services/broll.js](../../server/services/broll.js) — modify `executeCreateStrategy()` (line 2388)

**Signature change** — add a trailing optional parameter:
```
executeCreateStrategy(prepPipelineId, analysisPipelineId, videoId, groupId,
  pipelineIdOverride, priorStrategyPipelineIds = [])
```

**Top-of-function guards** (after stages parse, before pipeline state setup):
- Self-reference: `priorStrategyPipelineIds.includes(pipelineIdOverride)` → throw
- Each prior must have at least one `complete` row in `broll_runs` (DB confirmation, not just in-memory)
- Log `[broll-chain] executeCreateStrategy <pid> priors=[...]`

**Per-chapter substitution** (inside the per-chapter loop around [broll.js:2573](../../server/services/broll.js)):
- After existing chapter-scoped `.replace()` calls but before LLM call:
  ```
  const priorChapterText = await loadPriorChapterStrategies(priorStrategyPipelineIds, c)
  if (priorStrategyPipelineIds.length > 0 && !priorChapterText) {
    throw new Error(`[broll-chain] expected non-empty priors for chapter ${c}, got empty`)
  }
  chPrompt = chPrompt.replace(/\{\{prior_chapter_strategies\}\}/g, priorChapterText)
  chSystem = chSystem.replace(/\{\{prior_chapter_strategies\}\}/g, priorChapterText)
  console.log(`[broll-chain] variant ${pipelineIdOverride} chapter ${c} injecting priors n=${priorStrategyPipelineIds.length} bytes=${priorChapterText.length}`)
  ```

**New helpers** in a new file `server/services/broll-prior-strategies.js` (separate module so unit tests can import without mocking broll.js — same pattern used for `audience-formatter.js` in this branch):

```
async function loadPriorChapterStrategies(priorPids, chapterIndex) {
  if (!priorPids?.length) return ''
  const blocks = []
  for (const pid of priorPids) {
    const subRun = await db.prepare(
      `SELECT br.output_text, br.video_id, v.title FROM broll_runs br
       LEFT JOIN videos v ON v.id = br.video_id
       WHERE br.metadata_json LIKE ?
         AND br.metadata_json LIKE ?
         AND br.metadata_json LIKE '%"isSubRun":true%'
         AND br.status = 'complete'
       ORDER BY br.id DESC LIMIT 1`
    ).get(`%"pipelineId":"${pid}"%`, `%"subIndex":${chapterIndex}%`)
    if (!subRun) {
      throw new Error(`[broll-chain] missing sub-run: pid=${pid} chapter=${chapterIndex}`)
    }
    const slim = slimChapterStrategy(subRun.output_text)
    const label = subRun.title ? `Reference: ${subRun.title}` : pid
    blocks.push(`=== Source: ${label} ===\n${slim}`)
  }
  return `## Prior strategies for this chapter (do NOT produce a similar strategy):\n${blocks.join('\n\n')}`
}

function slimChapterStrategy(rawJsonText) {
  let parsed
  try { parsed = JSON.parse(rawJsonText) } catch { parsed = extractJSON(rawJsonText) }
  if (!parsed) return rawJsonText.slice(0, 2000)  // last-resort raw passthrough
  const slim = {
    strategy: parsed.strategy ?? null,
    beat_strategies: parsed.beat_strategies ?? [],
  }
  return JSON.stringify(slim, null, 2)
}
```

The slim drops `matched_reference_chapter`, `frequency_targets`, and other bookkeeping fields. Keeps `strategy` (chapter-level rules) + `beat_strategies` (per-beat strategy_points) — the substantive "Chapter + Beats strategy".

#### 3. [server/seed/update-create-strategy-beat-first.js](../../server/seed/update-create-strategy-beat-first.js) — update per-chapter prompt

Insert at the **top of Step 5**, immediately after the `## Step 5: Build per-beat strategies (CRITICAL)` heading:

```
## Step 5: Build per-beat strategies (CRITICAL)

{{prior_chapter_strategies}}

If prior strategies for this chapter are shown above, your strategy MUST be
meaningfully different. Do not produce the same or a similar approach. Choose
different visual angles, different beat strategies, different style/motion
choices. The goal is genuine variety across reference videos — not minor
re-wordings.

This is the most important part. For each beat in THIS chapter:
... (rest of existing Step 5 unchanged) ...
```

When `{{prior_chapter_strategies}}` resolves to `""` (Favorite's run, no priors), the directive paragraph reads as a no-op because the conditional ("If prior strategies … are shown above") gates on visible content. Favorite's prompt is effectively unchanged.

The seed is idempotent — anchors on the known string `## Step 5: Build per-beat strategies (CRITICAL)` and replaces the surrounding block, so re-running won't double-insert.

#### 4. Live strategy id=9 (production)

The seed update sets the new default for fresh installs. The live `id=9` row will not auto-update. Deploy options:
- Re-run the updated seed against prod DB (idempotent), OR
- Manually edit prompt in admin UI, OR
- Write a small one-off migration that patches `stages_json` in place — out of scope for this design unless requested.

## Data integrity guards (Section 1.5)

Six fail-loud checks live across the orchestrator and `executeCreateStrategy`:

1. **Self-reference guard** — Variant cannot have its own pipelineId in priors.
2. **Favorite-completed guard** — DB confirmation (not just in-memory `brollPipelineProgress`) that prior pipeline has at least one `complete` row before firing the next variant.
3. **Per-chapter sub-run availability** — `loadPriorChapterStrategies` throws if a chapter-N sub-run is missing for any prior.
4. **Non-empty when expected** — when `priorStrategyPipelineIds.length > 0`, resolved text MUST be non-empty.
5. **Self-contained placeholder framing** — resolver returns either `""` (Favorite, no priors) or a complete block with the "do NOT produce a similar strategy" header WITH the data, so the prompt never says "do not be similar to: " with nothing after.
6. **Structured logging at every handoff** — one log line per state transition, paste-able for production debugging:
   ```
   [broll-chain] favorite=<pid> variants=[<pid>, <pid>]
   [broll-chain] favorite complete; firing variant <pid> with priors=[<pid>] (n=1)
   [broll-chain] variant <pid> chapter 3 injecting priors n=1 bytes=4823
   [broll-chain] variant <pid> complete; firing next variant <pid> with priors=[<pid>, <pid>] (n=2)
   ```

## Error handling

- Favorite's strategy fails → chain stops; uncomplete Variants in `brollPipelineProgress` flipped to `failed` by chain wrapper. Combined unaffected.
- Mid-chain Variant fails → remaining downstream Variants flipped to `failed`. Already-completed Variants stay completed.
- DB query failure (broken `broll_runs` lookup) → throws; chain wrapper catches, logs, marks remaining variants failed.
- All errors include the relevant pipeline ID + chapter index for debugging.

## Testing

### New unit tests (vitest)

**File:** `server/services/__tests__/prior-chapter-strategies.test.js`

- `loadPriorChapterStrategies` returns `""` when priors empty (no DB query, no throw)
- `loadPriorChapterStrategies` throws on missing chapter sub-run (asserts error message includes pid + chapter index)
- `loadPriorChapterStrategies` with one prior valid sub-run → text contains "do NOT produce a similar strategy" header + slim chapter-N beat_strategies
- `loadPriorChapterStrategies` with two priors → both blocks present in pipeline-id order, separated by `\n\n`
- `slimChapterStrategy` drops bookkeeping fields (`matched_reference_chapter`, `frequency_targets`) but keeps `strategy` + `beat_strategies`
- `slimChapterStrategy` falls back gracefully on unparseable JSON (returns first 2000 chars of raw)

These tests use mocked `db.prepare(...).get()` results — no real DB needed.

### Manual smoke (post-implementation)

Run pipeline with 2 references (Favorite + Variant B):
1. Confirm Favorite's strategy fires immediately
2. Confirm Combined fires immediately (parallel with Favorite)
3. Confirm Variant B does NOT fire until Favorite completes
4. Query `broll_runs.system_instruction_used` for Variant B's chapter 1 sub-run, verify it contains:
   - The "do NOT produce a similar strategy" directive
   - Favorite's chapter 1 `beat_strategies` JSON
5. Run with 3 references, confirm Variant C's chapter 1 sub-run contains BOTH Favorite + Variant B's slim outputs

## Rollback

The change is additive at the parameter level (`priorStrategyPipelineIds = []` defaults to empty). To rollback:
1. Revert `broll-runner.js` chain logic (firing all variants in parallel)
2. The new parameter on `executeCreateStrategy` can stay (callers that don't pass it get pre-change behavior)
3. Revert seed update if desired (or leave in place — `{{prior_chapter_strategies}}` resolving to `""` is harmless when no priors are passed)

No DB migrations. No data shape changes.

## Decision log

- **Sequential chain over parallel-with-priors-only-from-favorite** — chosen by user. Each Variant differentiates from ALL prior strategies, not just Favorite. Tradeoff: slower wall time (`O(N)` per-variant duration) for stronger variety.
- **`is_favorite` is a hard guarantee** — UI validation at [StepReferences.jsx:136-147](../../src/components/upload-config/steps/StepReferences.jsx) prevents progressing without a starred reference. Defensive `|| exampleVideos[0]` fallback retained for safety.
- **Slim format = `strategy` + `beat_strategies`** — matches user's "Chapter + Beats strategy" wording. Drops bookkeeping (matched references, frequency tables) to reduce token usage in the chain accumulation.
- **Directive text in the seed lives in the prompt, not system_instruction** — directive depends on per-chapter resolved data, and prompts are where chapter-scoped substitutions happen in this codebase. The substitution wiring resolves `{{prior_chapter_strategies}}` in BOTH `chPrompt` and `chSystem` as a capability, so future seed updates can move the directive to system_instruction without code changes if desired.
- **Spawn fire-and-forget chain instead of awaiting in `runStrategies`** — preserves the function's return-immediately semantics; auto-orchestrator's existing `waitForPipelinesComplete` naturally drains the chain.
