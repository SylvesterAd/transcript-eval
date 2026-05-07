// Tests for runAllReferences.
//
// Mirrors the rough-cut-runner.test pattern: mock db.js + the broll service
// helpers, exercise both fresh-project and skip-existing-analysis branches.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  videos: [{ id: 387, group_id: 1 }, { id: 388, group_id: 1 }],
  examples: [{ id: 901 }, { id: 902 }],
  planPrepStrategy: { id: 7 },
  createStrategy: { id: 8 },
  combinedStrategy: { id: 9 },
  analysisStrategy: { id: 5 },
  // Active strategy version: created_at gates cross-main reuse so a
  // version bump invalidates older cached runs, and stages_json drives
  // the lastStageIdx lookup (7 stages → final index 6).
  analysisVersion: {
    id: 50,
    created_at: '2026-04-01T00:00:00.000Z',
    stages_json: JSON.stringify([
      { name: 'Analyze A-Roll + Chapters & Beats' },
      { name: 'Build analysis time windows' },
      { name: 'Analyze B-Roll per minute' },
      { name: 'Split analysis by chapter' },
      { name: 'Compute chapter stats' },
      { name: 'Pattern analysis' },
      { name: 'Assemble full analysis' },
    ]),
  },
  existingPrepRun: null,
  existingCombinedRun: null,
  completedAnalysis: [],
  group: { id: 1, editor_state_json: null },
  existingStratRuns: [],
  // Cross-main reuse fixtures: candidate is the assemble-stage row of a
  // prior project's analysis for the same reference video. When set,
  // sourcePipelineRowsByPid maps the source pipelineId to all of its
  // broll_runs rows (main stages + sub-runs) that the copy step pulls.
  crossMainCandidateByRef: {},
  sourcePipelineRowsByPid: {},
  insertedBrollRuns: [],
  // Per-pipelineId completion check used by waitForPipelinesComplete's DB
  // fallback. Default null means "no rows yet" — tests can set per-pid
  // shape to simulate "all main stages written" (main_stages >= total_stages).
  completionRowsByPid: {},
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT editor_state_json FROM video_groups WHERE id = \?/.test(sql)) return state.group
          // resolvePlanStrategyId audio-detection probe (Task 6). Default state has
          // no audio videos in the group, so the resolver falls through to the
          // default plan_prep lookup (next clause).
          if (/SELECT 1 FROM videos WHERE group_id = \? AND media_type = 'audio'/.test(sql)) return null
          // resolvePlanStrategyId audio-only strategy lookup. Only reached when the
          // audio-detection probe returns a row, which doesn't happen in the existing
          // tests — kept here for completeness so future audio-aware tests don't
          // explode on an unhandled SQL.
          if (/bundle_key = 'audio_only'/.test(sql)) return null
          // Per-video media_type probe added by the audio-aware analysisStrategy
          // resolver (replaces the original `SELECT * FROM broll_strategies WHERE
          // strategy_kind = 'main_analysis'` direct lookup). Returns a video row so
          // the resolver treats this group as video-only and falls through.
          if (/SELECT media_type FROM videos WHERE id = \?/.test(sql)) return { media_type: 'video' }
          if (/SELECT id FROM broll_strategies WHERE strategy_kind = 'plan_prep'/.test(sql)) return state.planPrepStrategy
          if (/SELECT id FROM broll_strategies WHERE strategy_kind = 'create_strategy'/.test(sql)) return state.createStrategy
          if (/SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy'/.test(sql)) return state.combinedStrategy
          if (/SELECT \* FROM broll_strategies WHERE strategy_kind = 'main_analysis'/.test(sql)) return state.analysisStrategy
          if (/SELECT \* FROM broll_strategy_versions/.test(sql)) return state.analysisVersion
          // existingPrep lookup (post-e229184): finds latest non-subRun complete plan_prep run
          if (/SELECT metadata_json FROM broll_runs[\s\S]*WHERE video_id = \? AND strategy_id = \?[\s\S]*ORDER BY id DESC LIMIT 1/.test(sql)) return state.existingPrepRun
          // waitForPipelinesComplete DB-fallback: reads main_stages + total_stages per pipelineId.
          if (/COUNT\(DISTINCT[\s\S]+stageIndex[\s\S]+FROM broll_runs/.test(sql)) {
            return state.completionRowsByPid[args[0]] || null
          }
          // waitForSearchBatchComplete: counts broll_searches rows still waiting/running for a batch.
          if (/SELECT count\(\*\)[\s\S]*FROM broll_searches[\s\S]*WHERE batch_id = \?/i.test(sql)) {
            if (state.batchCountAlways !== undefined) return { n: state.batchCountAlways }
            return { n: state.batchCountSeq.shift() ?? 0 }
          }
          // existingCombined lookup (post-e229184): SELECT 1 ... LIMIT 1
          if (/SELECT 1 FROM broll_runs[\s\S]*LIMIT 1/.test(sql)) return state.existingCombinedRun
          // Cross-main reuse candidate lookup: matches by strategy + ref-suffix
          // in pipelineId + last-stage stageIndex. Args are
          // [strategyId, '%-ex<refId>"%', '%"stageIndex":<N>%'].
          // No created_at gate — matches the existing same-project dedup's
          // version-agnostic policy (post-2026-05-06 hotfix; pre-hotfix this
          // gated by analysisVersion.created_at and missed pre-bump runs).
          if (/SELECT metadata_json FROM broll_runs[\s\S]*WHERE strategy_id = \?[\s\S]*AND metadata_json LIKE \?[\s\S]*AND metadata_json LIKE \?[\s\S]*ORDER BY id DESC LIMIT 1/.test(sql)) {
            const refLike = args[1] || ''
            const m = String(refLike).match(/-ex(\d+)"/)
            const refId = m ? Number(m[1]) : null
            return refId != null ? state.crossMainCandidateByRef[refId] || null : null
          }
          throw new Error(`unexpected get: ${sql}`)
        },
        async all(...args) {
          if (/FROM broll_runs WHERE strategy_id = \? AND video_id = \?/.test(sql)) return state.completedAnalysis
          // existingStratRuns (post-e229184): WHERE video_id = ? AND strategy_id = ?
          if (/FROM broll_runs[\s\S]*WHERE video_id = \? AND strategy_id = \?/.test(sql)) return state.existingStratRuns
          // Cross-main reuse: fetch every row for a source pipelineId so the copy
          // step can re-INSERT them under the new pipelineId.
          if (/SELECT \* FROM broll_runs WHERE metadata_json LIKE \?/.test(sql)) {
            const like = args[0] || ''
            const m = String(like).match(/"pipelineId":"([^"]+)"/)
            const pid = m ? m[1] : null
            return pid ? state.sourcePipelineRowsByPid[pid] || [] : []
          }
          throw new Error(`unexpected all: ${sql}`)
        },
        async run(...args) {
          if (/INSERT INTO broll_runs/i.test(sql)) {
            state.insertedBrollRuns.push({ sql, args })
            return { lastInsertRowid: state.insertedBrollRuns.length }
          }
          throw new Error(`unexpected run: ${sql}`)
        },
      }
    },
  },
}))

