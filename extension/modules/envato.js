// Envato 3-phase download. Ext.2 scope: ONE item per user click. No
// queue, no pool, no retry matrix — Ext.5 and Ext.7 add those.
//
// Phase 1 — Resolve: open elements.envato.com/<old-slug> in a hidden
//   tab, wait for webNavigation.onCommitted to commit a URL matching
//   app.envato.com/<segment>/<UUID>, capture the UUID, close the tab.
// Phase 2 — License: GET app.envato.com/download.data?itemUuid=...
//   with credentials:'include'. Parse the Remix streaming response
//   for the signed URL. THIS COMMITS A LICENSE on the user's Envato
//   fair-use counter — never call without a user-initiated trigger.
// Phase 2.5 — Filetype safety net: if the signed URL's
//   response-content-disposition filename ends .zip/.aep/.prproj,
//   abort BEFORE chrome.downloads.download. (Full deny-list + 24h
//   rate-limited telemetry is Ext.7.)
// Phase 3 — Save: chrome.downloads.download() into
//   ~/Downloads/transcript-eval/<sanitizedFilename>.
//
// Orchestration is a bare `await` chain — Ext.2's concurrency cap is 1.

import { RESOLVER_TIMEOUT_MS } from '../config.js'

// Matches app.envato.com/<segment>/<UUID> where UUID is the standard
// 8-4-4-4-12 hex form. <segment> is typically "stock-video" but we
// accept any single path segment to future-proof.
const APP_URL_UUID_RE = /^https:\/\/app\.envato\.com\/[^\/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\/?#]|$)/i

// Matches the Remix streaming response field: "downloadUrl","https://..."
// The streaming format uses pairs of JSON-encoded strings; we find the
// first pair whose key is exactly "downloadUrl" and capture the URL
// that follows it.
const REMIX_DOWNLOAD_URL_RE = /"downloadUrl"\s*,\s*"(https:\/\/[^"]+)"/

// Parses the response-content-disposition filename out of an AWS-
// flavored signed URL. The query parameter name varies
// (response-content-disposition OR X-Amz-SignedHeaders-adjacent params)
// but Envato's CDN uses the literal response-content-disposition
// parameter with a URL-encoded "attachment; filename=..." value.
const CONTENT_DISPOSITION_RE = /response-content-disposition=([^&]+)/
const FILENAME_FROM_DISPOSITION_RE = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i

/**
 * Phase 1. Opens `oldUrl` in a hidden tab, waits for the client-side
 * redirect to `app.envato.com/<segment>/<UUID>`, returns the UUID,
 * and closes the tab. Rejects with Error('resolve_timeout') after
 * RESOLVER_TIMEOUT_MS.
 *
 * MUST be called only in response to a user-initiated trigger. The
 * tab is opened active:false so the user doesn't see it flash.
 */
export async function resolveOldIdToNewUuid(oldUrl) {
  const tab = await new Promise((resolve, reject) => {
    chrome.tabs.create({ url: oldUrl, active: false }, t => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve(t)
    })
  })

  return new Promise((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      if (settled) return
      settled = true
      try { chrome.webNavigation.onCommitted.removeListener(onCommitted) } catch {}
      try { chrome.tabs.remove(tab.id) } catch {}
    }

    const timer = setTimeout(() => {
      if (settled) return
      cleanup()
      reject(new Error('resolve_timeout'))
    }, RESOLVER_TIMEOUT_MS)

    const onCommitted = (details) => {
      if (settled) return
      if (details.tabId !== tab.id) return
      const match = APP_URL_UUID_RE.exec(details.url)
      if (!match) return
      clearTimeout(timer)
      cleanup()
      resolve(match[1])
    }

    chrome.webNavigation.onCommitted.addListener(onCommitted)
  })
}

/**
 * Phase 2. Commits an Envato license and returns the signed CDN URL.
 * THIS IS THE LICENSE COMMIT POINT — never speculatively. Throws on
 * 401/403/429/empty-downloadUrl/other non-OK.
 */
