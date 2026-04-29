// src/hooks/useExportXmlKickoff.js
//
// State E's primary driver. Takes the Ext.5 extension's {type:"complete"}
// payload + the unified manifest built at State C and produces per-variant
// XMEML strings ready to download.
//
// Flow (auto-runs on completion; manual re-run via `regenerate`):
//   1. buildVariantsPayload(unifiedManifest, variantLabels)
//      → {variants:[{label, sequenceName, placements:[...]}, ...]}
//   2. POST /api/exports/:id/result
//      → writes the shape to exports.result_json
//   3. POST /api/exports/:id/generate-xml with {variants: variantLabels}
//      → server reads result_json, runs generateXmeml() per variant
//   4. For each returned xml string, synthesize a Blob + <a>.click()
//      → browser downloads variant-<label>.xml into default folder
//
// State machine:
//   idle → posting-result → generating → ready
//                                      ↘ error (terminal until regenerate)
//
// De-duplication: tracks a request ID (`activeRequestRef`). regenerate()
// bumps it; any in-flight promise whose captured ID no longer matches
// the active one is dropped. Prevents double-POST on double-click.

import { useState, useEffect, useRef, useCallback } from 'react'
import { apiPost } from './useApi.js'
import { EXT_ID } from '../lib/extension-id.js'

// ----------------------------------------------------------------------
// Pure transform: unified manifest → endpoint-ready variants shape.
//
// Exported as a named export so tests can exercise it without a React
// tree. See src/hooks/__tests__/useExportXmlKickoff.test.js.
//
// Why "Variant X" as sequenceName: matches the XMEML plan's example and
// is human-readable when the user opens the XML in Premiere. If the
// editor later introduces user-editable variant names, thread through.

export function buildVariantsPayload({ unifiedManifest, variantLabels }) {
  if (!unifiedManifest || !Array.isArray(unifiedManifest.items)) {
    throw new Error('buildVariantsPayload: unifiedManifest.items required')
  }
  if (!Array.isArray(variantLabels) || variantLabels.length === 0) {
    throw new Error('buildVariantsPayload: variantLabels must be a non-empty array')
  }

  const variants = []

  for (const label of variantLabels) {
    const placements = []
    for (const item of unifiedManifest.items) {
      if (!Array.isArray(item.placements)) continue
      for (const pl of item.placements) {
        if (pl.variant !== label) continue
        const ts = pl.timeline_start_s
        const td = pl.timeline_duration_s
        if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
        if (typeof td !== 'number' || !Number.isFinite(td) || td <= 0) continue
        placements.push({
          seq: item.seq,
          source: item.source || '',
          sourceItemId: item.source_item_id || '',
          filename: item.target_filename || '',
          timelineStart: ts,
          timelineDuration: td,
          // Optional per-placement overrides — fall back to sequence
          // defaults in the generator if omitted. We pass width/height
          // only if explicit to avoid burning in a guessed 1920x1080.
          ...(item.resolution?.width ? { width: item.resolution.width } : {}),
          ...(item.resolution?.height ? { height: item.resolution.height } : {}),
          ...(item.frame_rate ? { sourceFrameRate: item.frame_rate } : {}),
          // Source media's full length, used by the generator for
          // <file><duration> so Premiere can show trim handles past
          // the cut. Optional — falls back to timeline duration if
          // missing (no handles, but the cut still plays).
          ...(typeof item.duration_seconds === 'number' && item.duration_seconds > 0
            ? { sourceDurationSeconds: item.duration_seconds }
            : {}),
        })
      }
    }
    variants.push({
      label,
      sequenceName: `Variant ${label}`,
      placements,
    })
  }

  return { variants }
}

// ----------------------------------------------------------------------
// Browser-side download helper. Encapsulated for easier test spying.
// Synthesizes one anchor + one click per variant, revokes the URL
// after 10 seconds (long enough for any browser to pick up the blob;
// short enough not to leak if the user closes the tab).

export function triggerXmlDownload(filename, xmlString, folderPath) {
  // Preferred path: hand the XML to the extension so it lands in the
  // same folder as the b-roll mp4s. If the extension is unreachable
  // (no EXT_ID, non-Chrome browser, popup blocker, etc.), fall back
  // to the classic Blob + <a download> which lands in the user's
  // default Downloads folder — they'll have to move the file by hand
  // but at least it isn't lost.
  const tryExtension = () => new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage || !EXT_ID) {
      reject(new Error('extension unavailable'))
      return
    }
    if (!folderPath) {
      reject(new Error('folderPath required for extension save'))
      return
    }
    let settled = false
    const t = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('extension save timed out')) }
    }, 5000)
    try {
      chrome.runtime.sendMessage(
        EXT_ID,
        { type: 'save_xml', version: 1, folder: folderPath, filename, content: xmlString },
        (response) => {
          if (settled) return
          settled = true
          clearTimeout(t)
          const lastErr = chrome.runtime.lastError
          if (lastErr) return reject(new Error(lastErr.message || 'sendMessage error'))
          if (!response?.ok) return reject(new Error(response?.error || 'extension declined save'))
          resolve(response)
        },
      )
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(t); reject(e) }
    }
  })

  const fallbackBrowserDownload = () => {
    const blob = new Blob([xmlString], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { try { document.body.removeChild(a) } catch {} }, 0)
    setTimeout(() => { try { URL.revokeObjectURL(url) } catch {} }, 10_000)
    return url
  }

  // Fire the extension save; if it rejects, fall back. Return the
  // resulting promise for tests / callers that want to await.
  return tryExtension().catch((err) => {
    console.warn('[xml-download] extension save failed, using browser fallback:', err?.message || err)
    fallbackBrowserDownload()
    return { ok: true, fallback: true, error: String(err?.message || err) }
  })
}

