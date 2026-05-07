// server/routes/__tests__/batch-transcribe-script-skip.test.js
//
// Regression: POST /groups/:id/transcribe must not enqueue rows where
// media_type='script'. Scripts (.txt/.docx/.pdf) are stored in the videos
// table with video_type='raw' but have no audio for ElevenLabs Scribe to
// transcribe — calling Scribe on one returns 400 "File is corrupted" and
// poisons the transcribe stage in ProcessingModal.
//
// Pattern: mock db.js, dynamic-import the module under test inside the
// test (mirrors videos-audio-upload.test.js — necessary because videos.js
// runs an IIFE at import time that calls db.prepare).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbCalls = []

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      dbCalls.push(sql)
      return {
        async get() {
          if (/SELECT id FROM video_groups WHERE id/.test(sql)) {
            return { id: 308 }
          }
          // The IIFE at the top of videos.js asks for stuck transcriptions
          // and stuck experiment runs at module load. Return empty so it
          // exits cleanly.
          return null
        },
        async all() {
          if (/FROM videos\s+WHERE group_id =/.test(sql)) {
            // Returning empty is enough to drive the test — the assertion
            // is on the SELECT string, not on the loop body that runs after.
            return []
          }
          // Startup IIFE selects from videos / experiment_runs.
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

// startBackgroundTranscription is called from the IIFE; stub the worker
// machinery to avoid touching real network/storage when videos.js loads.
vi.mock('../../services/whisper.js', () => ({
  transcribeVideo: vi.fn(),
  findCutWords: vi.fn(),
}))

beforeEach(() => {
  dbCalls.length = 0
})

describe('POST /groups/:id/transcribe — script skip', () => {
  it('candidate SELECT filters to media_type IN (audio,video)', async () => {
    const { _batchTranscribeHandler } = await import('../videos.js')

    const req = { params: { id: '308' }, auth: { userId: 'admin' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await _batchTranscribeHandler(req, res)

    const candidateSelect = dbCalls.find(
      sql => /FROM videos\s+WHERE group_id =/.test(sql)
              && /transcription_status/.test(sql)
    )
    expect(candidateSelect).toBeTruthy()
    expect(candidateSelect).toMatch(/media_type IN \('audio',\s*'video'\)/)
  })
})
