import { Router } from 'express'
import multer from 'multer'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, unlinkSync, rmSync, copyFileSync, existsSync, statSync, writeFileSync, createWriteStream } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import db from '../db.js'
import { requireAuth, isAdmin } from '../auth.js'
import { transcribeVideo, findCutWords } from '../services/whisper.js'
import { extractThumbnail, getVideoDuration, getVideoMediaInfo, checkFfmpeg, concatenateVideos, extractEnergyEnvelope, extractWaveformPeaks, extractVideoFrames } from '../services/video-processor.js'
import { analyzeMulticam, classifyVideosForReview } from '../services/multicam-sync.js'
import { runStageProgress } from '../services/llm-runner.js'
import { uploadFile, deleteByUrl, deleteFolder, downloadToTemp, uploadFrames, TEMP_DIR as STORAGE_TEMP_DIR } from '../services/storage.js'
import { createDirectUpload, deleteStream, getStreamStatus, isEnabled as cfStreamEnabled, waitForStreamReady, enableMp4Downloads, waitForMp4Ready, mp4Url as cfMp4Url, thumbnailUrl as cfThumbnailUrl } from '../services/cloudflare-stream.js'
// Lazy import to avoid blocking server startup
const annotationMapper = () => import('../services/annotation-mapper.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads', 'videos')
const THUMBNAILS_DIR = join(__dirname, '..', '..', 'uploads', 'thumbnails')
const TEMP_UPLOAD_DIR = join(__dirname, '..', '..', 'uploads', 'temp')
mkdirSync(UPLOADS_DIR, { recursive: true })
mkdirSync(THUMBNAILS_DIR, { recursive: true })
mkdirSync(TEMP_UPLOAD_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: TEMP_UPLOAD_DIR,
  filename(req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E6)
    cb(null, unique + extname(file.originalname))
  }
})
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } }) // 50GB limit

// Default rough-cut config written on group creation. The upload-config flow
// no longer surfaces the RoughCutConfigModal, so downstream pipeline stages
// (which still read rough_cut_config_json) need sensible defaults out of the
// box. Keys mirror the legacy modal: `cut` toggles what's stripped from the
// timeline, `identify` toggles what's flagged for review.
const DEFAULT_ROUGH_CUT_CONFIG = {
  cut: { silences: true, false_starts: false, filler_words: true, meta_commentary: false },
  identify: { repetition: true, lengthy: false, technical_unclear: false, irrelevance: false },
}

// Exported for unit testing. Validates the PUT /groups/:id payload shape.
// Returns { error: string | null } — a non-null error short-circuits the
// handler with 400. Unknown fields are silently ignored so callers can
// piecemeal patch a subset of columns.
export function validateGroupUpdate(body) {
  const VALID_LIBS = ['envato', 'artlist', 'storyblocks']
  const VALID_PATHS = ['hands-off', 'strategy-only', 'guided']

  if (body.libraries !== undefined) {
    if (!Array.isArray(body.libraries) || body.libraries.some(l => !VALID_LIBS.includes(l))) {
      return { error: 'libraries must be an array of: ' + VALID_LIBS.join(', ') }
    }
  }
  if (body.freepik_opt_in !== undefined && typeof body.freepik_opt_in !== 'boolean') {
    return { error: 'freepik_opt_in must be boolean' }
  }
  if (body.audience !== undefined && (typeof body.audience !== 'object' || body.audience === null)) {
    return { error: 'audience must be an object' }
  }
  if (body.path_id !== undefined && !VALID_PATHS.includes(body.path_id)) {
    return { error: 'path_id must be one of: ' + VALID_PATHS.join(', ') }
  }
  return { error: null }
}

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

// ── Startup: re-queue transcriptions that were interrupted by server restart ──
;(async () => {
  try {
    const stuck = await db.prepare(
      "SELECT id, title FROM videos WHERE transcription_status IN ('pending', 'waiting_for_cloudflare', 'downloading', 'extracting_audio', 'transcribing', 'processing') AND transcription_status != 'done'"
    ).all()
    if (stuck.length > 0) {
      console.log(`[transcribe] Re-queuing ${stuck.length} interrupted transcription(s)`)
      for (const v of stuck) {
        await db.prepare("UPDATE videos SET transcription_status = NULL WHERE id = ?").run(v.id)
        // Delay slightly to let server finish booting
        setTimeout(() => startBackgroundTranscription(v.id), 3000)
      }
    }
    // Also reset experiment runs stuck at 'running' (killed by server restart)
    const stuckRuns = await db.prepare(
      "SELECT id FROM experiment_runs WHERE status = 'running'"
    ).all()
    if (stuckRuns.length > 0) {
      console.log(`[startup] Resetting ${stuckRuns.length} stuck experiment run(s) to failed`)
      for (const r of stuckRuns) {
        await db.prepare("UPDATE experiment_runs SET status = 'failed', error_message = 'Interrupted by server restart' WHERE id = ?").run(r.id)
      }
    }
  } catch (err) {
    console.error('[startup] Startup cleanup failed:', err.message)
  }
})()

// ── Startup: backfill thumbnails for CF Stream videos that never got metadata ──
// processVideoMetadata is fire-and-forget, so earlier crashes could have
// interrupted it, leaving videos with a cf_stream_uid but no thumbnail_path.
;(async () => {
  try {
    const missingThumbs = await db.prepare(
      "SELECT id FROM videos WHERE cf_stream_uid IS NOT NULL AND (thumbnail_path IS NULL OR thumbnail_path = '')"
    ).all()
    if (missingThumbs.length > 0) {
      console.log(`[startup] Backfilling metadata for ${missingThumbs.length} CF Stream video(s) missing thumbnails`)
      for (const v of missingThumbs) {
        setTimeout(() => processVideoMetadata(v.id).catch(err =>
          console.error(`[startup] Metadata backfill failed for video ${v.id}:`, err.message)), 5000)
      }
    }
  } catch (err) {
    console.error('[startup] Thumbnail backfill check failed:', err.message)
  }
})()

// ── Transcription queue with concurrency control ────────────────────────
const TRANSCRIPTION_CONCURRENCY = 3
const transcriptionQueue = []     // [{ videoId, resolve }]
const activeTranscriptionIds = new Set()  // videoIds currently running
const queuedIds = new Set()              // videoIds waiting in queue
const abortControllers = new Map()       // videoId → AbortController
const classifyingGroups = new Set()      // groupId — in-flight auto-classification dedup

function enqueueTranscription(videoId) {
  // Dedup: skip if already running or already queued
  if (activeTranscriptionIds.has(videoId) || queuedIds.has(videoId)) {
    console.log(`[queue] Video ${videoId} already queued/active, skipping`)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    queuedIds.add(videoId)
    transcriptionQueue.push({ videoId, resolve })
    console.log(`[queue] Enqueued video ${videoId} (queued: ${transcriptionQueue.length}, active: ${activeTranscriptionIds.size})`)
    drainTranscriptionQueue()
  })
}

function drainTranscriptionQueue() {
  while (activeTranscriptionIds.size < TRANSCRIPTION_CONCURRENCY && transcriptionQueue.length > 0) {
    const { videoId, resolve } = transcriptionQueue.shift()
    queuedIds.delete(videoId)
    activeTranscriptionIds.add(videoId)
    const ac = new AbortController()
    abortControllers.set(videoId, ac)
    console.log(`[queue] Starting video ${videoId} (active: ${activeTranscriptionIds.size}, waiting: ${transcriptionQueue.length})`)
    runTranscription(videoId, ac.signal).finally(() => {
      activeTranscriptionIds.delete(videoId)
      abortControllers.delete(videoId)
      console.log(`[queue] Finished video ${videoId} (active: ${activeTranscriptionIds.size}, waiting: ${transcriptionQueue.length})`)
      resolve()
      drainTranscriptionQueue()
    })
  }
}

async function cancelGroupTranscriptions(groupId) {
  // Remove queued items for this group
  const videoIds = (await db.prepare('SELECT id FROM videos WHERE group_id = ?').all(groupId)).map(v => v.id)
  const idSet = new Set(videoIds)
  let removedFromQueue = 0
  for (let i = transcriptionQueue.length - 1; i >= 0; i--) {
    if (idSet.has(transcriptionQueue[i].videoId)) {
      const { videoId, resolve } = transcriptionQueue.splice(i, 1)[0]
      queuedIds.delete(videoId)
      resolve()
      removedFromQueue++
    }
  }
  // Abort active transcriptions for this group
  let aborted = 0
  for (const vid of videoIds) {
    const ac = abortControllers.get(vid)
    if (ac) { ac.abort(); aborted++ }
  }
  // Reset DB status for non-done videos
  await db.prepare(`
    UPDATE videos SET transcription_status = NULL, transcription_error = NULL
    WHERE group_id = ? AND (transcription_status IS NULL OR transcription_status NOT IN ('done'))
  `).run(groupId)
  console.log(`[cancel] Group ${groupId}: removed ${removedFromQueue} from queue, aborted ${aborted} active`)
  return { removedFromQueue, aborted }
}

// Auto-trigger classification once every video in a group has reached a terminal
// transcription state. Replaces the frontend-driven trigger in ProcessingModal
// which silently broke when the modal unmounted before its poll caught 'done',
// or when its groupId captured as NaN from a malformed URL — leaving groups
// permanently stuck at assembly_status=null. Only fires for groups that have
// never been classified; user-owned states (classified/confirmed/etc) are left
// alone so re-transcription doesn't blow away their sub-group splits.
async function maybeAutoClassify(groupId) {
  if (!groupId) return
  if (classifyingGroups.has(groupId)) return

  const pending = await db.prepare(
    "SELECT 1 FROM videos WHERE group_id = ? AND (transcription_status IS NULL OR transcription_status NOT IN ('done', 'failed')) LIMIT 1"
  ).get(groupId)
  if (pending) return

  const group = await db.prepare(
    'SELECT classification_json, assembly_status FROM video_groups WHERE id = ?'
  ).get(groupId)
  if (!group) return
  if (group.classification_json || group.assembly_status) return

  if (classifyingGroups.has(groupId)) return
  classifyingGroups.add(groupId)

  console.log(`[transcribe] Group ${groupId} — all transcriptions terminal, auto-triggering classification`)
  classifyVideosForReview(groupId)
    .catch(err => console.error(`[transcribe] Auto-classify failed for group ${groupId}:`, err.message))
    .finally(() => classifyingGroups.delete(groupId))
}

