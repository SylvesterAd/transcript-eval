import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function setupChrome({ isAllowed = true } = {}) {
  globalThis.chrome = {
    extension: { isAllowedFileSchemeAccess: vi.fn(async () => isAllowed) },
    downloads: { download: vi.fn(), search: vi.fn(), onChanged: { addListener: vi.fn() } },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn() } },
    runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
  }
  globalThis.fetch = vi.fn(async (url, opts) => {
    const fixturePath = resolve(__dirname, '../../fixtures/mp4/30_cfr.mp4')
    const bytes = readFileSync(fixturePath)
    if (opts?.method === 'HEAD') {
      return new Response(null, { headers: { 'content-length': String(bytes.length) } })
    }
    return new Response(bytes, { status: 200 })
  })
}

describe('queue probe integration', () => {
  beforeEach(() => setupChrome())

  it('attaches probed_metadata to state.items[i] when permission granted', async () => {
    setupChrome({ isAllowed: true })
    const { runProbeForItem } = await import('../queue.js')
    const item = { seq: 1, final_path: '/Users/test/30_cfr.mp4', probed_metadata: undefined }
    await runProbeForItem(item)
    expect(item.probed_metadata).toMatchObject({ frameRate: 30, ntsc: false })
  })

  it('skips probe when permission denied; item.probed_metadata stays undefined', async () => {
    setupChrome({ isAllowed: false })
    const { runProbeForItem } = await import('../queue.js')
    const item = { seq: 1, final_path: '/Users/test/30_cfr.mp4', probed_metadata: undefined }
    await runProbeForItem(item)
    expect(item.probed_metadata).toBeUndefined()
  })

  it('emits fps_probe_skipped_no_permission once per run when denied', async () => {
    setupChrome({ isAllowed: false })
    const emit = vi.fn()
    const { runProbeForItem } = await import('../queue.js')
    const items = [
      { seq: 1, final_path: '/Users/test/a.mp4' },
      { seq: 2, final_path: '/Users/test/b.mp4' },
      { seq: 3, final_path: '/Users/test/c.mp4' },
    ]
    const ctx = { hasEmittedSkipForRun: false }
    for (const item of items) {
      await runProbeForItem(item, { emit, runContext: ctx })
    }
    const skipCalls = emit.mock.calls.filter(c => c[0] === 'fps_probe_skipped_no_permission')
    expect(skipCalls.length).toBe(1)
  })
})

describe('queue probe respects fps_probe_enabled flag', () => {
  // Uses _setProbeConfigOverride test hook (exported from queue.js) rather
  // than vi.doMock — ESM live-binding semantics make re-import mocking
  // unreliable across vitest workers. The hook is a deliberate seam for this
  // exact scenario (plan step 7 pre-approved this fallback).

  it('skips probe when getCachedConfig returns fps_probe_enabled=false', async () => {
    setupChrome({ isAllowed: true })
    const { runProbeForItem, _setProbeConfigOverride } = await import('../queue.js')
    _setProbeConfigOverride({ fps_probe_enabled: false })
    const emit = vi.fn()
    const item = { seq: 1, final_path: '/Users/test/30_cfr.mp4', probed_metadata: undefined }
    await runProbeForItem(item, { emit })
    _setProbeConfigOverride(null)
    expect(item.probed_metadata).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('fps_probe_skipped_remote_kill', expect.any(Object))
  })

  it('emits fps_probe_skipped_remote_kill once per run with runContext', async () => {
    setupChrome({ isAllowed: true })
    const { runProbeForItem, _setProbeConfigOverride } = await import('../queue.js')
    _setProbeConfigOverride({ fps_probe_enabled: false })
    const emit = vi.fn()
    const ctx = { hasEmittedSkipForRun: false }
    const items = [
      { seq: 1, final_path: '/Users/test/a.mp4' },
      { seq: 2, final_path: '/Users/test/b.mp4' },
    ]
    for (const item of items) {
      await runProbeForItem(item, { emit, runContext: ctx })
    }
    _setProbeConfigOverride(null)
    const killCalls = emit.mock.calls.filter(c => c[0] === 'fps_probe_skipped_remote_kill')
    expect(killCalls.length).toBe(1)
  })

  it('runs probe normally when fps_probe_enabled=true', async () => {
    setupChrome({ isAllowed: true })
    const { runProbeForItem, _setProbeConfigOverride } = await import('../queue.js')
    _setProbeConfigOverride({ fps_probe_enabled: true })
    const item = { seq: 1, final_path: '/Users/test/30_cfr.mp4', probed_metadata: undefined }
    await runProbeForItem(item)
    _setProbeConfigOverride(null)
    expect(item.probed_metadata).toMatchObject({ frameRate: 30 })
  })
})

describe('queue snapshot exposes probed_metadata', () => {
  it('snapshot.items[i] includes probed_metadata when set', async () => {
    setupChrome({ isAllowed: true })
    const { buildItemSnapshot } = await import('../queue.js')
    const item = {
      seq: 2, source: 'envato', source_item_id: 'NXG', target_filename: 'a.mov',
      phase: 'completed', bytes_received: 1000, total_bytes: 1000,
      error_code: null, final_path: '/Users/test/a.mov',
      probed_metadata: { frameRate: 30, ntsc: false, width: 1920, height: 1080,
                         durationSeconds: 12.3, embeddedTimecode: '01:00:00:00' },
    }
    const snap = buildItemSnapshot(item)
    expect(snap.probed_metadata).toEqual(item.probed_metadata)
  })

  it('snapshot.items[i] omits probed_metadata when undefined', async () => {
    setupChrome({ isAllowed: false })
    const { buildItemSnapshot } = await import('../queue.js')
    const item = {
      seq: 2, source: 'envato', source_item_id: 'NXG', target_filename: 'a.mov',
      phase: 'completed', bytes_received: 0, total_bytes: 0,
      error_code: null, final_path: null, probed_metadata: undefined,
    }
    const snap = buildItemSnapshot(item)
    expect(snap.probed_metadata).toBeUndefined()
  })
})
