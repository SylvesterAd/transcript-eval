// Server-side automation orchestrator. Used by maybeAutoClassify (Full Auto)
// and the manual /confirm-classification route handler. Keeps the splitting
// + propagation logic in one place so Full Auto and the manual click path
// stay in lockstep.
//
// confirmClassificationGroup — splits a parent video_group into sub-groups
// per the LLM classifier output, propagating auto_rough_cut + path_id and
// copying broll_example_sources rows so sub-group b-roll endpoints find
// references at the right level.
//
// chainAfterClassify — called by maybeAutoClassify after classification
// finishes. For path_id='hands-off' projects, it auto-confirms the
// classification so the user doesn't have to click anything.

import db from '../db.js'
import { analyzeMulticam } from './multicam-sync.js'
import { pathToFlags } from '../routes/broll.js'
import * as emailNotifier from './email-notifier.js'

export async function confirmClassificationGroup(parentGroupId, groups, opts) {
  const { propagateAutoRoughCut, propagatePathId, userId } = opts
  const subGroupIds = []

  // Pull example_set rows once; sources are linked via example_set_id, not
  // group_id directly. We copy each parent source into a fresh per-sub-group set.
  const parentExampleSets = await db.prepare(
    'SELECT id FROM broll_example_sets WHERE group_id = ?'
  ).all(parentGroupId)
  const parentSources = []
  for (const set of parentExampleSets) {
    const rows = await db.prepare(
      'SELECT kind, source_url, label, status, error, meta_json, is_favorite FROM broll_example_sources WHERE example_set_id = ?'
    ).all(set.id)
    for (const r of rows) parentSources.push(r)
  }

  for (const g of groups) {
    const r = await db.prepare(
      `INSERT INTO video_groups (name, assembly_status, parent_group_id, user_id, auto_rough_cut, path_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(g.name, 'pending', parentGroupId, userId, !!propagateAutoRoughCut, propagatePathId || null)
    const subId = r.lastInsertRowid
    subGroupIds.push(subId)

    if (g.videoIds?.length) {
      const placeholders = g.videoIds.map(() => '?').join(',')
      await db.prepare(`UPDATE videos SET group_id = ? WHERE id IN (${placeholders})`)
        .run(subId, ...g.videoIds)
    }

    // Copy broll example references down to each sub-group so b-roll endpoints
    // hitting `/groups/:subId/...` find the user's seed sources.
    if (parentSources.length > 0) {
      const setRes = await db.prepare(
        'INSERT INTO broll_example_sets (group_id, created_by) VALUES (?, ?)'
      ).run(subId, userId || null)
      const newSetId = setRes.lastInsertRowid
      for (const src of parentSources) {
        await db.prepare(
          `INSERT INTO broll_example_sources (example_set_id, kind, source_url, label, status, error, meta_json, is_favorite)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(newSetId, src.kind, src.source_url, src.label, src.status, src.error, src.meta_json, src.is_favorite)
      }
    }

    console.log(`[orchestrator] Sub-group "${g.name}": ${g.videoIds?.length || 0} videos → group ${subId}`)
  }

  await db.prepare('UPDATE video_groups SET assembly_status = ? WHERE id = ?')
    .run('confirmed', parentGroupId)

  for (const subId of subGroupIds) {
    analyzeMulticam(subId, { skipClassification: true })
  }

  return { subGroupIds }
}

export async function chainAfterClassify(groupId) {
  const g = await db.prepare(
    'SELECT id, user_id, path_id, auto_rough_cut, classification_json, assembly_status FROM video_groups WHERE id = ?'
  ).get(groupId)
  if (!g) return
  if (g.path_id !== 'hands-off') return
  if (g.assembly_status !== 'classified') return // classifier may have failed
  if (!g.classification_json) return

  let parsed
  try { parsed = JSON.parse(g.classification_json) } catch { return }
  if (!parsed?.groups?.length) return

  console.log(`[orchestrator] Auto-confirming classification for hands-off group ${groupId}`)
  await confirmClassificationGroup(groupId, parsed.groups, {
    propagateAutoRoughCut: !!g.auto_rough_cut,
    propagatePathId: g.path_id,
    userId: g.user_id,
  })
}

