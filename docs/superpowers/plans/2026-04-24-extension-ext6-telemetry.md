# Ext.6 — Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a one-PR slice — smaller than Ext.5's two-PR queue work. Expect 1–2 days of focused work.

**Goal:** Ship Ext.6 of the transcript-eval Export Helper Chrome extension — wire every queue state transition to `POST /api/export-events` so the backend has a full chronology of every run. Adds a new `extension/modules/telemetry.js` (in-memory ring buffer + `chrome.storage.local` overflow queue + exponential-backoff retry + 500-event hard cap + Bearer-JWT attach + 401-pause-until-refresh), and surgically hooks `extension/modules/queue.js` at the 10 state transitions documented in the extension spec. After Ext.6, the admin observability UI (WebApp.3, deferred) can reconstruct any run from database rows, and the user's `export_events` table fills up in real time during a live export.

**Architecture:** One new small module — `extension/modules/telemetry.js` — owns the buffer, the flush loop, the JWT attach, and the 401 pause flag. It exports a single public surface: `emit(event, payload)` plus a handful of lifecycle helpers (`flushNow`, `pauseForAuthRefresh`, `resumeAfterAuthRefresh`, `getBufferStats` for diagnostics/tests). `modules/queue.js` imports `emit` and calls it at each of the 10 state transitions the extension spec enumerates — pure drop-in side effects, no control-flow changes to the queue. `modules/auth.js` grows one small helper — `attachBearer(headers)` — that reads the current JWT via the existing `getJwt()` and attaches the `Authorization` header; the telemetry module is the first (and for Ext.6, only) caller. The service worker is not restructured; telemetry listens on the same Port-adjacent broadcast pattern the queue already uses, but via a direct import (`import { emit } from './telemetry.js'`), not via the Port.

**Tech Stack:** Chrome MV3 (unchanged), vanilla JS ES modules, `chrome.storage.local` (via a telemetry-owned namespace — does NOT reuse `modules/storage.js` since that file is scoped to run/lock/dedup state; Ext.8's opt-out switch and Ext.9's config consumption will grow their own storage namespaces too), `fetch` (same API the extension uses for `/api/pexels-url` / `/api/freepik-url`), no new build tooling, no new npm packages.

---

## Why read this before touching code

Ext.6 is smaller than Ext.5 but the failure modes are subtler — most bugs will be "events lost silently" rather than "code throws." Skim the invariants before opening any file.

1. **MV3 service workers terminate aggressively — the in-memory ring buffer is LOST on SW termination unless persisted.** Every `emit` call MUST write to `chrome.storage.local` before the fire-and-forget flush begins. Do not rely on "I'll flush before the SW dies" — MV3 gives you no shutdown hook. The ring buffer is an optimization (avoids touching disk when the flush succeeds immediately); the storage-backed overflow queue is the source of truth. Treat any `await` between "I accepted an emit" and "I persisted it" as a place the SW can die — and if it dies, the event is gone. The concrete rule: `emit(event, payload)` synchronously enqueues into the in-memory buffer AND fires off an async persist, and the flush loop reads from storage first (so the buffer is a write-through cache, not a write-back one).

2. **JWT refresh synchronization with flush is load-bearing.** Ext.4's `refreshSessionViaPort()` is the only path that mints a new JWT when the old one 401s. Telemetry POSTs share the same JWT that `/api/pexels-url` and `/api/freepik-url` use — if telemetry 401s while the queue is mid-download, the queue's own 401 handler is already running a refresh. Telemetry MUST NOT race it. The rule: on 401, set `paused_for_auth = true` and STOP the flush loop; when the queue's `refreshSessionViaPort` resolves successfully, `modules/auth.js` notifies telemetry via a callback (the `onSessionRefreshed` hook Ext.6 adds) which sets `paused_for_auth = false` and resumes the flush. Do NOT have telemetry call `refreshSessionViaPort` itself — that would race the queue and could exhaust the 10s Port timeout on both sides.

3. **401 handling must not drop events.** When a 401 comes back from `/api/export-events`, the in-flight event goes BACK to the front of the persisted queue (not the end — its `t` timestamp is older than anything else). Drop-on-overflow only applies when the queue is at the 500-event hard cap AND a new event lands; 401 alone is never a drop trigger.

4. **The event-type enum must not drift from the backend contract.** `server/services/exports.js` currently exports `ALLOWED_EVENTS` as a 10-element `Set`: `export_started`, `item_resolved`, `item_licensed`, `item_downloaded`, `item_failed`, `rate_limit_hit`, `session_expired`, `queue_paused`, `queue_resumed`, `export_completed`. The backend returns a 400 with `unknown event: <value>` on any mismatch — which means a typo in `modules/queue.js`'s emit call would be silently swallowed by the retry loop (the backoff keeps retrying the same 400). Ext.6 adds a client-side constant `TELEMETRY_EVENT_ENUM` in `config.js` whose values are typed from a single source of truth and asserted at emit time — drift is caught at development time, not in production.

5. **`error_code` for `item_failed` comes from a fixed 15-element enum.** The extension spec enumerates: `envato_403`, `envato_402_tier`, `envato_429`, `envato_session_401`, `envato_unavailable`, `envato_unsupported_filetype`, `freepik_404`, `freepik_429`, `freepik_unconfigured`, `pexels_404`, `network_failed`, `disk_failed`, `integrity_failed`, `resolve_failed`, `url_expired_refetch_failed`. Ext.5's queue currently records free-form error strings (e.g. `resolve_failed`, `license_failed`, `download_failed`, `network_failed`, `disk_failed:<reason>`, `cancelled`, `download_interrupt:<reason>`, `network_resume_failed:<msg>`). Ext.6 introduces a mapping function `normalizeErrorCode(rawError)` in `telemetry.js` that maps the queue's raw strings into the 15-code enum; unknown raw strings map to `null` (so the emit still succeeds but the backend gets `error_code: null`, which it accepts). Ext.7's full failure-matrix work will tighten the mapping — Ext.6 just ensures we never emit a 16th code.

6. **`meta` is stringified size-capped at 4 KB server-side.** The backend rejects meta JSON that exceeds 4096 bytes with a 400 ValidationError. Ext.6's `export_started` meta is small (3 integers + a 3-key source breakdown), `export_completed` is small (4 integers), `item_*` are tiny. No runtime risk in Ext.6 — but the client-side emit wraps the serialization in try/catch and drops meta (not the whole event) if it oversizes, logging a warn. This belt-and-braces guard costs one if-statement and prevents a future developer from accidentally shipping a run where 100 events silently retry-loop on 400s.

7. **One Port-broadcast hook site is NOT added.** Unlike Ext.5's `broadcast({type:"state"})` which goes to the web app Port, telemetry events go ONLY to `/api/export-events`. The web app does not see telemetry — it already has the Port `state` push with the full RunState snapshot. Telemetry is for admin observability; Port is for user-facing UI. Keep these channels distinct; Ext.8's diagnostic bundle also does NOT hit the Port.

8. **Every `emit` is fire-and-forget.** The queue's state transitions must not `await` telemetry. If the flush is slow or paused, the queue must keep downloading. The emit function returns synchronously (it schedules persistence via microtask/queueMicrotask; the flush loop is an independent `setInterval`-style loop awoken by fresh events). A botched emit must never stall the queue.

9. **`export_completed` is terminal and MUST fire exactly once per run.** Not on pause. Not on cancel's mid-flight state. ONLY when `queue.finalize()` runs (all items `done`/`failed`, run_state flips to `complete`) OR when `queue.cancelRun()` runs (explicit cancel — backend treats cancel as a terminal state for status derivation). The queue's current `cancelRun` does NOT call any "run ended" hook yet — Ext.6 adds the emit at `cancelRun` too, with `meta.reason: 'cancelled'` so the backend can distinguish clean finish from cancel in a follow-up analysis. `hardStopQueue(reason)` (disk_failed path) also emits `export_completed` with `meta.reason: 'hard_stop'`.

10. **Backend idempotency is NOT a shield.** The `export_events` table has no unique constraint on `(export_id, event, item_id, t)` — two retries of the same event from the client WILL produce two rows. This is acceptable because the backend is an observability sink, not a transaction log; duplicates are rare (only on retry-after-timeout where the server actually succeeded) and do not change derived statuses. But it means Ext.6 MUST NOT do optimistic client-side dedup based on server state — keep it simple: if we wrote it to storage, flush it until the server 2xxs, then remove.

---

## Scope (Ext.6 only — hold the line)

### In scope

