import OpenAI from 'openai'
import { createReadStream, statSync, unlinkSync, readdirSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const execFileAsync = promisify(execFile)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = join(__dirname, '..', '..', 'uploads', 'temp')
mkdirSync(TEMP_DIR, { recursive: true })

/** Get audio duration in seconds via ffprobe */
async function getAudioDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ], { timeout: 30000 })
    return parseFloat(stdout.trim()) || 0
  } catch { return 0 }
}

/**
 * Extract audio from video, compressed for Whisper.
 * If the result exceeds 24MB, split into chunks.
 * Returns { single: path } or { chunks: [{ path, startSec }] }
 */
async function extractAudio(filePath) {
  const outputPath = join(TEMP_DIR, `whisper-${Date.now()}.mp3`)

  // Try mono 48kbps first (good quality/size balance for speech)
  await execFileAsync('ffmpeg', [
    '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-y', outputPath,
  ], { timeout: 600000 })

  const stat = statSync(outputPath)
  const sizeMB = stat.size / 1024 / 1024
  console.log(`[whisper] Extracted audio: ${sizeMB.toFixed(1)}MB`)

  if (sizeMB <= 24) return { single: outputPath }

  // Too large — split into chunks
  console.log(`[whisper] Audio ${sizeMB.toFixed(1)}MB exceeds 25MB limit, splitting into chunks...`)

  const duration = await getAudioDuration(outputPath)
  if (duration <= 0) throw new Error('Could not determine audio duration')

  // Calculate chunk duration to keep each under 20MB (safe margin)
  // At 48kbps mono: 20MB / (48000/8) bytes per sec ≈ 3333 seconds ≈ 55 min
  // But be conservative: target ~20 min chunks
  const chunkSec = Math.floor(Math.min(1200, (20 / sizeMB) * duration))
  const numChunks = Math.ceil(duration / chunkSec)
  console.log(`[whisper] Splitting ${Math.round(duration)}s audio into ${numChunks} chunks of ~${chunkSec}s`)

  const chunks = []
  for (let i = 0; i < numChunks; i++) {
    const startSec = i * chunkSec
    const chunkPath = join(TEMP_DIR, `whisper-${Date.now()}-chunk${i}.mp3`)
    await execFileAsync('ffmpeg', [
      '-i', outputPath,
      '-ss', String(startSec),
      '-t', String(chunkSec),
      '-c', 'copy',  // no re-encoding needed, just copy the mp3 stream
      '-y', chunkPath,
    ], { timeout: 120000 })

    const chunkStat = statSync(chunkPath)
    console.log(`[whisper] Chunk ${i + 1}/${numChunks}: ${(chunkStat.size/1024/1024).toFixed(1)}MB (${startSec}s - ${startSec + chunkSec}s)`)
    chunks.push({ path: chunkPath, startSec })
  }

  // Clean up the full audio file
  try { unlinkSync(outputPath) } catch {}

  return { chunks }
}

/** Call Whisper API with retries on 500 errors */
async function callWhisper(filePath) {
  const maxRetries = 3
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await openai.audio.transcriptions.create({
        file: createReadStream(filePath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['word', 'segment'],
      })
    } catch (err) {
      const is500 = err.status === 500 || err.message?.includes('500')
      if (is500 && attempt < maxRetries) {
        const delay = attempt * 3000
        console.log(`[whisper] Got 500 error, retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})...`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        throw err
      }
    }
  }
}

/**
 * Transcribe a video/audio file using OpenAI Whisper.
 * Automatically extracts, compresses, and splits audio for large files.
 */
