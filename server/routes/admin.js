import { Router } from 'express'
import { requireAuth, isAdmin } from '../auth.js'
import db from '../db.js'
import { activeStreams, streamingFetch } from '../services/api-logger.js'
import { notify } from '../services/slack-notifier.js'

const router = Router()

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// Keys grouped by service — only non-empty values are returned
const KEY_GROUPS = [
  {
    group: 'AI / LLM',
    keys: [
      { name: 'OPENAI_API_KEY', label: 'OpenAI' },
      { name: 'GOOGLE_API_KEY', label: 'Google AI (Primary)' },
      { name: 'GOOGLE_API_KEY_BACKUP', label: 'Google AI (Backup)' },
      { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs' },
    ],
  },
  {
    group: 'Media / Stock',
    keys: [
      { name: 'STORYBLOCKS_API_KEY', label: 'Storyblocks API Key' },
      { name: 'STORYBLOCKS_PRIVATE_KEY', label: 'Storyblocks Private Key' },
      { name: 'PEXELS_API_KEY', label: 'Pexels' },
    ],
  },
  {
    group: 'Infrastructure',
    keys: [
      { name: 'CF_ACCOUNT_ID', label: 'Cloudflare Account ID' },
      { name: 'CF_API_TOKEN', label: 'Cloudflare API Token' },
      { name: 'GPU_INTERNAL_KEY', label: 'GPU Internal Key' },
    ],
  },
  {
    group: 'Deployment',
    keys: [
      { name: 'RAILWAY_API_TOKEN', label: 'Railway API Token' },
      { name: 'RAILWAY_PROJECT_ID', label: 'Railway Project ID' },
      { name: 'VERCEL_TOKEN', label: 'Vercel Token' },
      { name: 'VERCEL_PROJECT_ID', label: 'Vercel Project ID' },
    ],
  },
]

router.get('/keys', requireAuth, requireAdmin, (req, res) => {
  const groups = KEY_GROUPS.map(({ group, keys }) => ({
    group,
    keys: keys
      .filter(k => process.env[k.name])
      .map(k => ({
        name: k.name,
        label: k.label,
        value: process.env[k.name],
      })),
  })).filter(g => g.keys.length > 0)

  res.json({ groups })
})

router.post('/test-search', requireAuth, requireAdmin, async (req, res) => {
  const GPU_URL = 'https://gpu-proxy-production.up.railway.app/broll/search'
  const GPU_KEY = process.env.GPU_INTERNAL_KEY
  if (!GPU_KEY) return res.status(500).json({ error: 'GPU_INTERNAL_KEY not set' })

  const body = req.body || {
    keywords: ['book page', 'reading book page', 'medical journal'],
    brief: 'Function: Inform - Illustrate. Description: Book page with medical text.',
    sources: ['pexels', 'storyblocks'],
    max_results: 5, min_duration: 3, max_duration: 30, orientation: 'horizontal',
  }

  try {
    const data = await streamingFetch(GPU_URL, {
      body,
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': GPU_KEY },
      logSource: 'test-search:admin',
      onProgress: (ev) => console.log(`[test-search] ${ev.stage}: ${ev.status}`),
    })
    res.json({ status: 'complete', results: data.results?.length || 0, events: data.events?.length || 0 })
  } catch (err) {
    res.json({ status: 'error', error: err.message })
  }
})

router.get('/api-logs/active', requireAuth, requireAdmin, (req, res) => {
  const streams = Array.from(activeStreams.values())
  res.json({ streams })
})

router.get('/api-logs', requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0
  const source = req.query.source || null
  const placementUuid = req.query.placementUuid || null

  const conditions = []
  const filterParams = []
  if (source) {
    conditions.push('source LIKE ?')
    filterParams.push(`%${source}%`)
  }
  if (placementUuid) {
    conditions.push('placement_uuid = ?')
    filterParams.push(placementUuid)
  }
  const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''

  const logs = await db.prepare(
    `SELECT id, method, url, request_body, response_status, error, duration_ms, source, placement_uuid, created_at FROM api_logs${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...filterParams, limit, offset)
  const countQuery = await db.prepare(
    `SELECT COUNT(*) as total FROM api_logs${whereClause}`
  ).get(...filterParams)

  res.json({ logs, total: parseInt(countQuery.total), limit, offset })
})

router.get('/api-logs/:id', requireAuth, requireAdmin, async (req, res) => {
  const log = await db.prepare('SELECT * FROM api_logs WHERE id = ?').get(req.params.id)
  if (!log) return res.status(404).json({ error: 'Log not found' })
  res.json(log)
})

// ── B-Roll Search Queue ──────────────────────────────────────────────

router.get('/broll-searches', requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0
  const status = req.query.status || null

  let where = ''
  const params = []
  if (status) { where = 'WHERE status = ?'; params.push(status) }

  const rows = await db.prepare(`SELECT * FROM broll_searches ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)
  const countResult = await db.prepare(`SELECT COUNT(*) as total FROM broll_searches ${where}`).get(...params)

  res.json({ searches: rows, total: parseInt(countResult.total), limit, offset })
})

router.get('/broll-searches/:id', requireAuth, requireAdmin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM broll_searches WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  let apiLog = null
  if (row.api_log_id) {
    apiLog = await db.prepare('SELECT * FROM api_logs WHERE id = ?').get(row.api_log_id)
  }
  res.json({ ...row, apiLog })
})

router.delete('/broll-searches/:id', requireAuth, requireAdmin, async (req, res) => {
  const { changes } = await db.prepare('DELETE FROM broll_searches WHERE id = ?').run(req.params.id)
  if (!changes) return res.status(404).json({ error: 'Not found' })
  res.json({ success: true })
})

router.post('/test-alert', requireAuth, requireAdmin, (_req, res) => {
  notify({
    source: 'admin-test',
    title: 'Test alert from admin endpoint',
    error: 'Synthetic — safe to ignore.',
  })
  res.json({ ok: true })
})

export default router
