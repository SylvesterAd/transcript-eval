// server/services/graphics/render-worker.js
//
// Drain loop for queued graphics_renders rows. Mirrors broll-search-worker.js
// — Postgres SELECT ... FOR UPDATE SKIP LOCKED concurrent claim.
//
// Per iteration (single flow always — multi-scene is handled INSIDE one HTML composition):
//   1. Claim ONE queued render
//   2. Generate single HTML covering all scenes (specToHtml + lint gate)
//   3. renderHtml -> local MP4
//   4. uploadRender -> Supabase signed URL
//   5. runCritic -> score + scene-scoped feedback (per-scene sampling internally)
//   6. If score low, refineHtml + re-render + re-critic (max MAX_ITERATIONS)
//   7. Atomic: mark render complete + flip session status

import path from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import db from '../../db.js'
import { renderHtml } from './render-runner.js'
import { uploadRender } from './uploader.js'
import { specToHtml, refineHtml } from './html-generator.js'
import { runCritic } from './critic/critic-runner.js'
import { runLint, formatFindingsForPrompt } from './lint-runner.js'
import { emit } from './events/emitter.js'

const POLL_INTERVAL_MS = 2000
const STUCK_AFTER_MS = 10 * 60 * 1000
const MAX_ITERATIONS = 3
const SCORE_THRESHOLD = 0.7
let running = false

function totalSpecDuration(spec) {
  if (Array.isArray(spec.scenes) && spec.scenes.length > 0) {
    return spec.scenes.reduce((sum, s) => sum + (s.duration ?? 0), 0)
  }
  return spec.duration ?? 0
}

