// server/routes/__tests__/videos-audio-upload.test.js
//
// Tests for the /upload route's media_type detection (audio vs video).
// Pattern mirrors videos-register-duration.test.js: we mock db.js to
// capture every prepared statement + args, mock external services
// (storage, video-processor, cloudflare-stream) so the route exercises
// only the in-process branching logic, then call the exported
// _uploadVideoHandler directly.
//
// We deviate from the original plan's supertest-based approach because:
//   1. supertest is not installed and the codebase pattern (see
//      videos-register-duration) uses direct handler invocation.
//   2. The plan's test would have written real rows to the shared
//      Supabase dev DB referenced by DATABASE_URL.
// The contract verified is the same: for audio uploads, media_type is
// set to 'audio', extractThumbnail is not called, frame extraction is
// not started, and the video INSERT carries audio in the column list.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractVideoFrames } from '../../services/video-processor.js'

// Capture every prepared statement and the args passed to .run().
const dbCalls = []

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      // Return a non-null row for "SELECT * FROM videos WHERE id = ?" so
      // startBackgroundFrameExtraction proceeds past its early-return
      // (`if (!video?.file_path) return`). Without this, the
      // "extractVideoFrames not called for audio" assertion is vacuous —
      // it would pass even if the `if (!isAudio)` gate were removed.
      get: (id) => {
        if (/SELECT \* FROM videos WHERE id = \?/i.test(sql)) {
          return { id, file_path: 'https://supabase.test/upload-url', media_type: 'video' }
        }
        return null
      },
      all: () => [],
      run: (...args) => {
        dbCalls.push({ sql, args })
        if (/INSERT INTO videos/i.test(sql)) return { lastInsertRowid: 999 }
        if (/INSERT INTO video_groups/i.test(sql)) return { lastInsertRowid: 42 }
        return { rowCount: 1 }
      },
    }),
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

// Mock external services. We only care about route-level branching.
const extractThumbnailMock = vi.fn().mockResolvedValue('/tmp/thumb.jpg')
const getVideoDurationMock = vi.fn().mockResolvedValue(120)
const getVideoMediaInfoMock = vi.fn().mockResolvedValue({ codec: 'mp3' })
const checkFfmpegMock = vi.fn().mockResolvedValue(true)
vi.mock('../../services/video-processor.js', () => ({
  extractThumbnail: (...a) => extractThumbnailMock(...a),
  getVideoDuration: (...a) => getVideoDurationMock(...a),
  getVideoMediaInfo: (...a) => getVideoMediaInfoMock(...a),
  checkFfmpeg: (...a) => checkFfmpegMock(...a),
  extractEnergyEnvelope: vi.fn(),
  extractWaveformPeaks: vi.fn(),
  // Resolve to 0 so startBackgroundFrameExtraction's .then() chain doesn't
  // throw "Cannot read properties of undefined (reading 'then')" when the
  // function actually runs (video uploads).
  extractVideoFrames: vi.fn().mockResolvedValue(0),
  concatenateVideos: vi.fn(),
}))

vi.mock('../../services/storage.js', () => ({
  uploadFile: vi.fn().mockResolvedValue('https://supabase.test/upload-url'),
  deleteByUrl: vi.fn(),
  deleteFolder: vi.fn(),
  // Resolve so the fire-and-forget transcription/frame paths (now reachable
  // because the db mock returns a non-null video row) don't blow up on
  // undefined downloads and pollute the test output with unhandled rejections.
  downloadToTemp: vi.fn().mockResolvedValue('/tmp/downloaded-file.mp4'),
  uploadFrames: vi.fn().mockResolvedValue(undefined),
  TEMP_DIR: '/tmp',
}))

vi.mock('../../services/cloudflare-stream.js', () => ({
  isEnabled: vi.fn().mockReturnValue(false),
  createDirectUpload: vi.fn(),
  deleteStream: vi.fn(),
  getStreamStatus: vi.fn(),
  waitForStreamReady: vi.fn(),
  enableMp4Downloads: vi.fn(),
  waitForMp4Ready: vi.fn(),
  mp4Url: vi.fn(),
  thumbnailUrl: vi.fn(),
}))

