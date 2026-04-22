# Slack Failure Alerts

## Goal

Fire a Slack message whenever something fails in the transcript-eval backend:
b-roll pipelines, rough-cut (experiment_runs) pipelines, GPU jobs (Supabase
`broll_jobs`), and API-log errors (any non-2xx or thrown fetch error via
`loggedFetch` / `streamingFetch`).

**Signal policy: firehose.** No dedupe, no thresholds, no digests. Every
individual failure event fires exactly one Slack message. (Dedupe only for
GPU poller — see below — to avoid re-firing the same failed row.)

**Environment:** production only. Controlled by presence of
`SLACK_WEBHOOK_URL` env var in Railway. Local dev silently no-ops unless the
var is set.

## Architecture

```
  failure site                                  Slack
  ────────────       ┌──────────────┐          ─────
  broll.js       ─┐                  ┐
  llm-runner.js  ─┼──▶ notify(...)  ─┤ in-memory FIFO queue
  api-logger.js  ─┘                  │       │
                                     │       │ drain @ 1 msg/sec
  broll_jobs poller ──▶ notify(...) ─┘       ▼
                                          POST webhook
                                       (retry ×3, backoff)
```

One central module (`server/services/slack-notifier.js`) exposes a single
`notify({ source, title, error, meta })` function. Call sites push
synchronously; the module drains on a timer.

## New files

### `server/services/slack-notifier.js` (~120 LOC)

Public API:

```js
export function notify({ source, title, error, meta })
```

- `source` (string, required): one of `broll-keywords`, `broll-search`,
  `broll-plan`, `broll-alt-plan`, `broll-create-strategy`,
  `broll-search-batch`, `broll-other`, `rough-cut`, `gpu`, `api-log`.
- `title` (string, required): one-line summary.
- `error` (string|Error, optional): message or Error object. Stack is not
  sent; only `.message` is formatted.
- `meta` (object, optional): flat key/value context (pipelineId, jobId,
  videoId, url, status, logSource). Rendered as `key: value` lines.

Behavior:

- Reads `SLACK_WEBHOOK_URL` at module init. If absent, `notify()` is a no-op.
- Pushes a formatted payload into an in-memory FIFO queue.
- Queue cap: **500**. Overflow drops oldest items. Once drain resumes, emits
  one synthetic message: `⚠️ N alerts dropped (backpressure)`.
- Drain loop: sends one message every **1000 ms** to respect Slack's webhook
  rate limit (~1 msg/sec per webhook).
- Per-message retries: **3 attempts** with exponential backoff (500ms, 1s,
  2s). On final failure, `console.warn` once and drop. Never throw back into
  caller's code path.
- On 429 response: honor `Retry-After` header (requeue at front, wait the
  header value).
- Environment tag: every message prefixed with `[prod]`. (Configurable via
  `SLACK_ENV_TAG` env var — defaults to `prod`.)

Formatter output (example):

```
🔴 [prod][broll-keywords] Pipeline failed
pipelineId: kw-plan-369-1776798461332-1776802676384
videoId: 412
error: Gemini API 500 — Internal error
t: 2026-04-22T14:22:03Z
```

Emoji map:

| Source prefix | Emoji |
|---|---|
| `broll-*` | 🔴 |
| `rough-cut` | 🟠 |
| `gpu` | 🟣 |
| `api-log` | 🟡 |

### `server/services/gpu-failure-poller.js` (~60 LOC)

Polls Supabase `broll_jobs` every **30s** for rows where `status = 'failed'`
AND `updated_at > lastPollTs`. Dedupes by `job_id` in an in-memory Set
(size-capped at 1000, FIFO eviction).

- On server start: initialise `lastPollTs` to `new Date().toISOString()`
  (don't alert for historical failures).
- On each tick: query Supabase, for each new row call `notify({ source:
  'gpu', title: 'GPU job failed', error: row.error, meta: { jobId: row.id,
  instanceId: row.instance_id, brief: row.request?.brief } })`, add `row.id`
  to the dedupe Set, update `lastPollTs`.
- Silently skip if `SUPABASE_URL`/`SUPABASE_SECRET_KEY` missing (same
  existing Supabase-client pattern as `routes/gpu.js`).
- On Supabase error during poll: `console.warn`, don't fire alert (avoid
  alert storms if Supabase is temporarily down).

Edge case: server restart within 30s may miss a failure that happened in the
restart window. Acceptable for a solo-dev tool — documented, not fixed.

## Edited files

### `server/services/broll.js`

Add one `notify()` line immediately before the `throw err` in each of the
following catch blocks. All use `import { notify } from './slack-notifier.js'`.

