import { createHmac } from 'crypto'

const API_KEY = process.env.STORYBLOCKS_API_KEY
const PRIVATE_KEY = process.env.STORYBLOCKS_PRIVATE_KEY
const BASE_URL = 'https://api.storyblocks.com'

export function isEnabled() {
  return Boolean(API_KEY && PRIVATE_KEY)
}

function buildAuth(resourcePath) {
  const expires = Math.floor(Date.now() / 1000) + 3600 // 1 hour
  const hmac = createHmac('sha256', PRIVATE_KEY + expires)
    .update(resourcePath)
    .digest('hex')
  return { APIKEY: API_KEY, EXPIRES: expires, HMAC: hmac }
}

function authParams(resourcePath) {
  const auth = buildAuth(resourcePath)
  return `APIKEY=${encodeURIComponent(auth.APIKEY)}&EXPIRES=${auth.EXPIRES}&HMAC=${auth.HMAC}`
}

async function apiGet(resourcePath, extraParams = {}) {
  const qs = new URLSearchParams({ ...extraParams })
  const authQs = authParams(resourcePath)
  const url = `${BASE_URL}${resourcePath}?${authQs}&${qs.toString()}`
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Storyblocks ${res.status}: ${text}`)
  }
  return res.json()
}

/**
 * Search for stock videos.
 */
export async function searchVideos({ keywords, page = 1, resultsPerPage = 20, quality, contentType, minDuration, maxDuration, orientation, sortBy, userId = 'system', projectId = 'transcript-eval' }) {
  const resource = '/api/v2/videos/search'
  const params = {
    keywords: keywords || '',
    page: String(page),
    results_per_page: String(Math.min(resultsPerPage, 250)),
    user_id: userId,
    project_id: projectId,
    extended: 'download_formats,keywords,description,categories',
  }
  if (quality) params.quality = quality
  if (contentType) params.content_type = contentType
  if (minDuration) params.min_duration = String(minDuration)
  if (maxDuration) params.max_duration = String(maxDuration)
  if (orientation) params.orientation = orientation
  if (sortBy) params.sort_by = sortBy

  return apiGet(resource, params)
}

/**
 * Search for stock audio/music.
 */
export async function searchAudio({ keywords, page = 1, resultsPerPage = 20, contentType, minBpm, maxBpm, hasVocals, userId = 'system', projectId = 'transcript-eval' }) {
  const resource = '/api/v2/audio/search'
  const params = {
    keywords: keywords || '',
    page: String(page),
    results_per_page: String(Math.min(resultsPerPage, 250)),
    user_id: userId,
    project_id: projectId,
  }
  if (contentType) params.content_type = contentType
  if (minBpm) params.min_bpm = String(minBpm)
  if (maxBpm) params.max_bpm = String(maxBpm)
  if (hasVocals !== undefined) params.has_vocals = String(hasVocals)

  return apiGet(resource, params)
}

/**
 * Search for stock images.
 */
export async function searchImages({ keywords, page = 1, resultsPerPage = 20, contentType, orientation, userId = 'system', projectId = 'transcript-eval' }) {
  const resource = '/api/v2/images/search'
  const params = {
    keywords: keywords || '',
    page: String(page),
    results_per_page: String(Math.min(resultsPerPage, 250)),
    user_id: userId,
    project_id: projectId,
  }
  if (contentType) params.content_type = contentType
  if (orientation) params.orientation = orientation

  return apiGet(resource, params)
}

/**
 * Get download URLs for a stock video.
 */
export async function getVideoDownload(stockItemId, { userId = 'system', projectId = 'transcript-eval' } = {}) {
  const resource = `/api/v2/videos/stock-item/download/${stockItemId}`
  return apiGet(resource, { user_id: userId, project_id: projectId })
}

/**
 * Get download URLs for a stock audio item.
 */
export async function getAudioDownload(stockItemId, { userId = 'system', projectId = 'transcript-eval' } = {}) {
  const resource = `/api/v2/audio/stock-item/download/${stockItemId}`
  return apiGet(resource, { user_id: userId, project_id: projectId })
}

/**
 * Get details for a stock video.
 */
export async function getVideoDetails(stockItemId) {
  const resource = `/api/v2/videos/stock-item/details/${stockItemId}`
  return apiGet(resource)
}

/**
 * Get similar videos.
 */
export async function getSimilarVideos(stockItemId, limit = 10) {
  const resource = `/api/v2/videos/stock-item/similar/${stockItemId}`
  return apiGet(resource, { limit: String(limit) })
}

/**
 * List video categories.
 */
export async function getVideoCategories() {
  const resource = '/api/v2/videos/stock-item/categories'
  return apiGet(resource)
}
