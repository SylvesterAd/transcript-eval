// Ext.9 — feature flag fetch + enforcement gate.
//
// Public API:
//   fetchConfig()                      — fetch /api/ext-config, cache it, return result
//   getCachedConfig()                  — read cached_ext_config; return {config, fresh} or null
//   refreshConfigOnStartup()           — fire-and-forget boot refresh; populates _inFlightRefresh
//   enforceConfigBeforeExport(manifest) — gate a {type:"export"} message; returns {ok, error_code?}
//
// Internal:
//   compareSemver(a, b)                — -1 / 0 / 1 for x.y.z strings
//
// See docs/superpowers/plans/2026-04-24-extension-ext9-ext-config.md
// for the fall-open + race semantics. Do NOT change the five canonical
// error codes without a coordinated WebApp.4 update.

import {
  BACKEND_URL,
  EXT_VERSION,
  EXT_CONFIG_ENDPOINT,
  EXT_CONFIG_CACHE_TTL_MS,
  CONFIG_CHECK_AWAIT_TIMEOUT_MS,
  CONFIG_FALL_OPEN_DEFAULTS,
  CONFIG_ERROR_CODES,
} from '../config.js'

const CACHE_KEY = 'cached_ext_config'

// In-memory handle to any currently-pending fetch. enforceConfigBeforeExport
// awaits this (with a timeout) so the startup-racing-first-export edge
// case does not surface a fall-open when a fresh response is about to land.
let _inFlightRefresh = null

// Minimal x.y.z semver comparator. Pre-release tags + build metadata
// are NOT supported — this scope is fully controlled on both ends
// (EXT_VERSION + server's min_ext_version are always plain x.y.z).
// Returns -1 / 0 / 1; throws on malformed input.
export function compareSemver(a, b) {
  const parse = s => {
    if (typeof s !== 'string') throw new Error(`compareSemver: expected string, got ${typeof s}`)
    const parts = s.split('.')
    if (parts.length !== 3) throw new Error(`compareSemver: expected x.y.z, got "${s}"`)
    return parts.map((p, i) => {
      const n = Number.parseInt(p, 10)
      if (!Number.isFinite(n) || String(n) !== p || n < 0) {
        throw new Error(`compareSemver: invalid segment "${p}" in "${s}"`)
      }
      return n
    })
  }
  const pa = parse(a), pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

// Fetch /api/ext-config; on 2xx parse JSON, validate required keys,
// persist to chrome.storage.local.cached_ext_config with fetched_at.
// On network failure or non-2xx, rethrow — callers decide fall-open.
export async function fetchConfig() {
  const url = `${BACKEND_URL}${EXT_CONFIG_ENDPOINT}`
  let resp
  try {
    resp = await fetch(url, { method: 'GET', credentials: 'omit' })
  } catch (err) {
    // Network failure (DNS, offline, CORS). Caller handles fall-open.
    throw new Error(`[config-fetch] fetch failed: ${err?.message || err}`)
  }
  if (!resp.ok) {
    throw new Error(`[config-fetch] non-2xx: ${resp.status}`)
  }
  let json
  try {
    json = await resp.json()
  } catch (err) {
    throw new Error(`[config-fetch] JSON parse failed: ${err?.message || err}`)
  }
  // Minimum validation — reject obviously malformed responses.
  if (!json || typeof json !== 'object' || typeof json.min_ext_version !== 'string') {
    throw new Error(`[config-fetch] invalid response shape: ${JSON.stringify(json).slice(0, 200)}`)
  }
  const record = { config: json, fetched_at: Date.now() }
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: record })
  } catch (err) {
    console.warn('[config-fetch] cache write failed', err)
    // Do NOT rethrow — the caller has the in-memory result.
  }
  return record
}

// Read the cached config + compute freshness. Returns
// { config, fetched_at, fresh } or null if no cache exists.
// fresh === true iff Date.now() - fetched_at < EXT_CONFIG_CACHE_TTL_MS.
export async function getCachedConfig() {
  let record
  try {
    const res = await chrome.storage.local.get(CACHE_KEY)
    record = res[CACHE_KEY]
  } catch (err) {
    console.warn('[config-fetch] cache read failed', err)
    return null
  }
  if (!record || !record.config || typeof record.fetched_at !== 'number') return null
  const age = Date.now() - record.fetched_at
  return {
    config: record.config,
    fetched_at: record.fetched_at,
    fresh: age >= 0 && age < EXT_CONFIG_CACHE_TTL_MS,
  }
}

// Fire-and-forget from SW boot. Populates _inFlightRefresh so
// enforceConfigBeforeExport can await if a first export races
// with boot. Never throws — logs and swallows.
export function refreshConfigOnStartup() {
  if (_inFlightRefresh) return _inFlightRefresh
  _inFlightRefresh = (async () => {
    try {
      const record = await fetchConfig()
      return { ok: true, record }
    } catch (err) {
      console.warn('[config-fetch] refreshConfigOnStartup: fetch failed; falling back to cache or fall-open', err?.message || err)
      return { ok: false, error: String(err?.message || err) }
    } finally {
      // Clear after the Promise resolves so subsequent awaiters
      // trigger a new fetch (not wait on a resolved one forever).
      queueMicrotask(() => { _inFlightRefresh = null })
    }
  })()
  return _inFlightRefresh
}

// Exported for tests + the awaiting-logic in enforceConfigBeforeExport.
export function _getInFlightRefresh() { return _inFlightRefresh }
