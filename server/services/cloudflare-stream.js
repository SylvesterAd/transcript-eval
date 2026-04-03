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
    playbackId: r.uid, // Cloudflare uses uid as playback ID
    duration: r.duration || null,
    thumbnail: r.thumbnail || null,
    playbackUrl: r.playback?.hls || null,
    ready: r.readyToStream || false,
  }
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
 * Get the customer subdomain for playback URLs.
 */
let _customerSubdomain = null
export async function getCustomerSubdomain() {
  if (_customerSubdomain) return _customerSubdomain
  // Fetch any stream to discover the subdomain, or use the standard format
  _customerSubdomain = `customer-${CF_ACCOUNT_ID.slice(0, 8)}`
  return _customerSubdomain
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
