// server/routes/__tests__/full-auto-status-script-skip.test.js
//
// Regression: GET /groups/:id/full-auto-status powers ProcessingModal's
// stage indicators. media_type='script' rows must not appear in its
// `videos` response — otherwise deriveStages counts them in the
// transcribe stage's denominator, leaves the stage "neither done nor
// active" (since their transcription_status is 'failed'), and the UI
// renders "Pending" forever.
//
// This is the same upstream bug as the multicam-sync / batch-transcribe
// script-skip fixes — pinned here so the API contract that powers the
// modal is also covered.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbCalls = []

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      dbCalls.push(sql)
      return {
        async get() {
          if (/SELECT id, name, path_id/.test(sql)) {
            return {
              id: 308, name: 'p', path_id: 'strategy-only', auto_rough_cut: true,
              assembly_status: 'confirmed', assembly_error: null,
              rough_cut_status: null, broll_chain_status: null,
            }
          }
          return null
        },
        async all() {
          if (/FROM videos[\s\S]*WHERE video_type = 'raw'/.test(sql)) {
            return []
          }
          if (/FROM video_groups WHERE parent_group_id =/.test(sql)) {
            return []
          }
          return []
        },
        async run() {
          return { changes: 1 }
        },
      }
    },
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

vi.mock('../../services/whisper.js', () => ({
  transcribeVideo: vi.fn(),
  findCutWords: vi.fn(),
}))

beforeEach(() => {
  dbCalls.length = 0
})

describe('GET /groups/:id/full-auto-status — script skip', () => {
  it('candidate SELECT filters to media_type IN (audio,video)', async () => {
    const { _fullAutoStatusHandler } = await import('../videos.js')

    const req = { params: { id: '308' }, auth: { userId: 'admin' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await _fullAutoStatusHandler(req, res)

    const candidateSelect = dbCalls.find(
      sql => /FROM videos[\s\S]*WHERE video_type = 'raw'/.test(sql)
              && /transcription_status/.test(sql)
    )
    expect(candidateSelect).toBeTruthy()
    expect(candidateSelect).toMatch(/media_type IN \('audio',\s*'video'\)/)
  })
})
