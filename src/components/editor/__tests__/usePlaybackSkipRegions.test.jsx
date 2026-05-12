import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { computeSkipRegions, usePlaybackSkipRegions } from '../usePlaybackSkipRegions.js'

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

describe('computeSkipRegions (pure)', () => {
  it('returns empty array for no cuts', () => {
    expect(computeSkipRegions([])).toEqual([])
    expect(computeSkipRegions(null)).toEqual([])
  })

  it('merges overlapping cuts', () => {
    const out = computeSkipRegions([
      { start: 10, end: 20 },
      { start: 15, end: 30 },
    ])
    expect(out).toEqual([{ start: 10, end: 30 }])
  })

  it('subtracts cutExclusions from merged regions', () => {
    const out = computeSkipRegions(
      [{ start: 10, end: 30 }],
      [{ start: 15, end: 20 }],
    )
    expect(out).toEqual([
      { start: 10, end: 15 },
      { start: 20, end: 30 },
    ])
  })

  it('filters out near-zero-width cuts', () => {
    const out = computeSkipRegions([{ start: 10, end: 10.005 }])
    expect(out).toEqual([])
  })

  describe('word-aware merge', () => {
    it('merges adjacent cuts when the gap contains no transcript word', () => {
      // Real case from project 367: an ai-silence cut and the user's
      // Backspace cut leave a 200ms gap whose only nearby word ("[clears
      // throat]") starts AT the gap's far edge (not inside it). Result:
      // one merged region instead of two with a sliver between.
      const cuts = [
        { start: 175.69, end: 176.23, source: 'ai-silence' },
        { start: 176.43, end: 178.15, source: 'transcript' },
      ]
      const words = [
        { start: 175.08, end: 175.519, word: 'seven.' },
        { start: 176.48, end: 177.74, word: '[clears throat]' },
        { start: 178.22, end: 178.46, word: 'Number' },
      ]
      const out = computeSkipRegions(cuts, [], words)
      expect(out).toEqual([{ start: 175.69, end: 178.15 }])
    })

    it('keeps cuts separate when a transcript word fits in the gap', () => {
      const cuts = [
        { start: 10, end: 12, source: 'transcript' },
        { start: 14, end: 16, source: 'transcript' },
      ]
      const words = [{ start: 12.5, end: 13.5, word: 'keepme' }]
      const out = computeSkipRegions(cuts, [], words)
      expect(out).toEqual([
        { start: 10, end: 12 },
        { start: 14, end: 16 },
      ])
    })

    it('falls back to the 50ms basic merge when words is null', () => {
      const cuts = [
        { start: 10, end: 12, source: 'transcript' },
        { start: 12.04, end: 14, source: 'transcript' },  // 40ms gap → still merges
        { start: 15, end: 17, source: 'transcript' },     // 1s gap, no words → stays separate without words
      ]
      const out = computeSkipRegions(cuts, [])
      expect(out).toEqual([
        { start: 10, end: 14 },
        { start: 15, end: 17 },
      ])
    })

    it('does not merge across a word-less gap when the cuts overlap an exclusion', () => {
      // Smart-merge runs before exclusion split — the user's manual
      // exclusion still carves out a kept sub-region after the merge.
      const cuts = [
        { start: 10, end: 12, source: 'transcript' },
        { start: 13, end: 15, source: 'transcript' },
      ]
      const words = []  // no words anywhere → smart-merge would join 10-15
      const exclusions = [{ start: 11, end: 14 }]
      const out = computeSkipRegions(cuts, exclusions, words)
      expect(out).toEqual([
        { start: 10, end: 11 },
        { start: 14, end: 15 },
      ])
    })
  })
})

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
