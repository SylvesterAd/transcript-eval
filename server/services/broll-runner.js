// Reusable b-roll pipeline runners. Bodies extracted from server/routes/broll.js.
// Used both by the original HTTP routes (which become thin wrappers) and by
// the slice-2 auto-orchestrator chain.

import db from '../db.js'

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
    prepPipelineId = `${planPrepStrategyId || 7}-${mainVideoId}-${Date.now()}`
    brollPipelineProgress.set(prepPipelineId, {
      strategyId: planPrepStrategyId || 7, videoId: mainVideoId, groupId: subGroupId,
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
  const { executeCreateStrategy, executeCreateCombinedStrategy, brollPipelineProgress } =
    await import('./broll.js')

  // Skip analysis pipelines that already have a completed strategy.
  // Match by strategy_id (column) — old LIKE on metadata_json's "phase"
  // never matched, see plan-prep dedup above for the same fix pattern.
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

  const allPipelineIds = []
  for (const analysisPipelineId of newAnalysisIds) {
    const pid = `strat-${mainVideoId}-${Date.now()}-${analysisPipelineId.slice(-6)}`
    allPipelineIds.push(pid)
    brollPipelineProgress.set(pid, {
      videoId: mainVideoId, groupId: subGroupId, status: 'running',
      stageName: 'Loading data...', stageIndex: 0, totalStages: 1, phase: 'create_strategy',
    })
    executeCreateStrategy(prepPipelineId, analysisPipelineId, mainVideoId, subGroupId || null, pid)
      .catch(err => console.error(`[broll-runner] Create strategy failed for analysis ${analysisPipelineId}: ${err.message}`))
  }

  // Combined "best of all" strategy if 2+ refs AND (no existing combined OR new analyses).
  // Detect via strategy_id (column) — phase JSON-match never worked,
  // and existingStratRuns above only contains create_strategy rows now,
  // not create_combined_strategy ones, so we need a separate query.
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
    combinedPipelineId = `cstrat-${mainVideoId}-${Date.now()}`
    allPipelineIds.push(combinedPipelineId)
    brollPipelineProgress.set(combinedPipelineId, {
      videoId: mainVideoId, groupId: subGroupId, status: 'running',
      stageName: 'Loading data...', stageIndex: 0, totalStages: 1, phase: 'create_combined_strategy',
    })
    executeCreateCombinedStrategy(prepPipelineId, analysisPipelineIds, mainVideoId, subGroupId || null, combinedPipelineId)
      .catch(err => console.error(`[broll-runner] Combined strategy failed: ${err.message}`))
  }

  console.log(`[broll-runner] runStrategies: firing ${allPipelineIds.length} pipelines (${newAnalysisIds.length} individual + ${shouldFireCombined ? 1 : 0} combined)`)

  return { strategyPipelineIds: allPipelineIds, combinedPipelineId }
}

// runPlanForEachVariant — extracted from POST /broll/pipeline/run-plan (broll.js:1063)
//
// Fires executeCreatePlan once per strategy variant. executeCreatePlan
// generates its own pipelineId (plan-{videoId}-{Date.now()}); we snapshot the
// progress map before/after each call to capture the new plan ID.
// Returns { planPipelineIds }.
export async function runPlanForEachVariant({
  subGroupId, mainVideoId, prepPipelineId, strategyPipelineIds,
}) {
  if (!prepPipelineId || !strategyPipelineIds?.length || !mainVideoId) {
    throw new Error('runPlanForEachVariant: prepPipelineId, strategyPipelineIds, and mainVideoId required')
  }
  const { executeCreatePlan, brollPipelineProgress } = await import('./broll.js')

  const planPipelineIds = []
  for (const stratId of strategyPipelineIds) {
    const beforeIds = new Set(brollPipelineProgress.keys())

    const result = executeCreatePlan(prepPipelineId, stratId, mainVideoId, subGroupId || null)
    result.catch(err => console.error(`[broll-runner] Create plan failed for strategy ${stratId}: ${err.message}`))

    // Wait briefly for executeCreatePlan to register its progress entry
    await new Promise(r => setTimeout(r, 500))

    let newPlanId = null
    for (const [pid, prog] of brollPipelineProgress.entries()) {
      if (beforeIds.has(pid)) continue
      if (pid.startsWith('plan-') && prog.phase === 'create_plan') {
        newPlanId = pid
        break
      }
    }
    if (newPlanId) planPipelineIds.push(newPlanId)
    else console.warn(`[broll-runner] runPlanForEachVariant: no new plan-* pipeline registered for strategy ${stratId}`)
  }

  return { planPipelineIds }
}

// waitForPipelinesComplete — polls brollPipelineProgress until all IDs reach
// 'complete', or rejects on the first 'failed', or after maxWaitMs.
export async function waitForPipelinesComplete(
  pipelineIds,
  { pollIntervalMs = 2000, maxWaitMs = 60 * 60 * 1000 } = {},
) {
  if (!pipelineIds?.length) return
  const { brollPipelineProgress } = await import('./broll.js')
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    let allComplete = true
    for (const id of pipelineIds) {
      const p = brollPipelineProgress.get(id) || {}
      if (p.status === 'failed') {
        throw new Error(`pipeline ${id} failed: ${p.error || 'unknown'}`)
      }
      if (p.status !== 'complete') { allComplete = false; break }
    }
    if (allComplete) return
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  throw new Error(`waitForPipelinesComplete: timed out after ${maxWaitMs}ms`)
}

// runBrollSearchFirst10 — kicks off the unified keywords + GPU search batch
// (executeSearchBatch from broll.js, also exposed via /pipeline/search-next-batch
// at broll.js:628). Returns { searchPipelineId } so callers can poll progress.
export async function runBrollSearchFirst10({
  subGroupId, planPipelineIds, batchSize = 10,
}) {
  if (!planPipelineIds?.length) {
    throw new Error('runBrollSearchFirst10: planPipelineIds required')
  }
  const { executeSearchBatch } = await import('./broll.js')

  const searchPipelineId = `search-batch-${Date.now()}`
  executeSearchBatch(planPipelineIds, batchSize, searchPipelineId)
    .catch(err => console.error(`[broll-runner] Search batch failed: ${err.message}`))
  return { searchPipelineId }
}