// ----------------------------------------------------------------------
// The hook.
//
// Accepts `autoKick` (default true) for the standard auto-run flow.
// Tests pass `autoKick: false` to drive the flow explicitly.

const STATUS_IDLE = 'idle'
const STATUS_POSTING_RESULT = 'posting-result'
const STATUS_GENERATING = 'generating'
const STATUS_READY = 'ready'
const STATUS_ERROR = 'error'

export function useExportXmlKickoff({
  exportId,
  variantLabels,
  unifiedManifest,
  complete,
  autoKick = true,
  // Test-seams: override the network or download primitives. Default
  // to the real ones. Keeping them injectable avoids heavy mocking
  // frameworks in tests.
  _apiPost = apiPost,
  _triggerDownload = triggerXmlDownload,
} = {}) {
  const [status, setStatus] = useState(STATUS_IDLE)
  const [xmlByVariant, setXmlByVariant] = useState(null)
  const [error, setError] = useState(null)
  const activeRequestRef = useRef(0)

  const run = useCallback(async () => {
    if (!exportId || !unifiedManifest || !Array.isArray(variantLabels) || variantLabels.length === 0) {
      setError('missing inputs (exportId / unifiedManifest / variantLabels)')
      setStatus(STATUS_ERROR)
      return
    }
    const reqId = ++activeRequestRef.current
    setError(null)
    setStatus(STATUS_POSTING_RESULT)
    try {
      const body = buildVariantsPayload({ unifiedManifest, variantLabels })
      await _apiPost(`/exports/${encodeURIComponent(exportId)}/result`, body)
      if (reqId !== activeRequestRef.current) return  // superseded
      setStatus(STATUS_GENERATING)
      // Forward the extension-resolved absolute folder so the server
      // can emit <pathurl>file:///<absolute>/<file>.mp4</pathurl> per
      // Apple's FCP7 XMEML spec. When undefined (older extension that
      // hasn't published folder_path_absolute yet, or browser-fallback
      // XML save), the generator falls back to bare filenames.
      const targetFolderAbsolute = complete?.folder_path_absolute || null
      const resp = await _apiPost(
        `/exports/${encodeURIComponent(exportId)}/generate-xml`,
        {
          variants: variantLabels,
          ...(targetFolderAbsolute ? { target_folder_absolute: targetFolderAbsolute } : {}),
        },
      )
      if (reqId !== activeRequestRef.current) return
      const xmls = resp?.xml_by_variant || {}
      setXmlByVariant(xmls)
      const folderPath = complete?.folder_path || null
      for (const label of variantLabels) {
        const xml = xmls[label]
        if (typeof xml !== 'string' || !xml) continue
        const filename = `variant-${String(label).toLowerCase()}.xml`
        // Don't await — fire-and-forget per variant. Each call resolves
        // either through the extension or falls back to a browser
        // download; we don't block the State E transition on either.
        try { _triggerDownload(filename, xml, folderPath) } catch {}
      }
      setStatus(STATUS_READY)
    } catch (err) {
      if (reqId !== activeRequestRef.current) return
      setError(err?.message || String(err))
      setStatus(STATUS_ERROR)
    }
  }, [exportId, variantLabels, unifiedManifest, _apiPost, _triggerDownload])

  // Auto-run on the null → complete-with-no-failures transition.
  // We do NOT auto-run for partial failures (State F); State F will
  // offer a "Generate XML anyway" button that calls regenerate() on
  // demand. Keeping that out of scope for this plan — State F is
  // deferred — but we avoid regressing around it: the auto-run
  // condition here is exactly `fail_count === 0`.
  const lastCompleteRef = useRef(null)
  useEffect(() => {
    if (!autoKick) return
    if (!complete) return
    if (lastCompleteRef.current === complete) return
    lastCompleteRef.current = complete
    if ((complete.fail_count ?? 0) === 0) {
      run()
    }
    // If fail_count > 0, do nothing here — State F is responsible.
  }, [complete, autoKick, run])

  const regenerate = useCallback(() => {
    // User clicked "Retry". Bump the request ID before calling run()
    // so any in-flight response is dropped.
    run()
  }, [run])

  return {
    status,
    xml_by_variant: xmlByVariant,
    error,
    regenerate,
  }
}
