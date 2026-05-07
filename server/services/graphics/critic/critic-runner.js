// server/services/graphics/critic/critic-runner.js
//
// Orchestrates the per-iteration critic loop:
//   1. Extract N frames from the rendered MP4
//   2. Upload frames to Supabase
//   3. Call VLM evaluator
//   4. Persist iteration row
//   5. Return critique + retry decision

import path from 'node:path'
import db from '../../../db.js'
import { extractFrames } from './frame-extractor.js'
import { evaluateFrames } from './evaluator.js'
import { uploadFrames } from '../uploader.js'

const FRAME_COUNT = 4

export async function runCritic({ renderId, iterationIndex, mp4Path, durationSec, spec, sessionId }) {
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders'
  const frameDir = path.join(baseDir, String(renderId), `iter-${iterationIndex}-frames`)

  const localFramePaths = await extractFrames({
    mp4Path,
    durationSec,
    count: FRAME_COUNT,
    outDir: frameDir,
  })
  const frameUrls = await uploadFrames({ renderId, iterationIndex, framePaths: localFramePaths })
  const critique = await evaluateFrames({ framePaths: localFramePaths, spec })

  await db.prepare(
    `INSERT INTO graphics_render_iterations
       (render_id, iteration_index, mp4_path, frame_urls_json, critic_score, critic_criteria_json, critic_feedback)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    renderId,
    iterationIndex,
    mp4Path,
    JSON.stringify(frameUrls),
    critique.score,
    JSON.stringify(critique.criteria),
    critique.feedback
  )

  return {
    score: critique.score,
    criteria: critique.criteria,
    feedback: critique.feedback,
    retry_recommended: critique.retry_recommended,
    frameUrls,
    tokens: critique.tokens,
  }
}
