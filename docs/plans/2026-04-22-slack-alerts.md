# Slack Failure Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire a Slack message for every failure in b-roll pipelines, rough-cut (experiment_runs) pipelines, GPU jobs (Supabase `broll_jobs`), and API logs (non-2xx / thrown fetch errors).

**Architecture:** One central `slack-notifier.js` module with an in-memory FIFO queue drained at 1 msg/sec. Call sites push synchronously and never block. A separate poller watches Supabase `broll_jobs` since the GPU runs externally. Env-var-gated — `SLACK_WEBHOOK_URL` already set in Railway prod; no-op when unset.

**Tech Stack:** Node.js (ES modules), Express, `@supabase/supabase-js`, native `fetch`. No test framework in this project — verification is manual via `node -e` smoke + `/api/admin/test-alert` post-deploy.

**Spec:** `docs/specs/2026-04-22-slack-alerts-design.md`

---

## File Structure

| File | Kind | Responsibility |
|---|---|---|
| `server/services/slack-notifier.js` | new | Central `notify()`, FIFO queue, drain+retry, backpressure |
| `server/services/gpu-failure-poller.js` | new | 30s Supabase poll for failed `broll_jobs`, dedupe by id |
| `server/routes/admin.js` | edit | Add `POST /api/admin/test-alert` |
| `server/services/api-logger.js` | edit | Fire `notify()` on non-2xx / thrown fetch in `loggedFetch` + `streamingFetch` |
| `server/services/broll.js` | edit | Fire `notify()` in 7 pipeline-level catch blocks |
| `server/services/llm-runner.js` | edit | Fire `notify()` in rough-cut catch at main pipeline level |
| `server/index.js` | edit | Start the GPU poller at boot |

---

## Task 1: Create the `slack-notifier.js` module

**Files:**
- Create: `server/services/slack-notifier.js`

**Why this is task 1:** Everything else calls into this module, so it has to exist first. We build the full module in one task because the pieces (queue, drain, retry, backpressure) only make sense together.

- [ ] **Step 1: Create the file with the complete implementation**

Write to `/Users/laurynas/Desktop/one last /transcript-eval/server/services/slack-notifier.js`:

```js
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
```

- [ ] **Step 2: Syntax-check the file**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/services/slack-notifier.js
```
Expected: no output (exit 0).

- [ ] **Step 3: Smoke test the no-op path (no env var set)**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --input-type=module -e "import('./server/services/slack-notifier.js').then(m => { m.notify({source:'api-log', title:'test'}); console.log('state:', m._internalState()) })"
```
Expected output:
```
state: { queueLength: 0, dropped: 0, draining: false }
```
(No queue push because `SLACK_WEBHOOK_URL` is not set — verifies the no-op guard.)

- [ ] **Step 4: Smoke test with webhook set (dummy URL)**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && SLACK_WEBHOOK_URL=https://127.0.0.1:1/nope node --input-type=module -e "import('./server/services/slack-notifier.js').then(m => { for (let i=0;i<3;i++) m.notify({source:'api-log', title:'t'+i}); console.log('state:', m._internalState()) })"
```
Expected: `state: { queueLength: 3, dropped: 0, draining: true }` — proves the queue accepts pushes and the drain timer starts.

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && git add server/services/slack-notifier.js && git commit -m "feat(alerts): add central Slack notifier with queue + backpressure"
```

---

## Task 2: Add `/api/admin/test-alert` endpoint

**Files:**
- Modify: `server/routes/admin.js`

- [ ] **Step 1: Add the notify import at the top of admin.js**

Edit `/Users/laurynas/Desktop/one last /transcript-eval/server/routes/admin.js`.

Find:
```js
import { activeStreams, streamingFetch } from '../services/api-logger.js'
```
Replace with:
```js
import { activeStreams, streamingFetch } from '../services/api-logger.js'
import { notify } from '../services/slack-notifier.js'
```

- [ ] **Step 2: Add the test endpoint before `export default router`**

Find the bottom of the file (it ends with `export default router`). Immediately **before** that line, insert:

