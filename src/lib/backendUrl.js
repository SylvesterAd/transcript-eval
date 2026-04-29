// Resolves the absolute URL of the backend the web app is talking to.
// Used by useExtension.sendSession to tell the extension which host
// to call for /api/<source>-url, /api/export-events, /api/ext-config.
//
// Resolution order:
//   1. VITE_BACKEND_URL — explicit override (set in `.env` for local
//      dev pointing at a non-default port; Vercel can leave unset).
//   2. VITE_API_URL — if it's already absolute, derive the origin.
//   3. Heuristic: localhost host → localhost:3001, anything else →
//      production Railway URL.
//
// The fallback is intentionally conservative: a hardcoded prod URL
// keeps a packaged extension working when the web app omits
// backend_url (older builds, fallback paths). The dynamic value
// shipped on each session message is what enables a single packaged
// extension to serve both prod and dev users.

const PROD_BACKEND_URL = 'https://backend-production-4b19.up.railway.app'

export function resolveBackendUrl() {
  const explicit = import.meta.env?.VITE_BACKEND_URL
  if (typeof explicit === 'string' && /^https?:\/\//.test(explicit)) {
    return explicit.replace(/\/+$/, '')
  }
  const apiUrl = import.meta.env?.VITE_API_URL
  if (typeof apiUrl === 'string' && /^https?:\/\//.test(apiUrl)) {
    try {
      const u = new URL(apiUrl)
      return `${u.protocol}//${u.host}`
    } catch { /* fall through */ }
  }
  if (typeof window !== 'undefined' && window.location?.hostname === 'localhost') {
    return 'http://localhost:3001'
  }
  return PROD_BACKEND_URL
}
