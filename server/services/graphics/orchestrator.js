// server/services/graphics/orchestrator.js
import db from '../../db.js';
import { callGemini } from '../../lib/llm/gemini.js';
import { MODEL_FOR, costCents } from './models.js';
import { BRIEF_SYSTEM_PROMPT } from './brief-prompt.js';
import { mergeSpec, isSpecComplete } from './session-state.js';
import { emit } from './events/emitter.js';

const SPEC_BLOCK = /\[SPEC\]\s*(\{[^}]*\})/m;

const MAX_ITERATIONS_PER_SESSION = parseInt(process.env.GRAPHICS_MAX_ITERATIONS_PER_SESSION || '10', 10);
const ACK_TEXT = 'Refining…';

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

// Bug 2 fix: load most recent 50, then reverse for chronological order
async function loadHistory(sessionId, limit = 50) {
  const rows = await db
    .prepare('SELECT role, content FROM graphics_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(sessionId, limit);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

export async function runChatTurn({ sessionId, userMessage }) {
  // Reads stay outside the transaction (no long-running lock needed)
  const session = await loadSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);

  if (session.status === 'iterating') {
    // Find latest complete parent
    const parent = await db.prepare(
      `SELECT id, iteration, template, spec_snapshot_json, final_html_text
       FROM graphics_renders
       WHERE session_id = ? AND status = 'complete'
       ORDER BY iteration DESC
       LIMIT 1`
    ).get(sessionId);
    if (!parent) {
      throw new Error(`session ${sessionId} status='iterating' but no complete render exists`);
    }
    if (!parent.final_html_text) {
      throw new Error(`parent render ${parent.id} missing final_html_text`);
    }

    const renderId = await db.transaction(async (tx) => {
      await tx.prepare(
        `INSERT INTO graphics_messages (session_id, role, content) VALUES (?, ?, ?)`
      ).run(sessionId, 'user', userMessage);
      await tx.prepare(
        `INSERT INTO graphics_messages (session_id, role, content) VALUES (?, ?, ?)`
      ).run(sessionId, 'assistant', ACK_TEXT);
      const inserted = await tx.prepare(
        `INSERT INTO graphics_renders
          (session_id, iteration, spec_snapshot_json, template, status,
           parent_render_id, human_feedback)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)
         RETURNING id`
      ).get(
        sessionId,
        parent.iteration + 1,
        typeof parent.spec_snapshot_json === 'string'
          ? parent.spec_snapshot_json
          : JSON.stringify(parent.spec_snapshot_json),
        parent.template,
        parent.id,
        userMessage,
      );
      await tx.prepare(`UPDATE graphics_sessions SET status = 'rendering' WHERE id = ?`).run(sessionId);
      return inserted.id;
    });

    emit({ sessionId, step: 'render_queued', label: 'Refine queued', renderId });
    return { assistantText: ACK_TEXT, specUpdate: {}, newSpec: session.spec_json || {}, renderId, cost: 0 };
  }

  // Bug 1 fix: load history BEFORE inserting user message, then push in-memory
  const history = await loadHistory(sessionId);
  history.push({ role: 'user', content: userMessage });

  // LLM call stays outside the transaction (long network call must not hold a connection)
  emit({ sessionId, step: 'brief_thinking', label: 'Thinking…' })
  const briefResp = await callGemini({
    model: MODEL_FOR.brief,
    system: BRIEF_SYSTEM_PROMPT,
    messages: history,
    thinkingLevel: 'low',
    tools: [{ googleSearch: {} }],
  });
  emit({ sessionId, step: 'brief_replied', label: 'Reply received' })
  const specUpdate = extractSpec(briefResp.text);
  const visibleText = stripSpecBlock(briefResp.text);

  // Minor 7: fallback for empty visibleText (e.g. reply is only a [SPEC] block)
  const safeText = visibleText || '(updating…)';

  const cost = costCents(MODEL_FOR.brief, briefResp.tokens);
  const newSpec = mergeSpec(session.spec_json || {}, specUpdate);

  // Bug 3 fix: wrap all writes in a single atomic transaction
  const renderId = await db.transaction(async (tx) => {
    // INSERT user message (moved inside tx — was previously before loadHistory)
    await tx.prepare(
      'INSERT INTO graphics_messages (session_id, role, content) VALUES (?, ?, ?)'
    ).run(sessionId, 'user', userMessage);

    // INSERT assistant message
    await tx.prepare(
      `INSERT INTO graphics_messages
       (session_id, role, content, model_used, tokens_in, tokens_out, cost_cents)
       VALUES (?, 'assistant', ?, ?, ?, ?, ?)`
    ).run(sessionId, safeText, MODEL_FOR.brief, briefResp.tokens.in, briefResp.tokens.out, cost);

    // UPDATE spec_json on session
    await tx.prepare(
      'UPDATE graphics_sessions SET spec_json = ?, updated_at = NOW() WHERE id = ?'
    ).run(JSON.stringify(newSpec), sessionId);

    // Enqueue render if spec is complete and session is still in briefing state
    if (isSpecComplete(newSpec) && session.status === 'briefing') {
      const iteration = 1;
      const inserted = await tx
        .prepare(
          `INSERT INTO graphics_renders (session_id, iteration, spec_snapshot_json, template, status)
           VALUES (?, ?, ?, ?, 'queued') RETURNING id`
        )
        .get(sessionId, iteration, JSON.stringify(newSpec), newSpec.template);
      await tx.prepare("UPDATE graphics_sessions SET status = 'rendering' WHERE id = ?").run(sessionId);
      return inserted.id;
    }

    return null;
  });

  if (renderId) emit({ sessionId, step: 'render_queued', label: 'Render queued', renderId })

  return {
    assistantText: safeText,
    specUpdate,
    newSpec,
    renderId,
    cost,
  };
}
