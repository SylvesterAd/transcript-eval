import { useEffect } from 'react'
import Hls from 'hls.js'

const HLS_RE = /\.m3u8(\?|$)/i

function isHlsUrl(url) {
  return typeof url === 'string' && HLS_RE.test(url)
}

function buildHls() {
  const hls = new Hls({ maxBufferLength: 10 })
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    const levels = hls.levels || []
    let cap = -1
    for (let i = 0; i < levels.length; i++) {
      if ((levels[i].height ?? 0) <= 480) cap = i
    }
    if (cap >= 0) hls.autoLevelCapping = cap
  })
  return hls
}

/**
 * Imperatively attaches a video source to a <video> element.
 * Order of preference:
 *   1. hlsUrl + Hls.js (Chrome/Firefox) — adaptive bitrate, capped at ~480p.
 *   2. hlsUrl + native HLS (Safari).
 *   3. mp4Url (fallback).
 *
 * @param {React.RefObject<HTMLVideoElement>} videoRef
 * @param {{ hlsUrl: string|null, mp4Url: string|null }} sources
 */
export function useHlsSource(videoRef, { hlsUrl, mp4Url }) {
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (hlsUrl && Hls.isSupported()) {
      const hls = buildHls()
      hls.loadSource(hlsUrl)
      hls.attachMedia(video)
      return () => hls.destroy()
    }

    if (hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl
      return () => {
        video.removeAttribute('src')
        video.load()
      }
    }

    if (mp4Url) {
      video.src = mp4Url
      return () => {
        video.removeAttribute('src')
        video.load()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- videoRef identity is stable; reading current inside the effect
  }, [hlsUrl, mp4Url])
}

// ---------------------------------------------------------------------------
// Imperative variant for callers that own video.src themselves (e.g. a rAF
// tick that swaps URLs based on the playhead). Same provider preference order
// as the hook. The active Hls instance is stashed on `video._hlsInstance` so
// we can tear it down before the next swap, and the active URL is stashed on
// `video._currentSourceUrl` so callers can guard idempotently — comparing
// against `video.src` is unreliable for HLS because hls.js sets src to an
// internal blob: URL.
//
// Pair with detachVideoSource(video) in the component's unmount cleanup —
// otherwise hls.js keeps a Worker alive after the <video> goes away.
// ---------------------------------------------------------------------------

export function attachVideoSource(video, url) {
  if (!video) return
  if (video._currentSourceUrl === url) return
  if (video._hlsInstance) {
    try { video._hlsInstance.destroy() } catch {}
    video._hlsInstance = null
  }
  video._currentSourceUrl = url || null
  if (!url) {
    video.removeAttribute('src')
    return
  }
  if (isHlsUrl(url) && Hls.isSupported()) {
    const hls = buildHls()
    hls.loadSource(url)
    hls.attachMedia(video)
    video._hlsInstance = hls
    return
  }
  // Safari native HLS or MP4 — direct src assignment.
  video.src = url
}

export function detachVideoSource(video) {
  if (!video) return
  if (video._hlsInstance) {
    try { video._hlsInstance.destroy() } catch {}
    video._hlsInstance = null
  }
  video._currentSourceUrl = null
}
