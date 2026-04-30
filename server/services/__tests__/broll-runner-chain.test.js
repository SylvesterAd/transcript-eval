// Focused unit coverage for the favorite-first chain orchestration in
// runStrategies (server/services/broll-runner.js). The existing
// broll-runner.test.js has brittle DB-stub setup with baseline failures —
// this file uses a per-test-configurable mock so the chain branches can be
// exercised without leaking state.
//
// Tests covered:
//   1. orderedAnalysisIds puts the favorite (isFavorite=true) first.
//   2. After the favorite reaches 'complete' in the progress map, the
//      variant fires with priors=[favoritePid].
//   3. When the favorite fails, the chain catches it and flips remaining
//      variants to status='failed' with 'chain aborted:' prefix.
//
// We drive waitForPipelinesComplete by manipulating the (mocked)
// brollPipelineProgress map directly — its body re-imports brollPipelineProgress
// via the same './broll.js' mock, so a status update there resolves the loop.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Module-level mock state ───────────────────────────────────────────────
// Held in a closure that the per-test setup mutates.
const dbState = {
  // Sequence of `.get()` results consumed in order by db.prepare(...).get().
  // runStrategies issues, in order:
  //   1. SELECT id FROM broll_strategies WHERE strategy_kind = 'create_strategy'
  //   2. SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy'
  //   3. SELECT 1 FROM broll_runs ... existing combined?
  // .all() is consumed once for the existingStratRuns query.
  getResults: [],
  allResults: [],
}
let getCallIdx = 0
let allCallIdx = 0

vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      get: vi.fn((..._args) => dbState.getResults[getCallIdx++]),
      all: vi.fn((..._args) => dbState.allResults[allCallIdx++] ?? []),
    })),
  },
}))

const mockProgress = new Map()
const mockExecuteCreateStrategy = vi.fn()
const mockExecuteCreateCombinedStrategy = vi.fn()
const mockLoadExampleVideos = vi.fn()

vi.mock('../broll.js', () => ({
  executeCreateStrategy: mockExecuteCreateStrategy,
  executeCreateCombinedStrategy: mockExecuteCreateCombinedStrategy,
  loadExampleVideos: mockLoadExampleVideos,
  brollPipelineProgress: mockProgress,
}))

import { runStrategies } from '../broll-runner.js'

beforeEach(() => {
  // Reset all mock state between tests.
  getCallIdx = 0
  allCallIdx = 0
  // Default DB sequence: create_strategy id=8, no existingStratRuns,
  // create_combined_strategy id=9, no existing combined.
  dbState.getResults = [
    { id: 8 }, // create_strategy
    { id: 9 }, // create_combined_strategy
    undefined, // no existing combined
  ]
  dbState.allResults = [
    [], // existingStratRuns: none
  ]
  mockExecuteCreateStrategy.mockReset()
  mockExecuteCreateCombinedStrategy.mockReset()
  mockLoadExampleVideos.mockReset()
  mockProgress.clear()
  // Default loadExampleVideos: 3 videos, video #2 is favorite.
  mockLoadExampleVideos.mockResolvedValue([
    { id: 1, isFavorite: false, title: 'Ref A' },
    { id: 2, isFavorite: true, title: 'Ref Fav' },
    { id: 3, isFavorite: false, title: 'Ref C' },
  ])
})

afterEach(() => {
  // Silence any in-flight chain by marking everything complete so the
  // poll loop doesn't keep iterating after the test finishes.
  for (const [pid, p] of mockProgress.entries()) {
    if (p?.status === 'running') {
      mockProgress.set(pid, { ...p, status: 'complete' })
    }
  }
})