vi.mock('../broll.js', () => ({
  loadExampleVideos: vi.fn().mockResolvedValue([{ id: 901 }, { id: 902 }]),
  executePlanPrep: vi.fn().mockResolvedValue(),
  executePipeline: vi.fn().mockResolvedValue(),
  executeCreateStrategy: vi.fn().mockResolvedValue(),
  executeCreateCombinedStrategy: vi.fn().mockResolvedValue(),
  executeCreatePlan: vi.fn().mockResolvedValue(),
  executeSearchBatch: vi.fn().mockResolvedValue(),
  brollPipelineProgress: new Map(),
}))

import { runAllReferences } from '../broll-runner.js'

beforeEach(() => {
  state.completedAnalysis = []
  state.existingStratRuns = []
  state.existingPrepRun = null
  state.existingCombinedRun = null
  state.completionRowsByPid = {}
  state.crossMainCandidateByRef = {}
  state.sourcePipelineRowsByPid = {}
  state.insertedBrollRuns = []
})

describe('runAllReferences', () => {
  it('returns prep + analysis pipeline IDs for new project', async () => {
    const r = await runAllReferences({ subGroupId: 1, mainVideoId: 387 })
    expect(r.prepPipelineId).toMatch(/^7-387-\d+$/)
    expect(r.analysisPipelineIds).toHaveLength(2)
    expect(r.analysisPipelineIds[0]).toMatch(/^5-387-\d+-ex901$/)
  })

  it('reuses existing analysis when reference already analyzed', async () => {
    state.completedAnalysis = [
      { metadata_json: JSON.stringify({ pipelineId: '5-387-1234-ex901' }) },
    ]
    const r = await runAllReferences({ subGroupId: 1, mainVideoId: 387 })
    expect(r.analysisPipelineIds).toContain('5-387-1234-ex901')
    expect(r.analysisPipelineIds).toHaveLength(2)
  })

  it('duplicates a prior project\'s analysis when the same reference reappears under a new main video', async () => {
    // Reference 901 was already analyzed for a different main video (999).
    // Reference 902 has no prior analysis anywhere.
    // Expectation:
    //   - 901: rows are copied across, no new executePipeline call
    //   - 902: fresh executePipeline fired
    const sourcePid = '5-999-1700000000000-ex901'
    state.crossMainCandidateByRef[901] = {
      metadata_json: JSON.stringify({ pipelineId: sourcePid, stageIndex: 6, stageName: 'Assemble full analysis' }),
    }
    state.sourcePipelineRowsByPid[sourcePid] = [
      { strategy_id: 5, video_id: 999, step_name: 'analysis', status: 'complete', transcript_source: 'raw', resolved_transcript_source: 'raw',
        analysis_run_id: null, input_text: '', output_text: '{"chapters":[]}', prompt_used: '', system_instruction_used: '', model: 'gemini',
        params_json: '{}', tokens_in: 100, tokens_out: 200, cost: 0.5, runtime_ms: 1000, error_message: null,
        metadata_json: JSON.stringify({ pipelineId: sourcePid, stageIndex: 0, stageName: 'Analyze A-Roll + Chapters & Beats' }) },
      { strategy_id: 5, video_id: 999, step_name: 'analysis', status: 'complete', transcript_source: 'raw', resolved_transcript_source: 'raw',
        analysis_run_id: null, input_text: '', output_text: '{"assembled":true}', prompt_used: '', system_instruction_used: '', model: 'gemini',
        params_json: '{}', tokens_in: 50, tokens_out: 75, cost: 0.2, runtime_ms: 500, error_message: null,
        metadata_json: JSON.stringify({ pipelineId: sourcePid, stageIndex: 6, stageName: 'Assemble full analysis' }) },
    ]

    const broll = await import('../broll.js')
    broll.executePipeline.mockClear()

    const r = await runAllReferences({ subGroupId: 1, mainVideoId: 387 })

    // 901 was reused (new pipelineId keyed on mainVideoId=387, suffixed -ex901)
    // 902 was scheduled fresh
    expect(r.analysisPipelineIds).toHaveLength(2)
    const reusedPid = r.analysisPipelineIds.find(p => p.endsWith('-ex901'))
    const freshPid = r.analysisPipelineIds.find(p => p.endsWith('-ex902'))
    expect(reusedPid).toMatch(/^5-387-\d+-ex901$/)
    expect(reusedPid).not.toBe(sourcePid)             // freshly minted, not the original
    expect(freshPid).toMatch(/^5-387-\d+-ex902$/)

    // executePipeline fired ONLY for 902, not for 901.
    expect(broll.executePipeline).toHaveBeenCalledTimes(1)
    const callArgs = broll.executePipeline.mock.calls[0]
    expect(callArgs[8]).toMatchObject({ exampleVideoId: 902 })

    // Both source rows were duplicated under the new (mainVideoId=387, pipelineId=reusedPid).
    expect(state.insertedBrollRuns).toHaveLength(2)
    for (const ins of state.insertedBrollRuns) {
      const [strategyId, videoId] = ins.args
      expect(strategyId).toBe(5)
      expect(videoId).toBe(387)
      // tokens / cost zeroed — the original run paid for them
      const [, , , , , , , , , , , , , tokensIn, tokensOut, cost] = ins.args
      expect(tokensIn).toBe(0)
      expect(tokensOut).toBe(0)
      expect(cost).toBe(0)
      // Rewrites pipelineId + tags copiedFromPipelineId for audit
      const meta = JSON.parse(ins.args[ins.args.length - 1])
      expect(meta.pipelineId).toBe(reusedPid)
      expect(meta.copiedFromPipelineId).toBe(sourcePid)
    }
  })

  it('reuses analysis even when source rows predate the active strategy version (post-hotfix)', async () => {
    // Regression for the 2026-05-06 ship: the version "Version 2 +audio_note"
    // was published 07:10 UTC. Prior project runs from 2026-05-04 12:57
    // were the obvious reuse candidates for the next day's projects, but
    // the original cross-main code gated on `created_at >= version.created_at`
    // and silently re-ran every analysis. Hotfix removed the gate — this
    // test pins that behavior so a future "stricter" rewrite can't sneak
    // it back without a deliberate decision.
    const sourcePid = '5-413-1777888547460-ex901'  // arbitrary pre-version-bump pipeline
    state.crossMainCandidateByRef[901] = {
      metadata_json: JSON.stringify({ pipelineId: sourcePid, stageIndex: 6 }),
    }
    state.sourcePipelineRowsByPid[sourcePid] = [
      { strategy_id: 5, video_id: 413, step_name: 'analysis', status: 'complete',
        transcript_source: 'raw', resolved_transcript_source: 'raw',
        analysis_run_id: null, input_text: '', output_text: '{"assembled":true}',
        prompt_used: 'old-prompt', system_instruction_used: '', model: 'gemini',
        params_json: '{}', tokens_in: 50, tokens_out: 75, cost: 0.2, runtime_ms: 500, error_message: null,
        metadata_json: JSON.stringify({ pipelineId: sourcePid, stageIndex: 6, stageName: 'Assemble full analysis' }) },
    ]

    const broll = await import('../broll.js')
    broll.executePipeline.mockClear()

    const r = await runAllReferences({ subGroupId: 1, mainVideoId: 387 })

    const reusedPid = r.analysisPipelineIds.find(p => p.endsWith('-ex901'))
    expect(reusedPid).toMatch(/^5-387-\d+-ex901$/)
    // executePipeline should fire ONCE (for ref 902 which has no candidate),
    // not twice — proving 901 hit the reuse path despite the timestamp.
    expect(broll.executePipeline).toHaveBeenCalledTimes(1)
    expect(broll.executePipeline.mock.calls[0][8]).toMatchObject({ exampleVideoId: 902 })
    expect(state.insertedBrollRuns).toHaveLength(1)
  })

  it('falls back to fresh analysis when cross-main reuse fails (chain unaffected)', async () => {
    // Candidate exists, but the source-rows fetch returns nothing (e.g. the
    // pipelineId has been purged). Reuse must abort cleanly and let the
    // fresh pipeline fire so the chain still completes.
    const sourcePid = '5-999-1700000000000-ex901'
    state.crossMainCandidateByRef[901] = {
      metadata_json: JSON.stringify({ pipelineId: sourcePid, stageIndex: 6 }),
    }
    state.sourcePipelineRowsByPid[sourcePid] = []  // empty → reuse aborts

    const broll = await import('../broll.js')
    broll.executePipeline.mockClear()

    const r = await runAllReferences({ subGroupId: 1, mainVideoId: 387 })

    // Both 901 and 902 fall through to fresh analysis.
    expect(r.analysisPipelineIds).toHaveLength(2)
    expect(r.analysisPipelineIds[0]).toMatch(/^5-387-\d+-ex901$/)
    expect(r.analysisPipelineIds[1]).toMatch(/^5-387-\d+-ex902$/)
    expect(broll.executePipeline).toHaveBeenCalledTimes(2)
    expect(state.insertedBrollRuns).toHaveLength(0)
  })
})

