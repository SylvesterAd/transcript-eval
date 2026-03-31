import db from '../db.js'
import { executeRun } from './llm-runner.js'

/**
 * Build merged word timestamps for a group, applying track offsets from editor state.
 * Replicates the editor's mergedWords logic: longest audio track is primary,
 * other tracks fill in time gaps not covered by the primary.
 */
export function getTimelineWordTimestamps(groupId) {
  const group = db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(groupId)
  if (!group?.editor_state_json) return null

  let edState
  try { edState = JSON.parse(group.editor_state_json) } catch { return null }
  const tracks = edState.tracks || []

  // Find audio tracks, load their word timestamps from transcripts
  const audioTracks = tracks
    .filter(t => t.type === 'audio')
    .map(t => {
      const videoId = parseInt(t.id.replace('a-', ''))
      if (isNaN(videoId)) return null
      const transcript = db.prepare(
        'SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = ?'
      ).get(videoId, 'raw')
      let words = []
      if (transcript?.word_timestamps_json) {
        try { words = JSON.parse(transcript.word_timestamps_json) } catch { /* ignore */ }
      }
      return {
        videoId,
        offset: t.offset || 0,
        duration: t.duration || 0,
        timelineEnd: (t.offset || 0) + (t.duration || 0),
        words,
      }
    })
    .filter(t => t && t.words.length > 0)
    .sort((a, b) => (b.timelineEnd - b.offset) - (a.timelineEnd - a.offset)) // longest first

  if (!audioTracks.length) return null

  const primary = audioTracks[0]
  const merged = primary.words.map(w => ({
    word: w.word,
    start: w.start + primary.offset,
    end: w.end + primary.offset,
  }))

  const coveredStart = primary.offset
  const coveredEnd = primary.timelineEnd

  for (let i = 1; i < audioTracks.length; i++) {
    const t = audioTracks[i]
    for (const w of t.words) {
      const absStart = w.start + t.offset
      if (absStart < coveredStart || absStart >= coveredEnd) {
        merged.push({ word: w.word, start: absStart, end: w.end + t.offset })
      }
    }
  }

  merged.sort((a, b) => a.start - b.start)
  return merged
}

/**
 * Convert timecode string "[HH:MM:SS]" or "[MM:SS]" to seconds.
 */
function timecodeToSeconds(tc) {
  const match = tc.match(/\[?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,2}))?)?\]?/)
  if (!match) return 0
  let seconds = 0
  if (match[3] !== undefined) {
    seconds = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])
  } else {
    seconds = parseInt(match[1]) * 60 + parseInt(match[2])
  }
  if (match[4]) seconds += parseInt(match[4], 10) / 100
  return seconds
}

/**
 * Normalize text for comparison: lowercase, strip punctuation.
 */
function normalizeText(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Build a positional index: timecode → word timestamp entries.
 *
 * Walks the assembled transcript and merged word timestamps in parallel,
 * matching each transcript word to its corresponding word timestamp entry
 * by sequential position (not by time window).
 *
 * Returns: Array of { tc, tcSec, words: [{word, start, end}] }
 */
function buildTimecodeWordIndex(assembledTranscript, wordTimestamps) {
  if (!assembledTranscript || !wordTimestamps?.length) return []

  // Parse transcript into timecoded entries
  const entries = []
  for (const line of assembledTranscript.split('\n')) {
    const m = line.match(/^(\[[\d:\.]+\])\s*(.+)/)
    if (m) {
      const textWords = m[2].trim().split(/\s+/).filter(Boolean)
      if (textWords.length > 0) {
        entries.push({ tc: m[1], tcSec: timecodeToSeconds(m[1]), textWords })
      }
    }
  }

  // Walk both lists in parallel — each transcript word maps to the next
  // matching word in the timestamps. This ensures positional accuracy:
  // "clap" in "Kayla's good clap again" stays separate from standalone "Clap."
  const index = []
  let wsPos = 0

  for (const entry of entries) {
    const matched = []

    for (const word of entry.textWords) {
      const norm = normalizeText(word)
      if (!norm) continue

      // Scan forward (limited) to find matching word
      let found = false
      const scanLimit = Math.min(wsPos + 40, wordTimestamps.length)
      for (let j = wsPos; j < scanLimit; j++) {
        const wNorm = normalizeText(wordTimestamps[j].word)
        if (wNorm === norm || wNorm.startsWith(norm) || norm.startsWith(wNorm)) {
          matched.push(wordTimestamps[j])
          wsPos = j + 1
          found = true
          break
        }
      }

      // If not found in forward scan, the word might be missing from timestamps
      // (e.g. formatting artifacts). Skip it — other words in the entry still match.
    }

    if (matched.length > 0) {
      index.push({ tc: entry.tc, tcSec: entry.tcSec, words: matched })
    }
  }

  return index
}

/**
 * Find word timestamp entries for a given LLM timecode, using the positional index.
 *
 * Lookup strategy:
 * 1. Exact timecode string match
 * 2. Seconds-based match with tolerance (handles format differences like
 *    [00:00:45] vs [00:00:45.95])
 */
function findWordsForTimecode(timecode, wordIndex) {
  const tcNorm = timecode.startsWith('[') ? timecode : `[${timecode}]`
  const tcSec = timecodeToSeconds(timecode)

  // 1. Exact string match — may return multiple entries for duplicate timecodes
  const exact = wordIndex.filter(e => e.tc === tcNorm)
  if (exact.length > 0) return exact

  // 2. Closest by seconds (within 1s tolerance)
  let best = null
  let bestDist = Infinity
  for (const e of wordIndex) {
    const dist = Math.abs(e.tcSec - tcSec)
    if (dist < bestDist) {
      bestDist = dist
      best = e
    }
  }
  if (best && bestDist < 1.0) return [best]

  return []
}

/**
 * Parse raw LLM JSON response, handling markdown code fences.
 */
function parseRawJson(raw) {
  if (!raw) return []
  try {
    // Strip markdown code fences
    let cleaned = raw.trim()
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) cleaned = fenceMatch[1].trim()
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Try to find JSON array in the text
    const arrayMatch = raw.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      try { return JSON.parse(arrayMatch[0]) } catch { /* ignore */ }
    }
    return []
  }
}