export async function getSignedDownloadUrl(newUuid) {
  const url = `https://app.envato.com/download.data?itemUuid=${encodeURIComponent(newUuid)}&itemType=stock-video&_routes=routes/download/route`
  let resp
  try {
    resp = await fetch(url, { credentials: 'include' })
  } catch (err) {
    throw new Error('envato_network_error: ' + String(err?.message || err))
  }

  if (resp.status === 401) throw new Error('envato_session_missing')
  if (resp.status === 402) throw new Error('envato_402')
  if (resp.status === 403) throw new Error('envato_403')
  if (resp.status === 429) throw new Error('envato_429')
  if (!resp.ok) throw new Error('envato_http_' + resp.status)

  const text = await resp.text()
  const signedUrl = extractDownloadUrlFromRemixStream(text)
  if (!signedUrl) throw new Error('envato_unavailable')
  return signedUrl
}

/**
 * Top-level orchestrator. Calls Phase 1 → Phase 2 → Phase 2.5 → Phase 3.
 * Returns {ok, filename, downloadId} on success or {ok:false, errorCode,
 * detail} on any failure. Does NOT throw — the caller is the SW message
 * handler which wants a plain reply object.
 */
export async function downloadEnvato({ envatoItemUrl, itemId, runId, sanitizedFilename }) {
  // Light sanity check. The SW message handler also validates, but
  // catching obvious errors here gives a more useful error surface.
  if (!envatoItemUrl || typeof envatoItemUrl !== 'string') {
    return { ok: false, errorCode: 'bad_input', detail: 'envatoItemUrl missing or non-string' }
  }
  if (!itemId || typeof itemId !== 'string') {
    return { ok: false, errorCode: 'bad_input', detail: 'itemId missing or non-string' }
  }

  const t0 = Date.now()
  let newUuid
  try {
    newUuid = await resolveOldIdToNewUuid(envatoItemUrl)
  } catch (err) {
    return { ok: false, errorCode: err?.message === 'resolve_timeout' ? 'resolve_timeout' : 'resolve_error', detail: String(err?.message || err) }
  }
  const t1 = Date.now()
  console.log('[envato] phase 1 resolve OK', { newUuid, ms: t1 - t0 })

  let signedUrl
  try {
    signedUrl = await getSignedDownloadUrl(newUuid)
  } catch (err) {
    return { ok: false, errorCode: err?.message || 'envato_license_error', detail: String(err?.message || err) }
  }
  const t2 = Date.now()
  console.log('[envato] phase 2 license OK', { ms: t2 - t1 })

  // Phase 2.5 — ZIP / AEP / PRPROJ safety net.
  const cdnFilename = extractFilenameFromSignedUrl(signedUrl)
  if (cdnFilename && /\.(zip|aep|prproj)$/i.test(cdnFilename)) {
    console.log('[envato] phase 2.5 safety net aborted', { cdnFilename })
    return { ok: false, errorCode: 'envato_unsupported_filetype', detail: cdnFilename }
  }

  // Derive extension from the CDN filename. Default .mov if extraction
  // failed — Envato's default for stock-video is .mov.
  let ext = 'mov'
  if (cdnFilename) {
    const m = /\.([a-z0-9]{2,5})$/i.exec(cdnFilename)
    if (m) ext = m[1].toLowerCase()
  }
  const finalFilename = sanitizedFilename || `envato_${itemId}.${ext}`

  // Phase 3 — save. runId is captured for Ext.5's per-run folder layout
  // but ignored here; Ext.2 writes flat under transcript-eval/.
  void runId

  let downloadId
  try {
    downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: signedUrl,
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
  const t3 = Date.now()
  console.log('[envato] phase 3 download started', { downloadId, ms: t3 - t2, total_ms: t3 - t0 })

  return { ok: true, filename: finalFilename, downloadId }
}

// ---- private helpers ----

// Extracts `"downloadUrl","https://..."` from a Remix streaming response.
// Returns null if not found (caller treats null as `envato_unavailable`).
function extractDownloadUrlFromRemixStream(text) {
  if (typeof text !== 'string' || !text.length) return null
  const m = REMIX_DOWNLOAD_URL_RE.exec(text)
  return m ? m[1] : null
}

// Pulls the response-content-disposition filename out of a signed URL.
// Returns the decoded filename string or null if the URL doesn't
// include that query param (in which case we fall back to the MOV
// default in the caller).
function extractFilenameFromSignedUrl(url) {
  if (typeof url !== 'string' || !url.length) return null
  const dispMatch = CONTENT_DISPOSITION_RE.exec(url)
  if (!dispMatch) return null
  let disposition
  try {
    disposition = decodeURIComponent(dispMatch[1])
  } catch {
    return null
  }
  const nameMatch = FILENAME_FROM_DISPOSITION_RE.exec(disposition)
  return nameMatch ? nameMatch[1] : null
}
