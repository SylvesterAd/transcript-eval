// Ext.8 unit tests — scrubSensitive + buildBundle contents.
//
// Runs in the 'extension' workspace project (node env). chrome.*
// globals are mocked per test; telemetry.js's getRingSnapshot is
// avoided by resetting modules and providing a mock chrome env that
// makes telemetry's module-init chrome.storage.onChanged.addListener
// a no-op.
//
// Guardrails:
//   - scrubSensitive never mutates its input.
//   - Every byte of the assembled ZIP passes through scrubSensitive
//     (we assert via a Blob-capturing probe — no "eyJ" in output).
//   - chrome.downloads.download is called with saveAs:true.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'

// Capturing Blob stub — lets us inspect the bundled bytes.
class CapturingBlob {
  constructor(parts, opts) {
    this.parts = parts
    this.type = opts?.type
    // fflate returns Uint8Array parts; concatenate for inspection.
    const first = parts?.[0]
    this.bytes = first instanceof Uint8Array ? first : new Uint8Array(0)
  }
}

function installChromeStub(overrides = {}) {
  const defaultStorage = {
    'run:01ABC': {
      run_id: '01ABC',
      created_at: Date.now() - 1000,
      updated_at: Date.now(),
      phase: 'complete',
      error_code: null,
      stats: { ok_count: 1, fail_count: 0 },
      items: [
        {
          source: 'pexels',
          source_item_id: 'X1',
          status: 'complete',
          error_code: null,
          filename: '/Users/alice/Downloads/transcript-eval/export-abc123/001_pexels_X1.mp4',
        },
      ],
    },
    telemetry_queue: [
      { export_id: '01ABC', event: 'export_started', ts: 1000, meta: {}, ext_version: '0.8.0' },
    ],
    deny_list: { envato: ['NX9WYGQ'] },
    daily_counts: { '2026-04-24': { envato: 3 } },
    deny_list_alerted: {},
    telemetry_overflow_total: 0,
    telemetry_opt_out: false,
    active_run_id: null,
    'te:jwt': {
      token: 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
      user_id: 'abcd1234efgh5678',
      expires_at: 9_999_999_999_999,
    },
    ...overrides,
  }
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async () => structuredClone(defaultStorage)),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    cookies: { get: vi.fn(async () => null) },
    downloads: { download: vi.fn(async () => 42) },
    runtime: {
      getManifest: () => ({ version: '0.8.0' }),
      lastError: null,
    },
  }
  globalThis.URL = {
    createObjectURL: vi.fn(() => 'blob:fake-url'),
    revokeObjectURL: vi.fn(),
  }
  globalThis.Blob = CapturingBlob
  // Node 20+ defines navigator as a non-writable getter; redefine
  // via Object.defineProperty to stub it in tests.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'test-ua', platform: 'test-plat' },
    writable: true,
    configurable: true,
  })
}

