// Tests the server-side automation orchestrator: confirmClassificationGroup
// (extracted from POST /confirm-classification) and chainAfterClassify (the
// hook that fires after classification finishes for Full Auto projects).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  exampleSets: [],          // rows returned for SELECT id FROM broll_example_sets WHERE group_id = ?
  exampleSources: [],       // rows returned for SELECT * FROM broll_example_sources WHERE example_set_id = ?
  inserts: [],              // every INSERT INTO video_groups call (sub-group creation)
  exampleSetInserts: [],    // every INSERT INTO broll_example_sets call (per sub-group)
  exampleSourceInserts: [], // every INSERT INTO broll_example_sources call (copies)
  videosUpdates: [],        // every UPDATE videos SET group_id call
  parentUpdates: [],        // every UPDATE video_groups SET assembly_status call
  analyzeMulticamCalls: [], // analyzeMulticam(subId, opts) invocations
  groupRow: null,           // row returned for SELECT ... FROM video_groups WHERE id = ? (chainAfterClassify)
  subGroup: null,           // row for SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id = ? (runFullAutoBrollChain)
  mainVideo: null,          // row for the SELECT v.id FROM videos v JOIN transcripts ... lookup
  brollChainUpdates: [],    // every UPDATE video_groups SET broll_chain_status call
  parentCheckRow: null,     // row for SELECT parent_group_id FROM video_groups WHERE id = ? (guards)
  reclassifyTargetGroups: [], // rows for SELECT id, name FROM video_groups WHERE parent_group_id = ? (reclassifyGroup snapshot)
  reclassifySubGroupVideoIds: {}, // sgId → [{id}] for SELECT id FROM videos WHERE group_id = ? AND video_type = 'raw'
  reclassifyVideoRows: [],  // rows for SELECT v.id, v.title, ... FROM videos v ... WHERE v.id IN (...) for runClassification
  classificationUpdates: [], // every UPDATE video_groups SET classification_json call (parent classification write)
  subGroupDeletes: [],      // every DELETE FROM video_groups WHERE id = ? call (smart-diff different path)
}

let nextSubGroupId = 1000
let nextExampleSetId = 5000
let nextExampleSourceId = 9000

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT id, user_id, path_id, auto_rough_cut, classification_json, assembly_status FROM video_groups WHERE id/.test(sql)) {
            return state.groupRow
          }
          if (/SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id/.test(sql)) {
            return state.subGroup
          }
          if (/SELECT parent_group_id FROM video_groups WHERE id/.test(sql)) {
            return state.parentCheckRow
          }
          if (/SELECT v\.id FROM videos v/.test(sql)) {
            return state.mainVideo
          }
          throw new Error(`unexpected get: ${sql}`)
        },
        async all(...args) {
          if (/SELECT id FROM broll_example_sets WHERE group_id/.test(sql)) {
            return state.exampleSets
          }
          if (/FROM broll_example_sources WHERE example_set_id/.test(sql)) {
            return state.exampleSources
          }
          if (/SELECT id, name FROM video_groups WHERE parent_group_id/.test(sql)) {
            return state.reclassifyTargetGroups
          }
          if (/SELECT id FROM videos WHERE group_id .* AND video_type = 'raw'/.test(sql)) {
            const groupId = args[0]
            return state.reclassifySubGroupVideoIds[groupId] || []
          }
          if (/SELECT v\.id, v\.title/.test(sql)) {
            return state.reclassifyVideoRows
          }
          throw new Error(`unexpected all: ${sql}`)
        },
        async run(...args) {
          if (/INSERT INTO video_groups/.test(sql)) {
            const id = ++nextSubGroupId
            state.inserts.push({ id, args })
            return { lastInsertRowid: id }
          }
          if (/INSERT INTO broll_example_sets/.test(sql)) {
            const id = ++nextExampleSetId
            state.exampleSetInserts.push({ id, args })
            return { lastInsertRowid: id }
          }
          if (/INSERT INTO broll_example_sources/.test(sql)) {
            const id = ++nextExampleSourceId
            state.exampleSourceInserts.push({ id, args })
            return { lastInsertRowid: id }
          }
          if (/UPDATE videos SET group_id/.test(sql)) {
            state.videosUpdates.push(args)
            return { changes: 1 }
          }
          if (/UPDATE video_groups SET assembly_status/.test(sql)) {
            state.parentUpdates.push(args)
            return { changes: 1 }
          }
          if (/UPDATE video_groups SET broll_chain_status/.test(sql)) {
            state.brollChainUpdates.push({ sql, args })
            return { changes: 1 }
          }
          if (/UPDATE video_groups SET classification_json/.test(sql)) {
            state.classificationUpdates.push({ sql, args })
            return { changes: 1 }
          }
          if (/DELETE FROM video_groups WHERE id/.test(sql)) {
            state.subGroupDeletes.push(args)
            return { changes: 1 }
          }
          throw new Error(`unexpected run: ${sql}`)
        },
      }
    },
  },
}))