async function runTranscription(videoId, signal) {
  const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  if (!video) {
    console.error(`[transcribe] Video ${videoId} not found in DB — skipping`)
    return
  }
  if (!video.file_path && !video.cf_stream_uid) {
    console.error(`[transcribe] Video ${videoId} has no file_path or cf_stream_uid — skipping`)
    await db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = ? WHERE id = ?')
      .run('failed', 'No file path — video may not have uploaded correctly', videoId)
    return
  }

  // Skip if already transcribed (dedup safety)
  if (video.transcription_status === 'done') {
    console.log(`[transcribe] Video ${videoId} already done — skipping`)
    return
  }

  // Wait for Cloudflare Stream to finish transcoding if needed
  if (video.cf_stream_uid) {
    await db.prepare('UPDATE videos SET transcription_status = ? WHERE id = ?').run('waiting_for_cloudflare', videoId)
    console.log(`[transcribe] Video ${videoId} waiting for CF stream ${video.cf_stream_uid}...`)
    try {
      await waitForStreamReady(video.cf_stream_uid, 600000, signal)
      await enableMp4Downloads(video.cf_stream_uid)
      await waitForMp4Ready(video.cf_stream_uid, 300000, signal)
    } catch (err) {
      await db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = ? WHERE id = ?')
        .run('failed', `Cloudflare Stream not ready: ${err.message}`, videoId)
      return
    }
  }

  // Resolve download URL: prefer CF MP4, fall back to file_path
  const downloadUrl = video.cf_stream_uid ? cfMp4Url(video.cf_stream_uid) : video.file_path

  let actualPath
  let tempTranscribeFile = false
  try {
    if (downloadUrl.startsWith('http')) {
      // Short retry loop for transient network blips — MP4 readiness is already
      // verified above via waitForMp4Ready, so 404s here are rare edge propagation delays.
      let lastErr
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          actualPath = await downloadToTemp(downloadUrl, `transcribe-${video.id}-${Date.now()}.mp4`)
          break
        } catch (err) {
          lastErr = err
          if (attempt < 5) {
            console.log(`[transcribe] Video ${videoId} download attempt ${attempt} failed (${err.message}), retrying in 5s...`)
            await new Promise(r => setTimeout(r, 5000))
          }
        }
      }
      if (!actualPath) throw lastErr
      tempTranscribeFile = true
    } else {
      actualPath = join(__dirname, '..', '..', downloadUrl)
    }
  } catch (err) {
    await db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = ? WHERE id = ?')
      .run('failed', `Download failed: ${err.message}`, videoId)
    return
  }
  const transcriptType = video.video_type === 'human_edited' ? 'human_edited' : 'raw'

  console.log(`[transcribe] Video ${videoId} starting: ${video.title} (${actualPath})`)

  try {
    const onProgress = async (stage) => {
      if (signal?.aborted) throw new Error('Transcription cancelled')
      console.log(`[transcribe] Video ${videoId} → ${stage}`)
      await db.prepare('UPDATE videos SET transcription_status = ? WHERE id = ?').run(stage, videoId)
    }

    onProgress('downloading')
    const result = await transcribeVideo(actualPath, onProgress, signal)

    await db.prepare(`
      INSERT INTO transcripts (video_id, type, content, word_timestamps_json, alignment_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(video_id, type) DO UPDATE SET content = excluded.content, word_timestamps_json = excluded.word_timestamps_json, alignment_json = excluded.alignment_json
    `).run(videoId, transcriptType, result.formatted, JSON.stringify(result.words), result.alignment ? JSON.stringify(result.alignment) : null)

    if (result.duration && !video.duration_seconds) {
      await db.prepare('UPDATE videos SET duration_seconds = ? WHERE id = ?').run(Math.round(result.duration), videoId)
    }

    // Cut word detection
    if (video.group_id && video.video_type === 'human_edited') {
      const rawSibling = await db.prepare(
        "SELECT v.id FROM videos v WHERE v.group_id = ? AND v.video_type = 'raw' AND v.id != ?"
      ).get(video.group_id, videoId)
      if (rawSibling) {
        const rawTranscript = await db.prepare(
          "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'"
        ).get(rawSibling.id)
        if (rawTranscript?.word_timestamps_json) {
          findCutWords(JSON.parse(rawTranscript.word_timestamps_json), result.words)
        }
      }
    }

    await db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = NULL WHERE id = ?')
      .run('done', videoId)
    console.log(`[transcribe] Video ${videoId} DONE: ${result.words?.length} words`)

    maybeAutoClassify(video.group_id)

    // Clean up temp file if we downloaded from Supabase
    if (tempTranscribeFile) { try { unlinkSync(actualPath) } catch {} }
  } catch (err) {
    // Clean up temp file if we downloaded from Supabase
    if (tempTranscribeFile) { try { unlinkSync(actualPath) } catch {} }
    // Don't mark as failed if cancelled — cancelGroupTranscriptions handles cleanup
    if (signal?.aborted || err.message === 'Transcription cancelled') {
      console.log(`[transcribe] Video ${videoId} cancelled`)
      await db.prepare('UPDATE videos SET transcription_status = NULL, transcription_error = NULL WHERE id = ?').run(videoId)
      return
    }
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
    console.error(`[transcribe] Video ${videoId} FAILED:`, detail)
    console.error(`[transcribe] Video ${videoId} raw error:`, err)
    await db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = ? WHERE id = ?')
      .run('failed', detail, videoId)
    maybeAutoClassify(video.group_id)
  }
}

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
async function startBackgroundTranscription(videoId) {
  const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  if (!video) {
    console.error(`[transcribe] startBackgroundTranscription: video ${videoId} not found`)
    return
  }
  if (!video.file_path) {
    console.error(`[transcribe] startBackgroundTranscription: video ${videoId} has no file_path`)
    return
  }

  console.log(`[transcribe] startBackgroundTranscription: video ${videoId} "${video.title}" — enqueueing`)
  await db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = NULL WHERE id = ?')
    .run('pending', videoId)

  enqueueTranscription(videoId)
}

/**
 * Extract timeline frames in background. Fire-and-forget — doesn't block upload.
 */
async function startBackgroundFrameExtraction(videoId) {
  const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  if (!video?.file_path) return
  if (video.frames_status === 'done') return

  // file_path may be a Supabase URL or local path
  let actualPath
  let tempFrameFile = false
  if (video.file_path.startsWith('http')) {
    try {
      actualPath = await downloadToTemp(video.file_path, `frames-${video.id}-${Date.now()}.mp4`)
      tempFrameFile = true
    } catch (e) {
      console.error(`[frames] Failed to download video ${videoId} for frame extraction:`, e.message)
      await db.prepare('UPDATE videos SET frames_status = ? WHERE id = ?').run('failed', videoId)
      return
    }
  } else {
    actualPath = join(__dirname, '..', '..', video.file_path)
  }
  await db.prepare('UPDATE videos SET frames_status = ? WHERE id = ?').run('extracting', videoId)

  extractVideoFrames(actualPath, videoId)
    .then(async (count) => {
      // Upload extracted frames to Supabase Storage
      const localFramesDir = join(__dirname, '..', '..', 'uploads', 'frames', String(videoId))
      try {
        await uploadFrames(videoId, localFramesDir)
        // Clean up local frames after upload
        try { rmSync(localFramesDir, { recursive: true, force: true }) } catch {}
      } catch (e) {
        console.error(`[frames] Supabase upload failed for video ${videoId}:`, e.message)
      }
      // Clean up temp video file
      if (tempFrameFile) { try { unlinkSync(actualPath) } catch {} }
      await db.prepare('UPDATE videos SET frames_status = ? WHERE id = ?').run(count > 0 ? 'done' : 'failed', videoId)
    })
    .catch(async (e) => {
      if (tempFrameFile) { try { unlinkSync(actualPath) } catch {} }
      console.error(`[frames] Background extraction failed for video ${videoId}:`, e.message)
      await db.prepare('UPDATE videos SET frames_status = ? WHERE id = ?').run('failed', videoId)
    })
}

// List all videos with their transcripts
router.get('/', requireAuth, async (req, res) => {
  const videos = await db.prepare(`
    SELECT v.*,
      COALESCE(parent.name, vg.name) AS group_name,
      COALESCE(parent.assembly_status, vg.assembly_status) AS group_assembly_status,
      COALESCE(parent.assembly_error, vg.assembly_error) AS group_assembly_error,
      COALESCE(parent.id, vg.id) AS effective_group_id,
      COALESCE(parent.libraries_json, vg.libraries_json) AS group_libraries_json,
      COALESCE(parent.freepik_opt_in, vg.freepik_opt_in) AS group_freepik_opt_in,
      COALESCE(parent.audience_json, vg.audience_json) AS group_audience_json,
      COALESCE(parent.path_id, vg.path_id) AS group_path_id,
      (SELECT COUNT(*) FROM transcripts t WHERE t.video_id = v.id AND t.type = 'raw') AS has_raw,
      (SELECT COUNT(*) FROM transcripts t WHERE t.video_id = v.id AND t.type = 'human_edited') AS has_human_edited
    FROM videos v
    LEFT JOIN video_groups vg ON vg.id = v.group_id
    LEFT JOIN video_groups parent ON parent.id = vg.parent_group_id
    ${isAdmin(req) ? '' : 'WHERE vg.user_id = ?'}
    ORDER BY v.created_at DESC
  `).all(...(isAdmin(req) ? [] : [req.auth.userId]))
  // Remap group_id to parent for project list, and parse config JSON
  for (const v of videos) {
    if (v.effective_group_id) {
      v.group_id = v.effective_group_id
    }
    v.libraries = v.group_libraries_json ? JSON.parse(v.group_libraries_json) : []
    v.freepik_opt_in = v.group_freepik_opt_in === null || v.group_freepik_opt_in === undefined ? true : !!v.group_freepik_opt_in
    v.audience = v.group_audience_json ? JSON.parse(v.group_audience_json) : null
    v.path_id = v.group_path_id || null
    delete v.group_libraries_json
    delete v.group_freepik_opt_in
    delete v.group_audience_json
    delete v.group_path_id
  }
  res.json(videos)
})

// Get video groups
router.get('/groups', requireAuth, async (req, res) => {
  const groups = await db.prepare(`
    SELECT vg.*,
      (SELECT COUNT(*) FROM videos v WHERE v.group_id = vg.id) AS video_count
    FROM video_groups vg
    WHERE ${isAdmin(req) ? '' : 'vg.user_id = ? AND'} (vg.assembly_status IS NULL OR vg.assembly_status != 'deleting')
    ORDER BY vg.created_at DESC
  `).all(...(isAdmin(req) ? [] : [req.auth.userId]))
  res.json(groups)
})

// Get group detail with assembled transcript
router.get('/groups/:id/detail', requireAuth, async (req, res) => {
  const groupId = req.params.id
  const userScope = isAdmin(req) ? '' : 'AND user_id = ?'
  const userArgs = isAdmin(req) ? [] : [req.auth.userId]

  // Kick off the two independent reads in parallel — pg.Pool will use
  // two backends briefly under transaction mode and return them as
  // soon as the SELECTs finish.
  const [group, videos] = await Promise.all([
    db.prepare(`SELECT * FROM video_groups WHERE id = ? ${userScope}`).get(groupId, ...userArgs),
    db.prepare('SELECT id, title, video_type, duration_seconds, transcription_status, transcription_error, thumbnail_path, file_path, frames_status FROM videos WHERE group_id = ?').all(groupId),
  ])
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const relatedGroups = group.upload_batch_id
    ? await db.prepare(
        'SELECT id, name, assembly_status FROM video_groups WHERE upload_batch_id = ? AND id != ?'
      ).all(group.upload_batch_id, group.id)
    : []

  res.json({
    ...group,
    videos,
    relatedGroups,
    assembly_details: group.assembly_details_json ? JSON.parse(group.assembly_details_json) : null,
    timeline: group.timeline_json ? JSON.parse(group.timeline_json) : null,
    rough_cut_config: group.rough_cut_config_json ? JSON.parse(group.rough_cut_config_json) : null,
    libraries: group.libraries_json ? JSON.parse(group.libraries_json) : [],
    freepik_opt_in: group.freepik_opt_in === null || group.freepik_opt_in === undefined ? true : !!group.freepik_opt_in,
    audience: group.audience_json ? JSON.parse(group.audience_json) : null,
    path_id: group.path_id || null,
    editor_state: group.editor_state_json ? JSON.parse(group.editor_state_json) : null,
    annotations: group.annotations_json ? JSON.parse(group.annotations_json) : null,
  })
})

