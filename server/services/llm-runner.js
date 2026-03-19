import db from '../db.js'
import { scoreOutput } from './scorer.js'
import { calculateSimilarity, checkTimecodePreservation, checkPausePreservation, computeDiff, extractDeletions } from './diff-engine.js'
import { classifyDeletions } from './classifier.js'
import { segmentTranscript, reassembleSegments } from './segmenter.js'

// ── Live progress & abort tracking ──────────────────────────────────────
// Maps experimentRunId → { stageIndex, totalStages, stageName, status }
export const runStageProgress = new Map()
// Set of experiment IDs that should be aborted
export const abortedExperiments = new Set()

// ── Startup cleanup: mark orphaned "running" runs as failed ─────────────
const orphaned = db.prepare("UPDATE experiment_runs SET status = 'failed', error_message = 'Server restarted while run was in progress' WHERE status = 'running'").run()
if (orphaned.changes > 0) console.log(`[llm-runner] Cleaned up ${orphaned.changes} orphaned running run(s)`)

/**
 * Execute a full experiment run for a single video.
 * Supports stage types: "llm" (default), "programmatic", "llm_parallel"
 */
export async function executeRun(experimentRunId) {
  const run = db.prepare(`
    SELECT er.*, e.strategy_version_id, v.id AS vid
    FROM experiment_runs er
    JOIN experiments e ON e.id = er.experiment_id
    JOIN videos v ON v.id = er.video_id
    WHERE er.id = ?
  `).get(experimentRunId)

  if (!run) throw new Error('Run not found')

  const version = db.prepare('SELECT * FROM strategy_versions WHERE id = ?').get(run.strategy_version_id)
  if (!version) throw new Error('Strategy version not found')

  const stages = JSON.parse(version.stages_json || '[]')
  if (stages.length === 0) throw new Error('No stages defined')

  // For grouped videos, use the combined/assembled transcript
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(run.video_id)
  let rawTranscript = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'raw'").get(run.video_id)
  let humanTranscript = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(run.video_id)

  if (video?.group_id) {
    // Use assembled transcript from the group as raw source
    const group = db.prepare('SELECT assembled_transcript, assembly_status FROM video_groups WHERE id = ?').get(video.group_id)
    if (group?.assembled_transcript && group.assembly_status === 'done') {
      const cleaned = group.assembled_transcript
        .replace(/\[Source:[^\]]*\]\n*/g, '')
        .replace(/\[Additional from:[^\]]*\]\n*/g, '')
        .replace(/--- --- ---\n*/g, '')
        .trim()
      rawTranscript = { content: cleaned }
    }
    // Look for human_edited across sibling videos in the group
    if (!humanTranscript) {
      humanTranscript = db.prepare(`
        SELECT t.content FROM transcripts t
        JOIN videos v ON v.id = t.video_id
        WHERE v.group_id = ? AND t.type = 'human_edited'
        LIMIT 1
      `).get(video.group_id)
    }
  }

  if (!rawTranscript || !humanTranscript) throw new Error('Transcripts not found')

  db.prepare("UPDATE experiment_runs SET status = 'running' WHERE id = ?").run(experimentRunId)

  const raw = rawTranscript.content
  const human = humanTranscript.content
  let currentInput = raw
  let segments = null // For parallel processing
  const startTime = Date.now()
  let totalTokens = 0
  let totalCost = 0

  // Check for previously completed stages (resume support)
  const completedStages = db.prepare(
    'SELECT stage_index, output_text, stage_name FROM run_stage_outputs WHERE experiment_run_id = ? ORDER BY stage_index'
  ).all(experimentRunId)
  let resumeFrom = 0
  if (completedStages.length > 0) {
    const lastCompleted = completedStages[completedStages.length - 1]
    resumeFrom = lastCompleted.stage_index + 1
    const lastStage = stages[lastCompleted.stage_index]
    const lastType = lastStage?.type || 'llm'

    // Restore state based on what the last completed stage was
    if (lastType === 'llm' || (lastType === 'programmatic' && lastStage?.action === 'reassemble')) {
      currentInput = lastCompleted.output_text
    }
    if (lastType === 'programmatic' && lastStage?.action === 'segment') {
      // Rebuild segments for the next llm_parallel stage
      const params = lastStage.actionParams || {}
      segments = segmentTranscript(currentInput, {
        minSeconds: params.minSeconds || 40,
        maxSeconds: params.maxSeconds || 80,
        contextSeconds: params.contextSeconds || 30,
      })
    }
    if (lastType === 'llm_parallel') {
      // Restore segments with their cleaned text from saved output
      // Find the segment stage before this one to rebuild segment structure
      const segStageData = completedStages.find(cs => {
        const s = stages[cs.stage_index]
        return s?.type === 'programmatic' && s?.action === 'segment'
      })
      if (segStageData) {
        const segStage = stages[segStageData.stage_index]
        const params = segStage.actionParams || {}
        segments = segmentTranscript(currentInput, {
          minSeconds: params.minSeconds || 40,
          maxSeconds: params.maxSeconds || 80,
          contextSeconds: params.contextSeconds || 30,
        })
        // Restore cleanedText from saved llm_parallel output
        try {
          const saved = JSON.parse(lastCompleted.output_text)
          for (const item of saved) {
            if (segments[item.segment - 1] && item.cleanedText) {
              segments[item.segment - 1].cleanedText = item.cleanedText
            }
          }
          console.log(`[llm-runner] Restored ${saved.length} segment results from previous run`)
        } catch { /* couldn't parse, will need to re-run */ }
      }
    }
    console.log(`[llm-runner] Resuming run ${experimentRunId} from stage ${resumeFrom} (${completedStages.length} stages already done)`)
  }

  try {
    for (let i = 0; i < stages.length; i++) {
      // Skip already completed stages
      if (i < resumeFrom) continue

      // Abort check
      if (abortedExperiments.has(run.experiment_id)) {
        db.prepare("UPDATE experiment_runs SET status = 'failed', error_message = 'Aborted by user' WHERE id = ?").run(experimentRunId)
        runStageProgress.delete(experimentRunId)
        throw new Error('Aborted')
      }

      const stage = stages[i]
      const stageType = stage.type || 'llm'

      // Track stage progress
      runStageProgress.set(experimentRunId, {
        stageIndex: i,
        totalStages: stages.length,
        stageName: stage.name || `Stage ${i + 1}`,
        status: 'running',
      })
      const stageStart = Date.now()
      let stageOutput = ''
      let tokensIn = 0
      let tokensOut = 0
      let stageCost = 0
      let promptUsed = ''
      let systemUsed = ''
      let modelUsed = stage.model || ''

      if (stageType === 'programmatic') {
        // Programmatic action — no LLM call
        const action = stage.action || 'segment'

        if (action === 'segment') {
          const params = stage.actionParams || {}
          segments = segmentTranscript(currentInput, {
            minSeconds: params.minSeconds || 40,
            maxSeconds: params.maxSeconds || 80,
            contextSeconds: params.contextSeconds || 30,
          })
          stageOutput = JSON.stringify(segments.map((s, idx) => ({
            segment: idx + 1,
            startTime: s.startTime,
            endTime: s.endTime,
            entries: s.entryCount,
            mainTextPreview: s.mainText.slice(0, 100) + '...',
          })))
          promptUsed = `[Programmatic] Segmented transcript into ${segments.length} chunks (${params.minSeconds || 40}-${params.maxSeconds || 80}s, ${params.contextSeconds || 30}s context)`
          modelUsed = 'programmatic'

        } else if (action === 'reassemble') {
          if (segments && Array.isArray(segments)) {
            const cleanedTexts = segments.map(s => s.cleanedText || s.mainText)
            stageOutput = reassembleSegments(cleanedTexts)
            segments = null // Clear segments state
          } else {
            stageOutput = currentInput
          }
          promptUsed = '[Programmatic] Reassembled cleaned segments into full text'
          modelUsed = 'programmatic'

        } else {
          stageOutput = currentInput
          promptUsed = `[Programmatic] Unknown action: ${action}`
          modelUsed = 'programmatic'
        }

      } else if (stageType === 'llm_parallel') {
        // Run LLM on each segment separately
        if (!segments || segments.length === 0) {
          // Fallback: treat as single LLM call
          const prompt = insertTranscript(stage.prompt || '{{transcript}}', currentInput)
          const llmResult = await callLLM({
            model: stage.model || 'claude-sonnet-4-20250514',
            systemInstruction: stage.system_instruction || '',
            prompt,
            params: stage.params || {},
            experimentId: run.experiment_id,
          })
          stageOutput = llmResult.text
          tokensIn = llmResult.tokensIn
          tokensOut = llmResult.tokensOut
          stageCost = llmResult.cost
          promptUsed = prompt
          systemUsed = stage.system_instruction || ''
          modelUsed = stage.model || 'claude-sonnet-4-20250514'
        } else {
          // Process segments with staggered concurrency pool (max 3, 1s stagger)
          // Saves each segment result to DB immediately so nothing is lost on crash/restart
          const CONCURRENCY = 3
          const STAGGER_MS = 1000
          let segmentsDone = 0

          // Check for partially completed segments from a previous attempt
          const existingStage = db.prepare(
            'SELECT id, output_text FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index = ?'
          ).get(experimentRunId, i)

          let partialResults = new Array(segments.length).fill(null)
          let stageRowId = null

          if (existingStage && existingStage.output_text) {
            stageRowId = existingStage.id
            try {
              const saved = JSON.parse(existingStage.output_text)
              for (const item of saved) {
                if (item && item.cleanedText && item.segment) {
                  partialResults[item.segment - 1] = item
                  if (segments[item.segment - 1]) {
                    segments[item.segment - 1].cleanedText = item.cleanedText
                  }
                }
              }
              segmentsDone = partialResults.filter(r => r !== null).length
              console.log(`[llm-runner] Resuming llm_parallel: ${segmentsDone}/${segments.length} segments already done`)
            } catch { /* couldn't parse, start fresh */ }
          }

          if (!stageRowId) {
            // Create stage output record upfront so we can update it incrementally
            const inserted = db.prepare(`
              INSERT INTO run_stage_outputs (experiment_run_id, stage_index, stage_name, input_text, output_text,
                prompt_used, system_instruction_used, model, params_json, tokens_in, tokens_out, cost, runtime_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
            `).run(
              experimentRunId, i, stage.name || `Stage ${i + 1}`,
              typeof currentInput === 'string' ? currentInput.slice(0, 50000) : JSON.stringify(currentInput).slice(0, 50000),
              '[]', '', stage.system_instruction || '',
              stage.model || 'claude-sonnet-4-20250514',
              JSON.stringify(stage.params || {})
            )
            stageRowId = inserted.lastInsertRowid
          }

          const prog = runStageProgress.get(experimentRunId)
          if (prog) { prog.segmentsDone = segmentsDone; prog.segmentsTotal = segments.length }

          let nextIdx = 0
          let aborted = false
          async function worker() {
            while (nextIdx < segments.length && !aborted) {
              if (abortedExperiments.has(run.experiment_id)) { aborted = true; return }

              const s = nextIdx++
              if (s >= segments.length) return

              // Skip already completed segments
              if (partialResults[s] !== null) continue

              const seg = segments[s]
              let segPrompt = (stage.prompt || '{{transcript}}')
              const fullSegText = buildSegmentPromptText(seg)
              segPrompt = insertTranscript(segPrompt, fullSegText)
              segPrompt = segPrompt.replace(/\{\{segment_number\}\}/g, String(s + 1))
              segPrompt = segPrompt.replace(/\{\{total_segments\}\}/g, String(segments.length))

              const llmResult = await callLLM({
                model: stage.model || 'claude-sonnet-4-20250514',
                systemInstruction: stage.system_instruction || '',
                prompt: segPrompt,
                params: stage.params || {},
                experimentId: run.experiment_id,
              })

              if (abortedExperiments.has(run.experiment_id)) { aborted = true; return }

              seg.cleanedText = llmResult.text
              tokensIn += llmResult.tokensIn || 0
              tokensOut += llmResult.tokensOut || 0
              stageCost += llmResult.cost || 0
              segmentsDone++

              partialResults[s] = { segment: s + 1, cleanedText: llmResult.text }

              // Save to DB immediately after each segment
              const currentOutput = JSON.stringify(partialResults.filter(r => r !== null))
              db.prepare('UPDATE run_stage_outputs SET output_text = ?, tokens_in = ?, tokens_out = ?, cost = ? WHERE id = ?')
                .run(currentOutput.slice(0, 50000), tokensIn, tokensOut, stageCost, stageRowId)

              const p = runStageProgress.get(experimentRunId)
              if (p) p.segmentsDone = segmentsDone
            }
          }

          // Stagger workers: launch each 1s apart to avoid rate limits
          const workers = []
          for (let w = 0; w < Math.min(CONCURRENCY, segments.length); w++) {
            if (w > 0) await new Promise(r => setTimeout(r, STAGGER_MS))
            workers.push(worker())
          }
          await Promise.all(workers)

          if (aborted) {
            // Save whatever we have so far before marking failed
            const currentOutput = JSON.stringify(partialResults.filter(r => r !== null))
            db.prepare('UPDATE run_stage_outputs SET output_text = ?, runtime_ms = ? WHERE id = ?')
              .run(currentOutput.slice(0, 50000), Date.now() - stageStart, stageRowId)
            db.prepare("UPDATE experiment_runs SET status = 'failed', error_message = 'Aborted by user' WHERE id = ?").run(experimentRunId)
            runStageProgress.delete(experimentRunId)
            throw new Error('Aborted')
          }

          // Final save with all segments
          stageOutput = JSON.stringify(segments.map((s, idx) => ({
            segment: idx + 1,
            cleanedText: s.cleanedText || s.mainText,
          })))
          // Update the existing row instead of inserting a new one
          db.prepare(`UPDATE run_stage_outputs SET output_text = ?, prompt_used = ?, tokens_in = ?, tokens_out = ?, cost = ?, runtime_ms = ? WHERE id = ?`)
            .run(stageOutput.slice(0, 50000),
              `[Parallel LLM] Processed ${segments.length} segments (3x concurrent) with: ${(stage.prompt || '').slice(0, 200)}...`,
              tokensIn, tokensOut, stageCost, Date.now() - stageStart, stageRowId)
          promptUsed = '__already_saved__'
          systemUsed = stage.system_instruction || ''
          modelUsed = stage.model || 'claude-sonnet-4-20250514'
        }

      } else {
        // Standard LLM stage
        const prompt = insertTranscript(stage.prompt || '{{transcript}}', currentInput)
        const llmResult = await callLLM({
          model: stage.model || 'claude-sonnet-4-20250514',
          systemInstruction: stage.system_instruction || '',
          prompt,
          params: stage.params || {},
          experimentId: run.experiment_id,
        })

        stageOutput = llmResult.text
        tokensIn = llmResult.tokensIn
        tokensOut = llmResult.tokensOut
        stageCost = llmResult.cost
        promptUsed = prompt
        systemUsed = stage.system_instruction || ''
        modelUsed = stage.model || 'claude-sonnet-4-20250514'
      }

      const stageRuntime = Date.now() - stageStart

      // Store stage output (skip for llm_parallel — already saved incrementally)
      let stageOutputId
      if (promptUsed === '__already_saved__') {
        // llm_parallel already saved its row; find its ID
        const existing = db.prepare(
          'SELECT id FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index = ?'
        ).get(experimentRunId, i)
        stageOutputId = existing?.id
      } else {
        const stageResult = db.prepare(`
          INSERT INTO run_stage_outputs (experiment_run_id, stage_index, stage_name, input_text, output_text,
            prompt_used, system_instruction_used, model, params_json, tokens_in, tokens_out, cost, runtime_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          experimentRunId, i, stage.name || `Stage ${i + 1}`,
          typeof currentInput === 'string' ? currentInput.slice(0, 50000) : JSON.stringify(currentInput).slice(0, 50000),
          stageOutput.slice(0, 50000),
          (promptUsed || '').slice(0, 50000), systemUsed,
          modelUsed,
          JSON.stringify(stage.params || {}),
          tokensIn, tokensOut,
          stageCost, stageRuntime
        )
        stageOutputId = stageResult.lastInsertRowid
      }
      totalTokens += tokensIn + tokensOut
      totalCost += stageCost

      // Update currentInput for stages that produce cleaned text
      if (stageType === 'programmatic' && stage.action === 'reassemble') {
        currentInput = stageOutput
      } else if (stageType === 'llm') {
        currentInput = stageOutput
      } else if (stageType === 'llm_parallel' && (!segments || segments.length === 0)) {
        // Fallback single-call mode: treat output like a normal LLM stage
        currentInput = stageOutput
      }

      // Compute metrics for stages that produce text output
      if (stageType === 'llm' || (stageType === 'programmatic' && stage.action === 'reassemble')
          || (stageType === 'llm_parallel' && (!segments || segments.length === 0))) {
        computeAndStoreMetrics(stageOutputId, experimentRunId, i, raw, human, currentInput, run.video_id)
      }

      // Mark stage done
      const prog = runStageProgress.get(experimentRunId)
      if (prog) prog.status = 'done'
    }

    // Compute final score
    const finalScore = scoreOutput(raw, human, currentInput)
    const totalRuntime = Date.now() - startTime

    db.prepare(`
      UPDATE experiment_runs SET status = 'complete', total_score = ?, score_breakdown_json = ?,
        total_tokens = ?, total_cost = ?, total_runtime_ms = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(
      finalScore.totalScore, JSON.stringify(finalScore),
      totalTokens, totalCost, totalRuntime,
      experimentRunId
    )

    runStageProgress.delete(experimentRunId)
    return { success: true, score: finalScore, runtime: totalRuntime }
  } catch (err) {
    runStageProgress.delete(experimentRunId)
    db.prepare("UPDATE experiment_runs SET status = 'failed', error_message = ? WHERE id = ?").run(err.message || String(err), experimentRunId)
    throw err
  }
}

/** Insert transcript into prompt template. Handles all placeholder styles:
 *  <transcript></transcript>, <transcript>, {{transcript}} */
function insertTranscript(template, text) {
  return template
    .replace(/<transcript><\/transcript>/g, text)
    .replace(/<transcript>\s*$/g, text)
    .replace(/<transcript>/g, text)
    .replace(/\{\{transcript\}\}/g, text)
}

function buildSegmentPromptText(seg) {
  let text = ''
  if (seg.beforeContext) {
    text += `--- CONTEXT BEFORE (do NOT modify) ---\n${seg.beforeContext}\n--- END CONTEXT BEFORE ---\n\n`
  }
  text += `--- MAIN SEGMENT (process this) ---\n${seg.mainText}\n--- END MAIN SEGMENT ---`
  if (seg.afterContext) {
    text += `\n\n--- CONTEXT AFTER (do NOT modify) ---\n${seg.afterContext}\n--- END CONTEXT AFTER ---`
  }
  return text
}

function computeAndStoreMetrics(stageOutputId, experimentRunId, stageIndex, raw, human, current, videoId) {
  const humanVsCurrent = calculateSimilarity(human, current)
  const rawVsCurrent = calculateSimilarity(raw, current)
  const rawVsHuman = calculateSimilarity(raw, human)
  const timecodes = checkTimecodePreservation(raw, current)
  const pauses = checkPausePreservation(raw, current)

  let delta = null
  if (stageIndex > 0) {
    const prevMetric = db.prepare(`
      SELECT m.diff_percent FROM metrics m
      JOIN run_stage_outputs rso ON rso.id = m.run_stage_output_id
      WHERE rso.experiment_run_id = ? AND rso.stage_index = ? AND m.comparison_type = 'human_vs_current'
    `).get(experimentRunId, stageIndex - 1)
    if (prevMetric) {
      delta = humanVsCurrent.diffPercent - prevMetric.diff_percent
    }
  }

  const comparisons = [
    { type: 'human_vs_current', sim: humanVsCurrent, delta },
    { type: 'raw_vs_current', sim: rawVsCurrent, delta: null },
    { type: 'raw_vs_human', sim: rawVsHuman, delta: null },
  ]

  for (const comp of comparisons) {
    db.prepare(`
      INSERT INTO metrics (run_stage_output_id, comparison_type, diff_percent, similarity_percent,
        delta_vs_previous_stage, timecode_preservation_score, pause_marker_preservation_score, formatting_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stageOutputId, comp.type,
      comp.sim.diffPercent, comp.sim.similarityPercent,
      comp.type === 'human_vs_current' ? delta : null,
      timecodes.score, pauses.score,
      (timecodes.score + pauses.score) / 2
    )
  }

  const diff = computeDiff(human, current)
  const deletions = extractDeletions(diff)
  const classified = classifyDeletions(deletions)

  for (const d of classified) {
    db.prepare(`
      INSERT INTO deletion_annotations (run_stage_output_id, video_id, comparison_type, deleted_text,
        position_start, position_end, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(stageOutputId, videoId, 'human_vs_current', d.text, d.position_start, d.position_end, d.reason)
  }
}

/**
 * Call an LLM API with auto-retry (up to 3 attempts, 5s delay between).
 */
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 5000

async function callLLM({ model, systemInstruction, prompt, params, experimentId }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  const googleKey = process.env.GOOGLE_API_KEY
  const googleKeyBackup = process.env.GOOGLE_API_KEY_BACKUP

  // AbortController so we can kill in-flight fetch on abort
  const controller = new AbortController()
  // Combine user-abort with a 5-minute timeout so hung connections don't block forever
  const combinedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000)])

  // Track which Google key to use (falls back to backup on failure)
  let currentGoogleKey = googleKey

  let callFn
  if (model.startsWith('claude') && anthropicKey) {
    callFn = () => callAnthropic({ model, systemInstruction, prompt, params, apiKey: anthropicKey, signal: combinedSignal })
  } else if (model.startsWith('gpt') && openaiKey) {
    callFn = () => callOpenAI({ model, systemInstruction, prompt, params, apiKey: openaiKey, signal: combinedSignal })
  } else if (model.startsWith('gemini') && currentGoogleKey) {
    callFn = () => callGemini({ model, systemInstruction, prompt, params, apiKey: currentGoogleKey, signal: combinedSignal })
  } else if (anthropicKey && !model.startsWith('gpt') && !model.startsWith('gemini')) {
    callFn = () => callAnthropic({ model: 'claude-sonnet-4-20250514', systemInstruction, prompt, params, apiKey: anthropicKey, signal: combinedSignal })
  } else {
    const needed = model.startsWith('claude') ? 'ANTHROPIC_API_KEY'
      : model.startsWith('gpt') ? 'OPENAI_API_KEY'
      : model.startsWith('gemini') ? 'GOOGLE_API_KEY'
      : 'an API key'
    throw new Error(`Missing ${needed} in .env for model "${model}"`)
  }

  // Gemini Pro thinking fallback chain for "other side closed" (60s server-side thinking timeout):
  // 1. Retry same model with thinking: LOW (keeps Pro quality, reduces think time)
  // 2. Fall back to gemini-3-pro-preview with thinking: LOW
  // 3. Fall back to gemini-3-flash-preview (fastest, always works)
  const GEMINI_PRO_MODELS = ['gemini-3.1-pro-preview', 'gemini-3-pro-preview']
  let currentModel = model
  let currentParams = { ...params }
  let fallbackStep = 0 // 0=original, 1=same+LOW, 2=3-pro+LOW, 3=flash

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Check abort before each attempt
    if (experimentId && abortedExperiments.has(experimentId)) {
      controller.abort()
      throw new Error('Aborted')
    }
    try {
      return await callFn()
    } catch (err) {
      if (err.name === 'AbortError' || err.message === 'Aborted') throw new Error('Aborted')
      if (err.name === 'TimeoutError') throw new Error(`LLM request timed out after 5 minutes for ${currentModel}`)
      // Extract real error from Node's generic "fetch failed" wrapper
      const realMsg = err.cause ? `${err.message}: ${err.cause.message || err.cause}` : err.message
      console.error(`[llm] Attempt ${attempt}/${MAX_RETRIES} failed for ${currentModel}: ${realMsg}`)

      // Auto-fallback chain for Gemini Pro "other side closed" (thinking timeout)
      if (GEMINI_PRO_MODELS.includes(currentModel) && realMsg.includes('other side closed')) {
        fallbackStep++
        if (fallbackStep === 1 && (!currentParams.thinking_level || currentParams.thinking_level === 'HIGH' || currentParams.thinking_level === 'MEDIUM')) {
          // Step 1: same model but with LOW thinking
          console.log(`[llm] ${currentModel} thinking timed out, retrying with thinking: LOW`)
          currentParams = { ...currentParams, thinking_level: 'LOW' }
          callFn = () => callGemini({ model: currentModel, systemInstruction, prompt, params: currentParams, apiKey: currentGoogleKey, signal: combinedSignal })
          attempt--; continue
        } else if (fallbackStep <= 2 && currentModel !== 'gemini-3-pro-preview') {
          // Step 2: try gemini-3-pro-preview with LOW thinking
          console.log(`[llm] Falling back to gemini-3-pro-preview with thinking: LOW`)
          currentModel = 'gemini-3-pro-preview'
          currentParams = { ...currentParams, thinking_level: 'LOW' }
          callFn = () => callGemini({ model: currentModel, systemInstruction, prompt, params: currentParams, apiKey: currentGoogleKey, signal: combinedSignal })
          attempt--; continue
        } else if (fallbackStep <= 3) {
          // Step 3: fall back to flash (always works)
          console.log(`[llm] Falling back to gemini-3-flash-preview`)
          currentModel = 'gemini-3-flash-preview'
          currentParams = { ...params } // Reset params for flash
          callFn = () => callGemini({ model: currentModel, systemInstruction, prompt, params: currentParams, apiKey: currentGoogleKey, signal: combinedSignal })
          attempt--; continue
        }
      }

      // Switch to backup Google key on failure
      if (currentModel.startsWith('gemini') && googleKeyBackup && currentGoogleKey !== googleKeyBackup) {
        currentGoogleKey = googleKeyBackup
        callFn = () => callGemini({ model: currentModel, systemInstruction, prompt, params: currentParams, apiKey: currentGoogleKey, signal: combinedSignal })
        console.log(`[llm] Switching to backup Google API key`)
      }
      if (attempt === MAX_RETRIES) throw new Error(realMsg)
      console.log(`[llm] Retrying in ${RETRY_DELAY_MS / 1000}s...`)
      // Check abort during retry wait
      for (let waited = 0; waited < RETRY_DELAY_MS; waited += 500) {
        if (experimentId && abortedExperiments.has(experimentId)) {
          controller.abort()
          throw new Error('Aborted')
        }
        await new Promise(r => setTimeout(r, 500))
      }
    }
  }
}

