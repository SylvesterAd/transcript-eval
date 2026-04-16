import { Router } from 'express'
import multer from 'multer'
import { dirname, join, extname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'
import { requireAuth } from '../auth.js'
import { uploadFile } from '../services/storage.js'
import { extractThumbnail } from '../services/video-processor.js'
import db from '../db.js'
import {
  BROLL_MODELS,
  createStrategy,
  createStrategyBundle,
  createVersion,
  deleteStrategy,
  getStrategy,
  getVersion,
  listStrategies,
  listStrategyBundles,
  listVersions,
  listRuns,
  listAllRuns,
  deleteRun,
  addExampleSource,
  listExampleSources,
  deleteExampleSource,
  analyzeVideo,
  executePipeline,
  brollPipelineProgress,
  updateStrategy,
  updateVersion,
  listReferenceAnalysisRuns,
  setExampleFavorite,
  downloadYouTubeVideo,
  abortedBrollPipelines,
  pipelineAbortControllers,
  updateExampleSourceStatus,
  getPipelineSnapshot,
  executeAltPlans,
  executeKeywords,
  executeBrollSearch,
  getBRollEditorData,
  searchSinglePlacement,
  executePlanPrep,
  executeCreateStrategy,
  executeCreatePlan,
  loadExampleVideos,
} from '../services/broll.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = join(__dirname, '..', '..', 'uploads', 'temp')
mkdirSync(TEMP_DIR, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_DIR,
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E6) + extname(file.originalname)),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
})

const router = Router()

// Defaults & models
router.get('/defaults', (req, res) => res.json({ models: BROLL_MODELS }))
router.get('/models', (req, res) => res.json({ models: BROLL_MODELS }))

// Strategies
router.get('/strategies', requireAuth, async (req, res) => {
  const list = await listStrategies()
  res.json(list)
})

router.get('/strategy-bundles', requireAuth, async (req, res) => {
  const bundles = await listStrategyBundles()
  res.json(bundles)
})

