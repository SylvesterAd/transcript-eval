// Artlist HLS preview proxy.
//
// Artlist's preview CDN (cms-public-artifacts.artlist.io, behind Cloudflare)
// gates its HLS playlists + segments behind Referer-based hotlink protection:
// it returns the manifest only when the request's `Referer` is artlist.io /
// artgrid.io, and 403s a Cloudflare challenge page for any other (or absent)
// Referer. Browsers forbid JavaScript from forging a cross-origin `Referer`,
// so hls.js running on our own origin can never load these directly.
//
// The fix is to proxy the whole HLS tree through the backend, injecting the
// Referer on every upstream request, and rewriting the URIs inside each
// manifest so the browser re-routes every child request (variant playlists +
// media segments + EXT-X URI="" attributes) back through this proxy.
//
// The same `Referer: https://artlist.io/` is what the Adpunk.Ssh GraphQL
// search client already uses to talk to Artlist.

export const ARTLIST_REFERER = 'https://artlist.io/'
export const ARTLIST_ORIGIN = 'https://artlist.io'

// A realistic desktop Chrome UA — Cloudflare also fingerprints obviously-bot
// User-Agents. Mirrors the UA used by the Adpunk.Ssh Artlist client.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// SSRF guard: only Artlist's own domains may be proxied. This keeps the
// endpoint from being abused as an open relay to arbitrary hosts.
const ALLOWED_HOST_RE = /(^|\.)artlist\.io$|(^|\.)artgrid\.io$/i

/** True when `raw` is an http(s) URL on an allowed Artlist host. */
export function isAllowedArtlistUrl(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  return ALLOWED_HOST_RE.test(u.hostname)
}

/** Resolve a (possibly relative) manifest URI against the manifest's URL. */
function resolveUrl(ref, base) {
  try {
    return new URL(ref, base).href
  } catch {
    return null
  }
}

/**
 * Decide whether an upstream response is an HLS manifest (vs a binary segment).
 * Prefers the Content-Type; falls back to the URL extension. An HTML response
 * is never a manifest (that's the Cloudflare 403 page).
 */
export function isHlsManifest(contentType, url) {
  const ct = (contentType || '').toLowerCase()
  // An HTML body is never a manifest — it's a Cloudflare challenge/error page.
  if (ct.includes('text/html')) return false
  // Explicit HLS content-type.
  if (ct.includes('mpegurl')) return true // application/vnd.apple.mpegurl | application/x-mpegURL
  // The URL extension is authoritative for Artlist: playlists end in `.m3u8`,
  // media segments in `.ts`/`.m4s`/`.mp4`. Some Artlist clips serve their
  // master playlist with a bogus content-type (observed:
  // `application/x-www-form-urlencoded`), so content-type alone must NOT be
  // allowed to reject a `.m3u8`. Without this, such manifests were streamed as
  // opaque binary (URIs left un-rewritten) and never played — the "some clips
  // play, some don't" bug.
  return /\.m3u8($|\?)/i.test(url || '')
}

/**
 * Rewrite every URI inside an HLS manifest so child requests route back through
 * this proxy. Handles three forms:
 *   1. bare URI lines (variant playlists, media segments)
 *   2. `URI="..."` attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, ...)
 * Each URI is first resolved to an absolute URL against `manifestUrl` (Artlist
 * manifests use relative URIs), then wrapped as `${proxyPath}?u=<encoded>`.
 *
 * @param {string} body        raw manifest text
 * @param {string} manifestUrl absolute URL the manifest was fetched from
 * @param {string} proxyPath   e.g. '/api/broll/hls-proxy'
 * @returns {string} rewritten manifest
 */
export function rewriteHlsManifest(body, manifestUrl, proxyPath) {
  const wrap = (abs) => `${proxyPath}?u=${encodeURIComponent(abs)}`
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (line === '') return line
      if (line.startsWith('#')) {
        // Rewrite any URI="..." attribute embedded in a tag.
        return line.replace(/URI="([^"]*)"/g, (m, uri) => {
          const abs = resolveUrl(uri, manifestUrl)
          return abs ? `URI="${wrap(abs)}"` : m
        })
      }
      // A bare URI line (variant playlist or media segment).
      const abs = resolveUrl(line.trim(), manifestUrl)
      return abs ? wrap(abs) : line
    })
    .join('\n')
}

/**
 * Fetch an Artlist URL with the hotlink-defeating headers. Caller is
 * responsible for validating the URL first (isAllowedArtlistUrl).
 *
 * @param {string} url
 * @param {{ range?: string }} [opts] forward a Range header for segment reads
 * @returns {Promise<Response>}
 */
export function fetchArtlist(url, { range } = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: ARTLIST_REFERER,
    Origin: ARTLIST_ORIGIN,
    Accept: '*/*',
  }
  if (range) headers.Range = range
  return fetch(url, { headers, redirect: 'follow' })
}
