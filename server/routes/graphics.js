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
      `SELECT id, iteration, status, output_url, preview_url, duration_ms, cost_cents,
              iteration_count, final_score, parent_render_id, human_feedback, created_at
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

// GET /api/graphics/renders/:id/iterations
router.get('/renders/:id/iterations', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const owner = await db
    .prepare(
      `SELECT r.id FROM graphics_renders r
       JOIN graphics_sessions s ON s.id = r.session_id
       WHERE r.id = ? AND s.user_id = ?`
    )
    .get(id, req.auth.userId);
  if (!owner) return res.status(404).json({ error: 'not found' });
  const rows = await db
    .prepare(
      `SELECT id, render_id, iteration_index, frame_urls_json,
              critic_score, critic_criteria_json, critic_feedback, created_at
       FROM graphics_render_iterations
       WHERE render_id = ?
       ORDER BY iteration_index ASC`
    )
    .all(id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      render_id: r.render_id,
      iteration_index: r.iteration_index,
      frame_urls: typeof r.frame_urls_json === 'string' ? JSON.parse(r.frame_urls_json) : r.frame_urls_json || [],
      critic_score: r.critic_score,
      critic_criteria: typeof r.critic_criteria_json === 'string' ? JSON.parse(r.critic_criteria_json) : r.critic_criteria_json,
      critic_feedback: r.critic_feedback,
      created_at: r.created_at,
    }))
  );
});

export default router;
