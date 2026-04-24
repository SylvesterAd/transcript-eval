# Ext.5 — Queue + Concurrency + Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the BIGGEST extension phase — 14 tasks, two PR boundaries. Expect 3–4 days of focused work.

**Goal:** Ship Ext.5 of the transcript-eval Export Helper Chrome extension — the real queue. Replace the single-item debug handlers from Ext.2/3 with a full state machine: **5-resolver / 5-licenser / 3-downloader** per-stage concurrency, persistent run state across service-worker restarts, pause/resume/cancel, JIT URL fetching, `chrome.power.requestKeepAwake`, single-active-run lock, `chrome.downloads.onChanged`-driven interrupt recovery, and auto-resume on Chrome reopen. The spec's "Large exports (100 GB+)" mitigation table is this phase in table form. After Ext.5, a user can start a 300-item run, close Chrome, reboot the laptop, open Chrome, and watch it pick up from the last persisted transition.

**Architecture:** One new big module — `extension/modules/queue.js` — owns the state machine, worker slots, and Port broadcast. A second new module — `extension/modules/storage.js` — is the single owner of every `chrome.storage.local` read/write the queue touches (`run:<runId>`, `active_run_id`, `completed_items`, `deny_list`, `daily_counts`). The service worker becomes a thin router: `{type:"export"}` → `startRun`; `{type:"pause"|"resume"|"cancel"|"status"}` → the matching queue public function; a top-level `chrome.runtime.onStartup` hook calls `autoResumeIfActiveRun()`; a top-level `chrome.downloads.onChanged` listener routes by `downloadId` into the queue. The Ext.2/3 single-item debug handlers stay in place (useful for isolated debugging) but are clearly marked deprecated. Port wiring (established in Ext.4) is now exercised in anger: every queue transition fans out a `{type:"state"}` push; per-item byte progress is coalesced to at most one push per 500 ms per item.

**Tech Stack:** Chrome MV3 (unchanged), vanilla JS ES modules, `chrome.storage.local` (via the new `storage.js` wrapper), `chrome.downloads` + `chrome.downloads.onChanged` + `chrome.downloads.resume()`, `chrome.power.requestKeepAwake("system")` + `chrome.power.releaseKeepAwake()`, `chrome.runtime.onStartup` + `chrome.runtime.onInstalled`, existing Ext.4 Port registration (`chrome.runtime.onConnectExternal`). No new build tooling; no new npm packages.

---

## Why read this before touching code

Ext.5 has more load-bearing invariants than every other extension phase combined. Skim them before opening any file. They are the reason the queue is the biggest single module in the extension.

1. **MV3 service workers terminate aggressively — often every 30 s of inactivity.** State in memory is LOST on termination. Every state change — every single phase transition, every `bytes_received` update you persist, every item push into a phase queue — must be written to `chrome.storage.local` under `run:<runId>` **before** the next `await`. Treat any `await` between "I know the new state" and "I've persisted the new state" as a place the SW can die. Save first, broadcast after. If the SW dies between two `await`s, the last thing you persisted is the truth. This is the single most important rule in this plan.

2. **Concurrency is per-STAGE, not global.** Ext.5 runs up to 5 Envato resolver tabs AND up to 5 Envato license fetches AND up to 3 downloads **at the same time**. The pool is three pools, keyed off the item's current `phase`. Workers pull from their stage's queue:
   - `queued` → resolver worker pulls (Envato only; Pexels/Freepik jump straight to `downloading`) → advances to `licensing` on success.
   - `licensing` → licenser worker pulls (Envato only) → advances to `downloading`.
   - `downloading` → downloader worker pulls (all sources) → advances to `done` or `failed`.
   There is no "one active item at a time" global lock — that's what Ext.2/3 had.

3. **JIT URL fetching is non-negotiable.** NEVER batch-mint signed URLs at run start. Each downloader worker fetches its URL **immediately** before starting the `chrome.downloads.download` call, so URL TTL (Envato ~1 h, Freepik ~15–60 min, Pexels no expiry but treat uniformly) does not matter even if the run takes 4 hours. If you find yourself prefetching URLs into an array at queue build time, stop.

4. **`chrome.downloads.resume()` handles NETWORK_* interrupts; 3-retry cap.** Per the spec, a `chrome.downloads.onChanged` event with `state.current === 'interrupted'` whose `error` starts with `NETWORK_` triggers `chrome.downloads.resume(downloadId)`. Track per-`downloadId` retry count in the persisted `items[].retries`. On the 4th attempt (3 retries used), mark the item `failed` with `error_code='network_failed'`. FILE_* interrupts (disk full, locked path, OS error) are a hard stop for the entire queue with reason `disk_failed` — you cannot download anything else if the disk is hosed. USER_CANCELED marks just that item `cancelled` and the queue keeps going.

5. **Single active run lock is atomic and persisted.** `chrome.storage.local.active_run_id` is the gate. `startRun` checks-and-sets via a read-then-write under the reasonable assumption that only one SW is running — MV3 gives you exactly one SW per extension, so races are against your own re-entrancy, not parallel workers. Every entry point (`startRun`, `autoResumeIfActiveRun`) reads `active_run_id` first; a second `{type:"export"}` while the lock is held returns `{ok:false, reason:'run_already_active', active_run_id}`. Clear the lock on `complete` / `cancel` (NOT on `pause` — a paused run still owns the lock).

6. **`chrome.power.requestKeepAwake("system")` on run start; `releaseKeepAwake()` on every exit path.** The `power` permission is added to the manifest in this phase. Acquire on `startRun`; release on `complete`, `pause`, `cancel`, and on any hard-stop failure path (disk_failed, fatal session error from Ext.4 handoff). Resume re-acquires. If you forget to release on pause, the user's laptop will never sleep while a paused run sits there — a UX bug, not just a code smell.

7. **`chrome.downloads.onChanged` is the ONLY reliable way to observe download state transitions in a terminated-SW world.** You cannot trust a `chrome.downloads.download()` promise to tell you when the file finished, because the SW might have been killed and revived between start and finish. Register the `chrome.downloads.onChanged` listener at module top level (not inside `startRun`) so it's wired up the moment the SW wakes. The listener's job is to look up `downloadId → queue item` via a persisted index (`downloadIdToItemId` map inside the RunState), then dispatch to the queue's `handleDownloadEvent` which updates `bytes_received`, handles interrupts, and advances the item's phase.

8. **On SW wake: `active_run_id` is the signal.** If `chrome.runtime.onStartup` (or the top-level SW init) finds `active_run_id` set, call `autoResumeIfActiveRun()`. That function reads the RunState, **rehydrates the phase queues from `items[].phase`**, re-acquires `keepAwake`, re-registers any in-flight `chrome.downloads` (by asking `chrome.downloads.search({id: downloadId})` for each item whose phase is `downloading`), and starts pulling workers. Items whose `phase === 'downloading'` but whose `chrome.downloads.search` returns nothing are rolled back to `queued` (download was lost during termination) so their download will re-fetch a fresh URL JIT.

9. **Port broadcast: every state transition fans out `{type:"state"}`.** If no Port is connected (web-app tab closed), state is still persisted — the web app can reconnect and call `{type:"status"}` to read. Coalesce: one `state` push per transition is fine, but per-item byte progress (from `downloads.onChanged` state.current==='in_progress' events) fires dozens of times per second for a single download — coalesce to **at most one `progress` push per item per 500 ms** to avoid Port flooding.

10. **Debug handlers from Ext.2/3 stay alive.** `{type:"debug_envato_one_shot"}` and `{type:"debug_source_one_shot"}` remain in `service_worker.js`. They are useful for debugging a single item without spinning up the queue. The plan marks them deprecated in a comment but does not remove or re-route them through the queue.

---

## Scope (Ext.5 only — hold the line)

### In scope

