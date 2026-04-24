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