/**
 * Build annotations from a completed experiment run.
 *
 * Uses positional word matching: walks the assembled transcript and word
 * timestamps in parallel to build an exact timecode→words index, then
 * maps each LLM deletion/identify item to the correct words by timecode lookup.
 *
 * @param {number} experimentRunId - The run to extract annotations from
 * @param {Array} wordTimestamps - Array of {word, start, end} from the timeline
 * @param {string} [assembledTranscript] - Assembled transcript for timecode→word mapping
 * @returns {Object} Annotations object ready to store as JSON
 */
export function buildAnnotationsFromRun(experimentRunId, wordTimestamps, assembledTranscript) {
  const run = db.prepare(`
    SELECT er.*, e.strategy_version_id, e.name AS experiment_name
    FROM experiment_runs er
    JOIN experiments e ON e.id = er.experiment_id
    WHERE er.id = ?
  `).get(experimentRunId)
  if (!run) throw new Error(`Run ${experimentRunId} not found`)

  const version = db.prepare('SELECT * FROM strategy_versions WHERE id = ?').get(run.strategy_version_id)
  if (!version) throw new Error('Strategy version not found')

  const stages = JSON.parse(version.stages_json || '[]')
  const stageOutputs = db.prepare(
    'SELECT * FROM run_stage_outputs WHERE experiment_run_id = ? ORDER BY stage_index'
  ).all(experimentRunId)

  // Build positional word index from assembled transcript
  const wordIndex = buildTimecodeWordIndex(assembledTranscript, wordTimestamps)

  const items = []
  let annId = 0

  for (const stageOutput of stageOutputs) {
    const stageConfig = stages[stageOutput.stage_index]
    if (!stageConfig) continue

    const outputMode = stageConfig.output_mode
    if (!outputMode || outputMode === 'passthrough' || outputMode === 'keep_only') continue

    // Determine annotation type from output_mode
    let annotationType
    if (outputMode === 'deletion') {
      annotationType = 'deletion'
    } else if (outputMode === 'identify') {
      annotationType = 'identify'
    } else {
      continue
    }

    // Parse raw items from the stage output
    let rawItems = []

    if (stageConfig.type === 'llm_parallel') {
      // Parallel stage: output_text contains JSON array of segment results
      try {
        const segments = JSON.parse(stageOutput.output_text || '[]')
        if (Array.isArray(segments)) {
          for (const seg of segments) {
            const segRaw = seg.llmResponseRaw || seg.raw || ''
            rawItems.push(...parseRawJson(segRaw))
          }
        }
      } catch {
        // Fallback: try llm_response_raw directly
        rawItems = parseRawJson(stageOutput.llm_response_raw)
      }
    } else {
      // Non-parallel: use llm_response_raw
      rawItems = parseRawJson(stageOutput.llm_response_raw)
    }

    // Derive category from stage config (identifyPreselect)
    const preselect = stageConfig.identifyPreselect
    const stageCategory = (preselect?.enabled && preselect?.categories?.length === 1)
      ? preselect.categories[0]
      : (preselect?.enabled && preselect?.categories?.length > 0)
        ? preselect.categories[0]
        : null

    // Map each raw item to word timestamps via positional index
    for (const item of rawItems) {
      if (!item.timecode) continue

      // Look up words at this timecode
      const entries = findWordsForTimecode(item.timecode, wordIndex)
      if (!entries.length) continue

      // Collect all words from matching entries
      let matchedWords = entries.flatMap(e => e.words)

      // If LLM specified text, subset to matching words
      if (item.text) {
        const targetTokens = normalizeText(item.text).split(' ').filter(Boolean)
        if (targetTokens.length > 0 && targetTokens.length <= matchedWords.length) {
          for (let i = 0; i <= matchedWords.length - targetTokens.length; i++) {
            let match = true
            for (let j = 0; j < targetTokens.length; j++) {
              const wNorm = normalizeText(matchedWords[i + j].word)
              if (wNorm !== targetTokens[j] && !wNorm.startsWith(targetTokens[j]) && !targetTokens[j].startsWith(wNorm)) {
                match = false
                break
              }
            }
            if (match) {
              matchedWords = matchedWords.slice(i, i + targetTokens.length)
              break
            }
          }
        }
      }

      if (!matchedWords.length) continue

      const startTime = matchedWords[0].start
      // Handle 0-duration words (ElevenLabs sometimes returns start === end)
      let endTime = matchedWords[matchedWords.length - 1].end
      if (endTime <= startTime) endTime = startTime + 0.15

      annId++
      items.push({
        id: `ann-${annId}`,
        type: annotationType,
        category: stageCategory || item.category || (annotationType === 'deletion' ? 'filler_words' : 'repetition'),
        reason: item.reason || '',
        text: item.text || '',
        timecode: item.timecode,
        startTime,
        endTime,
        stageName: stageOutput.stage_name,
        stageIndex: stageOutput.stage_index,
      })
    }
  }

  const strategy = db.prepare(`
    SELECT s.name FROM strategies s
    JOIN strategy_versions sv ON sv.strategy_id = s.id
    WHERE sv.id = ?
  `).get(run.strategy_version_id)

  return {
    flowRunId: experimentRunId,
    flowName: strategy?.name || run.experiment_name,
    createdAt: new Date().toISOString(),
    items,
  }
}

