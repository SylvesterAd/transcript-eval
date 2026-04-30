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
