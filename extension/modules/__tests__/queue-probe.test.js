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
