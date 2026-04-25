// src/components/export/__tests__/StateF_Partial.test.jsx
//
// Component test for State F. Environment: happy-dom (web project in
// vitest.workspace.js). Uses bare createRoot + React.act — no Testing
// Library dependency per the Week 4 State E plan's convention.
//
// Covers:
//   - Failed-items list renders with human-readable labels.
//   - Retry button calls onRetryFailed with the set of failed
//     source_item_ids.
//   - "Generate XML anyway" mounts the kickoff panel (verified by
//     the hook's _apiPost test-seam being called).
//   - "Report issue" button is disabled.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Mock the useExportXmlKickoff module — we want the hook to be a
// no-op spy in this test so we can assert the XML panel mounts and
// calls regenerate() without actually posting. We do this with vi.mock
// at the top of the file.
vi.mock('../../../hooks/useExportXmlKickoff.js', async () => {
  const regenerate = vi.fn()
  return {
    useExportXmlKickoff: () => ({
      status: 'idle',
      xml_by_variant: null,
      error: null,
      regenerate,
    }),
    triggerXmlDownload: vi.fn(),
    __mockRegenerate: regenerate,  // test handle
  }
})

// Import after the mock is declared.
import StateF_Partial from '../StateF_Partial.jsx'
import * as xmlKickoffModule from '../../../hooks/useExportXmlKickoff.js'

// -------------------- Fixtures --------------------

function makeComplete() {
  return {
    ok_count: 2,
    fail_count: 3,
    folder_path: '~/Downloads/transcript-eval/',
    xml_paths: [],
  }
}

function makeSnapshot() {
  return {
    items: [
      { seq: 1, source: 'envato', source_item_id: 'OK1', target_filename: '001_envato_OK1.mov', phase: 'done' },
      { seq: 2, source: 'envato', source_item_id: 'FAIL1', target_filename: '002_envato_FAIL1.mov', phase: 'failed', error_code: 'envato_session_401' },
      { seq: 3, source: 'pexels', source_item_id: 'FAIL2', target_filename: '003_pexels_FAIL2.mp4', phase: 'failed', error_code: 'pexels_404' },
      { seq: 4, source: 'envato', source_item_id: 'OK2', target_filename: '004_envato_OK2.mov', phase: 'done' },
      { seq: 5, source: 'freepik', source_item_id: 'FAIL3', target_filename: '005_freepik_FAIL3.mp4', phase: 'failed', error_code: 'freepik_404' },
    ],
  }
}

function makeUnifiedManifest() {
  return {
    variants: ['A'],
    totals: { count: 5, est_size_bytes: 500_000_000 },
    options: { force_redownload: false },
    items: [
      { seq: 2, source: 'envato', source_item_id: 'FAIL1', target_filename: '002_envato_FAIL1.mov', envato_item_url: 'https://...', placements: [{variant:'A',timeline_start_s:0,timeline_duration_s:2}] },
      // ...
    ],
  }
}

// -------------------- Mount helper --------------------

async function mount(props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(StateF_Partial, props))
  })
  return { container, root, unmount: () => {
    act(() => root.unmount())
    document.body.removeChild(container)
  }}
}

// -------------------- Tests --------------------

describe('StateF_Partial — failed items list', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('renders 3 failed rows with human-readable labels', async () => {
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: makeSnapshot(),
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    // Three failed items → three <li> rows.
    const rows = container.querySelectorAll('li')
    expect(rows.length).toBe(3)
    // Labels from errorCodeLabels.js (envato_session_401, pexels_404, freepik_404).
    const text = container.textContent
    expect(text).toMatch(/Envato session expired/i)
    expect(text).toMatch(/Pexels item not found/i)
    expect(text).toMatch(/Freepik item not found/i)
    // Summary line: 2 / 5 clips downloaded · 3 failed.
    expect(text).toMatch(/2 \/ 5/)
    expect(text).toMatch(/3 failed/)
    unmount()
  })

  it('shows fallback text when snapshot items are missing', async () => {
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: null,
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    expect(container.textContent).toMatch(/did not include a per-item list/i)
    unmount()
  })
})

describe('StateF_Partial — Retry button', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('calls onRetryFailed with the failed source_item_ids', async () => {
    const onRetryFailed = vi.fn()
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: makeSnapshot(),
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed,
    })
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      b => /retry failed items/i.test(b.textContent)
    )
    expect(retryBtn).toBeDefined()
    expect(retryBtn.disabled).toBe(false)
    await act(async () => { retryBtn.click() })
    expect(onRetryFailed).toHaveBeenCalledTimes(1)
    const call = onRetryFailed.mock.calls[0][0]
    expect(call.failedIds).toBeInstanceOf(Set)
    expect([...call.failedIds]).toEqual(expect.arrayContaining(['FAIL1', 'FAIL2', 'FAIL3']))
    expect(call.failedIds.size).toBe(3)
    unmount()
  })

  it('is disabled when no failed items', async () => {
    const { container, unmount } = await mount({
      complete: { ok_count: 5, fail_count: 0, folder_path: 'x', xml_paths: [] },
      snapshot: { items: [] },
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      b => /retry failed items/i.test(b.textContent)
    )
    expect(retryBtn.disabled).toBe(true)
    unmount()
  })
})

describe('StateF_Partial — Generate XML anyway', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('mounts the XML panel and calls regenerate() on click', async () => {
    const { __mockRegenerate } = xmlKickoffModule
    __mockRegenerate.mockClear()
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: makeSnapshot(),
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    const xmlBtn = Array.from(container.querySelectorAll('button')).find(
      b => /generate xml anyway/i.test(b.textContent)
    )
    expect(xmlBtn).toBeDefined()
    expect(xmlBtn.disabled).toBe(false)
    await act(async () => { xmlBtn.click() })
    // After click: regenerate called via the XmlKickoffPanel's mount effect.
    expect(__mockRegenerate).toHaveBeenCalled()
    // Button is now disabled (xmlPanelShown === true).
    expect(xmlBtn.disabled).toBe(true)
    unmount()
  })
})

describe('StateF_Partial — Report issue', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('is disabled with a tooltip referencing Ext.8', async () => {
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: makeSnapshot(),
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    const reportBtn = Array.from(container.querySelectorAll('button')).find(
      b => /report issue/i.test(b.textContent)
    )
    expect(reportBtn).toBeDefined()
    expect(reportBtn.disabled).toBe(true)
    expect(reportBtn.getAttribute('title')).toMatch(/ext\.8/i)
    unmount()
  })
})
