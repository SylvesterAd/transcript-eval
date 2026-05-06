import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture every prepared statement and the args passed to .run().
const dbCalls = []

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      get: () => null,
      all: () => [],
      run: (...args) => {
        dbCalls.push({ sql, args })
        // INSERT INTO videos returns lastInsertRowid
        if (/INSERT INTO videos/i.test(sql)) return { lastInsertRowid: 999 }
        return { rowCount: 1 }
      },
    }),
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

// Stub out cloudflare-stream — videos.js imports it at module load (mp4Url,
// thumbnailUrl are aliased to cfMp4Url/cfThumbnailUrl). Keep the mock
// minimal — we only want to exercise the route handler logic.
vi.mock('../../services/cloudflare-stream.js', () => ({
  mp4Url: (uid) => `https://videodelivery.net/${uid}/downloads/default.mp4`,
  thumbnailUrl: () => null,
  enableMp4Downloads: async () => {},
  waitForStreamReady: async () => ({ duration: 0 }),
  waitForMp4Ready: async () => {},
  createDirectUpload: async () => ({}),
  deleteStream: async () => {},
  getStreamStatus: async () => ({}),
  isEnabled: () => false,
}))

describe('POST /videos/register — duration_seconds handling', () => {
  beforeEach(() => { dbCalls.length = 0 })

  it('persists duration_seconds when provided in the request body', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    const req = {
      auth: { userId: 'user-1' },
      body: {
        cf_stream_uid: 'cf-uid-abc',
        filename: 'test.mp4',
        title: 'test',
        group_id: 42,
        video_type: 'raw',
        file_size: 1234567,
        duration_seconds: 612,
      },
    }
    const res = {
      status: function (c) { this._status = c; return this },
      json: function (b) { this._body = b; return this },
    }
    await _registerVideoHandler(req, res)

    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeDefined()
    expect(insert.sql).toMatch(/duration_seconds/)
    // The duration_seconds value should appear in the args array
    expect(insert.args).toContain(612)
  })

  it('inserts NULL duration_seconds when client did not probe', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    const req = {
      auth: { userId: 'user-1' },
      body: {
        cf_stream_uid: 'cf-uid-xyz',
        filename: 't.mp4',
        title: 't',
        group_id: 42,
        video_type: 'raw',
        file_size: 1000,
        // no duration_seconds
      },
    }
    const res = {
      status: function (c) { this._status = c; return this },
      json: function (b) { this._body = b; return this },
    }
    await _registerVideoHandler(req, res)

    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeDefined()
    // duration_seconds should be in the column list, value should be null
    expect(insert.args).toContain(null)
  })

  it('rejects negative or non-finite duration_seconds (defensive)', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    for (const bad of [-5, 'not-a-number', Infinity, NaN]) {
      dbCalls.length = 0
      const req = {
        auth: { userId: 'user-1' },
        body: {
          cf_stream_uid: 'cf-uid',
          group_id: 42,
          video_type: 'raw',
          file_size: 1000,
          duration_seconds: bad,
        },
      }
      const res = {
        status: function (c) { this._status = c; return this },
        json: function (b) { this._body = b; return this },
      }
      await _registerVideoHandler(req, res)

      const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
      // Bad input should be coerced to null, not stored verbatim.
      expect(insert.args).toContain(null)
      expect(insert.args).not.toContain(bad)
    }
  })
})

describe('POST /videos/register — audio-via-CF-Stream guard', () => {
  beforeEach(() => { dbCalls.length = 0 })

  // Defense-in-depth: a stale UploadModal bundle (from before the audio
  // branch shipped) routes audio MP3s through TUS → Cloudflare Stream
  // and POSTs to /register with cf_stream_uid set but no media_type.
  // CF Stream cannot transcode audio, so the upload is doomed; we must
  // reject at /register so the corrupt row is never inserted. See
  // group 289 for the bug this guards against.
  it('rejects audio-extension filenames when cf_stream_uid is supplied', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    for (const filename of ['audio.mp3', 'voice.WAV', 'sound.m4a', 'pod (1).mp3']) {
      dbCalls.length = 0
      const req = {
        auth: { userId: 'user-1' },
        body: {
          cf_stream_uid: 'cf-uid-doomed',
          filename,
          title: filename,
          group_id: 42,
          video_type: 'raw',
          file_size: 1000,
        },
      }
      const res = {
        status: function (c) { this._status = c; return this },
        json: function (b) { this._body = b; return this },
      }
      await _registerVideoHandler(req, res)

      expect(res._status).toBe(400)
      expect(res._body?.error || '').toMatch(/audio/i)
      const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
      expect(insert).toBeUndefined()
    }
  })

  it('still allows video-extension filenames with cf_stream_uid', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    const req = {
      auth: { userId: 'user-1' },
      body: {
        cf_stream_uid: 'cf-uid-ok',
        filename: 'movie.mp4',
        title: 'movie',
        group_id: 42,
        video_type: 'raw',
        file_size: 1000,
      },
    }
    const res = {
      status: function (c) { this._status = c; return this },
      json: function (b) { this._body = b; return this },
    }
    await _registerVideoHandler(req, res)

    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeDefined()
  })

  it('also catches title-only audio filenames when filename param is missing', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    const req = {
      auth: { userId: 'user-1' },
      body: {
        cf_stream_uid: 'cf-uid-doomed',
        title: 'voice memo.mp3',
        group_id: 42,
        video_type: 'raw',
        file_size: 1000,
      },
    }
    const res = {
      status: function (c) { this._status = c; return this },
      json: function (b) { this._body = b; return this },
    }
    await _registerVideoHandler(req, res)

    expect(res._status).toBe(400)
    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeUndefined()
  })
})
