// Reusable b-roll pipeline runners. Bodies extracted from server/routes/broll.js.
// Used both by the original HTTP routes (which become thin wrappers) and by
// the slice-2 auto-orchestrator chain.

import db from '../db.js'

// Resolve the plan strategy id for a given subgroup. Returns the audio-only
// variant when any video in the group has media_type='audio', otherwise the
// default plan strategy (matched by strategy_kind='plan_prep' first row).
async function resolvePlanStrategyId(subGroupId) {
  const audio = await db.prepare(
    "SELECT 1 FROM videos WHERE group_id = ? AND media_type = 'audio' LIMIT 1"
  ).get(subGroupId)
  if (audio) {
    const audioStrategy = await db.prepare(
      "SELECT id FROM broll_strategies WHERE bundle_key = 'audio_only' AND strategy_kind = 'plan_prep' ORDER BY id LIMIT 1"
    ).get()
    if (audioStrategy?.id) return audioStrategy.id
    console.warn('[broll-runner] media_type=audio but no audio_only plan strategy seeded; falling back to default')
  }
  const def = await db.prepare(
    "SELECT id FROM broll_strategies WHERE strategy_kind = 'plan_prep' ORDER BY id LIMIT 1"
  ).get()
  return def?.id || 7
}

// runAllReferences — extracted from POST /broll/pipeline/run-all (broll.js:927)
//
// Fires plan-prep + per-reference analysis pipelines in parallel.
// Returns { prepPipelineId, analysisPipelineIds, videoCount, skippedAnalysis, skippedPrep }.
// Already-complete pipelines for the same (video, reference) pair are reused.
export async function runAllReferences({ subGroupId, mainVideoId }) {
  if (!mainVideoId || !subGroupId) {
    throw new Error('runAllReferences: subGroupId and mainVideoId required')
  }

  const { loadExampleVideos, executePlanPrep, executePipeline, brollPipelineProgress } =
    await import('./broll.js')

  let editorCuts = null
  const group = await db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(subGroupId)
  if (group?.editor_state_json) {
    try {
      const s = JSON.parse(group.editor_state_json)
      if (s.cuts?.length) editorCuts = { cuts: s.cuts, cutExclusions: s.cutExclusions || [] }
    } catch {}
  }

  const examples = await loadExampleVideos(subGroupId)
  const readyVideos = examples.filter(v => v.id)

  // Reuse a previously-completed plan_prep run if one exists for this
  // video. Match by broll_runs.strategy_id (the dedicated column),
  // NOT by JSON-pattern on metadata_json — executePipeline writes
  // `"phase":"plan"` for these rows (defaulted in broll.js), never
  // `"plan_prep"`, so the old LIKE check never matched and every
  // server boot's resumeStuckFullAutoChains kicked off a fresh
  // plan-prep pipeline.
  const planPrepStrategy = await db.prepare(
    "SELECT id FROM broll_strategies WHERE strategy_kind = 'plan_prep' ORDER BY id LIMIT 1"
  ).get()
  const planPrepStrategyId = planPrepStrategy?.id

  let existingPrepId = null
  if (planPrepStrategyId) {
    const existingPrep = await db.prepare(
      `SELECT metadata_json FROM broll_runs
       WHERE video_id = ? AND strategy_id = ? AND status = 'complete'
         AND metadata_json NOT LIKE '%"isSubRun":true%'
       ORDER BY id DESC LIMIT 1`
    ).get(mainVideoId, planPrepStrategyId)
    existingPrepId = existingPrep ? JSON.parse(existingPrep.metadata_json || '{}').pipelineId : null
  }

  let prepPipelineId = existingPrepId
  if (!existingPrepId) {
    const resolvedPlanStrategyId = await resolvePlanStrategyId(subGroupId)
    prepPipelineId = `${resolvedPlanStrategyId}-${mainVideoId}-${Date.now()}`
    brollPipelineProgress.set(prepPipelineId, {
      strategyId: resolvedPlanStrategyId, videoId: mainVideoId, groupId: subGroupId,
      status: 'running', stageName: 'Loading data...', stageIndex: 0, totalStages: 5,
      phase: 'plan_prep', strategyName: 'Plan Prep',
    })
    executePlanPrep(mainVideoId, subGroupId, editorCuts, prepPipelineId)
      .catch(err => console.error(`[broll-runner] Plan prep failed: ${err.message}`))
  }

  const analysisStrategy = await db.prepare(
    "SELECT * FROM broll_strategies WHERE strategy_kind = 'main_analysis' ORDER BY id LIMIT 1"
  ).get()
  const allAnalysisIds = []

  if (analysisStrategy) {
    const completedAnalysisRuns = await db.prepare(
      `SELECT metadata_json FROM broll_runs WHERE strategy_id = ? AND video_id = ? AND status = 'complete' AND metadata_json NOT LIKE '%"isSubRun":true%' ORDER BY id DESC`
    ).all(analysisStrategy.id, mainVideoId)

    const alreadyAnalyzedVideoIds = new Set()
    for (const r of completedAnalysisRuns) {
      try {
        const m = JSON.parse(r.metadata_json || '{}')
        const ex = m.pipelineId?.match(/-ex(\d+)/)
        if (ex) {
          alreadyAnalyzedVideoIds.add(Number(ex[1]))
          if (!allAnalysisIds.includes(m.pipelineId)) allAnalysisIds.push(m.pipelineId)
        }
      } catch {}
    }

    const analysisVersion = await db.prepare(
      'SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(analysisStrategy.id)

    if (analysisVersion) {
      const newVideos = readyVideos.filter(v => !alreadyAnalyzedVideoIds.has(v.id))
      // Stagger the parallel pipeline starts so CF Stream doesn't get hit with
      // 1 (main) + N (reference) MP4 fetches in the same tick. CF occasionally
      // 502s under bursty MP4 downloads, especially right after enableMp4Downloads.
      // 800ms is enough to spread the connect-time without meaningfully delaying
      // the chain (analysis itself is the dominant cost).
      for (let i = 0; i < newVideos.length; i++) {
        const vid = newVideos[i]
        if (i > 0) await new Promise(r => setTimeout(r, 800))
        const pid = `${analysisStrategy.id}-${mainVideoId}-${Date.now()}-ex${vid.id}`
        allAnalysisIds.push(pid)
        brollPipelineProgress.set(pid, {
          strategyId: analysisStrategy.id, videoId: mainVideoId, groupId: subGroupId,
          status: 'running', stageName: 'Loading data...', stageIndex: 0, totalStages: 1,
          exampleVideoId: vid.id, strategyName: 'Reference Analysis',
        })
        executePipeline(
          analysisStrategy.id, analysisVersion.id, mainVideoId, subGroupId,
          'raw', null, null, null,
          { exampleVideoId: vid.id, pipelineIdOverride: pid },
        ).catch(err => console.error(`[broll-runner] Analysis for video ${vid.id} failed: ${err.message}`))
      }
    }
  }

  return {
    prepPipelineId,
    analysisPipelineIds: allAnalysisIds,
    videoCount: readyVideos.length,
    skippedAnalysis: readyVideos.length - allAnalysisIds.filter(id => brollPipelineProgress.get(id)?.status === 'running').length,
    skippedPrep: !!existingPrepId,
  }
}

// runStrategies — extracted from POST /broll/pipeline/run-strategies (broll.js:940)
//
// For each analysis pipeline that doesn't already have a completed strategy,
// fires executeCreateStrategy. If there are 2+ analyses (and no existing
// combined strategy, or new analyses to incorporate), also fires
// executeCreateCombinedStrategy. Returns { strategyPipelineIds, combinedPipelineId }.
export async function runStrategies({ subGroupId, mainVideoId, prepPipelineId, analysisPipelineIds }) {
  if (!prepPipelineId || !analysisPipelineIds?.length || !mainVideoId) {
    throw new Error('runStrategies: prepPipelineId, analysisPipelineIds, and mainVideoId required')
  }
  const { executeCreateStrategy, executeCreateCombinedStrategy, brollPipelineProgress, loadExampleVideos } =
    await import('./broll.js')

  // Skip analyses that already have a completed strategy (column-based dedup).
  const createStrategy = await db.prepare(
    "SELECT id FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1"
  ).get()
  const existingStratRuns = createStrategy
    ? await db.prepare(
        `SELECT metadata_json FROM broll_runs
         WHERE video_id = ? AND strategy_id = ? AND status = 'complete'
           AND metadata_json NOT LIKE '%"isSubRun":true%'`
      ).all(mainVideoId, createStrategy.id)
    : []
  const alreadyDoneAnalysisIds = new Set()
  for (const r of existingStratRuns) {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      if (m.analysisPipelineId) alreadyDoneAnalysisIds.add(m.analysisPipelineId)
    } catch {}
  }

  const newAnalysisIds = analysisPipelineIds.filter(id => !alreadyDoneAnalysisIds.has(id))
  const skippedCount = analysisPipelineIds.length - newAnalysisIds.length
  if (skippedCount) console.log(`[broll-runner] Skipping ${skippedCount} strategies (already exist)`)

  // ── Order analysis IDs: favorite first, then variants in example order ──
  // Map each analysis pipeline ID to its reference video via the -ex<videoId>
  // suffix already encoded in the ID (see runAllReferences pid construction).
  const exampleVideos = subGroupId ? await loadExampleVideos(subGroupId) : []
  const favoriteVideoId = (exampleVideos.find(v => v.isFavorite) || exampleVideos[0])?.id ?? null

  function videoIdFromAnalysisId(analysisId) {
    const m = String(analysisId).match(/-ex(\d+)$/)
    if (!m) throw new Error(`[broll-chain] cannot extract videoId from analysisPipelineId: ${analysisId}`)
    return Number(m[1])
  }

  const orderedAnalysisIds = [...newAnalysisIds].sort((a, b) => {
    const va = videoIdFromAnalysisId(a)
    const vb = videoIdFromAnalysisId(b)
    if (va === favoriteVideoId && vb !== favoriteVideoId) return -1
    if (vb === favoriteVideoId && va !== favoriteVideoId) return 1
    // Preserve example-order for non-favorites (loadExampleVideos returns insertion order)
    const ia = exampleVideos.findIndex(v => v.id === va)
    const ib = exampleVideos.findIndex(v => v.id === vb)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })

  // ── Reserve all strategy pipeline IDs upfront ──
  const allPipelineIds = []
  const variantPlan = []  // [{ analysisPipelineId, pid }] in execution order, excluding favorite
  let favoritePid = null
  const baseTs = Date.now()
  for (let idx = 0; idx < orderedAnalysisIds.length; idx++) {
    const analysisPipelineId = orderedAnalysisIds[idx]
    const pid = `strat-${mainVideoId}-${baseTs + idx}-${analysisPipelineId.slice(-6)}`
    allPipelineIds.push(pid)
    brollPipelineProgress.set(pid, {
      videoId: mainVideoId, groupId: subGroupId, status: 'running',
      stageName: idx === 0 ? 'Loading data...' : 'Waiting for favorite...',
      stageIndex: 0, totalStages: 1, phase: 'create_strategy',
    })
    if (idx === 0) {
      favoritePid = pid
    } else {
      variantPlan.push({ analysisPipelineId, pid })
    }
  }

  // ── Combined strategy (independent, parallel, unchanged from before) ──
  let combinedPipelineId = null
  const combinedStrategy = await db.prepare(
    "SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1"
  ).get()
  const existingCombined = combinedStrategy
    ? !!(await db.prepare(
        `SELECT 1 FROM broll_runs
         WHERE video_id = ? AND strategy_id = ? AND status = 'complete'
           AND metadata_json NOT LIKE '%"isSubRun":true%'
         LIMIT 1`
      ).get(mainVideoId, combinedStrategy.id))
    : false
  const shouldFireCombined = analysisPipelineIds.length >= 2 && (!existingCombined || newAnalysisIds.length > 0)
  if (shouldFireCombined) {
    combinedPipelineId = `cstrat-${mainVideoId}-${baseTs}`
    allPipelineIds.push(combinedPipelineId)
    brollPipelineProgress.set(combinedPipelineId, {
      videoId: mainVideoId, groupId: subGroupId, status: 'running',
      stageName: 'Loading data...', stageIndex: 0, totalStages: 1, phase: 'create_combined_strategy',
    })
  }

  console.log(`[broll-chain] favorite=${favoritePid} variants=[${variantPlan.map(v => v.pid).join(', ')}] combined=${combinedPipelineId || 'none'}`)

  // ── Fire favorite + combined immediately, parallel ──
  if (favoritePid) {
    executeCreateStrategy(prepPipelineId, orderedAnalysisIds[0], mainVideoId, subGroupId || null, favoritePid, [])
      .catch(err => {
        console.error(`[broll-runner] Favorite strategy failed: ${err.message}`)
        const p = brollPipelineProgress.get(favoritePid)
        if (p) brollPipelineProgress.set(favoritePid, { ...p, status: 'failed', error: err.message })
      })
  }
  if (shouldFireCombined) {
    executeCreateCombinedStrategy(prepPipelineId, analysisPipelineIds, mainVideoId, subGroupId || null, combinedPipelineId)
      .catch(err => console.error(`[broll-runner] Combined strategy failed: ${err.message}`))
  }

  // ── Spawn fire-and-forget chain for variants ──
  if (variantPlan.length > 0 && favoritePid) {
    ;(async () => {
      await waitForPipelinesComplete([favoritePid])
      console.log(`[broll-chain] favorite ${favoritePid} complete; starting variant chain`)
      const completed = [favoritePid]
      for (const v of variantPlan) {
        const priors = completed.slice()
        console.log(`[broll-chain] firing variant ${v.pid} priors=[${priors.join(',')}] (n=${priors.length})`)
        const p = brollPipelineProgress.get(v.pid)
        if (p) brollPipelineProgress.set(v.pid, { ...p, stageName: 'Loading data...' })
        await executeCreateStrategy(
          prepPipelineId, v.analysisPipelineId,
          mainVideoId, subGroupId || null,
          v.pid, priors,
        )
        completed.push(v.pid)
        console.log(`[broll-chain] variant ${v.pid} complete`)
      }
    })().catch(err => {
      console.error(`[broll-chain] chain failed: ${err.message}`)
      for (const v of variantPlan) {
        const p = brollPipelineProgress.get(v.pid)
        if (p && p.status === 'running') {
          brollPipelineProgress.set(v.pid, { ...p, status: 'failed', error: `chain aborted: ${err.message}` })
        }
      }
    })
  }

  console.log(`[broll-runner] runStrategies: reserved ${allPipelineIds.length} pipelines (1 favorite + ${variantPlan.length} variants + ${shouldFireCombined ? 1 : 0} combined)`)

  return { strategyPipelineIds: allPipelineIds, combinedPipelineId }
}

