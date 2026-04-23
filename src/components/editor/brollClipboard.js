// In-memory + localStorage-mirrored clipboard for b-roll placements.
// Only one slot; newer copy overwrites older.

const STORAGE_KEY = 'broll-clipboard'
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h — purge stale entries

let memCache = null
const subscribers = new Set()

function notify() {
  for (const cb of subscribers) cb(memCache)
}

export function getClipboard() {
  if (memCache) return memCache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.copiedAt) return null
    if (Date.now() - parsed.copiedAt > MAX_AGE_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    memCache = parsed
    return parsed
  } catch {
    return null
  }
}

export function setClipboard(entry) {
  memCache = entry
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry))
  } catch { /* storage full — ignore */ }
  notify()
}

export function clearClipboard() {
  memCache = null
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
  notify()
}

export function subscribeClipboard(cb) {
  subscribers.add(cb)
  // Push current value
  cb(memCache ?? getClipboard())
  return () => subscribers.delete(cb)
}

// Listen for cross-tab updates
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    memCache = null
    notify()
  })
}
