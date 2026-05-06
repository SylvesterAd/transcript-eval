import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePlaybackSkipRegions } from '../usePlaybackSkipRegions.js'

function makeVideoRef(initialTime = 0) {
  const ref = {
    current: {
      currentTime: initialTime,
      paused: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  }
  return ref
}

describe('usePlaybackSkipRegions', () => {
  it('attaches a timeupdate listener on mount', () => {
    const ref = makeVideoRef()
    renderHook(() => usePlaybackSkipRegions(ref, [], []))
    expect(ref.current.addEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function))
  })

  it('removes the listener on unmount', () => {
    const ref = makeVideoRef()
    const { unmount } = renderHook(() => usePlaybackSkipRegions(ref, [], []))
    unmount()
    expect(ref.current.removeEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function))
  })

  it('jumps over a cut when timeupdate fires inside it', () => {
    const ref = makeVideoRef(15)
    const cuts = [{ id: 'c1', start: 10, end: 20, source: 'transcript' }]
    renderHook(() => usePlaybackSkipRegions(ref, cuts, []))
    const handler = ref.current.addEventListener.mock.calls[0][1]
    handler()
    expect(ref.current.currentTime).toBeGreaterThanOrEqual(20)
  })

  it('does not jump when timeupdate fires outside any cut', () => {
    const ref = makeVideoRef(25)
    const cuts = [{ id: 'c1', start: 10, end: 20, source: 'transcript' }]
    renderHook(() => usePlaybackSkipRegions(ref, cuts, []))
    const handler = ref.current.addEventListener.mock.calls[0][1]
    handler()
    expect(ref.current.currentTime).toBe(25)
  })

  it('respects cutExclusions (excluded sub-region is not skipped)', () => {
    const ref = makeVideoRef(15)
    const cuts = [{ id: 'c1', start: 10, end: 30, source: 'transcript' }]
    const exclusions = [{ start: 12, end: 18 }]
    renderHook(() => usePlaybackSkipRegions(ref, cuts, exclusions))
    const handler = ref.current.addEventListener.mock.calls[0][1]
    handler()
    // 15 is inside the exclusion → playback continues; currentTime unchanged.
    expect(ref.current.currentTime).toBe(15)
  })

  it('handles empty cuts array (no-op)', () => {
    const ref = makeVideoRef(50)
    renderHook(() => usePlaybackSkipRegions(ref, [], []))
    const handler = ref.current.addEventListener.mock.calls[0][1]
    handler()
    expect(ref.current.currentTime).toBe(50)
  })

  it('merges overlapping cuts before applying', () => {
    const ref = makeVideoRef(15)
    // Two overlapping cuts that together cover [10, 30].
    const cuts = [
      { id: 'a', start: 10, end: 20, source: 'transcript' },
      { id: 'b', start: 15, end: 30, source: 'transcript' },
    ]
    renderHook(() => usePlaybackSkipRegions(ref, cuts, []))
    const handler = ref.current.addEventListener.mock.calls[0][1]
    handler()
    // Should jump to 30 (merged end), not 20.
    expect(ref.current.currentTime).toBeGreaterThanOrEqual(30)
  })
})
