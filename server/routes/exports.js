import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { mintExtToken, requireExtAuth } from '../services/ext-jwt.js'
import { createExport, recordExportEvent, writeExportResult, ValidationError, NotFoundError } from '../services/exports.js'
import { getDownloadUrl as pexelsGetDownloadUrl, isEnabled as pexelsEnabled } from '../services/pexels.js'
import { getSignedDownloadUrl as freepikGetSignedUrl, isEnabled as freepikEnabled, RateLimitError as FreepikRateLimitError } from '../services/freepik.js'

const router = Router()

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { plan_pipeline_id, variant_labels, manifest } = req.body || {}
    const result = await createExport({
      userId: req.auth?.userId || null,
      planPipelineId: plan_pipeline_id,
      variantLabels: variant_labels,
      manifest,
    })
    res.status(201).json(result)
  } catch (err) {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

// POST /api/exports/:id/result
//
// Writes the {variants:[{label, sequenceName, placements}, ...]} shape to
// exports.result_json. Called by WebApp.1's State E handler AFTER the
// extension signals {type:"complete"} — the client has the placement
// timing data from the unified manifest built at State C, so the client
// is the authority on what to write.
//
// Why not put this inside the extension telemetry flow? Phase 1's
// recordExportEvent writes raw `meta` (counts only) to result_json;
// coercing its shape would conflate telemetry semantics with a write
// concern for a specific downstream consumer (XMEML). Keeping the
// writer separate here means the extension contract doesn't have to
// care about XMEML's input shape.
//
// Request body: { variants: [{ label, sequenceName, placements: [...] }, ...] }
// Response: 200 { ok: true } | 400 { error } | 404 { error } | 500 passthrough
router.post('/:id/result', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth?.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    const { id } = req.params
    const { variants } = req.body || {}
    const result = await writeExportResult({ id, userId, variants })
    res.status(200).json(result)
  } catch (err) {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message })
    if (err instanceof NotFoundError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

export const sessionTokenRouter = Router()
sessionTokenRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth?.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    const result = await mintExtToken(userId)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

export const exportEventsRouter = Router()
exportEventsRouter.post('/', requireExtAuth, async (req, res, next) => {
  try {
    await recordExportEvent({ userId: req.ext?.userId || null, body: req.body })
    res.status(202).json({ ok: true })
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError) {
      return res.status(err.status).json({ error: err.message })
    }
    next(err)
  }
})

export const pexelsUrlRouter = Router()
pexelsUrlRouter.post('/', requireExtAuth, async (req, res, next) => {
  try {
    if (!pexelsEnabled()) return res.status(503).json({ error: 'Pexels is not configured' })
    const { item_id, preferred_resolution } = req.body || {}
    if (!item_id) return res.status(400).json({ error: 'item_id required' })
    const result = await pexelsGetDownloadUrl(item_id, preferred_resolution || '1080p')
    res.json(result)
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: 'Pexels item not found' })
    next(err)
  }
})

export const freepikUrlRouter = Router()
freepikUrlRouter.post('/', requireExtAuth, async (req, res, next) => {
  try {
    if (!freepikEnabled()) return res.status(503).json({ error: 'Freepik is not configured' })
    const { item_id, format } = req.body || {}
    if (!item_id) return res.status(400).json({ error: 'item_id required' })
    const result = await freepikGetSignedUrl(item_id, format || 'mp4')
    res.json(result)
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: 'Freepik item not found' })
    if (err instanceof FreepikRateLimitError) return res.status(429).json({ error: 'Freepik rate limit' })
    next(err)
  }
})

export default router
