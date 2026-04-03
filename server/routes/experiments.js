import { Router } from 'express'
import db from '../db.js'
import { executeRun, runStageProgress, abortedExperiments, activeAbortControllers } from '../services/llm-runner.js'
import { computeDiff, normalizeForDiff } from '../services/diff-engine.js'
import { computeStability, computeExperimentStability } from '../services/stability.js'
import { analyzeExperiment, analyzRunWithLLM, analyzeRunCustom } from '../services/llm-analyzer.js'
import { requireAuth } from '../auth.js'

const router = Router()

// All-time LLM spending summary (must be before /:id)
router.get('/spending/total', requireAuth, async (req, res) => {
  const result = await db.prepare(`
    SELECT COUNT(*) AS entries,
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM spending_log
  `).get()
  res.json({
    runs: result.entries,
    total_cost: result.total_cost,
    total_tokens: result.total_tokens,
  })
})

// Today's LLM spending summary (must be before /:id)
router.get('/spending/today', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const result = await db.prepare(`
    SELECT COUNT(*) AS entries,
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM spending_log WHERE created_at >= ?
  `).get(today)
  res.json({
    runs: result.entries,
    total_cost: result.total_cost,
    total_tokens: result.total_tokens,
  })
})

// List all experiments
router.get('/', requireAuth, async (req, res) => {
  const experiments = await db.prepare(`
    SELECT e.*,
      s.name AS strategy_name,
      sv.version_number,
      (SELECT COUNT(*) FROM experiment_runs er WHERE er.experiment_id = e.id) AS run_count,
      (SELECT COUNT(*) FROM experiment_runs er WHERE er.experiment_id = e.id AND er.status = 'complete') AS completed_runs,
      (SELECT COUNT(*) FROM experiment_runs er WHERE er.experiment_id = e.id AND er.status = 'partial') AS partial_runs,
      (SELECT ROUND(AVG(er2.total_score), 3) FROM experiment_runs er2 WHERE er2.experiment_id = e.id AND er2.status = 'complete') AS avg_score
    FROM experiments e
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    WHERE e.user_id = ?
    ORDER BY e.created_at DESC
  `).all(req.auth.userId)
  res.json(experiments)
})

// ── /runs routes MUST be before /:id to avoid Express treating "runs" as an :id param ──

// List all runs (for dedicated Runs view)
router.get('/runs', requireAuth, async (req, res) => {
  const runs = await db.prepare(`
    SELECT er.*, v.title AS video_title, v.group_id,
      e.name AS experiment_name,
      s.name AS strategy_name, sv.version_number,
      sv.stages_json,
      (SELECT COUNT(*) FROM run_stage_outputs rso WHERE rso.experiment_run_id = er.id) AS completed_stages,
      (SELECT COALESCE(SUM(rso.cost), 0) FROM run_stage_outputs rso WHERE rso.experiment_run_id = er.id) AS stages_cost,
      (SELECT COALESCE(SUM(rso.tokens_in + rso.tokens_out), 0) FROM run_stage_outputs rso WHERE rso.experiment_run_id = er.id) AS stages_tokens,
      (SELECT COALESCE(SUM(rso.runtime_ms), 0) FROM run_stage_outputs rso WHERE rso.experiment_run_id = er.id) AS stages_runtime_ms
    FROM experiment_runs er
    LEFT JOIN videos v ON v.id = er.video_id
    JOIN experiments e ON e.id = er.experiment_id
    LEFT JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    LEFT JOIN strategies s ON s.id = sv.strategy_id
    WHERE e.user_id = ?
    ORDER BY er.created_at DESC
    LIMIT 100
  `).all(req.auth.userId)

  for (const run of runs) {
    // Parse stages_json to get total stage count and names
    try {
      const stages = JSON.parse(run.stages_json)
      run.totalStages = Array.isArray(stages) ? stages.length : 0
      run.stageNames = Array.isArray(stages) ? stages.map((s, i) => {
        const custom = s.name || ''
        if (!custom || /^Stage\s+\d+$/i.test(custom)) return `Stage ${i + 1}`
        return `Stage ${i + 1}: ${custom}`
      }) : []
    } catch {
      run.totalStages = 0
      run.stageNames = []
    }
    delete run.stages_json

    // Use stage-level costs when run totals are null (failed/running runs)
    if (run.total_cost == null) run.total_cost = run.stages_cost
    if (run.total_tokens == null) run.total_tokens = run.stages_tokens
    if (run.total_runtime_ms == null) run.total_runtime_ms = run.stages_runtime_ms
    delete run.stages_cost
    delete run.stages_tokens
    delete run.stages_runtime_ms

    // Attach live progress for running runs
    if (run.status === 'running') {
      const prog = runStageProgress.get(run.id)
      if (prog) {
        run.currentStage = prog.stageIndex
        run.stageName = prog.stageName
        run.stageStatus = prog.status
        if (prog.segmentsTotal) {
          run.segmentsDone = prog.segmentsDone || 0
          run.segmentsTotal = prog.segmentsTotal
        }
      }
    }
  }

  res.json(runs)
})

