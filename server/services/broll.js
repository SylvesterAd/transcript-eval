import db from '../db.js'
import { loggedFetch, streamingFetch } from './api-logger.js'
import { notify } from './slack-notifier.js'
import { callLLM } from './llm-runner.js'
import { downloadToTemp, uploadFile, deleteFile, getPublicUrl } from './storage.js'
import { extractVideoSegment } from './video-processor.js'
import { mp4Url } from './cloudflare-stream.js'
import { segmentTranscript, segmentByChapters, reassembleSegments } from './segmenter.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = join(__dirname, '..', '..', 'uploads', 'temp')
mkdirSync(TEMP_DIR, { recursive: true })
const execFileAsync = promisify(execFile)

function cleanupTempFiles(files) {
  if (!files?.length) return
  // Fire-and-forget cleanup of temp storage files
  setTimeout(async () => {
    for (const f of files) {
      try {
        await deleteFile(f.bucket, f.path)
        console.log(`[broll-pipeline] Cleaned up temp file: ${f.bucket}/${f.path}`)
      } catch (e) {
        console.warn(`[broll-pipeline] Failed to clean temp file ${f.bucket}/${f.path}:`, e.message)
      }
    }
  }, 5000) // small delay so any in-flight reads finish
}

/**
 * Retry a stage function with escalating delays: 5s, then 20s, then give up.
 * Designed for Gemini API rate limit / connection errors during parallel analysis.
 */
async function withStageRetry(fn, { label, abortSignal } = {}) {
  const delays = [5000, 20000]
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (abortSignal?.aborted || err.name === 'AbortError') throw err
      if (attempt === delays.length) throw err
      console.log(`[broll-pipeline] ${label || 'Stage'} failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt] / 1000}s: ${err.message}`)
      await new Promise(r => setTimeout(r, delays[attempt]))
    }
  }
}

// ── Robust JSON extraction from LLM output ──
function extractJSON(text) {
  if (!text) return null
  // Try ```json ... ``` or ``` ... ``` fence
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return JSON.parse(fence[1].trim())
  // Strip LLM / aggregation prefixes: "json\n" header, "=== Example: ... ===" wrapper
  let cleaned = text
    .replace(/^json\s*\n/, '')
    .replace(/```\s*$/, '')
    .replace(/^(={2,}[^\n]+={2,}\s*\n)+/, '')
    .trim()
  try { return JSON.parse(cleaned) } catch {}
  // Last resort: slice from first { or [ to last } or ]
  const start = cleaned.search(/[{\[]/)
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
  throw new Error('No JSON found in text')
}

// ── Pipeline snapshots for diagnostics ──
const SNAPSHOT_DIR = join(TEMP_DIR, 'pipeline-snapshots')
mkdirSync(SNAPSHOT_DIR, { recursive: true })

function writePipelineSnapshot(pipelineId, data) {
  try {
    writeFileSync(join(SNAPSHOT_DIR, `${slugify(pipelineId)}.json`), JSON.stringify(data, null, 2))
  } catch (e) {
    console.warn(`[broll-snapshot] Write failed: ${e.message}`)
  }
}

export function getPipelineSnapshot(pipelineId) {
  const fp = join(SNAPSHOT_DIR, `${slugify(pipelineId)}.json`)
  try {
    if (!existsSync(fp)) return null
    return JSON.parse(readFileSync(fp, 'utf-8'))
  } catch { return null }
}

export const BROLL_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gpt-5.4',
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
]

export const BROLL_STRATEGY_KINDS = ['hook_analysis', 'main_analysis', 'plan', 'alt_plan', 'keywords', 'keywords_batch', 'broll_search', 'plan_prep', 'create_strategy', 'create_plan', 'create_combined_strategy']

/**
 * Upgrade a stock footage preview URL to HD quality.
 * Storyblocks: __P180.mp4 → __P1080.mp4, resolution=180p → resolution=1080p
 * Pexels: -sd_426_240_Xfps.mp4 → -hd_1920_1080_Xfps.mp4
 */
function upgradePreviewUrl(url) {
  if (!url) return null
  if (url.includes('storyblocks') || url.includes('dm0qx8t0i9gc9.cloudfront.net')) {
    return url.replace(/__P\d+\.mp4/, '__P1080.mp4').replace(/resolution=\d+p/, 'resolution=1080p')
  }
  if (url.includes('pexels.com')) {
    return url.replace(/-sd_\d+_\d+_(\d+fps)/, '-hd_1920_1080_$1')
  }
  return null // no upgrade available
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'broll'
}

function strategyLabelForKind(kind) {
  if (kind === 'hook_analysis') return 'Hook Analysis'
  if (kind === 'main_analysis') return 'Main Analysis'
  if (kind === 'keywords') return 'Keywords'
  if (kind === 'broll_search') return 'B-Roll Search'
  return 'Plan'
}

function decorateStrategy(strategy) {
  if (!strategy) return strategy
  const kind = strategy.strategy_kind || 'hook_analysis'
  const isPlan = kind === 'plan'
  return {
    ...strategy,
    strategy_kind: kind,
    hook_strategy_id: strategy.hook_strategy_id || null,
    main_strategy_id: strategy.main_strategy_id || null,
    model: isPlan ? strategy.plan_model : strategy.analysis_model,
    system_prompt: isPlan ? strategy.plan_system_prompt : strategy.analysis_system_prompt,
  }
}

function decorateVersion(version, kind = 'hook_analysis') {
  if (!version) return version
  const key = kind === 'plan' ? 'plan' : kind === 'main_analysis' ? 'main' : 'hook'
  return {
    ...version,
    prompt: version[`${key}_prompt`] || '',
    params_json: version[`${key}_params_json`] || '{}',
    stages_json: version.stages_json || '[]',
  }
}

function buildVersionPayloadForKind(kind, payload = {}) {
  const prompt = payload.prompt ?? ''
  const params = payload.params_json ?? '{}'
  return {
    hook_prompt: kind === 'hook_analysis' ? prompt : (payload.hook_prompt ?? ''),
    main_prompt: kind === 'main_analysis' ? prompt : (payload.main_prompt ?? ''),
    plan_prompt: kind === 'plan' ? prompt : (payload.plan_prompt ?? ''),
    hook_params_json: kind === 'hook_analysis' ? params : (payload.hook_params_json ?? '{}'),
    main_params_json: kind === 'main_analysis' ? params : (payload.main_params_json ?? '{}'),
    plan_params_json: kind === 'plan' ? params : (payload.plan_params_json ?? '{}'),
  }
}

// ── Strategies & Versions ──────────────────────────────────────────────
export async function listStrategies() {
  const rows = await db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM broll_strategy_versions v WHERE v.strategy_id = s.id) AS version_count
    FROM broll_strategies s
    WHERE COALESCE(s.strategy_kind, '') <> 'legacy'
    ORDER BY s.updated_at DESC, s.created_at DESC
  `).all()
  return rows.map(decorateStrategy)
}

export async function createStrategy({ name, description, strategy_kind, bundle_key, bundle_name, model, system_prompt, hook_strategy_id, main_strategy_id }) {
  if (!name) throw new Error('Name is required')
  const kind = BROLL_STRATEGY_KINDS.includes(strategy_kind) ? strategy_kind : 'hook_analysis'
  const isPlan = kind === 'plan'
  const analysisModel = isPlan ? 'gemini-3-flash-preview' : (model || 'gemini-3-flash-preview')
  const planModel = isPlan ? (model || 'gpt-5.4') : 'gpt-5.4'
  const res = await db.prepare(`
    INSERT INTO broll_strategies (
      name, description,
      analysis_model, analysis_system_prompt,
      plan_model, plan_system_prompt,
      strategy_kind, bundle_key, bundle_name,
      hook_strategy_id, main_strategy_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    description || null,
    analysisModel,
    isPlan ? '' : (system_prompt || ''),
    planModel,
    isPlan ? (system_prompt || '') : '',
    kind,
    bundle_key || null,
    bundle_name || null,
    hook_strategy_id || null,
    main_strategy_id || null,
  )
  return getStrategy(res.lastInsertRowid)
}

export async function getStrategy(id) {
  const row = await db.prepare('SELECT * FROM broll_strategies WHERE id = ?').get(id)
  return decorateStrategy(row)
}

export async function updateStrategy(id, payload = {}) {
  const current = await getStrategy(id)
  if (!current) throw new Error('Strategy not found')

  const kind = current.strategy_kind || 'hook_analysis'
  const isPlan = kind === 'plan'
  const next = {
    name: payload.name?.trim() || current.name,
    description: payload.description !== undefined ? (payload.description || null) : current.description,
    analysis_model: isPlan ? current.analysis_model : (payload.model || payload.analysis_model || current.analysis_model),
    analysis_system_prompt: isPlan ? current.analysis_system_prompt : (payload.system_prompt ?? payload.analysis_system_prompt ?? current.analysis_system_prompt),
    analysis_prompt: payload.analysis_prompt ?? current.analysis_prompt,
    analysis_params_json: payload.analysis_params_json ?? current.analysis_params_json,
    plan_model: isPlan ? (payload.model || payload.plan_model || current.plan_model) : (payload.plan_model || current.plan_model),
    plan_system_prompt: isPlan ? (payload.system_prompt ?? payload.plan_system_prompt ?? current.plan_system_prompt) : (payload.plan_system_prompt ?? current.plan_system_prompt),
    plan_prompt: payload.plan_prompt ?? current.plan_prompt,
    plan_params_json: payload.plan_params_json ?? current.plan_params_json,
    bundle_name: payload.bundle_name ?? current.bundle_name,
    hook_strategy_id: payload.hook_strategy_id !== undefined ? (payload.hook_strategy_id || null) : current.hook_strategy_id,
    main_strategy_id: payload.main_strategy_id !== undefined ? (payload.main_strategy_id || null) : current.main_strategy_id,
  }

  await db.prepare(`
    UPDATE broll_strategies
    SET
      name = ?, description = ?,
      analysis_model = ?, analysis_system_prompt = ?,
      analysis_prompt = ?, analysis_params_json = ?,
      plan_model = ?, plan_system_prompt = ?,
      plan_prompt = ?, plan_params_json = ?,
      bundle_name = ?,
      hook_strategy_id = ?, main_strategy_id = ?,
      updated_at = NOW()
    WHERE id = ?
  `).run(
    next.name, next.description,
    next.analysis_model, next.analysis_system_prompt,
    next.analysis_prompt, next.analysis_params_json,
    next.plan_model, next.plan_system_prompt,
    next.plan_prompt, next.plan_params_json,
    next.bundle_name,
    next.hook_strategy_id, next.main_strategy_id,
    id,
  )

  return getStrategy(id)
}

export async function deleteStrategy(id) {
  await db.prepare('DELETE FROM broll_strategy_versions WHERE strategy_id = ?').run(id)
  await db.prepare('DELETE FROM broll_runs WHERE strategy_id = ?').run(id)
  await db.prepare('DELETE FROM broll_strategies WHERE id = ?').run(id)
}

export async function listVersions(strategyId) {
  const strategy = await getStrategy(strategyId)
  if (!strategy) return []
  const rows = await db.prepare(`
    SELECT * FROM broll_strategy_versions
    WHERE strategy_id = ?
    ORDER BY created_at DESC
  `).all(strategyId)
  return rows.map(row => decorateVersion(row, strategy.strategy_kind))
}

export async function createVersion(strategyId, payload) {
  const strategy = await getStrategy(strategyId)
  if (!strategy) throw new Error('Strategy not found')
  const values = buildVersionPayloadForKind(strategy.strategy_kind, payload || {})
  const res = await db.prepare(`
    INSERT INTO broll_strategy_versions (
      strategy_id, name, notes,
      hook_prompt, main_prompt, plan_prompt,
      hook_params_json, main_params_json, plan_params_json,
      stages_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    strategyId,
    payload.name || `v${Date.now()}`,
    payload.notes || null,
    values.hook_prompt,
    values.main_prompt,
    values.plan_prompt,
    values.hook_params_json || '{}',
    values.main_params_json || '{}',
    values.plan_params_json || '{}',
    payload.stages_json || '[]',
  )
  return getVersion(res.lastInsertRowid)
}

export async function getVersion(id) {
  const row = await db.prepare(`
    SELECT v.*, s.strategy_kind
    FROM broll_strategy_versions v
    JOIN broll_strategies s ON s.id = v.strategy_id
    WHERE v.id = ?
  `).get(id)
  if (!row) return row
  const { strategy_kind, ...version } = row
  return decorateVersion(version, strategy_kind)
}

export async function updateVersion(strategyId, versionId, payload = {}) {
  const current = await db.prepare(`
    SELECT v.*, s.strategy_kind
    FROM broll_strategy_versions v
    JOIN broll_strategies s ON s.id = v.strategy_id
    WHERE v.id = ? AND v.strategy_id = ?
  `).get(versionId, strategyId)

  if (!current) throw new Error('Version not found')
  const values = buildVersionPayloadForKind(current.strategy_kind, payload)

  await db.prepare(`
    UPDATE broll_strategy_versions
    SET
      name = ?, notes = ?,
      hook_prompt = ?, main_prompt = ?, plan_prompt = ?,
      hook_params_json = ?, main_params_json = ?, plan_params_json = ?,
      stages_json = ?
    WHERE id = ? AND strategy_id = ?
  `).run(
    payload.name?.trim() || current.name,
    payload.notes !== undefined ? (payload.notes || null) : current.notes,
    payload.hook_prompt ?? values.hook_prompt ?? current.hook_prompt,
    payload.main_prompt ?? values.main_prompt ?? current.main_prompt,
    payload.plan_prompt ?? values.plan_prompt ?? current.plan_prompt,
    payload.hook_params_json ?? values.hook_params_json ?? current.hook_params_json,
    payload.main_params_json ?? values.main_params_json ?? current.main_params_json,
    payload.plan_params_json ?? values.plan_params_json ?? current.plan_params_json,
    payload.stages_json ?? current.stages_json ?? '[]',
    versionId,
    strategyId,
  )

  return getVersion(versionId)
}

export async function listStrategyBundles() {
  const strategies = await listStrategies()
  const bundleMap = new Map()

  for (const strategy of strategies) {
    const key = strategy.bundle_key || `single-${strategy.id}`
    if (!bundleMap.has(key)) {
      bundleMap.set(key, {
        bundle_key: key,
        bundle_name: strategy.bundle_name || strategy.name,
        description: strategy.description || '',
        strategies: [],
      })
    }
    bundleMap.get(key).strategies.push(strategy)
  }

  const kindOrder = { hook_analysis: 0, main_analysis: 1, plan: 2 }
  return [...bundleMap.values()]
    .map(bundle => ({
      ...bundle,
      strategies: bundle.strategies.sort((a, b) => (kindOrder[a.strategy_kind] ?? 99) - (kindOrder[b.strategy_kind] ?? 99)),
    }))
    .sort((a, b) => a.bundle_name.localeCompare(b.bundle_name))
}

export async function createStrategyBundle({ name, description }) {
  if (!name?.trim()) throw new Error('Name is required')

  const baseName = name.trim()
  const bundleKey = `${slugify(baseName)}-${Date.now()}`
  const commonDescription = description?.trim() || null

  const created = []
  for (const kind of BROLL_STRATEGY_KINDS) {
    const strategy = await createStrategy({
      name: `${baseName} · ${strategyLabelForKind(kind)}`,
      description: commonDescription,
      strategy_kind: kind,
      bundle_key: bundleKey,
      bundle_name: baseName,
      model: kind === 'plan' ? 'gpt-5.4' : 'gemini-3-flash-preview',
      system_prompt: '',
    })

    await createVersion(strategy.id, {
      name: 'Version 1',
      notes: `${strategyLabelForKind(kind)} strategy`,
      prompt: '',
      params_json: kind === 'plan'
        ? '{"temperature":0.3,"thinking_level":"LOW"}'
        : '{"temperature":0.2,"thinking_level":"LOW"}',
    })

    created.push(strategy)
  }

  return {
    bundle_key: bundleKey,
    bundle_name: baseName,
    description: commonDescription,
    strategies: created,
  }
}

// ── Runs ──────────────────────────────────────────────────────────────
export async function listRuns(strategyId) {
  return db.prepare(`
    SELECT r.*, v.title AS video_title
    FROM broll_runs r
    LEFT JOIN videos v ON v.id = r.video_id
    WHERE r.strategy_id = ?
    ORDER BY r.created_at DESC
  `).all(strategyId)
}

export async function listAllRuns() {
  return db.prepare(`
    SELECT r.id, r.strategy_id, r.video_id, r.step_name, r.status, r.model,
           r.tokens_in, r.tokens_out, r.cost, r.runtime_ms, r.metadata_json, r.created_at,
           v.title AS video_title, v.group_id, s.name AS strategy_name, s.strategy_kind
    FROM broll_runs r
    LEFT JOIN videos v ON v.id = r.video_id
    LEFT JOIN broll_strategies s ON s.id = r.strategy_id
    ORDER BY r.created_at DESC
    LIMIT 1000
  `).all()
}

export async function deleteRun(id) {
  await db.prepare('DELETE FROM broll_runs WHERE id = ?').run(id)
}

// ── Example Sets ─────────────────────────────────────────────────────
export async function getOrCreateExampleSet(groupId, createdBy) {
  const existing = await db.prepare('SELECT * FROM broll_example_sets WHERE group_id = ? ORDER BY created_at DESC LIMIT 1').get(groupId)
  if (existing) return existing
  const res = await db.prepare('INSERT INTO broll_example_sets (group_id, created_by) VALUES (?, ?)').run(groupId, createdBy || null)
  return db.prepare('SELECT * FROM broll_example_sets WHERE id = ?').get(res.lastInsertRowid)
}

export async function listExampleSources(groupId) {
  // Check this group and its parent (sub-groups inherit parent's references)
  const parent = await db.prepare('SELECT parent_group_id FROM video_groups WHERE id = ?').get(groupId)
  const groupIds = [groupId]
  if (parent?.parent_group_id) groupIds.push(parent.parent_group_id)

  return db.prepare(`
    SELECT es.*, v.duration_seconds, v.title AS video_title FROM broll_example_sources es
    JOIN broll_example_sets eset ON eset.id = es.example_set_id
    LEFT JOIN videos v ON v.id = (es.meta_json::json->>'videoId')::int
    WHERE eset.group_id IN (${groupIds.map(() => '?').join(',')})
    ORDER BY es.created_at DESC
  `).all(...groupIds)
}

export async function addExampleSource(groupId, { kind, source_url, label, createdBy }) {
  if (!['upload', 'yt_video', 'yt_channel'].includes(kind)) throw new Error('Invalid kind')
  const set = await getOrCreateExampleSet(groupId, createdBy)
  const res = await db.prepare(`
    INSERT INTO broll_example_sources (example_set_id, kind, source_url, label, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(set.id, kind, source_url || null, label || null)
  return db.prepare('SELECT * FROM broll_example_sources WHERE id = ?').get(res.lastInsertRowid)
}

export async function updateExampleSourceStatus(id, status, error = null, meta = {}) {
  await db.prepare('UPDATE broll_example_sources SET status = ?, error = ?, meta_json = ? WHERE id = ?')
    .run(status, error, JSON.stringify(meta), id)
}

export async function deleteExampleSource(id) {
  await db.prepare('DELETE FROM broll_example_sources WHERE id = ?').run(id)
}

/**
 * Download a YouTube video at 360p, upload to Supabase, create a videos record,
 * and link it to the example source. Runs in the background after addExampleSource.
 */
export async function downloadYouTubeVideo(exampleSourceId) {
  const source = await db.prepare(`
    SELECT es.*, eset.group_id
    FROM broll_example_sources es
    JOIN broll_example_sets eset ON eset.id = es.example_set_id
    WHERE es.id = ?
  `).get(exampleSourceId)
  if (!source || !source.source_url) throw new Error('Example source not found or missing URL')

  const url = source.source_url
  const groupId = source.group_id
  let mp4Path = null

  try {
    await updateExampleSourceStatus(exampleSourceId, 'processing')

    // Check if a video with this YouTube URL already exists — reuse it
    const existing = await db.prepare(
      'SELECT id FROM videos WHERE youtube_url = ? AND file_path IS NOT NULL LIMIT 1'
    ).get(url)
    if (existing) {
      console.log(`[broll-dl] Reusing existing video ${existing.id} for ${url}`)
      await updateExampleSourceStatus(exampleSourceId, 'ready', null, { videoId: existing.id })
      return
    }

    const fileId = Date.now() + '-' + Math.round(Math.random() * 1E6)
    mp4Path = join(TEMP_DIR, `${fileId}.mp4`)

    // Verify yt-dlp is available
    await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 })

    // Get video info
    console.log(`[broll-dl] Fetching info: ${url}`)
    const { stdout: infoJson } = await execFileAsync('yt-dlp', [
      '--dump-json', '--no-download', url
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
    const info = JSON.parse(infoJson)
    const videoTitle = source.label || info.title || 'YouTube Reference'
    const duration = Math.round(info.duration || 0)
    console.log(`[broll-dl] Title: "${videoTitle}", Duration: ${duration}s`)

    // Download at 360p
    console.log(`[broll-dl] Downloading 360p video...`)
    await execFileAsync('yt-dlp', [
      '-f', 'best[height<=360]',
      '-o', mp4Path,
      '--no-post-overwrites',
      url
    ], { timeout: 600000 })

    if (!existsSync(mp4Path)) {
      throw new Error('Video download completed but file not found')
    }
    console.log(`[broll-dl] Downloaded: ${mp4Path}`)

    // Upload to Supabase storage
    const storageUrl = await uploadFile('videos', `${fileId}.mp4`, mp4Path)
    console.log(`[broll-dl] Uploaded to storage: ${storageUrl}`)

    // Create videos record (not linked to group — linkage is via broll_example_sources)
    const result = await db.prepare(
      'INSERT INTO videos (title, file_path, video_type, duration_seconds, youtube_url) VALUES (?, ?, ?, ?, ?)'
    ).run(videoTitle, storageUrl, 'human_edited', duration, url)
    const videoId = Number(result.lastInsertRowid)
    console.log(`[broll-dl] Video record created: id=${videoId}`)

    // Link to example source
    await updateExampleSourceStatus(exampleSourceId, 'ready', null, { videoId })
    console.log(`[broll-dl] Example source ${exampleSourceId} ready with videoId=${videoId}`)

  } catch (err) {
    console.error(`[broll-dl] Error downloading ${url}:`, err.message)
    await updateExampleSourceStatus(exampleSourceId, 'failed', err.message)
  } finally {
    if (mp4Path) try { unlinkSync(mp4Path) } catch {}
  }
}

export async function setExampleFavorite(id) {
  const source = await db.prepare('SELECT * FROM broll_example_sources WHERE id = ?').get(id)
  if (!source) throw new Error('Example source not found')
  // Toggle: if already favorite, unfavorite; otherwise clear all and set this one
  await db.prepare('UPDATE broll_example_sources SET is_favorite = FALSE WHERE example_set_id = ?').run(source.example_set_id)
  if (!source.is_favorite) {
    await db.prepare('UPDATE broll_example_sources SET is_favorite = TRUE WHERE id = ?').run(id)
  }
  return db.prepare('SELECT * FROM broll_example_sources WHERE id = ?').get(id)
}

/**
 * Get a local video file path for a video. Downloads from CF Stream if needed.
 */
async function getVideoFilePath(videoId) {
  const video = await db.prepare('SELECT file_path, cf_stream_uid FROM videos WHERE id = ?').get(videoId)
  if (!video) throw new Error(`Video ${videoId} not found`)

  // If we have a CF Stream UID, download the MP4
  if (video.cf_stream_uid) {
    const url = mp4Url(video.cf_stream_uid)
    console.log(`[broll] Downloading video ${videoId} from CF Stream for analysis...`)
    return downloadToTemp(url, `broll-analysis-${videoId}.mp4`)
  }

  // Otherwise use local/Supabase file_path
  if (video.file_path) {
    return downloadToTemp(video.file_path, `broll-analysis-${videoId}.mp4`)
  }

  throw new Error(`Video ${videoId} has no file_path or cf_stream_uid`)
}

export async function analyzeVideo(strategyId, videoId, stage = 'main') {
  const strategy = await getStrategy(strategyId)
  if (!strategy) throw new Error('Strategy not found')

  // Get the actual video file
  const videoFilePath = await getVideoFilePath(videoId)

  // Get transcript if available (sent alongside video for context)
  const transcript = await db.prepare('SELECT content FROM transcripts WHERE video_id = ? AND type = ?').get(videoId, 'raw')
  const transcriptSnippet = transcript?.content || '(no transcript available)'

  const modelToUse = strategy.analysis_model || 'gemini-3-flash-preview'

  // Only Gemini supports direct video input
  if (!modelToUse.startsWith('gemini')) {
    throw new Error(`Video analysis requires a Gemini model. "${modelToUse}" does not support video input.`)
  }

  const systemInstruction = `You are an expert video analyst. You watch the actual video and analyze its visual content.
Your task is to identify B-roll opportunities, picture-in-picture moments, and overlay events.
Focus on what you SEE in the video — scene changes, on-screen elements, speaker actions, visual transitions.
Output JSON only.`

  const prompt = `Analyze this video for the "${stage}" section (${stage === 'hook' ? 'first 2 minutes' : 'main content after the hook'}).

Watch the video carefully and identify visual events where B-roll, PIP, or overlays should be inserted.

For each event, describe:
- What is visually happening on screen at that moment
- What type of visual treatment fits (broll = cover A-roll with different footage, pip = picture-in-picture layout, overlay = graphic/image over A-roll)
- Exact timestamps from the video

Return a JSON array (up to 12 items):
[{
  "stage": "${stage}",
  "type": "broll|pip|overlay",
  "start_seconds": 10,
  "end_seconds": 15,
  "visual_description": "what you see on screen",
  "audio_anchor": "what is being said",
  "trigger": "why this moment needs B-roll",
  "function": "e.g. Inform - Illustrate, Engage - Surprise, Clarify - Demonstrate",
  "type_group": "e.g. Screen recording, Stock footage, Diagram, Photo, Talking head close-up",
  "description": "suggested B-roll content"
}]

${transcript?.content ? `\nTranscript for reference:\n${transcriptSnippet}` : ''}`

  const start = Date.now()
  const { text, tokensIn, tokensOut, cost } = await callLLM({
    model: modelToUse,
    systemInstruction,
    prompt,
    params: { temperature: 0.2 },
    experimentId: null,
    videoFile: videoFilePath,
  })

  const runtime = Date.now() - start
  let events = []
  try {
    const parsed = JSON.parse(text)
    events = Array.isArray(parsed) ? parsed : []
  } catch {
    // Try to extract JSON from markdown code blocks
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) try { events = JSON.parse(match[1]) } catch { events = [] }
  }

  const res = await db.prepare(`
    INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    strategyId, videoId, 'analysis', 'complete',
    `[video file uploaded to Gemini]\n\n${transcriptSnippet.slice(0, 500)}...`,
    text, prompt, systemInstruction,
    modelToUse,
    tokensIn || 0, tokensOut || 0, cost || 0, runtime,
  )

  return { runId: res.lastInsertRowid, events, model: modelToUse, runtime, cost }
}

// ── Transcript source resolution ─────────────────────────────────────
async function resolveTranscript(videoId, source = 'raw') {
  if (source === 'rough_cut_output') {
    // Find the latest completed experiment run for this video and get its final output
    const latestRun = await db.prepare(`
      SELECT rso.output_text
      FROM run_stage_outputs rso
      JOIN experiment_runs er ON er.id = rso.experiment_run_id
      WHERE er.video_id = ? AND er.status = 'complete'
      ORDER BY rso.stage_index DESC, er.completed_at DESC
      LIMIT 1
    `).get(videoId)
    if (latestRun?.output_text) return { content: latestRun.output_text, resolved: 'rough_cut_output' }
    // Fall back to human_edited if no rough cut available
    console.warn(`[broll] No rough cut output for video ${videoId}, falling back to human_edited`)
    source = 'human_edited'
  }

  if (source === 'human_edited') {
    const t = await db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'human_edited'").get(videoId)
    if (t?.content) return { content: t.content, resolved: 'human_edited' }
    console.warn(`[broll] No human_edited transcript for video ${videoId}, falling back to raw`)
  }

  const t = await db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'raw'").get(videoId)
  if (!t?.content) throw new Error(`No transcript found for video ${videoId}`)
  return { content: t.content, resolved: 'raw' }
}

// ── Load reference analysis from another strategy's runs ────────────
/**
 * Load the latest completed pipeline output for a strategy.
 * Used by plan strategies to access reference analysis results.
 */
export async function loadLatestStrategyOutput(strategyId) {
  // Get the last stage output from the most recent completed pipeline run
  const row = await db.prepare(`
    SELECT output_text FROM broll_runs
    WHERE strategy_id = ? AND status = 'complete'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(strategyId)
  return row?.output_text || null
}

/**
 * Load output from a specific broll_runs row by ID.
 */
export async function loadRunOutput(runId) {
  const row = await db.prepare('SELECT output_text FROM broll_runs WHERE id = ?').get(runId)
  return row?.output_text || null
}

/**
 * List available reference analysis runs (for UI selection).
 * Returns assembled outputs from completed pipeline runs of analysis strategies.
 */
export async function listReferenceAnalysisRuns(strategyId) {
  const rows = await db.prepare(`
    SELECT r.id, r.video_id, r.created_at, r.metadata_json,
           v.title as video_title
    FROM broll_runs r
    LEFT JOIN videos v ON v.id = r.video_id
    WHERE r.strategy_id = ? AND r.status = 'complete'
    ORDER BY r.created_at DESC
  `).all(strategyId)

  // Group by pipelineId, return only the final stage of each pipeline
  const byPipeline = {}
  for (const row of rows) {
    const meta = JSON.parse(row.metadata_json || '{}')
    const pid = meta.pipelineId || row.id
    if (!byPipeline[pid] || (meta.stageIndex || 0) > (byPipeline[pid].stageIndex || 0)) {
      byPipeline[pid] = { ...row, stageIndex: meta.stageIndex || 0, stageName: meta.stageName || '' }
    }
  }

  return Object.values(byPipeline).map(r => ({
    run_id: r.id,
    video_id: r.video_id,
    video_title: r.video_title || `Video #${r.video_id}`,
    stage_name: r.stageName,
    created_at: r.created_at,
  }))
}

// ── Post-cut transcript generator ───────────────────────────────────
/**
 * Generate a transcript with timecodes adjusted for rough cut removals.
 * Words inside cut regions are removed; remaining words get shifted timecodes.
 */
export async function generatePostCutTranscript(videoId, cuts, cutExclusions = []) {
  const t = await db.prepare("SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'").get(videoId)
  if (!t?.word_timestamps_json) throw new Error(`No word timestamps for video ${videoId}`)
  const words = JSON.parse(t.word_timestamps_json)

  // 1. Compute effective cuts: merge cuts, subtract exclusions
  const effectiveCuts = computeEffectiveCuts(cuts, cutExclusions)

  // 2. Filter out words whose midpoint falls inside any cut
  const keptWords = words.filter(w => {
    const mid = (w.start + w.end) / 2
    return !effectiveCuts.some(c => mid >= c.start && mid < c.end)
  })

  // 3. Pre-compute cumulative cut durations for offset calculation
  const sortedCuts = [...effectiveCuts].sort((a, b) => a.start - b.start)
  const cutEnds = sortedCuts.map(c => c.end)
  const cutDurations = sortedCuts.map(c => c.end - c.start)
  const cumDurations = []
  let cum = 0
  for (const d of cutDurations) { cum += d; cumDurations.push(cum) }

  function getOffset(time) {
    // Binary search: sum of cut durations for all cuts ending before this time
    let lo = 0, hi = cutEnds.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cutEnds[mid] <= time) lo = mid + 1
      else hi = mid
    }
    return lo > 0 ? cumDurations[lo - 1] : 0
  }

  // 4. Adjust timecodes
  const adjusted = keptWords.map(w => ({
    word: w.word,
    start: w.start - getOffset(w.start),
    end: w.end - getOffset(w.end),
  }))

  // 5. Format as [HH:MM:SS] timecoded transcript
  const toTC = (s) => {
    const h = String(Math.floor(s / 3600)).padStart(2, '0')
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
    const sec = String(Math.floor(s % 60)).padStart(2, '0')
    const cs = Math.round((s % 1) * 100)
    const base = `${h}:${m}:${sec}`
    return cs > 0 ? `[${base}.${String(cs).padStart(2, '0')}]` : `[${base}]`
  }

  const lines = []
  let currentLine = []
  let lineStartTime = null
  let prevLineEnd = null

  for (let i = 0; i < adjusted.length; i++) {
    const w = adjusted[i]
    if (lineStartTime === null) lineStartTime = w.start
    currentLine.push(w.word)

    const endsWithPunctuation = /[.!?]$/.test(w.word.trim())
    const isLastWord = i === adjusted.length - 1

    if (endsWithPunctuation || isLastWord) {
      if (prevLineEnd !== null) {
        const gap = Math.round(lineStartTime - prevLineEnd)
        if (gap > 1) lines.push(`[${gap}s]`)
      }
      const tc = toTC(lineStartTime)
      const text = currentLine.join(' ').replace(/\s+([.,!?;:])/g, '$1')
      lines.push(`${tc} ${text.trim()}`)
      prevLineEnd = adjusted[i].end
      currentLine = []
      lineStartTime = null
    }
  }

  return lines.join('\n\n')
}

