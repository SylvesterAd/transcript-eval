// src/hooks/__tests__/useExportXmlKickoff.test.js
//
// Covers:
//   - buildVariantsPayload: pure transform over the unified manifest
//   - triggerXmlDownload: happy-dom Blob + <a>.click assertion (smoke)
//   - useExportXmlKickoff: state machine + POST order + auto-kick on
//     `complete` transition (via a minimal renderHook-equivalent)
//
// Environment: happy-dom (set by vitest.workspace.js `web` project).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

// React 19 looks for this global to silence "act(...)" warnings in
// test environments. happy-dom doesn't pre-set it.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

import {
  buildVariantsPayload,
  triggerXmlDownload,
  useExportXmlKickoff,
} from '../useExportXmlKickoff.js'

// -------------------- Fixtures --------------------

// A single-variant unified manifest approximating what buildManifest
// returns after State C's "Start Export" in a single-variant flow.
function makeManifestSingleVariant() {
  return {
    variants: ['A'],
    totals: { count: 2, est_size_bytes: 200_000_000, by_source: { envato: 1, pexels: 1 } },
    options: { force_redownload: false },
    items: [
      {
        seq: 1,
        source: 'envato',
        source_item_id: 'NX9WYGQ',
        envato_item_url: 'https://elements.envato.com/thing-NX9WYGQ',
        target_filename: '001_envato_NX9WYGQ.mov',
        resolution: { width: 1920, height: 1080 },
        frame_rate: 30,
        est_size_bytes: 100_000_000,
        variants: ['A'],
        placements: [{ variant: 'A', timeline_start_s: 0, timeline_duration_s: 2.5 }],
      },
      {
        seq: 2,
        source: 'pexels',
        source_item_id: '123456',
        target_filename: '002_pexels_123456.mp4',
        resolution: { width: 1920, height: 1080 },
        frame_rate: 30,
        est_size_bytes: 100_000_000,
        variants: ['A'],
        placements: [{ variant: 'A', timeline_start_s: 2.5, timeline_duration_s: 3.0 }],
      },
    ],
  }
}

// Two-variant manifest: one item is shared (placements from both A and C),
// one item is A-only. Exercises dedup + per-variant slicing.
function makeManifestTwoVariant() {
  return {
    variants: ['A', 'C'],
    totals: { count: 2, est_size_bytes: 200_000_000, by_source: { envato: 2 } },
    items: [
      {
        seq: 1, source: 'envato', source_item_id: 'SHARED',
        target_filename: '001_envato_SHARED.mov',
        resolution: { width: 3840, height: 2160 }, frame_rate: 24, est_size_bytes: 100_000_000,
        variants: ['A', 'C'],
        placements: [
          { variant: 'A', timeline_start_s: 0, timeline_duration_s: 4 },
          { variant: 'C', timeline_start_s: 10, timeline_duration_s: 4 },
        ],
      },
      {
        seq: 2, source: 'envato', source_item_id: 'AONLY',
        target_filename: '002_envato_AONLY.mov',
        resolution: { width: 1920, height: 1080 }, frame_rate: 30, est_size_bytes: 100_000_000,
        variants: ['A'],
        placements: [{ variant: 'A', timeline_start_s: 4, timeline_duration_s: 2 }],
      },
    ],
  }
}

// -------------------- buildVariantsPayload --------------------

