// Reusable AI Rough Cut runner.
//
// Used by:
//   - POST /videos/groups/:id/start-ai-roughcut (manual editor button)
//   - multicam-sync.updateStatus when assembly transitions to 'done' on a
//     group with auto_rough_cut = true (slice 1 auto-trigger)
//
// Behaviour matches the prior inline route handler exactly:
//   1. Look up group (404-equivalent if missing or not owned).
//   2. Compute tokenCost from total durations.
//   3. Transactional balance deduction; rollback + 'insufficient_tokens'
//      if balance < cost.
//   4. Short-circuit with already_exists if group.annotations_json has
//      items (and !force).
//   5. Find main strategy + latest version.
//   6. Create experiment + experiment_run rows.
//   7. Return synchronously with all IDs.
//   8. Kick off pipeline in background (executeRun + buildAnnotations).
//
import db from '../db.js'
import { estimateTokenCost } from './token-pricing.js'

export async function runAiRoughCut({ groupId, userId, isAdmin = false, force = false }) {
  const ownerScope = isAdmin ? '' : 'AND user_id = ?'
  const args = isAdmin ? [groupId] : [groupId, userId]
  const group = await db.prepare(
    `SELECT * FROM video_groups WHERE id = ? ${ownerScope}`
  ).get(...args)
  if (!group) return { error: 'not_found' }

  const videos = await db.prepare(
    'SELECT duration_seconds FROM videos WHERE group_id = ?'
  ).all(groupId)
  const totalDuration = videos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0)
  const tokenCost = estimateTokenCost(totalDuration)

  // Transactional token deduction.
  const client = await db.pool.connect()
  let balanceAfter
  try {
    await client.query('BEGIN')
    await client.query(
      'INSERT INTO user_tokens (user_id, balance) VALUES ($1, 10000) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    )
    const { rows } = await client.query(
      'SELECT balance FROM user_tokens WHERE user_id = $1 FOR UPDATE',
      [userId]
    )
    const currentBalance = rows[0]?.balance ?? 0
    if (currentBalance < tokenCost) {
      await client.query('ROLLBACK')
      return { error: 'insufficient_tokens', balance: currentBalance, required: tokenCost }
    }
    balanceAfter = currentBalance - tokenCost
    await client.query(
      'UPDATE user_tokens SET balance = $1, updated_at = NOW() WHERE user_id = $2',
      [balanceAfter, userId]
    )
    await client.query(
      `INSERT INTO token_transactions (user_id, amount, balance_after, type, description, group_id)
       VALUES ($1, $2, $3, 'debit', $4, $5)`,
      [userId, -tokenCost, balanceAfter, `AI Rough Cut for project ${groupId}`, groupId]
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // Short-circuit if annotations already exist (unless force).
  if (group.annotations_json && !force) {
    try {
      const ann = JSON.parse(group.annotations_json)
      if (ann?.items?.length > 0) {
        return { already_exists: true, tokensDeducted: tokenCost, balanceAfter }
      }
    } catch { /* proceed */ }
  }

  // Clean up stale 'pending' Auto runs (>5 min old).
  await db.prepare(`
    UPDATE experiment_runs SET status = 'failed'
    WHERE id IN (
      SELECT er.id FROM experiment_runs er
      JOIN experiments e ON e.id = er.experiment_id
      WHERE er.video_id IN (SELECT id FROM videos WHERE group_id = ?)
        AND er.status = 'pending'
        AND e.name ILIKE 'Auto:%'
        AND er.created_at < NOW() - INTERVAL '5 minutes'
    )
  `).run(groupId)

  const mainStrategy = await db.prepare('SELECT * FROM strategies WHERE is_main = 1').get()
  if (!mainStrategy) return { error: 'no_main_strategy' }
  const version = await db.prepare(
    'SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version_number DESC LIMIT 1'
  ).get(mainStrategy.id)
  if (!version) return { error: 'no_strategy_versions' }

  const video = await db.prepare(`
    SELECT v.* FROM videos v
    JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id = ? AND v.video_type = 'raw'
    ORDER BY v.id LIMIT 1
  `).get(groupId)
  if (!video) return { error: 'no_video_with_transcript' }

  const expResult = await db.prepare(
    'INSERT INTO experiments (strategy_version_id, name, notes, video_ids_json, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(version.id, `Auto: ${mainStrategy.name}`, `Auto-run for group ${groupId}`, JSON.stringify([video.id]), userId)

  const experimentId = Number(expResult.lastInsertRowid)
  const runResult = await db.prepare(
    'INSERT INTO experiment_runs (experiment_id, video_id, run_number, status) VALUES (?, ?, 1, ?)'
  ).run(experimentId, video.id, 'pending')
  const runId = Number(runResult.lastInsertRowid)

  let stageInfos = []
  try {
    const stages = JSON.parse(version.stages_json || '[]')
    stageInfos = stages.map((s, i) => ({
      name: s.name || `Stage ${i + 1}`,
      type: s.type || 'llm',
    }))
  } catch {}

  // Background pipeline (executeRun → buildAnnotations → write annotations_json).
  // Same retry semantics as the previous inline IIFE.
  ;(async () => {
    const MAX_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { executeRun } = await import('./llm-runner.js')
        if (attempt > 1) {
          console.log(`[runAiRoughCut] Retry attempt ${attempt} for group ${groupId} (run ${runId})`)
          await db.prepare("UPDATE experiment_runs SET status = 'pending', error_message = NULL WHERE id = ?").run(runId)
        }
        await executeRun(runId)
        const completedRun = await db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(runId)
        if (completedRun.status !== 'complete' && completedRun.status !== 'partial') {
          if (attempt < MAX_ATTEMPTS) continue
          return
        }
        const am = await import('./annotation-mapper.js')
        let wordTimestamps = await am.getTimelineWordTimestamps(groupId)
        if (!wordTimestamps?.length) {
          const transcript = await db.prepare(
            "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'"
          ).get(video.id)
          if (transcript?.word_timestamps_json) {
            try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch {}
          }
        }
        if (!wordTimestamps?.length) return
        const groupData = await db.prepare(
          'SELECT assembled_transcript FROM video_groups WHERE id = ?'
        ).get(groupId)
        const annotations = await am.buildAnnotationsFromRun(runId, wordTimestamps, groupData?.assembled_transcript)
        await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?').run(JSON.stringify(annotations), groupId)
        // If this run was the auto-trigger (rough_cut_status was set), flip to done.
        // Use a conditional UPDATE so a manual-trigger run (status null) stays null.
        await db.prepare(
          "UPDATE video_groups SET rough_cut_status = 'done' WHERE id = ? AND rough_cut_status IN ('pending', 'running')"
        ).run(groupId)
        return
      } catch (err) {
        console.error(`[runAiRoughCut] Attempt ${attempt} failed for group ${groupId}:`, err.message)
      }
    }
    // All attempts exhausted — mark as failed if this was an auto-trigger.
    await db.prepare(
      "UPDATE video_groups SET rough_cut_status = 'failed' WHERE id = ? AND rough_cut_status IN ('pending', 'running')"
    ).run(groupId)
  })()

  return {
    ok: true,
    experimentId, runId,
    totalStages: stageInfos.length,
    stageNames: stageInfos.map(s => s.name),
    stageTypes: stageInfos.map(s => s.type),
    tokensDeducted: tokenCost,
    balanceAfter,
  }
}
