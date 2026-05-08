// server/services/graphics/critic/critic-runner.js
//
// Orchestrates the per-iteration critic loop:
//   - Single-scene specs: extract N frames spanning the whole MP4, run one critic call.
//   - Multi-scene specs: loop scenes, extract N frames per scene window
//     (using cumulative spec.scenes[i].duration as boundaries), run one critic
//     call per scene, aggregate score = min(scores), feedback = "Scene N: ...",
//     retry_recommended = any(scene.retry_recommended).
//
// One iteration row is persisted per call; scene-level criteria stored under
// keys `scene_1`, `scene_2`, ... in the criteria_json.

import path from 'node:path'
import db from '../../../db.js'
import { extractFrames } from './frame-extractor.js'
import { evaluateFrames } from './evaluator.js'
import { uploadFrames } from '../uploader.js'
import { emit } from '../events/emitter.js'

const FRAMES_PER_SCENE = 4

export async function runCritic({ renderId, iterationIndex, mp4Path, durationSec, spec, sessionId }) {
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders'
  const isMultiScene = Array.isArray(spec.scenes) && spec.scenes.length > 0

  if (!isMultiScene) {
    const frameDir = path.join(baseDir, String(renderId), `iter-${iterationIndex}-frames`)
    const localFramePaths = await extractFrames({
      mp4Path, durationSec, count: FRAMES_PER_SCENE, outDir: frameDir,
    })
    emit({ sessionId, step: 'frames_captured', label: 'Frames captured', renderId, iteration: iterationIndex })
    const frameUrls = await uploadFrames({ renderId, iterationIndex, framePaths: localFramePaths })
    const critique = await evaluateFrames({ framePaths: localFramePaths, spec })

    await db.prepare(
      `INSERT INTO graphics_render_iterations
         (render_id, iteration_index, mp4_path, frame_urls_json, critic_score, critic_criteria_json, critic_feedback)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      renderId, iterationIndex, mp4Path,
      JSON.stringify(frameUrls), critique.score,
      JSON.stringify(critique.criteria), critique.feedback
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

  // Multi-scene: per-scene frame extraction + per-scene critic + aggregate
  const sceneCritiques = []
  const allFrameUrls = []
  const totalTokens = { in: 0, out: 0 }
  let cumulativeStart = 0

  for (let i = 0; i < spec.scenes.length; i++) {
    const sceneSpec = spec.scenes[i]
    const sceneStart = cumulativeStart
    const sceneEnd = cumulativeStart + sceneSpec.duration
    const sceneFrameDir = path.join(baseDir, String(renderId), `iter-${iterationIndex}-scene-${i}-frames`)
    const sceneFramePaths = await extractFrames({
      mp4Path,
      durationSec: sceneSpec.duration,
      startSec: sceneStart,
      endSec: sceneEnd,
      count: FRAMES_PER_SCENE,
      outDir: sceneFrameDir,
    })
    emit({
      sessionId, step: 'frames_captured',
      label: `Frames captured (scene ${i + 1})`,
      renderId, iteration: iterationIndex, sceneIndex: i,
    })
    const sceneFrameUrls = await uploadFrames({
      renderId, iterationIndex, framePaths: sceneFramePaths, sceneIndex: i,
    })
    const sceneCritique = await evaluateFrames({
      framePaths: sceneFramePaths,
      spec: { ...sceneSpec, aspectRatio: spec.aspectRatio, tone: spec.tone },
    })
    sceneCritiques.push({ index: i, ...sceneCritique })
    allFrameUrls.push(...sceneFrameUrls)
    totalTokens.in += sceneCritique.tokens?.in ?? 0
    totalTokens.out += sceneCritique.tokens?.out ?? 0
    cumulativeStart = sceneEnd
  }

  const aggregateScore = Math.min(...sceneCritiques.map((c) => c.score))
  const aggregateFeedback = sceneCritiques
    .map((c) => `Scene ${c.index + 1}: ${c.feedback}`)
    .join('\n')
  const aggregateRetry = sceneCritiques.some((c) => c.retry_recommended)
  const aggregateCriteria = sceneCritiques.reduce((acc, c) => {
    acc[`scene_${c.index + 1}`] = c.criteria
    return acc
  }, {})

  await db.prepare(
    `INSERT INTO graphics_render_iterations
       (render_id, iteration_index, mp4_path, frame_urls_json, critic_score, critic_criteria_json, critic_feedback)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    renderId, iterationIndex, mp4Path,
    JSON.stringify(allFrameUrls), aggregateScore,
    JSON.stringify(aggregateCriteria), aggregateFeedback
  )

  return {
    score: aggregateScore,
    criteria: aggregateCriteria,
    feedback: aggregateFeedback,
    retry_recommended: aggregateRetry,
    frameUrls: allFrameUrls,
    tokens: totalTokens,
  }
}
