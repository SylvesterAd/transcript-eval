// Regression test: buildInitialRunState must preserve manifest items'
// pre-populated `signed_url` (set by the server for A-roll items so
// the queue can skip the mint phase and download the Cloudflare URL
// directly). When this field was hardcoded to null, A-roll downloads
// fell into getSignedUrlForSource → unknown-source throw, which the
// classifier mis-routed to freepik_404 ("Freepik item not found").

import { describe, it, expect, vi, beforeEach } from 'vitest'

// queue.js imports from auth/sources/etc which all touch chrome.*. We
// only need buildInitialRunState — a pure transform — so stub the
// chrome global before importing.
beforeEach(() => {
  globalThis.chrome = {
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
    runtime: { onConnect: { addListener: () => {} }, onMessage: { addListener: () => {} } },
    downloads: { onChanged: { addListener: () => {} }, onCreated: { addListener: () => {} } },
    power: { requestKeepAwake: () => {}, releaseKeepAwake: () => {} },
  }
  vi.resetModules()
})

describe('pickAbsoluteFolder', () => {
  it('extracts the parent folder from any item with final_path', async () => {
    const { pickAbsoluteFolder } = await import('../queue.js')
    const items = [
      { source_item_id: 'a', final_path: null },
      { source_item_id: 'b', final_path: '/Users/laurynas/Downloads/transcript-eval/export-370-a/002_pexels_x.mp4' },
      { source_item_id: 'c', final_path: '/Users/laurynas/Downloads/transcript-eval/export-370-a/003_envato_y.mov' },
    ]
    expect(pickAbsoluteFolder(items)).toBe('/Users/laurynas/Downloads/transcript-eval/export-370-a')
  })

  it('returns null when no item carries final_path', async () => {
    const { pickAbsoluteFolder } = await import('../queue.js')
    expect(pickAbsoluteFolder([{ final_path: null }, { final_path: '' }])).toBe(null)
    expect(pickAbsoluteFolder([])).toBe(null)
    expect(pickAbsoluteFolder(null)).toBe(null)
  })

  it('handles Windows-style backslash paths', async () => {
    const { pickAbsoluteFolder } = await import('../queue.js')
    const items = [{ final_path: 'C:\\Users\\jane\\Downloads\\export-1\\001_x.mp4' }]
    expect(pickAbsoluteFolder(items)).toBe('C:\\Users\\jane\\Downloads\\export-1')
  })
})

describe('buildInitialRunState', () => {
  it('preserves manifest items[].signed_url (A-roll Cloudflare URL passthrough)', async () => {
    const { buildInitialRunState } = await import('../queue.js')
    const manifest = [
      {
        source: 'aroll',
        source_item_id: '370',
        target_filename: '001_aroll_370.mp4',
        signed_url: 'https://videodelivery.net/abc123/manifest/video.mp4',
        est_size_bytes: 100,
      },
      {
        source: 'pexels',
        source_item_id: 'p1',
        target_filename: '002_pexels_p1.mp4',
        // pexels mints JIT — manifest doesn't carry signed_url
      },
    ]
    const state = buildInitialRunState({ runId: 'r1', manifest, targetFolder: '~/Downloads/x', options: {}, userId: 'u' })
    expect(state.items[0].signed_url).toBe('https://videodelivery.net/abc123/manifest/video.mp4')
    expect(state.items[1].signed_url).toBe(null)
  })

  it('falls back to null when signed_url is missing or empty', async () => {
    const { buildInitialRunState } = await import('../queue.js')
    const manifest = [
      { source: 'envato', source_item_id: 'e1', target_filename: '001_envato_e1.mov' },
      { source: 'aroll',  source_item_id: '5', target_filename: '002_aroll_5.mp4', signed_url: '' },
    ]
    const state = buildInitialRunState({ runId: 'r2', manifest, targetFolder: '', options: {}, userId: 'u' })
    expect(state.items[0].signed_url).toBe(null)
    expect(state.items[1].signed_url).toBe(null)
  })
})
