import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { mintExtToken, requireExtAuth } from '../services/ext-jwt.js'
import { createExport, recordExportEvent, ValidationError, NotFoundError } from '../services/exports.js'

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

export default router
