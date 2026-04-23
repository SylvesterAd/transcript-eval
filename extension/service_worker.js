// MV3 service worker — Ext.1 scope.
//
// Handles one-shot chrome.runtime.onMessageExternal messages from the
// web app. No Port handling yet (that comes in Ext.5 when the export
// page opens a long-lived connection).
//
// IMPORTANT: the listener must return `true` so sendResponse stays
// valid while the async handler runs. Otherwise the web app sees
// `undefined` for every reply.

import { EXT_VERSION, MESSAGE_VERSION } from './config.js'
import { getJwt, setJwt, hasValidJwt } from './modules/auth.js'

async function handlePing() {
  const jwt = await getJwt()
  return {
    type: 'pong',
    version: MESSAGE_VERSION,
    ext_version: EXT_VERSION,
    envato_session: 'missing',   // Ext.1 has no cookie watcher yet — always "missing"
    has_jwt: !!jwt && jwt.expires_at > Date.now(),
    jwt_expires_at: jwt?.expires_at ?? null,
  }
}

async function handleSession(msg) {
  const { token, kid, user_id, expires_at } = msg
  try {
    await setJwt({ token, kid, user_id, expires_at })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: 'invalid_session_shape', detail: String(err?.message || err) }
  }
}

function isSupportedVersion(v) {
  // Accept current and N-1 per spec § "Versioning". Ext.1 only knows v1.
  return v === MESSAGE_VERSION
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    if (!msg || typeof msg !== 'object') {
      sendResponse({ error: 'bad_message' })
      return
    }
    if (!isSupportedVersion(msg.version)) {
      sendResponse({ error: 'unsupported_version', supported: [MESSAGE_VERSION] })
      return
    }

    switch (msg.type) {
      case 'ping':
        sendResponse(await handlePing())
        return
      case 'session':
        sendResponse(await handleSession(msg))
        return
      default:
        sendResponse({ error: 'unknown_type', type: msg.type })
        return
    }
  })()
  return true  // keep sendResponse alive for the async handler above
})
