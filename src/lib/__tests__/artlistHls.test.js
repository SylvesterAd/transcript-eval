import { describe, it, expect } from 'vitest'
import { isArtlistUrl, toPlayableHlsUrl } from '../artlistHls.js'

// import.meta.env.VITE_API_URL is unset under vitest, so API_BASE === '/api'.
const PROXY = '/api/broll/hls-proxy'
const ARTLIST =
  'https://cms-public-artifacts.artlist.io/content/artgrid/footage-hls/abc_playlist.m3u8'

describe('isArtlistUrl', () => {
  it('detects artlist + artgrid hosts', () => {
    expect(isArtlistUrl(ARTLIST)).toBe(true)
    expect(isArtlistUrl('https://cdn.artgrid.io/x.m3u8')).toBe(true)
  })
  it('rejects non-artlist hosts and junk', () => {
    expect(isArtlistUrl('https://player.vimeo.com/x.m3u8')).toBe(false)
    expect(isArtlistUrl('https://videodelivery.net/uid/manifest/video.m3u8')).toBe(false)
    expect(isArtlistUrl('https://artlist.io.evil.com/x.m3u8')).toBe(false)
    expect(isArtlistUrl(null)).toBe(false)
    expect(isArtlistUrl('not a url')).toBe(false)
  })
})

describe('toPlayableHlsUrl', () => {
  it('routes artlist HLS through the backend proxy', () => {
    expect(toPlayableHlsUrl(ARTLIST)).toBe(`${PROXY}?u=${encodeURIComponent(ARTLIST)}`)
  })
  it('leaves Cloudflare Stream a-roll HLS untouched', () => {
    const cf = 'https://videodelivery.net/uid/manifest/video.m3u8'
    expect(toPlayableHlsUrl(cf)).toBe(cf)
  })
  it('leaves direct MP4 previews (pexels/storyblocks) untouched', () => {
    const mp4 = 'https://player.vimeo.com/external/123.hd.mp4'
    expect(toPlayableHlsUrl(mp4)).toBe(mp4)
  })
  it('passes through null/empty unchanged', () => {
    expect(toPlayableHlsUrl(null)).toBe(null)
    expect(toPlayableHlsUrl('')).toBe('')
  })
})
