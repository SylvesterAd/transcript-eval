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
import { analyzeMulticam, runClassification } from './multicam-sync.js'
import { pathToFlags } from '../routes/broll.js'
import * as emailNotifier from './email-notifier.js'

// Pure helper. Returns true iff `snapshot` (existing sub-groups with their
// videoIds) and `newGroups` (a fresh classification's groups[]) cover the
// same videos in the same partitioning. Group names are ignored — only the
// per-group set of videoIds matters. Used by reclassifyGroup to decide
// whether a re-classification produces an identical structure (in which
// case rough_cut and broll progress is preserved) or a different one (in
// which case sub-groups are deleted and the user re-confirms).
export function videoIdSetsMatch(snapshot, newGroups) {
  if (snapshot.length !== newGroups.length) return false
  const matched = new Set()
  for (const ng of newGroups) {
    const ngSet = new Set(ng.videoIds || [])
    let found = false
    for (let i = 0; i < snapshot.length; i++) {
      if (matched.has(i)) continue
      const sg = snapshot[i]
      const sgIds = sg.videoIds || []
      if (sgIds.length === ngSet.size && sgIds.every(id => ngSet.has(id))) {
        matched.add(i)
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

export async function confirmClassificationGroup(parentGroupId, groups, opts) {
  const { propagateAutoRoughCut, propagatePathId, userId } = opts

  // Guard against recursive split: if `parentGroupId` is itself a sub-group,
  // splitting it again creates the 239→240→241-style chain that orphans
  // references on the original parent. The route layer also rejects this,
  // but the service guard makes it impossible to bypass via direct calls.
  const parentRow = await db.prepare(
    'SELECT parent_group_id FROM video_groups WHERE id = ?'
  ).get(parentGroupId)
  if (parentRow?.parent_group_id) {
    throw new Error(`Cannot split group ${parentGroupId}: it is already a sub-group of ${parentRow.parent_group_id}`)
  }

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

// reclassifyGroup — re-runs classification on a parent project, preserving
// rough_cut + b-roll progress when the new classification produces the same
// videoId-per-sub-group partitioning as the existing structure. Replaces
// the brute-force "delete sub-groups, re-classify" flow that destroyed
// progress on every Re-classify click.
//
// Behavior:
//   1. Reject if `parentId` is itself a sub-group.
//   2. Snapshot existing sub-groups + their videoIds.
//   3. Run classification on the videos currently in those sub-groups.
//   4. If the new partitioning matches the snapshot (videoId-set per group),
//      write the new classification_json on the parent and stop — sub-groups
//      and their downstream rough_cut / broll progress are preserved.
//   5. If the partitioning differs, delete the sub-groups, move their videos
//      back to the parent, write classification_json + assembly_status =
//      'classified' on the parent, and let the user re-confirm.
//
// Returns { unchanged: boolean, classification }.
export async function reclassifyGroup(parentId) {
  const parentRow = await db.prepare(
    'SELECT parent_group_id FROM video_groups WHERE id = ?'
  ).get(parentId)
  if (parentRow?.parent_group_id) {
    throw new Error(`Cannot re-classify group ${parentId}: it is a sub-group of ${parentRow.parent_group_id}. Re-classify the top-level project instead.`)
  }

  // Snapshot existing sub-groups + their video IDs so we can compare new
  // classification against the current partitioning, and restore on a no-op.
  const subGroups = await db.prepare(
    'SELECT id, name FROM video_groups WHERE parent_group_id = ? ORDER BY id'
  ).all(parentId)

  const snapshot = []
  for (const sg of subGroups) {
    const vids = await db.prepare(
      "SELECT id FROM videos WHERE group_id = ? AND video_type = 'raw' ORDER BY id"
    ).all(sg.id)
    snapshot.push({ id: sg.id, name: sg.name, videoIds: vids.map(v => v.id) })
  }

  // Read videos currently across the parent + sub-groups (we don't move them
  // until we've decided the new partitioning warrants destructive action).
  const subGroupIds = subGroups.map(sg => sg.id)
  const ids = [parentId, ...subGroupIds]
  const placeholders = ids.map(() => '?').join(',')
  const videos = await db.prepare(`
    SELECT v.id, v.title, v.duration_seconds, v.file_path, t.content AS transcript
    FROM videos v
    LEFT JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id IN (${placeholders}) AND v.video_type = 'raw'
    ORDER BY v.id
  `).all(...ids)

  if (videos.length === 0) {
    throw new Error(`No raw videos found under group ${parentId} or its sub-groups`)
  }

  // Run classification (calls Gemini for >1 video; trivial for 1).
  const classification = await runClassification(videos)
  const sameStructure = videoIdSetsMatch(snapshot, classification.groups)

  if (sameStructure) {
    // Refresh classification_json on the parent (idempotent — no destructive
    // change to sub-groups, no status flip; rough_cut + broll progress kept).
    await db.prepare(
      'UPDATE video_groups SET classification_json = ? WHERE id = ?'
    ).run(JSON.stringify(classification), parentId)
    return { unchanged: true, classification }
  }

  // Different structure: in a transaction, move videos back to parent, delete
  // sub-groups, write the new classification + status='classified' so the user
  // can review and confirm.
  await runInTransaction(async (tx) => {
    // Move ALL videos that were in any sub-group back to the parent in one shot.
    const allVideoIds = snapshot.flatMap(sg => sg.videoIds)
    if (allVideoIds.length > 0) {
      const placeholders = allVideoIds.map(() => '?').join(',')
      await tx.prepare(
        `UPDATE videos SET group_id = ? WHERE id IN (${placeholders})`
      ).run(parentId, ...allVideoIds)
    }
    // Delete the now-empty sub-groups (FKs cascade to their progress rows).
    for (const sg of subGroups) {
      await tx.prepare('DELETE FROM video_groups WHERE id = ?').run(sg.id)
    }
    // Write new classification + flip status so AssetsView re-renders for review.
    await tx.prepare(
      'UPDATE video_groups SET classification_json = ? WHERE id = ?'
    ).run(JSON.stringify(classification), parentId)
    await tx.prepare(
      'UPDATE video_groups SET assembly_status = ? WHERE id = ?'
    ).run('classified', parentId)
  })

  return { unchanged: false, classification }
}

// runInTransaction — wraps a callback in a Postgres BEGIN/COMMIT (rolls back
// on throw). Falls back to non-transactional execution when db.transaction
// isn't available (vitest mocks of db.js often only stub `prepare`). The
// fallback runs each statement sequentially via the regular pool — same
// observable behavior in tests, no atomicity in production unless db.js
// exposes the helper.
async function runInTransaction(fn) {
  if (typeof db.transaction === 'function') {
    return db.transaction(fn)
  }
  return fn(db)
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