describe('scrubSensitive', () => {
  let scrubSensitive
  beforeEach(async () => {
    installChromeStub()
    vi.resetModules()
    ;({ scrubSensitive } = await import('../diagnostics.js'))
  })

  it('redacts values under sensitive-named keys to <redacted>', () => {
    const out = scrubSensitive({
      nested: { token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' },
    })
    expect(out.nested.token).toBe('<redacted>')
  })

  it('redacts JWT-shaped values under non-sensitive keys to <redacted-jwt>', () => {
    const out = scrubSensitive({ last_seen: 'eyJabc0123456.def.ghi' })
    expect(out.last_seen).toBe('<redacted-jwt>')
  })

  it('collapses absolute macOS paths with an export segment to the redacted pattern', () => {
    const out = scrubSensitive({
      filename: '/Users/alice/Downloads/transcript-eval/export-abc123/001_envato_X.mov',
    })
    expect(out.filename).toBe('~/Downloads/transcript-eval/export-<redacted>/001_envato_X.mov')
  })

  it('redacts absolute paths without an export segment to <redacted-path>', () => {
    const out = scrubSensitive({ path: '/Users/alice/Documents/secret.txt' })
    expect(out.path).toBe('<redacted-path>')
  })

  it('redacts email-keyed fields and email-shaped string values', () => {
    const out = scrubSensitive({ email: 'alice@gmail.com', note: 'contact alice@gmail.com please' })
    expect(out.email).toBe('<redacted-email>')
    expect(out.note).toContain('<redacted-email>')
    expect(out.note).not.toContain('@gmail.com')
  })

  it('passes primitives through unchanged', () => {
    expect(scrubSensitive(42)).toBe(42)
    expect(scrubSensitive(null)).toBe(null)
    expect(scrubSensitive('plain string')).toBe('plain string')
  })

  it('does not mutate the input object', () => {
    const input = { token: 'eyJabc0123456.def.ghi', nested: { email: 'alice@gmail.com' } }
    const frozen = JSON.parse(JSON.stringify(input))
    scrubSensitive(input)
    expect(input).toEqual(frozen)
  })

  it('is cycle-safe (does not infinite-loop on self-referential objects)', () => {
    const o = { a: 1 }
    o.self = o
    const out = scrubSensitive(o)
    expect(out.a).toBe(1)
    expect(out.self).toBe('<redacted-cycle>')
  })
})

describe('buildBundle', () => {
  let buildBundle
  beforeEach(async () => {
    installChromeStub()
    vi.resetModules()
    ;({ buildBundle } = await import('../diagnostics.js'))
  })

  it('returns ok:true with a timestamped .zip filename', async () => {
    const res = await buildBundle()
    expect(res.ok).toBe(true)
    expect(res.filename).toMatch(/^transcript-eval-diagnostics-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.*\.zip$/)
  })

  it('calls chrome.downloads.download with saveAs:true', async () => {
    await buildBundle()
    expect(globalThis.chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ saveAs: true })
    )
    const callArg = globalThis.chrome.downloads.download.mock.calls[0][0]
    expect(callArg.filename).toMatch(/\.zip$/)
    expect(callArg.url).toBe('blob:fake-url')
  })

  it('produces a ZIP containing meta/queue/events/environment JSON files', async () => {
    const res = await buildBundle()
    // Capture the bytes written into the Blob — unzip and confirm
    // all four named entries are present.
    const blobCall = globalThis.URL.createObjectURL.mock.calls[0][0]
    expect(blobCall).toBeInstanceOf(CapturingBlob)
    const unzipped = unzipSync(blobCall.bytes)
    const names = Object.keys(unzipped).sort()
    expect(names).toEqual(['environment.json', 'events.json', 'meta.json', 'queue.json'])
    expect(res.bytes).toBe(blobCall.bytes.byteLength)
  })

  it('does NOT leak JWT tokens into any bundled file', async () => {
    await buildBundle()
    const blob = globalThis.URL.createObjectURL.mock.calls[0][0]
    const unzipped = unzipSync(blob.bytes)
    for (const [name, u8] of Object.entries(unzipped)) {
      const text = strFromU8(u8)
      // Invariant #8: no raw JWT prefix anywhere in the bundle.
      expect(text, `file ${name} contains a JWT prefix`).not.toMatch(/eyJ[A-Za-z0-9_\-]{10,}\./)
    }
  })

  it('does NOT leak absolute /Users/ paths (they should be collapsed)', async () => {
    await buildBundle()
    const blob = globalThis.URL.createObjectURL.mock.calls[0][0]
    const unzipped = unzipSync(blob.bytes)
    for (const [name, u8] of Object.entries(unzipped)) {
      const text = strFromU8(u8)
      // Absolute /Users/ paths must be collapsed.
      expect(text, `file ${name} contains an absolute /Users/ path`).not.toMatch(/"\/Users\//)
    }
  })

  it('environment.json records cookie-presence booleans + jwt-presence metadata only', async () => {
    await buildBundle()
    const blob = globalThis.URL.createObjectURL.mock.calls[0][0]
    const unzipped = unzipSync(blob.bytes)
    const env = JSON.parse(strFromU8(unzipped['environment.json']))
    // Cookie presence: booleans only (mocked as absent).
    expect(typeof env.cookie_presence.has_envato_client_id).toBe('boolean')
    expect(typeof env.cookie_presence.has_elements_session).toBe('boolean')
    // JWT presence: metadata fields only, never the raw token.
    expect(env.jwt_presence.jwt_present).toBe(true)
    expect(env.jwt_presence.jwt_user_id_prefix).toBe('abcd1234')
    expect(env.jwt_presence.token).toBeUndefined()
    // telemetry_opt_out recorded.
    expect(env.telemetry_opt_out).toBe(false)
  })

  it('meta.json records the schema version + ext version', async () => {
    await buildBundle()
    const blob = globalThis.URL.createObjectURL.mock.calls[0][0]
    const unzipped = unzipSync(blob.bytes)
    const meta = JSON.parse(strFromU8(unzipped['meta.json']))
    expect(meta.schema_version).toBe(1)
    expect(meta.ext_version).toBe('0.9.0')
    expect(meta.bundle_max_events).toBe(200)
    expect(meta.bundle_window_ms).toBe(86_400_000)
  })
})
