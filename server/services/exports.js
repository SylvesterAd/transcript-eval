// B-Roll export service. Phase 1 responsibilities:
// - mint export IDs (ULID with `exp_` prefix, lex-sortable by time)
// - create/update exports rows
// - insert export_events rows
// - fire Slack alerts on a dedupe window for the event types listed in
//   docs/specs/2026-04-23-envato-export-design.md § Slack alerting.

import { ulid } from 'ulid'
import db from '../db.js'
import { notify } from './slack-notifier.js'

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotFoundError'
    this.status = 404
  }
}

export function mintExportId() {
  return `exp_${ulid()}`
}

export async function createExport({ userId, planPipelineId, variantLabels, manifest }) {
  if (!planPipelineId) throw new ValidationError('plan_pipeline_id required')
  if (!Array.isArray(variantLabels) || variantLabels.length === 0) throw new ValidationError('variant_labels must be a non-empty array')
  if (!manifest || typeof manifest !== 'object') throw new ValidationError('manifest must be an object')

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
  // If caller passed a userId, the row must match (null-owner rows are
  // treated as inaccessible — there is no legitimate null-owner code
  // path in Phase 1; all creates go through a requireAuth route).
  if (userId && row.user_id !== userId) return null
  return row
}

const ALLOWED_EVENTS = new Set([
  'export_started', 'item_resolved', 'item_licensed', 'item_downloaded',
  'item_failed', 'rate_limit_hit', 'session_expired',
  'queue_paused', 'queue_resumed', 'export_completed',
])

const META_MAX_BYTES = 4096

// In-process Slack dedupe: key → last-fired epoch ms. 60s window.
const slackLastFired = new Map()
const SLACK_DEDUPE_MS = 60_000

function maybeSlackAlert(evt, userId) {
  let title = null
  if (evt.event === 'item_failed' && (evt.error_code === 'envato_403' || evt.error_code === 'envato_429')) {
    title = `Envato ${evt.error_code} on item ${evt.item_id || '?'}`
  } else if (evt.event === 'session_expired') {
    title = 'Envato session expired mid-run'
  } else if (evt.event === 'export_completed') {
    const failCount = evt.meta && typeof evt.meta.fail_count === 'number' ? evt.meta.fail_count : 0
    if (failCount >= 10) title = `Export completed with ${failCount} failures`
  }
  if (!title) return

  const key = `${userId || 'anon'}|${evt.event}|${evt.error_code || ''}`
  const now = Date.now()
  const last = slackLastFired.get(key) || 0
  if (now - last < SLACK_DEDUPE_MS) return
  slackLastFired.set(key, now)

  notify({
    source: 'broll-export',
    title,
    meta: {
      export_id: evt.export_id,
      user_id: userId || null,
      source: evt.source || null,
      http_status: evt.http_status || null,
      retry_count: evt.retry_count || null,
    },
  })
}

export async function recordExportEvent({ userId, body }) {
  if (!body || typeof body !== 'object') throw new ValidationError('body required')
  const { export_id, event, item_id, source, phase, error_code, http_status, retry_count, meta, t } = body

  if (!export_id) throw new ValidationError('export_id required')
  if (!event || !ALLOWED_EVENTS.has(event)) throw new ValidationError(`unknown event: ${event}`)
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new ValidationError('t must be a finite number (epoch_ms)')

  let metaJson = null
  if (meta != null) {
    if (typeof meta !== 'object' || Array.isArray(meta)) throw new ValidationError('meta must be an object')
    try {
      metaJson = JSON.stringify(meta)
    } catch {
      throw new ValidationError('meta not JSON-serializable')
    }
    if (Buffer.byteLength(metaJson, 'utf8') > META_MAX_BYTES) throw new ValidationError('meta too large (max 4 KB)')
  }

  // Ownership check: the export must exist and belong to this user.
  const row = await db.prepare('SELECT id, user_id, status FROM exports WHERE id = ?').get(export_id)
  // Collapse missing-vs-not-owned to the same 404 message so the endpoint
  // can't be used to enumerate valid export_ids.
  if (!row || (userId && row.user_id && row.user_id !== userId)) {
    throw new NotFoundError('export_id not found')
  }

  const receivedAt = Date.now()
  await db.prepare(
    `INSERT INTO export_events (export_id, user_id, event, item_id, source, phase, error_code, http_status, retry_count, meta_json, t, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(export_id, userId || null, event, item_id || null, source || null, phase || null, error_code || null,
        http_status || null, retry_count || null, metaJson, t, receivedAt)

  // Status transitions on lifecycle events
  if (event === 'export_started' && row.status === 'pending') {
    await db.prepare(`UPDATE exports SET status = 'in_progress' WHERE id = ?`).run(export_id)
  } else if (event === 'export_completed') {
    const failCount = meta && typeof meta.fail_count === 'number' ? meta.fail_count : 0
    const okCount = meta && typeof meta.ok_count === 'number' ? meta.ok_count : 0
    let status
    if (failCount === 0) status = 'complete'
    else if (okCount === 0) status = 'failed'
    else status = 'partial'
    const resultJson = meta ? JSON.stringify(meta) : null
    await db.prepare(`UPDATE exports SET status = ?, completed_at = NOW(), result_json = COALESCE(?, result_json) WHERE id = ?`)
      .run(status, resultJson, export_id)
  }

  // Side-effect: Slack (dedupe window of 60s per user+event+error_code).
  maybeSlackAlert({ ...body, export_id }, userId)
}
