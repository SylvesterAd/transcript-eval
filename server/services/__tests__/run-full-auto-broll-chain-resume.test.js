// Tests for runFullAutoBrollChain's resumeFromSubstage option (Task 5 of
// the b-roll auto-resume plan). The boot-time resume path passes
// { resumeFromSubstage } so phases whose outputs already exist in broll_runs
// are skipped — the chain just advances from where the previous server died.
//
// Existing callers (e.g., the first 'stuck' loop in resumeStuckFullAutoChains)
// pass nothing → unchanged behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  subGroup: { id: 7, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 },
  mainVideo: { id: 100 },
  brollChainUpdates: [],
  // Track runner method call ordering
  runnerCalls: [],
  // Capture the args each runBrollSearchAll call received, so tests can
  // assert what planPipelineIds the search phase was handed.
  searchBatchArgs: [],
  // Plan pipelineIds the DB recovery query (plan-% prefix) should return when
  // resumeChain('search') has to reconstruct them (no opts supplied).
  recoveredPlanPids: [],
  // What phaseHasOutputs returns per (phase, strategy_kind). The mocked db.get
  // below inspects the kind arg to decide whether to return a row. Refs is now
  // split into refsPrep + refsAnalysis because phaseHasOutputs requires BOTH.
  phaseOutputs: { refsPrep: false, refsAnalysis: false, strategy: false, plan: false, search: false },
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT id, user_id, path_id, parent_group_id.* FROM video_groups WHERE id/.test(sql)) {
            return state.subGroup
          }
          // isCancelled probe — never cancelled in these tests.
          if (/SELECT assembly_status FROM video_groups WHERE id/.test(sql)) {
            return { assembly_status: 'done' }
          }
          if (/SELECT v\.id FROM videos v/.test(sql)) {
            return state.mainVideo
          }
          // phaseHasOutputs probe — phaseHasOutputs queries each strategy_kind
          // separately now (one IN per call), so the LAST arg is the kind being
          // asked about. Map it to the phaseOutputs table.
          if (/JOIN broll_strategies s ON s\.id = r\.strategy_id/.test(sql)) {
            const kind = args[args.length - 1]
            if (kind === 'main_analysis' && state.phaseOutputs.refsAnalysis) return { '?column?': 1 }
            if (kind === 'plan_prep' && state.phaseOutputs.refsPrep) return { '?column?': 1 }
            if (kind === 'create_strategy' && state.phaseOutputs.strategy) return { '?column?': 1 }
            if (kind === 'create_combined_strategy' && state.phaseOutputs.strategy) return { '?column?': 1 }
            if (kind === 'plan' && state.phaseOutputs.plan) return { '?column?': 1 }
            return null
          }
          // Recovery queries (when skipping a phase, we look up the latest
          // completed pipelineIds for that phase's strategy_kinds). Return
          // empty so refs/strategy/plan recovery yields no pipelineIds — the
          // tests don't assert on the recovered IDs.
          if (/SELECT metadata_json FROM broll_runs r/.test(sql)) {
            return null
          }
          return null
        },
        async all(...args) {
          if (/SELECT id FROM videos WHERE group_id = \?/.test(sql)) {
            return [{ id: 100 }]
          }
          // Recovery queries via .all
          if (/SELECT DISTINCT metadata_json FROM broll_runs r/.test(sql)) {
            return []
          }
          // resumeChain('search') plan-pid recovery (plan-% prefix match).
          if (/->>'pipelineId'\)\s*LIKE 'plan-%'/.test(sql)) {
            return state.recoveredPlanPids.map(pid => ({ pid }))
          }
          return []
        },
        async run(...args) {
          if (/UPDATE video_groups SET broll_chain_status/.test(sql) || /UPDATE video_groups SET broll_chain_substage/.test(sql)) {
            state.brollChainUpdates.push({ sql, args })
          }
          return { changes: 1 }
        },
      }
    },
  },
}))

vi.mock('../../routes/broll.js', () => ({
  pathToFlags: () => ({ stopAfterRoughCut: false, stopAfterStrategy: false, autoSelectVariants: true }),
}))