/**
 * Merge cuts and subtract exclusions to get effective cut regions.
 */
function computeEffectiveCuts(cuts, cutExclusions = []) {
  if (!cuts || !cuts.length) return []

  // Filter real cuts (not zero-width razor markers)
  const real = cuts.filter(c => c.end > c.start + 0.01)
  if (!real.length) return []

  // Sort and merge overlapping cuts
  const sorted = [...real].sort((a, b) => a.start - b.start)
  const merged = [{ start: sorted[0].start, end: sorted[0].end }]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (sorted[i].start <= last.end + 0.05) {
      last.end = Math.max(last.end, sorted[i].end)
    } else {
      merged.push({ start: sorted[i].start, end: sorted[i].end })
    }
  }

  // Subtract exclusions
  if (!cutExclusions || !cutExclusions.length) return merged

  const result = []
  for (const region of merged) {
    let current = { ...region }
    const sortedEx = [...cutExclusions].sort((a, b) => a.start - b.start)
    for (const ex of sortedEx) {
      if (ex.start >= current.end || ex.end <= current.start) continue
      if (current.start < ex.start - 0.01) {
        result.push({ start: current.start, end: ex.start })
      }
      current.start = ex.end
    }
    if (current.start < current.end - 0.01) {
      result.push(current)
    }
  }
  return result.sort((a, b) => a.start - b.start)
}

// ── Pipeline progress & abort tracking ───────────────────────────────
export const brollPipelineProgress = new Map()
export const abortedBrollPipelines = new Set()
export const pipelineAbortControllers = new Map() // pipelineId → AbortController

// ── Sequential pipeline executor ─────────────────────────────────────
/**
 * Load example video IDs for a group from broll_example_sources.
 * Returns array of { videoId, filePath, title } for each ready example.
 */
export async function loadExampleVideos(groupId) {
  // Check this group and its parent (sub-groups inherit parent's references)
  const parent = await db.prepare('SELECT parent_group_id FROM video_groups WHERE id = ?').get(groupId)
  const groupIds = [groupId]
  if (parent?.parent_group_id) groupIds.push(parent.parent_group_id)

  const sources = await db.prepare(`
    SELECT es.id, es.source_url, es.kind, es.meta_json, es.is_favorite
    FROM broll_example_sources es
    JOIN broll_example_sets eset ON eset.id = es.example_set_id
    WHERE eset.group_id IN (${groupIds.map(() => '?').join(',')}) AND es.status = 'ready'
  `).all(...groupIds)

  const videos = []
  for (const src of sources) {
    try {
      const meta = JSON.parse(src.meta_json || '{}')
      if (meta.videoId) {
        const v = await db.prepare('SELECT id, title, file_path, cf_stream_uid FROM videos WHERE id = ?').get(meta.videoId)
        if (v) videos.push({ ...v, isFavorite: !!src.is_favorite })
      }
    } catch {}
  }
  return videos
}

// Run alt plans for non-favorite reference videos using a completed plan pipeline's data
export async function executeAltPlans(planPipelineId) {
  // Load the plan pipeline's completed stages
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)

  if (!planRuns.length) throw new Error('No completed stages found for plan pipeline')

  const firstMeta = JSON.parse(planRuns[0].metadata_json || '{}')
  const strategyId = planRuns[0].strategy_id
  const videoId = planRuns[0].video_id
  const groupId = firstMeta.groupId || null
  if (!strategyId || !videoId) throw new Error('Missing strategy/video info in plan pipeline')

  // Load plan strategy to find linked analysis strategy
  const planStrategy = await getStrategy(strategyId)
  if (!planStrategy?.main_strategy_id) throw new Error('Plan strategy has no linked analysis strategy')

  // Load alt_plan strategy and its latest version
  const altPlanStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'alt_plan' ORDER BY id LIMIT 1").get()
  if (!altPlanStrategy) throw new Error('No alt_plan strategy found')
  const altVersion = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(altPlanStrategy.id)
  if (!altVersion) throw new Error('No alt_plan version found')
  const altStages = JSON.parse(altVersion.stages_json || '[]')
  if (!altStages.length) throw new Error('Alt plan strategy has no stages')

  // Load example videos and determine favorite vs alt
  const exampleVideos = groupId ? await loadExampleVideos(groupId) : []
  if (exampleVideos.length < 2) throw new Error('Need at least 2 reference videos for alternative plans')
  const favoriteVideo = exampleVideos.find(v => v.isFavorite) || exampleVideos[0]
  const altVideos = exampleVideos.filter(v => v !== favoriteVideo)

  // Rebuild plan pipeline state from DB
  const mainStages = planRuns.filter(r => !JSON.parse(r.metadata_json || '{}').isSubRun)
  const stageOutputsByIndex = {}
  for (const r of mainStages) {
    const m = JSON.parse(r.metadata_json || '{}')
    if (m.stageIndex != null) stageOutputsByIndex[m.stageIndex] = r.output_text || ''
  }

  // Load the plan's assembled output (last stage = assemble_broll_plan)
  const planVersion = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategyId)
  const planStagesTemplate = JSON.parse(planVersion?.stages_json || '[]')
  const assembleIdx = planStagesTemplate.length - 1
  const favoriteOutput = stageOutputsByIndex[assembleIdx] || ''
  if (!favoriteOutput) throw new Error('Plan pipeline has no assembled output')

  // Rebuild chapterSplits from split_by_chapter stage
  const splitIdx = planStagesTemplate.findIndex(s => s.action === 'split_by_chapter')
  const chaptersIdx = planStagesTemplate[splitIdx]?.actionParams?.chaptersStageIndex
  const aRollIdx = planStagesTemplate[splitIdx]?.actionParams?.aRollStageIndex
  const chaptersJSON = stageOutputsByIndex[chaptersIdx] || ''
  const aRollJSON = aRollIdx != null ? stageOutputsByIndex[aRollIdx] : ''

  let chaptersData
  try { chaptersData = JSON.parse(chaptersJSON) } catch { chaptersData = extractJSON(chaptersJSON) }
  const chapters = chaptersData?.chapters || []
  let aRolls = chaptersData?.a_roll_appearances || chaptersData?.a_rolls || []
  if (!aRolls.length && aRollJSON) {
    try {
      const aRollParsed = extractJSON(aRollJSON)
      aRolls = aRollParsed?.a_roll_appearances || aRollParsed?.a_rolls || []
    } catch {}
  }

  // Rebuild currentTranscript
  const transcriptIdx = planStagesTemplate.findIndex(s => s.action === 'generate_post_cut_transcript')
  const currentTranscript = transcriptIdx >= 0 ? stageOutputsByIndex[transcriptIdx] || '' : ''

  // Build chapterSplits (simplified version of split_by_chapter logic)
  const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
  function tcToSec(tc) {
    const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/)
    if (!m) return null
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
  }
  // Normalize timestamps
  for (const ch of chapters) {
    if (ch.start && !ch.start_seconds) ch.start_seconds = tcToSec(ch.start) ?? 0
    if (ch.end && !ch.end_seconds) ch.end_seconds = tcToSec(ch.end) ?? 0
    for (const b of (ch.beats || [])) {
      if (b.start && !b.start_seconds) b.start_seconds = tcToSec(b.start) ?? 0
      if (b.end && !b.end_seconds) b.end_seconds = tcToSec(b.end) ?? 0
    }
  }
  for (const a of aRolls) {
    if (a.change_at && !a.change_at_seconds) a.change_at_seconds = tcToSec(a.change_at) ?? 0
  }

  const transcriptLines = currentTranscript.split('\n')
  function parseLineTime(line) {
    const m = line.match(/\[(\d{1,2}):(\d{2}):?(\d{2})?(?:\.\d+)?\]/)
    if (!m) return null
    return (parseInt(m[1]) * 3600) + (parseInt(m[2]) * 60) + (parseInt(m[3] || '0'))
  }

  const chapterSplits = chapters.map((ch, idx) => {
    const chTranscriptLines = transcriptLines.filter(line => {
      const t = parseLineTime(line)
      if (t === null) return false
      return t >= ch.start_seconds && t < ch.end_seconds
    })
    const beats = (ch.beats || []).map(b => `  - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)}): ${b.description || ''}${b.purpose ? ' | Purpose: ' + b.purpose : ''}${b.emotion ? ' | Emotion: ' + b.emotion : ''}`).join('\n')
    return {
      chapter_number: idx + 1,
      chapter_name: ch.name || `Chapter ${idx + 1}`,
      chapter_purpose: ch.purpose || ch.description || '',
      chapter_emotion: ch.emotion || '',
      chapter_start: ch.start_seconds,
      chapter_end: ch.end_seconds,
      chapter_start_tc: toTC(ch.start_seconds),
      chapter_end_tc: toTC(ch.end_seconds),
      chapter_duration_seconds: ch.end_seconds - ch.start_seconds,
      beats_formatted: beats,
      beats_raw: ch.beats || [],
      elements: [],
      transcript: chTranscriptLines.join('\n'),
    }
  })

  // Build _allChaptersContext
  const allChaptersSummary = chapters.map((ch, idx) => {
    const beats = (ch.beats || []).map(b => `    - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)})`).join('\n')
    return `### Chapter ${idx + 1}: ${ch.name} (${toTC(ch.start_seconds)}-${toTC(ch.end_seconds)})\nPurpose: ${ch.purpose || ch.description || ''}${ch.emotion ? '\nEmotion: ' + ch.emotion : ''}\nBeats:\n${beats}`
  }).join('\n\n')
  const aRollSummary = aRolls.map(a => {
    const changeAt = a.change_at_seconds != null ? ` — change at ${toTC(a.change_at_seconds)}` : ''
    const note = a.change_note ? ` (${a.change_note})` : ''
    return `A-Roll #${a.id}: ${a.description}${changeAt}${note}`
  }).join('\n')
  chapterSplits._allChaptersContext = `## A-Rolls:\n${aRollSummary}\n\n## Chapters & Beats:\n${allChaptersSummary}`

  // Load analysis outputs per video
  const analysisStrategy = await getStrategy(planStrategy.main_strategy_id)
  const analysisOutputsByVideo = {}
  if (analysisStrategy) {
    // Find analysis runs for this group's example videos
    for (const vid of exampleVideos) {
      const assembleRuns = await db.prepare(
        `SELECT output_text, metadata_json FROM broll_runs WHERE strategy_id = ? AND video_id = ? AND status = 'complete' AND metadata_json LIKE '%"stageName":"Assemble full analysis"%' ORDER BY id DESC LIMIT 1`
      ).get(analysisStrategy.id, vid.id)
      // Also search by video label in metadata
      if (!assembleRuns) {
        const labelRuns = await db.prepare(
          `SELECT output_text FROM broll_runs WHERE strategy_id = ? AND status = 'complete' AND metadata_json LIKE ? ORDER BY id DESC LIMIT 1`
        ).get(analysisStrategy.id, `%"videoLabel":"${vid.title || ''}"%`)
      }
      if (assembleRuns) analysisOutputsByVideo[vid.id] = assembleRuns.output_text || ''
    }
  }

  // Now run alt plans for each non-favorite video
  const results = []
  for (const altVid of altVideos) {
    const referenceAnalysis = analysisOutputsByVideo[altVid.id] || ''
    const altLabel = altVid.title || `Video #${altVid.id}`
    const altPipelineId = `alt-${planPipelineId}-${altVid.id}-${Date.now()}`

    console.log(`[broll-pipeline] Starting alt plan for "${altLabel}" (${referenceAnalysis.length} chars analysis)`)
    brollPipelineProgress.set(altPipelineId, { strategyId: altPlanStrategy.id, videoId, groupId, strategyName: `Alt: ${altLabel}`, videoTitle: altLabel, startedAt: Date.now(), stageIndex: 0, totalStages: altStages.length, status: 'running', stageName: 'Starting...', phase: 'alt_plan', videoLabel: altLabel })

    const pipelineAbort = new AbortController()
    pipelineAbortControllers.set(altPipelineId, pipelineAbort)
    const pipelineStart = Date.now()
    const stageOutputs = []
    let llmAnswer = '', questionCount = 0
    const llmAnswers = {}

    function replacePlaceholders(text) {
      let result = text
        .replace(/\{\{transcript\}\}/g, currentTranscript)
        .replace(/\{\{llm_answer\}\}/g, llmAnswer)
        .replace(/\{\{reference_analysis\}\}/g, referenceAnalysis)
        .replace(/\{\{favorite_plan\}\}/g, favoriteOutput)
      for (const [num, ans] of Object.entries(llmAnswers)) {
        result = result.replace(new RegExp(`\\{\\{llm_answer_${num}\\}\\}`, 'g'), ans)
      }
      stageOutputs.forEach((out, i) => {
        result = result.replace(new RegExp(`\\{\\{stage_${i + 1}_output\\}\\}`, 'g'), out || '')
      })
      return result
    }

    try {
      for (let i = 0; i < altStages.length; i++) {
        if (abortedBrollPipelines.has(altPipelineId)) break
        const stage = altStages[i]
        const stageName = stage.name || `Stage ${i + 1}`
        brollPipelineProgress.set(altPipelineId, { strategyId: altPlanStrategy.id, videoId, groupId, strategyName: `Alt: ${altLabel}`, videoTitle: altLabel, startedAt: pipelineStart, stageIndex: i, totalStages: altStages.length, status: 'running', stageName, phase: 'alt_plan', videoLabel: altLabel })
        console.log(`[broll-pipeline] ${altPipelineId} Stage ${i + 1}/${altStages.length}: ${stageName}`)

        let output = ''
        let stageTokensIn = 0, stageTokensOut = 0, stageCost = 0
        const stageStart = Date.now()

        if (stage.type === 'transcript_question' && stage.per_chapter) {
          // Per-chapter stage
          const allChaptersCtx = chapterSplits._allChaptersContext || ''
          const CHAPTER_CONCURRENCY = 5
          const chapterResults = new Array(chapterSplits.length).fill(null)
          let completedChapters = 0
          brollPipelineProgress.set(altPipelineId, { ...brollPipelineProgress.get(altPipelineId), subDone: 0, subTotal: chapterSplits.length, subLabel: '' })

          async function processChapter(c) {
            if (abortedBrollPipelines.has(altPipelineId)) return
            const ch = chapterSplits[c]
            let prevChapterOutput = ''
            for (let pi = i - 1; pi >= 0; pi--) {
              const prevStage = altStages[pi]
              const isPrevPerChapter = prevStage.type === 'transcript_question' && prevStage.per_chapter
              const isPrevEnrich = prevStage.type === 'programmatic' && (prevStage.action === 'enrich_beat_matches' || prevStage.action === 'enrich_beat_frequency')
              if (isPrevPerChapter || isPrevEnrich) {
                try { prevChapterOutput = JSON.parse(stageOutputs[pi] || '[]')[c] || '' } catch {}
                break
              }
            }

            let chPrompt = replacePlaceholders(stage.prompt || '')
              .replace(/\{\{chapter_number\}\}/g, String(ch.chapter_number))
              .replace(/\{\{total_chapters\}\}/g, String(chapterSplits.length))
              .replace(/\{\{chapter_name\}\}/g, ch.chapter_name)
              .replace(/\{\{chapter_purpose\}\}/g, ch.chapter_purpose)
              .replace(/\{\{chapter_emotion\}\}/g, ch.chapter_emotion || '')
              .replace(/\{\{chapter_start_tc\}\}/g, ch.chapter_start_tc)
              .replace(/\{\{chapter_end_tc\}\}/g, ch.chapter_end_tc)
              .replace(/\{\{chapter_duration_seconds\}\}/g, String(ch.chapter_duration_seconds))
              .replace(/\{\{chapter_beats\}\}/g, ch.beats_formatted)
              .replace(/\{\{chapter_transcript\}\}/g, ch.transcript)
              .replace(/\{\{all_chapters\}\}/g, allChaptersCtx)
              .replace(/\{\{a_rolls\}\}/g, allChaptersCtx.split('## Chapters')[0] || '')
              .replace(/\{\{prev_chapter_output\}\}/g, prevChapterOutput)

            const chSystem = replacePlaceholders(stage.system_instruction || '')

            const { callLLM } = await import('./llm-runner.js')
            const result = await callLLM({
              model: stage.model || 'gemini-3.1-pro-preview',
              systemInstruction: chSystem,
              prompt: chPrompt,
              params: stage.params || { temperature: 0.3 },
              experimentId: null,
              abortSignal: pipelineAbort.signal,
            })

            chapterResults[c] = result.text
            stageTokensIn += result.tokensIn || 0
            stageTokensOut += result.tokensOut || 0
            stageCost += result.cost || 0
            completedChapters++
            brollPipelineProgress.set(altPipelineId, { ...brollPipelineProgress.get(altPipelineId), subDone: completedChapters, subTotal: chapterSplits.length, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}` })

            // Store sub-run
            await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              altPlanStrategy.id, videoId, 'analysis', 'complete',
              ch.transcript.slice(0, 500), result.text, chPrompt, chSystem,
              stage.model || 'gemini-3.1-pro-preview',
              result.tokensIn || 0, result.tokensOut || 0, result.cost || 0, 0,
              JSON.stringify({ pipelineId: altPipelineId, stageIndex: i, stageName, subIndex: c, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}`, isSubRun: true, phase: 'alt_plan', videoLabel: altLabel }),
            )
          }

          let nextC = 0
          async function runNext() { while (nextC < chapterSplits.length && !abortedBrollPipelines.has(altPipelineId)) { const c = nextC++; await processChapter(c) } }
          await Promise.all(Array.from({ length: Math.min(CHAPTER_CONCURRENCY, chapterSplits.length) }, () => runNext()))

          output = JSON.stringify(chapterResults.filter(Boolean))
          questionCount++
          llmAnswer = output
          llmAnswers[questionCount] = output

        } else if (stage.type === 'programmatic' && stage.action === 'assemble_broll_plan') {
          // Assemble alt plan
          const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
          let llmResults = []
          try { llmResults = JSON.parse(lastPerChapterOutput) } catch {}
          const parsedPlans = llmResults.map(r => { try { return extractJSON(r) } catch { return r } })
          const allChaptersCtx = chapterSplits._allChaptersContext || ''
          const chapters = chapterSplits.map((ch, idx) => ({
            chapter_number: ch.chapter_number, chapter_name: ch.chapter_name,
            time: `${ch.chapter_start_tc} - ${ch.chapter_end_tc}`,
            duration_seconds: ch.chapter_duration_seconds, purpose: ch.chapter_purpose,
            beats: ch.beats_formatted, plan: parsedPlans[idx] || null,
          }))
          output = JSON.stringify({ video_context: allChaptersCtx, total_chapters: chapters.length, chapters }, null, 2)
        }

        stageOutputs.push(output)
        const stageRuntime = Date.now() - stageStart

        await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          altPlanStrategy.id, videoId, 'analysis', 'complete',
          '', output, stage.prompt || '', stage.system_instruction || '',
          stage.model || 'programmatic',
          stageTokensIn, stageTokensOut, stageCost, stageRuntime,
          JSON.stringify({ pipelineId: altPipelineId, stageIndex: i, totalStages: altStages.length, stageName, stageType: stage.type, phase: 'alt_plan', videoLabel: altLabel, analysisStageCount: 0, groupId }),
        )

        if (stageCost > 0 || stageTokensIn + stageTokensOut > 0) {
          await db.prepare('INSERT INTO spending_log (total_cost, total_tokens, total_runtime_ms, source, created_at) VALUES (?, ?, ?, ?, ?)').run(stageCost, stageTokensIn + stageTokensOut, stageRuntime, `broll alt-plan ${altPipelineId} stage ${i}`, new Date().toISOString())
        }
      }

      brollPipelineProgress.set(altPipelineId, { ...brollPipelineProgress.get(altPipelineId), stageIndex: altStages.length, status: 'complete', stageName: 'Done' })
      setTimeout(() => brollPipelineProgress.delete(altPipelineId), 300_000)
      pipelineAbortControllers.delete(altPipelineId)
      results.push({ pipelineId: altPipelineId, videoId: altVid.id, videoLabel: altLabel, status: 'complete' })
      console.log(`[broll-pipeline] Alt plan for "${altLabel}" complete (${((Date.now() - pipelineStart) / 1000).toFixed(1)}s)`)

    } catch (err) {
      pipelineAbortControllers.delete(altPipelineId)
      brollPipelineProgress.set(altPipelineId, { ...brollPipelineProgress.get(altPipelineId), status: 'failed', error: err.message })
      setTimeout(() => brollPipelineProgress.delete(altPipelineId), 300_000)
      results.push({ pipelineId: altPipelineId, videoId: altVid.id, videoLabel: altLabel, status: 'failed', error: err.message })
      console.error(`[broll-pipeline] Alt plan for "${altLabel}" failed: ${err.message}`)
      notify({ source: 'broll-alt-plan', title: 'Alt plan failed', error: err.message, meta: { pipelineId: altPipelineId, videoId: altVid.id, videoLabel: altLabel } })
    }
  }

  return results
}

// Generate stock footage search keywords for each B-Roll placement in a completed plan
export async function executeKeywords(planPipelineId) {
  // Load plan pipeline's completed stages
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)
  if (!planRuns.length) throw new Error('No completed stages found for plan pipeline')

  const strategyId = planRuns[0].strategy_id
  const videoId = planRuns[0].video_id
  const firstMeta = JSON.parse(planRuns[0].metadata_json || '{}')
  const groupId = firstMeta.groupId || null

  // Find keywords strategy and load prompt/system from its version
  const keywordsStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'keywords' ORDER BY id LIMIT 1").get()
  if (!keywordsStrategy) throw new Error('No keywords strategy found')
  const keywordsVersion = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(keywordsStrategy.id)
  const keywordsStages = keywordsVersion ? JSON.parse(keywordsVersion.stages_json || '[]') : []
  const kwStage = keywordsStages[0] || {}
  const kwPromptTemplate = kwStage.prompt || ''
  const kwSystemTemplate = kwStage.system_instruction || ''
  const kwModel = kwStage.model || 'gemini-3-flash-preview'
  const kwParams = kwStage.params || { temperature: 0.4 }

  // Find the Per-chapter B-Roll plan sub-runs from the plan pipeline
  const planSubRuns = planRuns.filter(r => {
    const m = JSON.parse(r.metadata_json || '{}')
    return m.isSubRun && m.stageName === 'Per-chapter B-Roll plan'
  }).sort((a, b) => {
    const ma = JSON.parse(a.metadata_json || '{}')
    const mb = JSON.parse(b.metadata_json || '{}')
    return (ma.subIndex || 0) - (mb.subIndex || 0)
  })
  if (!planSubRuns.length) throw new Error('No Per-chapter B-Roll plan sub-runs found')

  // Also find alt plan pipelines and their sub-runs
  const altPlanRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"alt-${planPipelineId}-%`)
  const altPlanGroups = {} // { pipelineId: { label, subRuns[] } }
  for (const r of altPlanRuns) {
    const m = JSON.parse(r.metadata_json || '{}')
    if (!m.isSubRun || m.stageName !== 'Per-chapter Alternative B-Roll Plan') continue
    const pid = m.pipelineId
    if (!altPlanGroups[pid]) altPlanGroups[pid] = { label: m.videoLabel || 'Alt', subRuns: [] }
    altPlanGroups[pid].subRuns.push(r)
  }
  // Sort sub-runs within each group
  for (const g of Object.values(altPlanGroups)) {
    g.subRuns.sort((a, b) => (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0))
  }

  // Build combined work list: favorite chapters + alt plan chapters
  const workItems = planSubRuns.map((sr, i) => ({ subRun: sr, source: 'favorite', chapterIndex: i, label: JSON.parse(sr.metadata_json || '{}').subLabel || `Chapter ${i + 1}` }))
  for (const [pid, group] of Object.entries(altPlanGroups)) {
    for (let i = 0; i < group.subRuns.length; i++) {
      const sr = group.subRuns[i]
      const sm = JSON.parse(sr.metadata_json || '{}')
      workItems.push({ subRun: sr, source: `alt:${group.label}`, chapterIndex: i, label: `${group.label} · ${sm.subLabel || `Ch ${i + 1}`}` })
    }
  }

  const keywordsPipelineId = `kw-${planPipelineId}-${Date.now()}`
  const pipelineStart = Date.now()
  const pipelineAbort = new AbortController()
  pipelineAbortControllers.set(keywordsPipelineId, pipelineAbort)

  const altCount = Object.keys(altPlanGroups).length
  console.log(`[broll-pipeline] Starting keywords generation: ${planSubRuns.length} favorite chapters + ${altCount} alt plans (${workItems.length} total)`)
  brollPipelineProgress.set(keywordsPipelineId, { strategyId: keywordsStrategy.id, videoId, groupId, strategyName: 'Generate Keywords', videoTitle: '', startedAt: pipelineStart, stageIndex: 0, totalStages: 1, status: 'running', stageName: 'Generate B-Roll Keywords', phase: 'keywords', videoLabel: '', subDone: 0, subTotal: workItems.length, subLabel: '' })

  try {
    // Generate keywords for all work items (favorite + alt plan chapters)
    const CHAPTER_CONCURRENCY = 5
    const allResults = new Array(workItems.length).fill(null)
    let completedItems = 0

    async function processItem(idx) {
      if (abortedBrollPipelines.has(keywordsPipelineId)) return
      const item = workItems[idx]
      const rawPlacements = item.subRun.output_text || ''

      // Filter to only broll placements (skip graphic_package and overlay_image)
      let filteredPlacements = rawPlacements
      try {
        const parsed = extractJSON(rawPlacements)
        const brollOnly = (parsed.placements || parsed).filter(p => p.category === 'broll')
        filteredPlacements = JSON.stringify({ placements: brollOnly }, null, 2)
        console.log(`[broll-pipeline] Keywords: ${item.label} (${brollOnly.length} broll of ${(parsed.placements || parsed).length})`)
      } catch {
        console.log(`[broll-pipeline] Keywords: ${item.label} (could not filter, using raw)`)
      }

      const prompt = kwPromptTemplate.replace(/\{\{chapter_placements\}\}/g, filteredPlacements)
      const system = kwSystemTemplate

      const { callLLM } = await import('./llm-runner.js')
      const result = await callLLM({
        model: kwModel,
        systemInstruction: system,
        prompt,
        params: kwParams,
        experimentId: null,
        abortSignal: pipelineAbort.signal,
      })

      allResults[idx] = result.text
      completedItems++
      brollPipelineProgress.set(keywordsPipelineId, { ...brollPipelineProgress.get(keywordsPipelineId), subDone: completedItems, subLabel: item.label })

      await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        keywordsStrategy.id, videoId, 'analysis', 'complete',
        filteredPlacements.slice(0, 500), result.text, prompt, system,
        kwModel,
        result.tokensIn || 0, result.tokensOut || 0, result.cost || 0, 0,
        JSON.stringify({ pipelineId: keywordsPipelineId, stageIndex: 0, stageName: 'Generate B-Roll Keywords', subIndex: idx, subLabel: item.label, source: item.source, isSubRun: true, phase: 'keywords', groupId }),
      )

      if ((result.cost || 0) > 0 || (result.tokensIn || 0) + (result.tokensOut || 0) > 0) {
        await db.prepare('INSERT INTO spending_log (total_cost, total_tokens, total_runtime_ms, source, created_at) VALUES (?, ?, ?, ?, ?)').run(result.cost || 0, (result.tokensIn || 0) + (result.tokensOut || 0), 0, `broll keywords ${keywordsPipelineId} item ${idx}`, new Date().toISOString())
      }
    }

    let nextIdx = 0
    async function runNext() { while (nextIdx < workItems.length && !abortedBrollPipelines.has(keywordsPipelineId)) { const i = nextIdx++; await processItem(i) } }
    await Promise.all(Array.from({ length: Math.min(CHAPTER_CONCURRENCY, workItems.length) }, () => runNext()))

    const keywordsOutput = JSON.stringify(allResults.filter(Boolean))

    // Main stage entry
    await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      keywordsStrategy.id, videoId, 'analysis', 'complete',
      '', keywordsOutput, '', '', 'gemini-3-flash-preview', 0, 0, 0, Date.now() - pipelineStart,
      JSON.stringify({ pipelineId: keywordsPipelineId, stageIndex: 0, totalStages: 1, stageName: 'Generate B-Roll Keywords', stageType: 'transcript_question', phase: 'keywords', groupId, analysisStageCount: 0 }),
    )

    brollPipelineProgress.set(keywordsPipelineId, { ...brollPipelineProgress.get(keywordsPipelineId), stageIndex: 1, totalStages: 1, status: 'complete', stageName: 'Done' })
    // Clean up stale failed entries
    await db.prepare(`DELETE FROM broll_runs WHERE status = 'failed' AND metadata_json LIKE ?`).run(`%"pipelineId":"${keywordsPipelineId}"%`)
    setTimeout(() => brollPipelineProgress.delete(keywordsPipelineId), 300_000)
    pipelineAbortControllers.delete(keywordsPipelineId)
    console.log(`[broll-pipeline] Keywords complete (${((Date.now() - pipelineStart) / 1000).toFixed(1)}s, ${planSubRuns.length} chapters)`)

    return { pipelineId: keywordsPipelineId, status: 'complete' }

  } catch (err) {
    pipelineAbortControllers.delete(keywordsPipelineId)
    brollPipelineProgress.set(keywordsPipelineId, { ...brollPipelineProgress.get(keywordsPipelineId), status: 'failed', error: err.message })
    setTimeout(() => brollPipelineProgress.delete(keywordsPipelineId), 300_000)
    console.error(`[broll-pipeline] Keywords failed: ${err.message}`)
    notify({ source: 'broll-keywords', title: 'Keywords pipeline failed', error: err.message, meta: { pipelineId: keywordsPipelineId, videoId } })
    throw err
  }
}

// Poll GPU proxy job until complete or timeout
async function _pollGpuJob(jobId, gpuKey, timeoutSeconds = 900) {
  const GPU_JOB_URL = `https://gpu-proxy-production.up.railway.app/broll/jobs/${jobId}`
  const start = Date.now()
  while ((Date.now() - start) < timeoutSeconds * 1000) {
    await new Promise(r => setTimeout(r, 10000)) // poll every 10s
    try {
      const resp = await fetch(GPU_JOB_URL, {
        headers: { 'X-Internal-Key': gpuKey },
      })
      if (!resp.ok) continue
      const job = await resp.json()
      if (job.status === 'complete' && job.final_results) {
        return job.final_results
      }
      if (job.status === 'failed') {
        return { status: 'failed', error: job.error }
      }
      console.log(`[broll-pipeline] Job ${jobId}: ${job.status}`)
    } catch {}
  }
  return { status: 'timeout' }
}

// Resolve which stock libraries to send to the broll proxy for a given plan pipeline.
// Reads `libraries_json` + `freepik_opt_in` from the parent video group, filters
// `artlist` (no proxy provider yet), and always appends `pexels` (free, always on).
// `overrides.sources` (if non-empty) wins, with the same artlist filter applied.
async function resolveBrollSources(planPipelineId, overrides = {}) {
  if (overrides.sources?.length) {
    return overrides.sources.filter(s => s !== 'artlist')
  }

  let libraries = []
  let freepikOptIn = true

  try {
    const planRuns = await db.prepare(
      `SELECT metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id LIMIT 1`
    ).all(`%"pipelineId":"${planPipelineId}"%`)
    const groupId = planRuns[0] ? JSON.parse(planRuns[0].metadata_json || '{}').groupId : null

    if (groupId) {
      const group = await db.prepare(
        `SELECT libraries_json, freepik_opt_in FROM video_groups WHERE id = ?`
      ).get(groupId)
      if (group?.libraries_json) {
        try { libraries = JSON.parse(group.libraries_json) || [] } catch {}
      }
      if (group?.freepik_opt_in === false) freepikOptIn = false
    }
  } catch (e) {
    console.error('[broll] resolveBrollSources failed, falling back to pexels only:', e)
  }

  const sources = [...libraries.filter(l => l !== 'artlist'), 'pexels']
  if (freepikOptIn) sources.push('freepik')
  return Array.from(new Set(sources))
}

