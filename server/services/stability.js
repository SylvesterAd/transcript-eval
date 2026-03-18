import db from '../db.js'
import { calculateSimilarity } from './diff-engine.js'

/**
 * Compute stability metrics for repeated runs of an experiment on a specific video.
 * Requires at least 2 runs to be meaningful.
 */
export function computeStability(experimentId, videoId) {
  const runs = db.prepare(`
    SELECT er.*, rso_final.output_text AS final_output
    FROM experiment_runs er
    LEFT JOIN run_stage_outputs rso_final ON rso_final.experiment_run_id = er.id
      AND rso_final.stage_index = (SELECT MAX(rso2.stage_index) FROM run_stage_outputs rso2 WHERE rso2.experiment_run_id = er.id)
    WHERE er.experiment_id = ? AND er.video_id = ? AND er.status = 'complete'
    ORDER BY er.run_number
  `).all(experimentId, videoId)

  if (runs.length < 2) {
    return { runs: runs.length, stable: null, message: 'Need at least 2 runs for stability analysis' }
  }

  // Score variance
  const scores = runs.map(r => r.total_score).filter(s => s !== null)
  const scoreStats = computeStats(scores)

  // Text variance — compare each run's final output to every other run
  const textSimilarities = []
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[i].final_output && runs[j].final_output) {
        const sim = calculateSimilarity(runs[i].final_output, runs[j].final_output)
        textSimilarities.push({
          runA: runs[i].run_number,
          runB: runs[j].run_number,
          similarity: sim.similarityPercent
        })
      }
    }
  }

  const simValues = textSimilarities.map(t => t.similarity)
  const textStats = computeStats(simValues)

  // Per-stage variance
  const stageCount = db.prepare(`
    SELECT MAX(stage_index) AS max_stage FROM run_stage_outputs
    WHERE experiment_run_id IN (SELECT id FROM experiment_runs WHERE experiment_id = ? AND video_id = ? AND status = 'complete')
  `).get(experimentId, videoId)?.max_stage ?? 0

  const stageVariance = []
  for (let s = 0; s <= stageCount; s++) {
    const stageMetrics = db.prepare(`
      SELECT m.similarity_percent, m.diff_percent
      FROM metrics m
      JOIN run_stage_outputs rso ON rso.id = m.run_stage_output_id
      JOIN experiment_runs er ON er.id = rso.experiment_run_id
      WHERE er.experiment_id = ? AND er.video_id = ? AND er.status = 'complete'
        AND rso.stage_index = ? AND m.comparison_type = 'human_vs_current'
    `).all(experimentId, videoId, s)

    const sims = stageMetrics.map(m => m.similarity_percent)
    stageVariance.push({
      stage_index: s,
      stats: computeStats(sims)
    })
  }

  // Runtime variance
  const runtimes = runs.map(r => r.total_runtime_ms).filter(r => r !== null)
  const runtimeStats = computeStats(runtimes)

  // Stability classification
  const isStable = scoreStats.stddev < 0.02 && textStats.mean > 95

  return {
    runs: runs.length,
    stable: isStable,
    score: {
      ...scoreStats,
      perRun: runs.map(r => ({ run: r.run_number, score: r.total_score }))
    },
    text: {
      ...textStats,
      pairs: textSimilarities
    },
    stageVariance,
    runtime: runtimeStats
  }
}

/**
 * Compute stability across all videos for an experiment.
 */
export function computeExperimentStability(experimentId) {
  const videos = db.prepare('SELECT DISTINCT video_id FROM experiment_runs WHERE experiment_id = ?').all(experimentId)

  const perVideo = {}
  for (const { video_id } of videos) {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(video_id)
    perVideo[video_id] = {
      video,
      stability: computeStability(experimentId, video_id)
    }
  }

  // Overall stats
  const allScores = db.prepare(
    'SELECT total_score FROM experiment_runs WHERE experiment_id = ? AND status = ? AND total_score IS NOT NULL'
  ).all(experimentId, 'complete').map(r => r.total_score)

  return {
    overall: computeStats(allScores),
    perVideo
  }
}

function computeStats(values) {
  if (!values || values.length === 0) return { mean: null, min: null, max: null, stddev: null, variance: null, count: 0 }
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)
  return {
    mean: round(mean),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    stddev: round(stddev),
    variance: round(variance),
    range: round(Math.max(...values) - Math.min(...values)),
    count: n
  }
}

function round(n) {
  return Math.round(n * 10000) / 10000
}
