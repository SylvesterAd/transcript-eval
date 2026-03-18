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

  try {
    for (let i = 0; i < stages.length; i++) {
      // Abort check
      if (abortedExperiments.has(run.experiment_id)) {
        db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ?").run(experimentRunId)
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
            params: stage.params || {}
          })
          stageOutput = llmResult.text
          tokensIn = llmResult.tokensIn
          tokensOut = llmResult.tokensOut
          stageCost = llmResult.cost
          promptUsed = prompt
          systemUsed = stage.system_instruction || ''
          modelUsed = stage.model || 'claude-sonnet-4-20250514'
        } else {
          // Process each segment
          const results = []
          for (let s = 0; s < segments.length; s++) {
            const seg = segments[s]
            // Build prompt with context markers
            let segPrompt = (stage.prompt || '{{transcript}}')
            const fullSegText = buildSegmentPromptText(seg)
            segPrompt = insertTranscript(segPrompt, fullSegText)
            segPrompt = segPrompt.replace(/\{\{segment_number\}\}/g, String(s + 1))
            segPrompt = segPrompt.replace(/\{\{total_segments\}\}/g, String(segments.length))

            const llmResult = await callLLM({
              model: stage.model || 'claude-sonnet-4-20250514',
              systemInstruction: stage.system_instruction || '',
              prompt: segPrompt,
              params: stage.params || {}
            })

            // Store cleaned text back on segment
            seg.cleanedText = llmResult.text
            tokensIn += llmResult.tokensIn || 0
            tokensOut += llmResult.tokensOut || 0
            stageCost += llmResult.cost || 0

            results.push({
              segment: s + 1,
              inputLength: seg.mainText.length,
              outputLength: llmResult.text.length,
            })
          }

          stageOutput = JSON.stringify(results)
          promptUsed = `[Parallel LLM] Processed ${segments.length} segments with: ${(stage.prompt || '').slice(0, 200)}...`
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
          params: stage.params || {}
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

      // For programmatic/parallel stages, use a summary as output_text
      const displayOutput = stageType === 'programmatic' || stageType === 'llm_parallel'
        ? stageOutput
        : stageOutput

      // Store stage output
      const stageResult = db.prepare(`
        INSERT INTO run_stage_outputs (experiment_run_id, stage_index, stage_name, input_text, output_text,
          prompt_used, system_instruction_used, model, params_json, tokens_in, tokens_out, cost, runtime_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        experimentRunId, i, stage.name || `Stage ${i + 1}`,
        typeof currentInput === 'string' ? currentInput.slice(0, 50000) : JSON.stringify(currentInput).slice(0, 50000),
        displayOutput.slice(0, 50000),
        (promptUsed || '').slice(0, 50000), systemUsed,
        modelUsed,
        JSON.stringify(stage.params || {}),
        tokensIn, tokensOut,
        stageCost, stageRuntime
      )

      const stageOutputId = stageResult.lastInsertRowid
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
    db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ?").run(experimentRunId)
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
 * Call an LLM API. Supports Anthropic Claude and OpenAI GPT.
 */
async function callLLM({ model, systemInstruction, prompt, params }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  const googleKey = process.env.GOOGLE_API_KEY

  if (model.startsWith('claude') && anthropicKey) {
    return callAnthropic({ model, systemInstruction, prompt, params, apiKey: anthropicKey })
  }

  if (model.startsWith('gpt') && openaiKey) {
    return callOpenAI({ model, systemInstruction, prompt, params, apiKey: openaiKey })
  }

  if (model.startsWith('gemini') && googleKey) {
    return callGemini({ model, systemInstruction, prompt, params, apiKey: googleKey })
  }

  if (anthropicKey && !model.startsWith('gpt') && !model.startsWith('gemini')) {
    return callAnthropic({ model: 'claude-sonnet-4-20250514', systemInstruction, prompt, params, apiKey: anthropicKey })
  }

  // No matching API key — throw instead of silently mocking
  const needed = model.startsWith('claude') ? 'ANTHROPIC_API_KEY'
    : model.startsWith('gpt') ? 'OPENAI_API_KEY'
    : model.startsWith('gemini') ? 'GOOGLE_API_KEY'
    : 'an API key'
  throw new Error(`Missing ${needed} in .env for model "${model}"`)
}

async function callAnthropic({ model, systemInstruction, prompt, params, apiKey }) {
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
    signal: AbortSignal.timeout(5 * 60 * 1000),
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

async function callOpenAI({ model, systemInstruction, prompt, params, apiKey }) {
  const messages = []
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction })
  messages.push({ role: 'user', content: prompt })

  const body = { model, messages }
  if (params.temperature !== undefined) body.temperature = params.temperature

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(5 * 60 * 1000),
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

async function callGemini({ model, systemInstruction, prompt, params, apiKey }) {
  const contents = [{ role: 'user', parts: [{ text: prompt }] }]
  const body = { contents }

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] }
  }

  const generationConfig = {}
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature

  // Gemini thinking support
  if (params.thinking_level && params.thinking_level !== 'OFF') {
    generationConfig.thinkingConfig = { thinkingLevel: params.thinking_level }
  }

  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(5 * 60 * 1000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err}`)
  }

  const data = await res.json()

  // With thinking enabled, Gemini may return thought parts alongside text parts.
  // Find the last part where 'thought' is not true to get the actual response.
  let text = ''
  const parts = data.candidates?.[0]?.content?.parts
  if (params.thinking_level && Array.isArray(parts)) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!parts[i].thought) {
        text = parts[i].text || ''
        break
      }
    }
  } else {
    text = parts?.[0]?.text || ''
  }

  const tokensIn = data.usageMetadata?.promptTokenCount || 0
  const tokensOut = data.usageMetadata?.candidatesTokenCount || 0

  const pricing = {
    'gemini-3.1-pro-preview': { input: 2.5, output: 15 },
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
