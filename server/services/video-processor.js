import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync, readdirSync } from 'fs'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const THUMBNAILS_DIR = join(__dirname, '..', '..', 'uploads', 'thumbnails')
const FRAMES_DIR = join(__dirname, '..', '..', 'uploads', 'frames')
const TEMP_DIR = join(__dirname, '..', '..', 'uploads', 'temp')
mkdirSync(TEMP_DIR, { recursive: true })
mkdirSync(FRAMES_DIR, { recursive: true })

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
 * Extract energy envelope from a video's audio track.
 * Returns RMS energy per window (default 100ms) as 0-255 values.
 * Used for audio-based cross-correlation sync between multicam videos.
 */
export async function extractEnergyEnvelope(videoPath, { sampleRate = 8000, windowMs = 100 } = {}) {
  const tempPath = join(TEMP_DIR, `envelope-${Date.now()}-${Math.random().toString(36).slice(2)}.pcm`)

  try {
    // Extract mono raw PCM audio at 8kHz
    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-f', 's16le', '-y', tempPath,
    ], { timeout: 600000 })

    const buffer = readFileSync(tempPath)
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
    const durationSeconds = samples.length / sampleRate

    // Compute RMS energy per window
    const windowSize = Math.floor(sampleRate * windowMs / 1000) // 800 samples at 8kHz/100ms
    const numWindows = Math.floor(samples.length / windowSize)
    const envelope = new Array(numWindows)

    for (let w = 0; w < numWindows; w++) {
      const offset = w * windowSize
      let sumSq = 0
      for (let i = 0; i < windowSize; i++) {
        const s = samples[offset + i] / 32768 // normalize to [-1, 1]
        sumSq += s * s
      }
      const rms = Math.sqrt(sumSq / windowSize)
      envelope[w] = Math.min(255, Math.round(rms * 255))
    }

    return { envelope, durationSeconds }
  } finally {
    try { unlinkSync(tempPath) } catch {}
  }
}

/**
 * Extract speech-envelope waveform peaks for visual display and sync comparison.
 *
 * Pipeline (makes waveforms from different cameras visually comparable):
 * 1. Mono 16kHz PCM via FFmpeg with bandpass filter (200–6000 Hz speech range)
 *    — removes low rumble, AC hum, and high-frequency hiss
 * 2. Remove DC offset
 * 3. Compute RMS envelope per 10ms window (speech intensity, not raw samples)
 * 4. Noise gate: suppress windows below adaptive noise floor
 * 5. Normalize to consistent peak level across all tracks
 *
 * Returns flat array [min0, max0, min1, max1, ...] as signed bytes (-128..127)
 * at the requested peaks-per-second resolution (default 100).
 */
