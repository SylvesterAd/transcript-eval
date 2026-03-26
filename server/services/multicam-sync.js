import db from '../db.js'
import { extractEnergyEnvelope, extractWaveformPeaks } from './video-processor.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const VENV_PYTHON = join(__dirname, '.venv', 'bin', 'python3')
const AUDALIGN_SCRIPT = join(__dirname, 'audalign_refine.py')

/**
 * Refine sync offset using audalign's sample-level cross-correlation.
 * Takes the rough transcript offset and returns a precise one.
 */
async function refineWithAudalign(primaryPath, secondaryPath, roughOffset, maxLags = 10) {
  try {
    const { stdout, stderr } = await execFileAsync(VENV_PYTHON, [
      AUDALIGN_SCRIPT, primaryPath, secondaryPath, String(roughOffset), String(maxLags)
    ], { timeout: 60000 })
    // audalign prints progress to stderr, JSON result is the last line on stdout
    const lines = stdout.trim().split('\n')
    const jsonLine = lines[lines.length - 1]
    const result = JSON.parse(jsonLine)
    return result
  } catch (err) {
    console.error(`[multicam] audalign refinement failed:`, err.message)
    return { offset: roughOffset, confidence: 0, error: err.message, method: 'fallback' }
  }
}

/**
 * Analyze a group of raw footage videos for multicam sync.
 * 1. Compare transcripts to find multicam pairs (same audio)
 * 2. Group multicam videos, pick longest transcript as primary
 * 3. Order non-matching segments using Gemini
 * 4. Assemble final combined transcript
 */
/** Re-export buildTimeline for use by the rebuild-timeline API endpoint */
export { buildTimeline as buildTimelineForGroup }