/**
 * Auto-run the main flow for a video group after transcription completes.
 */
export async function runMainFlowForGroup(groupId) {
  // Find main strategy
  const mainStrategy = db.prepare('SELECT * FROM strategies WHERE is_main = 1').get()
  if (!mainStrategy) {
    console.log(`[main-flow] No main strategy set, skipping for group ${groupId}`)
    return
  }

  // Get latest version
  const version = db.prepare(
    'SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version_number DESC LIMIT 1'
  ).get(mainStrategy.id)
  if (!version) {
    console.log(`[main-flow] Main strategy "${mainStrategy.name}" has no versions, skipping`)
    return
  }

  // Find the group's primary video (first raw video with a transcript)
  const video = db.prepare(`
    SELECT v.* FROM videos v
    JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id = ? AND v.video_type = 'raw'
    ORDER BY v.id LIMIT 1
  `).get(groupId)
  if (!video) {
    console.log(`[main-flow] No video with transcript found in group ${groupId}`)
    return
  }

  console.log(`[main-flow] Running "${mainStrategy.name}" v${version.version_number} for group ${groupId} (video ${video.id})`)

  // Create experiment + run
  const expResult = db.prepare(
    'INSERT INTO experiments (strategy_version_id, name, notes, video_ids_json) VALUES (?, ?, ?, ?)'
  ).run(version.id, `Auto: ${mainStrategy.name}`, `Auto-run for group ${groupId}`, JSON.stringify([video.id]))

  const runResult = db.prepare(
    'INSERT INTO experiment_runs (experiment_id, video_id, run_number, status) VALUES (?, ?, 1, ?)'
  ).run(Number(expResult.lastInsertRowid), video.id, 'pending')

  const runId = Number(runResult.lastInsertRowid)

  // Execute the run
  await executeRun(runId)

  // Check if run completed
  const completedRun = db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(runId)
  if (completedRun.status !== 'complete' && completedRun.status !== 'partial') {
    console.error(`[main-flow] Run ${runId} ended with status: ${completedRun.status}`)
    return
  }

  // Get merged word timestamps (all videos with track offsets)
  let wordTimestamps = getTimelineWordTimestamps(groupId)

  // Fallback: single video if editor state not ready yet
  if (!wordTimestamps?.length) {
    const transcript = db.prepare(
      'SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = ?'
    ).get(video.id, 'raw')
    wordTimestamps = []
    if (transcript?.word_timestamps_json) {
      try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch { /* ignore */ }
    }
  }

  if (!wordTimestamps.length) {
    console.log(`[main-flow] No word timestamps for group ${groupId}, skipping annotation mapping`)
    return
  }

  // Build annotations (pass assembled transcript for positional word matching)
  const groupData = db.prepare('SELECT assembled_transcript FROM video_groups WHERE id = ?').get(groupId)
  const annotations = buildAnnotationsFromRun(runId, wordTimestamps, groupData?.assembled_transcript)
  console.log(`[main-flow] Built ${annotations.items.length} annotations for group ${groupId}`)

  // Store annotations
  db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?')
    .run(JSON.stringify(annotations), groupId)
}
