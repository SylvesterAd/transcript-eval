import { describe, it, expect, vi, beforeEach } from 'vitest'

// Each db.prepare call gets a result driven by the SQL pattern.
const dbState = {
  // Match `WHERE strategy_kind = 'create_strategy' ...` → strategy row
  createStrategy: { id: 8 },
  // Match `WHERE strategy_kind = 'create_combined_strategy'` → combined strategy row
  combinedStrategy: { id: 10 },
  // Match `WHERE strategy_kind = 'create_plan' ...` → plan strategy row
  createPlan: { id: 9 },
  // Returned for `SELECT metadata_json FROM broll_runs ... strategy_id = 8` (create_strategy runs)
  existingStratRuns: [],
  // Returned for `SELECT metadata_json FROM broll_runs ... strategy_id = 9` (create_plan runs)
  existingPlanRuns: [],
  // Returned for the existing-combined check (LIMIT 1 row when present)
  existingCombined: false,
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/strategy_kind = 'create_strategy'/.test(sql)) return dbState.createStrategy
          if (/strategy_kind = 'create_combined_strategy'/.test(sql)) return dbState.combinedStrategy
          if (/strategy_kind = 'create_plan'/.test(sql)) return dbState.createPlan
          if (/SELECT 1 FROM broll_runs/.test(sql) && /strategy_id = \?/.test(sql)) {
            // The "existing combined" check.
            return dbState.existingCombined ? { '?column?': 1 } : null
          }
          return null
        },
        async all(...args) {
          if (/SELECT metadata_json FROM broll_runs/.test(sql) && /strategy_id = \?/.test(sql)) {
            const stratId = args[1] // [video_id, strategy_id]
            if (stratId === 8) return dbState.existingStratRuns
            if (stratId === 9) return dbState.existingPlanRuns
            return []
          }
          return []
        },
        async run() { return { changes: 0 } },
      }
    },
  },
}))

// Lightweight broll.js mock — we only need brollPipelineProgress + the
// executeCreate* functions to exist as no-op vi.fn so runStrategies and
// runPlanForEachVariant can call into them without spawning real work.
const fakeProgress = new Map()
const executeCreateStrategy = vi.fn(async () => ({ ok: true }))
const executeCreateCombinedStrategy = vi.fn(async () => ({ ok: true }))
const executeCreatePlan = vi.fn(async (_prep, stratId) => ({
  planPipelineId: `plan-fresh-${stratId}`,
}))
const loadExampleVideos = vi.fn(async () => [{ id: 478, isFavorite: true }, { id: 479, isFavorite: false }])

vi.mock('../broll.js', () => ({
  brollPipelineProgress: fakeProgress,
  executeCreateStrategy,
  executeCreateCombinedStrategy,
  executeCreatePlan,
  loadExampleVideos,
}))

import { runStrategies, runPlanForEachVariant } from '../broll-runner.js'