export async function extractWaveformPeaks(videoPath, { peaksPerSecond = 100 } = {}) {
  const sampleRate = 16000 // 16kHz — sufficient for speech, fast to process
  const tempPath = join(TEMP_DIR, `waveform-${Date.now()}-${Math.random().toString(36).slice(2)}.pcm`)

  try {
    // Extract mono PCM with bandpass filter (200-6000 Hz speech range)
    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-af', 'highpass=f=200,lowpass=f=6000',
      '-f', 's16le', '-y', tempPath,
    ], { timeout: 600000 })

    const buffer = readFileSync(tempPath)
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
    const durationSeconds = samples.length / sampleRate

    if (samples.length === 0) return { peaks: [], durationSeconds: 0 }

    // Remove DC offset
    let dcSum = 0
    for (let i = 0; i < samples.length; i++) dcSum += samples[i]
    const dcOffset = dcSum / samples.length
    const floats = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) floats[i] = (samples[i] - dcOffset) / 32768

    // Compute RMS envelope per 10ms window (speech envelope, not raw peaks)
    const rmsWindowSize = Math.floor(sampleRate * 0.01) // 160 samples at 16kHz
    const numRmsWindows = Math.floor(floats.length / rmsWindowSize)
    const rmsEnvelope = new Float32Array(numRmsWindows)

    for (let w = 0; w < numRmsWindows; w++) {
      const offset = w * rmsWindowSize
      let sumSq = 0
      for (let i = 0; i < rmsWindowSize; i++) {
        const s = floats[offset + i]
        sumSq += s * s
      }
      rmsEnvelope[w] = Math.sqrt(sumSq / rmsWindowSize)
    }

    // Adaptive noise floor: median of lowest 20% of non-zero RMS values
    const sorted = [...rmsEnvelope].filter(v => v > 0).sort((a, b) => a - b)
    const noiseFloor = sorted.length > 0
      ? sorted[Math.floor(sorted.length * 0.2)] * 1.5
      : 0

    // Noise gate: suppress windows below floor
    for (let w = 0; w < numRmsWindows; w++) {
      if (rmsEnvelope[w] < noiseFloor) rmsEnvelope[w] = 0
    }

    // Downsample RMS envelope to target peaks-per-second resolution
    const rmsPerSecond = sampleRate / rmsWindowSize // 1000 RMS windows/s at 16kHz/10ms
    const bucketSize = Math.max(1, Math.round(rmsPerSecond / peaksPerSecond))
    const numBuckets = Math.ceil(numRmsWindows / bucketSize)

    const bucketMax = new Float32Array(numBuckets)
    let globalMax = 0

    for (let b = 0; b < numBuckets; b++) {
      const start = b * bucketSize
      const end = Math.min(start + bucketSize, numRmsWindows)
      let bMax = 0
      for (let i = start; i < end; i++) {
        if (rmsEnvelope[i] > bMax) bMax = rmsEnvelope[i]
      }
      bucketMax[b] = bMax
      if (bMax > globalMax) globalMax = bMax
    }

    // Normalize to full -128..127 range (symmetric for WaveformData compatibility)
    if (globalMax === 0) globalMax = 1
    const peaks = new Array(numBuckets * 2)
    for (let b = 0; b < numBuckets; b++) {
      const normalized = Math.round((bucketMax[b] / globalMax) * 127)
      peaks[b * 2] = -normalized     // min (symmetric)
      peaks[b * 2 + 1] = normalized  // max
    }

    return { peaks, durationSeconds }
  } finally {
    try { unlinkSync(tempPath) } catch {}
  }
}

/**
 * Extract video frames as JPEG images for timeline thumbnails.
 * 1 frame per second, 160x90px, JPEG quality 6 (~2KB/frame).
 * Output: /uploads/frames/{videoId}/0.jpg, 1.jpg, 2.jpg, ...
 * Returns the frame count on success, or 0 on failure.
 */
export async function extractVideoFrames(videoPath, videoId) {
  const outDir = join(FRAMES_DIR, String(videoId))
  mkdirSync(outDir, { recursive: true })

  try {
    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-vf', 'fps=1,scale=160:90:flags=lanczos',
      '-q:v', '6',
      '-start_number', '0',
      '-y',
      join(outDir, '%d.jpg'),
    ], { timeout: 600000 }) // 10 min timeout

    // Count extracted frames
    const files = readdirSync(outDir).filter(f => f.endsWith('.jpg'))
    console.log(`[frames] Video ${videoId}: extracted ${files.length} frames`)
    return files.length
  } catch (e) {
    console.error(`[frames] Video ${videoId} extraction failed:`, e.message)
    return 0
  }
}

/**
 * Get video media info (resolution, fps, codec, filesize) using ffprobe.
 */
export async function getVideoMediaInfo(videoPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
      '-show_entries', 'format=size',
      '-of', 'json',
      videoPath,
    ], { timeout: 10000 })

    const data = JSON.parse(stdout)
    const videoStream = data.streams?.find(s => s.width && s.height) || data.streams?.[0] || {}
    const format = data.format || {}

    let fps = null
    if (videoStream.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split('/')
      if (den && +den > 0) fps = Math.round(+num / +den)
    }

    return {
      width: videoStream.width || null,
      height: videoStream.height || null,
      fps,
      codec: videoStream.codec_name || null,
      filesize: format.size ? parseInt(format.size) : null,
    }
  } catch {
    return null
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
