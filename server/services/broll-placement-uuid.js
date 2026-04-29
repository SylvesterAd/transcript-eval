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
