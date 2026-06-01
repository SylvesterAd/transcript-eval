import { describe, it, expect } from 'vitest'
import {
  isAllowedArtlistUrl,
  isHlsManifest,
  rewriteHlsManifest,
} from '../artlist-hls-proxy.js'

const PROXY = '/api/broll/hls-proxy'
const MASTER_URL =
  'https://cms-public-artifacts.artlist.io/content/artgrid/footage-hls/abc_playlist_1710331847.m3u8'

describe('isAllowedArtlistUrl', () => {
  it('allows the artlist preview CDN host', () => {
    expect(isAllowedArtlistUrl(MASTER_URL)).toBe(true)
  })
  it('allows artgrid subdomains', () => {
    expect(isAllowedArtlistUrl('https://artgrid.imgix.net/foo.m3u8')).toBe(false) // imgix is not artlist/artgrid TLD
    expect(isAllowedArtlistUrl('https://cdn.artgrid.io/x_1080p.m3u8')).toBe(true)
  })
  it('rejects non-artlist hosts (SSRF guard)', () => {
    expect(isAllowedArtlistUrl('https://evil.com/x.m3u8')).toBe(false)
    expect(isAllowedArtlistUrl('https://artlist.io.evil.com/x.m3u8')).toBe(false)
    expect(isAllowedArtlistUrl('https://notartlist.io.evil/x')).toBe(false)
  })
  it('rejects non-http protocols and garbage', () => {
    expect(isAllowedArtlistUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedArtlistUrl('http://169.254.169.254/latest/meta-data')).toBe(false)
    expect(isAllowedArtlistUrl('not a url')).toBe(false)
    expect(isAllowedArtlistUrl(undefined)).toBe(false)
  })
})

describe('isHlsManifest', () => {
  it('treats mpegurl content-types as manifests', () => {
    expect(isHlsManifest('application/vnd.apple.mpegurl', MASTER_URL)).toBe(true)
    expect(isHlsManifest('application/x-mpegURL', MASTER_URL)).toBe(true)
  })
  it('treats the Cloudflare 403 HTML page as NOT a manifest', () => {
    expect(isHlsManifest('text/html; charset=UTF-8', MASTER_URL)).toBe(false)
  })
  it('treats video/binary content-types as NOT manifests', () => {
    expect(isHlsManifest('video/mp2t', 'https://x.artlist.io/seg_001.ts')).toBe(false)
    expect(isHlsManifest('video/mp4', 'https://x.artlist.io/seg_001.m4s')).toBe(false)
  })
  it('falls back to the .m3u8 extension when content-type is generic', () => {
    expect(isHlsManifest('application/octet-stream', MASTER_URL)).toBe(true)
    expect(isHlsManifest('', MASTER_URL)).toBe(true)
    expect(isHlsManifest('', 'https://x.artlist.io/seg_001.ts')).toBe(false)
  })
  it('treats a .m3u8 served with a bogus content-type as a manifest (Artlist quirk)', () => {
    // ~12% of Artlist clips serve their master playlist as
    // application/x-www-form-urlencoded. The URL extension must win, else the
    // manifest gets streamed as opaque binary (URIs un-rewritten) and never
    // plays — the "some clips play, some don't" regression.
    expect(isHlsManifest('application/x-www-form-urlencoded', MASTER_URL)).toBe(true)
    expect(isHlsManifest('application/x-www-form-urlencoded', 'https://x.artlist.io/seg.ts')).toBe(false)
  })
})

describe('rewriteHlsManifest', () => {
  it('rewrites relative variant playlist URIs in a master playlist through the proxy', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240',
      'abc_240p_1710331847.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720',
      'abc_720p_1710331847.m3u8',
    ].join('\n')

    const out = rewriteHlsManifest(master, MASTER_URL, PROXY)
    const lines = out.split('\n')

    // Tag lines are untouched.
    expect(lines[0]).toBe('#EXTM3U')
    expect(lines[2]).toBe('#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240')

    // Variant URIs are resolved to absolute and wrapped through the proxy.
    const expected240 = `${PROXY}?u=${encodeURIComponent(
      'https://cms-public-artifacts.artlist.io/content/artgrid/footage-hls/abc_240p_1710331847.m3u8',
    )}`
    expect(lines[3]).toBe(expected240)
    expect(lines[5]).toContain(`${PROXY}?u=`)
    expect(decodeURIComponent(lines[5].split('?u=')[1])).toContain('abc_720p_1710331847.m3u8')
  })

  it('rewrites segment URIs and EXT-X-MAP/KEY URI attributes in a media playlist', () => {
    const variant = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0',
      '#EXTINF:6.000,',
      'seg_00001.m4s',
      '#EXTINF:6.000,',
      'seg_00002.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const variantUrl =
      'https://cms-public-artifacts.artlist.io/content/artgrid/footage-hls/abc_720p_1710331847.m3u8'

    const out = rewriteHlsManifest(variant, variantUrl, PROXY)

    // EXTINF and other tags without a URI are untouched.
    expect(out).toContain('#EXTINF:6.000,')
    expect(out).toContain('#EXT-X-ENDLIST')

    // Segment URIs wrapped.
    expect(out).toContain(
      `${PROXY}?u=${encodeURIComponent(
        'https://cms-public-artifacts.artlist.io/content/artgrid/footage-hls/seg_00001.m4s',
      )}`,
    )
    // EXT-X-MAP URI rewritten in place, attribute preserved.
    expect(out).toContain(
      `#EXT-X-MAP:URI="${PROXY}?u=${encodeURIComponent(
        'https://cms-public-artifacts.artlist.io/content/artgrid/footage-hls/init.mp4',
      )}"`,
    )
    // EXT-X-KEY URI rewritten, other attributes (METHOD, IV) preserved.
    expect(out).toContain('#EXT-X-KEY:METHOD=AES-128,URI="' + PROXY + '?u=')
    expect(out).toContain('IV=0x0')
  })

  it('preserves blank lines and leaves nothing un-proxied for a real Artlist master', () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240\nabc_240p.m3u8\n'
    const out = rewriteHlsManifest(master, MASTER_URL, PROXY)
    // No bare artlist URL should survive un-wrapped.
    for (const line of out.split('\n')) {
      if (line && !line.startsWith('#')) {
        expect(line.startsWith(`${PROXY}?u=`)).toBe(true)
      }
    }
  })
})
