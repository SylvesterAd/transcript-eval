// server/services/__tests__/bundle-parser.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fflate so we can control unzipSync output per test without
// needing a real ZIP byte sequence. `strFromU8` we keep real.
vi.mock('fflate', async () => {
  const actual = await vi.importActual('fflate')
  return {
    ...actual,
    unzipSync: vi.fn(),
  }
})

import { unzipSync } from 'fflate'
import { parseBundle, BundleParseError, SUPPORTED_SCHEMA_VERSIONS } from '../bundle-parser.js'

function u8(str) {
  return new TextEncoder().encode(str)
}

function validBundleFiles() {
  return {
    'meta.json': u8(JSON.stringify({
      schema_version: 1,
      ext_version: '0.8.0',
      generated_at: '2026-04-24T17:22:31.412Z',
    })),
    'queue.json': u8(JSON.stringify({
      runs: [{ run_id: '01ABC', created_at: 1, updated_at: 2, phase: 'complete', stats: { ok_count: 1, fail_count: 0 }, items: [] }],
    })),
    'events.json': u8(JSON.stringify({ events: [] })),
    'environment.json': u8(JSON.stringify({
      user_agent: 'Mozilla/5.0 ...',
      platform: 'MacIntel',
      cookie_presence: { has_envato_client_id: true },
      jwt_presence: { jwt_present: false },
      deny_list: {},
      daily_counts: {},
      telemetry_overflow_total: 0,
      telemetry_opt_out: false,
    })),
  }
}

describe('parseBundle', () => {
  beforeEach(() => { vi.mocked(unzipSync).mockReset() })
  afterEach(() => { vi.clearAllMocks() })

  it('happy path — returns all four parsed sections', () => {
    vi.mocked(unzipSync).mockReturnValue(validBundleFiles())
    const result = parseBundle(new Uint8Array([0x50, 0x4b, 0x03, 0x04])) // fake ZIP header bytes
    expect(result.meta.schema_version).toBe(1)
    expect(result.meta.ext_version).toBe('0.8.0')
    expect(result.queue.runs).toHaveLength(1)
    expect(result.events.events).toEqual([])
    expect(result.environment.user_agent).toMatch(/Mozilla/)
  })

  it('throws missing_zip_body when given null / empty / non-Uint8Array', () => {
    expect(() => parseBundle(null)).toThrow(BundleParseError)
    expect(() => parseBundle(new Uint8Array(0))).toThrow(/missing_zip_body/)
  })

  it('throws invalid_zip when fflate.unzipSync throws', () => {
    vi.mocked(unzipSync).mockImplementation(() => { throw new Error('bad zip') })
    expect.assertions(3)
    try {
      parseBundle(new Uint8Array([1, 2, 3]))
    } catch (e) {
      expect(e).toBeInstanceOf(BundleParseError)
      expect(e.errorCode).toBe('invalid_zip')
      expect(e.httpStatus).toBe(400)
    }
  })

  it('throws missing_bundle_file when meta.json is absent', () => {
    const files = validBundleFiles()
    delete files['meta.json']
    vi.mocked(unzipSync).mockReturnValue(files)
    expect.assertions(2)
    try { parseBundle(new Uint8Array([1])) } catch (e) {
      expect(e.errorCode).toBe('missing_bundle_file')
      expect(e.detail.missing).toBe('meta.json')
    }
  })

  it('throws invalid_json when environment.json is malformed', () => {
    const files = validBundleFiles()
    files['environment.json'] = u8('{ not-json')
    vi.mocked(unzipSync).mockReturnValue(files)
    expect.assertions(2)
    try { parseBundle(new Uint8Array([1])) } catch (e) {
      expect(e.errorCode).toBe('invalid_json')
      expect(e.detail.file).toBe('environment.json')
    }
  })

  it('throws unsupported_bundle_version when schema_version !== 1', () => {
    const files = validBundleFiles()
    files['meta.json'] = u8(JSON.stringify({ schema_version: 2, ext_version: '1.0.0', generated_at: 'x' }))
    vi.mocked(unzipSync).mockReturnValue(files)
    expect.assertions(4)
    try { parseBundle(new Uint8Array([1])) } catch (e) {
      expect(e.errorCode).toBe('unsupported_bundle_version')
      expect(e.httpStatus).toBe(422)
      expect(e.detail.supported_versions).toEqual(SUPPORTED_SCHEMA_VERSIONS)
      expect(e.detail.got).toBe(2)
    }
  })

  it('throws missing_required_field when environment.jwt_presence absent', () => {
    const files = validBundleFiles()
    const env = JSON.parse(new TextDecoder().decode(files['environment.json']))
    delete env.jwt_presence
    files['environment.json'] = u8(JSON.stringify(env))
    vi.mocked(unzipSync).mockReturnValue(files)
    expect.assertions(3)
    try { parseBundle(new Uint8Array([1])) } catch (e) {
      expect(e.errorCode).toBe('missing_required_field')
      expect(e.detail.file).toBe('environment.json')
      expect(e.detail.field).toBe('jwt_presence')
    }
  })
})