// Poll assembly status (lightweight — no JSON parsing)
router.get('/groups/:id/status', requireAuth, async (req, res) => {
  const row = await db.prepare(`SELECT assembly_status, assembly_error FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!row) return res.status(404).json({ error: 'Group not found' })
  res.json({ assembly_status: row.assembly_status, assembly_error: row.assembly_error })
})

// Get classification data + videos with media info
router.get('/groups/:id/classification', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id, name, assembly_status, assembly_error, classification_json FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // If confirmed, videos live in sub-groups — gather them all
  const isConfirmed = group.assembly_status === 'confirmed'
  let videos
  if (isConfirmed) {
    const subGroups = await db.prepare('SELECT id FROM video_groups WHERE parent_group_id = ?').all(req.params.id)
    const subIds = subGroups.map(sg => sg.id)
    if (subIds.length > 0) {
      videos = await db.prepare(`
        SELECT id, title, duration_seconds, thumbnail_path, media_info_json, file_path
        FROM videos WHERE group_id IN (${subIds.map(() => '?').join(',')}) AND video_type = 'raw' ORDER BY id
      `).all(...subIds)
    } else {
      videos = []
    }
  } else {
    videos = await db.prepare(`
      SELECT id, title, duration_seconds, thumbnail_path, media_info_json, file_path
      FROM videos WHERE group_id = ? AND video_type = 'raw' ORDER BY id
    `).all(req.params.id)
  }

  let classification = null
  try { classification = JSON.parse(group.classification_json) } catch {}

  // If no classification exists, build a default single-group one
  if (!classification) {
    classification = { groups: [{ name: 'MAIN', videoIds: videos.map(v => v.id) }], gemini: null }
  }

  const videosWithInfo = videos.map(v => {
    let mediaInfo = null
    try { mediaInfo = JSON.parse(v.media_info_json) } catch {}
    return { ...v, media_info: mediaInfo, media_info_json: undefined }
  })

  // Include sub-group info when confirmed
  let subGroups = null
  if (isConfirmed) {
    subGroups = await db.prepare('SELECT id, name, assembly_status FROM video_groups WHERE parent_group_id = ? ORDER BY id').all(req.params.id)
  }

  res.json({
    group: { id: group.id, name: group.name, assembly_status: group.assembly_status, assembly_error: group.assembly_error },
    classification,
    videos: videosWithInfo,
    subGroups,
  })
})

// Re-run Gemini classification (gathers split videos back from sub-groups first)
router.post('/groups/:id/reclassify', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const group = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // Gather videos back from child sub-groups
  const subGroups = await db.prepare('SELECT id FROM video_groups WHERE parent_group_id = ?').all(groupId)
  for (const sg of subGroups) {
    await db.prepare('UPDATE videos SET group_id = ? WHERE group_id = ?').run(groupId, sg.id)
    await db.prepare('DELETE FROM video_groups WHERE id = ?').run(sg.id)
  }
  if (subGroups.length > 0) {
    console.log(`[reclassify] Gathered videos back from ${subGroups.length} sub-groups into project ${groupId}`)
  }

  res.json({ ok: true, message: 'Reclassification started' })
  classifyVideosForReview(groupId)
})

// Save modified grouping from user
router.post('/groups/:id/update-classification', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id, classification_json FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const { groups } = req.body
  if (!Array.isArray(groups)) return res.status(400).json({ error: 'groups array required' })

  let existing = null
  try { existing = JSON.parse(group.classification_json) } catch {}

  const classification = {
    groups,
    gemini: existing?.gemini || null,
  }
  await db.prepare('UPDATE video_groups SET classification_json = ? WHERE id = ?')
    .run(JSON.stringify(classification), req.params.id)

  res.json({ ok: true, classification })
})

// Confirm classification → split groups + start sync
router.post('/groups/:id/confirm-classification', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const group = await db.prepare(`SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const { groups } = req.body
  if (!Array.isArray(groups) || groups.length === 0) return res.status(400).json({ error: 'groups array required' })

  // Project (original group) stays as parent container.
  // ALL videos move to new child sub-groups.
  const subGroupIds = []

  for (const g of groups) {
    const r = await db.prepare(
      'INSERT INTO video_groups (name, assembly_status, parent_group_id, user_id) VALUES (?, ?, ?, ?)'
    ).run(g.name, 'pending', groupId, req.auth.userId)
    const subId = r.lastInsertRowid
    subGroupIds.push(subId)

    if (g.videoIds?.length) {
      const placeholders = g.videoIds.map(() => '?').join(',')
      await db.prepare(`UPDATE videos SET group_id = ? WHERE id IN (${placeholders})`)
        .run(subId, ...g.videoIds)
    }
    console.log(`[confirm] Sub-group "${g.name}": ${g.videoIds?.length || 0} videos → group ${subId}`)
  }

  // Mark project as confirmed, store sub-group mapping
  await db.prepare('UPDATE video_groups SET assembly_status = ? WHERE id = ?')
    .run('confirmed', groupId)

  // Start sync for each sub-group
  for (const subId of subGroupIds) {
    analyzeMulticam(subId, { skipClassification: true })
  }

  res.json({ ok: true, groupIds: subGroupIds })
})

// Save editor state for a group
router.put('/groups/:id/editor-state', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  const { editor_state } = req.body
  await db.prepare('UPDATE video_groups SET editor_state_json = ? WHERE id = ?')
    .run(JSON.stringify(editor_state), req.params.id)
  res.json({ ok: true })
})

// Beacon endpoint for auto-save on unmount/tab close (sendBeacon sends POST with text/plain)
router.post('/groups/:id/editor-state-beacon', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  // sendBeacon may send as text/plain — parse manually if needed
  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { return res.status(400).json({ error: 'Invalid JSON' }) }
  }
  const { editor_state } = body
  if (editor_state) {
    await db.prepare('UPDATE video_groups SET editor_state_json = ? WHERE id = ?')
      .run(JSON.stringify(editor_state), req.params.id)
  }
  res.json({ ok: true })
})

// Extract frames for all videos in a group (for existing projects without frames)
router.post('/groups/:id/extract-frames', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  const videos = await db.prepare('SELECT id, file_path, frames_status FROM videos WHERE group_id = ?').all(req.params.id)
  let started = 0
  for (const v of videos) {
    if (v.frames_status === 'done' || v.frames_status === 'extracting') continue
    if (!v.file_path) continue
    startBackgroundFrameExtraction(v.id)
    started++
  }
  res.json({ ok: true, started, total: videos.length })
})

// Trigger main flow LLM pipeline for a group
router.post('/groups/:id/run-main-flow', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const force = req.query.force === 'true'
  console.log(`[run-main-flow] group=${groupId} userId=${req.auth.userId} email=${req.auth.email} isAdmin=${isAdmin(req)}`)
  const group = await db.prepare(`SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // Check if annotations already exist (with actual items)
  if (!force && group.annotations_json) {
    try {
      const ann = JSON.parse(group.annotations_json)
      if (ann?.items?.length > 0) {
        return res.json({ already_exists: true })
      }
      // Empty annotations — try to rebuild from completed run below
    } catch { /* invalid JSON, proceed */ }
  }

  // Check for a completed Auto: run that never had annotations built (e.g. after bug fix)
  if (!force) {
    const completedRun = await db.prepare(`
      SELECT er.id AS run_id, e.id AS experiment_id FROM experiment_runs er
      JOIN experiments e ON e.id = er.experiment_id
      WHERE er.video_id IN (SELECT id FROM videos WHERE group_id = ?)
        AND er.status = 'complete'
        AND e.name ILIKE 'Auto:%'
      ORDER BY er.id DESC LIMIT 1
    `).get(groupId)
    if (completedRun) {
      // Rebuild annotations from this completed run
      try {
        const { buildAnnotationsFromRun, getTimelineWordTimestamps } = await annotationMapper()
        const video = await db.prepare(`
          SELECT v.* FROM videos v
          JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
          WHERE v.group_id = ? AND v.video_type = 'raw'
          ORDER BY v.id LIMIT 1
        `).get(groupId)
        let wordTimestamps = await getTimelineWordTimestamps(groupId)
        if (!wordTimestamps?.length && video) {
          const transcript = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(video.id)
          if (transcript?.word_timestamps_json) try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch {}
        }
        if (wordTimestamps?.length) {
          const groupData = await db.prepare('SELECT assembled_transcript FROM video_groups WHERE id = ?').get(groupId)
          const annotations = await buildAnnotationsFromRun(completedRun.run_id, wordTimestamps, groupData?.assembled_transcript)
          console.log(`[run-main-flow] Rebuilt ${annotations.items.length} annotations from completed run ${completedRun.run_id} for group ${groupId}`)
          await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?').run(JSON.stringify(annotations), groupId)
          return res.json({ already_exists: true, rebuilt: true })
        }
      } catch (err) {
        console.error(`[run-main-flow] Rebuild from completed run failed:`, err.message)
      }
    }
  }

  // Clear old annotations so editor doesn't show stale results while new run is in progress
  if (force && group.annotations_json) {
    await db.prepare('UPDATE video_groups SET annotations_json = NULL WHERE id = ?').run(groupId)
  }

  // Clean up stale pending Auto: runs for this group (older than 5 minutes)
  await db.prepare(`
    UPDATE experiment_runs SET status = 'failed'
    WHERE id IN (
      SELECT er.id FROM experiment_runs er
      JOIN experiments e ON e.id = er.experiment_id
      WHERE er.video_id IN (SELECT id FROM videos WHERE group_id = ?)
        AND er.status = 'pending'
        AND e.name ILIKE 'Auto:%'
        AND er.created_at < NOW() - INTERVAL '5 minutes'
    )
  `).run(groupId)

  // Check if a run is actually in progress (running with live progress, or pending and very recent)
  const inProgressRun = await db.prepare(`
    SELECT er.id AS run_id, e.id AS experiment_id FROM experiment_runs er
    JOIN experiments e ON e.id = er.experiment_id
    WHERE er.video_id IN (SELECT id FROM videos WHERE group_id = ?)
      AND er.status IN ('pending', 'running')
      AND e.name ILIKE 'Auto:%'
    ORDER BY er.id DESC LIMIT 1
  `).get(groupId)
  if (inProgressRun) {
    // Only trust this if it's actually running (has live progress) or was created recently
    const hasLiveProgress = runStageProgress.has(inProgressRun.run_id)
    const run = await db.prepare('SELECT created_at FROM experiment_runs WHERE id = ?').get(inProgressRun.run_id)
    const ageMs = run ? Date.now() - new Date(run.created_at).getTime() : 999999
    const isRecent = ageMs < 60000 // less than 1 minute old

    if (hasLiveProgress || isRecent) {
      const version = await db.prepare(`
        SELECT sv.stages_json FROM experiments e
        JOIN strategy_versions sv ON sv.id = e.strategy_version_id
        WHERE e.id = ?
      `).get(inProgressRun.experiment_id)
      let stageNames = []
      try {
        const stages = JSON.parse(version?.stages_json || '[]')
        stageNames = stages.map((s, i) => s.name || `Stage ${i + 1}`)
      } catch { /* ignore */ }
      return res.json({ experimentId: inProgressRun.experiment_id, runId: inProgressRun.run_id, totalStages: stageNames.length, stageNames })
    }
    // Stale pending run — mark as failed and continue to create a new one
    await db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ?").run(inProgressRun.run_id)
  }

  // Check if too many failed runs — stop auto-creating after 2 failures
  // But if annotations were already cleared (user deleted run), reset failed runs to allow retry
  if (!group.annotations_json) {
    await db.prepare(`
      UPDATE experiment_runs SET status = 'cancelled'
      WHERE id IN (
        SELECT er.id FROM experiment_runs er
        JOIN experiments e ON e.id = er.experiment_id
        WHERE er.video_id IN (SELECT id FROM videos WHERE group_id = ?)
          AND er.status = 'failed'
          AND e.name ILIKE 'Auto:%'
      )
    `).run(groupId)
  }
  const failedCount = await db.prepare(`
    SELECT COUNT(*) AS cnt FROM experiment_runs er
    JOIN experiments e ON e.id = er.experiment_id
    WHERE er.video_id IN (SELECT id FROM videos WHERE group_id = ?)
      AND er.status = 'failed'
      AND e.name ILIKE 'Auto:%'
  `).get(groupId)
  if (failedCount.cnt >= 2) {
    return res.status(422).json({ error: 'too_many_failures', message: 'Auto-run failed multiple times. Please contact your admin to review and clear failed runs.' })
  }

  // Find is_main=1 strategy + latest version
  const mainStrategy = await db.prepare('SELECT * FROM strategies WHERE is_main = 1').get()
  if (!mainStrategy) return res.status(400).json({ error: 'No main strategy configured' })

  const version = await db.prepare(
    'SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version_number DESC LIMIT 1'
  ).get(mainStrategy.id)
  if (!version) return res.status(400).json({ error: 'Main strategy has no versions' })

  // Find the group's primary video with a transcript
  const video = await db.prepare(`
    SELECT v.* FROM videos v
    JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id = ? AND v.video_type = 'raw'
    ORDER BY v.id LIMIT 1
  `).get(groupId)
  if (!video) return res.status(400).json({ error: 'No video with transcript found' })

  // Create experiment + run records
  const expResult = await db.prepare(
    'INSERT INTO experiments (strategy_version_id, name, notes, video_ids_json, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(version.id, `Auto: ${mainStrategy.name}`, `Auto-run for group ${groupId}`, JSON.stringify([video.id]), req.auth.userId)

  const experimentId = Number(expResult.lastInsertRowid)
  const runResult = await db.prepare(
    'INSERT INTO experiment_runs (experiment_id, video_id, run_number, status) VALUES (?, ?, 1, ?)'
  ).run(experimentId, video.id, 'pending')

  const runId = Number(runResult.lastInsertRowid)

  // Parse stage info from the strategy version for immediate progress display
  let stageInfos = []
  try {
    const stages = JSON.parse(version.stages_json || '[]')
    stageInfos = stages.map((s, i) => ({
      name: s.name || `Stage ${i + 1}`,
      type: s.type || 'llm',
    }))
  } catch { /* ignore */ }

  // Return IDs immediately for polling
  res.json({ experimentId, runId, totalStages: stageInfos.length, stageNames: stageInfos.map(s => s.name), stageTypes: stageInfos.map(s => s.type) })

  // Execute in background with 1 auto-retry on failure
  ;(async () => {
    const MAX_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { executeRun } = await import('../services/llm-runner.js')

        // On retry, reset the same run record instead of creating a new one
        if (attempt > 1) {
          console.log(`[main-flow] Retry attempt ${attempt} for group ${groupId} (run ${runId})`)
          await db.prepare("UPDATE experiment_runs SET status = 'pending', error_message = NULL WHERE id = ?").run(runId)
        }

        await executeRun(runId)

        // Check if run completed
        const completedRun = await db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(runId)
        if (completedRun.status !== 'complete' && completedRun.status !== 'partial') {
          console.error(`[main-flow] Run ${runId} ended with status: ${completedRun.status}`)
          if (attempt < MAX_ATTEMPTS) continue // retry
          return
        }

        // Success — build annotations using merged timeline word timestamps
        const { buildAnnotationsFromRun, getTimelineWordTimestamps } = await annotationMapper()
        let wordTimestamps = await getTimelineWordTimestamps(groupId)

        // Fallback: single video if editor state not available
        if (!wordTimestamps?.length) {
          const transcript = await db.prepare(
            'SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = ?'
          ).get(video.id, 'raw')
          wordTimestamps = []
          if (transcript?.word_timestamps_json) {
            try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch { /* ignore */ }
          }
        }

        if (!wordTimestamps?.length) {
          console.log(`[main-flow] No word timestamps for group ${groupId}, skipping annotation mapping`)
          return
        }

        const groupData = await db.prepare('SELECT assembled_transcript FROM video_groups WHERE id = ?').get(groupId)
        const annotations = await buildAnnotationsFromRun(runId, wordTimestamps, groupData?.assembled_transcript)
        console.log(`[main-flow] Built ${annotations.items.length} annotations for group ${groupId}`)

        // Store annotations
        await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?')
          .run(JSON.stringify(annotations), groupId)
        return // success — exit retry loop
      } catch (err) {
        console.error(`[main-flow] Attempt ${attempt} failed for group ${groupId}:`, err.message)
        if (attempt >= MAX_ATTEMPTS) {
          console.error(`[main-flow] All attempts exhausted for group ${groupId}`)
        }
      }
    }
  })()
})

// ── Token system ────────────────────────────────────────────────────

async function getOrCreateTokenBalance(userId) {
  let row = await db.prepare('SELECT balance FROM user_tokens WHERE user_id = ?').get(userId)
  if (!row) {
    await db.prepare('INSERT INTO user_tokens (user_id, balance) VALUES (?, 10000) ON CONFLICT (user_id) DO NOTHING').run(userId)
    await db.prepare("INSERT INTO token_transactions (user_id, amount, balance_after, type, description) VALUES (?, 10000, 10000, 'initial', 'Welcome bonus')").run(userId)
    row = { balance: 10000 }
  }
  return row.balance
}

function estimateTokenCost(durationSeconds) {
  const minutes = (durationSeconds || 0) / 60
  return Math.max(1, Math.ceil(minutes * 30)) // 30 tokens per minute, minimum 1
}

function estimateProcessingTime(durationSeconds) {
  const minutes = (durationSeconds || 0) / 60
  return Math.round(minutes * 0.375 * 60) // 0.375 min processing per min of video → seconds
}

router.get('/user/tokens', requireAuth, async (req, res) => {
  const balance = await getOrCreateTokenBalance(req.auth.userId)
  res.json({ balance })
})

router.post('/groups/:id/estimate-ai-roughcut', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const group = await db.prepare(`SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const videos = await db.prepare('SELECT duration_seconds FROM videos WHERE group_id = ?').all(groupId)
  const totalDuration = videos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0)
  const tokenCost = estimateTokenCost(totalDuration)
  const estimatedTimeSeconds = estimateProcessingTime(totalDuration)
  const balance = await getOrCreateTokenBalance(req.auth.userId)

  res.json({ tokenCost, estimatedTimeSeconds, balance, sufficient: balance >= tokenCost, durationSeconds: totalDuration })
})

