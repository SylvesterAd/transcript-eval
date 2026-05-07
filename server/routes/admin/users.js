// server/routes/admin/users.js
//
// Admin-only user listing + inspection. Backs the /admin/users panel.
//
// Mount: server/index.js → app.use('/api/admin/users', router)
//
// Auth: requireAuth + requireAdmin. requireAdmin is declared locally to
// match the pattern in server/routes/admin/exports.js — extracting into
// shared middleware is a follow-up once a third file needs it.
//
// Data model: users live in Supabase Auth, not in our SQLite/Postgres.
// We list them via the Supabase Admin API (service role) and enrich
// each with a project_count drawn from our local video_groups table.
//
// Failure mode: if SUPABASE_SERVICE_ROLE_KEY is unset, both routes
// respond 503 with a clear message so the admin nav can still render
// and other admin pages keep working.

import { Router } from 'express'
import { requireAuth, isAdmin } from '../../auth.js'
import db from '../../db.js'
import { hasSupabaseAdminConfig, getSupabaseAdmin } from '../../services/supabase-admin.js'

const router = Router()

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

function requireSupabaseAdminConfig(_req, res, next) {
  if (!hasSupabaseAdminConfig()) {
    return res.status(503).json({
      error: 'Admin user listing requires SUPABASE_SERVICE_ROLE_KEY (and SUPABASE_URL).',
    })
  }
  next()
}

// GET /api/admin/users
//
// Query params (all optional):
//   ?page=1&perPage=50    1-based pagination, perPage capped at 200
//
// Response 200:
//   { users: [{ id, email, created_at, last_sign_in_at, project_count }],
//     total, page, perPage }
//
// project_count is the number of root video_groups (parent_group_id IS
// NULL) owned by each user — sub-groups created by multicam classification
// don't count as separate projects.
router.get('/', requireAuth, requireAdmin, requireSupabaseAdminConfig, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(Math.max(1, parseInt(req.query.perPage) || 50), 200)

    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) {
      // Surface upstream error verbatim — Supabase phrases these clearly
      // ("invalid_credentials", "user_not_found"). No need to re-wrap.
      return res.status(502).json({ error: `Supabase: ${error.message}` })
    }

    const users = data?.users || []
    const userIds = users.map(u => u.id)

    // Count root projects per user in a single grouped query. Empty IN ()
    // is invalid SQL, so guard against an empty user list.
    const projectCountByUser = {}
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',')
      const rows = await db.prepare(
        `SELECT user_id, COUNT(*) AS project_count
         FROM video_groups
         WHERE user_id IN (${placeholders}) AND parent_group_id IS NULL
         GROUP BY user_id`
      ).all(...userIds)
      for (const row of rows) {
        projectCountByUser[row.user_id] = parseInt(row.project_count) || 0
      }
    }

    const enriched = users.map(u => ({
      id: u.id,
      email: u.email || null,
      created_at: u.created_at || null,
      last_sign_in_at: u.last_sign_in_at || null,
      project_count: projectCountByUser[u.id] || 0,
    }))

    // Supabase doesn't expose a `total` on listUsers; we approximate
    // with `data.total` if the SDK populates it (recent SDKs do), else
    // null — the UI shows "page N" without a total when null.
    const total = typeof data?.total === 'number' ? data.total : null

    res.json({ users: enriched, total, page, perPage })
  } catch (err) {
    next(err)
  }
})

// GET /api/admin/users/:userId
//
// Response 200:
//   { user: { id, email, created_at, last_sign_in_at,
//             email_confirmed_at, app_metadata, user_metadata },
//     projects: [{ id, name, created_at, assembly_status,
//                  rough_cut_status, broll_chain_status,
//                  broll_chain_substage, path_id, auto_rough_cut }] }
//
// projects are root video_groups (parent_group_id IS NULL), newest first.
// 404 if Supabase has no record of the user — even if local video_groups
// rows exist for that user_id (shouldn't happen, but explicit > implicit).
router.get('/:userId', requireAuth, requireAdmin, requireSupabaseAdminConfig, async (req, res, next) => {
  try {
    const { userId } = req.params

    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase.auth.admin.getUserById(userId)
    if (error) {
      return res.status(502).json({ error: `Supabase: ${error.message}` })
    }
    const u = data?.user
    if (!u) {
      return res.status(404).json({ error: 'User not found' })
    }

    const projects = await db.prepare(
      `SELECT id, name, created_at, assembly_status,
              rough_cut_status, broll_chain_status, broll_chain_substage,
              path_id, auto_rough_cut
       FROM video_groups
       WHERE user_id = ? AND parent_group_id IS NULL
       ORDER BY created_at DESC`
    ).all(userId)

    res.json({
      user: {
        id: u.id,
        email: u.email || null,
        created_at: u.created_at || null,
        last_sign_in_at: u.last_sign_in_at || null,
        email_confirmed_at: u.email_confirmed_at || null,
        app_metadata: u.app_metadata || null,
        user_metadata: u.user_metadata || null,
      },
      projects,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/admin/users/:userId/impersonate
//
// Mints a one-time magiclink that, when visited, signs the browser in
// as the target user. The admin's own session is replaced — there is
// no "switch back" without a fresh sign-in. Returns:
//
//   { action_link: <supabase verify URL>, email: <target> }
//
// Body (optional):
//   { redirect_to: <absolute URL> }   passed through to Supabase as
//                                     redirectTo so the post-verify
//                                     bounce lands on the caller's
//                                     origin instead of the project's
//                                     default site URL.
//
// 404 if the target has no email (phone-only / OAuth-only accounts
// can't receive a magiclink). 502 surfaces upstream Supabase errors.
router.post('/:userId/impersonate', requireAuth, requireAdmin, requireSupabaseAdminConfig, async (req, res, next) => {
  try {
    const { userId } = req.params
    const supabase = getSupabaseAdmin()

    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId)
    if (userErr) return res.status(502).json({ error: `Supabase: ${userErr.message}` })
    const target = userData?.user
    if (!target) return res.status(404).json({ error: 'User not found' })
    if (!target.email) {
      return res.status(404).json({
        error: 'Target user has no email — magiclink impersonation requires one',
      })
    }

    const linkOptions = {}
    if (typeof req.body?.redirect_to === 'string' && req.body.redirect_to) {
      linkOptions.redirectTo = req.body.redirect_to
    }

    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: target.email,
      options: linkOptions,
    })
    if (error) return res.status(502).json({ error: `Supabase: ${error.message}` })

    const actionLink = data?.properties?.action_link
    if (!actionLink) {
      return res.status(502).json({ error: 'Supabase did not return an action_link' })
    }

    res.json({ action_link: actionLink, email: target.email })
  } catch (err) {
    next(err)
  }
})

export default router
