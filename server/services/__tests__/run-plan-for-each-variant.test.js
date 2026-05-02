import { describe, it, expect, vi, beforeEach } from 'vitest'

// db.js does process.exit(1) at module load if DATABASE_URL is unset; mock it
// out so importing broll-runner.js (which transitively imports db.js) works.
vi.mock('../../db.js', () => ({
  default: {
    prepare() { return { async get() { return null }, async all() { return [] } } },
  },
}))

// Captures dispatched executeCreatePlan calls.
const calls = []
const progressMap = new Map()

vi.mock('../broll.js', () => ({
  executeCreatePlan: async (prepId, stratId, videoId, groupId) => {
    calls.push({ prepId, stratId, videoId, groupId })
    // Simulate variable prep latency: each call takes a different amount
    // of time before "registering" — the bug we're fixing is that the old
    // code missed any plan that took >500ms to register.
    const planPipelineId = `plan-${videoId}-${Date.now()}-${stratId.slice(-3)}`
    const delayMs = stratId.includes('slow') ? 1500 : 50
    await new Promise(r => setTimeout(r, delayMs))
    progressMap.set(planPipelineId, { phase: 'create_plan', status: 'complete' })
    return {
      planPipelineId,
      stageCount: 2,
      totalTokensIn: 100,
      totalTokensOut: 50,
      totalCost: 0.001,
      totalRuntime: delayMs,
    }
  },
  brollPipelineProgress: progressMap,
}))

describe('runPlanForEachVariant', () => {
  beforeEach(() => {
    calls.length = 0
    progressMap.clear()
  })

  it('returns one planPipelineId per strategy, in input order', async () => {
    const { runPlanForEachVariant } = await import('../broll-runner.js')
    const result = await runPlanForEachVariant({
      subGroupId: 1,
      mainVideoId: 100,
      prepPipelineId: 'prep-100',
      strategyPipelineIds: ['strat-aaa', 'strat-bbb', 'strat-ccc'],
    })
    expect(result.planPipelineIds).toHaveLength(3)
    // Each plan ID was constructed from the strategy ID's last 3 chars
    expect(result.planPipelineIds[0]).toMatch(/-aaa$/)
    expect(result.planPipelineIds[1]).toMatch(/-bbb$/)
    expect(result.planPipelineIds[2]).toMatch(/-ccc$/)
  })

  it('captures all plan IDs even when some take longer than 500ms to register (regression)', async () => {
    const { runPlanForEachVariant } = await import('../broll-runner.js')
    // The 'slow' marker triggers a 1500ms delay in our mock — under the old
    // 500ms-scrape implementation, this plan would be silently dropped.
    const result = await runPlanForEachVariant({
      subGroupId: 1,
      mainVideoId: 100,
      prepPipelineId: 'prep-100',
      strategyPipelineIds: ['strat-fast', 'strat-slow-mid', 'strat-slow-late'],
    })
    expect(result.planPipelineIds).toHaveLength(3)
  })

  it('throws when required args are missing', async () => {
    const { runPlanForEachVariant } = await import('../broll-runner.js')
    await expect(runPlanForEachVariant({
      subGroupId: 1, mainVideoId: 100, strategyPipelineIds: ['s'],
    })).rejects.toThrow(/required/)
  })

  it('logs warning and skips plans that fail, but returns the rest', async () => {
    const { runPlanForEachVariant } = await import('../broll-runner.js')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Re-mock executeCreatePlan to fail one call
    const broll = await import('../broll.js')
    const original = broll.executeCreatePlan
    broll.executeCreatePlan = vi.fn(async (prepId, stratId, videoId, groupId) => {
      if (stratId === 'strat-fail') throw new Error('boom')
      return original(prepId, stratId, videoId, groupId)
    })

    const result = await runPlanForEachVariant({
      subGroupId: 1, mainVideoId: 100, prepPipelineId: 'prep',
      strategyPipelineIds: ['strat-aaa', 'strat-fail', 'strat-bbb'],
    })

    expect(result.planPipelineIds).toHaveLength(2)
    expect(errSpy).toHaveBeenCalled()

    errSpy.mockRestore()
    warnSpy.mockRestore()
    broll.executeCreatePlan = original
  })

  it('runs plans in parallel, not sequentially (timing check)', async () => {
    const { runPlanForEachVariant } = await import('../broll-runner.js')
    // 3 plans × 1500ms each. If sequential, total ≥ 4500ms. If parallel,
    // total ≈ 1500ms (the slowest one).
    const start = Date.now()
    await runPlanForEachVariant({
      subGroupId: 1, mainVideoId: 100, prepPipelineId: 'prep',
      strategyPipelineIds: ['strat-slow-1', 'strat-slow-2', 'strat-slow-3'],
    })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(3000)  // generous: parallel should be <1700ms
  })
})
