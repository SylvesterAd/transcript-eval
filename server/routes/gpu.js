import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../auth.js'
import { brollPipelineProgress } from '../services/broll.js'

const router = Router()

// Supabase client for reading GPU proxy logs
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SECRET_KEY
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null

// GET /api/gpu/runs — Recent GPU search runs from Supabase broll_search_logs
router.get('/runs', requireAuth, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' })
  }

  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const { data, error } = await supabase
      .from('broll_search_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    res.json({ runs: data })
  } catch (err) {
    console.error('[gpu/runs] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/gpu/progress — Active pipeline GPU progress from in-memory map
router.get('/progress', requireAuth, (_req, res) => {
  const active = []
  for (const [pipelineId, prog] of brollPipelineProgress.entries()) {
    if (prog.gpuStage || prog.gpuStatus) {
      active.push({
        pipelineId,
        status: prog.status,
        stageName: prog.stageName,
        stageIndex: prog.stageIndex,
        totalStages: prog.totalStages,
        gpuStage: prog.gpuStage,
        gpuStatus: prog.gpuStatus,
        subDone: prog.subDone,
        subTotal: prog.subTotal,
        subLabel: prog.subLabel,
        startedAt: prog.startedAt,
      })
    }
  }
  res.json({ active })
})

// GET /api/gpu/jobs — Recent GPU jobs with per-stage persistence
router.get('/jobs', requireAuth, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' })
  }

  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const { data, error } = await supabase
      .from('broll_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    res.json({ jobs: data })
  } catch (err) {
    console.error('[gpu/jobs] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
