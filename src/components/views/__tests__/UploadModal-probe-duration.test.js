import { describe, it, expect, vi } from 'vitest'
import { probeDuration } from '../UploadModal.jsx'

// Each test injects mock factories so we don't need a real DOM with media decoding.
// happy-dom doesn't actually parse video files, so loadedmetadata never fires
// against a real <video>. The injection points keep production code clean while
// letting unit tests exercise every branch.

function mockFactories(overrides = {}) {
  const calls = { revokeObjectURL: 0 }
  const fakeVideo = overrides.fakeVideo || {
    duration: 0, videoWidth: 0, videoHeight: 0,
    src: null, preload: null, onloadedmetadata: null, onerror: null,
  }
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
  it('returns duration + dimensions when loadedmetadata fires with finite duration', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = {
      duration: 612.3, videoWidth: 1920, videoHeight: 1080,
      src: null, preload: null, onloadedmetadata: null, onerror: null,
    }
    const { factories, calls } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    // Simulate the browser firing loadedmetadata after src assignment
    setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)

    const result = await promise
    expect(result).toEqual({ duration: 612.3, width: 1920, height: 1080 })
    expect(calls.revokeObjectURL).toBe(1)
  })

  it('reports portrait dimensions for phone-shot footage', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = {
      duration: 30, videoWidth: 1080, videoHeight: 1920,
      src: null, preload: null, onloadedmetadata: null, onerror: null,
    }
    const { factories } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)

    expect(await promise).toEqual({ duration: 30, width: 1080, height: 1920 })
  })

  it('returns width=null + height=null when audio fallback is used (videoWidth absent)', async () => {
    // First attempt (video tag) errors. Audio fallback succeeds with no
    // videoWidth/videoHeight on the element, so probe returns null dims.
    const file = new Blob([], { type: 'audio/mp3' })
    const fakeVideo = { duration: 184, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    setTimeout(() => {
      fakeVideo.onerror?.()                                      // video tag fails
      setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)        // audio tag succeeds
    }, 0)

    expect(await promise).toEqual({ duration: 184, width: null, height: null })
  })

  it('returns null when duration is Infinity (some streams report this until seek)', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = { duration: Infinity, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    // video fires with Infinity → null; audio fallback uses same element, fires again → null
    setTimeout(() => {
      fakeVideo.onloadedmetadata?.()
      setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)
    }, 0)

    expect(await promise).toBe(null)
  })

  it('returns null when duration is NaN (browser cannot decode container)', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = { duration: NaN, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    // video fires with NaN → null; audio fallback uses same element, fires again → null
    setTimeout(() => {
      fakeVideo.onloadedmetadata?.()
      setTimeout(() => fakeVideo.onloadedmetadata?.(), 0)
    }, 0)

    expect(await promise).toBe(null)
  })

  it('returns null when both video and audio elements fire onerror', async () => {
    const file = new Blob([], { type: 'video/mp4' })
    const fakeVideo = { duration: 0, src: null, preload: null, onloadedmetadata: null, onerror: null }
    const { factories, calls } = mockFactories({ fakeVideo })

    const promise = probeDuration(file, factories)
    // Fire onerror once for video, then again for the audio fallback
    // (mockFactories returns the same element for both tags)
    setTimeout(() => {
      fakeVideo.onerror?.()
      setTimeout(() => fakeVideo.onerror?.(), 0)
    }, 0)

    expect(await promise).toBe(null)
    expect(calls.revokeObjectURL).toBe(2) // one revoke per element (video + audio)
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