// Get a single stage's input/output/human for the View modal
router.get('/runs/:runId/stages/:stageIndex', requireAuth, async (req, res) => {
  const run = await db.prepare(`
    SELECT er.video_id, v.group_id, e.strategy_version_id FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    JOIN experiments e ON e.id = er.experiment_id
    WHERE er.id = ? AND e.user_id = ?
  `).get(req.params.runId, req.auth.userId)
  if (!run) return res.status(404).json({ error: 'Run not found' })

  const stage = await db.prepare(
    'SELECT * FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index = ?'
  ).get(req.params.runId, parseInt(req.params.stageIndex))
  if (!stage) return res.status(404).json({ error: 'Stage not found' })

  let human = await db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(run.video_id)
  if (!human && run.group_id) {
    human = await db.prepare(`
      SELECT t.content FROM transcripts t JOIN videos v ON v.id = t.video_id
      WHERE v.group_id = ? AND t.type = 'human_edited' LIMIT 1
    `).get(run.group_id)
  }

  const metrics = await db.prepare(`
    SELECT * FROM metrics WHERE run_stage_output_id = ?
  `).all(stage.id)

  // Parse segment data for llm_parallel stages
  const isParallel = stage.prompt_used && stage.prompt_used.startsWith('[Parallel LLM]')
  let segments = null
  let reconstructedOutput = null
  if (isParallel) {
    try {
      const parsed = JSON.parse(stage.output_text)
      if (Array.isArray(parsed) && parsed[0]?.segment) {
        segments = parsed
        reconstructedOutput = parsed.map(s => s.cleanedText || '').join('\n\n')
      }
    } catch {
      // JSON likely truncated at 50k limit — find last complete segment object and close the array
      const text = stage.output_text
      const lastSep = text.lastIndexOf('},{"segment":')
      if (lastSep !== -1) {
        try {
          const parsed = JSON.parse(text.slice(0, lastSep + 1) + ']')
          if (Array.isArray(parsed) && parsed[0]?.segment) {
            segments = parsed
            reconstructedOutput = parsed.map(s => s.cleanedText || '').join('\n\n')
          }
        } catch {}
      }
    }
  }

  const effectiveOutput = reconstructedOutput || stage.output_text

  // Fetch raw strategy stage templates (before placeholder substitution)
  let rawStageConfig = null
  if (run.strategy_version_id) {
    const sv = await db.prepare('SELECT stages_json FROM strategy_versions WHERE id = ?').get(run.strategy_version_id)
    if (sv?.stages_json) {
      try {
        const allStages = JSON.parse(sv.stages_json)
        const stageIdx = parseInt(req.params.stageIndex)
        if (allStages[stageIdx]) {
          rawStageConfig = {
            prompt: allStages[stageIdx].prompt || null,
            system_instruction: allStages[stageIdx].system_instruction || null,
          }
        }
      } catch {}
    }
  }

  // Mark segments that have the actual saved system instruction (from new runs)
  if (segments) {
    for (const seg of segments) {
      if (seg.systemInstructionUsed) seg.systemInstructionSaved = true
    }
  }

  // For parallel segments without saved systemInstructionUsed, reconstruct from chapter data
  if (segments && segments.length > 0 && !segments[0].systemInstructionUsed && rawStageConfig?.system_instruction) {
    const sysTemplate = stage.system_instruction_used?.replace(/^\[Per-segment[^\]]*\]\n*/, '') || rawStageConfig.system_instruction
    if (sysTemplate.includes('{{chapter_name}}')) {
      // The segment_by_chapters output only has chapterName — full chapter data (description, purpose, beats)
      // lives in the llm_question stage that preceded it. Find both.
      const stageIdx = parseInt(req.params.stageIndex)
      const chapterStage = await db.prepare(
        'SELECT output_text FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index < ? AND stage_name ILIKE ? ORDER BY stage_index DESC LIMIT 1'
      ).get(req.params.runId, stageIdx, '%Segment by Chapters%')
      // Find the llm_question stage (Identify Chapters) that has the full chapter JSON
      const questionStage = await db.prepare(
        'SELECT output_text FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index < ? AND stage_name ILIKE ? ORDER BY stage_index DESC LIMIT 1'
      ).get(req.params.runId, stageIdx, '%Chapters%Beats%')
      // Parse the full chapters JSON from the llm_question output
      let fullChapters = null
      if (questionStage?.output_text) {
        try {
          const raw = questionStage.output_text
          const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
          fullChapters = JSON.parse(jsonMatch ? jsonMatch[1].trim() : raw.trim())
        } catch {}
      }
      const segmentNames = chapterStage?.output_text ? JSON.parse(chapterStage.output_text) : null
      if (fullChapters || segmentNames) {
        for (let si = 0; si < segments.length; si++) {
          // Match by index — chapters and segments align 1:1
          const ch = fullChapters?.[si] || {}
          const segName = segmentNames?.[si]
          const name = segName?.chapterName || ch.name || ''
          const description = ch.description || ''
          const purpose = ch.purpose || ''
          const beats = (ch.beats || []).map(b => `- ${b.timecode}: ${b.description}${b.purpose ? ' (' + b.purpose + ')' : ''}`).join('\n')
          segments[si].systemInstructionUsed = sysTemplate
            .replace(/\{\{chapter_name\}\}/g, name)
            .replace(/\{\{chapter_description\}\}/g, description)
            .replace(/\{\{chapter_purpose\}\}/g, purpose)
            .replace(/\{\{chapter_beats\}\}/g, beats)
            .replace(/\{\{segment_number\}\}/g, String(si + 1))
            .replace(/\{\{total_segments\}\}/g, String(segments.length))
        }
      }
    }
  }

  res.json({
    input: stage.input_text,
    output: effectiveOutput,
    human: human?.content || null,
    inputNormalized: normalizeForDiff(stage.input_text),
    outputNormalized: normalizeForDiff(effectiveOutput),
    humanNormalized: normalizeForDiff(human?.content),
    normalizedDiff: computeDiff(human?.content, effectiveOutput),
    promptUsed: stage.prompt_used,
    systemInstruction: stage.system_instruction_used,
    stageName: stage.stage_name,
    stageIndex: stage.stage_index,
    model: stage.model,
    runtime_ms: stage.runtime_ms,
    metrics,
    segments,
    isParallel,
    llmResponseRaw: stage.llm_response_raw || null,
    rawStageConfig,
  })
})