// Search stock footage for each B-Roll placement using keywords + GPU-powered API
export async function executeBrollSearch(planPipelineId, { limit } = {}) {
  const GPU_URL = 'https://gpu-proxy-production.up.railway.app/broll/search'
  const GPU_KEY = process.env.GPU_INTERNAL_KEY
  if (!GPU_KEY) throw new Error('GPU_INTERNAL_KEY not set')

  // Load plan pipeline data
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)
  if (!planRuns.length) throw new Error('No completed stages found for plan pipeline')

  const videoId = planRuns[0].video_id
  const firstMeta = JSON.parse(planRuns[0].metadata_json || '{}')
  const groupId = firstMeta.groupId || null

  // Find or create broll_search strategy
  let searchStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'broll_search' ORDER BY id LIMIT 1").get()
  if (!searchStrategy) {
    const r = await db.prepare("INSERT INTO broll_strategies (name, strategy_kind) VALUES (?, ?)").run('B-Roll Video Search', 'broll_search')
    searchStrategy = { id: r.lastInsertRowid }
  }

  // Load plan sub-runs (placements) — favorite
  const planSubRuns = planRuns.filter(r => {
    const m = JSON.parse(r.metadata_json || '{}')
    return m.isSubRun && m.stageName === 'Per-chapter B-Roll plan'
  }).sort((a, b) => (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0))

  // Load alt plan sub-runs
  const altPlanRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"alt-${planPipelineId}-%`)
  const altSubRuns = altPlanRuns.filter(r => {
    const m = JSON.parse(r.metadata_json || '{}')
    return m.isSubRun && m.stageName === 'Per-chapter Alternative B-Roll Plan'
  }).sort((a, b) => (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0))

  // Load keywords sub-runs (from the most recent kw- pipeline)
  const kwRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id DESC`
  ).all(`%"pipelineId":"kw-${planPipelineId}-%`)
  const kwSubRuns = kwRuns.filter(r => JSON.parse(r.metadata_json || '{}').isSubRun)

  // Build keyword lookup: { "favorite:0": [...], "favorite:1": [...], "alt:Label:0": [...] }
  const kwByKey = {}
  for (const r of kwSubRuns) {
    const m = JSON.parse(r.metadata_json || '{}')
    const source = m.source || 'favorite'
    const chIdx = source === 'favorite' ? m.subIndex : m.subIndex - planSubRuns.length
    const key = source.startsWith('alt:') ? `${source}:${chIdx}` : `favorite:${m.subIndex}`
    try {
      kwByKey[key] = extractJSON(r.output_text || '')
    } catch {}
  }

  // Build work items: flatten all placements from favorite + alt
  const workItems = []

  function addPlacements(subRuns, source) {
    for (let chIdx = 0; chIdx < subRuns.length; chIdx++) {
      const sr = subRuns[chIdx]
      const srMeta = JSON.parse(sr.metadata_json || '{}')
      const chLabel = srMeta.subLabel || `Chapter ${chIdx + 1}`
      try {
        const parsed = extractJSON(sr.output_text || '')
        const placements = parsed.placements || parsed
        if (!Array.isArray(placements)) continue
        const brollOnly = placements.filter(p => p.category === 'broll')

        // Find keywords for this chapter
        const kwKey = source === 'favorite' ? `favorite:${chIdx}` : `${source}:${chIdx}`
        const chKeywords = Array.isArray(kwByKey[kwKey]) ? kwByKey[kwKey] : []

        for (let pIdx = 0; pIdx < brollOnly.length; pIdx++) {
          const p = brollOnly[pIdx]
          // Find matching keywords by placement_index
          const kwEntry = chKeywords.find(k => k.placement_index === pIdx) || chKeywords[pIdx]
          const keywords = kwEntry?.keywords
            ? kwEntry.keywords.flatMap(k => [k.query_2w, k.query_3w].filter(Boolean))
            : []

          workItems.push({ placement: p, keywords, source, chapterIndex: chIdx, placementIndex: pIdx, chapterLabel: chLabel })
        }
      } catch {}
    }
  }

  addPlacements(planSubRuns, 'favorite')

  // Group alt sub-runs by pipeline
  const altByPipeline = {}
  for (const sr of altSubRuns) {
    const m = JSON.parse(sr.metadata_json || '{}')
    const pid = m.pipelineId
    if (!altByPipeline[pid]) altByPipeline[pid] = { label: m.videoLabel || 'Alt', subRuns: [] }
    altByPipeline[pid].subRuns.push(sr)
  }
  for (const g of Object.values(altByPipeline)) {
    g.subRuns.sort((a, b) => (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0))
    addPlacements(g.subRuns, `alt:${g.label}`)
  }

  if (!workItems.length) throw new Error('No broll placements found')

  // Skip items that already have search results
  const existingSearchRuns = await db.prepare(
    `SELECT metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete'`
  ).all(`%"pipelineId":"bs-${planPipelineId}-%`)
  const searched = new Set()
  for (const r of existingSearchRuns) {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      if (m.isSubRun) searched.add(`${m.chapterIndex}:${m.placementIndex}`)
    } catch {}
  }
  const pendingItems = workItems.filter(w => !searched.has(`${w.chapterIndex}:${w.placementIndex}`))
  const itemsToProcess = limit ? pendingItems.slice(0, limit) : pendingItems

  if (!itemsToProcess.length) {
    console.log(`[broll-pipeline] All ${workItems.length} items already searched, nothing to do`)
    return
  }

  const searchPipelineId = `bs-${planPipelineId}-${Date.now()}`
  const pipelineStart = Date.now()
  const pipelineAbort = new AbortController()
  pipelineAbortControllers.set(searchPipelineId, pipelineAbort)

  console.log(`[broll-pipeline] Starting B-Roll search: ${itemsToProcess.length} of ${workItems.length} elements (${searched.size} already done, limit: ${limit || 'none'})`)
  brollPipelineProgress.set(searchPipelineId, { strategyId: searchStrategy.id, videoId, groupId, strategyName: 'B-Roll Search', videoTitle: '', startedAt: pipelineStart, stageIndex: 0, totalStages: 1, status: 'running', stageName: 'Searching stock footage', phase: 'broll_search', videoLabel: '', subDone: 0, subTotal: itemsToProcess.length, subLabel: '' })

  let completedItems = 0
  const resolvedSources = await resolveBrollSources(planPipelineId)
  console.log(`[broll-pipeline] Sources for ${searchPipelineId}: ${resolvedSources.join(', ')}`)

  try {
    // Process ONE element at a time (sequential — API takes ~90s each)
    for (let idx = 0; idx < itemsToProcess.length; idx++) {
      if (abortedBrollPipelines.has(searchPipelineId)) break
      const item = itemsToProcess[idx]
      const p = item.placement
      const shortDesc = (p.description || '').slice(0, 60)
      const subLabel = `Ch${item.chapterIndex + 1} #${item.placementIndex + 1}: ${shortDesc}`

      brollPipelineProgress.set(searchPipelineId, { ...brollPipelineProgress.get(searchPipelineId), subDone: completedItems, subLabel })
      console.log(`[broll-pipeline] Search ${idx + 1}/${itemsToProcess.length}: ${subLabel}`)

      // Build brief — description + full style, no function/type metadata
      const styleParts = []
      if (p.style?.colors) styleParts.push(`colors: ${p.style.colors}`)
      if (p.style?.temperature) styleParts.push(`temperature: ${p.style.temperature}`)
      if (p.style?.motion) styleParts.push(`motion: ${p.style.motion}`)
      if (p.style?.framing) styleParts.push(`framing: ${p.style.framing}`)
      if (p.style?.lighting) styleParts.push(`lighting: ${p.style.lighting}`)

      const brief = [
        p.description ? `# ${p.description}` : '',
        styleParts.length ? `## Style: ${styleParts.join('; ')}` : '',
      ].filter(Boolean).join('\n')

      // Use keywords from keyword generation, or fall back to placement's search_keywords
      const searchKeywords = item.keywords.length ? item.keywords : (p.search_keywords || [])

      const requestBody = {
        keywords: searchKeywords,
        brief,
        sources: resolvedSources,
        max_results: 10,
      }

      let results = []
      let searchMeta = {}
      const searchStart = Date.now()
      try {
        const data = await streamingFetch(GPU_URL, {
          body: requestBody,
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': GPU_KEY },
          signal: pipelineAbort.signal,
          logSource: `broll-search:${searchPipelineId}`,
          onProgress: (ev) => {
            const gpuStatus = ev.status ? `${ev.stage}: ${ev.status}` : ev.stage
            console.log(`[broll-pipeline] GPU [${idx + 1}/${itemsToProcess.length}] ${gpuStatus}`)
            brollPipelineProgress.set(searchPipelineId, {
              ...brollPipelineProgress.get(searchPipelineId),
              subDone: completedItems,
              subLabel,
              gpuStage: ev.stage,
              gpuStatus: ev.status,
            })
          },
        })

        results = data.results || []
        searchMeta = { search_count: data.search_count, filtered_count: data.filtered_count, model_used: data.model_used }
      } catch (err) {
        if (err.name === 'AbortError') throw err

        // Try to recover via job polling if we got a job_id before disconnect
        const jobId = err.job_id || null
        if (!jobId) {
          // Check events array from streamingFetch for job_id
          const events = err.events || []
          const jobEvent = events.find(e => e.data?.job_id)
          if (jobEvent?.data?.job_id) {
            console.log(`[broll-pipeline] SSE failed but have job_id ${jobEvent.data.job_id}, polling for results...`)
            try {
              const jobResult = await _pollGpuJob(jobEvent.data.job_id, GPU_KEY, 900)
              if (jobResult?.results) {
                results = jobResult.results
                searchMeta = { search_count: jobResult.search_count, filtered_count: jobResult.filtered_count, model_used: jobResult.model_used, recovered: true }
                console.log(`[broll-pipeline] Recovered ${results.length} results from job ${jobEvent.data.job_id}`)
              } else {
                searchMeta = { error: `Job ${jobEvent.data.job_id}: ${jobResult?.status || 'unknown'}` }
              }
            } catch (pollErr) {
              console.warn(`[broll-pipeline] Job poll failed: ${pollErr.message}`)
              searchMeta = { error: err.message }
            }
          } else {
            console.warn(`[broll-pipeline] Search failed for element ${idx}: ${err.message}`)
            searchMeta = { error: err.message }
          }
        }
      }
      const searchDuration = Date.now() - searchStart

      const output = JSON.stringify({
        placement: { description: p.description, start: p.start, end: p.end, audio_anchor: p.audio_anchor, function: p.function, type_group: p.type_group, source_feel: p.source_feel },
        keywords_used: searchKeywords,
        results,
        ...searchMeta,
      })

      // Results tracked via api_logs (streamingFetch) and broll_search_logs (GPU proxy)

      completedItems++
    }

    brollPipelineProgress.set(searchPipelineId, { ...brollPipelineProgress.get(searchPipelineId), stageIndex: 1, status: 'complete', stageName: 'Done', subDone: completedItems })
    setTimeout(() => brollPipelineProgress.delete(searchPipelineId), 300_000)
    pipelineAbortControllers.delete(searchPipelineId)
    await db.prepare(`DELETE FROM broll_runs WHERE status = 'failed' AND metadata_json LIKE ?`).run(`%"pipelineId":"${searchPipelineId}"%`)
    console.log(`[broll-pipeline] B-Roll search complete: ${completedItems}/${workItems.length} elements (${((Date.now() - pipelineStart) / 1000).toFixed(0)}s)`)

    return { pipelineId: searchPipelineId, status: 'complete', totalSearched: completedItems }

  } catch (err) {
    pipelineAbortControllers.delete(searchPipelineId)
    brollPipelineProgress.set(searchPipelineId, { ...brollPipelineProgress.get(searchPipelineId), status: 'failed', error: err.message, subDone: completedItems })
    setTimeout(() => brollPipelineProgress.delete(searchPipelineId), 300_000)
    if (!abortedBrollPipelines.has(searchPipelineId)) {
      await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, error_message, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`).run(searchStrategy.id, videoId, 'analysis', 'failed', err.message, JSON.stringify({ pipelineId: searchPipelineId, stageIndex: 0, totalStages: 1 }))
    }
    console.error(`[broll-pipeline] B-Roll search failed: ${err.message}`)
    notify({ source: 'broll-search', title: 'Search pipeline failed', error: err.message, meta: { pipelineId: searchPipelineId, videoId, completedItems } })
    throw err
  }
}

/**
 * Merged keywords + search: processes placements in batches.
 * 1. Groups first N placements by chapter
 * 2. Generates keywords per CHAPTER (one LLM call per chapter, concurrent)
 * 3. As each chapter's keywords finish, queues its placements for search
 * 4. Search runs sequentially (1 at a time, GPU takes ~90s each)
 * @param {string} planPipelineId - plan pipeline to process
 * @param {number} batchSize - how many placements to process (default 10)
 */
/**
 * Generate search keywords for a batch of plan placements using strategy 11 (keywords_batch).
 * This is a plain LLM call — no GPU, no stock footage search.
 * Takes the next `batchSize` placements from a plan pipeline that don't have keywords yet.
 */
export async function executeKeywordsBatch(planPipelineId, batchSize = 10, preGeneratedPipelineId = null) {
  // Load plan pipeline data
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)
  if (!planRuns.length) throw new Error('No completed stages found for plan pipeline')

  const videoId = planRuns[0].video_id
  const firstMeta = JSON.parse(planRuns[0].metadata_json || '{}')
  const groupId = firstMeta.groupId || null

  // Load batch keywords strategy (falls back to legacy 'keywords' if batch not found)
  let keywordsStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'keywords_batch' ORDER BY id LIMIT 1").get()
  if (!keywordsStrategy) keywordsStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'keywords' ORDER BY id LIMIT 1").get()
  if (!keywordsStrategy) throw new Error('No keywords strategy found')
  const keywordsVersion = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(keywordsStrategy.id)
  const keywordsStages = keywordsVersion ? JSON.parse(keywordsVersion.stages_json || '[]') : []
  const kwStage = keywordsStages[0] || {}
  const kwPromptTemplate = kwStage.prompt || ''
  const kwSystemTemplate = kwStage.system_instruction || ''
  const kwModel = kwStage.model || 'gemini-3-flash-preview'
  const kwParams = kwStage.params || { temperature: 0.4 }

  // Load plan sub-runs (per-chapter plan outputs)
  const planSubRuns = planRuns.filter(r => {
    const m = JSON.parse(r.metadata_json || '{}')
    return m.isSubRun && m.stageName === 'Per-chapter B-Roll plan'
  }).sort((a, b) => (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0))

  // Build flat list of broll placements across all chapters
  const workItems = []
  for (let chIdx = 0; chIdx < planSubRuns.length; chIdx++) {
    const sr = planSubRuns[chIdx]
    const srMeta = JSON.parse(sr.metadata_json || '{}')
    const chLabel = srMeta.subLabel || `Chapter ${chIdx + 1}`
    try {
      const parsed = extractJSON(sr.output_text || '')
      const placements = parsed.placements || parsed
      if (!Array.isArray(placements)) continue
      const brollOnly = placements.filter(p => p.category === 'broll')
      for (let pIdx = 0; pIdx < brollOnly.length; pIdx++) {
        workItems.push({ placement: brollOnly[pIdx], chapterIndex: chIdx, placementIndex: pIdx, chapterLabel: chLabel })
      }
    } catch {}
  }
  if (!workItems.length) throw new Error('No broll placements found')

  // Skip items that already have keywords
  const existingKwRuns = await db.prepare(
    `SELECT metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete'`
  ).all(`%"pipelineId":"kw-${planPipelineId}-%`)
  const kwDone = new Set()
  for (const r of existingKwRuns) {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      if (m.isSubRun && m.processedIndices) {
        for (const idx of m.processedIndices) kwDone.add(idx)
      }
    } catch {}
  }
  const pendingItems = workItems.filter((_, i) => !kwDone.has(i))
  const itemsToProcess = pendingItems.slice(0, batchSize)

  if (!itemsToProcess.length) {
    console.log(`[broll-keywords] All ${workItems.length} items already have keywords`)
    return { pipelineId: null, status: 'complete', totalProcessed: 0, totalElements: workItems.length }
  }

  const pipelineId = preGeneratedPipelineId || `kw-${planPipelineId}-${Date.now()}`
  const pipelineStart = Date.now()
  const pipelineAbort = new AbortController()
  pipelineAbortControllers.set(pipelineId, pipelineAbort)

  console.log(`[broll-keywords] Generating keywords for ${itemsToProcess.length} of ${workItems.length} placements (${kwDone.size} already done)`)
  brollPipelineProgress.set(pipelineId, {
    strategyId: keywordsStrategy.id, videoId, groupId,
    strategyName: 'Generate Keywords', videoTitle: '', startedAt: pipelineStart,
    stageIndex: 0, totalStages: 1, status: 'running',
    stageName: `Generating keywords for ${itemsToProcess.length} placements`,
    phase: 'keywords',
    subDone: 0, subTotal: itemsToProcess.length,
    subLabel: `Batch of ${itemsToProcess.length}`,
    planPipelineId,
  })

  try {
    // Build batch placements JSON for the prompt template
    const batchPlacements = itemsToProcess.map((item, i) => ({
      batch_index: i,
      chapter_index: item.chapterIndex,
      placement_index: item.placementIndex,
      chapter_label: item.chapterLabel,
      description: item.placement.description,
      audio_anchor: item.placement.audio_anchor,
      function: item.placement.function,
      type_group: item.placement.type_group,
      source_feel: item.placement.source_feel,
      style: item.placement.style,
    }))

    const filteredPlacements = JSON.stringify({ placements: batchPlacements }, null, 2)
    const prompt = kwPromptTemplate
      .replace(/\{\{batch_placements\}\}/g, filteredPlacements)
      .replace(/\{\{chapter_placements\}\}/g, filteredPlacements)

    console.log(`[broll-keywords] ${pipelineId} Running LLM call (${kwModel}) for ${itemsToProcess.length} placements`)

    const kwResult = await callLLM({
      model: kwModel, systemInstruction: kwSystemTemplate,
      prompt, params: kwParams, experimentId: null,
      abortSignal: pipelineAbort.signal,
      logPrefix: `[kw:${pipelineId.slice(-12)}]`,
    })

    // Track which global indices were processed
    const processedIndices = itemsToProcess.map((item) => workItems.indexOf(item))

    // Store keyword run
    await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      keywordsStrategy.id, videoId, 'analysis', 'complete',
      filteredPlacements.slice(0, 500), kwResult.text, prompt, kwSystemTemplate, kwModel,
      kwResult.tokensIn || 0, kwResult.tokensOut || 0, kwResult.cost || 0, Date.now() - pipelineStart,
      JSON.stringify({
        pipelineId, stageIndex: 0, stageName: 'Generate Keywords',
        subIndex: 0, subLabel: `Batch of ${itemsToProcess.length}`,
        isSubRun: true, phase: 'keywords', groupId, planPipelineId,
        processedIndices, batchSize: itemsToProcess.length,
        totalPlacements: workItems.length,
      }),
    )

    brollPipelineProgress.set(pipelineId, {
      ...brollPipelineProgress.get(pipelineId),
      stageIndex: 1, status: 'complete', stageName: 'Done',
      subDone: itemsToProcess.length,
    })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    pipelineAbortControllers.delete(pipelineId)
    console.log(`[broll-keywords] Done: ${itemsToProcess.length} placements (${((Date.now() - pipelineStart) / 1000).toFixed(0)}s)`)

    return {
      pipelineId, status: 'complete',
      totalProcessed: itemsToProcess.length,
      totalElements: workItems.length,
      remaining: pendingItems.length - itemsToProcess.length,
    }

  } catch (err) {
    pipelineAbortControllers.delete(pipelineId)
    brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), status: 'failed', error: err.message })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    console.error(`[broll-keywords] Failed: ${err.message}`)
    notify({ source: 'broll-keywords-batch', title: 'Keywords batch failed', error: err.message, meta: { pipelineId, videoId } })
    throw err
  }
}

/**
 * Unified search batch: generates keywords for all variants in parallel,
 * then GPU-searches placements one-at-a-time interleaved across variants.
 */
export async function executeSearchBatch(planPipelineIds, batchSize = 10, pipelineIdOverride = null) {
  const pipelineId = pipelineIdOverride || `search-batch-${Date.now()}`
  const pipelineStart = Date.now()
  const pipelineAbort = new AbortController()
  pipelineAbortControllers.set(pipelineId, pipelineAbort)

  brollPipelineProgress.set(pipelineId, {
    status: 'running', phase: 'keywords',
    stageName: 'Checking queue...',
    keywordsDone: 0, keywordsTotal: planPipelineIds.length,
    subDone: 0, subTotal: batchSize,
  })

  try {
    // Phase 0: Check for existing waiting/running entries from a previous interrupted batch
    const existingResumable = await db.prepare(
      `SELECT * FROM broll_searches WHERE plan_pipeline_id IN (${planPipelineIds.map(() => '?').join(',')}) AND status IN ('waiting', 'running', 'failed', 'stopped') ORDER BY id`
    ).all(...planPipelineIds)

    let toSearch = []

    if (existingResumable.length) {
      // Resume existing queue — skip keywords, go straight to GPU search
      console.log(`[search-batch] Resuming ${existingResumable.length} existing queue entries (${existingResumable.map(r => r.status).join(', ')})`)
      // Reset stuck/failed/stopped entries back to 'waiting'
      for (const row of existingResumable) {
        if (row.status !== 'waiting') {
          await db.prepare(`UPDATE broll_searches SET status = 'waiting', started_at = NULL, completed_at = NULL, error = NULL WHERE id = ?`).run(row.id)
        }
      }
      toSearch = existingResumable.map(row => ({
        pid: row.plan_pipeline_id,
        chapterIndex: row.chapter_index,
        placementIndex: row.placement_index,
        brollSearchId: row.id,
        variantLabel: row.variant_label || 'Variant',
      }))
    } else {
      // No existing queue — full flow: keywords + create new entries

      // Phase 1: Generate keywords for all variants in parallel
      brollPipelineProgress.set(pipelineId, {
        ...brollPipelineProgress.get(pipelineId),
        stageName: 'Generating keywords...',
      })
      const kwResults = await Promise.allSettled(
        planPipelineIds.map(async (pid) => {
          const result = await executeKeywordsBatch(pid, batchSize)
          const prog = brollPipelineProgress.get(pipelineId)
          if (prog) {
            prog.keywordsDone = (prog.keywordsDone || 0) + 1
            prog.stageName = `Keywords: ${prog.keywordsDone}/${prog.keywordsTotal} variants`
            brollPipelineProgress.set(pipelineId, { ...prog })
          }
          return { pid, result }
        })
      )
      console.log(`[search-batch] Keywords done for ${kwResults.filter(r => r.status === 'fulfilled').length}/${planPipelineIds.length} variants`)

      if (abortedBrollPipelines.has(pipelineId)) throw new Error('Aborted')

      // Phase 2: Build interleaved queue from all variants
      const variantQueues = []
      for (const pid of planPipelineIds) {
        const queue = await _getPendingGpuPlacements(pid)
        variantQueues.push(queue)
      }

      const interleaved = []
      const maxLen = Math.max(...variantQueues.map(q => q.length), 0)
      for (let i = 0; i < maxLen; i++) {
        for (const queue of variantQueues) {
          if (i < queue.length) interleaved.push(queue[i])
        }
      }
      const gpuBatchSize = batchSize * planPipelineIds.length
      const sliced = interleaved.slice(0, gpuBatchSize)
      console.log(`[search-batch] GPU queue: ${sliced.length} placements (from ${interleaved.length} total pending, ${batchSize}/variant × ${planPipelineIds.length} variants)`)

      // Phase 2.5: Create queue entries in broll_searches
      for (const item of sliced) {
        const variantLabel = `Variant ${String.fromCharCode(65 + planPipelineIds.indexOf(item.pid))}`
        const { brief, keywords, description } = await _buildSearchParams(item.pid, item.chapterIndex, item.placementIndex)
        const ins = await db.prepare(`
          INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, variant_label, description, brief, keywords_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')
        `).run(item.pid, pipelineId, item.chapterIndex, item.placementIndex, variantLabel, description, brief, JSON.stringify(keywords))
        item.brollSearchId = ins.lastInsertRowid
        item.variantLabel = variantLabel
      }
      toSearch = sliced
      console.log(`[search-batch] Created ${toSearch.length} queue entries in broll_searches`)
    }

    // Phase 3: Sequential GPU search
    brollPipelineProgress.set(pipelineId, {
      ...brollPipelineProgress.get(pipelineId),
      phase: 'gpu_search',
      stageName: 'Searching B-Roll...',
      subDone: 0, subTotal: toSearch.length,
    })

    for (let i = 0; i < toSearch.length; i++) {
      if (abortedBrollPipelines.has(pipelineId)) {
        // Mark remaining entries as stopped (not failed — user intentionally stopped)
        for (const remaining of toSearch.slice(i)) {
          await db.prepare(
            `UPDATE broll_searches SET status = 'stopped', error = 'Stopped by user', completed_at = NOW() WHERE id = ? AND status IN ('waiting', 'running')`
          ).run(remaining.brollSearchId)
        }
        throw new Error('Aborted')
      }
      const item = toSearch[i]
      brollPipelineProgress.set(pipelineId, {
        ...brollPipelineProgress.get(pipelineId),
        stageName: `${item.variantLabel} Ch${item.chapterIndex + 1} #${item.placementIndex + 1}`,
        subDone: i, subTotal: toSearch.length,
        currentVariant: item.variantLabel,
      })

      // Mark as running in queue
      await db.prepare(`UPDATE broll_searches SET status = 'running', started_at = NOW() WHERE id = ?`).run(item.brollSearchId)

      try {
        const result = await searchSinglePlacement(item.pid, item.chapterIndex, item.placementIndex)
        // If we got zero results because the GPU job is still running or failed, surface that
        // in the row status — don't lie by marking 'complete'. UI can then show a real state.
        const rowStatus = result.gpuJobStatus === 'running' ? 'timeout'
          : result.gpuJobStatus === 'failed' ? 'failed'
          : 'complete'
        await db.prepare(`
          UPDATE broll_searches SET status = ?, results_json = ?, num_results = ?, duration_ms = ?, api_log_id = ?, error = ?, completed_at = NOW()
          WHERE id = ?
        `).run(
          rowStatus,
          JSON.stringify(result.results || []),
          (result.results || []).length,
          result.duration || null,
          result.apiLogId || null,
          result.error || null,
          item.brollSearchId
        )
      } catch (err) {
        console.error(`[search-batch] GPU search failed for ${item.variantLabel} Ch${item.chapterIndex + 1} #${item.placementIndex + 1}: ${err.message}`)
        await db.prepare(`UPDATE broll_searches SET status = 'failed', error = ?, completed_at = NOW() WHERE id = ?`).run(err.message, item.brollSearchId)
      }
    }

    brollPipelineProgress.set(pipelineId, {
      ...brollPipelineProgress.get(pipelineId),
      status: 'complete', stageName: 'Done',
      subDone: toSearch.length, subTotal: toSearch.length,
    })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    pipelineAbortControllers.delete(pipelineId)
    console.log(`[search-batch] Complete: ${toSearch.length} searches (${((Date.now() - pipelineStart) / 1000).toFixed(0)}s)`)

    return { pipelineId, searched: toSearch.length, total: toSearch.length }

  } catch (err) {
    pipelineAbortControllers.delete(pipelineId)
    brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), status: 'failed', error: err.message })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    // Mark any remaining waiting/running queue entries as failed
    db.prepare(
      `UPDATE broll_searches SET status = 'failed', error = ?, completed_at = NOW() WHERE batch_id = ? AND status IN ('waiting', 'running')`
    ).run(err.message, pipelineId).catch(() => {})
    console.error(`[search-batch] Failed: ${err.message}`)
    notify({ source: 'broll-search-batch', title: 'Search batch failed', error: err.message, meta: { pipelineId } })
    throw err
  }
}

// Helper: build brief, keywords, and description for a placement (shared by executeSearchBatch + searchSinglePlacement)
async function _buildSearchParams(planPipelineId, chapterIndex, placementIndex) {
  // Load plan sub-runs to find the placement
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)
  const chapterRuns = planRuns.filter(r => {
    try { const m = JSON.parse(r.metadata_json || '{}'); return m.isSubRun && m.stageName === 'Per-chapter B-Roll plan' }
    catch { return false }
  }).sort((a, b) => {
    const ma = JSON.parse(a.metadata_json || '{}'), mb = JSON.parse(b.metadata_json || '{}')
    return (ma.subIndex || 0) - (mb.subIndex || 0)
  })

  if (chapterIndex >= chapterRuns.length) return { brief: '', keywords: [], description: '' }

  let parsed
  try { parsed = extractJSON(chapterRuns[chapterIndex].output_text || '') } catch { return { brief: '', keywords: [], description: '' } }

  const items = parsed.placements || parsed
  if (!Array.isArray(items)) return { brief: '', keywords: [], description: '' }
  const brollOnly = items.filter(p => !p.category || p.category === 'broll')
  if (placementIndex >= brollOnly.length) return { brief: '', keywords: [], description: '' }

  const p = brollOnly[placementIndex]

  // Load keywords
  const kwRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id DESC`
  ).all(`%"pipelineId":"kw-${planPipelineId}-%`)
  const kwSubRuns = kwRuns.filter(r => JSON.parse(r.metadata_json || '{}').isSubRun)

  let keywords = []
  for (const r of kwSubRuns) {
    const m = JSON.parse(r.metadata_json || '{}')
    if (m.subIndex === chapterIndex) {
      try {
        const kwData = extractJSON(r.output_text || '')
        const kwEntry = (Array.isArray(kwData) ? kwData : []).find(k => k.placement_index === placementIndex) || kwData[placementIndex]
        if (kwEntry?.keywords) {
          keywords = kwEntry.keywords.flatMap(k => [k.query_2w, k.query_3w].filter(Boolean))
        }
      } catch {}
      break
    }
  }
  if (!keywords.length) keywords = p.search_keywords || []

  // Build brief
  const styleParts = []
  if (p.style?.colors) styleParts.push(`colors: ${p.style.colors}`)
  if (p.style?.temperature) styleParts.push(`temperature: ${p.style.temperature}`)
  if (p.style?.motion) styleParts.push(`motion: ${p.style.motion}`)
  if (p.style?.framing) styleParts.push(`framing: ${p.style.framing}`)
  if (p.style?.lighting) styleParts.push(`lighting: ${p.style.lighting}`)
  const brief = [
    p.description ? `# ${p.description}` : '',
    styleParts.length ? `## Style: ${styleParts.join('; ')}` : '',
  ].filter(Boolean).join('\n')

  return { brief, keywords, description: p.description || '' }
}

// Helper: find placements with keywords but no GPU results for a variant
async function _getPendingGpuPlacements(planPipelineId) {
  // Load plan placements
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)
  const chapterRuns = planRuns.filter(r => {
    try { return JSON.parse(r.metadata_json || '{}').isSubRun && JSON.parse(r.metadata_json || '{}').stageName === 'Per-chapter B-Roll plan' }
    catch { return false }
  }).sort((a, b) => (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0))

  const allPlacements = []
  for (let chIdx = 0; chIdx < chapterRuns.length; chIdx++) {
    try {
      const parsed = extractJSON(chapterRuns[chIdx].output_text || '')
      const items = parsed.placements || parsed
      if (!Array.isArray(items)) continue
      const brollOnly = items.filter(p => !p.category || p.category === 'broll')
      for (let pIdx = 0; pIdx < brollOnly.length; pIdx++) {
        allPlacements.push({ pid: planPipelineId, chapterIndex: chIdx, placementIndex: pIdx })
      }
    } catch {}
  }

  // Find which already have GPU results (legacy broll_runs)
  const searchRuns = await db.prepare(
    `SELECT metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete'`
  ).all(`%"pipelineId":"bs-${planPipelineId}-%`)
  const searched = new Set()
  for (const r of searchRuns) {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      if (m.isSubRun) searched.add(`${m.chapterIndex}:${m.placementIndex}`)
    } catch {}
  }

  // Also exclude placements already in broll_searches queue
  const queuedRows = await db.prepare(
    `SELECT chapter_index, placement_index FROM broll_searches WHERE plan_pipeline_id = ? AND status IN ('waiting', 'running', 'complete')`
  ).all(planPipelineId)
  for (const row of queuedRows) {
    searched.add(`${row.chapter_index}:${row.placement_index}`)
  }

  return allPlacements.filter(p => !searched.has(`${p.chapterIndex}:${p.placementIndex}`))
}

/**
 * Run Plan Prep pipeline: stages 1-5 (transcript, video, A-Roll, chapters, split).
 * This is a convenience wrapper that runs executePipeline with the plan_prep strategy.
 */
export async function executePlanPrep(videoId, groupId, editorCuts = null, pipelineIdOverride = null) {
  // Find the plan_prep strategy and its latest version
  const strategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'plan_prep' ORDER BY id LIMIT 1").get()
  if (!strategy) throw new Error('No plan_prep strategy found. Run the split-plan-strategies migration.')

  const version = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy.id)
  if (!version) throw new Error('No plan_prep strategy version found')

  // Run using the existing pipeline executor
  // Pass groupId=null to prevent standalone analysis expansion (plan_prep doesn't need example videos)
  const result = await executePipeline(
    strategy.id,
    version.id,
    videoId,
    null, // no groupId — prevents example video expansion
    'raw',
    editorCuts,
    null, // no referenceRunId
    null, // no resumeData
    { stopAfterPlan: false, exampleVideoId: null, pipelineIdOverride },
  )

  return {
    prepPipelineId: result.pipelineId,
    stageCount: result.stageCount,
    totalTokensIn: result.totalTokensIn,
    totalTokensOut: result.totalTokensOut,
    totalCost: result.totalCost,
    totalRuntime: result.totalRuntime,
  }
}