describe('runStrategies', () => {
  it('returns one strat pipeline ID per analysis + a combined when 2+ refs', async () => {
    const { runStrategies } = await import('../broll-runner.js?strat=' + Date.now())
    const r = await runStrategies({
      subGroupId: 1, mainVideoId: 387,
      prepPipelineId: '7-387-1', analysisPipelineIds: ['5-387-1-ex901', '5-387-1-ex902'],
    })
    // 2 individual + 1 combined
    expect(r.strategyPipelineIds).toHaveLength(3)
    expect(r.combinedPipelineId).toMatch(/^cstrat-387-\d+$/)
    // slice(-6) of '5-387-1-ex901' is '-ex901' → produces 'strat-{vid}-{ts}--ex901'
    expect(r.strategyPipelineIds[0]).toMatch(/^strat-387-\d+--ex901$/)
  })

  it('skips analysis IDs that already have a completed strategy', async () => {
    state.existingStratRuns = [
      { metadata_json: JSON.stringify({ phase: 'create_strategy', analysisPipelineId: '5-387-1-ex901' }) },
    ]
    const { runStrategies } = await import('../broll-runner.js?strat2=' + Date.now())
    const r = await runStrategies({
      subGroupId: 1, mainVideoId: 387,
      prepPipelineId: '7-387-1', analysisPipelineIds: ['5-387-1-ex901', '5-387-1-ex902'],
    })
    // 1 new individual + 1 combined (re-fired because new analyses present)
    expect(r.strategyPipelineIds).toHaveLength(2)
    expect(r.combinedPipelineId).toBeTruthy()
  })

  it('does not fire combined for a single reference', async () => {
    const { runStrategies } = await import('../broll-runner.js?strat3=' + Date.now())
    const r = await runStrategies({
      subGroupId: 1, mainVideoId: 387,
      prepPipelineId: '7-387-1', analysisPipelineIds: ['5-387-1-ex901'],
    })
    expect(r.strategyPipelineIds).toHaveLength(1)
    expect(r.combinedPipelineId).toBeNull()
  })
})