router.post('/groups/:id/start-ai-roughcut', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const group = await db.prepare(`SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // Calculate cost
  const videos = await db.prepare('SELECT duration_seconds FROM videos WHERE group_id = ?').all(groupId)
  const totalDuration = videos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0)
  const tokenCost = estimateTokenCost(totalDuration)

  // Transactional token deduction
  const client = await db.pool.connect()
  let balanceAfter
  try {
    await client.query('BEGIN')
    // Ensure user row exists
    await client.query('INSERT INTO user_tokens (user_id, balance) VALUES ($1, 10000) ON CONFLICT (user_id) DO NOTHING', [req.auth.userId])
    const { rows } = await client.query('SELECT balance FROM user_tokens WHERE user_id = $1 FOR UPDATE', [req.auth.userId])
    const currentBalance = rows[0]?.balance ?? 0

    if (currentBalance < tokenCost) {
      await client.query('ROLLBACK')
      return res.status(402).json({ error: 'insufficient_tokens', balance: currentBalance, required: tokenCost })
    }

    balanceAfter = currentBalance - tokenCost
    await client.query('UPDATE user_tokens SET balance = $1, updated_at = NOW() WHERE user_id = $2', [balanceAfter, req.auth.userId])
    await client.query(
      "INSERT INTO token_transactions (user_id, amount, balance_after, type, description, group_id) VALUES ($1, $2, $3, 'debit', $4, $5)",
      [req.auth.userId, -tokenCost, balanceAfter, `AI Rough Cut for project ${groupId}`, groupId]
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // ── Now execute the pipeline (same logic as run-main-flow lines 700-877) ──

  // Check existing annotations
  if (group.annotations_json) {
    try {
      const ann = JSON.parse(group.annotations_json)
      if (ann?.items?.length > 0 && !req.query.force) {
        return res.json({ already_exists: true, tokensDeducted: tokenCost, balanceAfter })
      }
    } catch { /* proceed */ }
  }

  // Clean up stale pending runs
  await db.prepare(`
    UPDATE experiment_runs SET status = 'failed'
    WHERE id IN (
      SELECT er.id FROM experiment_runs er
      JOIN experiments e ON e.id = er.experiment_id
      WHERE er.video_id IN (SELECT id FROM videos WHERE group_id = ?)
        AND er.status = 'pending'
        AND e.name ILIKE 'Auto:%'
        AND er.created_at < NOW() - INTERVAL '5 minutes'
    )
  `).run(groupId)

  // Find main strategy + version
  const mainStrategy = await db.prepare('SELECT * FROM strategies WHERE is_main = 1').get()
  if (!mainStrategy) return res.status(400).json({ error: 'No main strategy configured' })

  const version = await db.prepare(
    'SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version_number DESC LIMIT 1'
  ).get(mainStrategy.id)
  if (!version) return res.status(400).json({ error: 'Main strategy has no versions' })

  const video = await db.prepare(`
    SELECT v.* FROM videos v
    JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id = ? AND v.video_type = 'raw'
    ORDER BY v.id LIMIT 1
  `).get(groupId)
  if (!video) return res.status(400).json({ error: 'No video with transcript found' })

  const expResult = await db.prepare(
    'INSERT INTO experiments (strategy_version_id, name, notes, video_ids_json, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(version.id, `Auto: ${mainStrategy.name}`, `Auto-run for group ${groupId}`, JSON.stringify([video.id]), req.auth.userId)

  const experimentId = Number(expResult.lastInsertRowid)
  const runResult = await db.prepare(
    'INSERT INTO experiment_runs (experiment_id, video_id, run_number, status) VALUES (?, ?, 1, ?)'
  ).run(experimentId, video.id, 'pending')
  const runId = Number(runResult.lastInsertRowid)

  let stageInfos = []
  try {
    const stages = JSON.parse(version.stages_json || '[]')
    stageInfos = stages.map((s, i) => ({
      name: s.name || `Stage ${i + 1}`,
      type: s.type || 'llm',
    }))
  } catch {}

  res.json({
    experimentId, runId,
    totalStages: stageInfos.length,
    stageNames: stageInfos.map(s => s.name),
    stageTypes: stageInfos.map(s => s.type),
    tokensDeducted: tokenCost,
    balanceAfter,
  })

  // Execute pipeline in background (same as run-main-flow)
  ;(async () => {
    const MAX_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { executeRun } = await import('../services/llm-runner.js')
        if (attempt > 1) {
          console.log(`[start-ai-roughcut] Retry attempt ${attempt} for group ${groupId} (run ${runId})`)
          await db.prepare("UPDATE experiment_runs SET status = 'pending', error_message = NULL WHERE id = ?").run(runId)
        }
        await executeRun(runId)
        const completedRun = await db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(runId)
        if (completedRun.status !== 'complete' && completedRun.status !== 'partial') {
          if (attempt < MAX_ATTEMPTS) continue
          return
        }
        const { buildAnnotationsFromRun, getTimelineWordTimestamps } = await annotationMapper()
        let wordTimestamps = await getTimelineWordTimestamps(groupId)
        if (!wordTimestamps?.length) {
          const transcript = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(video.id)
          if (transcript?.word_timestamps_json) try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch {}
        }
        if (!wordTimestamps?.length) return
        const groupData = await db.prepare('SELECT assembled_transcript FROM video_groups WHERE id = ?').get(groupId)
        const annotations = await buildAnnotationsFromRun(runId, wordTimestamps, groupData?.assembled_transcript)
        await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?').run(JSON.stringify(annotations), groupId)
        return
      } catch (err) {
        console.error(`[start-ai-roughcut] Attempt ${attempt} failed for group ${groupId}:`, err.message)
      }
    }
  })()
})

// Rebuild annotations from existing run (re-maps without re-running LLMs)
router.post('/groups/:id/rebuild-annotations', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const group = await db.prepare(`SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  let annotations
  try { annotations = JSON.parse(group.annotations_json || 'null') } catch {}
  if (!annotations?.flowRunId) return res.status(400).json({ error: 'No existing annotations to rebuild' })

  const { buildAnnotationsFromRun, getTimelineWordTimestamps } = await annotationMapper()
  let wordTimestamps = await getTimelineWordTimestamps(groupId)
  if (!wordTimestamps?.length) {
    const video = await db.prepare("SELECT v.id FROM videos v JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw' WHERE v.group_id = ? ORDER BY v.id LIMIT 1").get(groupId)
    if (video) {
      const transcript = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(video.id)
      if (transcript?.word_timestamps_json) try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch {}
    }
  }
  if (!wordTimestamps?.length) return res.status(400).json({ error: 'No word timestamps' })

  const groupData = await db.prepare('SELECT assembled_transcript FROM video_groups WHERE id = ?').get(groupId)
  const rebuilt = await buildAnnotationsFromRun(annotations.flowRunId, wordTimestamps, groupData?.assembled_transcript)
  await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?').run(JSON.stringify(rebuilt), groupId)
  res.json({ success: true, items: rebuilt.items.length })
})