describe('runStrategies — favorite-first chain', () => {
  it('orders pipelines favorite-first based on isFavorite flag', async () => {
    // Both helpers never resolve in this test — we only inspect the
    // synchronous return value and the first executeCreateStrategy call.
    mockExecuteCreateStrategy.mockReturnValue(new Promise(() => {}))
    mockExecuteCreateCombinedStrategy.mockReturnValue(new Promise(() => {}))

    const result = await runStrategies({
      subGroupId: 100,
      mainVideoId: 200,
      prepPipelineId: 'prep-200',
      analysisPipelineIds: ['8-200-111-ex1', '8-200-222-ex2', '8-200-333-ex3'],
    })

    // 3 strategy + 1 combined.
    expect(result.strategyPipelineIds).toHaveLength(4)
    expect(result.combinedPipelineId).toBeTruthy()

    // Only the favorite fires immediately; variants wait on the chain.
    expect(mockExecuteCreateStrategy).toHaveBeenCalledTimes(1)
    const firstCall = mockExecuteCreateStrategy.mock.calls[0]
    // executeCreateStrategy(prepPipelineId, analysisPipelineId, mainVideoId, subGroupId, pid, priors)
    expect(firstCall[0]).toBe('prep-200')
    expect(firstCall[1]).toBe('8-200-222-ex2') // favorite analysis ID (-ex2)
    expect(firstCall[2]).toBe(200)
    expect(firstCall[3]).toBe(100)
    expect(firstCall[5]).toEqual([]) // no priors for favorite
  })

  it('fires variant with priors=[favoritePid] after favorite reaches complete', async () => {
    const calls = []
    mockExecuteCreateStrategy.mockImplementation(
      async (_prep, analysisId, _vid, _gid, pid, priors) => {
        calls.push({ pid, priors: [...priors], analysisId })
        // Mark this pipeline complete so subsequent waitForPipelinesComplete
        // calls in the chain (for variants > 1) would resolve too.
        mockProgress.set(pid, { ...mockProgress.get(pid), status: 'complete' })
      },
    )
    mockExecuteCreateCombinedStrategy.mockResolvedValue(undefined)

    const result = await runStrategies({
      subGroupId: 100,
      mainVideoId: 200,
      prepPipelineId: 'prep-200',
      analysisPipelineIds: ['8-200-111-ex1', '8-200-222-ex2'], // -ex2 is favorite
    })

    // Identify the favorite pid (first entry in strategyPipelineIds).
    const favoritePid = result.strategyPipelineIds[0]
    // Mark the favorite complete so waitForPipelinesComplete in the chain resolves.
    mockProgress.set(favoritePid, { ...mockProgress.get(favoritePid), status: 'complete' })

    // Wait for the chain IIFE to consume the completion + fire the variant.
    // waitForPipelinesComplete polls every 2000ms by default; rely on the
    // initial check (no setTimeout before the first poll) — the IIFE's first
    // iteration sees 'complete' immediately and proceeds.
    await new Promise(r => setTimeout(r, 100))

    // Should have at least 2 calls: favorite (priors=[]) and variant (priors=[favoritePid]).
    expect(calls.length).toBeGreaterThanOrEqual(2)

    const favoriteCall = calls.find(c => c.priors.length === 0)
    const variantCall = calls.find(c => c.priors.length === 1)

    expect(favoriteCall).toBeDefined()
    expect(favoriteCall.analysisId).toBe('8-200-222-ex2')
    expect(favoriteCall.pid).toBe(favoritePid)

    expect(variantCall).toBeDefined()
    expect(variantCall.analysisId).toBe('8-200-111-ex1') // the non-favorite
    expect(variantCall.priors).toEqual([favoritePid])
  })

  it('flips remaining variants to failed when favorite fails (chain aborted)', async () => {
    // Favorite call: throw and mark progress 'failed' (mimics the .catch in runStrategies).
    mockExecuteCreateStrategy.mockImplementation(
      async (_prep, _analysisId, _vid, _gid, pid, priors) => {
        if (priors.length === 0) {
          mockProgress.set(pid, {
            ...mockProgress.get(pid),
            status: 'failed',
            error: 'simulated favorite failure',
          })
          throw new Error('simulated favorite failure')
        }
        // Variants should not be reached — the chain aborts first.
        throw new Error('variant should not have been called')
      },
    )
    mockExecuteCreateCombinedStrategy.mockResolvedValue(undefined)

    const result = await runStrategies({
      subGroupId: 100,
      mainVideoId: 200,
      prepPipelineId: 'prep-200',
      analysisPipelineIds: ['8-200-111-ex1', '8-200-222-ex2'], // -ex2 is favorite
    })

    // Wait for the chain IIFE to detect failure and run its catch handler.
    // waitForPipelinesComplete sees status='failed' on the first iteration
    // and throws; the chain's outer .catch flips variants to failed.
    await new Promise(r => setTimeout(r, 100))

    // The variant pid is everything except favorite + combined.
    const favoritePid = result.strategyPipelineIds[0]
    const variantPids = result.strategyPipelineIds
      .filter(p => p !== favoritePid && p !== result.combinedPipelineId)

    expect(variantPids.length).toBeGreaterThan(0)
    for (const vpid of variantPids) {
      const p = mockProgress.get(vpid)
      expect(p).toBeDefined()
      expect(p.status).toBe('failed')
      expect(p.error).toMatch(/^chain aborted:/)
    }
  })
})
