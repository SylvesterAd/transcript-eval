import { createHash } from 'crypto'

/**
 * Compute a hash of a stage's significant fields.
 * Two stages with the same hash are considered identical.
 */
function computeStageHash(stage) {
  const significant = {
    type: stage.type || 'llm',
    model: stage.model || '',
    prompt: stage.prompt || '',
    system_instruction: stage.system_instruction || '',
    action: stage.action || '',
    actionParams: JSON.stringify(stage.actionParams || {}),
    output_mode: stage.output_mode || '',
    params: JSON.stringify(stage.params || {}),
  }
  return createHash('md5').update(JSON.stringify(significant)).digest('hex')
}

/**
 * Compare old stages array with new stages array.
 * Returns the first index from which stages differ (or where new stages are appended).
 * Returns null if stages are identical.
 */
export function findFirstChangedIndex(oldStages, newStages) {
  const minLen = Math.min(oldStages.length, newStages.length)
  for (let i = 0; i < minLen; i++) {
    if (computeStageHash(oldStages[i]) !== computeStageHash(newStages[i])) {
      return i
    }
  }
  // If new stages are longer (appended), the first new index
  if (newStages.length > oldStages.length) return oldStages.length
  // If new stages are shorter (removed), the cutoff point
  if (newStages.length < oldStages.length) return newStages.length
  // Identical
  return null
}

/**
 * Invalidate run stage outputs for all experiments using a given strategy version.
 * Deletes stage outputs from `fromIndex` onward and marks runs as 'partial' or 'pending'.
 */
export async function invalidateFromIndex(db, versionId, fromIndex, totalNewStages) {
  const experiments = await db.prepare(
    'SELECT id FROM experiments WHERE strategy_version_id = ?'
  ).all(versionId)

  let invalidated = 0
  for (const exp of experiments) {
    const runs = await db.prepare(
      "SELECT id FROM experiment_runs WHERE experiment_id = ? AND status IN ('complete', 'partial')"
    ).all(exp.id)

    for (const run of runs) {
      // Delete metrics and annotations for affected stages
      await db.prepare(`
        DELETE FROM metrics WHERE run_stage_output_id IN (
          SELECT id FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index >= ?
        )
      `).run(run.id, fromIndex)

      await db.prepare(`
        DELETE FROM deletion_annotations WHERE run_stage_output_id IN (
          SELECT id FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index >= ?
        )
      `).run(run.id, fromIndex)

      // Delete stage outputs from changed index onward
      const deleted = await db.prepare(
        'DELETE FROM run_stage_outputs WHERE experiment_run_id = ? AND stage_index >= ?'
      ).run(run.id, fromIndex)

      // Check how many stages remain
      const remaining = await db.prepare(
        'SELECT COUNT(*) as cnt FROM run_stage_outputs WHERE experiment_run_id = ?'
      ).get(run.id)

      if (remaining.cnt === 0) {
        await db.prepare(
          "UPDATE experiment_runs SET status = 'pending', total_score = NULL, score_breakdown_json = NULL, total_tokens = NULL, total_cost = NULL, total_runtime_ms = NULL, completed_at = NULL WHERE id = ?"
        ).run(run.id)
      } else {
        await db.prepare(
          "UPDATE experiment_runs SET status = 'partial', total_score = NULL, score_breakdown_json = NULL, completed_at = NULL WHERE id = ?"
        ).run(run.id)
      }
      invalidated++
    }
  }

  return invalidated
}