export async function analyzeMulticam(groupId, options = {}) {
  let videos = db.prepare(`
    SELECT v.id, v.title, v.duration_seconds, v.file_path, t.content AS transcript
    FROM videos v
    LEFT JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id = ? AND v.video_type = 'raw'
    ORDER BY v.id
  `).all(groupId)

  if (videos.length === 0) {
    return updateStatus(groupId, 'failed', 'No transcribed raw videos in group')
  }

  if (videos.length === 1) {
    return updateStatus(groupId, 'done', null, videos[0].transcript, JSON.stringify({
      segments: [{ videoIds: [videos[0].id], primaryVideoId: videos[0].id, primaryTitle: videos[0].title, isMulticam: false }],
    }))
  }

  // Resolve sync mode from options or DB
  const groupRow = db.prepare('SELECT sync_mode FROM video_groups WHERE id = ?').get(groupId)
  const syncMode = options.syncMode || groupRow?.sync_mode || 'sync'

  // No-sync path: skip classification/overlap/clustering/timeline, go straight to ordering
  if (syncMode === 'no_sync') {
    console.log(`[multicam] No-sync mode for group ${groupId} — skipping waveform analysis`)
    const segments = videos.map(v => ({
      videoIds: [v.id],
      titles: [v.title],
      primaryVideoId: v.id,
      primaryTitle: v.title,
      transcript: v.transcript,
      duration: v.duration_seconds,
      isMulticam: false,
    }))

    try {
      let ordered = segments
      let geminiData = null
      if (segments.length > 1) {
        updateStatus(groupId, 'ordering')
        console.log(`[multicam] Ordering ${segments.length} segments with Gemini (no-sync)...`)
        const result = await orderWithGemini(segments)
        ordered = result.ordered
        geminiData = result.gemini
      }

      updateStatus(groupId, 'assembling')
      const assembled = assemble(ordered)

      const details = {
        syncMode: 'no_sync',
        gemini: geminiData,
        segments: ordered.map(s => ({
          videoIds: s.videoIds,
          titles: s.titles,
          primaryVideoId: s.primaryVideoId,
          primaryTitle: s.primaryTitle,
          isMulticam: s.isMulticam,
          duration: s.duration,
        })),
      }

      updateStatus(groupId, 'done', null, assembled, JSON.stringify(details))
      console.log(`[multicam] Group ${groupId} done (no-sync): ${ordered.length} segments assembled`)
    } catch (err) {
      const reason = err.message || String(err)
      console.error(`[multicam] Group ${groupId} failed (no-sync):`, reason)
      updateStatus(groupId, 'failed', `Assembly error: ${reason}`)
    }
    return
  }

  // Classification step: separate off-topic videos into their own groups
  const group = db.prepare('SELECT * FROM video_groups WHERE id = ?').get(groupId)
  const shouldClassify = videos.length > 2 && !group.upload_batch_id && !options.skipClassification

  if (shouldClassify) {
    updateStatus(groupId, 'classifying')
    try {
      const classResult = await classifyContextWithGemini(videos)
      if (classResult.groups.length > 1) {
        const batchId = Date.now() + '-' + Math.random().toString(36).slice(2)
        db.prepare('UPDATE video_groups SET upload_batch_id = ? WHERE id = ?').run(batchId, groupId)

        // Largest cluster stays in current group
        const sorted = [...classResult.groups].sort((a, b) => b.length - a.length)
        const mainCluster = sorted[0]
        const mainVideoIds = new Set(mainCluster.map(id => id))

        for (let ci = 1; ci < sorted.length; ci++) {
          const cluster = sorted[ci]
          const clusterVideoIds = cluster
          const newGroupName = `${group.name} (separated)`
          const details = { classification: classResult.gemini, clusterIndex: ci }
          const r = db.prepare(
            'INSERT INTO video_groups (name, assembly_status, upload_batch_id, assembly_details_json) VALUES (?, ?, ?, ?)'
          ).run(newGroupName, 'transcribing', batchId, JSON.stringify(details))
          const newGroupId = r.lastInsertRowid

          for (const videoId of clusterVideoIds) {
            db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(newGroupId, videoId)
          }

          console.log(`[multicam] Separated ${clusterVideoIds.length} videos into new group ${newGroupId}`)
          // Fire async — sub-group has upload_batch_id set so it will skip re-classification
          analyzeMulticam(newGroupId)
        }

        // Re-query videos for current group (some were moved out)
        videos = db.prepare(`
          SELECT v.id, v.title, v.duration_seconds, t.content AS transcript
          FROM videos v
          LEFT JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
          WHERE v.group_id = ? AND v.video_type = 'raw'
          ORDER BY v.id
        `).all(groupId)

        if (videos.length === 0) {
          return updateStatus(groupId, 'failed', 'No videos remain after classification split')
        }
        if (videos.length === 1) {
          return updateStatus(groupId, 'done', null, videos[0].transcript, JSON.stringify({
            segments: [{ videoIds: [videos[0].id], primaryVideoId: videos[0].id, primaryTitle: videos[0].title, isMulticam: false }],
          }))
        }
      }
    } catch (err) {
      console.error(`[multicam] Classification failed (non-fatal):`, err.message)
      // Continue with all videos in one group
    }
  }

  updateStatus(groupId, 'syncing')

  try {
    // Extract normalized words from each transcript
    const items = videos.map(v => ({
      ...v,
      words: extractWords(v.transcript || ''),
    }))

    // Pairwise overlap using trigram matching (tolerates Whisper errors)
    console.log(`[multicam] Comparing ${videos.length} transcripts...`)
    const overlap = {}
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const score = computeOverlap(items[i].words, items[j].words)
        overlap[`${i}-${j}`] = score
        console.log(`[multicam]   ${videos[i].title} vs ${videos[j].title}: ${(score * 100).toFixed(1)}%`)
      }
    }

    // Group multicam videos (>30% trigram overlap = same scene)
    const groups = clusterMulticam(items.length, overlap, 0.30)
    console.log(`[multicam] ${groups.length} distinct segments (${groups.filter(g => g.length > 1).length} multicam groups)`)

    // For each cluster pick the longest-duration video as primary,
    // then merge any non-overlapping content from other cameras
    const segments = groups.map(group => {
      const vids = group.map(i => items[i])
      const primary = vids.reduce((best, v) =>
        (v.duration_seconds || 0) > (best.duration_seconds || 0) ? v : best
      )
      const others = vids.filter(v => v.id !== primary.id)
      const transcript = group.length > 1
        ? mergeMulticamTranscript(primary, others)
        : primary.transcript
      return {
        videoIds: vids.map(v => v.id),
        titles: vids.map(v => v.title),
        primaryVideoId: primary.id,
        primaryTitle: primary.title,
        transcript,
        duration: primary.duration_seconds,
        isMulticam: group.length > 1,
      }
    })

    // Build timeline — multicam clusters get sync offsets, singles get standalone tracks
    const multicamClusters = groups.filter(g => g.length > 1)
    let timeline = { version: 1, generatedAt: new Date().toISOString(), totalDuration: 0, tracks: [] }

    if (multicamClusters.length > 0) {
      updateStatus(groupId, 'building_timeline')
      console.log(`[multicam] Building timeline for ${multicamClusters.length} multicam cluster(s)...`)
      try {
        timeline = await buildTimeline(groupId, multicamClusters, items)
      } catch (err) {
        console.error(`[multicam] Timeline building failed (non-fatal):`, err.message)
      }
    }

    // Add standalone (non-multicam) segments to timeline so all videos appear in editor
    for (const seg of segments) {
      if (seg.isMulticam) continue
      timeline.tracks.push({
        videoId: seg.primaryVideoId,
        title: seg.primaryTitle,
        role: 'standalone',
        offset: 0,
        duration: seg.duration || 0,
        waveform: [],
        sync: { method: 'standalone', confidence: 1.0, matchCount: null },
      })
    }

    // Extract high-res waveform peaks for all timeline tracks
    const videoRows = db.prepare('SELECT id, file_path FROM videos WHERE group_id = ?').all(groupId)
    const fileMap = Object.fromEntries(videoRows.map(v => [v.id, v.file_path]))
    for (const track of timeline.tracks) {
      if (track.waveformPeaks?.length) continue // already extracted inside buildTimeline
      const filePath = fileMap[track.videoId]
      if (!filePath) continue
      try {
        const { peaks, durationSeconds } = await extractWaveformPeaks(join(__dirname, '..', '..', filePath))
        track.waveformPeaks = peaks
        if (durationSeconds) track.duration = durationSeconds
      } catch (err) {
        console.error(`[multicam] Waveform peaks failed for video ${track.videoId}:`, err.message)
      }
    }

    // If multiple non-overlapping segments, ask Gemini for logical order
    let ordered = segments
    let geminiData = null
    if (segments.length > 1) {
      updateStatus(groupId, 'ordering')
      console.log(`[multicam] Ordering ${segments.length} segments with Gemini...`)
      const result = await orderWithGemini(segments)
      ordered = result.ordered
      geminiData = result.gemini
    }

    // Apply absolute offsets: non-overlapping segments play sequentially
    // Within a multicam cluster, tracks already have relative sync offsets.
    // After ordering, shift each segment's tracks by the cumulative duration
    // of all preceding segments so they don't all stack at time=0.
    if (ordered.length > 1) {
      let cumulativeOffset = 0
      for (const seg of ordered) {
        if (cumulativeOffset > 0) {
          const segVideoIds = new Set(seg.videoIds)
          for (const track of timeline.tracks) {
            if (segVideoIds.has(track.videoId)) {
              track.offset += cumulativeOffset
            }
          }
        }
        cumulativeOffset += seg.duration || 0
      }
    }

    // Recompute total duration across all tracks
    timeline.totalDuration = 0
    for (const track of timeline.tracks) {
      const end = track.offset + track.duration
      if (end > timeline.totalDuration) timeline.totalDuration = end
    }

    // Save timeline (after ordering + absolute offsets applied)
    // Clear editor_state_json again in case auto-save raced during sync
    db.prepare('UPDATE video_groups SET timeline_json = ?, editor_state_json = NULL WHERE id = ?')
      .run(JSON.stringify(timeline), groupId)
    console.log(`[multicam] Timeline saved: ${timeline.tracks.length} tracks, ${timeline.totalDuration.toFixed(1)}s total`)

    // Assemble final transcript — resets all timecodes to be continuous
    updateStatus(groupId, 'assembling')
    const assembled = assemble(ordered)

    const details = {
      syncMode: 'sync',
      overlapScores: overlap,
      gemini: geminiData,
      segments: ordered.map(s => ({
        videoIds: s.videoIds,
        titles: s.titles,
        primaryVideoId: s.primaryVideoId,
        primaryTitle: s.primaryTitle,
        isMulticam: s.isMulticam,
        duration: s.duration,
      })),
    }

    updateStatus(groupId, 'done', null, assembled, JSON.stringify(details))
    console.log(`[multicam] Group ${groupId} done: ${ordered.length} segments assembled`)
  } catch (err) {
    const reason = err.message || String(err)
    const detail = reason.includes('Gemini') ? `Gemini API error during ordering: ${reason}`
      : reason.includes('GOOGLE_API_KEY') ? 'Google API key not configured'
      : `Multicam analysis error: ${reason}`
    console.error(`[multicam] Group ${groupId} failed:`, detail)
    updateStatus(groupId, 'failed', detail)
  }
}