vi.mock('../multicam-sync.js', () => ({
  analyzeMulticam: vi.fn((id, opts) => { state.analyzeMulticamCalls.push({ id, opts }) }),
}))

// pathToFlags is imported statically by auto-orchestrator.js; the real module
// pulls in the entire broll route tree (multer, requireAuth, etc.). Mock it so
// the runFullAutoBrollChain tests don't drag the express router into the
// vitest sandbox.
vi.mock('../../routes/broll.js', () => ({
  pathToFlags: (pathId) => {
    switch (pathId) {
      case 'hands-off':     return { stopAfterStrategy: false, stopAfterPlan: false, autoSelectVariants: true }
      case 'strategy-only': return { stopAfterStrategy: true,  stopAfterPlan: false, autoSelectVariants: false }
      case 'guided':        return { stopAfterStrategy: true,  stopAfterPlan: true,  autoSelectVariants: false }
      default:              return { stopAfterStrategy: true,  stopAfterPlan: false, autoSelectVariants: false }
    }
  },
}))

// Default email-notifier mock — individual tests override via vi.doMock to
// capture the template name passed to send().
vi.mock('../email-notifier.js', () => ({ send: vi.fn(async () => {}) }))

import { confirmClassificationGroup, chainAfterClassify, reclassifyGroup, videoIdSetsMatch } from '../auto-orchestrator.js'

beforeEach(() => {
  state.exampleSets = []
  state.exampleSources = []
  state.inserts = []
  state.exampleSetInserts = []
  state.exampleSourceInserts = []
  state.videosUpdates = []
  state.parentUpdates = []
  state.analyzeMulticamCalls = []
  state.groupRow = null
  state.subGroup = null
  state.mainVideo = null
  state.brollChainUpdates = []
  state.parentCheckRow = null
  state.reclassifyTargetGroups = []
  state.reclassifySubGroupVideoIds = {}
  state.reclassifyVideoRows = []
  state.classificationUpdates = []
  state.subGroupDeletes = []
})

