// In-memory pub/sub for pipeline telemetry. Each subscriber registers for a
// specific sessionId; emit() fans out to all subscribers for that session.
// No persistence — events are best-effort streaming. SSE consumers may miss
// events that happened before they connected; that's acceptable for MVP.

const subscribers = new Map() // sessionId → Set<callback>

export function subscribe(sessionId, callback) {
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set())
  subscribers.get(sessionId).add(callback)
  return () => {
    const set = subscribers.get(sessionId)
    if (set) {
      set.delete(callback)
      if (set.size === 0) subscribers.delete(sessionId)
    }
  }
}

export function emit(event) {
  const set = subscribers.get(event.sessionId)
  if (!set) return
  for (const cb of set) {
    try { cb(event) } catch (e) { console.error('[emitter] subscriber threw', e) }
  }
}
