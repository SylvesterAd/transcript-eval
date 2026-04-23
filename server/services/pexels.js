const API_KEY = process.env.PEXELS_API_KEY
const BASE = 'https://api.pexels.com'

export function isEnabled() {
  return Boolean(API_KEY)
}

function headers() {
  return { Authorization: API_KEY }
}

async function apiGet(url) {
  const res = await fetch(url, { headers: headers() })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Pexels ${res.status}: ${text}`)
  }
  return res.json()
}

export async function searchVideos({ query, page = 1, perPage = 15, orientation, size, locale }) {
  const params = new URLSearchParams({ query, page: String(page), per_page: String(Math.min(perPage, 80)) })
  if (orientation) params.set('orientation', orientation)
  if (size) params.set('size', size)
  if (locale) params.set('locale', locale)
  return apiGet(`${BASE}/v1/videos/search?${params}`)
}

export async function searchPhotos({ query, page = 1, perPage = 15, orientation, size, color, locale }) {
  const params = new URLSearchParams({ query, page: String(page), per_page: String(Math.min(perPage, 80)) })
  if (orientation) params.set('orientation', orientation)
  if (size) params.set('size', size)
  if (color) params.set('color', color)
  if (locale) params.set('locale', locale)
  return apiGet(`${BASE}/v1/search?${params}`)
}

export async function getVideo(id) {
  return apiGet(`${BASE}/v1/videos/videos/${id}`)
}

export async function getPhoto(id) {
  return apiGet(`${BASE}/v1/photos/${id}`)
}

export async function popularVideos({ page = 1, perPage = 15, minDuration, maxDuration } = {}) {
  const params = new URLSearchParams({ page: String(page), per_page: String(Math.min(perPage, 80)) })
  if (minDuration) params.set('min_duration', String(minDuration))
  if (maxDuration) params.set('max_duration', String(maxDuration))
  return apiGet(`${BASE}/v1/videos/popular?${params}`)
}

export async function curatedPhotos({ page = 1, perPage = 15 } = {}) {
  const params = new URLSearchParams({ page: String(page), per_page: String(Math.min(perPage, 80)) })
  return apiGet(`${BASE}/v1/curated?${params}`)
}

// ── Extension download URL resolution ──────────────────────────────────
// Used by POST /api/pexels-url. Picks the best mp4 <= preferred height
// from a Pexels video's video_files array; falls back to the smallest
// available when none fit (rare — e.g. item only offers 4K).

const RESOLUTION_HEIGHT = { '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 }

export function pickBestVideoFile(video, preferredResolution = '1080p') {
  const files = Array.isArray(video?.video_files) ? video.video_files : []
  if (!files.length) return null
  const wanted = RESOLUTION_HEIGHT[preferredResolution] || 1080

  const mp4s = files.filter(f => (f.file_type || '').toLowerCase() === 'video/mp4' && f.link)
  const pool = mp4s.length ? mp4s : files.filter(f => f.link)
  if (!pool.length) return null

  const underOrEqual = pool.filter(f => (f.height || 0) <= wanted)
  const chosen = underOrEqual.length
    ? underOrEqual.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
    : pool.sort((a, b) => (a.height || 0) - (b.height || 0))[0]
  return chosen
}

// Fetch the video from Pexels and choose the best download URL.
// Returns { url, filename, size_bytes, resolution } per the API contract.
export async function getDownloadUrl(itemId, preferredResolution = '1080p') {
  const video = await getVideo(itemId)
  if (!video || !video.id) throw new Error('Pexels item not found')
  const file = pickBestVideoFile(video, preferredResolution)
  if (!file) throw new Error('Pexels item has no downloadable video files')
  const ext = (file.file_type || 'video/mp4').split('/').pop() || 'mp4'
  return {
    url: file.link,
    filename: `pexels_${video.id}.${ext}`,
    size_bytes: null,  // Pexels doesn't return size; extension derives from Content-Length at download time
    resolution: { width: file.width || video.width || null, height: file.height || video.height || null },
  }
}