// fs.unlinkSync would throw on the fake paths in req.file; stub it.
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs')
  return {
    ...actual,
    unlinkSync: vi.fn(),
  }
})

// Build a minimal req object that mirrors what multer produces after
// disk-storage. The route only reads .file.{originalname,mimetype,
// path,filename,size}, plus req.body and req.auth.
function makeReq({ originalname, mimetype, body = {} }) {
  return {
    auth: { userId: 'test-user' },
    body: { title: 'My upload', video_type: 'raw', ...body },
    file: {
      originalname,
      mimetype,
      path: '/tmp/upload-temp-file',
      filename: 'upload-' + Date.now() + originalname.slice(originalname.lastIndexOf('.')),
      size: 1234,
    },
  }
}

function makeRes() {
  return {
    status(c) { this._status = c; return this },
    json(b) { this._body = b; return this },
  }
}

describe('POST /videos/upload — audio media_type handling', () => {
  beforeEach(() => {
    dbCalls.length = 0
    extractThumbnailMock.mockClear()
    getVideoDurationMock.mockClear()
    getVideoMediaInfoMock.mockClear()
    extractVideoFrames.mockClear()
  })

  it('sets media_type=audio when an mp3 is uploaded', async () => {
    const { _uploadVideoHandler } = await import('../videos.js')

    const req = makeReq({ originalname: 'vo.mp3', mimetype: 'audio/mpeg' })
    const res = makeRes()
    await _uploadVideoHandler(req, res)

    expect(res._status).toBe(201)
    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeDefined()
    expect(insert.sql).toMatch(/media_type/)
    // 8th column is media_type per the new INSERT statement.
    expect(insert.args).toContain('audio')
    // thumbnail_path arg position is 3rd (title, file_path, thumbnail_path, ...).
    expect(insert.args[2]).toBeNull()
  })

  it('does not call extractThumbnail for audio uploads', async () => {
    const { _uploadVideoHandler } = await import('../videos.js')

    const req = makeReq({ originalname: 'voice.wav', mimetype: 'audio/wav' })
    const res = makeRes()
    await _uploadVideoHandler(req, res)

    expect(extractThumbnailMock).not.toHaveBeenCalled()
  })

  it('does not call extractVideoFrames (frame extraction) for audio uploads', async () => {
    const { _uploadVideoHandler } = await import('../videos.js')

    const req = makeReq({ originalname: 'frames.mp3', mimetype: 'audio/mpeg', body: { title: 'Voice frames' } })
    const res = makeRes()
    await _uploadVideoHandler(req, res)

    // Flush any deferred microtasks from the fire-and-forget background call.
    await new Promise(r => setImmediate(r))
    expect(extractVideoFrames).not.toHaveBeenCalled()
    // Load-bearing: startBackgroundFrameExtraction must not run at all for
    // audio. Its second SQL statement is the unique "UPDATE videos SET
    // frames_status" — if the `if (!isAudio)` gate at videos.js:1792 is
    // removed, the function reaches this query and the test fails.
    const framesStatusUpdate = dbCalls.find(c => /UPDATE videos SET frames_status/i.test(c.sql))
    expect(framesStatusUpdate).toBeUndefined()
  })

  it('falls back to filename when MIME is application/octet-stream for audio', async () => {
    const { _uploadVideoHandler } = await import('../videos.js')

    const req = makeReq({ originalname: 'voice.m4a', mimetype: 'application/octet-stream' })
    const res = makeRes()
    await _uploadVideoHandler(req, res)

    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert.args).toContain('audio')
    expect(extractThumbnailMock).not.toHaveBeenCalled()
  })

  it('preserves media_type=video for mp4 uploads (regression)', async () => {
    const { _uploadVideoHandler } = await import('../videos.js')

    const req = makeReq({ originalname: 'clip.mp4', mimetype: 'video/mp4' })
    const res = makeRes()
    await _uploadVideoHandler(req, res)

    expect(res._status).toBe(201)
    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeDefined()
    expect(insert.args).toContain('video')
    // For video, extractThumbnail must run (ffmpeg is mocked-true).
    expect(extractThumbnailMock).toHaveBeenCalled()

    // Positive counterpart to the audio test: startBackgroundFrameExtraction
    // must run for video uploads. Pinning both directions ensures the audio
    // test's negative assertion is load-bearing (i.e. would fail if the
    // `if (!isAudio)` gate at videos.js:1792 were removed).
    await new Promise(r => setImmediate(r))
    const framesStatusUpdate = dbCalls.find(c => /UPDATE videos SET frames_status/i.test(c.sql))
    expect(framesStatusUpdate).toBeDefined()
  })
})

