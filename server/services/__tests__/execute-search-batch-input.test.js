// Regression: executeSearchBatch must reject falsy / empty plan pipeline IDs
// with a clear error instead of crashing deep inside.
//
// Root cause (prod, search-batch-1779455020983): the boot/periodic auto-resume
// sweep resumed a chain stuck at substage 'search' via resumeChain(id,'search')
// with NO opts. resumeChain's old `opts.planPipelineIds || [opts.planPipelineId]`
// produced [undefined], which reached executeSearchBatch and threw the cryptic
// "Cannot read properties of undefined (reading 'slice')" while building a
// per-variant log label (`v.pid.slice(-13)`). This test pins the defensive
// guard that converts that into an actionable error.

import { describe, it, expect, vi } from 'vitest'

// broll.js → llm-runner.js does top-level db work at module load; a chainable
// no-op stmt is enough for import (mirrors broll-extract-json.test.js).
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ changes: 0 }),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

const { executeSearchBatch } = await import('../broll.js')

describe('executeSearchBatch input validation', () => {
  it('rejects [undefined] with a clear error, not a .slice TypeError', async () => {
    await expect(executeSearchBatch([undefined], 10, 'search-batch-test-1')).rejects.toThrow(
      /no valid plan pipeline IDs/i,
    )
    // The original prod crash signature must NOT reappear.
    await expect(executeSearchBatch([undefined], 10, 'search-batch-test-1b')).rejects.not.toThrow(
      /reading 'slice'/,
    )
  })

  it('rejects an empty array', async () => {
    await expect(executeSearchBatch([], 10, 'search-batch-test-2')).rejects.toThrow(
      /no valid plan pipeline IDs/i,
    )
  })

  it('rejects null / undefined argument', async () => {
    await expect(executeSearchBatch(null, 10, 'search-batch-test-3')).rejects.toThrow(
      /no valid plan pipeline IDs/i,
    )
    await expect(executeSearchBatch(undefined, 10, 'search-batch-test-4')).rejects.toThrow(
      /no valid plan pipeline IDs/i,
    )
  })
})
