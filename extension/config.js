// Compile-time extension config. Chrome extensions cannot read .env
// at runtime — config is baked in at build time. ENV = "dev" on the
// unpacked build, "prod" when packaged for the Chrome Web Store.
// Change ENV by editing this file before packaging; there's no
// build-step substitution yet (added in Ext.10).

export const EXT_VERSION = '0.4.0'
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

// Concurrency cap for hidden-tab resolvers. Ext.2 serves one item per
// user click so the cap is 1; Ext.5 raises this to 5 with a real pool.
// Keep the constant here so the bump point is a single-line edit.
export const MAX_RESOLVER_CONCURRENCY = 1

// Freepik signed URLs are short-lived (Phase 1 backend mints with
// ~15 min TTL; Freepik's own TTL is 15-60 min). Ext.3 aborts the
// download if the URL is within 60s of expiry rather than starting
// a transfer that may 403 mid-stream. Full refetch-on-expiry lands
// in Ext.5/Ext.7; this constant is the grace window.
export const FREEPIK_URL_GRACE_MS = 60000
