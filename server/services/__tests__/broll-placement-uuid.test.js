// Tests for the broll-placement-uuid helper (side-table-backed).
//
// Strategy: real Postgres. The side table `broll_placement_uuids` and
// the parent `broll_runs` table are both real, and the helper writes
// to / reads from them directly. Tests scope all fixture inserts to
// `plan_pipeline_id LIKE 'test-uuid-helper-%'` so cleanup in
// beforeEach does not touch real data.
//
// This file uses the `import db from '../../db.js'` (default import)
// pattern to match the rest of the codebase. The plan's draft used a
// named import — that's not how server/db.js exports.

import { describe, it, expect, beforeEach } from 'vitest'
import db from '../../db.js'
import {
  getOrCreatePlacementUuid,
  ensurePlanUuids,
  lookupPlacementUuid,
} from '../broll-placement-uuid.js'

describe('broll-placement-uuid helper (side table)', () => {
  // broll_runs has NOT NULL FKs to broll_strategies(id), videos(id) and a
  // NOT NULL step_name. We grab any valid id for each so test inserts
  // satisfy the constraints without coupling to a specific row.
  let strategyId
  let videoId

  beforeEach(async () => {
    await db.prepare(`DELETE FROM broll_placement_uuids WHERE plan_pipeline_id LIKE ?`).run('test-uuid-helper-%')
    await db.prepare(`DELETE FROM broll_runs WHERE metadata_json LIKE ?`).run('%test-uuid-helper%')
    if (!strategyId) {
      const s = await db.prepare(`SELECT id FROM broll_strategies LIMIT 1`).get()
      strategyId = s.id
    }
    if (!videoId) {
      const v = await db.prepare(`SELECT id FROM videos LIMIT 1`).get()
      videoId = v.id
    }
  })

  // Helper to insert a chapter sub-run with the minimum required columns.
  async function insertChapterRun(planPid, subIndex, outputJson) {
    await db.prepare(
      `INSERT INTO broll_runs (strategy_id, video_id, step_name, status, metadata_json, output_text)
       VALUES (?, ?, 'plan', 'complete', ?, ?)`
    ).run(
      strategyId,
      videoId,
      JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex }),
      outputJson,
    )
  }

  it('getOrCreatePlacementUuid creates a new p_-prefixed uuid on first call', async () => {
    const planPid = 'test-uuid-helper-1'
    const uuid = await getOrCreatePlacementUuid(planPid, 0, 0)
    expect(uuid).toMatch(/^p_[a-z0-9]{12}$/)
  })

  it('getOrCreatePlacementUuid returns the SAME uuid on repeat calls (idempotent)', async () => {
    const planPid = 'test-uuid-helper-2'
    const a = await getOrCreatePlacementUuid(planPid, 0, 0)
    const b = await getOrCreatePlacementUuid(planPid, 0, 0)
    expect(a).toBe(b)
  })

  it('getOrCreatePlacementUuid returns DIFFERENT uuids for different positions', async () => {
    const planPid = 'test-uuid-helper-3'
    const a = await getOrCreatePlacementUuid(planPid, 0, 0)
    const b = await getOrCreatePlacementUuid(planPid, 0, 1)
    const c = await getOrCreatePlacementUuid(planPid, 1, 0)
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('getOrCreatePlacementUuid does NOT mutate broll_runs.output_text', async () => {
    const planPid = 'test-uuid-helper-4'
    const original = JSON.stringify({ placements: [{ description: 'A' }] })
    await insertChapterRun(planPid, 0, original)

    await getOrCreatePlacementUuid(planPid, 0, 0)

    const after = await db.prepare(`SELECT output_text FROM broll_runs WHERE metadata_json LIKE ?`).get(`%"pipelineId":"${planPid}"%`)
    expect(after.output_text).toBe(original) // byte-for-byte unchanged
  })

  it('ensurePlanUuids returns Map<chapterIndex, Map<placementIndex, uuid>> for all chapter placements', async () => {
    const planPid = 'test-uuid-helper-5'
    await insertChapterRun(planPid, 0, JSON.stringify({ placements: [{ description: 'A' }, { description: 'B' }] }))
    await insertChapterRun(planPid, 1, JSON.stringify({ placements: [{ description: 'C' }] }))

    const m = await ensurePlanUuids(planPid)
    expect(m.get(0).size).toBe(2)
    expect(m.get(1).size).toBe(1)
    expect(m.get(0).get(0)).toMatch(/^p_/)
    expect(m.get(0).get(1)).toMatch(/^p_/)
    expect(m.get(1).get(0)).toMatch(/^p_/)
    // All distinct
    const all = [m.get(0).get(0), m.get(0).get(1), m.get(1).get(0)]
    expect(new Set(all).size).toBe(3)
  })

  it('ensurePlanUuids is idempotent — returns same uuids on repeat call', async () => {
    const planPid = 'test-uuid-helper-6'
    await insertChapterRun(planPid, 0, JSON.stringify({ placements: [{ description: 'A' }] }))

    const m1 = await ensurePlanUuids(planPid)
    const m2 = await ensurePlanUuids(planPid)
    expect(m2.get(0).get(0)).toBe(m1.get(0).get(0))
  })

  it('lookupPlacementUuid returns null when no uuid has been assigned', async () => {
    const planPid = 'test-uuid-helper-7'
    const uuid = await lookupPlacementUuid(planPid, 0, 0)
    expect(uuid).toBe(null)
  })

  it('skips category != "broll" placements when building the map', async () => {
    const planPid = 'test-uuid-helper-8'
    await insertChapterRun(planPid, 0, JSON.stringify({ placements: [
      { description: 'broll item', category: 'broll' },
      { description: 'aroll item', category: 'aroll' }, // should be skipped
      { description: 'broll item 2' }, // no category = treated as broll
    ]}))

    const m = await ensurePlanUuids(planPid)
    // brollOnly indexing: position 0 = first broll, position 1 = third item (second is skipped)
    expect(m.get(0).size).toBe(2)
    expect(m.get(0).get(0)).toMatch(/^p_/)
    expect(m.get(0).get(1)).toMatch(/^p_/)
  })
})
