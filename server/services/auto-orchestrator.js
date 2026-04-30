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

// Note: resumePipeline is dynamically imported from './broll.js' inside
// resumeStuckFullAutoChains to avoid pulling broll.js (which has heavy
// transitive deps including llm-runner.js side-effects) into the module
// graph at orchestrator load time. The dynamic import still respects
// vi.mock('../broll.js', ...) in tests.

// Indirection holder for orchestrator-internal helpers that
// resumeStuckFullAutoChains delegates to. Tests stub these by reassigning
// fields on the holder (see resume-stuck-chains-v2.test.js). The pattern
// mirrors __pipelineRunner in broll.js — ESM live bindings make vi.spyOn
// on the named exports unreliable, so we route through a mutable object.
// Populated below the function declarations.
export const __orchestratorDeps = {
  findInterruptedPipelinesForGroup: null,
  resumeChain: null,
  runFullAutoBrollChain: null,
}

// Find pipelineIds belonging to a video_group whose expected stages exceed the
// completed-main-stages count (i.e., interrupted by a server crash). Skips
// alt-/kw-/bs- pipelines (they have dedicated re-trigger endpoints). When
// substage='refs', also scans pipelines for the group's reference videos.
//
// Returns an array of pipelineId strings.
export async function findInterruptedPipelinesForGroup(groupId, substage) {
  // Gather video IDs that belong to this group
  const groupVideoRows = await db.prepare('SELECT id FROM videos WHERE group_id = ?').all(groupId)
  const videoIds = groupVideoRows.map(r => r.id)

  // For 'refs' substage, also include reference videos.
  // broll_example_sources stores videoId inside meta_json (TEXT), not a column —
  // see loadExampleVideos in broll.js for the canonical pattern. We fetch the
  // rows and parse JSON in JS rather than try a JSON extract in SQL.
  if (substage === 'refs') {
    const refSources = await db.prepare(`
      SELECT s.meta_json
      FROM broll_example_sources s
      JOIN broll_example_sets es ON es.id = s.example_set_id
      WHERE es.group_id = ? AND s.status = 'ready'
    `).all(groupId)
    for (const row of refSources) {
      try {
        const meta = JSON.parse(row.meta_json || '{}')
        if (meta.videoId && !videoIds.includes(meta.videoId)) videoIds.push(meta.videoId)
      } catch {}
    }
  }

  if (!videoIds.length) return []

  // Fetch broll_runs for these videos. The pg adapter uses '?' placeholders
  // (see existing query at server/services/broll.js:806-810).
  const placeholders = videoIds.map(() => '?').join(',')
  const runs = await db.prepare(
    `SELECT id, metadata_json, status FROM broll_runs WHERE video_id IN (${placeholders}) AND status = 'complete'`
  ).all(...videoIds)

  // Group by pipelineId, count completed main stages, compare to expectedStages
  // (taken from any row's totalStages metadata).
  const byPid = new Map()
  for (const row of runs) {
    let meta
    try { meta = JSON.parse(row.metadata_json || '{}') } catch { continue }
    const pid = meta.pipelineId
    if (!pid) continue
    if (pid.startsWith('alt-') || pid.startsWith('kw-') || pid.startsWith('bs-')) continue
    if (!byPid.has(pid)) byPid.set(pid, { mainStages: new Set(), expected: 0 })
    const entry = byPid.get(pid)
    if (meta.totalStages != null && meta.totalStages > entry.expected) entry.expected = meta.totalStages
    if (!meta.isSubRun && meta.stageIndex != null) entry.mainStages.add(meta.stageIndex)
  }

  const interrupted = []
  for (const [pid, { mainStages, expected }] of byPid) {
    if (expected > 0 && mainStages.size < expected) interrupted.push(pid)
  }
  return interrupted
}

// Cooperative cancel signal. The DELETE handler sets assembly_status='deleting'
// on the sub-group (and the parent) before purging. We poll this between
// chain stages and bail — no more executePipeline calls, no more email
// notifications, no more status writes against rows that are about to vanish.
async function isCancelled(subGroupId) {
  const row = await db.prepare(
    'SELECT assembly_status FROM video_groups WHERE id = ?'
  ).get(subGroupId)
  return !row || row.assembly_status === 'deleting'
}

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

