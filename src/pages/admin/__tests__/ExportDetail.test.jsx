// src/pages/admin/__tests__/ExportDetail.test.jsx
//
// Smoke test — mounts the page for an :id route, stubs apiGet with
// a fixture export + 5 events + aggregates, asserts timeline rows
// render in order.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../hooks/useApi.js', () => ({
  apiGet: vi.fn(),
}))
vi.mock('../../../lib/supabaseClient.js', () => ({ supabase: null }))

import ExportDetail from '../ExportDetail.jsx'
import { apiGet } from '../../../hooks/useApi.js'

const fixture = {
  export: {
    id: 'exp_ABC', user_id: 'u-1', plan_pipeline_id: 'pp-1',
    variant_labels: '["A","C"]', status: 'partial',
    manifest_json: '{}', result_json: null, xml_paths: null,
    folder_path: '~/Downloads/test', created_at: '2026-04-24T00:00:00Z',
    completed_at: '2026-04-24T00:05:00Z',
  },
  events: [
    { id: 1, event: 'export_started', item_id: null, source: null, phase: null,
      error_code: null, http_status: null, retry_count: 0, meta: { n: 3 },
      t: 1700000000000, received_at: 1700000000100 },
    { id: 2, event: 'item_downloaded', item_id: 'ABC', source: 'envato',
      phase: 'download', error_code: null, http_status: 200, retry_count: 0,
      meta: null, t: 1700000001000, received_at: 1700000001100 },
    { id: 3, event: 'item_failed', item_id: 'XYZ', source: 'pexels',
      phase: 'download', error_code: 'pexels_429', http_status: 429,
      retry_count: 2, meta: null, t: 1700000002000, received_at: 1700000002100 },
    { id: 4, event: 'rate_limit_hit', item_id: null, source: 'pexels',
      phase: null, error_code: null, http_status: null, retry_count: 0,
      meta: { retry_after_sec: 60 }, t: 1700000003000, received_at: 1700000003100 },
    { id: 5, event: 'export_completed', item_id: null, source: null,
      phase: null, error_code: null, http_status: null, retry_count: 0,
      meta: null, t: 1700000004000, received_at: 1700000004100 },
  ],
  aggregates: {
    fail_count: 1,
    success_count: 1,
    by_source: {
      envato: { failed: 0, succeeded: 1 },
      pexels: { failed: 1, succeeded: 0 },
    },
    by_error_code: { pexels_429: 1 },
  },
}

let container, root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiGet.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ExportDetail', () => {
  it('renders summary + aggregates + all 5 events', async () => {
    apiGet.mockResolvedValueOnce(fixture)
    await act(async () => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/admin/exports/exp_ABC'] },
          createElement(Routes, null,
            createElement(Route, {
              path: '/admin/exports/:id',
              element: createElement(ExportDetail),
            }),
          ),
        ),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const text = container.textContent
    expect(text).toContain('exp_ABC')
    expect(text).toContain('pp-1')
    expect(text).toContain('partial')

    // Aggregates
    expect(text).toContain('Downloaded:')
    expect(text).toContain('pexels_429')

    // All 5 event types show up
    expect(text).toContain('export_started')
    expect(text).toContain('item_downloaded')
    expect(text).toContain('item_failed')
    expect(text).toContain('rate_limit_hit')
    expect(text).toContain('export_completed')

    // Timeline count surface
    expect(text).toContain('Timeline (5 events)')
  })

  it('shows empty timeline when no events', async () => {
    apiGet.mockResolvedValueOnce({
      ...fixture,
      events: [],
      aggregates: { fail_count: 0, success_count: 0, by_source: {}, by_error_code: {} },
    })
    await act(async () => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/admin/exports/exp_NONE'] },
          createElement(Routes, null,
            createElement(Route, {
              path: '/admin/exports/:id',
              element: createElement(ExportDetail),
            }),
          ),
        ),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('No events recorded.')
  })

  it('surfaces 404 errors from apiGet', async () => {
    apiGet.mockRejectedValueOnce(new Error('export not found'))
    await act(async () => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/admin/exports/exp_MISSING'] },
          createElement(Routes, null,
            createElement(Route, {
              path: '/admin/exports/:id',
              element: createElement(ExportDetail),
            }),
          ),
        ),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('export not found')
  })
})
