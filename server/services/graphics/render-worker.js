// server/services/graphics/render-worker.js
//
// Drain loop for queued graphics_renders rows. Mirrors broll-search-worker.js
// — Postgres SELECT ... FOR UPDATE SKIP LOCKED concurrent claim, no Redis,
// no BullMQ. Stuck-running rows are reclaimed by a periodic sweep.
//
// Per iteration:
//   1. Claim ONE queued render
//   2. Opus: spec -> full HTML (specToHtml)
//   3. renderHtml -> local MP4
//   4. uploadRender -> Supabase signed URL
//   5. Atomic: mark render complete + flip session status

import path from 'node:path';
import db from '../../db.js';                          // default import
import { renderHtml } from './render-runner.js';
import { uploadRender } from './uploader.js';
import { callAnthropic } from '../../lib/llm/anthropic.js';
import { specToHtml } from './html-generator.js';
import { MODEL_FOR } from './models.js';
import { runCritic } from './critic/critic-runner.js';
import { buildRetryPrompt } from './retry-prompt.js';
import { concatScenes } from './scene-concat.js';
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

async function runSceneCriticLoop({ renderId, sessionId, sceneSpec, sceneIndex = null }) {
  const subDir = sceneIndex !== null ? `scene-${sceneIndex}` : null;
  let totalCost = 0;
  const { html: initialHtml, cost } = await specToHtml({ spec: sceneSpec });
  totalCost += cost;
  let currentHtml = initialHtml;
  let currentResult = await renderHtml({ html: currentHtml, renderId, subDir });
  emit({ sessionId, step: 'render_finished', label: `Render complete (iter 1)`, renderId, iteration: 1, sceneIndex })
  let currentUpload = await uploadRender({ renderId, sessionId, localPath: currentResult.outputPath });
  let bestAttempt = null;
  let iteration = 1;
  let totalDurationMs = currentResult.durationMs;

  while (iteration <= MAX_ITERATIONS) {
    const critique = await runCritic({
      renderId, iterationIndex: iteration, sceneIndex,
      mp4Path: currentResult.outputPath,
      durationSec: sceneSpec.duration || 5,
      spec: sceneSpec, sessionId,
    });
    emit({ sessionId, step: 'critic_scored', label: `Critic score ${critique.score.toFixed(2)} (iter ${iteration})`, renderId, iteration, score: critique.score, sceneIndex });
    const attempt = { iteration, score: critique.score, mp4Path: currentResult.outputPath, upload: currentUpload, durationMs: currentResult.durationMs };
    if (!bestAttempt || attempt.score > bestAttempt.score) bestAttempt = attempt;
    if (!critique.retry_recommended || critique.score >= SCORE_THRESHOLD) break;
    if (iteration >= MAX_ITERATIONS) break;

    emit({ sessionId, step: 'retry_triggered', label: `Refining (iter ${iteration + 1})`, renderId, sceneIndex });
    const retrySys = buildRetryPrompt({ priorCritique: critique, priorHtml: currentHtml });
    const retryResp = await callAnthropic({
      model: MODEL_FOR.create, system: retrySys,
      messages: [{ role: 'user', content: `Spec:\n${JSON.stringify(sceneSpec)}` }],
      max_tokens: 4096,
    });
    const retryHtml = retryResp.text.trim()
      .replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '').trim();
    if (!/data-composition-id\s*=\s*"main"/i.test(retryHtml)) {
      throw new Error('retry creator returned HTML missing data-composition-id="main"');
    }
    currentHtml = retryHtml;
    iteration += 1;
    currentResult = await renderHtml({ html: currentHtml, renderId, subDir });
    emit({ sessionId, step: 'render_finished', label: `Render complete (iter ${iteration})`, renderId, iteration, sceneIndex });
    totalDurationMs += currentResult.durationMs;
    currentUpload = await uploadRender({ renderId, sessionId, localPath: currentResult.outputPath });
  }

  return {
    bestMp4Path: bestAttempt.mp4Path,
    bestUpload: bestAttempt.upload,
    bestScore: bestAttempt.score,
    totalIterations: iteration,
    totalDurationMs,
    cost: totalCost,
  };
}

export async function drainOnce() {
  let processed = 0;
  const errors = [];
  let row;
  while ((row = await claimNextRender())) {
    try {
      emit({ sessionId: row.session_id, step: 'render_started', label: 'Rendering…', renderId: row.id, iteration: 1 });

      const spec = row.spec_snapshot_json;
      const isMultiScene = Array.isArray(spec.scenes) && spec.scenes.length > 0;

      if (isMultiScene) {
        const sceneResults = [];
        let aggregateCost = 0;
        for (let i = 0; i < spec.scenes.length; i++) {
          const sceneSpec = { ...spec, ...spec.scenes[i] };
          delete sceneSpec.scenes;
          const r = await runSceneCriticLoop({
            renderId: row.id, sessionId: row.session_id, sceneSpec, sceneIndex: i,
          });
          sceneResults.push(r);
          aggregateCost += r.cost;
        }
        const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders';
        const finalLocalPath = path.join(baseDir, String(row.id), 'final.mp4');
        await concatScenes({ sceneMp4Paths: sceneResults.map((r) => r.bestMp4Path), outputPath: finalLocalPath });
        const finalUpload = await uploadRender({ renderId: row.id, sessionId: row.session_id, localPath: finalLocalPath });
        const finalScore = Math.min(...sceneResults.map((r) => r.bestScore));
        const totalIters = sceneResults.reduce((s, r) => s + r.totalIterations, 0);
        const totalDuration = sceneResults.reduce((s, r) => s + r.totalDurationMs, 0);
        await db.transaction(async (tx) => {
          await tx.prepare(
            `UPDATE graphics_renders
             SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
                 iteration_count = ?, final_score = ?, scene_count = ?
             WHERE id = ?`
          ).run(finalUpload.url, totalDuration, aggregateCost, totalIters, finalScore, spec.scenes.length, row.id);
          await tx.prepare(`UPDATE graphics_sessions SET status = 'iterating' WHERE id = ?`).run(row.session_id);
        });
        emit({ sessionId: row.session_id, step: 'render_complete', label: 'Done', renderId: row.id, finalScore });
        processed += 1;
        continue;
      }

      // Single-scene path (back-compat)
      const r = await runSceneCriticLoop({
        renderId: row.id, sessionId: row.session_id, sceneSpec: spec, sceneIndex: null,
      });

      await db.transaction(async (tx) => {
        await tx.prepare(
          `UPDATE graphics_renders
           SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
               iteration_count = ?, final_score = ?
           WHERE id = ?`
        ).run(
          r.bestUpload.url, r.totalDurationMs, r.cost, r.totalIterations, r.bestScore, row.id
        );
        await tx.prepare(`UPDATE graphics_sessions SET status = 'iterating' WHERE id = ?`).run(row.session_id);
      });
      emit({ sessionId: row.session_id, step: 'render_complete', label: 'Done', renderId: row.id, finalScore: r.bestScore });
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
