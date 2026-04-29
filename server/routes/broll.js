import { Router } from 'express'
import multer from 'multer'
import { dirname, join, extname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'
import { requireAuth, isAdmin } from '../auth.js'
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
  executeKeywordsBatch,
  getBRollEditorData,
  buildManifestFromPlacements,
  searchSinglePlacement,
  searchUserPlacement,
  executePlanPrep,
  executeCreateStrategy,
  executeCreatePlan,
  executeCreateCombinedStrategy,
  executeSearchBatch,
  loadExampleVideos,
  previewBrollReset,
  resetBrollSearches,
  loadBrollEditorState,
  saveBrollEditorState,
} from '../services/broll.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = join(__dirname, '..', '..', 'uploads', 'temp')
mkdirSync(TEMP_DIR, { recursive: true })

// Map a video_groups.path_id to the pipeline stop flags it implies.
//   hands-off     → full auto, no mid-run checkpoints, auto-select variants
//   strategy-only → pause after strategy (analysis) phase
//   guided        → pause after strategy AND after plan phases
// null / unknown  → default to strategy-only (safer than hands-off)
export function pathToFlags(pathId) {
  switch (pathId) {
    case 'hands-off':
      return { stopAfterStrategy: false, stopAfterPlan: false, autoSelectVariants: true }
    case 'strategy-only':
      return { stopAfterStrategy: true,  stopAfterPlan: false, autoSelectVariants: false }
    case 'guided':
      return { stopAfterStrategy: true,  stopAfterPlan: true,  autoSelectVariants: false }
    default:
      // legacy / unset: behave as strategy-only for safety
      return { stopAfterStrategy: true, stopAfterPlan: false, autoSelectVariants: false }
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_DIR,
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E6) + extname(file.originalname)),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
})

const router = Router()

// Standalone router so server/index.js can mount the manifest endpoint
// at /api/broll-searches/:pipelineId/manifest (matches WebApp.1 spec)
// without inheriting the /api/broll prefix.
export const brollSearchesRouter = Router()

