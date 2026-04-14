import { Router } from 'express'
import { requireAuth, isAdmin } from '../auth.js'
import db from '../db.js'
import { activeStreams } from '../services/api-logger.js'

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

router.get('/api-logs/active', requireAuth, requireAdmin, (req, res) => {
  const streams = Array.from(activeStreams.values())
  res.json({ streams })
})

router.get('/api-logs', requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0
  const source = req.query.source || null

  let query = 'SELECT id, method, url, request_body, response_status, error, duration_ms, source, created_at FROM api_logs'
  const params = []

  if (source) {
    query += ' WHERE source LIKE ?'
    params.push(`%${source}%`)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const logs = await db.prepare(query).all(...params)
  const countQuery = source
    ? await db.prepare('SELECT COUNT(*) as total FROM api_logs WHERE source LIKE ?').get(`%${source}%`)
    : await db.prepare('SELECT COUNT(*) as total FROM api_logs').get()

  res.json({ logs, total: parseInt(countQuery.total), limit, offset })
})

router.get('/api-logs/:id', requireAuth, requireAdmin, async (req, res) => {
  const log = await db.prepare('SELECT * FROM api_logs WHERE id = ?').get(req.params.id)
  if (!log) return res.status(404).json({ error: 'Log not found' })
  res.json(log)
})

export default router
