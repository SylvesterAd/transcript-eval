import { Router } from 'express'
import { createHash } from 'crypto'
import db from '../db.js'
import { computeDiff, extractDeletions, extractAdditions, calculateSimilarity, fullComparison } from '../services/diff-engine.js'
import { classifyDeletions, reasonStats } from '../services/classifier.js'
import { scoreOutput } from '../services/scorer.js'

const router = Router()

/** Generate a cache key from two texts */
function cacheKey(type, textA, textB) {
  const hash = createHash('md5').update(textA).update('||').update(textB).digest('hex')
  return `${type}:${hash}`
}

/** Get cached diff result or compute, cache, and return */
function getCachedDiff(type, rawContent, humanContent) {
  const key = cacheKey(type, rawContent, humanContent)
  const cached = db.prepare('SELECT result_json FROM diff_cache WHERE cache_key = ?').get(key)
  if (cached) return JSON.parse(cached.result_json)

  const comparison = fullComparison(rawContent, humanContent)
  const classified = classifyDeletions(comparison.deletions)
  const result = {
    comparison_type: type,
    diff: comparison.diff,
    similarity: comparison.similarity,
    deletions: classified,
    additions: comparison.additions,
    timecodes: comparison.timecodes,
    pauses: comparison.pauses,
    reasonStats: reasonStats(classified)
  }

  db.prepare('INSERT OR REPLACE INTO diff_cache (cache_key, result_json) VALUES (?, ?)').run(key, JSON.stringify(result))
  return result
}

/**
 * GET /api/diffs/video/:videoId/raw-vs-human
 * Compare raw transcript vs human-edited for a benchmark video.
 */
router.get('/video/:videoId/raw-vs-human', (req, res) => {
  const { videoId } = req.params
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  if (!video) return res.status(404).json({ error: 'Video not found' })

  // Look for transcripts on this video first
  let raw = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'raw'").get(videoId)
  let human = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(videoId)

  // For grouped videos, also check group assembled transcript and sibling transcripts
  if (video.group_id) {
    if (!raw) {
      const group = db.prepare('SELECT assembled_transcript FROM video_groups WHERE id = ? AND assembly_status = ?').get(video.group_id, 'done')
      if (group?.assembled_transcript) raw = { content: group.assembled_transcript }
    }
    if (!human) {
      const sibHuman = db.prepare(`
        SELECT t.content FROM transcripts t
        JOIN videos v ON v.id = t.video_id
        WHERE v.group_id = ? AND v.id != ? AND t.type = 'human_edited'
        LIMIT 1
      `).get(video.group_id, videoId)
      if (sibHuman) human = sibHuman
    }
    if (!raw) {
      const sibRaw = db.prepare(`
        SELECT t.content FROM transcripts t
        JOIN videos v ON v.id = t.video_id
        WHERE v.group_id = ? AND t.type = 'raw'
        ORDER BY v.duration_seconds DESC
        LIMIT 1
      `).get(video.group_id)
      if (sibRaw) raw = sibRaw
    }
  }

  if (!raw || !human) return res.status(404).json({ error: 'Transcripts not found' })

  res.json(getCachedDiff('raw_vs_human', raw.content, human.content))
})

/**
 * POST /api/diffs/compare
 * Compare any two texts. Body: { textA, textB, rawText? }
 */
router.post('/compare', (req, res) => {
  const { textA, textB, rawText } = req.body
  if (!textA || !textB) return res.status(400).json({ error: 'textA and textB are required' })

  res.json(getCachedDiff('compare', textA, textB))
})

/**
 * POST /api/diffs/score
 * Score a workflow output. Body: { raw, humanEdited, current }
 */
router.post('/score', (req, res) => {
  const { raw, humanEdited, current } = req.body
  if (!raw || !humanEdited || !current) {
    return res.status(400).json({ error: 'raw, humanEdited, and current are required' })
  }

  const score = scoreOutput(raw, humanEdited, current)
  res.json(score)
})

/**
 * GET /api/diffs/video/:videoId/full
 * Full analysis of raw vs human for a benchmark video, including scoring preview.
 */
router.get('/video/:videoId/full', (req, res) => {
  const { videoId } = req.params
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  const raw = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'raw'").get(videoId)
  const human = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(videoId)

  if (!video || !raw || !human) return res.status(404).json({ error: 'Video or transcripts not found' })

  const result = getCachedDiff('full', raw.content, human.content)

  res.json({
    video,
    raw: raw.content,
    human_edited: human.content,
    comparison: {
      diff: result.diff,
      similarity: result.similarity,
      deletions: result.deletions,
      additions: result.additions,
      timecodes: result.timecodes,
      pauses: result.pauses,
      reasonStats: result.reasonStats
    }
  })
})

/** Invalidate cache for a video (call when transcripts change) */
export function invalidateDiffCache() {
  db.prepare('DELETE FROM diff_cache').run()
}

router.post('/clear-cache', (req, res) => {
  invalidateDiffCache()
  res.json({ ok: true })
})

export default router
