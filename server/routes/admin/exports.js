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

export default router
