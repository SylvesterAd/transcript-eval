// src/pages/admin/__tests__/SupportBundle.test.jsx
//
// Smoke tests for the /admin/support page. happy-dom env. Mocks:
//   - fetch (the /parse call)
//   - apiGet (the correlation call)
//   - supabaseClient (so getAuthHeaders is a no-op)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../hooks/useApi.js', () => ({
  apiGet: vi.fn(),
}))
vi.mock('../../../lib/supabaseClient.js', () => ({ supabase: null }))

import SupportBundle from '../SupportBundle.jsx'
import { apiGet } from '../../../hooks/useApi.js'
import fixture from './fixtures/sample-bundle-v1.json'

describe('<SupportBundle />', () => {
  let root, container, originalFetch

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalFetch = globalThis.fetch
    apiGet.mockReset()
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
  })

  it('renders upload form on mount', async () => {
    await act(async () => { root.render(createElement(SupportBundle)) })
    expect(container.querySelector('input[type="file"]')).not.toBeNull()
  })

  it('renders all four sections after a successful parse', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixture,
    })
    apiGet.mockResolvedValue({
      export: { id: '01EXPORTABCD', user_id: 'u-1', status: 'complete', created_at: '2026-04-24', completed_at: null, folder_path: '~/d' },
      events: [],
      aggregates: { fail_count: 0, success_count: 0, by_source: {}, by_error_code: {} },
    })

    await act(async () => { root.render(createElement(SupportBundle)) })
    const input = container.querySelector('input[type="file"]')
    const file = new File([new Uint8Array([1])], 'bundle.zip', { type: 'application/zip' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // Flush microtasks so fetch promise + apiGet promise resolve.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = container.innerHTML
    expect(html).toMatch(/Bundle Meta/)
    expect(html).toMatch(/Queue State/)
    expect(html).toMatch(/Events/)
    expect(html).toMatch(/Environment/)
  })

  it('renders unsupported-version banner on 422', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: 'unsupported_bundle_version', supported_versions: [1], got: 2 }),
    })

    await act(async () => { root.render(createElement(SupportBundle)) })
    const input = container.querySelector('input[type="file"]')
    const file = new File([new Uint8Array([1])], 'v2.zip', { type: 'application/zip' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.innerHTML).toMatch(/Unsupported bundle version/)
  })
})
