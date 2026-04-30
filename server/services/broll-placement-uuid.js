// Side-table-backed placement UUID helper.
//
// UUIDs that identify a single (plan_pipeline_id, chapter_index,
// placement_index) live exclusively in `broll_placement_uuids`. We
// READ `broll_runs.output_text` to enumerate the LLM's emitted
// placements (so the per-chapter `placements[]` shape is the source
// of truth for ordering), but we NEVER mutate it — the run record
// must stay a faithful copy of the model's output.
//
// Concurrency: `getOrCreatePlacementUuid` uses a SELECT → INSERT ON
// CONFLICT DO NOTHING → SELECT pattern. The composite UNIQUE index
// on (plan_pipeline_id, chapter_index, placement_index) (Task 1)
// makes the INSERT race-safe; the trailing SELECT picks up the
// winner's uuid if a concurrent caller beat us to the INSERT.

import db from '../db.js'

function newUuid() {
  const rand = (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)))
    .replace(/-/g, '')
    .slice(0, 12)
  return 'p_' + rand
}

/**
 * Read-only lookup. Returns the uuid for (planPipelineId, chapterIndex, placementIndex)
 * if one has been assigned, else null. Never writes.
 */
export async function lookupPlacementUuid(planPipelineId, chapterIndex, placementIndex) {
  const row = await db.prepare(
    `SELECT uuid FROM broll_placement_uuids WHERE plan_pipeline_id = ? AND chapter_index = ? AND placement_index = ?`
  ).get(planPipelineId, chapterIndex, placementIndex)
  return row?.uuid || null
}

/**
 * Get the uuid for (planPipelineId, chapterIndex, placementIndex), creating one
 * atomically if it doesn't exist. Idempotent (uses INSERT ... ON CONFLICT DO NOTHING
 * then re-SELECTs).
 *
 * Does NOT modify broll_runs.output_text — UUIDs live exclusively in the side table.
 */
export async function getOrCreatePlacementUuid(planPipelineId, chapterIndex, placementIndex) {
  const existing = await lookupPlacementUuid(planPipelineId, chapterIndex, placementIndex)
  if (existing) return existing

  const uuid = newUuid()
  await db.prepare(`
    INSERT INTO broll_placement_uuids (plan_pipeline_id, chapter_index, placement_index, uuid)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (plan_pipeline_id, chapter_index, placement_index) DO NOTHING
  `).run(planPipelineId, chapterIndex, placementIndex, uuid)

  // Re-SELECT in case a concurrent caller won the INSERT race.
  return await lookupPlacementUuid(planPipelineId, chapterIndex, placementIndex)
}

/**
 * For all broll-category placements across all chapter runs of a plan pipeline,
 * ensure a uuid exists in the side table. Reads broll_runs.output_text but never
 * mutates it. Returns Map<chapterIndex, Map<placementIndex, uuid>>.
 */
export async function ensurePlanUuids(planPipelineId) {
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)
  const chapterRuns = planRuns.filter(r => {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      return m.isSubRun && m.stageName === 'Per-chapter B-Roll plan'
    } catch { return false }
  })

  const out = new Map()
  for (const r of chapterRuns) {
    const meta = JSON.parse(r.metadata_json || '{}')
    const chIdx = typeof meta.subIndex === 'number' ? meta.subIndex : 0

    const raw = r.output_text || ''
    const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '')
    let parsed
    try { parsed = JSON.parse(cleaned) } catch { continue }

    let items = parsed.placements || parsed.broll_placements || []
    if (!items.length) {
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v) && v.length && v[0]?.description) { items = v; break }
      }
    }
    if (!Array.isArray(items)) continue

    const chapterMap = new Map()
    let brollIdx = 0
    for (const p of items) {
      if (p?.category && p.category !== 'broll') continue
      const uuid = await getOrCreatePlacementUuid(planPipelineId, chIdx, brollIdx)
      chapterMap.set(brollIdx, uuid)
      brollIdx++
    }
    out.set(chIdx, chapterMap)
  }
  return out
}