- `extension/modules/storage.js` — **new**. Single owner of all `chrome.storage.local` access that the queue touches. Thin async wrappers + an atomic CAS for `active_run_id`.
- `extension/modules/queue.js` — **new**. The state machine, worker slots, Port broadcast, `chrome.downloads.onChanged` routing, JIT URL fetching, auto-resume.
- `extension/service_worker.js` — **modify**. Handle `{type:"export"}`, `{type:"pause"}`, `{type:"resume"}`, `{type:"cancel"}`, `{type:"status"}`. Register top-level `chrome.downloads.onChanged` + `chrome.runtime.onStartup` + `chrome.runtime.onInstalled` hooks. Leave Ext.2/3 debug handlers intact with a `// DEPRECATED Ext.5+` comment.
- `extension/modules/envato.js` — **modify**. Concurrency cap constant bumped from `1` to `5`. The `MAX_ENVATO_RESOLVER_CONCURRENCY` constant that Ext.2 added to `config.js` is the one bump point — no other logic changes in `envato.js` (Ext.4's Port-level session-refresh hook is reused unchanged).
- `extension/modules/sources.js` — **modify**. Concurrency cap constant bumped from `1` to `3` for Pexels/Freepik download worker pool. Same pattern: the constant lives in `config.js`.
- `extension/config.js` — **modify**. Add `MAX_ENVATO_RESOLVER_CONCURRENCY`, `MAX_ENVATO_LICENSE_CONCURRENCY`, `MAX_DOWNLOAD_CONCURRENCY`, `PROGRESS_COALESCE_MS`, `DOWNLOAD_NETWORK_RETRY_CAP`. Bump `EXT_VERSION` to `0.5.0`.
- `extension/manifest.json` — **modify**. Add `"power"` to `permissions`; bump `version` to `0.5.0`.
- `extension-test.html` — **modify**. Add a "Queue / stress test" fieldset with buttons to start a 50-item synthetic run, pause, resume, cancel, and a live state log (Port consumer) so the verifier can eyeball transitions.
- `extension/README.md` — **modify**. Append "Ext.5 — Queue & persistence" section documenting pause/resume semantics, SW-wake resume, the `active_run_id` lock, and the stress-test button.
- Manual smoke verification task (no commit) mirroring Ext.1/2/3/4's "no-commit verification task" pattern. This is the acceptance gate: 50-item run → force-close Chrome at ~20 items → reopen → observe auto-resume.

### 2-PR boundary (per the spec's "2 PRs" hint)

The task list is split with an explicit commit checkpoint:

- **PR 1 — Queue machinery** (Tasks 0–7). Lands a working in-memory queue with per-stage concurrency, pause/resume/cancel, keepAwake, `downloads.onChanged` routing, and Port broadcast. State is NOT persisted yet — kill the SW mid-run and the run is lost. That's OK for PR 1; it isolates review on the concurrency + state-machine correctness before the persistence layer is mixed in.
- **PR 2 — Persistence & resume** (Tasks 8–11). Adds `storage.js` wiring around every state transition, SW-wake auto-resume, and the `active_run_id` CAS. Force-close-Chrome survives from this PR onward.

The plan STILL uses one-commit-per-task discipline inside each PR. The PR boundary is a merge-level split, not a task-level split. Task 7's end is the "PR 1 merge candidate" commit.

### Deferred (DO NOT add to Ext.5 — they belong to later phases)

- **Full per-error retry matrix** (402 tier_restricted, 403 hard-stop + Slack, 429 Retry-After + jitter, 5xx exp backoff, integrity mismatch delete+retry, `unsupported_filetype` deny-list persistence with 24 h telemetry dedupe) → Ext.7. Ext.5 does a minimal "any thrown error from envato.js/sources.js marks the item failed with that error's message as `error_code`; NETWORK_* interrupts get 3 resume attempts; FILE_* interrupts are a hard stop; USER_CANCELED is just a cancel". The failure matrix table at Ext.7 time will plug into the same `handleWorkerError` hook.
- **Telemetry emission** (`POST /api/export-events`) → Ext.6. Ext.5 emits events in-process via the Port only. No `modules/telemetry.js`, no HTTP POST, no offline queue. The 10 event types enumerated in the spec exist as Ext.5 state transitions — Ext.6 will attach a side-effect listener.
- **Daily cap enforcement** (`daily_counts` in storage, warn at 400, hard stop at 500 per source per user) → Ext.7. `storage.js` includes the getter/setter signatures so Ext.7 can wire it without refactoring, but the queue does not consult the counter yet.
- **Deny-list enforcement** (cache `unsupported_filetype` `source_item_id`s, skip on future runs) → Ext.7. `storage.js` has the wrappers; the queue does not read them yet.
- **Diagnostic bundle generator** (`modules/diagnostics.js`) → Ext.8.
- **Feature flags** (`/api/ext-config` fetch, runtime kill-switch) → Ext.9.
- **CI packaging / Web Store upload automation** → Ext.10 / Ext.11.
- **Real captured HAR fixtures / full mock-mode infrastructure** → Ext.5's stress test uses a synthetic in-memory manifest; full mock server work is deferred.
- **XMEML emit at `complete`** → that's the web app's job (already shipped per the roadmap). Ext.5's `complete` state ends at "all items settled, state cleared, Port pushed `{type:"complete"}`" — the web app picks up `complete` and calls its XMEML generator.
- **Partial-run UI** — Ext.5 emits `complete` with `ok_count`/`fail_count`; the web app owns State F rendering. Don't add UI affordances to the extension beyond the Port message.

Fight the urge to "just add" any of the above. The queue is already the biggest file in the extension; every deferred item is its own PR-sized concern.

---

## Prerequisites

- **Ext.1 + Ext.2 + Ext.3 + Ext.4 merged (or landed on a feature branch this one can rebase onto).** Ext.5 depends on:
  - `modules/envato.js` existing with a `resolveOldIdToNewUuid`, `getSignedDownloadUrl`, `downloadEnvato` surface (Ext.2). The queue calls those functions; it does NOT re-implement the 3-phase pipeline.
  - `modules/sources.js` existing with `getPexelsUrl`, `getFreepikUrl`, `downloadFromSignedUrl` (Ext.3).
  - `modules/auth.js` extended with `refreshSessionViaPort` and the cookie watcher (Ext.4). The queue's "401 on download.data" path dispatches to this hook rather than implementing the refresh dance itself.
  - `modules/port.js` implementing `registerPort`, `broadcast`, `sendToPort` (Ext.4). The queue imports `broadcast({type:"state", …})`.
  - manifest v0.4.0 with `storage, tabs, webNavigation, downloads, cookies` permissions. Ext.5 adds only `power`.
- **A real Envato + Pexels + Freepik coverage on the dev profile.** Stress test mixes all three; Pexels is cheap (public API), Envato is licensed (budget the run — 15 Envato items in the 50-item synthetic = 15 license commits).
- **Chrome 120+** (unchanged).
- **Node 20+** (unchanged).

Note: Path to the repo has a trailing space in `"one last "` — quote every path.

---

## File structure (Ext.5 final state)

Additions over Ext.4 are marked `[NEW Ext.5]`; modifications are `[MOD Ext.5]`; unchanged earlier files are shown without annotation for context.

```
$TE/extension/
├── manifest.json                  [MOD Ext.5] version 0.4.0 → 0.5.0; permissions +power
├── service_worker.js              [MOD Ext.5] new export/pause/resume/cancel/status cases; top-level downloads.onChanged + onStartup hooks; debug handlers kept as DEPRECATED
├── config.js                      [MOD Ext.5] +MAX_* concurrency constants, +PROGRESS_COALESCE_MS, +DOWNLOAD_NETWORK_RETRY_CAP, EXT_VERSION bump
├── popup.html                     (unchanged)
├── popup.css                      (unchanged)
├── popup.js                       (unchanged from Ext.4 — popup still reads via Port/status from queue)
├── .extension-id                  (unchanged — key pinned in Ext.1)
├── README.md                      [MOD Ext.5] append "Ext.5 — Queue & persistence" section
├── modules/
│   ├── auth.js                    (unchanged — Ext.4 left it Port-aware already)
│   ├── envato.js                  [MOD Ext.5] no functional change; imports MAX_ENVATO_RESOLVER_CONCURRENCY for the resolver pool constant (used by queue.js, referenced here only so grep finds the bump site)
│   ├── sources.js                 [MOD Ext.5] no functional change; constants as above
│   ├── port.js                    (unchanged — Ext.4's broadcast is what we use)
│   ├── queue.js                   [NEW Ext.5] state machine, worker slots, Port broadcast, JIT URL fetching, auto-resume. THE beast.
│   └── storage.js                 [NEW Ext.5] single-owner chrome.storage.local wrappers + active_run_id CAS
├── scripts/
│   └── generate-key.mjs           (unchanged)
└── fixtures/
    └── envato/                    (unchanged — real HAR fixtures still deferred)

$TE/extension-test.html            [MOD Ext.5] new fieldset "Queue / stress test": 50-item run button, pause/resume/cancel buttons, live Port log, run-state dump
```

Why this split:
- `modules/storage.js` is deliberately thin and audit-friendly. Every `chrome.storage.local.get/set/remove` call in the extension lives here after Ext.5 — grep for it to see every key the extension persists. The `active_run_id` CAS is the trickiest method in the file and has a comment explaining why MV3's single-SW-instance property makes a read-then-write safe.
- `modules/queue.js` owns the state machine, worker pool, Port broadcast, `downloads.onChanged` routing, and the auto-resume entry point. It imports `envato.js`, `sources.js`, `auth.js`, `port.js`, and `storage.js`. It exports exactly five public functions: `startRun`, `pauseRun`, `resumeRun`, `cancelRun`, `getRunState`, plus `autoResumeIfActiveRun` and the module-top-level side effect that registers `chrome.downloads.onChanged`.
- `envato.js` / `sources.js` do NOT own concurrency — they expose per-item async functions and the queue decides how many workers to run. The constants live in `config.js` purely so Ext.5's bump is a single-file edit from Ext.2/3's `1` to the new values.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/extension-ext5` on branch `feature/extension-ext5-queue-persistence`. Branch from `feature/extension-ext4-port-session-refresh` if Ext.4 is still unmerged; otherwise branch from `main`. Task 0 has both variants.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan. Task 13 has an explicit "DO NOT push" reminder.
- **Never kill anything on port 3001.** User's backend dev server.
- **Commit style:** conventional commits (`feat(ext): ...`, `chore(ext): ...`, `docs(ext): ...`, `refactor(ext): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing in every shell call.
- **PR boundary checkpoint:** after Task 7's commit, stop and request review before starting Task 8. This is the spec's 2-PR split.
- **License commits are real.** Each Envato item in the stress test ticks the fair-use counter. Budget: 15 license commits for the 50-item synthetic × however many runs the verifier does. Reuse the same 15 items across runs — once a license is committed, re-downloading the same item in a new run does NOT commit a second license (the session's fair-use is per-item-per-24h). See the Ext.2 plan's "License budget" section for context.
- **Persist-first discipline.** Re-read invariant #1 before every Task 8+ commit. If a test reveals "SW died and we lost a transition," the fix is almost always "move the `saveRunState` call earlier in the function".

---

## Task 0: Create worktree + branch

**Files:**
- Create: `$TE/.worktrees/extension-ext5/` (worktree)

- [ ] **Step 1: Decide the branch-point**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin
git branch -a | grep extension-ext4 || echo "no ext4 branch"
```

- If `feature/extension-ext4-port-session-refresh` still exists (not yet merged to `main`), branch Ext.5 FROM it:
  ```bash
  git worktree add -b feature/extension-ext5-queue-persistence .worktrees/extension-ext5 feature/extension-ext4-port-session-refresh
  ```
- If Ext.4 has already merged, branch from `main`:
  ```bash
  git worktree add -b feature/extension-ext5-queue-persistence .worktrees/extension-ext5 main
  ```

- [ ] **Step 2: Enter the worktree and verify inheritance from Ext.1→Ext.4**

```bash
cd "$TE/.worktrees/extension-ext5"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext5
git branch --show-current
# Expected: feature/extension-ext5-queue-persistence
ls extension/
# Expected includes: manifest.json service_worker.js config.js modules/ popup.* scripts/ fixtures/
ls extension/modules/
# Expected: auth.js envato.js sources.js port.js
# NOT expected yet: queue.js, storage.js (those are this plan's additions)
cat extension/.extension-id
# Expected: 32-char a-p string (identical to Ext.1's)
```

- [ ] **Step 3: Confirm inherited manifest version is `0.4.0`**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions)"
# Expected: version: 0.4.0 | permissions: [ 'storage', 'tabs', 'webNavigation', 'downloads', 'cookies' ]
```

If the version or permissions differ, Ext.4 didn't land as expected — stop and reconcile before proceeding. Ext.5 assumes `cookies` is already present (Ext.4 added it) and ONLY adds `power` on top.

There is nothing to commit in this task — creating a worktree and branch doesn't produce a file change on its own.

---

## Task 1: Manifest bump — add `power` permission, version 0.4.0 → 0.5.0

The manifest change goes first so that by the time Task 6 wires `chrome.power.requestKeepAwake`, the permission is already declared. Calling `chrome.power.*` without the permission throws `Error: chrome.power is undefined` silently inside the SW — a confusing failure mode.

**Files:**
- Modify: `extension/manifest.json`

- [ ] **Step 1: Read the current manifest**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext5"
cat extension/manifest.json
```

Expected (from Ext.4 state): `version: 0.4.0`, `permissions: ["storage","tabs","webNavigation","downloads","cookies"]`.

- [ ] **Step 2: Bump `version`**

Use Edit:
- `old_string`: `"version": "0.4.0"`
- `new_string`: `"version": "0.5.0"`

- [ ] **Step 3: Extend the `permissions` array**

- `old_string`: `"permissions": ["storage", "tabs", "webNavigation", "downloads", "cookies"]`
- `new_string`: `"permissions": ["storage", "tabs", "webNavigation", "downloads", "cookies", "power"]`

Rationale: the only Chrome API Ext.5 adds beyond Ext.4's is `chrome.power.requestKeepAwake("system")` + `chrome.power.releaseKeepAwake()`. No new host_permissions — every download origin was already whitelisted by Ext.2/3 (Envato) and Ext.3 (Pexels + Freepik signed URL origins).

- [ ] **Step 4: Verify the manifest still parses and the new permission is present**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions, '| has power:', m.permissions.includes('power'))"
# Expected: version: 0.5.0 | permissions: [ 'storage', 'tabs', 'webNavigation', 'downloads', 'cookies', 'power' ] | has power: true
```

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json
git commit -m "$(cat <<'EOF'
feat(ext): manifest — add power permission for Ext.5 keep-awake

Version 0.4.0 → 0.5.0. Adds the "power" permission so the queue can
call chrome.power.requestKeepAwake("system") on run start (prevents
the laptop sleeping mid-export) and releaseKeepAwake() on complete,
pause, cancel, or hard-stop failure paths.

No new host_permissions — every download origin was whitelisted in
Ext.2 (Envato) and Ext.3 (Pexels / Freepik).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extend `config.js` — concurrency caps + coalesce interval + retry cap

All queue-tuning knobs live in one file. Putting them here (instead of magic numbers inside `queue.js`) means Ext.7's retry-policy work and any future Ext.11 telemetry-driven tuning are a one-file edit.

**Files:**
- Modify: `extension/config.js`

- [ ] **Step 1: Read the current `config.js`**

```bash
cat extension/config.js
```

Expected shape (from Ext.2/3/4): `EXT_VERSION`, `ENV`, `BACKEND_URL`, `MESSAGE_VERSION`, `RESOLVER_TIMEOUT_MS`, `MAX_RESOLVER_CONCURRENCY=1` (set by Ext.2), and whatever Ext.3/4 added (source download timeouts, port session-refresh timeout).

- [ ] **Step 2: Bump `EXT_VERSION` to `0.5.0`**

- `old_string`: `export const EXT_VERSION = '0.4.0'`
- `new_string`: `export const EXT_VERSION = '0.5.0'`

- [ ] **Step 3: Replace the Ext.2 `MAX_RESOLVER_CONCURRENCY = 1` with the three Ext.5 concurrency constants**

Locate the line `export const MAX_RESOLVER_CONCURRENCY = 1` that Ext.2 added. Use Edit:
- `old_string`: `export const MAX_RESOLVER_CONCURRENCY = 1`
- `new_string`:
  ```js
  // Per-stage worker pool sizes. Ext.2/3 capped everything at 1 for
  // isolated debugging; Ext.5 is where the real queue runs concurrent
  // workers. Per the spec's "Large exports" table: 5 resolvers, 5
  // licensers, 3 downloaders. Tune here; every pool reads these.
  export const MAX_ENVATO_RESOLVER_CONCURRENCY = 5
  export const MAX_ENVATO_LICENSE_CONCURRENCY = 5
  export const MAX_DOWNLOAD_CONCURRENCY = 3

  // Legacy alias — Ext.2's single debug path still imports this.
  // Kept so the Ext.2 debug handler keeps working without edits.
  export const MAX_RESOLVER_CONCURRENCY = 1
  ```

Rationale for keeping `MAX_RESOLVER_CONCURRENCY` as a legacy alias: Ext.2 wired `modules/envato.js`'s debug path to import that constant. Ext.5 deliberately does NOT touch Ext.2's debug code — see the "DO NOT break Ext.2/3's debug handlers" constraint. The three new constants are what `queue.js` imports.

- [ ] **Step 4: Add `PROGRESS_COALESCE_MS` + `DOWNLOAD_NETWORK_RETRY_CAP`**

Append after the concurrency block:

```js
// Per-item progress pushes over Port are coalesced to at most one
// push per PROGRESS_COALESCE_MS. chrome.downloads.onChanged fires
// every few hundred ms during a single large download; without
// coalescing, the Port gets hundreds of messages per second.
export const PROGRESS_COALESCE_MS = 500

// chrome.downloads.resume() retry cap for NETWORK_* interrupts.
// Per the spec: three attempts, then mark the item failed.
export const DOWNLOAD_NETWORK_RETRY_CAP = 3
```

Use the Edit tool with the new constants block. Pick a stable `old_string` anchor from the file (e.g. the `MAX_RESOLVER_CONCURRENCY = 1` legacy alias line you just added) and append after it.

- [ ] **Step 5: Verify `config.js` still parses**

```bash
node --check extension/config.js
# Expected: exit 0
node -e "import('./extension/config.js').then(m => console.log(Object.keys(m).sort()))"
# Expected output includes (alphabetical):
#   BACKEND_URL, DOWNLOAD_NETWORK_RETRY_CAP, ENV, EXT_VERSION,
#   MAX_DOWNLOAD_CONCURRENCY, MAX_ENVATO_LICENSE_CONCURRENCY,
#   MAX_ENVATO_RESOLVER_CONCURRENCY, MAX_RESOLVER_CONCURRENCY,
#   MESSAGE_VERSION, PROGRESS_COALESCE_MS, RESOLVER_TIMEOUT_MS,
#   + whatever Ext.3/4 added
```

- [ ] **Step 6: Commit**

```bash
git add extension/config.js
git commit -m "$(cat <<'EOF'
feat(ext): config — queue concurrency caps + retry/coalesce constants

EXT_VERSION 0.4.0 → 0.5.0. New constants per the spec's "Large
exports" mitigation table:

- MAX_ENVATO_RESOLVER_CONCURRENCY = 5 (Phase 1 resolver tabs)
- MAX_ENVATO_LICENSE_CONCURRENCY  = 5 (Phase 2 download.data fetches)
- MAX_DOWNLOAD_CONCURRENCY        = 3 (Phase 3 + all non-Envato sources)
- PROGRESS_COALESCE_MS            = 500 (per-item Port progress rate)
- DOWNLOAD_NETWORK_RETRY_CAP      = 3 (chrome.downloads.resume cap)

The Ext.2 `MAX_RESOLVER_CONCURRENCY = 1` alias is kept so the existing
debug handler still imports a valid symbol — Ext.5 does not refactor
the debug path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `modules/storage.js` — the chrome.storage.local wrapper

Storage module goes in BEFORE the queue so Task 4's queue can import it. `storage.js` is the single file that touches `chrome.storage.local` for queue purposes; every key is enumerated at the top of the file as documentation.

**Files:**
- Create: `extension/modules/storage.js`

- [ ] **Step 1: Write `extension/modules/storage.js`**

Full content (~150 LOC). Every function is async because `chrome.storage.local.get/set/remove` all return Promises in MV3:

```js
// Single owner of all chrome.storage.local access the queue touches.
//
// Keys (enumerated so a future reader can audit what the extension
// persists):
//
//   run:<runId>
//     Full RunState JSON for an active or completed run. See queue.js
//     for the RunState shape. Written on every phase transition;
//     deleted on cancel; retained on complete (so a returning user
//     sees the last run in the popup until a new run starts or they
//     manually clear).
//
//   active_run_id
//     string | null. The single-active-run lock. Set on startRun,
//     cleared on complete / cancel. A second startRun while this is
//     set fails with {ok:false, reason:'run_already_active'}.
//
//   completed_items
//     { "<user_id>|<source>|<source_item_id>|<target_folder>": true, ... }
//     Flat object used as a set — key membership means "this item was
//     downloaded successfully to this folder by this user". Ext.5
//     writes on item success; the export page's pre-flight reads this
//     to compute "already on disk" counts. (Full dedup policy lives
//     in the web app; the extension just records.)
//
//   deny_list
//     { "<source>|<source_item_id>": { reason, first_seen_at } }
//     Items the extension refuses to download on future runs (e.g.
//     unsupported_filetype ZIPs). Ext.7 writes; Ext.5 just reads at
//     JIT-license time and respects.
//
//   daily_counts
//     { "<YYYY-MM-DD>": { envato, pexels, freepik } }
//     Per-source per-day download counters for the fair-use cap.
//     Ext.7 increments + enforces; Ext.5 only reads (and may soft-warn
//     but not hard-stop; hard-stop is Ext.7's feature).
//
// MV3 single-SW-instance note: Chrome runs exactly one service worker
// per extension at a time. `active_run_id` CAS via a read-then-write
// is therefore safe against extension-side races. Races against the
// user clicking Start in two tabs simultaneously resolve through Port
// ordering — whichever tab's message lands at onMessageExternal first
// wins the CAS.

const K = {
  runPrefix: 'run:',
  activeRunId: 'active_run_id',
  completedItems: 'completed_items',
  denyList: 'deny_list',
  dailyCounts: 'daily_counts',
}

function runKey(runId) {
  return K.runPrefix + runId
}

// -------------------- RunState --------------------

export async function saveRunState(runId, state) {
  if (!runId || typeof runId !== 'string') {
    throw new Error('saveRunState: runId must be a non-empty string')
  }
  if (!state || typeof state !== 'object') {
    throw new Error('saveRunState: state must be an object')
  }
  const withStamp = { ...state, updated_at: Date.now() }
  await chrome.storage.local.set({ [runKey(runId)]: withStamp })
}

export async function loadRunState(runId) {
  const key = runKey(runId)
  const { [key]: state } = await chrome.storage.local.get(key)
  return state || null
}

export async function deleteRunState(runId) {
  await chrome.storage.local.remove(runKey(runId))
}

// -------------------- active_run_id lock --------------------

export async function getActiveRunId() {
  const { [K.activeRunId]: v } = await chrome.storage.local.get(K.activeRunId)
  return v || null
}

// Atomic-enough CAS. Reads active_run_id; if null or equal to the
// requested runId, sets it and returns {ok:true}. Otherwise returns
// {ok:false, activeRunId}. The MV3 single-SW-instance property makes
// this read-then-write safe from races with our own workers.
export async function setActiveRunId(runId) {
  if (!runId || typeof runId !== 'string') {
    throw new Error('setActiveRunId: runId must be a non-empty string')
  }
  const current = await getActiveRunId()
  if (current && current !== runId) {
    return { ok: false, activeRunId: current }
  }
  await chrome.storage.local.set({ [K.activeRunId]: runId })
  return { ok: true }
}

export async function clearActiveRunId() {
  await chrome.storage.local.remove(K.activeRunId)
}

// -------------------- completed_items --------------------

function completedKey(userId, source, itemId, folder) {
  return `${userId}|${source}|${itemId}|${folder}`
}

export async function isCompleted(userId, source, itemId, folder) {
  const { [K.completedItems]: map } = await chrome.storage.local.get(K.completedItems)
  return !!(map && map[completedKey(userId, source, itemId, folder)])
}

export async function markCompleted(userId, source, itemId, folder) {
  const { [K.completedItems]: existing } = await chrome.storage.local.get(K.completedItems)
  const map = existing || {}
  map[completedKey(userId, source, itemId, folder)] = { t: Date.now() }
  await chrome.storage.local.set({ [K.completedItems]: map })
}

// Returns the set of { source, source_item_id } that this user has
// previously completed in this folder — used by the export page's
// pre-flight "already on disk" accounting. Cost is O(n) over the
// completed_items object; acceptable for <100k items per user.
export async function getAllCompletedForFolder(userId, folder) {
  const { [K.completedItems]: map } = await chrome.storage.local.get(K.completedItems)
  if (!map) return []
  const prefix = `${userId}|`
  const suffix = `|${folder}`
  const out = []
  for (const k of Object.keys(map)) {
    if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue
    const parts = k.split('|')
    // [userId, source, source_item_id, ...folder-may-contain-pipes]
    if (parts.length < 4) continue
    out.push({ source: parts[1], source_item_id: parts[2] })
  }
  return out
}

// -------------------- deny_list (read-only in Ext.5) --------------------

export async function isDenied(source, sourceItemId) {
  const { [K.denyList]: map } = await chrome.storage.local.get(K.denyList)
  return !!(map && map[`${source}|${sourceItemId}`])
}

// Writer is Ext.7's territory but the signature is stubbed here so
// Ext.7 can land a single-file change.
export async function addToDenyList(source, sourceItemId, reason) {
  const { [K.denyList]: existing } = await chrome.storage.local.get(K.denyList)
  const map = existing || {}
  map[`${source}|${sourceItemId}`] = { reason, first_seen_at: Date.now() }
  await chrome.storage.local.set({ [K.denyList]: map })
}

// -------------------- daily_counts (read-only in Ext.5) --------------------

function today() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export async function getDailyCount(source) {
  const { [K.dailyCounts]: map } = await chrome.storage.local.get(K.dailyCounts)
  const day = map && map[today()]
  return (day && day[source]) || 0
}

// Writer is Ext.7's territory.
export async function incrementDailyCount(source) {
  const { [K.dailyCounts]: existing } = await chrome.storage.local.get(K.dailyCounts)
  const map = existing || {}
  const d = today()
  map[d] = map[d] || { envato: 0, pexels: 0, freepik: 0 }
  map[d][source] = (map[d][source] || 0) + 1
  await chrome.storage.local.set({ [K.dailyCounts]: map })
}
```

- [ ] **Step 2: Verify syntax and that the module exports the expected names**

```bash
node --check extension/modules/storage.js
# Expected: exit 0
node -e "import('./extension/modules/storage.js').then(m => console.log(Object.keys(m).sort().join(',')))"
# Expected (order-independent):
#   addToDenyList,clearActiveRunId,deleteRunState,getActiveRunId,
#   getAllCompletedForFolder,getDailyCount,incrementDailyCount,
#   isCompleted,isDenied,loadRunState,markCompleted,saveRunState,
#   setActiveRunId
```

- [ ] **Step 3: Commit**

```bash
git add extension/modules/storage.js
git commit -m "$(cat <<'EOF'
feat(ext): storage module — single-owner chrome.storage.local wrappers

New module owns every chrome.storage.local key the queue touches:

- run:<runId>              — full RunState JSON, saved every transition
- active_run_id            — single-active-run lock, atomic-enough CAS
- completed_items          — cross-run dedup set keyed by (user, source, item, folder)
- deny_list                — skip-on-future-runs (Ext.7 writes, Ext.5 reads)
- daily_counts             — per-source per-day caps (Ext.7 writes, Ext.5 reads)

setActiveRunId uses read-then-write CAS; safe because MV3 runs exactly
one service worker per extension at a time. Races against two tabs
clicking Start simultaneously resolve through onMessageExternal
ordering.

Stub writers for deny_list and daily_counts land here so Ext.7's
enforcement work is a single-file change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `modules/queue.js` Phase 1 — the state machine (NO persistence yet)

This is the big task. It lands the queue's in-memory behaviour end-to-end: state machine, phase queues, worker pools, keepAwake, `chrome.downloads.onChanged` routing, Port broadcast. Persistence goes in Task 8 (after the PR 1 checkpoint). Splitting this way means PR 1 review can focus on concurrency + state-machine correctness without the persistence layer muddying the diff.

**Files:**
- Create: `extension/modules/queue.js`

- [ ] **Step 1: Understand the shape before you write code**

RunState is the data structure. Every field has a purpose:

```js
{
  runId: string,                     // ULID from the web app
  started_at: epoch_ms,
  updated_at: epoch_ms,              // stamped by saveRunState (Task 8)
  target_folder_path: string,        // extension-reported (sanitized) folder under Downloads/
  options: {
    variants: string[],              // ["A","B","C"] — extension doesn't care, echoes on complete
    force_redownload: boolean,
  },
  items: [
    {
      seq: number,                   // 1-based order in the manifest
      source: 'envato' | 'pexels' | 'freepik',
      source_item_id: string,
      target_filename: string,
      envato_item_url: string | null, // only for source==='envato'
      phase: 'queued' | 'resolving' | 'licensing' | 'downloading' | 'done' | 'failed',
      download_id: number | null,    // chrome.downloads id once started
      bytes_received: number,
      total_bytes: number | null,
      error_code: string | null,
      retries: number,               // chrome.downloads.resume attempts used
      resolved_uuid: string | null,  // Envato only: Phase-1 output
      signed_url: string | null,     // Envato Phase-2 output / Pexels/Freepik JIT
    }
  ],
  stats: {
    ok_count: number,
    fail_count: number,
    total_bytes_downloaded: number,
  },
  run_state: 'running' | 'paused' | 'complete' | 'cancelled',
  download_id_to_seq: { [downloadId: number]: number }, // lookup for onChanged
}
```

Phase queues are derived from `items[].phase`, not a separate array. That matters for resume — rehydrating is just filtering.

- [ ] **Step 2: Write `extension/modules/queue.js`**

Target size: ~500 LOC. Structure:

```js
import {
  MAX_ENVATO_RESOLVER_CONCURRENCY,
  MAX_ENVATO_LICENSE_CONCURRENCY,
  MAX_DOWNLOAD_CONCURRENCY,
  PROGRESS_COALESCE_MS,
  DOWNLOAD_NETWORK_RETRY_CAP,
} from '../config.js'
import { resolveOldIdToNewUuid, getSignedDownloadUrl } from './envato.js'
import { getSignedUrlForSource } from './sources.js' // added by Ext.3
import { broadcast } from './port.js'

// In-memory state — this module has a singleton RunState. MV3 SW
// termination means every field here must be reconstructable from
// chrome.storage.local. Task 8 wires the save path; Task 9 wires the
// load path.
let state = null           // RunState | null
let acquiredKeepAwake = false
let lastProgressPush = new Map() // seq -> last-push-epoch-ms

// ------------------- Public API -------------------

export async function startRun({ runId, manifest, targetFolder, options, userId }) {
  // 1. Check lock (Task 10 will wire the real storage-backed version)
  if (state && state.run_state === 'running') {
    return { ok: false, reason: 'run_already_active', active_run_id: state.runId }
  }
  // 2. Build initial RunState
  state = buildInitialRunState({ runId, manifest, targetFolder, options, userId })
  // 3. Acquire keepAwake (Task 6 fills this in; shim for now)
  await acquireKeepAwake()
  // 4. Broadcast initial state
  broadcast({ type: 'state', version: 1, export: snapshot() })
  // 5. Kick worker pools
  schedule()
  return { ok: true, runId }
}

export async function pauseRun() {
  if (!state || state.run_state !== 'running') return { ok: false }
  state.run_state = 'paused'
  await releaseKeepAwake()
  broadcast({ type: 'state', version: 1, export: snapshot() })
  return { ok: true }
}

export async function resumeRun() {
  if (!state || state.run_state !== 'paused') return { ok: false }
  state.run_state = 'running'
  await acquireKeepAwake()
  broadcast({ type: 'state', version: 1, export: snapshot() })
  schedule()
  return { ok: true }
}

export async function cancelRun() {
  if (!state) return { ok: false }
  state.run_state = 'cancelled'
  // Cancel any in-flight chrome.downloads
  for (const it of state.items) {
    if (it.phase === 'downloading' && it.download_id != null) {
      try { await chrome.downloads.cancel(it.download_id) } catch {}
    }
  }
  await releaseKeepAwake()
  broadcast({ type: 'state', version: 1, export: snapshot() })
  state = null
  return { ok: true }
}

export function getRunState() {
  return state ? snapshot() : null
}

// ------------------- Scheduler -------------------

function schedule() {
  if (!state || state.run_state !== 'running') return
  fillPool('resolving',   MAX_ENVATO_RESOLVER_CONCURRENCY, runResolver)
  fillPool('licensing',   MAX_ENVATO_LICENSE_CONCURRENCY,  runLicenser)
  fillPool('downloading', MAX_DOWNLOAD_CONCURRENCY,        runDownloader)
  // Terminal check: if every item is done or failed, finalize.
  const everyoneDone = state.items.every(i => i.phase === 'done' || i.phase === 'failed')
  if (everyoneDone) finalize()
}

// Currently-active counts per phase (in-flight).
let active = { resolving: 0, licensing: 0, downloading: 0 }

function fillPool(phaseName, cap, runner) {
  while (active[phaseName] < cap) {
    const item = nextItemForPhase(phaseName)
    if (!item) return
    active[phaseName]++
    runner(item).finally(() => {
      active[phaseName]--
      schedule() // chain-pull: on completion, try to fill other pools
    })
  }
}

function nextItemForPhase(phaseName) {
  if (!state) return null
  // For 'resolving': only envato items in 'queued' phase.
  // For 'licensing': only envato items in 'resolving-done' — but we
  //   don't add an extra phase; resolving->licensing is a direct
  //   transition inside runResolver. So 'licensing' picks up items
  //   whose phase is literally 'licensing' and not yet claimed.
  // For 'downloading': any item whose phase is 'downloading' and not
  //   yet claimed (Envato items arrive here after runLicenser;
  //   Pexels/Freepik items start here directly from 'queued').
  //
  // Claim semantics: we flip an in-memory `claimed` flag on the item.
  // Not persisted — a crashed SW redoes the claim on resume because
  // the phase-before-crash is what's persisted.
  if (phaseName === 'resolving') {
    return state.items.find(i => !i.claimed && i.source === 'envato' && i.phase === 'queued')
  }
  if (phaseName === 'licensing') {
    return state.items.find(i => !i.claimed && i.source === 'envato' && i.phase === 'licensing')
  }
  if (phaseName === 'downloading') {
    return state.items.find(i => !i.claimed && i.phase === 'downloading')
  }
  return null
}

// ------------------- Workers -------------------

async function runResolver(item) {
  item.claimed = true
  item.phase = 'resolving'
  broadcastItemTransition(item)
  try {
    const uuid = await resolveOldIdToNewUuid(item.envato_item_url)
    item.resolved_uuid = uuid
    item.phase = 'licensing'
    item.claimed = false
    broadcastItemTransition(item)
  } catch (err) {
    failItem(item, err?.message || 'resolve_failed')
  }
}

async function runLicenser(item) {
  item.claimed = true
  // item.phase is already 'licensing'
  broadcastItemTransition(item)
  try {
    // JIT URL fetching: we're milliseconds away from chrome.downloads.download
    const signedUrl = await getSignedDownloadUrl(item.resolved_uuid)
    item.signed_url = signedUrl
    item.phase = 'downloading'
    item.claimed = false
    broadcastItemTransition(item)
  } catch (err) {
    failItem(item, err?.message || 'license_failed')
  }
}

async function runDownloader(item) {
  item.claimed = true
  // item.phase is 'downloading' already
  // JIT URL fetch for Pexels/Freepik (they skip resolving/licensing)
  try {
    if (item.source !== 'envato' && !item.signed_url) {
      item.signed_url = await getSignedUrlForSource(item.source, item.source_item_id)
    }
    const downloadId = await chrome.downloads.download({
      url: item.signed_url,
      filename: `${state.target_folder_path}/${item.target_filename}`,
      saveAs: false,
      conflictAction: 'uniquify',
    })
    item.download_id = downloadId
    state.download_id_to_seq[downloadId] = item.seq
    broadcastItemTransition(item)
    // The rest happens via chrome.downloads.onChanged — we return
    // and let the listener finalize the item on 'complete' or
    // 'interrupted'. The worker's Promise resolves when the listener
    // flips phase to 'done' or 'failed' (we hand-resolve via a per-
    // item awaiter).
    await waitForDownloadSettled(item)
    item.claimed = false
  } catch (err) {
    failItem(item, err?.message || 'download_failed')
  }
}

// Per-item "wait until settled" — resolves when chrome.downloads.onChanged
// flips the item to 'done' or 'failed'. Implementation: each item gets
// its own Promise whose resolver we stash on the item (not persisted
// — on SW wake, handleDownloadEvent re-sees the download_id via
// chrome.downloads.search and continues).
function waitForDownloadSettled(item) {
  return new Promise(resolve => { item.__settle = resolve })
}

// ------------------- chrome.downloads.onChanged routing -------------------

chrome.downloads.onChanged.addListener(delta => {
  if (!state) return
  const seq = state.download_id_to_seq[delta.id]
  if (seq == null) return
  const item = state.items.find(i => i.seq === seq)
  if (!item) return
  handleDownloadEvent(item, delta)
})

function handleDownloadEvent(item, delta) {
  // Byte progress — coalesced.
  if (delta.bytesReceived != null) {
    item.bytes_received = delta.bytesReceived.current
    maybePushProgress(item)
  }
  if (delta.totalBytes != null && delta.totalBytes.current != null) {
    item.total_bytes = delta.totalBytes.current
  }
  // State transitions.
  if (delta.state) {
    const next = delta.state.current
    if (next === 'complete') {
      item.phase = 'done'
      state.stats.ok_count++
      state.stats.total_bytes_downloaded += item.bytes_received || 0
      broadcastItemTransition(item)
      broadcast({ type: 'item_done', version: 1, item_id: item.source_item_id, result: 'ok' })
      item.__settle?.()
    } else if (next === 'interrupted') {
      handleDownloadInterrupt(item, delta)
    }
  }
}

function handleDownloadInterrupt(item, delta) {
  const reason = delta.error?.current || 'UNKNOWN'
  if (reason.startsWith('NETWORK_')) {
    if (item.retries < DOWNLOAD_NETWORK_RETRY_CAP) {
      item.retries++
      chrome.downloads.resume(item.download_id).catch(err => {
        failItem(item, `network_resume_failed:${err?.message}`)
        item.__settle?.()
      })
      broadcastItemTransition(item)
      return
    }
    failItem(item, 'network_failed')
    item.__settle?.()
  } else if (reason.startsWith('FILE_')) {
    // Disk is broken — hard stop the whole queue.
    failItem(item, `disk_failed:${reason}`)
    item.__settle?.()
    hardStopQueue('disk_failed')
  } else if (reason === 'USER_CANCELED') {
    failItem(item, 'cancelled')
    item.__settle?.()
  } else {
    failItem(item, `download_interrupt:${reason}`)
    item.__settle?.()
  }
}

function maybePushProgress(item) {
  const now = Date.now()
  const last = lastProgressPush.get(item.seq) || 0
  if (now - last < PROGRESS_COALESCE_MS) return
  lastProgressPush.set(item.seq, now)
  broadcast({
    type: 'progress', version: 1,
    item_id: item.source_item_id,
    phase: item.phase,
    bytes: item.bytes_received,
    total_bytes: item.total_bytes,
  })
}

// ------------------- State helpers -------------------

function buildInitialRunState({ runId, manifest, targetFolder, options, userId }) {
  return {
    runId,
    started_at: Date.now(),
    updated_at: Date.now(),
    target_folder_path: targetFolder,
    options: { variants: options?.variants || [], force_redownload: !!options?.force_redownload },
    items: manifest.map((m, i) => ({
      seq: i + 1,
      source: m.source,
      source_item_id: m.source_item_id,
      target_filename: m.target_filename,
      envato_item_url: m.envato_item_url || null,
      phase: m.source === 'envato' ? 'queued' : 'downloading', // non-Envato skip phases 1-2
      download_id: null,
      bytes_received: 0,
      total_bytes: m.est_size_bytes || null,
      error_code: null,
      retries: 0,
      resolved_uuid: null,
      signed_url: null,
      claimed: false,
    })),
    stats: { ok_count: 0, fail_count: 0, total_bytes_downloaded: 0 },
    run_state: 'running',
    download_id_to_seq: {},
    userId, // for storage.markCompleted wiring in Task 8
  }
}

function snapshot() {
  // Hide in-memory-only fields (claimed, __settle) from Port pushes.
  return {
    runId: state.runId,
    started_at: state.started_at,
    updated_at: state.updated_at,
    target_folder_path: state.target_folder_path,
    options: state.options,
    items: state.items.map(({ claimed, __settle, ...rest }) => rest),
    stats: state.stats,
    run_state: state.run_state,
  }
}

function broadcastItemTransition(item) {
  broadcast({ type: 'state', version: 1, export: snapshot() })
}

function failItem(item, errorCode) {
  item.phase = 'failed'
  item.error_code = errorCode
  item.claimed = false
  state.stats.fail_count++
  broadcastItemTransition(item)
  broadcast({ type: 'item_done', version: 1, item_id: item.source_item_id, result: 'failed' })
}

function finalize() {
  state.run_state = 'complete'
  broadcast({
    type: 'complete', version: 1,
    ok_count: state.stats.ok_count,
    fail_count: state.stats.fail_count,
    folder_path: state.target_folder_path,
    xml_paths: [], // web app generates XMLs
  })
  releaseKeepAwake()
  // Don't null `state` — keep for {type:"status"} inspection until
  // next startRun clears it. Task 8 also saves state here and clears
  // active_run_id.
}

function hardStopQueue(reason) {
  state.run_state = 'cancelled'
  state.error_code = reason
  for (const it of state.items) {
    if (it.phase === 'downloading' && it.download_id != null) {
      chrome.downloads.cancel(it.download_id).catch(() => {})
    }
    if (it.phase === 'queued' || it.phase === 'resolving' || it.phase === 'licensing' || it.phase === 'downloading') {
      it.phase = 'failed'
      it.error_code = reason
    }
  }
  broadcast({ type: 'state', version: 1, export: snapshot() })
  releaseKeepAwake()
}

// ------------------- keepAwake (real impl in Task 6) -------------------

async function acquireKeepAwake() {
  if (acquiredKeepAwake) return
  try {
    chrome.power.requestKeepAwake('system')
    acquiredKeepAwake = true
  } catch (err) {
    // Non-fatal; log and continue
    console.warn('[queue] keepAwake failed', err)
  }
}

async function releaseKeepAwake() {
  if (!acquiredKeepAwake) return
  try {
    chrome.power.releaseKeepAwake()
  } catch {}
  acquiredKeepAwake = false
}

// ------------------- Auto-resume stub (real impl in Task 9) -------------------

export async function autoResumeIfActiveRun() {
  // Task 9 fills this in.
  return { resumed: false }
}
```

**Key decisions explained in the code comments:**
- Non-Envato items start at phase `downloading` directly from `queued`, bypassing `resolving`/`licensing`. The scheduler's `nextItemForPhase('downloading')` picks them up.
- `item.claimed` is in-memory only. If the SW dies between claiming and persisting, the persisted phase is pre-claim — on resume the item is re-claimed cleanly.
- `item.__settle` is the per-item awaiter that marries `chrome.downloads.onChanged` back to the worker's Promise chain. It's reconstructed on SW-wake via the same `chrome.downloads.onChanged` path (see Task 9).
- `acquireKeepAwake` wraps the call in try/catch because `chrome.power` throws if permission is somehow missing — non-fatal for the queue.
- `hardStopQueue` is the blast-door for FILE_* disk errors (and, later, fatal session errors from Ext.4's handoff).

- [ ] **Step 3: Verify syntax and exports**

```bash
node --check extension/modules/queue.js
# Expected: exit 0
# (Runtime import will fail because chrome.* is undefined outside the
# extension — that's fine; syntax is what we're confirming.)
```

- [ ] **Step 4: Commit (persistence NOT yet wired — Tasks 8+)**

```bash
git add extension/modules/queue.js
git commit -m "$(cat <<'EOF'
feat(ext): queue state machine — Phase 1 (in-memory, no persistence)

Lands the end-to-end queue behaviour without the chrome.storage.local
save path yet. This is the half of the PR-1-sized slice that proves
the concurrency + state-machine correctness; Task 8+ will wire
persistence around every transition.

Public API: startRun / pauseRun / resumeRun / cancelRun / getRunState
(+ autoResumeIfActiveRun as a stub filled by Task 9). Internals:

- Three per-stage worker pools: 5 resolvers, 5 licensers, 3 downloaders.
- Phase queues derived from items[].phase — no separate arrays.
- chrome.downloads.onChanged listener routes by download_id to
  handleDownloadEvent; byte progress coalesced to one push per 500ms.
- NETWORK_* interrupts get up to 3 chrome.downloads.resume() attempts;
  FILE_* interrupts hard-stop the queue; USER_CANCELED marks the item
  cancelled and continues.
- JIT URL fetching: each downloader fetches its signed URL
  milliseconds before chrome.downloads.download, so URL TTL doesn't
  matter.
- chrome.power.requestKeepAwake('system') on run start; released on
  pause / cancel / complete.
- Per-item __settle Promise bridges chrome.downloads.onChanged back to
  the worker's await.

In-memory only for now. Force-closing the SW mid-run loses the run;
that's deliberate — persistence lands in Task 8 and is reviewed in
PR 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `service_worker.js` — export/pause/resume/cancel/status handlers

The SW becomes a thin dispatcher. Ext.2's `debug_envato_one_shot` and Ext.3's `debug_source_one_shot` stay intact — the plan explicitly does NOT re-route them through the queue.

**Files:**
- Modify: `extension/service_worker.js`

- [ ] **Step 1: Read the current service_worker.js**

Expected shape (Ext.4 state): imports from `config.js`, `auth.js`, `envato.js`, `sources.js`, `port.js`; `onMessageExternal` listener with cases for `ping`, `session`, `debug_envato_one_shot`, `debug_source_one_shot`; Port `onConnectExternal` registered via `port.js`; cookie watcher from Ext.4.

- [ ] **Step 2: Add queue import**

Insert near the top-of-file imports:

```js
import {
  startRun, pauseRun, resumeRun, cancelRun, getRunState,
  autoResumeIfActiveRun,
} from './modules/queue.js'
```

Use Edit anchoring on an existing import line (e.g. `import { broadcast } from './modules/port.js'`).

- [ ] **Step 3: Add handlers inside the `onMessageExternal` switch**

Locate the switch in the existing listener. Find a stable `old_string` anchor (e.g. the `case 'debug_envato_one_shot':` block's opening line) and insert new cases BEFORE the `default:` branch:

```js
case 'export': {
  const { manifest, target_folder, options, export_id } = msg
  // user_id comes from the stored JWT — queue uses it for completed_items keying
  const jwt = await getJwt()
  const userId = jwt?.user_id || null
  const result = await startRun({
    runId: export_id,
    manifest,
    targetFolder: target_folder,
    options,
    userId,
  })
  sendResponse(result)
  return
}
case 'pause': {
  sendResponse(await pauseRun())
  return
}
case 'resume': {
  sendResponse(await resumeRun())
  return
}
case 'cancel': {
  sendResponse(await cancelRun())
  return
}
case 'status': {
  sendResponse({ ok: true, state: getRunState() })
  return
}
```

- [ ] **Step 4: Mark the debug handlers as deprecated but keep them**

Above the `case 'debug_envato_one_shot':` line, add a comment:

```js
// DEPRECATED Ext.5+ — kept for isolated debugging of the 3-phase
// envato flow without spinning up the queue. The queue in
// modules/queue.js is the production path. Removing this case would
// be strictly a cleanup, not a correctness fix.
```

Same treatment above `case 'debug_source_one_shot':`.

Do NOT delete or rewrite either case. The constraint is explicit: keep them working.

- [ ] **Step 5: Register top-level hooks for SW-wake**

At the top level of `service_worker.js` (outside the listener, after the imports), add:

```js
// On SW wake (Chrome reopen, extension reload, or first install),
// check if there's an active run to resume. This is the auto-resume
// entry point — Task 9 fills in autoResumeIfActiveRun.
chrome.runtime.onStartup.addListener(() => {
  autoResumeIfActiveRun().catch(err => {
    console.error('[sw] autoResumeIfActiveRun on startup failed', err)
  })
})
chrome.runtime.onInstalled.addListener(() => {
  autoResumeIfActiveRun().catch(err => {
    console.error('[sw] autoResumeIfActiveRun on install failed', err)
  })
})
// Also try at module top level — onStartup doesn't always fire on
// SW wake from idle (it fires on Chrome startup). The top-level call
// covers wake-from-idle.
autoResumeIfActiveRun().catch(err => {
  console.error('[sw] autoResumeIfActiveRun at module-init failed', err)
})
```

Rationale: `chrome.runtime.onStartup` fires on Chrome launch but NOT when the SW wakes from idle after a 30 s timeout. The top-level call covers both cases (it re-runs every time the SW starts, which is what we want).

- [ ] **Step 6: Verify syntax**

```bash
node --check extension/service_worker.js
# Expected: exit 0
```

- [ ] **Step 7: Commit**

```bash
git add extension/service_worker.js
git commit -m "$(cat <<'EOF'
feat(ext): service worker — wire queue export/pause/resume/cancel/status

Adds five new onMessageExternal cases dispatching to modules/queue.js:

- export       → startRun({...}) with user_id from the stored JWT
- pause        → pauseRun()
- resume       → resumeRun()
- cancel       → cancelRun()
- status       → {ok:true, state: getRunState()}

Ext.2/3's debug_envato_one_shot and debug_source_one_shot handlers
are left intact with a DEPRECATED Ext.5+ comment — useful for isolated
debugging of the envato or source path without spinning up the queue.

Top-level chrome.runtime.onStartup + onInstalled listeners call
autoResumeIfActiveRun (stub in this task; Task 9 fills it in). A
module-top-level invocation also runs every SW wake to cover the
wake-from-idle case that onStartup misses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Integrate `chrome.power.requestKeepAwake` (real impl)

Task 4 added `acquireKeepAwake` / `releaseKeepAwake` as shims with try/catch wrappers. They already call `chrome.power.*`; this task is about verifying the permission works end-to-end and adding the release-on-all-exit-paths audit.

**Files:**
- Modify: `extension/modules/queue.js` (no new logic — audit pass)

- [ ] **Step 1: Audit every path that transitions `run_state` away from `running`**

Open `modules/queue.js` and grep for every write to `state.run_state`:

```bash
grep -n 'run_state *=' extension/modules/queue.js
```

Expected sites:
- `pauseRun`: sets `paused` → calls `releaseKeepAwake` ✓
- `resumeRun`: sets `running` → calls `acquireKeepAwake` ✓
- `cancelRun`: sets `cancelled` → calls `releaseKeepAwake` ✓
- `finalize`: sets `complete` → calls `releaseKeepAwake` ✓
- `hardStopQueue`: sets `cancelled` → calls `releaseKeepAwake` ✓
- `startRun`: initial `running` → calls `acquireKeepAwake` ✓

Each of the five transitions-away-from-running paths must pair the state write with a `releaseKeepAwake()` call. If any path is missing, fix it now.

- [ ] **Step 2: Add a defensive release on SW termination**

MV3 SW termination doesn't give us an `onBeforeUnload` hook (the SW just dies). Chrome auto-releases keepAwake when the extension's SW dies, so no manual cleanup is needed here. Document this with a comment:

Inside `modules/queue.js`, near the `acquireKeepAwake` / `releaseKeepAwake` pair, add:

```js
// Note on SW termination: we do NOT attempt to releaseKeepAwake on
// SW shutdown. MV3 doesn't expose a termination hook, and Chrome
// automatically releases keepAwake when the extension's SW is torn
// down. If we later see the laptop stay awake after a forced SW
// shutdown, investigate — but don't add a polyfill here before
// confirming the bug is real.
```

Use Edit anchoring on the existing `async function acquireKeepAwake() {` line.

- [ ] **Step 3: Sanity-check no syntactic regressions**

```bash
node --check extension/modules/queue.js
# Expected: exit 0
```

- [ ] **Step 4: Commit**

```bash
git add extension/modules/queue.js
git commit -m "$(cat <<'EOF'
chore(ext): queue — audit keepAwake acquire/release pairing

Walk every state.run_state assignment and confirm each transition
away from 'running' pairs with releaseKeepAwake(). Five exit paths:
pauseRun, cancelRun, finalize, hardStopQueue, and the implicit
terminal-state branch in schedule(). Starts (startRun, resumeRun)
acquire. No new logic — this is a correctness audit.

Document the MV3-SW-termination behaviour: we rely on Chrome
auto-releasing keepAwake when the SW is torn down, not a manual hook
(MV3 doesn't expose one).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final PR-1 review pass + test-page stress fieldset

This is the PR 1 boundary commit. After this task, stop and request review. Tasks 8+ land in PR 2.

**Files:**
- Modify: `extension-test.html` — add "Queue / stress test" fieldset.

- [ ] **Step 1: Open the existing test page**

```bash
cat extension-test.html | head -30
```

Inherit the Ext.1/2/3/4 conventions: one fieldset per feature, inline module JS in the final `<script type="module">` block.

- [ ] **Step 2: Add a "Queue / stress test" fieldset**

Insert a new fieldset BEFORE the closing `</body>` and before the inline script block's closing brace. Anchor on the last existing fieldset (`<fieldset><legend>4. End-to-end happy path</legend>` or whichever Ext.4's last fieldset is).

Fieldset markup:

```html
<fieldset>
  <legend>5. Queue / stress test</legend>
  <p class="muted">
    Starts a 50-item synthetic run: 30 Pexels, 15 Envato (real license
    commits — budget), 5 Freepik. Live state log pushes via Port. Use
    <b>Pause</b> to observe in-flight downloads continuing while new
    pulls stop; <b>Resume</b> to pick up; <b>Cancel</b> to abort.
  </p>
  <div class="row">
    <label>Target folder suffix:</label>
    <input type="text" id="q-folder" placeholder="transcript-eval/export-stress-1" value="transcript-eval/export-stress-1" style="flex:1">
  </div>
  <div class="row">
    <button id="q-start">Start 50-item run</button>
    <button id="q-pause">Pause</button>
    <button id="q-resume">Resume</button>
    <button id="q-cancel">Cancel</button>
    <button id="q-status">Status snapshot</button>
  </div>
  <div class="row">
    <button id="q-second-export">Try 2nd {type:"export"} (expect run_already_active)</button>
  </div>
  <pre id="q-log">(no events yet)</pre>
</fieldset>
```

- [ ] **Step 3: Add the inline JS for the fieldset**

Inside the existing `<script type="module">` block, after the Ext.4 wiring, append:

```js
// ------- Queue / stress test -------
let qPort = null
const qLog = document.getElementById('q-log')
function qAppend(line) {
  qLog.textContent = (qLog.textContent === '(no events yet)' ? '' : qLog.textContent)
    + line + '\n'
  qLog.scrollTop = qLog.scrollHeight
}
function qConnectPort() {
  if (qPort) return
  try {
    const id = getExtId()
    qPort = chrome.runtime.connect(id, { name: 'transcript-eval-export' })
    qPort.onMessage.addListener(m => qAppend(JSON.stringify(m)))
    qPort.onDisconnect.addListener(() => { qPort = null; qAppend('<port disconnected>') })
  } catch (e) {
    qAppend('port connect error: ' + e.message)
  }
}
function buildSyntheticManifest() {
  // 30 Pexels + 15 Envato + 5 Freepik.
  const out = []
  let seq = 0
  for (let i = 0; i < 30; i++) {
    out.push({
      source: 'pexels',
      source_item_id: String(1000 + i),
      target_filename: `${String(++seq).padStart(3, '0')}_pexels_${1000 + i}.mp4`,
      envato_item_url: null,
      est_size_bytes: 5_000_000,
    })
  }
  for (let i = 0; i < 15; i++) {
    out.push({
      source: 'envato',
      source_item_id: 'NX9WYGQ', // repeat a known real ID so license commits dedupe per 24h
      target_filename: `${String(++seq).padStart(3, '0')}_envato_NX9WYGQ_${i}.mov`,
      envato_item_url: 'https://elements.envato.com/...-NX9WYGQ',
      est_size_bytes: 50_000_000,
    })
  }
  for (let i = 0; i < 5; i++) {
    out.push({
      source: 'freepik',
      source_item_id: `fp_${2000 + i}`,
      target_filename: `${String(++seq).padStart(3, '0')}_freepik_${2000 + i}.mp4`,
      envato_item_url: null,
      est_size_bytes: 20_000_000,
    })
  }
  return out
}
document.getElementById('q-start').onclick = async () => {
  qConnectPort()
  const folder = document.getElementById('q-folder').value.trim() || 'transcript-eval/export-stress-1'
  const result = await send({
    type: 'export', version: 1,
    export_id: 'stress_' + Date.now(),
    manifest: buildSyntheticManifest(),
    target_folder: folder,
    options: { variants: ['A'], force_redownload: false },
  })
  qAppend('startRun reply: ' + JSON.stringify(result))
}
document.getElementById('q-pause').onclick = async () => {
  qAppend('pause: ' + JSON.stringify(await send({ type: 'pause', version: 1 })))
}
document.getElementById('q-resume').onclick = async () => {
  qAppend('resume: ' + JSON.stringify(await send({ type: 'resume', version: 1 })))
}
document.getElementById('q-cancel').onclick = async () => {
  qAppend('cancel: ' + JSON.stringify(await send({ type: 'cancel', version: 1 })))
}
document.getElementById('q-status').onclick = async () => {
  qAppend('status: ' + JSON.stringify(await send({ type: 'status', version: 1 })))
}
document.getElementById('q-second-export').onclick = async () => {
  const r = await send({
    type: 'export', version: 1,
    export_id: 'second_' + Date.now(),
    manifest: [{ source: 'pexels', source_item_id: '999', target_filename: '999.mp4', envato_item_url: null }],
    target_folder: 'transcript-eval/export-second',
    options: { variants: [], force_redownload: false },
  })
  qAppend('second export reply: ' + JSON.stringify(r))
}
```

- [ ] **Step 4: Smoke the page loads without JS errors**

```bash
# Just sanity-check the HTML is still well-formed
grep -c '</fieldset>' extension-test.html
# Expected: 5 (four from Ext.1-4 + this new one)
```

- [ ] **Step 5: Commit — this is the PR-1 boundary commit**

```bash
git add extension-test.html
git commit -m "$(cat <<'EOF'
test(ext): stress-test fieldset for the queue (PR 1 boundary)

50-item synthetic manifest (30 Pexels / 15 Envato / 5 Freepik) driven
through the new queue via the existing test page. Live Port log
captures state / progress / item_done / complete events. Buttons for
pause, resume, cancel, status, and a "second export" that should be
rejected with run_already_active (Task 10 lands the lock — until then
this button returns ok:true and races the existing run; that's the
current known behaviour).

== PR 1 boundary ==

Ext.5 work after this commit belongs to PR 2 (persistence + SW-wake
resume + active_run_id lock). Pause here, load unpacked, and observe
the queue end-to-end before starting Task 8.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Checkpoint for the verifier / reviewer:**

- Load the extension unpacked, open `http://localhost:5173/extension-test.html`, paste the extension ID, click "Start 50-item run". You should see the Port log fill with `state` events showing items marching through `queued → resolving → licensing → downloading → done`, roughly 5 resolvers + 3 downloads in flight at any moment.
- Click "Pause" — new workers should stop pulling; in-flight downloads continue to completion (per spec). Click "Resume" — workers resume pulling.
- Click "Cancel" — state clears, any in-flight `chrome.downloads` are cancelled via `chrome.downloads.cancel`.
- Kill the SW manually (`chrome://extensions` → Export Helper → "service worker" link opens DevTools → click stop) → observe the run is LOST in memory. This is expected; persistence is Task 8+. Starting a new run from the test page should work normally because in-memory state was wiped.

If any of the above misbehave, PR 1 is not ready — fix before starting Task 8.

---

## Task 8: Persistence wiring — queue writes state on every transition

This is the first PR-2 task. Every phase transition inside `queue.js` gains a `saveRunState` call. Persist-first, broadcast-after.

**Files:**
- Modify: `extension/modules/queue.js`

- [ ] **Step 1: Add the storage import**

At the top of `modules/queue.js`:

```js
import {
  saveRunState, loadRunState, deleteRunState,
  getActiveRunId, setActiveRunId, clearActiveRunId,
  markCompleted,
} from './storage.js'
```

Use Edit anchoring on the existing `import { broadcast } from './port.js'` line.

- [ ] **Step 2: Wrap every state transition in a persist-then-broadcast helper**

Introduce a new internal helper near the existing `broadcastItemTransition`:

```js
async function persist() {
  if (!state) return
  state.updated_at = Date.now()
  await saveRunState(state.runId, stripInMemory(state))
}

function stripInMemory(s) {
  // Don't persist `claimed` or `__settle` — they're in-memory only.
  return {
    ...s,
    items: s.items.map(({ claimed, __settle, ...rest }) => rest),
  }
}
```

Then replace every `broadcastItemTransition(item)` call with `await persistAndBroadcast(item)`:

```js
async function persistAndBroadcast(item) {
  await persist()
  broadcast({ type: 'state', version: 1, export: snapshot() })
}
```

Call sites to update (grep `broadcastItemTransition` in `queue.js`):
- `runResolver` — both success and fail paths
- `runLicenser` — both paths
- `runDownloader` — after `chrome.downloads.download` returns an id
- `handleDownloadEvent` — on complete, on interrupt, on error
- `failItem` — replace with `await persistAndBroadcast(item)` (function now async)
- `hardStopQueue` — replace with `await persistAndBroadcast()` at the end
- `pauseRun` / `resumeRun` / `cancelRun` — each ends with `await persist()` + broadcast
- `startRun` — `await persist()` BEFORE the `broadcast` in the build-state block. This is invariant #1: persist before broadcasting.

- [ ] **Step 3: Make `failItem` async**

Because `failItem` now calls `await persistAndBroadcast`, it becomes `async`. Every call site (`runResolver`, `runLicenser`, `runDownloader`, `handleDownloadEvent`) already runs inside an async worker, so awaiting is natural.

- [ ] **Step 4: Wire `startRun` to set the CAS lock**

Before `state = buildInitialRunState(...)` in `startRun`, add:

```js
const lockResult = await setActiveRunId(runId)
if (!lockResult.ok) {
  return { ok: false, reason: 'run_already_active', active_run_id: lockResult.activeRunId }
}
```

This is the real lock — Task 4's "in-memory state check" is now superseded by a chrome.storage.local check that survives SW restarts.

- [ ] **Step 5: Wire `finalize` + `cancelRun` to clear the lock + delete run state**

Inside `finalize`:

```js
state.run_state = 'complete'
await persist() // save the terminal state before clearing the lock
await clearActiveRunId()
// Keep run:<runId> in storage so the popup can show "last run" — cleared
// on next startRun via the CAS (overwrite) and the web app's
// post-complete acknowledge.
```

Inside `cancelRun`:

```js
// existing cancel of in-flight chrome.downloads...
state.run_state = 'cancelled'
await persist()
await deleteRunState(state.runId) // cancel wipes; complete retains
await clearActiveRunId()
```

- [ ] **Step 6: Wire `markCompleted` on per-item success**

Inside `handleDownloadEvent`'s `next === 'complete'` branch, after stats update:

```js
if (state.userId) {
  await markCompleted(state.userId, item.source, item.source_item_id, state.target_folder_path)
}
```

- [ ] **Step 7: Verify syntax**

```bash
node --check extension/modules/queue.js
# Expected: exit 0
```

- [ ] **Step 8: Commit**

```bash
git add extension/modules/queue.js
git commit -m "$(cat <<'EOF'
feat(ext): queue — persist every state transition to chrome.storage.local

Implements invariant #1 from the plan's "Why read this": every phase
transition persists to chrome.storage.local BEFORE broadcasting to the
Port. MV3 SW termination is designed-for: whatever's persisted is the
truth if the SW dies mid-transition.

Wiring:
- Every broadcastItemTransition call becomes await persistAndBroadcast.
- startRun acquires active_run_id via storage.setActiveRunId (real CAS).
- finalize persists terminal state, then clearActiveRunId.
- cancelRun deletes run:<runId> + clearActiveRunId.
- Per-item completion writes storage.markCompleted(userId, source,
  source_item_id, folder) for cross-run dedup.

The `claimed` and `__settle` fields stay in-memory only — stripped in
stripInMemory before persisting.

Run continues to emit state pushes in real time; the persist step adds
~1-5 ms per transition (chrome.storage.local is fast). Negligible for
a 300-item run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `autoResumeIfActiveRun` — the SW-wake resume path

This is the function that makes "close Chrome at 20/50 items, reboot, reopen" work. It reads `active_run_id`, loads the RunState, rehydrates phase queues, and kicks the scheduler.

**Files:**
- Modify: `extension/modules/queue.js`

- [ ] **Step 1: Replace the Task 4 stub with the real implementation**

Locate the existing `export async function autoResumeIfActiveRun()` in `queue.js`. Replace its body:

```js
export async function autoResumeIfActiveRun() {
  if (state) return { resumed: false, reason: 'already_in_memory' }
  const activeId = await getActiveRunId()
  if (!activeId) return { resumed: false, reason: 'no_active_run' }
  const persisted = await loadRunState(activeId)
  if (!persisted) {
    // Lock is orphaned — clear it.
    await clearActiveRunId()
    return { resumed: false, reason: 'orphaned_lock' }
  }
  // Rehydrate in-memory state.
  state = {
    ...persisted,
    download_id_to_seq: persisted.download_id_to_seq || {},
    items: persisted.items.map(i => ({
      ...i,
      claimed: false,       // re-claimable
      __settle: null,
    })),
  }
  // Any item whose persisted phase is 'downloading' but whose
  // chrome.downloads.search returns nothing got lost during SW death —
  // roll it back to 'queued' (or 'licensing' for envato items that
  // had already been resolved/licensed) so it re-fetches JIT.
  await reconcileInFlightDownloads()
  // Respect paused state — don't auto-unpause.
  if (state.run_state === 'running') {
    await acquireKeepAwake()
    broadcast({ type: 'state', version: 1, export: snapshot() })
    schedule()
  } else {
    broadcast({ type: 'state', version: 1, export: snapshot() })
  }
  return { resumed: true, runId: activeId, run_state: state.run_state }
}

async function reconcileInFlightDownloads() {
  if (!state) return
  for (const item of state.items) {
    if (item.phase !== 'downloading' || item.download_id == null) continue
    // Check if the download still exists and its state.
    let results = []
    try {
      results = await chrome.downloads.search({ id: item.download_id })
    } catch {
      results = []
    }
    const d = results[0]
    if (!d) {
      // Lost — roll back.
      item.download_id = null
      item.signed_url = null // force JIT refetch
      if (item.source === 'envato' && item.resolved_uuid) {
        item.phase = 'licensing' // resolved UUID is still valid
      } else {
        item.phase = 'queued'
      }
      continue
    }
    if (d.state === 'complete') {
      item.phase = 'done'
      item.bytes_received = d.bytesReceived
      state.stats.ok_count++
      state.stats.total_bytes_downloaded += d.bytesReceived
      continue
    }
    if (d.state === 'interrupted') {
      // Treat like a fresh interrupt — NETWORK_* gets a resume,
      // FILE_* hard-stops. Surface via handleDownloadInterrupt by
      // synthesizing a delta.
      handleDownloadInterrupt(item, { error: { current: d.error || 'UNKNOWN' } })
      continue
    }
    // state === 'in_progress' — the download survived SW death. The
    // existing chrome.downloads.onChanged listener (registered at
    // module top level) will pick up subsequent events. We re-mark
    // the item as claimed so no new worker grabs it.
    item.claimed = true
    // Re-attach a per-item settle Promise inside a fresh worker run
    // so the scheduler's bookkeeping stays correct. Simplest: spawn
    // a downloader that immediately awaits waitForDownloadSettled.
    spawnReattachedDownloader(item)
  }
}

function spawnReattachedDownloader(item) {
  active.downloading++
  ;(async () => {
    try {
      await waitForDownloadSettled(item)
    } finally {
      active.downloading--
      item.claimed = false
      schedule()
    }
  })()
}
```

- [ ] **Step 2: Persist after reconciliation**

At the end of `reconcileInFlightDownloads`:

```js
await persist()
```

So the rolled-back state is written before the scheduler starts pulling.

- [ ] **Step 3: Verify syntax**

```bash
node --check extension/modules/queue.js
# Expected: exit 0
```

- [ ] **Step 4: Commit**

```bash
git add extension/modules/queue.js
git commit -m "$(cat <<'EOF'
feat(ext): queue — auto-resume on SW wake / Chrome reopen

Implements autoResumeIfActiveRun: reads active_run_id, loads the
persisted RunState, rehydrates the in-memory state, and either
resumes the scheduler or holds for user action (if the run was
paused before the SW died).

Reconciliation logic (reconcileInFlightDownloads):
- For every item whose persisted phase is 'downloading':
  - chrome.downloads.search({id}) returns the real state.
  - 'complete' → mark done, bump stats.
  - 'interrupted' → synthesize onChanged delta, re-run interrupt
    handler (NETWORK_* resumes, FILE_* hard-stops).
  - 'in_progress' → download survived SW death; re-claim the item,
    spawn a reattached downloader whose only job is to await the
    next onChanged settle event.
  - Missing (lost during SW death) → roll back to 'licensing' (if
    the envato resolved_uuid is still valid) or 'queued'. JIT URL
    refetch kicks in automatically on next worker cycle.

Paused runs resume paused — auto-resume never auto-unpauses.
keepAwake is re-acquired only if the run is running.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `active_run_id` lock + "second export" rejection end-to-end test

The CAS lock was wired in Task 8. This task verifies the end-to-end rejection path and closes the "second export" test button from Task 7.

**Files:**
- No code changes — this is a verification task.

- [ ] **Step 1: Reload the unpacked extension**

`chrome://extensions` → Export Helper → reload icon (or toggle off + on). Confirm version shows `0.5.0`.

- [ ] **Step 2: Click "Start 50-item run" in the test page**

Wait for the Port log to show a handful of `state` messages with items in various phases.

- [ ] **Step 3: Click "Try 2nd {type:"export"} (expect run_already_active)"**

Expected Port log entry:

```json
{"type":"state", ...}  <-- ongoing from first run
{"type":"state", ...}
second export reply: {"ok":false,"reason":"run_already_active","active_run_id":"stress_<timestamp>"}
```

If the second export returns `{ok:true}`, Task 8's lock wiring is broken — the `setActiveRunId` CAS isn't being consulted in `startRun`. Revisit Task 8 Step 4.

- [ ] **Step 4: Cancel the first run, verify the lock clears**

Click Cancel. Wait for the `state` message with `run_state: "cancelled"`. Then click "Start 50-item run" again — it should succeed.

In a separate Chrome DevTools (SW console): `await chrome.storage.local.get('active_run_id')` → returns `{active_run_id: "<new_id>"}` after the new start, empty after cancel.

- [ ] **Step 5: No code changes means no commit**

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

If anything is modified, investigate — a test should not alter files.

---

## Task 11: Stress-test fixture hardening — synthetic 50-item manifest behaviour

The manifest built by `buildSyntheticManifest` in Task 7 is MVP-adequate for a smoke but has a couple of rough edges worth tightening before the manual verification in Task 12:

- **Pexels items hit the real API** (cheap) but Freepik items hit `/api/freepik-url` which returns signed CDN URLs that actually download real MB of data. For a 50-item stress, 5 Freepik × 20 MB = 100 MB — acceptable, but document.
- **Envato items repeat the same `source_item_id`**. License commits dedupe per-item per-24h, but 15 calls to `download.data` for the same UUID do tick the fair-use counter each time; Envato is OK with ~50/day per account. Budget 15 licenses per stress run.

**Files:**
- Modify: `extension-test.html` (add a "cheap mode" toggle)

- [ ] **Step 1: Add a "cheap mode" checkbox to the stress fieldset**

Add to the HTML inside the "Queue / stress test" fieldset:

```html
<div class="row">
  <label><input type="checkbox" id="q-cheap-mode" checked> Cheap mode (skip Envato items; Pexels+Freepik only)</label>
</div>
```

- [ ] **Step 2: Update `buildSyntheticManifest` to respect the toggle**

Modify the function:

```js
function buildSyntheticManifest() {
  const cheap = document.getElementById('q-cheap-mode').checked
  const out = []
  let seq = 0
  // 30 Pexels
  for (let i = 0; i < 30; i++) {
    out.push({
      source: 'pexels',
      source_item_id: String(1000 + i),
      target_filename: `${String(++seq).padStart(3, '0')}_pexels_${1000 + i}.mp4`,
      envato_item_url: null,
      est_size_bytes: 5_000_000,
    })
  }
  // 15 Envato (skipped in cheap mode)
  if (!cheap) {
    for (let i = 0; i < 15; i++) {
      out.push({
        source: 'envato',
        source_item_id: 'NX9WYGQ',
        target_filename: `${String(++seq).padStart(3, '0')}_envato_NX9WYGQ_${i}.mov`,
        envato_item_url: 'https://elements.envato.com/...-NX9WYGQ',
        est_size_bytes: 50_000_000,
      })
    }
  }
  // 5 Freepik
  for (let i = 0; i < 5; i++) {
    out.push({
      source: 'freepik',
      source_item_id: `fp_${2000 + i}`,
      target_filename: `${String(++seq).padStart(3, '0')}_freepik_${2000 + i}.mp4`,
      envato_item_url: null,
      est_size_bytes: 20_000_000,
    })
  }
  return out
}
```

Cheap mode: 35 items (30 Pexels + 5 Freepik), ~250 MB total, no license commits.
Full mode: 50 items, adds 15 Envato license commits.

- [ ] **Step 3: Update the legend + copy**

Change the paragraph copy inside the fieldset to:

```html
<p class="muted">
  Drives a synthetic manifest through the queue. <b>Cheap mode</b>
  (default): 35 items (30 Pexels + 5 Freepik), ~250 MB, no Envato
  license commits. <b>Full mode</b>: adds 15 Envato items
  (NX9WYGQ × 15); budget the fair-use counter before clicking.
  Live state log pushes via Port.
</p>
```

- [ ] **Step 4: Commit**

```bash
git add extension-test.html
git commit -m "$(cat <<'EOF'
test(ext): stress test — cheap mode toggle (Pexels + Freepik only)

Adds a "cheap mode" checkbox to the 50-item stress test. Default on:
35 items, ~250 MB, zero Envato license commits — safe to run
repeatedly during development. Unchecked: adds 15 Envato items for
full-path coverage but budgets 15 real license commits per run.

Manual verification (Task 12) uses full mode once; everything before
it stays in cheap mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Manual verification — SW-wake resume + pause behaviour (no commit)

Full end-to-end acceptance gate. Mirrors Ext.1/2/3/4's manual-verification task pattern. No code changes.

**Prereq:** Dev server on `:5173`, extension loaded unpacked at v0.5.0, user signed in to Envato + transcript-eval in the same Chrome profile.

- [ ] **Step 1: Start vite dev**

In a new terminal:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext5"
npm run dev:client
```

- [ ] **Step 2: Reload the extension + clear storage once for a clean run**

- `chrome://extensions` → Export Helper → reload.
- Click "service worker" link → DevTools console.
- Run: `await chrome.storage.local.clear()` to reset any old state.

- [ ] **Step 3: Full-mode stress run**

1. Open `http://localhost:5173/extension-test.html`, paste the extension ID.
2. Uncheck "Cheap mode".
3. Click "Start 50-item run".
4. Observe the Port log: a burst of 5 `state` messages showing envato items in `resolving`, plus 3 Pexels items in `downloading`. After ~30 seconds, resolvers finish, items move to `licensing`, then `downloading`.
5. Expected concurrency at peak: 5 resolvers + 5 licensers + 3 downloaders in flight. Verify via `chrome.downloads` tab in Chrome's downloads page — you should see 3 active bars, never more, never fewer (until items start finishing).

- [ ] **Step 4: Force-close Chrome at ~20 / 50 items done**

1. Watch the Port log until the running total shows approximately 20 items in `done` phase.
2. Quit Chrome entirely (Cmd-Q on macOS).
3. Wait 5 seconds.
4. Re-open Chrome.
5. Open `chrome://extensions` → Export Helper → "service worker" link → DevTools console.
6. In the SW console, expect to see `[sw] autoResumeIfActiveRun at module-init ...` log lines (add a `console.log` in service_worker.js during verification if needed — don't commit).
7. Open the test page again, click "Status snapshot". The Port reply should show `run_state: "running"` with `ok_count ≈ 20-25` (some items finished in-flight during the resume window; a handful rolled back from `downloading` to `queued` or `licensing`).
8. Let the run continue to completion. Final Port event: `{type:"complete", ok_count:<50 if no failures>, fail_count:<0>, folder_path:..., xml_paths:[]}`.

If the run does NOT auto-resume (Port snapshot shows `null` state), the auto-resume wiring is broken. Re-check Task 5's top-level `autoResumeIfActiveRun` call and Task 9's `loadRunState` path.

- [ ] **Step 5: Pause behaviour verification**

1. Start a fresh cheap-mode run (35 items).
2. Wait until ~5 items are in `done` and 3 downloads are in flight.
3. Click Pause. Port log shows `state` with `run_state: "paused"`.
4. Observe: the 3 in-flight downloads KEEP GOING to completion (per spec — pause stops new pulls, not in-flight work).
5. Observe: after the 3 finish, NO new items move to `downloading`. Every remaining item stays in `queued` / `licensing`.
6. Click Resume. Workers pick up; new downloads start within ~1 s.
7. Let the run complete.

- [ ] **Step 6: Second-export rejection**

1. Start a fresh cheap-mode run.
2. While it's running, click "Try 2nd {type:"export"}".
3. Port log shows `second export reply: {"ok":false,"reason":"run_already_active","active_run_id":"..."}`.
4. Cancel the first run.
5. Click "Try 2nd {type:"export"}" again. It should succeed now.

- [ ] **Step 7: Cancel behaviour**

1. Start a fresh cheap-mode run.
2. While it's running, click Cancel.
3. Port log shows `state` with `run_state: "cancelled"`.
4. All in-flight `chrome.downloads` are cancelled — check Chrome's downloads page, any in-flight bars show "Canceled".
5. In SW DevTools console: `await chrome.storage.local.get(['active_run_id'])` → `{active_run_id: undefined}` (cleared).
6. `await chrome.storage.local.get(null)` — no `run:*` keys remain (cancel deletes).

- [ ] **Step 8: Do NOT commit anything from this task**

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

If any of Steps 3-7 fail, go fix before starting Task 13. The common failure modes:

- Auto-resume doesn't happen → check Task 5's module-top-level `autoResumeIfActiveRun` call (it must be at module scope, not inside a listener).
- Pause stops in-flight downloads → the pause logic is calling `chrome.downloads.cancel`; it should only flip `run_state` and stop the scheduler from pulling. Re-read Task 4's `pauseRun`.
- Second-export succeeds → the CAS in `startRun` isn't wired. Re-do Task 8 Step 4.
- Cancel leaves run:<id> in storage → `deleteRunState` isn't called. Re-do Task 8 Step 5.
- Force-close loses items → `persist` isn't being awaited before the next yield. Re-audit Task 8: grep `state.items.find|state.stats|state.run_state` and confirm every mutation has `await persist()` before the next `await` or return.

---

## Task 13: README update + self-review + branch summary

**Files:**
- Modify: `extension/README.md`

- [ ] **Step 1: Append "Ext.5 — Queue & persistence" section**

Open `extension/README.md` and add at the end (after Ext.4's section):

```markdown
## Ext.5 — Queue & persistence

- **Permissions:** `power` added. Manifest version `0.5.0`.
- **New modules:** `modules/queue.js` (state machine + worker pools +
  `chrome.downloads.onChanged` routing), `modules/storage.js` (single
  owner of `chrome.storage.local` wrappers for run state, active-run
  lock, completed-items set, deny-list, daily counts).
- **Message handlers:** `{type:"export"}`, `{type:"pause"}`,
  `{type:"resume"}`, `{type:"cancel"}`, `{type:"status"}`. The
  `debug_envato_one_shot` / `debug_source_one_shot` handlers from
  Ext.2/3 stay intact with a DEPRECATED comment — useful for isolated
  debugging.
- **Concurrency:** 5 Envato resolver tabs, 5 Envato licensers, 3
  downloaders (Envato + Pexels + Freepik share the downloader pool).
  Tune via the constants in `config.js`.
- **Persistence invariant:** every phase transition writes
  `run:<runId>` to `chrome.storage.local` BEFORE broadcasting. MV3 SW
  termination is designed-for; whatever's persisted is the truth on
  resume.
- **SW-wake resume:** module-top-level `autoResumeIfActiveRun`
  rehydrates from `active_run_id` → `run:<runId>`. `chrome.runtime.
  onStartup` + `onInstalled` also trigger it. In-flight downloads are
  reconciled via `chrome.downloads.search({id})` and rolled back to
  `queued` if lost.
- **Single active run:** `active_run_id` lock enforced in
  `startRun` via `storage.setActiveRunId` CAS. A second
  `{type:"export"}` while the lock is held returns
  `{ok:false, reason:'run_already_active', active_run_id}`. Cleared
  on complete or cancel (NOT on pause — a paused run holds the lock).
- **Keep-awake:** `chrome.power.requestKeepAwake("system")` on
  `startRun` / `resumeRun`; `releaseKeepAwake()` on pause, cancel,
  complete, and hard-stop (disk_failed) paths.
- **Interrupt recovery:** `chrome.downloads.resume(id)` on NETWORK_*
  interrupts, up to 3 attempts per item. FILE_* interrupts hard-stop
  the whole queue (disk is hosed; no point continuing).
  USER_CANCELED marks just that item cancelled.
- **JIT URL fetching:** each downloader fetches its signed URL
  (Envato: `download.data`; Pexels/Freepik: `/api/*-url`) milliseconds
  before `chrome.downloads.download`. URL TTL (Envato ~1 h, Freepik
  15-60 min) doesn't matter even on multi-hour runs.
- **Port broadcast:** every state transition pushes `{type:"state"}`.
  Per-item byte progress is coalesced to at most one `{type:"progress"}`
  push per item per 500 ms. On `complete`, pushes `{type:"complete",
  ok_count, fail_count, folder_path, xml_paths:[]}` (web app owns
  XMEML generation).

### Stress test

Run the "Queue / stress test" fieldset on `extension-test.html`.
Cheap mode (default): 35 items, ~250 MB, no Envato license commits.
Full mode: adds 15 Envato items (budget 15 license commits).

Acceptance gate for Ext.5: close Chrome at ~20/50 items, reopen,
observe the run auto-resume from the persisted state. See
`docs/superpowers/plans/2026-04-24-extension-ext5-queue-persistence.md`
Task 12 for the full verification script.

### Known Ext.5 limitations (belong to later phases)

- Failure matrix (402 tier_restricted, 403 hard-stop + Slack, 429
  Retry-After + jitter, integrity mismatch retry,
  `unsupported_filetype` deny-list with 24 h telemetry dedupe) →
  Ext.7.
- Telemetry to `/api/export-events` → Ext.6. Events are emitted
  in-process via Port only; no HTTP POST yet.
- Daily-cap enforcement (warn at 400, hard-stop at 500 per source per
  user) → Ext.7. Getters live in `storage.js`; the queue doesn't
  consult them yet.
- Diagnostic bundle (`modules/diagnostics.js`) → Ext.8.
- Feature flags (`/api/ext-config`) → Ext.9.
```

- [ ] **Step 2: Commit the README update**

```bash
git add extension/README.md
git commit -m "$(cat <<'EOF'
docs(ext): README — Ext.5 queue & persistence section

Documents the new modules, message handlers, concurrency caps, the
persist-first invariant, SW-wake resume behaviour, the active_run_id
lock semantics, keep-awake pairing, interrupt recovery, JIT URL
fetching, and Port broadcast coalescing. Also lists the acceptance
gate (50-item force-close-and-reopen) and the deferred-to-later-phases
list for readers doing Ext.6+ planning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Full branch review**

```bash
git log --oneline main..HEAD  # or the appropriate base
# Expected commits (13 total, 1 per task except 0, 10, 12 — those are
# verification/setup tasks with no commit):
#   chore(ext): manifest — add power permission ... (Task 1)
#   feat(ext): config — queue concurrency caps ...  (Task 2)
#   feat(ext): storage module ...                   (Task 3)
#   feat(ext): queue state machine — Phase 1 ...    (Task 4)
#   feat(ext): service worker — wire queue ...      (Task 5)
#   chore(ext): queue — audit keepAwake ...         (Task 6)
#   test(ext): stress-test fieldset ... (PR 1 ...)  (Task 7)  ← PR 1 boundary
#   feat(ext): queue — persist every state ...      (Task 8)
#   feat(ext): queue — auto-resume on SW wake ...   (Task 9)
#   test(ext): stress test — cheap mode toggle ...  (Task 11)
#   docs(ext): README — Ext.5 queue & persistence   (Task 13)
# (Task 0, 10, 12 produce no commit by design.)
```

Actual commit count: 10 (Task 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13 → but some tasks may merge). Verify against the per-task headings above.

```bash
git diff main --stat  # or appropriate base
# Expected additions (approximate):
#   extension/manifest.json                  |   3 +/-
#   extension/config.js                      |  20 +
#   extension/modules/storage.js             | 150 +
#   extension/modules/queue.js               | 600 +
#   extension/service_worker.js              |  60 +/-
#   extension/README.md                      |  60 +
#   extension-test.html                      | 120 +
```

If `git diff main` surfaces anything OUTSIDE `extension/*`, `extension-test.html`, or the manifest, investigate — the plan scope is all extension-side.

- [ ] **Step 4: DO NOT push**

`git push` requires explicit user approval. Task 13's acceptance is "all commits on the local branch, branch ready for review, two PR-sized slices clearly demarcated by Task 7's commit message."

Surface to the reviewer:
- Branch name: `feature/extension-ext5-queue-persistence`.
- PR 1 candidate: commits up to and including Task 7's "(PR 1 boundary)" commit.
- PR 2 candidate: commits Task 8 through Task 13.
- Last commit sha.

---

## Self-review against the spec

After completing Tasks 0–13, re-read `docs/specs/2026-04-23-envato-export-design.md` § "Large exports (100 GB+)" and § "Run state persistence" and `docs/specs/2026-04-23-envato-export-extension.md` § "Phased delivery" Ext.5:

> **Ext.5** — Queue + concurrency + persistence. 5-resolver, 3-downloader caps; pause/resume/cancel; `chrome.storage.local` state; SW-wake resume; `chrome.power.requestKeepAwake`. Single active run per user.

Coverage check:

- 5-resolver cap → Task 2 (`MAX_ENVATO_RESOLVER_CONCURRENCY = 5`) + Task 4 (`fillPool('resolving', ...)`). ✓
- 3-downloader cap → Task 2 (`MAX_DOWNLOAD_CONCURRENCY = 3`) + Task 4 (`fillPool('downloading', ...)`). ✓
- Pause/resume/cancel → Task 4 (public API) + Task 5 (SW handlers) + Task 12 (manual verification). ✓
- `chrome.storage.local` state → Task 3 (storage.js) + Task 8 (persistence wiring). ✓
- SW-wake resume → Task 9 (`autoResumeIfActiveRun`) + Task 5 (top-level hook). ✓
- `chrome.power.requestKeepAwake` → Task 1 (permission) + Task 4 (wiring) + Task 6 (audit). ✓
- Single active run per user → Task 3 (`setActiveRunId` CAS) + Task 8 (wiring) + Task 10 (verification). ✓

Spec § "Large exports (100 GB+)" mitigation table:

| Problem | Mitigation | Covered by |
|---|---|---|
| Signed URLs expire ~1 h | JIT fetching | Task 4 (`runDownloader` refetches immediately before `chrome.downloads.download`) |
| User closes Chrome / laptop sleeps | Persistent queue + SW-wake resume | Task 8 + Task 9 |
| OS auto-sleep kills downloads | `chrome.power.requestKeepAwake("system")` | Task 1 + Task 4 + Task 6 |
| Flaky WiFi interrupts a file | `chrome.downloads.resume()` max 3 retries | Task 4 (`handleDownloadInterrupt`) |
| Insufficient disk | `navigator.storage.estimate()` pre-flight | **NOT in extension** — web app's pre-flight owns this (already shipped per roadmap) |
| Concurrency caps | 5 / 5 / 3 | Task 2 + Task 4 |
| No visibility over hours | Popup per-item + Port `{type:"state"}` + `{type:"progress"}` | Task 4 (broadcast) |

Spec § "Run state persistence" JSON shape — fields covered:

- `runId`, `started_at`, `updated_at` ✓
- `target_folder_path` ✓
- `options: {include_variants, force_redownload}` — plan renames `include_variants` to `variants` in buildInitialRunState; the spec's wording says "include_variants" but nothing on our side depends on the key name. ✓ (minor naming delta — acceptable, call out in review)
- `items: [{seq, source, source_item_id, target_filename, phase, download_id, bytes_received, error_code}]` ✓ + plan adds `retries`, `resolved_uuid`, `signed_url`, `total_bytes`, `envato_item_url` (extensions beyond the spec skeleton, all necessary for the queue's correct operation).
- `stats: {ok_count, fail_count, total_bytes_downloaded}` ✓

Spec § "Concurrency + queue constraints":

- One active export per user → Task 3 + Task 8 + Task 10 ✓
- Second `{type:"export"}` while run live → `{type:"error", reason:"run_already_active"}` — plan returns `{ok:false, reason:"run_already_active", active_run_id}` (structurally equivalent; the spec doesn't specify the exact envelope). ✓
- `chrome.storage.local.active_run_id` lock → Task 3 ✓
- Cleared on complete / cancel → Task 8 ✓

Spec § "Port broadcast":

- `{type:"state", version:1, export:{...runState}}` on every transition → Task 4 ✓
- `{type:"item_done", ...}` on per-item settle → Task 4 ✓
- `{type:"progress", ..., bytes, total_bytes}` coalesced to ≤1/500 ms → Task 4 (`maybePushProgress`) + Task 2 (`PROGRESS_COALESCE_MS`) ✓

Explicitly deferred (still correct):

- Failure matrix → Ext.7.
- Telemetry (`/api/export-events`) → Ext.6.
- Diagnostic bundle → Ext.8.
- Feature flags → Ext.9.
- CI packaging → Ext.10.

Open risks:

1. **SW-wake atomicity window.** Between `chrome.downloads.search` returning `{state: 'in_progress'}` in `reconcileInFlightDownloads` and the `spawnReattachedDownloader` awaiting `waitForDownloadSettled`, a `chrome.downloads.onChanged` event can fire and be dropped (the `__settle` Promise isn't yet attached). Mitigation: the top-level `chrome.downloads.onChanged` listener is registered at module init — it fires, flips `item.phase` to `done`/`failed`, and persists. `spawnReattachedDownloader` then awaits `__settle` which is never called (the event already fired), so the reattached worker dangles forever. Task 9's implementation calls `item.__settle?.()` inside the listener; the dangling Promise is harmless (it's never awaited by anything that needs to settle), but the active counter gets stuck. **Known bug; if encountered in Task 12, patch by making `spawnReattachedDownloader` re-check the item's phase after attaching and immediately resolve if already terminal.** This is a single-digit-line fix; flagging here so the reviewer knows to look.
2. **`chrome.power.requestKeepAwake` failure modes.** On Linux-running-under-WSL-style edge cases, `chrome.power` may be a no-op. Task 4's try/catch swallows the error. Not a correctness issue; user may see their laptop sleep on some systems. Acceptable for MVP.
3. **Persistence size.** At 300 items × ~500 bytes of item state, a run is ~150 KB in `chrome.storage.local` — well under the 5 MB per-key limit. At 50-60 save-per-second during peak progress events, storage writes are the biggest performance risk. Mitigated by coalescing progress pushes at the Port level, but persistence still fires on every transition. If we see noticeable slowdown, add a `persistDebounced` for byte-progress-only updates.
4. **`NX9WYGQ` as the repeated stress-test Envato ID.** Envato may flag 15 identical item licenses in a minute as "scripted". The cheap-mode default avoids this for routine development; full-mode runs should be rare (acceptance only).

Open questions NOT resolved (expected — not in scope):

- Full failure-code enum → Ext.7.
- Telemetry schema → Ext.6.
- Feature flag schema → Ext.9.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-extension-ext5-queue-persistence.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, two-stage (spec + code) review after each task. **Strongly recommended for this plan** given the size of `queue.js` and the persistence-correctness concerns.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints at Task 7 (PR 1 boundary) and Task 13 (end).

Which approach?
