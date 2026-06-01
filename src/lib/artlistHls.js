// Artlist HLS previews are hotlink-protected: their CDN
// (cms-public-artifacts.artlist.io) 403s any request whose `Referer` isn't
// artlist.io / artgrid.io. Browsers can't forge a cross-origin Referer, so
// hls.js can't load these directly from our origin. We route them through the
// backend proxy (`/api/broll/hls-proxy`), which injects the Referer and
// rewrites the manifest so every child request comes back through us.
//
// Non-Artlist URLs (Pexels/Storyblocks MP4s, Cloudflare Stream a-roll HLS) are
// returned unchanged — they're directly playable.

const API_BASE = import.meta.env?.VITE_API_URL || '/api'
const ARTLIST_HOST_RE = /(^|\.)artlist\.io$|(^|\.)artgrid\.io$/i

/** True when `url` points at an Artlist-owned host. */
export function isArtlistUrl(url) {
  if (typeof url !== 'string') return false
  try {
    return ARTLIST_HOST_RE.test(new URL(url).hostname)
  } catch {
    return false
  }
}

// Proxy-rewrite version. Appended to the master proxy URL so that browsers
// holding a stale manifest — cached by an earlier proxy build that served some
// Artlist masters un-rewritten (pre content-type fix) — fetch a fresh copy
// under a new cache key instead of replaying the broken one. Bump this if the
// proxy's manifest-rewrite output ever changes again.
const PROXY_VERSION = 1

/**
 * Returns a playable URL for a media source. Artlist URLs are routed through
 * the backend HLS proxy; everything else passes through untouched.
 */
export function toPlayableHlsUrl(url) {
  if (!isArtlistUrl(url)) return url
  return `${API_BASE}/broll/hls-proxy?u=${encodeURIComponent(url)}&pv=${PROXY_VERSION}`
}
