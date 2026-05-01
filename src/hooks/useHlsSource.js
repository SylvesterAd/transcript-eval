import { useEffect } from 'react'
import Hls from 'hls.js'

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
      const hls = new Hls({
        maxBufferLength: 10,
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const levels = hls.levels || []
        let cap = -1
        for (let i = 0; i < levels.length; i++) {
          if ((levels[i].height ?? 0) <= 480) cap = i
        }
        if (cap >= 0) hls.autoLevelCapping = cap
      })
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