// runPlanForEachVariant — fires executeCreatePlan once per strategy variant.
//
// Plans run in parallel (Promise.all) and we read each one's pipelineId
// from the resolved value of executeCreatePlan, which returns
// `{ planPipelineId, ... }`. This is deterministic — every plan that
// completes successfully ends up in planPipelineIds.
//
// Earlier versions polled brollPipelineProgress 500 ms after dispatch
// to scrape the new plan-* entry. That race silently dropped plans
// whose internal prep work took longer than 500 ms (saw 65s in
// production for plan #3 on group 267 — only the favorite plan was
// captured, so search ran on it alone and Variants B/C got zero
// broll_searches rows). See docs/superpowers/plans/2026-05-02-broll-
// followup-fixes.md Task 4.
//
// Failed plans are logged and skipped — their slot is omitted from the
// returned planPipelineIds. Order matches strategyPipelineIds for
// successful plans (Promise.all preserves array order in resolved
// values, so we filter without re-ordering).
//
// Returns { planPipelineIds }.
export async function runPlanForEachVariant({
  subGroupId, mainVideoId, prepPipelineId, strategyPipelineIds,
}) {
  if (!prepPipelineId || !strategyPipelineIds?.length || !mainVideoId) {
    throw new Error('runPlanForEachVariant: prepPipelineId, strategyPipelineIds, and mainVideoId required')
  }
  const { executeCreatePlan } = await import('./broll.js')

  const promises = strategyPipelineIds.map(stratId =>
    executeCreatePlan(prepPipelineId, stratId, mainVideoId, subGroupId || null)
      .then(result => ({ ok: true, planPipelineId: result.planPipelineId, stratId }))
      .catch(err => {
        console.error(`[broll-runner] Create plan failed for strategy ${stratId}: ${err.message}`)
        return { ok: false, stratId, error: err.message }
      })
  )

  const results = await Promise.all(promises)
  const planPipelineIds = results.filter(r => r.ok).map(r => r.planPipelineId)

  if (planPipelineIds.length < strategyPipelineIds.length) {
    console.warn(`[broll-runner] runPlanForEachVariant: ${planPipelineIds.length}/${strategyPipelineIds.length} plans succeeded`)
  }

  return { planPipelineIds }
}

