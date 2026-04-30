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
          if (/SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id/.test(sql)) {
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
  pathToFlags: () => ({ stopAfterStrategy: false, stopAfterPlan: false, autoSelectVariants: true }),
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
  runBrollSearchFirst10: vi.fn(async () => {
    state.runnerCalls.push('runBrollSearchFirst10')
  }),
  waitForPipelinesComplete: vi.fn(async () => {}),
}))

vi.mock('../email-notifier.js', () => ({ send: vi.fn(async () => {}) }))

const { runFullAutoBrollChain } = await import('../auto-orchestrator.js')

beforeEach(() => {
  state.brollChainUpdates = []
  state.runnerCalls = []
  state.phaseOutputs = { refsPrep: false, refsAnalysis: false, strategy: false, plan: false, search: false }
})

describe('runFullAutoBrollChain with resumeFromSubstage', () => {
  it('default behavior (no option) runs all phases', async () => {
    await runFullAutoBrollChain(7)
    expect(state.runnerCalls).toEqual(['runAllReferences', 'runStrategies', 'runPlanForEachVariant', 'runBrollSearchFirst10'])
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
    expect(state.runnerCalls).toContain('runBrollSearchFirst10')
  })
})
