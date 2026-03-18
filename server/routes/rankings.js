import { Router } from 'express'
import db from '../db.js'

const router = Router()

/**
 * GET /api/rankings
 * Cross-strategy comparison: all experiments ranked by average score.
 */
router.get('/', (req, res) => {
  const rankings = db.prepare(`
    SELECT e.id AS experiment_id, e.name AS experiment_name,
      s.name AS strategy_name, sv.version_number,
      ROUND(AVG(er.total_score), 3) AS avg_score,
      COUNT(er.id) AS total_runs,
      SUM(CASE WHEN er.status = 'complete' THEN 1 ELSE 0 END) AS completed_runs,
      ROUND(AVG(er.total_tokens), 0) AS avg_tokens,
      ROUND(AVG(er.total_cost), 6) AS avg_cost,
      ROUND(AVG(er.total_runtime_ms), 0) AS avg_runtime_ms
    FROM experiments e
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    LEFT JOIN experiment_runs er ON er.experiment_id = e.id AND er.status = 'complete'
    GROUP BY e.id
    HAVING completed_runs > 0
    ORDER BY avg_score DESC
  `).all()

  // Get per-video scores for each experiment
  for (const r of rankings) {
    r.videoScores = db.prepare(`
      SELECT er.video_id, v.title AS video_title,
        ROUND(AVG(er.total_score), 3) AS avg_score,
        COUNT(*) AS runs
      FROM experiment_runs er
      JOIN videos v ON v.id = er.video_id
      WHERE er.experiment_id = ? AND er.status = 'complete'
      GROUP BY er.video_id
      ORDER BY er.video_id
    `).all(r.experiment_id)
  }

  res.json(rankings)
})

/**
 * GET /api/rankings/video/:videoId
 * Compare all experiments for a single video.
 */
router.get('/video/:videoId', (req, res) => {
  const { videoId } = req.params
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  if (!video) return res.status(404).json({ error: 'Video not found' })

  const rankings = db.prepare(`
    SELECT e.id AS experiment_id, e.name AS experiment_name,
      s.name AS strategy_name, sv.version_number,
      ROUND(AVG(er.total_score), 3) AS avg_score,
      COUNT(er.id) AS run_count,
      ROUND(MIN(er.total_score), 3) AS min_score,
      ROUND(MAX(er.total_score), 3) AS max_score
    FROM experiment_runs er
    JOIN experiments e ON e.id = er.experiment_id
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    WHERE er.video_id = ? AND er.status = 'complete'
    GROUP BY e.id
    ORDER BY avg_score DESC
  `).all(videoId)

  // Get stage-level detail for each experiment on this video
  for (const r of rankings) {
    r.stageMetrics = db.prepare(`
      SELECT rso.stage_index, rso.stage_name,
        ROUND(AVG(m.diff_percent), 2) AS avg_diff,
        ROUND(AVG(m.similarity_percent), 2) AS avg_similarity,
        ROUND(AVG(m.delta_vs_previous_stage), 2) AS avg_delta
      FROM run_stage_outputs rso
      JOIN metrics m ON m.run_stage_output_id = rso.id
      JOIN experiment_runs er ON er.id = rso.experiment_run_id
      WHERE er.experiment_id = ? AND er.video_id = ? AND er.status = 'complete'
        AND m.comparison_type = 'human_vs_current'
      GROUP BY rso.stage_index, rso.stage_name
      ORDER BY rso.stage_index
    `).all(r.experiment_id, videoId)

    // Get reason-aware stats
    r.reasonStats = db.prepare(`
      SELECT da.reason, COUNT(*) AS count
      FROM deletion_annotations da
      JOIN run_stage_outputs rso ON rso.id = da.run_stage_output_id
      JOIN experiment_runs er ON er.id = rso.experiment_run_id
      WHERE er.experiment_id = ? AND er.video_id = ? AND er.status = 'complete'
        AND da.comparison_type = 'human_vs_current'
        AND rso.stage_index = (SELECT MAX(rso2.stage_index) FROM run_stage_outputs rso2 WHERE rso2.experiment_run_id = er.id)
      GROUP BY da.reason
    `).all(r.experiment_id, videoId)
  }

  res.json({ video, rankings })
})

/**
 * GET /api/rankings/stages
 * Cross-strategy stage-by-stage comparison.
 */
router.get('/stages', (req, res) => {
  const stageData = db.prepare(`
    SELECT e.id AS experiment_id, e.name AS experiment_name,
      s.name AS strategy_name, sv.version_number,
      rso.stage_index, rso.stage_name,
      ROUND(AVG(m.diff_percent), 2) AS avg_diff,
      ROUND(AVG(m.similarity_percent), 2) AS avg_similarity,
      ROUND(AVG(m.delta_vs_previous_stage), 2) AS avg_delta,
      ROUND(AVG(m.timecode_preservation_score), 3) AS avg_timecode_score,
      ROUND(AVG(m.pause_marker_preservation_score), 3) AS avg_pause_score
    FROM run_stage_outputs rso
    JOIN metrics m ON m.run_stage_output_id = rso.id
    JOIN experiment_runs er ON er.id = rso.experiment_run_id
    JOIN experiments e ON e.id = er.experiment_id
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    WHERE er.status = 'complete' AND m.comparison_type = 'human_vs_current'
    GROUP BY e.id, rso.stage_index
    ORDER BY e.id, rso.stage_index
  `).all()

  // Group by experiment
  const grouped = {}
  for (const row of stageData) {
    if (!grouped[row.experiment_id]) {
      grouped[row.experiment_id] = {
        experiment_id: row.experiment_id,
        experiment_name: row.experiment_name,
        strategy_name: row.strategy_name,
        version_number: row.version_number,
        stages: []
      }
    }
    grouped[row.experiment_id].stages.push(row)
  }

  res.json(Object.values(grouped))
})

export default router
