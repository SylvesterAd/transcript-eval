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

// Capture every prepared statement and the args passed to .run().
const dbCalls = []

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      get: () => null,
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
  extractVideoFrames: vi.fn(),
  concatenateVideos: vi.fn(),
}))

vi.mock('../../services/storage.js', () => ({
  uploadFile: vi.fn().mockResolvedValue('https://supabase.test/upload-url'),
  deleteByUrl: vi.fn(),
  deleteFolder: vi.fn(),
  downloadToTemp: vi.fn(),
  uploadFrames: vi.fn(),
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
  })
})