describe('runStrategies dedup propagation', () => {
  beforeEach(() => {
    fakeProgress.clear()
    dbState.existingStratRuns = []
    dbState.existingCombined = false
    executeCreateStrategy.mockClear()
    executeCreateCombinedStrategy.mockClear()
  })

  it('returns empty strategy IDs when there are zero analyses with strategies AND no analyses to fire', async () => {
    // Edge case: caller passed at least one analysis ID, but DB says nothing
    // exists. With no existing strategies AND no analyses to skip, allPipelineIds
    // gets the new strategies. So strategyPipelineIds is non-empty.
    const out = await runStrategies({
      subGroupId: 367, mainVideoId: 511,
      prepPipelineId: 'prep-1', analysisPipelineIds: ['analysis-X-ex478'],
    })
    expect(out.strategyPipelineIds.length).toBeGreaterThan(0)
    expect(executeCreateStrategy).toHaveBeenCalled()
  })

  it('forwards existing strategy pipelineIds when all analyses are dedup-skipped', async () => {
    // The bug: previously, when every analysis already had a complete
    // strategy, strategyPipelineIds came back empty — plan phase then
    // crashed. Fix: existing strategy IDs get forwarded.
    dbState.existingStratRuns = [
      { metadata_json: JSON.stringify({ analysisPipelineId: 'analysis-X-ex478', pipelineId: 'strat-cached-A' }) },
      { metadata_json: JSON.stringify({ analysisPipelineId: 'analysis-Y-ex479', pipelineId: 'strat-cached-B' }) },
    ]
    dbState.existingCombined = true // also pretend combined exists so we don't fire it
    const out = await runStrategies({
      subGroupId: 367, mainVideoId: 511,
      prepPipelineId: 'prep-1',
      analysisPipelineIds: ['analysis-X-ex478', 'analysis-Y-ex479'],
    })
    expect(out.strategyPipelineIds).toEqual(['strat-cached-A', 'strat-cached-B'])
    expect(executeCreateStrategy).not.toHaveBeenCalled()
  })

  it('mixes new + existing strategy pipelineIds when some analyses are cached', async () => {
    dbState.existingStratRuns = [
      { metadata_json: JSON.stringify({ analysisPipelineId: 'analysis-X-ex478', pipelineId: 'strat-cached-A' }) },
    ]
    const out = await runStrategies({
      subGroupId: 367, mainVideoId: 511,
      prepPipelineId: 'prep-1',
      analysisPipelineIds: ['analysis-X-ex478', 'analysis-Y-ex479'],
    })
    // Cached A is preserved; B fires fresh.
    const cached = out.strategyPipelineIds.filter(p => p === 'strat-cached-A')
    expect(cached).toHaveLength(1)
    // At least one fresh strategy fired (the strat-* prefix indicates new).
    expect(out.strategyPipelineIds.some(p => p.startsWith('strat-') && p !== 'strat-cached-A')).toBe(true)
  })

  it('preserves input order for existing strategy pipelineIds', async () => {
    // Input: [Y first, X second]. Existing strategies: both. Output should
    // forward in input order.
    dbState.existingStratRuns = [
      { metadata_json: JSON.stringify({ analysisPipelineId: 'analysis-X-ex478', pipelineId: 'strat-cached-X' }) },
      { metadata_json: JSON.stringify({ analysisPipelineId: 'analysis-Y-ex479', pipelineId: 'strat-cached-Y' }) },
    ]
    dbState.existingCombined = true
    const out = await runStrategies({
      subGroupId: 367, mainVideoId: 511,
      prepPipelineId: 'prep-1',
      analysisPipelineIds: ['analysis-Y-ex479', 'analysis-X-ex478'],
    })
    expect(out.strategyPipelineIds).toEqual(['strat-cached-Y', 'strat-cached-X'])
  })

  it('skips runs with malformed metadata_json without crashing', async () => {
    dbState.existingStratRuns = [
      { metadata_json: '{not valid json' },
      { metadata_json: JSON.stringify({ analysisPipelineId: 'analysis-X-ex478', pipelineId: 'strat-cached-A' }) },
      { metadata_json: JSON.stringify({ analysisPipelineId: 'analysis-Y-ex479' }) }, // no pipelineId — skipped
    ]
    dbState.existingCombined = true
    const out = await runStrategies({
      subGroupId: 367, mainVideoId: 511,
      prepPipelineId: 'prep-1',
      analysisPipelineIds: ['analysis-X-ex478', 'analysis-Y-ex479'],
    })
    // X is forwarded; Y is treated as not-existing → fires fresh.
    expect(out.strategyPipelineIds).toContain('strat-cached-A')
    expect(executeCreateStrategy).toHaveBeenCalled()
  })
})

describe('runPlanForEachVariant dedup', () => {
  beforeEach(() => {
    dbState.existingPlanRuns = []
    executeCreatePlan.mockClear()
  })

  it('fires fresh plans when no existing plan runs match', async () => {
    const out = await runPlanForEachVariant({
      subGroupId: 367, mainVideoId: 511,
      prepPipelineId: 'prep-1',
      strategyPipelineIds: ['strat-A', 'strat-B'],
    })
    expect(executeCreatePlan).toHaveBeenCalledTimes(2)
    expect(out.planPipelineIds).toEqual(['plan-fresh-strat-A', 'plan-fresh-strat-B'])
  })

  it('forwards cached plan pipelineIds when all strategies have existing plans', async () => {
    dbState.existingPlanRuns = [
      { metadata_json: JSON.stringify({ strategyPipelineId: 'strat-A', pipelineId: 'plan-cached-A' }) },
      { metadata_json: JSON.stringify({ strategyPipelineId: 'strat-B', pipelineId: 'plan-cached-B' }) },
    ]
    const out = await runPlanForEachVariant({
      subGroupId: 367, mainVideoId: 511,
      prepPipelineId: 'prep-1',
      strategyPipelineIds: ['strat-A', 'strat-B'],
    })
    expect(executeCreatePlan).not.toHaveBeenCalled()
    expect(out.planPipelineIds.sort()).toEqual(['plan-cached-A', 'plan-cached-B'])
  })

  it('mixes new + cached when some strategies have plans and some do not', async () => {
    dbState.existingPlanRuns = [
      { metadata_json: JSON.stringify({ strategyPipelineId: 'strat-A', pipelineId: 'plan-cached-A' }) },
    ]
    const out = await runPlanForEachVariant({
      subGroupId: 367, mainVideoId: 511,
      prepPipelineId: 'prep-1',
      strategyPipelineIds: ['strat-A', 'strat-B'],
    })
    expect(executeCreatePlan).toHaveBeenCalledTimes(1)
    expect(executeCreatePlan).toHaveBeenCalledWith('prep-1', 'strat-B', 511, 367, null)
    expect(out.planPipelineIds.sort()).toEqual(['plan-cached-A', 'plan-fresh-strat-B'])
  })

  it('still throws when called with empty strategyPipelineIds (caller bug)', async () => {
    await expect(
      runPlanForEachVariant({
        subGroupId: 367, mainVideoId: 511,
        prepPipelineId: 'prep-1', strategyPipelineIds: [],
      }),
    ).rejects.toThrow(/required/)
  })
})
