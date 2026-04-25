// Compile-time extension config. Chrome extensions cannot read .env
// at runtime — config is baked in at build time. ENV = "dev" on the
// unpacked build, "prod" when packaged for the Chrome Web Store.
// Change ENV by editing this file before packaging; there's no
// build-step substitution yet (added in Ext.10).

export const EXT_VERSION = '0.9.0'
export const ENV = 'dev'  // "dev" | "prod"

export const BACKEND_URL = ENV === 'prod'
  ? 'https://backend-production-4b19.up.railway.app'
  : 'http://localhost:3001'

// Message protocol version. Bump only on breaking changes to the
// web app ↔ extension message shape. See spec § "Versioning".
export const MESSAGE_VERSION = 1

// Resolver timing — Phase 1 waits this long for elements.envato.com/...
// to client-redirect to app.envato.com/<uuid>. 15s chosen to tolerate
// a slow network + cold Envato cache without hanging forever.
export const RESOLVER_TIMEOUT_MS = 15000

// Per-stage worker pool sizes. Ext.2/3 capped everything at 1 for
// isolated debugging; Ext.5 is where the real queue runs concurrent
// workers. Per the spec's "Large exports" table: 5 resolvers, 5
// licensers, 3 downloaders. Tune here; every pool reads these.
export const MAX_ENVATO_RESOLVER_CONCURRENCY = 5
export const MAX_ENVATO_LICENSE_CONCURRENCY = 5
export const MAX_DOWNLOAD_CONCURRENCY = 3

// Legacy alias — Ext.2's single debug path still imports this.
// Kept so the Ext.2 debug handler keeps working without edits.
export const MAX_RESOLVER_CONCURRENCY = 1

// Per-item progress pushes over Port are coalesced to at most one
// push per PROGRESS_COALESCE_MS. chrome.downloads.onChanged fires
// every few hundred ms during a single large download; without
// coalescing, the Port gets hundreds of messages per second.
export const PROGRESS_COALESCE_MS = 500

// chrome.downloads.resume() retry cap for NETWORK_* interrupts.
// Per the spec: three attempts, then mark the item failed.
export const DOWNLOAD_NETWORK_RETRY_CAP = 3

// Freepik signed URLs are short-lived (Phase 1 backend mints with
// ~15 min TTL; Freepik's own TTL is 15-60 min). Ext.3 aborts the
// download if the URL is within 60s of expiry rather than starting
// a transfer that may 403 mid-stream. Full refetch-on-expiry lands
// in Ext.5/Ext.7; this constant is the grace window.
export const FREEPIK_URL_GRACE_MS = 60000

// -------- Ext.6 telemetry --------
//
// Source of truth for every tunable the telemetry module reads. If you
// find yourself adding a magic number inside modules/telemetry.js,
// back up and add it here instead — Ext.8's opt-out switch and Ext.9's
// kill switch both need to inspect these constants from other modules.

// In-memory ring buffer size. The happy-path fast-path: successful
// emits land here and flush in a single 202 round-trip. Overflow into
// chrome.storage.local only when the flush loop is behind or paused.
export const TELEMETRY_BUFFER_SIZE = 50

// Hard cap on the persisted overflow queue. Beyond this, oldest
// events are dropped and an overflow counter is incremented. Per
// spec: 500.
export const TELEMETRY_MAX_QUEUE_SIZE = 500

// Exponential-backoff retry on transient failure (5xx / network /
// timeout). Starts at BASE_MS, doubles up to MAX_MS, with jitter of
// ±JITTER (fraction of the current wait).
export const TELEMETRY_RETRY_BASE_MS = 2000
export const TELEMETRY_RETRY_MAX_MS = 60000
export const TELEMETRY_RETRY_JITTER = 0.2

// Offline flush interval: how often the background loop wakes to
// re-attempt a flush when parked in an offline / 401 / no-JWT state.
// On successful flush we drain eagerly until the queue is empty.
export const TELEMETRY_FLUSH_INTERVAL_MS = 5000

// Allowed event names. Single source of truth for the client-side
// assertion that prevents drift from the backend's ALLOWED_EVENTS set
// in server/services/exports.js. Any emit with an unlisted `event`
// logs a warn and is dropped (see telemetry.js for the assert). If you
// need a new event, add it here AND to server/services/exports.js in
// the same commit — they MUST match.
export const TELEMETRY_EVENT_ENUM = Object.freeze([
  'export_started',
  'item_resolved',
  'item_licensed',
  'item_downloaded',
  'item_failed',
  'rate_limit_hit',
  'session_expired',
  'queue_paused',
  'queue_resumed',
  'export_completed',
])

// -------- Ext.7 failure-mode polish --------
//
// Source of truth for retry timings, backoff caps, and daily-cap
// thresholds. Ext.9 will serve these from /api/ext-config; for now
// they are compile-time baked in.

// Resolver tab retry: one retry at +30s on timeout, then give up.
export const RESOLVER_RETRY_DELAY_MS = 30000
export const RESOLVER_MAX_ATTEMPTS   = 2  // initial + 1 retry

