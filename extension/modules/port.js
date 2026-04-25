// Long-lived Port registry. ONE active port at a time — the export
// page on the web app. Ext.5 may extend this if multi-tab becomes a
// thing (spec allows a single active run per user, so multi-tab is
// unlikely).
//
// onConnectExternal fires when the web app calls
// chrome.runtime.connect(EXT_ID). We stash the port at module scope
// so any SW code path (envato.js error, sources.js refresh, cookie
// watcher state change) can call broadcastToPort() without passing
// the port around.
//
// Security: the web app's origin is checked against an allow-list
// before accepting a port. Matches externally_connectable's matches
// entry in manifest.json. A rogue page on another origin cannot
// attach.

import { setJwt } from './auth.js'

// Mirrors manifest.json externally_connectable.matches. Keep this list
// aligned with the manifest.
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://transcript-eval.com',
  'https://transcript-eval.vercel.app',
  'https://transcript-eval-sylvesterads-projects.vercel.app',
  'https://transcript-eval-git-main-sylvesterads-projects.vercel.app',
]

// Module-scoped singletons — the Port lives here.
let activePort = null
let activeSenderUrl = null

// Pending resolvers for refreshSessionViaPort() — each call adds one;
// the next inbound {type:"session"} resolves the first; any
// disconnect rejects them all.
const pendingSessionResolvers = []

function isOriginAllowed(url) {
  try {
    const u = new URL(url)
    const origin = `${u.protocol}//${u.host}`
    return ALLOWED_ORIGINS.includes(origin)
  } catch {
    return false
  }
}

// Called by service_worker.js at top level. Wires onConnectExternal
// and dispatches inbound messages / disconnect to user handlers.
//
// onConnect / onDisconnect / onMessage callbacks are optional —
// service_worker.js uses them to log lifecycle + route
// non-auth-related inbound messages (e.g. Ext.5's queue commands).
export function registerPortHandler({ onConnect, onDisconnect, onMessage } = {}) {
  chrome.runtime.onConnectExternal.addListener((port) => {
    const senderUrl = port?.sender?.url || ''
    if (!isOriginAllowed(senderUrl)) {
      try { port.disconnect() } catch {}
      return
    }

    // If another port is already active, disconnect the old one.
    // Simpler than queuing; matches "single active run" semantics.
    if (activePort && activePort !== port) {
      try { activePort.disconnect() } catch {}
    }

    activePort = port
    activeSenderUrl = senderUrl
    onConnect?.({ port, senderUrl })

    port.onMessage.addListener(async (msg) => {
      if (!msg || typeof msg !== 'object') return
      // Auth-related inbound messages are handled HERE (centralized)
      // so other modules don't have to subscribe.
      if (msg.type === 'session') {
        const { token, kid, user_id, expires_at } = msg
        try {
          await setJwt({ token, kid, user_id, expires_at })
          // Resolve all pending refreshers.
          while (pendingSessionResolvers.length) {
            const r = pendingSessionResolvers.shift()
            r.resolve({ token, kid, user_id, expires_at })
          }
        } catch (err) {
          // Bad shape — reject pending refreshers so they don't hang.
          while (pendingSessionResolvers.length) {
            const r = pendingSessionResolvers.shift()
            r.reject(new Error('bad_session_shape: ' + String(err?.message || err)))
          }
        }
        return
      }
      onMessage?.(msg, { port, senderUrl })
    })

    port.onDisconnect.addListener(() => {
      if (activePort === port) {
        activePort = null
        activeSenderUrl = null
      }
      // Reject any still-pending refreshers; their 10s timeout would
      // have fired anyway, but this makes failure fast.
      while (pendingSessionResolvers.length) {
        const r = pendingSessionResolvers.shift()
        r.reject(new Error('port_disconnected'))
      }
      onDisconnect?.({ senderUrl })
    })
  })
}

// Returns the current active Port or null. Safe to call at any time.
// Consumers should treat null as "no export page open."
export function getActivePort() {
  if (!activePort) return null
  return { port: activePort, senderUrl: activeSenderUrl }
}

// Posts a message to the active port. No-op if no port is attached.
// Caller passes plain objects; we wrap in try/catch because Chrome
// can throw if the port is mid-disconnect.
export function broadcastToPort(msg) {
  if (!activePort) return false
  try {
    activePort.postMessage(msg)
    return true
  } catch {
    return false
  }
}

// Used by refreshSessionViaPort in auth.js. Returns a promise that
// resolves on the next inbound {type:"session"} OR rejects on the
// configured timeout (default 10s). The promise is added to
// pendingSessionResolvers; the onMessage and onDisconnect listeners
// above drain the queue.
export function waitForNextSessionMessage(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject }
    pendingSessionResolvers.push(entry)
    setTimeout(() => {
      const idx = pendingSessionResolvers.indexOf(entry)
      if (idx !== -1) {
        pendingSessionResolvers.splice(idx, 1)
        reject(new Error('refresh_timeout'))
      }
    }, timeoutMs)
  })
}
