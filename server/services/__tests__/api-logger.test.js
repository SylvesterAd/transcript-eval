import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// db.js connects to Postgres at import time — mock it so importing api-logger
// doesn't touch a real database. streamingFetch only uses db.prepare().run().
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({ run: vi.fn(async () => ({ lastInsertRowid: 1 })) })),
  },
}))
vi.mock('../slack-notifier.js', () => ({ notify: vi.fn() }))

import { streamingFetch } from '../api-logger.js'
import { notify } from '../slack-notifier.js'

const enc = new TextEncoder()

// Build a fake fetch whose SSE body yields the given string chunks, then
// simulates undici cutting the socket mid-stream by throwing TypeError('terminated').
function fetchThatStreamsThenDrops(chunks) {
  return vi.fn(async () => {
    let i = 0
    const reader = {
      read: async () => {
        if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) }
        throw new TypeError('terminated')
      },
    }
    return {
      status: 200,
      ok: true,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: { getReader: () => reader },
    }
  })
}

const JOB_EVENT = 'event: progress\ndata: {"stage":"job","status":"created","job_id":"JOB-123"}\n\n'

describe('streamingFetch — alert only when unrecoverable', () => {
  beforeEach(() => {
    notify.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does NOT alert when the stream drops after a job_id was captured (recoverable)', async () => {
    // job event arrives, THEN the socket is cut mid-rerank — exactly the prod case.
    vi.stubGlobal('fetch', fetchThatStreamsThenDrops([JOB_EVENT]))

    const result = await streamingFetch('https://gpu/broll/search', {
      body: { keywords: ['x'], brief: 'b' },
      headers: {},
      logSource: 'broll-search-single:p_test',
      onProgress: () => {}, // callers always pass this; job_id capture is gated on it
    })

    // The pipeline is running server-side under JOB-123; the caller will poll
    // /broll/jobs/:id for the real outcome. A transport-drop alert here is a
    // false alarm, so notify must not fire.
    expect(notify).not.toHaveBeenCalled()
    // And streamingFetch must surface the job_id so the caller can recover.
    expect(result.job_id).toBe('JOB-123')
  })

  it('DOES alert when the stream drops before any job_id (unrecoverable)', async () => {
    // socket cut before the job event ever arrives → nothing to poll → real failure.
    vi.stubGlobal('fetch', fetchThatStreamsThenDrops([]))

    await expect(
      streamingFetch('https://gpu/broll/search', {
        body: { keywords: ['x'], brief: 'b' },
        headers: {},
        logSource: 'broll-search-single:p_test',
      }),
    ).rejects.toThrow('terminated')

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ source: 'api-log', title: 'Stream error' })
  })
})