// Run per-chapter B-Roll strategy for ONE reference video using completed prep + analysis pipelines
export async function executeCreateStrategy(prepPipelineId, analysisPipelineId, videoId, groupId, pipelineIdOverride) {
  // 1. Load create_strategy strategy and version
  const strategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1").get()
  if (!strategy) throw new Error('No create_strategy strategy found')
  const version = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy.id)
  if (!version) throw new Error('No create_strategy version found')
  const stages = JSON.parse(version.stages_json || '[]')
  if (!stages.length) throw new Error('create_strategy strategy has no stages')

  // 2. Load prep pipeline data from DB
  const prepRuns = await db.prepare(
    `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${prepPipelineId}"%`)
  if (!prepRuns.length) throw new Error('No completed stages found for prep pipeline')

  function findPrepStage(name) {
    return prepRuns.find(r => {
      const m = JSON.parse(r.metadata_json || '{}')
      return !m.isSubRun && m.stageName === name
    })
  }

  const transcriptRun = findPrepStage('Generate post-cut transcript')
  const aRollRun = findPrepStage('Analyze A-Roll Appearances')
  const chaptersRun = findPrepStage('Analyze Chapters & Beats')

  const currentTranscript = transcriptRun?.output_text || ''
  const aRollOutput = aRollRun?.output_text || ''
  const chaptersOutput = chaptersRun?.output_text || ''

  // 3. Rebuild chapterSplits from chapters JSON + transcript
  let chaptersData
  try { chaptersData = JSON.parse(chaptersOutput) } catch { chaptersData = extractJSON(chaptersOutput) }
  const chapters = chaptersData?.chapters || []
  let aRolls = chaptersData?.a_roll_appearances || chaptersData?.a_rolls || []
  if (!aRolls.length && aRollOutput) {
    try {
      const aRollParsed = extractJSON(aRollOutput)
      aRolls = aRollParsed?.a_roll_appearances || aRollParsed?.a_rolls || []
    } catch {}
  }

  const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
  function tcToSec(tc) {
    const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/)
    if (!m) return null
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
  }
  for (const ch of chapters) {
    if (ch.start && !ch.start_seconds) ch.start_seconds = tcToSec(ch.start) ?? 0
    if (ch.end && !ch.end_seconds) ch.end_seconds = tcToSec(ch.end) ?? 0
    for (const b of (ch.beats || [])) {
      if (b.start && !b.start_seconds) b.start_seconds = tcToSec(b.start) ?? 0
      if (b.end && !b.end_seconds) b.end_seconds = tcToSec(b.end) ?? 0
    }
  }
  for (const a of aRolls) {
    if (a.change_at && !a.change_at_seconds) a.change_at_seconds = tcToSec(a.change_at) ?? 0
  }

  const transcriptLines = currentTranscript.split('\n')
  function parseLineTime(line) {
    const m = line.match(/\[(\d{1,2}):(\d{2}):?(\d{2})?(?:\.\d+)?\]/)
    if (!m) return null
    return (parseInt(m[1]) * 3600) + (parseInt(m[2]) * 60) + (parseInt(m[3] || '0'))
  }

  const chapterSplits = chapters.map((ch, idx) => {
    const chTranscriptLines = transcriptLines.filter(line => {
      const t = parseLineTime(line)
      if (t === null) return false
      return t >= ch.start_seconds && t < ch.end_seconds
    })
    const beats = (ch.beats || []).map(b => `  - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)}): ${b.description || ''}${b.purpose ? ' | Purpose: ' + b.purpose : ''}${b.emotion ? ' | Emotion: ' + b.emotion : ''}`).join('\n')
    return {
      chapter_number: idx + 1,
      chapter_name: ch.name || `Chapter ${idx + 1}`,
      chapter_purpose: ch.purpose || ch.description || '',
      chapter_emotion: ch.emotion || '',
      chapter_start: ch.start_seconds,
      chapter_end: ch.end_seconds,
      chapter_start_tc: toTC(ch.start_seconds),
      chapter_end_tc: toTC(ch.end_seconds),
      chapter_duration_seconds: ch.end_seconds - ch.start_seconds,
      beats_formatted: beats,
      beats_raw: ch.beats || [],
      elements: [],
      transcript: chTranscriptLines.join('\n'),
    }
  })

  // Build _allChaptersContext
  const allChaptersSummary = chapters.map((ch, idx) => {
    const beats = (ch.beats || []).map(b => `    - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)})`).join('\n')
    return `### Chapter ${idx + 1}: ${ch.name} (${toTC(ch.start_seconds)}-${toTC(ch.end_seconds)})\nPurpose: ${ch.purpose || ch.description || ''}${ch.emotion ? '\nEmotion: ' + ch.emotion : ''}\nBeats:\n${beats}`
  }).join('\n\n')
  const aRollSummary = aRolls.map(a => {
    const changeAt = a.change_at_seconds != null ? ` — change at ${toTC(a.change_at_seconds)}` : ''
    const note = a.change_note ? ` (${a.change_note})` : ''
    return `A-Roll #${a.id}: ${a.description}${changeAt}${note}`
  }).join('\n')
  chapterSplits._allChaptersContext = `## A-Rolls:\n${aRollSummary}\n\n## Chapters & Beats:\n${allChaptersSummary}`

  // 4. Load reference analysis from analysis pipeline
  const analysisRuns = await db.prepare(
    `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${analysisPipelineId}"%`)

  const assembleRun = analysisRuns.find(r => {
    const m = JSON.parse(r.metadata_json || '{}')
    return !m.isSubRun && (m.stageName === 'Assemble full analysis' || m.stageIndex === analysisRuns.filter(r2 => !JSON.parse(r2.metadata_json || '{}').isSubRun).length - 1)
  })
  const referenceAnalysis = assembleRun?.output_text || ''
  if (!referenceAnalysis) throw new Error('No assembled analysis found for analysis pipeline')

  // Build slim reference analysis: only chapter/beat info + beat strategies + beat frequency
  let slimReferenceAnalysis = referenceAnalysis
  try {
    const refData = JSON.parse(referenceAnalysis)
    const slimChapters = (refData.chapters || []).map(ch => {
      const byBeat = ch.frequency_and_timing?.by_beat || []
      const beatFreqMap = {}
      for (const b of byBeat) {
        beatFreqMap[b.beat_name] = {
          broll_per_minute: b.broll?.per_minute ?? null,
          broll_avg_duration: b.broll?.avg_duration_seconds ?? null,
        }
      }
      return {
        chapter_name: ch.chapter_name,
        chapter_number: ch.chapter_number,
        purpose: ch.purpose,
        duration_seconds: ch.duration_seconds,
        beats: ch.beats,
        beat_strategies: ch.pattern_analysis?.beat_strategies?.map(bs => ({
          ...bs,
          reference_frequency: beatFreqMap[bs.beat_name] || null,
        })) || [],
      }
    })
    slimReferenceAnalysis = JSON.stringify({ chapters: slimChapters }, null, 2)
  } catch {}

  // 5. Set up pipeline state and run stages
  const pipelineId = pipelineIdOverride || `strat-${videoId}-${Date.now()}`
  const pipelineStart = Date.now()
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0

  brollPipelineProgress.set(pipelineId, { strategyId: strategy.id, videoId, groupId, strategyName: strategy.name || 'Create Strategy', startedAt: pipelineStart, stageIndex: 0, totalStages: stages.length, status: 'running', stageName: 'Starting...', phase: 'create_strategy' })

  const pipelineAbort = new AbortController()
  pipelineAbortControllers.set(pipelineId, pipelineAbort)
  const stageOutputs = []
  let llmAnswer = '', questionCount = 0
  const llmAnswers = {}

  function replacePlaceholders(text) {
    let result = text
      .replace(/\{\{transcript\}\}/g, currentTranscript)
      .replace(/\{\{llm_answer\}\}/g, llmAnswer)
      .replace(/\{\{reference_analysis_slim\}\}/g, slimReferenceAnalysis)
      .replace(/\{\{reference_analysis\}\}/g, referenceAnalysis)
    // llm_answer_1 maps to aRollOutput (A-Roll analysis from prep pipeline)
    result = result.replace(/\{\{llm_answer_1\}\}/g, aRollOutput)
    for (const [num, ans] of Object.entries(llmAnswers)) {
      result = result.replace(new RegExp(`\\{\\{llm_answer_${num}\\}\\}`, 'g'), ans)
    }
    stageOutputs.forEach((out, i) => {
      result = result.replace(new RegExp(`\\{\\{stage_${i + 1}_output\\}\\}`, 'g'), out || '')
    })
    return result
  }

  try {
    for (let i = 0; i < stages.length; i++) {
      if (abortedBrollPipelines.has(pipelineId)) break
      const stage = stages[i]
      const stageName = stage.name || `Stage ${i + 1}`
      brollPipelineProgress.set(pipelineId, { strategyId: strategy.id, videoId, groupId, strategyName: strategy.name || 'Create Strategy', startedAt: pipelineStart, stageIndex: i, totalStages: stages.length, status: 'running', stageName, phase: 'create_strategy' })
      console.log(`[broll-pipeline] ${pipelineId} Stage ${i + 1}/${stages.length}: ${stageName}`)

      let output = ''
      let stageTokensIn = 0, stageTokensOut = 0, stageCost = 0
      const stageStart = Date.now()

      if (stage.type === 'transcript_question' && stage.per_chapter) {
        // Per-chapter stage
        const allChaptersCtx = chapterSplits._allChaptersContext || ''
        const CHAPTER_CONCURRENCY = 5
        const chapterResults = new Array(chapterSplits.length).fill(null)
        let completedChapters = 0
        brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), subDone: 0, subTotal: chapterSplits.length, subLabel: '' })

        async function processChapter(c) {
          if (abortedBrollPipelines.has(pipelineId)) return
          const ch = chapterSplits[c]
          let prevChapterOutput = ''
          for (let pi = i - 1; pi >= 0; pi--) {
            const prevStage = stages[pi]
            const isPrevPerChapter = prevStage.type === 'transcript_question' && prevStage.per_chapter
            const isPrevEnrich = prevStage.type === 'programmatic' && (prevStage.action === 'enrich_beat_matches' || prevStage.action === 'enrich_beat_frequency')
            if (isPrevPerChapter || isPrevEnrich) {
              try { prevChapterOutput = JSON.parse(stageOutputs[pi] || '[]')[c] || '' } catch {}
              break
            }
          }

          let chPrompt = replacePlaceholders(stage.prompt || '')
            .replace(/\{\{chapter_number\}\}/g, String(ch.chapter_number))
            .replace(/\{\{total_chapters\}\}/g, String(chapterSplits.length))
            .replace(/\{\{chapter_name\}\}/g, ch.chapter_name)
            .replace(/\{\{chapter_purpose\}\}/g, ch.chapter_purpose)
            .replace(/\{\{chapter_emotion\}\}/g, ch.chapter_emotion || '')
            .replace(/\{\{chapter_start_tc\}\}/g, ch.chapter_start_tc)
            .replace(/\{\{chapter_end_tc\}\}/g, ch.chapter_end_tc)
            .replace(/\{\{chapter_duration_seconds\}\}/g, String(ch.chapter_duration_seconds))
            .replace(/\{\{chapter_beats\}\}/g, ch.beats_formatted)
            .replace(/\{\{chapter_transcript\}\}/g, ch.transcript)
            .replace(/\{\{all_chapters\}\}/g, allChaptersCtx)
            .replace(/\{\{a_rolls\}\}/g, allChaptersCtx.split('## Chapters')[0] || '')
            .replace(/\{\{prev_chapter_output\}\}/g, prevChapterOutput)

          const chSystem = replacePlaceholders(stage.system_instruction || '')

          const { callLLM } = await import('./llm-runner.js')
          const result = await callLLM({
            model: stage.model || 'gemini-3.1-pro-preview',
            systemInstruction: chSystem,
            prompt: chPrompt,
            params: stage.params || { temperature: 0.3 },
            experimentId: null,
            abortSignal: pipelineAbort.signal,
          })

          chapterResults[c] = result.text
          stageTokensIn += result.tokensIn || 0
          stageTokensOut += result.tokensOut || 0
          stageCost += result.cost || 0
          completedChapters++
          brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), subDone: completedChapters, subTotal: chapterSplits.length, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}` })

          // Store sub-run
          await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            strategy.id, videoId, 'analysis', 'complete',
            ch.transcript.slice(0, 500), result.text, chPrompt, chSystem,
            stage.model || 'gemini-3.1-pro-preview',
            result.tokensIn || 0, result.tokensOut || 0, result.cost || 0, 0,
            JSON.stringify({ pipelineId, stageIndex: i, stageName, subIndex: c, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}`, isSubRun: true, phase: 'create_strategy', prepPipelineId, analysisPipelineId }),
          )
        }

        let nextC = 0
        async function runNext() { while (nextC < chapterSplits.length && !abortedBrollPipelines.has(pipelineId)) { const c = nextC++; await processChapter(c) } }
        await Promise.all(Array.from({ length: Math.min(CHAPTER_CONCURRENCY, chapterSplits.length) }, () => runNext()))

        output = JSON.stringify(chapterResults.filter(Boolean))
        questionCount++
        llmAnswer = output
        llmAnswers[questionCount] = output

      } else if (stage.type === 'programmatic' && stage.action === 'enrich_beat_frequency') {
        // Enrich beat_strategies with frequency data from the reference analysis
        const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
        let chapterStrategyResults = []
        try { chapterStrategyResults = JSON.parse(lastPerChapterOutput) } catch {}

        // Parse reference analysis to extract by_beat frequency data per chapter
        let refData
        try { refData = JSON.parse(referenceAnalysis) } catch { refData = extractJSON(referenceAnalysis) }
        const refChapters = refData?.chapters || []

        // Build lookup: { chapterName: { beatName: { per_minute, avg_duration_seconds } } }
        const refBeatFreq = {}
        for (const ch of refChapters) {
          const chName = ch.chapter_name || ''
          refBeatFreq[chName] = {}
          const byBeat = ch.frequency_and_timing?.by_beat || []
          for (const b of byBeat) {
            const broll = b.broll || {}
            refBeatFreq[chName][b.beat_name] = {
              per_minute: broll.per_minute ?? (broll.count != null ? broll.count : null),
              avg_duration_seconds: broll.avg_duration_seconds ?? null,
              gp_per_minute: b.graphic_package?.per_minute ?? null,
              beat_duration_seconds: b.beat_duration_seconds ?? null,
            }
          }
        }

        const enriched = chapterStrategyResults.map(chResult => {
          let parsed
          try { parsed = typeof chResult === 'string' ? extractJSON(chResult) : chResult } catch { return chResult }
          if (!parsed?.beat_strategies) return chResult

          for (const bs of parsed.beat_strategies) {
            const matchedChapter = bs.matched_from_chapter || parsed.matched_reference_chapter?.chapter_name || ''
            const matchedBeat = bs.matched_reference_beat || ''

            // Try exact match first, then fuzzy
            let freq = refBeatFreq[matchedChapter]?.[matchedBeat]
            if (!freq) {
              // Fuzzy: search all chapters for matching beat name
              for (const [, beats] of Object.entries(refBeatFreq)) {
                if (beats[matchedBeat]) { freq = beats[matchedBeat]; break }
              }
            }

            if (freq) {
              bs.reference_frequency = {
                broll_per_minute: freq.per_minute,
                broll_avg_duration_seconds: freq.avg_duration_seconds,
                gp_per_minute: freq.gp_per_minute,
                beat_duration_seconds: freq.beat_duration_seconds,
              }
            }
          }

          return JSON.stringify(parsed, null, 2)
        })

        output = JSON.stringify(enriched)
        llmAnswer = output
        questionCount++
        llmAnswers[questionCount] = output

      } else if (stage.type === 'programmatic' && stage.action === 'assemble_broll_plan') {
        // Assemble strategy output (not expected for create_strategy, but handle gracefully)
        const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
        let llmResults = []
        try { llmResults = JSON.parse(lastPerChapterOutput) } catch {}
        const parsedPlans = llmResults.map(r => { try { return extractJSON(r) } catch { return r } })
        const allChaptersCtx = chapterSplits._allChaptersContext || ''
        const assembledChapters = chapterSplits.map((ch, idx) => ({
          chapter_number: ch.chapter_number, chapter_name: ch.chapter_name,
          time: `${ch.chapter_start_tc} - ${ch.chapter_end_tc}`,
          duration_seconds: ch.chapter_duration_seconds, purpose: ch.chapter_purpose,
          beats: ch.beats_formatted, plan: parsedPlans[idx] || null,
        }))
        output = JSON.stringify({ video_context: allChaptersCtx, total_chapters: assembledChapters.length, chapters: assembledChapters }, null, 2)
      }

      stageOutputs.push(output)
      totalTokensIn += stageTokensIn
      totalTokensOut += stageTokensOut
      totalCost += stageCost
      const stageRuntime = Date.now() - stageStart

      await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        strategy.id, videoId, 'analysis', 'complete',
        '', output, stage.prompt || '', stage.system_instruction || '',
        stage.model || 'programmatic',
        stageTokensIn, stageTokensOut, stageCost, stageRuntime,
        JSON.stringify({ pipelineId, stageIndex: i, totalStages: stages.length, stageName, stageType: stage.type, phase: 'create_strategy', prepPipelineId, analysisPipelineId, groupId }),
      )

      if (stageCost > 0 || stageTokensIn + stageTokensOut > 0) {
        await db.prepare('INSERT INTO spending_log (total_cost, total_tokens, total_runtime_ms, source, created_at) VALUES (?, ?, ?, ?, ?)').run(stageCost, stageTokensIn + stageTokensOut, stageRuntime, `broll create-strategy ${pipelineId} stage ${i}`, new Date().toISOString())
      }
    }

    brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), stageIndex: stages.length, status: 'complete', stageName: 'Done' })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    pipelineAbortControllers.delete(pipelineId)
    console.log(`[broll-pipeline] Create strategy ${pipelineId} complete (${((Date.now() - pipelineStart) / 1000).toFixed(1)}s)`)

  } catch (err) {
    pipelineAbortControllers.delete(pipelineId)
    brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), status: 'failed', error: err.message })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    console.error(`[broll-pipeline] Create strategy ${pipelineId} failed: ${err.message}`)
    notify({ source: 'broll-create-strategy', title: 'Create strategy failed', error: err.message, meta: { pipelineId, videoId } })
    try {
      await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, error_message, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`).run(
        strategy.id, videoId, 'analysis', 'failed', err.message,
        JSON.stringify({ pipelineId, stageIndex: stageOutputs.length, totalStages: stages.length, stageName: 'Pipeline failed', phase: 'create_strategy', prepPipelineId, analysisPipelineId }),
      )
    } catch (dbErr) { console.error(`[broll-pipeline] Failed to write error row:`, dbErr.message) }
    throw err
  }

  // 6. Return
  return {
    strategyPipelineId: pipelineId,
    stageCount: stages.length,
    totalTokensIn,
    totalTokensOut,
    totalCost,
    totalRuntime: Date.now() - pipelineStart,
  }
}

// Run per-chapter B-Roll strategy for MULTIPLE reference videos using completed prep + analysis pipelines
export async function executeCreateCombinedStrategy(prepPipelineId, analysisPipelineIds, videoId, groupId, pipelineIdOverride) {
  // 1. Load create_combined_strategy strategy and version
  const strategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1").get()
  if (!strategy) throw new Error('No create_combined_strategy strategy found')
  const version = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy.id)
  if (!version) throw new Error('No create_combined_strategy version found')
  const stages = JSON.parse(version.stages_json || '[]')
  if (!stages.length) throw new Error('create_combined_strategy strategy has no stages')

  // 2. Load prep pipeline data from DB
  const prepRuns = await db.prepare(
    `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${prepPipelineId}"%`)
  if (!prepRuns.length) throw new Error('No completed stages found for prep pipeline')

  function findPrepStage(name) {
    return prepRuns.find(r => {
      const m = JSON.parse(r.metadata_json || '{}')
      return !m.isSubRun && m.stageName === name
    })
  }

  const transcriptRun = findPrepStage('Generate post-cut transcript')
  const aRollRun = findPrepStage('Analyze A-Roll Appearances')
  const chaptersRun = findPrepStage('Analyze Chapters & Beats')

  const currentTranscript = transcriptRun?.output_text || ''
  const aRollOutput = aRollRun?.output_text || ''
  const chaptersOutput = chaptersRun?.output_text || ''

  // 3. Rebuild chapterSplits from chapters JSON + transcript
  let chaptersData
  try { chaptersData = JSON.parse(chaptersOutput) } catch { chaptersData = extractJSON(chaptersOutput) }
  const chapters = chaptersData?.chapters || []
  let aRolls = chaptersData?.a_roll_appearances || chaptersData?.a_rolls || []
  if (!aRolls.length && aRollOutput) {
    try {
      const aRollParsed = extractJSON(aRollOutput)
      aRolls = aRollParsed?.a_roll_appearances || aRollParsed?.a_rolls || []
    } catch {}
  }

  const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
  function tcToSec(tc) {
    const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/)
    if (!m) return null
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
  }
  for (const ch of chapters) {
    if (ch.start && !ch.start_seconds) ch.start_seconds = tcToSec(ch.start) ?? 0
    if (ch.end && !ch.end_seconds) ch.end_seconds = tcToSec(ch.end) ?? 0
    for (const b of (ch.beats || [])) {
      if (b.start && !b.start_seconds) b.start_seconds = tcToSec(b.start) ?? 0
      if (b.end && !b.end_seconds) b.end_seconds = tcToSec(b.end) ?? 0
    }
  }
  for (const a of aRolls) {
    if (a.change_at && !a.change_at_seconds) a.change_at_seconds = tcToSec(a.change_at) ?? 0
  }

  const transcriptLines = currentTranscript.split('\n')
  function parseLineTime(line) {
    const m = line.match(/\[(\d{1,2}):(\d{2}):?(\d{2})?(?:\.\d+)?\]/)
    if (!m) return null
    return (parseInt(m[1]) * 3600) + (parseInt(m[2]) * 60) + (parseInt(m[3] || '0'))
  }

  const chapterSplits = chapters.map((ch, idx) => {
    const chTranscriptLines = transcriptLines.filter(line => {
      const t = parseLineTime(line)
      if (t === null) return false
      return t >= ch.start_seconds && t < ch.end_seconds
    })
    const beats = (ch.beats || []).map(b => `  - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)}): ${b.description || ''}${b.purpose ? ' | Purpose: ' + b.purpose : ''}${b.emotion ? ' | Emotion: ' + b.emotion : ''}`).join('\n')
    return {
      chapter_number: idx + 1,
      chapter_name: ch.name || `Chapter ${idx + 1}`,
      chapter_purpose: ch.purpose || ch.description || '',
      chapter_emotion: ch.emotion || '',
      chapter_start: ch.start_seconds,
      chapter_end: ch.end_seconds,
      chapter_start_tc: toTC(ch.start_seconds),
      chapter_end_tc: toTC(ch.end_seconds),
      chapter_duration_seconds: ch.end_seconds - ch.start_seconds,
      beats_formatted: beats,
      beats_raw: ch.beats || [],
      elements: [],
      transcript: chTranscriptLines.join('\n'),
    }
  })

  // Build _allChaptersContext
  const allChaptersSummary = chapters.map((ch, idx) => {
    const beats = (ch.beats || []).map(b => `    - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)})`).join('\n')
    return `### Chapter ${idx + 1}: ${ch.name} (${toTC(ch.start_seconds)}-${toTC(ch.end_seconds)})\nPurpose: ${ch.purpose || ch.description || ''}${ch.emotion ? '\nEmotion: ' + ch.emotion : ''}\nBeats:\n${beats}`
  }).join('\n\n')
  const aRollSummary = aRolls.map(a => {
    const changeAt = a.change_at_seconds != null ? ` — change at ${toTC(a.change_at_seconds)}` : ''
    const note = a.change_note ? ` (${a.change_note})` : ''
    return `A-Roll #${a.id}: ${a.description}${changeAt}${note}`
  }).join('\n')
  chapterSplits._allChaptersContext = `## A-Rolls:\n${aRollSummary}\n\n## Chapters & Beats:\n${allChaptersSummary}`

  // 4. Load ALL reference analyses from analysis pipelines
  const allAnalyses = []
  for (const apId of analysisPipelineIds) {
    const analysisRuns = await db.prepare(
      `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
    ).all(`%"pipelineId":"${apId}"%`)

    const assembleRun = analysisRuns.find(r => {
      const m = JSON.parse(r.metadata_json || '{}')
      return !m.isSubRun && (m.stageName === 'Assemble full analysis')
    })

    // Get reference video title from pipeline ID suffix (-ex{videoId}) or metadata
    let label = apId
    const exMatch = apId.match(/-ex(\d+)$/)
    if (exMatch) {
      const refVid = await db.prepare('SELECT title FROM videos WHERE id = ?').get(exMatch[1])
      if (refVid?.title) label = refVid.title
    }
    if (label === apId) {
      const labelRun = analysisRuns.find(r => { const m = JSON.parse(r.metadata_json || '{}'); return m.videoLabel })
      if (labelRun) label = JSON.parse(labelRun.metadata_json).videoLabel || apId
    }

    if (assembleRun?.output_text) {
      allAnalyses.push({ label, analysis: assembleRun.output_text, pipelineId: apId })
    }
  }
  if (!allAnalyses.length) throw new Error('No assembled analyses found for any analysis pipeline')

  // Build concatenated reference analyses text
  const allReferenceAnalyses = allAnalyses.map(a =>
    `\n========== REFERENCE: ${a.label} ==========\n${a.analysis}`
  ).join('\n\n')

  // Build slim version for beat selection (Stage 0): only chapter/beat info + beat strategies + beat frequency
  const slimReferenceAnalyses = allAnalyses.map(a => {
    let refData
    try { refData = JSON.parse(a.analysis) } catch { try { refData = extractJSON(a.analysis) } catch { return `\n========== REFERENCE: ${a.label} ==========\n${a.analysis}` } }

    const slimChapters = (refData.chapters || []).map(ch => {
      const byBeat = ch.frequency_and_timing?.by_beat || []
      const beatFreqMap = {}
      for (const b of byBeat) {
        beatFreqMap[b.beat_name] = {
          broll_per_minute: b.broll?.per_minute ?? null,
          broll_avg_duration: b.broll?.avg_duration_seconds ?? null,
        }
      }

      return {
        chapter_name: ch.chapter_name,
        chapter_number: ch.chapter_number,
        purpose: ch.purpose,
        duration_seconds: ch.duration_seconds,
        beats: ch.beats,
        beat_strategies: ch.pattern_analysis?.beat_strategies?.map(bs => ({
          ...bs,
          reference_frequency: beatFreqMap[bs.beat_name] || null,
        })) || [],
      }
    })

    return `\n========== REFERENCE: ${a.label} ==========\n${JSON.stringify({ chapters: slimChapters }, null, 2)}`
  }).join('\n\n')

  // 5. Set up pipeline state and run stages
  const pipelineId = pipelineIdOverride || `cstrat-${videoId}-${Date.now()}`
  const pipelineStart = Date.now()
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0

  brollPipelineProgress.set(pipelineId, { strategyId: strategy.id, videoId, groupId, strategyName: strategy.name || 'Create Combined Strategy', startedAt: pipelineStart, stageIndex: 0, totalStages: stages.length, status: 'running', stageName: 'Starting...', phase: 'create_combined_strategy' })

  const pipelineAbort = new AbortController()
  pipelineAbortControllers.set(pipelineId, pipelineAbort)
  const stageOutputs = []
  let llmAnswer = '', questionCount = 0
  const llmAnswers = {}

  function replacePlaceholders(text) {
    let result = text
      .replace(/\{\{transcript\}\}/g, currentTranscript)
      .replace(/\{\{llm_answer\}\}/g, llmAnswer)
      .replace(/\{\{all_reference_analyses_slim\}\}/g, slimReferenceAnalyses)
      .replace(/\{\{all_reference_analyses\}\}/g, allReferenceAnalyses)
      .replace(/\{\{reference_analysis\}\}/g, allReferenceAnalyses) // fallback
    // llm_answer_1 maps to aRollOutput (A-Roll analysis from prep pipeline)
    result = result.replace(/\{\{llm_answer_1\}\}/g, aRollOutput)
    for (const [num, ans] of Object.entries(llmAnswers)) {
      result = result.replace(new RegExp(`\\{\\{llm_answer_${num}\\}\\}`, 'g'), ans)
    }
    stageOutputs.forEach((out, i) => {
      result = result.replace(new RegExp(`\\{\\{stage_${i + 1}_output\\}\\}`, 'g'), out || '')
    })
    return result
  }

  try {
    for (let i = 0; i < stages.length; i++) {
      if (abortedBrollPipelines.has(pipelineId)) break
      const stage = stages[i]
      const stageName = stage.name || `Stage ${i + 1}`
      brollPipelineProgress.set(pipelineId, { strategyId: strategy.id, videoId, groupId, strategyName: strategy.name || 'Create Combined Strategy', startedAt: pipelineStart, stageIndex: i, totalStages: stages.length, status: 'running', stageName, phase: 'create_combined_strategy' })
      console.log(`[broll-pipeline] ${pipelineId} Stage ${i + 1}/${stages.length}: ${stageName}`)

      let output = ''
      let stageTokensIn = 0, stageTokensOut = 0, stageCost = 0
      const stageStart = Date.now()

      if (stage.type === 'transcript_question' && stage.per_chapter) {
        // Per-chapter stage
        const allChaptersCtx = chapterSplits._allChaptersContext || ''
        const CHAPTER_CONCURRENCY = 5
        const chapterResults = new Array(chapterSplits.length).fill(null)
        let completedChapters = 0
        brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), subDone: 0, subTotal: chapterSplits.length, subLabel: '' })

        async function processChapter(c) {
          if (abortedBrollPipelines.has(pipelineId)) return
          const ch = chapterSplits[c]
          let prevChapterOutput = ''
          for (let pi = i - 1; pi >= 0; pi--) {
            const prevStage = stages[pi]
            const isPrevPerChapter = prevStage.type === 'transcript_question' && prevStage.per_chapter
            const isPrevEnrich = prevStage.type === 'programmatic' && (prevStage.action === 'enrich_beat_matches' || prevStage.action === 'enrich_beat_frequency')
            if (isPrevPerChapter || isPrevEnrich) {
              try { prevChapterOutput = JSON.parse(stageOutputs[pi] || '[]')[c] || '' } catch {}
              break
            }
          }

          let chPrompt = replacePlaceholders(stage.prompt || '')
            .replace(/\{\{chapter_number\}\}/g, String(ch.chapter_number))
            .replace(/\{\{total_chapters\}\}/g, String(chapterSplits.length))
            .replace(/\{\{chapter_name\}\}/g, ch.chapter_name)
            .replace(/\{\{chapter_purpose\}\}/g, ch.chapter_purpose)
            .replace(/\{\{chapter_emotion\}\}/g, ch.chapter_emotion || '')
            .replace(/\{\{chapter_start_tc\}\}/g, ch.chapter_start_tc)
            .replace(/\{\{chapter_end_tc\}\}/g, ch.chapter_end_tc)
            .replace(/\{\{chapter_duration_seconds\}\}/g, String(ch.chapter_duration_seconds))
            .replace(/\{\{chapter_beats\}\}/g, ch.beats_formatted)
            .replace(/\{\{chapter_transcript\}\}/g, ch.transcript)
            .replace(/\{\{all_chapters\}\}/g, allChaptersCtx)
            .replace(/\{\{a_rolls\}\}/g, allChaptersCtx.split('## Chapters')[0] || '')
            .replace(/\{\{prev_chapter_output\}\}/g, prevChapterOutput)

          const chSystem = replacePlaceholders(stage.system_instruction || '')

          const { callLLM } = await import('./llm-runner.js')
          const result = await callLLM({
            model: stage.model || 'gemini-3.1-pro-preview',
            systemInstruction: chSystem,
            prompt: chPrompt,
            params: stage.params || { temperature: 0.3 },
            experimentId: null,
            abortSignal: pipelineAbort.signal,
          })

          chapterResults[c] = result.text
          stageTokensIn += result.tokensIn || 0
          stageTokensOut += result.tokensOut || 0
          stageCost += result.cost || 0
          completedChapters++
          brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), subDone: completedChapters, subTotal: chapterSplits.length, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}` })

          // Store sub-run
          await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            strategy.id, videoId, 'analysis', 'complete',
            ch.transcript.slice(0, 500), result.text, chPrompt, chSystem,
            stage.model || 'gemini-3.1-pro-preview',
            result.tokensIn || 0, result.tokensOut || 0, result.cost || 0, 0,
            JSON.stringify({ pipelineId, stageIndex: i, stageName, subIndex: c, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}`, isSubRun: true, phase: 'create_combined_strategy', prepPipelineId, analysisPipelineIds }),
          )
        }

        let nextC = 0
        async function runNext() { while (nextC < chapterSplits.length && !abortedBrollPipelines.has(pipelineId)) { const c = nextC++; await processChapter(c) } }
        await Promise.all(Array.from({ length: Math.min(CHAPTER_CONCURRENCY, chapterSplits.length) }, () => runNext()))

        output = JSON.stringify(chapterResults.filter(Boolean))
        questionCount++
        llmAnswer = output
        llmAnswers[questionCount] = output

      } else if (stage.type === 'programmatic' && stage.action === 'enrich_beat_matches') {
        // Enrich Stage 0's beat matches with reference data + new video beat purpose
        const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
        let chapterMatchResults = []
        try { chapterMatchResults = JSON.parse(lastPerChapterOutput) } catch {}

        // Build reference lookup: { videoTitle: { chapterName: { beats: [...], beat_strategies: [...], by_beat: [...] } } }
        const refLookup = {}
        for (const analysis of allAnalyses) {
          let refData
          try { refData = JSON.parse(analysis.analysis) } catch { try { refData = extractJSON(analysis.analysis) } catch { continue } }
          refLookup[analysis.label] = {}
          for (const ch of (refData?.chapters || [])) {
            refLookup[analysis.label][ch.chapter_name || ''] = {
              beats: ch.beats || [],
              beat_strategies: ch.pattern_analysis?.beat_strategies || [],
              by_beat: ch.frequency_and_timing?.by_beat || [],
            }
          }
        }

        const enriched = chapterMatchResults.map((chResult, chIdx) => {
          let parsed
          try { parsed = typeof chResult === 'string' ? extractJSON(chResult) : chResult } catch { return chResult }
          if (!parsed?.beat_matches) return chResult

          const chSplit = chapterSplits[chIdx]

          for (const match of parsed.beat_matches) {
            // Look up new video beat purpose from prep pipeline
            const prepBeat = chSplit?.beats_raw?.find(b => b.name === match.new_video_beat)
            if (prepBeat) {
              match.new_video_beat_purpose = prepBeat.purpose || prepBeat.description || ''
            }

            // Look up matched reference beat data
            const refName = match.matched_reference || ''
            const refChapter = match.matched_reference_chapter || ''
            const refBeatName = match.matched_reference_beat || ''

            // Find the reference (fuzzy match on title)
            let refChapters = refLookup[refName]
            if (!refChapters) {
              // Fuzzy: find reference whose title contains or is contained by the match
              for (const [label, chapters] of Object.entries(refLookup)) {
                if (label.includes(refName) || refName.includes(label)) { refChapters = chapters; break }
              }
            }
            if (!refChapters) continue

            // Find the chapter (fuzzy)
            let chData = refChapters[refChapter]
            if (!chData) {
              for (const [chName, data] of Object.entries(refChapters)) {
                if (chName.includes(refChapter) || refChapter.includes(chName)) { chData = data; break }
              }
            }
            if (!chData) {
              // Search all chapters for the beat
              for (const data of Object.values(refChapters)) {
                const foundBeat = data.beats?.find(b => b.name === refBeatName || b.beat_name === refBeatName)
                if (foundBeat) { chData = data; break }
              }
            }
            if (!chData) continue

            // Find the beat in beats array
            const refBeat = chData.beats?.find(b =>
              b.name === refBeatName || b.beat_name === refBeatName ||
              b.name?.includes(refBeatName) || refBeatName?.includes(b.name)
            )
            if (refBeat) {
              match.reference_beat_description = refBeat.description || ''
              match.reference_beat_purpose = refBeat.purpose || ''
              match.reference_beat_emotion = refBeat.emotion || ''
            }

            // Find strategy_points from beat_strategies
            const refStrategy = chData.beat_strategies?.find(bs =>
              bs.beat_name === refBeatName ||
              bs.beat_name?.includes(refBeatName) || refBeatName?.includes(bs.beat_name)
            )
            if (refStrategy) {
              match.reference_beat_strategy_points = refStrategy.strategy_points || []
              // Use emotion from strategy if beat didn't have it
              if (!match.reference_beat_emotion && refStrategy.beat_emotion) {
                match.reference_beat_emotion = refStrategy.beat_emotion
              }
            }

            // Find frequency from by_beat
            const refFreq = chData.by_beat?.find(b =>
              b.beat_name === refBeatName ||
              b.beat_name?.includes(refBeatName) || refBeatName?.includes(b.beat_name)
            )
            if (refFreq) {
              match.reference_frequency = {
                broll_per_minute: refFreq.broll?.per_minute ?? null,
                broll_avg_duration: refFreq.broll?.avg_duration_seconds ?? null,
              }
            }
          }

          return JSON.stringify(parsed, null, 2)
        })

        output = JSON.stringify(enriched)
        llmAnswer = output
        questionCount++
        llmAnswers[questionCount] = output

      } else if (stage.type === 'programmatic' && stage.action === 'enrich_beat_frequency') {
        // Enrich beat_strategies with frequency data from ALL reference analyses
        const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
        let chapterStrategyResults = []
        try { chapterStrategyResults = JSON.parse(lastPerChapterOutput) } catch {}

        // Build lookup across all references: { referenceName: { chapterName: { beatName: freqData } } }
        const refBeatFreq = {}
        for (const analysis of allAnalyses) {
          let refData
          try { refData = JSON.parse(analysis.analysis) } catch { try { refData = extractJSON(analysis.analysis) } catch { continue } }
          refBeatFreq[analysis.label] = {}
          for (const ch of (refData?.chapters || [])) {
            const chName = ch.chapter_name || ''
            refBeatFreq[analysis.label][chName] = {}
            for (const b of (ch.frequency_and_timing?.by_beat || [])) {
              const broll = b.broll || {}
              refBeatFreq[analysis.label][chName][b.beat_name] = {
                per_minute: broll.per_minute ?? null,
                avg_duration_seconds: broll.avg_duration_seconds ?? null,
                gp_per_minute: b.graphic_package?.per_minute ?? null,
                beat_duration_seconds: b.beat_duration_seconds ?? null,
              }
            }
          }
        }

        const enriched = chapterStrategyResults.map(chResult => {
          let parsed
          try { parsed = typeof chResult === 'string' ? extractJSON(chResult) : chResult } catch { return chResult }
          if (!parsed?.beat_strategies) return chResult

          for (const bs of parsed.beat_strategies) {
            // For combined strategy, selected_from is "ReferenceName / BeatName"
            const selectedFrom = bs.selected_from || ''
            const matchedBeat = bs.matched_reference_beat || ''
            const matchedChapter = bs.matched_from_chapter || ''

            let freq = null
            // Try selected_from parsing (combined strategy format)
            if (selectedFrom && selectedFrom.includes(' / ')) {
              const refName = selectedFrom.split(' / ')[0].trim()
              const beatName = selectedFrom.split(' / ').slice(1).join(' / ').trim()
              // Search for this reference
              for (const [label, chapters] of Object.entries(refBeatFreq)) {
                if (label.includes(refName) || refName.includes(label)) {
                  for (const [, beats] of Object.entries(chapters)) {
                    if (beats[beatName]) { freq = beats[beatName]; break }
                  }
                  if (freq) break
                }
              }
            }
            // Try matched_from_chapter + matched_reference_beat (single reference format)
            if (!freq && matchedChapter && matchedBeat) {
              for (const [, chapters] of Object.entries(refBeatFreq)) {
                if (chapters[matchedChapter]?.[matchedBeat]) { freq = chapters[matchedChapter][matchedBeat]; break }
              }
            }
            // Fuzzy: search all references/chapters for beat name
            if (!freq && matchedBeat) {
              for (const [, chapters] of Object.entries(refBeatFreq)) {
                for (const [, beats] of Object.entries(chapters)) {
                  if (beats[matchedBeat]) { freq = beats[matchedBeat]; break }
                }
                if (freq) break
              }
            }

            if (freq) {
              bs.reference_frequency = {
                broll_per_minute: freq.per_minute,
                broll_avg_duration_seconds: freq.avg_duration_seconds,
                gp_per_minute: freq.gp_per_minute,
                beat_duration_seconds: freq.beat_duration_seconds,
              }
            }
          }

          return JSON.stringify(parsed, null, 2)
        })

        output = JSON.stringify(enriched)
        llmAnswer = output
        questionCount++
        llmAnswers[questionCount] = output

      } else if (stage.type === 'programmatic' && stage.action === 'assemble_broll_plan') {
        // Assemble strategy output
        const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
        let llmResults = []
        try { llmResults = JSON.parse(lastPerChapterOutput) } catch {}
        const parsedPlans = llmResults.map(r => { try { return extractJSON(r) } catch { return r } })
        const allChaptersCtx = chapterSplits._allChaptersContext || ''
        const assembledChapters = chapterSplits.map((ch, idx) => ({
          chapter_number: ch.chapter_number, chapter_name: ch.chapter_name,
          time: `${ch.chapter_start_tc} - ${ch.chapter_end_tc}`,
          duration_seconds: ch.chapter_duration_seconds, purpose: ch.chapter_purpose,
          beats: ch.beats_formatted, plan: parsedPlans[idx] || null,
        }))
        output = JSON.stringify({ video_context: allChaptersCtx, total_chapters: assembledChapters.length, chapters: assembledChapters }, null, 2)
      }

      stageOutputs.push(output)
      totalTokensIn += stageTokensIn
      totalTokensOut += stageTokensOut
      totalCost += stageCost
      const stageRuntime = Date.now() - stageStart

      await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        strategy.id, videoId, 'analysis', 'complete',
        '', output, stage.prompt || '', stage.system_instruction || '',
        stage.model || 'programmatic',
        stageTokensIn, stageTokensOut, stageCost, stageRuntime,
        JSON.stringify({ pipelineId, stageIndex: i, totalStages: stages.length, stageName, stageType: stage.type, phase: 'create_combined_strategy', prepPipelineId, analysisPipelineIds, groupId }),
      )

      if (stageCost > 0 || stageTokensIn + stageTokensOut > 0) {
        await db.prepare('INSERT INTO spending_log (total_cost, total_tokens, total_runtime_ms, source, created_at) VALUES (?, ?, ?, ?, ?)').run(stageCost, stageTokensIn + stageTokensOut, stageRuntime, `broll create-combined-strategy ${pipelineId} stage ${i}`, new Date().toISOString())
      }
    }

    brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), stageIndex: stages.length, status: 'complete', stageName: 'Done' })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    pipelineAbortControllers.delete(pipelineId)
    console.log(`[broll-pipeline] Create combined strategy ${pipelineId} complete (${((Date.now() - pipelineStart) / 1000).toFixed(1)}s)`)

  } catch (err) {
    pipelineAbortControllers.delete(pipelineId)
    brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), status: 'failed', error: err.message })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    console.error(`[broll-pipeline] Create combined strategy ${pipelineId} failed: ${err.message}`)
    notify({ source: 'broll-create-combined-strategy', title: 'Create combined strategy failed', error: err.message, meta: { pipelineId, videoId } })
    // Write a failed pipeline-level row so the UI can show the failure
    try {
      await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, error_message, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`).run(
        strategy.id, videoId, 'analysis', 'failed', err.message,
        JSON.stringify({ pipelineId, stageIndex: stageOutputs.length, totalStages: stages.length, stageName: 'Pipeline failed', phase: 'create_combined_strategy', prepPipelineId, analysisPipelineIds, groupId }),
      )
    } catch (dbErr) { console.error(`[broll-pipeline] Failed to write error row:`, dbErr.message) }
    throw err
  }

  // 6. Return
  return {
    strategyPipelineId: pipelineId,
    stageCount: stages.length,
    totalTokensIn,
    totalTokensOut,
    totalCost,
    totalRuntime: Date.now() - pipelineStart,
  }
}