// Reusable factory for upload-multiple req objects. Mirrors what multer
// produces with .array() — the route reads .files (plural).
function makeMultiReq({ files, body = {} }) {
  return {
    auth: { userId: 'test-user' },
    body: { title: 'Mixed batch', video_type: 'raw', ...body },
    files: files.map((f, i) => ({
      originalname: f.originalname,
      mimetype: f.mimetype,
      path: '/tmp/upload-temp-' + i,
      filename: 'upload-' + i + '-' + Date.now() + f.originalname.slice(f.originalname.lastIndexOf('.')),
      size: 1234,
    })),
  }
}

describe('POST /videos/upload-multiple — audio media_type handling', () => {
  beforeEach(() => {
    dbCalls.length = 0
    extractThumbnailMock.mockClear()
    getVideoDurationMock.mockClear()
    getVideoMediaInfoMock.mockClear()
    extractVideoFrames.mockClear()
  })

  it('sets per-file media_type when mixed audio + video are uploaded', async () => {
    const { _uploadMultipleVideosHandler } = await import('../videos.js')

    const req = makeMultiReq({
      files: [
        { originalname: 'a.mp3', mimetype: 'audio/mpeg' },
        { originalname: 'b.mp4', mimetype: 'video/mp4' },
      ],
      body: { title: 'Mixed', video_type: 'raw' },
    })
    const res = makeRes()
    await _uploadMultipleVideosHandler(req, res)

    expect(res._status).toBe(201)

    // Two video INSERTs — collect them in encounter order, which equals
    // the file order because the handler iterates orderedFiles serially.
    const inserts = dbCalls.filter(c => /INSERT INTO videos/i.test(c.sql))
    expect(inserts).toHaveLength(2)
    // Every INSERT must include media_type now.
    for (const ins of inserts) expect(ins.sql).toMatch(/media_type/)
    // Last positional arg is media_type per the new column order.
    const types = inserts.map(ins => ins.args[ins.args.length - 1]).sort()
    expect(types).toEqual(['audio', 'video'])
  })

  it('skips thumbnail + frame extraction for audio rows in a mixed batch', async () => {
    const { _uploadMultipleVideosHandler } = await import('../videos.js')

    const req = makeMultiReq({
      files: [
        { originalname: 'voice.mp3', mimetype: 'audio/mpeg' },
        { originalname: 'clip.mp4', mimetype: 'video/mp4' },
      ],
      body: { video_type: 'raw' },
    })
    const res = makeRes()
    await _uploadMultipleVideosHandler(req, res)

    // extractThumbnail should fire exactly once — for the video file only.
    expect(extractThumbnailMock).toHaveBeenCalledTimes(1)

    // Flush deferred microtasks from the fire-and-forget background calls.
    await new Promise(r => setImmediate(r))

    // Load-bearing: in the raw+multi branch the handler iterates videoIds
    // and calls startBackgroundFrameExtraction only for non-audio entries.
    // Each successful frame-extraction kickoff issues TWO `UPDATE videos
    // SET frames_status` queries (status='extracting' then result). With
    // one video file in the batch we should see >= 1; with the gate at
    // _uploadMultipleVideosHandler removed, both files would trigger and
    // the count would be >= 2. We assert exactly the count expected for
    // the video-only path (mock returns 0, so the success branch runs).
    const framesStatusUpdates = dbCalls.filter(c => /UPDATE videos SET frames_status/i.test(c.sql))
    // 2 updates for the single video row. If the `if (fileMediaTypes[i]
    // !== 'audio')` gate is removed, this jumps to 4 (both files).
    expect(framesStatusUpdates.length).toBe(2)
  })

  it('all-audio non-raw batch (single file) sets media_type=audio and skips frames', async () => {
    const { _uploadMultipleVideosHandler } = await import('../videos.js')

    // video_type !== 'raw' OR length === 1 → falls into the concat/single
    // branch, which we also patched. A single audio file is the simplest
    // path through that branch.
    const req = makeMultiReq({
      files: [{ originalname: 'solo.wav', mimetype: 'audio/wav' }],
      body: { video_type: 'broll', title: 'Solo audio' },
    })
    const res = makeRes()
    await _uploadMultipleVideosHandler(req, res)

    expect(res._status).toBe(201)
    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeDefined()
    expect(insert.sql).toMatch(/media_type/)
    expect(insert.args[insert.args.length - 1]).toBe('audio')
    // thumbnail_path arg position is 3rd (title, file_path, thumbnail_path, ...).
    expect(insert.args[2]).toBeNull()
    expect(extractThumbnailMock).not.toHaveBeenCalled()

    await new Promise(r => setImmediate(r))
    // Load-bearing: pins the `if (!isAudio) startBackgroundFrameExtraction`
    // gate in the non-raw / single-file branch of
    // _uploadMultipleVideosHandler. Removing the gate would fire frame
    // extraction and emit `UPDATE videos SET frames_status` calls.
    const framesStatusUpdate = dbCalls.find(c => /UPDATE videos SET frames_status/i.test(c.sql))
    expect(framesStatusUpdate).toBeUndefined()
  })
})