describe('confirmClassificationGroup', () => {
  it('inserts one sub-group per groups[] entry, propagating auto_rough_cut + path_id', async () => {
    await confirmClassificationGroup(1, [{ name: 'Cam 1', videoIds: [1] }, { name: 'Cam 2', videoIds: [2] }], {
      propagateAutoRoughCut: true,
      propagatePathId: 'hands-off',
      userId: 'u1',
    })
    expect(state.inserts).toHaveLength(2)
    for (const ins of state.inserts) {
      // args order = (name, 'pending', parentGroupId, userId, auto_rough_cut, path_id)
      expect(ins.args).toContain('hands-off')
      expect(ins.args).toContain(true)
    }
  })

  it('copies broll_example_sources from parent set to new sub-group set', async () => {
    state.exampleSets = [{ id: 42 }]
    state.exampleSources = [
      { kind: 'upload', source_url: null, label: 'r1', status: 'ready', error: null, meta_json: '{"a":1}', is_favorite: true },
      { kind: 'yt_video', source_url: 'https://yt/x', label: 'r2', status: 'pending', error: null, meta_json: '{}', is_favorite: false },
    ]
    await confirmClassificationGroup(1, [{ name: 'A', videoIds: [1] }], {
      propagateAutoRoughCut: false,
      propagatePathId: 'hands-off',
      userId: 'u1',
    })
    // One new example_sets row for the sub-group.
    expect(state.exampleSetInserts).toHaveLength(1)
    // Two source rows copied into the new set.
    expect(state.exampleSourceInserts).toHaveLength(2)
  })

  it('fires analyzeMulticam per sub-group with skipClassification', async () => {
    await confirmClassificationGroup(1, [{ name: 'A', videoIds: [1] }, { name: 'B', videoIds: [2] }], {
      propagateAutoRoughCut: false,
      propagatePathId: null,
      userId: 'u1',
    })
    expect(state.analyzeMulticamCalls).toHaveLength(2)
    for (const c of state.analyzeMulticamCalls) {
      expect(c.opts).toEqual({ skipClassification: true })
    }
  })

  it('updates parent assembly_status to confirmed', async () => {
    await confirmClassificationGroup(1, [{ name: 'A', videoIds: [1] }], {
      propagateAutoRoughCut: false,
      propagatePathId: null,
      userId: 'u1',
    })
    expect(state.parentUpdates).toHaveLength(1)
    expect(state.parentUpdates[0]).toContain('confirmed')
  })

  it('throws when called on a sub-group (parent_group_id is set)', async () => {
    state.parentCheckRow = { parent_group_id: 239 }
    await expect(
      confirmClassificationGroup(240, [{ name: 'A', videoIds: [1] }], {
        propagateAutoRoughCut: false,
        propagatePathId: null,
        userId: 'u1',
      })
    ).rejects.toThrow(/sub-group/i)
    expect(state.inserts).toHaveLength(0)
    expect(state.parentUpdates).toHaveLength(0)
  })
})

describe('chainAfterClassify', () => {
  it('auto-confirms classification for hands-off groups', async () => {
    state.groupRow = {
      id: 7,
      user_id: 'u1',
      path_id: 'hands-off',
      auto_rough_cut: true,
      classification_json: JSON.stringify({ groups: [{ name: 'A', videoIds: [1] }] }),
      assembly_status: 'classified',
    }
    await chainAfterClassify(7)
    expect(state.inserts).toHaveLength(1)
    expect(state.parentUpdates).toHaveLength(1)
  })

  it('skips when path_id is not hands-off', async () => {
    state.groupRow = {
      id: 7,
      user_id: 'u1',
      path_id: null,
      auto_rough_cut: false,
      classification_json: JSON.stringify({ groups: [{ name: 'A', videoIds: [1] }] }),
      assembly_status: 'classified',
    }
    await chainAfterClassify(7)
    expect(state.inserts).toHaveLength(0)
  })

  it('skips when assembly_status is not classified (classifier failed)', async () => {
    state.groupRow = {
      id: 7,
      user_id: 'u1',
      path_id: 'hands-off',
      auto_rough_cut: true,
      classification_json: null,
      assembly_status: null,
    }
    await chainAfterClassify(7)
    expect(state.inserts).toHaveLength(0)
  })
})

