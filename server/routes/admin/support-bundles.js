// server/routes/admin/support-bundles.js
// POST /api/admin/support-bundles/parse — STATELESS bundle parser.
// Accepts raw application/zip bytes, calls the pure parser, returns JSON.
// NO persistence, NO filesystem side effects. See WebApp.4 plan § invariant #1.

import { Router } from 'express'
import express from 'express'
import { requireAuth, isAdmin } from '../../auth.js'
import { parseBundle, BundleParseError } from '../../services/bundle-parser.js'

const router = Router()

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// POST /parse — body is raw application/zip (≤50MB).
// Response 200: { meta, queue, events, environment }
// Response 400: { error: '<errorCode>', ...detail }
// Response 401: { error: 'Authentication required' }    (via requireAuth)
// Response 403: { error: 'Admin access required' }       (via requireAdmin)
// Response 413: sent by express.raw when body > 50MB
// Response 422: { error: 'unsupported_bundle_version', supported_versions, got }
router.post(
  '/parse',
  express.raw({ limit: '50mb', type: 'application/zip' }),
  requireAuth,
  requireAdmin,
  (req, res, next) => {
    try {
      const body = req.body
      if (!body || !Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: 'missing_zip_body' })
      }
      const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      const parsed = parseBundle(bytes)
      return res.json(parsed)
    } catch (err) {
      if (err instanceof BundleParseError) {
        return res.status(err.httpStatus).json({ error: err.errorCode, ...err.detail })
      }
      next(err)
    }
  }
)

export default router
