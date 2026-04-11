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
