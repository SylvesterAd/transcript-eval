import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock db before importing the worker.
// Use a plain object mutated via state so vi.mock hoisting can't cause
// "Cannot access before initialization" for const variables.
const state = {
  queryImpl: null,
}

vi.mock('../../db.js', () => ({
  default: {
    pool: {
      query: vi.fn((...args) => state.queryImpl(...args)),
    },
    prepare: vi.fn(),
  },
}))
vi.mock('../broll.js', () => ({
  searchSinglePlacement: vi.fn(),
  abortedBrollPipelines: new Set(),
}))

import { startWorker, stopWorker, _resetForTest } from '../broll-search-worker.js'
import db from '../../db.js'
import { searchSinglePlacement } from '../broll.js'

const mockPool = db.pool

describe('broll-search-worker — lock acquisition', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    _resetForTest()
  })
  afterEach(async () => {
    await stopWorker()
  })

  it('acquires the advisory lock and starts draining', async () => {
    state.queryImpl = async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    }

    await startWorker()

    // Lock query should have been called
    const lockCalls = mockPool.query.mock.calls.filter(c => c[0].includes('pg_try_advisory_lock'))
    expect(lockCalls.length).toBe(1)
  })

  it('stays idle when another instance holds the lock', async () => {
    state.queryImpl = async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: false }] }
      return { rows: [], rowCount: 0 }
    }

    await startWorker()

    // Should not have polled the queue
    const pollCalls = mockPool.query.mock.calls.filter(c => c[0].includes('SELECT id, plan_pipeline_id'))
    expect(pollCalls.length).toBe(0)
  })
})

describe('broll-search-worker — empty queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    _resetForTest()
    state.queryImpl = async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    }
  })
  afterEach(async () => {
    await stopWorker()
    vi.useRealTimers()
  })

  it('polls the queue and reschedules after 1s when empty', async () => {
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)

    const pollsBefore = mockPool.query.mock.calls.filter(c => c[0].includes('SELECT id, plan_pipeline_id')).length
    expect(pollsBefore).toBeGreaterThanOrEqual(1)

    await vi.advanceTimersByTimeAsync(1100)

    const pollsAfter = mockPool.query.mock.calls.filter(c => c[0].includes('SELECT id, plan_pipeline_id')).length
    expect(pollsAfter).toBeGreaterThan(pollsBefore)
  })
})

describe('broll-search-worker — success path', () => {
  const updates = []

  beforeEach(() => {
    vi.useFakeTimers()
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    searchSinglePlacement.mockReset()
    _resetForTest()

    state.queryImpl = async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) {
        return {
          rows: [{
            id: 100,
            plan_pipeline_id: 'plan-1',
            placement_uuid: 'p_abc',
            chapter_index: 0,
            placement_index: 1,
            batch_id: 'b-1',
          }],
        }
      }
      if (sql.includes("SET status='running'")) return { rowCount: 1 }
      if (sql.includes('SET status=$1')) {
        updates.push(params)
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    searchSinglePlacement.mockResolvedValue({
      results: [{ id: 'r1' }, { id: 'r2' }],
      duration: 5000,
      apiLogId: 999,
      gpuJobStatus: null,
      error: null,
    })

    updates.length = 0
  })

  afterEach(async () => {
    await stopWorker()
    vi.useRealTimers()
  })

  it('processes a waiting row and writes the success UPDATE', async () => {
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    // Yield multiple times to let async work inside drainLoop settle
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(searchSinglePlacement).toHaveBeenCalledWith('plan-1', {
      placementUuid: 'p_abc',
      chapterIndex: 0,
      placementIndex: 1,
    })

    expect(updates.length).toBe(1)
    expect(updates[0]).toEqual([
      'complete',
      JSON.stringify([{ id: 'r1' }, { id: 'r2' }]),
      2,
      5000,
      999,
      null,
      100,
    ])
  })
})

describe('broll-search-worker — catch path (Bug 1 regression)', () => {
  const updates = []

  beforeEach(() => {
    vi.useFakeTimers()
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    searchSinglePlacement.mockReset()
    _resetForTest()
    updates.length = 0
  })

  afterEach(async () => {
    await stopWorker()
    vi.useRealTimers()
  })

  it('persists err.apiLogId on the failed row', async () => {
    state.queryImpl = async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) {
        return {
          rows: [{
            id: 200,
            plan_pipeline_id: 'plan-1',
            placement_uuid: 'p_xyz',
            chapter_index: 1,
            placement_index: 0,
            batch_id: 'b-2',
          }],
        }
      }
      if (sql.includes("SET status='running'")) return { rowCount: 1 }
      if (sql.includes("SET status='failed'")) {
        updates.push(params)
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    const err = new Error('GPU exploded')
    err.apiLogId = 4242
    searchSinglePlacement.mockRejectedValue(err)

    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(updates.length).toBe(1)
    expect(updates[0]).toEqual(['GPU exploded', 4242, 200])
  })

  it('uses null api_log_id when err.apiLogId is missing', async () => {
    state.queryImpl = async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) {
        return {
          rows: [{
            id: 201,
            plan_pipeline_id: 'plan-1',
            placement_uuid: 'p_xyz',
            chapter_index: 1,
            placement_index: 0,
            batch_id: 'b-2',
          }],
        }
      }
      if (sql.includes("SET status='running'")) return { rowCount: 1 }
      if (sql.includes("SET status='failed'")) {
        updates.push(params)
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    searchSinglePlacement.mockRejectedValue(new Error('no apiLogId on me'))

    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(updates.length).toBe(1)
    expect(updates[0]).toEqual(['no apiLogId on me', null, 201])
  })
})