async function generateHtmlWithLintGate({ spec, renderId }) {
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders'
  const htmlDir = path.join(baseDir, String(renderId))
  await mkdir(htmlDir, { recursive: true })
  const lintProjectDir = path.join(htmlDir, 'lint')
  await mkdir(lintProjectDir, { recursive: true })
  const htmlPath = path.join(lintProjectDir, 'index.html')

  const first = await specToHtml({ spec })
  let html = first.html
  let cost = first.cost
  let tokens = first.tokens
  await writeFile(htmlPath, html, 'utf8')

  let lint = await runLint({ projectDir: lintProjectDir })
  if (lint.errorCount === 0) return { html, cost, tokens, lintFindings: lint.findings }

  const feedback = formatFindingsForPrompt(lint.findings)
  const retry = await specToHtml({ spec, additionalSystemContext: feedback })
  html = retry.html
  cost += retry.cost
  tokens = { in: tokens.in + retry.tokens.in, out: tokens.out + retry.tokens.out }
  await writeFile(htmlPath, html, 'utf8')

  lint = await runLint({ projectDir: lintProjectDir })
  if (lint.errorCount > 0) {
    throw new Error(`lint failed after 1 retry: ${formatFindingsForPrompt(lint.findings)}`)
  }
  return { html, cost, tokens, lintFindings: lint.findings }
}

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
       RETURNING id, session_id, iteration, spec_snapshot_json, template, parent_render_id, human_feedback`
    )
    .get()
}

// Scene-agnostic loop: spec (single or multi-scene) is passed intact to runCritic,
// which handles per-scene frame sampling + aggregation internally.
async function runCriticLoop({ renderId, sessionId, spec, parentRenderId = null, humanFeedback = null }) {
  let totalCost = 0
  let initialHtml

  if (parentRenderId) {
    const parent = await db
      .prepare(`SELECT final_html_text FROM graphics_renders WHERE id = ?`)
      .get(parentRenderId)
    if (!parent || !parent.final_html_text) {
      throw new Error(`parent render ${parentRenderId} missing final_html_text`)
    }
    if (!humanFeedback) {
      throw new Error(`render ${renderId} has parent_render_id but no human_feedback`)
    }
    const refined = await refineHtml({ html: parent.final_html_text, feedback: humanFeedback, spec })
    initialHtml = refined.html
    totalCost += refined.cost
    // Lint once on the refined HTML — no retry on this path. If the LLM produced
    // broken HTML for human feedback, surface the error rather than synthesizing.
    const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders'
    const lintProjectDir = path.join(baseDir, String(renderId), 'lint')
    await mkdir(lintProjectDir, { recursive: true })
    await writeFile(path.join(lintProjectDir, 'index.html'), initialHtml, 'utf8')
    const lint = await runLint({ projectDir: lintProjectDir })
    if (lint.errorCount > 0) {
      throw new Error(`refined HTML failed lint: ${formatFindingsForPrompt(lint.findings)}`)
    }
  } else {
    const fresh = await generateHtmlWithLintGate({ spec, renderId })
    initialHtml = fresh.html
    totalCost += fresh.cost
  }

  let currentHtml = initialHtml
  let currentResult = await renderHtml({ html: currentHtml, renderId })
  emit({ sessionId, step: 'render_finished', label: `Render complete (iter 1)`, renderId, iteration: 1 })
  let currentUpload = await uploadRender({ renderId, sessionId, localPath: currentResult.outputPath })
  let bestAttempt = null
  let iteration = 1
  let totalDurationMs = currentResult.durationMs

  while (iteration <= MAX_ITERATIONS) {
    const critique = await runCritic({
      renderId, iterationIndex: iteration,
      mp4Path: currentResult.outputPath,
      durationSec: totalSpecDuration(spec),
      spec, sessionId,
    })
    emit({ sessionId, step: 'critic_scored', label: `Critic score ${critique.score.toFixed(2)} (iter ${iteration})`, renderId, iteration, score: critique.score })
    const attempt = { iteration, score: critique.score, mp4Path: currentResult.outputPath, upload: currentUpload, durationMs: currentResult.durationMs, html: currentHtml }
    if (!bestAttempt || attempt.score > bestAttempt.score) bestAttempt = attempt
    if (!critique.retry_recommended || critique.score >= SCORE_THRESHOLD) break
    if (iteration >= MAX_ITERATIONS) break

    emit({ sessionId, step: 'retry_triggered', label: `Refining (iter ${iteration + 1})`, renderId })
    const refineRes = await refineHtml({ html: currentHtml, feedback: critique.feedback, spec })
    currentHtml = refineRes.html
    totalCost += refineRes.cost
    iteration += 1
    currentResult = await renderHtml({ html: currentHtml, renderId })
    emit({ sessionId, step: 'render_finished', label: `Render complete (iter ${iteration})`, renderId, iteration })
    totalDurationMs += currentResult.durationMs
    currentUpload = await uploadRender({ renderId, sessionId, localPath: currentResult.outputPath })
  }

  return {
    bestMp4Path: bestAttempt.mp4Path,
    bestUpload: bestAttempt.upload,
    bestScore: bestAttempt.score,
    bestHtml: bestAttempt.html,
    totalIterations: iteration,
    totalDurationMs,
    cost: totalCost,
  }
}

export async function drainOnce() {
  let processed = 0
  const errors = []
  let row
  while ((row = await claimNextRender())) {
    try {
      emit({ sessionId: row.session_id, step: 'render_started', label: 'Rendering…', renderId: row.id, iteration: 1 })
      const spec = row.spec_snapshot_json
      const r = await runCriticLoop({
        renderId: row.id,
        sessionId: row.session_id,
        spec,
        parentRenderId: row.parent_render_id ?? null,
        humanFeedback: row.human_feedback ?? null,
      })
      const sceneCount = Array.isArray(spec.scenes) && spec.scenes.length > 0 ? spec.scenes.length : 1
      await db.transaction(async (tx) => {
        await tx.prepare(
          `UPDATE graphics_renders
           SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
               iteration_count = ?, final_score = ?, scene_count = ?, final_html_text = ?
           WHERE id = ?`
        ).run(r.bestUpload.url, r.totalDurationMs, r.cost, r.totalIterations, r.bestScore, sceneCount, r.bestHtml, row.id)
        await tx.prepare(`UPDATE graphics_sessions SET status = 'iterating' WHERE id = ?`).run(row.session_id)
      })
      emit({ sessionId: row.session_id, step: 'render_complete', label: 'Done', renderId: row.id, finalScore: r.bestScore })
      processed += 1
    } catch (e) {
      errors.push({ renderId: row.id, error: e.message })
      try {
        await db.transaction(async (tx) => {
          await tx.prepare(`UPDATE graphics_renders SET status = 'failed', error_message = ? WHERE id = ?`)
            .run(e.message.slice(0, 500), row.id)
          // Unstick the session regardless of whether this was an initial
          // render or an iteration. If left in 'rendering', the chat UI is
          // dead and the user can't recover. Iterations flip back to
          // 'iterating' (a completed parent still exists); initial-render
          // failures flip back to 'briefing' so the user can chat again.
          const nextSessionStatus = row.parent_render_id ? 'iterating' : 'briefing'
          await tx.prepare(`UPDATE graphics_sessions SET status = ? WHERE id = ?`)
            .run(nextSessionStatus, row.session_id)
        })
        emit({
          sessionId: row.session_id,
          step: 'render_failed',
          label: 'Render failed',
          renderId: row.id,
          error: e.message.slice(0, 200),
        })
      } catch (markErr) {
        console.error('[graphics-worker] failed to mark render failed', row.id, markErr)
      }
    }
  }
  return { processed, errors }
}

async function reclaimStuck() {
  await db
    .prepare(
      `UPDATE graphics_renders
       SET status = 'queued'
       WHERE status = 'running'
         AND created_at < NOW() - INTERVAL '${Math.floor(STUCK_AFTER_MS / 1000)} seconds'`
    )
    .run()
}

export async function startWorker() {
  if (running) return
  running = true
  console.log('[graphics-worker] starting drain loop')
  while (running) {
    try {
      await reclaimStuck()
      await drainOnce()
    } catch (e) {
      console.error('[graphics-worker] iteration failed', e)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

export function stopWorker() {
  running = false
}
