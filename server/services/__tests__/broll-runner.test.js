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
  analysisVersion: { id: 50 },
  existingPrepRun: null,
  existingCombinedRun: null,
  completedAnalysis: [],
  group: { id: 1, editor_state_json: null },
  existingStratRuns: [],
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
          // existingCombined lookup (post-e229184): SELECT 1 ... LIMIT 1
          if (/SELECT 1 FROM broll_runs[\s\S]*LIMIT 1/.test(sql)) return state.existingCombinedRun
          throw new Error(`unexpected get: ${sql}`)
        },
        async all(...args) {
          if (/FROM broll_runs WHERE strategy_id = \? AND video_id = \?/.test(sql)) return state.completedAnalysis
          // existingStratRuns (post-e229184): WHERE video_id = ? AND strategy_id = ?
          if (/FROM broll_runs[\s\S]*WHERE video_id = \? AND strategy_id = \?/.test(sql)) return state.existingStratRuns
          throw new Error(`unexpected all: ${sql}`)
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
    // Stub executeCreatePlan: each call registers a new plan-* progress entry
    broll.executeCreatePlan.mockImplementation(async (prepId, stratId, vid, gid) => {
      counter += 1
      const pid = `plan-${vid}-${Date.now()}-${counter}`
      broll.brollPipelineProgress.set(pid, { phase: 'create_plan', status: 'running' })
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
})
