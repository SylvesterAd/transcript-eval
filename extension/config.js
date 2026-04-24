// Compile-time extension config. Chrome extensions cannot read .env
// at runtime — config is baked in at build time. ENV = "dev" on the
// unpacked build, "prod" when packaged for the Chrome Web Store.
// Change ENV by editing this file before packaging; there's no
// build-step substitution yet (added in Ext.10).

export const EXT_VERSION = '0.6.0'
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