describe('runPlanForEachVariant', () => {
  it('runs one plan pipeline per strategy variant', async () => {
    const broll = await import('../broll.js')
    let counter = 0
    // Stub executeCreatePlan: each call returns a new planPipelineId.
    // (Post-fix contract: runPlanForEachVariant reads the ID from the
    // resolved value, not from the progress map — see broll-runner.js
    // runPlanForEachVariant comment for history.)
    broll.executeCreatePlan.mockImplementation(async (prepId, stratId, vid, gid) => {
      counter += 1
      const pid = `plan-${vid}-${Date.now()}-${counter}`
      broll.brollPipelineProgress.set(pid, { phase: 'create_plan', status: 'running' })
      return { planPipelineId: pid, stageCount: 1, totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, totalRuntime: 0 }
    })

    const { runPlanForEachVariant } = await import('../broll-runner.js?plan=' + Date.now())
    const r = await runPlanForEachVariant({
      subGroupId: 1, mainVideoId: 387, prepPipelineId: '7-387-1',
      strategyPipelineIds: ['strat-387-1-A', 'strat-387-1-B'],
    })
    expect(r.planPipelineIds).toHaveLength(2)
    expect(r.planPipelineIds[0]).toMatch(/^plan-387-/)
    expect(r.planPipelineIds[1]).toMatch(/^plan-387-/)
    expect(r.planPipelineIds[0]).not.toBe(r.planPipelineIds[1])
  })
})