```js
router.post('/test-alert', requireAuth, requireAdmin, (_req, res) => {
  notify({
    source: 'api-log',
    title: 'Test alert from admin endpoint',
    error: 'Synthetic — safe to ignore.',
  })
  res.json({ ok: true })
})
```

- [ ] **Step 3: Syntax-check**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/routes/admin.js
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && git add server/routes/admin.js && git commit -m "feat(alerts): add admin /test-alert endpoint for smoke testing"
```

---

## Task 3: Wire `api-logger.js` (both fetch paths)

**Files:**
- Modify: `server/services/api-logger.js`

**Note:** api-logger is the noisiest source. Every non-2xx + every thrown fetch fires. User opted into firehose — do not add filtering.

- [ ] **Step 1: Add the notify import at the top**

Edit `/Users/laurynas/Desktop/one last /transcript-eval/server/services/api-logger.js`.

Find:
```js
import db from '../db.js'
```
Replace with:
```js
import db from '../db.js'
import { notify } from './slack-notifier.js'
```

- [ ] **Step 2: Add the notify call inside `loggedFetch`**

Find (in `loggedFetch`):
```js
  ).catch(err => console.warn('[api-logger] Failed to log:', err.message))

  if (error && !response) {
    throw new Error(error)
  }

  return response
}
```

Replace with:
```js
  ).catch(err => console.warn('[api-logger] Failed to log:', err.message))

  if (responseStatus >= 400 || error) {
    notify({
      source: 'api-log',
      title: error ? 'Fetch threw' : `HTTP ${responseStatus}`,
      error: error || null,
      meta: {
        method,
        url: url.length > 200 ? url.slice(0, 200) + '…' : url,
        status: responseStatus,
        logSource: logSource || null,
        duration_ms: duration,
      },
    })
  }

  if (error && !response) {
    throw new Error(error)
  }

  return response
}
```

- [ ] **Step 3: Add the notify call inside `streamingFetch`**

Find (in `streamingFetch`, near the end):
```js
  if (errorEvent && !finalResult) {
    const err = new Error(errorEvent.error || JSON.stringify(errorEvent))
    err.apiLogId = apiLogId
    throw err
  }

  return { ...finalResult, events: allEvents, apiLogId }
}
```

Replace with:
```js
  if (errorEvent || (responseStatus && responseStatus >= 400)) {
    notify({
      source: 'api-log',
      title: errorEvent ? 'Stream error' : `HTTP ${responseStatus}`,
      error: errorEvent?.error || null,
      meta: {
        method,
        url: url.length > 200 ? url.slice(0, 200) + '…' : url,
        status: responseStatus,
        logSource: logSource || null,
        duration_ms: duration,
        apiLogId,
      },
    })
  }

  if (errorEvent && !finalResult) {
    const err = new Error(errorEvent.error || JSON.stringify(errorEvent))
    err.apiLogId = apiLogId
    throw err
  }

  return { ...finalResult, events: allEvents, apiLogId }
}
```

- [ ] **Step 4: Syntax-check**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/services/api-logger.js
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && git add server/services/api-logger.js && git commit -m "feat(alerts): fire Slack alert on api-logger non-2xx / thrown fetch"
```

---

## Task 4: Wire `broll.js` — all 7 pipeline-level catch blocks

**Files:**
- Modify: `server/services/broll.js`

All edits follow the same pattern: add a `notify({ source: 'broll-*', ... })` call inside the catch block. Seven distinct catches, each with unique surrounding context.

- [ ] **Step 1: Add the notify import**

Edit `/Users/laurynas/Desktop/one last /transcript-eval/server/services/broll.js`.

Find:
```js
import db from '../db.js'
import { loggedFetch, streamingFetch } from './api-logger.js'
```

Replace with:
```js
import db from '../db.js'
import { loggedFetch, streamingFetch } from './api-logger.js'
import { notify } from './slack-notifier.js'
```

- [ ] **Step 2: Wire the Alt-plan catch (around L1246 — does NOT rethrow)**

