// LRU cache of <link rel="preload" as="video"> tags appended to <head>.
// Keeps network pressure low by capping at 20 concurrent preloads, evicting
// least-recently-used URLs when new ones arrive. The first ~4 imminent clips
// use fetchpriority=high; the rest use low so they don't crowd out the high ones.

const MAX_ENTRIES = 20
const HIGH_PRIORITY_COUNT = 4
const links = new Map() // url -> { el: HTMLLinkElement, priority: 'high'|'low' }
let scheduleTimer = null

function addPreload(url, priority) {
  if (!url || typeof document === 'undefined') return
  if (links.has(url)) {
    const entry = links.get(url)
    if (entry.priority === 'low' && priority === 'high') {
      // Low→high upgrade: setAttribute('fetchpriority') on an existing <link>
      // does NOT re-prioritize an in-flight or completed fetch. Remove the old
      // <link> and fall through to create a fresh one so the browser actually
      // issues a new request at the higher priority.
      if (entry.el?.parentNode) entry.el.parentNode.removeChild(entry.el)
      links.delete(url)
    } else {
      // Same priority (or high→low — re-fetching a completed high-priority
      // request as low wouldn't help): just touch LRU recency.
      links.delete(url)
      links.set(url, entry)
      return
    }
  }
  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'video'
  link.href = url
  link.setAttribute('fetchpriority', priority)
  // No crossorigin attribute — must match the <video> element (BRollPreview.jsx) which
  // also has no crossorigin set. A mode mismatch (e.g. preload=anonymous, video=no-cors)
  // makes the preloaded response non-reusable and forces the player to re-fetch.
  document.head.appendChild(link)
  links.set(url, { el: link, priority })
  console.log('[broll-preload] added', priority, url.slice(0, 80))
  while (links.size > MAX_ENTRIES) {
    const oldestUrl = links.keys().next().value
    const oldestEntry = links.get(oldestUrl)
    if (oldestEntry?.el?.parentNode) oldestEntry.el.parentNode.removeChild(oldestEntry.el)
    links.delete(oldestUrl)
  }
}

function removeUnused(keepSet) {
  for (const url of [...links.keys()]) {
    if (!keepSet.has(url)) {
      const entry = links.get(url)
      if (entry?.el?.parentNode) entry.el.parentNode.removeChild(entry.el)
      links.delete(url)
    }
  }
}

/**
 * Schedule preload for upcoming clips.
 *
 * @param {Array<{ timelineStart:number, index:any, results:Array<any>, persistedSelectedResult?:number }>} activePlacements
 * @param {Record<string, Array<any>>} inactivePlacementsByPid
 * @param {number} currentTime
 * @param {Record<string|number, number>} selectedResultsByIndex
 */
export function scheduleBrollPreload({ activePlacements = [], inactivePlacementsByPid = {}, currentTime = 0, selectedResultsByIndex = {} }) {
  // Coalesce rapid calls within a single frame, but keep the delay shorter than the
  // playback throttle (100ms) so the schedule actually fires while playing.
  if (scheduleTimer) clearTimeout(scheduleTimer)
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null
    const keep = new Map() // url -> priority ('high' | 'low')
    const pickUrl = (p) => {
      const ri = selectedResultsByIndex[p.index] ?? p.persistedSelectedResult ?? 0
      const r = p.results?.[ri]
      if (!r) return null
      return r.preview_url || r.preview_url_hq || r.url
    }
    const setKeep = (url, priority) => {
      // Upgrade to high if any source needs it; never downgrade.
      const existing = keep.get(url)
      if (existing === 'high') return
      keep.set(url, priority)
    }

    // Active variant: next 10 clips at-or-after (currentTime - 1s).
    // First HIGH_PRIORITY_COUNT use fetchpriority=high so they don't get deprioritized
    // behind low-priority preloads when bandwidth is contended.
    const active = [...activePlacements]
      .filter(p => p.timelineStart >= currentTime - 1)
      .sort((a, b) => a.timelineStart - b.timelineStart)
      .slice(0, 10)
    active.forEach((p, i) => {
      const u = pickUrl(p)
      if (u) setKeep(u, i < HIGH_PRIORITY_COUNT ? 'high' : 'low')
    })

    // Each inactive variant: next 2 clips at low priority
    for (const placements of Object.values(inactivePlacementsByPid)) {
      const list = [...(placements || [])]
        .filter(p => p.timelineStart >= currentTime - 1)
        .sort((a, b) => a.timelineStart - b.timelineStart)
        .slice(0, 2)
      for (const p of list) { const u = pickUrl(p); if (u) setKeep(u, 'low') }
    }

    for (const [url, priority] of keep) addPreload(url, priority)
    removeUnused(new Set(keep.keys()))
    console.log('[broll-preload] applied', {
      currentTime: currentTime.toFixed(2),
      keepCount: keep.size,
      cacheSize: links.size,
      activeNext: active.slice(0, 3).map(p => ({ start: p.timelineStart.toFixed(2), idx: p.index })),
    })
  }, 50)
}

export function clearBrollPreload() {
  for (const entry of links.values()) {
    if (entry?.el?.parentNode) entry.el.parentNode.removeChild(entry.el)
  }
  links.clear()
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null }
}
