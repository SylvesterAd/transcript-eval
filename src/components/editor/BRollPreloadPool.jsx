import { useEffect, useMemo } from 'react'

// Preloads upcoming b-roll clips by rendering hidden <video preload="auto">
// elements. Each goes through the same media-cache code path as the main
// player, so when the player switches src to one of these URLs the data is
// already buffered. <link rel="preload" as="video"> doesn't reliably
// populate the cache that <video> Range requests consume from in Chrome —
// see https://bugs.chromium.org/p/chromium/issues/detail?id=988867.
//
// Sizing: 5 active + 1 per inactive variant (matches the user's "next 5"
// expectation; inactive variants need only one so a quick variant-switch
// doesn't show a cold load).

function pickUrl(p, selectedResultsByIndex) {
  const ri = selectedResultsByIndex[p.index] ?? p.persistedSelectedResult ?? 0
  const r = p.results?.[ri]
  return r?.preview_url || r?.preview_url_hq || r?.url || null
}

export default function BRollPreloadPool({
  activePlacements = [],
  inactivePlacementsByPid = {},
  currentTime = 0,
  selectedResultsByIndex = {},
}) {
  const urls = useMemo(() => {
    const set = new Set()

    const active = [...activePlacements]
      .filter(p => p.timelineStart >= currentTime - 1)
      .sort((a, b) => a.timelineStart - b.timelineStart)
      .slice(0, 5)
    for (const p of active) {
      const u = pickUrl(p, selectedResultsByIndex)
      if (u) set.add(u)
    }

    for (const placements of Object.values(inactivePlacementsByPid)) {
      const list = [...(placements || [])]
        .filter(p => p.timelineStart >= currentTime - 1)
        .sort((a, b) => a.timelineStart - b.timelineStart)
        .slice(0, 1)
      for (const p of list) {
        const u = pickUrl(p, selectedResultsByIndex)
        if (u) set.add(u)
      }
    }

    return [...set]
  }, [activePlacements, inactivePlacementsByPid, currentTime, selectedResultsByIndex])

  useEffect(() => {
    if (urls.length) {
      console.log('[broll-preload-pool]', urls.length, 'clips:', urls.map(u => u.slice(0, 80)))
    }
  }, [urls])

  // Off-screen positioning (not display:none) — Chrome won't fetch preload
  // data for display:none video elements. 1×1 px far off-screen still
  // counts as "rendered" so the browser actually downloads.
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: '-9999px',
        top: '-9999px',
        width: '1px',
        height: '1px',
        pointerEvents: 'none',
        opacity: 0,
      }}
    >
      {urls.map(url => (
        <video
          key={url}
          src={url}
          preload="auto"
          muted
          playsInline
        />
      ))}
    </div>
  )
}
