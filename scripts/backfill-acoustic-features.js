// scripts/backfill-acoustic-features.js
//
// Usage:
//   node --env-file=.env scripts/backfill-acoustic-features.js <video_id> [--force]
//
// Downloads (if file_path is a URL) or reads (if local) the audio for a video,
// runs server/services/extract_acoustic_features.py, and stores the result on
// the existing transcripts row. Idempotent — skips videos that already have
// acoustic_features_json unless --force is passed.

import db from '../server/db.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, writeFileSync, unlinkSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

async function main() {
  const args = process.argv.slice(2)
  const videoId = parseInt(args.find(a => /^\d+$/.test(a)), 10)
  const force = args.includes('--force')
  if (Number.isNaN(videoId)) {
    console.error('usage: node scripts/backfill-acoustic-features.js <video_id> [--force]')
    process.exit(1)
  }

  const video = await db.prepare('SELECT id, file_path, video_type FROM videos WHERE id = ?').get(videoId)
  if (!video) {
    console.error(`video ${videoId} not found`)
    process.exit(1)
  }
  if (!video.file_path) {
    console.error(`video ${videoId} has no file_path`)
    process.exit(1)
  }

  const transcriptType = video.video_type === 'human_edited' ? 'human_edited' : 'raw'
  const transcript = await db.prepare(
    'SELECT id, acoustic_features_json IS NOT NULL AS has_features FROM transcripts WHERE video_id = ? AND type = ?'
  ).get(videoId, transcriptType)
  if (!transcript) {
    console.error(`video ${videoId} has no ${transcriptType} transcript`)
    process.exit(1)
  }
  if (transcript.has_features && !force) {
    console.log(`video ${videoId} already has acoustic_features_json (use --force to overwrite)`)
    process.exit(0)
  }

  // Resolve file_path → local audio. Mirrors whisper.js extractAudio:
  // for any video format (mp4/webm/mov), ffmpeg streams just the audio
  // track to a small mp3. For native audio (mp3/m4a/wav) we download as-is.
  // Either way librosa reads a small audio file, not a multi-hundred-MB mp4.
  let localPath = video.file_path
  let tempPath = null
  const isAudioFormat = /\.(mp3|m4a|wav)(\?|$)/i.test(video.file_path)
  if (/^https?:/.test(video.file_path)) {
    const dir = mkdtempSync(join(tmpdir(), 'acoustic-'))
    if (isAudioFormat) {
      const ext = video.file_path.match(/\.(mp3|m4a|wav)(\?|$)/i)[1].toLowerCase()
      tempPath = join(dir, `audio.${ext}`)
      console.log(`[backfill] Downloading audio ${video.file_path} → ${tempPath}`)
      const resp = await fetch(video.file_path)
      if (!resp.ok) throw new Error(`download failed: ${resp.status}`)
      const buf = Buffer.from(await resp.arrayBuffer())
      writeFileSync(tempPath, buf)
    } else {
      tempPath = join(dir, 'audio.mp3')
      console.log(`[backfill] ffmpeg-extracting audio from ${video.file_path} → ${tempPath}`)
      // -vn (no video), -ac 1 (mono), -ar 22050 (matches librosa target sr),
      // -b:a 48k (cheap), -y (overwrite). ffmpeg pulls remote input directly.
      await execFileAsync('ffmpeg', [
        '-i', video.file_path, '-vn', '-ac', '1', '-ar', '22050', '-b:a', '48k', '-y', tempPath,
      ], { timeout: 600000, maxBuffer: 50 * 1024 * 1024 })
    }
    localPath = tempPath
    console.log(`[backfill] Audio file size: ${(statSync(tempPath).size / 1024 / 1024).toFixed(1)} MB`)
  }

  // Pick interpreter
  const venvPython = join(REPO_ROOT, '.venv', 'bin', 'python')
  const py = existsSync(venvPython) ? venvPython : 'python3'
  const script = join(REPO_ROOT, 'server', 'services', 'extract_acoustic_features.py')

  console.log(`[backfill] Running ${py} ${script} ${localPath}`)
  const t0 = Date.now()
  const { stdout } = await execFileAsync(py, [script, localPath], {
    timeout: 600000,
    maxBuffer: 200 * 1024 * 1024,
  })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  let features
  try { features = JSON.parse(stdout) } catch (e) {
    console.error('[backfill] Could not parse extractor output:', e.message)
    process.exit(2)
  }

  console.log(`[backfill] Extracted ${features.frames?.length} frames in ${elapsed}s (duration ${features.duration_s}s)`)
  console.log(`[backfill] JSON size: ${(stdout.length / 1024).toFixed(1)} KB`)

  await db.prepare(
    'UPDATE transcripts SET acoustic_features_json = ? WHERE id = ?'
  ).run(stdout, transcript.id)
  console.log(`[backfill] Stored on transcript ${transcript.id}`)

  if (tempPath) {
    try { unlinkSync(tempPath) } catch {}
  }
  process.exit(0)
}

main().catch(err => {
  console.error('[backfill] failed:', err)
  process.exit(1)
})
