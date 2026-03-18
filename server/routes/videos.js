import { Router } from 'express'
import multer from 'multer'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, unlinkSync, copyFileSync, existsSync, statSync, writeFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import db from '../db.js'
import { transcribeVideo, findCutWords } from '../services/whisper.js'
import { extractThumbnail, getVideoDuration, checkFfmpeg, concatenateVideos } from '../services/video-processor.js'
import { analyzeMulticam } from '../services/multicam-sync.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads', 'videos')
const THUMBNAILS_DIR = join(__dirname, '..', '..', 'uploads', 'thumbnails')
mkdirSync(UPLOADS_DIR, { recursive: true })
mkdirSync(THUMBNAILS_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename(req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E6)
    cb(null, unique + extname(file.originalname))
  }
})
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } }) // 50GB limit

// Multer error handler wrapper
function handleUpload(fieldConfig) {
  return (req, res, next) => {
    const uploadHandler = typeof fieldConfig === 'string'
      ? upload.single(fieldConfig)
      : upload.array(fieldConfig.name, fieldConfig.maxCount)

    uploadHandler(req, res, (err) => {
      if (err) {
        console.error('[upload] Multer error:', err.message, err.code)
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File too large. Maximum size is 50GB.' })
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` })
      }
      next()
    })
  }
}

const router = Router()

/**
 * Insert [Xs] pause markers into a transcript using word timestamps.
 * Finds gaps > 1s between the end of one segment and start of the next.
 */
function addPauseMarkers(content, wordTimestampsJson) {
  if (!content || !wordTimestampsJson) return content
  // Only add if not already present
  if (content.includes('[') && /\[\d+s\]/.test(content)) return content

  let words
  try { words = JSON.parse(wordTimestampsJson) } catch { return content }
  if (!words || words.length === 0) return content

  // Parse transcript into timecoded blocks
  const blocks = content.split(/\n\n/)
  const result = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const tcMatch = block.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/)
    if (!tcMatch) { result.push(block); continue }

    const blockStart = +tcMatch[1] * 3600 + +tcMatch[2] * 60 + +tcMatch[3]

    if (i > 0) {
      // Find previous block's end time
      const prevMatch = blocks[i - 1].match(/^\[(\d{2}):(\d{2}):(\d{2})\]/)
      if (prevMatch) {
        const prevStart = +prevMatch[1] * 3600 + +prevMatch[2] * 60 + +prevMatch[3]
        // Estimate previous block end from word timestamps
        const prevWords = words.filter(w => Math.floor(w.start) >= prevStart && Math.floor(w.start) < blockStart)
        const prevEnd = prevWords.length > 0 ? prevWords[prevWords.length - 1].end : prevStart + 2
        const gap = Math.round(blockStart - prevEnd)
        if (gap > 1) {
          result.push(`[${gap}s]`)
        }
      }
    }
    result.push(block)
  }

  return result.join('\n\n')
}

/**
 * Run transcription in the background. Updates video.transcription_status as it progresses.
 * Survives browser close since it's a server-side promise, not tied to any HTTP response.
 */
function startBackgroundTranscription(videoId) {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  if (!video || !video.file_path) return

  db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = NULL WHERE id = ?')
    .run('pending', videoId)

  const actualPath = join(__dirname, '..', '..', video.file_path)
  const transcriptType = video.video_type === 'human_edited' ? 'human_edited' : 'raw'

  // Fire and forget — runs entirely on server
  ;(async () => {
    try {
      const onProgress = (stage) => {
        db.prepare('UPDATE videos SET transcription_status = ? WHERE id = ?').run(stage, videoId)
      }

      const result = await transcribeVideo(actualPath, onProgress)

      db.prepare(`
        INSERT INTO transcripts (video_id, type, content, word_timestamps_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id, type) DO UPDATE SET content = excluded.content, word_timestamps_json = excluded.word_timestamps_json
      `).run(videoId, transcriptType, result.formatted, JSON.stringify(result.words))

      if (result.duration && !video.duration_seconds) {
        db.prepare('UPDATE videos SET duration_seconds = ? WHERE id = ?').run(Math.round(result.duration), videoId)
      }

      // Cut word detection
      if (video.group_id && video.video_type === 'human_edited') {
        const rawSibling = db.prepare(
          "SELECT v.id FROM videos v WHERE v.group_id = ? AND v.video_type = 'raw' AND v.id != ?"
        ).get(video.group_id, videoId)
        if (rawSibling) {
          const rawTranscript = db.prepare(
            "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'"
          ).get(rawSibling.id)
          if (rawTranscript?.word_timestamps_json) {
            findCutWords(JSON.parse(rawTranscript.word_timestamps_json), result.words)
          }
        }
      }

      db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = NULL WHERE id = ?')
        .run('done', videoId)
      console.log(`[transcribe] Video ${videoId} done: ${result.words?.length} words`)

      // Check if this completes a multicam group that needs assembly
      if (video.group_id) {
        const group = db.prepare('SELECT * FROM video_groups WHERE id = ?').get(video.group_id)
        if (group?.assembly_status === 'transcribing') {
          const pending = db.prepare(`
            SELECT COUNT(*) as cnt FROM videos
            WHERE group_id = ? AND video_type = 'raw'
            AND (transcription_status IS NULL OR transcription_status NOT IN ('done', 'failed'))
          `).get(video.group_id)
          if (pending.cnt === 0) {
            console.log(`[transcribe] All videos in group ${video.group_id} done, starting multicam analysis`)
            analyzeMulticam(video.group_id)
          }
        }
      }
    } catch (err) {
      const reason = err.message || String(err)
      const status = err.status || ''
      const detail = reason.includes('OPENAI_API_KEY') || reason.includes('Missing credentials') ? 'OpenAI API key not configured or invalid'
        : status === 500 || reason.includes('500') ? `OpenAI server error (500) — their service may be down. Try again in a few minutes.`
        : status === 413 || reason.includes('413') ? 'Audio file too large for Whisper API (>25MB even after compression)'
        : reason.includes('ENOENT') ? `File not found: ${actualPath}`
        : reason.includes('25MB') ? 'Audio file too large for Whisper API (>25MB even after compression)'
        : reason.includes('timeout') ? 'Transcription timed out — file may be too long or server too slow'
        : reason.includes('API') ? reason
        : `Whisper error: ${reason}`
      console.error(`[transcribe] Video ${videoId} failed:`, detail)
      db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = ? WHERE id = ?')
        .run('failed', detail, videoId)
    }
  })()
}

// List all videos with their transcripts
router.get('/', (req, res) => {
  const videos = db.prepare(`
    SELECT v.*,
      vg.name AS group_name,
      vg.assembly_status AS group_assembly_status,
      vg.assembly_error AS group_assembly_error,
      (SELECT COUNT(*) FROM transcripts t WHERE t.video_id = v.id AND t.type = 'raw') AS has_raw,
      (SELECT COUNT(*) FROM transcripts t WHERE t.video_id = v.id AND t.type = 'human_edited') AS has_human_edited
    FROM videos v
    LEFT JOIN video_groups vg ON vg.id = v.group_id
    ORDER BY v.created_at DESC
  `).all()
  res.json(videos)
})

// Get video groups
router.get('/groups', (req, res) => {
  const groups = db.prepare(`
    SELECT vg.*,
      (SELECT COUNT(*) FROM videos v WHERE v.group_id = vg.id) AS video_count
    FROM video_groups vg
    ORDER BY vg.created_at DESC
  `).all()
  res.json(groups)
})

// Get group detail with assembled transcript
router.get('/groups/:id/detail', (req, res) => {
  const group = db.prepare('SELECT * FROM video_groups WHERE id = ?').get(req.params.id)
  if (!group) return res.status(404).json({ error: 'Group not found' })
  const videos = db.prepare('SELECT id, title, video_type, duration_seconds, transcription_status, transcription_error, thumbnail_path FROM videos WHERE group_id = ?').all(req.params.id)
  res.json({
    ...group,
    videos,
    assembly_details: group.assembly_details_json ? JSON.parse(group.assembly_details_json) : null,
  })
})

// Get single video with transcripts
router.get('/:id', (req, res) => {
  const video = db.prepare(`
    SELECT v.*, vg.name AS group_name
    FROM videos v
    LEFT JOIN video_groups vg ON vg.id = v.group_id
    WHERE v.id = ?
  `).get(req.params.id)
  if (!video) return res.status(404).json({ error: 'Video not found' })

  const transcriptsRaw = db.prepare('SELECT * FROM transcripts WHERE video_id = ?').all(req.params.id)

  // Add pause markers (cached in DB after first computation) and strip word_timestamps_json
  const transcripts = transcriptsRaw.map(t => {
    let content = t.content
    if (t.word_timestamps_json && content && !/\[\d+s\]/.test(content)) {
      content = addPauseMarkers(content, t.word_timestamps_json)
      // Cache: update stored transcript so we don't recompute next time
      db.prepare('UPDATE transcripts SET content = ? WHERE id = ?').run(content, t.id)
    }
    return { id: t.id, video_id: t.video_id, type: t.type, content, created_at: t.created_at }
  })

  // Get sibling videos in same group
  let groupVideos = []
  let groupTranscript = null
  let siblingTranscripts = []
  if (video.group_id) {
    groupVideos = db.prepare('SELECT id, title, video_type FROM videos WHERE group_id = ? AND id != ?').all(video.group_id, video.id)

    // Get group's assembled transcript (combined raw), cleaned of source headers
    const group = db.prepare('SELECT assembled_transcript, assembly_status FROM video_groups WHERE id = ?').get(video.group_id)
    if (group?.assembled_transcript) {
      groupTranscript = group.assembled_transcript
        .replace(/\[Source:[^\]]*\]\n*/g, '')
        .replace(/\[Additional from:[^\]]*\]\n*/g, '')
        .replace(/--- --- ---\n*/g, '')
        .trim()
    }

    // Get transcripts from sibling videos (e.g., human_edited from the edited version)
    for (const sib of groupVideos) {
      const sibT = db.prepare('SELECT id, type, content, word_timestamps_json FROM transcripts WHERE video_id = ?').all(sib.id)
      for (const t of sibT) {
        let content = t.content
        if (t.word_timestamps_json && content && !/\[\d+s\]/.test(content)) {
          content = addPauseMarkers(content, t.word_timestamps_json)
          db.prepare('UPDATE transcripts SET content = ? WHERE id = ?').run(content, t.id)
        }
        siblingTranscripts.push({ type: t.type, content, video_id: sib.id, video_title: sib.title })
      }
    }
  }

  res.json({ ...video, transcripts, groupVideos, groupTranscript, siblingTranscripts })
})

// Upload video file + transcribe
router.post('/upload', handleUpload('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' })
  console.log(`[upload] File received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`)

  const { title, video_type = 'raw', group_id, group_name, link_video_id } = req.body

  const videoName = title || req.file.originalname.replace(extname(req.file.originalname), '')
  const filePath = req.file.path

  // Create or use group
  let finalGroupId = group_id ? parseInt(group_id) : null
  if (!finalGroupId && group_name) {
    const result = db.prepare('INSERT INTO video_groups (name) VALUES (?)').run(group_name)
    finalGroupId = result.lastInsertRowid
  }

  // Link to existing video of opposite type
  if (!finalGroupId && link_video_id) {
    const linkedVideo = db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
    if (linkedVideo) {
      if (linkedVideo.group_id) {
        finalGroupId = linkedVideo.group_id
      } else {
        const groupResult = db.prepare('INSERT INTO video_groups (name) VALUES (?)').run(linkedVideo.title || videoName)
        finalGroupId = groupResult.lastInsertRowid
        db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
      }
    }
  }

  // Extract thumbnail
  let thumbnailPath = null
  const hasFfmpeg = await checkFfmpeg()
  if (hasFfmpeg) {
    const thumbFilename = req.file.filename.replace(extname(req.file.filename), '.jpg')
    thumbnailPath = await extractThumbnail(filePath, thumbFilename)
    if (thumbnailPath) {
      thumbnailPath = `/uploads/thumbnails/${thumbFilename}`
    }
  }

  // Get duration
  let duration = null
  if (hasFfmpeg) {
    duration = await getVideoDuration(filePath)
  }

  // Insert video record
  const result = db.prepare(
    'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(videoName, `/uploads/videos/${req.file.filename}`, thumbnailPath, video_type, finalGroupId, duration)

  const videoId = result.lastInsertRowid

  // Auto-start background transcription
  startBackgroundTranscription(videoId)

  res.status(201).json({
    videoId,
    video: db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId),
  })
})

// Upload multiple files — raw footage: individual transcription + multicam analysis; other: concatenate
router.post('/upload-multiple', handleUpload({ name: 'videos', maxCount: 20 }), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' })
  console.log(`[upload-multiple] ${req.files.length} files received: ${req.files.map(f => `${f.originalname} (${(f.size/1024/1024).toFixed(1)}MB)`).join(', ')}`)

  const { title, video_type = 'raw', link_video_id, order } = req.body

  // Reorder files if order provided (JSON array of indices)
  let orderedFiles = [...req.files]
  if (order) {
    try {
      const indices = JSON.parse(order)
      orderedFiles = indices.map(i => req.files[i])
    } catch {}
  }

  const hasFfmpeg = await checkFfmpeg()

  // RAW FOOTAGE + MULTIPLE FILES: save each individually for multicam analysis
  if (video_type === 'raw' && orderedFiles.length > 1) {
    const groupName = title || orderedFiles.map(f => f.originalname.replace(/\.[^.]+$/, '')).join(' + ')
    const groupResult = db.prepare('INSERT INTO video_groups (name, assembly_status) VALUES (?, ?)').run(groupName, 'transcribing')
    const groupId = groupResult.lastInsertRowid

    // Handle linking to existing video
    if (link_video_id) {
      const linked = db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
      if (linked) {
        if (linked.group_id) {
          // Move new group's future videos to existing group — actually, just update linked video into our new group
        }
        db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(groupId, linked.id)
      }
    }

    const videoIds = []
    for (const file of orderedFiles) {
      const vidName = file.originalname.replace(/\.[^.]+$/, '')

      let thumbPath = null
      if (hasFfmpeg) {
        const thumbFilename = file.filename.replace(extname(file.filename), '.jpg')
        thumbPath = await extractThumbnail(file.path, thumbFilename)
        if (thumbPath) thumbPath = `/uploads/thumbnails/${thumbFilename}`
      }

      let duration = null
      if (hasFfmpeg) duration = await getVideoDuration(file.path)

      const r = db.prepare(
        'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(vidName, `/uploads/videos/${file.filename}`, thumbPath, 'raw', groupId, duration)

      videoIds.push(r.lastInsertRowid)
    }

    // Start background transcription for each — multicam analysis triggers automatically when all done
    for (const vid of videoIds) startBackgroundTranscription(vid)

    return res.status(201).json({
      videoIds,
      groupId,
      multicam: true,
      videos: videoIds.map(id => db.prepare('SELECT * FROM videos WHERE id = ?').get(id)),
    })
  }

  // NON-RAW or SINGLE FILE: original concatenation behavior
  let finalFilePath, finalFilename
  if (orderedFiles.length === 1) {
    finalFilePath = orderedFiles[0].path
    finalFilename = orderedFiles[0].filename
  } else {
    if (!hasFfmpeg) {
      for (const f of req.files) { try { unlinkSync(f.path) } catch {} }
      return res.status(400).json({ error: 'FFmpeg is required to concatenate multiple files' })
    }

    const baseName = Date.now() + '-combined'
    const outputPath = join(UPLOADS_DIR, baseName + '.mp4')

    try {
      const actualPath = await concatenateVideos(orderedFiles.map(f => f.path), outputPath)
      finalFilePath = actualPath
      finalFilename = actualPath.split('/').pop()
    } catch (err) {
      for (const f of req.files) { try { unlinkSync(f.path) } catch {} }
      return res.status(500).json({ error: `Concatenation failed: ${err.message}` })
    }

    for (const f of orderedFiles) { try { unlinkSync(f.path) } catch {} }
  }

  const videoName = title || orderedFiles.map(f => f.originalname.replace(/\.[^.]+$/, '')).join(' + ')

  let finalGroupId = null
  if (link_video_id) {
    const linkedVideo = db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
    if (linkedVideo) {
      if (linkedVideo.group_id) {
        finalGroupId = linkedVideo.group_id
      } else {
        const groupResult = db.prepare('INSERT INTO video_groups (name) VALUES (?)').run(linkedVideo.title || videoName)
        finalGroupId = groupResult.lastInsertRowid
        db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
      }
    }
  }

  let thumbnailPath = null
  if (hasFfmpeg) {
    const thumbFilename = finalFilename.replace(extname(finalFilename), '.jpg')
    thumbnailPath = await extractThumbnail(finalFilePath, thumbFilename)
    if (thumbnailPath) thumbnailPath = `/uploads/thumbnails/${thumbFilename}`
  }

  let duration = null
  if (hasFfmpeg) duration = await getVideoDuration(finalFilePath)

  const result = db.prepare(
    'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(videoName, `/uploads/videos/${finalFilename}`, thumbnailPath, video_type, finalGroupId, duration)

  const videoId = result.lastInsertRowid
  startBackgroundTranscription(videoId)

  res.status(201).json({
    videoId,
    video: db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId),
  })
})

// Import from local file path (no browser upload needed)
router.post('/import-local', async (req, res) => {
  const { file_path, title, video_type = 'raw', link_video_id, auto_transcribe } = req.body

  if (!file_path) return res.status(400).json({ error: 'file_path is required' })
  if (!existsSync(file_path)) return res.status(400).json({ error: `File not found: ${file_path}` })

  const stat = statSync(file_path)
  console.log(`[import-local] Importing: ${file_path} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)

  const ext = extname(file_path)
  const filename = Date.now() + '-' + Math.round(Math.random() * 1E6) + ext
  const destPath = join(UPLOADS_DIR, filename)

  try {
    copyFileSync(file_path, destPath)
    console.log(`[import-local] Copied to: ${destPath}`)
  } catch (err) {
    return res.status(500).json({ error: `Failed to copy file: ${err.message}` })
  }

  const videoName = title || file_path.split('/').pop().replace(/\.[^.]+$/, '')

  // Handle linking
  let finalGroupId = null
  if (link_video_id) {
    const linkedVideo = db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
    if (linkedVideo) {
      if (linkedVideo.group_id) {
        finalGroupId = linkedVideo.group_id
      } else {
        const groupResult = db.prepare('INSERT INTO video_groups (name) VALUES (?)').run(linkedVideo.title || videoName)
        finalGroupId = groupResult.lastInsertRowid
        db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
      }
    }
  }

  // Extract thumbnail
  let thumbnailPath = null
  const hasFfmpeg = await checkFfmpeg()
  if (hasFfmpeg) {
    const thumbFilename = filename.replace(ext, '.jpg')
    thumbnailPath = await extractThumbnail(destPath, thumbFilename)
    if (thumbnailPath) thumbnailPath = `/uploads/thumbnails/${thumbFilename}`
  }

  let duration = null
  if (hasFfmpeg) duration = await getVideoDuration(destPath)

  const result = db.prepare(
    'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(videoName, `/uploads/videos/${filename}`, thumbnailPath, video_type, finalGroupId, duration)

  const videoId = result.lastInsertRowid
  console.log(`[import-local] Video created: id=${videoId}, title="${videoName}", type=${video_type}, duration=${duration}s`)

  // Auto-start background transcription
  if (auto_transcribe !== false) {
    startBackgroundTranscription(videoId)
  }

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  res.status(201).json({ videoId, video })
})

// Import from YouTube URL — downloads mp3 + thumbnail
router.post('/import-youtube', async (req, res) => {
  const { url, title, video_type = 'human_edited', link_video_id } = req.body

  if (!url) return res.status(400).json({ error: 'url is required' })

  // Verify yt-dlp is available
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 })
  } catch {
    return res.status(500).json({ error: 'yt-dlp is not installed. Run: brew install yt-dlp' })
  }

  const fileId = Date.now() + '-' + Math.round(Math.random() * 1E6)
  const mp3Path = join(UPLOADS_DIR, `${fileId}.mp3`)
  const thumbPath = join(THUMBNAILS_DIR, `${fileId}.jpg`)

  try {
    // Get video info first (title, duration)
    console.log(`[youtube] Fetching info: ${url}`)
    const { stdout: infoJson } = await execFileAsync('yt-dlp', [
      '--dump-json', '--no-download', url
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
    const info = JSON.parse(infoJson)
    const videoTitle = title || info.title || 'YouTube Video'
    const duration = Math.round(info.duration || 0)
    console.log(`[youtube] Title: "${videoTitle}", Duration: ${duration}s`)

    // Download audio as mp3
    console.log(`[youtube] Downloading audio...`)
    await execFileAsync('yt-dlp', [
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', mp3Path.replace('.mp3', '.%(ext)s'),
      url
    ], { timeout: 600000 }) // 10 min timeout

    // yt-dlp may add extension, find the actual file
    const actualMp3 = existsSync(mp3Path) ? mp3Path
      : existsSync(mp3Path.replace('.mp3', '.mp3')) ? mp3Path
      : null

    if (!actualMp3 || !existsSync(actualMp3)) {
      // Check for file with the id prefix
      const { readdirSync } = await import('fs')
      const found = readdirSync(UPLOADS_DIR).find(f => f.startsWith(fileId) && (f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.opus') || f.endsWith('.webm')))
      if (!found) throw new Error('Audio download completed but file not found')
      // If not mp3, it's fine — Whisper handles multiple formats
    }

    console.log(`[youtube] Audio downloaded: ${mp3Path}`)

    // Download thumbnail
    console.log(`[youtube] Downloading thumbnail...`)
    try {
      await execFileAsync('yt-dlp', [
        '--write-thumbnail', '--skip-download',
        '--convert-thumbnails', 'jpg',
        '-o', join(THUMBNAILS_DIR, fileId),
        url
      ], { timeout: 30000 })

      // yt-dlp saves as fileId.jpg
      if (!existsSync(thumbPath)) {
        // Try with .webp extension and convert
        const webpPath = join(THUMBNAILS_DIR, `${fileId}.webp`)
        if (existsSync(webpPath)) {
          try {
            await execFileAsync('ffmpeg', ['-i', webpPath, '-y', thumbPath], { timeout: 10000 })
            unlinkSync(webpPath)
          } catch { /* thumbnail is optional */ }
        }
      }
    } catch (err) {
      console.log(`[youtube] Thumbnail download failed (non-fatal): ${err.message}`)
    }

    const hasThumbnail = existsSync(thumbPath)

    // Handle group linking
    let finalGroupId = null
    if (link_video_id) {
      const linkedVideo = db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
      if (linkedVideo) {
        if (linkedVideo.group_id) {
          finalGroupId = linkedVideo.group_id
        } else {
          const groupResult = db.prepare('INSERT INTO video_groups (name) VALUES (?)').run(linkedVideo.title || videoTitle)
          finalGroupId = groupResult.lastInsertRowid
          db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
        }
      }
    }

    const result = db.prepare(
      'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds, youtube_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      videoTitle,
      `/uploads/videos/${fileId}.mp3`,
      hasThumbnail ? `/uploads/thumbnails/${fileId}.jpg` : null,
      video_type,
      finalGroupId,
      duration,
      url
    )

    const videoId = result.lastInsertRowid
    console.log(`[youtube] Video created: id=${videoId}`)

    // Auto-start background transcription
    startBackgroundTranscription(videoId)

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
    res.status(201).json({ videoId, video })

  } catch (err) {
    console.error(`[youtube] Error:`, err.message)
    // Clean up partial downloads
    try { unlinkSync(mp3Path) } catch {}
    try { unlinkSync(thumbPath) } catch {}
    res.status(500).json({ error: `YouTube import failed: ${err.message}` })
  }
})

// Transcribe a video using Whisper (non-blocking — runs in background)
router.post('/:id/transcribe', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id)
  if (!video) return res.status(404).json({ error: 'Video not found' })
  if (!video.file_path) return res.status(400).json({ error: 'No video file associated with this video' })

  // Don't start if already in progress
  if (video.transcription_status && !['done', 'failed'].includes(video.transcription_status)) {
    return res.json({ status: video.transcription_status, message: 'Transcription already in progress' })
  }

  startBackgroundTranscription(video.id)
  res.json({ status: 'pending', message: 'Transcription started' })
})

// Create video (manual, without file upload)
router.post('/', (req, res) => {
  const { title, youtube_url, duration_seconds, metadata, video_type, group_id } = req.body
  if (!title) return res.status(400).json({ error: 'Title is required' })

  const result = db.prepare(
    'INSERT INTO videos (title, youtube_url, duration_seconds, metadata_json, video_type, group_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, youtube_url || null, duration_seconds || null, JSON.stringify(metadata || {}), video_type || 'raw', group_id || null)

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(video)
})

// Create video group
router.post('/groups', (req, res) => {
  const { name } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })
  const result = db.prepare('INSERT INTO video_groups (name) VALUES (?)').run(name)
  const group = db.prepare('SELECT * FROM video_groups WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(group)
})

// Update video
router.put('/:id', (req, res) => {
  const { title, youtube_url, duration_seconds, metadata, video_type, group_id } = req.body
  db.prepare(
    'UPDATE videos SET title = ?, youtube_url = ?, duration_seconds = ?, metadata_json = ?, video_type = COALESCE(?, video_type), group_id = ? WHERE id = ?'
  ).run(title, youtube_url || null, duration_seconds || null, JSON.stringify(metadata || {}), video_type || null, group_id ?? null, req.params.id)

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id)
  res.json(video)
})

// Delete a group and all its videos (and all related experiment data)
router.delete('/groups/:id', (req, res) => {
  const videos = db.prepare('SELECT id FROM videos WHERE group_id = ?').all(req.params.id)
  for (const v of videos) {
    const runs = db.prepare('SELECT id FROM experiment_runs WHERE video_id = ?').all(v.id)
    for (const run of runs) {
      db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
      db.prepare('DELETE FROM metrics WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
      db.prepare('DELETE FROM analysis_records WHERE experiment_run_id = ?').run(run.id)
      db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ?').run(run.id)
    }
    db.prepare('DELETE FROM experiment_runs WHERE video_id = ?').run(v.id)
    db.prepare('DELETE FROM deletion_annotations WHERE video_id = ?').run(v.id)
    db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(v.id)
    db.prepare('DELETE FROM videos WHERE id = ?').run(v.id)
  }
  db.prepare('DELETE FROM video_groups WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// Delete video (and all related experiment data)
router.delete('/:id', (req, res) => {
  const id = req.params.id

  // Get group_id before deleting (to clean up empty groups after)
  const video = db.prepare('SELECT group_id FROM videos WHERE id = ?').get(id)
  const groupId = video?.group_id

  // Clean up experiment run data referencing this video
  const runs = db.prepare('SELECT id FROM experiment_runs WHERE video_id = ?').all(id)
  for (const run of runs) {
    db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
    db.prepare('DELETE FROM metrics WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
    db.prepare('DELETE FROM analysis_records WHERE experiment_run_id = ?').run(run.id)
    db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ?').run(run.id)
  }
  db.prepare('DELETE FROM experiment_runs WHERE video_id = ?').run(id)
  db.prepare('DELETE FROM deletion_annotations WHERE video_id = ?').run(id)
  db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(id)
  db.prepare('DELETE FROM videos WHERE id = ?').run(id)

  // Clean up empty group if this was the last video in it
  if (groupId) {
    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM videos WHERE group_id = ?').get(groupId)
    if (remaining.cnt === 0) {
      db.prepare('DELETE FROM video_groups WHERE id = ?').run(groupId)
    }
  }

  res.json({ success: true })
})

// Upload/update transcript for a video
router.put('/:id/transcript/:type', (req, res) => {
  const { id, type } = req.params
  const { content } = req.body

  if (!['raw', 'human_edited'].includes(type)) {
    return res.status(400).json({ error: 'Type must be raw or human_edited' })
  }
  if (!content) return res.status(400).json({ error: 'Content is required' })

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id)
  if (!video) return res.status(404).json({ error: 'Video not found' })

  db.prepare(`
    INSERT INTO transcripts (video_id, type, content)
    VALUES (?, ?, ?)
    ON CONFLICT(video_id, type) DO UPDATE SET content = excluded.content
  `).run(id, type, content)

  const transcript = db.prepare(
    'SELECT * FROM transcripts WHERE video_id = ? AND type = ?'
  ).get(id, type)
  res.json(transcript)
})

// Get transcript comparison (raw vs human)
router.get('/:id/comparison', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id)
  if (!video) return res.status(404).json({ error: 'Video not found' })

  const raw = db.prepare("SELECT * FROM transcripts WHERE video_id = ? AND type = 'raw'").get(req.params.id)
  const humanEdited = db.prepare("SELECT * FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(req.params.id)

  res.json({
    video,
    raw: raw?.content || null,
    human_edited: humanEdited?.content || null
  })
})

export default router
