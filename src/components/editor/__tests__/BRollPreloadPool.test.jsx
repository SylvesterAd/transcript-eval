import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import BRollPreloadPool from '../BRollPreloadPool.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function placement(idx, timelineStart, url) {
  return {
    index: idx,
    timelineStart,
    results: [{ preview_url: url }],
    persistedSelectedResult: 0,
  }
}

function getPoolVideoUrls(container) {
  return Array.from(container.querySelectorAll('video')).map(v => v.getAttribute('src'))
}

describe('BRollPreloadPool', () => {
  let container, root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders <video preload="auto"> elements for the next 5 active clips', () => {
    const placements = Array.from({ length: 8 }, (_, i) =>
      placement(i, i * 5, `https://cdn.test/clip-${i}.mp4`)
    )
    act(() => {
      root.render(<BRollPreloadPool activePlacements={placements} currentTime={0} />)
    })
    const videos = container.querySelectorAll('video')
    expect(videos).toHaveLength(5)
    for (const v of videos) {
      expect(v.getAttribute('preload')).toBe('auto')
      expect(v.muted).toBe(true)
    }
    const urls = getPoolVideoUrls(container)
    expect(urls).toEqual([
      'https://cdn.test/clip-0.mp4',
      'https://cdn.test/clip-1.mp4',
      'https://cdn.test/clip-2.mp4',
      'https://cdn.test/clip-3.mp4',
      'https://cdn.test/clip-4.mp4',
    ])
  })

  it('drops <video> elements for clips that fall behind currentTime', () => {
    const placements = Array.from({ length: 10 }, (_, i) =>
      placement(i, i * 5, `https://cdn.test/clip-${i}.mp4`)
    )
    act(() => {
      root.render(<BRollPreloadPool activePlacements={placements} currentTime={0} />)
    })
    expect(getPoolVideoUrls(container)).toEqual([
      'https://cdn.test/clip-0.mp4',
      'https://cdn.test/clip-1.mp4',
      'https://cdn.test/clip-2.mp4',
      'https://cdn.test/clip-3.mp4',
      'https://cdn.test/clip-4.mp4',
    ])

    // Advance: timelineStart >= currentTime - 1 = 24, so clips 0-4 (start <= 20) drop out.
    act(() => {
      root.render(<BRollPreloadPool activePlacements={placements} currentTime={25} />)
    })
    expect(getPoolVideoUrls(container)).toEqual([
      'https://cdn.test/clip-5.mp4',
      'https://cdn.test/clip-6.mp4',
      'https://cdn.test/clip-7.mp4',
      'https://cdn.test/clip-8.mp4',
      'https://cdn.test/clip-9.mp4',
    ])
  })

  it('preloads 1 clip per inactive variant in addition to the active 5', () => {
    const active = Array.from({ length: 3 }, (_, i) =>
      placement(i, i * 5, `https://cdn.test/active-${i}.mp4`)
    )
    const inactive = {
      'pid-A': [placement(0, 0, 'https://cdn.test/A-0.mp4'), placement(1, 5, 'https://cdn.test/A-1.mp4')],
      'pid-B': [placement(0, 0, 'https://cdn.test/B-0.mp4')],
    }
    act(() => {
      root.render(
        <BRollPreloadPool activePlacements={active} inactivePlacementsByPid={inactive} currentTime={0} />
      )
    })
    const urls = getPoolVideoUrls(container)
    expect(urls).toContain('https://cdn.test/active-0.mp4')
    expect(urls).toContain('https://cdn.test/active-1.mp4')
    expect(urls).toContain('https://cdn.test/active-2.mp4')
    expect(urls).toContain('https://cdn.test/A-0.mp4')
    expect(urls).toContain('https://cdn.test/B-0.mp4')
    // Only the FIRST inactive clip per variant — A-1 should not appear
    expect(urls).not.toContain('https://cdn.test/A-1.mp4')
  })

  it('deduplicates URLs that appear in both active and inactive', () => {
    const url = 'https://cdn.test/shared.mp4'
    const active = [placement(0, 0, url)]
    const inactive = { 'pid-A': [placement(0, 0, url)] }
    act(() => {
      root.render(
        <BRollPreloadPool activePlacements={active} inactivePlacementsByPid={inactive} currentTime={0} />
      )
    })
    const urls = getPoolVideoUrls(container)
    expect(urls).toEqual([url])
  })

  it('honors selectedResultsByIndex override over persistedSelectedResult', () => {
    const p = {
      index: 0,
      timelineStart: 0,
      results: [
        { preview_url: 'https://cdn.test/result-0.mp4' },
        { preview_url: 'https://cdn.test/result-1.mp4' },
      ],
      persistedSelectedResult: 0,
    }
    act(() => {
      root.render(
        <BRollPreloadPool
          activePlacements={[p]}
          currentTime={0}
          selectedResultsByIndex={{ 0: 1 }}
        />
      )
    })
    expect(getPoolVideoUrls(container)).toEqual(['https://cdn.test/result-1.mp4'])
  })
})