// runFullAutoBrollChain — fires the b-roll pipeline chain (references analyzed
// → strategy → plan → first-10 search) for sub-groups whose parent picked
// hands-off / strategy-only / guided. Respects pathToFlags pauses.
export async function runFullAutoBrollChain(subGroupId) {
  if (!subGroupId) return
  await db.prepare("UPDATE video_groups SET broll_chain_status = 'running' WHERE id = ?").run(subGroupId)

  const sg = await db.prepare(
    'SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id = ?'
  ).get(subGroupId)
  if (!sg) return
  const flags = pathToFlags(sg.path_id)

  try {
    const runner = await import('./broll-runner.js')

    const mainVideo = await db.prepare(`
      SELECT v.id FROM videos v
      JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
      WHERE v.group_id = ? AND v.video_type = 'raw'
      ORDER BY v.id LIMIT 1
    `).get(subGroupId)
    if (!mainVideo) throw new Error('No video with transcript in sub-group')

    const refs = await runner.runAllReferences({ subGroupId, mainVideoId: mainVideo.id })
    await runner.waitForPipelinesComplete([refs.prepPipelineId, ...refs.analysisPipelineIds].filter(Boolean))

    const strats = await runner.runStrategies({
      subGroupId, mainVideoId: mainVideo.id,
      prepPipelineId: refs.prepPipelineId, analysisPipelineIds: refs.analysisPipelineIds,
    })
    await runner.waitForPipelinesComplete(strats.strategyPipelineIds)

    if (flags.stopAfterStrategy) {
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_strategy' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('paused_at_strategy', { subGroupId, userId: sg.user_id })
      return
    }

    const plans = await runner.runPlanForEachVariant({
      subGroupId, mainVideoId: mainVideo.id,
      prepPipelineId: refs.prepPipelineId,
      strategyPipelineIds: strats.strategyPipelineIds,
    })
    await runner.waitForPipelinesComplete(plans.planPipelineIds)

    if (flags.stopAfterPlan) {
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_plan' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('paused_at_plan', { subGroupId, userId: sg.user_id })
      return
    }

    await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: plans.planPipelineIds })

    await db.prepare("UPDATE video_groups SET broll_chain_status = 'done' WHERE id = ?").run(subGroupId)
    await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
  } catch (err) {
    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'failed', broll_chain_error = ? WHERE id = ?"
    ).run(String(err.message).slice(0, 500), subGroupId)
    await emailNotifier.send('failed', { subGroupId, userId: sg.user_id, error: err.message })
  }
}

// resumeChain — called after the user picks a strategy/plan at a checkpoint.
//   fromStage = 'plan'  → user picked strategies; run plan + search
//   fromStage = 'search' → user picked plan; run search only
export async function resumeChain(subGroupId, fromStage, opts = {}) {
  const sg = await db.prepare(
    'SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id = ?'
  ).get(subGroupId)
  if (!sg) return

  await db.prepare("UPDATE video_groups SET broll_chain_status = 'running' WHERE id = ?").run(subGroupId)

  try {
    const runner = await import('./broll-runner.js')
    const mainVideo = await db.prepare(`
      SELECT v.id FROM videos v JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
      WHERE v.group_id = ? AND v.video_type = 'raw' ORDER BY v.id LIMIT 1
    `).get(subGroupId)

    if (fromStage === 'plan') {
      const plans = await runner.runPlanForEachVariant({
        subGroupId, mainVideoId: mainVideo.id,
        strategyPipelineIds: opts.strategyPipelineIds || [],
        prepPipelineId: opts.prepPipelineId,
      })
      await runner.waitForPipelinesComplete(plans.planPipelineIds)

      if (sg.path_id === 'guided') {
        await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_plan' WHERE id = ?").run(subGroupId)
        await emailNotifier.send('paused_at_plan', { subGroupId, userId: sg.user_id })
        return
      }
      await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: plans.planPipelineIds })
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'done' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
    } else if (fromStage === 'search') {
      await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: opts.planPipelineIds || [opts.planPipelineId] })
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'done' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
    }
  } catch (err) {
    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'failed', broll_chain_error = ? WHERE id = ?"
    ).run(String(err.message).slice(0, 500), subGroupId)
    await emailNotifier.send('failed', { subGroupId, userId: sg.user_id, error: err.message })
  }
}

// Called from server boot. Re-fires chains for sub-groups that should be running
// but aren't (interrupted by server restart, etc.).
export async function resumeStuckFullAutoChains() {
  const stuck = await db.prepare(`
    SELECT id FROM video_groups
    WHERE path_id IN ('hands-off', 'strategy-only', 'guided')
      AND assembly_status = 'done'
      AND parent_group_id IS NOT NULL
      AND (rough_cut_status IS NULL OR rough_cut_status IN ('done', 'failed', 'insufficient_tokens', 'skipped'))
      AND broll_chain_status IS NULL
  `).all()
  for (const sg of stuck) {
    setTimeout(() => runFullAutoBrollChain(sg.id), 3000)
  }

  const interrupted = await db.prepare(
    "SELECT id FROM video_groups WHERE broll_chain_status = 'running'"
  ).all()
  for (const sg of interrupted) {
    await db.prepare("UPDATE video_groups SET broll_chain_status = NULL WHERE id = ?").run(sg.id)
    setTimeout(() => runFullAutoBrollChain(sg.id), 3000)
  }
  console.log(`[startup] resumed ${stuck.length} stuck + ${interrupted.length} interrupted chains`)
}
