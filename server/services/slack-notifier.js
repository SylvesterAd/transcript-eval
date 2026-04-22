// Central Slack alerting. notify() is synchronous and never blocks the caller.
// Reads SLACK_WEBHOOK_URL at module init. If missing, notify() is a no-op.

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || null
const ENV_TAG = process.env.SLACK_ENV_TAG || 'prod'
const MAX_QUEUE = 500
const DRAIN_INTERVAL_MS = 1000
const MAX_RETRIES = 3

const EMOJI_BY_PREFIX = [
  ['broll-', '🔴'],
  ['rough-cut', '🟠'],
  ['gpu', '🟣'],
  ['api-log', '🟡'],
]

const queue = []
let droppedCount = 0
let drainTimer = null

function pickEmoji(source) {
  for (const [prefix, emoji] of EMOJI_BY_PREFIX) {
    if (source === prefix || source.startsWith(prefix)) return emoji
  }
  return '⚪'
}

function format({ source, title, error, meta }) {
  const emoji = pickEmoji(source)
  const errMsg = error instanceof Error ? error.message : (error || '')
  const lines = [`${emoji} [${ENV_TAG}][${source}] ${title}`]
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta)) {
      if (v != null && v !== '') lines.push(`${k}: ${v}`)
    }
  }
  if (errMsg) lines.push(`error: ${errMsg}`)
  lines.push(`t: ${new Date().toISOString()}`)
  return lines.join('\n')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function sendWithRetries(text) {
  let attempt = 0
  while (attempt < MAX_RETRIES) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (res.ok) return true
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10)
        await sleep(Math.max(1, retryAfter) * 1000)
        continue
      }
    } catch {
      // Network error: fall through to backoff
    }
    attempt++
    if (attempt < MAX_RETRIES) await sleep(500 * Math.pow(2, attempt - 1))
  }
  return false
}

function ensureDrain() {
  if (drainTimer) return
  drainTimer = setInterval(async () => {
    if (droppedCount > 0) {
      const summary = `⚠️ [${ENV_TAG}] ${droppedCount} alert(s) dropped (backpressure)`
      droppedCount = 0
      await sendWithRetries(summary).catch(() => {})
    }
    const next = queue.shift()
    if (!next) {
      clearInterval(drainTimer)
      drainTimer = null
      return
    }
    const ok = await sendWithRetries(next).catch(() => false)
    if (!ok) console.warn('[slack-notifier] Dropped message after retries')
  }, DRAIN_INTERVAL_MS)
}

export function notify({ source, title, error, meta }) {
  if (!WEBHOOK_URL) return
  if (!source || !title) return
  if (queue.length >= MAX_QUEUE) {
    queue.shift()
    droppedCount++
  }
  queue.push(format({ source, title, error, meta }))
  ensureDrain()
}

export function _internalState() {
  return { queueLength: queue.length, dropped: droppedCount, draining: !!drainTimer }
}
