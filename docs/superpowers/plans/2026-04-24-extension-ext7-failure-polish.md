# Ext.7 — Failure-mode Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

## Goal

Ext.7 closes the resilience gap Ext.5 intentionally left open: the queue already has terminal sinks (`failItem`, `hardStopQueue`) and storage stubs (`isDenied` / `addToDenyList`, `getDailyCount` / `incrementDailyCount`), but every error path still dumps items straight into `failItem` with no backoff, no retry, no skip-vs-hardstop distinction, and no deny-list. This phase wires the full 17-row failure matrix from the extension spec (`§ Failure handling (full matrix)` + `§ Error codes the extension emits`), adds the deny-list writer + 24h Slack-alert dedupe, teaches Freepik how to refetch expired URLs, honors `Retry-After` for 429s, enforces the 500-per-source daily cap (warn at 400), adds file-size integrity retry, and hard-stops the queue on disk interrupts. Extension bumps to v0.7.0.

## Architecture

Ext.7 is a pure extension-side phase. Zero backend, zero web-app changes — it rides on top of the Ext.5 queue scaffolding and the Ext.6 telemetry plumbing. The pattern:

- Every retryable branch grows a **pure classifier function** (e.g. `classifyEnvatoLicenseError`) that returns one of `{retry: {after_ms, max_attempts}}`, `{skip: 'error_code'}`, `{hardStop: 'error_code'}`, or `{pauseThenRetry}`. The worker loop dispatches on the classifier's verdict — one entry point per stage, every outcome accounted for.
- Deny-list check happens **before** the Phase-2 license GET. A deny hit returns a skip — we never spend a license on an item we already know is a .zip.
- Daily-cap increment happens **after** `chrome.downloads` reports `complete`. A hard-stop mid-download must NOT leak a cap increment (invariant #3).
- 24h Slack-alert dedupe is a **storage-scoped** map (`deny_list_alerted`) keyed by `source_item_id + error_code`, because MV3 SW termination trashes any in-memory dedupe (invariant #5).
- Retry-After parsing handles both seconds-form AND HTTP-date form; the result is clamped to `[1, 600]` seconds so a misconfigured server can't make the extension sleep for days.

## Tech Stack

- Chrome MV3 service worker, Vite-built extension bundle (no new build-step changes).
- `chrome.storage.local` for deny-list, daily-counts, alert-dedupe. All existing keys stay as-is; we only grow the storage module's reader/writer set.
- `fetch` for backend + third-party CDNs (no new runtime deps).
- Telemetry via the Ext.6 `emit()` fire-and-forget path — `error_code` enum is frozen; we widen `normalizeErrorCode`'s map but NOT the enum (invariant #8).
- Vitest for unit tests if any land (Ext.7 prefers smoke + the manual failure-matrix run — unit tests on chrome.* are brittle).

## Open questions for the user

1. **Bundle the `conflictAction: 'uniquify'` filename-fidelity fix into Ext.7, or ship standalone?**
   Recommendation: **bundle into Ext.7.** The change is a new `item_finalized` Port message carrying the real download path from `chrome.downloads.search({id})` so the web app can tell `001_envato_NX9WYGQ.mov` from `001_envato_NX9WYGQ (1).mov` when Chrome uniquifies. Diff footprint is three files (`queue.js`, `port.js`, web-app consumer), all work Ext.7 already touches in `queue.js`, and shipping it standalone costs a full plan/worktree/review cycle for a single-screen change. Cross-phase note: the web app's `result_json` consumer needs to read `final_path` too — WebApp.3 (State F) can pick it up. If the user prefers to keep Ext.7 narrow, we drop this to Task 10 of a mini-PR and the plan sans-bundle is ~200 lines shorter.

2. **Slack alert dedupe — per (item_id, error_code) or per item_id only?**
   Recommendation: **per (item_id, error_code)**, so a single item that fails as `envato_unsupported_filetype` today and `integrity_failed` next week produces two alerts. The spec says "one telemetry event per item per 24h max" for the ZIP case specifically; we extend the pattern to all dedupable events to keep the storage shape uniform. If the user wants tighter dedupe (per item_id only) say so; it's a one-line change to the dedupe key.

3. **500-per-source daily-cap — hard-stop whole queue, or skip just that source's remaining items?**
   Recommendation: **skip that source's remaining items, NOT hard-stop the queue.** A Pexels 500 cap shouldn't halt an otherwise-healthy Envato+Freepik run. The spec is ambiguous ("hard stop at 500") — we interpret narrowly as "hard stop for that source". The user can flip this in Task 6 if they prefer the stricter reading.

## Why read this before touching code

1. **Every error path must terminate by calling exactly ONE of `failItem` / `hardStopQueue` — the queue's two terminal sinks are disjoint. Calling both double-counts `fail_count` and double-emits `export_completed`.** The Ext.5 queue already maintains this invariant in the Phase-3 `handleDownloadInterrupt` branch (FILE_* calls `failItem` THEN `hardStopQueue`, and `hardStopQueue` re-marks the same item — read that code carefully before replicating the pattern; Ext.7 should NOT re-mark an item that `failItem` already flipped to `failed`). When introducing a new skip/hardstop decision, add the terminal call at the deepest switch arm, not as a fallthrough.

2. **Daily-cap increment fires AFTER `chrome.downloads` reports `complete`, not on license commit.** The cap is a user-protection thing (Envato's fair-use counter) so the right attribution is "bytes actually on disk". A hard-stop between license and download-complete must NOT leak a cap increment; wire `incrementDailyCount` inside `handleDownloadEvent` at the `next === 'complete'` branch, next to `state.stats.ok_count++`. Never from `runLicenser`.

3. **Deny-list reads happen BEFORE the license `download.data` GET — the entire point is to avoid wasting a license.** `runLicenser` must `await isDenied(item.source, item.source_item_id)` as its first step and skip the item immediately if the check returns true. Deny-list writes, conversely, only happen AFTER `getSignedDownloadUrl` returns (we need the signed URL to see the `.zip`/`.aep`/`.prproj` extension in the `response-content-disposition`).

4. **Slack alert dedupe is per `(source_item_id, error_code)` per 24h — keyed in `chrome.storage.local`; never in SW memory.** MV3 SW termination resets any module-scoped Map; a telemetry storm on SW wake would look like duplicate alerts. Use a `deny_list_alerted` map of `{"<source>|<itemId>|<code>": last_emitted_at}` in storage. Before the first `emit(..., { alert: true })` call, read the map, check `Date.now() - last_emitted_at >= 24*3600*1000`. Persist before emit.

5. **`Retry-After` header parses seconds OR HTTP-date — use `Math.max(1, Number(header) || (Date.parse(header) - Date.now())/1000)`, then sanity-clamp to 600s.** RFC 7231 allows both forms; a misbehaving origin can return `"never"` or garbage and we must not crash or sleep for days. Spec says the server may return seconds-form; we tolerate both and floor at 1s so we always make forward progress.

6. **Partial-run XML is a web-app concern; Ext.7 emits `export_completed` with accurate `ok_count`/`fail_count` and stops there.** When a hard-stop fires, the Ext.6 `export_completed` emission already carries `reason: "hard_stop:<code>"` — don't duplicate. When the queue pauses for 429 cooldown, emit `queue_paused` with `meta.reason = "envato_429_cooldown"` (matching Ext.6's pause path). WebApp.3 (State F) consumes these and renders the "partial run, X/Y downloaded, here's the XML" UI.

7. **Persist-first discipline still applies (from Ext.5): every storage write happens BEFORE the next `await`.** Ext.7 introduces several new write-then-emit patterns: deny-list write before the `addToDenyList` Slack alert emit; daily-cap increment before the progress broadcast; alert-dedupe map update before the `emit`. If you flip the order, a SW death between the async calls leaves the persisted state out of sync with downstream consumers.

8. **The 15-code `error_code` enum in `telemetry.js` is frozen; Ext.7 widens the MAP, not the enum.** `ERROR_CODE_ENUM` in `telemetry.js` is `Object.freeze`d. The backend has a matching list in `server/services/exports.js` that Ext.6's drift-assert verifies. Ext.7 tightens `normalizeErrorCode` (e.g. `network_resume_failed` → `network_failed`, `envato_http_402` → `envato_402_tier` under the right conditions) but NEVER adds a new enum member. If a new code is needed, bounce to Ext.8 or reopen the Ext.6 plan.

9. **Ext.6 executor applied a T5-before-T3 commit ordering swap to avoid a transient broken-import window; Ext.7 has a similar risk.** When adding the new classifier functions, import them in `queue.js` ONLY after the classifier module exports them. Concretely: Task 2 lands `storage.js` writer changes first, Task 3 lands the classifier module, Task 4 wires `queue.js` to import from `classifier.js`. Do NOT reorder tasks 2-3-4 without re-checking imports.

10. **Envato's Phase-2 license function throws plain `Error`s with prefix-coded messages (`envato_429`, `envato_402`, `envato_403`, etc.). The classifier must parse `err.message` to decide retry vs. hardstop — the Retry-After header is NOT currently surfaced through this throw.** Ext.7 must refactor `getSignedDownloadUrl` in `envato.js` to attach `Retry-After` (and a few other response-scoped facts) to the thrown error via `Object.assign(new Error(...), { retryAfter, httpStatus })`. Classifier reads `err.retryAfter`, NOT the response object (which is already out-of-scope by the time the throw propagates).

## Scope (Ext.7 only — hold the line)

### In scope

1. **Per-error retry/skip/hard-stop matrix.** 17-row failure matrix from spec § "Failure handling (full matrix)". New `modules/classifier.js` module maps `(phase, error)` → one of `{retry, skip, hardStop, pauseThenRetry}`. Worker loops (`runResolver`, `runLicenser`, `runDownloader`, `handleDownloadInterrupt`) dispatch on the verdict.
2. **Deny-list writes for `envato_unsupported_filetype`.** Storage reader/writer stubs are already live in `storage.js` (Ext.5 deferral). Ext.7 wires `runLicenser` to:
   - Read `isDenied` BEFORE the `download.data` GET; skip with `envato_unsupported_filetype` on hit.
   - Write `addToDenyList(source, itemId, reason)` AFTER the post-license filename check detects `.zip`/`.aep`/`.prproj`.
   - 24h Slack-alert dedupe via new `deny_list_alerted` storage map — one telemetry event per `(source_item_id, error_code)` per 24h.
3. **Freepik URL-refetch-on-expiry.** Downloader respects `expires_at`; on expiry OR mid-download expiry signal, refetch URL + retry download once. Second refetch still failing → skip with `url_expired_refetch_failed`.
4. **Tier-restricted handling.** `download.data` 402 OR 403-with-`"upgrade"`-body → `envato_402_tier` — skip item, do NOT hard-stop. Distinct from generic 403 (hard-stop with `envato_403`).
5. **429 retry-after honoring.** On first 429, read `Retry-After` header + apply 20% jitter, retry once. Second 429 → pause queue 5min, 1 final retry. Third 429 → hard-stop with `envato_429`.
6. **Daily cap enforcement.** `chrome.storage.local.daily_counts[<yyyy-mm-dd>][<source>]` — warn at 400, hard-stop (that source's queue slice only — see open question 3) at 500. Increment happens on download-complete.
7. **Integrity check retry.** File size vs. `est_size_bytes` mismatch after download → delete the file via `chrome.downloads.removeFile`, retry once (refetching the URL). Second mismatch → `integrity_failed`, skip item.
8. **Disk_failed hard-stop.** `chrome.downloads` `FILE_*` interrupt → hard-stop queue + popup "Disk error — change folder and retry." (already partially wired in Ext.5 — Ext.7 adds the popup affordance and ensures no further items are attempted).
9. **Manifest + config version bump** to **v0.7.0** (`manifest.json` + `config.js` `EXT_VERSION`).

### Deferred (DO NOT add to Ext.7)

- Telemetry opt-out switch → **Ext.8** (leave `modules/telemetry.js` opt-out alone; Ext.7 only touches `normalizeErrorCode` and calls `emit()`).
- Diagnostic bundle generator → **Ext.8** (`modules/diagnostics.js` is still a stub file).
- `/api/ext-config` consumption / kill-switch / tunable-from-server → **Ext.9**.
- CI packaging + Chrome Web Store submission → **Ext.10+**.
- WebApp State F UI (the "partial run" view) — separate phase; Ext.7 only touches the extension + Port. If a `result_json` shape change is required for State F (e.g. `final_path` from the optional bundle), flag as cross-phase note in Task 9.
- Ext.5's dirty-tree list (`server/routes/gpu.js`, `server/services/gpu-failure-poller.js`, `check_placement.js`, `final_query*.js`, `query_*.js`, `server/db.sqlite`, `server/seed/update-*.js`, `docs/plans/2026-04-22-reset-broll-searches.md`, `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md`) — **untouched**. The worktree starts from current `main`; if the dirty tree is still dirty, stash it and resume after.

## Prerequisites

- Weeks 1-4 merged to local `main` (Ext.5 + Ext.6 at 6020dd5 or later).
- `chrome` + Node 20+ (Vite build).
- Test Envato subscription (for the manual smoke task — the failure-matrix cases need live 429 / 402 / ZIP responses).
- Test Freepik item ID that returns a short-TTL signed URL (find in Ext.3's smoke fixtures; else use a minted URL with `--ttl=60`).
- `chrome://extensions` loaded with the unpacked dev build.
- `localhost:3001` backend running (for the JWT refresh + telemetry POST paths).
- Worktree skill: `superpowers:using-git-worktrees` (for Task 0's `.worktrees/extension-ext7` setup).

## File structure (Ext.7 final state)

```
extension/
├── manifest.json              [MOD Ext.7] version: "0.7.0"
├── config.js                  [MOD Ext.7] EXT_VERSION = '0.7.0'; new retry/cap constants
├── service_worker.js          unchanged
├── popup.html                 unchanged
├── popup.js                   [MOD Ext.7] "Disk error" copy state for hardstop
├── modules/
│   ├── auth.js                unchanged
│   ├── envato.js              [MOD Ext.7] getSignedDownloadUrl attaches Retry-After + httpStatus to thrown errors
│   ├── sources.js             [MOD Ext.7] fetchFreepikUrl surfaces Retry-After; URL-refetch helper exported
│   ├── queue.js               [MOD Ext.7] dispatch on classifier verdict; deny-list gate; daily-cap gate; integrity check
│   ├── storage.js             [MOD Ext.7] deny_list_alerted map + getter/setter; daily-cap warn-helper
│   ├── telemetry.js           [MOD Ext.7] normalizeErrorCode tightens; adds known prefix-coded branches
│   ├── classifier.js          [NEW Ext.7] single-purpose module — error → verdict mapping
│   ├── port.js                [MOD Ext.7] item_finalized message (if bundle Q1=yes); "disk_error" hardstop broadcast
│   └── diagnostics.js         unchanged (Ext.8 will fill)
├── fixtures/                  unchanged
└── icons/
```

Why this split:

- **`classifier.js` as a new module, not a helper inside `queue.js`.** The classifier is pure (no chrome.* calls, no state) and exceptionally testable. Putting it in its own file lets the failure-matrix be unit-tested without booting the full queue. Future phases (Ext.9 kill-switch) can intercept the classifier verdict before dispatch.
- **`storage.js` grows the `deny_list_alerted` map + a `shouldAlertForDeny` helper.** Alert dedupe is storage-semantic (24h persistence across SW termination); it belongs next to the deny-list reader/writer, not in `telemetry.js`.
- **`envato.js` and `sources.js` get *minimal* changes**: just attach `Retry-After` / `httpStatus` / response body to thrown errors. The classifier is the right place for the "402+body-says-upgrade → tier-restricted" decision; the source modules should remain thin.
- **`queue.js` absorbs the daily-cap gate, integrity check, and verdict dispatch**; it's the dispatcher of record.
- **`popup.js` gets a single copy change** — "Disk error — change folder and retry" — so the user can recover without a DevTools spelunk.

## Working conventions for these tasks

- **Worktree.** All work happens in `.worktrees/extension-ext7` (branch `feature/extension-ext7-failure-polish`) created off current `main`. Use the `superpowers:using-git-worktrees` skill for Task 0. Do NOT work on `main` directly.
- **Never push.** No `git push origin` until the user confirms. Commits stay local.
- **Never kill anything on `:3001`.** The backend is running and other phases need it. Use `curl localhost:3001/api/healthz` to verify liveness; do not pkill/killall. If the port is wedged, ask the user.
- **Quote every path.** The repo lives at `/Users/laurynas/Desktop/one last /transcript-eval` — the trailing space in `"one last "` is load-bearing. Every bash invocation quotes the full path with double-quotes; heredocs use absolute paths; `cd` is used sparingly.
- **Never amend.** Always new commits, even after a pre-commit hook failure. The worktree may grow noisy; that's fine.
- **One commit per task.** Each `Task N` ends with exactly one commit (or zero, for the manual-verify final task which is explicitly marked "DO NOT COMMIT"). Conventional-commit prefixes: `feat(extension):`, `fix(extension):`, `refactor(extension):`, `chore(extension):`.
- **Commit trailer.** Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` (see examples in each task).
- **Dirty-tree off-limits.** `server/routes/gpu.js`, `server/services/gpu-failure-poller.js`, `check_placement.js`, `final_query*.js`, `query_*.js`, `server/db.sqlite`, `server/seed/update-*.js`, `docs/plans/2026-04-22-reset-broll-searches.md`, `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md` — do not stage, do not commit, do not modify. These may appear as dirty in `git status`; leave them alone.
- **Investigate, don't guess.** Before wiring a new classifier branch, `git grep` for existing references (e.g. `envato_429` appears in telemetry.js, envato.js, and queue.js — all three need to agree). Before adding a new storage key, `git grep -n "chrome.storage.local.get" extension/` to confirm no collision.

## Task 0: Create worktree + branch + scaffold commit

**Files:** none (git operations only).

- [ ] **Step 0.1: Verify clean enough tree.** `git -C "/Users/laurynas/Desktop/one last /transcript-eval" status --short | grep -vE '^(\\?\\?)|gpu|check_placement|final_query|query_|server/db\\.sqlite|server/seed/update-|docs/plans/2026-04-22|docs/superpowers/plans/2026-04-22' | head -20`. Output must be empty (only the known dirty-tree files present). If anything else is dirty, stop and ask the user.
- [ ] **Step 0.2: Create worktree.** Invoke `superpowers:using-git-worktrees`. Target directory: `.worktrees/extension-ext7`. Branch name: `feature/extension-ext7-failure-polish`. Base: `main`. The skill handles the `git worktree add` + initial `cd`.
- [ ] **Step 0.3: Smoke that the worktree imports build.** `cd` into the worktree then `npm --prefix extension run build 2>&1 | tail -20` should exit 0. (Ext.6 landed a build script; if the command fails, the worktree setup is broken — do not proceed.)
- [ ] **Step 0.4: Scaffold commit.** Empty-ish commit marking the start of Ext.7 work. This ensures the branch has at least one commit that distinguishes it from `main`, which makes later `git log --oneline main..HEAD` output readable.

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git commit --allow-empty -m "$(cat <<'EOF'
chore(extension): start Ext.7 failure-mode polish branch

Empty scaffold commit to distinguish the branch from main.
Ext.7 implements the 17-row failure matrix from the extension
spec, deny-list writes, 429 retry-after handling, daily-cap
enforcement, and integrity checks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 0.5: Verify branch + worktree.** `git -C "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7" branch --show-current` returns `feature/extension-ext7-failure-polish`; `git log --oneline main..HEAD` shows exactly the scaffold commit.

## Task 1: Manifest + config bump (v0.7.0 + new constants)

**Files:** `extension/manifest.json`, `extension/config.js`.

- [ ] **Step 1.1: Bump manifest version.** Edit `extension/manifest.json`: `"version": "0.6.0"` → `"version": "0.7.0"`. (The chrome-webstore field is `version`; the dev-mode UI reads the same.)
- [ ] **Step 1.2: Bump EXT_VERSION in config.js.** `export const EXT_VERSION = '0.6.0'` → `'0.7.0'`.
- [ ] **Step 1.3: Add Ext.7 constants block to config.js.** Append after the Ext.6 telemetry block (line ~99), before the file ends:

```js
// -------- Ext.7 failure-mode polish --------
//
// Source of truth for retry timings, backoff caps, and daily-cap
// thresholds. Ext.9 will serve these from /api/ext-config; for now
// they are compile-time baked in.

// Resolver tab retry: one retry at +30s on timeout, then give up.
export const RESOLVER_RETRY_DELAY_MS = 30000
export const RESOLVER_MAX_ATTEMPTS   = 2  // initial + 1 retry

// Envato download.data 5xx / network exponential backoff: 1s, 5s, 15s, 60s,
// then license_failed. Four total attempts.
export const ENVATO_LICENSE_BACKOFF_MS = [1000, 5000, 15000, 60000]

// Retry-After clamp (in seconds). Envato may return absurd values
// or a misbehaving CDN may return garbage; clamp to a sane window so
// we never sleep for days.
export const RETRY_AFTER_MIN_SEC = 1
export const RETRY_AFTER_MAX_SEC = 600

// Jitter applied to Retry-After values. Spec says ±20%.
export const RETRY_AFTER_JITTER = 0.20

// 429 escalation: after second 429, pause the queue this long, then
// one final retry before hard-stop.
export const ENVATO_429_COOLDOWN_MS = 5 * 60 * 1000  // 5 minutes

// Daily cap per source per user. Warn at warn_at; hard-stop (that
// source) at hard_stop_at.
export const DAILY_CAP_WARN_AT      = 400
export const DAILY_CAP_HARD_STOP_AT = 500

// Deny-list alert dedupe window. One Slack alert per
// (source_item_id, error_code) per this many ms.
export const DENY_LIST_ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000  // 24h

// Freepik URL-refetch-on-expiry cap. After this many refetches that
// still yield an expired URL, mark url_expired_refetch_failed.
export const FREEPIK_URL_REFETCH_CAP = 2

// Integrity check: size-mismatch tolerance. If the downloaded size
// is within ±N% of est_size_bytes, accept (some CDNs return slightly
// different sizes than the catalogue claimed). Below / above → retry
// once, then integrity_failed.
export const INTEGRITY_TOLERANCE = 0.05  // ±5%
```

- [ ] **Step 1.4: Verify.** `node -e "import('./extension/config.js').then(m => console.log(m.EXT_VERSION))"` → `0.7.0`. Open `manifest.json`, confirm `version` reads `"0.7.0"`.
- [ ] **Step 1.5: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/manifest.json extension/config.js
git commit -m "$(cat <<'EOF'
feat(extension): bump to v0.7.0 + Ext.7 failure-mode constants

manifest.json + config.js EXT_VERSION → 0.7.0. config.js grows
a new Ext.7 block with retry timings (resolver retry delay,
Envato license backoff, Retry-After clamps, 429 cooldown), the
daily-cap thresholds (warn @ 400, hard-stop @ 500), and the
24h deny-list alert dedupe window.

All constants are Ext.9-hot-replaceable (the kill-switch phase
will serve them from /api/ext-config); defaults match the
extension spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 2: `storage.js` — deny-list alert dedupe + daily-cap warn-helper

**Files:** `extension/modules/storage.js`.

- [ ] **Step 2.1: Add `deny_list_alerted` key to the enum + doc comment.** In the top-of-file key-doc block, append:

```
//   deny_list_alerted
//     { "<source>|<source_item_id>|<error_code>": <last_emitted_at_epoch_ms> }
//     Dedupe map for 24h-rate-limited telemetry alerts. Ext.7 reads
//     before emitting an alert-flagged event; writes on emit. MV3 SW
//     termination would otherwise lose this — persistence is mandatory.
```

Also add `denyListAlerted: 'deny_list_alerted'` to the `K` object.

- [ ] **Step 2.2: Add `shouldAlertForDeny(source, itemId, errorCode)` reader.** Returns `true` if the dedupe window elapsed OR there's no prior entry.

```js
import { DENY_LIST_ALERT_DEDUPE_MS } from '../config.js'

function denyAlertKey(source, itemId, errorCode) {
  return `${source}|${itemId}|${errorCode}`
}

// Ext.7. Returns true if we should emit a Slack-alert-flagged telemetry
// event for this (source, item, error_code) tuple now — i.e. the 24h
// dedupe window has elapsed. Returns false if we alerted recently.
export async function shouldAlertForDeny(source, itemId, errorCode) {
  const { [K.denyListAlerted]: map } = await chrome.storage.local.get(K.denyListAlerted)
  const last = map && map[denyAlertKey(source, itemId, errorCode)]
  if (!last) return true
  return Date.now() - last >= DENY_LIST_ALERT_DEDUPE_MS
}

// Ext.7. Stamps the dedupe map with `now` for this (source, item,
// error_code). Call BEFORE emitting the alert (so a SW death between
// the persist and emit doesn't duplicate-alert on next SW wake).
export async function markAlertEmitted(source, itemId, errorCode) {
  const { [K.denyListAlerted]: existing } = await chrome.storage.local.get(K.denyListAlerted)
  const map = existing || {}
  map[denyAlertKey(source, itemId, errorCode)] = Date.now()
  await chrome.storage.local.set({ [K.denyListAlerted]: map })
}
```

- [ ] **Step 2.3: Add `checkDailyCapThreshold(source)` helper.** Returns `'ok' | 'warn' | 'hard_stop'` based on the current day's count.

```js
import { DAILY_CAP_WARN_AT, DAILY_CAP_HARD_STOP_AT } from '../config.js'

// Ext.7. Returns 'ok' / 'warn' / 'hard_stop' based on the current
// day's count for `source`. Called by the queue before every download
// start AND after every download complete (the cap is on completed
// downloads; `warn` fires on the download that would cross the warn
// threshold, `hard_stop` fires when we try to start a download at or
// above the hard-stop threshold).
export async function checkDailyCapThreshold(source) {
  const count = await getDailyCount(source)
  if (count >= DAILY_CAP_HARD_STOP_AT) return 'hard_stop'
  if (count >= DAILY_CAP_WARN_AT) return 'warn'
  return 'ok'
}
```

- [ ] **Step 2.4: Verify.** Import-time smoke: `node -e "import('./extension/modules/storage.js').then(m => console.log(Object.keys(m).sort().join(',')))"` should list `addToDenyList,checkDailyCapThreshold,clearActiveRunId,deleteRunState,getActiveRunId,getAllCompletedForFolder,getDailyCount,incrementDailyCount,isCompleted,isDenied,loadRunState,markAlertEmitted,markCompleted,saveRunState,setActiveRunId,shouldAlertForDeny`.
- [ ] **Step 2.5: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/modules/storage.js
git commit -m "$(cat <<'EOF'
feat(extension): storage — deny-list alert dedupe + daily-cap threshold helper

Adds `deny_list_alerted` storage map (keyed by
source|item_id|error_code → last_emitted_at_ms) with
shouldAlertForDeny / markAlertEmitted helpers for the 24h
rate-limited telemetry pattern Ext.7 uses on the ZIP/AEP/PRPROJ
path.

Adds checkDailyCapThreshold(source) → 'ok'|'warn'|'hard_stop'
for the queue's pre-download gate.

Both helpers are persistence-only — no queue wiring here;
Task 5 + Task 6 consume them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 3: `classifier.js` — pure error → verdict mapping

**Files:** `extension/modules/classifier.js` [NEW].

- [ ] **Step 3.1: Create `extension/modules/classifier.js`.** This is a pure module — no `chrome.*` calls, no state, no async. Just deterministic mapping.

```js
// Ext.7 — single-purpose error classifier.
//
// Maps (phase, error) to a verdict that the queue dispatches on.
// Verdicts are disjoint:
//   { retry: { delay_ms, attempts_left } }
//     — sleep delay_ms, then retry. Classifier tracks attempt count
//       via the error's `attempt` field; caller decrements.
//   { skip: { error_code, detail? } }
//     — item-only failure; queue calls failItem.
//   { hardStop: { error_code, detail? } }
//     — whole-queue failure; queue calls hardStopQueue.
//   { pauseThenRetry: { pause_ms, error_code, final_attempt_left: true } }
//     — pause the queue for pause_ms, then on resume attempt once
//       more; if that fails, hardStop.
//   { cooldownThenRetry: { cooldown_ms, error_code, final_attempt } }
//     — same as pauseThenRetry but semantically tied to 429 escalation.
//
// The classifier is pure so it's unit-testable without booting the
// queue. Future phases (Ext.9 kill-switch) can intercept the verdict
// before dispatch.

import {
  ENVATO_LICENSE_BACKOFF_MS,
  ENVATO_429_COOLDOWN_MS,
  RETRY_AFTER_MIN_SEC,
  RETRY_AFTER_MAX_SEC,
  RETRY_AFTER_JITTER,
  RESOLVER_MAX_ATTEMPTS,
  RESOLVER_RETRY_DELAY_MS,
  DOWNLOAD_NETWORK_RETRY_CAP,
} from '../config.js'

// Parse Retry-After header (RFC 7231: seconds OR HTTP-date).
// Returns seconds, clamped to [RETRY_AFTER_MIN_SEC, RETRY_AFTER_MAX_SEC],
// with ±RETRY_AFTER_JITTER jitter. Null input → default 60s.
export function parseRetryAfter(header) {
  if (!header) return 60
  const asNum = Number(header)
  let sec
  if (Number.isFinite(asNum)) {
    sec = asNum
  } else {
    const dateMs = Date.parse(header)
    if (Number.isFinite(dateMs)) {
      sec = Math.floor((dateMs - Date.now()) / 1000)
    } else {
      sec = 60
    }
  }
  sec = Math.max(RETRY_AFTER_MIN_SEC, Math.min(RETRY_AFTER_MAX_SEC, sec))
  const jitterBand = sec * RETRY_AFTER_JITTER
  const jittered = sec + (Math.random() * 2 - 1) * jitterBand
  return Math.max(RETRY_AFTER_MIN_SEC, Math.floor(jittered))
}

// Classify a resolver-phase error (Phase 1).
// Triggers: resolve_timeout, no_uuid, unexpected.
// item.resolve_attempts is maintained by the queue across retries.
export function classifyResolverError(err, item) {
  const msg = String(err?.message || err)
  if (msg === 'resolve_timeout') {
    const attempts = (item?.resolve_attempts || 0) + 1
    if (attempts < RESOLVER_MAX_ATTEMPTS) {
      return { retry: { delay_ms: RESOLVER_RETRY_DELAY_MS, attempts_left: RESOLVER_MAX_ATTEMPTS - attempts } }
    }
    return { skip: { error_code: 'resolve_failed', detail: 'resolve_timeout after retries' } }
  }
  // Envato's resolver throws a different shape for "no UUID in redirect"
  // — the resolver tab committed to a non-app.envato.com URL (likely
  // the old slug is delisted). No retry; spec says "skip, no retry".
  if (msg.includes('no_uuid') || msg.includes('delisted')) {
    return { skip: { error_code: 'envato_unavailable', detail: msg } }
  }
  // Unknown — skip conservatively.
  return { skip: { error_code: 'resolve_failed', detail: msg } }
}

// Classify a licenser-phase error (Envato Phase 2).
// The error carries err.httpStatus + err.retryAfter + err.body when
// available (envato.js attaches these before throwing in Task 4).
// item.license_attempts is the number of prior attempts.
export function classifyLicenseError(err, item) {
  const msg = String(err?.message || err)
  const status = err?.httpStatus
  const body = err?.body || ''
  const attempts = item?.license_attempts || 0

  // 401 — session expired.
  if (msg === 'envato_session_missing' || status === 401) {
    // Ext.5 already pauses the queue + broadcasts refresh_session via
    // handle401Envato. The classifier returns skip; queue calls
    // failItem with envato_session_401 and the queue-level pause is
    // the broader mechanism.
    return { skip: { error_code: 'envato_session_401', detail: msg } }
  }

  // 402 or 403-with-"upgrade" body → tier-restricted, skip.
  if (status === 402) {
    return { skip: { error_code: 'envato_402_tier', detail: msg } }
  }
  if (status === 403 && /upgrade/i.test(body)) {
    return { skip: { error_code: 'envato_402_tier', detail: 'http_403 body contains upgrade' } }
  }
  // 403 generic → hard stop.
  if (status === 403) {
    return { hardStop: { error_code: 'envato_403', detail: msg } }
  }

  // 429 escalation: first 429 → Retry-After + jitter, 1 retry.
  //                 second 429 → 5min cooldown, 1 final retry.
  //                 third 429 → hard stop.
  if (status === 429 || msg === 'envato_429') {
    const retryCount = item?.rate_limit_429_count || 0
    if (retryCount === 0) {
      const retryAfterSec = parseRetryAfter(err?.retryAfter)
      return { retry: { delay_ms: retryAfterSec * 1000, attempts_left: 2, error_code_on_fail: 'envato_429' } }
    }
    if (retryCount === 1) {
      return { cooldownThenRetry: { cooldown_ms: ENVATO_429_COOLDOWN_MS, error_code: 'envato_429', final_attempt: true } }
    }
    return { hardStop: { error_code: 'envato_429', detail: 'third 429 after cooldown' } }
  }

  // 5xx / network / DNS / timeout — exponential backoff per config.
  if ((status && status >= 500) || msg === 'envato_network_error' || msg.startsWith('envato_network_error')) {
    const backoff = ENVATO_LICENSE_BACKOFF_MS
    if (attempts < backoff.length) {
      return { retry: { delay_ms: backoff[attempts], attempts_left: backoff.length - attempts, error_code_on_fail: 'envato_unavailable' } }
    }
    return { skip: { error_code: 'envato_unavailable', detail: 'license 5xx retries exhausted' } }
  }

  // Empty downloadUrl — item delisted. Skip.
  if (msg === 'envato_unavailable') {
    return { skip: { error_code: 'envato_unavailable', detail: 'empty downloadUrl' } }
  }

  // Unsupported filetype (post-license URL check) — skip + deny-list.
  // Queue is responsible for the deny-list write; classifier just
  // returns the verdict.
  if (msg === 'envato_unsupported_filetype') {
    return { skip: { error_code: 'envato_unsupported_filetype', detail: err?.detail || 'zip/aep/prproj' } }
  }

  // Unknown — skip conservatively.
  return { skip: { error_code: 'envato_unavailable', detail: msg } }
}

// Classify a Freepik/Pexels mint-phase error.
export function classifySourceMintError(err, item) {
  const msg = String(err?.message || err)
  const status = err?.httpStatus

  if (msg === 'pexels_404' || msg === 'freepik_404') {
    const code = msg === 'pexels_404' ? 'pexels_404' : 'freepik_404'
    return { skip: { error_code: code, detail: 'upstream 404' } }
  }

  if (msg === 'freepik_429' || status === 429) {
    const attempts = item?.freepik_429_count || 0
    if (attempts === 0) {
      return { cooldownThenRetry: { cooldown_ms: ENVATO_429_COOLDOWN_MS, error_code: 'freepik_429', final_attempt: true } }
    }
    return { hardStop: { error_code: 'freepik_429', detail: 'second freepik 429 after cooldown' } }
  }

  if (msg === 'freepik_unconfigured') {
    // Skip this item AND every other freepik item in the run; queue
    // pulls that behaviour out of the skip verdict via the special
    // skip_whole_source flag.
    return { skip: { error_code: 'freepik_unconfigured', detail: 'backend 503 no API key', skip_whole_source: 'freepik' } }
  }

  if (msg.startsWith('network_error')) {
    const attempts = item?.mint_attempts || 0
    const backoff = ENVATO_LICENSE_BACKOFF_MS
    if (attempts < backoff.length) {
      return { retry: { delay_ms: backoff[attempts], attempts_left: backoff.length - attempts, error_code_on_fail: 'freepik_404' } }
    }
    return { skip: { error_code: 'freepik_404', detail: 'mint network exhausted' } }
  }

  return { skip: { error_code: msg.startsWith('pexels') ? 'pexels_404' : 'freepik_404', detail: msg } }
}

// Classify a download-phase error (chrome.downloads interrupt).
// Called from handleDownloadInterrupt.
export function classifyDownloadInterrupt(reason, item) {
  if (reason === 'USER_CANCELED') {
    // Treated as skip-but-continue (not an error). Queue calls
    // failItem with 'cancelled' so the item counts as failed, but
    // the queue keeps rolling on other items.
    return { skip: { error_code: 'cancelled', detail: 'user cancelled' } }
  }
  if (reason.startsWith('NETWORK_')) {
    const retries = item?.retries || 0
    if (retries < DOWNLOAD_NETWORK_RETRY_CAP) {
      return { retry: { delay_ms: 0, attempts_left: DOWNLOAD_NETWORK_RETRY_CAP - retries, error_code_on_fail: 'network_failed', use_chrome_resume: true } }
    }
    return { skip: { error_code: 'network_failed', detail: reason } }
  }
  if (reason.startsWith('FILE_')) {
    return { hardStop: { error_code: 'disk_failed', detail: reason } }
  }
  if (reason === 'SERVER_FORBIDDEN' || reason === 'SERVER_UNAUTHORIZED') {
    // Signed URL expired mid-download. For Freepik, the queue will
    // try a URL refetch before treating as failure (it checks the
    // item's source + refetch_count). Here we just signal skip; the
    // queue will decide whether to promote to a refetch retry.
    return { skip: { error_code: 'url_expired_refetch_failed', detail: reason, maybe_refetch: true } }
  }
  return { skip: { error_code: 'network_failed', detail: reason } }
}

// Classify an integrity-check failure.
export function classifyIntegrityError(item) {
  const attempts = item?.integrity_retries || 0
  if (attempts === 0) {
    return { retry: { delay_ms: 0, attempts_left: 1, error_code_on_fail: 'integrity_failed', redownload: true } }
  }
  return { skip: { error_code: 'integrity_failed', detail: 'size mismatch after retry' } }
}
```

- [ ] **Step 3.2: Smoke the parser.** Run a quick in-process sanity check (or add a tiny `extension/modules/__classifier-smoke.js` that calls `parseRetryAfter` with `"42"`, `"Sat, 24 Apr 2027 12:00:00 GMT"`, `"garbage"`, `null`; output must be finite ints in `[1,600]`).
- [ ] **Step 3.3: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/modules/classifier.js
git commit -m "$(cat <<'EOF'
feat(extension): classifier — pure error→verdict mapping

New modules/classifier.js (pure module; no chrome.* calls, no
state). Exports classifyResolverError / classifyLicenseError /
classifySourceMintError / classifyDownloadInterrupt /
classifyIntegrityError, each returning one of four disjoint
verdicts: retry, skip, hardStop, cooldownThenRetry.

Also exports parseRetryAfter — RFC 7231 seconds-OR-HTTP-date
parser with ±20% jitter and [1, 600]s clamp.

Queue wiring happens in Task 4 and Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 4: `envato.js` + `sources.js` — attach response metadata to thrown errors

**Files:** `extension/modules/envato.js`, `extension/modules/sources.js`.

- [ ] **Step 4.1: Refactor `getSignedDownloadUrl` in `envato.js` to attach `httpStatus`, `retryAfter`, and `body` to the thrown Errors.** Currently throws `new Error('envato_429')`; we want the classifier to see the Retry-After header.

Replace the existing status-branching block:

```js
  if (resp.status === 401) {
    await handle401Envato()
    const err = new Error('envato_session_missing')
    err.httpStatus = 401
    throw err
  }
  if (resp.status === 402) {
    const err = new Error('envato_402')
    err.httpStatus = 402
    // Read body so classifier can check for the "upgrade" hint.
    try { err.body = await resp.text() } catch {}
    throw err
  }
  if (resp.status === 403) {
    const err = new Error('envato_403')
    err.httpStatus = 403
    try { err.body = await resp.text() } catch {}
    throw err
  }
  if (resp.status === 429) {
    const err = new Error('envato_429')
    err.httpStatus = 429
    err.retryAfter = resp.headers.get('Retry-After') || null
    throw err
  }
  if (resp.status >= 500) {
    const err = new Error('envato_http_' + resp.status)
    err.httpStatus = resp.status
    throw err
  }
  if (!resp.ok) {
    const err = new Error('envato_http_' + resp.status)
    err.httpStatus = resp.status
    throw err
  }
```

(Subtly: the existing 401 branch calls `await handle401Envato()` then throws. Keep that; we just also attach `httpStatus = 401`. Classifier reads `err.httpStatus`.)

- [ ] **Step 4.2: Apply the same treatment to `sources.js` `fetchFreepikUrl` and `fetchPexelsUrl`.** Currently they throw raw `new Error('freepik_429')` etc.; attach `httpStatus` and `retryAfter`.

```js
  if (resp.status === 404) {
    const err = new Error('freepik_404')
    err.httpStatus = 404
    throw err
  }
  if (resp.status === 429) {
    const err = new Error('freepik_429')
    err.httpStatus = 429
    err.retryAfter = resp.headers.get('Retry-After') || null
    throw err
  }
  if (resp.status === 503) {
    const err = new Error('freepik_unconfigured')
    err.httpStatus = 503
    throw err
  }
  if (!resp.ok) {
    const err = new Error('freepik_api_error')
    err.httpStatus = resp.status
    throw err
  }
```

Same shape for Pexels (`pexels_404`, `pexels_api_error`).

- [ ] **Step 4.3: Export a `refetchFreepikUrl(itemId)` helper.** This is just a named alias for `fetchFreepikUrl` with clearer intent; the queue calls it on expiry to distinguish initial fetch from refetch in logs. Keep it minimal — it's syntactic sugar:

```js
// Ext.7: Freepik URL refetch on expiry. Same as fetchFreepikUrl but
// a) the caller's intent is clear in logs, and b) future phases can
// add refetch-specific telemetry here without touching the initial
// fetch path.
export async function refetchFreepikUrl(itemId, format = 'mp4') {
  return fetchFreepikUrl({ itemId, format })
}
```

- [ ] **Step 4.4: Verify.** `grep -n "throw new Error" extension/modules/envato.js extension/modules/sources.js` should show every throw site now ships inside a `const err = new Error(...); err.httpStatus = ...; throw err` block (except the orchestrator wrappers at the bottom of `envato.js`'s `downloadEnvato` / `sources.js`'s `downloadSourceItem` which return `{ok:false, errorCode}` and don't throw).
- [ ] **Step 4.5: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/modules/envato.js extension/modules/sources.js
git commit -m "$(cat <<'EOF'
refactor(extension): attach httpStatus/retryAfter/body to thrown
envato + sources errors

getSignedDownloadUrl (envato.js), fetchPexelsUrl and fetchFreepikUrl
(sources.js) now attach response metadata to their thrown Error
objects so the Ext.7 classifier can distinguish 402 / 403-upgrade /
403-generic / 429-with-Retry-After / 5xx without re-parsing the
response at the throw site.

Also exports a named refetchFreepikUrl(itemId) alias for queue
use on mid-download URL expiry. Behaviour-identical to
fetchFreepikUrl; separate name makes log intent clear.

No functional change at the orchestrator surface — Ext.7 only
uses these errors internally (the queue consumes them; the
single-download {ok, errorCode} objects at the bottom of each
module still normalize to string codes before returning).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 5: `queue.js` — wire classifier + deny-list + alert dedupe

**Files:** `extension/modules/queue.js`.

This is the biggest task — the queue's three workers (`runResolver`, `runLicenser`, `runDownloader`) and the interrupt handler all grow verdict-dispatch logic.

- [ ] **Step 5.1: Add new imports.** At the top of `queue.js`:

```js
import {
  classifyResolverError,
  classifyLicenseError,
  classifySourceMintError,
  classifyDownloadInterrupt,
  classifyIntegrityError,
  parseRetryAfter,
} from './classifier.js'
import {
  isDenied,
  addToDenyList,
  shouldAlertForDeny,
  markAlertEmitted,
  incrementDailyCount,
  checkDailyCapThreshold,
} from './storage.js'
```

- [ ] **Step 5.2: Add per-item retry counters to `buildInitialRunState`.** In the items map, add:

```js
      resolve_attempts: 0,
      license_attempts: 0,
      rate_limit_429_count: 0,
      freepik_429_count: 0,
      mint_attempts: 0,
      url_refetch_count: 0,
      integrity_retries: 0,
```

These are persisted (no in-memory-only marker), so a SW restart remembers the retry state.

- [ ] **Step 5.3: Refactor `runResolver` to dispatch on classifier verdict.**

```js
async function runResolver(item) {
  item.claimed = true
  item.phase = 'resolving'
  item.resolve_started_at = Date.now()
  await persistAndBroadcast()
  try {
    const uuid = await resolveOldIdToNewUuid(item.envato_item_url)
    item.resolved_uuid = uuid
    item.phase = 'licensing'
    item.claimed = false
    emitTelemetry('item_resolved', {
      export_id: state.runId,
      item_id: item.source_item_id,
      source: 'envato',
      phase: 'resolve',
      t: Date.now(),
      meta: { resolve_ms: Date.now() - (item.resolve_started_at || Date.now()) },
    })
    await persistAndBroadcast()
  } catch (err) {
    item.resolve_attempts = (item.resolve_attempts || 0) + 1
    const verdict = classifyResolverError(err, item)
    await applyVerdict(item, verdict, { phase: 'resolve', err })
  }
}
```

- [ ] **Step 5.4: Refactor `runLicenser` to gate on deny-list + classifier.**

```js
async function runLicenser(item) {
  item.claimed = true
  item.license_started_at = Date.now()

  // --- Ext.7 deny-list gate ---
  // Read BEFORE the license GET so we don't spend a license on a
  // known-bad filetype. Non-Envato sources don't reach this worker.
  try {
    if (await isDenied(item.source, item.source_item_id)) {
      await failItem(item, 'envato_unsupported_filetype')
      // Alert dedupe: only emit once per 24h.
      await maybeEmitDenyAlert(item, 'envato_unsupported_filetype', 'pre-deny-hit')
      return
    }
  } catch (err) {
    console.warn('[queue] deny-list read failed — proceeding', err)
  }

  await persistAndBroadcast()
  try {
    const signedUrl = await getSignedDownloadUrl(item.resolved_uuid)

    // Ext.7 post-license filetype check. Envato's own orchestrator
    // (envato.js `downloadEnvato`) does this for single-shot; the
    // queue does it here for the pool path.
    const cdnFilename = extractFilenameFromSignedUrl(signedUrl)
    if (cdnFilename && /\.(zip|aep|prproj)$/i.test(cdnFilename)) {
      // Write to deny-list THEN emit alert (persist-before-emit).
      await addToDenyList(item.source, item.source_item_id, `unsupported_filetype:${cdnFilename}`)
      await failItem(item, 'envato_unsupported_filetype')
      await maybeEmitDenyAlert(item, 'envato_unsupported_filetype', cdnFilename)
      return
    }

    item.signed_url = signedUrl
    item.phase = 'downloading'
    item.claimed = false
    emitTelemetry('item_licensed', {
      export_id: state.runId,
      item_id: item.source_item_id,
      source: 'envato',
      phase: 'license',
      t: Date.now(),
      meta: { license_ms: Date.now() - (item.license_started_at || Date.now()) },
    })
    await persistAndBroadcast()
  } catch (err) {
    item.license_attempts = (item.license_attempts || 0) + 1
    const verdict = classifyLicenseError(err, item)
    await applyVerdict(item, verdict, { phase: 'license', err })
  }
}
```

Also add an `extractFilenameFromSignedUrl` helper at the bottom of `queue.js` — same implementation as envato.js's private copy; paste it (or hoist to a shared util in a follow-up). Keep private to `queue.js` for now to avoid cross-module circular.

- [ ] **Step 5.5: Refactor `runDownloader` to dispatch mint errors on the classifier + gate on daily-cap.**

```js
async function runDownloader(item) {
  item.claimed = true

  // --- Ext.7 daily-cap hard-stop gate ---
  // Check BEFORE starting a new download. The per-download-complete
  // check at the end of handleDownloadEvent handles the "crossed the
  // threshold mid-run" case.
  const capStatus = await checkDailyCapThreshold(item.source).catch(() => 'ok')
  if (capStatus === 'hard_stop') {
    await failItem(item, `${item.source}_daily_cap_exceeded`)
    return
  }
  if (capStatus === 'warn' && !state.daily_cap_warned?.[item.source]) {
    state.daily_cap_warned = state.daily_cap_warned || {}
    state.daily_cap_warned[item.source] = Date.now()
    broadcast({ type: 'warn', message: `Approaching daily ${item.source} cap (400/500)` })
    await persist()
  }

  try {
    // JIT URL fetch for Pexels/Freepik.
    if (item.source !== 'envato' && !item.signed_url) {
      try {
        item.signed_url = await getSignedUrlForSource(item.source, item.source_item_id)
        if (item.source === 'freepik') {
          // Stash expires_at if the mint endpoint returned it.
          item.signed_url_expires_at = await getFreepikExpiresAt(item.source_item_id).catch(() => null)
        }
      } catch (err) {
        item.mint_attempts = (item.mint_attempts || 0) + 1
        const verdict = classifySourceMintError(err, item)
        await applyVerdict(item, verdict, { phase: 'download', err })
        return
      }
    }
    item.download_started_at = Date.now()
    const downloadId = await chrome.downloads.download({
      url: item.signed_url,
      filename: `${state.target_folder_path}/${item.target_filename}`,
      saveAs: false,
      conflictAction: 'uniquify',
    })
    item.download_id = downloadId
    state.download_id_to_seq[downloadId] = item.seq
    await persistAndBroadcast()
    await waitForDownloadSettled(item)
    item.claimed = false
  } catch (err) {
    await failItem(item, err?.message || 'download_failed')
  }
}
```

Note: `getSignedUrlForSource` currently fetches and returns `data?.url` only; for Freepik we also need `expires_at`. Add a paired helper:

```js
// Ext.7. Returns {url, expires_at} for Freepik mints; null for Pexels.
// Used so the queue can track URL TTL for refetch-on-expiry.
async function getFreepikExpiresAt(itemId) {
  // Cheap: fetchFreepikUrl was just called; we don't want to call it
  // again. Freepik's expires_at is already in the shape returned by
  // sources.js. Pull from the original mint call by widening
  // getSignedUrlForSource below.
  return null  // placeholder — see Step 5.5b
}
```

- [ ] **Step 5.5b: Widen `getSignedUrlForSource` to return the full object.** Change the helper (top of queue.js) from returning `data?.url` to returning the whole `{url, expires_at, size_bytes}`:

```js
async function getSignedUrlForSource(source, itemId) {
  if (source === 'pexels') {
    const data = await fetchPexelsUrl({ itemId })
    return { url: data?.url, size_bytes: data?.size_bytes || null }
  }
  if (source === 'freepik') {
    const data = await fetchFreepikUrl({ itemId })
    return { url: data?.url, expires_at: data?.expires_at || null, size_bytes: data?.size_bytes || null }
  }
  throw new Error(`unknown source: ${source}`)
}
```

Then in `runDownloader`:

```js
      const mint = await getSignedUrlForSource(item.source, item.source_item_id)
      item.signed_url = mint.url
      item.signed_url_expires_at = mint.expires_at || null
      item.expected_size_bytes = mint.size_bytes || item.total_bytes || null
```

`item.expected_size_bytes` drives the integrity check in Task 7.

- [ ] **Step 5.6: Implement `applyVerdict(item, verdict, context)`.** Central dispatcher for all classifier verdicts.

```js
async function applyVerdict(item, verdict, context) {
  if (verdict.skip) {
    // Special: freepik_unconfigured sets skip_whole_source so all
    // remaining freepik items bail out at once.
    if (verdict.skip.skip_whole_source) {
      const source = verdict.skip.skip_whole_source
      for (const it of state.items) {
        if (it.source === source && (it.phase === 'queued' || it.phase === 'licensing' || it.phase === 'downloading')) {
          it.phase = 'failed'
          it.error_code = verdict.skip.error_code
          state.stats.fail_count++
        }
      }
      await persistAndBroadcast()
    }
    await failItem(item, verdict.skip.error_code)
    // Signal settle so the worker's Promise doesn't dangle.
    item.__settle?.()
    return
  }
  if (verdict.hardStop) {
    await failItem(item, verdict.hardStop.error_code)
    item.__settle?.()
    await hardStopQueue(verdict.hardStop.error_code)
    return
  }
  if (verdict.retry) {
    // Emit a rate_limit_hit telemetry for 429 retries (so State F has
    // visibility into retry chains).
    if (context.err?.httpStatus === 429) {
      item.rate_limit_429_count = (item.rate_limit_429_count || 0) + 1
      const retryAfterSec = parseRetryAfter(context.err?.retryAfter)
      emitTelemetry('rate_limit_hit', {
        export_id: state.runId,
        item_id: item.source_item_id,
        source: item.source,
        phase: context.phase,
        t: Date.now(),
        http_status: 429,
        retry_count: item.rate_limit_429_count,
        meta: { retry_after_sec: retryAfterSec },
      })
    }
    if (verdict.retry.use_chrome_resume) {
      // Download-phase NETWORK_* retry. The existing
      // chrome.downloads.resume path handles it; caller should have
      // routed here via handleDownloadInterrupt.
      item.retries = (item.retries || 0) + 1
      chrome.downloads.resume(item.download_id).catch(async err => {
        await failItem(item, `network_resume_failed:${err?.message}`)
        item.__settle?.()
      })
      await persistAndBroadcast()
      return
    }
    // Normal retry: sleep, reset the relevant phase, let the scheduler
    // re-pick it on the next pass.
    if (verdict.retry.delay_ms > 0) {
      await sleep(verdict.retry.delay_ms)
    }
    // Reset phase so the worker re-picks.
    if (context.phase === 'resolve') {
      item.phase = 'queued'
    } else if (context.phase === 'license') {
      item.phase = 'licensing'
    } else {
      item.phase = 'downloading'
    }
    item.claimed = false
    item.signed_url = null // force JIT refetch on retry
    await persistAndBroadcast()
    schedule()
    return
  }
  if (verdict.cooldownThenRetry) {
    // Pause the queue for the cooldown, then resume with a final-retry
    // flag on the item. If the final retry fails, the classifier's
    // next verdict will be hardStop.
    item.rate_limit_429_count = (item.rate_limit_429_count || 0) + 1
    emitTelemetry('queue_paused', {
      export_id: state.runId,
      t: Date.now(),
      meta: { reason: `${verdict.cooldownThenRetry.error_code}_cooldown` },
    })
    state.run_state = 'paused'
    await persistAndBroadcast()
    setTimeout(async () => {
      if (!state || state.run_state !== 'paused') return
      // Resume only if we're still the same run.
      state.run_state = 'running'
      item.phase = context.phase === 'resolve' ? 'queued'
                  : context.phase === 'license' ? 'licensing'
                  : 'downloading'
      item.claimed = false
      item.signed_url = null
      await persistAndBroadcast()
      emitTelemetry('queue_resumed', { export_id: state.runId, t: Date.now() })
      schedule()
    }, verdict.cooldownThenRetry.cooldown_ms)
    return
  }
  // Unknown verdict — defensive skip.
  await failItem(item, 'unknown_verdict')
  item.__settle?.()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
```

- [ ] **Step 5.7: Implement `maybeEmitDenyAlert(item, errorCode, detail)`.** Checks the 24h dedupe; marks emitted; emits with alert flag.

```js
async function maybeEmitDenyAlert(item, errorCode, detail) {
  try {
    const should = await shouldAlertForDeny(item.source, item.source_item_id, errorCode)
    if (!should) return
    // Persist BEFORE emit so a SW death between the two doesn't
    // double-alert on next wake.
    await markAlertEmitted(item.source, item.source_item_id, errorCode)
    emitTelemetry('item_failed', {
      export_id: state.runId,
      item_id: item.source_item_id,
      source: item.source,
      phase: 'license',
      t: Date.now(),
      error_code: errorCode,
      retry_count: 0,
      meta: { alert: true, detail, filename: detail },
    })
  } catch (err) {
    console.warn('[queue] maybeEmitDenyAlert failed', err)
  }
}
```

(Note: the backend's Slack-alert logic keys on `meta.alert === true` — the telemetry event itself looks ordinary, it just carries an extra meta flag the server routes to Slack. If the backend doesn't yet route on `meta.alert`, flag that as a cross-phase note in Task 9.)

- [ ] **Step 5.8: Refactor `handleDownloadInterrupt` to dispatch on the classifier.** Replace the existing body with:

```js
async function handleDownloadInterrupt(item, delta) {
  const reason = delta.error?.current || 'UNKNOWN'
  const verdict = classifyDownloadInterrupt(reason, item)

  // Special: url-expired maybe-refetch path. The classifier returned
  // skip with maybe_refetch; the queue decides whether to promote to
  // a refetch-retry based on source + refetch count.
  if (verdict.skip?.maybe_refetch && item.source === 'freepik') {
    if ((item.url_refetch_count || 0) < FREEPIK_URL_REFETCH_CAP) {
      item.url_refetch_count = (item.url_refetch_count || 0) + 1
      item.signed_url = null
      item.phase = 'downloading'
      item.claimed = false
      await persistAndBroadcast()
      schedule()
      return
    }
    // Refetch cap hit — final verdict.
    await failItem(item, 'url_expired_refetch_failed')
    item.__settle?.()
    return
  }

  await applyVerdict(item, verdict, { phase: 'download', err: { reason } })
}
```

- [ ] **Step 5.9: Import the new `FREEPIK_URL_REFETCH_CAP` constant.** Add to the top-of-file config imports block.
- [ ] **Step 5.10: Verify.** `npm --prefix extension run build 2>&1 | tail -30`. Must compile without errors. Load unpacked in chrome://extensions and verify the service worker boots (open DevTools → background page → no red errors).
- [ ] **Step 5.11: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/modules/queue.js
git commit -m "$(cat <<'EOF'
feat(extension): queue — wire classifier + deny-list + 429 + cap gates

runResolver, runLicenser, runDownloader and
handleDownloadInterrupt all now dispatch on the classifier's
verdict instead of calling failItem with a raw string. New
central applyVerdict() handles skip / hardStop / retry /
cooldownThenRetry uniformly.

runLicenser gains:
  - deny-list pre-check (before the download.data GET) so we
    never spend a license on a known-bad filetype
  - post-license filename check (.zip/.aep/.prproj) that writes
    to the deny-list and fires a 24h-deduped telemetry alert

runDownloader gains:
  - daily-cap pre-check (warn @ 400, skip-this-source @ 500)
  - mint-phase classifier (freepik_404 / freepik_429 /
    freepik_unconfigured-skip-whole-source)
  - retry counter book-keeping (url_refetch_count,
    integrity_retries)

maybeEmitDenyAlert is the new 24h-deduped alert emitter; it
persists markAlertEmitted BEFORE emit so SW termination can't
double-alert.

Existing failItem / hardStopQueue / markCompleted paths
untouched — classifier routes INTO these; it does not replace
them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 6: `queue.js` — daily-cap increment on download complete + warn broadcast

**Files:** `extension/modules/queue.js`.

- [ ] **Step 6.1: Wire `incrementDailyCount` into the `next === 'complete'` branch of `handleDownloadEvent`.** Currently:

```js
    if (next === 'complete') {
      item.phase = 'done'
      state.stats.ok_count++
      state.stats.total_bytes_downloaded += item.bytes_received || 0
      // Record cross-run dedup entry.
      if (state.userId) {
        try {
          await markCompleted(state.userId, item.source, item.source_item_id, state.target_folder_path)
```

Add `await incrementDailyCount(item.source)` right after `markCompleted`. Same try/catch — we want per-source daily counts to reflect what actually landed on disk.

```js
      if (state.userId) {
        try {
          await markCompleted(state.userId, item.source, item.source_item_id, state.target_folder_path)
        } catch (err) {
          console.warn('[queue] markCompleted failed', err)
        }
      }
      // Ext.7: daily-cap increment. Happens on complete, not on
      // license commit — a hard-stop mid-download must NOT leak a
      // cap increment.
      try {
        await incrementDailyCount(item.source)
        const newStatus = await checkDailyCapThreshold(item.source)
        if (newStatus === 'warn' && !state.daily_cap_warned?.[item.source]) {
          state.daily_cap_warned = state.daily_cap_warned || {}
          state.daily_cap_warned[item.source] = Date.now()
          broadcast({ type: 'warn', message: `Approaching daily ${item.source} cap (400/500)` })
        }
        if (newStatus === 'hard_stop') {
          // Skip further items of this source; do NOT hard-stop the
          // whole queue (open question 3). A future item hitting the
          // runDownloader's pre-check will fail with source_daily_cap_exceeded.
          console.warn('[queue] daily cap hit for source:', item.source)
        }
      } catch (err) {
        console.warn('[queue] daily-cap increment failed', err)
      }
```

- [ ] **Step 6.2: Verify.** Rebuild + reload extension. Trigger a single successful download via the Ext.5 queue manual-test harness (any source). Open DevTools → Application → chrome.storage.local → `daily_counts` — the current day's entry should have `{envato: 1}` (or whichever source).
- [ ] **Step 6.3: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/modules/queue.js
git commit -m "$(cat <<'EOF'
feat(extension): queue — daily-cap increment on download complete

handleDownloadEvent now calls incrementDailyCount(item.source)
in the `next === 'complete'` branch, right after markCompleted.
This is the single write point for daily_counts; a hard-stop
mid-download cannot leak a cap increment.

Also broadcasts a one-shot 'warn' Port message when crossing
the 400/500 warn threshold (dedup via state.daily_cap_warned
so we only warn once per source per run). Hard-stop-at-500
surfaces via the runDownloader pre-check skip path, not from
here — so this function just logs the crossing and moves on.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 7: `queue.js` — integrity check (size mismatch → delete + retry)

**Files:** `extension/modules/queue.js`.

- [ ] **Step 7.1: Add integrity check inside the `next === 'complete'` branch, BEFORE the daily-cap increment.** (Reason: if integrity fails, we shouldn't count the item as downloaded.)

```js
    if (next === 'complete') {
      // Ext.7 integrity check.
      // chrome.downloads returns totalBytes; the manifest carries
      // est_size_bytes (± tolerance). If |actual - expected| > 5%,
      // retry once.
      const expected = item.expected_size_bytes || item.total_bytes
      const actual = item.bytes_received || 0
      if (expected && actual > 0) {
        const tol = expected * INTEGRITY_TOLERANCE
        if (Math.abs(actual - expected) > tol && Math.abs(actual - expected) > 1024) {
          // Below-tol AND below-1024-byte-absolute-floor: we ignore
          // rounding differences for tiny files. Else retry once.
          const verdict = classifyIntegrityError(item)
          if (verdict.retry) {
            item.integrity_retries = (item.integrity_retries || 0) + 1
            // Delete the file via chrome.downloads.removeFile, then
            // null the signed URL so the re-download refetches JIT,
            // and roll the item back to 'downloading'.
            try {
              await chrome.downloads.removeFile(item.download_id)
            } catch {}
            item.download_id = null
            item.signed_url = null
            item.bytes_received = 0
            item.phase = 'downloading'
            item.claimed = false
            await persistAndBroadcast()
            schedule()
            return
          }
          // verdict.skip path — already retried.
          await failItem(item, verdict.skip.error_code)
          item.__settle?.()
          return
        }
      }
      item.phase = 'done'
      // ... rest of the existing complete handling
```

- [ ] **Step 7.2: Import `INTEGRITY_TOLERANCE` at the top of the file.**
- [ ] **Step 7.3: Verify.** Rebuild + reload. Manually mutate one manifest item's `est_size_bytes` to `100` (tiny value) before running it; the queue should retry once then fail with `integrity_failed`. (Full verification is in Task 9's manual smoke.)
- [ ] **Step 7.4: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/modules/queue.js
git commit -m "$(cat <<'EOF'
feat(extension): queue — integrity check on download complete

If the downloaded file's bytes_received differs from
expected_size_bytes by more than ±5% (INTEGRITY_TOLERANCE) AND
more than 1024 bytes absolute, the queue deletes the file via
chrome.downloads.removeFile, rolls the item back to
'downloading', and schedules a refetch. Second mismatch →
integrity_failed.

Placement: inside handleDownloadEvent's `next === 'complete'`
branch, BEFORE the daily-cap increment and ok_count++. A
failed-integrity item never counts toward either.

The 1024-byte absolute floor exists to avoid chasing sub-KB
rounding differences on very small clips (the spec's 5% of a
100KB file is 5KB — that's a big tolerance, so the floor kicks
in below ~20KB).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 8: `popup.js` — disk-error state + popup copy

**Files:** `extension/popup.js`, `extension/popup.html` if needed.

- [ ] **Step 8.1: Read the existing popup.** `grep -n "state\|status" extension/popup.js | head -30` to see the state-rendering logic.
- [ ] **Step 8.2: Add a disk-error state renderer.** The popup's state machine (one of: "No auth" / "No Envato session" / "Ready" / "Active run" / "Post-run") needs a sixth state: "Disk error — change folder and retry." This fires when the queue's last hard-stop was `disk_failed`.

Read the RunState via the usual `chrome.storage.local.get(['run:'+activeId, 'active_run_id'])` pattern; if the current/most-recent run has `error_code === 'disk_failed'` OR any item has `error_code: 'disk_failed'`, show the error state with a link that opens Chrome's download settings:

```js
// Ext.7: disk-error state. Rendered when the most-recent run's
// error_code or any item's error_code is 'disk_failed'.
function renderDiskError(container, run) {
  container.innerHTML = `
    <div class="state error">
      <div class="title">Disk error</div>
      <div class="body">
        The last download was interrupted by a disk error
        (out of space / permission denied / path gone).
        <br><br>
        Change your download folder in
        <a href="chrome://settings/downloads" target="_blank">Chrome settings</a>
        and try the export again.
      </div>
    </div>
  `
}
```

- [ ] **Step 8.3: Add CSS for the error state in `popup.html`** if not already present (red accent or `.error` class). Keep minimal — one line of style is fine.
- [ ] **Step 8.4: Verify.** Trigger a hard-stop by temporarily making the download folder read-only on disk, OR by manually setting `chrome.storage.local.set({'run:test':{error_code:'disk_failed',items:[]}, active_run_id:'test'})` in the service-worker devtools. Open the popup; it renders the disk-error state.
- [ ] **Step 8.5: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/popup.js extension/popup.html
git commit -m "$(cat <<'EOF'
feat(extension): popup — disk-error state + recovery copy

Adds a sixth state to the popup state machine: "Disk error —
change folder and retry." Rendered when the active or
most-recent run has error_code === 'disk_failed', or any of
its items does.

Copy points the user at chrome://settings/downloads so they
can redirect to a writable path without a DevTools
spelunk. Ext.7 is the phase that hard-stops on FILE_* so this
state can now actually be reached.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 9: `normalizeErrorCode` tightening (telemetry.js)

**Files:** `extension/modules/telemetry.js`.

- [ ] **Step 9.1: Tighten the error-code mapper.** Currently several branches fall through to `return null`; Ext.7 knows enough about the raw strings to map them correctly.

Edit `normalizeErrorCode`:

```js
export function normalizeErrorCode(raw) {
  if (raw == null) return null
  const s = String(raw)
  if (ERROR_CODE_SET.has(s)) return s
  const beforeColon = s.split(':', 1)[0]
  if (ERROR_CODE_SET.has(beforeColon)) return beforeColon

  // Ext.5's legacy raw-string mappings (pre-Ext.7 classifier).
  if (beforeColon === 'download_interrupt') return 'network_failed'
  if (beforeColon === 'network_resume_failed') return 'network_failed'
  if (beforeColon === 'license_failed') return 'envato_unavailable'
  if (beforeColon === 'download_failed') return null

  // Ext.7 additions — classifier may still pass through some raw codes
  // via failItem (e.g. envato_http_500, envato_session_missing,
  // pexels_daily_cap_exceeded).
  if (s === 'envato_session_missing') return 'envato_session_401'
  if (s === 'envato_session_missing_preflight') return 'envato_session_401'
  if (s === 'envato_preflight_error') return 'envato_unavailable'
  if (s === 'envato_402') return 'envato_402_tier'
  if (s.startsWith('envato_http_5')) return 'envato_unavailable'
  if (s.startsWith('envato_http_4')) return 'envato_unavailable'  // 4xx that aren't 401/402/403/429
  if (s === 'freepik_url_expired') return 'url_expired_refetch_failed'
  if (s.endsWith('_daily_cap_exceeded')) return null  // no matching enum entry; raw in meta.raw_error
  if (s === 'unknown_verdict') return null
  if (s === 'cancelled') return null  // user-cancelled isn't in the enum; null + raw
  if (s === 'resolve_timeout') return 'resolve_failed'
  if (s === 'resolve_error') return 'resolve_failed'
  if (s === 'bad_input') return null

  return null
}
```

- [ ] **Step 9.2: Verify.** Quick eval sanity check in a repl (or via `node -e`): `normalizeErrorCode('envato_session_missing')` → `'envato_session_401'`; `normalizeErrorCode('envato_http_500')` → `'envato_unavailable'`; `normalizeErrorCode('foo:bar')` → `null`.
- [ ] **Step 9.3: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/modules/telemetry.js
git commit -m "$(cat <<'EOF'
chore(extension): telemetry — tighten normalizeErrorCode for Ext.7

Adds mappings for the raw strings Ext.7's classifier + worker
paths now emit: envato_session_missing* →
envato_session_401, envato_http_5xx / 4xx →
envato_unavailable, envato_402 → envato_402_tier,
resolve_timeout / resolve_error → resolve_failed,
freepik_url_expired → url_expired_refetch_failed.

ERROR_CODE_ENUM is NOT widened (frozen per Ext.6 invariant);
unmappable strings still normalize to null and the raw string
lives in meta.raw_error for admin triage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 10: Optional — `item_finalized` Port message + `conflictAction:'uniquify'` fidelity

**Only if user answers YES to open question 1.** Skip otherwise.

**Files:** `extension/modules/queue.js`, `extension/modules/port.js`.

- [ ] **Step 10.1: Add `item_finalized` broadcast to `handleDownloadEvent` complete branch.** After `markCompleted`, `incrementDailyCount`, and `emit item_downloaded`, query `chrome.downloads.search({id: item.download_id})` to learn the actual on-disk filename (which may be `001_envato_NX9WYGQ (1).mov` if Chrome uniquified). Broadcast:

```js
      // Ext.7 optional bundle: item_finalized with the actual path.
      // The web app's result_json consumer needs the real filename so
      // XMEML paths resolve correctly.
      try {
        const results = await chrome.downloads.search({ id: item.download_id })
        const actual = results[0]
        const finalPath = actual?.filename || item.target_filename
        item.final_path = finalPath
        broadcast({
          type: 'item_finalized',
          item_id: item.source_item_id,
          seq: item.seq,
          final_path: finalPath,
          bytes: item.bytes_received,
        })
      } catch (err) {
        console.warn('[queue] item_finalized broadcast failed', err)
      }
```

- [ ] **Step 10.2: Include `final_path` in the `item_done` shape and on `state.items` persistence.** Snapshot already emits all non-in-memory fields; `final_path` will flow through.
- [ ] **Step 10.3: Update `port.js` if it has a message-type allow-list.** (Read first — `grep -n "type\|msg.type" extension/modules/port.js` — if there's no allowlist, no change needed.)
- [ ] **Step 10.4: Cross-phase note.** Flag to WebApp.3 / State F: `result_json.items[].final_path` is now available.
- [ ] **Step 10.5: Commit.**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext7"
git add extension/modules/queue.js extension/modules/port.js
git commit -m "$(cat <<'EOF'
feat(extension): queue + port — item_finalized message with real on-disk path

When chrome.downloads uniquifies a filename (adds " (1).mov"
because a file with that name already exists), the web app's
XMEML generator currently loses track of the real path. This
adds an item_finalized Port message emitted after each
successful download, carrying the path returned by
chrome.downloads.search({id}).

final_path is also persisted on state.items so the web app
can read it from the completed run's result_json.

Cross-phase: WebApp.3 (State F) consumes final_path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 11: Manual smoke verification

**DO NOT COMMIT THIS TASK.** This is a live-probe task — findings go into the Task 9 summary comment on PR-equivalent, not as a commit.

**Files:** none.

The failure matrix has 17 rows; smoke-testing every one is impractical. Target the four highest-risk rows — the ones where the classifier is new code and the live behaviour matters.

### Smoke 1: Deny-list write + 24h alert dedupe

- [ ] **Step 11.1.1:** Find (or craft, via a local mock) an Envato item whose signed URL's `response-content-disposition` ends `.zip`. Typical candidate: After Effects project templates. Pick one from fixtures if available; else fish around the Envato catalog for an "AEP" tagged item.
- [ ] **Step 11.1.2:** Build a one-item manifest targeting it. Start the run via the test harness. Verify:
  - Queue item fails with `envato_unsupported_filetype`.
  - `chrome.storage.local.deny_list` has a key `envato|<item_id>` with a timestamp.
  - `chrome.storage.local.deny_list_alerted` has the same key (plus error_code suffix).
  - Backend received one `item_failed` telemetry event with `meta.alert: true`.
- [ ] **Step 11.1.3:** Start the SAME run again (fresh runId, same item). Verify:
  - The item is SKIPPED before `download.data` is called (grep DevTools network for `download.data` — it should NOT appear for this item).
  - Failing reason is still `envato_unsupported_filetype`.
  - Backend received ZERO new `meta.alert: true` telemetry events (within the 24h window).
- [ ] **Step 11.1.4:** In `chrome.storage.local`, manually backdate the `deny_list_alerted` entry by 25 hours: `chrome.storage.local.set({'deny_list_alerted': {'envato|<id>|envato_unsupported_filetype': Date.now() - 25*3600*1000}})`. Re-run. Verify a new `meta.alert: true` event DOES fire.

### Smoke 2: 429 Retry-After honoring + cooldown escalation

- [ ] **Step 11.2.1:** Craft a local mock backend (`/api/freepik-url`) that returns 429 with `Retry-After: 45` for the first request from a given JWT, then 429 without header for the second, then 200 on the third.
- [ ] **Step 11.2.2:** Start a one-item Freepik run. Verify:
  - First 429 → queue waits ~45s (± jitter), retries once.
  - Second 429 → queue pauses 5 minutes (or use a shorter override via `ENVATO_429_COOLDOWN_MS = 5000` in a dev config for the smoke), emits `queue_paused` with `meta.reason: 'freepik_429_cooldown'`.
  - Third attempt → succeeds, download completes.
- [ ] **Step 11.2.3:** Check the telemetry backend: one `rate_limit_hit` event, one `queue_paused`, one `queue_resumed`, one `item_downloaded`.
- [ ] **Step 11.2.4:** Negative case — make the mock 429 for all three attempts. Verify the queue hard-stops with `freepik_429` after the cooldown's final retry.

### Smoke 3: Freepik URL-refetch-on-expiry

- [ ] **Step 11.3.1:** Craft a Freepik manifest item whose mint backend returns an `expires_at` of `Date.now() + 2000` — a URL that expires in 2 seconds. In dev, override `FREEPIK_URL_GRACE_MS = 60000` (already set).
- [ ] **Step 11.3.2:** Slow the download (throttle to 50kb/s via DevTools Network) so the URL expires mid-download.
- [ ] **Step 11.3.3:** Verify:
  - chrome.downloads reports `interrupted` with `SERVER_UNAUTHORIZED` (or similar 4xx).
  - Queue's `url_refetch_count` increments to 1.
  - Queue re-mints the URL via `fetchFreepikUrl`, restarts the download, and it completes.
  - `item.url_refetch_count` ends at 1.
- [ ] **Step 11.3.4:** Negative case — mock the Freepik backend to always return an already-expired URL. After two refetches (`FREEPIK_URL_REFETCH_CAP = 2`), item fails with `url_expired_refetch_failed`.

### Smoke 4: 500-per-source daily-cap boundary

- [ ] **Step 11.4.1:** Prime `chrome.storage.local.daily_counts` to `{[today()]: {envato: 499}}` via DevTools:
  ```js
  chrome.storage.local.set({daily_counts: {[new Date().toISOString().slice(0,10)]: {envato: 499, pexels: 0, freepik: 0}}})
  ```
- [ ] **Step 11.4.2:** Start a 5-item Envato run. Verify:
  - Item 1 downloads successfully; `daily_counts.envato` becomes 500.
  - Item 2's `runDownloader` pre-check returns `hard_stop` and skips with `envato_daily_cap_exceeded`.
  - Items 3/4/5 skip the same way.
  - Run ends with ok_count=1, fail_count=4.
- [ ] **Step 11.4.3:** Reset counts to `{envato: 399}`. Start a 3-item run. Verify:
  - Item 1 downloads; count → 400.
  - Item 2's pre-check returns `warn`; Port receives a `{type: 'warn', message: 'Approaching daily envato cap (400/500)'}`.
  - Item 2 + 3 still download (warn doesn't stop the queue).

### Smoke 5: Disk-error hard-stop

- [ ] **Step 11.5.1:** Change the target folder to a path the user lacks write permission for (e.g. `/System/Library/no-perm-here/`). Start a run.
- [ ] **Step 11.5.2:** Verify:
  - First download fails with `FILE_ACCESS_DENIED` (chrome.downloads interrupt).
  - Queue hard-stops with `disk_failed`.
  - Remaining items all mark as failed with `disk_failed`.
  - Popup opens to the "Disk error — change folder and retry." state.
- [ ] **Step 11.5.3:** Change target to a writable folder, start a fresh run — everything works.

### Cross-phase notes to report back (Task 9 output, no commit)

- If `meta.alert: true` is NOT routed to Slack by the current backend `/api/export-events` handler, flag: **Ext.8 or a backend phase needs a one-liner to check `meta.alert === true` and POST to Slack.** This is a ~5-line backend change; do not bundle into Ext.7.
- If WebApp.3 (State F) needs `final_path` and the optional bundle was NOT taken (Task 10 skipped), flag: **State F will need to infer the filename, or bundle+rollback on Ext.7 to add it.** Recommend bundling.
- If the daily-cap hard-stop interpretation ("skip-this-source, not whole-queue") needs the opposite (whole-queue hard-stop), the user can change the `runDownloader` pre-check from `failItem` to `hardStopQueue` — this is one-line.
- The dirty-tree list from Ext.5 is still dirty at the time of this plan; any integration commit that touches those files is out-of-scope and must be declined.

### Reporting

Write a 10-line findings summary in the Task 9 comment / PR body when reporting back:

```
Ext.7 smoke results:
- Deny-list + alert dedupe: PASS / FAIL (details)
- 429 Retry-After + cooldown:  PASS / FAIL
- Freepik URL refetch:         PASS / FAIL
- Daily-cap boundary:          PASS / FAIL
- Disk-error hard-stop:        PASS / FAIL
Blocking issues: <list or "none">
Cross-phase flags: <list or "none">
```

---

## Execution handoff

- Execute in `.worktrees/extension-ext7`. Never on `main`.
- Task ordering matters — T2 before T3 before T4 (classifier module's imports depend on storage + config). T5 is the biggest commit; if it grows too large, split into T5a (classifier wiring) + T5b (deny-list wiring) + T5c (dispatcher) — but the single commit is preferred so the full refactor is atomic.
- Every commit ends with the Claude Opus 4.7 (1M context) co-author trailer.
- Never `git push`. Never modify `~/.git` or git config. Never use `--no-verify`.
- Final merge back to main goes through the user — do NOT self-merge.
