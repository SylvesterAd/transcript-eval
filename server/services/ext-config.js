import semver from 'semver'

// Defaults — what the extension would receive if every EXT_* env var
// were unset. These match the defaults baked into the extension itself
// (Ext.9), so a 5xx from this endpoint produces the same behavior as a
// healthy "everything-on" response.
const DEFAULTS = Object.freeze({
  min_ext_version:      '0.1.0',
  export_enabled:       true,
  envato_enabled:       true,
  pexels_enabled:       true,
  freepik_enabled:      false,   // ships off until Ext.3 is verified end-to-end
  daily_cap_override:   null,
  slack_alerts_enabled: true,
})

// Module-load assertion: if EXT_MIN_VERSION is set, it must be valid
// semver. Loud failure on boot beats silent default in production.
const RAW_MIN_VERSION = process.env.EXT_MIN_VERSION
if (RAW_MIN_VERSION !== undefined && semver.valid(RAW_MIN_VERSION) === null) {
  throw new Error(
    `[ext-config] EXT_MIN_VERSION is set to "${RAW_MIN_VERSION}" but is not a valid semver string. ` +
    `Set it to something like "0.1.0" or unset it to use the default "${DEFAULTS.min_ext_version}".`
  )
}

// 'true'/'1' → true; 'false'/'0' → false; anything else (incl. undefined,
// empty string, garbage) → fallback. Case-insensitive.
export function parseBool(value, fallback) {
  if (value === undefined || value === null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return fallback
}

// Parse EXT_DAILY_CAP_OVERRIDE → integer | null. Unset → null.
// Non-integer / non-positive → null (with a console.warn so the
// operator notices in Railway logs).
function parseDailyCapOverride(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || String(n) !== String(raw).trim() || n < 0) {
    console.warn(`[ext-config] EXT_DAILY_CAP_OVERRIDE="${raw}" is not a non-negative integer; treating as null`)
    return null
  }
  return n
}

// Read env vars on every call (NOT cached) so flag flips via Railway's
// "edit variable + restart" land immediately on the next request.
// process.env reads are O(1); no measurable overhead.
export function getExtConfig() {
  const minVersion = process.env.EXT_MIN_VERSION || DEFAULTS.min_ext_version

  return {
    min_ext_version:      minVersion,
    export_enabled:       parseBool(process.env.EXT_EXPORT_ENABLED,        DEFAULTS.export_enabled),
    envato_enabled:       parseBool(process.env.EXT_ENVATO_ENABLED,        DEFAULTS.envato_enabled),
    pexels_enabled:       parseBool(process.env.EXT_PEXELS_ENABLED,        DEFAULTS.pexels_enabled),
    freepik_enabled:      parseBool(process.env.EXT_FREEPIK_ENABLED,       DEFAULTS.freepik_enabled),
    daily_cap_override:   parseDailyCapOverride(process.env.EXT_DAILY_CAP_OVERRIDE),
    slack_alerts_enabled: parseBool(process.env.EXT_SLACK_ALERTS_ENABLED,  DEFAULTS.slack_alerts_enabled),
  }
}

// Exported for tests / future admin tooling. Consumers should NOT
// mutate the returned object.
export { DEFAULTS }
