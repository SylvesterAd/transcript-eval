import db from '../db.js'
import { executeRun } from './llm-runner.js'

/**
 * Convert timecode string "[HH:MM:SS]" or "[MM:SS]" to seconds.
 */
function timecodeToSeconds(tc) {
  const match = tc.match(/\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?/)
  if (!match) return 0
  if (match[3] !== undefined) {
    return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])
  }
  return parseInt(match[1]) * 60 + parseInt(match[2])
}

/**
 * Normalize text for comparison: lowercase, strip punctuation.
 */
function normalizeText(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Match an item's text to word timestamps, returning the time range.
 *
 * @param {string|null} itemText - The text to find, or null for whole timecode segment
 * @param {number} timecodeSeconds - The timecode in seconds
 * @param {Array} wordTimestamps - Array of {word, start, end}
 * @returns {{startTime: number, endTime: number}|null}
 */
function matchTextToWords(itemText, timecodeSeconds, wordTimestamps) {
  if (!wordTimestamps?.length) return null

  // Find candidate words near the timecode
  const windowStart = timecodeSeconds - 2
  const windowEnd = timecodeSeconds + 30
  const candidates = []
  for (let i = 0; i < wordTimestamps.length; i++) {
    if (wordTimestamps[i].start >= windowStart && wordTimestamps[i].start <= windowEnd) {
      candidates.push({ ...wordTimestamps[i], idx: i })
    }
  }
  if (candidates.length === 0) return null

  if (itemText) {
    // Normalize and tokenize the target text
    const targetTokens = normalizeText(itemText).split(' ').filter(Boolean)
    if (targetTokens.length === 0) return null

    // Find contiguous subsequence in candidates matching target tokens
    for (let i = 0; i <= candidates.length - targetTokens.length; i++) {
      let match = true
      for (let j = 0; j < targetTokens.length; j++) {
        const wordNorm = normalizeText(candidates[i + j].word)
        if (wordNorm !== targetTokens[j]) {
          match = false
          break
        }
      }
      if (match) {
        return {
          startTime: candidates[i].start,
          endTime: candidates[i + targetTokens.length - 1].end,
        }
      }
    }

    // Fallback: try partial/fuzzy match with startsWith
    for (let i = 0; i <= candidates.length - targetTokens.length; i++) {
      let match = true
      for (let j = 0; j < targetTokens.length; j++) {
        const wordNorm = normalizeText(candidates[i + j].word)
        if (!wordNorm.startsWith(targetTokens[j]) && !targetTokens[j].startsWith(wordNorm)) {
          match = false
          break
        }
      }
      if (match) {
        return {
          startTime: candidates[i].start,
          endTime: candidates[i + targetTokens.length - 1].end,
        }
      }
    }

    // Last resort: use first/last candidates as range
    return null
  }

  // No text specified — mark all words from timecode to next timecode (or +5s)
  const endTime = Math.min(timecodeSeconds + 5, candidates[candidates.length - 1].end)
  return {
    startTime: candidates[0].start,
    endTime,
  }
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
 * @param {number} experimentRunId - The run to extract annotations from
 * @param {Array} wordTimestamps - Array of {word, start, end} from the primary transcript
 * @returns {Object} Annotations object ready to store as JSON
 */
export function buildAnnotationsFromRun(experimentRunId, wordTimestamps) {
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

    // Map each raw item to word timestamps
    for (const item of rawItems) {
      if (!item.timecode) continue

      const tcSeconds = timecodeToSeconds(item.timecode)
      const timeRange = matchTextToWords(item.text || null, tcSeconds, wordTimestamps)
      if (!timeRange) continue

      annId++
      items.push({
        id: `ann-${annId}`,
        type: annotationType,
        category: item.category || (annotationType === 'deletion' ? 'filler_words' : 'repetition'),
        reason: item.reason || '',
        text: item.text || '',
        timecode: item.timecode,
        startTime: timeRange.startTime,
        endTime: timeRange.endTime,
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

  // Get word timestamps for the video
  const transcript = db.prepare(
    'SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = ?'
  ).get(video.id, 'raw')

  let wordTimestamps = []
  if (transcript?.word_timestamps_json) {
    try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch { /* ignore */ }
  }

  if (!wordTimestamps.length) {
    console.log(`[main-flow] No word timestamps for video ${video.id}, skipping annotation mapping`)
    return
  }

  // Build annotations
  const annotations = buildAnnotationsFromRun(runId, wordTimestamps)
  console.log(`[main-flow] Built ${annotations.items.length} annotations for group ${groupId}`)

  // Store annotations
  db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?')
    .run(JSON.stringify(annotations), groupId)
}
