// Tests for resumeStuckYouTubeDownloads — the boot-time recovery path that
// re-fires downloadYouTubeVideo for broll_example_sources rows whose driver
// died mid-download. Without this, a server crash between status='processing'
// and the success/failure write leaves the row stuck forever (frontend spins,
// no retry). Mirrors the heartbeat pattern used by resumeStuckFullAutoChains
// for b-roll chains.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  rows: [],                       // SELECT result for the resume query
  downloadCalls: [],              // downloadYouTubeVideo invocations
  resumeQuerySql: null,           // captured SQL of the resume query
  resumeQueryArgs: null,          // captured bind args of the resume query
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async all(...args) {
          if (/FROM broll_example_sources[\s\S]*kind = 'yt_video'/.test(sql)) {
            state.resumeQuerySql = sql
            state.resumeQueryArgs = args
            return state.rows
          }
          return []
        },
        async get() { return null },
        async run() { return { changes: 1 } },
      }
    },
  },
}))

vi.mock('../broll.js', () => ({
  downloadYouTubeVideo: vi.fn(async (id) => { state.downloadCalls.push(id) }),
}))

const { resumeStuckYouTubeDownloads } = await import('../auto-orchestrator.js')

beforeEach(async () => {
  state.rows = []
  state.downloadCalls = []
  state.resumeQuerySql = null
  state.resumeQueryArgs = null
  vi.useFakeTimers()
  const { downloadYouTubeVideo } = await import('../broll.js')
  downloadYouTubeVideo.mockReset()
  downloadYouTubeVideo.mockImplementation(async (id) => { state.downloadCalls.push(id) })
})

describe('resumeStuckYouTubeDownloads', () => {
  it('refires downloadYouTubeVideo for each row returned by the resume query', async () => {
    state.rows = [{ id: 11 }, { id: 22 }]
    await resumeStuckYouTubeDownloads()
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.downloadCalls.sort()).toEqual([11, 22])
  })

  it('does nothing when no stuck rows are returned', async () => {
    state.rows = []
    await resumeStuckYouTubeDownloads()
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.downloadCalls).toEqual([])
  })

  it('query filters to yt_video kind only — uploads and yt_channel never auto-resume', async () => {
    state.rows = []
    await resumeStuckYouTubeDownloads()
    expect(state.resumeQuerySql).toMatch(/kind = 'yt_video'/)
  })

  it('query restricts status to in-flight states (pending or processing)', async () => {
    state.rows = []
    await resumeStuckYouTubeDownloads()
    expect(state.resumeQuerySql).toMatch(/status IN \('pending', 'processing'\)/)
  })

  it('query filters by stale or null heartbeat — fresh-heartbeat rows are skipped (live driver)', async () => {
    state.rows = []
    await resumeStuckYouTubeDownloads()
    expect(state.resumeQuerySql).toMatch(/heartbeat_at IS NULL OR heartbeat_at/)
  })

  it('does not crash when downloadYouTubeVideo rejects — one bad row does not block siblings', async () => {
    state.rows = [{ id: 31 }, { id: 32 }]
    const { downloadYouTubeVideo } = await import('../broll.js')
    downloadYouTubeVideo.mockReset()
    downloadYouTubeVideo
      .mockImplementationOnce(async () => { throw new Error('boom') })
      .mockImplementation(async (id) => { state.downloadCalls.push(id) })
    await resumeStuckYouTubeDownloads()
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.downloadCalls).toEqual([32])
  })
})