/**
 * Compute rough time offset between primary and secondary video using word timestamps.
 * Uses 10-word sliding window with 50% fuzzy match threshold — tolerates transcription
 * differences between cameras (Whisper outputs vary per mic/angle). Requires ≥3
 * matching windows for a confident offset. Median aggregation for robustness.
 */
function computeTranscriptOffset(primaryTimestamps, secondaryTimestamps) {
  if (!primaryTimestamps || !secondaryTimestamps) {
    return { offsetSeconds: 0, confidence: 0, matchCount: 0 }
  }

  const normalize = (ts) => ts
    .filter(w => w.word && w.word.replace(/[.,!?;:'"()\-—]/g, '').length > 1)
    .map(w => ({ word: w.word.toLowerCase().replace(/[.,!?;:'"()\-—]/g, ''), start: w.start }))

  const primary = normalize(primaryTimestamps)
  const secondary = normalize(secondaryTimestamps)

  const WINDOW = 10
  const MATCH_THRESHOLD = 0.5  // 50% of words must match positionally
  const MIN_WINDOWS = 3        // need at least 3 matching windows

  if (primary.length < WINDOW || secondary.length < WINDOW) {
    return { offsetSeconds: 0, confidence: 0, matchCount: 0 }
  }

  // Index primary words → positions for fast candidate lookup
  const wordPositions = new Map()
  for (let i = 0; i < primary.length; i++) {
    const w = primary[i].word
    if (!wordPositions.has(w)) wordPositions.set(w, [])
    wordPositions.get(w).push(i)
  }

  const offsets = []

  // Slide 10-word window across secondary transcript
  for (let si = 0; si <= secondary.length - WINDOW; si++) {
    const secWords = []
    for (let k = 0; k < WINDOW; k++) secWords.push(secondary[si + k].word)

    // Find candidate primary window starts using word index
    const candidates = new Set()
    for (let k = 0; k < WINDOW; k++) {
      const positions = wordPositions.get(secWords[k])
      if (!positions) continue
      for (const p of positions) {
        const start = p - k
        if (start >= 0 && start + WINDOW <= primary.length) candidates.add(start)
      }
    }

    // Check each candidate — accept first that passes threshold
    for (const pi of candidates) {
      let matches = 0
      for (let k = 0; k < WINDOW; k++) {
        if (secWords[k] === primary[pi + k].word) matches++
      }
      if (matches >= WINDOW * MATCH_THRESHOLD) {
        offsets.push(primary[pi].start - secondary[si].start)
        break // one match per secondary window
      }
    }
  }

  if (offsets.length < MIN_WINDOWS) {
    return { offsetSeconds: 0, confidence: 0, matchCount: offsets.length }
  }

  // Median offset (robust to Whisper timing jitter)
  offsets.sort((a, b) => a - b)
  const median = offsets[Math.floor(offsets.length / 2)]
  const totalWindows = Math.max(1, secondary.length - WINDOW + 1)
  const confidence = Math.min(1, offsets.length / totalWindows)

  return { offsetSeconds: median, confidence, matchCount: offsets.length }
}

/**
 * Parse timecoded blocks from transcript content as fallback timestamps.
 * Returns array of { word, start } from [HH:MM:SS] block headers.
 */
function parseTimecodedBlocks(transcript) {
  if (!transcript) return null
  const blocks = transcript.split(/(?=\[\d{2}:\d{2}:\d{2}\])/).filter(Boolean)
  if (blocks.length === 0) return null

  const timestamps = []
  for (const block of blocks) {
    const tcMatch = block.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/)
    if (!tcMatch) continue
    const start = +tcMatch[1] * 3600 + +tcMatch[2] * 60 + +tcMatch[3]
    const words = block
      .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '')
      .replace(/[.,!?;:'"()\-—]/g, '')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 1)
    for (const word of words) {
      timestamps.push({ word, start })
    }
  }
  return timestamps.length > 0 ? timestamps : null
}

/**
 * Refine time offset using audio energy envelope cross-correlation.
 * Searches within ±searchWindowSec of the rough transcript offset.
 * Returns precise offset and NCC confidence score.
 */
function refineOffsetWithAudio(envelopeA, envelopeB, roughOffsetSec, searchWindowSec = 30) {
  if (!envelopeA || !envelopeB || envelopeA.length === 0 || envelopeB.length === 0) {
    return { preciseOffsetSeconds: roughOffsetSec, confidence: 0 }
  }

  const SAMPLES_PER_SEC = 10 // 100ms windows = 10 per second
  const roughIdx = Math.round(roughOffsetSec * SAMPLES_PER_SEC)
  const searchRange = Math.round(searchWindowSec * SAMPLES_PER_SEC)

  const minLag = roughIdx - searchRange
  const maxLag = roughIdx + searchRange

  let bestLag = roughIdx
  let bestNCC = -2

  for (let tau = minLag; tau <= maxLag; tau++) {
    // Compute NCC over the overlapping region
    let sumAB = 0, sumAA = 0, sumBB = 0
    let count = 0

    for (let i = 0; i < envelopeA.length; i++) {
      const j = i - tau
      if (j < 0 || j >= envelopeB.length) continue
      sumAB += envelopeA[i] * envelopeB[j]
      sumAA += envelopeA[i] * envelopeA[i]
      sumBB += envelopeB[j] * envelopeB[j]
      count++
    }

    if (count < SAMPLES_PER_SEC * 5) continue // need at least 5s of overlap

    const denom = Math.sqrt(sumAA * sumBB)
    if (denom === 0) continue
    const ncc = sumAB / denom

    if (ncc > bestNCC) {
      bestNCC = ncc
      bestLag = tau
    }
  }

  // If confidence too low, try wider windows
  if (bestNCC < 0.2) {
    for (const wider of [60, 120]) {
      if (wider <= searchWindowSec) continue
      const wideResult = refineOffsetWithAudio(envelopeA, envelopeB, roughOffsetSec, wider)
      if (wideResult.confidence >= 0.2) return wideResult
    }
    // Fall back to transcript offset
    return { preciseOffsetSeconds: roughOffsetSec, confidence: bestNCC > 0 ? bestNCC : 0 }
  }

  return {
    preciseOffsetSeconds: bestLag / SAMPLES_PER_SEC,
    confidence: bestNCC,
  }
}

/**
 * Build timeline with per-track offsets and waveforms for multicam clusters.
 * Extracts audio envelopes with capped concurrency (max 3 parallel FFmpeg).
 */
async function buildTimeline(groupId, multicamClusters, items) {
  const tracks = []
  const FFMPEG_CONCURRENCY = 3

  for (const cluster of multicamClusters) {
    const vids = cluster.map(i => items[i])
    const primary = vids.reduce((best, v) =>
      (v.duration_seconds || 0) > (best.duration_seconds || 0) ? v : best
    )
    const secondaries = vids.filter(v => v.id !== primary.id)

    // Fetch word timestamps for all cluster videos
    const timestampCache = new Map()
    for (const v of vids) {
      const row = db.prepare(
        "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'"
      ).get(v.id)
      let ts = null
      if (row?.word_timestamps_json) {
        try { ts = JSON.parse(row.word_timestamps_json) } catch {}
      }
      // Fallback to timecoded block parsing
      if (!ts) ts = parseTimecodedBlocks(v.transcript)
      timestampCache.set(v.id, ts)
    }

    // Extract energy envelopes + waveform peaks with capped concurrency
    const envelopeCache = new Map()
    const allVids = [primary, ...secondaries]
    for (let i = 0; i < allVids.length; i += FFMPEG_CONCURRENCY) {
      const batch = allVids.slice(i, i + FFMPEG_CONCURRENCY)
      const results = await Promise.all(batch.map(async (v) => {
        if (!v.file_path) return { id: v.id, envelope: null, peaks: null, duration: v.duration_seconds || 0 }
        const actualPath = join(__dirname, '..', '..', v.file_path)
        try {
          console.log(`[multicam] Extracting audio data for "${v.title}"...`)
          const [envResult, peaksResult] = await Promise.all([
            extractEnergyEnvelope(actualPath),
            extractWaveformPeaks(actualPath).catch(err => {
              console.error(`[multicam] Waveform peaks failed for "${v.title}":`, err.message)
              return null
            }),
          ])
          return {
            id: v.id,
            envelope: envResult.envelope,
            peaks: peaksResult?.peaks || null,
            duration: peaksResult?.durationSeconds || envResult.durationSeconds,
          }
        } catch (err) {
          console.error(`[multicam] Audio extraction failed for "${v.title}":`, err.message)
          return { id: v.id, envelope: null, peaks: null, duration: v.duration_seconds || 0 }
        }
      }))
      for (const r of results) {
        envelopeCache.set(r.id, { envelope: r.envelope, peaks: r.peaks, duration: r.duration })
      }
    }

    const primaryEnvData = envelopeCache.get(primary.id)

    // Primary track
    tracks.push({
      videoId: primary.id,
      title: primary.title,
      role: 'primary',
      offset: 0,
      duration: primaryEnvData?.duration || primary.duration_seconds || 0,
      waveform: primaryEnvData?.envelope || [],
      waveformPeaks: primaryEnvData?.peaks || [],
      sync: {
        method: 'primary',
        transcriptOffset: 0,
        audioOffset: 0,
        confidence: 1.0,
        matchCount: null,
      },
    })

    // Secondary tracks
    for (const sec of secondaries) {
      const primaryTS = timestampCache.get(primary.id)
      const secondaryTS = timestampCache.get(sec.id)
      const secEnvData = envelopeCache.get(sec.id)

      // Phase 1: transcript-based rough offset
      const transcriptResult = computeTranscriptOffset(primaryTS, secondaryTS)
      console.log(`[multicam] Transcript offset for "${sec.title}": ${transcriptResult.offsetSeconds.toFixed(1)}s (confidence: ${transcriptResult.confidence.toFixed(2)}, matches: ${transcriptResult.matchCount})`)

      // Phase 2: audalign sample-level refinement (if both videos have files)
      let finalOffset = transcriptResult.offsetSeconds
      let method = 'transcript_only'
      let audalignResult = null

      if (primary.file_path && sec.file_path && transcriptResult.confidence > 0) {
        const primaryPath = join(__dirname, '..', '..', primary.file_path)
        const secPath = join(__dirname, '..', '..', sec.file_path)
        audalignResult = await refineWithAudalign(primaryPath, secPath, transcriptResult.offsetSeconds, 10)
        console.log(`[multicam] Audalign for "${sec.title}": ${audalignResult.offset.toFixed(6)}s (correction: ${(audalignResult.correction || 0).toFixed(6)}s, confidence: ${audalignResult.confidence}, method: ${audalignResult.method})`)

        if (audalignResult.method === 'audalign_correlation' && audalignResult.confidence > 0) {
          finalOffset = audalignResult.offset
          method = 'transcript+audalign'
        }
      } else if (!primary.file_path || !sec.file_path) {
        console.log(`[multicam] Skipping audalign for "${sec.title}" (missing video file)`)
      }

      tracks.push({
        videoId: sec.id,
        title: sec.title,
        role: 'secondary',
        offset: finalOffset,
        duration: secEnvData?.duration || sec.duration_seconds || 0,
        waveform: secEnvData?.envelope || [],
        waveformPeaks: secEnvData?.peaks || [],
        sync: {
          method,
          transcriptOffset: transcriptResult.offsetSeconds,
          audalignOffset: audalignResult?.offset ?? null,
          audalignCorrection: audalignResult?.correction ?? null,
          confidence: audalignResult?.method === 'audalign_correlation' ? audalignResult.confidence : transcriptResult.confidence,
          matchCount: transcriptResult.matchCount,
        },
      })
    }
  }

  // Compute total duration across all tracks
  let totalDuration = 0
  for (const track of tracks) {
    const end = track.offset + track.duration
    if (end > totalDuration) totalDuration = end
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalDuration,
    tracks,
  }
}

function updateStatus(groupId, status, error = null, transcript = null, details = null) {
  if (transcript !== null) {
    db.prepare('UPDATE video_groups SET assembly_status = ?, assembly_error = ?, assembled_transcript = ?, assembly_details_json = ? WHERE id = ?')
      .run(status, error, transcript, details, groupId)
  } else {
    db.prepare('UPDATE video_groups SET assembly_status = ?, assembly_error = ? WHERE id = ?')
      .run(status, error, groupId)
  }
}

/**
 * Merge non-overlapping content from other cameras into the primary transcript.
 * Finds portions at the start/end of other videos that the primary didn't capture.
 */
function mergeMulticamTranscript(primary, others) {
  if (!primary.transcript) return primary.transcript
  const validOthers = others.filter(v => v.transcript)
  if (validOthers.length === 0) return primary.transcript

  const primaryWords = extractWords(primary.transcript)
  if (primaryWords.length < 4) return primary.transcript

  const primaryTrigrams = new Set()
  for (let i = 0; i <= primaryWords.length - 3; i++) {
    primaryTrigrams.add(`${primaryWords[i]} ${primaryWords[i+1]} ${primaryWords[i+2]}`)
  }

  let bestPrefix = null // { text, source }
  let bestSuffix = null

  for (const other of validOthers) {
    // Split transcript into timecoded blocks
    const blocks = other.transcript.split(/(?=\[\d{2}:\d{2}:\d{2}\])/).map(b => b.trim()).filter(Boolean)
    if (blocks.length === 0) continue

    // Check each block for overlap with primary
    const overlaps = blocks.map(block => {
      const words = extractWords(block)
      if (words.length < 3) return true // too short to judge, assume overlap
      let hits = 0
      for (let i = 0; i <= words.length - 3; i++) {
        if (primaryTrigrams.has(`${words[i]} ${words[i+1]} ${words[i+2]}`)) hits++
      }
      return hits / Math.max(1, words.length - 2) > 0.3
    })

    const firstOverlap = overlaps.indexOf(true)
    const lastOverlap = overlaps.lastIndexOf(true)
    if (firstOverlap < 0) continue

    // Blocks before first overlap = unique prefix (this camera started earlier)
    if (firstOverlap > 0) {
      const pre = blocks.slice(0, firstOverlap).join('\n\n')
      if (!bestPrefix || pre.length > bestPrefix.text.length) {
        bestPrefix = { text: pre, source: other.title }
      }
    }

    // Blocks after last overlap = unique suffix (this camera kept rolling)
    if (lastOverlap < blocks.length - 1) {
      const suf = blocks.slice(lastOverlap + 1).join('\n\n')
      if (!bestSuffix || suf.length > bestSuffix.text.length) {
        bestSuffix = { text: suf, source: other.title }
      }
    }
  }

  let result = primary.transcript

  if (bestPrefix) {
    // Prefix timecodes are already correct (they start from [00:00:00] of that camera).
    // Shift the PRIMARY forward by the prefix duration so timecodes are continuous.
    const prefixDuration = getLastTimecode(bestPrefix.text)
    console.log(`[multicam] Merging prefix from ${bestPrefix.source} (${bestPrefix.text.split(/\s+/).length} words, ${prefixDuration}s)`)
    result = offsetTimecodes(result, prefixDuration)
    result = `[Additional from: ${bestPrefix.source}]\n\n${bestPrefix.text}\n\n${result}`
  }

  if (bestSuffix) {
    // Shift suffix timecodes to continue after the primary ends
    const primaryEnd = getLastTimecode(result)
    console.log(`[multicam] Merging suffix from ${bestSuffix.source} (${bestSuffix.text.split(/\s+/).length} words, offset +${primaryEnd}s)`)
    const shiftedSuffix = offsetTimecodes(bestSuffix.text, primaryEnd)
    result = `${result}\n\n[Additional from: ${bestSuffix.source}]\n\n${shiftedSuffix}`
  }

  return result
}

/** Extract the last timecode in a transcript as total seconds */
function getLastTimecode(text) {
  const matches = [...text.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\]/g)]
  if (matches.length === 0) return 0
  const last = matches[matches.length - 1]
  return +last[1] * 3600 + +last[2] * 60 + +last[3]
}

/** Strip timecodes and punctuation, return lowercase word array */
function extractWords(transcript) {
  return transcript
    .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '')
    .replace(/[.,!?;:'"()\-—]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 1) // skip single-char noise
}

/**
 * Trigram overlap ratio between two word arrays.
 * Robust to Whisper errors: a single wrong word breaks at most 3 trigrams
 * out of potentially hundreds, so the overall ratio barely moves.
 */
function computeOverlap(a, b) {
  if (a.length < 4 || b.length < 4) return 0

  const triA = new Set()
  for (let i = 0; i <= a.length - 3; i++) triA.add(`${a[i]} ${a[i+1]} ${a[i+2]}`)

  let hits = 0
  const countB = Math.max(1, b.length - 2)
  for (let i = 0; i <= b.length - 3; i++) {
    if (triA.has(`${b[i]} ${b[i+1]} ${b[i+2]}`)) hits++
  }

  return Math.min(1, hits / Math.min(triA.size, countB))
}

/** Union-find clustering of videos above overlap threshold */
function clusterMulticam(n, overlap, threshold) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { parent[find(a)] = find(b) }

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if ((overlap[`${i}-${j}`] || 0) >= threshold) union(i, j)

  const groups = {}
  for (let i = 0; i < n; i++) {
    const root = find(i)
    if (!groups[root]) groups[root] = []
    groups[root].push(i)
  }
  return Object.values(groups)
}

/**
 * Use Gemini to classify videos by topic/context.
 * Returns { groups: [[videoId, ...], ...], gemini: { prompt, response, thinking } }
 * On failure, returns single group with all videos.
 */
async function classifyContextWithGemini(videos) {
  const fallback = { groups: [videos.map(v => v.id)], gemini: null }
  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) {
    console.log('[multicam] No GOOGLE_API_KEY, skipping classification')
    return fallback
  }

  const previews = videos.map((v, i) => {
    const text = (v.transcript || '')
      .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '').trim()
      .split(/\s+/).slice(0, 500).join(' ')
    return `--- VIDEO ${i + 1} (id: ${v.id}, title: "${v.title}") ---\n${text}`
  }).join('\n\n')

  const prompt = `You have ${videos.length} video transcripts. Cluster them by topic/context. Videos about the same topic or from the same session should be in the same group. Videos that are clearly about a different topic (e.g., a promo mixed with interviews) should be in a separate group.\n\n${previews}\n\nRespond with ONLY a JSON object in this format: { "groups": [[id1, id2], [id3]] } where each inner array contains the video IDs that belong together.`

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: 'You classify video transcripts by topic/context. Respond ONLY with a JSON object. No explanation.' }] },
        generationConfig: {
          maxOutputTokens: 10000,
          temperature: 1,
          thinkingConfig: { thinkingLevel: 'HIGH' },
        },
      })
    })
    if (!r.ok) throw new Error(`Gemini ${r.status}`)

    const data = await r.json()
    const parts = data.candidates?.[0]?.content?.parts || []
    const textPart = [...parts].reverse().find(p => p.text !== undefined)
    const text = textPart?.text || ''
    const thoughtPart = parts.find(p => p.thought === true)
    const geminiData = { prompt, response: text, thinking: thoughtPart?.text || null }

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*"groups"[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      const groups = parsed.groups
      if (Array.isArray(groups) && groups.length > 0) {
        // Validate: all video IDs must be present and valid
        const allIds = new Set(videos.map(v => v.id))
        const returnedIds = groups.flat()
        const valid = returnedIds.length === allIds.size &&
          returnedIds.every(id => allIds.has(id)) &&
          new Set(returnedIds).size === returnedIds.length
        if (valid) {
          console.log(`[multicam] Classification: ${groups.length} groups — ${groups.map(g => g.length).join(', ')} videos each`)
          return { groups, gemini: geminiData }
        }
      }
    }
    console.log('[multicam] Could not parse classification response, keeping all together')
    return { ...fallback, gemini: geminiData }
  } catch (err) {
    console.error('[multicam] Classification failed:', err.message)
    return fallback
  }
}

