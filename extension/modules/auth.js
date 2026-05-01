// JWT lifecycle for the extension. Storage is chrome.storage.local;
// nothing persists in service worker memory because MV3 service
// workers are terminated aggressively. Every caller reads fresh.

import { BACKEND_URL as DEFAULT_BACKEND_URL } from '../config.js'

const STORAGE_KEY = 'te:jwt'
// Backend URL the web app pushed via {type:"session", backend_url}.
// The extension uses this for /api/<source>-url, /api/export-events,
// and /api/ext-config. Falls back to config.js's compile-time value
// when unset (older web app, or pre-Ext.13 packaged extension).
//
// Why dynamic: a single packaged extension installed from the Chrome
// Web Store needs to talk to whichever backend the user's open web
// app is talking to. In dev that's localhost:3001; in prod it's
// Railway. The web app knows; it tells us on every session message.
const BACKEND_URL_KEY = 'te:backend_url'

// Envato session cookies — watched for appear/disappear transitions
// that mean the user signed in or out. Both must be present for a
// logged-in session; either missing = no session.
//
// envato_client_id is a stable identity tag (set on first visit).
// The Elements session cookie is VERSIONED — historically
// `elements.session.5`, but Envato rotates the suffix periodically
// (e.g. `.6`, `.7`). Hardcoding `.5` made us miss valid sessions
// whenever the version bumped, manifesting as "session missing" even
// for fully signed-in users. We now match by prefix.
const ENVATO_CLIENT_ID_NAME = 'envato_client_id'
const ENVATO_ELEMENTS_SESSION_PREFIX = 'elements.session.'
const ENVATO_COOKIE_DOMAIN = '.envato.com'

// Returns true if the cookie name is an Envato Elements session cookie
// (any version suffix). Exported for diagnostics.js / tests so they
// stay in sync with the prefix policy here.
export function isEnvatoElementsSessionCookie(name) {
  return typeof name === 'string' && name.startsWith(ENVATO_ELEMENTS_SESSION_PREFIX)
}

// Key for the cached Envato session status in chrome.storage.local.
// Kept across SW restarts so popup can render without blocking on a
// fresh cookie round-trip.
const ENVATO_STATUS_KEY = 'envato_session_status'

// Reference Envato item UUID used for the pre-flight session check.
// Must point to a currently-listed, long-lived stock-video item. If
// Envato delists it, pre-flight starts returning errors even with a
// healthy session — which we distinguish from 401 via HTTP status
// inspection.
//
// Rotation procedure: pick a new stable item from
//   https://elements.envato.com/stock-video
// open it, look at the app.envato.com/<segment>/<UUID> URL it
// redirects to, paste the UUID here.
//
// As of 2026-04: this UUID is a well-known long-lived Envato item.
// If pre-flight starts failing with non-401 status on a healthy
// account, rotate.
export const ENVATO_REFERENCE_UUID = 'c7b99c11-828b-4791-932a-37345c1740a2'

// Shape returned by POST /api/session-token and by the web app's
// {type:"session"} message:
//   { token: string, kid: string, user_id: string, expires_at: number (epoch_ms) }

export async function getJwt() {
  const { [STORAGE_KEY]: jwt } = await chrome.storage.local.get(STORAGE_KEY)
  return jwt || null
}

// Ext.6: helper used by modules/telemetry.js (and any future module)
// that needs to POST to a Bearer-authenticated backend endpoint.
// Reads the current JWT from storage and sets the Authorization
// header. Idempotent: returns the same headers object it received.
// Throws nothing — if no JWT, the header is simply not set and the
// caller is responsible for treating absence as "paused for auth".
export async function attachBearer(headers) {
  const jwt = await getJwt()
  if (jwt && jwt.token && jwt.expires_at > Date.now()) {
    headers['Authorization'] = 'Bearer ' + jwt.token
  }
  return headers
}

