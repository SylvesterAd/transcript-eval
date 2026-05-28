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
  searchUserPlacement: vi.fn(),
  abortedBrollPipelines: new Set(),
}))
vi.mock('../slack-notifier.js', () => ({ notify: vi.fn() }))

import { startWorker, stopWorker, _resetForTest, reclaimerSweep as _reclaimerSweep, isTransientGpuFailure } from '../broll-search-worker.js'
import db from '../../db.js'
import { searchSinglePlacement, searchUserPlacement, abortedBrollPipelines } from '../broll.js'
import { notify } from '../slack-notifier.js'

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

describe('broll-search-worker — abort honored', () => {
  const updates = []

  beforeEach(() => {
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    searchSinglePlacement.mockReset()
    abortedBrollPipelines.clear()
    _resetForTest()
    vi.useFakeTimers()
    updates.length = 0
  })

  afterEach(async () => {
    await stopWorker()
    vi.useRealTimers()
  })

  it('marks row stopped without calling searchSinglePlacement when batch aborted', async () => {
    state.queryImpl = async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) {
        return {
          rows: [{
            id: 300,
            plan_pipeline_id: 'plan-1',
            placement_uuid: 'p_abc',
            chapter_index: 0,
            placement_index: 0,
            batch_id: 'aborted-batch',
          }],
        }
      }
      if (sql.includes("SET status='stopped'")) {
        updates.push({ params })
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    abortedBrollPipelines.add('aborted-batch')

    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(searchSinglePlacement).not.toHaveBeenCalled()
    expect(updates.length).toBe(1)
    expect(updates[0].params[0]).toBe(300)
  })
})

describe('broll-search-worker — reclaimer (requeue under max retries)', () => {
  const updates = []

  beforeEach(() => {
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    _resetForTest()
    updates.length = 0
  })

  it('requeues a stuck row, increments retry_count, clears data columns', async () => {
    state.queryImpl = async (sql, params) => {
      if (sql.includes("status='running'") && sql.includes('started_at')) {
        return { rows: [{ id: 500, retry_count: 0 }] }
      }
      if (sql.includes("status='waiting'") && sql.includes('retry_count=retry_count+1')) {
        updates.push({ sql, params })
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    await _reclaimerSweep()

    expect(updates.length).toBe(1)
    expect(updates[0].params).toEqual([500])
    expect(updates[0].sql).toContain('api_log_id=NULL')
    expect(updates[0].sql).toContain('error=NULL')
    expect(updates[0].sql).toContain('results_json=NULL')
  })
})

describe('broll-search-worker — reclaimer (max retries)', () => {
  const updates = []

  beforeEach(() => {
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    _resetForTest()
    updates.length = 0
  })

  it('fails permanently when retry_count >= 3', async () => {
    state.queryImpl = async (sql, params) => {
      if (sql.includes("status='running'") && sql.includes('started_at')) {
        return { rows: [{ id: 600, retry_count: 3 }] }
      }
      if (sql.includes("status='failed'") && sql.includes('reclaimed: stuck after')) {
        updates.push({ sql, params })
        return { rowCount: 1 }
      }
      if (sql.includes("status='waiting'") && sql.includes('retry_count=retry_count+1')) {
        throw new Error('should not requeue at max retries')
      }
      return { rows: [], rowCount: 0 }
    }

    await _reclaimerSweep()

    expect(updates.length).toBe(1)
    expect(updates[0].params).toEqual([600])
  })
})

describe('broll-search-worker — alerts only on genuine, recovery-exhausted failure', () => {
  const rowQueryImpl = (id) => async (sql) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
    if (sql.includes('SELECT id, plan_pipeline_id')) {
      return { rows: [{ id, plan_pipeline_id: 'plan-1', placement_uuid: 'p_x', chapter_index: 0, placement_index: 0, batch_id: 'b' }] }
    }
    if (sql.includes("SET status='running'")) return { rowCount: 1 }
    if (sql.includes('SET status=$1') || sql.includes("SET status='failed'")) return { rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    searchSinglePlacement.mockReset()
    notify.mockReset()
    _resetForTest()
  })
  afterEach(async () => {
    await stopWorker()
    vi.useRealTimers()
  })

  it('alerts when a search fails for a non-transient reason (resolved gpuJobStatus=failed)', async () => {
    state.queryImpl = rowQueryImpl(900)
    searchSinglePlacement.mockResolvedValue({
      results: [], gpuJobStatus: 'failed', error: 'No candidates found for brief', duration: 1000, apiLogId: null,
    })
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ source: expect.stringContaining('broll-search') })
  })

  it('does NOT alert on a transient failure (row left running for the reclaimer)', async () => {
    state.queryImpl = rowQueryImpl(901)
    searchSinglePlacement.mockResolvedValue({
      results: [], gpuJobStatus: 'failed', error: 'Stale job — process likely restarted', duration: 1000, apiLogId: null,
    })
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(notify).not.toHaveBeenCalled()
  })

  it('alerts when the proxy call throws a non-transient error', async () => {
    state.queryImpl = rowQueryImpl(902)
    searchSinglePlacement.mockRejectedValue(new Error('GPU exploded'))
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ source: expect.stringContaining('broll-search') })
  })
})

