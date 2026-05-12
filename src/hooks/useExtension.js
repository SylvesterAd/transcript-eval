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
import { EXT_ID, EXT_IDS_TO_PROBE } from '../lib/extension-id.js'
import { resolveBackendUrl } from '../lib/backendUrl.js'
import { isOutdated } from '../lib/semver.js'

/* global __EXT_LATEST_VERSION__ */
export const EXT_LATEST_VERSION =
  typeof __EXT_LATEST_VERSION__ === 'string' ? __EXT_LATEST_VERSION__ : ''

// Cached ID of whichever extension responded to the most recent
// successful ping(). sendSession/sendExport/openPort use this so a
// dev-loaded extension (whose ID differs from the Web Store build's
// pinned EXT_ID) keeps working past the initial probe.
let _activeExtId = EXT_ID

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

function send(msg, { timeoutMs = 5000, extId = _activeExtId } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
      reject(new Error('chrome.runtime.sendMessage is not available — non-Chrome browser?'))
      return
    }
    if (!extId) {
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
      chrome.runtime.sendMessage(extId, msg, (response) => {
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
      const probedIds = EXT_IDS_TO_PROBE.length ? EXT_IDS_TO_PROBE : [EXT_ID].filter(Boolean)
      let lastNonInstallError = null
      for (const id of probedIds) {
        try {
          const r = await send({ type: 'ping', version: 1 }, { timeoutMs: 3000, extId: id })
          const ext_version = r?.ext_version ?? null
          _activeExtId = id
          return {
            installed: true,
            ext_id: id,
            probed_ids: probedIds,
            ext_version,
            latest_version: EXT_LATEST_VERSION || null,
            is_outdated: isOutdated(ext_version, EXT_LATEST_VERSION),
            envato_session: r?.envato_session ?? 'missing',
            has_jwt: !!r?.has_jwt,
            jwt_expires_at: r?.jwt_expires_at ?? null,
            raw: r,
          }
        } catch (err) {
          if (!isNotInstalledError(err.message)) {
            // Real error against this ID (handler crash, timeout). Don't
            // fall through — the user has *something* installed under
            // this ID and we should surface what's wrong.
            lastNonInstallError = { id, error: err.message }
          }
          // not_installed: try next ID
        }
      }
      if (lastNonInstallError) {
        return {
          installed: false,
          reason: 'error',
          error: lastNonInstallError.error,
          ext_id: lastNonInstallError.id,
          probed_ids: probedIds,
          latest_version: EXT_LATEST_VERSION || null,
        }
      }
      return {
        installed: false,
        reason: 'not_installed',
        ext_id: EXT_ID,
        probed_ids: probedIds,
        latest_version: EXT_LATEST_VERSION || null,
      }
    },

    // Mints a session JWT via Phase 1 backend, then forwards to the
    // extension. Caller passes the minted token object; this helper
    // only does the chrome.runtime.sendMessage half so callers can
    // mint once and reuse.
    //
    // Also pushes the absolute backend URL the web app is using so a
    // single packaged extension can serve both prod and dev users
    // without recompiling — extension persists it and routes all
    // /api/<source>-url / /api/export-events / /api/ext-config calls
    // there. See extension/modules/auth.js setBackendUrl.
    sendSession: async ({ token, kid, user_id, expires_at }) => {
      const backend_url = resolveBackendUrl()
      const r = await send({ type: 'session', version: 1, token, kid, user_id, expires_at, backend_url })
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

    // Open a long-lived Port to the extension. Unlike sendMessage (one-
    // shot request/response), a Port stays open until one side calls
    // disconnect(). Used by State D's useExportPort hook to subscribe
    // to the extension's queue broadcasts: {type:"state"},
    // {type:"progress"}, {type:"item_done"}, {type:"complete"}.
    //
    // Returns a handle the caller owns: { port, disconnect }. The
    // caller is responsible for calling disconnect() on unmount.
    //
    // Auto-retries once on IMMEDIATE disconnect: if Chrome fires
    // onDisconnect synchronously (typical when EXT_ID is invalid or
    // the extension was just reloaded), we try one more connect with
    // a small delay before surfacing the error to the caller. This
    // handles the common "extension was reloaded during dev" race
    // without a user-visible blip.
    openPort: (name = 'export-tap') => {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.connect) {
        throw new Error('chrome.runtime.connect is not available — non-Chrome browser?')
      }
      const targetId = _activeExtId || EXT_ID
      if (!targetId) {
        throw new Error('EXT_ID is empty (see src/lib/extension-id.js)')
      }
      let port = null
      let retried = false
      const listeners = { message: [], disconnect: [] }

      function attach(p) {
        p.onMessage.addListener((msg) => {
          listeners.message.forEach(fn => { try { fn(msg) } catch (e) { console.error('[useExtension.openPort onMessage listener error]', e) } })
        })
        p.onDisconnect.addListener(() => {
          const lastErr = chrome.runtime.lastError
          const reason = lastErr?.message || 'disconnected'
          // Retry ONCE on immediate disconnect (extension reloaded,
          // transient), then surface to caller.
          if (!retried) {
            retried = true
            setTimeout(() => {
              try {
                const p2 = chrome.runtime.connect(targetId, { name })
                port = p2
                attach(p2)
              } catch (e) {
                listeners.disconnect.forEach(fn => { try { fn(e.message || reason) } catch {} })
              }
            }, 200)
            return
          }
          listeners.disconnect.forEach(fn => { try { fn(reason) } catch {} })
        })
      }

      try {
        port = chrome.runtime.connect(targetId, { name })
        attach(port)
      } catch (e) {
        throw new Error(`failed to open port to ${targetId}: ${e.message}`)
      }

      return {
        // Consumers use these to subscribe; plain add/remove pattern
        // so the hook consumer doesn't have to think about Chrome's
        // API quirks.
        onMessage: (fn) => {
          listeners.message.push(fn)
          return () => { listeners.message = listeners.message.filter(f => f !== fn) }
        },
        onDisconnect: (fn) => {
          listeners.disconnect.push(fn)
          return () => { listeners.disconnect = listeners.disconnect.filter(f => f !== fn) }
        },
        postMessage: (msg) => {
          try { port?.postMessage(msg) } catch (e) { console.error('[openPort.postMessage]', e) }
        },
        disconnect: () => {
          try { port?.disconnect() } catch {}
          port = null
          listeners.message = []
          listeners.disconnect = []
        },
      }
    },
  }), [])
}