// True if the group already has the broll_runs outputs needed to skip a phase.
// - 'refs' requires BOTH 'plan_prep' (main video) AND 'main_analysis' (ref videos)
//   because the next phase (runStrategies) fails without prepPipelineId AND
//   analysisPipelineIds. If only one exists, return false so refs re-runs;
//   runAllReferences is idempotent and will fill the missing piece without
//   re-doing completed work.
// - 'strategy' is satisfied by EITHER 'create_strategy' OR 'create_combined_strategy'
//   (which one applies depends on the number of reference videos).
// - 'plan' is satisfied by 'plan'.
// - 'search' always returns false — idempotent re-run is safer than skipping.
async function phaseHasOutputs(groupId, phase) {
  const groupVideoRows = await db.prepare('SELECT id FROM videos WHERE group_id = ?').all(groupId)
  const videoIds = groupVideoRows.map(r => r.id)
  if (!videoIds.length) return false

  if (phase === 'search') return false

  const phaseConfig = {
    refs: { kinds: ['main_analysis', 'plan_prep'], requireAll: true },
    strategy: { kinds: ['create_strategy', 'create_combined_strategy'], requireAll: false },
    plan: { kinds: ['plan'], requireAll: false },
  }[phase]
  if (!phaseConfig) return false

  const placeholders = videoIds.map(() => '?').join(',')
  for (const kind of phaseConfig.kinds) {
    const row = await db.prepare(
      `SELECT 1 FROM broll_runs r
       JOIN broll_strategies s ON s.id = r.strategy_id
       WHERE r.video_id IN (${placeholders}) AND r.status = 'complete'
         AND s.strategy_kind = ?
       LIMIT 1`
    ).get(...videoIds, kind)
    if (phaseConfig.requireAll && !row) return false  // missing a required kind
    if (!phaseConfig.requireAll && row) return true   // any kind found
  }
  // requireAll: all kinds existed (no early false). requireAny: nothing matched.
  return phaseConfig.requireAll
}

// Heartbeat TTL: how long we trust an existing 'running' chain before
// considering its driver process dead. Set comfortably above the in-chain
// heartbeat interval (HEARTBEAT_INTERVAL_MS) so a brief LLM call or DB
// hiccup doesn't trip the lock, but small enough that a crashed worker
// is recovered within a couple of minutes by boot resume / re-trigger.
const HEARTBEAT_TTL_MS = 90 * 1000
const HEARTBEAT_INTERVAL_MS = 30 * 1000

