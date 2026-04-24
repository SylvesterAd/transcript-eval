// Promise-wrapped chrome.runtime.sendMessage helpers.
//
// chrome.runtime.sendMessage(EXT_ID, msg, callback) is callback-only
// AND chrome.runtime.lastError is not surfaced via the callback's
// arguments — you have to read it inside the callback. If you forget,
// Chrome silently logs a warning and your response is undefined.
//
// `send()` here:
//   - rejects if chrome.runtime is missing (non-Chrome browser, or
//     extension not installed and Chrome blocks the channel).
//   - rejects with the lastError message if Chrome reports one.
//   - resolves with the response otherwise.
//
// All exported helpers wrap `send()` and add a `.installed` boolean
// to the result (true when send succeeded, false when it rejected
// with a "Could not establish connection" / "Receiving end does not
// exist" error — the canonical "extension not installed" signals).

import { useMemo } from 'react'
import { EXT_ID } from '../lib/extension-id.js'

// Chrome reports a few distinct phrasings when the extension isn't
// reachable. Match on substrings rather than exact equality so we
// stay tolerant across Chrome versions / locales.
function isNotInstalledError(message) {
  if (!message || typeof message !== 'string') return false
  const m = message.toLowerCase()
  return (
    m.includes('could not establish connection') ||
    m.includes('receiving end does not exist') ||
    m.includes('no extension') ||
    m.includes('not exist')
  )
}

function send(msg, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
      reject(new Error('chrome.runtime.sendMessage is not available — non-Chrome browser?'))
      return
    }
    if (!EXT_ID) {
      reject(new Error('EXT_ID is empty (see src/lib/extension-id.js)'))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`extension message timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    try {
      chrome.runtime.sendMessage(EXT_ID, msg, (response) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const lastErr = chrome.runtime.lastError
        if (lastErr) {
          reject(new Error(lastErr.message || 'unknown chrome.runtime.lastError'))
          return
        }
        resolve(response)
      })
    } catch (e) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    }
  })
}

// Hook that returns memoized helpers. Hooks are the React-idiomatic
// way to hand functions to components, even when those functions
// don't close over state. Memoize so the identity is stable across
// renders (useEffect deps stay sane).
export function useExtension() {
  return useMemo(() => ({
    ping: async () => {
      try {
        const r = await send({ type: 'ping', version: 1 }, { timeoutMs: 3000 })
        return {
          installed: true,
          ext_version: r?.ext_version ?? null,
          envato_session: r?.envato_session ?? 'missing',
          has_jwt: !!r?.has_jwt,
          jwt_expires_at: r?.jwt_expires_at ?? null,
          raw: r,
        }
      } catch (err) {
        if (isNotInstalledError(err.message)) {
          return { installed: false, reason: 'not_installed' }
        }
        return { installed: false, reason: 'error', error: err.message }
      }
    },

    // Mints a session JWT via Phase 1 backend, then forwards to the
    // extension. Caller passes the minted token object; this helper
    // only does the chrome.runtime.sendMessage half so callers can
    // mint once and reuse.
    sendSession: async ({ token, kid, user_id, expires_at }) => {
      const r = await send({ type: 'session', version: 1, token, kid, user_id, expires_at })
      if (!r?.ok) throw new Error(r?.error || 'extension rejected session')
      return r
    },

    // Phase A: one-shot export send. Ext.5 will replace this with a
    // long-lived Port; State D wiring lives in the next webapp plan.
    // Manifest is the array buildManifest produced; target_folder is
    // the display string we showed in State C; options is the
    // checkbox state from State C.
    sendExport: async ({ export_id, manifest, target_folder, options }) => {
      const r = await send({
        type: 'export', version: 1,
        export_id, manifest, target_folder, options,
      }, { timeoutMs: 10000 })
      // Extension ack shape isn't strictly defined yet (Ext.5 owns it);
      // accept anything truthy that doesn't carry .error as success.
      if (r?.error) throw new Error(r.error)
      return r ?? { ok: true }
    },
  }), [])
}
