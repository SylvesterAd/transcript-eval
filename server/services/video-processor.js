import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, writeFileSync, unlinkSync } from 'fs'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const THUMBNAILS_DIR = join(__dirname, '..', '..', 'uploads', 'thumbnails')

/**
 * Extract a thumbnail from a video file using ffmpeg.
 * Takes a frame at 2 seconds (or 0 if video is shorter).
 */
export async function extractThumbnail(videoPath, outputFilename) {
  const outputPath = join(THUMBNAILS_DIR, outputFilename)

  try {
    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-ss', '2',
      '-vframes', '1',
      '-vf', 'scale=320:-1',
      '-q:v', '3',
      '-y',
      outputPath,
    ], { timeout: 15000 })

    return outputPath
  } catch {
    // Try at 0 seconds if 2s fails (very short video)
    try {
      await execFileAsync('ffmpeg', [
        '-i', videoPath,
        '-ss', '0',
        '-vframes', '1',
        '-vf', 'scale=320:-1',
        '-q:v', '3',
        '-y',
        outputPath,
      ], { timeout: 15000 })
      return outputPath
    } catch {
      return null
    }
  }
}

/**
 * Get video duration in seconds using ffprobe.
 */
export async function getVideoDuration(videoPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      videoPath,
    ], { timeout: 10000 })

    return Math.round(parseFloat(stdout.trim()))
  } catch {
    return null
  }
}

/**
 * Concatenate multiple video/audio files into one.
 * Extracts audio only (mp3) since we only need it for transcription — much faster than re-encoding video.
 */
export async function concatenateVideos(filePaths, outputPath) {
  // Force mp3 output for speed
  const mp3Output = outputPath.replace(/\.[^.]+$/, '.mp3')
  const listPath = mp3Output + '.concat.txt'

  try {
    // Step 1: Extract audio from each file as intermediate mp3s
    const tempFiles = []
    for (let i = 0; i < filePaths.length; i++) {
      const tempMp3 = mp3Output + `.part${i}.mp3`
      console.log(`[concat] Extracting audio from file ${i + 1}/${filePaths.length}...`)
      await execFileAsync('ffmpeg', [
        '-i', filePaths[i],
        '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k',
        '-y', tempMp3,
      ], { timeout: 600000 })
      tempFiles.push(tempMp3)
    }

    // Step 2: Concat the mp3s with demuxer (same format, fast)
    const listContent = tempFiles.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
    writeFileSync(listPath, listContent)

    console.log(`[concat] Concatenating ${tempFiles.length} audio files...`)
    await execFileAsync('ffmpeg', [
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-y', mp3Output,
    ], { timeout: 300000 })

    // Clean up temp parts
    for (const f of tempFiles) { try { unlinkSync(f) } catch {} }

    console.log(`[concat] Done: ${mp3Output}`)
    return mp3Output
  } finally {
    try { unlinkSync(listPath) } catch {}
  }
}

/**
 * Check if ffmpeg is available on the system.
 */
export async function checkFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}