// ─── Export manifest endpoint (WebApp.1 Phase A) ─────────────────
// Returns the per-item manifest the Chrome extension downloads for
// a given plan_pipeline_id. Reads broll_searches.results_json and
// reshapes per-result entries into the spec's manifest entry format
// (see docs/specs/2026-04-23-envato-export-design.md § "Manifest
// shape (unified)").
//
// Auth: requireAuth (Supabase JWT) only for Phase A. Per-pipeline
// ownership enforcement is TODO project-wide — none of the other
// /broll routes check it today; tightening here in isolation would
// be inconsistent. Revisit when adding admin/observability routes.
//
// Query: ?variant=<label>  optional; filter to a single variant_label
//                          when provided. Omitting returns all picked
//                          items across every variant.
brollSearchesRouter.get('/:pipelineId/manifest', requireAuth, async (req, res) => {
  try {
    const pipelineId = String(req.params.pipelineId || '')
    if (!pipelineId) return res.status(400).json({ error: 'pipelineId required' })
    const variant = req.query.variant ? String(req.query.variant) : null

    // Use the same data path as the b-roll editor — 3-tier fallback
    // (broll_searches → broll_runs → broll_search_logs) plus user
    // edits from broll_editor_state. Without this, projects whose
    // searches landed in legacy storage show 0 items in the export
    // pre-flight even though the editor displays them correctly.
    const editorData = await getBRollEditorData(pipelineId)
    const placements = Array.isArray(editorData?.placements) ? editorData.placements : []

    // Refine each placement's start/end to the same transcript-snapped
    // times the b-roll editor displays. The plan generator emits whole-
    // second timecodes (e.g. "[00:01:13]"); the editor calls
    // matchPlacementsToTranscript to find the actual transcript word
    // matching the placement's audio_anchor (~73.64s instead of 73s).
    // Without this step the export's start times disagree with the
    // editor's display by up to ~1 second per clip.
    try {
      const planMatchForVideo = pipelineId.match(/^plan-(\d+)-/)
      if (planMatchForVideo) {
        const videoId = parseInt(planMatchForVideo[1], 10)
        const vRow = await db.prepare('SELECT group_id FROM videos WHERE id = ?').get(videoId)
        const groupId = vRow?.group_id || null
        if (groupId) {
          const { getTimelineWordTimestamps } = await import('../services/annotation-mapper.js')
          const { matchPlacementsToTranscript } = await import('../services/placement-match.js')
          const words = (await getTimelineWordTimestamps(groupId)) || []
          const refined = matchPlacementsToTranscript(placements, words)
          // matchPlacementsToTranscript returns NEW objects keyed by
          // (chapterIndex, placementIndex) for plan placements, or by
          // userPlacementId for manual ones. Push the refined timing
          // back onto the original `placements` array (in place) so
          // buildManifestFromPlacements sees it via p.start/p.end as
          // numeric seconds. coerceTimingToSeconds passes numbers
          // through unchanged.
          const byKey = new Map()
          for (const r of refined) {
            const key = r.isUserPlacement
              ? `user:${r.userPlacementId}`
              : `${r.chapterIndex}:${r.placementIndex}`
            byKey.set(key, r)
          }
          for (const p of placements) {
            const key = p.isUserPlacement
              ? `user:${p.userPlacementId}`
              : `${p.chapterIndex}:${p.placementIndex}`
            const r = byKey.get(key)
            if (r && typeof r.timelineStart === 'number' && typeof r.timelineEnd === 'number') {
              p.start = r.timelineStart
              p.end = r.timelineEnd
            }
          }
        }
      }
    } catch (e) {
      console.warn('[broll-export-manifest] transcript-match refinement failed; falling back to plan timecodes:', e.message)
    }

    // Pure transform: pick → filter → manifest item shape. We pin
    // allowedSources to ['pexels'] for now — envato + freepik download
    // paths are still being shaken out, and silently mixing sources
    // confuses users when the editor displays one source as "selected"
    // but the export pipeline picks a different one via fall-through.
    // To re-enable additional sources, expand the allowlist (or remove
    // it entirely to restore "any non-storyblocks" behavior).
    const ALLOWED_SOURCES = ['pexels']
    const { items, totals } = buildManifestFromPlacements(placements, { variant, allowedSources: ALLOWED_SOURCES })

    // A-roll injection: parse pipelineId for the videoId (pattern is
    // 'plan-<videoId>-<timestamp>'); look up the user's source video;
    // if it has a downloadable file_path, prepend an A-roll item with
    // a pre-populated signed_url so the extension queue downloads it
    // alongside the b-rolls without going through a mint API call.
    // The A-roll downloaded copy lets the XMEML generator emit a V1
    // track that Premiere can resolve locally instead of leaving the
    // user to re-link the main video by hand.
    let aroll = null
    const planMatch = pipelineId.match(/^plan-(\d+)-/)
    if (planMatch) {
      const videoId = parseInt(planMatch[1], 10)
      try {
        const vRow = await db.prepare(
          'SELECT id, title, file_path, duration_seconds, media_info_json FROM videos WHERE id = ?'
        ).get(videoId)
        if (vRow && vRow.file_path && /^https?:\/\//.test(vRow.file_path)) {
          // Parse media_info_json for resolution / framerate hints if present.
          let mediaInfo = {}
          try { mediaInfo = JSON.parse(vRow.media_info_json || '{}') } catch {}
          aroll = {
            video_id: vRow.id,
            title: vRow.title || `aroll_${videoId}.mp4`,
            target_filename: `aroll_${videoId}.mp4`,
            signed_url: vRow.file_path,
            duration_seconds: vRow.duration_seconds || null,
            width: mediaInfo.width || null,
            height: mediaInfo.height || null,
            frame_rate: mediaInfo.frame_rate || null,
          }
          // Prepend an item entry the extension queue understands. seq
          // is 0 to mark it as the A-roll; b-rolls remain seq 1..N.
          items.unshift({
            seq: 0,
            timeline_start_s: 0,
            timeline_duration_s: aroll.duration_seconds,
            source: 'aroll',
            source_item_id: String(videoId),
            envato_item_url: null,
            target_filename: aroll.target_filename,
            resolution: { width: aroll.width || 1920, height: aroll.height || 1080 },
            frame_rate: aroll.frame_rate || 30,
            // For A-roll the source duration IS the timeline duration —
            // we play the whole thing. Forwarded to xmeml-generator so
            // the <file><duration> reflects reality (Premiere validates).
            duration_seconds: aroll.duration_seconds || null,
            est_size_bytes: null,
            variant_label: null,
            signed_url: aroll.signed_url,  // pre-populated → extension skips the mint phase
          })
          totals.count = items.length
          totals.by_source = { ...totals.by_source, aroll: 1 }
        }
      } catch (e) {
        console.warn('[broll-export-manifest] aroll lookup failed:', e.message)
      }
    }

    res.json({ pipeline_id: pipelineId, variant, items, totals, aroll })
  } catch (err) {
    console.error('[broll-export-manifest] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

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

  // Collect active pipelines from in-memory progress (exclude GPU search entries)
  const activePipelines = []
  for (const [pipelineId, prog] of brollPipelineProgress.entries()) {
    if (pipelineId.startsWith('search-single-') || pipelineId.startsWith('search-batch-')) continue
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
  const videoRuns = await db.prepare(`
    SELECT r.*, v.title AS video_title, v.group_id, s.name AS strategy_name, s.strategy_kind
    FROM broll_runs r
    LEFT JOIN videos v ON v.id = r.video_id
    LEFT JOIN broll_strategies s ON s.id = r.strategy_id
    WHERE r.video_id = ?
    ORDER BY r.created_at DESC
  `).all(parseInt(req.params.videoId))

  // Also check for active pipelines
  const active = []
  for (const [pipelineId, prog] of brollPipelineProgress.entries()) {
    if (prog.status === 'running' && prog.videoId === parseInt(req.params.videoId)) {
      active.push({ pipelineId, ...prog })
    }
  }

  res.json({ runs: videoRuns, activePipelines: active })
})

router.get('/runs/:id/detail', requireAuth, async (req, res) => {
  try {
    const db = (await import('../db.js')).default
    const run = await db.prepare('SELECT output_text, prompt_used, system_instruction_used, input_text, params_json FROM broll_runs WHERE id = ?').get(req.params.id)
    if (!run) return res.status(404).json({ error: 'Run not found' })
    res.json(run)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/runs/:id', requireAuth, async (req, res) => {
  await deleteRun(req.params.id)
  res.json({ success: true })
})

// Update a run's output_text (for manual strategy edits)
router.put('/runs/:id/output', requireAuth, async (req, res) => {
  try {
    const { output_text } = req.body || {}
    if (output_text == null) return res.status(400).json({ error: 'output_text required' })
    const db = (await import('../db.js')).default
    await db.prepare('UPDATE broll_runs SET output_text = ? WHERE id = ?').run(output_text, req.params.id)

    // Sync sub-run edit to parent run (so enriched/parent stays in sync)
    try {
      const run = await db.prepare('SELECT metadata_json FROM broll_runs WHERE id = ?').get(req.params.id)
      const meta = JSON.parse(run?.metadata_json || '{}')
      if (meta.isSubRun && meta.pipelineId != null && meta.subIndex != null) {
        // Find the parent run for the same pipeline + stage
        const parent = await db.prepare(
          `SELECT id, output_text FROM broll_runs WHERE metadata_json LIKE ? AND metadata_json NOT LIKE '%"isSubRun":true%' AND status = 'complete' LIMIT 1`
        ).get(`%"pipelineId":"${meta.pipelineId}"%"stageIndex":${meta.stageIndex}%`)
        if (parent?.output_text) {
          let parentData = JSON.parse(parent.output_text)
          if (Array.isArray(parentData) && meta.subIndex < parentData.length) {
            // Parse the new sub-run output to get the clean JSON
            let parsed = null
            const jsonMatch = output_text.match(/```json\s*([\s\S]*?)```/)
            if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[1]) } catch {} }
            if (!parsed) { try { parsed = JSON.parse(output_text) } catch {} }
            parentData[meta.subIndex] = parsed ? JSON.stringify(parsed, null, 2) : output_text
            await db.prepare('UPDATE broll_runs SET output_text = ? WHERE id = ?').run(JSON.stringify(parentData), parent.id)
            console.log(`[broll-edit] Synced sub-run ${req.params.id} edit to parent run ${parent.id} (index ${meta.subIndex})`)
          }
        }
      }
    } catch (syncErr) {
      console.error(`[broll-edit] Failed to sync to parent:`, syncErr.message)
    }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Pure transform: rows from broll_runs (with metadata_json + status +
// created_at) → ordered list of {plan_pipeline_id, label} for plans
// whose every run is complete. Exported for unit testing without a DB.
//
// Labels MUST match BRollPanel.strategyVariants so "Variant B" in the
// editor and the export page point at the same plan. The editor sorts
// strategies lexically by pipeline id (combined-strategies always
// last, identified by the `cstrat-` prefix) and inherits each
// strategy's letter onto its plan via metadata.strategyPipelineId.
// We mirror that here. Plans whose runs don't carry a
// strategyPipelineId fall back to firstSeen order after the labelled
// ones — defensive only; well-formed plans always have it.
export function buildExportPlansList(rows) {
  const byPipeline = new Map()
  for (const r of rows || []) {
    let meta = {}
    try { meta = JSON.parse(r.metadata_json || '{}') } catch { continue }
    const pid = meta.pipelineId
    if (!pid || !pid.startsWith('plan-')) continue
    let entry = byPipeline.get(pid)
    if (!entry) {
      entry = {
        plan_pipeline_id: pid,
        status: 'complete',
        firstSeen: r.created_at,
        strategyPipelineId: null,
      }
      byPipeline.set(pid, entry)
    }
    if (r.status === 'failed') entry.status = 'failed'
    if (!entry.strategyPipelineId && typeof meta.strategyPipelineId === 'string' && meta.strategyPipelineId) {
      entry.strategyPipelineId = meta.strategyPipelineId
    }
  }
  return [...byPipeline.values()]
    .filter(p => p.status === 'complete')
    .sort((a, b) => {
      const aCombined = (a.strategyPipelineId || '').startsWith('cstrat-')
      const bCombined = (b.strategyPipelineId || '').startsWith('cstrat-')
      if (aCombined !== bCombined) return aCombined ? 1 : -1
      if (a.strategyPipelineId && b.strategyPipelineId) {
        return a.strategyPipelineId.localeCompare(b.strategyPipelineId)
      }
      if (a.strategyPipelineId) return -1
      if (b.strategyPipelineId) return 1
      return new Date(a.firstSeen) - new Date(b.firstSeen)
    })
    .map((p, i) => ({
      plan_pipeline_id: p.plan_pipeline_id,
      label: `Variant ${String.fromCharCode(65 + i)}`,
    }))
}

// Lists complete b-roll plan pipelines for a video group, A/B/C-labelled in
// generation order. Drives the export page's variant chooser + the
// multi-variant export checkbox; consumers expect plan_pipeline_id values
// they can pass straight to /broll-searches/:pipelineId/manifest.
router.get('/groups/:groupId/export-plans', requireAuth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10)
    if (!Number.isFinite(groupId)) return res.status(400).json({ error: 'invalid groupId' })

    const videos = await db.prepare(`SELECT id FROM videos WHERE group_id = ?`).all(groupId)
    if (!videos.length) return res.json({ plans: [] })

    const videoIds = videos.map(v => v.id)
    const placeholders = videoIds.map(() => '?').join(',')
    const rows = await db.prepare(
      `SELECT metadata_json, status, created_at FROM broll_runs WHERE video_id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...videoIds)

    res.json({ plans: buildExportPlansList(rows) })
  } catch (err) {
    console.error('[broll-export-plans] error:', err.message)
    res.status(500).json({ error: err.message })
  }
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
    // NOTE: `stop_after_plan` is intentionally no longer honored here — the
    // authoritative source of checkpoint behavior is the group's stored
    // `path_id` (A/B/C automation paths, wave-1 schema). Clients still in
    // flight that pass `stop_after_plan` are ignored without error; the
    // path_id lookup below fully supersedes it.
    const { video_id, group_id, transcript_source, reference_run_id, example_video_id } = req.body || {}
    if (!video_id) return res.status(400).json({ error: 'video_id required' })

    const dbMod = (await import('../db.js')).default

    // Load editor cuts + path_id from group in one lookup
    let editorCuts = null
    let pathId = null
    if (group_id) {
      const group = await dbMod
        .prepare('SELECT editor_state_json, path_id FROM video_groups WHERE id = ?')
        .get(group_id)
      if (group?.editor_state_json) {
        try {
          const state = JSON.parse(group.editor_state_json)
          if (state.cuts?.length) {
            editorCuts = { cuts: state.cuts, cutExclusions: state.cutExclusions || [] }
          }
        } catch {}
      }
      pathId = group?.path_id || null
    }
    const { stopAfterStrategy, stopAfterPlan } = pathToFlags(pathId)

    const result = await executePipeline(
      req.params.id,
      req.params.versionId,
      video_id,
      group_id || null,
      transcript_source || 'raw',
      editorCuts,
      reference_run_id || null,
      null,
      { stopAfterPlan, stopAfterStrategy, exampleVideoId: example_video_id || null },
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
    // Immediately mark progress as failed so UI updates
    const prog = brollPipelineProgress.get(pipelineId)
    if (prog) brollPipelineProgress.set(pipelineId, { ...prog, status: 'failed', error: 'Stopped by user' })
    // Mark queue entries as stopped (distinct from real failures)
    if (pipelineId.startsWith('search-batch-')) {
      db.prepare(
        `UPDATE broll_searches SET status = 'stopped', error = 'Stopped by user', completed_at = NOW() WHERE batch_id = ? AND status IN ('waiting', 'running')`
      ).run(pipelineId).catch(err => console.warn('[stop-all] queue update failed:', err.message))
    }
    stopped++
  }
  console.log(`[broll-pipeline] stop-all: ${stopped} pipelines aborted`)
  res.json({ success: true, stopped })
})

// Admin-only: preview what Reset B-Roll Searches would delete for a group
router.get('/groups/:groupId/reset-searches/preview', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' })
  try {
    const groupId = Number(req.params.groupId)
    if (!Number.isFinite(groupId)) return res.status(400).json({ error: 'Invalid groupId' })
    const preview = await previewBrollReset(groupId)
    res.json(preview)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Admin-only: execute Reset B-Roll Searches for a group
router.post('/groups/:groupId/reset-searches', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' })
  try {
    const groupId = Number(req.params.groupId)
    if (!Number.isFinite(groupId)) return res.status(400).json({ error: 'Invalid groupId' })
    const result = await resetBrollSearches(groupId)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Generate keywords for plan placements (LLM only, no GPU)
// Must be BEFORE /pipeline/:pipelineId/* routes to avoid param capture
router.post('/pipeline/run-keywords', requireAuth, async (req, res) => {
  try {
    const { plan_pipeline_ids, batch_size } = req.body || {}
    if (!plan_pipeline_ids?.length) return res.status(400).json({ error: 'plan_pipeline_ids required' })

    // Generate pipeline IDs upfront so we can return them immediately
    const kwPipelineIds = []
    for (const pid of plan_pipeline_ids) {
      const kwPid = `kw-${pid}-${Date.now()}`
      kwPipelineIds.push(kwPid)
      // Set initial progress so frontend can poll immediately
      brollPipelineProgress.set(kwPid, {
        strategyName: 'Generate Keywords', status: 'running',
        stageName: 'Loading plan data...', phase: 'keywords',
        stageIndex: 0, totalStages: 1, subDone: 0, subTotal: 0,
        planPipelineId: pid,
      })
    }

    // Return IDs immediately, then fire LLM calls in background
    res.json({ kwPipelineIds })

    // Fire keyword generation for each plan variant (in parallel), passing the pre-generated ID
    for (let i = 0; i < plan_pipeline_ids.length; i++) {
      executeKeywordsBatch(plan_pipeline_ids[i], batch_size || 10, kwPipelineIds[i])
        .catch(err => console.error(`[broll-keywords] Failed for ${plan_pipeline_ids[i]}:`, err.message))
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Unified search: keywords + GPU search, interleaved across variants
router.post('/pipeline/search-next-batch', requireAuth, async (req, res) => {
  try {
    const { plan_pipeline_ids, batch_size } = req.body || {}
    if (!plan_pipeline_ids?.length) return res.status(400).json({ error: 'plan_pipeline_ids required' })

    const pipelineId = `search-batch-${Date.now()}`
    res.json({ pipelineId })

    executeSearchBatch(plan_pipeline_ids, batch_size || 10, pipelineId)
      .catch(err => console.error(`[search-batch] Failed: ${err.message}`))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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

router.get('/pipeline/:pipelineId/editor-state', requireAuth, async (req, res) => {
  try {
    const data = await loadBrollEditorState(req.params.pipelineId)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/pipeline/:pipelineId/editor-state', requireAuth, async (req, res) => {
  try {
    let body = req.body || {}
    // sendBeacon may deliver as text/plain; fall back to JSON-parse if we got a string
    if (req.query.beacon && typeof body === 'string') {
      try { body = JSON.parse(body) } catch {}
    }
    const { state, version } = body
    if (state == null || typeof version !== 'number') {
      return res.status(400).json({ error: 'state and numeric version required' })
    }
    const result = await saveBrollEditorState(req.params.pipelineId, state, version)
    if (result.status === 'conflict') {
      return res.status(409).json({ state: result.state, version: result.version })
    }
    res.json({ version: result.version })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/pipeline/:pipelineId/search-placement', requireAuth, async (req, res) => {
  try {
    const { pipelineId } = req.params
    const { placementUuid, chapterIndex, placementIndex, description, style, sources } = req.body
    if (!placementUuid && (chapterIndex == null || placementIndex == null)) {
      return res.status(400).json({ error: 'placementUuid OR (chapterIndex, placementIndex) required' })
    }
    const overrides = {}
    if (description) overrides.description = description
    if (style) overrides.style = style
    if (sources) overrides.sources = sources
    const result = await searchSinglePlacement(pipelineId, { placementUuid, chapterIndex, placementIndex }, overrides)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/pipeline/:pipelineId/search-user-placement', requireAuth, async (req, res) => {
  try {
    const { userPlacementId, description, style, sources } = req.body || {}
    if (!userPlacementId) return res.status(400).json({ error: 'userPlacementId required' })
    const overrides = {}
    if (description) overrides.description = description
    if (style) overrides.style = style
    if (sources) overrides.sources = sources
    const result = await searchUserPlacement(req.params.pipelineId, userPlacementId, overrides)
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

// Generate keywords for plan placements (LLM only, no GPU search)
// ── Split Pipeline Routes ──

// One-button: start prep + analysis runs in parallel
router.post('/pipeline/run-all', requireAuth, async (req, res) => {
  try {
    const { video_id, group_id } = req.body || {}
    if (!video_id || !group_id) return res.status(400).json({ error: 'video_id and group_id required' })
    const { runAllReferences } = await import('../services/broll-runner.js')
    const r = await runAllReferences({ subGroupId: group_id, mainVideoId: video_id })
    res.json(r)
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
    const { runStrategies } = await import('../services/broll-runner.js')
    const r = await runStrategies({
      subGroupId: group_id, mainVideoId: video_id,
      prepPipelineId: prep_pipeline_id, analysisPipelineIds: analysis_pipeline_ids,
    })
    res.json(r)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Clean strategy sub-run outputs for plan generation (strip reference-only fields)
router.post('/pipeline/clean-strategy', requireAuth, async (req, res) => {
  try {
    const { strategy_pipeline_id } = req.body || {}
    if (!strategy_pipeline_id) return res.status(400).json({ error: 'strategy_pipeline_id required' })
    const db = (await import('../db.js')).default

    const runs = await db.prepare(
      `SELECT id, output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
    ).all(`%"pipelineId":"${strategy_pipeline_id}"%`)

    const subRuns = runs.filter(r => { try { return JSON.parse(r.metadata_json || '{}').isSubRun } catch { return false } })
    const maxStage = subRuns.reduce((max, r) => { try { return Math.max(max, JSON.parse(r.metadata_json || '{}').stageIndex ?? 0) } catch { return max } }, -1)
    const lastStageRuns = subRuns.filter(r => { try { return (JSON.parse(r.metadata_json || '{}').stageIndex ?? 0) === maxStage } catch { return false } })

    // Parse/prep each row before acquiring a pool client so the slot
    // isn't held during JSON work.
    const updates = []
    for (const run of lastStageRuns) {
      try {
        const jsonMatch = run.output_text?.match(/```json\s*([\s\S]*?)```/)
        const parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(run.output_text || '{}')
        delete parsed.matched_reference_chapter
        delete parsed.commonalities
        if (parsed.strategy) delete parsed.strategy.commonalities
        const bs = parsed.beat_strategies || parsed.beatStrategies || []
        for (const b of bs) {
          delete b.matched_reference_beat
          delete b.match_reason
        }
        updates.push({ id: run.id, newOutput: '```json\n' + JSON.stringify(parsed, null, 2) + '\n```' })
      } catch (err) {
        console.error(`[clean-strategy] Failed to parse run ${run.id}:`, err.message)
      }
    }

    // One transaction holds a single pool slot for the whole batch
    let cleaned = 0
    if (updates.length) {
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        for (const u of updates) {
          await client.query('UPDATE broll_runs SET output_text = $1 WHERE id = $2', [u.newOutput, u.id])
          cleaned++
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    }

    res.json({ success: true, cleaned })
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
    const { runPlanForEachVariant } = await import('../services/broll-runner.js')
    const r = await runPlanForEachVariant({
      subGroupId: group_id, mainVideoId: video_id,
      prepPipelineId: prep_pipeline_id, strategyPipelineIds: [strategy_pipeline_id],
    })
    res.json({ planPipelineId: r.planPipelineIds[0] || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/groups/:subId/resume-chain', requireAuth, async (req, res) => {
  const subId = parseInt(req.params.subId)
  const fromStage = String(req.query.from || '')
  if (!['plan', 'search'].includes(fromStage)) {
    return res.status(400).json({ error: 'from must be "plan" or "search"' })
  }
  const sg = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`)
    .get(subId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!sg) return res.status(404).json({ error: 'Sub-group not found' })

  const { resumeChain } = await import('../services/auto-orchestrator.js')
  resumeChain(subId, fromStage, req.body || {}).catch(err =>
    console.error(`[resume-chain] ${err.message}`)
  )
  res.json({ ok: true })
})

router.post('/groups/:subId/retry-chain', requireAuth, async (req, res) => {
  const subId = parseInt(req.params.subId)
  const sg = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`)
    .get(subId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!sg) return res.status(404).json({ error: 'Sub-group not found' })

  await db.prepare("UPDATE video_groups SET broll_chain_status = NULL, broll_chain_error = NULL WHERE id = ?").run(subId)
  const { runFullAutoBrollChain } = await import('../services/auto-orchestrator.js')
  runFullAutoBrollChain(subId).catch(err => console.error(`[retry] ${err.message}`))
  res.json({ ok: true })
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
