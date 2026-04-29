// server/routes/__tests__/broll-export-plans.test.js
//
// Unit tests for buildExportPlansList — the pure transform that turns
// broll_runs rows into an A/B/C-labelled plans list for the export page.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    prepare() {
      return {
        async all() { return [] },
        async get() { return null },
        async run() { return { lastInsertRowid: 0 } },
      }
    },
  },
}))

import { buildExportPlansList } from '../broll.js'

function row(pid, status, createdAt) {
  return {
    metadata_json: JSON.stringify({ pipelineId: pid }),
    status,
    created_at: createdAt,
  }
}

// Row with both pipelineId AND strategyPipelineId. Mirrors what the
// real plan-stage runs carry so we can assert editor-matching label
// ordering.
function rowWithStrat(pid, strat, status, createdAt) {
  return {
    metadata_json: JSON.stringify({ pipelineId: pid, strategyPipelineId: strat }),
    status,
    created_at: createdAt,
  }
}

describe('buildExportPlansList', () => {
  it('returns empty array for empty input', () => {
    expect(buildExportPlansList([])).toEqual([])
    expect(buildExportPlansList(null)).toEqual([])
    expect(buildExportPlansList(undefined)).toEqual([])
  })

  it('groups runs by pipelineId and labels in firstSeen order', () => {
    const rows = [
      row('plan-225-1000', 'complete', '2026-01-01T00:00:00Z'),
      row('plan-225-1000', 'complete', '2026-01-01T00:00:01Z'),
      row('plan-225-2000', 'complete', '2026-01-01T00:00:02Z'),
      row('plan-225-3000', 'complete', '2026-01-01T00:00:03Z'),
    ]
    expect(buildExportPlansList(rows)).toEqual([
      { plan_pipeline_id: 'plan-225-1000', label: 'Variant A' },
      { plan_pipeline_id: 'plan-225-2000', label: 'Variant B' },
      { plan_pipeline_id: 'plan-225-3000', label: 'Variant C' },
    ])
  })

  it('skips pipelines whose pipelineId does not start with plan-', () => {
    const rows = [
      row('plan-225-1', 'complete', '2026-01-01T00:00:00Z'),
      row('kw-225-1', 'complete', '2026-01-01T00:00:01Z'),
      row('bs-plan-225-1-x', 'complete', '2026-01-01T00:00:02Z'),
      row('analysis-225-1', 'complete', '2026-01-01T00:00:03Z'),
    ]
    expect(buildExportPlansList(rows)).toEqual([
      { plan_pipeline_id: 'plan-225-1', label: 'Variant A' },
    ])
  })

  it('drops a plan if any of its runs failed', () => {
    const rows = [
      row('plan-1-A', 'complete', '2026-01-01T00:00:00Z'),
      row('plan-1-A', 'failed',   '2026-01-01T00:00:01Z'),  // poisons plan A
      row('plan-1-B', 'complete', '2026-01-01T00:00:02Z'),
    ]
    expect(buildExportPlansList(rows)).toEqual([
      { plan_pipeline_id: 'plan-1-B', label: 'Variant A' },
    ])
  })

  it('orders by earliest created_at per pipeline, not insertion order', () => {
    // plan-2 has earlier createdAt than plan-1 → should be Variant A
    const rows = [
      row('plan-1', 'complete', '2026-02-01T00:00:00Z'),
      row('plan-2', 'complete', '2026-01-01T00:00:00Z'),
      row('plan-1', 'complete', '2026-02-01T00:00:01Z'),
    ]
    expect(buildExportPlansList(rows)).toEqual([
      { plan_pipeline_id: 'plan-2', label: 'Variant A' },
      { plan_pipeline_id: 'plan-1', label: 'Variant B' },
    ])
  })

  it('tolerates malformed metadata_json', () => {
    const rows = [
      { metadata_json: '{not json',  status: 'complete', created_at: '2026-01-01T00:00:00Z' },
      { metadata_json: '',           status: 'complete', created_at: '2026-01-01T00:00:01Z' },
      { metadata_json: null,         status: 'complete', created_at: '2026-01-01T00:00:02Z' },
      row('plan-x', 'complete', '2026-01-01T00:00:03Z'),
    ]
    expect(buildExportPlansList(rows)).toEqual([
      { plan_pipeline_id: 'plan-x', label: 'Variant A' },
    ])
  })

  it('labels through Variant Z without mishap (smoke test for >2 plans)', () => {
    const rows = []
    for (let i = 0; i < 5; i++) {
      rows.push(row(`plan-${i}`, 'complete', `2026-01-01T00:00:0${i}Z`))
    }
    const out = buildExportPlansList(rows)
    expect(out.map(p => p.label)).toEqual(['Variant A', 'Variant B', 'Variant C', 'Variant D', 'Variant E'])
  })

  // Editor-matching labels: BRollPanel sorts strategy variants lex by
  // strategyPipelineId with combined-strategies (cstrat-) last. Plans
  // inherit the matching letter via metadata.strategyPipelineId. We
  // mirror that here so editor's "Variant B" → server's "Variant B".
  it('orders by strategyPipelineId lexically when present (matches editor)', () => {
    // Real-world data from group 225 / video 370. Earlier-created plan
    // (plan-...547311) is bound to a LATER strategy id (...423734-ex356)
    // — so by created_at it would be Variant A but by strategy id it's
    // Variant B. The editor uses strategy id; the server must too.
    const rows = [
      rowWithStrat('plan-370-1776857547311', 'strat-370-1776856423734--ex356', 'complete', '2026-04-22T11:33:43.557Z'),
      rowWithStrat('plan-370-1776857546254', 'strat-370-1776856423733--ex357', 'complete', '2026-04-22T11:33:56.970Z'),
      rowWithStrat('plan-370-1776857548036', 'cstrat-370-1776856423734',       'complete', '2026-04-22T11:36:15.963Z'),
    ]
    expect(buildExportPlansList(rows)).toEqual([
      { plan_pipeline_id: 'plan-370-1776857546254', label: 'Variant A' },
      { plan_pipeline_id: 'plan-370-1776857547311', label: 'Variant B' },
      { plan_pipeline_id: 'plan-370-1776857548036', label: 'Variant C' },
    ])
  })

  it('always sorts cstrat- (combined) plans last regardless of lex order', () => {
    const rows = [
      // cstrat-aaa would lex-sort BEFORE strat-zzz, but combined goes last.
      rowWithStrat('plan-c', 'cstrat-aaa-bbb',     'complete', '2026-01-01T00:00:00Z'),
      rowWithStrat('plan-a', 'strat-zzz-1--exA',   'complete', '2026-01-01T00:00:01Z'),
      rowWithStrat('plan-b', 'strat-zzz-2--exB',   'complete', '2026-01-01T00:00:02Z'),
    ]
    expect(buildExportPlansList(rows)).toEqual([
      { plan_pipeline_id: 'plan-a', label: 'Variant A' },
      { plan_pipeline_id: 'plan-b', label: 'Variant B' },
      { plan_pipeline_id: 'plan-c', label: 'Variant C' },
    ])
  })

  it('falls back to firstSeen for plans missing strategyPipelineId', () => {
    const rows = [
      rowWithStrat('plan-with-strat',    'strat-zzz', 'complete', '2026-01-01T00:00:02Z'),
      row(         'plan-no-strat-late',              'complete', '2026-01-01T00:00:03Z'),
      row(         'plan-no-strat-early',             'complete', '2026-01-01T00:00:01Z'),
    ]
    // Strategy-bearing plan first (strat lex sort beats fallback),
    // then unstratted plans by firstSeen ASC.
    expect(buildExportPlansList(rows).map(p => p.plan_pipeline_id)).toEqual([
      'plan-with-strat',
      'plan-no-strat-early',
      'plan-no-strat-late',
    ])
  })
})
