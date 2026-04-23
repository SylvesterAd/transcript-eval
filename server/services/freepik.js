// Freepik API client. Phase 1 only exposes getSignedDownloadUrl,
// which invokes GET /v1/videos/:id/download — a BILLABLE call
// (€0.05 per hit at Apr 2026 rates). Never call speculatively;
// only after the user has clicked Start Export and the extension
// is about to write this file to disk.

import { NotFoundError } from './errors.js'

const API_KEY = process.env.FREEPIK_API_KEY || ''
const BASE = 'https://api.freepik.com'
// Freepik signed URLs expire on the order of 15–60 min; conservatively 15.
const URL_TTL_MS = 15 * 60 * 1000

export function isEnabled() {
  return Boolean(API_KEY)
}

export class RateLimitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RateLimitError'
    this.status = 429
  }
}

function extToFilename(id, format) {
  const safeFormat = (format || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4'
  return `freepik_${id}.${safeFormat}`
}

export async function getSignedDownloadUrl(itemId, format = 'mp4') {
  if (!API_KEY) throw new Error('Freepik is not configured')
  if (!itemId) throw new Error('item_id required')

  const url = `${BASE}/v1/videos/${encodeURIComponent(itemId)}/download`
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'x-freepik-api-key': API_KEY, 'Accept': 'application/json' },
  })
  const text = await resp.text()
  if (!resp.ok) {
    if (resp.status === 404) throw new NotFoundError('Freepik item not found')
    if (resp.status === 429) throw new RateLimitError('Freepik rate limit')
    throw new Error(`Freepik ${resp.status}: ${text.slice(0, 200)}`)
  }
  let data
  try { data = JSON.parse(text) } catch { throw new Error('Freepik returned non-JSON body') }

  // Freepik's download response shape (verified 2026-04-23 via
  // adpunk.ssh/proxy/freepik.py contract): data.url (or similar) is the
  // signed download URL. Defensive field lookup across plausible keys.
  const d = data.data || data
  const signedUrl = d.url || d.download_url || d.href
  if (!signedUrl) throw new Error('Freepik response had no download URL')

  return {
    url: signedUrl,
    filename: d.filename || extToFilename(itemId, format),
    size_bytes: typeof d.size === 'number' ? d.size : null,
    expires_at: Date.now() + URL_TTL_MS,
  }
}
