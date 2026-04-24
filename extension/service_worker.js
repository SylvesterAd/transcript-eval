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
import {
  getJwt, setJwt, hasValidJwt,
  hasEnvatoSession, checkEnvatoSessionLive, onEnvatoSessionChange,
} from './modules/auth.js'
import { downloadEnvato } from './modules/envato.js'
import { downloadSourceItem } from './modules/sources.js'
import { registerPortHandler, broadcastToPort } from './modules/port.js'

async function handlePing() {
  const jwt = await getJwt()
  const { envato_session_status } = await chrome.storage.local.get('envato_session_status')
  // If the cookie watcher hasn't fired yet (fresh SW wake), fall
  // back to a best-effort read; still fast (no network).
  const envatoStatus = envato_session_status || (await hasEnvatoSession() ? 'ok' : 'missing')
  return {
    type: 'pong',
    version: MESSAGE_VERSION,
    ext_version: EXT_VERSION,
    envato_session: envatoStatus,
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

// Ext.2 debug handler — fires the full 3-phase Envato flow for ONE
// item. NOT user-facing; only triggered from the dev test page.
// The message does not require a valid JWT — the debug path doesn't
// emit telemetry yet (that lands in Ext.6). We accept it regardless
// so a fresh Chrome profile can exercise the flow without first
// doing a {type:"session"} round-trip.
async function handleDebugEnvatoOneShot(msg) {
  const { item_id, envato_item_url, run_id, sanitized_filename } = msg
  if (typeof item_id !== 'string' || !item_id) {
    return { ok: false, errorCode: 'bad_input', detail: 'item_id required' }
  }
  if (typeof envato_item_url !== 'string' || !envato_item_url) {
    return { ok: false, errorCode: 'bad_input', detail: 'envato_item_url required' }
  }
  try {
    const result = await downloadEnvato({
      envatoItemUrl: envato_item_url,
      itemId: item_id,
      runId: run_id,                 // may be undefined — Ext.2 ignores it
      sanitizedFilename: sanitized_filename, // may be undefined — default envato_<id>.<ext>
    })
    return result
  } catch (err) {
    // downloadEnvato returns rather than throwing, but be defensive.
    return { ok: false, errorCode: 'unhandled_error', detail: String(err?.message || err) }
  }
}

// Ext.3 debug handler — fires the full Pexels OR Freepik flow for
// ONE item via the server-proxied /api/<source>-url endpoints.
// NOT user-facing; only triggered from the dev test page.
//
// REQUIRES a valid JWT in chrome.storage.local (mint one via
// {type:"session"} from the test page first). Unlike the Envato
// debug handler, this flow posts to the backend with Bearer auth.
async function handleDebugSourceOneShot(msg) {
  const { source, item_id, run_id, sanitized_filename } = msg
  if (source !== 'pexels' && source !== 'freepik') {
    return { ok: false, errorCode: 'bad_input', detail: 'source must be "pexels" or "freepik"' }
  }
  if (!item_id || (typeof item_id !== 'string' && typeof item_id !== 'number')) {
    return { ok: false, errorCode: 'bad_input', detail: 'item_id required (string or number)' }
  }
  try {
    const result = await downloadSourceItem({
      source,
      itemId: item_id,
      runId: run_id,                  // may be undefined — Ext.3 ignores it
      sanitizedFilename: sanitized_filename,  // may be undefined — default <source>_<id>.<ext>
    })
    return result
  } catch (err) {
    // downloadSourceItem returns rather than throwing, but be defensive.
    return { ok: false, errorCode: 'unhandled_error', detail: String(err?.message || err) }
  }
}

// Ext.4 debug: fire an ad-hoc pre-flight check from the test page.
// Useful for "did my change to ENVATO_REFERENCE_UUID work?" loops.
async function handleDebugCheckEnvatoSession() {
  const cookiesOk = await hasEnvatoSession()
  const live = await checkEnvatoSessionLive()
  return {
    ok: true,
    cookies_ok: cookiesOk,
    live,
  }
}

function isSupportedVersion(v) {
  // Accept current and N-1 per spec § "Versioning". Ext.1 only knows v1.
  return v === MESSAGE_VERSION
}

// --- Ext.4: long-lived port registration ---
// Called once at SW boot. Future SW wake-ups re-run this file from
// scratch, which re-registers. onConnectExternal listeners are
// idempotent per registration call.
registerPortHandler({
  onConnect({ senderUrl }) { console.log('[port] connected from', senderUrl) },
  onDisconnect({ senderUrl }) { console.log('[port] disconnected from', senderUrl) },
  onMessage(msg, { senderUrl }) {
    // Ext.5 will route {type:"export"|"pause"|"resume"|"cancel"}
    // here. Ext.4 only knows {type:"session"} (handled inside
    // port.js). Anything else is logged and dropped.
    console.log('[port] inbound message', msg, 'from', senderUrl)
  },
})

// --- Ext.4: Envato cookie watcher ---
onEnvatoSessionChange(async ({ status }) => {
  await chrome.storage.local.set({ envato_session_status: status })
  broadcastToPort({ type: 'state', version: MESSAGE_VERSION, envato_session: status })
  if (status === 'missing') {
    try {
      chrome.action.setBadgeText({ text: '!' })
      chrome.action.setBadgeBackgroundColor({ color: '#dc2626' })
    } catch {}
  } else {
    try {
      chrome.action.setBadgeText({ text: '' })
    } catch {}
  }
  console.log('[envato-cookies] status ->', status)
})

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
      case 'debug_envato_one_shot':
        sendResponse(await handleDebugEnvatoOneShot(msg))
        return
      case 'debug_source_one_shot':
        sendResponse(await handleDebugSourceOneShot(msg))
        return
      case 'debug_check_envato_session':
        sendResponse(await handleDebugCheckEnvatoSession())
        return
      default:
        sendResponse({ error: 'unknown_type', type: msg.type })
        return
    }
  })()
  return true  // keep sendResponse alive for the async handler above
})
