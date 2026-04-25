// JWT lifecycle for the extension. Storage is chrome.storage.local;
// nothing persists in service worker memory because MV3 service
// workers are terminated aggressively. Every caller reads fresh.

const STORAGE_KEY = 'te:jwt'

// Envato session cookies — watched for appear/disappear transitions
// that mean the user signed in or out. Both are required for a
// logged-in session; either missing = no session.
const ENVATO_COOKIE_NAMES = ['envato_client_id', 'elements.session.5']
const ENVATO_COOKIE_DOMAIN = '.envato.com'

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

// True if a JWT is present AND not expired. Called by popup + SW
// to decide whether the extension is "connected" to transcript-eval.
export async function hasValidJwt() {
  const jwt = await getJwt()
  if (!jwt) return false
  return jwt.expires_at > Date.now()
}

// Reads .envato.com cookies. Returns true ONLY if both
// envato_client_id and elements.session.5 are present (name-match
// only; we don't validate cookie value — Envato's server does that).
//
// chrome.cookies.get matches cookies whose Domain attribute is
// compatible with the given URL. A cookie scoped to "elements.envato.com"
// will NOT match a query for "https://www.envato.com/", so we have
// to probe multiple URLs to cover where Envato actually scopes the
// session cookie post-sign-in. Order is most-likely first.
const ENVATO_COOKIE_PROBE_URLS = [
  'https://elements.envato.com/',
  'https://www.envato.com/',
  'https://account.envato.com/',
]
export async function hasEnvatoSession() {
  const results = await Promise.all(ENVATO_COOKIE_NAMES.map(name => (async () => {
    for (const url of ENVATO_COOKIE_PROBE_URLS) {
      const cookie = await new Promise(resolve =>
        chrome.cookies.get({ url, name }, resolve)
      )
      if (cookie) return cookie
    }
    return null
  })()))
  return results.every(c => !!c)
}

// Network pre-flight: hits download.data with the reference UUID to
// confirm Envato actually recognizes the session (cookies present is
// necessary but not sufficient — Envato may have invalidated on its
// side). Returns a structured result so the caller can distinguish
// "401 — session missing" (user action needed) from "5xx / network
// error" (transient) from "reference UUID delisted" (rotate the
// constant).
export async function checkEnvatoSessionLive() {
  const url = `https://app.envato.com/download.data?itemUuid=${encodeURIComponent(ENVATO_REFERENCE_UUID)}&itemType=stock-video&_routes=routes/download/route`
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
    if (!ENVATO_COOKIE_NAMES.includes(c.name)) return
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
