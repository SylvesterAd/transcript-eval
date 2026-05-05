// Tests the audio guard at the top of analyzeMulticam: any video in the group
// with media_type='audio' short-circuits before any heavy work (no transcripts
// pulled, no sync_mode lookup, no Gemini calls). Audio-only A-roll never needs
// multicam classification because there are no waveforms to align.
//
// Test pattern matches the rest of server/services/__tests__/: vi.mock the db
// module, route SQL by regex, capture .prepare() calls in dbCalls so we can
// assert the function bailed BEFORE issuing later queries (no transcripts JOIN,
// no sync_mode SELECT, no UPDATE video_groups, etc.).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  hasAudioRow: undefined, // what the audio-guard SELECT returns
  syncModeRow: { sync_mode: 'sync' },
  videoRows: [],          // rows for the v JOIN transcripts SELECT
  dbCalls: [],            // every SQL passed to db.prepare()
  statusUpdates: [],
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      state.dbCalls.push(sql)
      return {
        async get(...args) {
          if (/SELECT 1 FROM videos WHERE group_id = \? AND media_type = 'audio'/.test(sql)) {
            return state.hasAudioRow
          }
          if (/SELECT sync_mode FROM video_groups WHERE id/.test(sql)) {
            return state.syncModeRow
          }
          // updateStatus internals — don't care about exact shape, just acknowledge.
          if (/SELECT user_id, auto_rough_cut(?:, path_id)? FROM video_groups WHERE id/.test(sql)) {
            return { user_id: 'u1', auto_rough_cut: false }
          }
          throw new Error(`unexpected get SQL: ${sql}`)
        },
        async all(...args) {
          if (/FROM videos v[\s\S]*LEFT JOIN transcripts/.test(sql)) {
            return state.videoRows
          }
          throw new Error(`unexpected all SQL: ${sql}`)
        },
        async run(...args) {
          if (/UPDATE video_groups SET assembly_status/.test(sql)) {
            state.statusUpdates.push(args)
            return { changes: 1 }
          }
          throw new Error(`unexpected run SQL: ${sql}`)
        },
      }
    },
  },
}))

import { analyzeMulticam } from '../multicam-sync.js'

beforeEach(() => {
  state.hasAudioRow = undefined
  state.syncModeRow = { sync_mode: 'sync' }
  state.videoRows = []
  state.dbCalls = []
  state.statusUpdates = []
})

describe('analyzeMulticam (audio guard)', () => {
  it('returns early without running ffmpeg when group has any audio video', async () => {
    state.hasAudioRow = { '?column?': 1 } // SELECT 1 — Postgres returns truthy row

    const result = await analyzeMulticam(42)

    expect(result).toEqual({ skipped: true, reason: 'audio_in_group' })
    // Load-bearing: the audio-detection SELECT must be the ONLY SQL prepared.
    // If the guard regresses, analyzeMulticam would prepare the videos-with-
    // transcripts SELECT next (and many more). Counting prepare calls makes
    // the regression observable.
    expect(state.dbCalls).toHaveLength(1)
    expect(state.dbCalls[0]).toMatch(/media_type = 'audio'/)
    // No status updates either — the audio group is not "failed", just skipped.
    expect(state.statusUpdates).toHaveLength(0)
  })

  it('runs normally when group has only video (dryRun proves we passed the guard)', async () => {
    state.hasAudioRow = undefined // no audio in group

    // dryRun is a test-only short-circuit positioned AFTER the audio guard, so
    // a passing assertion here proves: (1) the audio SELECT was issued and
    // returned no row, and (2) we progressed past the guard.
    const result = await analyzeMulticam(43, { dryRun: true })

    expect(result?.skipped).not.toBe(true)
    expect(result).toMatchObject({ dryRun: true })
    // The audio-guard SELECT still runs (load-bearing for the negative path).
    expect(state.dbCalls[0]).toMatch(/media_type = 'audio'/)
  })
})
