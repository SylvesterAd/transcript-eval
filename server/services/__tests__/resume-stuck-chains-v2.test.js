// Tests the rewritten second loop of resumeStuckFullAutoChains. The first
// loop (status IS NULL → fire runFullAutoBrollChain) is unchanged. The second
// loop now uses smart per-pipeline resume + advance-from-substage instead of
// brute-forcing the whole chain (the previous behavior caused 50+ spurious
// analysis runs on every server restart). See Task 6 in
// docs/superpowers/plans/2026-04-29-broll-auto-resume.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const state = {
  stuckRows: [],         // first loop
  interruptedRows: [],   // second loop
  // Track interactions
  resumePipelineCalls: [],
  resumeChainCalls: [],
  runFullAutoBrollChainCalls: [],
  // findInterruptedPipelinesForGroup return per groupId
  interruptedPipelinesByGroup: {},
  // group substage per groupId
  substageByGroup: {},
  // Set true when the interrupted-chain query has a heartbeat filter
  // (broll_chain_heartbeat_at). Used to assert the duplicate-fire fix
  // hasn't been regressed.
  interruptedQueryFiltersHeartbeat: false,
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async all() {
          if (/SELECT id FROM video_groups[\s\S]*broll_chain_status IS NULL/.test(sql)) return state.stuckRows
          if (/broll_chain_status = 'running'/.test(sql)) {
            // Track that the interrupted query carries the heartbeat filter
            // so the duplicate-fire fix can't be silently regressed.
            if (/broll_chain_heartbeat_at/.test(sql)) state.interruptedQueryFiltersHeartbeat = true
            return state.interruptedRows
          }
          return []
        },
        async get(...args) {
          if (/SELECT broll_chain_substage FROM video_groups WHERE id/.test(sql)) {
            const id = args[0]
            return { broll_chain_substage: state.substageByGroup[id] || null }
          }
          return null
        },
        async run() { return {} },
      }
    },
  },
}))

// resumePipeline returns the Task 3.5 contract: { pipelineId, completedStages,
// executePromise } — Task 6 must await executePromise to know when each
// pipeline actually finishes before advancing the chain.
vi.mock('../broll.js', () => ({
  resumePipeline: vi.fn(async (pid) => {
    state.resumePipelineCalls.push(pid)
    return { pipelineId: pid, completedStages: 0, executePromise: Promise.resolve() }
  }),
}))

const orchestratorModule = await import('../auto-orchestrator.js')
const { resumeStuckFullAutoChains, __orchestratorDeps } = orchestratorModule

// Snapshot the real helpers so we can restore between tests. We swap them
// for stubs by mutating the indirection holder (the pattern mirrors
// __pipelineRunner in broll.js — ESM named-export live bindings make
// vi.spyOn unreliable, so we route through a mutable holder instead).
// resumePipeline lives in broll.js and is intercepted via vi.mock above.
const realFindInterruptedPipelinesForGroup = __orchestratorDeps.findInterruptedPipelinesForGroup
const realResumeChain = __orchestratorDeps.resumeChain
const realRunFullAutoBrollChain = __orchestratorDeps.runFullAutoBrollChain

beforeEach(async () => {
  state.stuckRows = []
  state.interruptedRows = []
  state.resumePipelineCalls = []
  state.resumeChainCalls = []
  state.runFullAutoBrollChainCalls = []
  state.interruptedPipelinesByGroup = {}
  state.substageByGroup = {}
  state.interruptedQueryFiltersHeartbeat = false

  // Reset the broll.js mock between tests so mockImplementationOnce resets too.
  const { resumePipeline } = await import('../broll.js')
  resumePipeline.mockReset()
  resumePipeline.mockImplementation(async (pid) => {
    state.resumePipelineCalls.push(pid)
    return { pipelineId: pid, completedStages: 0, executePromise: Promise.resolve() }
  })

  // Reinstall stubs on the holder (each beforeEach starts clean).
  __orchestratorDeps.findInterruptedPipelinesForGroup = vi.fn(async (gid) => state.interruptedPipelinesByGroup[gid] || [])
  __orchestratorDeps.resumeChain = vi.fn(async (gid, sub) => { state.resumeChainCalls.push({ gid, sub }) })
  __orchestratorDeps.runFullAutoBrollChain = vi.fn(async (gid, opts) => { state.runFullAutoBrollChainCalls.push({ gid, opts }) })

  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  __orchestratorDeps.findInterruptedPipelinesForGroup = realFindInterruptedPipelinesForGroup
  __orchestratorDeps.resumeChain = realResumeChain
  __orchestratorDeps.runFullAutoBrollChain = realRunFullAutoBrollChain
})