export async function executeCreatePlan(prepPipelineId, strategyPipelineId, videoId, groupId) {
  // 1. Load create_plan strategy and version
  const strategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'create_plan' ORDER BY id LIMIT 1").get()
  if (!strategy) throw new Error('No create_plan strategy found')
  const version = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy.id)
  if (!version) throw new Error('No create_plan version found')
  const stages = JSON.parse(version.stages_json || '[]')
  if (!stages.length) throw new Error('create_plan strategy has no stages')

  // 2. Load prep pipeline data from DB
  const prepRuns = await db.prepare(
    `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${prepPipelineId}"%`)
  if (!prepRuns.length) throw new Error('No completed stages found for prep pipeline')

  function findPrepStage(name) {
    return prepRuns.find(r => {
      const m = JSON.parse(r.metadata_json || '{}')
      return !m.isSubRun && m.stageName === name
    })
  }

  const transcriptRun = findPrepStage('Generate post-cut transcript')
  const aRollRun = findPrepStage('Analyze A-Roll Appearances')
  const chaptersRun = findPrepStage('Analyze Chapters & Beats')

  const currentTranscript = transcriptRun?.output_text || ''
  const aRollOutput = aRollRun?.output_text || ''
  const chaptersOutput = chaptersRun?.output_text || ''

  // 3. Rebuild chapterSplits from chapters JSON + transcript
  let chaptersData
  try { chaptersData = JSON.parse(chaptersOutput) } catch { chaptersData = extractJSON(chaptersOutput) }
  const chapters = chaptersData?.chapters || []
  let aRolls = chaptersData?.a_roll_appearances || chaptersData?.a_rolls || []
  if (!aRolls.length && aRollOutput) {
    try {
      const aRollParsed = extractJSON(aRollOutput)
      aRolls = aRollParsed?.a_roll_appearances || aRollParsed?.a_rolls || []
    } catch {}
  }

  const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
  function tcToSec(tc) {
    const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/)
    if (!m) return null
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
  }
  for (const ch of chapters) {
    if (ch.start && !ch.start_seconds) ch.start_seconds = tcToSec(ch.start) ?? 0
    if (ch.end && !ch.end_seconds) ch.end_seconds = tcToSec(ch.end) ?? 0
    for (const b of (ch.beats || [])) {
      if (b.start && !b.start_seconds) b.start_seconds = tcToSec(b.start) ?? 0
      if (b.end && !b.end_seconds) b.end_seconds = tcToSec(b.end) ?? 0
    }
  }
  for (const a of aRolls) {
    if (a.change_at && !a.change_at_seconds) a.change_at_seconds = tcToSec(a.change_at) ?? 0
  }

  const transcriptLines = currentTranscript.split('\n')
  function parseLineTime(line) {
    const m = line.match(/\[(\d{1,2}):(\d{2}):?(\d{2})?(?:\.\d+)?\]/)
    if (!m) return null
    return (parseInt(m[1]) * 3600) + (parseInt(m[2]) * 60) + (parseInt(m[3] || '0'))
  }

  const chapterSplits = chapters.map((ch, idx) => {
    const chTranscriptLines = transcriptLines.filter(line => {
      const t = parseLineTime(line)
      if (t === null) return false
      return t >= ch.start_seconds && t < ch.end_seconds
    })
    const beats = (ch.beats || []).map(b => `  - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)}): ${b.description || ''}${b.purpose ? ' | Purpose: ' + b.purpose : ''}${b.emotion ? ' | Emotion: ' + b.emotion : ''}`).join('\n')
    return {
      chapter_number: idx + 1,
      chapter_name: ch.name || `Chapter ${idx + 1}`,
      chapter_purpose: ch.purpose || ch.description || '',
      chapter_emotion: ch.emotion || '',
      chapter_start: ch.start_seconds,
      chapter_end: ch.end_seconds,
      chapter_start_tc: toTC(ch.start_seconds),
      chapter_end_tc: toTC(ch.end_seconds),
      chapter_duration_seconds: ch.end_seconds - ch.start_seconds,
      beats_formatted: beats,
      beats_raw: ch.beats || [],
      elements: [],
      transcript: chTranscriptLines.join('\n'),
    }
  })

  // Build _allChaptersContext
  const allChaptersSummary = chapters.map((ch, idx) => {
    const beats = (ch.beats || []).map(b => {
      const desc = b.description ? `: ${b.description}` : ''
      const purpose = b.purpose ? ` | Purpose: ${b.purpose}` : ''
      return `    - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)})${desc}${purpose}`
    }).join('\n')
    return `### Chapter ${idx + 1}: ${ch.name} (${toTC(ch.start_seconds)}-${toTC(ch.end_seconds)})\nPurpose: ${ch.purpose || ch.description || ''}${ch.emotion ? '\nEmotion: ' + ch.emotion : ''}\nBeats:\n${beats}`
  }).join('\n\n')
  const aRollSummary = aRolls.map(a => {
    const changeAt = a.change_at_seconds != null ? ` — change at ${toTC(a.change_at_seconds)}` : ''
    const note = a.change_note ? ` (${a.change_note})` : ''
    return `A-Roll #${a.id}: ${a.description}${changeAt}${note}`
  }).join('\n')
  chapterSplits._allChaptersContext = `## A-Rolls:\n${aRollSummary}\n\n## Chapters & Beats:\n${allChaptersSummary}`

  // 4. Load strategy output from strategy pipeline
  const stratRuns = await db.prepare(
    `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${strategyPipelineId}"%`)

  // Load from sub-runs of the LAST stage (these contain user edits)
  const allSubRuns = stratRuns.filter(r => { try { return JSON.parse(r.metadata_json || '{}').isSubRun } catch { return false } })
  const maxStageIndex = allSubRuns.reduce((max, r) => {
    try { return Math.max(max, JSON.parse(r.metadata_json || '{}').stageIndex ?? 0) } catch { return max }
  }, -1)
  const stratSubRuns = allSubRuns
    .filter(r => { try { return (JSON.parse(r.metadata_json || '{}').stageIndex ?? 0) === maxStageIndex } catch { return false } })
    .sort((a, b) => {
      const ma = JSON.parse(a.metadata_json || '{}')
      const mb = JSON.parse(b.metadata_json || '{}')
      return (ma.subIndex || 0) - (mb.subIndex || 0)
    })

  let strategyPerChapter
  if (stratSubRuns.length) {
    strategyPerChapter = stratSubRuns.map(r => {
      try {
        const parsed = extractJSON(r.output_text)
        if (parsed?.beat_strategies) return JSON.stringify({ beat_strategies: parsed.beat_strategies }, null, 2)
      } catch {}
      return r.output_text || ''
    })
    console.log(`[broll-pipeline] Plan: using sub-runs from stage ${maxStageIndex} (${strategyPerChapter.length} chapters, includes user edits)`)
  } else {
    // Fallback: try enriched parent run
    const enrichedRun = stratRuns.find(r => {
      const m = JSON.parse(r.metadata_json || '{}')
      return !m.isSubRun && m.stageName?.includes('Enrich')
    })
    if (enrichedRun?.output_text) {
      let enrichedChapters = []
      try { enrichedChapters = JSON.parse(enrichedRun.output_text) } catch {}
      strategyPerChapter = enrichedChapters.map(chResult => {
        let parsed
        try { parsed = typeof chResult === 'string' ? extractJSON(chResult) : chResult } catch { return chResult }
        if (!parsed?.beat_strategies) return typeof chResult === 'string' ? chResult : JSON.stringify(chResult, null, 2)
        return JSON.stringify({ beat_strategies: parsed.beat_strategies }, null, 2)
      })
      console.log(`[broll-pipeline] Plan: using enriched parent (${strategyPerChapter.length} chapters, no user edits)`)
    } else {
      strategyPerChapter = []
      console.log(`[broll-pipeline] Plan: no strategy data found for ${strategyPipelineId}`)
    }
  }

  // 5. Set up pipeline state and run stages
  const pipelineId = `plan-${videoId}-${Date.now()}`
  const pipelineStart = Date.now()
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0

  brollPipelineProgress.set(pipelineId, { strategyId: strategy.id, videoId, groupId, strategyName: strategy.name || 'Create Plan', startedAt: pipelineStart, stageIndex: 0, totalStages: stages.length, status: 'running', stageName: 'Starting...', phase: 'create_plan' })

  const pipelineAbort = new AbortController()
  pipelineAbortControllers.set(pipelineId, pipelineAbort)
  const stageOutputs = []
  let llmAnswer = '', questionCount = 0
  const llmAnswers = {}

  function replacePlaceholders(text) {
    let result = text
      .replace(/\{\{transcript\}\}/g, currentTranscript)
      .replace(/\{\{llm_answer\}\}/g, llmAnswer)
    // llm_answer_1 maps to aRollOutput (A-Roll analysis from prep pipeline)
    result = result.replace(/\{\{llm_answer_1\}\}/g, aRollOutput)
    for (const [num, ans] of Object.entries(llmAnswers)) {
      result = result.replace(new RegExp(`\\{\\{llm_answer_${num}\\}\\}`, 'g'), ans)
    }
    stageOutputs.forEach((out, i) => {
      result = result.replace(new RegExp(`\\{\\{stage_${i + 1}_output\\}\\}`, 'g'), out || '')
    })
    return result
  }

  try {
    for (let i = 0; i < stages.length; i++) {
      if (abortedBrollPipelines.has(pipelineId)) break
      const stage = stages[i]
      const stageName = stage.name || `Stage ${i + 1}`
      brollPipelineProgress.set(pipelineId, { strategyId: strategy.id, videoId, groupId, strategyName: strategy.name || 'Create Plan', startedAt: pipelineStart, stageIndex: i, totalStages: stages.length, status: 'running', stageName, phase: 'create_plan' })
      console.log(`[broll-pipeline] ${pipelineId} Stage ${i + 1}/${stages.length}: ${stageName}`)

      let output = ''
      let stageTokensIn = 0, stageTokensOut = 0, stageCost = 0
      const stageStart = Date.now()

      if (stage.type === 'transcript_question' && stage.per_chapter) {
        // Per-chapter B-Roll plan stage
        const allChaptersCtx = chapterSplits._allChaptersContext || ''
        const CHAPTER_CONCURRENCY = 5
        const chapterResults = new Array(chapterSplits.length).fill(null)
        let completedChapters = 0
        brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), subDone: 0, subTotal: chapterSplits.length, subLabel: '' })

        async function processChapter(c) {
          if (abortedBrollPipelines.has(pipelineId)) return
          const ch = chapterSplits[c]
          // {{prev_chapter_output}} resolves to the strategy output for this chapter
          let prevChapterOutput = strategyPerChapter[c] || ''
          // Also check for previous per_chapter or enrichment stages within this pipeline
          for (let pi = i - 1; pi >= 0; pi--) {
            const prevStage = stages[pi]
            const isPrevPerChapter = prevStage.type === 'transcript_question' && prevStage.per_chapter
            const isPrevEnrich = prevStage.type === 'programmatic' && (prevStage.action === 'enrich_beat_matches' || prevStage.action === 'enrich_beat_frequency')
            if (isPrevPerChapter || isPrevEnrich) {
              try { prevChapterOutput = JSON.parse(stageOutputs[pi] || '[]')[c] || '' } catch {}
              break
            }
          }

          let chPrompt = replacePlaceholders(stage.prompt || '')
            .replace(/\{\{chapter_number\}\}/g, String(ch.chapter_number))
            .replace(/\{\{total_chapters\}\}/g, String(chapterSplits.length))
            .replace(/\{\{chapter_name\}\}/g, ch.chapter_name)
            .replace(/\{\{chapter_purpose\}\}/g, ch.chapter_purpose)
            .replace(/\{\{chapter_emotion\}\}/g, ch.chapter_emotion || '')
            .replace(/\{\{chapter_start_tc\}\}/g, ch.chapter_start_tc)
            .replace(/\{\{chapter_end_tc\}\}/g, ch.chapter_end_tc)
            .replace(/\{\{chapter_duration_seconds\}\}/g, String(ch.chapter_duration_seconds))
            .replace(/\{\{chapter_beats\}\}/g, ch.beats_formatted)
            .replace(/\{\{chapter_transcript\}\}/g, ch.transcript)
            .replace(/\{\{all_chapters\}\}/g, allChaptersCtx)
            .replace(/\{\{a_rolls\}\}/g, allChaptersCtx.split('## Chapters')[0] || '')
            .replace(/\{\{prev_chapter_output\}\}/g, prevChapterOutput)

          const chSystem = replacePlaceholders(stage.system_instruction || '')

          const { callLLM } = await import('./llm-runner.js')
          const result = await callLLM({
            model: stage.model || 'gemini-3.1-pro-preview',
            systemInstruction: chSystem,
            prompt: chPrompt,
            params: stage.params || { temperature: 0.3 },
            experimentId: null,
            abortSignal: pipelineAbort.signal,
          })

          chapterResults[c] = result.text
          stageTokensIn += result.tokensIn || 0
          stageTokensOut += result.tokensOut || 0
          stageCost += result.cost || 0
          completedChapters++
          brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), subDone: completedChapters, subTotal: chapterSplits.length, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}` })

          // Store sub-run — stageName MUST be 'Per-chapter B-Roll plan' for downstream consumers
          await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            strategy.id, videoId, 'analysis', 'complete',
            ch.transcript.slice(0, 500), result.text, chPrompt, chSystem,
            stage.model || 'gemini-3.1-pro-preview',
            result.tokensIn || 0, result.tokensOut || 0, result.cost || 0, 0,
            JSON.stringify({ pipelineId, stageIndex: i, stageName: 'Per-chapter B-Roll plan', subIndex: c, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}`, isSubRun: true, phase: 'create_plan', prepPipelineId, strategyPipelineId }),
          )
        }

        let nextC = 0
        async function runNext() { while (nextC < chapterSplits.length && !abortedBrollPipelines.has(pipelineId)) { const c = nextC++; await processChapter(c) } }
        await Promise.all(Array.from({ length: Math.min(CHAPTER_CONCURRENCY, chapterSplits.length) }, () => runNext()))

        output = JSON.stringify(chapterResults.filter(Boolean))
        questionCount++
        llmAnswer = output
        llmAnswers[questionCount] = output

      } else if (stage.type === 'programmatic' && stage.action === 'assemble_broll_plan') {
        // Assemble full plan from per-chapter results + strategy data
        const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
        let llmResults = []
        try { llmResults = JSON.parse(lastPerChapterOutput) } catch {}
        const parsedPlans = llmResults.map(r => { try { return extractJSON(r) } catch { return r } })

        // Also parse strategies for inclusion
        const parsedStrategies = strategyPerChapter.map(r => { try { return extractJSON(r) } catch { return r } })

        const allChaptersCtx = chapterSplits._allChaptersContext || ''
        const assembledChapters = chapterSplits.map((ch, idx) => ({
          chapter_number: ch.chapter_number, chapter_name: ch.chapter_name,
          time: `${ch.chapter_start_tc} - ${ch.chapter_end_tc}`,
          duration_seconds: ch.chapter_duration_seconds, purpose: ch.chapter_purpose,
          beats: ch.beats_formatted,
          strategy: parsedStrategies[idx] || null,
          plan: parsedPlans[idx] || null,
        }))
        output = JSON.stringify({ video_context: allChaptersCtx, total_chapters: assembledChapters.length, chapters: assembledChapters }, null, 2)
      }

      stageOutputs.push(output)
      totalTokensIn += stageTokensIn
      totalTokensOut += stageTokensOut
      totalCost += stageCost
      const stageRuntime = Date.now() - stageStart

      await db.prepare(`INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        strategy.id, videoId, 'analysis', 'complete',
        '', output, stage.prompt || '', stage.system_instruction || '',
        stage.model || 'programmatic',
        stageTokensIn, stageTokensOut, stageCost, stageRuntime,
        JSON.stringify({ pipelineId, stageIndex: i, totalStages: stages.length, stageName, stageType: stage.type, phase: 'create_plan', prepPipelineId, strategyPipelineId, groupId }),
      )

      if (stageCost > 0 || stageTokensIn + stageTokensOut > 0) {
        await db.prepare('INSERT INTO spending_log (total_cost, total_tokens, total_runtime_ms, source, created_at) VALUES (?, ?, ?, ?, ?)').run(stageCost, stageTokensIn + stageTokensOut, stageRuntime, `broll create-plan ${pipelineId} stage ${i}`, new Date().toISOString())
      }
    }

    brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), stageIndex: stages.length, status: 'complete', stageName: 'Done' })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    pipelineAbortControllers.delete(pipelineId)
    console.log(`[broll-pipeline] Create plan ${pipelineId} complete (${((Date.now() - pipelineStart) / 1000).toFixed(1)}s)`)

  } catch (err) {
    pipelineAbortControllers.delete(pipelineId)
    brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), status: 'failed', error: err.message })
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)
    console.error(`[broll-pipeline] Create plan ${pipelineId} failed: ${err.message}`)
    throw err
  }

  // 6. Return
  return {
    planPipelineId: pipelineId,
    stageCount: stages.length,
    totalTokensIn,
    totalTokensOut,
    totalCost,
    totalRuntime: Date.now() - pipelineStart,
  }
}

export async function executePipeline(strategyId, versionId, videoId, groupId, transcriptSource = 'raw', editorCuts = null, referenceRunId = null, resumeData = null, { stopAfterPlan = false, stopAfterStrategy = false, exampleVideoId = null, pipelineIdOverride = null } = {}) {
  const strategy = await getStrategy(strategyId)
  if (!strategy) throw new Error('Strategy not found')

  const version = await db.prepare('SELECT * FROM broll_strategy_versions WHERE id = ?').get(versionId)
  if (!version) throw new Error('Strategy version not found')

  let planStages = JSON.parse(version.stages_json || '[]')
  if (!planStages.length) throw new Error('No stages defined in this version')

  // Pre-load example videos early (needed for chaining logic)
  let exampleVideos = []
  if (groupId) {
    exampleVideos = await loadExampleVideos(groupId)
    // Filter to a single example video if requested (for parallel per-video runs)
    if (exampleVideoId) {
      exampleVideos = exampleVideos.filter(v => v.id === exampleVideoId)
    }
    if (exampleVideos.length) console.log(`[broll-pipeline] Loaded ${exampleVideos.length} example videos for group ${groupId}${exampleVideoId ? ` (filtered to video ${exampleVideoId})` : ''}`)
  }

  // Require reference videos for plan strategies
  if (strategy.main_strategy_id && !referenceRunId && !exampleVideos.length) {
    throw new Error('No reference videos found. Add reference videos before generating a B-Roll plan.')
  }

  // ── Build combined stages: analysis×N + plan + alt_plan×(N-1) ──
  let stages = planStages
  let analysisStageCount = 0
  const analysisPhases = [] // [{videoId, videoTitle, startIdx, endIdx}]
  let planPhaseStartIdx = 0
  const altPlanPhases = [] // [{videoId, videoTitle, startIdx, endIdx}]
  let favoriteVideo = exampleVideos.find(v => v.isFavorite) || exampleVideos[0] || null
  let altVideos = exampleVideos.filter(v => v !== favoriteVideo)

  // Skip analysis expansion if resuming a pipeline that was originally run without analysis
  if (strategy.main_strategy_id && !referenceRunId && !resumeData?.skipAnalysis) {
    const analysisStrategy = await getStrategy(strategy.main_strategy_id)
    const analysisVersion = analysisStrategy ? await db.prepare(`
      SELECT * FROM broll_strategy_versions
      WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(strategy.main_strategy_id) : null
    const analysisStagesTemplate = analysisVersion ? JSON.parse(analysisVersion.stages_json || '[]') : []

    // Load alt plan strategy stages
    let altPlanStagesTemplate = []
    const altPlanStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'alt_plan' ORDER BY id LIMIT 1").get()
    if (altPlanStrategy) {
      const altVer = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(altPlanStrategy.id)
      if (altVer) altPlanStagesTemplate = JSON.parse(altVer.stages_json || '[]')
    }

    if (analysisStagesTemplate.length && exampleVideos.length) {
      const combined = []

      // Phase 1: Analysis per example video
      for (const vid of exampleVideos) {
        const label = vid.title || `Video #${vid.id}`
        const isFav = vid === favoriteVideo
        const startIdx = combined.length
        for (const s of analysisStagesTemplate) {
          const clone = JSON.parse(JSON.stringify(s))
          if (clone.actionParams) {
            for (const key of Object.keys(clone.actionParams)) {
              if (key.endsWith('StageIndex') && typeof clone.actionParams[key] === 'number') {
                clone.actionParams[key] += startIdx
              }
            }
          }
          combined.push({ ...clone, _phase: 'analysis', _videoId: vid.id, _videoLabel: label, _isFavorite: isFav })
        }
        analysisPhases.push({ videoId: vid.id, videoTitle: label, isFavorite: isFav, startIdx, endIdx: combined.length - 1, stageCount: analysisStagesTemplate.length })
      }
      analysisStageCount = combined.length

      // Phase 2: Favorite B-Roll plan
      planPhaseStartIdx = combined.length
      for (const s of planStages) {
        combined.push({ ...JSON.parse(JSON.stringify(s)), _phase: 'plan' })
      }

      // Phase 3: Alt plans per non-favorite video
      if (altPlanStagesTemplate.length) {
        for (const vid of altVideos) {
          const label = vid.title || `Video #${vid.id}`
          const startIdx = combined.length
          for (const s of altPlanStagesTemplate) {
            combined.push({ ...JSON.parse(JSON.stringify(s)), _phase: 'alt_plan', _videoId: vid.id, _videoLabel: label })
          }
          altPlanPhases.push({ videoId: vid.id, videoTitle: label, startIdx, endIdx: combined.length - 1, stageCount: altPlanStagesTemplate.length })
        }
      }

      stages = combined
      console.log(`[broll-pipeline] Combined: ${analysisStageCount} analysis (${exampleVideos.length} videos) + ${planStages.length} plan + ${altPlanPhases.length * altPlanStagesTemplate.length} alt plan stages`)
    }
  }

  // For standalone analysis strategies with multiple example videos: expand stages per video
  if (!strategy.main_strategy_id && exampleVideos.length > 1) {
    const combined = []
    for (const vid of exampleVideos) {
      const label = vid.title || `Video #${vid.id}`
      const isFav = vid === favoriteVideo
      const startIdx = combined.length
      for (const s of planStages) {
        const clone = JSON.parse(JSON.stringify(s))
        // Offset actionParams stage references by startIdx
        if (clone.actionParams) {
          for (const key of Object.keys(clone.actionParams)) {
            if (key.endsWith('StageIndex') && typeof clone.actionParams[key] === 'number') {
              clone.actionParams[key] += startIdx
            }
          }
        }
        combined.push({ ...clone, _phase: 'analysis', _videoId: vid.id, _videoLabel: label, _isFavorite: isFav })
      }
      analysisPhases.push({ videoId: vid.id, videoTitle: label, isFavorite: isFav, startIdx, endIdx: combined.length - 1, stageCount: planStages.length })
    }
    analysisStageCount = combined.length
    stages = combined
    console.log(`[broll-pipeline] Analysis expanded: ${exampleVideos.length} videos × ${planStages.length} stages = ${stages.length} total`)
  }

  // Resolve main video transcript
  const { content: mainTranscript, resolved: resolvedSource } = await resolveTranscript(videoId, transcriptSource)

  // Pre-load main video file if needed
  let mainVideoFilePath = null
  const needsMainVideo = stages.some(s => (s.type === 'video_llm' || s.type === 'video_question') && (s.target || 'main_video') === 'main_video')
  console.log(`[broll-pipeline] needsMainVideo=${needsMainVideo} stages=${stages.length} videoId=${videoId}`)
  if (needsMainVideo) {
    mainVideoFilePath = await getVideoFilePath(videoId)
    console.log(`[broll-pipeline] mainVideoFilePath=${mainVideoFilePath}`)
  }

  // Track per-video analysis outputs
  const analysisOutputs = {} // { [videoId]: assembledJSON }
  const chapterAnalyses = {} // { [videoId]: chaptersJSON } — collected for cross-video reference
  let favoriteOutput = '' // the favorite plan assembled output

  // Load reference analysis — either from a specific run or chain will produce it
  let referenceAnalysis = ''
  if (referenceRunId) {
    referenceAnalysis = await loadRunOutput(referenceRunId) || ''
    if (referenceAnalysis) console.log(`[broll-pipeline] Loaded reference analysis from run ${referenceRunId} (${referenceAnalysis.length} chars)`)

    // Also load chapter analyses from the analysis pipeline's stages for {{all_chapter_analyses}}
    const refRun = await db.prepare('SELECT metadata_json FROM broll_runs WHERE id = ?').get(referenceRunId)
    if (refRun) {
      const refMeta = JSON.parse(refRun.metadata_json || '{}')
      const refPipelineId = refMeta.pipelineId
      if (refPipelineId) {
        // Find all "Analyze Chapters" or stage index 1 outputs per video from the analysis pipeline
        const chapterRuns = await db.prepare(
          `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND metadata_json NOT LIKE '%"isSubRun":true%' AND status = 'complete' ORDER BY id`
        ).all(`%"pipelineId":"${refPipelineId}"%`)
        for (const cr of chapterRuns) {
          const cm = JSON.parse(cr.metadata_json || '{}')
          // Stage that contains chapters — look for chapters in output
          if (cr.output_text && cm.videoLabel) {
            try {
              const parsed = extractJSON(cr.output_text)
              if (parsed.chapters?.length) {
                const vid = cm.videoLabel || `Stage ${cm.stageIndex}`
                chapterAnalyses[vid] = cr.output_text
                console.log(`[broll-pipeline] Loaded chapter analysis for "${vid}" from analysis run`)
              }
            } catch {}
          }
        }
      }
    }
  }
  // If chaining, referenceAnalysis will be set after analysis stages complete

  // Pipeline state
  let currentTranscript = mainTranscript
  let segments = null
  let chapterSplits = null // set by split_by_chapter action
  let timeWindows = null // set by build_time_windows action
  let llmAnswer = ''
  const llmAnswers = {}
  let questionCount = 0
  let examplesOutput = '' // aggregated output from all examples-targeted stages
  const stageOutputs = []
  const pipelineId = pipelineIdOverride || resumeData?.originalPipelineId || `${strategyId}-${videoId}-${Date.now()}${exampleVideoId ? `-ex${exampleVideoId}` : ''}`
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0
  const mainVideo = await db.prepare('SELECT title FROM videos WHERE id = ?').get(videoId)
  const videoTitle = mainVideo?.title || `Video #${videoId}`
  const pipelineMeta = { strategyId, videoId, groupId, strategyName: strategy.name, videoTitle, startedAt: Date.now(), exampleVideoId: exampleVideoId || null }

  if (resumeData) {
    const completedCount = Object.keys(resumeData.completedStages).length
    console.log(`[broll-pipeline] Resuming pipeline ${pipelineId}: ${completedCount}/${stages.length} stages already complete`)
  }

  brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: 0, totalStages: stages.length, status: 'running', stageName: resumeData ? 'Resuming...' : '' })

  function replacePlaceholders(text) {
    // Build all_chapter_analyses from completed videos
    const allChapters = Object.entries(chapterAnalyses).map(([key, json]) => {
      const v = exampleVideos.find(e => e.id === Number(key))
      const label = v?.title || key
      return `=== ${label} ===\n${json}`
    }).join('\n\n')

    let result = text
      .replace(/\{\{transcript\}\}/g, currentTranscript)
      .replace(/\{\{llm_answer\}\}/g, llmAnswer)
      .replace(/\{\{examples_output\}\}/g, examplesOutput)
      .replace(/\{\{reference_analysis\}\}/g, referenceAnalysis)
      .replace(/\{\{favorite_plan\}\}/g, favoriteOutput)
      .replace(/\{\{all_chapter_analyses\}\}/g, allChapters)
    for (const [num, ans] of Object.entries(llmAnswers)) {
      result = result.replace(new RegExp(`\\{\\{llm_answer_${num}\\}\\}`, 'g'), ans)
    }
    stageOutputs.forEach((out, i) => {
      result = result.replace(new RegExp(`\\{\\{stage_${i + 1}_output\\}\\}`, 'g'), out || '')
    })
    return result
  }

  // Helper: run a single LLM call (video or text)
  async function runLLMCall(stage, videoFile, transcriptOverride, progressCtx) {
    const prompt = replacePlaceholders(stage.prompt || '')
    const systemInstruction = replacePlaceholders(stage.system_instruction || '')
    const finalPrompt = transcriptOverride
      ? prompt.replace(/\{\{transcript\}\}/g, transcriptOverride)
      : prompt

    const onProgress = progressCtx ? (subStatus) => {
      brollPipelineProgress.set(pipelineId, { ...brollPipelineProgress.get(pipelineId), subStatus })
    } : undefined

    const result = await callLLM({
      model: stage.model || 'gemini-3-flash-preview',
      systemInstruction,
      prompt: finalPrompt,
      params: stage.params || { temperature: 0.2 },
      experimentId: null,
      videoFile: videoFile || undefined,
      onProgress,
      abortSignal: pipelineAbort.signal,
    })
    result._resolvedPrompt = finalPrompt
    result._resolvedSystem = systemInstruction
    return result
  }

  // Helper: run a stage on examples and aggregate results
  // Returns { text, tokensIn, tokensOut, cost }
  async function runOnExamples(stage, isVideoType, videoList) {
    const vids = videoList || exampleVideos
    if (!vids.length) return { text: '(no example videos available)', tokensIn: 0, tokensOut: 0, cost: 0 }
    const perVideoResults = []
    let sTokensIn = 0, sTokensOut = 0, sCost = 0
    let lastResolved = { prompt: '', system: '' }

    for (let e = 0; e < vids.length; e++) {
      if (abortedBrollPipelines.has(pipelineId)) break
      const ex = vids[e]
      console.log(`[broll-pipeline] Example ${e + 1}/${exampleVideos.length}: ${ex.title || ex.id}`)

      let videoFile = null
      if (isVideoType) {
        videoFile = await getVideoFilePath(ex.id)
      }

      // Get example's transcript for transcript stages
      let exTranscript = null
      if (!isVideoType) {
        const t = await db.prepare("SELECT content FROM transcripts WHERE video_id = ? ORDER BY CASE type WHEN 'raw' THEN 1 WHEN 'human_edited' THEN 2 ELSE 3 END LIMIT 1").get(ex.id)
        exTranscript = t?.content || '(no transcript)'
      }

      const result = await runLLMCall(stage, videoFile, exTranscript, !!videoFile)
      perVideoResults.push(vids.length > 1
        ? `=== Example: ${ex.title || `Video #${ex.id}`} ===\n${result.text}`
        : result.text)
      totalTokensIn += result.tokensIn || 0
      totalTokensOut += result.tokensOut || 0
      totalCost += result.cost || 0
      sTokensIn += result.tokensIn || 0
      sTokensOut += result.tokensOut || 0
      sCost += result.cost || 0
      lastResolved = { prompt: result._resolvedPrompt || '', system: result._resolvedSystem || '' }
    }

    return { text: perVideoResults.join('\n\n'), tokensIn: sTokensIn, tokensOut: sTokensOut, cost: sCost, _resolvedPrompt: lastResolved.prompt, _resolvedSystem: lastResolved.system }
  }

  const pipelineStart = Date.now()
  const pipelineAbort = new AbortController()
  pipelineAbortControllers.set(pipelineId, pipelineAbort)
  const pipelineTempFiles = [] // { bucket, path } — cleaned up after pipeline completes

  // ── Pipeline snapshot for diagnostics ──
  const snapshot = {
    pipelineId,
    startedAt: new Date().toISOString(),
    totalStages: stages.length,
    stageNames: stages.map(s => s.name || 'unnamed'),
    analysisStageCount,
    resume: resumeData ? {
      completedStageIndices: Object.keys(resumeData.completedStages).map(Number),
      completedSubRunCounts: Object.fromEntries(
        Object.entries(resumeData.completedSubRuns || {}).map(([k, v]) => [k, v instanceof Set ? v.size : 0])
      ),
      skipAnalysis: !!resumeData.skipAnalysis,
    } : null,
    lastStage: null,
    outcome: null,
  }
  function saveSnapshot(name) {
    snapshot.lastStage = {
      index: stageOutputs.length - 1,
      name,
      completedCount: stageOutputs.length,
      outputSizes: stageOutputs.map(o => (o || '').length),
      llmAnswerKeys: Object.keys(llmAnswers).map(Number),
      questionCount,
      segments: segments?.length ?? null,
      chapterSplits: chapterSplits?.length ?? null,
      timeWindows: timeWindows?.length ?? null,
      tokens: { in: totalTokensIn, out: totalTokensOut },
      cost: Math.round(totalCost * 10000) / 10000,
      runtimeMs: Date.now() - pipelineStart,
    }
    writePipelineSnapshot(pipelineId, snapshot)
    console.log(`[broll-snapshot] stage ${stageOutputs.length}/${stages.length} "${name}" | cost=$${totalCost.toFixed(4)} | ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s`)
  }
  writePipelineSnapshot(pipelineId, snapshot) // save initial state

  // Helper: store a sub-run (per-window or per-chapter iteration)
  async function storeSubRun({ stageIndex, stageName, subIndex, subLabel, prompt, systemInstruction, input, output, model, tokensIn, tokensOut, cost, runtime, phase }) {
    const result = await db.prepare(`
      INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId, videoId, 'analysis', 'complete',
      input, output, prompt, systemInstruction,
      model || 'gemini-3-flash-preview',
      tokensIn || 0, tokensOut || 0, cost || 0, runtime || 0,
      JSON.stringify({ pipelineId, stageIndex, stageName, subIndex, subLabel, isSubRun: true, phase: phase || '', analysisStageCount }),
    )
    // Verify the insert persisted
    const verify = await db.prepare('SELECT id FROM broll_runs WHERE id = ?').get(result.lastInsertRowid)
    if (!verify) console.error(`[broll-pipeline] SUB-RUN LOST: stage=${stageIndex} sub=${subIndex} id=${result.lastInsertRowid} — inserted but not found!`)
    else console.log(`[broll-pipeline] Stored sub-run: stage=${stageIndex} sub=${subIndex} id=${result.lastInsertRowid}`)
  }

  try {
    for (let i = 0; i < stages.length; i++) {
      // Check for abort — also kill all in-flight fetch requests
      if (abortedBrollPipelines.has(pipelineId)) {
        pipelineAbort.abort()
        snapshot.outcome = { event: 'aborted', at: new Date().toISOString(), atStage: i }
        writePipelineSnapshot(pipelineId, snapshot)
        console.log(`[broll-pipeline] ${pipelineId} Aborted at stage ${i}`)
        brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: i, totalStages: stages.length, status: 'failed', error: 'Aborted by user' })
        setTimeout(() => { brollPipelineProgress.delete(pipelineId); abortedBrollPipelines.delete(pipelineId) }, 300_000)
        return { pipelineId, stageCount: i, stageOutputs, transcriptSource: resolvedSource, totalTokensIn, totalTokensOut, totalCost, totalRuntime: Date.now() - pipelineStart }
      }

      const stage = stages[i]
      const target = stage.target || 'main_video'
      const phase = stage._phase || 'plan'
      const videoLabel = stage._videoLabel || ''
      const stageName = stage.name || `Stage ${i + 1}`
      const phaseLabel = analysisStageCount ? `[${phase}${videoLabel ? ': ' + videoLabel : ''}] ` : ''
      brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: i, totalStages: stages.length, status: 'running', stageName: `${phaseLabel}${stageName}`, phase, videoLabel })
      console.log(`[broll-pipeline] ${pipelineId} Stage ${i + 1}/${stages.length}: ${phaseLabel}${stageName} (${stage.type}, target=${target})`)

      // ── Phase transitions ──
      // After each analysis video's last stage: store assembled output
      for (const ap of analysisPhases) {
        if (i === ap.endIdx + 1) {
          // Just finished this video's analysis
          const assembledIdx = ap.startIdx + ap.stageCount - 1
          analysisOutputs[ap.videoId] = stageOutputs[assembledIdx] || ''
          // Capture chapter analysis (template index 1) for cross-video reference
          const chaptersIdx = ap.startIdx + 1
          if (stageOutputs[chaptersIdx]) {
            chapterAnalyses[ap.videoId] = stageOutputs[chaptersIdx]
            console.log(`[broll-pipeline] Chapters for "${ap.videoTitle}" saved (${stageOutputs[chaptersIdx].length} chars)`)
          }
          console.log(`[broll-pipeline] Analysis for "${ap.videoTitle}" complete (${(analysisOutputs[ap.videoId] || '').length} chars)`)
        }
      }

      // Stop-after-strategy checkpoint (mirror of stopAfterPlan below):
      // strategy-only / guided paths pause the pipeline at the boundary
      // between the analysis phase and the plan phase so the user can
      // review the creative strategy before plan generation continues.
      if (stopAfterStrategy && analysisStageCount && i === planPhaseStartIdx) {
        console.log(`[broll-pipeline] stopAfterStrategy: stopping before plan phase (analysis complete for ${analysisPhases.length} videos)`)
        break
      }

      // When plan phase starts: set referenceAnalysis from favorite video
      if (analysisStageCount && i === planPhaseStartIdx && !referenceAnalysis && favoriteVideo) {
        referenceAnalysis = analysisOutputs[favoriteVideo.id] || ''
        console.log(`[broll-pipeline] Plan phase starting → referenceAnalysis from favorite "${favoriteVideo.title || favoriteVideo.id}" (${referenceAnalysis.length} chars)`)
        chapterSplits = null
        timeWindows = null
      }

      // When an alt plan phase starts: switch referenceAnalysis to that video's analysis
      for (const ap of altPlanPhases) {
        if (i === ap.startIdx) {
          referenceAnalysis = analysisOutputs[ap.videoId] || ''
          // favoriteOutput should already be set from plan phase
          console.log(`[broll-pipeline] Alt plan for "${ap.videoTitle}" → switching referenceAnalysis (${referenceAnalysis.length} chars)`)
          // Keep chapterSplits — chapters are from the main video and stay the same
          // Only switch the reference analysis (different style inspiration)
        }
      }

      // After plan phase's last stage: capture favorite plan output
      if (analysisStageCount && altPlanPhases.length && i === planPhaseStartIdx + planStages.length && !favoriteOutput) {
        favoriteOutput = stageOutputs[planPhaseStartIdx + planStages.length - 1] || ''
        console.log(`[broll-pipeline] Favorite plan complete (${favoriteOutput.length} chars)`)
        // Stop here if alt plans should be triggered separately (Step 3)
        if (stopAfterPlan) {
          console.log(`[broll-pipeline] stopAfterPlan: stopping before alt_plan phase (${altPlanPhases.length} alt videos pending)`)
          break
        }
      }

      // ── Resume: skip already-completed stages ──
      const isResumedStage = resumeData?.completedStages?.[i] != null
      if (isResumedStage && stage.type !== 'programmatic') {
        // LLM stage already completed — restore output and state, skip execution
        const restoredOutput = resumeData.completedStages[i]
        const _isQ = stage.type === 'video_question' || stage.type === 'transcript_question'
        if (_isQ) { questionCount++; llmAnswer = restoredOutput; llmAnswers[questionCount] = restoredOutput }
        if ((stage.target || 'main_video') === 'examples') examplesOutput = restoredOutput
        if (stage.type === 'transcript_llm') currentTranscript = restoredOutput
        stageOutputs.push(restoredOutput)
        console.log(`[broll-pipeline] Resume: restored stage ${i + 1}/${stages.length} (${stageName})`)
        saveSnapshot(stageName)
        continue
      }

      const stageStart = Date.now()
      let output = ''
      let stageTokensIn = 0, stageTokensOut = 0, stageCost = 0
      let resolvedPrompt = '', resolvedSystem = ''
      const isVideoType = stage.type === 'video_llm' || stage.type === 'video_question'
      const isQuestion = stage.type === 'video_question' || stage.type === 'transcript_question'

      // When running per-video analysis (multi-video chaining), narrow examples to just this video
      const effectiveExamples = stage._videoId
        ? exampleVideos.filter(v => v.id === stage._videoId)
        : exampleVideos

      if (target === 'examples' && stage.per_window) {
        // ── Per-window on example videos ──
        if (!timeWindows) throw new Error('per_window stage requires a preceding build_time_windows stage')
        if (!effectiveExamples.length) { output = '(no example videos available)' }
        else {
          const allPerVideoResults = []
          for (let e = 0; e < effectiveExamples.length; e++) {
            const ex = effectiveExamples[e]
            const videoFile = isVideoType ? await getVideoFilePath(ex.id) : null
            const perWindowResults = []

            // Run windows with concurrency pool of 5
            const WINDOW_CONCURRENCY = 5
            const windowResults = new Array(timeWindows.length).fill(null)
            let completedWindows = 0
            brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: i, totalStages: stages.length, status: 'running', stageName: `${phaseLabel}${stageName}`, phase, videoLabel, subDone: 0, subTotal: timeWindows.length, subLabel: '' })

            // Pre-load existing sub-run outputs for this stage (resume recovery)
            const existingSubOutputs = {}
            if (resumeData?.completedSubRuns?.[i]?.size) {
              const subRows = await db.prepare(
                `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND metadata_json LIKE ? AND status = 'complete'`
              ).all(`%"pipelineId":"${pipelineId}"%`, `%"stageIndex":${i},%"isSubRun":true%`)
              for (const sr of subRows) {
                const sm = JSON.parse(sr.metadata_json || '{}')
                if (sm.subIndex != null) existingSubOutputs[sm.subIndex] = sr.output_text || ''
              }
              if (Object.keys(existingSubOutputs).length) console.log(`[broll-pipeline] Resume: loaded ${Object.keys(existingSubOutputs).length}/${timeWindows.length} existing window sub-runs for stage ${i}`)
            }

            async function processWindow(w) {
              if (abortedBrollPipelines.has(pipelineId)) return
              const win = timeWindows[w]

              // Skip if this sub-run already completed (resume)
              if (existingSubOutputs[w] != null) {
                windowResults[w] = existingSubOutputs[w]
                completedWindows++
                console.log(`[broll-pipeline] Resume: skipped window ${w + 1}/${timeWindows.length} (already done)`)
                brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: i, totalStages: stages.length, status: 'running', stageName: `${phaseLabel}${stageName}`, phase, videoLabel, subDone: completedWindows, subTotal: timeWindows.length, subLabel: `Window ${win.start_tc}-${win.end_tc} (cached)` })
                return
              }

              console.log(`[broll-pipeline] Example ${e + 1}/${exampleVideos.length}, Window ${w + 1}/${timeWindows.length}: ${win.start_tc}-${win.end_tc}`)

              const updateSegStatus = (status) => {
                const prog = brollPipelineProgress.get(pipelineId) || {}
                const segmentStatuses = { ...(prog.segmentStatuses || {}) }
                segmentStatuses[w] = status
                brollPipelineProgress.set(pipelineId, { ...prog, segmentStatuses })
              }

              try {
                let winPrompt = replacePlaceholders(stage.prompt || '')
                  .replace(/\{\{window_id\}\}/g, String(win.window_id))
                  .replace(/\{\{window_start\}\}/g, String(win.start_seconds))
                  .replace(/\{\{window_end\}\}/g, String(win.end_seconds))
                  .replace(/\{\{window_start_tc\}\}/g, win.start_tc)
                  .replace(/\{\{window_end_tc\}\}/g, win.end_tc)
                  .replace(/\{\{window_chapter\}\}/g, win.chapter_name)
                  .replace(/\{\{window_beats\}\}/g, win.beats_in_window.join(', '))

                const winSystem = replacePlaceholders(stage.system_instruction || '')

                // Cut video segment for this window (fast, no re-encode)
                let windowVideoFile = videoFile
                if (videoFile) {
                  updateSegStatus(`Cutting segment ${win.start_tc}-${win.end_tc}...`)
                  windowVideoFile = await extractVideoSegment(videoFile, win.start_seconds, win.end_seconds, `broll-seg-${ex.id}-${win.start_seconds}-${win.end_seconds}.mp4`)
                  updateSegStatus('Uploading segment...')
                }

                const result = await callLLM({
                  model: stage.model || 'gemini-3-flash-preview',
                  systemInstruction: winSystem,
                  prompt: winPrompt,
                  params: stage.params || { temperature: 0.2 },
                  experimentId: null,
                  videoFile: windowVideoFile || undefined,
                  onProgress: (status) => updateSegStatus(status),
                  abortSignal: pipelineAbort.signal,
                })

                // Convert relative timestamps to absolute by adding window offset
                let outputText = result.text
                try {
                  const parsed = extractJSON(outputText)
                  if (parsed.elements) {
                    const offset = win.start_seconds
                    const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
                    const parseMmSs = (tc) => {
                      if (!tc) return null
                      const m = String(tc).match(/(\d{1,2}):(\d{2})/)
                      if (!m) return null
                      return parseInt(m[1]) * 60 + parseInt(m[2])
                    }
                    for (const el of parsed.elements) {
                      let startSec = el.start_seconds ?? parseMmSs(el.start)
                      let endSec = el.end_seconds ?? parseMmSs(el.end)
                      if (startSec != null) { el.start_seconds = startSec + offset; el.start_tc = toTC(el.start_seconds) }
                      if (endSec != null) { el.end_seconds = endSec + offset; el.end_tc = toTC(el.end_seconds) }
                      delete el.start; delete el.end
                    }
                    outputText = JSON.stringify(parsed)
                  }
                } catch {}
                windowResults[w] = outputText
                totalTokensIn += result.tokensIn || 0
                totalTokensOut += result.tokensOut || 0
                totalCost += result.cost || 0
                stageTokensIn += result.tokensIn || 0
                stageTokensOut += result.tokensOut || 0
                stageCost += result.cost || 0

                await storeSubRun({
                  stageIndex: i, stageName, subIndex: w,
                  subLabel: `${ex.title || `Video #${ex.id}`} · Window ${win.start_tc}-${win.end_tc}`,
                  prompt: winPrompt, systemInstruction: winSystem,
                  input: `[video: ${ex.title || ex.id}] Window ${win.start_tc}-${win.end_tc}`,
                  output: outputText, model: stage.model,
                  tokensIn: result.tokensIn, tokensOut: result.tokensOut, cost: result.cost,
                  runtime: 0, phase,
                })
              } catch (err) {
                // If user aborted, re-throw to stop the whole pipeline
                if (abortedBrollPipelines.has(pipelineId) || err.name === 'AbortError') throw err
                // Otherwise log and continue — one failed segment shouldn't kill the stage
                console.error(`[broll-pipeline] Window ${w + 1}/${timeWindows.length} FAILED: ${err.message}`)
                updateSegStatus(`FAILED: ${err.message}`)
                windowResults[w] = JSON.stringify({ error: err.message, window: win.start_tc + '-' + win.end_tc })
              }

              completedWindows++

              // Remove from segmentStatuses (complete)
              const prog = brollPipelineProgress.get(pipelineId) || {}
              const segmentStatuses = { ...(prog.segmentStatuses || {}) }
              delete segmentStatuses[w]
              brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: i, totalStages: stages.length, status: 'running', stageName: `${phaseLabel}${stageName}`, phase, videoLabel, subDone: completedWindows, subTotal: timeWindows.length, subLabel: `Window ${win.start_tc}-${win.end_tc}`, segmentStatuses })
            }

            // Pool: keep WINDOW_CONCURRENCY running, start next as each finishes
            let nextW = 0
            async function runNext() {
              while (nextW < timeWindows.length && !abortedBrollPipelines.has(pipelineId)) {
                const w = nextW++
                await processWindow(w)
              }
            }
            await Promise.all(Array.from({ length: Math.min(WINDOW_CONCURRENCY, timeWindows.length) }, () => runNext()))

            perWindowResults.push(...windowResults.filter(Boolean))

            allPerVideoResults.push(effectiveExamples.length > 1
              ? `=== Example: ${ex.title || `Video #${ex.id}`} ===\n${perWindowResults.join('\n')}`
              : perWindowResults.join('\n'))
          }
          output = allPerVideoResults.join('\n\n')
        }
        examplesOutput = output
        if (isQuestion) {
          questionCount++
          llmAnswer = output
          llmAnswers[questionCount] = output
        }

      } else if (target === 'examples') {
        // ── Run on example videos ──
        const exResult = await runOnExamples(stage, isVideoType, effectiveExamples)
        output = exResult.text
        resolvedPrompt = exResult._resolvedPrompt || ''; resolvedSystem = exResult._resolvedSystem || ''
        stageTokensIn += exResult.tokensIn || 0; stageTokensOut += exResult.tokensOut || 0; stageCost += exResult.cost || 0
        examplesOutput = output // update aggregated examples output

        if (isQuestion) {
          questionCount++
          llmAnswer = output
          llmAnswers[questionCount] = output
        }

      } else if (target === 'main_video' && isVideoType) {
        // ── Video stage on main video ──
        if (!mainVideoFilePath) throw new Error('Main video file not available')
        const model = stage.model || 'gemini-3-flash-preview'
        if (!model.startsWith('gemini')) throw new Error(`Video stage requires Gemini model, got "${model}"`)

        const result = await runLLMCall(stage, mainVideoFilePath, null, true)
        output = result.text
        resolvedPrompt = result._resolvedPrompt || ''; resolvedSystem = result._resolvedSystem || ''
        stageTokensIn += result.tokensIn || 0; stageTokensOut += result.tokensOut || 0; stageCost += result.cost || 0
        totalTokensIn += result.tokensIn || 0; totalTokensOut += result.tokensOut || 0; totalCost += result.cost || 0

        if (isQuestion) {
          questionCount++
          llmAnswer = output
          llmAnswers[questionCount] = output
        }

      } else if (stage.type === 'transcript_llm') {
        // ── Transcript full analysis ──
        const result = await runLLMCall(stage, null, null)
        output = result.text
        resolvedPrompt = result._resolvedPrompt || ''; resolvedSystem = result._resolvedSystem || ''
        currentTranscript = output
        stageTokensIn += result.tokensIn || 0; stageTokensOut += result.tokensOut || 0; stageCost += result.cost || 0
        totalTokensIn += result.tokensIn || 0; totalTokensOut += result.tokensOut || 0; totalCost += result.cost || 0

      } else if (stage.type === 'transcript_question' && stage.per_chapter) {
        // ── Per-chapter transcript question (concurrent pool of 5) ──
        if (!chapterSplits) throw new Error('per_chapter stage requires a preceding split_by_chapter stage')
        const allChaptersCtx = chapterSplits._allChaptersContext || ''
        const CHAPTER_CONCURRENCY = 5
        const chapterResults = new Array(chapterSplits.length).fill(null)
        let completedChapters = 0
        brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: i, totalStages: stages.length, status: 'running', stageName: `${phaseLabel}${stageName}`, phase, videoLabel, subDone: 0, subTotal: chapterSplits.length, subLabel: '' })

        // Pre-load existing sub-run outputs for this stage (resume recovery)
        const existingChapterOutputs = {}
        if (resumeData?.completedSubRuns?.[i]?.size) {
          const subRows = await db.prepare(
            `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND metadata_json LIKE ? AND status = 'complete'`
          ).all(`%"pipelineId":"${pipelineId}"%`, `%"stageIndex":${i},%"isSubRun":true%`)
          for (const sr of subRows) {
            const sm = JSON.parse(sr.metadata_json || '{}')
            if (sm.subIndex != null) existingChapterOutputs[sm.subIndex] = sr.output_text || ''
          }
          if (Object.keys(existingChapterOutputs).length) console.log(`[broll-pipeline] Resume: loaded ${Object.keys(existingChapterOutputs).length}/${chapterSplits.length} existing chapter sub-runs for stage ${i}`)
        }

        async function processChapter(c) {
          if (abortedBrollPipelines.has(pipelineId)) return
          const ch = chapterSplits[c]

          // Skip if this sub-run already completed (resume)
          if (existingChapterOutputs[c] != null) {
            chapterResults[c] = existingChapterOutputs[c]
            completedChapters++
            console.log(`[broll-pipeline] Resume: skipped chapter ${c + 1}/${chapterSplits.length} (already done)`)
            brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: i, totalStages: stages.length, status: 'running', stageName: `${phaseLabel}${stageName}`, phase, videoLabel, subDone: completedChapters, subTotal: chapterSplits.length, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name} (cached)` })
            return
          }

          console.log(`[broll-pipeline] Chapter ${c + 1}/${chapterSplits.length}: ${ch.chapter_name}`)

          // Resolve per-chapter output from the previous per_chapter or enrichment stage
          // Find the last per_chapter/enrich stage before this one and extract chapter c's output
          let prevChapterOutput = ''
          for (let pi = i - 1; pi >= 0; pi--) {
            const prevStage = stages[pi]
            const isPrevPerChapter = prevStage.type === 'transcript_question' && prevStage.per_chapter
            const isPrevEnrich = prevStage.type === 'programmatic' && (prevStage.action === 'enrich_beat_matches' || prevStage.action === 'enrich_beat_frequency')
            if (isPrevPerChapter || isPrevEnrich) {
              try {
                const prevResults = JSON.parse(stageOutputs[pi] || '[]')
                prevChapterOutput = prevResults[c] || ''
              } catch {}
              break
            }
          }

          let chPrompt = replacePlaceholders(stage.prompt || '')
            .replace(/\{\{chapter_number\}\}/g, String(ch.chapter_number))
            .replace(/\{\{total_chapters\}\}/g, String(chapterSplits.length))
            .replace(/\{\{chapter_name\}\}/g, ch.chapter_name)
            .replace(/\{\{chapter_purpose\}\}/g, ch.chapter_purpose)
            .replace(/\{\{chapter_emotion\}\}/g, ch.chapter_emotion || '')
            .replace(/\{\{chapter_start_tc\}\}/g, ch.chapter_start_tc)
            .replace(/\{\{chapter_end_tc\}\}/g, ch.chapter_end_tc)
            .replace(/\{\{chapter_duration_seconds\}\}/g, String(ch.chapter_duration_seconds))
            .replace(/\{\{chapter_beats\}\}/g, ch.beats_formatted)
            .replace(/\{\{chapter_elements\}\}/g, JSON.stringify(ch.elements, null, 2))
            .replace(/\{\{chapter_element_count\}\}/g, String(ch.elements.length))
            .replace(/\{\{chapter_transcript\}\}/g, ch.transcript)
            .replace(/\{\{chapter_stats\}\}/g, JSON.stringify((chapterSplits._stats || [])[c] || {}, null, 2))
            .replace(/\{\{all_chapters\}\}/g, allChaptersCtx)
            .replace(/\{\{a_rolls\}\}/g, allChaptersCtx.split('## Chapters')[0] || '')
            .replace(/\{\{prev_chapter_output\}\}/g, prevChapterOutput)

          const chSystem = replacePlaceholders(stage.system_instruction || '')

          const result = await callLLM({
            model: stage.model || 'gemini-3.1-pro-preview',
            systemInstruction: chSystem,
            prompt: chPrompt,
            params: stage.params || { temperature: 0.3 },
            experimentId: null,
            abortSignal: pipelineAbort.signal,
          })

          chapterResults[c] = result.text
          totalTokensIn += result.tokensIn || 0
          totalTokensOut += result.tokensOut || 0
          totalCost += result.cost || 0
          stageTokensIn += result.tokensIn || 0
          stageTokensOut += result.tokensOut || 0
          stageCost += result.cost || 0
          completedChapters++

          brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: i, totalStages: stages.length, status: 'running', stageName: `${phaseLabel}${stageName}`, phase, videoLabel, subDone: completedChapters, subTotal: chapterSplits.length, subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}` })

          await storeSubRun({
            stageIndex: i, stageName, subIndex: c,
            subLabel: `Chapter ${ch.chapter_number}: ${ch.chapter_name}`,
            prompt: chPrompt, systemInstruction: chSystem,
            input: ch.transcript.slice(0, 500),
            output: result.text, model: stage.model,
            tokensIn: result.tokensIn, tokensOut: result.tokensOut, cost: result.cost,
            runtime: 0, phase,
          })
        }

        // Pool: keep CHAPTER_CONCURRENCY running, start next as each finishes
        let nextC = 0
        async function runNextChapter() {
          while (nextC < chapterSplits.length && !abortedBrollPipelines.has(pipelineId)) {
            const c = nextC++
            await processChapter(c)
          }
        }
        await Promise.all(Array.from({ length: Math.min(CHAPTER_CONCURRENCY, chapterSplits.length) }, () => runNextChapter()))

        output = JSON.stringify(chapterResults.filter(Boolean))
        questionCount++
        llmAnswer = output
        llmAnswers[questionCount] = output

      } else if (stage.type === 'transcript_question') {
        // ── Transcript question ──
        const result = await runLLMCall(stage, null, null)
        output = result.text
        resolvedPrompt = result._resolvedPrompt || ''; resolvedSystem = result._resolvedSystem || ''
        questionCount++
        llmAnswer = output
        llmAnswers[questionCount] = output
        stageTokensIn += result.tokensIn || 0; stageTokensOut += result.tokensOut || 0; stageCost += result.cost || 0
        totalTokensIn += result.tokensIn || 0; totalTokensOut += result.tokensOut || 0; totalCost += result.cost || 0

      } else if (stage.type === 'transcript_parallel') {
        // ── Transcript per-segment ──
        if (!segments) throw new Error('transcript_parallel requires a preceding segment stage')
        const results = []
        for (let s = 0; s < segments.length; s++) {
          const seg = segments[s]
          const segPrompt = replacePlaceholders(stage.prompt || '')
            .replace(/\{\{segment_number\}\}/g, String(s + 1))
            .replace(/\{\{total_segments\}\}/g, String(segments.length))
          const systemInstruction = replacePlaceholders(stage.system_instruction || '')
          const result = await callLLM({
            model: stage.model || 'gemini-3-flash-preview',
            systemInstruction,
            prompt: segPrompt.includes('{{transcript}}') ? segPrompt : `${segPrompt}\n\n${seg.mainText || seg}`,
            params: stage.params || { temperature: 0.2 },
            experimentId: null,
            abortSignal: pipelineAbort.signal,
          })
          results.push(result.text)
          totalTokensIn += result.tokensIn || 0
          totalTokensOut += result.tokensOut || 0
          totalCost += result.cost || 0
        }
        output = JSON.stringify(results)

      } else if (stage.type === 'programmatic') {
        const action = stage.action || 'segment'
        const params = stage.actionParams || {}

        // Normalize LLM timecodes [HH:MM:SS] → _seconds fields
        function tcToSec(tc) {
          if (!tc) return null
          const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/)
          if (!m) return null
          return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
        }
        function normalizeTimestamps(obj) {
          if (!obj || typeof obj !== 'object') return
          if (obj.start && !obj.start_seconds) obj.start_seconds = tcToSec(obj.start) ?? 0
          if (obj.end && !obj.end_seconds) obj.end_seconds = tcToSec(obj.end) ?? 0
          if (obj.change_at && !obj.change_at_seconds) obj.change_at_seconds = tcToSec(obj.change_at) ?? 0
          for (const v of Object.values(obj)) {
            if (Array.isArray(v)) v.forEach(normalizeTimestamps)
            else if (v && typeof v === 'object') normalizeTimestamps(v)
          }
        }

        if (action === 'segment') {
          segments = segmentTranscript(currentTranscript, params)
          output = JSON.stringify(segments.map((s, idx) => ({ index: idx, lines: (s.mainText || '').split('\n').length })))
        } else if (action === 'segment_by_chapters') {
          segments = segmentByChapters(currentTranscript, llmAnswer, params)
          output = JSON.stringify(segments.map((s, idx) => ({ index: idx, chapter: s.chapter || idx })))
        } else if (action === 'reassemble') {
          if (!segments) throw new Error('reassemble requires preceding segments')
          currentTranscript = reassembleSegments(segments)
          output = currentTranscript
        } else if (action === 'build_time_windows') {
          // Parse A-Roll + Chapters JSON and split into equal-length ~1 min windows
          const chaptersSource = params.chaptersStageIndex != null ? stageOutputs[params.chaptersStageIndex] : (llmAnswers[1] || llmAnswer)
          const stage1 = chaptersSource
          let parsed
          try { parsed = JSON.parse(stage1) } catch { parsed = extractJSON(stage1) }
          normalizeTimestamps(parsed)
          // Get duration from the actual video file
          const windowVideoId = stage._videoId || effectiveExamples[0]?.id
          let totalDuration = 600
          if (windowVideoId) {
            const { getVideoDuration } = await import('./video-processor.js')
            const vPath = await getVideoFilePath(windowVideoId)
            const realDuration = await getVideoDuration(vPath)
            if (realDuration) totalDuration = Math.round(realDuration)
            console.log(`[broll-pipeline] Video ${windowVideoId} duration: ${totalDuration}s (${(totalDuration/60).toFixed(1)} min)`)
          }
          const targetSec = params.windowSeconds || 60
          const chapters = parsed.chapters || []
          const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
          // Number of windows = floor(duration / target), so partial last minute gets absorbed into equal splits
          // Only add an extra window if duration is exactly on the minute boundary
          const numWindows = Math.max(1, totalDuration % targetSec === 0 ? totalDuration / targetSec : Math.floor(totalDuration / targetSec))
          const windowSec = totalDuration / numWindows
          console.log(`[broll-pipeline] Time windows: ${totalDuration}s / ${numWindows} = ${windowSec.toFixed(1)}s each`)
          const windows = []
          for (let w = 0; w < numWindows; w++) {
            const start = Math.round(w * windowSec)
            const end = w === numWindows - 1 ? totalDuration : Math.round((w + 1) * windowSec)
            const ch = chapters.find(c => c.start_seconds <= start && c.end_seconds > start)
            const beats = (ch?.beats || [])
              .filter(b => b.start_seconds < end && b.end_seconds > start)
              .map(b => b.name)
            windows.push({
              window_id: w + 1,
              start_seconds: start,
              end_seconds: end,
              start_tc: toTC(start),
              end_tc: toTC(end),
              chapter_name: ch?.name || 'Unknown',
              beats_in_window: beats,
            })
          }
          timeWindows = windows
          output = JSON.stringify({ windows })
        } else if (action === 'split_by_chapter') {
          // Parse chapters JSON and per-window elements, group by chapter
          const chaptersSource = params.chaptersStageIndex != null ? stageOutputs[params.chaptersStageIndex] : (llmAnswers[1] || llmAnswer)
          let parsed
          try { parsed = JSON.parse(chaptersSource) } catch { parsed = extractJSON(chaptersSource) }
          normalizeTimestamps(parsed)
          const chapters = parsed.chapters || []
          let aRolls = parsed.a_roll_appearances || parsed.a_rolls || []

          // If A-Roll data is in a separate stage (plan strategy splits A-Roll and Chapters)
          if (!aRolls.length && params.aRollStageIndex != null) {
            try {
              const aRollParsed = extractJSON(stageOutputs[params.aRollStageIndex] || '')
              aRolls = aRollParsed.a_roll_appearances || aRollParsed.a_rolls || []
              normalizeTimestamps({ a_roll_appearances: aRolls })
            } catch (e) {
              console.warn(`[broll-pipeline] Failed to parse A-Roll from stage ${params.aRollStageIndex}: ${e.message}`)
            }
          }

          // Collect all elements from per-window output
          const elementsSource = params.elementsStageIndex != null ? stageOutputs[params.elementsStageIndex] : stageOutputs[2]
          const stage3raw = elementsSource || '[]'
          // Stage 3 with per_window outputs aggregated text with JSON blocks per window
          // Try to extract all JSON objects from the output
          const allElements = []
          let elId = 1
          const jsonBlocks = stage3raw.match(/\{[\s\S]*?"elements"\s*:\s*\[[\s\S]*?\]\s*\}/g) || []
          for (const block of jsonBlocks) {
            try {
              const w = JSON.parse(block)
              for (const el of (w.elements || [])) {
                allElements.push({ id: elId++, ...el })
              }
            } catch {}
          }
          // Fallback: try parsing as single JSON
          if (!allElements.length) {
            try {
              let allWindows = JSON.parse(stage3raw)
              if (!Array.isArray(allWindows)) allWindows = [allWindows]
              for (const w of allWindows) {
                for (const el of (w.elements || [])) {
                  allElements.push({ id: elId++, ...el })
                }
              }
            } catch {}
          }

          // Slice transcript by chapter timestamps
          const transcriptLines = currentTranscript.split('\n')
          function parseLineTime(line) {
            const m = line.match(/\[(\d{1,2}):(\d{2}):?(\d{2})?(?:\.\d+)?\]/)
            if (!m) return null
            return (parseInt(m[1]) * 3600) + (parseInt(m[2]) * 60) + (parseInt(m[3] || '0'))
          }

          const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`

          chapterSplits = chapters.map((ch, idx) => {
            const chElements = allElements.filter(e => e.start_seconds >= ch.start_seconds && e.start_seconds < ch.end_seconds)
            // Extract transcript lines for this chapter's time range
            const chTranscriptLines = transcriptLines.filter(line => {
              const t = parseLineTime(line)
              if (t === null) return false
              return t >= ch.start_seconds && t < ch.end_seconds
            })
            const beatsRaw = ch.beats || []
            const beats = beatsRaw.map(b => `  - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)}): ${b.description}${b.purpose ? ' | Purpose: ' + b.purpose : ''}${b.emotion ? ' | Emotion: ' + b.emotion : ''}`).join('\n')

            return {
              chapter_number: idx + 1,
              chapter_name: ch.name || `Chapter ${idx + 1}`,
              chapter_purpose: ch.purpose || ch.description || '',
              chapter_emotion: ch.emotion || '',
              chapter_start: ch.start_seconds,
              chapter_end: ch.end_seconds,
              chapter_start_tc: toTC(ch.start_seconds),
              chapter_end_tc: toTC(ch.end_seconds),
              chapter_duration_seconds: ch.end_seconds - ch.start_seconds,
              content_type: ch.content_type || '',
              beats_formatted: beats,
              beats_raw: beatsRaw,
              elements: chElements,
              transcript: chTranscriptLines.join('\n'),
            }
          })

          // Build all-chapters summary for context
          const allChaptersSummary = chapters.map((ch, idx) => {
            const beats = (ch.beats || []).map(b => `    - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)})`).join('\n')
            return `### Chapter ${idx + 1}: ${ch.name} (${toTC(ch.start_seconds)}-${toTC(ch.end_seconds)})\nPurpose: ${ch.purpose || ch.description || ''}${ch.emotion ? '\nEmotion: ' + ch.emotion : ''}\nBeats:\n${beats}`
          }).join('\n\n')
          const aRollSummary = aRolls.map(a => {
            const changeAt = a.change_at_seconds != null ? ` — change at ${toTC(a.change_at_seconds)}` : ''
            const note = a.change_note ? ` (${a.change_note})` : ''
            return `A-Roll #${a.id}: ${a.description}${changeAt}${note}`
          }).join('\n')

          // Store context for per_chapter stages
          chapterSplits._allChaptersContext = `## A-Rolls:\n${aRollSummary}\n\n## Chapters & Beats:\n${allChaptersSummary}`

          output = JSON.stringify({
            total_chapters: chapterSplits.length,
            total_elements: allElements.length,
            chapters: chapterSplits.map(c => ({
              name: c.chapter_name,
              start: c.chapter_start_tc,
              end: c.chapter_end_tc,
              element_count: c.elements.length,
            })),
          })
        } else if (action === 'compute_chapter_stats') {
          // Compute hard numbers per chapter from chapterSplits
          if (!chapterSplits) throw new Error('compute_chapter_stats requires a preceding split_by_chapter stage')

          function groupBy(arr, key) {
            const map = {}
            for (const el of arr) {
              const v = el[key] || 'unknown'
              map[v] = (map[v] || 0) + 1
            }
            return map
          }
          function avgDuration(els) {
            if (!els.length) return 0
            const total = els.reduce((s, e) => s + ((e.end_seconds || 0) - (e.start_seconds || 0)), 0)
            return Math.round(total / els.length * 10) / 10
          }
          function avgGap(els) {
            if (els.length < 2) return 0
            const sorted = [...els].sort((a, b) => a.start_seconds - b.start_seconds)
            let totalGap = 0
            for (let i = 1; i < sorted.length; i++) {
              totalGap += sorted[i].start_seconds - (sorted[i - 1].end_seconds || sorted[i - 1].start_seconds)
            }
            return Math.round(totalGap / (sorted.length - 1) * 10) / 10
          }
          function catStats(els) {
            if (!els.length) return { count: 0 }
            return {
              count: els.length,
              avg_duration_seconds: avgDuration(els),
              avg_gap_seconds: avgGap(els),
              by_type_group: groupBy(els, 'type_group'),
              by_function: groupBy(els, 'function'),
            }
          }

          const chapterStats = chapterSplits.map(ch => {
            const brolls = ch.elements.filter(e => e.category === 'broll')
            const gps = ch.elements.filter(e => e.category === 'graphic_package')
            const overlays = ch.elements.filter(e => e.category === 'overlay_image')

            const byBeat = (ch.beats_raw || []).map(b => {
              const beatEls = ch.elements.filter(e => e.start_seconds >= b.start_seconds && e.start_seconds < b.end_seconds)
              const beatBrolls = beatEls.filter(e => e.category === 'broll')
              const beatGps = beatEls.filter(e => e.category === 'graphic_package')
              const beatOverlays = beatEls.filter(e => e.category === 'overlay_image')
              const beatDurationMin = ((b.end_seconds || 0) - (b.start_seconds || 0)) / 60
              return {
                beat_name: b.name,
                beat_duration_seconds: (b.end_seconds || 0) - (b.start_seconds || 0),
                broll: { count: beatBrolls.length, per_minute: beatDurationMin > 0 ? Math.round(beatBrolls.length / beatDurationMin * 10) / 10 : 0, avg_duration_seconds: avgDuration(beatBrolls) },
                graphic_package: { count: beatGps.length, per_minute: beatDurationMin > 0 ? Math.round(beatGps.length / beatDurationMin * 10) / 10 : 0, avg_duration_seconds: avgDuration(beatGps) },
                overlay_image: { count: beatOverlays.length, per_minute: beatDurationMin > 0 ? Math.round(beatOverlays.length / beatDurationMin * 10) / 10 : 0 },
              }
            })

            return {
              chapter_name: ch.chapter_name,
              duration_seconds: ch.chapter_duration_seconds,
              broll: { ...catStats(brolls), by_source_feel: groupBy(brolls, 'source_feel') },
              graphic_package: catStats(gps),
              overlay_image: { ...catStats(overlays), by_position: groupBy(overlays, 'position') },
              by_beat: byBeat,
            }
          })

          // Store on chapterSplits for per_chapter stages to access
          chapterSplits._stats = chapterStats
          output = JSON.stringify(chapterStats)
        } else if (action === 'assemble_full_analysis') {
          // Merge: A-Roll + per-chapter (chapters/beats + stats + pattern analysis). No elements.
          if (!chapterSplits) throw new Error('assemble_full_analysis requires preceding split_by_chapter')
          const stats = chapterSplits._stats || []
          // Find the most recent per-chapter LLM output (pattern analysis results)
          const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
          let llmResults = []
          try { llmResults = JSON.parse(lastPerChapterOutput) } catch {}
          const parsedLlmResults = llmResults.map(r => {
            try { return extractJSON(r) } catch { return r }
          })

          // A-Roll from stage 0 output (first question answer)
          let aRollData = null
          try {
            const stage0Out = llmAnswers[1] || stageOutputs[0] || ''
            const parsed0 = extractJSON(stage0Out)
            aRollData = {
              has_talking_head: parsed0.has_talking_head,
              appearances: parsed0.a_roll_appearances || parsed0.a_rolls || [],
            }
          } catch {}

          const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`

          // Compute overall totals across all chapters
          let totalBroll = 0, totalGP = 0, totalOverlay = 0
          for (const s of stats) {
            totalBroll += s.broll?.count || 0
            totalGP += s.graphic_package?.count || 0
            totalOverlay += s.overlay_image?.count || 0
          }
          const totalElements = totalBroll + totalGP + totalOverlay || 1

          function toPct(countMap, total) {
            if (!countMap || !total) return {}
            const result = {}
            for (const [key, count] of Object.entries(countMap)) {
              result[key] = `${Math.round(count / total * 100)}%`
            }
            return result
          }

          const chapters = chapterSplits.map((ch, idx) => {
            const chStats = stats[idx] || {}
            const durationMin = ch.chapter_duration_seconds / 60
            const beats = (ch.beats_raw || []).map(b => ({
              name: b.name,
              time: `${toTC(b.start_seconds)} - ${toTC(b.end_seconds)}`,
              description: b.description,
              purpose: b.purpose || '',
            }))
            const brollCount = chStats.broll?.count || 0
            const gpCount = chStats.graphic_package?.count || 0
            const overlayCount = chStats.overlay_image?.count || 0
            const chTotal = brollCount + gpCount + overlayCount || 1
            return {
              chapter_number: ch.chapter_number,
              chapter_name: ch.chapter_name,
              time: `${ch.chapter_start_tc} - ${ch.chapter_end_tc}`,
              duration_seconds: ch.chapter_duration_seconds,
              purpose: ch.chapter_purpose,
              beats,
              frequency_and_timing: {
                broll: {
                  count: brollCount,
                  per_minute: Math.round(brollCount / durationMin * 10) / 10,
                  avg_duration_seconds: chStats.broll?.avg_duration_seconds,
                  what_footage_looks_like: toPct(chStats.broll?.by_source_feel, brollCount),
                  what_content_is_shown: toPct(chStats.broll?.by_type_group, brollCount),
                  why_its_used: toPct(chStats.broll?.by_function, brollCount),
                },
                graphic_package: { count: gpCount, per_minute: Math.round(gpCount / durationMin * 10) / 10, avg_duration_seconds: chStats.graphic_package?.avg_duration_seconds },
                overlay_image: { count: overlayCount, per_minute: Math.round(overlayCount / durationMin * 10) / 10, where_placed: toPct(chStats.overlay_image?.by_position, overlayCount) },
                usage_split: { broll_pct: Math.round(brollCount / chTotal * 100), graphic_package_pct: Math.round(gpCount / chTotal * 100), overlay_image_pct: Math.round(overlayCount / chTotal * 100) },
                by_beat: (chStats.by_beat || []).map(b => {
                  const brollCount = b.broll?.count || 0
                  const gpCount = b.graphic_package?.count || 0
                  const overlayCount = b.overlay_image?.count || 0
                  const total = brollCount + gpCount + overlayCount || 1
                  return {
                    beat_name: b.beat_name,
                    beat_duration_seconds: b.beat_duration_seconds,
                    broll: { count: brollCount, per_minute: b.broll?.per_minute || 0, avg_duration_seconds: b.broll?.avg_duration_seconds || 0 },
                    graphic_package: { count: gpCount, per_minute: b.graphic_package?.per_minute || 0, avg_duration_seconds: b.graphic_package?.avg_duration_seconds || 0 },
                    overlay_image: { count: overlayCount, per_minute: b.overlay_image?.per_minute || 0 },
                    usage_split: { broll_pct: Math.round(brollCount / total * 100), graphic_package_pct: Math.round(gpCount / total * 100), overlay_image_pct: Math.round(overlayCount / total * 100) },
                    total,
                  }
                }),
              },
              pattern_analysis: parsedLlmResults[idx] || null,
            }
          })

          output = JSON.stringify({
            a_roll: aRollData,
            total_chapters: chapters.length,
            overall_usage_split: {
              broll: { count: totalBroll, pct: Math.round(totalBroll / totalElements * 100) },
              graphic_package: { count: totalGP, pct: Math.round(totalGP / totalElements * 100) },
              overlay_image: { count: totalOverlay, pct: Math.round(totalOverlay / totalElements * 100) },
            },
            chapters,
          }, null, 2)
        } else if (action === 'generate_post_cut_transcript') {
          // Generate transcript with timecodes adjusted for rough cut
          if (!editorCuts?.cuts?.length) {
            // No cuts — use raw transcript as-is (plan prep without rough cut)
            console.log('[broll-pipeline] No editor cuts — using raw transcript')
            output = currentTranscript
          } else {
            const postCutTranscript = await generatePostCutTranscript(videoId, editorCuts.cuts, editorCuts.cutExclusions || [])
            currentTranscript = postCutTranscript
            output = postCutTranscript
            // Persist to database
            try {
              await db.prepare("DELETE FROM transcripts WHERE video_id = ? AND type = 'rough_cut_adjusted'").run(videoId)
              await db.prepare("INSERT INTO transcripts (video_id, type, content) VALUES (?, 'rough_cut_adjusted', ?)").run(videoId, postCutTranscript)
            } catch (e) { console.warn('[broll-pipeline] Could not persist rough_cut_adjusted transcript:', e.message) }
          }
        } else if (action === 'export_post_cut_video') {
          // Export post-cut 360p video, upload to Supabase for persistence across deploys
          if (!editorCuts?.cuts?.length) {
            // No cuts — skip video export, use original video
            console.log('[broll-pipeline] No editor cuts — skipping post-cut video export')
            output = 'No editor cuts — using original video'
          } else {
            const storagePath = `temp/postcut-${pipelineId}.mp4`
            let postCutPath = null

            // On resume: try downloading cached post-cut from Supabase (seconds vs minutes of FFmpeg)
            if (isResumedStage) {
              try {
                const cachedUrl = getPublicUrl('videos', storagePath)
                postCutPath = await downloadToTemp(cachedUrl, `postcut-${pipelineId}.mp4`)
                console.log(`[broll-pipeline] Resume: reused cached post-cut from storage (skipped FFmpeg)`)
                output = resumeData.completedStages[i] || `Post-cut video restored from cache`
              } catch (e) {
                console.warn(`[broll-pipeline] Resume: cached post-cut not available, falling back to FFmpeg: ${e.message}`)
                postCutPath = null
              }
            }

            // Initial run or resume fallback: run FFmpeg
            if (!postCutPath) {
              const { exportPostCutVideo } = await import('./video-processor.js')
              const { getVideoDuration } = await import('./video-processor.js')
              const originalPath = await getVideoFilePath(videoId)
              const duration = await getVideoDuration(originalPath) || 600
              const effectiveCuts = computeEffectiveCuts(editorCuts.cuts, editorCuts.cutExclusions || [])
              postCutPath = await exportPostCutVideo(originalPath, effectiveCuts, duration)
              // Upload to Supabase — kept for future resumes (not added to cleanup list)
              try {
                const url = await uploadFile('videos', storagePath, postCutPath)
                console.log(`[broll-pipeline] Post-cut uploaded to storage: ${url}`)
                output = `Post-cut video exported (360p) and uploaded: ${url}`
              } catch (e) {
                console.warn(`[broll-pipeline] Post-cut upload failed (using local): ${e.message}`)
                output = `Post-cut video exported (360p, local only): ${postCutPath}`
              }
            }

            mainVideoFilePath = postCutPath
          }
        } else if (action === 'assemble_broll_plan') {
          // Merge per-chapter B-Roll plan outputs into one document
          if (!chapterSplits) throw new Error('assemble_broll_plan requires preceding split_by_chapter')
          const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
          let llmResults = []
          try { llmResults = JSON.parse(lastPerChapterOutput) } catch {}
          const parsedPlans = llmResults.map(r => {
            try { return extractJSON(r) } catch { return r }
          })

          // Include per-chapter strategy if strategyStageIndex is specified
          let strategyResults = []
          if (params.strategyStageIndex != null) {
            try { strategyResults = JSON.parse(stageOutputs[params.strategyStageIndex] || '[]') } catch {}
            strategyResults = strategyResults.map(r => { try { return extractJSON(r) } catch { return r } })
          }

          const allChaptersCtx = chapterSplits._allChaptersContext || ''
          const chapters = chapterSplits.map((ch, idx) => ({
            chapter_number: ch.chapter_number,
            chapter_name: ch.chapter_name,
            time: `${ch.chapter_start_tc} - ${ch.chapter_end_tc}`,
            duration_seconds: ch.chapter_duration_seconds,
            purpose: ch.chapter_purpose,
            beats: ch.beats_formatted,
            strategy: strategyResults[idx] || null,
            plan: parsedPlans[idx] || null,
          }))

          output = JSON.stringify({
            video_context: allChaptersCtx,
            total_chapters: chapters.length,
            chapters,
          }, null, 2)
        } else {
          output = currentTranscript
        }
      }

      stageOutputs.push(output)
      const stageRuntime = Date.now() - stageStart

      if (isResumedStage) {
        // Programmatic stage replayed for state rebuild — re-insert to DB if row was deleted
        console.log(`[broll-pipeline] Resume: replayed programmatic stage ${i + 1}/${stages.length} (${stageName})`)
        // Check if DB row exists for this stage; if not (deleted by fromStage), re-insert
        const existing = await db.prepare(`SELECT id FROM broll_runs WHERE metadata_json LIKE ? AND metadata_json LIKE ? AND metadata_json NOT LIKE '%"isSubRun":true%' LIMIT 1`)
          .get(`%"pipelineId":"${pipelineId}"%`, `%"stageIndex":${i},%`)
        if (!existing) {
          await db.prepare(`
            INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            strategyId, videoId, 'analysis', 'complete',
            '', output, '', '', 'programmatic', 0, 0, 0, stageRuntime,
            JSON.stringify({ pipelineId, stageIndex: i, totalStages: stages.length, stageName, stageType: stage.type, target, phase, videoLabel, analysisStageCount, transcriptSource: resolvedSource, groupId }),
          )
          console.log(`[broll-pipeline] Resume: re-inserted programmatic stage ${i + 1} to DB`)
        }
      } else {

        await db.prepare(`
          INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          strategyId, videoId, 'analysis', 'complete',
          (isVideoType ? `[video: ${target}]` : currentTranscript.slice(0, 500)),
          output,
          resolvedPrompt || stage.prompt || '', resolvedSystem || stage.system_instruction || '',
          stage.model || 'gemini-3-flash-preview',
          stageTokensIn, stageTokensOut, stageCost, stageRuntime,
          JSON.stringify({ pipelineId, stageIndex: i, totalStages: stages.length, stageName, stageType: stage.type, target, phase, videoLabel, analysisStageCount, transcriptSource: resolvedSource, groupId }),
        )

        // Persist spending to spending_log — survives run deletion
        if (stageCost > 0 || stageTokensIn + stageTokensOut > 0) {
          await db.prepare(
            'INSERT INTO spending_log (total_cost, total_tokens, total_runtime_ms, source, created_at) VALUES (?, ?, ?, ?, ?)'
          ).run(stageCost, stageTokensIn + stageTokensOut, stageRuntime, `broll pipeline ${pipelineId} stage ${i}`, new Date().toISOString())
        }
      }

      saveSnapshot(stageName)
    }

    const totalRuntime = Date.now() - pipelineStart
    pipelineAbortControllers.delete(pipelineId)
    brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: stages.length, totalStages: stages.length, status: 'complete', stageName: 'Done' })

    // Clean up stale failed entries from previous aborted runs of this pipeline
    await db.prepare(`DELETE FROM broll_runs WHERE status = 'failed' AND metadata_json LIKE ?`).run(`%"pipelineId":"${pipelineId}"%`)
    setTimeout(() => brollPipelineProgress.delete(pipelineId), 300_000)

    snapshot.outcome = { event: 'complete', at: new Date().toISOString() }
    writePipelineSnapshot(pipelineId, snapshot)
    console.log(`[broll-snapshot] pipeline_complete | ${stages.length} stages | $${totalCost.toFixed(4)} | ${(totalRuntime / 1000).toFixed(1)}s`)

    // Clean up Supabase postcut file only on success (preserve for resume on failure)
    try { await deleteFile('videos', `temp/postcut-${pipelineId}.mp4`) } catch {}

    // Clean up temp files from Supabase storage
    cleanupTempFiles(pipelineTempFiles)

    return { pipelineId, stageCount: stages.length, stageOutputs, transcriptSource: resolvedSource, totalTokensIn, totalTokensOut, totalCost, totalRuntime }

  } catch (err) {
    console.error(`[broll-pipeline] PIPELINE CATCH (${typeof pipelineId !== 'undefined' ? pipelineId : 'unknown'}): ${err.message}`)
    pipelineAbortControllers.delete(pipelineId)
    const isAbort = abortedBrollPipelines.has(pipelineId) || err.name === 'AbortError'
    brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: stageOutputs.length, totalStages: stages.length, status: 'failed', error: isAbort ? 'Aborted by user' : err.message })
    setTimeout(() => { brollPipelineProgress.delete(pipelineId); abortedBrollPipelines.delete(pipelineId) }, 300_000)

    snapshot.outcome = { event: isAbort ? 'aborted' : 'failed', error: isAbort ? 'Aborted by user' : err.message, at: new Date().toISOString(), atStage: stageOutputs.length }
    writePipelineSnapshot(pipelineId, snapshot)
    console.log(`[broll-snapshot] pipeline_${isAbort ? 'aborted' : 'failed'} | stage ${stageOutputs.length}/${stages.length} | ${err.message}`)

    // Clean up temp files from Supabase storage even on failure
    cleanupTempFiles(pipelineTempFiles)
    // Don't insert a failed DB entry for user aborts — the completed stages are enough
    if (!isAbort) {
      await db.prepare(`
        INSERT INTO broll_runs (strategy_id, video_id, step_name, status, error_message, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(strategyId, videoId, 'analysis', 'failed', err.message, JSON.stringify({ pipelineId, stageIndex: stageOutputs.length, totalStages: stages.length }))
    }
    throw err
  }
}

