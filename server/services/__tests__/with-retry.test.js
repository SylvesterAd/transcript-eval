import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock db before importing broll (which transitively imports llm-runner)
vi.mock('../../db.js', () => ({
  default: {
    prepare() {
      return {
        async run() { return { changes: 0 } },
        async get() { return null },
        async all() { return [] },
      }
    },
  },
}))

import { withRetry, abortedBrollPipelines } from '../broll.js'

describe('withRetry', () => {
  beforeEach(() => {
    abortedBrollPipelines.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the value when the function succeeds on first try', async () => {
    const fn = vi.fn(async () => 'ok')
    const promise = withRetry(fn, { tries: 3, backoff: [5_000, 30_000], pipelineId: 'p1', label: 'test' })
    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on failure and returns the value on later success', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('flaky')
      return 'ok'
    })
    const promise = withRetry(fn, { tries: 3, backoff: [5_000, 30_000], pipelineId: 'p1', label: 'test' })
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws the last error after exhausting tries', async () => {
    const fn = vi.fn(async () => { throw new Error('always fails') })
    const promise = withRetry(fn, { tries: 3, backoff: [5_000, 30_000], pipelineId: 'p1', label: 'test' })
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(promise).rejects.toThrow('always fails')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws Aborted immediately if the pipeline was aborted before an attempt', async () => {
    abortedBrollPipelines.add('p1')
    const fn = vi.fn(async () => 'should not run')
    const promise = withRetry(fn, { tries: 3, backoff: [5_000, 30_000], pipelineId: 'p1', label: 'test' })
    await expect(promise).rejects.toThrow('Aborted')
    expect(fn).not.toHaveBeenCalled()
  })

  it('throws Aborted between attempts even if more retries remain', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls === 1) {
        abortedBrollPipelines.add('p1')
        throw new Error('first fail')
      }
      return 'should not reach'
    })
    const promise = withRetry(fn, { tries: 3, backoff: [5_000, 30_000], pipelineId: 'p1', label: 'test' })
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(promise).rejects.toThrow('Aborted')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('uses backoff[attempt-1] for sleep between attempts', async () => {
    const fn = vi.fn(async () => { throw new Error('fail') })
    const promise = withRetry(fn, { tries: 3, backoff: [1_000, 2_000], pipelineId: 'p1', label: 'test' })
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(3)
    await expect(promise).rejects.toThrow('fail')
  })
})