/**
 * Use Gemini 3 Pro to determine logical order of non-overlapping segments.
 * Returns { ordered, gemini: { prompt, response, order } }
 */
async function orderWithGemini(segments) {
  const noGemini = { ordered: segments, gemini: null }
  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) {
    console.log('[multicam] No GOOGLE_API_KEY, keeping upload order')
    return noGemini
  }

  const previews = segments.map((s, i) => {
    const text = (s.transcript || '')
      .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '').trim()
    return `--- SEGMENT ${i + 1} (source: "${s.primaryTitle}", ${s.duration || '?'}s) ---\n${text}`
  }).join('\n\n')

  const prompt = `You have ${segments.length} transcript segments from different parts of a video shoot. They do NOT overlap — each covers a different scene or topic. Determine the most logical chronological order.\n\n${previews}\n\nRespond with ONLY a JSON array of segment numbers in the correct order. Example: [2, 1, 3]`

  const geminiResult = { prompt, response: null, order: null }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: 'You analyze transcript segments and determine their chronological order. Respond ONLY with a JSON array of 1-based segment numbers. No explanation.' }] },
        generationConfig: {
          maxOutputTokens: 10000,
          temperature: 1,
          thinkingConfig: { thinkingLevel: 'HIGH' },
        },
      })
    })
    if (!r.ok) throw new Error(`Gemini ${r.status}`)

    const data = await r.json()
    const parts = data.candidates?.[0]?.content?.parts || []
    // With thinking enabled, parts may include thought parts — grab the last text part
    const textPart = [...parts].reverse().find(p => p.text !== undefined)
    const text = textPart?.text || ''
    const thoughtPart = parts.find(p => p.thought === true)
    geminiResult.response = text
    if (thoughtPart?.text) geminiResult.thinking = thoughtPart.text

    const match = text.match(/\[[\d,\s]+\]/)
    if (match) {
      const order = JSON.parse(match[0])
      if (order.length === segments.length && order.every(n => n >= 1 && n <= segments.length)) {
        console.log(`[multicam] Gemini order: ${JSON.stringify(order)}`)
        geminiResult.order = order
        return { ordered: order.map(n => segments[n - 1]), gemini: geminiResult }
      }
    }
    console.log('[multicam] Could not parse Gemini order, keeping original')
    return { ordered: segments, gemini: geminiResult }
  } catch (err) {
    console.error('[multicam] Gemini ordering failed:', err.message)
    geminiResult.response = `Error: ${err.message}`
    return { ordered: segments, gemini: geminiResult }
  }
}