// ── B-Roll Editor Data ────────────────────────────────────────────────

/**
 * Load the editor state blob for a plan pipeline.
 * Returns { state, version } — empty object and version 0 if no row yet.
 */
export async function loadBrollEditorState(planPipelineId) {
  const row = await db.prepare(
    `SELECT state_json, version FROM broll_editor_state WHERE plan_pipeline_id = ?`
  ).get(planPipelineId)
  if (!row) return { state: {}, version: 0 }
  let state = {}
  try { state = JSON.parse(row.state_json || '{}') } catch {}
  return { state, version: row.version }
}

/**
 * Save the editor state blob with optimistic concurrency.
 * If expectedVersion does not match the current row's version, returns
 * { status: 'conflict', state, version } without writing.
 * On success returns { status: 'ok', version: newVersion }.
 */
export async function saveBrollEditorState(planPipelineId, state, expectedVersion) {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    const cur = await client.query(
      `SELECT state_json, version FROM broll_editor_state WHERE plan_pipeline_id = $1 FOR UPDATE`,
      [planPipelineId],
    )
    const currentVersion = cur.rows[0]?.version || 0
    if (currentVersion !== expectedVersion) {
      await client.query('ROLLBACK')
      let currentState = {}
      try { currentState = JSON.parse(cur.rows[0]?.state_json || '{}') } catch {}
      return { status: 'conflict', state: currentState, version: currentVersion }
    }
    const nextVersion = currentVersion + 1
    const stateJson = JSON.stringify(state || {})
    if (cur.rows.length === 0) {
      await client.query(
        `INSERT INTO broll_editor_state (plan_pipeline_id, state_json, version, updated_at) VALUES ($1, $2, $3, NOW())`,
        [planPipelineId, stateJson, nextVersion],
      )
    } else {
      await client.query(
        `UPDATE broll_editor_state SET state_json = $1, version = $2, updated_at = NOW() WHERE plan_pipeline_id = $3`,
        [stateJson, nextVersion, planPipelineId],
      )
    }
    await client.query('COMMIT')
    return { status: 'ok', version: nextVersion }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Assemble all data needed for the B-Roll editor UI.
 * Loads plan placements and search results for a given plan pipeline.
 */
export async function getBRollEditorData(planPipelineId) {
  // 1. Load per-chapter plan sub-runs → extract placements
  const planSubRuns = await db.prepare(`
    SELECT id, output_text, metadata_json FROM broll_runs
    WHERE metadata_json LIKE ? AND status = 'complete'
    ORDER BY id
  `).all(`%"pipelineId":"${planPipelineId}"%`)

  const chapterRuns = planSubRuns.filter(r => {
    try { const m = JSON.parse(r.metadata_json || '{}'); return m.isSubRun && m.stageName === 'Per-chapter B-Roll plan' }
    catch { return false }
  }).sort((a, b) => {
    const ma = JSON.parse(a.metadata_json || '{}'), mb = JSON.parse(b.metadata_json || '{}')
    return (ma.subIndex || 0) - (mb.subIndex || 0)
  })

  // Flatten placements from all chapters
  const placements = []
  for (let chIdx = 0; chIdx < chapterRuns.length; chIdx++) {
    const raw = chapterRuns[chIdx].output_text || ''
    let parsed
    try {
      const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '')
      parsed = JSON.parse(cleaned)
    } catch { continue }

    // Find the placements array at any nesting
    let items = parsed.placements || parsed.broll_placements || []
    if (!items.length) {
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v) && v.length && v[0]?.description) { items = v; break }
      }
    }

    let brollIdx = 0
    for (let pIdx = 0; pIdx < items.length; pIdx++) {
      const p = items[pIdx]
      if (p.category && p.category !== 'broll') continue
      placements.push({
        index: placements.length,
        chapterIndex: chIdx,
        placementIndex: brollIdx++,
        start: p.start,
        end: p.end,
        audio_anchor: p.audio_anchor || '',
        description: p.description || '',
        function: p.function || '',
        type_group: p.type_group || '',
        source_feel: p.source_feel || '',
        style: p.style || {},
        searchStatus: 'pending',
        results: [],
      })
    }
  }

  // 2. Load search results — primary: broll_searches queue, fallback: legacy broll_runs + broll_search_logs
  const queueRows = await db.prepare(
    `SELECT * FROM broll_searches WHERE plan_pipeline_id = ? ORDER BY id`
  ).all(planPipelineId)

  if (queueRows.length) {
    // New queue system: broll_searches is the source of truth
    // First, try to recover orphaned 'running' entries (server restarted mid-search)
    // Only do this if NO active search batch is running in memory (otherwise the 'running' entry is legitimate)
    const hasActiveBatch = [...brollPipelineProgress.entries()].some(([pid, prog]) => pid.startsWith('search-batch-') && prog.status === 'running')
    const orphanedRunning = !hasActiveBatch ? queueRows.filter(r => r.status === 'running' && r.brief) : []
    if (orphanedRunning.length) {
      try {
        const allLogs = await db.prepare(
          `SELECT DISTINCT ON (brief) brief, results, num_results FROM broll_search_logs WHERE num_results > 0 ORDER BY brief, id DESC`
        ).all()
        const logByBrief = new Map(allLogs.map(l => [l.brief, l]))
        for (const row of orphanedRunning) {
          const logRow = logByBrief.get(row.brief)
          if (logRow) {
            const results = Array.isArray(logRow.results) ? logRow.results : JSON.parse(logRow.results || '[]')
            const upgraded = results.map(r => r.preview_url_hq ? r : { ...r, preview_url_hq: upgradePreviewUrl(r.preview_url) })
            await db.prepare(
              `UPDATE broll_searches SET status = 'complete', results_json = ?, num_results = ?, completed_at = NOW() WHERE id = ?`
            ).run(JSON.stringify(upgraded), upgraded.length, row.id)
            row.status = 'complete'
            row.results_json = JSON.stringify(upgraded)
            row.num_results = upgraded.length
            console.log(`[getBRollEditorData] Recovered orphaned search #${row.id} from broll_search_logs (${upgraded.length} results)`)
          }
        }
      } catch (err) {
        console.error('[getBRollEditorData] Orphan recovery error:', err.message)
      }
    }

    for (const row of queueRows) {
      const match = placements.find(p => p.chapterIndex === row.chapter_index && p.placementIndex === row.placement_index)
      if (!match) continue

      match.brollSearchId = row.id
      if (row.status === 'complete' && row.results_json) {
        const results = JSON.parse(row.results_json || '[]')
        match.results = results.map(r => r.preview_url_hq ? r : { ...r, preview_url_hq: upgradePreviewUrl(r.preview_url) })
        match.searchStatus = match.results.length > 0 ? 'complete' : 'no_results'
      } else if (row.status === 'running') {
        match.searchStatus = 'searching'
      } else if (row.status === 'waiting') {
        match.searchStatus = 'waiting'
      } else if (row.status === 'failed') {
        match.searchStatus = 'failed'
      }
    }
  } else {
    // Legacy fallback: broll_runs + broll_search_logs for pre-migration data
    const searchRuns = await db.prepare(`
      SELECT id, output_text, metadata_json FROM broll_runs
      WHERE metadata_json LIKE ? AND status IN ('complete', 'failed')
      ORDER BY id
    `).all(`%"pipelineId":"bs-${planPipelineId}-%`)

    const searchSubRuns = searchRuns.filter(r => {
      try { return JSON.parse(r.metadata_json || '{}').isSubRun } catch { return false }
    })

    for (const sr of searchSubRuns) {
      const meta = JSON.parse(sr.metadata_json || '{}')
      const match = placements.find(p => p.chapterIndex === meta.chapterIndex && p.placementIndex === meta.placementIndex)
      if (!match) continue
      try {
        const output = JSON.parse(sr.output_text || '{}')
        match.results = (output.results || []).map(r => r.preview_url_hq ? r : { ...r, preview_url_hq: upgradePreviewUrl(r.preview_url) })
        match.searchStatus = match.results.length > 0 ? 'complete' : 'no_results'
      } catch {
        match.searchStatus = 'failed'
      }
    }

    // Legacy fallback: broll_search_logs (GPU proxy writes there independently)
    const noResultPlacements = placements.filter(p => !p.results?.length && p.searchStatus !== 'complete')
    if (noResultPlacements.length) {
      const briefMap = new Map()
      for (const p of noResultPlacements) {
        const styleParts = []
        if (p.style?.colors) styleParts.push(`colors: ${p.style.colors}`)
        if (p.style?.temperature) styleParts.push(`temperature: ${p.style.temperature}`)
        if (p.style?.motion) styleParts.push(`motion: ${p.style.motion}`)
        if (p.style?.framing) styleParts.push(`framing: ${p.style.framing}`)
        if (p.style?.lighting) styleParts.push(`lighting: ${p.style.lighting}`)
        const brief = [
          p.description ? `# ${p.description}` : '',
          styleParts.length ? `## Style: ${styleParts.join('; ')}` : '',
        ].filter(Boolean).join('\n')
        briefMap.set(brief, p)
      }
      try {
        const allLogs = await db.prepare(
          `SELECT DISTINCT ON (brief) brief, results, num_results FROM broll_search_logs WHERE num_results > 0 ORDER BY brief, id DESC`
        ).all()
        for (const logRow of allLogs) {
          const p = briefMap.get(logRow.brief)
          if (!p) continue
          const raw = Array.isArray(logRow.results) ? logRow.results : JSON.parse(logRow.results || '[]')
          p.results = raw.map(r => r.preview_url_hq ? r : { ...r, preview_url_hq: upgradePreviewUrl(r.preview_url) })
          p.searchStatus = 'complete'
        }
      } catch (err) {
        console.error('[getBRollEditorData] broll_search_logs fallback error:', err.message)
      }
    }
  }

  // 2c. Mark placements that have keywords but no GPU results as 'keywords_ready'
  const kwRuns = await db.prepare(
    `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete'`
  ).all(`%"pipelineId":"kw-${planPipelineId}-%`)
  const kwProcessedIndices = new Set()
  for (const r of kwRuns) {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      if (m.processedIndices) for (const idx of m.processedIndices) kwProcessedIndices.add(idx)
    } catch {}
  }
  for (let i = 0; i < placements.length; i++) {
    if (placements[i].searchStatus === 'pending' && kwProcessedIndices.has(i)) {
      placements[i].searchStatus = 'keywords_ready'
    }
  }

  // 3. Check for active search progress (search-batch or legacy bs- pipelines)
  let searchProgress = null
  for (const [pid, prog] of brollPipelineProgress.entries()) {
    // New search-batch pipeline
    if (pid.startsWith('search-batch-') && prog.status === 'running') {
      searchProgress = {
        status: 'running',
        phase: prog.phase || 'gpu_search',
        subDone: prog.subDone || 0,
        subTotal: prog.subTotal || 0,
        currentVariant: prog.currentVariant || '',
        stageName: prog.stageName || '',
        keywordsDone: prog.keywordsDone || 0,
        keywordsTotal: prog.keywordsTotal || 0,
      }
      break
    }
    // Legacy bs- pipeline
    if (pid.startsWith(`bs-${planPipelineId}-`) && prog.status === 'running') {
      searchProgress = { status: 'running', subDone: prog.subDone || 0, subTotal: prog.subTotal || 0 }
      // Mark the currently-searching element
      const currentIdx = prog.subDone || 0
      if (currentIdx < placements.length) {
        placements[currentIdx].searchStatus = 'searching'
      }
      break
    }
  }

  // 3b. Fallback: derive searchProgress from broll_searches queue if in-memory progress expired
  if (!searchProgress && queueRows.length) {
    const hasRunning = queueRows.some(r => r.status === 'running')
    const hasWaiting = queueRows.some(r => r.status === 'waiting')
    if (hasRunning) {
      // Active GPU search in progress (in-memory progress expired but DB shows running)
      const done = queueRows.filter(r => r.status === 'complete').length
      const failed = queueRows.filter(r => r.status === 'failed').length
      const total = queueRows.length
      const running = queueRows.find(r => r.status === 'running')
      searchProgress = {
        status: 'running',
        phase: 'gpu_search',
        subDone: done + failed,
        subTotal: total,
        currentVariant: running.variant_label || '',
        stageName: `${running.variant_label} Ch${running.chapter_index + 1} #${running.placement_index + 1}`,
      }
    }
    // If only 'waiting' entries (no 'running'), the batch processor is dead.
    // Don't report 'running' — let the UI show "Search next 10" button to resume.
  }

  // 4. Merge user edits from broll_editor_state (hidden, manual positions, selected result, userPlacements)
  let editorState = {}, editorVersion = 0
  try {
    const loaded = await loadBrollEditorState(planPipelineId)
    editorState = loaded.state || {}
    editorVersion = loaded.version
  } catch (err) {
    console.error('[getBRollEditorData] Failed to load editor-state:', err.message)
  }

  const edits = editorState.edits || {}
  const userPlacements = Array.isArray(editorState.userPlacements) ? editorState.userPlacements : []

  const editedPlacements = []
  for (const p of placements) {
    const key = `${p.chapterIndex}:${p.placementIndex}`
    const e = edits[key]
    if (e?.hidden) continue
    if (e?.timelineStart != null && e?.timelineEnd != null) {
      p.userTimelineStart = e.timelineStart
      p.userTimelineEnd = e.timelineEnd
    }
    if (e?.selectedResult != null) {
      const resolved = Array.isArray(p.results) ? p.results[e.selectedResult] : undefined
      if (resolved) p.persistedSelectedResult = resolved
    }
    editedPlacements.push(p)
  }

  for (const up of userPlacements) {
    editedPlacements.push({
      index: `user:${up.id}`,
      userPlacementId: up.id,
      isUserPlacement: true,
      sourcePipelineId: up.sourcePipelineId,
      sourceChapterIndex: up.sourceChapterIndex ?? null,
      sourcePlacementIndex: up.sourcePlacementIndex ?? null,
      // chapterIndex/placementIndex left null so the same-key edit lookup
      // in matchPlacementsToTranscript treats userPlacements distinctly from
      // chapter-derived placements (matches client-side userPlacementToRawEntry).
      chapterIndex: null,
      placementIndex: null,
      userTimelineStart: up.timelineStart,
      userTimelineEnd: up.timelineEnd,
      persistedSelectedResult: (up.selectedResult != null ? (up.results?.[up.selectedResult] ?? null) : null),
      results: up.results || [],
      searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
      ...(up.snapshot || {}),
    })
  }

  return { placements: editedPlacements, searchProgress, totalPlacements: editedPlacements.length, editorStateVersion: editorVersion }
}