Find:
```js
    } catch (err) {
      pipelineAbortControllers.delete(altPipelineId)
      brollPipelineProgress.set(altPipelineId, { ...brollPipelineProgress.get(altPipelineId), status: 'failed', error: err.message })
      setTimeout(() => brollPipelineProgress.delete(altPipelineId), 300_000)
      results.push({ pipelineId: altPipelineId, videoId: altVid.id, videoLabel: altLabel, status: 'failed', error: err.message })
      console.error(`[broll-pipeline] Alt plan for "${altLabel}" failed: ${err.message}`)
    }
```

Replace with:
```js
    } catch (err) {
      pipelineAbortControllers.delete(altPipelineId)
      brollPipelineProgress.set(altPipelineId, { ...brollPipelineProgress.get(altPipelineId), status: 'failed', error: err.message })
      setTimeout(() => brollPipelineProgress.delete(altPipelineId), 300_000)
      results.push({ pipelineId: altPipelineId, videoId: altVid.id, videoLabel: altLabel, status: 'failed', error: err.message })
      console.error(`[broll-pipeline] Alt plan for "${altLabel}" failed: ${err.message}`)
      notify({ source: 'broll-alt-plan', title: 'Alt plan failed', error: err.message, meta: { pipelineId: altPipelineId, videoId: altVid.id, videoLabel: altLabel } })
    }
```

- [ ] **Step 3: Wire the Keywords pipeline catch (around L1403)**

Find:
```js
  } catch (err) {
    pipelineAbortControllers.delete(keywordsPipelineId)
    brollPipelineProgress.set(keywordsPipelineId, { ...brollPipelineProgress.get(keywordsPipelineId), status: 'failed', error: err.message })
    setTimeout(() => brollPipelineProgress.delete(keywordsPipelineId), 300_000)
    console.error(`[broll-pipeline] Keywords failed: ${err.message}`)
    throw err
  }
```

Replace with:
```js
  } catch (err) {
    pipelineAbortControllers.delete(keywordsPipelineId)
    brollPipelineProgress.set(keywordsPipelineId, { ...brollPipelineProgress.get(keywordsPipelineId), status: 'failed', error: err.message })
    setTimeout(() => brollPipelineProgress.delete(keywordsPipelineId), 300_000)
    console.error(`[broll-pipeline] Keywords failed: ${err.message}`)
    notify({ source: 'broll-keywords', title: 'Keywords pipeline failed', error: err.message, meta: { pipelineId: keywordsPipelineId, videoId } })
    throw err
  }
```

- [ ] **Step 4: Wire the Search pipeline catch (around L1681, `[broll-pipeline] B-Roll search failed`)**

Find:
```js
    console.error(`[broll-pipeline] B-Roll search failed: ${err.message}`)
    throw err
  }
}
```

Replace with:
```js
    console.error(`[broll-pipeline] B-Roll search failed: ${err.message}`)
    notify({ source: 'broll-search', title: 'Search pipeline failed', error: err.message, meta: { pipelineId: searchPipelineId, videoId, completedItems } })
    throw err
  }
}
```

- [ ] **Step 5: Wire the keywords-batch catch (around L1854, `[broll-keywords] Failed`)**

Find:
```js
    console.error(`[broll-keywords] Failed: ${err.message}`)
    throw err
  }
}
```

Replace with:
```js
    console.error(`[broll-keywords] Failed: ${err.message}`)
    notify({ source: 'broll-keywords', title: 'Keywords batch failed', error: err.message, meta: { pipelineId } })
    throw err
  }
}
```

- [ ] **Step 6: Wire the search-batch catch (around L2019)**

Find:
```js
    console.error(`[search-batch] Failed: ${err.message}`)
    throw err
  }
}
```

Replace with:
```js
    console.error(`[search-batch] Failed: ${err.message}`)
    notify({ source: 'broll-search-batch', title: 'Search batch failed', error: err.message, meta: { pipelineId } })
    throw err
  }
}
```

- [ ] **Step 7: Wire the Create-strategy catch (around L2543)**