describe('reclassifyGroup', () => {
  it('throws when called on a sub-group (parent_group_id is set)', async () => {
    state.parentCheckRow = { parent_group_id: 239 }
    await expect(reclassifyGroup(240)).rejects.toThrow(/sub-group/i)
    expect(state.classificationUpdates).toHaveLength(0)
    expect(state.subGroupDeletes).toHaveLength(0)
    expect(state.videosUpdates).toHaveLength(0)
  })

  it('preserves sub-groups when re-classification produces the same videoId partitioning', async () => {
    // Parent 239 with one sub-group 240 holding video 10.
    state.parentCheckRow = { parent_group_id: null }
    state.reclassifyTargetGroups = [{ id: 240, name: 'MAIN' }]
    state.reclassifySubGroupVideoIds = { 240: [{ id: 10 }] }
    state.reclassifyVideoRows = [{ id: 10, title: 'v', duration_seconds: 30, file_path: '/a', transcript: 'hello' }]
    // Override runClassification to return same partition.
    vi.doMock('../multicam-sync.js', () => ({
      analyzeMulticam: vi.fn(),
      runClassification: vi.fn(async () => ({ groups: [{ name: 'MAIN', videoIds: [10] }], gemini: null })),
    }))
    const { reclassifyGroup: rcg } = await import('../auto-orchestrator.js?same=' + Date.now())
    const result = await rcg(239)

    expect(result.unchanged).toBe(true)
    // No destructive ops.
    expect(state.subGroupDeletes).toHaveLength(0)
    expect(state.videosUpdates).toHaveLength(0)
    // classification_json is written on the parent (idempotent refresh).
    expect(state.classificationUpdates).toHaveLength(1)
    // assembly_status NOT changed (no parent UPDATE assembly_status calls).
    expect(state.parentUpdates).toHaveLength(0)
  })

  it('deletes sub-groups and re-attaches videos when the partitioning differs', async () => {
    // Parent 239 with one sub-group 240 holding videos 10, 11.
    // Re-classification splits them across two new groups.
    state.parentCheckRow = { parent_group_id: null }
    state.reclassifyTargetGroups = [{ id: 240, name: 'MAIN' }]
    state.reclassifySubGroupVideoIds = { 240: [{ id: 10 }, { id: 11 }] }
    state.reclassifyVideoRows = [
      { id: 10, title: 'a', duration_seconds: 30, file_path: '/a', transcript: 't1' },
      { id: 11, title: 'b', duration_seconds: 30, file_path: '/b', transcript: 't2' },
    ]
    vi.doMock('../multicam-sync.js', () => ({
      analyzeMulticam: vi.fn(),
      runClassification: vi.fn(async () => ({
        groups: [{ name: 'A', videoIds: [10] }, { name: 'B', videoIds: [11] }],
        gemini: null,
      })),
    }))
    const { reclassifyGroup: rcg } = await import('../auto-orchestrator.js?diff=' + Date.now())
    const result = await rcg(239)

    expect(result.unchanged).toBe(false)
    // Videos moved back to the parent (single bulk UPDATE).
    expect(state.videosUpdates).toHaveLength(1)
    // The old sub-group is deleted.
    expect(state.subGroupDeletes).toHaveLength(1)
    expect(state.subGroupDeletes[0]).toContain(240)
    // classification_json + assembly_status='classified' written on parent.
    expect(state.classificationUpdates).toHaveLength(1)
    expect(state.parentUpdates).toHaveLength(1)
    expect(state.parentUpdates[0]).toContain('classified')
  })
})