describe('broll-search-worker — reclaimer alerts when retries exhausted', () => {
  beforeEach(() => {
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
    notify.mockReset()
    _resetForTest()
  })

  it('alerts once when a stuck row is failed permanently after max retries', async () => {
    state.queryImpl = async (sql) => {
      if (sql.includes("status='running'") && sql.includes('started_at')) return { rows: [{ id: 903, retry_count: 3 }] }
      if (sql.includes("status='failed'") && sql.includes('reclaimed: stuck after')) return { rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }
    await _reclaimerSweep()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ source: expect.stringContaining('broll-search') })
  })
})

describe('isTransientGpuFailure', () => {
  it('classifies proxy-restart and transport errors as transient', () => {
    for (const m of [
      'Job cd0a707b: Stale job — process likely restarted',
      'process likely restarted',
      'socket hang up',
      'read ECONNRESET',
      'connect ECONNREFUSED 1.2.3.4:443',
      'fetch failed',
      'Bad Gateway',
      'Request failed with status code 503',
    ]) {
      expect(isTransientGpuFailure(m)).toBe(true)
    }
  })

  it('does not classify genuine pipeline failures as transient', () => {
    for (const m of ['GPU exploded', 'No candidates found for brief', 'SigLIP failed to load within 120s', null, '', undefined]) {
      expect(isTransientGpuFailure(m)).toBe(false)
    }
  })
})

describe('broll-search-worker — transient GPU failure left for reclaimer', () => {
  // Captures any terminal status write (parameterized success/timeout/failed, or
  // the hard-coded catch-path failed). Transient failures must produce NONE of
  // these — the row stays 'running' for reclaimerSweep to re-enqueue.
  const updates = []

  function rowQueryImpl(id) {
    return async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) {
        return { rows: [{ id, plan_pipeline_id: 'plan-1', placement_uuid: 'p_abc', chapter_index: 0, placement_index: 1, batch_id: 'b-1', retry_count: 0 }] }
      }
      if (sql.includes("SET status='running'")) return { rowCount: 1 }
      if (sql.includes('SET status=$1') || sql.includes("SET status='failed'")) { updates.push({ sql, params }); return { rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
  }

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

  it('leaves the row untouched when the GPU job failed with "process likely restarted"', async () => {
    state.queryImpl = rowQueryImpl(800)
    searchSinglePlacement.mockResolvedValue({
      results: [], gpuJobStatus: 'failed',
      error: 'Job cd0a707b: Stale job — process likely restarted', duration: 1000, apiLogId: null,
    })
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(updates.length).toBe(0)
  })

  it('hard-fails when the GPU job failed for a non-transient reason', async () => {
    state.queryImpl = rowQueryImpl(801)
    searchSinglePlacement.mockResolvedValue({
      results: [], gpuJobStatus: 'failed', error: 'No candidates found for brief', duration: 1000, apiLogId: null,
    })
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(updates.length).toBe(1)
    expect(updates[0].params[0]).toBe('failed')
  })

  it('leaves the row untouched when the proxy call throws a transient transport error', async () => {
    state.queryImpl = rowQueryImpl(802)
    searchSinglePlacement.mockRejectedValue(new Error('socket hang up'))
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(updates.length).toBe(0)
  })

  it('still hard-fails a non-transient thrown error (regression: GPU exploded)', async () => {
    state.queryImpl = rowQueryImpl(803)
    searchSinglePlacement.mockRejectedValue(new Error('GPU exploded'))
    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(updates.length).toBe(1)
    expect(updates[0].sql).toContain("SET status='failed'")
  })
})

describe('broll-search-worker — user-placement dispatch', () => {
  beforeEach(() => {
    searchSinglePlacement.mockReset()
    searchUserPlacement.mockReset()
    _resetForTest()
    vi.useFakeTimers()
    mockPool.query.mockReset()
    mockPool.query.mockImplementation((...args) => state.queryImpl(...args))
  })

  afterEach(async () => {
    await stopWorker()
    vi.useRealTimers()
  })

  it('dispatches user-placement rows to searchUserPlacement', async () => {
    state.queryImpl = async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] }
      if (sql.includes('SELECT id, plan_pipeline_id')) {
        return {
          rows: [{
            id: 700,
            plan_pipeline_id: 'plan-1',
            placement_uuid: 'up-abc',
            chapter_index: -1,
            placement_index: -1,
            batch_id: 'single-up-1',
          }],
        }
      }
      if (sql.includes("SET status='running'")) return { rowCount: 1 }
      if (sql.includes('SET status=$1')) return { rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }

    searchUserPlacement.mockResolvedValue({ results: [], duration: 100, apiLogId: null })

    await startWorker()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(searchUserPlacement).toHaveBeenCalledWith('plan-1', 'abc')
    expect(searchSinglePlacement).not.toHaveBeenCalled()
  })
})