// waitForPipelinesComplete — waits for every pipelineId to reach a terminal
// state. Source of truth is the DB (broll_runs), with the in-memory progress
// map as a fast path for liveness and 'failed' detection.
//
// History: earlier this polled brollPipelineProgress only. That race-d twice:
//   1. The map evicted 'complete' entries 5 min after success. A fast pid's
//      entry would disappear before a slow sibling finished, leaving the
//      poll seeing `undefined` forever (chain stuck mid-refs).
//   2. After a process restart, in-memory state was empty even when the DB
//      already had every stage complete — the chain would never advance.
//
// Now: a local Set caches pids we've already observed complete (in-memory or
// DB), so re-polling can't unsee them. For pids whose in-memory entry is
// absent or non-terminal, we fall back to the DB: a pipeline is complete
// when the count of distinct main-stage broll_runs rows >= totalStages from
// metadata. The fallback survives map eviction and process restarts.
export async function waitForPipelinesComplete(
  pipelineIds,
  { pollIntervalMs = 2000, maxWaitMs = 60 * 60 * 1000 } = {},
) {
  if (!pipelineIds?.length) return
  const { brollPipelineProgress } = await import('./broll.js')
  const start = Date.now()
  const completed = new Set()

  while (Date.now() - start < maxWaitMs) {
    let allComplete = true
    for (const id of pipelineIds) {
      if (completed.has(id)) continue

      const p = brollPipelineProgress.get(id)
      if (p?.status === 'failed') {
        throw new Error(`pipeline ${id} failed: ${p.error || 'unknown'}`)
      }
      if (p?.status === 'complete') { completed.add(id); continue }

      // DB fallback. Count distinct main-stage rows for this pipelineId; if
      // it matches the totalStages metadata recorded on those rows, the
      // pipeline finished even though the in-memory marker is gone.
      const row = await db.prepare(
        `SELECT
           COUNT(DISTINCT (((metadata_json::jsonb)->>'stageIndex')::int)) FILTER (
             WHERE COALESCE((metadata_json::jsonb)->>'isSubRun', 'false') != 'true'
           ) AS main_stages,
           MAX(((metadata_json::jsonb)->>'totalStages')::int) AS total_stages
         FROM broll_runs
         WHERE (metadata_json::jsonb)->>'pipelineId' = ?
           AND status = 'complete'`
      ).get(id)
      if (row && row.total_stages != null && Number(row.main_stages) >= Number(row.total_stages)) {
        completed.add(id)
        continue
      }

      allComplete = false
      break
    }
    if (allComplete && completed.size === pipelineIds.length) return
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  throw new Error(`waitForPipelinesComplete: timed out after ${maxWaitMs}ms`)
}

// Polls until every broll_searches row in this batch has left the
// waiting/running states, or until maxWaitMs elapses.
//
// On timeout we log a warning and return (NOT throw). The reasoning:
// the GPU worker processes placements serially in a separate process,
// and a single slow placement (saw 11 min in production for one row)
// can blow the per-batch budget. Hard-failing the chain in that case
// aborts subsequent batches and the user gets nothing. By returning
// soft we let the orchestrator continue; remaining placements keep
// processing in the worker and the editor surfaces partial results
// immediately. The 30-min default is enough for the typical 10-row
// batch even with one slow outlier.
export async function waitForSearchBatchComplete(searchPipelineId, {
  pollIntervalMs = 3000,
  maxWaitMs = 30 * 60_000,
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
  console.warn(`[broll-runner] waitForSearchBatchComplete: timed out after ${maxWaitMs}ms (batch ${searchPipelineId}) — proceeding with partial results; remaining placements will complete asynchronously`)
}

// runBrollSearchFirst10 — runs the unified keywords + GPU search batch
// (executeSearchBatch from broll.js, also exposed via /pipeline/search-next-batch
// at broll.js:628). Awaits the keyword + INSERT phase, then returns
// { searchPipelineId }. The GPU worker drains the inserted rows asynchronously.
//
// Awaiting matters: callers that immediately poll waitForSearchBatchComplete
// would otherwise see count=0 (rows not yet inserted) and return prematurely,
// causing the next loop iteration to enqueue duplicates of the same placements.
export async function runBrollSearchFirst10({
  subGroupId, planPipelineIds, batchSize = 10,
}) {
  if (!planPipelineIds?.length) {
    throw new Error('runBrollSearchFirst10: planPipelineIds required')
  }
  const { executeSearchBatch } = await import('./broll.js')

  const searchPipelineId = `search-batch-${Date.now()}`
  await executeSearchBatch(planPipelineIds, batchSize, searchPipelineId)
  return { searchPipelineId }
}

// Test-only export: lets server/services/__tests__/broll-runner-audio-resolver.test.js
// exercise the resolver in isolation without driving runAllReferences end-to-end.
export { resolvePlanStrategyId as __test__resolvePlanStrategyId }
