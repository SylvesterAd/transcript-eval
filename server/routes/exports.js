import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { createExport, ValidationError } from '../services/exports.js'
import { mintExtToken } from '../services/ext-jwt.js'

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

export default router
