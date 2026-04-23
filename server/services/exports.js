// B-Roll export service. Phase 1 responsibilities:
// - mint export IDs (ULID with `exp_` prefix, lex-sortable by time)
// - create/update exports rows
// - insert export_events rows
// - fire Slack alerts on a dedupe window for the event types listed in
//   docs/specs/2026-04-23-envato-export-design.md § Slack alerting.

import { ulid } from 'ulid'
import db from '../db.js'
// import { notify } from './slack-notifier.js'   // used by upcoming task (Task 6)

export function mintExportId() {
  return `exp_${ulid()}`
}

export async function createExport({ userId, planPipelineId, variantLabels, manifest }) {
  if (!planPipelineId) throw new Error('plan_pipeline_id required')
  if (!Array.isArray(variantLabels) || variantLabels.length === 0) throw new Error('variant_labels must be a non-empty array')
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be an object')

  const id = mintExportId()
  const manifestJson = JSON.stringify(manifest)
  const variantJson = JSON.stringify(variantLabels)

  await db.prepare(
    `INSERT INTO exports (id, user_id, plan_pipeline_id, variant_labels, status, manifest_json) VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(id, userId || null, String(planPipelineId), variantJson, manifestJson)

  const row = await db.prepare('SELECT id, created_at FROM exports WHERE id = ?').get(id)
  return { export_id: row.id, created_at: row.created_at }
}

export async function getExport(id, { userId } = {}) {
  const row = await db.prepare('SELECT * FROM exports WHERE id = ?').get(id)
  if (!row) return null
  if (userId && row.user_id && row.user_id !== userId) return null   // no leaking across users
  return row
}
