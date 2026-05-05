// server/routes/__tests__/videos-detail-media-type.test.js
//
// Regression test for the audio-only A-roll bug discovered during
// Task 11: the frontend reads `v.media_type` on each video object in
// `data?.videos` (EditorView at src/components/editor/EditorView.jsx
// and AssetsView at src/components/editor/AssetsView.jsx), but the
// `/groups/:id/detail` and `/groups/:id/classification` API endpoints
// were originally SELECTing a fixed column list that did NOT include
// `media_type`. As a result, every video object had
// `media_type === undefined` at runtime and the audio-only UI paths
// (no-video placeholder, multicam UI hidden) never fired.
//
// This test pins the column list shipped to the frontend by capturing
// the prepared SELECT SQL via a mocked db and asserting `media_type`
// appears in the projection. Removing `media_type` from any of these
// SELECT statements will fail the test.
//
// Pattern mirrors videos-register-duration.test.js (mock db.js, capture
// every prepared statement, call the exported handler directly).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbCalls = []

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      get: () => {
        // Return a non-null group row so the handlers proceed past the
        // 404 early-return. Shape mirrors what the route consumes
        // (assembly_status drives the classification branching).
        if (/FROM video_groups WHERE id = \?/i.test(sql)) {
          return {
            id: 42,
            name: 'Test Group',
            user_id: 'user-1',
            assembly_status: 'syncing',
            assembly_error: null,
            classification_json: null,
            parent_group_id: null,
            assembly_details_json: null,
            timeline_json: null,
            rough_cut_config_json: null,
            rough_cut_status: null,
            rough_cut_error_required: null,
            libraries_json: null,
            freepik_opt_in: null,
            audience_json: null,
            path_id: null,
            editor_state_json: null,
            annotations_json: null,
            upload_batch_id: null,
          }
        }
        return null
      },
      all: (...args) => {
        dbCalls.push({ sql, args })
        // Return a single video row for the videos SELECT so the
        // handler can format a JSON response without crashing on
        // .map() — the row carries media_type so we can also assert it
        // surfaces in the response body.
        if (/FROM videos/i.test(sql)) {
          return [{
            id: 1,
            title: 'audio-clip',
            video_type: 'raw',
            media_type: 'audio',
            duration_seconds: 30,
            transcription_status: 'done',
            transcription_error: null,
            thumbnail_path: null,
            file_path: 'https://supabase.test/audio.mp3',
            frames_status: null,
            media_info_json: null,
          }]
        }
        return []
      },
      run: () => ({ rowCount: 1 }),
    }),
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

// videos.js imports cloudflare-stream at module load — stub it. The
// service is otherwise unused in these handlers.
vi.mock('../../services/cloudflare-stream.js', () => ({
  mp4Url: () => null,
  thumbnailUrl: () => null,
  enableMp4Downloads: async () => {},
  waitForStreamReady: async () => ({ duration: 0 }),
  waitForMp4Ready: async () => {},
  createDirectUpload: async () => ({}),
  deleteStream: async () => {},
  getStreamStatus: async () => ({}),
  isEnabled: () => false,
}))

function makeRes() {
  return {
    status(c) { this._status = c; return this },
    json(b) { this._body = b; return this },
  }
}

function makeReq({ params = { id: '42' }, auth = { userId: 'user-1' } } = {}) {
  return { params, auth }
}

describe('GET /videos/groups/:id/detail — media_type in response', () => {
  // Clear dbCalls right before each handler call so the startup IIFEs
  // in videos.js (which fire SELECTs against the videos table on
  // module load) don't pollute our captured statements.
  beforeEach(() => { dbCalls.length = 0 })

  it('SELECTs media_type from the videos table', async () => {
    const { _getGroupDetailHandler } = await import('../videos.js')
    dbCalls.length = 0

    const res = makeRes()
    await _getGroupDetailHandler(makeReq(), res)

    // Find the SELECT against the videos table (excluding the
    // video_groups SELECT and any sub-SELECTs). The handler runs
    // exactly one such SELECT during the parallel Promise.all read.
    const videosSelect = dbCalls.find(c =>
      /^\s*SELECT\b/i.test(c.sql) &&
      /FROM videos\b/i.test(c.sql) &&
      !/FROM video_groups\b/i.test(c.sql)
    )
    expect(videosSelect).toBeDefined()
    // Load-bearing assertion: the SELECT projection must explicitly
    // include `media_type`. Removing it from the column list fails
    // here — a SELECT * would also pass, and that's intentional
    // (either form ships media_type to the frontend).
    expect(videosSelect.sql).toMatch(/\bmedia_type\b/)
  })

  it('includes media_type on each row of response.videos', async () => {
    const { _getGroupDetailHandler } = await import('../videos.js')
    dbCalls.length = 0

    const res = makeRes()
    await _getGroupDetailHandler(makeReq(), res)

    expect(res._body).toBeDefined()
    expect(Array.isArray(res._body.videos)).toBe(true)
    expect(res._body.videos.length).toBeGreaterThan(0)
    expect(res._body.videos[0].media_type).toBe('audio')
  })
})