describe('waitForPipelinesComplete', () => {
  it('resolves when all pipelines reach complete', async () => {
    const { waitForPipelinesComplete } = await import('../broll-runner.js?wait=' + Date.now())
    const { brollPipelineProgress } = await import('../broll.js')
    brollPipelineProgress.set('p1', { status: 'running' })
    brollPipelineProgress.set('p2', { status: 'running' })
    const promise = waitForPipelinesComplete(['p1', 'p2'], { pollIntervalMs: 10, maxWaitMs: 1000 })
    setTimeout(() => brollPipelineProgress.set('p1', { status: 'complete' }), 30)
    setTimeout(() => brollPipelineProgress.set('p2', { status: 'complete' }), 60)
    await expect(promise).resolves.toBeUndefined()
  })

  it('rejects on first failed pipeline', async () => {
    const { waitForPipelinesComplete } = await import('../broll-runner.js?fail=' + Date.now())
    const { brollPipelineProgress } = await import('../broll.js')
    brollPipelineProgress.set('p3', { status: 'running' })
    setTimeout(() => brollPipelineProgress.set('p3', { status: 'failed', error: 'boom' }), 20)
    await expect(waitForPipelinesComplete(['p3'], { pollIntervalMs: 10 })).rejects.toThrow(/p3.*failed/)
  })

  it('resolves via DB fallback when in-memory entry is missing but all stages complete in DB', async () => {
    // Simulates: pipeline finished, in-memory entry got GC'd (legacy 5-min
    // delete OR process restart), DB has every main stage marked complete.
    // The wait must not stall — DB is source of truth.
    const { waitForPipelinesComplete } = await import('../broll-runner.js?dbpass=' + Date.now())
    const { brollPipelineProgress } = await import('../broll.js')
    brollPipelineProgress.delete('p-db-1')
    state.completionRowsByPid['p-db-1'] = { main_stages: 7, total_stages: 7 }
    await expect(
      waitForPipelinesComplete(['p-db-1'], { pollIntervalMs: 10, maxWaitMs: 1000 })
    ).resolves.toBeUndefined()
  })

  it('keeps polling when DB shows partial main_stages (pipeline still in flight)', async () => {
    // 3 of 7 stages on disk → not done. Wait should NOT exit early.
    // We surface "did not exit early" by giving a small maxWaitMs and
    // expecting a timeout error rather than a clean resolve.
    const { waitForPipelinesComplete } = await import('../broll-runner.js?dbwait=' + Date.now())
    const { brollPipelineProgress } = await import('../broll.js')
    brollPipelineProgress.delete('p-db-2')
    state.completionRowsByPid['p-db-2'] = { main_stages: 3, total_stages: 7 }
    await expect(
      waitForPipelinesComplete(['p-db-2'], { pollIntervalMs: 10, maxWaitMs: 80 })
    ).rejects.toThrow(/timed out/)
  })

  it('does not re-stall after a completed pid is GC\'d mid-wait (defensive cache)', async () => {
    // Reproduces the exact race that stuck the chain at refs:
    // p-fast finishes early, its in-memory entry is then deleted while
    // p-slow is still running. Without a local "already-seen-complete"
    // cache, the wait would re-poll p-fast, see undefined, and stall.
    const { waitForPipelinesComplete } = await import('../broll-runner.js?gcrace=' + Date.now())
    const { brollPipelineProgress } = await import('../broll.js')
    brollPipelineProgress.set('p-fast', { status: 'running' })
    brollPipelineProgress.set('p-slow', { status: 'running' })
    const promise = waitForPipelinesComplete(['p-fast', 'p-slow'], { pollIntervalMs: 10, maxWaitMs: 1000 })
    setTimeout(() => brollPipelineProgress.set('p-fast', { status: 'complete' }), 20)
    setTimeout(() => brollPipelineProgress.delete('p-fast'), 50)  // simulate GC after we observed it
    setTimeout(() => brollPipelineProgress.set('p-slow', { status: 'complete' }), 100)
    await expect(promise).resolves.toBeUndefined()
  })
})