/**
 * Assemble final transcript from ordered segments with continuous timecodes.
 * Each segment's internal timecodes start from [00:00:00] — we shift them
 * so segment 2 continues where segment 1 left off, etc.
 */
function assemble(segments) {
  let result = ''
  let offset = 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (i > 0) result += '\n\n'

    // Transcript with offset timecodes (no source headers or separators)
    const text = cleanTranscript(seg.transcript || '(no transcript)')
    result += offset > 0 ? offsetTimecodes(text, offset) : text

    // Use the actual last timecode in transcript (accounts for merged prefix/suffix)
    // rather than just the primary's duration
    const lastTC = getLastTimecode(text)
    offset += lastTC > 0 ? lastTC : (seg.duration || 0)
  }

  return result
}

/** Remove source headers, separators, and other assembly artifacts */
function cleanTranscript(text) {
  return text
    .replace(/\[Source:[^\]]*\]\n*/g, '')
    .replace(/\[Additional from:[^\]]*\]\n*/g, '')
    .replace(/--- --- ---\n*/g, '')
    .trim()
}

function offsetTimecodes(text, secs) {
  return text.replace(/\[(\d{2}):(\d{2}):(\d{2})\]/g, (_, h, m, s) => {
    const total = +h * 3600 + +m * 60 + +s + secs
    const hh = String(Math.floor(total / 3600)).padStart(2, '0')
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
    const ss = String(Math.floor(total % 60)).padStart(2, '0')
    return `[${hh}:${mm}:${ss}]`
  })
}
