import { describe, it, expect, vi } from 'vitest'
import { probeDuration } from '../UploadModal.jsx'

// Each test injects mock factories so we don't need a real DOM with media decoding.
// happy-dom doesn't actually parse video files, so loadedmetadata never fires
// against a real <video>. The injection points keep production code clean while
// letting unit tests exercise every branch.

function mockFactories(overrides = {}) {
  const calls = { revokeObjectURL: 0 }
  const fakeVideo = overrides.fakeVideo || { duration: 0, src: null, preload: null, onloadedmetadata: null, onerror: null }
  return {
    fakeVideo,
    calls,
    factories: {
      _createElement: () => fakeVideo,
      _createObjectURL: () => 'blob:test-mock',
      _revokeObjectURL: () => { calls.revokeObjectURL++ },
    },
  }
}

describe('probeDuration', () => {
  it('returns the duration in seconds when loadedmetadata fires with finite duration', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = { duration: 612.3, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories, calls } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    // Simulate the browser firing loadedmetadata after src assignment
    setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)

    const result = await promise
    expect(result).toBe(612.3)
    expect(calls.revokeObjectURL).toBe(1)
  })

  it('returns null when duration is Infinity (some streams report this until seek)', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = { duration: Infinity, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)

    expect(await promise).toBe(null)
  })

  it('returns null when duration is NaN (browser cannot decode container)', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = { duration: NaN, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)

    expect(await promise).toBe(null)
  })

  it('returns null when the video element fires onerror', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = { duration: 0, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories, calls } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    setTimeout(() => fakeVideo.onerror?.(), 0)

    expect(await promise).toBe(null)
    expect(calls.revokeObjectURL).toBe(1) // still cleans up the blob URL
  })

  it('sets preload="metadata" on the video element (no full file decode)', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = { duration: 100, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)

    await promise
    expect(fakeVideo.preload).toBe('metadata')
  })
})