vi.mock('../broll-runner.js', () => ({
  runAllReferences: vi.fn(async () => {
    state.runnerCalls.push('runAllReferences')
    return { prepPipelineId: 'prep-1', analysisPipelineIds: ['a-1'] }
  }),
  runStrategies: vi.fn(async () => {
    state.runnerCalls.push('runStrategies')
    return { strategyPipelineIds: ['s-1'] }
  }),
  runPlanForEachVariant: vi.fn(async () => {
    state.runnerCalls.push('runPlanForEachVariant')
    return { planPipelineIds: ['p-1'] }
  }),
  runBrollSearchAll: vi.fn(async (args) => {
    state.runnerCalls.push('runBrollSearchAll')
    state.searchBatchArgs.push(args)
    return { searchPipelineId: `search-batch-mock-${state.runnerCalls.filter(c => c === 'runBrollSearchAll').length}` }
  }),
  waitForSearchBatchComplete: vi.fn(async () => {
    state.runnerCalls.push('waitForSearchBatchComplete')
  }),
  waitForPipelinesComplete: vi.fn(async () => {}),
}))

vi.mock('../email-notifier.js', () => ({ send: vi.fn(async () => {}) }))

const { runFullAutoBrollChain, resumeChain } = await import('../auto-orchestrator.js')

beforeEach(() => {
  state.brollChainUpdates = []
  state.runnerCalls = []
  state.searchBatchArgs = []
  state.recoveredPlanPids = []
  state.phaseOutputs = { refsPrep: false, refsAnalysis: false, strategy: false, plan: false, search: false }
})

describe('runFullAutoBrollChain with resumeFromSubstage', () => {
  it('default behavior (no option) runs all phases', async () => {
    await runFullAutoBrollChain(7)
    // Phase 4 (search) now runs ONE runBrollSearchAll (which internally loops
    // until every position is enqueued), then a single waitForSearchBatchComplete
    // to drain the GPU queue before marking the chain done.
    expect(state.runnerCalls).toEqual([
      'runAllReferences',
      'runStrategies',
      'runPlanForEachVariant',
      'runBrollSearchAll',
      'waitForSearchBatchComplete',
    ])
  })

  it('skips refs phase when BOTH prep and analysis outputs exist', async () => {
    state.phaseOutputs.refsPrep = true
    state.phaseOutputs.refsAnalysis = true
    await runFullAutoBrollChain(7, { resumeFromSubstage: 'refs' })
    expect(state.runnerCalls).not.toContain('runAllReferences')
    expect(state.runnerCalls).toContain('runStrategies')
  })

  it('does NOT skip refs when only main_analysis exists (plan_prep missing)', async () => {
    // This is the bug surfaced live: analysis pipelines completed on resume but
    // plan_prep was never run. With only one of the two, the next phase
    // (runStrategies) needs prepPipelineId AND analysisPipelineIds — without the
    // prep ID it would throw. Re-entering refs lets runAllReferences fill it in.
    state.phaseOutputs.refsAnalysis = true
    state.phaseOutputs.refsPrep = false
    await runFullAutoBrollChain(7, { resumeFromSubstage: 'refs' })
    expect(state.runnerCalls).toContain('runAllReferences')
  })

  it('does NOT skip refs when only plan_prep exists (main_analysis missing)', async () => {
    state.phaseOutputs.refsPrep = true
    state.phaseOutputs.refsAnalysis = false
    await runFullAutoBrollChain(7, { resumeFromSubstage: 'refs' })
    expect(state.runnerCalls).toContain('runAllReferences')
  })

  it('skips refs and strategy when refs(both) + strategy have outputs', async () => {
    state.phaseOutputs.refsPrep = true
    state.phaseOutputs.refsAnalysis = true
    state.phaseOutputs.strategy = true
    await runFullAutoBrollChain(7, { resumeFromSubstage: 'strategy' })
    expect(state.runnerCalls).not.toContain('runAllReferences')
    expect(state.runnerCalls).not.toContain('runStrategies')
    expect(state.runnerCalls).toContain('runPlanForEachVariant')
  })

  it('runs phase if outputs are missing even when resumeFromSubstage names that phase', async () => {
    // refsPrep=false, refsAnalysis=false → phaseHasOutputs returns false → don't skip
    await runFullAutoBrollChain(7, { resumeFromSubstage: 'refs' })
    expect(state.runnerCalls).toContain('runAllReferences')
  })

  it('always runs search phase (idempotent re-run is safer than skipping)', async () => {
    state.phaseOutputs.refsPrep = true
    state.phaseOutputs.refsAnalysis = true
    state.phaseOutputs.strategy = true
    state.phaseOutputs.plan = true
    await runFullAutoBrollChain(7, { resumeFromSubstage: 'plan' })
    expect(state.runnerCalls).toContain('runBrollSearchAll')
  })
})