/**
 * One-time backfill: for every plan referenced from broll_searches OR with
 * complete chapter runs in broll_runs, ensure every broll-category placement
 * has a uuid in broll_placement_uuids. Then UPDATE any broll_searches row
 * with NULL placement_uuid by joining on (plan_pipeline_id, chapter_index,
 * placement_index).
 *
 * Idempotent. Safe to call on every server boot. Never touches broll_runs.
 *
 * Performance note: on a fully-backfilled DB, this would otherwise pay
 * ~1 query per placement (per-placement SELECT inside `ensurePlanUuids`)
 * — at ~50ms Supavisor latency × thousands of placements that's tens of
 * seconds. We avoid the per-placement work in the steady-state by
 * pre-loading the side-table map for each plan in ONE query and only
 * walking `ensurePlanUuids` when we know placements are missing.
 */
export async function backfillPlacementUuids() {
  const fromSearches = await db.prepare(
    `SELECT DISTINCT plan_pipeline_id FROM broll_searches`
  ).all()
  const fromRuns = await db.prepare(
    `SELECT DISTINCT (metadata_json::jsonb->>'pipelineId') AS pid FROM broll_runs
     WHERE (metadata_json::jsonb->>'pipelineId') LIKE 'plan-%' AND status = 'complete'`
  ).all()
  const planIds = new Set([
    ...fromSearches.map(r => r.plan_pipeline_id),
    ...fromRuns.map(r => r.pid).filter(Boolean),
  ])

  let totalUuids = 0, totalSearchesFilled = 0
  for (const planPid of planIds) {
    // Pre-load every existing uuid for this plan in ONE query.
    const existingRows = await db.prepare(
      `SELECT chapter_index, placement_index, uuid FROM broll_placement_uuids
       WHERE plan_pipeline_id = ?`
    ).all(planPid)
    const uuidsByChapter = new Map()
    for (const r of existingRows) {
      if (!uuidsByChapter.has(r.chapter_index)) uuidsByChapter.set(r.chapter_index, new Map())
      uuidsByChapter.get(r.chapter_index).set(r.placement_index, r.uuid)
    }

    // Count expected placements from chapter runs to decide if we can
    // skip ensurePlanUuids. If the side table already has >= the
    // expected count, every placement is covered and we can move on.
    const chapterRuns = await db.prepare(
      `SELECT metadata_json, output_text FROM broll_runs
       WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
    ).all(`%"pipelineId":"${planPid}"%`)
    let expectedTotal = 0
    for (const r of chapterRuns) {
      let meta
      try { meta = JSON.parse(r.metadata_json || '{}') } catch { continue }
      if (!meta.isSubRun || meta.stageName !== 'Per-chapter B-Roll plan') continue
      const cleaned = (r.output_text || '').replace(/^```json\n?/, '').replace(/\n?```$/, '')
      let parsed
      try { parsed = JSON.parse(cleaned) } catch { continue }
      let items = parsed.placements || parsed.broll_placements || []
      if (!items.length) {
        for (const v of Object.values(parsed)) {
          if (Array.isArray(v) && v.length && v[0]?.description) { items = v; break }
        }
      }
      if (!Array.isArray(items)) continue
      for (const p of items) {
        if (p?.category && p.category !== 'broll') continue
        expectedTotal++
      }
    }
    const presentTotal = existingRows.length

    let planMap = uuidsByChapter
    if (presentTotal < expectedTotal) {
      // Some placements missing — call ensurePlanUuids to materialize them.
      planMap = await ensurePlanUuids(planPid)
    }
    for (const m of planMap.values()) totalUuids += m.size

    const rows = await db.prepare(
      `SELECT id, chapter_index, placement_index FROM broll_searches
       WHERE plan_pipeline_id = ? AND placement_uuid IS NULL`
    ).all(planPid)
    for (const row of rows) {
      const uuid = planMap.get(row.chapter_index)?.get(row.placement_index)
      if (uuid) {
        await db.prepare(`UPDATE broll_searches SET placement_uuid = ? WHERE id = ?`).run(uuid, row.id)
        totalSearchesFilled++
      }
    }
  }
  console.log(`[backfillPlacementUuids] plans=${planIds.size} uuids_in_side_table=${totalUuids} searches_backfilled=${totalSearchesFilled}`)
}