describe('buildVariantsPayload', () => {
  it('turns a single-variant manifest into one variant with seq-preserved placements', () => {
    const out = buildVariantsPayload({
      unifiedManifest: makeManifestSingleVariant(),
      variantLabels: ['A'],
    })
    expect(out).toEqual({
      variants: [{
        label: 'A',
        sequenceName: 'Variant A',
        placements: [
          {
            seq: 1,
            source: 'envato',
            sourceItemId: 'NX9WYGQ',
            filename: '001_envato_NX9WYGQ.mov',
            timelineStart: 0,
            timelineDuration: 2.5,
            width: 1920,
            height: 1080,
            sourceFrameRate: 30,
          },
          {
            seq: 2,
            source: 'pexels',
            sourceItemId: '123456',
            filename: '002_pexels_123456.mp4',
            timelineStart: 2.5,
            timelineDuration: 3.0,
            width: 1920,
            height: 1080,
            sourceFrameRate: 30,
          },
        ],
      }],
    })
  })

  it('preserves seq across variants for a shared item (multi-variant dedup)', () => {
    const out = buildVariantsPayload({
      unifiedManifest: makeManifestTwoVariant(),
      variantLabels: ['A', 'C'],
    })
    expect(out.variants.length).toBe(2)
    // Variant A: seq 1 + seq 2
    expect(out.variants[0].label).toBe('A')
    expect(out.variants[0].placements.map(p => p.seq)).toEqual([1, 2])
    // Variant C: seq 1 only (SHARED), with its C-specific timing
    expect(out.variants[1].label).toBe('C')
    expect(out.variants[1].placements.length).toBe(1)
    expect(out.variants[1].placements[0]).toMatchObject({
      seq: 1, sourceItemId: 'SHARED',
      timelineStart: 10, timelineDuration: 4,
    })
  })

  it('names sequences "Variant <label>"', () => {
    const out = buildVariantsPayload({
      unifiedManifest: makeManifestSingleVariant(),
      variantLabels: ['A'],
    })
    expect(out.variants[0].sequenceName).toBe('Variant A')
  })

  it('skips placements with null or non-finite timing', () => {
    const manifest = makeManifestSingleVariant()
    manifest.items[0].placements[0].timeline_start_s = null
    manifest.items[1].placements[0].timeline_duration_s = NaN
    const out = buildVariantsPayload({
      unifiedManifest: manifest,
      variantLabels: ['A'],
    })
    expect(out.variants[0].placements).toEqual([])
  })

  it('skips placements with zero or negative duration', () => {
    const manifest = makeManifestSingleVariant()
    manifest.items[0].placements[0].timeline_duration_s = 0
    manifest.items[1].placements[0].timeline_duration_s = -1
    const out = buildVariantsPayload({
      unifiedManifest: manifest,
      variantLabels: ['A'],
    })
    expect(out.variants[0].placements).toEqual([])
  })

  it('throws on missing unifiedManifest.items', () => {
    expect(() => buildVariantsPayload({
      unifiedManifest: null, variantLabels: ['A'],
    })).toThrow(/items required/)
  })

  it('throws on empty variantLabels', () => {
    expect(() => buildVariantsPayload({
      unifiedManifest: makeManifestSingleVariant(), variantLabels: [],
    })).toThrow(/non-empty/)
  })
})

// -------------------- triggerXmlDownload --------------------
//
// Smoke-level: assert the function (a) creates a blob URL, (b) creates
// an <a> element, (c) clicks it. We don't assert filename content
// because happy-dom's <a download> behavior is stubbed.

describe('triggerXmlDownload', () => {
  let clickSpy
  let originalClick
  beforeEach(() => {
    clickSpy = vi.fn()
    originalClick = HTMLAnchorElement.prototype.click
    // Patch all created anchors to record clicks. happy-dom's
    // HTMLAnchorElement.click is a no-op; replacing on the prototype
    // is the simplest spy.
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      value: clickSpy,
    })
  })
  afterEach(() => {
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      value: originalClick,
    })
  })

  it('creates a blob URL and clicks an anchor with the right filename', () => {
    const url = triggerXmlDownload('variant-a.xml', '<?xml version="1.0"?><xmeml/>')
    expect(typeof url).toBe('string')
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })
})

// -------------------- useExportXmlKickoff --------------------
//
// Minimal "render a hook" helper. Creates a root, renders a
// <Probe /> that captures the hook return into a ref, and exposes
// `act(() => { ... })` for flushing effects.
//
// React 19's `act` is exported from `react`, not `react-dom/test-utils`.

function renderHookOnce(useFn, props) {
  const captured = { current: null }
  function Probe(p) {
    captured.current = useFn(p)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(Probe, props)) })
  return {
    result: captured,
    rerender: (nextProps) => act(() => { root.render(createElement(Probe, nextProps)) }),
    unmount: () => act(() => { root.unmount() }),
  }
}