// Get run detail with stage outputs
router.get('/runs/:runId', requireAuth, async (req, res) => {
  const run = await db.prepare(`
    SELECT er.*, v.title AS video_title, e.name AS experiment_name,
      s.name AS strategy_name, sv.version_number,
      e.strategy_version_id, sv.strategy_id
    FROM experiment_runs er
    LEFT JOIN videos v ON v.id = er.video_id
    JOIN experiments e ON e.id = er.experiment_id
    LEFT JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    LEFT JOIN strategies s ON s.id = sv.strategy_id
    WHERE er.id = ? AND e.user_id = ?
  `).get(req.params.runId, req.auth.userId)
  if (!run) return res.status(404).json({ error: 'Run not found' })

  const stages = await db.prepare(
    'SELECT * FROM run_stage_outputs WHERE experiment_run_id = ? ORDER BY stage_index'
  ).all(req.params.runId)

  const metrics = await db.prepare(`
    SELECT m.*, rso.stage_index, rso.stage_name FROM metrics m
    JOIN run_stage_outputs rso ON rso.id = m.run_stage_output_id
    WHERE rso.experiment_run_id = ?
    ORDER BY rso.stage_index, m.comparison_type
  `).all(req.params.runId)

  // Get human-edited transcript for diff display
  const human = await db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(run.video_id)
  const raw = await db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'raw'").get(run.video_id)

  // Compute diffs for each stage (human vs stage output)
  const stageDiffs = stages.map(stage => {
    const diff = computeDiff(human?.content, stage.output_text)
    return { stage_index: stage.stage_index, diff }
  })

  const scoreBreakdown = run.score_breakdown_json ? JSON.parse(run.score_breakdown_json) : null

  const rawNormalized = normalizeForDiff(raw?.content)
  const humanNormalized = normalizeForDiff(human?.content)

  // Attach raw strategy stage configs (before placeholder substitution)
  let rawStageConfigs = null
  let runStagesJson = null
  if (run.strategy_version_id) {
    const sv = await db.prepare('SELECT stages_json FROM strategy_versions WHERE id = ?').get(run.strategy_version_id)
    if (sv?.stages_json) {
      try { rawStageConfigs = JSON.parse(sv.stages_json); runStagesJson = rawStageConfigs } catch {}
    }
  }
  for (const stage of stages) {
    const cfg = rawStageConfigs?.[stage.stage_index]
    stage.rawStageConfig = cfg ? { prompt: cfg.prompt || null, system_instruction: cfg.system_instruction || null } : null
  }

  // Compare run's stages snapshot with current latest version to detect changes
  let stageChanges = null
  if (run.strategy_id) {
      const latest = await db.prepare('SELECT stages_json FROM strategy_versions WHERE strategy_id = ? ORDER BY id DESC LIMIT 1').get(run.strategy_id)
      const snapshotJson = run.stages_snapshot_json
      if (latest?.stages_json && snapshotJson) {
        try {
          const latestStages = JSON.parse(latest.stages_json)
          const snapshotStages = JSON.parse(snapshotJson)
          const maxLen = Math.max(snapshotStages.length, latestStages.length)
          const stageOutputIndices = new Set(stages.map(s => s.stage_index))
          stageChanges = []
          let firstChanged = -1
          for (let i = 0; i < maxLen; i++) {
            const a = JSON.stringify(snapshotStages[i] || null)
            const b = JSON.stringify(latestStages[i] || null)
            const changed = a !== b
            const wasRun = stageOutputIndices.has(i)
            if (changed && !wasRun && firstChanged === -1) firstChanged = i
            let status
            if (wasRun) {
              status = 'unchanged'
            } else if (!snapshotStages[i]) {
              status = 'added'
            } else if (!latestStages[i]) {
              status = 'removed'
            } else if (changed) {
              status = 'changed'
            } else if (firstChanged >= 0) {
              status = 'impacted'
            } else {
              status = 'unchanged'
            }
            stageChanges.push({ index: i, status })
          }
        } catch {}
      }
  }

  res.json({ ...run, stages, metrics, stageDiffs, scoreBreakdown, raw: raw?.content, human: human?.content, rawNormalized, humanNormalized, stageChanges })
})