// Get word timestamps for all videos in a group
router.get('/groups/:id/word-timestamps', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  const rows = await db.prepare(`
    SELECT t.video_id, t.word_timestamps_json
    FROM transcripts t
    JOIN videos v ON v.id = t.video_id
    WHERE v.group_id = ? AND t.type = 'raw' AND t.word_timestamps_json IS NOT NULL
  `).all(req.params.id)
  const result = {}
  for (const row of rows) {
    try { result[row.video_id] = JSON.parse(row.word_timestamps_json) } catch { /* skip */ }
  }
  res.json(result)
})

// Get timeline JSON for a group
router.get('/groups/:id/timeline', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT timeline_json FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  if (!group.timeline_json) return res.status(404).json({ error: 'No timeline yet' })
  res.json(JSON.parse(group.timeline_json))
})

// Generate a minimal timeline with waveforms (for groups that skipped sync)
router.post('/groups/:id/generate-timeline', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT timeline_json FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  if (group.timeline_json) return res.json({ status: 'exists', message: 'Timeline already exists' })

  const videos = await db.prepare('SELECT id, title, file_path, duration_seconds, cf_stream_uid FROM videos WHERE group_id = ?').all(req.params.id)
  if (!videos.length) return res.status(400).json({ error: 'No videos in group' })

  const tracks = []
  const tempFiles = []
  for (const v of videos) {
    const track = { videoId: v.id, title: v.title, offset: 0, duration: v.duration_seconds || 0, waveformPeaks: [] }

    // For CF Stream videos, wait for the MP4 to be ready before attempting
    // download — otherwise we hit 404s and save an empty waveform.
    if (v.cf_stream_uid) {
      try {
        await waitForMp4Ready(v.cf_stream_uid, 180000)
      } catch (err) {
        console.error(`[generate-timeline] CF MP4 not ready for video ${v.id}: ${err.message}`)
      }
    }

    // Extract waveform
    const filePath = v.file_path
    if (filePath) {
      let fullPath
      if (filePath.startsWith('http')) {
        try {
          fullPath = await downloadToTemp(filePath, `waveform-${v.id}-${Date.now()}.mp4`)
          tempFiles.push(fullPath)
        } catch (e) {
          console.error(`[generate-timeline] Failed to download video ${v.id}:`, e.message)
        }
      } else {
        fullPath = join(__dirname, '..', '..', filePath)
      }
      if (fullPath) {
        try {
          console.log(`[generate-timeline] Extracting waveform for video ${v.id}...`)
          const { peaks, durationSeconds } = await extractWaveformPeaks(fullPath)
          track.waveformPeaks = peaks
          if (durationSeconds) track.duration = durationSeconds
        } catch (err) {
          console.error(`[generate-timeline] Waveform failed for video ${v.id}:`, err.message)
        }
      }
    }
    tracks.push(track)
  }

  for (const tf of tempFiles) { try { unlinkSync(tf) } catch {} }

  const timeline = { tracks }
  await db.prepare('UPDATE video_groups SET timeline_json = ? WHERE id = ?').run(JSON.stringify(timeline), req.params.id)

  res.json({ status: 'created', trackCount: tracks.length, hasWaveforms: tracks.some(t => t.waveformPeaks?.length > 0) })
})

// Regenerate waveform peaks for all tracks in a group's timeline
router.post('/groups/:id/regenerate-waveforms', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT timeline_json FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  if (!group.timeline_json) return res.status(404).json({ error: 'No timeline yet' })

  const timeline = JSON.parse(group.timeline_json)
  const videos = await db.prepare('SELECT id, file_path, cf_stream_uid FROM videos WHERE group_id = ?').all(req.params.id)
  const videoMap = Object.fromEntries(videos.map(v => [v.id, v]))

  let updated = 0
  const tempFiles = []
  for (const track of timeline.tracks) {
    const vid = videoMap[track.videoId]
    if (!vid?.file_path) continue
    const filePath = vid.file_path
    if (vid.cf_stream_uid) {
      try {
        await waitForMp4Ready(vid.cf_stream_uid, 180000)
      } catch (err) {
        console.error(`[waveform] CF MP4 not ready for video ${track.videoId}: ${err.message}`)
      }
    }
    let fullPath
    if (filePath.startsWith('http')) {
      try {
        fullPath = await downloadToTemp(filePath, `waveform-${track.videoId}-${Date.now()}.mp4`)
        tempFiles.push(fullPath)
      } catch (e) {
        console.error(`[waveform] Failed to download video ${track.videoId}:`, e.message)
        continue
      }
    } else {
      fullPath = join(__dirname, '..', '..', filePath)
    }
    try {
      console.log(`[waveform] Extracting peaks for video ${track.videoId}...`)
      const { peaks, durationSeconds } = await extractWaveformPeaks(fullPath)
      track.waveformPeaks = peaks
      if (durationSeconds) track.duration = durationSeconds
      updated++
    } catch (err) {
      console.error(`[waveform] Failed for video ${track.videoId}:`, err.message)
    }
  }
  // Clean up temp files
  for (const tf of tempFiles) { try { unlinkSync(tf) } catch {} }

  await db.prepare('UPDATE video_groups SET timeline_json = ? WHERE id = ?')
    .run(JSON.stringify(timeline), req.params.id)

  res.json({ updated, total: timeline.tracks.length })
})

// Cancel all transcriptions for a group
router.post('/groups/:id/cancel-transcriptions', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  const result = await cancelGroupTranscriptions(parseInt(req.params.id))
  res.json(result)
})

// Batch-start transcription for all untranscribed videos in a group (up to 3 concurrent)
router.post('/groups/:id/transcribe', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // Find all videos that need transcription (not done, not currently active)
  const videos = await db.prepare(`
    SELECT id, title, transcription_status, file_path, cf_stream_uid FROM videos
    WHERE group_id = ? AND (file_path IS NOT NULL OR cf_stream_uid IS NOT NULL)
    AND (transcription_status IS NULL OR transcription_status NOT IN ('done'))
    ORDER BY id ASC
  `).all(req.params.id)

  console.log(`[batch] Group ${req.params.id}: found ${videos.length} videos needing transcription:`,
    videos.map(v => `${v.id}:"${v.title}" (${v.transcription_status || 'null'})`).join(', '))

  let enqueued = 0
  for (const v of videos) {
    await db.prepare('UPDATE videos SET transcription_status = ?, transcription_error = NULL WHERE id = ?')
      .run('pending', v.id)
    enqueueTranscription(v.id)
    enqueued++
  }
  console.log(`[batch] Enqueued ${enqueued} videos (active: ${activeTranscriptionIds.size}, waiting: ${transcriptionQueue.length})`)
  res.json({ enqueued })
})

router.post('/groups/:id/rebuild-timeline', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const videos = await db.prepare(`
    SELECT v.id, v.title, v.duration_seconds, v.file_path, t.content AS transcript
    FROM videos v
    LEFT JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id = ? AND v.video_type = 'raw'
    ORDER BY v.id
  `).all(req.params.id)

  if (videos.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 raw videos for timeline' })
  }

  try {
    // Re-run clustering and timeline building inline
    const items = videos.map(v => ({
      ...v,
      words: v.transcript
        ? v.transcript.replace(/\[\d{2}:\d{2}:\d{2}\]/g, '').replace(/[.,!?;:'"()\-—]/g, '').toLowerCase().split(/\s+/).filter(w => w.length > 1)
        : [],
    }))

    // Pairwise overlap
    const overlap = {}
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const triA = new Set()
        for (let k = 0; k <= items[i].words.length - 3; k++) triA.add(`${items[i].words[k]} ${items[i].words[k+1]} ${items[i].words[k+2]}`)
        let hits = 0
        const countB = Math.max(1, items[j].words.length - 2)
        for (let k = 0; k <= items[j].words.length - 3; k++) {
          if (triA.has(`${items[j].words[k]} ${items[j].words[k+1]} ${items[j].words[k+2]}`)) hits++
        }
        overlap[`${i}-${j}`] = Math.min(1, hits / Math.min(triA.size, countB))
      }
    }

    // Cluster
    const parent = Array.from({ length: items.length }, (_, i) => i)
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++)
        if ((overlap[`${i}-${j}`] || 0) >= 0.30) parent[find(i)] = find(j)

    const clusterMap = {}
    for (let i = 0; i < items.length; i++) {
      const root = find(i)
      if (!clusterMap[root]) clusterMap[root] = []
      clusterMap[root].push(i)
    }
    const multicamClusters = Object.values(clusterMap).filter(g => g.length > 1)

    if (multicamClusters.length === 0) {
      return res.status(400).json({ error: 'No multicam clusters found (videos do not overlap)' })
    }

    // Import buildTimeline dynamically to avoid circular deps — it's in the same service
    const { buildTimelineForGroup } = await import('../services/multicam-sync.js')
    const timeline = await buildTimelineForGroup(req.params.id, multicamClusters, items)

    await db.prepare('UPDATE video_groups SET timeline_json = ? WHERE id = ?')
      .run(JSON.stringify(timeline), req.params.id)

    res.json(timeline)
  } catch (err) {
    console.error(`[timeline] Rebuild failed:`, err.message)
    res.status(500).json({ error: `Timeline rebuild failed: ${err.message}` })
  }
})

// Get single video with transcripts
router.get('/:id', requireAuth, async (req, res) => {
  const video = await db.prepare(`
    SELECT v.*, vg.name AS group_name
    FROM videos v
    LEFT JOIN video_groups vg ON vg.id = v.group_id
    WHERE v.id = ? ${isAdmin(req) ? '' : 'AND vg.user_id = ?'}
  `).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!video) return res.status(404).json({ error: 'Video not found' })

  const transcriptsRaw = await db.prepare('SELECT * FROM transcripts WHERE video_id = ?').all(req.params.id)

  // Add pause markers (cached in DB after first computation) and strip word_timestamps_json
  const transcripts = []
  for (const t of transcriptsRaw) {
    let content = t.content
    if (t.word_timestamps_json && content && !/\[\d+s\]/.test(content)) {
      content = addPauseMarkers(content, t.word_timestamps_json)
      // Cache: update stored transcript so we don't recompute next time
      await db.prepare('UPDATE transcripts SET content = ? WHERE id = ?').run(content, t.id)
    }
    transcripts.push({ id: t.id, video_id: t.video_id, type: t.type, content, created_at: t.created_at })
  }

  // Get sibling videos in same group
  let groupVideos = []
  let groupTranscript = null
  let siblingTranscripts = []
  if (video.group_id) {
    groupVideos = await db.prepare('SELECT id, title, video_type FROM videos WHERE group_id = ? AND id != ?').all(video.group_id, video.id)

    // Get group's assembled transcript (combined raw), cleaned of source headers
    const group = await db.prepare('SELECT assembled_transcript, assembly_status FROM video_groups WHERE id = ?').get(video.group_id)
    if (group?.assembled_transcript) {
      groupTranscript = group.assembled_transcript
        .replace(/\[Source:[^\]]*\]\n*/g, '')
        .replace(/\[Additional from:[^\]]*\]\n*/g, '')
        .replace(/--- --- ---\n*/g, '')
        .trim()
    }

    // Get transcripts from sibling videos (e.g., human_edited from the edited version)
    for (const sib of groupVideos) {
      const sibT = await db.prepare('SELECT id, type, content, word_timestamps_json FROM transcripts WHERE video_id = ?').all(sib.id)
      for (const t of sibT) {
        let content = t.content
        if (t.word_timestamps_json && content && !/\[\d+s\]/.test(content)) {
          content = addPauseMarkers(content, t.word_timestamps_json)
          await db.prepare('UPDATE transcripts SET content = ? WHERE id = ?').run(content, t.id)
        }
        siblingTranscripts.push({ type: t.type, content, video_id: sib.id, video_title: sib.title })
      }
    }
  }

  res.json({ ...video, transcripts, groupVideos, groupTranscript, siblingTranscripts })
})

