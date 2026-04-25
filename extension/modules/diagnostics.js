// Ext.8 — diagnostic bundle generator + privacy redactor.
//
// Public API:
//   buildBundle()        — assembles a .zip + triggers saveAs download
//   scrubSensitive(obj)  — deep-clone + redact; exported for tests
//
// See docs/superpowers/plans/2026-04-24-extension-ext8-diagnostics.md
// § "Bundle format (v1)" for the schema. Do NOT change the layout
// without bumping DIAGNOSTICS_SCHEMA_VERSION in config.js — WebApp.4
// parses this exact shape.
//
// Redaction is defense-in-depth. Every byte that enters the ZIP has
// passed through scrubSensitive at least once. See invariant #1
// in the plan's § "Why read this before touching code".

import { zipSync, strToU8 } from './vendor/fflate.js'
import {
  EXT_VERSION,
  DIAGNOSTICS_BUNDLE_WINDOW_MS,
  DIAGNOSTICS_MAX_EVENTS,
  DIAGNOSTICS_SCHEMA_VERSION,
} from '../config.js'

// Cookie-presence probes. Names reconciled against
// extension/modules/auth.js `hasEnvatoSession` (ENVATO_COOKIE_NAMES =
// ['envato_client_id', 'elements.session.5']). auth.js probes
// https://www.envato.com/ first, falls back to https://app.envato.com/
// — we mirror that dual-probe below.
const COOKIE_DOMAINS = {
  has_envato_client_id: {
    urls: ['https://www.envato.com/', 'https://app.envato.com/'],
    name: 'envato_client_id',
  },
  has_elements_session: {
    urls: ['https://www.envato.com/', 'https://app.envato.com/'],
    name: 'elements.session.5',
  },
}

const JWT_RE     = /eyJ[A-Za-z0-9_\-]{10,}\./
const ABSPATH_RE = /^(\/Users\/|\/home\/|[A-Za-z]:\\)/
const EXPORT_SEG = /\/(export-[^\/]+)\//
const SENSITIVE_KEY_RE = /token|secret|password|auth_key|api_key/i
const EMAIL_KEY_RE     = /email/i
const EMAIL_VALUE_RE   = /[\w.+-]+@[\w-]+\.[\w.-]+/
const LONG_META_STRING = 256  // per invariant #8 fallback

/**
 * Deep-clone + redact. Returns a new object; does NOT mutate input.
 * Rules:
 *   - keys matching /token|secret|password|auth_key|api_key/i → "<redacted>"
 *   - keys matching /email/i → "<redacted-email>"
 *   - string values matching JWT prefix → "<redacted-jwt>"
 *   - string values matching absolute OS paths → collapse to
 *     ~/Downloads/transcript-eval/export-<redacted>/<basename> if
 *     recognizable, else "<redacted-path>"
 *   - email-shaped string values → replaced with "<redacted-email>"
 *   - overlong strings under meta/title/query keys → "<redacted-long-string>"
 *   - cycle-safe (WeakSet).
 */
export function scrubSensitive(input) {
  const seen = new WeakSet()
  function walk(v, keyHint) {
    if (v == null) return v
    if (typeof v === 'string') return scrubString(v, keyHint)
    if (typeof v !== 'object') return v
    if (seen.has(v)) return '<redacted-cycle>'
    seen.add(v)
    if (Array.isArray(v)) return v.map(x => walk(x, keyHint))
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (SENSITIVE_KEY_RE.test(k)) { out[k] = '<redacted>'; continue }
      if (EMAIL_KEY_RE.test(k))     { out[k] = '<redacted-email>'; continue }
      out[k] = walk(val, k)
    }
    return out
  }
  function scrubString(s, keyHint) {
    if (JWT_RE.test(s)) return '<redacted-jwt>'
    if (ABSPATH_RE.test(s)) {
      const m = s.match(EXPORT_SEG)
      if (m) {
        const base = s.split('/').pop() || ''
        return `~/Downloads/transcript-eval/export-<redacted>/${base}`
      }
      return '<redacted-path>'
    }
    if (EMAIL_VALUE_RE.test(s)) return s.replace(new RegExp(EMAIL_VALUE_RE.source, 'g'), '<redacted-email>')
    // Fallback — overlong meta strings (video titles, search queries)
    // are suspicious per invariant #8.
    if (keyHint && /meta|title|query/i.test(keyHint) && s.length > LONG_META_STRING) {
      return '<redacted-long-string>'
    }
    return s
  }
  return walk(input)
}

// Probe a cookie at each provided URL; return true on first match.
// Matches auth.js `hasEnvatoSession` dual-probe behavior.
async function probeCookie(urls, name) {
  for (const url of urls) {
    try {
      const c = await chrome.cookies.get({ url, name })
      if (c) return true
    } catch { /* continue to next URL */ }
  }
  return false
}

/**
 * Assemble a diagnostic bundle ZIP and trigger a saveAs download.
 * Returns { ok, filename, download_id, bytes }.
 *
 * Invariant #6: atomic snapshot. Single chrome.storage.local.get(null),
 * then derive every bundle file from that one snapshot so an MV3 SW
 * termination mid-assembly cannot produce a half-populated ZIP.
 *
 * Invariant #10: read-only. Does NOT mutate any storage key.
 */
