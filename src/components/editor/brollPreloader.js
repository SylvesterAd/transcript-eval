// LRU cache of <link rel="preload" as="video"> tags appended to <head>.
// Keeps network pressure low by capping at 20 concurrent preloads with
// fetchpriority=low, evicting least-recently-used URLs when new ones arrive.

const MAX_ENTRIES = 20
const links = new Map() // url -> HTMLLinkElement
let scheduleTimer = null

function addPreload(url) {
  if (!url || typeof document === 'undefined') return
  if (links.has(url)) {
    // Touch for LRU: re-insert to move to end
    const el = links.get(url)
    links.delete(url)
    links.set(url, el)
    return
  }
  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'video'
  link.href = url
  link.setAttribute('fetchpriority', 'low')
  document.head.appendChild(link)
  links.set(url, link)
  while (links.size > MAX_ENTRIES) {
    const oldestUrl = links.keys().next().value
    const oldestEl = links.get(oldestUrl)
    if (oldestEl?.parentNode) oldestEl.parentNode.removeChild(oldestEl)
    links.delete(oldestUrl)
  }
}

function removeUnused(keepSet) {
  for (const url of [...links.keys()]) {
    if (!keepSet.has(url)) {
      const el = links.get(url)
      if (el?.parentNode) el.parentNode.removeChild(el)
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
  if (scheduleTimer) clearTimeout(scheduleTimer)
  scheduleTimer = setTimeout(() => {
    const keep = new Set()
    const pickUrl = (p) => {
      const ri = selectedResultsByIndex[p.index] ?? p.persistedSelectedResult ?? 0
      const r = p.results?.[ri]
      if (!r) return null
      return r.preview_url || r.preview_url_hq || r.url
    }

    // Active variant: next 5 clips at-or-after (currentTime - 1s)
    const active = [...activePlacements]
      .filter(p => p.timelineStart >= currentTime - 1)
      .sort((a, b) => a.timelineStart - b.timelineStart)
      .slice(0, 5)
    for (const p of active) { const u = pickUrl(p); if (u) keep.add(u) }

    // Each inactive variant: next 2 clips
    for (const placements of Object.values(inactivePlacementsByPid)) {
      const list = [...(placements || [])]
        .filter(p => p.timelineStart >= currentTime - 1)
        .sort((a, b) => a.timelineStart - b.timelineStart)
        .slice(0, 2)
      for (const p of list) { const u = pickUrl(p); if (u) keep.add(u) }
    }

    for (const url of keep) addPreload(url)
    removeUnused(keep)
  }, 250)
}

export function clearBrollPreload() {
  for (const el of links.values()) { if (el?.parentNode) el.parentNode.removeChild(el) }
  links.clear()
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null }
}