// Background: extract thumbnail, duration, media info from a video URL
async function processVideoMetadata(videoId) {
  const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  if (!video?.file_path && !video?.cf_stream_uid) return

  // Cloudflare Stream path: get metadata from CF API (no FFmpeg needed)
  if (video.cf_stream_uid) {
    try {
      console.log(`[register] Waiting for CF stream ${video.cf_stream_uid} to be ready...`)
      const status = await waitForStreamReady(video.cf_stream_uid)
      await enableMp4Downloads(video.cf_stream_uid)
      const thumbnail = cfThumbnailUrl(video.cf_stream_uid)
      const duration = status.duration ? Math.round(status.duration) : null

      await db.prepare(
        'UPDATE videos SET thumbnail_path = ?, duration_seconds = ?, media_info_json = ? WHERE id = ?'
      ).run(thumbnail, duration, JSON.stringify({ source: 'cloudflare', uid: video.cf_stream_uid }), videoId)

      // Update file_path to CF MP4 URL now that it's ready
      if (!video.file_path || video.file_path.includes('videodelivery.net')) {
        await db.prepare('UPDATE videos SET file_path = ? WHERE id = ?').run(cfMp4Url(video.cf_stream_uid), videoId)
      }

      console.log(`[register] Metadata from CF for video ${videoId}: duration=${duration}s`)
    } catch (err) {
      console.error(`[register] CF metadata failed for video ${videoId}:`, err.message)
    }
    return
  }

  // Legacy path: download file and extract metadata with FFmpeg
  let tempPath = null
  try {
    tempPath = await downloadToTemp(video.file_path, `meta-${videoId}-${Date.now()}.mp4`)
    const hasFfmpeg = await checkFfmpeg()
    if (!hasFfmpeg) return

    const thumbFilename = `thumb-${videoId}-${Date.now()}.jpg`
    const localThumbPath = await extractThumbnail(tempPath, thumbFilename)
    let thumbnailUrl = null
    if (localThumbPath) {
      thumbnailUrl = await uploadFile('thumbnails', thumbFilename, localThumbPath)
      try { unlinkSync(localThumbPath) } catch {}
    }

    const duration = await getVideoDuration(tempPath)
    const mediaInfo = await getVideoMediaInfo(tempPath)

    await db.prepare(
      'UPDATE videos SET thumbnail_path = ?, duration_seconds = ?, media_info_json = ? WHERE id = ?'
    ).run(thumbnailUrl, duration, mediaInfo ? JSON.stringify(mediaInfo) : null, videoId)

    console.log(`[register] Metadata extracted for video ${videoId}: duration=${duration}s`)
  } catch (err) {
    console.error(`[register] Metadata extraction failed for video ${videoId}:`, err.message)
  } finally {
    if (tempPath?.includes('/temp/')) { try { unlinkSync(tempPath) } catch {} }
  }
}

// Get a Cloudflare Stream direct-upload URL
// TUS creation proxy — tus-js-client POSTs here, we forward to Cloudflare.
// This is the approach Cloudflare documents for direct creator uploads.
// tus-js-client then PATCHes directly to the CF URL returned in Location header.
router.post('/stream/tus-create', requireAuth, async (req, res) => {
  try {
    if (!cfStreamEnabled()) return res.status(400).json({ error: 'Cloudflare Stream not configured' })

    const uploadLength = req.headers['upload-length']
    if (!uploadLength) return res.status(400).end('Upload-Length header required')

    const CF_API = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/stream`
    const cfRes = await fetch(`${CF_API}?direct_user=true`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': uploadLength,
        'Upload-Metadata': req.headers['upload-metadata'] || '',
      },
    })

    if (!cfRes.ok) {
      const text = await cfRes.text()
      console.error('[cf-stream] TUS create failed:', cfRes.status, text)
      return res.status(cfRes.status).end(text)
    }

    const location = cfRes.headers.get('location')
    const streamMediaId = cfRes.headers.get('stream-media-id')
    console.log(`[cf-stream] TUS created: uid=${streamMediaId} location=${location}`)

    // Forward TUS headers to the client — tus-js-client reads these
    res.setHeader('Access-Control-Expose-Headers', 'Location, Tus-Resumable, Stream-Media-Id')
    res.setHeader('Location', location)
    res.setHeader('Tus-Resumable', '1.0.0')
    if (streamMediaId) res.setHeader('Stream-Media-Id', streamMediaId)
    res.status(201).end()
  } catch (err) {
    console.error('[cf-stream] TUS create error:', err.message)
    res.status(500).end(err.message)
  }
})

// Legacy JSON endpoint (kept for backward compat)
router.post('/stream/create-upload', requireAuth, async (req, res) => {
  try {
    if (!cfStreamEnabled()) return res.status(400).json({ error: 'Cloudflare Stream not configured' })
    const { maxDurationSeconds, file_size } = req.body
    if (!file_size) return res.status(400).json({ error: 'file_size is required' })
    const result = await createDirectUpload(file_size, maxDurationSeconds || 21600)
    res.json(result)
  } catch (err) {
    console.error('[cf-stream] Create upload error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Register a video already uploaded to Supabase Storage (direct browser upload)
router.post('/register', requireAuth, async (req, res) => {
  try {
    const { file_url, filename, title, group_id, video_type = 'raw', file_size, link_video_id, cf_stream_uid } = req.body

    if (!file_url && !cf_stream_uid) return res.status(400).json({ error: 'file_url or cf_stream_uid is required' })

    // For CF-only uploads, derive file_path from the CF MP4 URL
    const effectiveFileUrl = file_url || (cf_stream_uid ? cfMp4Url(cf_stream_uid) : null)
    const videoName = title || filename || 'Untitled'

    // Create or use group
    let finalGroupId = group_id ? parseInt(group_id) : null

    // Link to existing video
    if (!finalGroupId && link_video_id) {
      const linkedVideo = await db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
      if (linkedVideo) {
        if (linkedVideo.group_id) {
          finalGroupId = linkedVideo.group_id
        } else {
          const groupResult = await db.prepare('INSERT INTO video_groups (name, user_id) VALUES (?, ?)').run(linkedVideo.title || videoName, req.auth.userId)
          finalGroupId = groupResult.lastInsertRowid
          await db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
        }
      }
    }

    // Insert video record (metadata will be filled in background)
    const result = await db.prepare(
      'INSERT INTO videos (title, file_path, video_type, group_id, media_info_json, cf_stream_uid) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(videoName, effectiveFileUrl, video_type, finalGroupId, file_size ? JSON.stringify({ filesize: file_size }) : null, cf_stream_uid || null)

    const videoId = result.lastInsertRowid
    console.log(`[register] Video registered: id=${videoId}, title="${videoName}", cf_stream=${cf_stream_uid || 'none'}`)

    // Background: all run in parallel — don't wait for metadata before transcribing
    processVideoMetadata(videoId).catch(err => console.error(`[register] Metadata failed for video ${videoId}:`, err.message))
    startBackgroundTranscription(videoId)
    if (!cf_stream_uid) startBackgroundFrameExtraction(videoId) // Cloudflare handles thumbnails

    res.status(201).json({
      videoId,
      video: await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId),
    })
  } catch (err) {
    console.error('[register] Error:', err)
    res.status(500).json({ error: err.message || 'Registration failed' })
  }
})

// Upload video file + transcribe (legacy: small files via multer)
router.post('/upload', requireAuth, handleUpload('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' })
  try {
  console.log(`[upload] File received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`)

  const { title, video_type = 'raw', group_id, group_name, link_video_id } = req.body

  const videoName = title || req.file.originalname.replace(extname(req.file.originalname), '')
  const filePath = req.file.path

  // Create or use group
  let finalGroupId = group_id ? parseInt(group_id) : null
  if (!finalGroupId && group_name) {
    const result = await db.prepare('INSERT INTO video_groups (name, user_id) VALUES (?, ?)').run(group_name, req.auth.userId)
    finalGroupId = result.lastInsertRowid
  }

  // Link to existing video of opposite type
  if (!finalGroupId && link_video_id) {
    const linkedVideo = await db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
    if (linkedVideo) {
      if (linkedVideo.group_id) {
        finalGroupId = linkedVideo.group_id
      } else {
        const groupResult = await db.prepare('INSERT INTO video_groups (name, user_id) VALUES (?, ?)').run(linkedVideo.title || videoName, req.auth.userId)
        finalGroupId = groupResult.lastInsertRowid
        await db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
      }
    }
  }

  // Extract thumbnail (to local THUMBNAILS_DIR first)
  let thumbnailPath = null
  let localThumbPath = null
  const hasFfmpeg = await checkFfmpeg()
  if (hasFfmpeg) {
    const thumbFilename = req.file.filename.replace(extname(req.file.filename), '.jpg')
    localThumbPath = await extractThumbnail(filePath, thumbFilename)
    if (localThumbPath) {
      // Upload thumbnail to Supabase Storage
      thumbnailPath = await uploadFile('thumbnails', thumbFilename, localThumbPath)
    }
  }

  // Get duration + media info
  let duration = null
  let mediaInfo = null
  if (hasFfmpeg) {
    duration = await getVideoDuration(filePath)
    mediaInfo = await getVideoMediaInfo(filePath)
  }

  // Upload video to Supabase Storage
  const videoUrl = await uploadFile('videos', req.file.filename, filePath)

  // Insert video record
  const result = await db.prepare(
    'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds, media_info_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(videoName, videoUrl, thumbnailPath, video_type, finalGroupId, duration, mediaInfo ? JSON.stringify(mediaInfo) : null)

  const videoId = result.lastInsertRowid

  // Clean up local temp files
  try { unlinkSync(filePath) } catch {}
  if (localThumbPath) { try { unlinkSync(localThumbPath) } catch {} }

  // Auto-start background transcription + frame extraction
  startBackgroundTranscription(videoId)
  startBackgroundFrameExtraction(videoId)

  res.status(201).json({
    videoId,
    video: await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId),
  })
  } catch (err) {
    console.error('[upload] Error:', err)
    res.status(500).json({ error: err.message || 'Upload failed' })
  }
})

// Upload multiple files — raw footage: individual transcription + multicam analysis; other: concatenate
router.post('/upload-multiple', requireAuth, handleUpload({ name: 'videos', maxCount: 20 }), async (req, res) => {
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
    const groupResult = await db.prepare('INSERT INTO video_groups (name, assembly_status, user_id) VALUES (?, ?, ?)').run(groupName, 'transcribing', req.auth.userId)
    const groupId = groupResult.lastInsertRowid

    // Handle linking to existing video
    if (link_video_id) {
      const linked = await db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
      if (linked) {
        if (linked.group_id) {
          // Move new group's future videos to existing group — actually, just update linked video into our new group
        }
        await db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(groupId, linked.id)
      }
    }

    const videoIds = []
    for (const file of orderedFiles) {
      const vidName = file.originalname.replace(/\.[^.]+$/, '')

      let thumbPath = null
      let localThumbPath = null
      if (hasFfmpeg) {
        const thumbFilename = file.filename.replace(extname(file.filename), '.jpg')
        localThumbPath = await extractThumbnail(file.path, thumbFilename)
        if (localThumbPath) {
          thumbPath = await uploadFile('thumbnails', thumbFilename, localThumbPath)
        }
      }

      let duration = null
      let mediaInfo = null
      if (hasFfmpeg) {
        duration = await getVideoDuration(file.path)
        mediaInfo = await getVideoMediaInfo(file.path)
      }

      // Upload video to Supabase Storage
      const videoUrl = await uploadFile('videos', file.filename, file.path)

      const r = await db.prepare(
        'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds, media_info_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(vidName, videoUrl, thumbPath, 'raw', groupId, duration, mediaInfo ? JSON.stringify(mediaInfo) : null)

      videoIds.push(r.lastInsertRowid)

      // Clean up local temp files
      try { unlinkSync(file.path) } catch {}
      if (localThumbPath) { try { unlinkSync(localThumbPath) } catch {} }
    }

    // Start background transcription + frame extraction for each
    for (const vid of videoIds) {
      startBackgroundTranscription(vid)
      startBackgroundFrameExtraction(vid)
    }

    const videosResult = []
    for (const id of videoIds) {
      videosResult.push(await db.prepare('SELECT * FROM videos WHERE id = ?').get(id))
    }
    return res.status(201).json({
      videoIds,
      groupId,
      multicam: true,
      videos: videosResult,
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
    const outputPath = join(TEMP_UPLOAD_DIR, baseName + '.mp4')

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
    const linkedVideo = await db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
    if (linkedVideo) {
      if (linkedVideo.group_id) {
        finalGroupId = linkedVideo.group_id
      } else {
        const groupResult = await db.prepare('INSERT INTO video_groups (name, user_id) VALUES (?, ?)').run(linkedVideo.title || videoName, req.auth.userId)
        finalGroupId = groupResult.lastInsertRowid
        await db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
      }
    }
  }

  let thumbnailPath = null
  let localThumbPath = null
  if (hasFfmpeg) {
    const thumbFilename = finalFilename.replace(extname(finalFilename), '.jpg')
    localThumbPath = await extractThumbnail(finalFilePath, thumbFilename)
    if (localThumbPath) {
      thumbnailPath = await uploadFile('thumbnails', thumbFilename, localThumbPath)
    }
  }

  let duration = null
  let mediaInfo = null
  if (hasFfmpeg) {
    duration = await getVideoDuration(finalFilePath)
    mediaInfo = await getVideoMediaInfo(finalFilePath)
  }

  // Upload video to Supabase Storage
  const videoUrl = await uploadFile('videos', finalFilename, finalFilePath)

  const result = await db.prepare(
    'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds, media_info_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(videoName, videoUrl, thumbnailPath, video_type, finalGroupId, duration, mediaInfo ? JSON.stringify(mediaInfo) : null)

  const videoId = result.lastInsertRowid

  // Clean up local temp files
  try { unlinkSync(finalFilePath) } catch {}
  if (localThumbPath) { try { unlinkSync(localThumbPath) } catch {} }

  startBackgroundTranscription(videoId)
  startBackgroundFrameExtraction(videoId)

  res.status(201).json({
    videoId,
    video: await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId),
  })
})

// Import from local file path (no browser upload needed)
router.post('/import-local', requireAuth, async (req, res) => {
  const { file_path, title, video_type = 'raw', link_video_id, auto_transcribe } = req.body

  if (!file_path) return res.status(400).json({ error: 'file_path is required' })
  if (!existsSync(file_path)) return res.status(400).json({ error: `File not found: ${file_path}` })

  const stat = statSync(file_path)
  console.log(`[import-local] Importing: ${file_path} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)

  const ext = extname(file_path)
  const filename = Date.now() + '-' + Math.round(Math.random() * 1E6) + ext
  const destPath = join(TEMP_UPLOAD_DIR, filename)

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
    const linkedVideo = await db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
    if (linkedVideo) {
      if (linkedVideo.group_id) {
        finalGroupId = linkedVideo.group_id
      } else {
        const groupResult = await db.prepare('INSERT INTO video_groups (name, user_id) VALUES (?, ?)').run(linkedVideo.title || videoName, req.auth.userId)
        finalGroupId = groupResult.lastInsertRowid
        await db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
      }
    }
  }

  // Extract thumbnail
  let thumbnailPath = null
  let localThumbPath = null
  const hasFfmpeg = await checkFfmpeg()
  if (hasFfmpeg) {
    const thumbFilename = filename.replace(ext, '.jpg')
    localThumbPath = await extractThumbnail(destPath, thumbFilename)
    if (localThumbPath) {
      thumbnailPath = await uploadFile('thumbnails', thumbFilename, localThumbPath)
    }
  }

  let duration = null
  let mediaInfo = null
  if (hasFfmpeg) {
    duration = await getVideoDuration(destPath)
    mediaInfo = await getVideoMediaInfo(destPath)
  }

  // Upload video to Supabase Storage
  const videoUrl = await uploadFile('videos', filename, destPath)

  const result = await db.prepare(
    'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds, media_info_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(videoName, videoUrl, thumbnailPath, video_type, finalGroupId, duration, mediaInfo ? JSON.stringify(mediaInfo) : null)

  const videoId = result.lastInsertRowid
  console.log(`[import-local] Video created: id=${videoId}, title="${videoName}", type=${video_type}, duration=${duration}s`)

  // Clean up local temp files
  try { unlinkSync(destPath) } catch {}
  if (localThumbPath) { try { unlinkSync(localThumbPath) } catch {} }

  // Auto-start background transcription + frame extraction
  if (auto_transcribe !== false) {
    startBackgroundTranscription(videoId)
  }
  startBackgroundFrameExtraction(videoId)

  const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  res.status(201).json({ videoId, video })
})

