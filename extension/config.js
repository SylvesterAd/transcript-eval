// Compile-time extension config. Chrome extensions cannot read .env
// at runtime — config is baked in at build time. ENV = "dev" on the
// unpacked build, "prod" when packaged for the Chrome Web Store.
// Change ENV by editing this file before packaging; there's no
// build-step substitution yet (added in Ext.10).

export const EXT_VERSION = '0.5.0'
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