// runFullAutoBrollChain — fires the b-roll pipeline chain (references analyzed
// → strategy → plan → first-10 search) for sub-groups whose parent picked
// hands-off / strategy-only / guided. Respects pathToFlags pauses.
//
// Options:
//   resumeFromSubstage — when set (boot-time auto-resume), skips phases whose
//     outputs already exist in broll_runs. Existing callers omit this and get
//     unchanged behavior. The skipped phase's pipelineIds are recovered from
//     the latest completed runs so downstream phases still get their inputs.
//     Also bypasses the duplicate-fire heartbeat guard since the boot resume
//     query has already filtered to chains whose heartbeat is stale.
export async function runFullAutoBrollChain(subGroupId, { resumeFromSubstage = null } = {}) {
  if (!subGroupId) return

  // Duplicate-fire guard. If status is 'running' AND the in-chain heartbeat
  // updater fired recently, another worker still owns this chain — bail
  // rather than spawn a parallel runAllReferences (the failure mode that
  // burned tokens with two main_analysis pipelines for the same reference
  // video). Resume callers skip this since their query already filtered.
  if (!resumeFromSubstage) {
    const lock = await db.prepare(
      'SELECT broll_chain_status, broll_chain_heartbeat_at FROM video_groups WHERE id = ?'
    ).get(subGroupId)
    if (lock?.broll_chain_status === 'running' && lock.broll_chain_heartbeat_at) {
      const ageMs = Date.now() - new Date(lock.broll_chain_heartbeat_at).getTime()
      if (ageMs < HEARTBEAT_TTL_MS) {
        console.log(`[orchestrator] Skipping duplicate chain fire for group ${subGroupId} — heartbeat is ${Math.round(ageMs / 1000)}s old`)
        return
      }
    }
  }

  await db.prepare(
    "UPDATE video_groups SET broll_chain_status = 'running', broll_chain_substage = 'refs', broll_chain_heartbeat_at = NOW() WHERE id = ?"
  ).run(subGroupId)
  if (await isCancelled(subGroupId)) return

  const heartbeat = setInterval(() => {
    db.prepare('UPDATE video_groups SET broll_chain_heartbeat_at = NOW() WHERE id = ?')
      .run(subGroupId)
      .catch(() => {})
  }, HEARTBEAT_INTERVAL_MS)

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

    // Phase 1: refs
    let refs = { prepPipelineId: null, analysisPipelineIds: [] }
    const skipRefs = resumeFromSubstage && await phaseHasOutputs(subGroupId, 'refs')
    if (skipRefs) {
      console.log(`[orchestrator] Skipping refs phase for group ${subGroupId} — outputs already exist`)
      // Recover prep + analysis pipeline IDs from the latest completed runs so
      // strategy phase still has its inputs.
      const prepRow = await db.prepare(`
        SELECT metadata_json FROM broll_runs r
        JOIN broll_strategies s ON s.id = r.strategy_id
        WHERE r.video_id = ? AND s.strategy_kind = 'plan_prep' AND r.status = 'complete'
        ORDER BY r.id DESC LIMIT 1
      `).get(mainVideo.id)
      if (prepRow) {
        try { refs.prepPipelineId = JSON.parse(prepRow.metadata_json || '{}').pipelineId || null } catch {}
      }
      const analysisRows = await db.prepare(`
        SELECT DISTINCT metadata_json FROM broll_runs r
        JOIN broll_strategies s ON s.id = r.strategy_id
        WHERE r.video_id = ? AND s.strategy_kind = 'main_analysis' AND r.status = 'complete'
        ORDER BY r.id DESC
      `).all(mainVideo.id)
      const pids = new Set()
      for (const a of analysisRows) {
        try {
          const m = JSON.parse(a.metadata_json || '{}')
          if (m.pipelineId) pids.add(m.pipelineId)
        } catch {}
      }
      refs.analysisPipelineIds = [...pids]
    } else {
      refs = await runner.runAllReferences({ subGroupId, mainVideoId: mainVideo.id })
      await runner.waitForPipelinesComplete([refs.prepPipelineId, ...refs.analysisPipelineIds].filter(Boolean))
    }
    if (await isCancelled(subGroupId)) return

    // Phase 2: strategy
    await db.prepare("UPDATE video_groups SET broll_chain_substage = 'strategy' WHERE id = ?").run(subGroupId)
    let strats = { strategyPipelineIds: [] }
    const skipStrategy = resumeFromSubstage && await phaseHasOutputs(subGroupId, 'strategy')
    if (skipStrategy) {
      console.log(`[orchestrator] Skipping strategy phase for group ${subGroupId} — outputs already exist`)
      const stratRows = await db.prepare(`
        SELECT DISTINCT metadata_json FROM broll_runs r
        JOIN broll_strategies s ON s.id = r.strategy_id
        WHERE r.video_id = ? AND s.strategy_kind IN ('create_strategy', 'create_combined_strategy') AND r.status = 'complete'
        ORDER BY r.id DESC
      `).all(mainVideo.id)
      const pids = new Set()
      for (const r of stratRows) {
        try {
          const m = JSON.parse(r.metadata_json || '{}')
          if (m.pipelineId) pids.add(m.pipelineId)
        } catch {}
      }
      strats.strategyPipelineIds = [...pids]
    } else {
      strats = await runner.runStrategies({
        subGroupId, mainVideoId: mainVideo.id,
        prepPipelineId: refs.prepPipelineId, analysisPipelineIds: refs.analysisPipelineIds,
      })
      await runner.waitForPipelinesComplete(strats.strategyPipelineIds)
    }
    if (await isCancelled(subGroupId)) return

    if (flags.stopAfterStrategy) {
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_strategy' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('paused_at_strategy', { subGroupId, userId: sg.user_id })
      return
    }

    // Phase 3: plan
    await db.prepare("UPDATE video_groups SET broll_chain_substage = 'plan' WHERE id = ?").run(subGroupId)
    let plans = { planPipelineIds: [] }
    const skipPlan = resumeFromSubstage && await phaseHasOutputs(subGroupId, 'plan')
    if (skipPlan) {
      console.log(`[orchestrator] Skipping plan phase for group ${subGroupId} — outputs already exist`)
      const planRows = await db.prepare(`
        SELECT DISTINCT metadata_json FROM broll_runs r
        JOIN broll_strategies s ON s.id = r.strategy_id
        WHERE r.video_id = ? AND s.strategy_kind = 'plan' AND r.status = 'complete'
        ORDER BY r.id DESC
      `).all(mainVideo.id)
      const pids = new Set()
      for (const r of planRows) {
        try {
          const m = JSON.parse(r.metadata_json || '{}')
          if (m.pipelineId) pids.add(m.pipelineId)
        } catch {}
      }
      plans.planPipelineIds = [...pids]
    } else {
      plans = await runner.runPlanForEachVariant({
        subGroupId, mainVideoId: mainVideo.id,
        prepPipelineId: refs.prepPipelineId,
        strategyPipelineIds: strats.strategyPipelineIds,
      })
      await runner.waitForPipelinesComplete(plans.planPipelineIds)
    }
    if (await isCancelled(subGroupId)) return

    if (flags.stopAfterPlan) {
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_plan' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('paused_at_plan', { subGroupId, userId: sg.user_id })
      return
    }

    // Phase 4: search — always runs (idempotent re-run is safer than skipping)
    await db.prepare("UPDATE video_groups SET broll_chain_substage = 'search' WHERE id = ?").run(subGroupId)
    await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: plans.planPipelineIds })

    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
    ).run(subGroupId)
    await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
  } catch (err) {
    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'failed', broll_chain_substage = NULL, broll_chain_error = ? WHERE id = ?"
    ).run(String(err.message).slice(0, 500), subGroupId)
    await emailNotifier.send('failed', { subGroupId, userId: sg.user_id, error: err.message })
  } finally {
    clearInterval(heartbeat)
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

  const startSubstage = fromStage === 'plan' ? 'plan' : 'search'
  await db.prepare(
    "UPDATE video_groups SET broll_chain_status = 'running', broll_chain_substage = ? WHERE id = ?"
  ).run(startSubstage, subGroupId)
  if (await isCancelled(subGroupId)) return

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
      if (await isCancelled(subGroupId)) return

      if (sg.path_id === 'guided') {
        await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_plan' WHERE id = ?").run(subGroupId)
        await emailNotifier.send('paused_at_plan', { subGroupId, userId: sg.user_id })
        return
      }
      await db.prepare("UPDATE video_groups SET broll_chain_substage = 'search' WHERE id = ?").run(subGroupId)
      await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: plans.planPipelineIds })
      await db.prepare(
        "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
      ).run(subGroupId)
      await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
    } else if (fromStage === 'search') {
      await runner.runBrollSearchFirst10({ subGroupId, planPipelineIds: opts.planPipelineIds || [opts.planPipelineId] })
      await db.prepare(
        "UPDATE video_groups SET broll_chain_status = 'done', broll_chain_substage = NULL WHERE id = ?"
      ).run(subGroupId)
      await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
    }
  } catch (err) {
    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'failed', broll_chain_substage = NULL, broll_chain_error = ? WHERE id = ?"
    ).run(String(err.message).slice(0, 500), subGroupId)
    await emailNotifier.send('failed', { subGroupId, userId: sg.user_id, error: err.message })
  }
}

