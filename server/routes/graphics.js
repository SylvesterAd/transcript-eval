import { Router } from 'express';
import db from '../db.js';
import { requireAuth, isAdmin } from '../auth.js';
import { runChatTurn } from '../services/graphics/orchestrator.js';

const router = Router();

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
}

router.use(requireAuth);
router.use(requireAdmin);

// POST /api/graphics/sessions
router.post('/sessions', async (req, res) => {
  const title = (req.body?.title || 'New graphic').slice(0, 200);
  const inserted = await db
    .prepare(
      `INSERT INTO graphics_sessions (user_id, user_email, title)
       VALUES (?, ?, ?)
       RETURNING id, title, spec_json, status, created_at`
    )
    .get(req.auth.userId, req.auth.email || '', title);
  res.status(201).json(inserted);
});

// GET /api/graphics/sessions
router.get('/sessions', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT id, title, status, spec_json, created_at, updated_at
       FROM graphics_sessions
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .all(req.auth.userId);
  res.json(rows);
});

// GET /api/graphics/sessions/:id
router.get('/sessions/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const session = await db
    .prepare(`SELECT * FROM graphics_sessions WHERE id = ? AND user_id = ?`)
    .get(id, req.auth.userId);
  if (!session) return res.status(404).json({ error: 'not found' });
  const messages = await db
    .prepare(
      `SELECT id, role, content, model_used, tokens_in, tokens_out, cost_cents, created_at
       FROM graphics_messages WHERE session_id = ? ORDER BY created_at ASC`
    )
    .all(id);
  const renders = await db
    .prepare(
      `SELECT id, iteration, status, output_url, preview_url, duration_ms, cost_cents, created_at
       FROM graphics_renders WHERE session_id = ? ORDER BY iteration ASC`
    )
    .all(id);
  res.json({ session, messages, renders });
});

// POST /api/graphics/sessions/:id/messages
router.post('/sessions/:id/messages', async (req, res) => {
  const id = Number(req.params.id);
  const message = (req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  const session = await db
    .prepare(`SELECT id FROM graphics_sessions WHERE id = ? AND user_id = ?`)
    .get(id, req.auth.userId);
  if (!session) return res.status(404).json({ error: 'not found' });

  try {
    const result = await runChatTurn({ sessionId: id, userMessage: message });
    res.json(result);
  } catch (e) {
    console.error('[graphics] chat turn failed', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/graphics/renders/:id
router.get('/renders/:id', async (req, res) => {
  const id = Number(req.params.id);
  const render = await db
    .prepare(
      `SELECT r.* FROM graphics_renders r
       JOIN graphics_sessions s ON s.id = r.session_id
       WHERE r.id = ? AND s.user_id = ?`
    )
    .get(id, req.auth.userId);
  if (!render) return res.status(404).json({ error: 'not found' });
  res.json(render);
});

export default router;