describe('GET /videos/groups/:id/classification — media_type in response', () => {
  beforeEach(() => { dbCalls.length = 0 })

  it('SELECTs media_type from the videos table (unconfirmed branch)', async () => {
    const { _getGroupClassificationHandler } = await import('../videos.js')
    dbCalls.length = 0

    const res = makeRes()
    await _getGroupClassificationHandler(makeReq(), res)

    const videosSelect = dbCalls.find(c =>
      /^\s*SELECT\b/i.test(c.sql) &&
      /FROM videos\b/i.test(c.sql) &&
      !/FROM video_groups\b/i.test(c.sql)
    )
    expect(videosSelect).toBeDefined()
    expect(videosSelect.sql).toMatch(/\bmedia_type\b/)
  })

  it('includes media_type on each row of response.videos', async () => {
    const { _getGroupClassificationHandler } = await import('../videos.js')
    dbCalls.length = 0

    const res = makeRes()
    await _getGroupClassificationHandler(makeReq(), res)

    expect(res._body).toBeDefined()
    expect(Array.isArray(res._body.videos)).toBe(true)
    expect(res._body.videos.length).toBeGreaterThan(0)
    // media_type must survive the {...v, media_info, media_info_json:
    // undefined} mapping in the handler. If a future refactor strips
    // it via an explicit pick or rename, this assertion catches it.
    expect(res._body.videos[0].media_type).toBe('audio')
  })
})

// The classification handler has TWO SELECT branches: one for projects
// where assembly_status='confirmed' (videos live in sub-groups, line
// 727 in videos.js) and one for unconfirmed projects (videos live on
// the group itself, line 735). Both ship to the frontend's
// `data.videos`, so both must include media_type. The previous
// describe block exercises the unconfirmed branch via the default
// mock; this one swaps to confirmed and asserts the same.
describe('GET /videos/groups/:id/classification — confirmed branch', () => {
  beforeEach(() => { dbCalls.length = 0 })

  it('SELECTs media_type from videos in the confirmed (sub-group) branch', async () => {
    // Re-import after resetting modules so the dynamic mock below
    // takes effect (vitest hoists vi.mock calls but db.prepare's
    // .get/.all closures already captured the original handler).
    vi.resetModules()
    const dbCallsLocal = []
    vi.doMock('../../db.js', () => ({
      default: {
        prepare: (sql) => ({
          get: () => {
            if (/FROM video_groups WHERE id = \?/i.test(sql)) {
              return {
                id: 42,
                name: 'Test Group',
                user_id: 'user-1',
                assembly_status: 'confirmed',
                assembly_error: null,
                classification_json: null,
                parent_group_id: null,
              }
            }
            return null
          },
          all: (...args) => {
            dbCallsLocal.push({ sql, args })
            // Sub-groups list — must be non-empty so the handler
            // builds the IN-clause SELECT for video rows.
            if (/SELECT id FROM video_groups WHERE parent_group_id = \?/i.test(sql)) {
              return [{ id: 100 }]
            }
            if (/FROM videos/i.test(sql)) {
              return [{
                id: 1,
                title: 'audio-clip',
                media_type: 'audio',
                duration_seconds: 30,
                thumbnail_path: null,
                file_path: 'https://supabase.test/audio.mp3',
                media_info_json: null,
              }]
            }
            // Sub-group metadata SELECT (when isConfirmed)
            return []
          },
          run: () => ({ rowCount: 1 }),
        }),
        pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
      },
    }))

    const { _getGroupClassificationHandler } = await import('../videos.js')
    // Drop everything captured during module-load IIFEs so we only
    // assert against statements issued by the handler itself.
    dbCallsLocal.length = 0

    const res = makeRes()
    await _getGroupClassificationHandler(makeReq(), res)

    // Find the SELECT that actually pulls video rows from the videos
    // table — the IN-clause variant at videos.js:727. It's the only
    // SELECT in the confirmed branch with media_info_json in the
    // projection, which is unique to that statement.
    const videosSelect = dbCallsLocal.find(c =>
      /FROM videos\b/i.test(c.sql) &&
      /media_info_json/i.test(c.sql) &&
      /IN \(\?/i.test(c.sql)
    )
    expect(videosSelect).toBeDefined()
    expect(videosSelect.sql).toMatch(/\bmedia_type\b/)
    expect(res._body.videos[0].media_type).toBe('audio')

    vi.doUnmock('../../db.js')
  })
})