describe('resumeChain Phase 4 search-all', () => {
  it("runs ONE search-all + one drain wait when fromStage='plan' completes the final search step", async () => {
    state.runnerCalls = []
    state.subGroup = { id: 7, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 }
    await resumeChain(7, 'plan', { strategyPipelineIds: ['s-1'], prepPipelineId: 'prep-1' })
    const searchCalls = state.runnerCalls.filter(c => c === 'runBrollSearchAll').length
    const waitCalls = state.runnerCalls.filter(c => c === 'waitForSearchBatchComplete').length
    expect(searchCalls).toBe(1)
    expect(waitCalls).toBe(1)
    const phase4 = state.runnerCalls.filter(
      c => c === 'runBrollSearchAll' || c === 'waitForSearchBatchComplete'
    )
    expect(phase4).toEqual(['runBrollSearchAll', 'waitForSearchBatchComplete'])
  })

  it("runs ONE search-all + one drain wait when fromStage='search'", async () => {
    state.runnerCalls = []
    state.subGroup = { id: 7, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 }
    await resumeChain(7, 'search', { planPipelineIds: ['p-1'] })
    const searchCalls = state.runnerCalls.filter(c => c === 'runBrollSearchAll').length
    const waitCalls = state.runnerCalls.filter(c => c === 'waitForSearchBatchComplete').length
    expect(searchCalls).toBe(1)
    expect(waitCalls).toBe(1)
    const phase4 = state.runnerCalls.filter(
      c => c === 'runBrollSearchAll' || c === 'waitForSearchBatchComplete'
    )
    expect(phase4).toEqual(['runBrollSearchAll', 'waitForSearchBatchComplete'])
  })

  // Regression for prod crash search-batch-1779455020983: the boot/periodic
  // auto-resume sweep (resumeInterruptedFullAutoChains) advances a chain stuck
  // at substage 'search' via resumeChain(id, 'search') with NO opts. The old
  // `opts.planPipelineIds || [opts.planPipelineId]` then produced [undefined],
  // which crashed executeSearchBatch on `undefined.slice(-13)`. resumeChain
  // must instead recover the real plan ids from the DB.
  it("fromStage='search' with NO opts never hands undefined plan ids to search", async () => {
    state.runnerCalls = []
    state.searchBatchArgs = []
    state.subGroup = { id: 7, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 }
    state.recoveredPlanPids = ['plan-100-111', 'plan-100-222']

    await resumeChain(7, 'search') // <- no opts, exactly like the sweep at line ~905

    expect(state.searchBatchArgs.length).toBe(1)
    for (const callArgs of state.searchBatchArgs) {
      expect(Array.isArray(callArgs.planPipelineIds)).toBe(true)
      // No falsy entries — the [undefined] crash signature must be gone.
      expect(callArgs.planPipelineIds.every(Boolean)).toBe(true)
      // Recovered from the DB by plan-% prefix.
      expect(callArgs.planPipelineIds).toEqual(['plan-100-111', 'plan-100-222'])
    }
  })

  it("fromStage='search' with no opts and no recoverable plans fails loudly", async () => {
    state.runnerCalls = []
    state.searchBatchArgs = []
    state.subGroup = { id: 7, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 }
    state.recoveredPlanPids = [] // nothing in the DB

    // resumeChain swallows errors into a 'failed' broll_chain_status update
    // rather than rejecting, so assert no search batch was ever dispatched.
    await resumeChain(7, 'search')
    expect(state.searchBatchArgs.length).toBe(0)
    expect(state.runnerCalls).not.toContain('runBrollSearchAll')
  })
})
