// server/routes/admin/exports.js
//
// Admin-only read routes over Phase 1's exports + export_events tables.
// Read-only by design (WebApp.3). No retry/cancel/delete.
//
// Mount: server/index.js → app.use('/api/admin/exports', router)
//
// Auth model: every handler composes `requireAuth + requireAdmin`.
// The middleware order matters — `requireAuth` short-circuits on missing
// auth and must run first to emit the correct 401. `requireAdmin`
// follows to emit 403 for authed-but-non-admin. Declared locally rather
// than sharing with server/routes/admin.js because the extraction into
// server/middleware/* is a follow-up once a second file needs it.
//
// Pagination: offset/limit matching /api/admin/api-logs. Max limit 200.
// Default 50. Consumer contract: { exports, total, limit, offset }.
//
// Date filters: `since` and `until` are ISO 8601. Omitted defaults apply
// per WebApp.3's open question #3 — the UI layer passes explicit
// `since` for the last 7 days; the server layer does not default.

import { Router } from 'express'
import { requireAuth, isAdmin } from '../../auth.js'
import db from '../../db.js'

const router = Router()

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// GET /api/admin/exports
//
// Query params (all optional):
//   ?limit=50&offset=0           pagination
//   ?failures_only=true          status IN ('failed','partial')
//   ?user_id=<uuid>              exact match
//   ?since=<iso>                 created_at >= ?
//   ?until=<iso>                 created_at <= ?
//
// Response 200: { exports: [...], total: <int>, limit, offset }
// Response 401: { error: 'Authentication required' }   (via requireAuth)
// Response 403: { error: 'Admin access required' }     (via requireAdmin)
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = parseInt(req.query.offset) || 0
    const failuresOnly = String(req.query.failures_only || '') === 'true'
    const userId = req.query.user_id || null
    const since = req.query.since || null
    const until = req.query.until || null

    const where = []
    const params = []
    if (failuresOnly) {
      where.push("status IN ('failed','partial')")
    }
    if (userId) {
      where.push('user_id = ?')
      params.push(userId)
    }
    if (since) {
      where.push('created_at >= ?')
      params.push(since)
    }
    if (until) {
      where.push('created_at <= ?')
      params.push(until)
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const listSql = `
      SELECT
        id, user_id, plan_pipeline_id, variant_labels, status,
        folder_path, created_at, completed_at,
        (SELECT COUNT(*) FROM export_events ev
           WHERE ev.export_id = exports.id AND ev.event = 'item_failed')     AS failed_count,
        (SELECT COUNT(*) FROM export_events ev
           WHERE ev.export_id = exports.id AND ev.event = 'item_downloaded') AS downloaded_count
      FROM exports
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `
    const rows = await db.prepare(listSql).all(...params, limit, offset)

    const countSql = `SELECT COUNT(*) AS total FROM exports ${whereClause}`
    const countRow = await db.prepare(countSql).get(...params)

    res.json({
      exports: rows,
      total: parseInt(countRow.total),
      limit,
      offset,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/admin/exports/:id/events
//
// Returns the full export row + all events in `t ASC` order (the
// index idx_export_events_export is ordered on (export_id, t), so
// ASC hits the index exactly). Aggregates are computed in JS from
// the events array — no second query — since we've already paid
// for the events fetch.
//
// Response 200: {
//   export: { id, user_id, plan_pipeline_id, variant_labels, status,
//             manifest_json, result_json, xml_paths, folder_path,
//             created_at, completed_at },
//   events: [{ id, event, item_id, source, phase, error_code,
//              http_status, retry_count, meta, t, received_at }, ...],
//   aggregates: { fail_count, success_count, by_source: {...},
//                 by_error_code: {...} }
// }
// Response 404: { error: 'export not found' }
// Response 401/403: via requireAuth/requireAdmin
router.get('/:id/events', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params
    const exportRow = await db.prepare(
      `SELECT id, user_id, plan_pipeline_id, variant_labels, status,
              manifest_json, result_json, xml_paths, folder_path,
              created_at, completed_at
       FROM exports WHERE id = ?`
    ).get(id)
    if (!exportRow) return res.status(404).json({ error: 'export not found' })

    // `t ASC` hits idx_export_events_export(export_id, t). Do not
    // change to `received_at` — that's the server-stamp for clock-skew
    // triage only and is not the primary sort.
    const events = await db.prepare(
      `SELECT id, event, item_id, source, phase, error_code,
              http_status, retry_count, meta_json, t, received_at
       FROM export_events
       WHERE export_id = ?
       ORDER BY t ASC`
    ).all(id)

    // Parse meta_json server-side so the client doesn't re-parse
    // per row in render. Null on parse failure — the client treats
    // meta as optional.
    const eventsParsed = events.map(e => {
      let meta = null
      if (e.meta_json) {
        try { meta = JSON.parse(e.meta_json) } catch { /* leave null */ }
      }
      const { meta_json, ...rest } = e
      return { ...rest, meta }
    })

    // Aggregates: per-source and per-error_code failure rates.
    // Only counts events with event === 'item_failed'. Per-source
    // also counts successes so the UI can render a rate (failed /
    // (failed + downloaded)) per source.
    const bySource = {}
    const byErrorCode = {}
    let failCount = 0
    let successCount = 0
    for (const ev of eventsParsed) {
      if (ev.event === 'item_failed') {
        failCount++
        const src = ev.source || 'unknown'
        bySource[src] = bySource[src] || { failed: 0, succeeded: 0 }
        bySource[src].failed++
        const code = ev.error_code || 'unknown'
        byErrorCode[code] = (byErrorCode[code] || 0) + 1
      } else if (ev.event === 'item_downloaded') {
        successCount++
        const src = ev.source || 'unknown'
        bySource[src] = bySource[src] || { failed: 0, succeeded: 0 }
        bySource[src].succeeded++
      }
    }

    res.json({
      export: exportRow,
      events: eventsParsed,
      aggregates: {
        fail_count: failCount,
        success_count: successCount,
        by_source: bySource,
        by_error_code: byErrorCode,
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