describe('useExportXmlKickoff', () => {
  let apiPost
  let triggerDownload
  let downloadedFilenames

  beforeEach(() => {
    downloadedFilenames = []
    apiPost = vi.fn(async (path, body) => {
      if (path.endsWith('/result')) {
        return { ok: true }
      }
      if (path.endsWith('/generate-xml')) {
        const labels = body?.variants || []
        const xml_by_variant = {}
        for (const l of labels) xml_by_variant[l] = `<?xml ${l}?><xmeml/>`
        return { xml_by_variant }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    triggerDownload = vi.fn((filename, xml) => {
      downloadedFilenames.push(filename)
      return `blob:test/${filename}`
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('auto-kicks on complete with no failures and posts both bodies in order', async () => {
    const manifest = makeManifestSingleVariant()
    const props = {
      exportId: 'exp_TEST',
      variantLabels: ['A'],
      unifiedManifest: manifest,
      complete: null,  // start idle
      _apiPost: apiPost,
      _triggerDownload: triggerDownload,
    }
    const h = renderHookOnce(useExportXmlKickoff, props)
    expect(h.result.current.status).toBe('idle')

    // Simulate the Port delivering {type:"complete"} — re-render with
    // a non-null complete. The effect should auto-kick.
    h.rerender({ ...props, complete: { ok_count: 2, fail_count: 0, folder_path: '~/Downloads/test', xml_paths: [] } })

    // Flush any pending promises (two POSTs). happy-dom doesn't need
    // fake timers; a microtask flush suffices.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(apiPost).toHaveBeenCalledTimes(2)
    expect(apiPost.mock.calls[0][0]).toMatch(/\/exports\/exp_TEST\/result$/)
    expect(apiPost.mock.calls[1][0]).toMatch(/\/exports\/exp_TEST\/generate-xml$/)
    // Body #1 is the variants shape
    expect(apiPost.mock.calls[0][1]).toMatchObject({
      variants: [{ label: 'A', sequenceName: 'Variant A' }],
    })
    // Body #2 is just the labels
    expect(apiPost.mock.calls[1][1]).toEqual({ variants: ['A'] })

    expect(h.result.current.status).toBe('ready')
    expect(h.result.current.xml_by_variant).toEqual({ A: expect.stringContaining('<?xml A?>') })
    expect(downloadedFilenames).toEqual(['variant-a.xml'])

    h.unmount()
  })

  it('does NOT auto-kick when fail_count > 0', async () => {
    const props = {
      exportId: 'exp_PARTIAL',
      variantLabels: ['A'],
      unifiedManifest: makeManifestSingleVariant(),
      complete: { ok_count: 1, fail_count: 1, folder_path: '~/Downloads/test', xml_paths: [] },
      _apiPost: apiPost,
      _triggerDownload: triggerDownload,
    }
    const h = renderHookOnce(useExportXmlKickoff, props)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    expect(apiPost).not.toHaveBeenCalled()
    expect(h.result.current.status).toBe('idle')
    h.unmount()
  })

  it('transitions to error state on POST /result failure and exposes regenerate', async () => {
    const failingApiPost = vi.fn(async (path) => {
      if (path.endsWith('/result')) throw new Error('simulated 500')
      return {}
    })
    const props = {
      exportId: 'exp_500',
      variantLabels: ['A'],
      unifiedManifest: makeManifestSingleVariant(),
      complete: { ok_count: 2, fail_count: 0, folder_path: '~/Downloads', xml_paths: [] },
      _apiPost: failingApiPost,
      _triggerDownload: triggerDownload,
    }
    const h = renderHookOnce(useExportXmlKickoff, props)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(h.result.current.status).toBe('error')
    expect(h.result.current.error).toMatch(/simulated 500/)

    // regenerate() retries the flow. Patch apiPost to succeed this
    // time; verify the state returns to 'ready'. The hook captured the
    // old apiPost in useCallback closures; rerender with the new one.
    const okApiPost = vi.fn(async (path, body) => {
      if (path.endsWith('/result')) return { ok: true }
      if (path.endsWith('/generate-xml')) {
        return { xml_by_variant: { A: '<?xml ok?><xmeml/>' } }
      }
      throw new Error(path)
    })
    h.rerender({ ...props, _apiPost: okApiPost })
    h.result.current.regenerate()
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(h.result.current.status).toBe('ready')
    h.unmount()
  })
})
