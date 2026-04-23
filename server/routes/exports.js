import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { createExport } from '../services/exports.js'

const router = Router()

router.post('/', requireAuth, async (req, res) => {
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
    res.status(400).json({ error: err.message })
  }
})

export default router
