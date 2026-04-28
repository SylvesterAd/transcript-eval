// Tests for runAllReferences.
//
// Mirrors the rough-cut-runner.test pattern: mock db.js + the broll service
// helpers, exercise both fresh-project and skip-existing-analysis branches.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  videos: [{ id: 387, group_id: 1 }, { id: 388, group_id: 1 }],
  examples: [{ id: 901 }, { id: 902 }],
  analysisStrategy: { id: 5 },
  analysisVersion: { id: 50 },
  completedAnalysis: [],
  group: { id: 1, editor_state_json: null },
  existingStratRuns: [],
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT editor_state_json FROM video_groups WHERE id = \?/.test(sql)) return state.group
          if (/SELECT \* FROM broll_strategies WHERE strategy_kind = 'main_analysis'/.test(sql)) return state.analysisStrategy
          if (/SELECT \* FROM broll_strategy_versions/.test(sql)) return state.analysisVersion
          if (/metadata_json LIKE.*plan_prep/.test(sql)) return null
          throw new Error(`unexpected get: ${sql}`)
        },
        async all(...args) {
          if (/FROM broll_runs WHERE strategy_id = \? AND video_id = \?/.test(sql)) return state.completedAnalysis
          if (/FROM broll_runs WHERE video_id = \? AND status = 'complete' AND metadata_json LIKE '%"phase":"create_strategy"%'/.test(sql)) return state.existingStratRuns
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