- `extension/modules/telemetry.js` — **new**. Owns:
  - `emit(event, payload)` — synchronous accept, async persist, fire-and-forget.
  - In-memory ring buffer (`BUFFER_SIZE` = 50) — fast-path when network is healthy; bypasses storage round-trip on the happy path.
  - `chrome.storage.local.telemetry_queue` — array of `{ event, payload, enqueued_at }` entries. Survives SW termination. Hard cap at 500.
  - Exponential-backoff retry on transient failure (5xx, network down). Base 2s, doubling up to 60s, jitter ±20%.
  - 500-event hard cap with oldest-drop — when enqueue would push past 500, shift the oldest and emit a synthetic `{event:'telemetry_queue_overflow', meta:{dropped: N}}` marker (the marker itself is NOT in the allowed 10-event enum, so it gets normalized to a warning log rather than POSTed — see invariant #4. The counter is preserved in `chrome.storage.local.telemetry_overflow_total` for diagnostics; an Ext.8 bundle reader can surface it).
  - Bearer-JWT attach via `modules/auth.js` — calls `getJwt()` before each POST; if no JWT, the flush is parked until a JWT shows up (same pause mechanism as 401 recovery).
  - Respect 401: set `paused_for_auth = true`, stop flushing, re-enqueue in-flight event to front of queue; resume when `onSessionRefreshed` fires.
  - `pauseForAuthRefresh()` / `resumeAfterAuthRefresh()` — called by auth module when it kicks/finishes a refresh.
- `extension/modules/queue.js` — **modify**. Wire `telemetry.emit(<event>, <payload>)` at each of the 10 state transitions:
  1. `startRun` (after CAS succeeds, before `schedule()` returns) → `export_started` with `meta: {total_items, total_bytes_est, source_breakdown: {envato, pexels, freepik}}`.
  2. `runResolver` success → `item_resolved` with `meta: {resolve_ms}`.
  3. `runLicenser` success → `item_licensed` with `meta: {license_ms}`.
  4. `handleDownloadEvent` `next === 'complete'` → `item_downloaded` with `meta: {bytes, download_ms, filename}`.
  5. `failItem` (called from every failure path) → `item_failed` with `error_code: normalizeErrorCode(item.error_code)`, `meta: {attempts: item.retries, final_http_status: <if available>}`.
  6. `handleDownloadInterrupt` where reason is `NETWORK_` and retries cap hit (or an Envato 429 in license/resolve flows — but that 429 path today throws; Ext.7 formalizes the mapping) → `rate_limit_hit` with `meta: {retry_after_sec}` (0 when not supplied by server; null is acceptable but prefer 0 for schema cleanliness).
  7. Envato `download.data` 401 path (currently throws from `envato.js` which propagates to `failItem`) → `session_expired` fires ONCE per run max (gated by a run-scoped flag on RunState: `session_expired_emitted`). Also fires `item_failed` with `error_code: 'envato_session_401'` for the item itself.
  8. `pauseRun` → `queue_paused` with `meta: {reason: 'user'}`.
  9. `resumeRun` → `queue_resumed`.
  10. `finalize` / `cancelRun` / `hardStopQueue` — all terminal paths → `export_completed` with `meta: {ok_count, fail_count, wall_seconds, total_bytes, reason: 'complete'|'cancelled'|'hard_stop'}` (REQUIRED — backend derives final status from these).
- `extension/modules/auth.js` — **modify**. Add `attachBearer(headers)` helper used by telemetry. The helper is a tiny 4-line function: `const jwt = await getJwt(); if (jwt?.token) headers['Authorization'] = 'Bearer ' + jwt.token; return headers`. Also add a lightweight `onSessionRefreshed(cb)` / `emitSessionRefreshed()` registrar pair — the auth module becomes a single-subscriber hub that telemetry attaches to on module load; `refreshSessionViaPort`'s resolve path calls `emitSessionRefreshed()` after the new JWT has been persisted. Do NOT restructure the existing auth flow beyond these additions. Keep the existing `getJwt` / `setJwt` / `hasValidJwt` / `hasEnvatoSession` / `checkEnvatoSessionLive` / `onEnvatoSessionChange` / `refreshSessionViaPort` exports unchanged.
- `extension/config.js` — **modify**. Bump `EXT_VERSION` to `0.6.0`. Add `TELEMETRY_*` constants:
  - `TELEMETRY_BUFFER_SIZE = 50` (in-memory ring).
  - `TELEMETRY_MAX_QUEUE_SIZE = 500` (storage hard cap).
  - `TELEMETRY_RETRY_BASE_MS = 2000`.
  - `TELEMETRY_RETRY_MAX_MS = 60000`.
  - `TELEMETRY_RETRY_JITTER = 0.2`.
  - `TELEMETRY_FLUSH_INTERVAL_MS = 5000` (the "offline flush interval" the spec names — how often the background loop wakes to re-attempt when parked in an offline/401 state).
  - `TELEMETRY_EVENT_ENUM` = `Object.freeze(['export_started', 'item_resolved', 'item_licensed', 'item_downloaded', 'item_failed', 'rate_limit_hit', 'session_expired', 'queue_paused', 'queue_resumed', 'export_completed'])` — source of truth for the assert.
- `extension/manifest.json` — **modify**. Bump `version` to `0.6.0`. NO new `permissions` (`storage` / `downloads` / `cookies` / `power` etc. already present; `/api/export-events` is same-origin to the `BACKEND_URL` that Ext.3/4 already `fetch` against — no new `host_permissions` either since `fetch` from the SW does not need host_permissions for CORS-enabled endpoints, and the backend's CORS allows the extension via the `chrome-extension://...` origin wildcard Ext.1 wired up).
- `extension/README.md` — **modify**. Append an "Ext.6 — Telemetry" section.
- `extension-test.html` — **modify**. Add an "11. Telemetry (Ext.6)" fieldset with:
  - A "Fire synthetic short run" button that drives a 3-item manifest (1 Pexels, 1 Freepik, 1 failure-via-invalid-id) through the queue and produces a visible chronology of emits.
  - A "Query buffer stats" button that exposes `telemetry.getBufferStats()` via a new `debug_telemetry_stats` SW message.
  - A "Force flush" button (emits a `debug_telemetry_flush` SW message that calls `telemetry.flushNow()`).
  - A "Simulate offline" toggle — documents that Chrome DevTools → Network → Offline is the canonical toggle (the manifest does not grant us a permission to programmatically flip this; the button only flips an in-process `TELEMETRY_DEBUG_FORCE_OFFLINE` flag we read in tests).
- **Verification task (no commit)**: complete a real 3-item run, query the `export_events` table via `psql` (or the existing `/api/admin/*` route if present; otherwise direct SQL) and eyeball the chronology; disconnect network, complete a run offline, reconnect, confirm queued events flush.

### Deferred (DO NOT add to Ext.6 — they belong to later phases)

- **Opt-out switch / diagnostics bundle** → Ext.8. The `modules/telemetry.js` built here does NOT consult an opt-out flag. Ext.8 will add a short-circuit at the top of `emit` that returns early if `telemetry_opt_out === true` in storage; the change is a one-line addition and intentionally NOT scaffolded here to keep this phase small.
- **Per-error retry / deny-list / Freepik TTL refetch** → Ext.7. The retry policy in Ext.6 is uniform exponential backoff on ANY non-2xx-non-401 response. Per-error branching (e.g. 402 tier_restricted → skip, 429 Retry-After honoring) lives in Ext.7's failure-matrix work.
- **`/api/ext-config` consumption / kill switch** → Ext.9. Ext.6's telemetry flushes as long as the user has a JWT and the endpoint responds. Ext.9 will add a check against `ext-config.telemetry_enabled` (or similar) that lets us turn off telemetry without republishing.
- **CI packaging / Web Store work** → Ext.10–12.
- **Telemetry admin UI** (`/admin/exports`) — WebApp.3, independent of extension work. Ext.6's backend rows are readable today via direct SQL; the UI will read the same rows.

Fight the urge to "just add" any of the above. The telemetry module is deliberately small (~250 LOC) and the deferred items are their own PR-sized concerns.

---

## Prerequisites

- **Ext.1 + Ext.2 + Ext.3 + Ext.4 + Ext.5 merged.** As of 2026-04-24 `main`, all five have landed (see `git log --oneline -10` — the merge of `feature/extension-ext5-queue-persistence` is at `aedf14d`). Ext.6 branches from `main`.
- Ext.6 depends on:
  - `modules/queue.js` with its 10 state transitions in place (Ext.5). The emit call sites map 1:1 onto state transitions the queue already computes — Ext.6 adds zero control-flow changes to the queue.
  - `modules/auth.js` with `getJwt()` and `refreshSessionViaPort()` (Ext.4). Ext.6 adds `attachBearer` and `onSessionRefreshed` to this module.
  - Backend `/api/export-events` endpoint accepting Bearer JWT (Phase 1 backend, already shipped — see `server/routes/exports.js` exporting `exportEventsRouter` via `requireExtAuth`).
- Chrome 120+ (unchanged).
- Node 20+ (unchanged — for the `node --check` syntax verification steps).
- **A valid extension JWT must be mintable.** For the verification task: use the test harness's fieldset 2 "Mint & store JWT" button which calls `/api/session-token` via `requireAuth` (cookie auth from transcript-eval session). Ensure you are signed in to transcript-eval in the same Chrome profile before starting the verification step.

Path to the repo has a trailing space in `"one last "` — quote every path.

---

## File structure (Ext.6 final state)

Additions over Ext.5 are marked `[NEW Ext.6]`; modifications are `[MOD Ext.6]`; unchanged earlier files are shown without annotation for context.

```
$TE/extension/
├── manifest.json                  [MOD Ext.6] version 0.5.0 → 0.6.0 (no permissions change)
├── service_worker.js              [MOD Ext.6] add two debug handlers: debug_telemetry_stats, debug_telemetry_flush; add module-top-level import of telemetry.js so its flush loop starts at SW boot
├── config.js                      [MOD Ext.6] +TELEMETRY_BUFFER_SIZE, TELEMETRY_MAX_QUEUE_SIZE, TELEMETRY_RETRY_BASE_MS, TELEMETRY_RETRY_MAX_MS, TELEMETRY_RETRY_JITTER, TELEMETRY_FLUSH_INTERVAL_MS, TELEMETRY_EVENT_ENUM; EXT_VERSION bump
├── popup.html                     (unchanged)
├── popup.css                      (unchanged)
├── popup.js                       (unchanged)
├── .extension-id                  (unchanged)
├── README.md                      [MOD Ext.6] append "Ext.6 — Telemetry" section
├── modules/
│   ├── auth.js                    [MOD Ext.6] +attachBearer(headers), +onSessionRefreshed(cb), +emitSessionRefreshed() — called from refreshSessionViaPort's success path
│   ├── envato.js                  (unchanged — Ext.6 does not restructure the 3-phase flow; telemetry emits from queue.js side-effect-only)
│   ├── sources.js                 (unchanged — same reason)
│   ├── port.js                    (unchanged)
│   ├── queue.js                   [MOD Ext.6] 10 telemetry.emit() call sites wired at the existing state transitions; +runStartMs / +itemStartMs / +lastActionStartMs bookkeeping to produce resolve_ms / license_ms / download_ms / wall_seconds meta
│   ├── storage.js                 (unchanged — telemetry owns its own storage namespace to avoid mixing run/lock concerns with observability)
│   └── telemetry.js               [NEW Ext.6] emit, ring buffer, storage overflow queue, exponential-backoff retry loop, JWT attach, 401-pause, normalizeErrorCode, TELEMETRY_EVENT_ENUM assert
├── scripts/
│   └── generate-key.mjs           (unchanged)
└── fixtures/
    └── envato/                    (unchanged)

$TE/extension-test.html            [MOD Ext.6] new fieldset "11. Telemetry (Ext.6)": fire-synthetic-run button, buffer-stats button, force-flush button, offline-mode documentation
```

Why this split:
- `modules/telemetry.js` is a new module so Ext.8's opt-out switch, diagnostic bundle, and Ext.9's kill-switch all have a single file to extend. Forcing telemetry into an existing file would blur scope.
- `auth.js`'s two new helpers (`attachBearer`, `onSessionRefreshed`) are additive and tiny — adding them to a fresh file would create a new "auth-helpers.js" with two functions, which is worse.
- `config.js` is the single source of truth for tunable constants; putting the enum there keeps the "can't drift from backend" assertion local to one file.
- `queue.js` gets ONLY emit calls. No structural changes. The mapping from transitions to events is 1:1 and auditable by grep.
- `storage.js` stays out of this plan — mixing observability events with run/lock state is a maintenance hazard.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/extension-ext6` on branch `feature/extension-ext6-telemetry`. Branch from local `main`. Task 0 creates the worktree and the scaffold commit (empty `telemetry.js` shell + this plan file checked in).
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan. Task 9 has an explicit "DO NOT push" reminder.
- **Never kill anything on port 3001.** User's backend dev server.
- **Commit style:** conventional commits (`feat(ext): …`, `chore(ext): …`, `docs(ext): …`, `refactor(ext): …`, `test(ext): …`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing in every shell call.
- **One commit per Task.** Tasks 0, 1, 2, 3, 4, 5, 6, 7, 8 each produce exactly one commit. Task 9 (manual verification) produces NONE. Task 10 is the README and produces one commit.
- **Event-enum drift check.** Before committing Task 4 (queue.js wire-up), run `grep -c "telemetry.emit" extension/modules/queue.js` and confirm the count matches the number of state transitions you touched (target: 10 logical sites; some sites may fire two events — e.g. `session_expired` + `item_failed` at the same transition — so the grep count may be 11–12). If the count is 9 or fewer, a transition was missed.
- **Fire-and-forget discipline.** In `queue.js`, telemetry emit calls are NOT `await`ed. The call looks like `telemetry.emit('item_resolved', {...})` — the function returns synchronously and schedules the persist on a microtask. If you find yourself `await`ing inside the queue, back up and re-read invariant #8.

---

## Task 0: Create worktree + branch + scaffold commit

**Files:**
- Create: `$TE/.worktrees/extension-ext6/` (worktree)
- Create: `extension/modules/telemetry.js` (empty shell — module with `export function emit(){}` stub so Task 2+ can iterate)
- Create: `docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md` (this file — it belongs on the branch so the plan travels with the code)

This mirrors Ext.5's Task 0 convention: the worktree + branch + checked-in plan + empty module shell all land in one scaffold commit so subsequent tasks have a clean parent to diff against.

- [ ] **Step 1: Create the worktree**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git status
# Expected: "On branch main, nothing to commit"
git log --oneline -5
# Expected: most recent commit is the Ext.5 merge (aedf14d or later)
git worktree add -b feature/extension-ext6-telemetry .worktrees/extension-ext6 main
```

- [ ] **Step 2: Enter the worktree and verify Ext.5 state is inherited**

```bash
cd "$TE/.worktrees/extension-ext6"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext6
git branch --show-current
# Expected: feature/extension-ext6-telemetry
ls extension/modules/
# Expected: auth.js envato.js port.js queue.js sources.js storage.js
# NOT expected yet: telemetry.js (this plan's addition)
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions)"
# Expected: version: 0.5.0 | permissions: [ 'storage', 'tabs', 'webNavigation', 'downloads', 'cookies', 'power' ]
```

If the version or permissions differ, Ext.5 didn't land as expected — stop and reconcile before proceeding.

- [ ] **Step 3: Create the empty `modules/telemetry.js` shell**

Use Write with the following content (the shell compiles, exports the public surface stubs, and includes the invariants block from the plan header so the implementer sees it when opening the file):

```js
// Ext.6 telemetry — /api/export-events emitter with offline queue +
// exponential-backoff retry.
//
// This module is the singleton owner of the telemetry buffer + flush
// loop. MV3 SW termination means the in-memory ring buffer is LOST on
// shutdown unless persisted — Task 2 wires the persist path; Task 3
// wires the flush loop + retry.
//
// Public API:
//   emit(event, payload)            — fire-and-forget; returns void
//   flushNow()                      — debug/test helper; forces one
//                                     flush attempt immediately
//   pauseForAuthRefresh()           — auth.js calls this on 401
//   resumeAfterAuthRefresh()        — auth.js calls this after refresh
//   getBufferStats()                — {buffer_size, queue_size,
//                                     paused_for_auth, overflow_total}
//
// See docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md
// for the full "Why read this before touching code" invariants — do
// not ship changes to this file without re-reading them.

export function emit(_event, _payload) {
  // Task 2 fills this in.
}

export async function flushNow() {
  // Task 3 fills this in.
}

export function pauseForAuthRefresh() {
  // Task 3 fills this in.
}

export function resumeAfterAuthRefresh() {
  // Task 3 fills this in.
}

export function getBufferStats() {
  // Task 3 fills this in.
  return { buffer_size: 0, queue_size: 0, paused_for_auth: false, overflow_total: 0 }
}
```

- [ ] **Step 4: Write this plan file into `docs/superpowers/plans/`**

The plan file already exists at the canonical path (it's this very file). Confirm it is present in the worktree via:

```bash
ls "docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md"
# Expected: the path echoes (plan file is committed on main already; worktree inherits).
```

If the plan file is NOT present on `main`, stop — the user's planning step hasn't merged the plan to `main`. Do not author it here; the plan is the caller's deliverable, not this task's.

- [ ] **Step 5: Verify `telemetry.js` parses**

```bash
node --check extension/modules/telemetry.js
# Expected: exit 0
```

- [ ] **Step 6: Commit**

```bash
git add extension/modules/telemetry.js
git commit -m "$(cat <<'EOF'
chore(ext): Ext.6 scaffold — empty telemetry.js module shell

Creates the branch's scaffold commit: an empty modules/telemetry.js
with the public surface stubbed (emit / flushNow / pauseForAuthRefresh
/ resumeAfterAuthRefresh / getBufferStats) and the "see plan for
invariants" pointer at the top of the file. Subsequent tasks fill in
the module in stages:

- Task 1: manifest + config constants.
- Task 2: ring buffer + chrome.storage.local persistence.
- Task 3: flush loop + exponential-backoff retry + JWT attach + 401.
- Task 4: wire 10 emit call sites in modules/queue.js.
- Task 5: auth.js attachBearer + onSessionRefreshed hooks.
- Task 6: service_worker.js debug handlers + module import.
- Task 7: extension-test.html fieldset for manual verification.
- Task 8: normalizeErrorCode mapping.
- Task 9: manual verification (no commit).
- Task 10: README.

Plan file already committed on main via the planning slot; it lives
at docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: Manifest bump + config constants

Manifest change is a one-line version bump; the interesting work is the `config.js` additions that become the source of truth for every telemetry tunable. Doing these together keeps the "version bump ↔ new feature surface" coupling in one commit.

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/config.js`

- [ ] **Step 1: Bump manifest `version`**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext6"
cat extension/manifest.json
```

Use Edit on `extension/manifest.json`:
- `old_string`: `"version": "0.5.0"`
- `new_string`: `"version": "0.6.0"`

NO permissions change. Verify:

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log(m.version, m.permissions)"
# Expected: 0.6.0 [ 'storage', 'tabs', 'webNavigation', 'downloads', 'cookies', 'power' ]
```

- [ ] **Step 2: Bump `EXT_VERSION` in `config.js`**

Use Edit:
- `old_string`: `export const EXT_VERSION = '0.5.0'`
- `new_string`: `export const EXT_VERSION = '0.6.0'`

- [ ] **Step 3: Append the TELEMETRY_* constants block**

Append AFTER the existing `FREEPIK_URL_GRACE_MS = 60000` line (currently the last line of `config.js`):

```js

// -------- Ext.6 telemetry --------
//
// Source of truth for every tunable the telemetry module reads. If you
// find yourself adding a magic number inside modules/telemetry.js,
// back up and add it here instead — Ext.8's opt-out switch and Ext.9's
// kill switch both need to inspect these constants from other modules.

// In-memory ring buffer size. The happy-path fast-path: successful
// emits land here and flush in a single 202 round-trip. Overflow into
// chrome.storage.local only when the flush loop is behind or paused.
export const TELEMETRY_BUFFER_SIZE = 50

// Hard cap on the persisted overflow queue. Beyond this, oldest
// events are dropped and an overflow counter is incremented. Per
// spec: 500.
export const TELEMETRY_MAX_QUEUE_SIZE = 500

// Exponential-backoff retry on transient failure (5xx / network /
// timeout). Starts at BASE_MS, doubles up to MAX_MS, with jitter of
// ±JITTER (fraction of the current wait).
export const TELEMETRY_RETRY_BASE_MS = 2000
export const TELEMETRY_RETRY_MAX_MS = 60000
export const TELEMETRY_RETRY_JITTER = 0.2

// Offline flush interval: how often the background loop wakes to
// re-attempt a flush when parked in an offline / 401 / no-JWT state.
// On successful flush we drain eagerly until the queue is empty.
export const TELEMETRY_FLUSH_INTERVAL_MS = 5000

// Allowed event names. Single source of truth for the client-side
// assertion that prevents drift from the backend's ALLOWED_EVENTS set
// in server/services/exports.js. Any emit with an unlisted `event`
// logs a warn and is dropped (see telemetry.js for the assert). If you
// need a new event, add it here AND to server/services/exports.js in
// the same commit — they MUST match.
export const TELEMETRY_EVENT_ENUM = Object.freeze([
  'export_started',
  'item_resolved',
  'item_licensed',
  'item_downloaded',
  'item_failed',
  'rate_limit_hit',
  'session_expired',
  'queue_paused',
  'queue_resumed',
  'export_completed',
])
```

- [ ] **Step 4: Verify `config.js` still parses and the new exports are present**

```bash
node --check extension/config.js
# Expected: exit 0
node -e "import('./extension/config.js').then(m => {
  const want = ['TELEMETRY_BUFFER_SIZE','TELEMETRY_MAX_QUEUE_SIZE','TELEMETRY_RETRY_BASE_MS','TELEMETRY_RETRY_MAX_MS','TELEMETRY_RETRY_JITTER','TELEMETRY_FLUSH_INTERVAL_MS','TELEMETRY_EVENT_ENUM']
  for (const k of want) {
    if (m[k] == null) { console.error('MISSING', k); process.exit(1) }
  }
  console.log('ok, EXT_VERSION=', m.EXT_VERSION, 'enum len=', m.TELEMETRY_EVENT_ENUM.length)
})"
# Expected: ok, EXT_VERSION= 0.6.0 enum len= 10
```

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/config.js
git commit -m "$(cat <<'EOF'
feat(ext): manifest + config — Ext.6 telemetry tunables (v0.6.0)

Bumps manifest.json version 0.5.0 → 0.6.0. No permission changes —
POST /api/export-events is same-origin to the BACKEND_URL the extension
already fetches against, and CORS is wired up Ext.1-side.

config.js additions:
- TELEMETRY_BUFFER_SIZE           = 50
- TELEMETRY_MAX_QUEUE_SIZE        = 500 (spec hard cap)
- TELEMETRY_RETRY_BASE_MS         = 2000
- TELEMETRY_RETRY_MAX_MS          = 60000
- TELEMETRY_RETRY_JITTER          = 0.2
- TELEMETRY_FLUSH_INTERVAL_MS     = 5000
- TELEMETRY_EVENT_ENUM            = frozen 10-element array

The enum is the client-side source of truth for the drift check
(telemetry.js asserts emit.event is a member). It MUST match the
backend's ALLOWED_EVENTS set in server/services/exports.js — if a
future event is added, BOTH files get edited in the same commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `telemetry.js` — ring buffer + chrome.storage.local persistence

First pass at the module. Implements `emit(event, payload)` with a synchronous accept, an in-memory ring buffer (fast path), and persistence to `chrome.storage.local.telemetry_queue` (durable path). No flush loop yet — that lands in Task 3.

**Files:**
- Modify: `extension/modules/telemetry.js`

- [ ] **Step 1: Replace the stub with the ring-buffer + persistence implementation**

Use Write to fully replace `extension/modules/telemetry.js`:

```js
// Ext.6 telemetry — /api/export-events emitter with offline queue +
// exponential-backoff retry.
//
// This module is the singleton owner of the telemetry buffer + flush
// loop. MV3 SW termination means the in-memory ring buffer is LOST on
// shutdown unless persisted — we use storage as the source of truth
// and treat the in-memory buffer as a write-through cache.
//
// Public API:
//   emit(event, payload)          — fire-and-forget; synchronous accept
//   flushNow()                    — force one flush attempt (Task 3)
//   pauseForAuthRefresh()         — auth.js calls on 401 (Task 3)
//   resumeAfterAuthRefresh()      — auth.js calls after refresh (Task 3)
//   getBufferStats()              — {buffer_size, queue_size,
//                                   paused_for_auth, overflow_total}
//
// See docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md
// for the full invariants — specifically:
//   #1  MV3 SW termination means persist-before-flush
//   #4  TELEMETRY_EVENT_ENUM client-side drift assert
//   #6  meta size cap (4 KB server-side; client belt-and-braces)
//   #8  emit is fire-and-forget

import {
  TELEMETRY_BUFFER_SIZE,
  TELEMETRY_MAX_QUEUE_SIZE,
  TELEMETRY_EVENT_ENUM,
} from '../config.js'

const STORAGE_KEY_QUEUE = 'telemetry_queue'
const STORAGE_KEY_OVERFLOW_TOTAL = 'telemetry_overflow_total'
const META_SOFT_CAP_BYTES = 4096

// In-memory ring buffer. Writes are the happy-path fast lane; the
// flush loop drains both the ring AND the persisted queue, unifying
// them before POSTing.
const ring = []

// Drift-check allowed-event set, derived once.
const ALLOWED = new Set(TELEMETRY_EVENT_ENUM)

// ------------------- Public API -------------------

export function emit(event, payload) {
  // Invariant #4: drift assert. Unknown events are dropped with a
  // warn, not thrown — a typo here must not crash the queue worker.
  if (!ALLOWED.has(event)) {
    console.warn('[telemetry] unknown event dropped:', event)
    return
  }
  const entry = buildEntry(event, payload)
  if (entry == null) return  // buildEntry rejected (e.g. missing export_id)

  // Ring buffer: fast path. If the ring is full, shift the oldest into
  // persistence before appending the new one.
  if (ring.length >= TELEMETRY_BUFFER_SIZE) {
    const shifted = ring.shift()
    persistAppend(shifted).catch(err => {
      console.warn('[telemetry] persist on ring shift failed', err)
    })
  }
  ring.push(entry)

  // Fire-and-forget persist. Even happy-path events are persisted so a
  // SW termination between ring enqueue and flush-success doesn't lose
  // them. The flush loop dedupes ring+persisted before POSTing.
  persistAppend(entry).catch(err => {
    console.warn('[telemetry] persistAppend failed', err)
  })
}

export async function flushNow() {
  // Task 3 fills this in.
}

export function pauseForAuthRefresh() {
  // Task 3 fills this in.
}

export function resumeAfterAuthRefresh() {
  // Task 3 fills this in.
}

export async function getBufferStats() {
  const { [STORAGE_KEY_QUEUE]: queue, [STORAGE_KEY_OVERFLOW_TOTAL]: overflow } =
    await chrome.storage.local.get([STORAGE_KEY_QUEUE, STORAGE_KEY_OVERFLOW_TOTAL])
  return {
    buffer_size: ring.length,
    queue_size: Array.isArray(queue) ? queue.length : 0,
    paused_for_auth: false, // Task 3 wires this up
    overflow_total: overflow || 0,
  }
}

// ------------------- Internals -------------------

function buildEntry(event, payload) {
  const p = payload || {}
  if (!p.export_id || typeof p.export_id !== 'string') {
    console.warn('[telemetry] dropping event with no export_id:', event, p)
    return null
  }
  // Shape per extension spec § "Request/response shapes".
  const entry = {
    export_id:   p.export_id,
    event,
    t:           typeof p.t === 'number' ? p.t : Date.now(),
  }
  if (p.item_id != null)     entry.item_id     = String(p.item_id)
  if (p.source != null)      entry.source      = p.source
  if (p.phase != null)       entry.phase       = p.phase
  if (p.error_code != null)  entry.error_code  = p.error_code
  if (p.http_status != null) entry.http_status = p.http_status
  if (p.retry_count != null) entry.retry_count = p.retry_count
  if (p.meta != null) {
    // Invariant #6 belt-and-braces: server rejects >4 KB meta with a
    // 400; that would loop the retry. Drop oversized meta with a warn
    // but keep the event — the backend accepts meta: null.
    try {
      const serialized = JSON.stringify(p.meta)
      if (new Blob([serialized]).size > META_SOFT_CAP_BYTES) {
        console.warn('[telemetry] meta too large, dropping from event:', event)
      } else {
        entry.meta = p.meta
      }
    } catch (err) {
      console.warn('[telemetry] meta not serializable, dropping:', err)
    }
  }
  return entry
}

async function persistAppend(entry) {
  const { [STORAGE_KEY_QUEUE]: existing } = await chrome.storage.local.get(STORAGE_KEY_QUEUE)
  const queue = Array.isArray(existing) ? existing : []

  // Hard cap with oldest-drop (spec: 500).
  let droppedThisCall = 0
  while (queue.length >= TELEMETRY_MAX_QUEUE_SIZE) {
    queue.shift()
    droppedThisCall++
  }
  queue.push(entry)

  const updates = { [STORAGE_KEY_QUEUE]: queue }
  if (droppedThisCall > 0) {
    const { [STORAGE_KEY_OVERFLOW_TOTAL]: prev } = await chrome.storage.local.get(STORAGE_KEY_OVERFLOW_TOTAL)
    updates[STORAGE_KEY_OVERFLOW_TOTAL] = (prev || 0) + droppedThisCall
    console.warn('[telemetry] queue overflow — dropped', droppedThisCall, 'oldest events')
  }
  await chrome.storage.local.set(updates)
}

// Exposed for Task 3's flush loop — reads the full persisted queue so
// the flush can drain in-order.
export async function _readPersistedQueue() {
  const { [STORAGE_KEY_QUEUE]: existing } = await chrome.storage.local.get(STORAGE_KEY_QUEUE)
  return Array.isArray(existing) ? existing : []
}

// Exposed for Task 3's flush loop — removes N events from the front
// after a successful 202 batch.
export async function _dropFromFrontOfQueue(count) {
  if (count <= 0) return
  const { [STORAGE_KEY_QUEUE]: existing } = await chrome.storage.local.get(STORAGE_KEY_QUEUE)
  const queue = Array.isArray(existing) ? existing : []
  queue.splice(0, count)
  await chrome.storage.local.set({ [STORAGE_KEY_QUEUE]: queue })
}

// Exposed for Task 3 — re-enqueue at the FRONT (used on 401 when the
// in-flight event goes back so it flushes first after refresh).
export async function _unshiftToQueue(entry) {
  const { [STORAGE_KEY_QUEUE]: existing } = await chrome.storage.local.get(STORAGE_KEY_QUEUE)
  const queue = Array.isArray(existing) ? existing : []
  queue.unshift(entry)
  await chrome.storage.local.set({ [STORAGE_KEY_QUEUE]: queue })
}
```

- [ ] **Step 2: Verify parse + shape**

```bash
node --check extension/modules/telemetry.js
# Expected: exit 0
node -e "import('./extension/modules/telemetry.js').then(m => console.log(Object.keys(m).sort()))"
# Expected: an array including 'emit', 'flushNow', 'getBufferStats', 'pauseForAuthRefresh', 'resumeAfterAuthRefresh', '_readPersistedQueue', '_dropFromFrontOfQueue', '_unshiftToQueue'
```

- [ ] **Step 3: Smoke the ring + persistence via a throwaway harness**

```bash
node -e "
  // Stand in for chrome.storage.local so the import doesn't crash.
  globalThis.chrome = {
    storage: { local: {
      _store: {},
      get(keys) {
        if (typeof keys === 'string') { const k=keys; return Promise.resolve({[k]: this._store[k]}) }
        const out = {}; for (const k of keys || []) out[k] = this._store[k]; return Promise.resolve(out)
      },
      set(o) { Object.assign(this._store, o); return Promise.resolve() },
    } },
  }
  const m = await import('./extension/modules/telemetry.js')
  m.emit('export_started', { export_id: 'exp_1', t: 1 })
  m.emit('item_downloaded', { export_id: 'exp_1', item_id: 'abc', t: 2 })
  m.emit('bogus_event', { export_id: 'exp_1', t: 3 })  // should warn + drop
  await new Promise(r => setTimeout(r, 50))
  console.log('stats:', await m.getBufferStats())
" 2>&1
# Expected output approximately:
#   [telemetry] unknown event dropped: bogus_event
#   stats: { buffer_size: 2, queue_size: 2, paused_for_auth: false, overflow_total: 0 }
```

If `bogus_event` is NOT dropped, the enum assert is broken — re-check the `ALLOWED` set import.

- [ ] **Step 4: Commit**

```bash
git add extension/modules/telemetry.js
git commit -m "$(cat <<'EOF'
feat(ext): telemetry — ring buffer + chrome.storage.local persistence

Implements the synchronous-accept, async-persist side of the
telemetry module. No flush loop yet (Task 3). Every emit() call:

1. Validates event against TELEMETRY_EVENT_ENUM (drift assert drops
   unknown events with a warn; does not throw).
2. Requires export_id (drops with a warn if missing).
3. Soft-caps meta at 4 KB (drops meta, keeps event, on oversize).
4. Writes to the in-memory ring buffer (fast path; fixed size 50).
5. Fire-and-forget persists to chrome.storage.local.telemetry_queue
   (durable path; hard-capped at 500; oldest-drop on overflow with
   telemetry_overflow_total counter for Ext.8 bundle readers).

Exposes _readPersistedQueue / _dropFromFrontOfQueue / _unshiftToQueue
for Task 3's flush loop. The underscore prefix marks them internal —
they are not part of the public API.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `telemetry.js` — flush loop + exponential-backoff retry + JWT attach + 401 pause

Second pass at the module. Adds the flush loop that drains persisted events to `POST /api/export-events`, exponential-backoff retry on transient failure, Bearer JWT attach via auth helper, and the 401 pause / resume semantics tied to `onSessionRefreshed`.

**Files:**
- Modify: `extension/modules/telemetry.js`

- [ ] **Step 1: Extend the imports**

At the top of `telemetry.js`, extend the import from `../config.js`:

```js
import {
  TELEMETRY_BUFFER_SIZE,
  TELEMETRY_MAX_QUEUE_SIZE,
  TELEMETRY_EVENT_ENUM,
  TELEMETRY_RETRY_BASE_MS,
  TELEMETRY_RETRY_MAX_MS,
  TELEMETRY_RETRY_JITTER,
  TELEMETRY_FLUSH_INTERVAL_MS,
  BACKEND_URL,
} from '../config.js'
```

Add a new import for auth (below the config import):

```js
import { attachBearer, onSessionRefreshed } from './auth.js'
```

(`attachBearer` and `onSessionRefreshed` are added by Task 5. This import will fail `node --check` until Task 5 lands — Task 3 can still be committed because the test-bed for Task 3 is the actual extension runtime, which will see both modules. Alternative: land Task 5 first — but the queue-side rationale in the plan sequences Task 4 after Task 3, and Task 4 depends on Task 3's flush loop being implementation-shaped, so keep this order and accept the transient import failure until Task 5.)

Rationale: this is a known documented "the plan is in-flight, two commits straddle the dependency" pattern. Ext.5's Task 5 had a similar transient. If this bothers you, swap Tasks 3 and 5 — the only cost is that Task 3's flush loop has to stub `attachBearer` as a local `async function attachBearer(h) { return h }` that Task 5 replaces.

- [ ] **Step 2: Add the flush state and loop**

Append to `telemetry.js` (after the existing `_unshiftToQueue` helper):

```js
// ------------------- Flush loop -------------------

// State for the flush loop. All module-scoped so SW restarts reset
// (we rely on persistence for correctness, not flush-loop state).
let pausedForAuth = false
let flushInFlight = false
let nextBackoffMs = TELEMETRY_RETRY_BASE_MS
let flushIntervalHandle = null

// Kick a background loop that tries to flush every
// TELEMETRY_FLUSH_INTERVAL_MS. The loop is a no-op when the persisted
// queue is empty. When there's work to do, we drain eagerly until
// empty or until a failure pauses us.
function ensureFlushLoopRunning() {
  if (flushIntervalHandle != null) return
  flushIntervalHandle = setInterval(() => {
    flushNow().catch(err => {
      console.warn('[telemetry] flush loop error', err)
    })
  }, TELEMETRY_FLUSH_INTERVAL_MS)
}

// Stop the loop — used only in tests to prevent timers leaking.
// Unused in the real SW (the SW terminates and restarts, which
// naturally clears the interval).
function stopFlushLoop() {
  if (flushIntervalHandle != null) {
    clearInterval(flushIntervalHandle)
    flushIntervalHandle = null
  }
}

export async function flushNow() {
  if (flushInFlight) return
  if (pausedForAuth) return
  flushInFlight = true
  try {
    const queue = await _readPersistedQueue()
    if (queue.length === 0) return
    // Drain eagerly: pop a batch, POST, repeat until empty or failure.
    // We POST one event per request per the spec's schema (the endpoint
    // accepts a single event; no bulk shape defined). Concurrency: 1.
    while (queue.length > 0) {
      if (pausedForAuth) return
      const entry = queue[0]
      const result = await postSingleEvent(entry)
      if (result.ok) {
        await _dropFromFrontOfQueue(1)
        queue.shift()
        nextBackoffMs = TELEMETRY_RETRY_BASE_MS
      } else if (result.pauseForAuth) {
        // 401 — leave the entry at the front, set the pause flag. The
        // auth-refreshed callback resumes us.
        pausedForAuth = true
        console.warn('[telemetry] paused for auth refresh')
        return
      } else if (result.dropEvent) {
        // 400 from the backend — the event shape is wrong. Drop it
        // rather than loop forever on a permanent failure. This is a
        // DEVELOPMENT bug signal, not a production one (the enum
        // check in emit() should prevent 400s in production).
        console.warn('[telemetry] dropping bad event after 400:', entry, result.detail)
        await _dropFromFrontOfQueue(1)
        queue.shift()
      } else {
        // Transient (5xx / network / timeout). Back off and return —
        // the flush loop's next tick retries.
        await sleep(jittered(nextBackoffMs))
        nextBackoffMs = Math.min(nextBackoffMs * 2, TELEMETRY_RETRY_MAX_MS)
        return
      }
    }
  } finally {
    flushInFlight = false
  }
}

async function postSingleEvent(entry) {
  const headers = { 'Content-Type': 'application/json' }
  try {
    await attachBearer(headers)
  } catch (err) {
    // No JWT — treat as "pause for auth" so the loop sleeps until
    // auth comes back. Same code path as 401.
    return { ok: false, pauseForAuth: true, detail: 'no_jwt' }
  }
  if (!headers['Authorization']) {
    return { ok: false, pauseForAuth: true, detail: 'no_jwt' }
  }
  let resp
  try {
    resp = await fetch(BACKEND_URL + '/api/export-events', {
      method: 'POST',
      headers,
      body: JSON.stringify(entry),
    })
  } catch (err) {
    // Network error — transient, back off.
    return { ok: false, transient: true, detail: String(err?.message || err) }
  }
  if (resp.status === 202 || resp.status === 200) return { ok: true }
  if (resp.status === 401) return { ok: false, pauseForAuth: true, detail: 'http_401' }
  if (resp.status >= 400 && resp.status < 500) {
    // 400 / 404 / 403 / 429 — all but 429 indicate a bad client-side
    // request. 429 we treat as transient. The backend does not
    // currently 429 on this endpoint, but be defensive.
    if (resp.status === 429) return { ok: false, transient: true, detail: 'http_429' }
    return { ok: false, dropEvent: true, detail: 'http_' + resp.status }
  }
  // 5xx — transient.
  return { ok: false, transient: true, detail: 'http_' + resp.status }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function jittered(ms) {
  const j = ms * TELEMETRY_RETRY_JITTER
  return Math.floor(ms + (Math.random() * 2 - 1) * j)
}

// ------------------- Auth-refresh integration -------------------

export function pauseForAuthRefresh() {
  pausedForAuth = true
}

export function resumeAfterAuthRefresh() {
  pausedForAuth = false
  // Eager drain on resume — don't wait for the next interval tick.
  flushNow().catch(err => console.warn('[telemetry] post-refresh flush error', err))
}

// Subscribe to auth.js's session-refreshed event so the pause unwinds
// automatically when the queue's Port-driven refresh completes.
try {
  onSessionRefreshed(() => resumeAfterAuthRefresh())
} catch (err) {
  // auth.js may not have onSessionRefreshed yet (during Task 3's
  // transient import gap — see plan rationale). Log and continue;
  // Task 5 lands the real onSessionRefreshed.
  console.warn('[telemetry] onSessionRefreshed subscribe deferred:', err?.message)
}

// Bootstrap: start the flush loop on module load. The SW wakes, imports
// this module, and the loop begins. Pending events from the previous
// SW incarnation drain on the first tick.
ensureFlushLoopRunning()
// Also try an immediate drain — events queued from a just-concluded
// cancelled run should flush within seconds of the SW waking up.
flushNow().catch(err => console.warn('[telemetry] initial flush error', err))
```

Update `getBufferStats` to include `paused_for_auth`:

```js
export async function getBufferStats() {
  const { [STORAGE_KEY_QUEUE]: queue, [STORAGE_KEY_OVERFLOW_TOTAL]: overflow } =
    await chrome.storage.local.get([STORAGE_KEY_QUEUE, STORAGE_KEY_OVERFLOW_TOTAL])
  return {
    buffer_size: ring.length,
    queue_size: Array.isArray(queue) ? queue.length : 0,
    paused_for_auth: pausedForAuth,
    overflow_total: overflow || 0,
  }
}
```

- [ ] **Step 3: Verify parse**

```bash
node --check extension/modules/telemetry.js
# Expected: exit 0
```

(The full `import()` smoke test fails here because `attachBearer` / `onSessionRefreshed` don't exist yet in `auth.js`. That's the documented transient — see Step 1. Task 5 lands them.)

- [ ] **Step 4: Commit**

```bash
git add extension/modules/telemetry.js
git commit -m "$(cat <<'EOF'
feat(ext): telemetry — flush loop + exp backoff retry + JWT + 401

Second telemetry pass: wires the flush loop that drains
chrome.storage.local.telemetry_queue to POST /api/export-events.

Loop semantics:
- Tick every TELEMETRY_FLUSH_INTERVAL_MS (5s).
- On tick: drain eagerly until queue empty, paused, or failure.
- Backoff on 5xx / network / 429: doubling from 2s to 60s, ±20% jitter.
- 400: drop the event (dev-time shape bug; never loop forever).
- 401: set pausedForAuth = true, leave entry at front of queue, return.
- onSessionRefreshed callback from auth.js clears the pause and
  triggers an eager drain.
- No JWT available: same path as 401 (pause; resume on refresh).

Concurrency: single in-flight POST (flushInFlight latch). The backend
endpoint accepts one event per request per the spec; no bulk shape.

Known transient: the import of attachBearer / onSessionRefreshed from
auth.js fails until Task 5 lands those exports. The module parses
cleanly; the runtime wires correctly after Task 5. See plan § Task 3
Step 1 for the rationale (queue wiring in Task 4 depends on the flush
loop existing, and Task 5 is auth-module surface that naturally groups
with the modules/auth.js edit rather than the telemetry one).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `modules/queue.js` emit call sites

This is the biggest functional task. Adds `telemetry.emit(<event>, <payload>)` at the 10 state transitions the extension spec enumerates. No control-flow changes to the queue — every emit is fire-and-forget (invariant #8).

**Files:**
- Modify: `extension/modules/queue.js`

- [ ] **Step 1: Add the telemetry import**

At the top of `queue.js`, in the existing import block, add:

```js
import { emit as emitTelemetry } from './telemetry.js'
```

(Use the `as emitTelemetry` alias to avoid shadowing `emit` elsewhere and to make the emit calls read clearly in the queue.)

- [ ] **Step 2: Add timing bookkeeping to RunState**

In `buildInitialRunState`, add to the per-item skeleton:

```js
items: (manifest || []).map((m, i) => ({
  // ... existing fields ...
  // Ext.6: timing fields for telemetry meta. Set when the phase starts.
  resolve_started_at: null,
  license_started_at: null,
  download_started_at: null,
}))
```

And at the top level of the RunState object, add:

```js
// Ext.6: flags so we emit session_expired at most once per run.
session_expired_emitted: false,
```

- [ ] **Step 3: Emit `export_started` in `startRun`**

Locate the `startRun` function. After the `await persist()` call and before `schedule()`, insert:

```js
// Ext.6 telemetry: export_started. Fire-and-forget.
const sourceBreakdown = { envato: 0, pexels: 0, freepik: 0 }
let totalBytesEst = 0
for (const item of state.items) {
  if (sourceBreakdown[item.source] != null) sourceBreakdown[item.source]++
  if (typeof item.total_bytes === 'number') totalBytesEst += item.total_bytes
}
emitTelemetry('export_started', {
  export_id: state.runId,
  t: state.started_at,
  meta: {
    total_items: state.items.length,
    total_bytes_est: totalBytesEst,
    source_breakdown: sourceBreakdown,
  },
})
```

- [ ] **Step 4: Emit `item_resolved` in `runResolver`**

Inside `runResolver`:
- Before `await resolveOldIdToNewUuid(...)` add: `item.resolve_started_at = Date.now()`.
- After the successful `item.phase = 'licensing'` block (inside the try, before `await persistAndBroadcast()`):

```js
emitTelemetry('item_resolved', {
  export_id: state.runId,
  item_id: item.source_item_id,
  source: 'envato',
  phase: 'resolve',
  t: Date.now(),
  meta: { resolve_ms: Date.now() - (item.resolve_started_at || Date.now()) },
})
```

- [ ] **Step 5: Emit `item_licensed` in `runLicenser`**

Inside `runLicenser`:
- Before `await getSignedDownloadUrl(...)` add: `item.license_started_at = Date.now()`.
- After the successful `item.phase = 'downloading'` block (inside the try, before `await persistAndBroadcast()`):

```js
emitTelemetry('item_licensed', {
  export_id: state.runId,
  item_id: item.source_item_id,
  source: 'envato',
  phase: 'license',
  t: Date.now(),
  meta: { license_ms: Date.now() - (item.license_started_at || Date.now()) },
})
```

- [ ] **Step 6: Emit `item_downloaded` in `handleDownloadEvent`**

Inside `handleDownloadEvent`, in the `next === 'complete'` branch, before `await persistAndBroadcast()`:

```js
emitTelemetry('item_downloaded', {
  export_id: state.runId,
  item_id: item.source_item_id,
  source: item.source,
  phase: 'download',
  t: Date.now(),
  meta: {
    bytes: item.bytes_received || 0,
    download_ms: Date.now() - (item.download_started_at || Date.now()),
    filename: item.target_filename,
  },
})
```

Also, in `runDownloader`, before `await chrome.downloads.download(...)`, add: `item.download_started_at = Date.now()`.

- [ ] **Step 7: Emit `item_failed` in `failItem`**

Replace `failItem`:

```js
async function failItem(item, errorCode) {
  item.phase = 'failed'
  item.error_code = errorCode
  item.claimed = false
  state.stats.fail_count++
  await persistAndBroadcast()
  broadcast({ type: 'item_done', item_id: item.source_item_id, result: 'failed' })

  // Ext.6 telemetry. Fire-and-forget; do not await.
  emitTelemetry('item_failed', {
    export_id: state.runId,
    item_id: item.source_item_id,
    source: item.source,
    phase: item.phase === 'resolving' ? 'resolve' : item.phase === 'licensing' ? 'license' : 'download',
    t: Date.now(),
    error_code: normalizeErrorCode(errorCode),   // Task 8 lands normalizeErrorCode
    retry_count: item.retries || 0,
    meta: {
      attempts: (item.retries || 0) + 1,
      raw_error: errorCode, // keep the raw string so admin observability can triage unknowns
    },
  })

  // Session_expired side-emit (invariant #7-adjacent; at most once per run).
  if ((errorCode === 'envato_session_401' || String(errorCode).startsWith('envato_session_401')) && !state.session_expired_emitted) {
    state.session_expired_emitted = true
    emitTelemetry('session_expired', {
      export_id: state.runId,
      t: Date.now(),
      source: 'envato',
    })
  }
}
```

For now, reference `normalizeErrorCode` — Task 8 actually implements it in `telemetry.js`. Stub it at the top of `queue.js` for Task 4 to compile cleanly:

```js
// Task 8 replaces this import with the real one exported from telemetry.js.
// Keep this stub so Task 4 compiles standalone.
function normalizeErrorCode(raw) { return raw }
```

Task 8 deletes the stub and adds `import { normalizeErrorCode } from './telemetry.js'`.

- [ ] **Step 8: Emit `rate_limit_hit` in `handleDownloadInterrupt` (NETWORK_ with retry)**

Inside `handleDownloadInterrupt`, in the `NETWORK_` branch, BEFORE the `item.retries++` line:

```js
// Ext.6 telemetry: each network retry counts as a rate_limit_hit
// signal. Note: chrome.downloads doesn't surface Retry-After for
// network interrupts; meta.retry_after_sec is null.
emitTelemetry('rate_limit_hit', {
  export_id: state.runId,
  item_id: item.source_item_id,
  source: item.source,
  phase: 'download',
  t: Date.now(),
  http_status: null,
  retry_count: item.retries || 0,
  meta: { retry_after_sec: null, reason: reason },
})
```

Rationale: the spec's `rate_limit_hit` table row says "Envato 429 hit". Today, Envato 429s propagate from `envato.js` as a thrown error that lands in `failItem` (Ext.5 doesn't currently distinguish 429 from other failures; that's Ext.7's failure-matrix work). Ext.6 opportunistically emits `rate_limit_hit` on NETWORK_ interrupts because that's the only observable signal today — Ext.7 will replace this with a proper 429-detecting path. The backend does not care: `rate_limit_hit` is a general-purpose "something rate-limited us" event, and the `meta.reason` field distinguishes.

- [ ] **Step 9: Emit `queue_paused` / `queue_resumed`**

Replace `pauseRun`:

```js
export async function pauseRun() {
  if (!state || state.run_state !== 'running') return { ok: false }
  state.run_state = 'paused'
  await releaseKeepAwake()
  await persistAndBroadcast()
  emitTelemetry('queue_paused', {
    export_id: state.runId,
    t: Date.now(),
    meta: { reason: 'user' },
  })
  return { ok: true }
}
```

Replace `resumeRun`:

```js
export async function resumeRun() {
  if (!state || state.run_state !== 'paused') return { ok: false }
  state.run_state = 'running'
  await acquireKeepAwake()
  await persistAndBroadcast()
  emitTelemetry('queue_resumed', {
    export_id: state.runId,
    t: Date.now(),
  })
  schedule()
  return { ok: true }
}
```

- [ ] **Step 10: Emit `export_completed` in `finalize`, `cancelRun`, `hardStopQueue`**

In `finalize`, before `await releaseKeepAwake()`:

```js
emitTelemetry('export_completed', {
  export_id: state.runId,
  t: Date.now(),
  meta: {
    ok_count:         state.stats.ok_count,
    fail_count:       state.stats.fail_count,
    wall_seconds:     Math.round((Date.now() - state.started_at) / 1000),
    total_bytes:      state.stats.total_bytes_downloaded,
    reason:           'complete',
  },
})
```

In `cancelRun`, AFTER the cancellation of in-flight downloads and BEFORE `await releaseKeepAwake()` (so the emit happens while `state` is still populated):

```js
emitTelemetry('export_completed', {
  export_id: state.runId,
  t: Date.now(),
  meta: {
    ok_count:         state.stats.ok_count,
    fail_count:       state.stats.fail_count,
    wall_seconds:     Math.round((Date.now() - state.started_at) / 1000),
    total_bytes:      state.stats.total_bytes_downloaded,
    reason:           'cancelled',
  },
})
```

In `hardStopQueue`, AFTER the `for (const it of state.items)` loop and BEFORE `await releaseKeepAwake()`:

```js
emitTelemetry('export_completed', {
  export_id: state.runId,
  t: Date.now(),
  meta: {
    ok_count:         state.stats.ok_count,
    fail_count:       state.stats.fail_count,
    wall_seconds:     Math.round((Date.now() - state.started_at) / 1000),
    total_bytes:      state.stats.total_bytes_downloaded,
    reason:           'hard_stop:' + reason,
  },
})
```

- [ ] **Step 11: Emit-count grep-verify**

```bash
grep -c "emitTelemetry(" extension/modules/queue.js
# Expected: at minimum 10, realistically 11-12 (export_started,
# item_resolved, item_licensed, item_downloaded, item_failed,
# session_expired, rate_limit_hit, queue_paused, queue_resumed,
# export_completed × 3 for finalize/cancel/hardStop).
# If < 10, a transition was missed — re-scan the task.
```

- [ ] **Step 12: Verify parse**

```bash
node --check extension/modules/queue.js
# Expected: exit 0
```

- [ ] **Step 13: Commit**

```bash
git add extension/modules/queue.js
git commit -m "$(cat <<'EOF'
feat(ext): queue — wire 10 telemetry.emit call sites at state transitions

Hooks modules/queue.js into modules/telemetry.js at each of the 10
state transitions the extension spec enumerates. Every emit is
fire-and-forget (no await) — the queue MUST NOT block on telemetry.

Call sites:
- startRun                   → export_started   (meta: total_items,
                                                  total_bytes_est,
                                                  source_breakdown)
- runResolver success        → item_resolved    (meta: resolve_ms)
- runLicenser success        → item_licensed    (meta: license_ms)
- handleDownloadEvent done   → item_downloaded  (meta: bytes,
                                                  download_ms, filename)
- failItem (all fail paths)  → item_failed      (error_code normalized,
                                                  retry_count, meta:
                                                  attempts, raw_error)
- failItem (envato_session_401) → session_expired (at most once per
                                                  run via state.session_expired_emitted)
- handleDownloadInterrupt
    NETWORK_ with retry      → rate_limit_hit   (meta: reason)
- pauseRun                   → queue_paused     (meta: reason: 'user')
- resumeRun                  → queue_resumed
- finalize                   → export_completed (meta: reason:'complete')
- cancelRun                  → export_completed (meta: reason:'cancelled')
- hardStopQueue              → export_completed (meta: reason:'hard_stop:<code>')

Bookkeeping added to RunState:
- items[].resolve_started_at / license_started_at / download_started_at
  so the *_ms meta fields are computed at the correct origin.
- session_expired_emitted boolean so the event fires once per run.

normalizeErrorCode is stubbed to identity here; Task 8 replaces with
the real 15-code enum mapping from telemetry.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `modules/auth.js` — `attachBearer` + `onSessionRefreshed` hub

Adds the two auth-module helpers telemetry needs. Does NOT restructure existing auth flow — all additions are append-only.

**Files:**
- Modify: `extension/modules/auth.js`

- [ ] **Step 1: Add `attachBearer` (near the top of the file, after `getJwt`)**

Insert after the existing `getJwt` function:

```js
// Ext.6: helper used by modules/telemetry.js (and any future module)
// that needs to POST to a Bearer-authenticated backend endpoint.
// Reads the current JWT from storage and sets the Authorization
// header. Idempotent: returns the same headers object it received.
// Throws nothing — if no JWT, the header is simply not set and the
// caller is responsible for treating absence as "paused for auth".
export async function attachBearer(headers) {
  const jwt = await getJwt()
  if (jwt && jwt.token && jwt.expires_at > Date.now()) {
    headers['Authorization'] = 'Bearer ' + jwt.token
  }
  return headers
}
```

- [ ] **Step 2: Add the session-refreshed subscriber hub**

Append at the bottom of `auth.js`:

```js
// Ext.6: session-refresh notification hub.
//
// modules/telemetry.js subscribes on load; modules/queue.js's
// Ext.5-era refreshSessionViaPort success path emits. Single-
// subscriber in practice, but the registry is multi-subscriber-safe
// so future modules (e.g. an Ext.9 /api/ext-config re-fetcher) can
// reuse without refactor.
const sessionRefreshedSubscribers = []

export function onSessionRefreshed(cb) {
  if (typeof cb !== 'function') throw new Error('onSessionRefreshed: cb must be a function')
  sessionRefreshedSubscribers.push(cb)
  // Return an unsubscribe for symmetry with onEnvatoSessionChange —
  // not currently used, but cheap.
  return () => {
    const idx = sessionRefreshedSubscribers.indexOf(cb)
    if (idx >= 0) sessionRefreshedSubscribers.splice(idx, 1)
  }
}

export function emitSessionRefreshed() {
  for (const cb of sessionRefreshedSubscribers) {
    try { cb() } catch (err) { console.warn('[auth] session-refreshed subscriber threw', err) }
  }
}
```

- [ ] **Step 3: Have `refreshSessionViaPort` fire `emitSessionRefreshed` on success**

Locate the existing `refreshSessionViaPort`. It currently returns the Promise from `waitForNextSessionMessage(10000)`. Wrap the return so the emit fires after resolution:

```js
export async function refreshSessionViaPort() {
  const { getActivePort, waitForNextSessionMessage } = await import('./port.js')
  const active = getActivePort()
  if (!active) throw new Error('no_port')
  const waitPromise = waitForNextSessionMessage(10000)
  try {
    active.port.postMessage({ type: 'refresh_session', version: 1 })
  } catch (err) {
    throw new Error('port_post_failed: ' + String(err?.message || err))
  }
  const result = await waitPromise
  // Ext.6: tell subscribers (telemetry, future Ext.9) the JWT has
  // been refreshed so they can unpark their flush loops.
  try { emitSessionRefreshed() } catch (err) { console.warn('[auth] emitSessionRefreshed threw', err) }
  return result
}
```

- [ ] **Step 4: Verify parse and surface**

```bash
node --check extension/modules/auth.js
# Expected: exit 0
node -e "import('./extension/modules/auth.js').then(m => console.log(['attachBearer','onSessionRefreshed','emitSessionRefreshed'].map(k => [k, typeof m[k]])))"
# Expected: [['attachBearer','function'],['onSessionRefreshed','function'],['emitSessionRefreshed','function']]
```

- [ ] **Step 5: Commit**

```bash
git add extension/modules/auth.js
git commit -m "$(cat <<'EOF'
feat(ext): auth — attachBearer helper + session-refreshed hub

Additive changes only; no refactor of existing auth flow.

attachBearer(headers): tiny 4-line helper that reads the JWT via
getJwt() and sets the Authorization header. Used by modules/
telemetry.js; future Bearer-auth callers (Ext.9) reuse.

onSessionRefreshed(cb) / emitSessionRefreshed(): single-subscriber-hub
pattern. refreshSessionViaPort fires emitSessionRefreshed after the
new JWT has landed in storage; telemetry subscribes on module load
and clears its paused-for-auth flag when the callback runs.

Symmetric with the existing onEnvatoSessionChange(handler) registry;
returns an unsubscribe for test cleanliness.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Service worker — import telemetry module + add debug handlers

The telemetry module's flush loop kicks off at import time (per Task 3's bootstrap). `service_worker.js` must import it so the SW boot actually starts the loop. Also adds two dev-only message handlers (`debug_telemetry_stats`, `debug_telemetry_flush`) that Task 7's test harness will drive.

**Files:**
- Modify: `extension/service_worker.js`

- [ ] **Step 1: Add the import**

In the existing import block at the top of `service_worker.js`, add:

```js
import { getBufferStats as telemetryStats, flushNow as telemetryFlushNow } from './modules/telemetry.js'
```

The side effect of the import is that `telemetry.js`'s bootstrap — `ensureFlushLoopRunning()` + initial `flushNow()` — runs at SW boot.

- [ ] **Step 2: Add the `debug_telemetry_stats` and `debug_telemetry_flush` cases**

In the `switch (msg.type)` block of `chrome.runtime.onMessageExternal`, add two new cases alongside the existing `debug_*` cases:

```js
case 'debug_telemetry_stats': {
  try {
    const stats = await telemetryStats()
    sendResponse({ ok: true, stats })
  } catch (err) {
    sendResponse({ ok: false, error: String(err?.message || err) })
  }
  return
}
case 'debug_telemetry_flush': {
  try {
    await telemetryFlushNow()
    const stats = await telemetryStats()
    sendResponse({ ok: true, stats })
  } catch (err) {
    sendResponse({ ok: false, error: String(err?.message || err) })
  }
  return
}
```

- [ ] **Step 3: Verify parse**

```bash
node --check extension/service_worker.js
# Expected: exit 0
```

- [ ] **Step 4: Commit**

```bash
git add extension/service_worker.js
git commit -m "$(cat <<'EOF'
feat(ext): service worker — import telemetry + debug handlers

Adds the telemetry module import so the flush loop boots with the SW.
Ext.6 telemetry is a module-side-effect-on-import design; the SW only
needs to see the symbol to bootstrap the loop.

Two dev-only message handlers for the test harness:
- debug_telemetry_stats: returns {buffer_size, queue_size,
  paused_for_auth, overflow_total}
- debug_telemetry_flush: forces an immediate flushNow() and returns
  the post-flush stats snapshot

Both handlers are reachable via chrome.runtime.sendMessage from the
test page; they are useful for the Task 9 manual verification of
online/offline flush behaviour.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Test harness — `extension-test.html` fieldset 11

Adds a "11. Telemetry (Ext.6)" fieldset with: a "Fire synthetic short run" button, a "Query buffer stats" button, a "Force flush" button, and documentation for the offline-mode toggle.

**Files:**
- Modify: `extension-test.html`

- [ ] **Step 1: Read the existing fieldset 10 to anchor the new one**

```bash
grep -n "fieldset>\|</script>" extension-test.html | head -20
```

The current trailing fieldset is `10. Queue / stress test (Ext.5)`. Append the new fieldset after its `</fieldset>` and before the `<script type="module">` tag.

- [ ] **Step 2: Insert the new fieldset**

Use Edit on `extension-test.html`. Find the `</fieldset>` that closes fieldset 10 (it's the one with `<legend>10. Queue / stress test (Ext.5)</legend>`) and add after it:

```html
  <fieldset>
    <legend>11. Telemetry (Ext.6)</legend>
    <p class="muted">
      Drives a 3-item synthetic run (1 Pexels + 1 Freepik + 1 bogus
      source_item_id to trigger <code>item_failed</code>) through the
      queue to exercise the full telemetry emit surface. Use "Query
      stats" to see the in-memory buffer + persisted queue sizes.
      Use "Force flush" to drain immediately rather than waiting for
      the 5s loop tick.
    </p>
    <p class="muted">
      <b>Offline test:</b> Chrome DevTools &rarr; Network tab &rarr;
      "Offline" checkbox toggles network for the whole browser
      (including the SW). Flip it on, fire a run, flip it off,
      observe the queued events flush within 5s (or immediately via
      Force flush).
    </p>
    <div class="row">
      <button id="t-synthetic-run">Fire synthetic short run (3 items)</button>
      <button id="t-stats">Query buffer stats</button>
      <button id="t-flush">Force flush</button>
    </div>
    <pre id="t-log">(no events yet)</pre>
  </fieldset>
```

- [ ] **Step 3: Add the button handlers in the `<script type="module">` block**

Find the existing `<script type="module">` block (it has the existing fieldset handlers). Append the telemetry-fieldset handlers at the end of the script, before `</script>`:

```js
    // Ext.6 telemetry fieldset.
    const tLog = document.getElementById('t-log')
    function tAppend(line) {
      if (tLog.textContent === '(no events yet)') tLog.textContent = ''
      tLog.textContent += line + '\n'
      tLog.scrollTop = tLog.scrollHeight
    }
    document.getElementById('t-synthetic-run').onclick = async () => {
      // Re-use the connectPort helper from fieldset 7 if that's how
      // the existing handlers worked; otherwise rely on sendMessage.
      const runId = 'telemetry_demo_' + Date.now()
      const manifest = [
        { source: 'pexels',  source_item_id: '856971', target_filename: 'pexels_856971.mp4', envato_item_url: null, est_size_bytes: 5_000_000 },
        { source: 'freepik', source_item_id: 'fp_001', target_filename: 'freepik_fp_001.mp4', envato_item_url: null, est_size_bytes: 20_000_000 },
        { source: 'pexels',  source_item_id: 'bogus', target_filename: 'pexels_bogus.mp4', envato_item_url: null, est_size_bytes: 1_000_000 },
      ]
      const result = await send({
        type: 'export', version: 1,
        export_id: runId,
        manifest,
        target_folder: 'transcript-eval/telemetry-demo',
        options: { variants: [], force_redownload: false },
      })
      tAppend('startRun: ' + JSON.stringify(result))
    }
    document.getElementById('t-stats').onclick = async () => {
      const r = await send({ type: 'debug_telemetry_stats', version: 1 })
      tAppend('stats: ' + JSON.stringify(r))
    }
    document.getElementById('t-flush').onclick = async () => {
      const r = await send({ type: 'debug_telemetry_flush', version: 1 })
      tAppend('flush result: ' + JSON.stringify(r))
    }
```

- [ ] **Step 4: Smoke test the page parses**

```bash
# Rough sanity: count fieldsets.
grep -c '</fieldset>' extension-test.html
# Expected: +1 from pre-Ext.6 (Ext.5 ended at 10). So if before was
# the count from Ext.5, after should be that + 1.
```

- [ ] **Step 5: Commit**

```bash
git add extension-test.html
git commit -m "$(cat <<'EOF'
test(ext): harness — Ext.6 telemetry fieldset (#11)

Adds the manual-test surface for telemetry verification:

- Fire synthetic short run (3 items): Pexels + Freepik + bogus id to
  exercise the full emit surface (export_started, item_resolved-ish
  (Pexels/Freepik skip resolve/license), item_downloaded ×2,
  item_failed ×1, export_completed). Drives a tiny manifest through
  the Ext.5 queue via the existing {type:"export"} flow.
- Query buffer stats: hits {type:"debug_telemetry_stats"} and shows
  {buffer_size, queue_size, paused_for_auth, overflow_total}.
- Force flush: hits {type:"debug_telemetry_flush"} and shows the
  post-flush stats snapshot.

Offline-mode test is documented as a DevTools Network-tab toggle —
MV3 does not expose a programmatic way to flip network offline, and
the spec's "telemetry queue offline → flush on reconnect" is human-
verified via the DevTools toggle per spec § "Telemetry".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `telemetry.js` — `normalizeErrorCode` and drop the queue.js stub

The 15-code enum mapping. Lives in `telemetry.js` (single source of truth for telemetry internals), is imported from `queue.js`, and replaces Task 4's local identity stub.

**Files:**
- Modify: `extension/modules/telemetry.js`
- Modify: `extension/modules/queue.js`

- [ ] **Step 1: Add the enum + mapper to `telemetry.js`**

Append to `telemetry.js` (after the `_unshiftToQueue` helper but before the flush-loop state declarations — or any sensible module-scope location):

```js
// ------------------- Error-code normalization -------------------
//
// The extension spec pins 15 error_code values for item_failed
// telemetry. Ext.5's queue records free-form strings
// (resolve_failed, download_failed, network_failed, disk_failed:<reason>,
// cancelled, download_interrupt:<reason>, network_resume_failed:<msg>,
// etc.). Ext.6 maps those strings into the enum at emit time;
// unmappable raw strings normalize to null. Ext.7's failure-matrix
// work will push the raw strings into well-known branches — this
// mapper then becomes lossless.

const ERROR_CODE_ENUM = Object.freeze([
  'envato_403',
  'envato_402_tier',
  'envato_429',
  'envato_session_401',
  'envato_unavailable',
  'envato_unsupported_filetype',
  'freepik_404',
  'freepik_429',
  'freepik_unconfigured',
  'pexels_404',
  'network_failed',
  'disk_failed',
  'integrity_failed',
  'resolve_failed',
  'url_expired_refetch_failed',
])
const ERROR_CODE_SET = new Set(ERROR_CODE_ENUM)

export function normalizeErrorCode(raw) {
  if (raw == null) return null
  const s = String(raw)
  // Direct hit.
  if (ERROR_CODE_SET.has(s)) return s
  // Prefix matches for the colon-separated variants Ext.5's queue
  // produces (e.g. "disk_failed:FILE_ACCESS_DENIED",
  // "download_interrupt:SERVER_UNAUTHORIZED", "network_resume_failed:<msg>").
  const beforeColon = s.split(':', 1)[0]
  if (ERROR_CODE_SET.has(beforeColon)) return beforeColon
  // Known Ext.5 raw strings that don't match the enum yet. Map
  // conservatively; Ext.7 will tighten.
  if (beforeColon === 'download_interrupt') return 'network_failed'
  if (beforeColon === 'network_resume_failed') return 'network_failed'
  if (beforeColon === 'license_failed') return 'envato_unavailable'
  if (beforeColon === 'download_failed') return null
  // Unknown — return null so the event still posts; the raw string
  // lives in meta.raw_error for admin triage.
  return null
}
```

Also expose `ERROR_CODE_ENUM` as an export so Ext.7's tests can assert the 15 codes from outside:

```js
export { ERROR_CODE_ENUM }
```

- [ ] **Step 2: Wire `normalizeErrorCode` into `queue.js`**

In `queue.js`, at the top of the imports block, extend the telemetry import:

```js
import { emit as emitTelemetry, normalizeErrorCode } from './telemetry.js'
```

Then delete the local stub added in Task 4:

```js
// REMOVE this block (added in Task 4 as a temporary stub):
// function normalizeErrorCode(raw) { return raw }
```

- [ ] **Step 3: Verify both files still parse and the mapping is sensible**

```bash
node --check extension/modules/telemetry.js
node --check extension/modules/queue.js
# Expected: both exit 0
node -e "
  globalThis.chrome = { storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } } }
  const { normalizeErrorCode, ERROR_CODE_ENUM } = await import('./extension/modules/telemetry.js')
  console.log('ENUM len:', ERROR_CODE_ENUM.length)
  const cases = [
    ['envato_403', 'envato_403'],
    ['disk_failed:FILE_ACCESS_DENIED', 'disk_failed'],
    ['network_resume_failed:timeout', 'network_failed'],
    ['download_interrupt:SERVER_UNAUTHORIZED', 'network_failed'],
    ['license_failed', 'envato_unavailable'],
    ['totally_unknown', null],
    [null, null],
  ]
  for (const [input, want] of cases) {
    const got = normalizeErrorCode(input)
    console.log(JSON.stringify(input), '->', JSON.stringify(got), got === want ? 'OK' : 'WRONG (want ' + JSON.stringify(want) + ')')
  }
"
# Expected: ENUM len: 15; every case labeled OK.
```

- [ ] **Step 4: Commit**

```bash
git add extension/modules/telemetry.js extension/modules/queue.js
git commit -m "$(cat <<'EOF'
feat(ext): telemetry — 15-code normalizeErrorCode + queue integration

Adds the error_code normalization layer that maps Ext.5's free-form
failure strings into the 15-code enum the extension spec pins for
item_failed telemetry. Enum exported as ERROR_CODE_ENUM so Ext.7's
failure-matrix work can assert against the same constant.

Mapping rules:
- Direct enum hit: returned as-is.
- Colon-separated (disk_failed:FILE_*, download_interrupt:*, etc.):
  take the prefix and re-check against the enum.
- Known Ext.5 Ext.6-window raw strings: conservative maps
  (download_interrupt → network_failed, license_failed →
  envato_unavailable). Ext.7 tightens these when the failure-matrix
  lands.
- Unknown: null. The event still posts (backend accepts error_code:
  null); meta.raw_error preserves the source string for admin triage.

queue.js drops its Task 4 identity stub and imports
normalizeErrorCode from telemetry.js — single source of truth for
telemetry internals.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Manual verification (no commit)

End-to-end acceptance gate. Mirrors Ext.5 Task 12's pattern: drives real traffic, verifies the backend received the expected chronology, verifies offline queueing + post-reconnect flush. No code changes; no commit.

**Prereq:**
- Dev server on `:5173` (vite).
- Backend on `:3001` (`npm run server` or however the user runs it).
- Extension loaded unpacked at `v0.6.0`.
- User signed in to `transcript-eval` in the same Chrome profile (required for `POST /api/session-token`'s cookie auth).
- A valid JWT minted via fieldset 2 of the test page.
- `psql` or equivalent access to the `export_events` table (direct DB is fine; the admin UI is WebApp.3, not yet shipped).

- [ ] **Step 1: Start vite + backend**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext6"
# In terminal A:
npm run server
# In terminal B:
npm run dev:client
```

- [ ] **Step 2: Reload the extension + clear storage once for a clean run**

- `chrome://extensions` → Export Helper → reload.
- Click "service worker" link → DevTools console.
- Run: `await chrome.storage.local.clear()` to reset any old state (including old telemetry queue + overflow counter).

- [ ] **Step 3: Mint a fresh JWT**

- Open `http://localhost:5173/extension-test.html`, paste the extension ID.
- Fieldset 2 → "Mint & store JWT". Confirm the pong in fieldset 2 shows `has_jwt: true`.

- [ ] **Step 4: Online-happy-path telemetry run**

1. In fieldset 11, click "Fire synthetic short run (3 items)".
2. Wait ~10–15 s for the 3 items to churn through the queue (2 downloads + 1 failure).
3. Click "Query buffer stats" — expect `queue_size: 0` (everything drained) and `overflow_total: 0`.
4. Query the backend database:
   ```bash
   psql "$DATABASE_URL" -c "SELECT event, item_id, source, error_code, t FROM export_events WHERE export_id LIKE 'telemetry_demo_%' ORDER BY t ASC;"
   # Expected chronology (approximately):
   #  event            | item_id | source  | error_code      | t
   #  export_started   |         |         |                 | 1745...000
   #  item_downloaded  | 856971  | pexels  |                 | 1745...002
   #  item_downloaded  | fp_001  | freepik |                 | 1745...004
   #  item_failed      | bogus   | pexels  | pexels_404      | 1745...005
   #  export_completed |         |         |                 | 1745...006
   ```

   Note: `rate_limit_hit` / `session_expired` / `queue_paused` / `queue_resumed` / `item_resolved` / `item_licensed` do NOT appear in a Pexels-only run. That's expected; they need Envato.

5. If the chronology is missing `export_started` or `export_completed`, the flush loop is broken — re-inspect Task 3's `flushNow` and Task 6's import.

- [ ] **Step 5: Offline queue + reconnect flush**

1. DevTools → Network tab → check "Offline".
2. In fieldset 11, click "Fire synthetic short run (3 items)" again (new `export_id`, so no row collision).
3. Wait ~10–15 s. Query the backend — the `export_id` for this second run should have ZERO rows (offline).
4. Click "Query buffer stats" — expect `queue_size: 5` (or however many emits the run produced).
5. Uncheck "Offline" in DevTools.
6. Click "Force flush". Wait ~5 s.
7. Click "Query buffer stats" — expect `queue_size: 0`.
8. Query the backend again — the second run's chronology should now be present.

- [ ] **Step 6: 401 / auth-refresh flush**

1. In the SW console: `await chrome.storage.local.remove('te:jwt')`. (Nukes the JWT without formally expiring — simulates server-side invalidation.)
2. Fire another synthetic run. Wait 5 s.
3. "Query buffer stats" — expect `paused_for_auth: true` and `queue_size > 0`.
4. Fieldset 2 → "Mint & store JWT" — mint a fresh one; this fires the web-app → SW Port message → `setJwt` → `emitSessionRefreshed()` in the auth module → telemetry's `resumeAfterAuthRefresh()`.
5. "Query buffer stats" within 10 s — expect `paused_for_auth: false` and `queue_size: 0`.
6. Query the backend — the chronology is present.

   Note: step 4 only fires `emitSessionRefreshed` if the web app sends via the Port. If the test harness's "Mint" button uses `chrome.runtime.sendMessage({type:"session"})` instead of Port, `emitSessionRefreshed` is NOT fired — the flush will wait for the 5 s interval tick to discover the new JWT and self-unpark (`postSingleEvent` re-reads JWT each call; the `paused_for_auth` flag clears on the next successful POST). Acceptable; document in the commit for Task 9's manual-notes file if you're writing one.

- [ ] **Step 7: Overflow counter**

Optional, only if you want full coverage. Synthetic way to induce overflow:

1. SW console:
   ```js
   // Queue ~600 synthetic events (well past the 500 cap) with bogus but
   // in-enum event names and export_id to exercise the overflow path.
   const telem = await import('./modules/telemetry.js')
   for (let i = 0; i < 600; i++) telem.emit('item_resolved', { export_id: 'overflow_test', t: Date.now() + i, item_id: String(i) })
   await new Promise(r => setTimeout(r, 200))
   console.log(await telem.getBufferStats())
   // Expected: queue_size <= 500; overflow_total >= 100.
   ```

2. If `queue_size` stays capped at 500 and `overflow_total` counts up, the oldest-drop is working. Don't post-test-query the backend (it will have some of the 500; the rest were dropped — not interesting data).

- [ ] **Step 8: Do NOT commit anything from this task**

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

If any of Steps 4–7 fail, go fix before starting Task 10. Common failure modes:

- Online run missing events → Task 3's flush loop not booting on SW wake. Check Task 6's import in `service_worker.js` and the bootstrap lines at the bottom of Task 3's telemetry.js.
- Offline queue grows but reconnect doesn't flush → the flush loop's interval is parked; the `pausedForAuth` flag got stuck. Add a `console.log('[telemetry] flushNow tick', {pausedForAuth, flushInFlight})` at the top of `flushNow` for diagnosis.
- 401 flow doesn't pause → either `postSingleEvent` isn't detecting 401 (re-check the `resp.status === 401` branch), or `onSessionRefreshed` isn't firing from auth (re-check Task 5 Step 3's wiring into `refreshSessionViaPort`).
- Overflow counter doesn't increment → re-check Task 2's `persistAppend` oldest-drop loop and the `telemetry_overflow_total` write.

---

## Task 10: README update + self-review

**Files:**
- Modify: `extension/README.md`

- [ ] **Step 1: Append "Ext.6 — Telemetry" section**

Append to `extension/README.md` (after the existing "Ext.5 — Queue & persistence" section, which ends with "Manifest changes (0.4.0 → 0.5.0)"):

```markdown
## Ext.6 — Telemetry

- **Permissions:** unchanged from Ext.5. Manifest version `0.6.0`.
- **New module:** `modules/telemetry.js` (~300 LOC) — owns the
  `POST /api/export-events` emitter. Ring buffer (50) + persisted
  overflow queue (`chrome.storage.local.telemetry_queue`, hard cap
  500, oldest-drop with counter) + exponential-backoff retry loop
  (2 s → 60 s, ±20 % jitter, 5 s idle interval) + Bearer-JWT attach
  + 401-pause-until-refresh + 15-code `normalizeErrorCode` mapper.
- **Queue integration:** `modules/queue.js` calls
  `telemetry.emit(<event>, <payload>)` at every state transition.
  Emits are fire-and-forget — the queue never awaits the flush.
  10 event types per the extension spec: `export_started`,
  `item_resolved`, `item_licensed`, `item_downloaded`, `item_failed`,
  `rate_limit_hit`, `session_expired`, `queue_paused`, `queue_resumed`,
  `export_completed`.
- **Payload conventions:**
  - `export_started` meta: `{total_items, total_bytes_est,
    source_breakdown: {envato, pexels, freepik}}`.
  - `export_completed` meta: `{ok_count, fail_count, wall_seconds,
    total_bytes, reason: 'complete'|'cancelled'|'hard_stop:<code>'}`
    — REQUIRED. Backend derives final export status from these.
  - `item_failed`: `error_code` REQUIRED, mapped via
    `normalizeErrorCode` to the 15-code enum; raw string preserved
    in `meta.raw_error` for admin triage of unknown branches.
- **Auth integration:** `modules/auth.js` gains `attachBearer(headers)`
  (read JWT, attach `Authorization`) and an
  `onSessionRefreshed(cb)` / `emitSessionRefreshed()` hub.
  `refreshSessionViaPort`'s success path fires the emit so telemetry
  unparks its flush.
- **Invariants:** MV3 SW termination means persist-before-flush;
  paused-for-auth is load-bearing; the 10-event enum MUST match
  `server/services/exports.js` ALLOWED_EVENTS; `export_completed`
  fires exactly once per run (on `finalize`, `cancelRun`, or
  `hardStopQueue`). Full list in
  `docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md`.

### Manual verification

The test harness's fieldset 11 (Ext.6) has three buttons: "Fire
synthetic short run" (3 items; exercises emit surface), "Query buffer
stats", and "Force flush". The DevTools Network tab's "Offline"
checkbox is the canonical way to test offline queueing — flip on,
fire a run, flip off, observe queue drain via Force flush or the
5 s loop tick.

Acceptance gate: complete a real 3-item run, query `export_events`
table for the chronology; disconnect network, complete a run offline,
reconnect, confirm queued events flush. Full step-by-step in the plan
file's Task 9.

### Known Ext.6 limitations (belong to later phases)

- Opt-out switch (user-facing "Send diagnostic events" toggle) →
  Ext.8. The emit function does NOT consult an opt-out flag today.
- Diagnostic bundle generator (`modules/diagnostics.js`) → Ext.8.
- Per-error retry / deny-list / Freepik TTL refetch → Ext.7. Today
  the retry loop is uniform exponential backoff on any non-2xx-
  non-401.
- `/api/ext-config` consumption / kill switch → Ext.9.
- CI packaging / Web Store work → Ext.10 / Ext.11 / Ext.12.

### Manifest changes (0.5.0 → 0.6.0)

- `permissions`: unchanged.
- `host_permissions`: unchanged — `/api/export-events` is same-origin
  to `BACKEND_URL`, which is already reachable for `/api/pexels-url` +
  `/api/freepik-url` from Ext.3.
- `version`: 0.5.0 → 0.6.0.
```

- [ ] **Step 2: Commit the README**

```bash
git add extension/README.md
git commit -m "$(cat <<'EOF'
docs(ext): README — Ext.6 telemetry section

Documents the new module, the 10-event emit surface, payload
conventions (export_started meta, export_completed meta required for
backend status derivation, item_failed error_code normalization),
auth integration (attachBearer + onSessionRefreshed hub), invariants
(persist-before-flush, paused-for-auth, export_completed-once), the
manual-verification flow (Task 9 in the plan), and the
deferred-to-later-phases list for Ext.7+ planners.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Full branch review**

```bash
git log --oneline main..HEAD
# Expected commits (one per task except Task 9 which is verification-
# only):
#   chore(ext): Ext.6 scaffold ...                                 (Task 0)
#   feat(ext):  manifest + config — Ext.6 telemetry tunables ...   (Task 1)
#   feat(ext):  telemetry — ring buffer + chrome.storage.local ... (Task 2)
#   feat(ext):  telemetry — flush loop + exp backoff retry + ...   (Task 3)
#   feat(ext):  queue — wire 10 telemetry.emit call sites ...      (Task 4)
#   feat(ext):  auth — attachBearer helper + session-refreshed ... (Task 5)
#   feat(ext):  service worker — import telemetry + debug ...      (Task 6)
#   test(ext):  harness — Ext.6 telemetry fieldset ...             (Task 7)
#   feat(ext):  telemetry — 15-code normalizeErrorCode + queue ... (Task 8)
#   docs(ext):  README — Ext.6 telemetry section                   (Task 10)
# Task 9 (verification) produces no commit.
```

Expect 10 commits.

```bash
git diff main --stat
# Expected additions (approximate):
#   extension/manifest.json                  |   2 +/-
#   extension/config.js                      |  40 +
#   extension/modules/telemetry.js           | 300 +
#   extension/modules/queue.js               |  80 +/-
#   extension/modules/auth.js                |  40 +
#   extension/service_worker.js              |  20 +/-
#   extension/README.md                      |  50 +
#   extension-test.html                      |  70 +
```

If `git diff main` surfaces anything OUTSIDE `extension/*`,
`extension-test.html`, the manifest, or the plan file itself,
investigate — Ext.6's scope is all extension-side + harness.

- [ ] **Step 4: DO NOT push**

`git push` requires explicit user approval. Task 10's acceptance is
"all commits on the local branch, branch ready for review, one PR
candidate."

Surface to the reviewer:
- Branch name: `feature/extension-ext6-telemetry`.
- Last commit sha.
- A copy of the Task 9 `psql` output showing the full 3-item run's
  chronology in `export_events`.
- Confirmation that the offline-queue-and-reconnect flush round-trip
  worked.

---

## Self-review against the spec

After completing Tasks 0–10, re-read the extension spec
(`docs/specs/2026-04-23-envato-export-extension.md`) § "Telemetry" and
§ "Phased delivery" Ext.6:

> **Ext.6** — Telemetry: wire every event to `/api/export-events`
> with offline queue.

And the roadmap
(`docs/specs/2026-04-24-export-remaining-roadmap.md`) § "Ext.6 —
Telemetry" / "Key decisions" bullets:

> - `export_started` / `export_completed` carry meaningful `meta` (ok/
>   fail counts, wall seconds, total bytes).
> - `item_failed` MUST carry `error_code` from the fixed enum (15
>   codes in extension spec).
> - If `/api/export-events` 401s, telemetry queue holds events until
>   JWT refresh completes.

Coverage check:

- 10-event enum matches backend's `ALLOWED_EVENTS` → Task 1
  (`TELEMETRY_EVENT_ENUM` in config.js) + Task 2 (drift assert in
  emit). ✓
- In-memory ring buffer + `chrome.storage.local` overflow queue →
  Task 2. ✓
- Exponential-backoff retry on transient failure → Task 3
  (`postSingleEvent` return shapes + `flushNow` backoff loop). ✓
- 500-event hard cap with oldest-drop → Task 2 (`persistAppend`
  shift loop). ✓
- Bearer-JWT attach via `modules/auth.js` → Task 3 (`attachBearer`
  call) + Task 5 (`attachBearer` implementation). ✓
- Respect 401: pause flush until JWT refresh completes → Task 3
  (`pauseForAuthRefresh` flag + `resumeAfterAuthRefresh` eager
  drain) + Task 5 (`onSessionRefreshed` / `emitSessionRefreshed`
  hub + `refreshSessionViaPort` integration). ✓
- `export_started` / `export_completed` carry meaningful meta →
  Task 4 Step 3 (`source_breakdown`) + Task 4 Step 10
  (`ok_count`/`fail_count`/`wall_seconds`/`total_bytes`/`reason`). ✓
- `item_failed` carries `error_code` from the 15-code enum →
  Task 4 Step 7 + Task 8 (`normalizeErrorCode` mapping). ✓
- 10 state transition emit sites in queue.js → Task 4 (11 sites
  actually, because `session_expired` is a side-emit from the
  `envato_session_401` branch of `item_failed`). ✓
- `/api/ext-config` consumption → **deferred to Ext.9** (roadmap
  confirms). ✓
- Opt-out switch → **deferred to Ext.8** (roadmap confirms). ✓

Open risks:

1. **Task 3's transient import gap.** `modules/telemetry.js` imports
   `attachBearer` and `onSessionRefreshed` from `modules/auth.js`, but
   those exports are added in Task 5. Between Task 3's commit and
   Task 5's commit, `node --check telemetry.js` passes (no runtime
   import resolution at check time) but `import('telemetry.js')` from
   a real `auth.js` would fail. The extension is NOT loadable between
   those commits. **Mitigation:** execute Tasks 3→4→5 contiguously; do
   not load the extension unpacked between them. Task 5's commit
   restores loadability.

   Alternative: swap the order (Task 5 → Task 3). The cost is that
   Task 3's flush loop can't be smoke-tested during the between-
   commits window either, but the extension would load. Acceptable
   for executors who prefer tighter loadability. Flagged for the
   reviewer to choose.

2. **`normalizeErrorCode` mapping is conservative for Ext.5 raw
   strings.** In particular `download_failed` maps to `null` (no
   wrong-bucket assignment) and `license_failed` maps to
   `envato_unavailable`. Ext.7's failure-matrix work will make the
   queue emit specific strings (e.g. `envato_403`, `envato_402_tier`,
   `freepik_404`) and the mapper becomes lossless. Ext.6 accepts the
   conservative mapping — the raw string is preserved in
   `meta.raw_error` for admin triage. Not a bug; a known Ext.7 input.

3. **Persistence volume.** A 300-item run emits roughly
   3 + 300 + 300 + 300 + (≤300) = ~1200 events (start + resolved +
   licensed + downloaded + failed + paused/resumed + completed). Each
   event is ~300 bytes serialized. At ~350 KB per run in
   `chrome.storage.local.telemetry_queue`, and the 5 MB per-key limit
   in MV3, a single run fits easily. Even pathologically queued
   10-run backlogs fit under 5 MB. No mitigation needed; flagging for
   posterity if the spec tightens.

4. **Backend dedup.** The `export_events` table has no unique
   constraint; a retry-after-5xx-that-actually-succeeded creates a
   duplicate row. Acceptable per invariant #10. Admin observability
   queries should `DISTINCT ON (export_id, event, item_id, t)` if
   duplicate-sensitive; WebApp.3's admin UI will handle this.

Explicitly deferred (still correct):

- Opt-out switch / diagnostics bundle → Ext.8.
- Per-error retry matrix / deny-list / Freepik TTL refetch → Ext.7.
- `/api/ext-config` consumption / kill switch → Ext.9.
- CI packaging / Web Store submission / soft launch → Ext.10/11/12.

Open questions NOT resolved (expected — not in scope):

- Full failure-code normalization lossless map → Ext.7.
- Admin observability UI → WebApp.3.
- User opt-out UX → Ext.8.

---

## Execution handoff

Plan complete and saved to
`docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md`. One
execution path:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per
task, review between tasks, two-stage (spec + code) review after Tasks
3, 4, and 8 (the three non-trivial ones). Task 9 (manual verification)
blocks on a human to click buttons and query the DB.

**2. Inline Execution** — execute tasks in this session using
`superpowers:executing-plans`, batch-execute with a checkpoint at
Task 4 (queue wiring is the riskiest single change) and at Task 8
(normalizeErrorCode is the spec-compliance linchpin).

Which approach?
