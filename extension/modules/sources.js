// Pexels + Freepik server-proxied downloads. Ext.3 scope: ONE item
// per user click. No queue, no dedupe, no retry matrix — Ext.5 and
// Ext.7 add those.
//
// Topology (different from Envato's 3-phase flow):
//   extension → backend /api/<source>-url (Bearer JWT) → signed URL
//     → chrome.downloads.download → ~/Downloads/transcript-eval/
//
// The backend holds Pexels and Freepik API keys; extension never sees
// them. Every call requires a valid JWT from Ext.1's storage.

import { BACKEND_URL, FREEPIK_URL_GRACE_MS } from '../config.js'
import { getJwt, refreshSessionViaPort } from './auth.js'

// Backend fetch with one retry on 401. Called by the Pexels + Freepik
// URL fetchers so we avoid copy-pasting the refresh dance.
//
// On first 401, try a refreshSessionViaPort() round-trip. If it
// succeeds, retry the original fetch ONCE with the (newly persisted)
// JWT. If the refresh fails (no port / 10s timeout / disconnect),
// re-throw the original 401. NO further retries — Ext.4 is
// retry-once-then-surface per spec.
export async function backendFetchWithRefresh(url, init = {}) {
  const jwt = await getJwt()
  const authedInit = {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(jwt?.token ? { 'Authorization': `Bearer ${jwt.token}` } : {}),
    },
  }
  const resp = await fetch(url, authedInit)
  if (resp.status !== 401) return resp

  // 401 path — try one refresh + retry.
  try {
    await refreshSessionViaPort()
  } catch (err) {
    // Can't recover; let the original 401 bubble up.
    return resp
  }
  const freshJwt = await getJwt()
  const retryInit = {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(freshJwt?.token ? { 'Authorization': `Bearer ${freshJwt.token}` } : {}),
    },
  }
  return fetch(url, retryInit)
}

// ---- public API ----

/**
 * Phase A (Pexels). Mints a signed Pexels video URL via backend.
 * Returns {url, filename, size_bytes, resolution: {width, height}}.
 * Throws Error('pexels_404') if the item doesn't exist upstream,
 * Error('pexels_api_error') on other non-OK responses,
 * Error('no_jwt') / Error('jwt_expired') via buildAuthHeaders,
 * Error('network_error: <detail>') on fetch failure.
 */
export async function fetchPexelsUrl({ itemId, preferredResolution = '1080p' }) {
  await ensureJwtFresh()
  let resp
  try {
    resp = await backendFetchWithRefresh(`${BACKEND_URL}/api/pexels-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, preferred_resolution: preferredResolution }),
    })
  } catch (err) {
    throw new Error('network_error: ' + String(err?.message || err))
  }

  if (resp.status === 404) throw new Error('pexels_404')
  if (!resp.ok) throw new Error('pexels_api_error')

  const data = await resp.json().catch(() => null)
  if (!data || !data.url) throw new Error('pexels_api_error')
  return data  // { url, filename, size_bytes, resolution }
}

/**
 * Phase A (Freepik). Mints a signed Freepik video URL via backend.
 * Returns {url, filename, size_bytes, expires_at}.
 * Throws Error('freepik_404'), Error('freepik_429'),
 * Error('freepik_unconfigured') on 503, Error('freepik_api_error')
 * on other 4xx/5xx, Error('no_jwt') / Error('jwt_expired') via
 * buildAuthHeaders, Error('network_error: <detail>') on fetch
 * failure.
 */
export async function fetchFreepikUrl({ itemId, format = 'mp4' }) {
  await ensureJwtFresh()
  let resp
  try {
    resp = await backendFetchWithRefresh(`${BACKEND_URL}/api/freepik-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, format }),
    })
  } catch (err) {
    throw new Error('network_error: ' + String(err?.message || err))
  }

  if (resp.status === 404) throw new Error('freepik_404')
  if (resp.status === 429) throw new Error('freepik_429')
  if (resp.status === 503) throw new Error('freepik_unconfigured')
  if (!resp.ok) throw new Error('freepik_api_error')

  const data = await resp.json().catch(() => null)
  if (!data || !data.url) throw new Error('freepik_api_error')
  return data  // { url, filename, size_bytes, expires_at }
}