// Envato download.data 5xx / network exponential backoff: 1s, 5s, 15s, 60s,
// then license_failed. Four total attempts.
export const ENVATO_LICENSE_BACKOFF_MS = [1000, 5000, 15000, 60000]

// Retry-After clamp (in seconds). Envato may return absurd values
// or a misbehaving CDN may return garbage; clamp to a sane window so
// we never sleep for days.
export const RETRY_AFTER_MIN_SEC = 1
export const RETRY_AFTER_MAX_SEC = 600

// Jitter applied to Retry-After values. Spec says ±20%.
export const RETRY_AFTER_JITTER = 0.20

// 429 escalation: after second 429, pause the queue this long, then
// one final retry before hard-stop.
export const ENVATO_429_COOLDOWN_MS = 5 * 60 * 1000  // 5 minutes

// Daily cap per source per user. Warn at warn_at; hard-stop (that
// source) at hard_stop_at.
export const DAILY_CAP_WARN_AT      = 400
export const DAILY_CAP_HARD_STOP_AT = 500

// Deny-list alert dedupe window. One Slack alert per
// (source_item_id, error_code) per this many ms.
export const DENY_LIST_ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000  // 24h

// Freepik URL-refetch-on-expiry cap. After this many refetches that
// still yield an expired URL, mark url_expired_refetch_failed.
export const FREEPIK_URL_REFETCH_CAP = 2

// Integrity check: size-mismatch tolerance. If the downloaded size
// is within ±N% of est_size_bytes, accept (some CDNs return slightly
// different sizes than the catalogue claimed). Below / above → retry
// once, then integrity_failed.
export const INTEGRITY_TOLERANCE = 0.05  // ±5%

// -------- Ext.8 diagnostics + privacy --------
//
// Source of truth for the diagnostic bundle's time-window + event
// cap. WebApp.4's bundle parser reads these indirectly via the
// bundle's meta.json (bundle_window_ms + bundle_max_events mirror
// these at generation time — a schema_version bump is required if
// we ever change the semantics).

// Queue-state inclusion window for buildBundle(). Runs older than
// this are skipped entirely. 24h is the spec-stated value.
export const DIAGNOSTICS_BUNDLE_WINDOW_MS = 24 * 60 * 60 * 1000

// Hard cap on event count in the bundle. If more events exist,
// the oldest are dropped (events.json.truncated_from records the
// original size). 200 is the spec-stated value.
export const DIAGNOSTICS_MAX_EVENTS = 200

// Bundle schema version. Bump when changing the on-disk JSON
// shape; WebApp.4's parser must support each prior version.
export const DIAGNOSTICS_SCHEMA_VERSION = 1

// -------- Ext.9 feature flag fetch --------
//
// Source of truth for /api/ext-config consumption. Keep this block
// in sync with server/routes/ext-config.js — both share the 60s
// TTL contract (server sets Cache-Control: public, max-age=60).

// Endpoint path appended to BACKEND_URL. PUBLIC (no auth) — must stay
// public so newly-installed extensions can gate BEFORE JWT mint.
export const EXT_CONFIG_ENDPOINT = '/api/ext-config'

// Cache TTL in ms. Fresh (<60s) → trust. Stale (>60s) + fetch failure
// → trust stale with a warning log. No cache at all + fetch failure
// → fall open (see CONFIG_FALL_OPEN_DEFAULTS).
export const EXT_CONFIG_CACHE_TTL_MS = 60 * 1000

// Max wait for an in-flight startup refresh when the first
// {type:"export"} races with SW boot. Past this, fall back to
// cached / fall-open.
export const CONFIG_CHECK_AWAIT_TIMEOUT_MS = 5000

// Fall-open defaults — what enforceConfigBeforeExport uses when no
// cache exists AND fetch failed. Match Backend 1.5 DEFAULTS where
// they are "on"; freepik_enabled is true here (vs false in server
// DEFAULTS) because fall-open means "backend unreachable" — a remote
// safety flag cannot be honored when we cannot reach the remote.
// The user gets Freepik; if Freepik is broken upstream, the download
// itself will fail with a clear per-item error.
export const CONFIG_FALL_OPEN_DEFAULTS = Object.freeze({
  min_ext_version:      '0.0.0',
  export_enabled:       true,
  envato_enabled:       true,
  pexels_enabled:       true,
  freepik_enabled:      true,
  daily_cap_override:   null,
  slack_alerts_enabled: false,  // client doesn't care — pass-through field
})

// Canonical error codes emitted by enforceConfigBeforeExport on reject.
// WebApp.4 / popup key UI off these exact strings — do NOT rename.
export const CONFIG_ERROR_CODES = Object.freeze({
  EXPORT_DISABLED:    'export_disabled_by_config',
  VERSION_BELOW_MIN:  'ext_version_below_min',
  ENVATO_DISABLED:    'envato_disabled_by_config',
  PEXELS_DISABLED:    'pexels_disabled_by_config',
  FREEPIK_DISABLED:   'freepik_disabled_by_config',
})