// Import from YouTube URL — downloads mp3 + thumbnail
router.post('/import-youtube', requireAuth, async (req, res) => {
  const { url, title, video_type = 'human_edited', link_video_id } = req.body

  if (!url) return res.status(400).json({ error: 'url is required' })

  // Verify yt-dlp is available
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 })
  } catch {
    return res.status(500).json({ error: 'yt-dlp is not installed. Run: brew install yt-dlp' })
  }

  const fileId = Date.now() + '-' + Math.round(Math.random() * 1E6)
  const mp3Path = join(TEMP_UPLOAD_DIR, `${fileId}.mp3`)
  const thumbPath = join(TEMP_UPLOAD_DIR, `${fileId}.jpg`)

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
      const found = readdirSync(TEMP_UPLOAD_DIR).find(f => f.startsWith(fileId) && (f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.opus') || f.endsWith('.webm')))
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
        '-o', join(TEMP_UPLOAD_DIR, fileId),
        url
      ], { timeout: 30000 })

      // yt-dlp saves as fileId.jpg
      if (!existsSync(thumbPath)) {
        // Try with .webp extension and convert
        const webpPath = join(TEMP_UPLOAD_DIR, `${fileId}.webp`)
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

    // Upload to Supabase Storage
    const videoUrl = await uploadFile('videos', `${fileId}.mp3`, mp3Path)
    let thumbnailUrl = null
    if (hasThumbnail) {
      thumbnailUrl = await uploadFile('thumbnails', `${fileId}.jpg`, thumbPath)
    }

    // Handle group linking
    let finalGroupId = null
    if (link_video_id) {
      const linkedVideo = await db.prepare('SELECT * FROM videos WHERE id = ?').get(parseInt(link_video_id))
      if (linkedVideo) {
        if (linkedVideo.group_id) {
          finalGroupId = linkedVideo.group_id
        } else {
          const groupResult = await db.prepare('INSERT INTO video_groups (name, user_id) VALUES (?, ?)').run(linkedVideo.title || videoTitle, req.auth.userId)
          finalGroupId = groupResult.lastInsertRowid
          await db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(finalGroupId, linkedVideo.id)
        }
      }
    }

    const result = await db.prepare(
      'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds, youtube_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      videoTitle,
      videoUrl,
      thumbnailUrl,
      video_type,
      finalGroupId,
      duration,
      url
    )

    const videoId = result.lastInsertRowid
    console.log(`[youtube] Video created: id=${videoId}`)

    // Clean up local temp files
    try { unlinkSync(mp3Path) } catch {}
    if (hasThumbnail) { try { unlinkSync(thumbPath) } catch {} }

    // Auto-start background transcription + frame extraction
    startBackgroundTranscription(videoId)
    startBackgroundFrameExtraction(videoId)

    const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
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
router.post('/:id/transcribe', requireAuth, async (req, res) => {
  const video = await db.prepare(`SELECT * FROM videos v WHERE v.id = ? ${isAdmin(req) ? '' : 'AND v.group_id IN (SELECT id FROM video_groups WHERE user_id = ?)'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
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
router.post('/', requireAuth, async (req, res) => {
  const { title, youtube_url, duration_seconds, metadata, video_type, group_id } = req.body
  if (!title) return res.status(400).json({ error: 'Title is required' })

  const result = await db.prepare(
    'INSERT INTO videos (title, youtube_url, duration_seconds, metadata_json, video_type, group_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, youtube_url || null, duration_seconds || null, JSON.stringify(metadata || {}), video_type || 'raw', group_id || null)

  const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(video)
})

// Upload script file (no transcription, no thumbnail)
router.post('/upload-script', requireAuth, handleUpload('script'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No script file uploaded' })
  console.log(`[upload-script] File received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`)

  const { title, group_id } = req.body
  const scriptName = title || req.file.originalname.replace(extname(req.file.originalname), '')
  const finalGroupId = group_id ? parseInt(group_id) : null

  // Upload script to Supabase Storage
  const scriptUrl = await uploadFile('videos', req.file.filename, req.file.path)

  const result = await db.prepare(
    'INSERT INTO videos (title, file_path, video_type, group_id, media_type) VALUES (?, ?, ?, ?, ?)'
  ).run(scriptName, scriptUrl, 'raw', finalGroupId, 'script')

  // Clean up local temp file
  try { unlinkSync(req.file.path) } catch {}

  const videoId = result.lastInsertRowid
  res.status(201).json({
    videoId,
    title: scriptName,
    media_type: 'script',
  })
})

// Import file from URL (video or script)
router.post('/import-url', requireAuth, async (req, res) => {
  const { url, type = 'video', group_id, title } = req.body

  if (!url) return res.status(400).json({ error: 'Please enter a URL' })
  try { new URL(url) } catch { return res.status(400).json({ error: 'Please enter a valid URL' }) }

  const fileId = Date.now() + '-' + Math.round(Math.random() * 1E6)

  try {
    console.log(`[import-url] Fetching: ${url} (type=${type})`)
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

    // Determine extension from URL or content-type
    const urlPath = new URL(url).pathname
    let ext = extname(urlPath) || ''
    if (!ext) {
      const ct = response.headers.get('content-type') || ''
      if (ct.includes('pdf')) ext = '.pdf'
      else if (ct.includes('word') || ct.includes('docx')) ext = '.docx'
      else if (ct.includes('text/plain')) ext = '.txt'
      else if (ct.includes('video/mp4') || ct.includes('mp4')) ext = '.mp4'
      else if (ct.includes('video')) ext = '.mp4'
      else ext = type === 'script' ? '.txt' : '.mp4'
    }

    const filename = `${fileId}${ext}`
    const destPath = join(TEMP_UPLOAD_DIR, filename)

    // Stream to disk
    const fileStream = createWriteStream(destPath)
    const reader = response.body.getReader()
    let done = false
    while (!done) {
      const { value, done: d } = await reader.read()
      done = d
      if (value) fileStream.write(Buffer.from(value))
    }
    fileStream.end()
    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve)
      fileStream.on('error', reject)
    })

    const stat = statSync(destPath)
    console.log(`[import-url] Downloaded: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)

    const finalTitle = title || urlPath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Imported file'
    const finalGroupId = group_id ? parseInt(group_id) : null
    const mediaType = type === 'script' ? 'script' : 'video'

    if (mediaType === 'video') {
      // Extract thumbnail + duration + media info
      let thumbnailPath = null
      let localThumbPath = null
      let duration = null
      let mediaInfo = null
      const hasFfmpeg = await checkFfmpeg()
      if (hasFfmpeg) {
        const thumbFilename = filename.replace(ext, '.jpg')
        localThumbPath = await extractThumbnail(destPath, thumbFilename)
        if (localThumbPath) {
          thumbnailPath = await uploadFile('thumbnails', thumbFilename, localThumbPath)
        }
        duration = await getVideoDuration(destPath)
        mediaInfo = await getVideoMediaInfo(destPath)
      }

      // Upload video to Supabase Storage
      const videoUrl = await uploadFile('videos', filename, destPath)

      const result = await db.prepare(
        'INSERT INTO videos (title, file_path, thumbnail_path, video_type, group_id, duration_seconds, media_type, media_info_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(finalTitle, videoUrl, thumbnailPath, 'raw', finalGroupId, duration, 'video', mediaInfo ? JSON.stringify(mediaInfo) : null)

      const videoId = result.lastInsertRowid

      // Clean up local temp files
      try { unlinkSync(destPath) } catch {}
      if (localThumbPath) { try { unlinkSync(localThumbPath) } catch {} }

      startBackgroundTranscription(videoId)
      startBackgroundFrameExtraction(videoId)

      res.status(201).json({ videoId, title: finalTitle, media_type: 'video' })
    } else {
      // Upload script to Supabase Storage
      const scriptUrl = await uploadFile('videos', filename, destPath)

      const result = await db.prepare(
        'INSERT INTO videos (title, file_path, video_type, group_id, media_type) VALUES (?, ?, ?, ?, ?)'
      ).run(finalTitle, scriptUrl, 'raw', finalGroupId, 'script')

      // Clean up local temp file
      try { unlinkSync(destPath) } catch {}

      res.status(201).json({ videoId: result.lastInsertRowid, title: finalTitle, media_type: 'script' })
    }
  } catch (err) {
    console.error(`[import-url] Error:`, err.message)
    const msg = err.name === 'TimeoutError' ? 'Download timed out'
      : err.message.includes('HTTP') ? `Failed to fetch from URL: ${err.message}`
      : `Failed to fetch from URL: ${err.message}`
    res.status(500).json({ error: msg })
  }
})

// Create video group
router.post('/groups', requireAuth, async (req, res) => {
  const { name } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })
  // Write DEFAULT_ROUGH_CUT_CONFIG up front — downstream pipeline stages still
  // read rough_cut_config_json, and the new upload-config flow does not set
  // it explicitly (the RoughCutConfigModal is gone).
  const result = await db.prepare(
    'INSERT INTO video_groups (name, user_id, rough_cut_config_json) VALUES (?, ?, ?)'
  ).run(name, req.auth.userId, JSON.stringify(DEFAULT_ROUGH_CUT_CONFIG))
  const group = await db.prepare('SELECT * FROM video_groups WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(group)
})

