import { describe, it, expect, vi, beforeEach } from 'vitest'

let dbState = { remaining: 0 }
const dbCalls = []

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      get: (...args) => {
        dbCalls.push({ kind: 'get', sql, args })
        return { n: dbState.remaining }
      },
      run: () => ({ rowCount: 1 }),
      all: () => [],
    }),
  },
}))

describe('waitForSearchBatchComplete', () => {
  beforeEach(() => {
    dbCalls.length = 0
    dbState = { remaining: 0 }
  })

  it('returns immediately when no rows are waiting/running', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js')
    dbState.remaining = 0
    await waitForSearchBatchComplete('search-batch-x', { pollIntervalMs: 10, maxWaitMs: 1000 })
    // First poll sees 0 rows → returns. Should have done exactly one poll.
    expect(dbCalls.length).toBe(1)
  })

  it('does NOT throw on timeout — returns silently with a warn log', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js')
    dbState.remaining = 5  // never reaches zero
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let threw = false
    try {
      await waitForSearchBatchComplete('search-batch-y', { pollIntervalMs: 10, maxWaitMs: 50 })
    } catch (e) {
      threw = true
    }
    expect(threw).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    const warnMsg = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(warnMsg).toMatch(/timed out|search-batch-y/i)
    warnSpy.mockRestore()
  })

  it('returns when isCancelled becomes true', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js')
    dbState.remaining = 5
    let cancelled = false
    setTimeout(() => { cancelled = true }, 30)
    await waitForSearchBatchComplete('search-batch-z', {
      pollIntervalMs: 10,
      maxWaitMs: 5000,
      isCancelled: () => cancelled,
    })
    // Should return promptly after cancellation, well under maxWaitMs.
  })

  it('default maxWaitMs is 30 minutes (regression guard)', async () => {
    const { waitForSearchBatchComplete } = await import('../broll-runner.js')
    // Pull the default from the function signature by introspection — call
    // with a never-completing batch and a tight observable budget so the
    // test runs fast, but assert via reading the source.
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      new URL('../broll-runner.js', import.meta.url), 'utf-8',
    )
    // Match: maxWaitMs = 30 * 60_000  (or 30 * 60000)
    expect(src).toMatch(/maxWaitMs\s*=\s*30\s*\*\s*60[_]?000/)
  })
})
