import { Router } from 'express'
import db from '../db.js'
import { requireAuth, isAdmin, verifyTokenString } from '../auth.js'
import { subscribe } from '../services/graphics/events/emitter.js'

const router = Router()

// EventSource can't send headers, so accept JWT via ?token=...
async function queryParamAuth(req, _res, next) {
  if (req.auth) return next()
  const token = req.query?.token
  if (token) {
    const auth = await verifyTokenString(String(token))
    if (auth) req.auth = auth
  }
  next()
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
  next()
}

router.use(queryParamAuth)
router.use(requireAuth)
router.use(requireAdmin)

router.get('/sessions/:id/events', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' })

  // Ownership check
  const session = await db
    .prepare(`SELECT id FROM graphics_sessions WHERE id = ? AND user_id = ?`)
    .get(id, req.auth.userId)
  if (!session) return res.status(404).json({ error: 'not found' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  res.write(`event: open\ndata: {"sessionId":${id}}\n\n`)

  const unsub = subscribe(id, (event) => {
    res.write(`event: ${event.step}\ndata: ${JSON.stringify(event)}\n\n`)
  })

  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`)
  }, 25000)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsub()
  })
})

export default router
