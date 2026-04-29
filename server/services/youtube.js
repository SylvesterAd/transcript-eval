// Shared YouTube URL helper. Used by broll.js (dedupe + reuse check)
// and db.js (one-time backfill of videos.youtube_id).

// Extract the canonical YouTube video ID from a URL so we can dedupe
// add requests where the same video is pasted twice with different
// query strings (e.g. /watch?v=ID vs /watch?v=ID&t=2s, youtu.be short
// link, /shorts/ID, /embed/ID, m.youtube.com). Returns null on non-YT
// URLs and parse failures.
//
// YouTube video IDs are always exactly 11 chars from [A-Za-z0-9_-].
// We pull the v-param (or path segment) and slice to that 11-char
// prefix so malformed pastes like ?v=ID=20s (a typo for &t=20s — the
// `=20s` ends up inside the v-value) still match the canonical URL.
const YT_ID_PREFIX = /^[A-Za-z0-9_-]{11}/

export function extractYouTubeId(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\.|^m\./, '')
    let raw = null
    if (host === 'youtu.be') {
      raw = u.pathname.slice(1).split('/')[0]
    } else if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') raw = u.searchParams.get('v')
      else {
        const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/)
        if (m) raw = m[1]
      }
    }
    if (!raw) return null
    const m = raw.match(YT_ID_PREFIX)
    return m ? m[0] : null
  } catch {}
  return null
}