| Line | Pipeline | Call |
|---|---|---|
| L1248 | Alt-plan | `notify({ source: 'broll-alt-plan', title: 'Alt plan failed', error: err.message, meta: { pipelineId: altPipelineId, videoId: altVid.id, videoLabel: altLabel } })` |
| L1405 | Keywords | `notify({ source: 'broll-keywords', title: 'Keywords pipeline failed', error: err.message, meta: { pipelineId: keywordsPipelineId, videoId } })` |
| L1683 | Search | `notify({ source: 'broll-search', title: 'Search pipeline failed', error: err.message, meta: { pipelineId: searchPipelineId, videoId, completedItems } })` |
| L1856 | Plan | `notify({ source: 'broll-plan', title: 'Plan pipeline failed', error: err.message, meta: { pipelineId } })` |
| L2021 | Search-batch | `notify({ source: 'broll-search-batch', title: 'Search batch failed', error: err.message, meta: { pipelineId } })` |
| L2545 | Create-strategy | `notify({ source: 'broll-create-strategy', title: 'Create strategy failed', error: err.message, meta: { pipelineId, videoId, strategyId } })` |
| L3096 | Plan-prep (or similar — verify during implementation) | `notify({ source: 'broll-other', title: 'Pipeline failed', error: err.message, meta: { pipelineId } })` |

Line numbers are as of 2026-04-22 — re-verify during implementation.

### `server/services/llm-runner.js`

Add `notify()` before the `throw err` at:

- **L795** — main rough-cut `experiment_runs` failure:
  ```js
  notify({ source: 'rough-cut', title: 'Experiment run failed',
           error: err.message, meta: { experimentRunId } })
  ```

During implementation, also audit per-stage catches inside `llm-runner.js`.
Per firehose policy, any catch that swallows an error (doesn't rethrow)
should also fire `notify({ source: 'rough-cut', ... })` with the stage
context. Catches that rethrow into the main catch don't need their own
notify — the main catch will fire once.

### `server/services/api-logger.js`

**In `loggedFetch`:** Immediately before `return response`, check:

```js
if (responseStatus >= 400 || error) {
  notify({
    source: 'api-log',
    title: error ? 'Fetch threw' : `HTTP ${responseStatus}`,
    error: error || null,
    meta: {
      method, url: url.length > 200 ? url.slice(0, 200) + '…' : url,
      status: responseStatus, logSource: logSource || null,
      duration_ms: duration,
    },
  })
}
```

**In `streamingFetch`:** Fire at the same place the existing code decides
whether to throw (around `if (errorEvent && !finalResult)`). Also fire if
`responseStatus >= 400` even when the stream partially succeeded.

**Note on volume:** api-log alerts will be the loudest channel by far. User
explicitly opted into firehose. If volume becomes unusable, later tune with
an exclusion list (e.g. ignore 404s from specific exploratory endpoints).

### `server/index.js`

After `app.listen(...)` callback, start the poller:

```js
import { startGpuFailurePoller } from './services/gpu-failure-poller.js'
startGpuFailurePoller()
```

### `server/routes/admin.js`

Add a test endpoint for post-deploy smoke testing:

```js
router.post('/test-alert', requireAuth, requireAdmin, (_req, res) => {
  notify({
    source: 'api-log', title: 'Test alert from admin endpoint',
    error: 'This is a synthetic test — safe to ignore.',
    meta: { t: new Date().toISOString() },
  })
  res.json({ ok: true })
})
```

Hit it with `curl -X POST https://<railway-url>/api/admin/test-alert -H
"Authorization: Bearer <token>"` after deploy to verify Slack wiring.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `SLACK_WEBHOOK_URL` | yes (prod) | Slack Incoming Webhook URL. If unset, notifier no-ops. |
| `SLACK_ENV_TAG` | no | Prefix for all alerts (default `prod`). |
| `SUPABASE_URL` | already set | Reused for GPU poller. |
| `SUPABASE_SECRET_KEY` | already set | Reused for GPU poller. |

Set `SLACK_WEBHOOK_URL` in Railway → service → Variables. Do not commit it.

## Error-handling rules

1. `notify()` must never throw into a caller's code path. Any internal error
   is caught, `console.warn`ed, and swallowed.
2. Notifier failures do not retry the *caller's* work — they only retry the
   Slack POST (3 attempts).
3. If Slack is down for extended periods, the queue will fill to 500, drop
   oldest, and emit one backpressure summary when drain resumes.
4. GPU poller errors (Supabase unreachable) are logged but do not fire
   alerts — avoids cascade during Supabase outages.

## Testing

- **Unit** (optional, small module): test queue semantics (push/drain/cap)
  with a stub `fetch`.
- **Manual smoke, post-deploy:** hit `/api/admin/test-alert`, verify one
  message arrives in Slack. This is the primary verification.
- **Natural verification:** the next real failure will confirm end-to-end.

No automated integration test against real Slack.

## Rollout

1. Create Slack Incoming Webhook, copy URL.
2. Set `SLACK_WEBHOOK_URL` in Railway → service → Variables.
3. Push branch; Railway auto-deploys (per existing flow).
4. Call `/api/admin/test-alert` → confirm message in Slack.
5. Trigger a known-failure scenario (e.g. run a b-roll pipeline with a bad
   model name) → confirm the failure alert fires.

## Out of scope

- Dedupe, thresholds, digest-mode alerts. (User picked firehose.)
- Persistence across server restarts (queue is in-memory only).
- Alerting on local-dev failures (env-var-gated).
- UI for viewing/muting alerts. (If needed later, upgrade to the
  DB-backed-queue approach from brainstorming Approach 2.)
- Bot-token / refresh-token Slack auth. (Webhook is sufficient; upgrade
  later if threading or multi-channel routing is needed.)
