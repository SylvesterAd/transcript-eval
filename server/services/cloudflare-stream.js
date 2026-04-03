const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID
const CF_API_TOKEN = process.env.CF_API_TOKEN
const CF_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream`

function headers() {
  return { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' }
}

export function isEnabled() {
  return Boolean(CF_ACCOUNT_ID && CF_API_TOKEN)
}

/**
 * Create a direct-upload URL for TUS uploads from the browser.
 * Returns { uid, tusUploadUrl }
 */
export async function createDirectUpload(maxDurationSeconds = 21600) {
  const res = await fetch(`${CF_API}?direct_user=true`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      maxDurationSeconds,
      requireSignedURLs: false,
    }),
  })
  const data = await res.json()
  if (!data.success) throw new Error(`CF Stream create failed: ${JSON.stringify(data.errors)}`)

  return {
    uid: data.result.uid,
    tusUploadUrl: data.result.uploadURL,
  }
}

/**
 * Enable MP4 downloads for a stream (must be called after upload, before downloading).
 */
export async function enableMp4Downloads(uid) {
  const res = await fetch(`${CF_API}/${uid}/downloads`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ default: { status: 'ready' } }),
  })
  const data = await res.json()
  if (!data.success) {
    // May already be enabled — not a fatal error
    console.warn(`[cf-stream] Enable MP4 downloads for ${uid}:`, data.errors)
  }
}

/**
 * Get stream status and playback info.
 */
export async function getStreamStatus(uid) {
  const res = await fetch(`${CF_API}/${uid}`, { headers: headers() })
  const data = await res.json()
  if (!data.success) return null

  const r = data.result
  return {
    uid: r.uid,
    status: r.status?.state || 'unknown', // queued, inprogress, ready, error
    playbackId: r.uid,
    duration: r.duration || null,
    thumbnail: r.thumbnail || null,
    playbackUrl: r.playback?.hls || null,
    mp4Url: r.playback?.dash?.replace('/manifest/video.mpd', '/downloads/default.mp4') || null,
    ready: r.readyToStream || false,
  }
}

/**
 * Poll until the stream is ready for playback/download.
 * Returns the stream status once ready, or throws on timeout/error.
 */
export async function waitForStreamReady(uid, timeoutMs = 600000, signal) {
  const start = Date.now()
  const pollInterval = 5000

  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error('Aborted')

    const status = await getStreamStatus(uid)
    if (!status) throw new Error(`Stream ${uid} not found`)

    if (status.ready) return status
    if (status.status === 'error') throw new Error(`Stream ${uid} transcoding failed`)

    await new Promise(r => setTimeout(r, pollInterval))
  }

  throw new Error(`Timed out waiting for stream ${uid} to be ready (${Math.round(timeoutMs / 1000)}s)`)
}

/**
 * Delete a stream.
 */
export async function deleteStream(uid) {
  if (!uid) return
  const res = await fetch(`${CF_API}/${uid}`, { method: 'DELETE', headers: headers() })
  const data = await res.json()
  if (!data.success) console.error(`[cf-stream] Delete failed for ${uid}:`, data.errors)
}

/**
 * Build playback HLS URL.
 */
export function hlsUrl(uid) {
  return `https://videodelivery.net/${uid}/manifest/video.m3u8`
}

/**
 * Build thumbnail URL at a specific time.
 */
export function thumbnailUrl(uid, timeSec = 2) {
  return `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg?time=${timeSec}s&width=320`
}

/**
 * Build MP4 download URL (frame-accurate, faststart).
 */
export function mp4Url(uid) {
  return `https://videodelivery.net/${uid}/downloads/default.mp4`
}