async function callAnthropic({ model, systemInstruction, prompt, params, apiKey, signal }) {
  const thinkingLevel = params.thinking_level
  const isThinking = thinkingLevel && thinkingLevel !== 'OFF'

  const body = {
    model,
    // max_tokens is required by Anthropic API
    max_tokens: isThinking ? 16000 : 16000,
    messages: [{ role: 'user', content: prompt }],
  }

  if (systemInstruction) body.system = systemInstruction

  if (isThinking) {
    // Anthropic requires budget_tokens; no auto mode available
    body.thinking = { type: 'enabled', budget_tokens: 10000 }
  } else {
    if (params.temperature !== undefined) body.temperature = params.temperature
  }
  if (params.top_p !== undefined) body.top_p = params.top_p

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${err}`)
  }

  const data = await res.json()

  // When thinking is enabled, response content may include thinking blocks.
  // Extract text from the last block with type 'text'.
  let text = ''
  if (isThinking && Array.isArray(data.content)) {
    const textBlocks = data.content.filter(b => b.type === 'text')
    text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : ''
  } else {
    text = data.content?.[0]?.text || ''
  }

  const tokensIn = data.usage?.input_tokens || 0
  const tokensOut = data.usage?.output_tokens || 0

  const pricing = {
    'claude-opus-4-20250514': { input: 15, output: 75 },
    'claude-sonnet-4-20250514': { input: 3, output: 15 },
  }
  const p = pricing[model] || { input: 3, output: 15 }
  const cost = (tokensIn * p.input + tokensOut * p.output) / 1_000_000

  return { text, tokensIn, tokensOut, cost }
}

async function callOpenAI({ model, systemInstruction, prompt, params, apiKey, signal }) {
  const messages = []
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction })
  messages.push({ role: 'user', content: prompt })

  const body = { model, messages }
  if (params.temperature !== undefined) body.temperature = params.temperature

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  const text = data.choices?.[0]?.message?.content || ''
  const tokensIn = data.usage?.prompt_tokens || 0
  const tokensOut = data.usage?.completion_tokens || 0

  const pricing = {
    'gpt-5.4': { input: 2.5, output: 10 },
  }
  const p = pricing[model] || { input: 2.5, output: 10 }
  const cost = (tokensIn * p.input + tokensOut * p.output) / 1_000_000

  return { text, tokensIn, tokensOut, cost }
}

async function callGemini({ model, systemInstruction, prompt, params, apiKey, signal }) {
  const contents = [{ role: 'user', parts: [{ text: prompt }] }]
  const body = { contents }

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] }
  }

  const generationConfig = {}
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature

  // Gemini thinking support — default to MEDIUM for Pro models (HIGH times out on large inputs due to 60s idle limit)
  const isProModel = model.includes('-pro-')
  const thinkingLevel = params.thinking_level || (isProModel ? 'MEDIUM' : undefined)
  if (thinkingLevel && thinkingLevel !== 'OFF') {
    generationConfig.thinkingConfig = { thinkingLevel }
  }

  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

  // Use streaming endpoint to prevent connection drops on long-running requests
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err}`)
  }

  // Parse SSE stream and collect all chunks
  const responseText = await res.text()
  const chunks = responseText.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => {
      try { return JSON.parse(line.slice(6)) } catch { return null }
    })
    .filter(Boolean)

  // Combine text from all chunks, tracking usage from the last chunk
  let text = ''
  let tokensIn = 0
  let tokensOut = 0

  for (const chunk of chunks) {
    const parts = chunk.candidates?.[0]?.content?.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part.thought && part.text) {
          text += part.text
        }
      }
    }
    // Usage metadata is in the last chunk
    if (chunk.usageMetadata) {
      tokensIn = chunk.usageMetadata.promptTokenCount || 0
      tokensOut = chunk.usageMetadata.candidatesTokenCount || 0
    }
  }

  const pricing = {
    'gemini-3.1-pro-preview': { input: 2.5, output: 15 },
    'gemini-3-pro-preview': { input: 2.5, output: 15 },
    'gemini-3-flash-preview': { input: 0.15, output: 0.6 },
  }
  const p = pricing[model] || { input: 1.25, output: 10 }
  const cost = (tokensIn * p.input + tokensOut * p.output) / 1_000_000

  return { text, tokensIn, tokensOut, cost }
}

function mockLLMResponse(prompt, model) {
  const text = prompt.length > 500 ? prompt.slice(-prompt.length) : prompt

  let cleaned = text
    .replace(/\b(um|uh|erm)\b\s*/gi, '')
    .replace(/\b(you know|I mean|basically|like)\b\s*/gi, '')
    .replace(/\b(so yeah|so)\b\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const tokensIn = Math.ceil(prompt.length / 4)
  const tokensOut = Math.ceil(cleaned.length / 4)

  return { text: cleaned, tokensIn, tokensOut, cost: 0, mock: true }
}
