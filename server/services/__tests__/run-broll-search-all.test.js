// Tests for runBrollSearchAll — the pipelined "search every position" loop that
// replaces the fixed 3-batch search phase. It repeatedly calls executeSearchBatch
// (keywords + enqueue, NO GPU wait) until nothing is pending, reusing ONE umbrella
// search-batch id so every enqueued row shares a batch_id. The single GPU worker
// drains the growing queue in the background.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// broll-runner.js does `import db from '../db.js'` at module load; stub it so the
// import doesn't try to open a real pool. runBrollSearchAll itself never touches db.
vi.mock('../../db.js', () => ({
  default: {
    prepare: () => ({ get: async () => null, all: async () => [], run: async () => ({}) }),
    pool: { query: async () => ({ rows: [] }) },
  },
}))

vi.mock('../broll.js', () => ({
  executeSearchBatch: vi.fn(),
  brollPipelineProgress: new Map(),
  pipelineAbortControllers: new Map(),
  abortedBrollPipelines: new Set(),
}))

const { runBrollSearchAll } = await import('../broll-runner.js')

beforeEach(async () => {
  const broll = await import('../broll.js')
  broll.executeSearchBatch.mockReset()
  broll.brollPipelineProgress.clear()
  broll.pipelineAbortControllers.clear()
  broll.abortedBrollPipelines.clear()
})