describe('videoIdSetsMatch', () => {
  it('returns true when sub-groups and new groups have identical videoId sets (order-insensitive)', () => {
    const snapshot = [
      { id: 240, name: 'MAIN', videoIds: [10] },
      { id: 241, name: 'PRMO', videoIds: [11, 12] },
    ]
    const newGroups = [
      { name: 'PRMO', videoIds: [12, 11] },
      { name: 'MAIN', videoIds: [10] },
    ]
    expect(videoIdSetsMatch(snapshot, newGroups)).toBe(true)
  })

  it('returns false when group counts differ', () => {
    const snapshot = [{ id: 240, name: 'MAIN', videoIds: [10, 11] }]
    const newGroups = [
      { name: 'A', videoIds: [10] },
      { name: 'B', videoIds: [11] },
    ]
    expect(videoIdSetsMatch(snapshot, newGroups)).toBe(false)
  })

  it('returns false when same total videos but split differently', () => {
    const snapshot = [
      { id: 240, name: 'MAIN', videoIds: [10, 11] },
      { id: 241, name: 'PRMO', videoIds: [12] },
    ]
    const newGroups = [
      { name: 'A', videoIds: [10] },
      { name: 'B', videoIds: [11, 12] },
    ]
    expect(videoIdSetsMatch(snapshot, newGroups)).toBe(false)
  })

  it('returns true for an empty snapshot and empty new groups', () => {
    expect(videoIdSetsMatch([], [])).toBe(true)
  })

  it('matches even when group names differ (we only care about videoId sets)', () => {
    const snapshot = [{ id: 240, name: 'MAIN', videoIds: [10] }]
    const newGroups = [{ name: 'Cam 1', videoIds: [10] }]
    expect(videoIdSetsMatch(snapshot, newGroups)).toBe(true)
  })
})

describe('runFullAutoBrollChain', () => {
  it('runs all stages for hands-off path', async () => {
    state.subGroup = { id: 100, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 }
    state.mainVideo = { id: 387 }
    const calls = []
    vi.doMock('../broll-runner.js', () => ({
      runAllReferences: async () => { calls.push('refs'); return { prepPipelineId: 'p1', analysisPipelineIds: ['a1'] } },
      runStrategies: async () => { calls.push('strategies'); return { strategyPipelineIds: ['s1'] } },
      runPlanForEachVariant: async () => { calls.push('plans'); return { planPipelineIds: ['pl1'] } },
      runBrollSearchFirst10: async () => { calls.push('search') },
      waitForPipelinesComplete: async () => {},
    }))
    vi.doMock('../email-notifier.js', () => ({ send: async () => {} }))
    const { runFullAutoBrollChain } = await import('../auto-orchestrator.js?ch=' + Date.now())
    await runFullAutoBrollChain(100)
    expect(calls).toEqual(['refs', 'strategies', 'plans', 'search'])
  })

  it('pauses after strategies for strategy-only path', async () => {
    state.subGroup = { id: 101, user_id: 'u1', path_id: 'strategy-only', parent_group_id: 1 }
    state.mainVideo = { id: 388 }
    const calls = []
    vi.doMock('../broll-runner.js', () => ({
      runAllReferences: async () => { calls.push('refs'); return { prepPipelineId: 'p', analysisPipelineIds: ['a'] } },
      runStrategies: async () => { calls.push('strategies'); return { strategyPipelineIds: ['s'] } },
      runPlanForEachVariant: async () => { calls.push('plans') },
      runBrollSearchFirst10: async () => { calls.push('search') },
      waitForPipelinesComplete: async () => {},
    }))
    let lastEmail = null
    vi.doMock('../email-notifier.js', () => ({ send: async (t) => { lastEmail = t } }))
    const { runFullAutoBrollChain } = await import('../auto-orchestrator.js?strat-only=' + Date.now())
    await runFullAutoBrollChain(101)
    expect(calls).toEqual(['refs', 'strategies'])
    expect(lastEmail).toBe('paused_at_strategy')
  })

  it('marks failed + emails on error', async () => {
    state.subGroup = { id: 103, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 }
    state.mainVideo = { id: 389 }
    vi.doMock('../broll-runner.js', () => ({
      runAllReferences: async () => { throw new Error('boom') },
    }))
    let lastEmail = null
    vi.doMock('../email-notifier.js', () => ({ send: async (t) => { lastEmail = t } }))
    const { runFullAutoBrollChain } = await import('../auto-orchestrator.js?fail=' + Date.now())
    await runFullAutoBrollChain(103)
    expect(lastEmail).toBe('failed')
  })
})
