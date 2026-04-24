// Ext.9 — config-fetch unit tests.
//
// Covers:
//   compareSemver: equal, greater, lesser, invalid input rejection.
//   enforceConfigBeforeExport: healthy pass-through; each reject code;
//     fall-open on no-cache + network failure; stale-cache + failure
//     uses stale; awaits in-flight refresh up to timeout.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock chrome.storage.local before importing the module under test.
beforeEach(() => {
  const store = new Map()
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key) => {
          if (typeof key === 'string') return { [key]: store.get(key) }
          if (Array.isArray(key)) {
            const out = {}
            for (const k of key) out[k] = store.get(k)
            return out
          }
          return Object.fromEntries(store)
        }),
        set: vi.fn(async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v) }),
      },
    },
  }
  globalThis.fetch = vi.fn()
  // Reset the module state (e.g. _inFlightRefresh) between tests by
  // invalidating the import cache — vitest resetModules() needed.
  vi.resetModules()
})

describe('compareSemver', () => {
  it('returns 0 for equal versions', async () => {
    const { compareSemver } = await import('../config-fetch.js')
    expect(compareSemver('0.9.0', '0.9.0')).toBe(0)
  })
  it('returns 1 for greater', async () => {
    const { compareSemver } = await import('../config-fetch.js')
    expect(compareSemver('0.9.0', '0.8.5')).toBe(1)
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1)
  })
  it('returns -1 for lesser', async () => {
    const { compareSemver } = await import('../config-fetch.js')
    expect(compareSemver('0.8.5', '0.9.0')).toBe(-1)
  })
  it('throws on malformed input', async () => {
    const { compareSemver } = await import('../config-fetch.js')
    expect(() => compareSemver('1.0', '1.0.0')).toThrow(/x\.y\.z/)
    expect(() => compareSemver('1.a.0', '1.0.0')).toThrow(/invalid segment/)
  })
})

describe('enforceConfigBeforeExport', () => {
  const makeManifest = (sources) => ({ items: sources.map(s => ({ source: s })) })

  it('pass-through on healthy fresh cache', async () => {
    const { enforceConfigBeforeExport } = await import('../config-fetch.js')
    await chrome.storage.local.set({
      cached_ext_config: {
        config: { min_ext_version: '0.1.0', export_enabled: true, envato_enabled: true, pexels_enabled: true, freepik_enabled: true },
        fetched_at: Date.now(),
      },
    })
    const result = await enforceConfigBeforeExport(makeManifest(['envato']))
    expect(result.ok).toBe(true)
  })

  it('rejects export_disabled_by_config', async () => {
    const { enforceConfigBeforeExport } = await import('../config-fetch.js')
    await chrome.storage.local.set({
      cached_ext_config: {
        config: { min_ext_version: '0.1.0', export_enabled: false, envato_enabled: true, pexels_enabled: true, freepik_enabled: true },
        fetched_at: Date.now(),
      },
    })
    const result = await enforceConfigBeforeExport(makeManifest(['envato']))
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('export_disabled_by_config')
  })

  it('rejects ext_version_below_min with current + min fields', async () => {
    const { enforceConfigBeforeExport } = await import('../config-fetch.js')
    await chrome.storage.local.set({
      cached_ext_config: {
        config: { min_ext_version: '99.0.0', export_enabled: true, envato_enabled: true, pexels_enabled: true, freepik_enabled: true },
        fetched_at: Date.now(),
      },
    })
    const result = await enforceConfigBeforeExport(makeManifest(['envato']))
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('ext_version_below_min')
    expect(result.min).toBe('99.0.0')
    expect(result.current).toBeDefined()
  })

  it('rejects envato_disabled_by_config only if envato is in the manifest', async () => {
    const { enforceConfigBeforeExport } = await import('../config-fetch.js')
    await chrome.storage.local.set({
      cached_ext_config: {
        config: { min_ext_version: '0.1.0', export_enabled: true, envato_enabled: false, pexels_enabled: true, freepik_enabled: true },
        fetched_at: Date.now(),
      },
    })
    // Manifest has NO envato — pass.
    let result = await enforceConfigBeforeExport(makeManifest(['pexels']))
    expect(result.ok).toBe(true)
    // Manifest HAS envato — reject.
    result = await enforceConfigBeforeExport(makeManifest(['envato']))
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('envato_disabled_by_config')
  })

  it('rejects freepik_disabled_by_config only if freepik is in the manifest', async () => {
    const { enforceConfigBeforeExport } = await import('../config-fetch.js')
    await chrome.storage.local.set({
      cached_ext_config: {
        config: { min_ext_version: '0.1.0', export_enabled: true, envato_enabled: true, pexels_enabled: true, freepik_enabled: false },
        fetched_at: Date.now(),
      },
    })
    const result = await enforceConfigBeforeExport(makeManifest(['freepik', 'envato']))
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('freepik_disabled_by_config')
  })

  it('falls open on no cache + network failure', async () => {
    const { enforceConfigBeforeExport } = await import('../config-fetch.js')
    globalThis.fetch.mockRejectedValueOnce(new Error('offline'))
    const result = await enforceConfigBeforeExport(makeManifest(['envato']))
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('fall_open_no_cache_no_network')
  })

  it('uses stale cache on fetch failure (less bad than fall-open)', async () => {
    const { enforceConfigBeforeExport } = await import('../config-fetch.js')
    await chrome.storage.local.set({
      cached_ext_config: {
        config: { min_ext_version: '0.1.0', export_enabled: false, envato_enabled: true, pexels_enabled: true, freepik_enabled: true },
        fetched_at: Date.now() - 5 * 60 * 1000,  // 5 min old — STALE
      },
    })
    globalThis.fetch.mockRejectedValueOnce(new Error('offline'))
    const result = await enforceConfigBeforeExport(makeManifest(['envato']))
    // Stale cache says export_enabled=false — trust it, don't fall open.
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('export_disabled_by_config')
  })

  it('awaits in-flight refresh when one is pending', async () => {
    const mod = await import('../config-fetch.js')
    // Kick off a slow refresh.
    let resolveFetch
    globalThis.fetch.mockImplementationOnce(() => new Promise(resolve => {
      resolveFetch = () => resolve({
        ok: true,
        json: async () => ({ min_ext_version: '0.1.0', export_enabled: true, envato_enabled: true, pexels_enabled: true, freepik_enabled: true }),
      })
    }))
    const refreshPromise = mod.refreshConfigOnStartup()
    // Enforcement awaits the refresh.
    const enforcePromise = mod.enforceConfigBeforeExport({ items: [{ source: 'envato' }] })
    // Resolve the refresh NOW.
    resolveFetch()
    await refreshPromise
    const result = await enforcePromise
    expect(result.ok).toBe(true)
  })
})