// Pure transform: getBRollEditorData() placements → export manifest items.
// Filters Storyblocks (export pipeline non-goal). Picks the user-selected
// result if present, else the top-ranked candidate. Variant filter is
// applied case-insensitively against `variant_label` and is forgiving of
// the "Variant X" vs "X" mismatch. When NO placement has variant_label
// (legacy data), the filter is a no-op pass-through (legacy data is
// per-pipelineId, not per-variant — there's no label to filter on).
//
// This function is exported separately from getBRollEditorData so the
// route handler can stay thin and the transform is unit-testable
// without a DB.
export function buildManifestFromPlacements(placements, { variant } = {}) {
  // Variant normalization: accept "A" or "Variant A".
  const variantNorm = variant
    ? variant.trim().replace(/^Variant\s+/i, '').toLowerCase()
    : null

  // Pre-pass: detect whether ANY placement carries a variant_label.
  // If none do, the variant filter is a no-op (legacy data path).
  const anyHasLabel = placements.some(p => p.variant_label != null && p.variant_label !== '')
  const applyVariantFilter = !!(variantNorm && anyHasLabel)

  let seq = 0
  const items = []
  let estTotal = 0
  const bySource = {}

  for (const p of placements) {
    if (p.hidden) continue
    if (!Array.isArray(p.results) || p.results.length === 0) continue

    // Variant filter (queue data path).
    if (applyVariantFilter) {
      const label = String(p.variant_label || '')
        .trim()
        .replace(/^Variant\s+/i, '')
        .toLowerCase()
      if (label !== variantNorm) continue
    }

    // Selection rule: user pick > top-ranked-non-storyblocks.
    // If the user explicitly picked a result, honor it (even if storyblocks —
    // we only filter storyblocks from auto-selection, not from explicit picks
    // because the editor wouldn't let them pick a non-existent source).
    // Otherwise scan results[] in rank order for the first non-storyblocks
    // result. Storyblocks is an export-pipeline non-goal per master spec, so
    // dropping it ENTIRELY (i.e. skipping the placement when storyblocks is
    // results[0]) means losing placements that have a perfectly good Pexels/
    // Envato/Freepik clip at index 1+. Fall through instead.
    let pick
    if (p.persistedSelectedResult && typeof p.persistedSelectedResult === 'object') {
      pick = p.persistedSelectedResult
    } else {
      pick = p.results.find(r => {
        const s = String(r?.source || '').toLowerCase()
        return s && s !== 'storyblocks'
      })
    }
    if (!pick) continue

    const source = String(pick.source || '').toLowerCase()
    if (!source) continue
    if (source === 'storyblocks') continue   // Defensive: if user picked storyblocks explicitly, still drop.

    const sourceItemId = pick.source_item_id || pick.id || pick.uid || null
    if (!sourceItemId) continue

    seq += 1
    const ext = source === 'envato' ? 'mov' : 'mp4'
    const safeId = String(sourceItemId).replace(/[^A-Za-z0-9_-]/g, '_')
    const targetFilename = `${String(seq).padStart(3, '0')}_${source}_${safeId}.${ext}`

    // Timeline: prefer user-edited positions over plan defaults.
    const startS = (p.userTimelineStart != null) ? p.userTimelineStart : (p.start ?? null)
    const endS   = (p.userTimelineEnd   != null) ? p.userTimelineEnd   : (p.end   ?? null)
    const durS   = (startS != null && endS != null) ? Math.max(0, endS - startS) : null

    const item = {
      seq,
      timeline_start_s: startS,
      timeline_duration_s: durS,
      source,
      source_item_id: String(sourceItemId),
      envato_item_url: source === 'envato' ? (pick.envato_item_url || null) : null,
      target_filename: targetFilename,
      resolution: pick.resolution || { width: pick.width || 1920, height: pick.height || 1080 },
      frame_rate: pick.frame_rate || 30,
      est_size_bytes: typeof pick.est_size_bytes === 'number'
        ? pick.est_size_bytes
        : (pick.duration_seconds ? Math.round(pick.duration_seconds * 25 * 1024 * 1024) : 100 * 1024 * 1024),
      variant_label: p.variant_label || null,
    }
    items.push(item)
    estTotal += item.est_size_bytes
    bySource[source] = (bySource[source] || 0) + 1
  }

  return {
    items,
    totals: { count: items.length, est_size_bytes: estTotal, by_source: bySource },
  }
}

