import { describe, it, expect, beforeEach, vi } from 'vitest'
import { scheduleBrollPreload, clearBrollPreload } from '../brollPreloader.js'

function getPreloadLinks() {
  return Array.from(document.head.querySelectorAll('link[rel="preload"][as="video"]'))
}

function placement(idx, timelineStart, url) {
  return {
    index: idx,
    timelineStart,
    results: [{ preview_url: url }],
    persistedSelectedResult: 0,
  }
}

describe('brollPreloader', () => {
  beforeEach(() => {
    clearBrollPreload()
    vi.useFakeTimers()
  })

  it('marks first 4 active clips as fetchpriority=high (HIGH_PRIORITY_COUNT)', () => {
    const placements = Array.from({ length: 8 }, (_, i) =>
      placement(i, i * 5, `https://cdn.test/clip-${i}.mp4`)
    )
    scheduleBrollPreload({ activePlacements: placements, currentTime: 0 })
    vi.advanceTimersByTime(60)

    const links = getPreloadLinks()
    expect(links).toHaveLength(8)
    const high = links.filter(l => l.getAttribute('fetchpriority') === 'high')
    const low = links.filter(l => l.getAttribute('fetchpriority') === 'low')
    expect(high).toHaveLength(4)
    expect(low).toHaveLength(4)
  })

  it('low→high upgrade replaces the <link> element so the browser re-fetches at the new priority', () => {
    // First schedule: clip-2 is at index 5, low priority.
    const initial = Array.from({ length: 6 }, (_, i) =>
      placement(i, i * 5, `https://cdn.test/clip-${i}.mp4`)
    )
    scheduleBrollPreload({ activePlacements: initial, currentTime: 0 })
    vi.advanceTimersByTime(60)

    const before = getPreloadLinks().find(l => l.href.endsWith('clip-5.mp4'))
    expect(before).toBeTruthy()
    expect(before.getAttribute('fetchpriority')).toBe('low')

    // Advance currentTime so clip-5 moves into the first 4 (high tier).
    // Filter window: timelineStart >= currentTime - 1 = 24. clip-5 is at 25, becomes
    // index 0 of remaining → high. clip-4 (20) is filtered out.
    scheduleBrollPreload({ activePlacements: initial, currentTime: 25 })
    vi.advanceTimersByTime(60)

    const after = getPreloadLinks().find(l => l.href.endsWith('clip-5.mp4'))
    expect(after).toBeTruthy()
    expect(after.getAttribute('fetchpriority')).toBe('high')
    // Critically: must be a NEW DOM element (not the same one with mutated attribute),
    // because setAttribute() doesn't re-prioritize an in-flight or completed fetch.
    expect(after).not.toBe(before)
    // And the old one must no longer be in the document.
    expect(before.parentNode).toBeNull()
  })

  it('same-priority touch keeps the same <link> element (no re-fetch)', () => {
    const placements = [placement(0, 0, 'https://cdn.test/clip-0.mp4')]
    scheduleBrollPreload({ activePlacements: placements, currentTime: 0 })
    vi.advanceTimersByTime(60)

    const before = getPreloadLinks()[0]

    // Same currentTime, same placement → same priority (high). Should reuse the element.
    scheduleBrollPreload({ activePlacements: placements, currentTime: 0 })
    vi.advanceTimersByTime(60)

    const after = getPreloadLinks()[0]
    expect(after).toBe(before)
  })

  it('removes <link> tags for clips that fall out of the preload window', () => {
    const placements = Array.from({ length: 12 }, (_, i) =>
      placement(i, i * 5, `https://cdn.test/clip-${i}.mp4`)
    )
    scheduleBrollPreload({ activePlacements: placements, currentTime: 0 })
    vi.advanceTimersByTime(60)
    expect(getPreloadLinks()).toHaveLength(10) // slice(0, 10)

    // Advance: clips 0-4 (timelineStart 0,5,10,15,20) all fall behind currentTime - 1 = 49.
    scheduleBrollPreload({ activePlacements: placements, currentTime: 50 })
    vi.advanceTimersByTime(60)

    const urls = getPreloadLinks().map(l => l.href)
    // clip-0..clip-4 should be evicted; clip-10, clip-11 are at 50, 55 → in window.
    expect(urls.some(u => u.endsWith('clip-0.mp4'))).toBe(false)
    expect(urls.some(u => u.endsWith('clip-4.mp4'))).toBe(false)
    expect(urls.some(u => u.endsWith('clip-10.mp4'))).toBe(true)
    expect(urls.some(u => u.endsWith('clip-11.mp4'))).toBe(true)
  })
})