// Called from server boot. Resumes b-roll work that the previous server
// process left in flight: stuck chains (status IS NULL but ought to start) and
// interrupted chains (status='running' when the process died). For interrupted
// chains, uses smart per-pipeline resume + advance-from-substage rather than
// re-firing the whole chain (which previously caused 50+ spurious analysis runs).
// See spec docs/superpowers/specs/2026-04-29-broll-auto-resume-design.md.
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
    setTimeout(() => __orchestratorDeps.runFullAutoBrollChain(sg.id), 3000)
  }

  // Skip chains whose heartbeat was updated within HEARTBEAT_TTL_MS — those
  // belong to a still-live driver process (e.g., a previous container that
  // overlaps with this boot during a rolling Vercel/Railway deploy, or a
  // dev nodemon hot-reload race). Resuming a live chain spawns parallel
  // runAllReferences calls and double-billed token usage.
  const heartbeatTtlSeconds = Math.ceil(HEARTBEAT_TTL_MS / 1000)
  const interrupted = await db.prepare(
    `SELECT id FROM video_groups
     WHERE broll_chain_status = 'running'
       AND (broll_chain_heartbeat_at IS NULL
            OR broll_chain_heartbeat_at < NOW() - (? || ' seconds')::interval)`
  ).all(String(heartbeatTtlSeconds))

  // Lazy-import resumePipeline so broll.js (and its transitive llm-runner deps)
  // isn't pulled into the module graph at orchestrator load time. vi.mock in
  // tests still intercepts this dynamic import.
  const { resumePipeline } = await import('./broll.js')

  let resumedPipelinesCount = 0
  let advancedChainsCount = 0
  for (const sg of interrupted) {
    try {
      const row = await db.prepare(
        'SELECT broll_chain_substage FROM video_groups WHERE id = ?'
      ).get(sg.id)
      const substage = row?.broll_chain_substage || null

      // Step 1: resume interrupted pipelines for this group.
      // Per Task 3.5 contract, resumePipeline returns { pipelineId, completedStages,
      // executePromise }. We MUST await executePromise so the chain doesn't advance
      // (Step 2) until the resumed pipeline has actually finished its work.
      const pids = await __orchestratorDeps.findInterruptedPipelinesForGroup(sg.id, substage)
      for (const pid of pids) {
        try {
          const { executePromise } = await resumePipeline(pid)
          await executePromise
          resumedPipelinesCount++
        } catch (err) {
          console.error(`[startup] resumePipeline(${pid}) failed for group ${sg.id}: ${err.message}`)
        }
      }

      // Step 2: advance the chain. Use setTimeout(... 3000) to mirror the
      // first loop's startup delay — gives the rest of the boot path a moment
      // to settle before kicking off chain advancement.
      if (substage === 'plan' || substage === 'search') {
        setTimeout(() => __orchestratorDeps.resumeChain(sg.id, substage), 3000)
      } else {
        // 'refs', 'strategy', or NULL → use runFullAutoBrollChain with the new option
        setTimeout(
          () => __orchestratorDeps.runFullAutoBrollChain(sg.id, { resumeFromSubstage: substage || 'refs' }),
          3000,
        )
      }
      advancedChainsCount++
    } catch (err) {
      console.error(`[startup] resume failed for group ${sg.id}: ${err.message}`)
    }
  }

  console.log(`[startup] resumed ${stuck.length} stuck + ${resumedPipelinesCount} interrupted pipelines across ${interrupted.length} chains; advanced ${advancedChainsCount} chains from substage`)
}