/**
 * Search a single B-Roll placement by its chapterIndex + placementIndex.
 * Reuses the same brief/keyword building as executeBrollSearch but for one item.
 */
export async function searchSinglePlacement(planPipelineId, chapterIndex, placementIndex, overrides = {}) {
  const GPU_URL = 'https://gpu-proxy-production.up.railway.app/broll/search'
  const GPU_KEY = process.env.GPU_INTERNAL_KEY
  if (!GPU_KEY) throw new Error('GPU_INTERNAL_KEY not set')

  // Load plan sub-runs to find the placement
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)

  const videoId = planRuns[0]?.video_id
  if (!videoId) throw new Error('No video found for pipeline')

  const chapterRuns = planRuns.filter(r => {
    try { const m = JSON.parse(r.metadata_json || '{}'); return m.isSubRun && m.stageName === 'Per-chapter B-Roll plan' }
    catch { return false }
  }).sort((a, b) => {
    const ma = JSON.parse(a.metadata_json || '{}'), mb = JSON.parse(b.metadata_json || '{}')
    return (ma.subIndex || 0) - (mb.subIndex || 0)
  })

  if (chapterIndex >= chapterRuns.length) throw new Error(`Chapter ${chapterIndex} not found`)

  const chapterRun = chapterRuns[chapterIndex]
  let parsed
  try {
    const raw = chapterRun.output_text || ''
    parsed = extractJSON(raw)
  } catch { throw new Error('Failed to parse chapter plan') }

  const items = parsed.placements || parsed
  if (!Array.isArray(items)) throw new Error('No placements array in chapter plan')
  const brollOnly = items.filter(p => !p.category || p.category === 'broll')
  if (placementIndex >= brollOnly.length) throw new Error(`Placement ${placementIndex} not found in chapter ${chapterIndex}`)

  const p = brollOnly[placementIndex]

  // Load keywords
  const kwRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id DESC`
  ).all(`%"pipelineId":"kw-${planPipelineId}-%`)
  const kwSubRuns = kwRuns.filter(r => JSON.parse(r.metadata_json || '{}').isSubRun)

  let keywords = []
  for (const r of kwSubRuns) {
    const m = JSON.parse(r.metadata_json || '{}')
    if (m.subIndex === chapterIndex) {
      try {
        const kwData = extractJSON(r.output_text || '')
        const kwEntry = (Array.isArray(kwData) ? kwData : []).find(k => k.placement_index === placementIndex) || kwData[placementIndex]
        if (kwEntry?.keywords) {
          keywords = kwEntry.keywords.flatMap(k => [k.query_2w, k.query_3w].filter(Boolean))
        }
      } catch {}
      break
    }
  }

  // Build brief — use overrides if provided
  const desc = overrides.description || p.description
  let styleStr
  if (overrides.style) {
    styleStr = overrides.style
  } else {
    const styleParts = []
    if (p.style?.colors) styleParts.push(`colors: ${p.style.colors}`)
    if (p.style?.temperature) styleParts.push(`temperature: ${p.style.temperature}`)
    if (p.style?.motion) styleParts.push(`motion: ${p.style.motion}`)
    if (p.style?.framing) styleParts.push(`framing: ${p.style.framing}`)
    if (p.style?.lighting) styleParts.push(`lighting: ${p.style.lighting}`)
    styleStr = styleParts.join('; ')
  }

  const brief = [
    desc ? `# ${desc}` : '',
    styleStr ? `## Style: ${styleStr}` : '',
  ].filter(Boolean).join('\n')

  const searchKeywords = keywords.length ? keywords : (p.search_keywords || [])
  const sources = await resolveBrollSources(planPipelineId, overrides)

  const requestBody = {
    keywords: searchKeywords,
    brief,
    sources,
    max_results: 10,
  }

  // Find or create broll_search strategy
  let searchStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'broll_search' ORDER BY id LIMIT 1").get()
  if (!searchStrategy) {
    const r = await db.prepare("INSERT INTO broll_strategies (name, strategy_kind) VALUES (?, ?)").run('B-Roll Video Search', 'broll_search')
    searchStrategy = { id: r.lastInsertRowid }
  }

  const searchStart = Date.now()
  let results = []
  let searchMeta = {}
  let apiLogId = null

  const progressId = `search-single-ch${chapterIndex}-p${placementIndex}-${Date.now()}`
  let gpuJobId = null
  brollPipelineProgress.set(progressId, {
    status: 'running', stageName: 'GPU Search', gpuStage: 'search', gpuStatus: 'Starting...',
    startedAt: Date.now(),
  })

  try {
    const data = await streamingFetch(GPU_URL, {
      body: requestBody,
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': GPU_KEY },
      logSource: `broll-search-single:ch${chapterIndex}-p${placementIndex}`,
      onProgress: (evt) => {
        if (evt.stage === 'job' && evt.job_id) gpuJobId = evt.job_id
        brollPipelineProgress.set(progressId, {
          ...brollPipelineProgress.get(progressId),
          gpuStage: evt.stage,
          gpuStatus: evt.message || evt.status,
          gpuJobId,
          subDone: evt.processed ?? evt.done,
          subTotal: evt.total,
        })
      },
    })
    results = data.results || []
    apiLogId = data.apiLogId || null
    searchMeta = { search_count: data.search_count, filtered_count: data.filtered_count, model_used: data.model_used }
  } catch (err) {
    console.error(`[searchSinglePlacement] streamingFetch error:`, err.message)
    apiLogId = err.apiLogId || null
    searchMeta = { error: err.message }
  }

  // Primary recovery: if the SSE stream ended without a result (Railway's ~15 min edge-proxy
  // cap, or the GPU proxy closing the stream early), ask the GPU proxy directly for the job
  // status. /broll/jobs/:id is authoritative — it knows if the GPU is still running, finished,
  // or failed, independent of any HTTP stream closing.
  let gpuJobStatus = null // 'running' (timeout), 'failed', or null (complete or never known)
  if (!results.length && gpuJobId) {
    console.log(`[searchSinglePlacement] Stream ended without results — polling GPU job ${gpuJobId} directly...`)
    try {
      const jobResult = await _pollGpuJob(gpuJobId, GPU_KEY, 1200) // up to 20 min
      if (jobResult?.results) {
        results = jobResult.results
        searchMeta = {
          search_count: jobResult.search_count,
          filtered_count: jobResult.filtered_count,
          model_used: jobResult.model_used,
          recovered: true,
        }
        console.log(`[searchSinglePlacement] Recovered ${results.length} results from GPU job ${gpuJobId}`)
      } else if (jobResult?.status === 'timeout') {
        console.warn(`[searchSinglePlacement] GPU job ${gpuJobId} still running after 20 min — giving up`)
        gpuJobStatus = 'running'
        searchMeta = { ...searchMeta, error: `Job ${gpuJobId}: still running after 20 min`, jobId: gpuJobId }
      } else if (jobResult?.status === 'failed') {
        console.warn(`[searchSinglePlacement] GPU job ${gpuJobId} failed: ${jobResult.error}`)
        gpuJobStatus = 'failed'
        searchMeta = { ...searchMeta, error: `Job ${gpuJobId}: ${jobResult.error || 'failed'}`, jobId: gpuJobId }
      }
    } catch (pollErr) {
      console.error(`[searchSinglePlacement] GPU job polling failed: ${pollErr.message}`)
      searchMeta = { ...searchMeta, error: pollErr.message }
    }
  }

  // Secondary fallback: broll_search_logs by brief. Reached when we never captured a job_id
  // from the stream, or when /broll/jobs/:id is unreachable. Short poll — the GPU proxy writes
  // here on completion, so if the job finished we'll see it quickly.
  if (!results.length) {
    console.log(`[searchSinglePlacement] Final fallback: checking broll_search_logs by brief...`)
    await new Promise(r => setTimeout(r, 3000))
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const logRow = await db.prepare(
          `SELECT results, num_results, num_candidates FROM broll_search_logs WHERE brief = ? ORDER BY id DESC LIMIT 1`
        ).get(brief)
        if (logRow?.num_results > 0) {
          results = Array.isArray(logRow.results) ? logRow.results : JSON.parse(logRow.results || '[]')
          searchMeta = { search_count: logRow.num_candidates, recovered: true }
          gpuJobStatus = null // recovered — clear any earlier timeout/failed state
          console.log(`[searchSinglePlacement] Got ${results.length} results from broll_search_logs fallback (attempt ${attempt + 1})`)
          break
        }
      } catch (fallbackErr) {
        console.error(`[searchSinglePlacement] fallback error:`, fallbackErr.message)
      }
      if (attempt < 5) await new Promise(r => setTimeout(r, 5000))
    }
  }

  const finalStatus = gpuJobStatus === 'running' ? 'timeout' : gpuJobStatus === 'failed' ? 'failed' : 'complete'
  brollPipelineProgress.set(progressId, { ...brollPipelineProgress.get(progressId), status: finalStatus, gpuStage: null, gpuStatus: null })
  setTimeout(() => brollPipelineProgress.delete(progressId), 60_000)

  // Upgrade preview URLs to HD where possible
  results = results.map(r => ({ ...r, preview_url_hq: upgradePreviewUrl(r.preview_url) }))

  const searchDuration = Date.now() - searchStart
  const groupId = JSON.parse(planRuns[0].metadata_json || '{}').groupId || null

  const output = JSON.stringify({
    placement: { description: p.description, start: p.start, end: p.end, audio_anchor: p.audio_anchor, function: p.function, type_group: p.type_group, source_feel: p.source_feel },
    keywords_used: searchKeywords,
    results,
    ...searchMeta,
  })

  // Results are tracked via api_logs (streamingFetch) and broll_search_logs (GPU proxy)
  // No need to duplicate in broll_runs

  return { results, ...searchMeta, duration: searchDuration, apiLogId, gpuJobStatus, jobId: gpuJobId }
}

export async function searchUserPlacement(planPipelineId, userPlacementId, overrides = {}) {
  const GPU_URL = 'https://gpu-proxy-production.up.railway.app/broll/search'
  const GPU_KEY = process.env.GPU_INTERNAL_KEY
  if (!GPU_KEY) throw new Error('GPU_INTERNAL_KEY not set')

  const loaded = await loadBrollEditorState(planPipelineId)
  const up = (loaded.state.userPlacements || []).find(u => u.id === userPlacementId)
  if (!up) throw new Error(`userPlacement ${userPlacementId} not found on pipeline ${planPipelineId}`)

  const desc = overrides.description || up.snapshot?.description
  let styleStr
  if (overrides.style) {
    styleStr = overrides.style
  } else {
    const s = up.snapshot?.style || {}
    const parts = []
    if (s.colors) parts.push(`colors: ${s.colors}`)
    if (s.temperature) parts.push(`temperature: ${s.temperature}`)
    if (s.motion) parts.push(`motion: ${s.motion}`)
    if (s.framing) parts.push(`framing: ${s.framing}`)
    if (s.lighting) parts.push(`lighting: ${s.lighting}`)
    styleStr = parts.join('; ')
  }

  const brief = [
    desc ? `# ${desc}` : '',
    styleStr ? `## Style: ${styleStr}` : '',
  ].filter(Boolean).join('\n')

  const sources = await resolveBrollSources(planPipelineId, overrides)
  const requestBody = { keywords: [], brief, sources, max_results: 10 }

  const res = await fetch(GPU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': GPU_KEY },
    body: JSON.stringify(requestBody),
  })
  if (!res.ok) throw new Error(`GPU search failed: ${res.status}`)
  const data = await res.json()
  const results = (data.results || []).map(r => r.preview_url_hq ? r : { ...r, preview_url_hq: upgradePreviewUrl(r.preview_url) })

  // Persist back: replace the userPlacement's results, reset selectedResult to 0.
  // Retry up to 3x on 409 conflict.
  let saved = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await loadBrollEditorState(planPipelineId)
    const updatedUps = (latest.state.userPlacements || []).map(u =>
      u.id === userPlacementId ? { ...u, results, selectedResult: 0 } : u
    )
    const nextState = { ...latest.state, userPlacements: updatedUps }
    const save = await saveBrollEditorState(planPipelineId, nextState, latest.version)
    if (save.status === 'ok') { saved = true; break }
  }
  if (!saved) {
    throw new Error('Failed to persist search results after conflicts; please retry')
  }

  return { results, searchStatus: results.length ? 'complete' : 'no_results' }
}

// ── Reset B-Roll Searches ──────────────────────────────────────────────
// Scope helper: returns all plan pipeline IDs + video IDs for a group.
// Used by both preview and reset so they operate on the exact same set.
export async function computeBrollResetScope(groupId) {
  // Include this group's videos AND any sub-groups' videos — sub-groups inherit parent plans.
  const videos = await db.prepare(`
    SELECT id FROM videos WHERE group_id IN (
      SELECT id FROM video_groups WHERE id = ? OR parent_group_id = ?
    )
  `).all(groupId, groupId)
  const videoIds = videos.map(v => v.id)
  if (!videoIds.length) return { planPipelineIds: [], videoIds: [] }

  const placeholders = videoIds.map(() => '?').join(',')
  const planRuns = await db.prepare(`
    SELECT DISTINCT (metadata_json::jsonb->>'pipelineId') AS pid
    FROM broll_runs
    WHERE video_id IN (${placeholders})
      AND (metadata_json::jsonb->>'pipelineId') LIKE 'plan-%'
  `).all(...videoIds)
  const planPipelineIds = planRuns.map(r => r.pid).filter(Boolean)

  return { planPipelineIds, videoIds }
}

// Preview: returns counts for what resetBrollSearches(groupId) would delete/abort.
// Pure read, no mutations.
export async function previewBrollReset(groupId) {
  const { planPipelineIds, videoIds } = await computeBrollResetScope(groupId)
  if (!planPipelineIds.length) {
    return { plans: [], searches: { total: 0, byStatus: {} }, kwRuns: 0, bsRuns: 0, activePipelines: [] }
  }
  const planPH = planPipelineIds.map(() => '?').join(',')
  const vidPH = videoIds.map(() => '?').join(',')

  const searchRows = await db.prepare(
    `SELECT status, COUNT(*)::int AS cnt FROM broll_searches WHERE plan_pipeline_id IN (${planPH}) GROUP BY status`
  ).all(...planPipelineIds)
  const byStatus = {}
  let total = 0
  for (const r of searchRows) { byStatus[r.status] = r.cnt; total += r.cnt }

  const kwRow = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM broll_runs WHERE video_id IN (${vidPH}) AND (metadata_json::jsonb->>'pipelineId') LIKE 'kw-%'`
  ).get(...videoIds)
  const bsRow = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM broll_runs WHERE video_id IN (${vidPH}) AND (metadata_json::jsonb->>'pipelineId') LIKE 'bs-%'`
  ).get(...videoIds)

  // In-memory pipelines that belong to this group's plans
  const activePipelines = []
  for (const [pid, progress] of brollPipelineProgress.entries()) {
    const matchesKwBs = planPipelineIds.some(planId =>
      pid === `kw-${planId}` || pid.startsWith(`kw-${planId}-`) || pid.startsWith(`bs-${planId}-`)
    )
    if (matchesKwBs) {
      activePipelines.push({ pipelineId: pid, status: progress.status, stageName: progress.stageName, kind: 'kw_or_bs' })
      continue
    }
    if (pid.startsWith('search-batch-')) {
      const row = await db.prepare(
        `SELECT 1 FROM broll_searches WHERE batch_id = ? AND plan_pipeline_id IN (${planPH}) LIMIT 1`
      ).get(pid, ...planPipelineIds)
      if (row) activePipelines.push({ pipelineId: pid, status: progress.status, stageName: progress.stageName, kind: 'search-batch' })
    }
  }

  return {
    plans: planPipelineIds,
    searches: { total, byStatus },
    kwRuns: kwRow?.cnt || 0,
    bsRuns: bsRow?.cnt || 0,
    activePipelines,
  }
}

// Execute reset: abort matching in-memory pipelines, delete broll_searches rows,
// delete kw-* and bs-* broll_runs for this group's videos.
// Leaves plans, strategies, analysis, reference data untouched.
export async function resetBrollSearches(groupId) {
  const { planPipelineIds, videoIds } = await computeBrollResetScope(groupId)
  if (!planPipelineIds.length) {
    return { searchesDeleted: 0, kwRunsDeleted: 0, bsRunsDeleted: 0, pipelinesAborted: 0 }
  }
  const planPH = planPipelineIds.map(() => '?').join(',')
  const vidPH = videoIds.map(() => '?').join(',')

  // 1) Collect pipeline IDs to abort
  const pidsToRemove = []
  for (const [pid, progress] of brollPipelineProgress.entries()) {
    const matchesKwBs = planPipelineIds.some(planId =>
      pid === `kw-${planId}` || pid.startsWith(`kw-${planId}-`) || pid.startsWith(`bs-${planId}-`)
    )
    if (matchesKwBs) { pidsToRemove.push(pid); continue }
    if (pid.startsWith('search-batch-')) {
      const row = await db.prepare(
        `SELECT 1 FROM broll_searches WHERE batch_id = ? AND plan_pipeline_id IN (${planPH}) LIMIT 1`
      ).get(pid, ...planPipelineIds)
      if (row) pidsToRemove.push(pid)
    }
  }

  // 2) Abort + clean up in-memory state for each
  let pipelinesAborted = 0
  for (const pid of pidsToRemove) {
    abortedBrollPipelines.add(pid)
    const controller = pipelineAbortControllers.get(pid)
    if (controller) {
      try { controller.abort() } catch (e) { console.warn(`[broll-reset] abort failed for ${pid}:`, e.message) }
      pipelineAbortControllers.delete(pid)
    }
    brollPipelineProgress.delete(pid)
    pipelinesAborted++
  }

  // 3) Delete broll_searches rows for this group's plans
  const delSearches = await db.prepare(
    `DELETE FROM broll_searches WHERE plan_pipeline_id IN (${planPH})`
  ).run(...planPipelineIds)
  const searchesDeleted = delSearches.changes || 0

  // 4) Delete kw-* broll_runs
  const delKw = await db.prepare(
    `DELETE FROM broll_runs WHERE video_id IN (${vidPH}) AND (metadata_json::jsonb->>'pipelineId') LIKE 'kw-%'`
  ).run(...videoIds)
  const kwRunsDeleted = delKw.changes || 0

  // 5) Delete bs-* broll_runs (legacy b-roll search pipeline)
  const delBs = await db.prepare(
    `DELETE FROM broll_runs WHERE video_id IN (${vidPH}) AND (metadata_json::jsonb->>'pipelineId') LIKE 'bs-%'`
  ).run(...videoIds)
  const bsRunsDeleted = delBs.changes || 0

  // Second-pass cleanup: a pipeline that was mid-insert when we aborted may have
  // finished writing a broll_searches row AFTER the first DELETE. Re-run to catch stragglers.
  const delSearchesAgain = await db.prepare(
    `DELETE FROM broll_searches WHERE plan_pipeline_id IN (${planPH})`
  ).run(...planPipelineIds)
  const stragglers = delSearchesAgain.changes || 0

  console.log(`[broll-reset] group=${groupId}: searches=${searchesDeleted}${stragglers ? ` (+${stragglers} stragglers)` : ''}, kw=${kwRunsDeleted}, bs=${bsRunsDeleted}, aborted=${pipelinesAborted}`)

  return { searchesDeleted: searchesDeleted + stragglers, kwRunsDeleted, bsRunsDeleted, pipelinesAborted }
}