describe('runBrollSearchAll', () => {
  it('keeps enqueuing batches until executeSearchBatch reports 0 enqueued', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch
      .mockResolvedValueOnce({ enqueued: 10 })
      .mockResolvedValueOnce({ enqueued: 10 })
      .mockResolvedValueOnce({ enqueued: 4 })
      .mockResolvedValueOnce({ enqueued: 0 })
    const r = await runBrollSearchAll({ planPipelineIds: ['p1', 'p2'] })
    expect(broll.executeSearchBatch).toHaveBeenCalledTimes(4)
    expect(r.totalEnqueued).toBe(24)
  })

  it('passes ONE shared search-batch id (and batchSize 10) to every iteration', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch
      .mockResolvedValueOnce({ enqueued: 10 })
      .mockResolvedValueOnce({ enqueued: 0 })
    const r = await runBrollSearchAll({ planPipelineIds: ['p1'] })
    const idsUsed = broll.executeSearchBatch.mock.calls.map(c => c[2])
    expect(idsUsed[0]).toMatch(/^search-batch-\d+$/)
    expect(new Set(idsUsed).size).toBe(1) // same umbrella id every call
    expect(r.searchPipelineId).toBe(idsUsed[0])
    expect(broll.executeSearchBatch.mock.calls[0][1]).toBe(10)
  })

  it('returns after a single call when nothing is pending', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockResolvedValueOnce({ enqueued: 0 })
    const r = await runBrollSearchAll({ planPipelineIds: ['p1'] })
    expect(broll.executeSearchBatch).toHaveBeenCalledTimes(1)
    expect(r.totalEnqueued).toBe(0)
  })

  it('stops enqueuing when isCancelled returns true', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockResolvedValue({ enqueued: 10 }) // would loop forever
    let checks = 0
    const isCancelled = () => { checks++; return checks > 1 } // false on 1st check, true after
    await runBrollSearchAll({ planPipelineIds: ['p1'], isCancelled })
    expect(broll.executeSearchBatch).toHaveBeenCalledTimes(1)
  })

  it('stops enqueuing when the pipeline is aborted via stop-all', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockImplementation(async (ids, size, id) => {
      broll.abortedBrollPipelines.add(id) // simulate user clicking Stop during the batch
      return { enqueued: 10 }
    })
    await runBrollSearchAll({ planPipelineIds: ['p1'] })
    expect(broll.executeSearchBatch).toHaveBeenCalledTimes(1)
  })

  it('treats an Aborted rejection from executeSearchBatch as a clean stop (no throw)', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockImplementation(async (ids, size, id) => {
      broll.abortedBrollPipelines.add(id)
      throw new Error('Aborted')
    })
    await expect(runBrollSearchAll({ planPipelineIds: ['p1'] })).resolves.toBeDefined()
  })

  it('propagates a non-abort error (e.g. keyword generation failure)', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockRejectedValueOnce(
      new Error('Keyword generation failed for 1/1 variants'),
    )
    await expect(runBrollSearchAll({ planPipelineIds: ['p1'] })).rejects.toThrow(
      /Keyword generation failed/,
    )
  })

  it('throws when planPipelineIds is missing or empty', async () => {
    await expect(runBrollSearchAll({ planPipelineIds: [] })).rejects.toThrow(/planPipelineIds/)
    await expect(runBrollSearchAll({})).rejects.toThrow(/planPipelineIds/)
  })

  it('stops after maxIterations even if batches never drain (safety cap)', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockResolvedValue({ enqueued: 10 }) // never reaches 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runBrollSearchAll({ planPipelineIds: ['p1'], maxIterations: 5 })
    expect(broll.executeSearchBatch).toHaveBeenCalledTimes(5)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('uses a provided searchPipelineId so the caller can return it up-front', async () => {
    const broll = await import('../broll.js')
    broll.executeSearchBatch.mockResolvedValueOnce({ enqueued: 0 })
    const r = await runBrollSearchAll({
      planPipelineIds: ['p1'], searchPipelineId: 'search-batch-fixed-123',
    })
    expect(r.searchPipelineId).toBe('search-batch-fixed-123')
    expect(broll.executeSearchBatch.mock.calls[0][2]).toBe('search-batch-fixed-123')
  })

  it("keeps umbrella progress 'running' between iterations, terminal stays 'enqueued'", async () => {
    // executeSearchBatch leaves the umbrella entry 'enqueued' at the end of each
    // call. Without a re-assert, a getBRollEditorData poll landing between
    // iterations sees 'enqueued' (not 'running') and the editor flaps back to the
    // idle "Search all" button. The loop must hold 'running' while more is pending,
    // but leave the LAST iteration 'enqueued' so callers that don't delete the
    // entry (the auto-chain) don't show a stuck-running bar after completion.
    const broll = await import('../broll.js')
    const statusAtCallStart = []
    broll.executeSearchBatch.mockImplementation(async (ids, size, pid) => {
      statusAtCallStart.push(broll.brollPipelineProgress.get(pid)?.status)
      broll.brollPipelineProgress.set(pid, { status: 'enqueued' }) // mimic executeSearchBatch
      return { enqueued: broll.executeSearchBatch.mock.calls.length < 3 ? 10 : 0 }
    })
    const r = await runBrollSearchAll({ planPipelineIds: ['p1'] })
    // Calls 2 and 3 must observe 'running' (re-asserted after the prior iteration).
    expect(statusAtCallStart[1]).toBe('running')
    expect(statusAtCallStart[2]).toBe('running')
    // Final iteration enqueued 0 → no re-assert → terminal entry stays 'enqueued'.
    expect(broll.brollPipelineProgress.get(r.searchPipelineId)?.status).toBe('enqueued')
  })

  it('awaits executeSearchBatch before returning (no fire-and-forget race)', async () => {
    // The caller (orchestrator) immediately polls waitForSearchBatchComplete; if
    // runBrollSearchAll returned before the keyword+INSERT landed, that poll would
    // see count=0 and finish prematurely. Each iteration must await the batch.
    const broll = await import('../broll.js')
    let resolveBatch
    broll.executeSearchBatch.mockImplementationOnce(() => new Promise(r => { resolveBatch = r }))
    let resolved = false
    const callPromise = runBrollSearchAll({ planPipelineIds: ['p1'] }).then(r => { resolved = true; return r })
    await new Promise(r => setTimeout(r, 20)) // yield; a non-awaited impl would resolve here
    expect(resolved).toBe(false)
    resolveBatch({ enqueued: 0 }) // drain → loop ends
    const r = await callPromise
    expect(resolved).toBe(true)
    expect(r.searchPipelineId).toMatch(/^search-batch-\d+$/)
  })
})