// Update video group. Accepts a piecemeal patch — each field is optional and
// only present fields are written. See validateGroupUpdate for the rules.
router.put('/groups/:id', requireAuth, async (req, res) => {
  const validation = validateGroupUpdate(req.body)
  if (validation.error) return res.status(400).json({ error: validation.error })

  const { rough_cut_config_json, libraries, freepik_opt_in, audience, path_id } = req.body

  const group = await db.prepare(
    `SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`
  ).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const updates = []
  const values = []

  if (rough_cut_config_json !== undefined) {
    updates.push('rough_cut_config_json = ?')
    values.push(JSON.stringify(rough_cut_config_json))
  }
  if (libraries !== undefined) {
    updates.push('libraries_json = ?')
    values.push(JSON.stringify(libraries))
  }
  if (freepik_opt_in !== undefined) {
    updates.push('freepik_opt_in = ?')
    values.push(freepik_opt_in)
  }
  if (audience !== undefined) {
    updates.push('audience_json = ?')
    values.push(JSON.stringify(audience))
  }
  if (path_id !== undefined) {
    updates.push('path_id = ?')
    values.push(path_id)
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }

  values.push(req.params.id)
  await db.prepare(`UPDATE video_groups SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  const updated = await db.prepare('SELECT * FROM video_groups WHERE id = ?').get(req.params.id)
  res.json(updated)
})

// Start assembly for a group (called from SyncOptionsModal after user picks sync mode)
router.post('/groups/:id/start-assembly', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const { sync_mode } = req.body
  if (!sync_mode || !['sync', 'no_sync'].includes(sync_mode)) {
    return res.status(400).json({ error: 'sync_mode must be "sync" or "no_sync"' })
  }

  // Guard: all raw videos must have finished transcription
  const pending = await db.prepare(`
    SELECT COUNT(*) as cnt FROM videos
    WHERE group_id = ? AND video_type = 'raw'
    AND (transcription_status IS NULL OR transcription_status NOT IN ('done', 'failed'))
  `).get(req.params.id)
  if (pending.cnt > 0) {
    return res.status(400).json({ error: `${pending.cnt} video(s) still transcribing` })
  }

  await db.prepare('UPDATE video_groups SET sync_mode = ?, assembly_status = ?, editor_state_json = NULL WHERE id = ?')
    .run(sync_mode, 'pending', req.params.id)

  // Fire-and-forget: start assembly in background (skip classification — keep all videos in one project)
  analyzeMulticam(req.params.id, { syncMode: sync_mode, skipClassification: true })

  res.json({ status: 'started', sync_mode })
})

// Update video
router.put('/:id', requireAuth, async (req, res) => {
  const { title, youtube_url, duration_seconds, metadata, video_type, group_id } = req.body
  await db.prepare(
    `UPDATE videos SET title = ?, youtube_url = ?, duration_seconds = ?, metadata_json = ?, video_type = COALESCE(?, video_type), group_id = ? WHERE id = ? ${isAdmin(req) ? '' : 'AND group_id IN (SELECT id FROM video_groups WHERE user_id = ?)'}`
  ).run(title, youtube_url || null, duration_seconds || null, JSON.stringify(metadata || {}), video_type || null, group_id ?? null, req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))

  const video = await db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id)
  res.json(video)
})

// Delete a group and all its videos (and all related experiment data)
// Background worker: actually delete group data + storage files
async function purgeGroup(groupId) {
  try {
    // Clean up broll example sources/sets for this group
    const exampleSets = await db.prepare('SELECT id FROM broll_example_sets WHERE group_id = ?').all(groupId)
    for (const set of exampleSets) {
      await db.prepare('DELETE FROM broll_example_sources WHERE example_set_id = ?').run(set.id)
    }
    await db.prepare('DELETE FROM broll_example_sets WHERE group_id = ?').run(groupId)

    const videos = await db.prepare('SELECT id, file_path, thumbnail_path, cf_stream_uid FROM videos WHERE group_id = ?').all(groupId)
    for (const v of videos) {
      const runs = await db.prepare('SELECT id FROM experiment_runs WHERE video_id = ?').all(v.id)
      for (const run of runs) {
        await db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
        await db.prepare('DELETE FROM metrics WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
        await db.prepare('DELETE FROM analysis_records WHERE experiment_run_id = ?').run(run.id)
        await db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ?').run(run.id)
      }
      await db.prepare('DELETE FROM experiment_runs WHERE video_id = ?').run(v.id)
      await db.prepare('DELETE FROM deletion_annotations WHERE video_id = ?').run(v.id)
      await db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(v.id)
      await db.prepare('DELETE FROM videos WHERE id = ?').run(v.id)
      if (v.file_path?.startsWith('http')) { await deleteByUrl(v.file_path).catch(() => {}) }
      else if (v.file_path) { try { unlinkSync(join(__dirname, '..', '..', v.file_path)) } catch {} }
      if (v.thumbnail_path?.startsWith('http')) { await deleteByUrl(v.thumbnail_path).catch(() => {}) }
      else if (v.thumbnail_path) { try { unlinkSync(join(__dirname, '..', '..', v.thumbnail_path)) } catch {} }
      await deleteFolder('frames', String(v.id)).catch(() => {})
      try { rmSync(join(__dirname, '..', '..', 'uploads', 'frames', String(v.id)), { recursive: true }) } catch {}
      if (v.cf_stream_uid) await deleteStream(v.cf_stream_uid).catch(() => {})
    }
    // Delete child groups (sub-groups created during classification)
    await db.prepare('UPDATE video_groups SET parent_group_id = NULL WHERE parent_group_id = ?').run(groupId)
    await db.prepare('DELETE FROM video_groups WHERE id = ?').run(groupId)
    console.log(`[delete] Group ${groupId} purged (${videos.length} videos)`)
  } catch (err) {
    console.error(`[delete] Purge failed for group ${groupId}:`, err.message)
  }
}

router.delete('/groups/:id', requireAuth, async (req, res) => {
  const group = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // Soft-hide immediately: set a deleted marker so it disappears from lists
  await db.prepare("UPDATE video_groups SET name = name || ' [deleting]', assembly_status = 'deleting' WHERE id = ?").run(req.params.id)

  // Respond instantly
  res.json({ success: true })

  // Purge in background
  purgeGroup(req.params.id)
})

// Delete video (and all related experiment data)
router.delete('/:id', requireAuth, async (req, res) => {
  const id = req.params.id

  // Get video info before deleting (to clean up files + empty groups after)
  const video = await db.prepare(`SELECT group_id, file_path, thumbnail_path FROM videos WHERE id = ? ${isAdmin(req) ? '' : 'AND group_id IN (SELECT id FROM video_groups WHERE user_id = ?)'}`).get(id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!video) return res.status(404).json({ error: 'Video not found' })
  const groupId = video?.group_id

  // Clean up experiment run data referencing this video
  const runs = await db.prepare('SELECT id FROM experiment_runs WHERE video_id = ?').all(id)
  for (const run of runs) {
    await db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
    await db.prepare('DELETE FROM metrics WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
    await db.prepare('DELETE FROM analysis_records WHERE experiment_run_id = ?').run(run.id)
    await db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ?').run(run.id)
  }
  await db.prepare('DELETE FROM experiment_runs WHERE video_id = ?').run(id)
  await db.prepare('DELETE FROM deletion_annotations WHERE video_id = ?').run(id)
  await db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(id)
  await db.prepare('DELETE FROM videos WHERE id = ?').run(id)

  // Delete video file, thumbnail, and extracted frames from storage
  if (video?.file_path) {
    if (video.file_path.startsWith('http')) {
      await deleteByUrl(video.file_path)
    } else {
      const baseDir = join(__dirname, '..', '..')
      try { unlinkSync(join(baseDir, video.file_path)) } catch {}
    }
  }
  if (video?.thumbnail_path) {
    if (video.thumbnail_path.startsWith('http')) {
      await deleteByUrl(video.thumbnail_path)
    } else {
      const baseDir = join(__dirname, '..', '..')
      try { unlinkSync(join(baseDir, video.thumbnail_path)) } catch {}
    }
  }
  // Delete frames from Supabase and local
  await deleteFolder('frames', String(id))
  const framesDir = join(__dirname, '..', '..', 'uploads', 'frames', String(id))
  try { rmSync(framesDir, { recursive: true }) } catch {}

  // Clean up empty group if this was the last video in it
  if (groupId) {
    const remaining = await db.prepare('SELECT COUNT(*) AS cnt FROM videos WHERE group_id = ?').get(groupId)
    if (remaining.cnt === 0) {
      await db.prepare('DELETE FROM video_groups WHERE id = ?').run(groupId)
    }
  }

  res.json({ success: true })
})

// Upload/update transcript for a video
router.put('/:id/transcript/:type', requireAuth, async (req, res) => {
  const { id, type } = req.params
  const { content } = req.body

  if (!['raw', 'human_edited'].includes(type)) {
    return res.status(400).json({ error: 'Type must be raw or human_edited' })
  }
  if (!content) return res.status(400).json({ error: 'Content is required' })

  const video = await db.prepare(`SELECT * FROM videos v WHERE v.id = ? ${isAdmin(req) ? '' : 'AND v.group_id IN (SELECT id FROM video_groups WHERE user_id = ?)'}`).get(id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!video) return res.status(404).json({ error: 'Video not found' })

  await db.prepare(`
    INSERT INTO transcripts (video_id, type, content)
    VALUES (?, ?, ?)
    ON CONFLICT(video_id, type) DO UPDATE SET content = excluded.content
  `).run(id, type, content)

  const transcript = await db.prepare(
    'SELECT * FROM transcripts WHERE video_id = ? AND type = ?'
  ).get(id, type)
  res.json(transcript)
})

// Get transcript comparison (raw vs human)
router.get('/:id/comparison', requireAuth, async (req, res) => {
  const video = await db.prepare(`SELECT * FROM videos v WHERE v.id = ? ${isAdmin(req) ? '' : 'AND v.group_id IN (SELECT id FROM video_groups WHERE user_id = ?)'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!video) return res.status(404).json({ error: 'Video not found' })

  const raw = await db.prepare("SELECT * FROM transcripts WHERE video_id = ? AND type = 'raw'").get(req.params.id)
  const humanEdited = await db.prepare("SELECT * FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(req.params.id)

  res.json({
    video,
    raw: raw?.content || null,
    human_edited: humanEdited?.content || null
  })
})

export default router
