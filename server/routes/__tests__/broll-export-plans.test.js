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
})
