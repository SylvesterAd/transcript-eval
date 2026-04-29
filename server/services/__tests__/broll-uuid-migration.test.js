// Tests for the one-time backfill of broll_placement_uuids and
// broll_searches.placement_uuid. Mirrors the pattern from
// broll-placement-uuid.test.js: real Postgres, default db import, fixture
// rows scoped to plan_pipeline_id LIKE 'test-uuid-backfill-%' so cleanup
// in beforeEach does not touch real data.

import { describe, it, expect, beforeEach } from 'vitest'
import db from '../../db.js'
import { backfillPlacementUuids } from '../broll-placement-uuid.js'

// The backfill scans every plan in broll_searches + broll_runs (full DB).
// On a fully-backfilled DB the per-plan fast path keeps total runtime
// under ~2s, but the first run on a fresh DB pays ~3 queries per missing
// placement; 30s gives headroom for that and for Supavisor latency spikes.
const TEST_TIMEOUT = 30000

describe('backfillPlacementUuids', () => {
  let strategyId, videoId

  beforeEach(async () => {
    await db.prepare(`DELETE FROM broll_placement_uuids WHERE plan_pipeline_id LIKE ?`).run('test-uuid-backfill-%')
    await db.prepare(`DELETE FROM broll_runs WHERE metadata_json LIKE ?`).run('%test-uuid-backfill%')
    await db.prepare(`DELETE FROM broll_searches WHERE plan_pipeline_id LIKE ?`).run('test-uuid-backfill-%')
    if (!strategyId) strategyId = (await db.prepare(`SELECT id FROM broll_strategies LIMIT 1`).get()).id
    if (!videoId) videoId = (await db.prepare(`SELECT id FROM videos LIMIT 1`).get()).id
  })

  async function insertChapterRun(planPid, subIndex, outputJson) {
    await db.prepare(
      `INSERT INTO broll_runs (strategy_id, video_id, step_name, status, metadata_json, output_text)
       VALUES (?, ?, 'plan', 'complete', ?, ?)`
    ).run(strategyId, videoId,
      JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex }),
      outputJson)
  }

  it('populates broll_placement_uuids and fills broll_searches.placement_uuid for existing rows', async () => {
    const planPid = 'test-uuid-backfill-plan-1'
    await insertChapterRun(planPid, 0, JSON.stringify({ placements: [{ description: 'A' }, { description: 'B' }] }))
    await db.prepare(
      `INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, status)
       VALUES (?, 'test-batch', 0, 0, 'complete'), (?, 'test-batch', 0, 1, 'complete')`
    ).run(planPid, planPid)

    await backfillPlacementUuids()

    const sideTable = await db.prepare(
      `SELECT chapter_index, placement_index, uuid FROM broll_placement_uuids
       WHERE plan_pipeline_id = ? ORDER BY chapter_index, placement_index`
    ).all(planPid)
    expect(sideTable).toHaveLength(2)
    expect(sideTable[0].uuid).toMatch(/^p_/)
    expect(sideTable[1].uuid).toMatch(/^p_/)
    expect(sideTable[0].uuid).not.toBe(sideTable[1].uuid)

    const searches = await db.prepare(
      `SELECT chapter_index, placement_index, placement_uuid FROM broll_searches
       WHERE plan_pipeline_id = ? ORDER BY placement_index`
    ).all(planPid)
    expect(searches[0].placement_uuid).toBe(sideTable[0].uuid)
    expect(searches[1].placement_uuid).toBe(sideTable[1].uuid)
  }, TEST_TIMEOUT)

  it('does NOT mutate broll_runs.output_text', async () => {
    const planPid = 'test-uuid-backfill-plan-2'
    const original = JSON.stringify({ placements: [{ description: 'A' }, { description: 'B' }] })
    await insertChapterRun(planPid, 0, original)

    await backfillPlacementUuids()

    const after = await db.prepare(`SELECT output_text FROM broll_runs WHERE metadata_json LIKE ?`).get(`%"pipelineId":"${planPid}"%`)
    expect(after.output_text).toBe(original) // byte-for-byte unchanged
  }, TEST_TIMEOUT)

  it('is idempotent — running twice does not change data', async () => {
    const planPid = 'test-uuid-backfill-plan-3'
    await insertChapterRun(planPid, 0, JSON.stringify({ placements: [{ description: 'X' }] }))
    await db.prepare(`INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, status) VALUES (?, 'b', 0, 0, 'complete')`).run(planPid)

    await backfillPlacementUuids()
    const after1 = await db.prepare(`SELECT placement_uuid FROM broll_searches WHERE plan_pipeline_id = ?`).get(planPid)
    await backfillPlacementUuids()
    const after2 = await db.prepare(`SELECT placement_uuid FROM broll_searches WHERE plan_pipeline_id = ?`).get(planPid)

    expect(after2.placement_uuid).toBe(after1.placement_uuid)
  }, TEST_TIMEOUT)
})