export async function buildBundle() {
  const generatedAt = new Date().toISOString()
  const timestampForFilename = generatedAt.replace(/[:.]/g, '-')
  const filename = `transcript-eval-diagnostics-${timestampForFilename}.zip`

  // Atomic snapshot.
  const snapshot = await chrome.storage.local.get(null)

  // --- queue.json ---
  const windowCutoff = Date.now() - DIAGNOSTICS_BUNDLE_WINDOW_MS
  const runs = []
  for (const [k, run] of Object.entries(snapshot)) {
    if (!k.startsWith('run:') || !run || typeof run !== 'object') continue
    const ts = run.updated_at || run.created_at || 0
    if (ts < windowCutoff) continue
    runs.push(scrubSensitive(run))
  }
  const queueJson = { runs }

  // --- events.json ---
  // In-memory ring lives in telemetry.js; getRingSnapshot() is the
  // stable accessor added in Ext.8 Task 4. Persisted queue is under
  // 'telemetry_queue' per Ext.6.
  const persisted = Array.isArray(snapshot.telemetry_queue) ? snapshot.telemetry_queue : []
  const ringSnapshot = await getRingSnapshotFromTelemetry()
  const all = [...ringSnapshot, ...persisted]
  // De-dup by export_id+event+ts signature.
  const seenEvents = new Set()
  const deduped = []
  for (const ev of all) {
    const key = `${ev?.export_id}|${ev?.event}|${ev?.ts}`
    if (seenEvents.has(key)) continue
    seenEvents.add(key)
    deduped.push(ev)
  }
  deduped.sort((a, b) => (a?.ts || 0) - (b?.ts || 0))
  const truncatedFrom = deduped.length
  const kept = deduped.slice(-DIAGNOSTICS_MAX_EVENTS).map(scrubSensitive)
  const eventsJson = {
    events: kept,
    count: kept.length,
    truncated_from: truncatedFrom,
  }

  // --- environment.json ---
  const cookiePresence = {}
  for (const [key, spec] of Object.entries(COOKIE_DOMAINS)) {
    cookiePresence[key] = await probeCookie(spec.urls, spec.name)
  }
  const jwtRaw = snapshot['te:jwt'] || null
  const jwtPresence = {
    jwt_present: !!(jwtRaw && jwtRaw.token),
    jwt_expires_at: jwtRaw?.expires_at || null,
    jwt_user_id_prefix: typeof jwtRaw?.user_id === 'string' ? jwtRaw.user_id.slice(0, 8) : null,
  }
  const environmentJson = scrubSensitive({
    user_agent: (globalThis.navigator && navigator.userAgent) || '',
    platform:   (globalThis.navigator && navigator.platform) || '',
    cookie_presence: cookiePresence,
    jwt_presence: jwtPresence,
    deny_list: snapshot.deny_list || {},
    daily_counts: snapshot.daily_counts || {},
    deny_list_alerted: snapshot.deny_list_alerted || {},
    telemetry_overflow_total: snapshot.telemetry_overflow_total || 0,
    telemetry_opt_out: snapshot.telemetry_opt_out === true,
    active_run_id: snapshot.active_run_id || null,
  })

  // --- meta.json ---
  const metaJson = {
    schema_version: DIAGNOSTICS_SCHEMA_VERSION,
    ext_version: EXT_VERSION,
    manifest_version: (globalThis.chrome?.runtime?.getManifest?.()?.version) || EXT_VERSION,
    generated_at: generatedAt,
    browser_family: 'chrome',
    bundle_window_ms: DIAGNOSTICS_BUNDLE_WINDOW_MS,
    bundle_max_events: DIAGNOSTICS_MAX_EVENTS,
  }

  // --- ZIP assembly ---
  const entries = {
    'meta.json':        strToU8(JSON.stringify(metaJson, null, 2)),
    'queue.json':       strToU8(JSON.stringify(queueJson, null, 2)),
    'events.json':      strToU8(JSON.stringify(eventsJson, null, 2)),
    'environment.json': strToU8(JSON.stringify(environmentJson, null, 2)),
  }
  const zipped = zipSync(entries, { level: 6 })
  const blob = new Blob([zipped], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: true,
  })
  // Blob URL remains valid until download completes; revoke
  // defensively after a delay (Chrome holds the ref; belt-and-braces).
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { ok: true, filename, download_id: downloadId, bytes: zipped.byteLength }
}

// telemetry.js grows a getRingSnapshot() in Task 4. We resolve it
// lazily via dynamic import to avoid a static cycle (telemetry.js
// may later import from diagnostics.js for test utilities, and this
// keeps the module-init order flexible for both production and
// mocked-chrome test harnesses).
let _telemetryRingGetter = null
export function _setRingGetter(fn) { _telemetryRingGetter = fn }
async function getRingSnapshotFromTelemetry() {
  if (_telemetryRingGetter) {
    try { return (await _telemetryRingGetter()) || [] } catch { return [] }
  }
  try {
    const mod = await import('./telemetry.js')
    return typeof mod.getRingSnapshot === 'function' ? (mod.getRingSnapshot() || []) : []
  } catch { return [] }
}