// Build a minimal req object for /register testing. Mirrors what the
// existing videos-register-duration tests pass through.
function makeRegisterReq(body = {}) {
  return { auth: { userId: 'test-user' }, body }
}

describe('POST /videos/register — audio media_type handling', () => {
  beforeEach(() => {
    dbCalls.length = 0
    extractVideoFrames.mockClear()
  })

  it('rejects audio + cf_stream_uid combo with HTTP 400', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    const req = makeRegisterReq({
      cf_stream_uid: 'cf-uid-bad',
      filename: 'voice.mp3',
      title: 'Voice over CF (forbidden)',
      group_id: 42,
      video_type: 'raw',
      file_size: 1000,
      media_type: 'audio',
    })
    const res = makeRes()
    await _registerVideoHandler(req, res)

    // Pin the exact contract: HTTP 400 + the specific error text. If the
    // CF-Stream rejection block is removed, this regresses immediately.
    expect(res._status).toBe(400)
    expect(res._body).toEqual({ error: 'Audio uploads cannot use Cloudflare Stream' })
    // No video row should have been inserted.
    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeUndefined()
  })

  it('persists media_type=audio when caller registers an audio file_url (no CF)', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    const req = makeRegisterReq({
      file_url: 'https://supabase.test/audio/voice.mp3',
      filename: 'voice.mp3',
      title: 'Voice over via storage',
      group_id: 42,
      video_type: 'raw',
      file_size: 1000,
      media_type: 'audio',
    })
    const res = makeRes()
    await _registerVideoHandler(req, res)

    expect(res._status).toBe(201)
    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeDefined()
    expect(insert.sql).toMatch(/media_type/)
    // media_type is the trailing positional arg in the new INSERT.
    expect(insert.args[insert.args.length - 1]).toBe('audio')

    // Load-bearing: startBackgroundFrameExtraction must not fire for audio
    // rows. The function's first state-changing SQL is `UPDATE videos SET
    // frames_status` — if the `!isAudio` gate is removed, that statement
    // appears in dbCalls and the test fails.
    await new Promise(r => setImmediate(r))
    const framesStatusUpdate = dbCalls.find(c => /UPDATE videos SET frames_status/i.test(c.sql))
    expect(framesStatusUpdate).toBeUndefined()
  })

  it('defaults media_type=video when not specified (regression for CF Stream callers)', async () => {
    const { _registerVideoHandler } = await import('../videos.js')

    const req = makeRegisterReq({
      cf_stream_uid: 'cf-uid-legit',
      filename: 'clip.mp4',
      title: 'CF Stream upload',
      group_id: 42,
      video_type: 'raw',
      file_size: 1000,
      // no media_type — old clients
    })
    const res = makeRes()
    await _registerVideoHandler(req, res)

    expect(res._status).toBe(201)
    const insert = dbCalls.find(c => /INSERT INTO videos/i.test(c.sql))
    expect(insert).toBeDefined()
    expect(insert.args[insert.args.length - 1]).toBe('video')
  })
})