export async function setJwt(jwt) {
  if (!jwt || typeof jwt !== 'object' || Array.isArray(jwt)) throw new Error('setJwt: jwt must be an object')
  const { token, kid, user_id, expires_at } = jwt
  if (typeof token !== 'string' || !token) throw new Error('setJwt: token must be a non-empty string')
  if (typeof kid !== 'string' || !kid) throw new Error('setJwt: kid must be a non-empty string')
  if (typeof user_id !== 'string' || !user_id) throw new Error('setJwt: user_id must be a non-empty string')
  if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) throw new Error('setJwt: expires_at must be a finite number')
  await chrome.storage.local.set({ [STORAGE_KEY]: { token, kid, user_id, expires_at } })
}

export async function clearJwt() {
  await chrome.storage.local.remove(STORAGE_KEY)
}

// Backend URL persistence: web app sends absolute URL on session, every
// fetch helper reads it back. Validated on write so a malformed value
// can't poison subsequent fetches.
export async function setBackendUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error('setBackendUrl: url must be an absolute http(s) URL')
  }
  // Strip trailing slashes so callers can safely template `${base}/api/...`.
  const normalized = url.replace(/\/+$/, '')
  await chrome.storage.local.set({ [BACKEND_URL_KEY]: normalized })
}

export async function getBackendUrl() {
  const { [BACKEND_URL_KEY]: stored } = await chrome.storage.local.get(BACKEND_URL_KEY)
  return (typeof stored === 'string' && /^https?:\/\//.test(stored)) ? stored : DEFAULT_BACKEND_URL
}

// True if a JWT is present AND not expired. Called by popup + SW
// to decide whether the extension is "connected" to transcript-eval.
export async function hasValidJwt() {
  const jwt = await getJwt()
  if (!jwt) return false
  return jwt.expires_at > Date.now()
}

// Reads .envato.com cookies. Returns true ONLY if both an
// envato_client_id AND an elements.session.<N> cookie are present
// (name-match only; we don't validate cookie value — Envato's server
// does that on the live preflight call).
//
// We use chrome.cookies.getAll on each probe URL so the elements.session
// suffix can match any version Envato is currently shipping (.5, .6, ...).
// chrome.cookies.get can't pattern-match by name, hence getAll + filter.
const ENVATO_COOKIE_PROBE_URLS = [
  'https://elements.envato.com/',
  'https://www.envato.com/',
  'https://account.envato.com/',
]
export async function hasEnvatoSession() {
  for (const url of ENVATO_COOKIE_PROBE_URLS) {
    const cookies = await new Promise(resolve =>
      chrome.cookies.getAll({ url }, c => resolve(c || []))
    )
    const hasClientId = cookies.some(c => c.name === ENVATO_CLIENT_ID_NAME)
    const hasElementsSession = cookies.some(c => isEnvatoElementsSessionCookie(c.name))
    if (hasClientId && hasElementsSession) return true
  }
  return false
}

// Network pre-flight: hits the stock-video item's Remix loader for the
// reference UUID to confirm Envato actually recognizes the session
// (cookies present is necessary but not sufficient — Envato may have
// invalidated on its side). Returns a structured result so the caller
// can distinguish "401 — session missing" (user action needed) from
// "5xx / network error" (transient) from "reference UUID delisted"
// (rotate the constant).
//
// We deliberately probe `/stock-video/<uuid>.data` (the loader) rather
// than `/download.data` — download.data now requires an assetUuid
// query parameter (Envato's 2026 API change), and licensed-asset
// preflight would commit a download against the user's fair-use
// counter. The .data loader is auth-gated but cost-free.
export async function checkEnvatoSessionLive() {
  const url = `https://app.envato.com/stock-video/${encodeURIComponent(ENVATO_REFERENCE_UUID)}.data`
  let resp
  try {
    resp = await fetch(url, { credentials: 'include' })
  } catch (err) {
    return { status: 'error', detail: String(err?.message || err) }
  }
  if (resp.status === 401) return { status: 'missing', httpStatus: 401 }
  if (resp.ok) return { status: 'ok', httpStatus: resp.status }
  return { status: 'error', httpStatus: resp.status, detail: `pre-flight HTTP ${resp.status}` }
}

// Subscribes to chrome.cookies.onChanged, filters to envato.com +
// the two cookies we care about, calls handler({status}) when those
// cookies transition.
//
// Returns an unsubscribe function. The service worker registers ONE
// subscription at top level (in service_worker.js), so the returned
// unsubscribe is mostly for completeness / tests.
//
// The handler is called with {status:'ok'|'missing'} based on the
// CURRENT aggregate state, not the transition direction. If any
// envato cookie was just set and the OTHER is also present, status
// is 'ok'. If either is missing, status is 'missing'.
export function onEnvatoSessionChange(handler) {
  const listener = async (changeInfo) => {
    const c = changeInfo?.cookie
    if (!c) return
    // Domain match: handle both leading-dot and exact root. Chrome
    // normalizes envato-set cookies to '.envato.com' with the dot.
    const d = c.domain || ''
    const domainOk = d === ENVATO_COOKIE_DOMAIN || d === 'envato.com' || d.endsWith('.envato.com')
    if (!domainOk) return
    // Match envato_client_id OR any elements.session.<N> version.
    if (c.name !== ENVATO_CLIENT_ID_NAME && !isEnvatoElementsSessionCookie(c.name)) return
    // Re-read aggregate state (the changeInfo for one cookie doesn't
    // tell us about the other's state).
    const ok = await hasEnvatoSession()
    handler({ status: ok ? 'ok' : 'missing' })
  }
  chrome.cookies.onChanged.addListener(listener)
  return () => {
    try { chrome.cookies.onChanged.removeListener(listener) } catch {}
  }
}

// Requests a fresh JWT from the web app via the Port. Returns a
// Promise that resolves on the next inbound {type:"session"} message
// or rejects on:
//   - no port open: 'no_port'
//   - 10s timeout: 'refresh_timeout'
//   - port disconnected mid-wait: 'port_disconnected'
//
// After resolve, the new JWT is ALREADY in chrome.storage.local (the
// SW Port onMessage handler writes it before resolving this promise).
// Callers just `await refreshSessionViaPort(); await retryOriginalFetch()`.
export async function refreshSessionViaPort() {
  const { getActivePort, waitForNextSessionMessage } = await import('./port.js')
  const active = getActivePort()
  if (!active) throw new Error('no_port')
  const waitPromise = waitForNextSessionMessage(10000)
  try {
    active.port.postMessage({ type: 'refresh_session', version: 1 })
  } catch (err) {
    throw new Error('port_post_failed: ' + String(err?.message || err))
  }
  const result = await waitPromise
  // Ext.6: tell subscribers (telemetry, future Ext.9) the JWT has
  // been refreshed so they can unpark their flush loops.
  try { emitSessionRefreshed() } catch (err) { console.warn('[auth] emitSessionRefreshed threw', err) }
  return result
}

// Ext.6: session-refresh notification hub.
//
// modules/telemetry.js subscribes on load; modules/queue.js's
// Ext.5-era refreshSessionViaPort success path emits. Single-
// subscriber in practice, but the registry is multi-subscriber-safe
// so future modules (e.g. an Ext.9 /api/ext-config re-fetcher) can
// reuse without refactor.
const sessionRefreshedSubscribers = []

export function onSessionRefreshed(cb) {
  if (typeof cb !== 'function') throw new Error('onSessionRefreshed: cb must be a function')
  sessionRefreshedSubscribers.push(cb)
  // Return an unsubscribe for symmetry with onEnvatoSessionChange —
  // not currently used, but cheap.
  return () => {
    const idx = sessionRefreshedSubscribers.indexOf(cb)
    if (idx >= 0) sessionRefreshedSubscribers.splice(idx, 1)
  }
}

export function emitSessionRefreshed() {
  for (const cb of sessionRefreshedSubscribers) {
    try { cb() } catch (err) { console.warn('[auth] session-refreshed subscriber threw', err) }
  }
}
