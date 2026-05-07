// server/services/graphics/render-worker.js
//
// Drain loop for queued graphics_renders rows. Mirrors broll-search-worker.js
// — Postgres SELECT ... FOR UPDATE SKIP LOCKED concurrent claim, no Redis,
// no BullMQ. Stuck-running rows are reclaimed by a periodic sweep.
//
// Per iteration:
//   1. Claim ONE queued render
//   2. Opus: spec -> template variables JSON
//   3. renderTemplate (Task 7) -> local MP4
//   4. uploadRender -> Supabase signed URL
//   5. Atomic: mark render complete + flip session status

import db from '../../db.js';                          // default import
import { renderTemplate } from './render-runner.js';
import { uploadRender } from './uploader.js';
import { callAnthropic } from '../../lib/llm/anthropic.js';
import { MODEL_FOR, costCents } from './models.js';
import { CREATE_SYSTEM_PROMPT } from './create-prompt.js';
import { runCritic } from './critic/critic-runner.js';
import { buildRetryPrompt } from './retry-prompt.js';
import { emit } from './events/emitter.js';

const POLL_INTERVAL_MS = 2000;
const STUCK_AFTER_MS = 10 * 60 * 1000;
const MAX_ITERATIONS = 3;       // initial + 2 retries
const SCORE_THRESHOLD = 0.7;
let running = false;

async function claimNextRender() {
  return await db
    .prepare(
      `UPDATE graphics_renders
       SET status = 'running'
       WHERE id = (
         SELECT id FROM graphics_renders
         WHERE status = 'queued'
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, session_id, iteration, spec_snapshot_json, template`
    )
    .get();
}

async function specToVars(spec) {
  const r = await callAnthropic({
    model: MODEL_FOR.create,
    system: CREATE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Spec:\n${JSON.stringify(spec)}` }],
    max_tokens: 1024,
  });
  const cost = costCents(MODEL_FOR.create, r.tokens);
  // Defensively strip markdown fences in case Opus wraps output despite the prompt
  const text = r.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
  let vars;
  try {
    vars = JSON.parse(text);
  } catch (e) {
    throw new Error(`creator returned invalid JSON: ${r.text.slice(0, 200)}`);
  }
  return { vars, cost };
}

export async function drainOnce() {
  let processed = 0;
  const errors = [];
  let row;
  while ((row = await claimNextRender())) {
    try {
      emit({ sessionId: row.session_id, step: 'render_started', label: 'Rendering…', renderId: row.id, iteration: 1 })
      const { vars: initialVars, cost } = await specToVars(row.spec_snapshot_json);
      let currentVars = initialVars;
      let currentResult = await renderTemplate({ template: row.template, vars: currentVars, renderId: row.id });
      emit({ sessionId: row.session_id, step: 'render_finished', label: `Render complete (iter 1)`, renderId: row.id, iteration: 1 })
      let currentUpload = await uploadRender({
        renderId: row.id, sessionId: row.session_id, localPath: currentResult.outputPath,
      });

      let bestAttempt = null;
      let iteration = 1;

      while (iteration <= MAX_ITERATIONS) {
        const critique = await runCritic({
          renderId: row.id,
          iterationIndex: iteration,
          mp4Path: currentResult.outputPath,
          durationSec: row.spec_snapshot_json.duration || 5,
          spec: row.spec_snapshot_json,
          sessionId: row.session_id,
        });

        emit({ sessionId: row.session_id, step: 'critic_scored', label: `Critic score ${critique.score.toFixed(2)} (iter ${iteration})`, renderId: row.id, iteration, score: critique.score })
        const attempt = {
          iteration,
          score: critique.score,
          upload: currentUpload,
          durationMs: currentResult.durationMs,
        };
        if (!bestAttempt || attempt.score > bestAttempt.score) bestAttempt = attempt;

        // Ship if quality is acceptable
        if (!critique.retry_recommended || critique.score >= SCORE_THRESHOLD) break;
        // Budget exhausted
        if (iteration >= MAX_ITERATIONS) break;

        // Retry: build new vars from critique feedback
        emit({ sessionId: row.session_id, step: 'retry_triggered', label: `Refining (iter ${iteration + 1})`, renderId: row.id })
        const retrySys = buildRetryPrompt({ priorCritique: critique, priorVars: currentVars });
        const retryResp = await callAnthropic({
          model: MODEL_FOR.create,
          system: retrySys,
          messages: [{ role: 'user', content: `Spec:\n${JSON.stringify(row.spec_snapshot_json)}` }],
          max_tokens: 1024,
        });
        const retryText = retryResp.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
        currentVars = JSON.parse(retryText);
        iteration += 1;
        currentResult = await renderTemplate({ template: row.template, vars: currentVars, renderId: row.id });
        emit({ sessionId: row.session_id, step: 'render_finished', label: `Render complete (iter ${iteration})`, renderId: row.id, iteration })
        currentUpload = await uploadRender({
          renderId: row.id, sessionId: row.session_id, localPath: currentResult.outputPath,
        });
      }

      // Wrap completion writes in a transaction for atomicity
      await db.transaction(async (tx) => {
        await tx
          .prepare(
            `UPDATE graphics_renders
             SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
                 iteration_count = ?, final_score = ?
             WHERE id = ?`
          )
          .run(
            bestAttempt.upload.url,
            bestAttempt.durationMs,
            cost,
            iteration,
            bestAttempt.score,
            row.id
          );
        await tx
          .prepare(`UPDATE graphics_sessions SET status = 'iterating' WHERE id = ?`)
          .run(row.session_id);
      });
      emit({ sessionId: row.session_id, step: 'render_complete', label: 'Done', renderId: row.id, finalScore: bestAttempt.score })
      processed += 1;
    } catch (e) {
      errors.push({ renderId: row.id, error: e.message });
      // Best-effort failure flag — outside the transaction so it always runs
      try {
        await db
          .prepare(`UPDATE graphics_renders SET status = 'failed', error_message = ? WHERE id = ?`)
          .run(e.message.slice(0, 500), row.id);
      } catch (markErr) {
        console.error('[graphics-worker] failed to mark render failed', row.id, markErr);
      }
    }
  }
  return { processed, errors };
}

async function reclaimStuck() {
  // NOTE: graphics_renders has only created_at — no claimed_at/started_at column.
  // We compare against created_at, which is OK for low-throughput MVP because
  // queued renders are picked up within seconds. A long-queued + briefly-running
  // row could be falsely reclaimed if the queue ever backs up beyond 10 min.
  // Phase 2: add a started_at column and compare against that.
  await db
    .prepare(
      `UPDATE graphics_renders
       SET status = 'queued'
       WHERE status = 'running'
         AND created_at < NOW() - INTERVAL '${Math.floor(STUCK_AFTER_MS / 1000)} seconds'`
    )
    .run();
}

export async function startWorker() {
  if (running) return;
  running = true;
  console.log('[graphics-worker] starting drain loop');
  while (running) {
    try {
      await reclaimStuck();
      await drainOnce();
    } catch (e) {
      console.error('[graphics-worker] iteration failed', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export function stopWorker() {
  running = false;
}
