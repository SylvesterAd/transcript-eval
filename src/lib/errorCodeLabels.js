// 15-code error_code enum → human-string mapping for State F's
// per-failure diagnostics list. Pure module: no React, no extension
// imports, no side effects.
//
// Source of truth: extension/modules/telemetry.js:185–201 (ERROR_CODE_ENUM).
// The 15 codes are copied as a literal below — do NOT import from
// extension/, which lives in a separate module graph from the web
// app's Vite build tree.
//
// Labels are 6–12 words, phrased to tell the non-technical user what
// happened and (where applicable) what to do next. If a new code lands
// in the extension enum, add it here AND bump the exhaustiveness test
// in src/lib/__tests__/errorCodeLabels.test.js.

export const ERROR_CODE_LABELS = Object.freeze({
  envato_403:                   'Envato blocked this asset (403) — license issue',
  envato_402_tier:              'Envato plan tier doesn\'t include this asset',
  envato_429:                   'Envato rate-limited — try again in a few minutes',
  envato_session_401:           'Envato session expired — sign in again',
  envato_unavailable:           'Envato item unavailable (delisted or removed)',
  envato_unsupported_filetype:  'Envato returned an unsupported file format',
  freepik_404:                  'Freepik item not found (removed or invalid)',
  freepik_429:                  'Freepik rate-limited — try again in a few minutes',
  freepik_unconfigured:         'Freepik API key not set — contact support',
  pexels_404:                   'Pexels item not found (removed or invalid)',
  network_failed:               'Network error — check your connection and retry',
  disk_failed:                  'Couldn\'t write to disk — check free space and permissions',
  integrity_failed:             'Downloaded file failed integrity check — corrupt or tampered',
  resolve_failed:               'Couldn\'t locate the source file — try again later',
  url_expired_refetch_failed:   'Download URL expired — server refused to renew',
})

// Null-safe getter with a readable fallback. State F calls this per
// failed item; the extension may normalize an unknown raw string to
// null (see extension/modules/telemetry.js normalizeErrorCode), so we
// must handle null gracefully.
export function getErrorLabel(code) {
  if (code == null) return 'Unknown error — check diagnostic bundle for details'
  const label = ERROR_CODE_LABELS[code]
  if (typeof label === 'string' && label.length > 0) return label
  return `Unknown error (${code})`
}
