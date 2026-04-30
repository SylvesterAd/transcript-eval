// Tests for runFullAutoBrollChain's duplicate-fire guard. The chain has been
// observed double-firing in production (two parallel main_analysis pipelines
// 20s apart for the same reference video — burned tokens). Root cause: a
// boot-time resumeStuckFullAutoChains can fire a chain that's still being
// driven by the original process (Vercel rolling deploys, dev nodemon hot
// reload, race between multicam-sync trigger and rough-cut completion
// trigger). The guard reads the row's status + heartbeat first; if status is
// 'running' AND heartbeat was updated recently, a fresh trigger bails.
// resumeFromSubstage callers bypass the guard since the boot resume path
// has already filtered by stale heartbeat at the query level.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  subGroup: { id: 7, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 },
  mainVideo: { id: 100 },
  // Lock probe return values
  brollChainStatus: null,
  brollChainHeartbeatAt: null,
  // Track behaviour
  runnerCalls: [],
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          // Lock probe — read status + heartbeat
          if (/SELECT broll_chain_status, broll_chain_heartbeat_at FROM video_groups WHERE id/.test(sql)) {
            return {
              broll_chain_status: state.brollChainStatus,
              broll_chain_heartbeat_at: state.brollChainHeartbeatAt,
            }
          }
          if (/SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id/.test(sql)) {
            return state.subGroup
          }
          if (/SELECT assembly_status FROM video_groups WHERE id/.test(sql)) {
            return { assembly_status: 'done' }
          }
          if (/SELECT v\.id FROM videos v/.test(sql)) {
            return state.mainVideo
          }
          if (/JOIN broll_strategies/.test(sql)) {
            return null
          }
          if (/SELECT metadata_json FROM broll_runs/.test(sql)) {
            return null
          }
          return null
        },
        async all() {
          if (/SELECT id FROM videos WHERE group_id/.test(sql)) {
            return [{ id: state.mainVideo.id }]
          }
          return []
        },
        async run() { return { changes: 1 } },
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
  state.runnerCalls = []
  state.brollChainStatus = null
  state.brollChainHeartbeatAt = null
})

describe('runFullAutoBrollChain duplicate-fire guard', () => {
  it('proceeds when chain status is null (fresh start)', async () => {
    state.brollChainStatus = null
    state.brollChainHeartbeatAt = null
    await runFullAutoBrollChain(7)
    expect(state.runnerCalls[0]).toBe('runAllReferences')
  })

  it('bails when chain is already running and heartbeat is fresh (no resume opt)', async () => {
    state.brollChainStatus = 'running'
    state.brollChainHeartbeatAt = new Date(Date.now() - 30 * 1000) // 30s ago
    await runFullAutoBrollChain(7)
    expect(state.runnerCalls).toEqual([])
  })

  it('proceeds when chain is running but heartbeat is stale (older than TTL)', async () => {
    state.brollChainStatus = 'running'
    state.brollChainHeartbeatAt = new Date(Date.now() - 10 * 60 * 1000) // 10 min ago
    await runFullAutoBrollChain(7)
    expect(state.runnerCalls[0]).toBe('runAllReferences')
  })

  it('proceeds when chain is running and heartbeat is null (legacy row, no telemetry)', async () => {
    state.brollChainStatus = 'running'
    state.brollChainHeartbeatAt = null
    await runFullAutoBrollChain(7)
    expect(state.runnerCalls[0]).toBe('runAllReferences')
  })

  it('bypasses guard when resumeFromSubstage is set (boot resume path)', async () => {
    state.brollChainStatus = 'running'
    state.brollChainHeartbeatAt = new Date(Date.now() - 30 * 1000)
    await runFullAutoBrollChain(7, { resumeFromSubstage: 'refs' })
    expect(state.runnerCalls[0]).toBe('runAllReferences')
  })

  it('proceeds when prior chain failed (recovery path)', async () => {
    state.brollChainStatus = 'failed'
    state.brollChainHeartbeatAt = new Date(Date.now() - 30 * 1000)
    await runFullAutoBrollChain(7)
    expect(state.runnerCalls[0]).toBe('runAllReferences')
  })

  it('proceeds when prior chain done (re-trigger after completion)', async () => {
    state.brollChainStatus = 'done'
    state.brollChainHeartbeatAt = new Date(Date.now() - 30 * 1000)
    await runFullAutoBrollChain(7)
    expect(state.runnerCalls[0]).toBe('runAllReferences')
  })
})
