import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbState = vi.hoisted(() => ({ updates: [] }))

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        get: () => ({ id: 99, user_id: 1, path_id: 'guided', parent_group_id: null }),
        run: (...args) => { dbState.updates.push({ sql, args }); return { changes: 1 } },
        all: () => [],
      }
    },
  },
}))

const runFullAutoBrollChainMock = vi.fn().mockResolvedValue(undefined)
// resumeChain imports './broll-runner.js' for plan/search; from=strategy
// should NOT touch the runner — it delegates to runFullAutoBrollChain.
vi.mock('../broll-runner.js', () => ({}))

vi.mock('../email-notifier.js', () => ({
  send: vi.fn().mockResolvedValue(undefined),
}))

// Inject mock into orchestrator's dep map.
import * as orchestrator from '../auto-orchestrator.js'
orchestrator.__orchestratorDeps.runFullAutoBrollChain = runFullAutoBrollChainMock

describe('resumeChain(fromStage=strategy)', () => {
  beforeEach(() => {
    dbState.updates.length = 0
    runFullAutoBrollChainMock.mockClear()
  })

  it('invokes runFullAutoBrollChain so the chain runs refs+strategy and pauses', async () => {
    await orchestrator.resumeChain(99, 'strategy')
    expect(runFullAutoBrollChainMock).toHaveBeenCalledWith(99)
  })

  it("does NOT set status='running' itself (the chain owns that transition)", async () => {
    await orchestrator.resumeChain(99, 'strategy')
    // No direct UPDATE to running with substage from this branch — the chain sets it.
    const direct = dbState.updates.find(u =>
      u.sql.includes("broll_chain_status = 'running'") && u.sql.includes('substage')
    )
    expect(direct).toBeFalsy()
  })
})