describe('resumeStuckFullAutoChains (rewritten second loop)', () => {
  it('first loop: still fires runFullAutoBrollChain for chains where status IS NULL', async () => {
    state.stuckRows = [{ id: 100 }]
    await resumeStuckFullAutoChains()
    // First-loop behavior: setTimeout(() => runFullAutoBrollChain(sg.id), 3000) — no opts
    await vi.advanceTimersByTimeAsync(3000)
    const call = state.runFullAutoBrollChainCalls.find(c => c.gid === 100)
    expect(call).toBeTruthy()
    expect(call.opts).toBeUndefined()
  })

  it('second loop: substage=plan → calls resumePipeline for interrupted pipelines, then resumeChain(plan)', async () => {
    state.interruptedRows = [{ id: 200 }]
    state.substageByGroup[200] = 'plan'
    state.interruptedPipelinesByGroup[200] = ['p1', 'p2']
    await resumeStuckFullAutoChains()
    expect(state.resumePipelineCalls).toEqual(['p1', 'p2'])
    // Step 2 (resumeChain) is delayed via setTimeout(3000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.resumeChainCalls).toEqual([{ gid: 200, sub: 'plan' }])
    expect(state.runFullAutoBrollChainCalls.find(c => c.gid === 200)).toBeFalsy()
  })

  it('second loop: substage=search → calls resumeChain(search)', async () => {
    state.interruptedRows = [{ id: 300 }]
    state.substageByGroup[300] = 'search'
    state.interruptedPipelinesByGroup[300] = []
    await resumeStuckFullAutoChains()
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.resumeChainCalls).toEqual([{ gid: 300, sub: 'search' }])
  })

  it('second loop: substage=refs → resumes any interrupted pipelines (incl. ref-video analysis), then runFullAutoBrollChain with resumeFromSubstage=refs', async () => {
    state.interruptedRows = [{ id: 400 }]
    state.substageByGroup[400] = 'refs'
    state.interruptedPipelinesByGroup[400] = ['analysis-388']
    await resumeStuckFullAutoChains()
    expect(state.resumePipelineCalls).toEqual(['analysis-388'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.runFullAutoBrollChainCalls).toEqual([{ gid: 400, opts: { resumeFromSubstage: 'refs' } }])
  })

  it('second loop: substage=strategy → no interrupted pipelines, runFullAutoBrollChain with resumeFromSubstage=strategy', async () => {
    state.interruptedRows = [{ id: 500 }]
    state.substageByGroup[500] = 'strategy'
    state.interruptedPipelinesByGroup[500] = []
    await resumeStuckFullAutoChains()
    expect(state.resumePipelineCalls).toEqual([])
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.runFullAutoBrollChainCalls).toEqual([{ gid: 500, opts: { resumeFromSubstage: 'strategy' } }])
  })

  it('second loop: failure on one group does not block the next', async () => {
    state.interruptedRows = [{ id: 600 }, { id: 700 }]
    state.substageByGroup[600] = 'plan'
    state.substageByGroup[700] = 'plan'
    state.interruptedPipelinesByGroup[600] = ['fail-pid']
    state.interruptedPipelinesByGroup[700] = ['ok-pid']

    // Make the first resume throw; second call returns the standard shape.
    const { resumePipeline } = await import('../broll.js')
    resumePipeline.mockReset()
    resumePipeline.mockImplementationOnce(async () => { throw new Error('boom') })
    resumePipeline.mockImplementation(async (pid) => {
      state.resumePipelineCalls.push(pid)
      return { pipelineId: pid, completedStages: 0, executePromise: Promise.resolve() }
    })

    await resumeStuckFullAutoChains()

    // Group 700 still processed despite group 600's resume throwing.
    expect(state.resumePipelineCalls).toContain('ok-pid')
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.resumeChainCalls.find(c => c.gid === 700)).toBeTruthy()
  })

  it('interrupted query filters by heartbeat staleness so live drivers are not double-fired', async () => {
    // Live chains with a recent heartbeat must be left alone — the only way
    // to know "left alone" without DB-side filtering is to assert the SQL
    // carries broll_chain_heartbeat_at. Without this filter, the boot path
    // and the still-alive driver both call runAllReferences and CF Stream
    // sees parallel main_analysis pipelines for the same reference.
    state.interruptedRows = []
    await resumeStuckFullAutoChains()
    expect(state.interruptedQueryFiltersHeartbeat).toBe(true)
  })
})
