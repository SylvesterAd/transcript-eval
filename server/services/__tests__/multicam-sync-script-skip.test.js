// server/services/__tests__/multicam-sync-script-skip.test.js
//
// Regression: video rows with media_type='script' must NEVER reach the
// classifier or the multicam-sync waveform path. Scripts are reference
// documents (.txt/.docx/.pdf) uploaded via /upload-script — they share the
// videos table with real videos but have no audio, no transcript, and no
// duration. When the classifier or sync code blindly queried by
// `video_type='raw'`, scripts were:
//   - sent to Gemini classification with empty transcripts → grouped into MAIN
//   - given waveform overlap scores of 0 against real videos
//   - placed in the assembled timeline as zero-duration "segments"
//   - and (separately) sent to ElevenLabs Scribe by the batch transcribe
//     endpoint, which returned "File is corrupted" because Scribe expects
//     audio/video.
// The fix: every SELECT that builds the candidate pool for classification
// or sync MUST filter to media_type IN ('audio','video'). These tests pin
// that filter in place using the same SQL-regex inspection pattern as
// multicam-audio-skip.test.js — losing the filter regresses an observed
// production bug (group 308 / sub-group 309 on 2026-05-07).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  hasAudioRow: undefined,
  syncModeRow: { sync_mode: 'sync' },
  videoRows: [],
  dbCalls: [],
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      state.dbCalls.push(sql)
      return {
        async get() {
          if (/SELECT 1 FROM videos WHERE group_id = \? AND media_type = 'audio'/.test(sql)) {
            return state.hasAudioRow
          }
          if (/SELECT sync_mode FROM video_groups WHERE id/.test(sql)) {
            return state.syncModeRow
          }
          if (/SELECT user_id, auto_rough_cut(?:, path_id)? FROM video_groups WHERE id/.test(sql)) {
            return { user_id: 'u1', auto_rough_cut: false }
          }
          throw new Error(`unexpected get SQL: ${sql}`)
        },
        async all() {
          if (/FROM videos v[\s\S]*LEFT JOIN transcripts/.test(sql)) {
            return state.videoRows
          }
          throw new Error(`unexpected all SQL: ${sql}`)
        },
        async run() {
          if (/UPDATE video_groups SET (classification_json|assembly_status)/.test(sql)) {
            return { changes: 1 }
          }
          throw new Error(`unexpected run SQL: ${sql}`)
        },
      }
    },
  },
}))

import { analyzeMulticam, classifyVideosForReview } from '../multicam-sync.js'

beforeEach(() => {
  state.hasAudioRow = undefined
  state.syncModeRow = { sync_mode: 'sync' }
  state.videoRows = []
  state.dbCalls = []
})

describe('classifyVideosForReview (script skip)', () => {
  it('candidate SELECT filters to media_type IN (audio,video)', async () => {
    // One row is enough — runClassification short-circuits to MAIN when
    // length === 1, so we exit cleanly without touching Gemini. The
    // assertion is on the SQL that selected the candidates.
    state.videoRows = [
      { id: 443, title: 'video.mp4', duration_seconds: 713, file_path: '/v.mp4', transcript: 'hello' },
    ]
    await classifyVideosForReview(308)

    const candidateSelect = state.dbCalls.find(
      sql => /FROM videos v[\s\S]*LEFT JOIN transcripts[\s\S]*v\.video_type = 'raw'/.test(sql)
    )
    expect(candidateSelect).toBeTruthy()
    expect(candidateSelect).toMatch(/media_type IN \('audio',\s*'video'\)/)
  })
})

describe('analyzeMulticam (script skip)', () => {
  it('candidate SELECT filters to media_type IN (audio,video)', async () => {
    state.hasAudioRow = undefined // bypass the audio guard
    state.videoRows = [
      { id: 443, title: 'video.mp4', duration_seconds: 713, file_path: '/v.mp4', transcript: 'hello' },
    ]
    // single-video path exits cleanly without ffmpeg/Gemini, so we don't
    // need to mock waveform extraction.
    await analyzeMulticam(309)

    const candidateSelect = state.dbCalls.find(
      sql => /FROM videos v[\s\S]*LEFT JOIN transcripts[\s\S]*v\.video_type = 'raw'/.test(sql)
    )
    expect(candidateSelect).toBeTruthy()
    expect(candidateSelect).toMatch(/media_type IN \('audio',\s*'video'\)/)
  })
})