/**
 * Top-level orchestrator. Dispatches on `source`, calls the right
 * fetch*Url, runs the Freepik TTL grace check, and calls
 * chrome.downloads.download. Returns
 *   {ok:true, filename, downloadId, size_bytes}
 * or
 *   {ok:false, errorCode, detail}
 * on any failure. Does NOT throw — the caller is the SW message
 * handler which wants a plain reply object.
 */
export async function downloadSourceItem({ source, itemId, runId, sanitizedFilename }) {
  // Light sanity check.
  if (source !== 'pexels' && source !== 'freepik') {
    return { ok: false, errorCode: 'bad_input', detail: `unknown source: ${source}` }
  }
  if (!itemId || (typeof itemId !== 'string' && typeof itemId !== 'number')) {
    return { ok: false, errorCode: 'bad_input', detail: 'itemId missing or wrong type' }
  }

  const t0 = Date.now()

  // Phase A — mint the signed URL.
  let mint
  try {
    mint = source === 'pexels'
      ? await fetchPexelsUrl({ itemId })
      : await fetchFreepikUrl({ itemId })
  } catch (err) {
    return { ok: false, errorCode: err?.message?.split(':')[0] || 'mint_error', detail: String(err?.message || err) }
  }
  const t1 = Date.now()
  console.log(`[sources] phase A mint OK (${source})`, { itemId, filename: mint.filename, ms: t1 - t0 })

  // Phase B — Freepik TTL grace check. Pexels URLs don't carry
  // expires_at so this is a no-op for Pexels.
  if (source === 'freepik' && isUrlLikelyExpired(mint.expires_at)) {
    console.log('[sources] phase B grace-check aborted', { expires_at: mint.expires_at })
    return { ok: false, errorCode: 'freepik_url_expired', detail: `expires_at ${mint.expires_at} within ${FREEPIK_URL_GRACE_MS}ms of now` }
  }

  // Phase C — chrome.downloads.download.
  // runId is accepted for Ext.5 forward compatibility but ignored.
  void runId

  const finalFilename = sanitizedFilename || mint.filename || `${source}_${itemId}.mp4`
  let downloadId
  try {
    downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: mint.url,
        filename: `transcript-eval/${finalFilename}`,
        saveAs: false,
        conflictAction: 'uniquify',
      }, id => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve(id)
      })
    })
  } catch (err) {
    return { ok: false, errorCode: 'chrome_downloads_error', detail: String(err?.message || err) }
  }
  const t2 = Date.now()
  console.log(`[sources] phase C download started (${source})`, { downloadId, ms: t2 - t1, total_ms: t2 - t0 })

  return { ok: true, filename: finalFilename, downloadId, size_bytes: mint.size_bytes ?? null }
}

// ---- private helpers ----

// Reads the JWT fresh from chrome.storage.local (MV3 SWs terminate
// aggressively — never cache). Throws 'no_jwt' if missing or
// 'jwt_expired' if past expiry. Fails fast before we hit the backend
// with a known-bad token. The 401-on-backend case (JWT present and
// not yet expired per our clock, but backend rejects — e.g. kid
// rotation) is handled by backendFetchWithRefresh one retry path.
async function ensureJwtFresh() {
  const jwt = await getJwt()
  if (!jwt || !jwt.token) throw new Error('no_jwt')
  if (typeof jwt.expires_at === 'number' && jwt.expires_at <= Date.now()) {
    throw new Error('jwt_expired')
  }
}

// True if `expiresAt` is a number AND we're within FREEPIK_URL_GRACE_MS
// of it. null / undefined / 0 / NaN → false (treat as "no expiry info,
// proceed"). This is the cheap guard; Ext.7 adds refetch-if-expired.
function isUrlLikelyExpired(expiresAt) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return false
  return Date.now() > expiresAt - FREEPIK_URL_GRACE_MS
}