export async function transcribeVideo(filePath, onProgress) {
  const stat = statSync(filePath)
  const sizeMB = stat.size / 1024 / 1024
  console.log(`[whisper] Input file: ${filePath} (${sizeMB.toFixed(1)}MB)`)

  const tempFiles = []

  try {
    let audioResult
    if (sizeMB > 24) {
      onProgress?.('extracting_audio')
      audioResult = await extractAudio(filePath)
    } else {
      audioResult = { single: null } // use original
    }

    onProgress?.('transcribing')

    if (audioResult.single !== undefined) {
      // Single file transcription (original or compressed)
      const fileToTranscribe = audioResult.single || filePath
      if (audioResult.single) tempFiles.push(audioResult.single)

      console.log(`[whisper] Sending to Whisper: ${(statSync(fileToTranscribe).size / 1024 / 1024).toFixed(1)}MB`)
      const response = await callWhisper(fileToTranscribe)

      onProgress?.('processing')
      const words = response.words || []
      const segments = response.segments || []
      const formatted = formatTranscript(words, segments)
      console.log(`[whisper] Transcription complete: ${words.length} words, ${response.duration}s`)

      return { text: response.text, formatted, words, segments, duration: response.duration }
    }

    // Chunked transcription
    const allWords = []
    const allSegments = []
    let fullText = ''
    let totalDuration = 0

    for (let i = 0; i < audioResult.chunks.length; i++) {
      const chunk = audioResult.chunks[i]
      tempFiles.push(chunk.path)

      onProgress?.(`transcribing chunk ${i + 1}/${audioResult.chunks.length}`)
      console.log(`[whisper] Transcribing chunk ${i + 1}/${audioResult.chunks.length} (offset ${chunk.startSec}s)...`)

      const response = await callWhisper(chunk.path)

      // Offset all timecodes by the chunk's start position
      const offset = chunk.startSec
      const words = (response.words || []).map(w => ({
        ...w,
        start: w.start + offset,
        end: w.end + offset,
      }))
      const segments = (response.segments || []).map(s => ({
        ...s,
        start: s.start + offset,
        end: s.end + offset,
      }))

      allWords.push(...words)
      allSegments.push(...segments)
      fullText += (fullText ? ' ' : '') + response.text
      totalDuration = Math.max(totalDuration, (response.duration || 0) + offset)

      console.log(`[whisper] Chunk ${i + 1} done: ${words.length} words`)
    }

    onProgress?.('processing')
    const formatted = formatTranscript(allWords, allSegments)
    console.log(`[whisper] Chunked transcription complete: ${allWords.length} words, ${Math.round(totalDuration)}s total`)

    return { text: fullText, formatted, words: allWords, segments: allSegments, duration: totalDuration }

  } finally {
    for (const f of tempFiles) {
      try { unlinkSync(f) } catch {}
    }
  }
}

/**
 * Format transcript using Whisper segments.
 * Each segment gets a [HH:MM:SS] timecode prefix.
 * Pauses longer than 1 second between segments are marked as [Xs].
 */
function formatTranscript(words, segments) {
  if (segments && segments.length > 0) {
    const lines = []
    for (let i = 0; i < segments.length; i++) {
      // Insert pause marker if gap > 1s between segments
      if (i > 0) {
        const gap = Math.round(segments[i].start - segments[i - 1].end)
        if (gap > 1) lines.push(`[${gap}s]`)
      }
      const tc = formatTimecode(segments[i].start)
      lines.push(`${tc} ${segments[i].text.trim()}`)
    }
    return lines.join('\n\n')
  }

  if (!words || words.length === 0) return ''

  const lines = []
  let currentLine = []
  let lineStartTime = null
  let prevLineEnd = null

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (lineStartTime === null) lineStartTime = word.start
    currentLine.push(word.word)

    const endsWithPunctuation = /[.!?]$/.test(word.word.trim())
    const isLastWord = i === words.length - 1

    if (endsWithPunctuation || isLastWord) {
      // Insert pause marker if gap > 1s
      if (prevLineEnd !== null) {
        const gap = Math.round(lineStartTime - prevLineEnd)
        if (gap > 1) lines.push(`[${gap}s]`)
      }
      const tc = formatTimecode(lineStartTime)
      const text = currentLine.join(' ').replace(/\s+([.,!?;:])/g, '$1')
      lines.push(`${tc} ${text.trim()}`)
      prevLineEnd = words[i].end
      currentLine = []
      lineStartTime = null
    }
  }

  return lines.join('\n\n')
}

function formatTimecode(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `[${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`
}

/**
 * Compare raw and edited transcripts to find cut/deleted words.
 */
export function findCutWords(rawWords, editedWords) {
  if (!rawWords?.length || !editedWords?.length) return []

  const normalize = w => w.word.trim().toLowerCase().replace(/[.,!?;:'"]/g, '')
  const rawNorm = rawWords.map(normalize)
  const editNorm = editedWords.map(normalize)

  const cuts = []
  let editIdx = 0

  for (let i = 0; i < rawWords.length; i++) {
    let found = false
    const searchWindow = Math.min(editIdx + 20, editNorm.length)

    for (let j = editIdx; j < searchWindow; j++) {
      if (rawNorm[i] === editNorm[j]) {
        editIdx = j + 1
        found = true
        break
      }
    }

    if (!found) {
      cuts.push({
        word: rawWords[i].word,
        start: rawWords[i].start,
        end: rawWords[i].end,
        rawIndex: i,
      })
    }
  }

  return cuts
}