describe('runBrollSearchFirst10', () => {
  it('fires executeSearchBatch and returns the new searchPipelineId', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockClear()
    const { runBrollSearchFirst10 } = await import('../broll-runner.js?search=' + Date.now())
    const r = await runBrollSearchFirst10({
      subGroupId: 1, planPipelineIds: ['plan-387-1', 'plan-387-2'],
    })
    expect(r.searchPipelineId).toMatch(/^search-batch-\d+$/)
    expect(broll.executeSearchBatch).toHaveBeenCalledWith(
      ['plan-387-1', 'plan-387-2'], 10, r.searchPipelineId,
    )
  })

  it('awaits executeSearchBatch before returning (regression: race with waitForSearchBatchComplete)', async () => {
    // Simulate the LLM-call delay inside executeSearchBatch. If runBrollSearchFirst10
    // does not await, it returns immediately and the caller polls before INSERTs land.
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockClear()
    let resolveSearch
    const searchPromise = new Promise(r => { resolveSearch = r })
    broll.executeSearchBatch.mockImplementationOnce(() => searchPromise)

    const { runBrollSearchFirst10 } = await import('../broll-runner.js?awaits=' + Date.now())

    let resolved = false
    const callPromise = runBrollSearchFirst10({
      subGroupId: 1, planPipelineIds: ['p1'],
    }).then(r => { resolved = true; return r })

    // Yield to the event loop so any non-awaited resolution would have happened.
    await new Promise(r => setTimeout(r, 20))
    expect(resolved).toBe(false)  // would be true under the buggy fire-and-forget version

    resolveSearch()
    const r = await callPromise
    expect(resolved).toBe(true)
    expect(r.searchPipelineId).toMatch(/^search-batch-\d+$/)
  })
})

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

  it('returns silently with a warn log on timeout when count never drains', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js?wfsbc3=' + Date.now())
    // Always returns 5 — never drains
    state.batchCountSeq = []
    state.batchCountAlways = 5
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      waitForSearchBatchComplete('search-batch-stuck', { pollIntervalMs: 10, maxWaitMs: 50 })
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    const warnMsg = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(warnMsg).toMatch(/timed out|search-batch-stuck/i)
    warnSpy.mockRestore()
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