router.post('/strategy-bundles', requireAuth, async (req, res) => {
  try {
    const bundle = await createStrategyBundle(req.body || {})
    res.status(201).json(bundle)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.post('/strategies', requireAuth, async (req, res) => {
  try {
    const strategy = await createStrategy(req.body)
    res.status(201).json(strategy)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/strategies/:id', requireAuth, async (req, res) => {
  const strategy = await getStrategy(req.params.id)
  if (!strategy) return res.status(404).json({ error: 'Not found' })
  res.json(strategy)
})

router.put('/strategies/:id', requireAuth, async (req, res) => {
  try {
    const strategy = await updateStrategy(req.params.id, req.body || {})
    res.json(strategy)
  } catch (err) {
    res.status(err.message === 'Strategy not found' ? 404 : 400).json({ error: err.message })
  }
})

router.delete('/strategies/:id', requireAuth, async (req, res) => {
  await deleteStrategy(req.params.id)
  res.json({ success: true })
})

// Versions
router.get('/strategies/:id/versions', requireAuth, async (req, res) => {
  const versions = await listVersions(req.params.id)
  res.json(versions)
})

router.post('/strategies/:id/versions', requireAuth, async (req, res) => {
  try {
    const version = await createVersion(req.params.id, req.body || {})
    res.status(201).json(version)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/versions/:versionId', requireAuth, async (req, res) => {
  const v = await getVersion(req.params.versionId)
  if (!v) return res.status(404).json({ error: 'Not found' })
  res.json(v)
})

router.put('/strategies/:id/versions/:versionId', requireAuth, async (req, res) => {
  try {
    const version = await updateVersion(req.params.id, req.params.versionId, req.body || {})
    res.json(version)
  } catch (err) {
    res.status(err.message === 'Version not found' ? 404 : 400).json({ error: err.message })
  }
})

// Runs
router.get('/runs', requireAuth, async (req, res) => {
  const runs = await listAllRuns()

  // Collect active pipelines from in-memory progress
  const activePipelines = []
  for (const [pipelineId, prog] of brollPipelineProgress.entries()) {
    if (prog.status === 'running' || prog.status === 'complete' || prog.status === 'failed') {
      const completedStages = runs.filter(r => {
        try { return JSON.parse(r.metadata_json || '{}').pipelineId === pipelineId } catch { return false }
      }).length
      activePipelines.push({ pipelineId, ...prog, completedStages })
    }
  }

  res.json({ runs, activePipelines })
})

router.get('/strategies/:id/runs', requireAuth, async (req, res) => {
  const runs = await listRuns(req.params.id)
  res.json(runs)
})

// Get runs for a specific video (used by BRollPanel to check existing plans)
router.get('/runs/video/:videoId', requireAuth, async (req, res) => {
  const runs = await listAllRuns()
  const videoRuns = runs.filter(r => r.video_id === parseInt(req.params.videoId))

  // Also check for active pipelines
  const active = []
  for (const [pipelineId, prog] of brollPipelineProgress.entries()) {
    if (prog.status === 'running' && prog.videoId === parseInt(req.params.videoId)) {
      active.push({ pipelineId, ...prog })
    }
  }

  res.json({ runs: videoRuns, activePipelines: active })
})

router.delete('/runs/:id', requireAuth, async (req, res) => {
  await deleteRun(req.params.id)
  res.json({ success: true })
})

// Example sources (per group)
router.get('/groups/:groupId/examples', requireAuth, async (req, res) => {
  const sources = await listExampleSources(req.params.groupId)
  res.json(sources)
})

router.post('/groups/:groupId/examples', requireAuth, async (req, res) => {
  try {
    const { kind, source_url, label } = req.body || {}
    if (!kind) return res.status(400).json({ error: 'kind required (yt_channel, yt_video, upload)' })
    const source = await addExampleSource(req.params.groupId, {
      kind, source_url, label,
      createdBy: req.auth?.userId || null,
    })
    // Start background YouTube download immediately for yt_video sources
    if (kind === 'yt_video' && source_url) {
      downloadYouTubeVideo(source.id).catch(err =>
        console.error(`[broll] Background download failed for source ${source.id}:`, err.message)
      )
    }
    res.status(201).json(source)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/examples/:id', requireAuth, async (req, res) => {
  await deleteExampleSource(req.params.id)
  res.json({ success: true })
})

// Upload local file as reference video
router.post('/groups/:groupId/examples/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const groupId = parseInt(req.params.groupId)
    const label = req.body.label || req.file.originalname.replace(extname(req.file.originalname), '')

    // Create example source
    const source = await addExampleSource(groupId, {
      kind: 'upload',
      source_url: null,
      label,
      createdBy: req.auth?.userId || null,
    })

    // Upload to storage
    await updateExampleSourceStatus(source.id, 'processing')
    const storageUrl = await uploadFile('videos', req.file.filename, req.file.path)

    // Extract and upload thumbnail
    let thumbnailUrl = null
    try {
      const thumbFilename = req.file.filename.replace(extname(req.file.filename), '.jpg')
      const localThumbPath = await extractThumbnail(req.file.path, thumbFilename)
      if (localThumbPath) {
        thumbnailUrl = await uploadFile('thumbnails', thumbFilename, localThumbPath)
        try { const { unlinkSync } = await import('fs'); unlinkSync(localThumbPath) } catch {}
      }
    } catch (err) {
      console.log(`[broll-upload] Thumbnail extraction failed (non-fatal): ${err.message}`)
    }

    // Create video record (not linked to group — linkage is via broll_example_sources)
    const result = await db.prepare(
      'INSERT INTO videos (title, file_path, thumbnail_path, video_type) VALUES (?, ?, ?, ?)'
    ).run(label, storageUrl, thumbnailUrl, 'human_edited')
    const videoId = Number(result.lastInsertRowid)

    // Link to example source with thumbnail in meta
    await updateExampleSourceStatus(source.id, 'ready', null, { videoId, thumbnailUrl })
    const updated = await db.prepare('SELECT * FROM broll_example_sources WHERE id = ?').get(source.id)
    res.status(201).json(updated)
  } catch (err) {
    res.status(400).json({ error: err.message })
  } finally {
    try { const { unlinkSync } = await import('fs'); unlinkSync(req.file.path) } catch {}
  }
})

router.put('/examples/:id/favorite', requireAuth, async (req, res) => {
  try {
    const source = await setExampleFavorite(req.params.id)
    res.json(source)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.post('/strategies/:id/analyze', requireAuth, async (req, res) => {
  try {
    const { video_id, stage } = req.body || {}
    if (!video_id) return res.status(400).json({ error: 'video_id required' })
    const result = await analyzeVideo(req.params.id, video_id, stage || 'main')
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Pipeline execution (multi-stage sequential)
router.post('/strategies/:id/versions/:versionId/run', requireAuth, async (req, res) => {
  try {
    const { video_id, group_id, transcript_source, reference_run_id, stop_after_plan, example_video_id } = req.body || {}
    if (!video_id) return res.status(400).json({ error: 'video_id required' })

    // Load editor cuts from group if available (needed for plan strategies)
    let editorCuts = null
    if (group_id) {
      const group = await (await import('../db.js')).default
        .prepare('SELECT editor_state_json FROM video_groups WHERE id = ?')
        .get(group_id)
      if (group?.editor_state_json) {
        try {
          const state = JSON.parse(group.editor_state_json)
          if (state.cuts?.length) {
            editorCuts = { cuts: state.cuts, cutExclusions: state.cutExclusions || [] }
          }
        } catch {}
      }
    }

    const result = await executePipeline(
      req.params.id,
      req.params.versionId,
      video_id,
      group_id || null,
      transcript_source || 'raw',
      editorCuts,
      reference_run_id || null,
      null,
      { stopAfterPlan: !!stop_after_plan, exampleVideoId: example_video_id || null },
    )
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// List available reference analysis runs for a strategy (for plan strategy selection)
router.get('/strategies/:id/reference-runs', requireAuth, async (req, res) => {
  try {
    const strategy = await getStrategy(req.params.id)
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' })
    const targetId = strategy.main_strategy_id || req.params.id
    const runs = await listReferenceAnalysisRuns(targetId)
    res.json(runs)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Pipeline progress
router.get('/pipeline/:pipelineId/progress', requireAuth, (req, res) => {
  const progress = brollPipelineProgress.get(req.params.pipelineId)
  if (!progress) return res.json({ status: 'unknown' })
  res.json(progress)
})

// Stop ALL running pipelines
router.post('/pipeline/stop-all', requireAuth, (req, res) => {
  let stopped = 0
  for (const [pipelineId, controller] of pipelineAbortControllers.entries()) {
    abortedBrollPipelines.add(pipelineId)
    controller.abort()
    pipelineAbortControllers.delete(pipelineId)
    stopped++
  }
  console.log(`[broll-pipeline] stop-all: ${stopped} pipelines aborted`)
  res.json({ success: true, stopped })
})

// Stop a running pipeline — immediately abort all in-flight requests
router.post('/pipeline/:pipelineId/stop', requireAuth, (req, res) => {
  const { pipelineId } = req.params
  abortedBrollPipelines.add(pipelineId)
  // Abort all in-flight fetch requests (uploads, LLM calls) immediately
  const controller = pipelineAbortControllers.get(pipelineId)
  if (controller) {
    controller.abort()
    pipelineAbortControllers.delete(pipelineId)
    console.log(`[broll-pipeline] ${pipelineId} abort signal sent — all in-flight requests cancelled`)
  }
  res.json({ success: true })
})

// Resume an interrupted/failed pipeline, or re-run from a specific stage
router.post('/pipeline/:pipelineId/resume', requireAuth, async (req, res) => {
  try {
    const { pipelineId } = req.params
    const { fromStage } = req.body || {} // optional: re-run from this stage index onwards

    // Alt plan and keywords pipelines can't be resumed — they must be re-triggered from their dedicated endpoints
    if (pipelineId.startsWith('alt-')) return res.status(400).json({ error: 'Alt plan pipelines must be re-run via "Generate Alt Plans" button, not resumed' })
    if (pipelineId.startsWith('kw-')) return res.status(400).json({ error: 'Keywords pipelines must be re-run via "Generate Keywords" button, not resumed' })
    if (pipelineId.startsWith('bs-')) return res.status(400).json({ error: 'B-Roll search pipelines must be re-run via "Search B-Roll" button, not resumed' })

    // Load ALL runs for this pipeline (main stages + sub-runs)
    const allRuns = await db.prepare(`
      SELECT * FROM broll_runs
      WHERE metadata_json LIKE ? AND status = 'complete'
      ORDER BY id
    `).all(`%"pipelineId":"${pipelineId}"%`)

    if (!allRuns.length) return res.status(404).json({ error: 'No completed stages found for this pipeline' })

    // Separate main stages and sub-runs
    const mainRuns = []
    const subRunsByStage = {} // stageIndex → [sub-runs sorted by subIndex]
    for (const run of allRuns) {
      const meta = JSON.parse(run.metadata_json || '{}')
      if (meta.isSubRun) {
        const si = meta.stageIndex
        if (si != null) {
          if (!subRunsByStage[si]) subRunsByStage[si] = []
          subRunsByStage[si].push({ ...run, _meta: meta })
        }
      } else {
        mainRuns.push(run)
      }
    }

    if (!mainRuns.length) return res.status(404).json({ error: 'No completed stages found for this pipeline' })

    // Extract pipeline info from first run's metadata
    const firstMeta = JSON.parse(mainRuns[0].metadata_json || '{}')
    const strategyId = mainRuns[0].strategy_id
    const videoId = mainRuns[0].video_id
    // groupId may be missing from old metadata — fall back to video's group
    let groupId = firstMeta.groupId || null
    if (!groupId && videoId) {
      const video = await db.prepare('SELECT group_id FROM videos WHERE id = ?').get(videoId)
      groupId = video?.group_id || null
    }

    // Get latest version
    const version = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategyId)
    if (!version) return res.status(400).json({ error: 'No strategy version found' })
    const newTemplateStages = JSON.parse(version.stages_json || '[]')

    // Build completed stages map
    // Group old runs by videoLabel to identify per-video groups
    const videoGroups = {}
    for (const run of mainRuns) {
      const meta = JSON.parse(run.metadata_json || '{}')
      if (meta.stageIndex == null) continue
      const vl = meta.videoLabel || ''
      if (!videoGroups[vl]) videoGroups[vl] = []
      videoGroups[vl].push({ stageIndex: meta.stageIndex, stageName: meta.stageName, output: run.output_text || '' })
    }
    const videoLabelOrder = Object.keys(videoGroups)

    const completedStages = {}
    for (let v = 0; v < videoLabelOrder.length; v++) {
      const vl = videoLabelOrder[v]
      const offset = v * newTemplateStages.length
      for (const run of videoGroups[vl]) {
        // Find this stage's position in the new template by name
        const newTemplateIdx = newTemplateStages.findIndex(s => s.name === run.stageName)
        if (newTemplateIdx >= 0) {
          const newIndex = newTemplateIdx + offset
          completedStages[newIndex] = run.output
          console.log(`[broll-resume] "${run.stageName}" [${vl || 'default'}] old:${run.stageIndex} → new:${newIndex}`)
        } else {
          // Stage name doesn't exist in new template — skip it (strategy changed this stage)
          console.log(`[broll-resume] Skipping "${run.stageName}" — not in new strategy`)
        }
      }
    }

    // NOTE: Do NOT reconstruct stages from partial sub-runs into completedStages.
    // Partial sub-runs are handled by completedSubRuns inside executePipeline —
    // it loads existing sub-runs and only re-runs the missing ones.

    // If re-running from a specific stage, drop everything from that stage onwards
    if (fromStage != null) {
      // Remember which stages we're keeping vs dropping
      const keptStages = new Set()
      for (const key of Object.keys(completedStages)) {
        if (Number(key) >= fromStage) {
          delete completedStages[key]
        } else {
          keptStages.add(Number(key))
        }
      }
      console.log(`[broll-resume] Re-running from stage ${fromStage}, keeping ${keptStages.size} completed stages`)

      // Delete old DB entries for stages being re-run (fromStage and everything after)
      for (const run of allRuns) {
        const meta = JSON.parse(run.metadata_json || '{}')
        if (meta.stageIndex == null || keptStages.has(meta.stageIndex)) continue
        if (meta.stageIndex >= fromStage) {
          await db.prepare('DELETE FROM broll_runs WHERE id = ?').run(run.id)
        }
      }
    }
    if (!version) return res.status(400).json({ error: 'No strategy version found' })

    // Load editor cuts if available
    let editorCuts = null
    if (groupId) {
      const group = await db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(groupId)
      if (group?.editor_state_json) {
        try {
          const state = JSON.parse(group.editor_state_json)
          if (state.cuts?.length) editorCuts = { cuts: state.cuts, cutExclusions: state.cutExclusions || [] }
        } catch {}
      }
    }

    // Build set of completed sub-run indices per stage (for partial recovery)
    const completedSubRuns = {} // stageIndex → Set of subIndex
    for (const [si, subs] of Object.entries(subRunsByStage)) {
      completedSubRuns[si] = new Set(subs.map(s => s._meta.subIndex).filter(i => i != null))
    }

    // Clear any previous abort flag so the resumed pipeline doesn't immediately abort
    abortedBrollPipelines.delete(pipelineId)

    // Fire and forget — same pattern as the run endpoint
    const result = executePipeline(
      strategyId, version.id, videoId, groupId,
      firstMeta.transcriptSource || 'raw',
      editorCuts, null,
      { completedStages, completedSubRuns, originalPipelineId: pipelineId, skipAnalysis: firstMeta.analysisStageCount === 0 },
    )

    res.json({ pipelineId, resumed: true, completedStages: Object.keys(completedStages).length })

    // Await in background
    result.catch(err => console.error(`[broll-pipeline] Resume failed for ${pipelineId}:`, err.message))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/pipeline/:pipelineId/snapshot', requireAuth, async (req, res) => {
  const data = getPipelineSnapshot(req.params.pipelineId)
  if (!data) return res.status(404).json({ error: 'No snapshot found for this pipeline' })
  res.json(data)
})

// Run alt plans using a completed plan pipeline's data
router.post('/pipeline/:pipelineId/run-alt-plans', requireAuth, async (req, res) => {
  try {
    const { pipelineId } = req.params
    // Fire and forget
    const result = executeAltPlans(pipelineId)
    res.json({ pipelineId, started: true })
    result.catch(err => console.error(`[broll-pipeline] Alt plans failed for ${pipelineId}:`, err.message))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Run keywords generation using a completed plan pipeline's data
router.post('/pipeline/:pipelineId/run-keywords', requireAuth, async (req, res) => {
  try {
    const { pipelineId } = req.params
    const result = executeKeywords(pipelineId)
    res.json({ pipelineId, started: true })
    result.catch(err => console.error(`[broll-pipeline] Keywords failed for ${pipelineId}:`, err.message))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Run B-Roll video search using keywords + GPU-powered API
router.get('/pipeline/:pipelineId/editor-data', requireAuth, async (req, res) => {
  try {
    const data = await getBRollEditorData(req.params.pipelineId)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/pipeline/:pipelineId/search-placement', requireAuth, async (req, res) => {
  try {
    const { pipelineId } = req.params
    const { chapterIndex, placementIndex, description, style, sources } = req.body
    if (chapterIndex == null || placementIndex == null) {
      return res.status(400).json({ error: 'chapterIndex and placementIndex required' })
    }
    const overrides = {}
    if (description) overrides.description = description
    if (style) overrides.style = style
    if (sources) overrides.sources = sources
    const result = await searchSinglePlacement(pipelineId, chapterIndex, placementIndex, overrides)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/pipeline/:pipelineId/run-broll-search', requireAuth, async (req, res) => {
  try {
    const { pipelineId } = req.params
    const limit = req.body.limit ? parseInt(req.body.limit, 10) : undefined
    const result = executeBrollSearch(pipelineId, { limit })
    res.json({ pipelineId, started: true, limit })
    result.catch(err => console.error(`[broll-pipeline] B-Roll search failed for ${pipelineId}:`, err.message))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Split Pipeline Routes ──

// One-button: start prep + analysis runs in parallel
router.post('/pipeline/run-all', requireAuth, async (req, res) => {
  try {
    const { video_id, group_id } = req.body || {}
    if (!video_id || !group_id) return res.status(400).json({ error: 'video_id and group_id required' })

    // Load editor cuts
    let editorCuts = null
    const group = await (await import('../db.js')).default
      .prepare('SELECT editor_state_json FROM video_groups WHERE id = ?')
      .get(group_id)
    if (group?.editor_state_json) {
      try {
        const state = JSON.parse(group.editor_state_json)
        if (state.cuts?.length) editorCuts = { cuts: state.cuts, cutExclusions: state.cutExclusions || [] }
      } catch {}
    }

    // Load example videos
    const examples = await loadExampleVideos(group_id)
    const readyVideos = examples.filter(v => v.id) // filter to ready videos with IDs

    // Fire prep (don't await — fire and forget)
    const prepPromise = executePlanPrep(video_id, group_id, editorCuts)
    prepPromise.catch(err => console.error(`[broll-pipeline] Plan prep failed: ${err.message}`))

    // Fire analysis runs in parallel (one per example video)
    const analysisStrategy = await (await import('../db.js')).default
      .prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'main_analysis' ORDER BY id LIMIT 1").get()

    let analysisPipelineIds = []
    if (analysisStrategy) {
      const analysisVersion = await (await import('../db.js')).default
        .prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(analysisStrategy.id)

      if (analysisVersion) {
        for (const vid of readyVideos) {
          const analysisPromise = executePipeline(
            analysisStrategy.id,
            analysisVersion.id,
            video_id,
            group_id,
            'raw',
            null,
            null,
            null,
            { exampleVideoId: vid.id },
          )
          analysisPromise.then(r => analysisPipelineIds.push(r.pipelineId))
            .catch(err => console.error(`[broll-pipeline] Analysis for video ${vid.id} failed: ${err.message}`))
        }
      }
    }

    // Wait briefly for pipeline IDs to be generated (they're created synchronously at start of executePipeline)
    await new Promise(r => setTimeout(r, 500))

    // Get the prep pipeline ID from progress map
    let prepPipelineId = null
    for (const [pid, prog] of brollPipelineProgress.entries()) {
      if (prog.videoId === video_id && prog.strategyName?.includes('Prep')) {
        prepPipelineId = pid
        break
      }
    }

    res.json({
      prepPipelineId,
      analysisPipelineIds: readyVideos.map(v => {
        // Find the pipeline ID for this video from progress map
        for (const [pid, prog] of brollPipelineProgress.entries()) {
          if (prog.videoId === video_id && pid.includes(`-ex${v.id}`)) return pid
        }
        return null
      }).filter(Boolean),
      videoCount: readyVideos.length,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Create strategies (one per analysis pipeline)
router.post('/pipeline/run-strategies', requireAuth, async (req, res) => {
  try {
    const { prep_pipeline_id, analysis_pipeline_ids, video_id, group_id } = req.body || {}
    if (!prep_pipeline_id || !analysis_pipeline_ids?.length || !video_id) {
      return res.status(400).json({ error: 'prep_pipeline_id, analysis_pipeline_ids, and video_id required' })
    }

    const strategyPipelineIds = []
    for (const analysisPipelineId of analysis_pipeline_ids) {
      const promise = executeCreateStrategy(prep_pipeline_id, analysisPipelineId, video_id, group_id || null)
      promise
        .then(r => strategyPipelineIds.push(r.strategyPipelineId))
        .catch(err => console.error(`[broll-pipeline] Create strategy failed for analysis ${analysisPipelineId}: ${err.message}`))
    }

    // Wait briefly for pipeline IDs to be generated
    await new Promise(r => setTimeout(r, 500))

    res.json({
      strategyPipelineIds: strategyPipelineIds.length ? strategyPipelineIds : analysis_pipeline_ids.map((_, i) => {
        // Fallback: find from progress map
        for (const [pid, prog] of brollPipelineProgress.entries()) {
          if (pid.startsWith('strat-') && prog.phase === 'create_strategy') return pid
        }
        return null
      }).filter(Boolean),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Create plan from a selected strategy
router.post('/pipeline/run-plan', requireAuth, async (req, res) => {
  try {
    const { prep_pipeline_id, strategy_pipeline_id, video_id, group_id } = req.body || {}
    if (!prep_pipeline_id || !strategy_pipeline_id || !video_id) {
      return res.status(400).json({ error: 'prep_pipeline_id, strategy_pipeline_id, and video_id required' })
    }

    const result = executeCreatePlan(prep_pipeline_id, strategy_pipeline_id, video_id, group_id || null)
    result.catch(err => console.error(`[broll-pipeline] Create plan failed: ${err.message}`))

    // Wait briefly for pipeline ID
    await new Promise(r => setTimeout(r, 500))

    // Find pipeline ID from progress map
    let planPipelineId = null
    for (const [pid, prog] of brollPipelineProgress.entries()) {
      if (pid.startsWith('plan-') && prog.phase === 'create_plan') {
        planPipelineId = pid
        break
      }
    }

    res.json({ planPipelineId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Transcript sources available for a video
router.get('/videos/:videoId/transcript-sources', requireAuth, async (req, res) => {
  try {
    const videoId = req.params.videoId
    const sources = []

    const raw = await (await import('../db.js')).default
      .prepare("SELECT id FROM transcripts WHERE video_id = ? AND type = 'raw'")
      .get(videoId)
    if (raw) sources.push({ id: 'raw', label: 'Raw Transcript', available: true })

    const human = await (await import('../db.js')).default
      .prepare("SELECT id FROM transcripts WHERE video_id = ? AND type = 'human_edited'")
      .get(videoId)
    sources.push({ id: 'human_edited', label: 'Human Edited', available: Boolean(human) })

    const roughCut = await (await import('../db.js')).default
      .prepare(`
        SELECT rso.id FROM run_stage_outputs rso
        JOIN experiment_runs er ON er.id = rso.experiment_run_id
        WHERE er.video_id = ? AND er.status = 'complete'
        ORDER BY rso.stage_index DESC, er.completed_at DESC LIMIT 1
      `)
      .get(videoId)
    sources.push({ id: 'rough_cut_output', label: 'Rough Cut Output', available: Boolean(roughCut) })

    res.json(sources)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

export default router