// Analyze a run (deterministic or LLM-powered)
router.post('/runs/:runId/analyze', requireAuth, async (req, res) => {
  try {
    const ownerCheck = await db.prepare(`
      SELECT er.id FROM experiment_runs er
      JOIN experiments e ON e.id = er.experiment_id
      WHERE er.id = ? AND e.user_id = ?
    `).get(req.params.runId, req.auth.userId)
    if (!ownerCheck) return res.status(404).json({ error: 'Run not found' })

    const { system_prompt, user_prompt, model, include_raw_transcript, include_stage_outputs } = req.body || {}

    // If custom prompts provided, use custom analysis
    if (user_prompt) {
      const result = await analyzeRunCustom(parseInt(req.params.runId), {
        systemPrompt: system_prompt,
        userPrompt: user_prompt,
        model: model || 'claude-haiku-4-5-20251001',
        includeRawTranscript: include_raw_transcript,
        includeStageOutputs: include_stage_outputs,
      })
      if (!result) return res.status(404).json({ error: 'Run not found or not complete' })
      return res.json(result)
    }

    const result = await analyzRunWithLLM(parseInt(req.params.runId))
    if (!result) return res.status(404).json({ error: 'Run not found or not complete' })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get analysis for a run
router.get('/runs/:runId/analysis', requireAuth, async (req, res) => {
  const ownerCheck = await db.prepare(`
    SELECT er.id FROM experiment_runs er
    JOIN experiments e ON e.id = er.experiment_id
    WHERE er.id = ? AND e.user_id = ?
  `).get(req.params.runId, req.auth.userId)
  if (!ownerCheck) return res.status(404).json({ error: 'Run not found' })

  const analyses = await db.prepare(
    'SELECT * FROM analysis_records WHERE experiment_run_id = ? ORDER BY analysis_type'
  ).all(req.params.runId)
  res.json(analyses)
})

// Restart a run from a specific stage (keeps earlier stages, re-runs from stageIndex onward)
router.post('/runs/:runId/restart-from/:stageIndex', requireAuth, async (req, res) => {
  const runId = parseInt(req.params.runId)
  const fromStage = parseInt(req.params.stageIndex)
  const run = await db.prepare(`
    SELECT er.* FROM experiment_runs er
    JOIN experiments e ON e.id = er.experiment_id
    WHERE er.id = ? AND e.user_id = ?
  `).get(runId, req.auth.userId)
  if (!run) return res.status(404).json({ error: 'Run not found' })
  if (run.status === 'running') return res.status(400).json({ error: 'Run is already running' })

  // Spending already saved to spending_log per-stage — no need to preserve here

  // Delete stage outputs from this stage onward
  const toDelete = await db.prepare(
    'SELECT id FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index >= ?'
  ).all(runId, fromStage)
  for (const rso of toDelete) {
    await db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id = ?').run(rso.id)
    await db.prepare('DELETE FROM metrics WHERE run_stage_output_id = ?').run(rso.id)
  }
  await db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index >= ?').run(runId, fromStage)

  // Reset run status
  await db.prepare("UPDATE experiment_runs SET status = 'pending', error_message = NULL WHERE id = ?").run(runId)

  // Return immediately, execute in background
  res.json({ restarting: true, fromStage })

  try {
    await executeRun(runId)
    // Rebuild annotations after successful run
    const completedRun = await db.prepare('SELECT status, video_id FROM experiment_runs WHERE id = ?').get(runId)
    if (completedRun?.status === 'complete' || completedRun?.status === 'partial') {
      const video = await db.prepare('SELECT group_id FROM videos WHERE id = ?').get(completedRun.video_id)
      if (video?.group_id) {
        try {
          const { buildAnnotationsFromRun, getTimelineWordTimestamps } = await import('../services/annotation-mapper.js')
          let wordTimestamps = getTimelineWordTimestamps(video.group_id)
          if (!wordTimestamps?.length) {
            const transcript = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(completedRun.video_id)
            if (transcript?.word_timestamps_json) {
              try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch {}
            }
          }
          if (wordTimestamps?.length) {
            const groupData = await db.prepare('SELECT assembled_transcript FROM video_groups WHERE id = ?').get(video.group_id)
            const annotations = buildAnnotationsFromRun(runId, wordTimestamps, groupData?.assembled_transcript)
            await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?')
              .run(JSON.stringify(annotations), video.group_id)
            console.log(`[restart] Rebuilt ${annotations.items.length} annotations for group ${video.group_id}`)
          }
        } catch (annErr) {
          console.error(`[restart] Annotation rebuild failed:`, annErr.message)
        }
      }
    }
  } catch (err) {
    console.error(`[restart] Run ${runId} from stage ${fromStage} failed:`, err.message)
  }
})

// Delete a single run
router.delete('/runs/:runId', requireAuth, async (req, res) => {
  const run = await db.prepare(`
    SELECT er.* FROM experiment_runs er
    JOIN experiments e ON e.id = er.experiment_id
    WHERE er.id = ? AND e.user_id = ?
  `).get(req.params.runId, req.auth.userId)
  if (!run) return res.status(404).json({ error: 'Run not found' })

  // Spending already saved to spending_log per-stage during execution — no need to preserve here

  // Clear annotations on the video group if this run produced them
  if (run.video_id) {
    const group = await db.prepare('SELECT id FROM video_groups WHERE id IN (SELECT group_id FROM videos WHERE id = ?)').get(run.video_id)
    if (group) {
      await db.prepare('UPDATE video_groups SET annotations_json = NULL WHERE id = ?').run(group.id)
    }
  }

  await db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
  await db.prepare('DELETE FROM metrics WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
  await db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ?').run(run.id)
  await db.prepare('DELETE FROM analysis_records WHERE experiment_run_id = ?').run(run.id)
  await db.prepare('DELETE FROM experiment_runs WHERE id = ?').run(run.id)

  // Delete the parent experiment if it has no remaining runs
  const remaining = await db.prepare('SELECT COUNT(*) AS cnt FROM experiment_runs WHERE experiment_id = ?').get(run.experiment_id)
  if (remaining.cnt === 0) {
    await db.prepare('DELETE FROM experiments WHERE id = ?').run(run.experiment_id)
  }

  res.json({ success: true })
})

// ── /:id routes ──

// Get experiment with runs
router.get('/:id', requireAuth, async (req, res) => {
  const experiment = await db.prepare(`
    SELECT e.*,
      s.name AS strategy_name,
      sv.version_number,
      sv.stages_json
    FROM experiments e
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    WHERE e.id = ? AND e.user_id = ?
  `).get(req.params.id, req.auth.userId)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  const runs = await db.prepare(`
    SELECT er.*, v.title AS video_title
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    WHERE er.experiment_id = ?
    ORDER BY v.id, er.run_number
  `).all(req.params.id)

  // Get per-video averages
  const videoAverages = await db.prepare(`
    SELECT er.video_id, v.title AS video_title,
      ROUND(AVG(er.total_score), 3) AS avg_score,
      COUNT(*) AS run_count
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    WHERE er.experiment_id = ? AND er.status = 'complete'
    GROUP BY er.video_id
  `).all(req.params.id)

  // Get stage-level metrics averages
  const stageMetrics = await db.prepare(`
    SELECT rso.stage_index, rso.stage_name,
      ROUND(AVG(m.diff_percent), 2) AS avg_diff,
      ROUND(AVG(m.similarity_percent), 2) AS avg_similarity,
      ROUND(AVG(m.delta_vs_previous_stage), 2) AS avg_delta
    FROM run_stage_outputs rso
    JOIN metrics m ON m.run_stage_output_id = rso.id
    JOIN experiment_runs er ON er.id = rso.experiment_run_id
    WHERE er.experiment_id = ? AND er.status = 'complete' AND m.comparison_type = 'human_vs_current'
    GROUP BY rso.stage_index, rso.stage_name
    ORDER BY rso.stage_index
  `).all(req.params.id)

  res.json({ ...experiment, runs, videoAverages, stageMetrics })
})

// Create experiment
router.post('/', requireAuth, async (req, res) => {
  const { strategy_version_id, name, notes, video_ids } = req.body
  if (!strategy_version_id || !name) {
    return res.status(400).json({ error: 'strategy_version_id and name are required' })
  }

  const sv = await db.prepare('SELECT * FROM strategy_versions WHERE id = ?').get(strategy_version_id)
  if (!sv) return res.status(404).json({ error: 'Strategy version not found' })

  const videoIdsJson = video_ids && Array.isArray(video_ids) && video_ids.length > 0
    ? JSON.stringify(video_ids)
    : null

  const result = await db.prepare(
    'INSERT INTO experiments (strategy_version_id, name, notes, video_ids_json, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(strategy_version_id, name, notes || null, videoIdsJson, req.auth.userId)

  const experiment = await db.prepare('SELECT * FROM experiments WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(experiment)
})

// Update experiment (video selection)
router.post('/:id/update', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id)
  const experiment = await db.prepare('SELECT * FROM experiments WHERE id = ? AND user_id = ?').get(id, req.auth.userId)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  const { video_ids } = req.body
  const videoIdsJson = video_ids && Array.isArray(video_ids) && video_ids.length > 0
    ? JSON.stringify(video_ids)
    : null

  await db.prepare('UPDATE experiments SET video_ids_json = ? WHERE id = ?').run(videoIdsJson, id)
  const updated = await db.prepare('SELECT * FROM experiments WHERE id = ?').get(id)
  res.json(updated)
})

// In-memory tracking for background execution
const activeExecutions = new Map() // experimentId -> { total, completed, failed, running, runIds, done }

// Execute experiment — kicks off runs in background, returns immediately
router.post('/:id/execute', requireAuth, async (req, res) => {
  const { repeat = 1, video_ids } = req.body || {}
  const experiment = await db.prepare('SELECT * FROM experiments WHERE id = ? AND user_id = ?').get(req.params.id, req.auth.userId)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  // Use video_ids from request, or fall back to the experiment's stored selection
  let effectiveIds = video_ids && Array.isArray(video_ids) && video_ids.length > 0
    ? video_ids
    : null
  if (!effectiveIds && experiment.video_ids_json) {
    try { effectiveIds = JSON.parse(experiment.video_ids_json) } catch {}
  }

  let videos
  if (effectiveIds && effectiveIds.length > 0) {
    const placeholders = effectiveIds.map(() => '?').join(',')
    videos = await db.prepare(`SELECT * FROM videos WHERE id IN (${placeholders}) ORDER BY id`).all(...effectiveIds)
  } else {
    videos = await db.prepare('SELECT * FROM videos ORDER BY id').all()
  }
  if (videos.length === 0) return res.status(400).json({ error: 'No videos found' })

  // Deduplicate grouped videos: keep only one representative per group
  // so the experiment runs once per group using the combined transcript
  const seenGroups = new Set()
  videos = videos.filter(v => {
    if (!v.group_id) return true
    if (seenGroups.has(v.group_id)) return false
    seenGroups.add(v.group_id)
    return true
  })

  // Create run records for each video x repeat
  const runIds = []
  for (let r = 1; r <= repeat; r++) {
    for (const video of videos) {
      const result = await db.prepare(
        'INSERT INTO experiment_runs (experiment_id, video_id, run_number, status) VALUES (?, ?, ?, ?)'
      ).run(experiment.id, video.id, r, 'pending')
      runIds.push(Number(result.lastInsertRowid))
    }
  }

  // Track this execution
  const execId = experiment.id
  const existing = activeExecutions.get(execId)
  const tracker = {
    total: runIds.length + (existing?.total || 0),
    completed: existing?.completed || 0,
    failed: existing?.failed || 0,
    running: existing?.running || 0,
    done: false,
    runIds: [...(existing?.runIds || []), ...runIds],
  }
  activeExecutions.set(execId, tracker)

  // Execute runs in background (sequentially to avoid overwhelming APIs)
  ;(async () => {
    for (const runId of runIds) {
      // Check abort before starting next run
      if (abortedExperiments.has(experiment.id)) {
        // Mark remaining pending runs as failed
        await db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ? AND status = 'pending'").run(runId)
        tracker.failed++
        continue
      }
      tracker.running++
      try {
        await executeRun(runId)
        tracker.completed++
      } catch (err) {
        tracker.failed++
        console.error(`[execute] Run ${runId} failed:`, err.message)
      }
      tracker.running--
    }
    // Mark done and clean up abort flag
    if (tracker.running === 0) tracker.done = true
    abortedExperiments.delete(experiment.id)
  })()

  // Return immediately
  res.json({ started: true, total: runIds.length, experimentId: experiment.id })
})

// Poll execution progress — includes per-run stage detail
router.get('/:id/progress', requireAuth, async (req, res) => {
  const expId = parseInt(req.params.id)
  const ownerCheck = await db.prepare('SELECT id FROM experiments WHERE id = ? AND user_id = ?').get(expId, req.auth.userId)
  if (!ownerCheck) return res.status(404).json({ error: 'Experiment not found' })
  const tracker = activeExecutions.get(expId)

  // DB-level status summary
  const dbStatus = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
      ROUND(AVG(CASE WHEN status = 'complete' THEN total_score END), 3) AS avg_score
    FROM experiment_runs WHERE experiment_id = ?
  `).get(expId)

  // Per-run detail with stage progress
  const runs = await db.prepare(`
    SELECT er.id AS runId, er.status, er.total_score, er.run_number,
      v.title AS videoTitle, er.error_message AS errorMessage
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    WHERE er.experiment_id = ?
    ORDER BY er.id
  `).all(expId)

  // Attach live stage progress for running runs
  for (const run of runs) {
    if (run.status === 'running') {
      const prog = runStageProgress.get(run.runId)
      if (prog) {
        run.currentStage = prog.stageIndex
        run.totalStages = prog.totalStages
        run.stageName = prog.stageName
        run.stageStatus = prog.status
        if (prog.segmentsTotal) {
          run.segmentsDone = prog.segmentsDone || 0
          run.segmentsTotal = prog.segmentsTotal
        }
      }
    }
    // Attach per-stage data (for complete, partial, AND running runs)
    if (run.status === 'complete' || run.status === 'partial' || run.status === 'running') {
      run.stages = await db.prepare(`
        SELECT rso.stage_index, rso.stage_name, m.similarity_percent
        FROM run_stage_outputs rso
        LEFT JOIN metrics m ON m.run_stage_output_id = rso.id AND m.comparison_type = 'human_vs_current'
        WHERE rso.experiment_run_id = ?
        ORDER BY rso.stage_index
      `).all(run.runId)
    }
  }

  const active = !!tracker && !tracker.done
  const progress = {
    active,
    total: dbStatus.total,
    completed: dbStatus.completed,
    failed: dbStatus.failed,
    running: dbStatus.running,
    pending: dbStatus.pending,
    partial: dbStatus.partial,
    avgScore: dbStatus.avg_score,
    runs,
  }

  if (tracker?.done) activeExecutions.delete(expId)
  res.json(progress)
})

// Abort a running experiment
router.post('/:id/abort', requireAuth, async (req, res) => {
  const expId = parseInt(req.params.id)
  const ownerCheck = await db.prepare('SELECT id FROM experiments WHERE id = ? AND user_id = ?').get(expId, req.auth.userId)
  if (!ownerCheck) return res.status(404).json({ error: 'Experiment not found' })
  abortedExperiments.add(expId)

  // Kill all in-flight LLM requests immediately
  const controllers = activeAbortControllers.get(expId)
  if (controllers) {
    for (const c of controllers) c.abort()
    activeAbortControllers.delete(expId)
  }

  // Mark pending and running runs as failed immediately
  await db.prepare("UPDATE experiment_runs SET status = 'failed', error_message = 'Stopped by admin' WHERE experiment_id = ? AND status IN ('pending', 'running')").run(expId)

  // Clean up progress tracking
  const runs = await db.prepare('SELECT id FROM experiment_runs WHERE experiment_id = ?').all(expId)
  for (const r of runs) runStageProgress.delete(r.id)

  res.json({ aborted: true })
})

// Retry failed runs — resumes from where they left off, keeps completed stages
router.post('/:id/retry', requireAuth, async (req, res) => {
  const expId = parseInt(req.params.id)
  const experiment = await db.prepare('SELECT * FROM experiments WHERE id = ? AND user_id = ?').get(expId, req.auth.userId)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  const failedRuns = await db.prepare("SELECT id FROM experiment_runs WHERE experiment_id = ? AND status = 'failed'").all(expId)
  if (failedRuns.length === 0) return res.json({ retried: 0 })

  // Reset failed runs to pending (keep their existing stage outputs for resumption)
  const runIds = failedRuns.map(r => r.id)
  for (const runId of runIds) {
    await db.prepare("UPDATE experiment_runs SET status = 'pending', total_score = NULL, score_breakdown_json = NULL, total_tokens = NULL, total_cost = NULL, total_runtime_ms = NULL, completed_at = NULL WHERE id = ?").run(runId)
  }

  const tracker = activeExecutions.get(expId) || { total: 0, completed: 0, failed: 0, running: 0, done: false, runIds: [] }
  tracker.total += runIds.length
  tracker.done = false
  tracker.runIds = [...tracker.runIds, ...runIds]
  activeExecutions.set(expId, tracker)

  ;(async () => {
    for (const runId of runIds) {
      if (abortedExperiments.has(expId)) {
        await db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ? AND status = 'pending'").run(runId)
        tracker.failed++
        continue
      }
      tracker.running++
      try {
        await executeRun(runId)
        tracker.completed++
      } catch (err) {
        tracker.failed++
        console.error(`[retry] Run ${runId} failed:`, err.message)
      }
      tracker.running--
    }
    if (tracker.running === 0) tracker.done = true
    abortedExperiments.delete(expId)
  })()

  res.json({ retried: runIds.length, experimentId: expId })
})

// Resume partial runs — runs stages that don't have outputs yet
router.post('/:id/resume', requireAuth, async (req, res) => {
  const expId = parseInt(req.params.id)
  const experiment = await db.prepare('SELECT * FROM experiments WHERE id = ? AND user_id = ?').get(expId, req.auth.userId)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  const partialRuns = await db.prepare(
    "SELECT id FROM experiment_runs WHERE experiment_id = ? AND status IN ('partial', 'pending')"
  ).all(expId)
  if (partialRuns.length === 0) return res.json({ resumed: 0 })

  const runIds = partialRuns.map(r => r.id)
  for (const runId of runIds) {
    await db.prepare("UPDATE experiment_runs SET status = 'pending' WHERE id = ?").run(runId)
  }

  const tracker = activeExecutions.get(expId) || { total: 0, completed: 0, failed: 0, running: 0, done: false, runIds: [] }
  tracker.total += runIds.length
  tracker.done = false
  tracker.runIds = [...tracker.runIds, ...runIds]
  activeExecutions.set(expId, tracker)

  ;(async () => {
    for (const runId of runIds) {
      if (abortedExperiments.has(expId)) {
        await db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ? AND status = 'pending'").run(runId)
        tracker.failed++
        continue
      }
      tracker.running++
      try {
        await executeRun(runId)
        tracker.completed++
      } catch (err) {
        tracker.failed++
        console.error(`[resume] Run ${runId} failed:`, err.message)
      }
      tracker.running--
    }
    if (tracker.running === 0) tracker.done = true
    abortedExperiments.delete(expId)
  })()

  res.json({ resumed: runIds.length, experimentId: expId })
})

// Stability analysis for an experiment
router.get('/:id/stability', requireAuth, async (req, res) => {
  const experiment = await db.prepare('SELECT * FROM experiments WHERE id = ? AND user_id = ?').get(req.params.id, req.auth.userId)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })
  const stability = computeExperimentStability(experiment.id)
  res.json(stability)
})

// Stability for a specific experiment + video
router.get('/:id/stability/:videoId', requireAuth, async (req, res) => {
  const ownerCheck = await db.prepare('SELECT id FROM experiments WHERE id = ? AND user_id = ?').get(req.params.id, req.auth.userId)
  if (!ownerCheck) return res.status(404).json({ error: 'Experiment not found' })
  const stability = computeStability(parseInt(req.params.id), parseInt(req.params.videoId))
  res.json(stability)
})

// Analyze experiment across all videos
router.post('/:id/analyze', requireAuth, async (req, res) => {
  try {
    const ownerCheck = await db.prepare('SELECT id FROM experiments WHERE id = ? AND user_id = ?').get(req.params.id, req.auth.userId)
    if (!ownerCheck) return res.status(404).json({ error: 'Experiment not found' })
    const analysis = await analyzeExperiment(parseInt(req.params.id))
    if (!analysis) return res.status(404).json({ error: 'No completed runs found' })
    res.json({ analysis })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get experiment analysis
router.get('/:id/analysis', requireAuth, async (req, res) => {
  const ownerCheck = await db.prepare('SELECT id FROM experiments WHERE id = ? AND user_id = ?').get(req.params.id, req.auth.userId)
  if (!ownerCheck) return res.status(404).json({ error: 'Experiment not found' })
  const analyses = await db.prepare(`
    SELECT ar.* FROM analysis_records ar
    WHERE ar.experiment_run_id IN (SELECT id FROM experiment_runs WHERE experiment_id = ?)
       OR (ar.analysis_type = 'cross_video' AND ar.content ILIKE ?)
    ORDER BY ar.analysis_type, ar.created_at
  `).all(req.params.id, `%experiment_id:${req.params.id}%`)
  res.json(analyses)
})

// Delete experiment
router.delete('/:id', requireAuth, async (req, res) => {
  const ownerCheck = await db.prepare('SELECT id FROM experiments WHERE id = ? AND user_id = ?').get(req.params.id, req.auth.userId)
  if (!ownerCheck) return res.status(404).json({ error: 'Experiment not found' })
  // Spending already saved to spending_log per-stage — just clean up run data
  const runs = await db.prepare('SELECT id FROM experiment_runs WHERE experiment_id = ?').all(req.params.id)
  for (const run of runs) {
    await db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
    await db.prepare('DELETE FROM metrics WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
    await db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ?').run(run.id)
    await db.prepare('DELETE FROM analysis_records WHERE experiment_run_id = ?').run(run.id)
  }
  await db.prepare('DELETE FROM experiment_runs WHERE experiment_id = ?').run(req.params.id)
  await db.prepare('DELETE FROM experiments WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

export default router