Find:
```js
    console.error(`[broll-pipeline] Create strategy ${pipelineId} failed: ${err.message}`)
    try {
```

Replace with:
```js
    console.error(`[broll-pipeline] Create strategy ${pipelineId} failed: ${err.message}`)
    notify({ source: 'broll-create-strategy', title: 'Create strategy failed', error: err.message, meta: { pipelineId, videoId } })
    try {
```

- [ ] **Step 8: Wire the Create-combined-strategy catch (around L3098)**

Find:
```js
    console.error(`[broll-pipeline] Create combined strategy ${pipelineId} failed: ${err.message}`)
    // Write a failed pipeline-level row so the UI can show the failure
```

Replace with:
```js
    console.error(`[broll-pipeline] Create combined strategy ${pipelineId} failed: ${err.message}`)
    notify({ source: 'broll-create-combined-strategy', title: 'Create combined strategy failed', error: err.message, meta: { pipelineId, videoId } })
    // Write a failed pipeline-level row so the UI can show the failure
```

- [ ] **Step 9: Syntax-check**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/services/broll.js
```
Expected: no output.

- [ ] **Step 10: Verify all 7 notify sites exist**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && grep -c "notify({ source: 'broll-" server/services/broll.js
```
Expected output: `7`

- [ ] **Step 11: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && git add server/services/broll.js && git commit -m "feat(alerts): fire Slack alert on every broll pipeline failure"
```

---

## Task 5: Wire `llm-runner.js` rough-cut catch

**Files:**
- Modify: `server/services/llm-runner.js`

- [ ] **Step 1: Add the notify import**

Edit `/Users/laurynas/Desktop/one last /transcript-eval/server/services/llm-runner.js`.

Find:
```js
import db from '../db.js'
import { scoreOutput } from './scorer.js'
```

Replace with:
```js
import db from '../db.js'
import { scoreOutput } from './scorer.js'
import { notify } from './slack-notifier.js'
```

- [ ] **Step 2: Wire the main rough-cut catch (around L793-797)**

Find:
```js
  } catch (err) {
    runStageProgress.delete(experimentRunId)
    await db.prepare("UPDATE experiment_runs SET status = 'failed', error_message = ? WHERE id = ?").run(err.message || String(err), experimentRunId)
    throw err
  }
}
```

Replace with:
```js
  } catch (err) {
    runStageProgress.delete(experimentRunId)
    await db.prepare("UPDATE experiment_runs SET status = 'failed', error_message = ? WHERE id = ?").run(err.message || String(err), experimentRunId)
    notify({ source: 'rough-cut', title: 'Experiment run failed', error: err.message || String(err), meta: { experimentRunId } })
    throw err
  }
}
```

- [ ] **Step 3: Syntax-check**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/services/llm-runner.js
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && git add server/services/llm-runner.js && git commit -m "feat(alerts): fire Slack alert on rough-cut experiment_runs failure"
```

---

## Task 6: Create the GPU failure poller

**Files:**
- Create: `server/services/gpu-failure-poller.js`

**Why separate from notifier:** GPU runs externally (vast.ai), so the server doesn't see those catches — it has to poll Supabase. Dedupe by `job_id` because the same row might appear in consecutive polls if `updated_at` equals the boundary.

- [ ] **Step 1: Create the file**

Write to `/Users/laurynas/Desktop/one last /transcript-eval/server/services/gpu-failure-poller.js`:

```js
// Polls Supabase broll_jobs for newly-failed rows every 30s and fires
// Slack alerts. GPU work runs externally, so this is our only hook.

import { createClient } from '@supabase/supabase-js'
import { notify } from './slack-notifier.js'

const POLL_INTERVAL_MS = 30_000
const DEDUPE_CAP = 1000

const seenJobIds = new Set()
let lastPollTs = null

export function startGpuFailurePoller() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    console.warn('[gpu-failure-poller] SUPABASE_URL/SUPABASE_SECRET_KEY missing, poller disabled')
    return
  }
  const supabase = createClient(url, key)
  lastPollTs = new Date().toISOString()

  const tick = async () => {
    try {
      const { data, error } = await supabase
        .from('broll_jobs')
        .select('id, error, instance_id, request, updated_at')
        .eq('status', 'failed')
        .gt('updated_at', lastPollTs)
        .order('updated_at', { ascending: true })
        .limit(100)

      if (error) {
        console.warn('[gpu-failure-poller] Supabase query failed:', error.message)
        return
      }

      for (const row of (data || [])) {
        if (seenJobIds.has(row.id)) continue
        seenJobIds.add(row.id)
        if (seenJobIds.size > DEDUPE_CAP) {
          const first = seenJobIds.values().next().value
          seenJobIds.delete(first)
        }
        notify({
          source: 'gpu',
          title: 'GPU job failed',
          error: row.error,
          meta: {
            jobId: row.id,
            instanceId: row.instance_id,
            brief: row.request?.brief || null,
          },
        })
      }

      if (data && data.length > 0) {
        lastPollTs = data[data.length - 1].updated_at
      }
    } catch (err) {
      console.warn('[gpu-failure-poller] Tick failed:', err.message)
    }
  }

  setInterval(tick, POLL_INTERVAL_MS)
  console.log('[gpu-failure-poller] Started (30s interval)')
}
```

- [ ] **Step 2: Syntax-check**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/services/gpu-failure-poller.js
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && git add server/services/gpu-failure-poller.js && git commit -m "feat(alerts): add GPU failure poller for Supabase broll_jobs"
```

---

## Task 7: Start the GPU poller at boot

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Add the import**

Edit `/Users/laurynas/Desktop/one last /transcript-eval/server/index.js`.

Find:
```js
import { attachAuth, hasServerAuthConfig } from './auth.js'
import { initBuckets, isEnabled as storageEnabled } from './services/storage.js'
```

Replace with:
```js
import { attachAuth, hasServerAuthConfig } from './auth.js'
import { initBuckets, isEnabled as storageEnabled } from './services/storage.js'
import { startGpuFailurePoller } from './services/gpu-failure-poller.js'
```

- [ ] **Step 2: Start the poller in `app.listen` callback**

Find:
```js
app.listen(PORT, async () => {
  console.log(`Transcript Eval API running on http://localhost:${PORT}`)
  console.log(`[auth] ${hasServerAuthConfig ? 'Supabase JWT verification enabled' : 'Supabase JWT verification disabled'}`)
  if (storageEnabled()) {
    await initBuckets()
  }
})
```

Replace with:
```js
app.listen(PORT, async () => {
  console.log(`Transcript Eval API running on http://localhost:${PORT}`)
  console.log(`[auth] ${hasServerAuthConfig ? 'Supabase JWT verification enabled' : 'Supabase JWT verification disabled'}`)
  if (storageEnabled()) {
    await initBuckets()
  }
  startGpuFailurePoller()
})
```

- [ ] **Step 3: Syntax-check**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/index.js
```
Expected: no output.

- [ ] **Step 4: Boot the server locally to confirm it starts (without SLACK_WEBHOOK_URL, should no-op)**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && timeout 6 node --env-file=.env server/index.js 2>&1 | grep -E "Transcript Eval|gpu-failure-poller|error|Error" | head -20
```
Expected lines include:
- `Transcript Eval API running on http://localhost:3001`
- `[gpu-failure-poller] Started (30s interval)` (assuming Supabase env vars are set — they are)
- No stack traces / errors

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && git add server/index.js && git commit -m "feat(alerts): start GPU failure poller at server boot"
```

---

## Task 8: Deploy to Railway + end-to-end verification

**Files:** none modified — this is the deploy + smoke-test task.

- [ ] **Step 1: Push the branch**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && git push -u origin HEAD
```
Expected: push succeeds. (Per user feedback memory: **ask user before pushing**. Confirm first if running interactively.)