// Boot-time recovery for YouTube reference downloads. downloadYouTubeVideo
// is fire-and-forget from POST /groups/:id/examples — a server kill between
// the INSERT (status='pending') and the success/failure write leaves the
// row stuck (status='pending' or 'processing'). The frontend just spins.
// We refire the download for any row whose heartbeat is null/stale; the
// staleness check leaves a still-live driver in a parallel container alone
// (rolling deploy / dev hot-reload) so we don't double-fire yt-dlp.
export async function resumeStuckYouTubeDownloads() {
  const heartbeatTtlSeconds = Math.ceil(HEARTBEAT_TTL_MS / 1000)
  const stuck = await db.prepare(
    `SELECT id FROM broll_example_sources
     WHERE kind = 'yt_video'
       AND status IN ('pending', 'processing')
       AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - (? || ' seconds')::interval)`
  ).all(String(heartbeatTtlSeconds))

  if (!stuck.length) return

  const { downloadYouTubeVideo } = await import('./broll.js')
  for (const row of stuck) {
    setTimeout(() => {
      downloadYouTubeVideo(row.id).catch(err =>
        console.error(`[startup] yt resume ${row.id} failed: ${err.message}`)
      )
    }, 3000)
  }
  console.log(`[startup] resumed ${stuck.length} stuck YouTube downloads`)
}

// Populate the indirection holder now that all helper functions are declared.
// Tests can override these fields to swap in mocks (see resume-stuck-chains-v2.test.js).
__orchestratorDeps.findInterruptedPipelinesForGroup = findInterruptedPipelinesForGroup
__orchestratorDeps.resumeChain = resumeChain
__orchestratorDeps.runFullAutoBrollChain = runFullAutoBrollChain
