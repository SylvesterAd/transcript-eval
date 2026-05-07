// server/services/graphics/orchestrator.js
import db from '../../db.js';
import { callGemini } from '../../lib/llm/gemini.js';
import { MODEL_FOR, costCents } from './models.js';
import { BRIEF_SYSTEM_PROMPT } from './brief-prompt.js';
import { mergeSpec, isSpecComplete } from './session-state.js';

const SPEC_BLOCK = /\[SPEC\]\s*(\{[^}]*\})/m;

function extractSpec(text) {
  const m = text.match(SPEC_BLOCK);
  if (!m) return {};
  try {
    return JSON.parse(m[1]);
  } catch {
    return {};
  }
}

function stripSpecBlock(text) {
  return text.replace(SPEC_BLOCK, '').trim();
}

async function loadSession(sessionId) {
  return await db.prepare('SELECT id, spec_json, status FROM graphics_sessions WHERE id = ?').get(sessionId);
}

async function loadHistory(sessionId, limit = 50) {
  const rows = await db
    .prepare('SELECT role, content FROM graphics_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?')
    .all(sessionId, limit);
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

export async function runChatTurn({ sessionId, userMessage }) {
  const session = await loadSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);

  // Persist user message
  await db.prepare(
    'INSERT INTO graphics_messages (session_id, role, content) VALUES (?, ?, ?)'
  ).run(sessionId, 'user', userMessage);

  const history = await loadHistory(sessionId);
  history.push({ role: 'user', content: userMessage });

  // Brief phase
  const briefResp = await callGemini({
    model: MODEL_FOR.brief,
    system: BRIEF_SYSTEM_PROMPT,
    messages: history,
    thinkingLevel: 'low',
  });
  const specUpdate = extractSpec(briefResp.text);
  const visibleText = stripSpecBlock(briefResp.text);

  const cost = costCents(MODEL_FOR.brief, briefResp.tokens);
  await db.prepare(
    `INSERT INTO graphics_messages
     (session_id, role, content, model_used, tokens_in, tokens_out, cost_cents)
     VALUES (?, 'assistant', ?, ?, ?, ?, ?)`
  ).run(sessionId, visibleText, MODEL_FOR.brief, briefResp.tokens.in, briefResp.tokens.out, cost);

  const newSpec = mergeSpec(session.spec_json || {}, specUpdate);
  await db.prepare(
    'UPDATE graphics_sessions SET spec_json = ?, updated_at = NOW() WHERE id = ?'
  ).run(JSON.stringify(newSpec), sessionId);

  // Enqueue render if spec is complete
  let renderId = null;
  if (isSpecComplete(newSpec) && session.status === 'briefing') {
    const iteration = 1;
    const inserted = await db
      .prepare(
        `INSERT INTO graphics_renders (session_id, iteration, spec_snapshot_json, template, status)
         VALUES (?, ?, ?, ?, 'queued') RETURNING id`
      )
      .get(sessionId, iteration, JSON.stringify(newSpec), newSpec.template);
    renderId = inserted.id;
    await db.prepare("UPDATE graphics_sessions SET status = 'rendering' WHERE id = ?").run(sessionId);
  }

  return {
    assistantText: visibleText,
    specUpdate,
    newSpec,
    renderId,
    cost,
  };
}
