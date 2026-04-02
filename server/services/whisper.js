import { readFileSync, statSync, unlinkSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = join(__dirname, '..', '..', 'uploads', 'temp')
mkdirSync(TEMP_DIR, { recursive: true })

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY

/** Extract audio from video, compressed for upload */
async function extractAudio(filePath) {
  const outputPath = join(TEMP_DIR, `scribe-${Date.now()}.mp3`)
  await execFileAsync('ffmpeg', [
    '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-y', outputPath,
  ], { timeout: 600000 })
  const sizeMB = statSync(outputPath).size / 1024 / 1024
  console.log(`[scribe] Extracted audio: ${sizeMB.toFixed(1)}MB`)
  return outputPath
}

/** Call ElevenLabs Scribe V2 API with retries */
async function callScribe(filePath, signal) {
  const maxRetries = 3
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('Transcription cancelled')
    try {
      const buffer = readFileSync(filePath)
      const blob = new Blob([buffer], { type: 'audio/mpeg' })

      const form = new FormData()
      form.append('model_id', 'scribe_v2')
      form.append('timestamps_granularity', 'word')
      form.append('file', blob, basename(filePath))

      const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
        body: form,
        signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Scribe API ${response.status}: ${text}`)
      }

      return await response.json()
    } catch (err) {
      if (signal?.aborted) throw new Error('Transcription cancelled')
      const isRetryable = err.message?.includes('500') || err.message?.includes('503')
      if (isRetryable && attempt < maxRetries) {
        const delay = attempt * 3000
        console.log(`[scribe] Error, retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})...`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        throw err
      }
    }
  }
}

/**
 * Transcribe a video/audio file using ElevenLabs Scribe V2.
 * Extracts audio for large files to reduce upload size.
 * Scribe V2 supports up to 3GB files natively — no chunking needed.
 */
export async function transcribeVideo(filePath, onProgress, signal) {
  const stat = statSync(filePath)
  const sizeMB = stat.size / 1024 / 1024
  console.log(`[scribe] Input file: ${filePath} (${sizeMB.toFixed(1)}MB)`)

  let audioPath = null

  try {
    // Extract audio for large files to reduce upload size
    if (sizeMB > 50) {
      onProgress?.('extracting_audio')
      audioPath = await extractAudio(filePath)
    }

    onProgress?.('transcribing')
    const fileToTranscribe = audioPath || filePath
    console.log(`[scribe] Sending to Scribe V2: ${(statSync(fileToTranscribe).size / 1024 / 1024).toFixed(1)}MB`)

    const response = await callScribe(fileToTranscribe, signal)

    onProgress?.('processing')

    // Map Scribe response to our format: { word, start, end }
    const scribeWords = response.words || []
    const words = scribeWords
      .filter(w => w.type === 'word')
      .map(w => ({ word: w.text, start: w.start, end: w.end }))

    // Fix duplicate timestamps: if a word has the same start as the previous,
    // set its start/end to the average between the previous and next word
    for (let i = 1; i < words.length; i++) {
      if (words[i].start === words[i - 1].start) {
        const prev = words[i - 1].end
        const next = i + 1 < words.length ? words[i + 1].start : words[i].end + 0.3
        words[i].start = (prev + next) / 2
        words[i].end = Math.max(words[i].start + 0.01, next - 0.01)
      }
    }

    const text = response.text || ''
    const duration = words.length > 0 ? words[words.length - 1].end : 0
    const formatted = formatTranscript(words)

    console.log(`[scribe] Transcription complete: ${words.length} words, ${duration.toFixed(1)}s`)

    return { text, formatted, words, segments: [], duration }
  } finally {
    if (audioPath) {
      try { unlinkSync(audioPath) } catch {}
    }
  }
}

/**
 * Format transcript with timecodes and pause markers.
 */
function formatTranscript(words) {
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
  const cs = Math.round((seconds % 1) * 100)
  // Include centiseconds only when needed to disambiguate (keeps clean timecodes for most lines)
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return cs > 0 ? `[${base}.${String(cs).padStart(2, '0')}]` : `[${base}]`
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
