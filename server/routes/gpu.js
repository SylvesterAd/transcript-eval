import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../auth.js'
import { brollPipelineProgress } from '../services/broll.js'

const router = Router()

// Supabase client for reading GPU proxy logs
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SECRET_KEY
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null

// GET /api/gpu/runs — Recent GPU search runs from Supabase broll_search_logs + broll_jobs
router.get('/runs', requireAuth, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' })
  }

  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)

    // Fetch both tables in parallel — only light columns (pipeline_stages/results fetched on expand)
    const logColumns = 'id,created_at,brief,keywords,sources,num_candidates,num_unique_thumbnails,num_videos_reranked,num_results,processing_time_seconds,rerank_model,caller,error'
    const jobColumns = 'id,created_at,status,instance_id,request,error,updated_at,pipeline_stages'
    const [logsRes, jobsRes] = await Promise.all([
      supabase.from('broll_search_logs').select(logColumns).order('created_at', { ascending: false }).limit(limit),
      supabase.from('broll_jobs').select(jobColumns).order('created_at', { ascending: false }).limit(limit),
    ])

    if (logsRes.error) throw logsRes.error
    const logs = logsRes.data || []
    const jobs = jobsRes.data || []

    // Match logs to jobs — log is created when pipeline finishes, job when it starts.
    // Match by: log.created_at is between job.created_at and job.updated_at (+ 30s buffer)
    const matchedJobIds = new Set()
    for (const log of logs) {
      const logTime = new Date(log.created_at).getTime()
      let bestJob = null
      let bestDiff = Infinity
      for (const job of jobs) {
        const jobStart = new Date(job.created_at).getTime()
        const jobEnd = new Date(job.updated_at || job.created_at).getTime() + 30000
        if (logTime >= jobStart && logTime <= jobEnd) {
          const diff = logTime - jobStart
          if (diff < bestDiff) {
            bestDiff = diff
            bestJob = job
          }
        }
      }
      if (bestJob) {
        log.job_id = bestJob.id
        log.instance_id = bestJob.instance_id
        log.job_status = bestJob.status
        matchedJobIds.add(bestJob.id)
      }
    }

    // Include unmatched jobs (stuck/in-progress/failed without a search_logs entry)
    const unmatchedJobs = jobs.filter(j => !matchedJobIds.has(j.id)).map(j => {
      const req2 = j.request || {}
      const ps = j.pipeline_stages || {}
      const stats = ps.stats || {}
      return {
        id: `job-${j.id}`,
        created_at: j.created_at,
        brief: req2.brief || '',
        keywords: req2.keywords || [],
        sources: req2.sources || null,
        num_candidates: stats.candidates || 0,
        num_unique_thumbnails: stats.unique || 0,
        num_videos_reranked: 0,
        num_results: Array.isArray(j.final_results?.results) ? j.final_results.results.length : 0,
        processing_time_seconds: j.updated_at ? (new Date(j.updated_at) - new Date(j.created_at)) / 1000 : 0,
        rerank_model: null,
        error: j.error,
        job_id: j.id,
        job_status: j.status,
        instance_id: j.instance_id,
        is_job: true,
      }
    })

    // Merge and sort by created_at descending
    const all = [...logs, ...unmatchedJobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    // Strip heavy fields from list response — fetched on expand via /runs/:id
    const light = all.map(({ results, pipeline_stages, search_results, siglip_results, final_results, ...rest }) => ({
      ...rest,
      num_results: rest.num_results || (Array.isArray(results) ? results.length : 0),
    }))
    res.json({ runs: light })
  } catch (err) {
    console.error('[gpu/runs] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/gpu/runs/:id — Full detail for a single run (with heavy fields)
router.get('/runs/:id', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })

  try {
    const runId = req.params.id

    // Check if it's a job-prefixed ID
    if (runId.startsWith('job-')) {
      const jobId = runId.slice(4)
      const { data: job, error } = await supabase.from('broll_jobs').select('*').eq('id', jobId).single()
      if (error) throw error
      const req2 = job.request || {}
      const jobStats = (job.pipeline_stages || {}).stats || {}
      return res.json({
        id: runId,
        brief: req2.brief || '',
        keywords: req2.keywords || [],
        sources: req2.sources || null,
        results: job.final_results?.results || job.final_results || [],
        pipeline_stages: { search: job.search_results, siglip: job.siglip_results, source_warnings: (job.pipeline_stages || {}).source_warnings, stats: (job.pipeline_stages || {}).stats },
        num_candidates: jobStats.candidates || (Array.isArray(job.search_results) ? job.search_results.length : 0),
        num_unique_thumbnails: jobStats.unique || (Array.isArray(job.siglip_results) ? job.siglip_results.length : 0),
        num_results: Array.isArray(job.final_results?.results) ? job.final_results.results.length : (Array.isArray(job.final_results) ? job.final_results.length : 0),
        error: job.error,
        job_id: job.id,
        job_status: job.status,
        instance_id: job.instance_id,
        created_at: job.created_at,
        is_job: true,
      })
    }

    // Regular search log
    const { data: log, error } = await supabase.from('broll_search_logs').select('*').eq('id', parseInt(runId)).single()
    if (error) throw error

    // Try to find matching job
    const logTime = new Date(log.created_at).getTime()
    const { data: jobs } = await supabase.from('broll_jobs').select('id, status, instance_id').order('created_at', { ascending: false }).limit(20)
    for (const job of (jobs || [])) {
      const diff = Math.abs(new Date(job.created_at || 0).getTime() - logTime)
      if (diff < 10000) {
        log.job_id = job.id
        log.instance_id = job.instance_id
        log.job_status = job.status
        break
      }
    }

    res.json(log)
  } catch (err) {
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
        gpuJobId: prog.gpuJobId || null,
        subDone: prog.subDone,
        subTotal: prog.subTotal,
        subLabel: prog.subLabel,
        startedAt: prog.startedAt,
      })
    }
  }
  res.json({ active })
})

// POST /api/gpu/runs/:id/abort — Mark a stuck/running job as failed
router.post('/runs/:id/abort', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })

  try {
    const runId = req.params.id
    const jobId = runId.startsWith('job-') ? runId.slice(4) : runId

    const { data: job, error: fetchErr } = await supabase.from('broll_jobs').select('id,status').eq('id', jobId).single()
    if (fetchErr) throw fetchErr
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (job.status === 'complete' || job.status === 'failed') {
      return res.json({ ok: true, status: job.status, message: 'Already finished' })
    }

    const { error: updateErr } = await supabase.from('broll_jobs')
      .update({ status: 'failed', error: 'Aborted by user', updated_at: new Date().toISOString() })
      .eq('id', jobId)
    if (updateErr) throw updateErr

    res.json({ ok: true, status: 'failed' })
  } catch (err) {
    console.error('[gpu/abort] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
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
