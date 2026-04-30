// Integration test against a real Postgres DB. Uses DATABASE_URL from env.
// Mocks only the network call (fetch) to the GPU; everything else is real.
//
// SKIPPED BY DEFAULT. Opt in with RUN_BROLL_WORKER_INTEGRATION=1 because:
// (1) the worker's drain loop, by design, picks up *any* `status='waiting'`
//     row in the table — running this test against a shared/production DB
//     drains real production rows;
// (2) without a proper isolated test DB, opt-in is the safest default.
// To run locally, ensure DATABASE_URL points at a throw-away DB that you
// don't mind seeing 'failed' rows in, then:
//   RUN_BROLL_WORKER_INTEGRATION=1 npm test -- server/services/__tests__/broll-search-worker.integration.test.js

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const skip = !process.env.DATABASE_URL || !process.env.RUN_BROLL_WORKER_INTEGRATION

const d = skip ? describe.skip : describe

d('broll-search-worker integration', () => {
  let db, startWorker, stopWorker, _resetForTest
  let testRowIds = []

  beforeEach(async () => {
    db = (await import('../../db.js')).default
    const w = await import('../broll-search-worker.js')
    startWorker = w.startWorker
    stopWorker = w.stopWorker
    _resetForTest = w._resetForTest

    // Insert a fixture row directly
    const r = await db.prepare(`
      INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, status)
      VALUES (?, ?, ?, ?, 'waiting') RETURNING id
    `).run('integration-test-plan', 'integration-test-batch', 0, 0)
    testRowIds.push(r.lastInsertRowid)

    // Stub fetch to avoid real GPU call
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ results: [{ id: 'fake-result' }], search_count: 1 }),
      clone() { return this },
      text: async () => '{}',
    })
  })

  afterEach(async () => {
    await stopWorker()
    _resetForTest()
    if (testRowIds.length) {
      await db.prepare(`DELETE FROM broll_searches WHERE id = ANY($1)`).run(testRowIds)
      testRowIds = []
    }
    vi.restoreAllMocks()
  })

  it('drains a fixture row to a terminal status', async () => {
    await startWorker()

    // Poll the row for up to 30s waiting for status to change from 'waiting'
    const id = testRowIds[0]
    let row
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      row = await db.prepare(`SELECT id, status, api_log_id FROM broll_searches WHERE id = ?`).get(id)
      if (row && row.status !== 'waiting') break
    }

    expect(row.status).not.toBe('waiting')
    expect(row.status).not.toBe('running')
    // Worker may produce 'failed' if GPU stub returns nothing usable; either way row was processed.
    expect(['complete', 'failed', 'timeout']).toContain(row.status)
  }, 60_000)
})
