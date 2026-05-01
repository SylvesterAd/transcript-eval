import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

// vi.mock() is hoisted to the top of the file before imports. Use vi.hoisted()
// so HlsMock + hlsInstances are also hoisted and available inside the factory.
const { HlsMock, hlsInstances } = vi.hoisted(() => {
  const hlsInstances = []
  const HlsMock = vi.fn(function (config) {
    this.config = config
    this.loadSource = vi.fn()
    this.attachMedia = vi.fn()
    this.destroy = vi.fn()
    this.on = vi.fn()
    hlsInstances.push(this)
  })
  HlsMock.isSupported = vi.fn(() => true)
  HlsMock.Events = { MANIFEST_PARSED: 'hlsManifestParsed' }
  return { HlsMock, hlsInstances }
})

vi.mock('hls.js', () => ({ default: HlsMock }))

import { useHlsSource } from '../useHlsSource.js'

function makeVideoEl() {
  const el = document.createElement('video')
  el.canPlayType = vi.fn(() => '')
  return el
}

describe('useHlsSource', () => {
  beforeEach(() => {
    hlsInstances.length = 0
    HlsMock.mockClear()
    HlsMock.isSupported.mockReturnValue(true)
  })

  it('attaches Hls.js when hlsUrl provided and Hls.isSupported()', () => {
    const video = makeVideoEl()
    const ref = { current: video }
    renderHook(() => useHlsSource(ref, { hlsUrl: 'https://example/m.m3u8', mp4Url: null }))
    expect(hlsInstances).toHaveLength(1)
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith('https://example/m.m3u8')
    expect(hlsInstances[0].attachMedia).toHaveBeenCalledWith(video)
    expect(hlsInstances[0].config).toMatchObject({ capLevelToPlayerSize: true })
  })

  it('falls back to native src in Safari when Hls.isSupported() is false', () => {
    HlsMock.isSupported.mockReturnValue(false)
    const video = makeVideoEl()
    video.canPlayType = vi.fn(() => 'maybe')
    const ref = { current: video }
    renderHook(() => useHlsSource(ref, { hlsUrl: 'https://example/m.m3u8', mp4Url: 'https://example/m.mp4' }))
    expect(hlsInstances).toHaveLength(0)
    expect(video.src).toBe('https://example/m.m3u8')
  })

  it('falls back to mp4Url when hlsUrl is null', () => {
    const video = makeVideoEl()
    const ref = { current: video }
    renderHook(() => useHlsSource(ref, { hlsUrl: null, mp4Url: 'https://example/m.mp4' }))
    expect(hlsInstances).toHaveLength(0)
    expect(video.src).toBe('https://example/m.mp4')
  })

  it('destroys Hls instance on unmount', () => {
    const video = makeVideoEl()
    const ref = { current: video }
    const { unmount } = renderHook(() =>
      useHlsSource(ref, { hlsUrl: 'https://example/m.m3u8', mp4Url: null })
    )
    const instance = hlsInstances[0]
    unmount()
    expect(instance.destroy).toHaveBeenCalledTimes(1)
  })

  it('caps quality at ~480p via MANIFEST_PARSED handler', () => {
    const video = makeVideoEl()
    const ref = { current: video }
    renderHook(() => useHlsSource(ref, { hlsUrl: 'https://example/m.m3u8', mp4Url: null }))
    const instance = hlsInstances[0]
    const handler = instance.on.mock.calls.find(c => c[0] === 'hlsManifestParsed')?.[1]
    expect(handler).toBeTypeOf('function')
    instance.levels = [
      { height: 240 }, { height: 360 }, { height: 480 }, { height: 720 }, { height: 1080 },
    ]
    handler()
    // Indices 0,1,2 are ≤480p; cap should be 2.
    expect(instance.autoLevelCapping).toBe(2)
  })
})