- [ ] **Step 2: Trigger a Railway redeploy**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && set -a && source .env && set +a && \
  curl -s "https://backboard.railway.app/graphql/v2" \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query":"mutation { serviceInstanceRedeploy(serviceId: \"390e488d-be84-4174-8bb9-01dd7f9d35aa\", environmentId: \"5756287a-d209-44a2-9a3a-6e5faa391f6b\") }"}'
```
Expected response: `{"data":{"serviceInstanceRedeploy":true}}`.

- [ ] **Step 3: Wait for deploy to complete (~60-120s)**

Poll until `/api/health` reports a fresh `deployed` timestamp:
```bash
for i in $(seq 1 30); do
  DEPLOYED=$(curl -s https://backend-production-4b19.up.railway.app/api/health | python3 -c "import json,sys; print(json.load(sys.stdin).get('deployed','?'))" 2>/dev/null)
  echo "[$(date +%H:%M:%S)] deployed: $DEPLOYED"
  sleep 10
done
```
Expected: `deployed` timestamp updates to within the last ~2 minutes.

- [ ] **Step 4: Fire the test endpoint**

Get an admin auth token from the running app (user will provide, or from browser localStorage after logging in as admin). Then:

```bash
ADMIN_JWT=<paste admin JWT>
curl -s -X POST https://backend-production-4b19.up.railway.app/api/admin/test-alert \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json"
```
Expected: `{"ok":true}`.

- [ ] **Step 5: Confirm the message arrived in Slack**

Check the Slack channel the webhook points at. Expect one message:
```
🟡 [prod][api-log] Test alert from admin endpoint
error: Synthetic — safe to ignore.
t: 2026-04-22T…
```

If nothing arrives: check Railway logs for `[slack-notifier]` warnings and verify `SLACK_WEBHOOK_URL` is set in Railway env vars.

- [ ] **Step 6: (Optional) Trigger a real failure to verify wiring**

Kick off a b-roll keywords pipeline with a deliberately bad model name to force a failure. Expect a 🔴 alert in Slack within ~1s of the failure.

- [ ] **Step 7: Rotate the webhook URL**

Now that the webhook URL has been in chat history, regenerate it:
1. Slack app → Incoming Webhooks → **Remove** → **Add New Webhook to Workspace** → pick channel → copy URL
2. Update Railway env var (same variableUpsert GraphQL call as before, with the new URL)
3. Redeploy (Step 2)
4. Re-run Steps 3-5 to confirm the new URL works

---

## Self-Review Notes

- **Spec coverage:**
  - Central notifier module ✓ (Task 1)
  - Queue cap 500 + backpressure summary ✓ (Task 1)
  - 1 msg/sec drain ✓ (Task 1)
  - 3 retries + Retry-After ✓ (Task 1)
  - `[prod]` env tag ✓ (Task 1)
  - `notify()` no-op when webhook unset ✓ (Task 1)
  - Emoji per source ✓ (Task 1)
  - broll.js — 7 call sites ✓ (Task 4, verified with `grep -c`)
  - llm-runner.js — main catch ✓ (Task 5)
  - api-logger.js — both fetches ✓ (Task 3)
  - GPU poller ✓ (Tasks 6+7)
  - Admin test endpoint ✓ (Task 2)
  - Rollout steps (push, redeploy, test) ✓ (Task 8)

- **Per-stage catches inside llm-runner.js:** Spec said to audit these during implementation. They rethrow into the main catch at L795, so they don't need their own notify — main catch fires once with the aggregate error. No changes needed.

- **Placeholder scan:** No TBDs, no "implement later". Line numbers are approximate (noted "around L…") because they may shift; each edit uses unique surrounding text so the Edit tool's exact-match semantics are satisfied regardless of line drift.

- **Type consistency:** `notify({ source, title, error, meta })` used everywhere. No drift.

---

## Rollback Plan

If alerts become unusable (too noisy, Slack rate-limited, etc.):

1. Delete the `SLACK_WEBHOOK_URL` env var in Railway → service → Variables.
2. Redeploy (Step 2 of Task 8).
3. All `notify()` calls now silently no-op. No code changes needed.

If the poller causes Supabase load issues:
1. Revert Task 7 commit (`git revert <hash>`) to disable the poller at boot.
2. Redeploy.
