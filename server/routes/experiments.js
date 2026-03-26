import { Router } from 'express'
import db from '../db.js'
import { executeRun, runStageProgress, abortedExperiments } from '../services/llm-runner.js'
import { computeDiff, normalizeForDiff } from '../services/diff-engine.js'
import { computeStability, computeExperimentStability } from '../services/stability.js'
import { analyzeExperiment, analyzRunWithLLM, analyzeRunCustom } from '../services/llm-analyzer.js'

const router = Router()

// List all experiments
router.get('/', (req, res) => {
  const experiments = db.prepare(`
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
    ORDER BY e.created_at DESC
  `).all()
  res.json(experiments)
})

// Get experiment with runs
router.get('/:id', (req, res) => {
  const experiment = db.prepare(`
    SELECT e.*,
      s.name AS strategy_name,
      sv.version_number,
      sv.stages_json
    FROM experiments e
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    WHERE e.id = ?
  `).get(req.params.id)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  const runs = db.prepare(`
    SELECT er.*, v.title AS video_title
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    WHERE er.experiment_id = ?
    ORDER BY v.id, er.run_number
  `).all(req.params.id)

  // Get per-video averages
  const videoAverages = db.prepare(`
    SELECT er.video_id, v.title AS video_title,
      ROUND(AVG(er.total_score), 3) AS avg_score,
      COUNT(*) AS run_count
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    WHERE er.experiment_id = ? AND er.status = 'complete'
    GROUP BY er.video_id
  `).all(req.params.id)

  // Get stage-level metrics averages
  const stageMetrics = db.prepare(`
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
router.post('/', (req, res) => {
  const { strategy_version_id, name, notes, video_ids } = req.body
  if (!strategy_version_id || !name) {
    return res.status(400).json({ error: 'strategy_version_id and name are required' })
  }

  const sv = db.prepare('SELECT * FROM strategy_versions WHERE id = ?').get(strategy_version_id)
  if (!sv) return res.status(404).json({ error: 'Strategy version not found' })

  const videoIdsJson = video_ids && Array.isArray(video_ids) && video_ids.length > 0
    ? JSON.stringify(video_ids)
    : null

  const result = db.prepare(
    'INSERT INTO experiments (strategy_version_id, name, notes, video_ids_json) VALUES (?, ?, ?, ?)'
  ).run(strategy_version_id, name, notes || null, videoIdsJson)

  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(experiment)
})

// Update experiment (video selection)
router.post('/:id/update', (req, res) => {
  const id = parseInt(req.params.id)
  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  const { video_ids } = req.body
  const videoIdsJson = video_ids && Array.isArray(video_ids) && video_ids.length > 0
    ? JSON.stringify(video_ids)
    : null

  db.prepare('UPDATE experiments SET video_ids_json = ? WHERE id = ?').run(videoIdsJson, id)
  const updated = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id)
  res.json(updated)
})

// In-memory tracking for background execution
const activeExecutions = new Map() // experimentId -> { total, completed, failed, running, runIds, done }

// Execute experiment — kicks off runs in background, returns immediately
router.post('/:id/execute', (req, res) => {
  const { repeat = 1, video_ids } = req.body || {}
  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(req.params.id)
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
    videos = db.prepare(`SELECT * FROM videos WHERE id IN (${placeholders}) ORDER BY id`).all(...effectiveIds)
  } else {
    videos = db.prepare('SELECT * FROM videos ORDER BY id').all()
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
      const result = db.prepare(
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
        db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ? AND status = 'pending'").run(runId)
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
router.get('/:id/progress', (req, res) => {
  const expId = parseInt(req.params.id)
  const tracker = activeExecutions.get(expId)

  // DB-level status summary
  const dbStatus = db.prepare(`
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
  const runs = db.prepare(`
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
      run.stages = db.prepare(`
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
router.post('/:id/abort', (req, res) => {
  const expId = parseInt(req.params.id)
  abortedExperiments.add(expId)
  // Also mark any pending runs as failed immediately
  db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE experiment_id = ? AND status = 'pending'").run(expId)
  res.json({ aborted: true })
})

// Retry failed runs — resumes from where they left off, keeps completed stages
router.post('/:id/retry', (req, res) => {
  const expId = parseInt(req.params.id)
  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(expId)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  const failedRuns = db.prepare("SELECT id FROM experiment_runs WHERE experiment_id = ? AND status = 'failed'").all(expId)
  if (failedRuns.length === 0) return res.json({ retried: 0 })

  // Reset failed runs to pending (keep their existing stage outputs for resumption)
  const runIds = failedRuns.map(r => r.id)
  for (const runId of runIds) {
    db.prepare("UPDATE experiment_runs SET status = 'pending', total_score = NULL, score_breakdown_json = NULL, total_tokens = NULL, total_cost = NULL, total_runtime_ms = NULL, completed_at = NULL WHERE id = ?").run(runId)
  }

  const tracker = activeExecutions.get(expId) || { total: 0, completed: 0, failed: 0, running: 0, done: false, runIds: [] }
  tracker.total += runIds.length
  tracker.done = false
  tracker.runIds = [...tracker.runIds, ...runIds]
  activeExecutions.set(expId, tracker)

  ;(async () => {
    for (const runId of runIds) {
      if (abortedExperiments.has(expId)) {
        db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ? AND status = 'pending'").run(runId)
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
router.post('/:id/resume', (req, res) => {
  const expId = parseInt(req.params.id)
  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(expId)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })

  const partialRuns = db.prepare(
    "SELECT id FROM experiment_runs WHERE experiment_id = ? AND status IN ('partial', 'pending')"
  ).all(expId)
  if (partialRuns.length === 0) return res.json({ resumed: 0 })

  const runIds = partialRuns.map(r => r.id)
  for (const runId of runIds) {
    db.prepare("UPDATE experiment_runs SET status = 'pending' WHERE id = ?").run(runId)
  }

  const tracker = activeExecutions.get(expId) || { total: 0, completed: 0, failed: 0, running: 0, done: false, runIds: [] }
  tracker.total += runIds.length
  tracker.done = false
  tracker.runIds = [...tracker.runIds, ...runIds]
  activeExecutions.set(expId, tracker)

  ;(async () => {
    for (const runId of runIds) {
      if (abortedExperiments.has(expId)) {
        db.prepare("UPDATE experiment_runs SET status = 'failed' WHERE id = ? AND status = 'pending'").run(runId)
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

// Get a single stage's input/output/human for the View modal
router.get('/runs/:runId/stages/:stageIndex', (req, res) => {
  const run = db.prepare(`
    SELECT er.video_id, v.group_id FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id WHERE er.id = ?
  `).get(req.params.runId)
  if (!run) return res.status(404).json({ error: 'Run not found' })

  const stage = db.prepare(
    'SELECT * FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index = ?'
  ).get(req.params.runId, parseInt(req.params.stageIndex))
  if (!stage) return res.status(404).json({ error: 'Stage not found' })

  let human = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(run.video_id)
  if (!human && run.group_id) {
    human = db.prepare(`
      SELECT t.content FROM transcripts t JOIN videos v ON v.id = t.video_id
      WHERE v.group_id = ? AND t.type = 'human_edited' LIMIT 1
    `).get(run.group_id)
  }

  const metrics = db.prepare(`
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
  })
})

// Get run detail with stage outputs
router.get('/runs/:runId', (req, res) => {
  const run = db.prepare(`
    SELECT er.*, v.title AS video_title, e.name AS experiment_name,
      s.name AS strategy_name, sv.version_number
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    JOIN experiments e ON e.id = er.experiment_id
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    WHERE er.id = ?
  `).get(req.params.runId)
  if (!run) return res.status(404).json({ error: 'Run not found' })

  const stages = db.prepare(
    'SELECT * FROM run_stage_outputs WHERE experiment_run_id = ? ORDER BY stage_index'
  ).all(req.params.runId)

  const metrics = db.prepare(`
    SELECT m.*, rso.stage_index, rso.stage_name FROM metrics m
    JOIN run_stage_outputs rso ON rso.id = m.run_stage_output_id
    WHERE rso.experiment_run_id = ?
    ORDER BY rso.stage_index, m.comparison_type
  `).all(req.params.runId)

  // Get human-edited transcript for diff display
  const human = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(run.video_id)
  const raw = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'raw'").get(run.video_id)

  // Compute diffs for each stage (human vs stage output)
  const stageDiffs = stages.map(stage => {
    const diff = computeDiff(human?.content, stage.output_text)
    return { stage_index: stage.stage_index, diff }
  })

  const scoreBreakdown = run.score_breakdown_json ? JSON.parse(run.score_breakdown_json) : null

  const rawNormalized = normalizeForDiff(raw?.content)
  const humanNormalized = normalizeForDiff(human?.content)

  res.json({ ...run, stages, metrics, stageDiffs, scoreBreakdown, raw: raw?.content, human: human?.content, rawNormalized, humanNormalized })
})

// Stability analysis for an experiment
router.get('/:id/stability', (req, res) => {
  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(req.params.id)
  if (!experiment) return res.status(404).json({ error: 'Experiment not found' })
  const stability = computeExperimentStability(experiment.id)
  res.json(stability)
})

// Stability for a specific experiment + video
router.get('/:id/stability/:videoId', (req, res) => {
  const stability = computeStability(parseInt(req.params.id), parseInt(req.params.videoId))
  res.json(stability)
})

// Analyze a run (deterministic or LLM-powered)
router.post('/runs/:runId/analyze', async (req, res) => {
  try {
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
router.get('/runs/:runId/analysis', (req, res) => {
  const analyses = db.prepare(
    'SELECT * FROM analysis_records WHERE experiment_run_id = ? ORDER BY analysis_type'
  ).all(req.params.runId)
  res.json(analyses)
})

// Analyze experiment across all videos
router.post('/:id/analyze', async (req, res) => {
  try {
    const analysis = await analyzeExperiment(parseInt(req.params.id))
    if (!analysis) return res.status(404).json({ error: 'No completed runs found' })
    res.json({ analysis })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get experiment analysis
router.get('/:id/analysis', (req, res) => {
  const analyses = db.prepare(`
    SELECT ar.* FROM analysis_records ar
    WHERE ar.experiment_run_id IN (SELECT id FROM experiment_runs WHERE experiment_id = ?)
       OR (ar.analysis_type = 'cross_video' AND ar.content LIKE ?)
    ORDER BY ar.analysis_type, ar.created_at
  `).all(req.params.id, `%experiment_id:${req.params.id}%`)
  res.json(analyses)
})

// Delete a single run
router.delete('/runs/:runId', (req, res) => {
  const run = db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(req.params.runId)
  if (!run) return res.status(404).json({ error: 'Run not found' })

  db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
  db.prepare('DELETE FROM metrics WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
  db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ?').run(run.id)
  db.prepare('DELETE FROM analysis_records WHERE experiment_run_id = ?').run(run.id)
  db.prepare('DELETE FROM experiment_runs WHERE id = ?').run(run.id)
  res.json({ success: true })
})

// Delete experiment
router.delete('/:id', (req, res) => {
  const runs = db.prepare('SELECT id FROM experiment_runs WHERE experiment_id = ?').all(req.params.id)
  for (const run of runs) {
    db.prepare('DELETE FROM deletion_annotations WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
    db.prepare('DELETE FROM metrics WHERE run_stage_output_id IN (SELECT id FROM run_stage_outputs WHERE experiment_run_id = ?)').run(run.id)
    db.prepare('DELETE FROM run_stage_outputs WHERE experiment_run_id = ?').run(run.id)
    db.prepare('DELETE FROM analysis_records WHERE experiment_run_id = ?').run(run.id)
  }
  db.prepare('DELETE FROM experiment_runs WHERE experiment_id = ?').run(req.params.id)
  db.prepare('DELETE FROM experiments WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// Today's LLM spending summary
router.get('/spending/today', (req, res) => {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS runs,
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM experiment_runs
    WHERE completed_at >= ? AND status IN ('complete', 'partial')
  `).get(today)
  res.json(stats)
})

export default router
