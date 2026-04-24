// src/pages/admin/__tests__/ExportsList.test.jsx
//
// Smoke test only — mounts the page with a stubbed apiGet returning
// 3 fixture rows and asserts all 3 ids land in the DOM. No RTL
// (matches the project's bare-React test precedent in
// src/hooks/__tests__/useExportXmlKickoff.test.js).
//
// Environment: happy-dom (set by vitest.workspace.js `web` project).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Stub apiGet BEFORE ExportsList imports it.
vi.mock('../../../hooks/useApi.js', () => ({
  apiGet: vi.fn(),
}))

// Stub supabase (imported transitively by useApi) — it reads
// VITE_SUPABASE_URL at module load. happy-dom has no env plumbing.
vi.mock('../../../lib/supabaseClient.js', () => ({ supabase: null }))

import ExportsList from '../ExportsList.jsx'
import { apiGet } from '../../../hooks/useApi.js'

const fixtureRows = [
  {
    id: 'exp_A', user_id: 'u-1', plan_pipeline_id: 'pp-1',
    variant_labels: '["A"]', status: 'complete', folder_path: '~/Downloads/a',
    created_at: '2026-04-24T00:00:00Z', completed_at: '2026-04-24T00:05:00Z',
    failed_count: 0, downloaded_count: 3,
  },
  {
    id: 'exp_B', user_id: 'u-1', plan_pipeline_id: 'pp-2',
    variant_labels: '["A","C"]', status: 'failed', folder_path: null,
    created_at: '2026-04-23T00:00:00Z', completed_at: null,
    failed_count: 2, downloaded_count: 1,
  },
  {
    id: 'exp_C', user_id: 'u-2', plan_pipeline_id: 'pp-3',
    variant_labels: '["C"]', status: 'partial', folder_path: '~/Downloads/c',
    created_at: '2026-04-22T00:00:00Z', completed_at: '2026-04-22T00:03:00Z',
    failed_count: 1, downloaded_count: 2,
  },
]

let container
let root

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

describe('ExportsList', () => {
  it('renders all fixture rows with their ids', async () => {
    apiGet.mockResolvedValueOnce({
      exports: fixtureRows,
      total: 3,
      limit: 50,
      offset: 0,
    })
    await act(async () => {
      root.render(
        createElement(MemoryRouter, null, createElement(ExportsList)),
      )
    })
    // Let the async apiGet settle.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const text = container.textContent
    expect(text).toContain('exp_A')
    expect(text).toContain('exp_B')
    expect(text).toContain('exp_C')
    expect(text).toContain('3 total')
  })

  it('shows empty state when no rows match', async () => {
    apiGet.mockResolvedValueOnce({ exports: [], total: 0, limit: 50, offset: 0 })
    await act(async () => {
      root.render(
        createElement(MemoryRouter, null, createElement(ExportsList)),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('No exports match these filters.')
  })

  it('surfaces apiGet errors', async () => {
    apiGet.mockRejectedValueOnce(new Error('500 Internal'))
    await act(async () => {
      root.render(
        createElement(MemoryRouter, null, createElement(ExportsList)),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('500 Internal')
  })
})
