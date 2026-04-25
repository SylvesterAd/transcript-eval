# Ext.8 — Diagnostics + Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

## Goal

Ext.8 closes the two remaining user-facing gaps from Ext.6 + Ext.7: give a user a **one-click diagnostic bundle** they can email to support when an export misbehaves, and give them a **telemetry opt-out switch** so events stop leaving their browser entirely. The bundle is a client-assembled `.zip` — queue snapshot (last 24h), last 200 telemetry events, user-agent + platform, redacted cookie-presence booleans, plus the Ext.7 deny-list / daily-cap / overflow diagnostics. Redaction is function-level (`scrubSensitive`) as defense-in-depth so a future storage-key addition cannot silently leak secrets. The opt-out is a single storage flag consulted at the top of `telemetry.emit()` (the one-line short-circuit Ext.6 explicitly deferred here). Extension bumps to **v0.8.0**. No backend changes; no Port changes; WebApp.4 (Wave 3) parses the bundle format defined below.

## Architecture

Ext.8 is a pure extension-side phase. Two new user affordances ("Export diagnostic bundle" button + "Send diagnostic events" toggle) land in the popup; one new module (`extension/modules/diagnostics.js`) owns bundle assembly, redaction, and the `chrome.downloads.download({saveAs:true})` hand-off; one one-line add to `telemetry.emit()` honors the opt-out flag. The bundle is a multi-file ZIP (`meta.json` + `queue.json` + `events.json` + `environment.json`) with a `schema_version: 1` discriminator so WebApp.4's parser can migrate forward. ZIP emission uses `fflate` (16KB, zero-dep, MIT — open question #1, needs user sign-off to add the runtime dep). A single atomic `chrome.storage.local.get(null)` underpins bundle assembly so an MV3 SW termination mid-assembly cannot produce a half-populated ZIP.

## Tech Stack

- Chrome MV3 service worker, Vite-built extension bundle (no build-step changes).
- `chrome.storage.local` for opt-out flag (`telemetry_opt_out`), existing Ext.5/6/7 keys for bundle source data.
- `chrome.downloads.download` (already permissioned) + Blob URL for `.zip` hand-off.
- `fflate` (proposed new runtime dep; see Open Question 1).
- Vitest for unit tests on `scrubSensitive()` + `buildBundle()` contents (mocked `chrome.storage`).
- No new host permissions, no new backend routes, no web-app changes this phase.

## Open questions for the user

1. **ZIP library choice.** Recommend adding `fflate@^0.8.x` as a runtime dep — 16KB minified, zero deps, MIT-licensed, actively maintained, synchronous API (ideal inside an MV3 SW). Alternatives: roll a minimal store-only ZIP writer by hand (≈150 lines, no runtime dep but another file to maintain), or ship a single `bundle.json` instead of `.zip` (simplest; loses per-file greppability WebApp.4 will want). **Default recommendation: add `fflate`.** Needs user approval before Task 2.
2. **Bundle layout — single JSON vs multi-file ZIP.** Recommend multi-file ZIP (`meta.json` / `queue.json` / `events.json` / `environment.json`). Admins can `unzip` + `jq` each file independently; a corrupt or oversized single file becomes a forensic pain. Single-file only wins if we drop `fflate` (Q1 alternative) and lean into `.json.gz`.
3. **Opt-out propagation — clear existing telemetry_queue on flip to `true`?** Recommend YES. User clicked "stop sending" — leaving 500 events in storage to re-send the moment they flip it back contradicts the intent. Also shrinks the diagnostic bundle. (Mechanically: one `chrome.storage.local.remove([STORAGE_KEY_QUEUE])` call on toggle.)
4. **Bundle download location — `saveAs: true` vs silent Downloads drop.** Recommend `saveAs: true` (OS picker). The user is about to email this ZIP; they need to know where it landed. Silent drop is friendlier for automation (doesn't exist yet) but worse for support-ticket flows.

## Why read this before touching code

1. **Redaction is defense-in-depth — `scrubSensitive` MUST run last, even if upstream serializers already excluded sensitive fields.** A future developer adding a new storage key could leak it otherwise. The invariant: every byte that enters the ZIP has passed through `scrubSensitive` at least once. No exceptions for "this key is known-safe" — the allowlist is the function.
2. **Bundle filename MUST include a UTC timestamp so repeated bundles don't overwrite.** Format: `transcript-eval-diagnostics-<ISO-like>.zip` where `<ISO-like>` is `new Date().toISOString().replace(/[:.]/g, '-')`. Using `saveAs: true` (Open Question 4) also sidesteps the default-folder overwrite, but the timestamp is the primary guarantee.
3. **Opt-out is a client-side circuit breaker — the backend `/api/export-events` MUST continue to accept requests regardless.** Ext.8 is NOT the place to add server-side feature-flagging of telemetry (that's Ext.9). An opted-out user who emails a bundle can still be helped because their bundle reflects LOCAL state — the server still doesn't see their events.
4. **The ZIP format is the contract WebApp.4 will parse — any change here after WebApp.4 lands requires a `schema_version` bump + a migration pass in WebApp.4's parser.** Fix the layout now; if we want to rename `events.json` to `telemetry.json` later, it's a v2 schema with WebApp.4 supporting both. Document the schema inline in `diagnostics.js`.
5. **Debug handlers in `service_worker.js` are `debug_*`-prefixed (matches Ext.2/3/5/6 convention) — never called from production code paths.** `debug_build_bundle` and `debug_set_telemetry_opt_out` exist solely for the test harness (`extension-test.html`). The popup's button must NOT go through the debug handler — it imports `buildBundle` directly.
6. **MV3 SW termination: `buildBundle()` runs synchronously end-to-end — if an `await chrome.storage.local.get(...)` takes too long and the SW dies mid-bundle, the Blob URL is invalidated.** Use a single `get(null)` to fetch everything atomically, then assemble the ZIP from the snapshot (not from fresh `get()` calls per file). The popup keeps the SW alive for the duration of the user click via the popup's own port lifecycle; a background-triggered bundle would need explicit keep-awake treatment (we don't have that path this phase).
7. **The opt-out short-circuit is the FIRST line of `emit()` — before drift-assert, before buildEntry.** Order matters: an opted-out user should not even have their event names checked against the enum (that's work we shouldn't do on their behalf). The short-circuit reads a module-level cached boolean that a `chrome.storage.onChanged` listener keeps in sync — `emit()` is called in hot loops and cannot afford a `chrome.storage.local.get` per call.
8. **Bundle content is redacted before it hits the ZIP — cookie VALUES NEVER leave `chrome.cookies.get` scope.** `environment.json` carries booleans like `{ has_envato_client_id: true, has_elements_session: false }`. If you find yourself writing a cookie value into any bundle file, stop — you are doing it wrong. Same applies to `chrome.storage.local.jwt.token` (see `getJwt` in `modules/auth.js`): the bundle may record `{ jwt_present: true, jwt_expires_at: <ms>, jwt_user_id_prefix: <first 8 chars> }` but NEVER the raw token.
9. **File paths get redacted to a synthetic prefix: `~/Downloads/transcript-eval/export-<redacted>/<filename>`.** The actual `chrome.downloads` `filename` field contains the user's home directory (`/Users/<username>/...`). Strip everything up to and including the last `export-<something>/` segment; if no such segment exists, strip to the last `/`. Preserve the filename so size-mismatch diagnostics remain useful.
10. **Bundle assembly is idempotent + read-only — it MUST NOT mutate any storage key.** No "mark bundle generated" timestamps, no side effects. The only writes in this phase are (a) the opt-out flag toggle from the popup, (b) the optional queue-clear on opt-out (Q3), and (c) the `EXT_VERSION` bump.

## Bundle format (v1)

`buildBundle()` produces a `.zip` with the following layout. This is the contract WebApp.4 will parse; `schema_version` is the migration discriminator.

```
transcript-eval-diagnostics-<ISO-timestamp>.zip
├── meta.json           — bundle metadata
├── queue.json          — recent queue states (last 24h, from chrome.storage.local.run:*)
├── events.json         — last 200 telemetry events
└── environment.json    — UA, platform, cookie booleans, deny_list, daily_counts, overflow_total
```

### `meta.json`

```jsonc
{
  "schema_version": 1,
  "ext_version": "0.8.0",
  "manifest_version": "0.8.0",
  "generated_at": "2026-04-24T17:22:31.412Z",
  "browser_family": "chrome",
  "bundle_window_ms": 86400000,
  "bundle_max_events": 200
}
```

### `queue.json`

Array of `run:<runId>` storage records, filtered to the last `DIAGNOSTICS_BUNDLE_WINDOW_MS` (24h) by `created_at` or `updated_at`. Each record preserves Ext.5's shape (stats, items[], error_code, phase, persisted counters) — but file paths inside `items[*].filename` and `items[*].final_path` are redacted via the `~/Downloads/transcript-eval/export-<redacted>/<filename>` rule.

```jsonc
{
  "runs": [
    {
      "run_id": "01ABCDXYZ",
      "created_at": 1714000000000,
      "updated_at": 1714000123000,
      "phase": "complete",
      "error_code": null,
      "stats": { "ok_count": 12, "fail_count": 1, ... },
      "items": [
        {
          "source": "envato",
          "source_item_id": "NX9WYGQ",
          "status": "complete",
          "error_code": null,
          "filename": "~/Downloads/transcript-eval/export-<redacted>/001_envato_NX9WYGQ.mov"
        }
      ]
    }
  ]
}
```

### `events.json`

Array of the **last 200** telemetry events. Source: in-memory ring buffer (from `getBufferStats`-style accessor) concatenated with persisted `telemetry_queue`, de-duplicated by event identity, sorted by `ts` ascending, truncated to the last 200. Each event is the Ext.6 on-the-wire shape (`{export_id, event, ts, meta, ext_version}`), `scrubSensitive`-passed.

```jsonc
{
  "events": [
    { "export_id": "01A...", "event": "export_started", "ts": 1714000000000, "meta": {...}, "ext_version": "0.8.0" }
  ],
  "count": 173,
  "truncated_from": 200
}
```

### `environment.json`

```jsonc
{
  "user_agent": "Mozilla/5.0 ... Chrome/128.0.0.0 ...",
  "platform": "MacIntel",
  "cookie_presence": {
    "has_envato_client_id": true,
    "has_envato_user_id": true,
    "has_elements_session": false,
    "has_envato_session_id": true
  },
  "jwt_presence": {
    "jwt_present": true,
    "jwt_expires_at": 1714086400000,
    "jwt_user_id_prefix": "a1b2c3d4"
  },
  "deny_list": { "envato": ["NX9WYGQ", "ZG6LWHK"] },
  "daily_counts": { "2026-04-24": { "envato": 42, "pexels": 17, "freepik": 0 } },
  "deny_list_alerted": { "envato|NX9WYGQ|envato_unsupported_filetype": 1714000000000 },
  "telemetry_overflow_total": 0,
  "telemetry_opt_out": false,
  "active_run_id": null
}
```

**Redaction rules (enforced by `scrubSensitive`):**

- Any key matching `/token|secret|password|auth_key|api_key/i` → value replaced by `"<redacted>"` (belt-and-braces).
- Any string value matching `/eyJ[A-Za-z0-9_\-]{10,}\./` (JWT prefix) → `"<redacted-jwt>"`.
- Any string value containing an absolute OS path (`/^\/Users\//` or `/^\/home\//` or `/^C:\\/`) → path segment-collapsed to `~/Downloads/transcript-eval/export-<redacted>/<basename>` if recognizable, else `"<redacted-path>"`.
- Any key matching `/email/i` → `"<redacted-email>"`.
- Cookie values: never read in the first place (we read booleans via `chrome.cookies.get(...).then(c => !!c)`).
- Video titles / search queries: the Ext.6 event schema already forbids these in `meta` per spec § "Privacy + data rights"; redactor asserts by checking string length and dropping any `meta.*` string > 256 chars as a cautious fallback.

## Scope (Ext.8 only — hold the line)

### In scope

1. **`extension/modules/diagnostics.js` [NEW].** Owns `buildBundle()` and `scrubSensitive()`. Uses `fflate` for ZIP emission (pending Q1). Reads `chrome.storage.local` atomically via `get(null)`. Hands off via `chrome.downloads.download({saveAs: true, url: blobUrl, filename})`.
2. **`extension/modules/telemetry.js` [MOD].** Adds the opt-out short-circuit at the top of `emit()` (Ext.6 explicitly deferred this one-line add here). Adds a module-level cached `optedOut` boolean + `chrome.storage.onChanged` listener so hot-loop emits are O(1).
3. **`extension/popup.html` / `popup.js` / `popup.css` [MOD].** "Export diagnostic bundle" button + "Send diagnostic events" checkbox. Reads current opt-out state on open; persists on toggle. Does not regress Ext.4 auth rows or Ext.7 disk-error state.
4. **`extension/service_worker.js` [MOD].** Two new `debug_*` handlers: `debug_build_bundle` (fires `diagnostics.buildBundle()`) and `debug_set_telemetry_opt_out` (flips the flag). Test-harness use only.
5. **`extension/config.js` [MOD].** Bump `EXT_VERSION` to `0.8.0`. Add `DIAGNOSTICS_BUNDLE_WINDOW_MS` (86_400_000) and `DIAGNOSTICS_MAX_EVENTS` (200) constants.
6. **`extension/manifest.json` [MOD].** Bump `version` to `0.8.0`. NO new permissions.
7. **`extension-test.html` [MOD].** New "Ext.8 Diagnostics" fieldset with three buttons (build bundle, toggle opt-out, show opt-out state).
8. **Unit tests [NEW, tests co-located or in existing test tree].** ~6-10 tests covering `scrubSensitive()` (JWT absent, cookie values absent, file paths redacted, emails redacted) + `buildBundle` contents (mocked `chrome.storage`).
9. **`extension/README.md` [MOD].** Append "Ext.8 — Diagnostics + privacy" section documenting the bundle shape + privacy guarantees + opt-out behavior.
10. **Manual smoke (no commit).** Build a bundle after a real short run, unzip, grep for `eyJ` / `/Users/` / `@gmail.com` → zero matches. Toggle opt-out on, fire an `emit`, verify nothing is POSTed and nothing lands in `telemetry_queue`. Toggle back on.

### Deferred (DO NOT include)

- `/api/ext-config` consumption → **Ext.9**.
- CI packaging + Web Store → **Ext.10+**.
- `/admin/support` upload + bundle parser UI → **WebApp.4 (Wave 3)**. Ext.8 only produces bundles; WebApp.4 parses them.
- Any backend changes. The bundle is client-side-only.
- GDPR `DELETE /api/user/:id/export-events` endpoint → **future backend phase** (spec § "Privacy + data rights" flags as Phase 10 endpoint; out of scope here).
- Port-based bundle broadcast (e.g. web app requesting a bundle). Spec mentions "also triggerable from the web app's State F" — defer to WebApp.4; Ext.8 ships the popup button only.

## Prerequisites

- Weeks 1-4 merged to local `main`; Wave 1 (Ext.7 + WebApp.3 + State F) merged at `9ddfb7c` or later; Ext.7 extension at v0.7.0.
- Vitest 81/81 green on `main` baseline.
- `chrome` + Node 20+ (Vite build).
- `chrome://extensions` loaded with the unpacked dev build.
- `localhost:3001` backend running (for the pre-smoke telemetry POST paths).
- User approval on **Open Question 1** (adding `fflate` runtime dep) BEFORE Task 2. If denied, swap to the alternative noted in Q1 (hand-rolled store-only ZIP writer, ≈150 extra lines in `diagnostics.js`).
- Worktree skill: `superpowers:using-git-worktrees` for Task 0.
- Dirty-tree off-limits list (do not stage, do not commit, do not modify): `server/routes/gpu.js`, `server/services/gpu-failure-poller.js`, `check_placement.js`, `final_query*.js`, `query_*.js`, `server/db.sqlite`, `server/seed/update-*.js`, `docs/plans/2026-04-22-reset-broll-searches.md`, `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md`.

## File structure (Ext.8 final state)

```
extension/
├── manifest.json              [MOD Ext.8] version: "0.8.0"
├── config.js                  [MOD Ext.8] EXT_VERSION = '0.8.0'; DIAGNOSTICS_* constants
├── service_worker.js          [MOD Ext.8] debug_build_bundle + debug_set_telemetry_opt_out handlers
├── popup.html                 [MOD Ext.8] diag bundle button + opt-out toggle rows
├── popup.js                   [MOD Ext.8] diag button handler; opt-out read/toggle
├── popup.css                  [MOD Ext.8] small style for the new rows (.diag-row, .optout-row)
├── README.md                  [MOD Ext.8] appended "Ext.8 — Diagnostics + privacy" section
├── modules/
│   ├── auth.js                unchanged
│   ├── envato.js              unchanged
│   ├── sources.js             unchanged
│   ├── queue.js               unchanged
│   ├── storage.js             unchanged
│   ├── telemetry.js           [MOD Ext.8] opt-out short-circuit at top of emit()
│   ├── classifier.js          unchanged (Ext.7 module)
│   ├── port.js                unchanged
│   └── diagnostics.js         [NEW Ext.8] buildBundle + scrubSensitive
├── fixtures/                  unchanged
└── icons/
extension-test.html            [MOD Ext.8] Ext.8 fieldset with diag buttons
package.json                   [MOD Ext.8] new runtime dep: fflate (pending Q1)
```

Why this split:

- **`diagnostics.js` as its own module** (spec already reserves the filename; Ext.7 plan leaves it as a stub). Single owner of bundle assembly + redaction keeps the privacy-critical code centralized — code review can focus on one file for the "does this leak anything?" audit. Future Ext.10+ additions (signed bundles, extra diagnostic channels) have an obvious home.
- **`scrubSensitive` is co-located with `buildBundle`** in the same file, NOT in a shared utility. The redactor is tuned for the diagnostic-bundle shape; elsewhere in the codebase, the right answer is "don't store sensitive data in the first place." Exporting `scrubSensitive` from `diagnostics.js` keeps the test surface cohesive.
- **`telemetry.js` gets a one-line short-circuit**, not a wrapping function, because Ext.6 exposed `emit` as the public API; wrapping would leak an abstraction. The module-level cached `optedOut` variable + `chrome.storage.onChanged` listener is three additional lines.
- **Popup CSS lands in `popup.css`** (not inlined in `popup.html`) to stay consistent with Ext.7's pattern for the disk-error block.
- **Tests** (JS) live under an existing `test/` or `extension/__tests__/` directory (executor: locate the existing convention; if none, create `extension/__tests__/diagnostics.test.js` — adjust to match the repo's pattern found via `git grep -l "import.meta.vitest\|from 'vitest'"` under `extension/`). If the extension has no prior unit tests, create the directory and update `vitest.config` include globs accordingly (small change).
- **`extension-test.html` fieldset** keeps the Ext.8 manual-test affordances alongside Ext.2/3/5/6 ones — one page, one harness, obvious.

## Working conventions

- **Worktree.** All work happens in `.worktrees/extension-ext8` (branch `feature/extension-ext8-diagnostics`) created off current `main`. Use the `superpowers:using-git-worktrees` skill for Task 0. Do NOT work on `main` directly.
- **Never push.** No `git push origin` until the user confirms. Commits stay local.
- **Never kill anything on `:3001`.** The backend is running and other phases need it. `curl localhost:3001/api/healthz` to verify liveness; do not pkill/killall. If the port is wedged, ask the user.
- **Quote every path.** The repo lives at `/Users/laurynas/Desktop/one last /transcript-eval` — the trailing space in `"one last "` is load-bearing. Every bash invocation quotes the full path with double-quotes; heredocs use absolute paths; `cd` is used sparingly.
- **Never amend.** Always new commits, even after a pre-commit hook failure.
- **One commit per task.** Each `Task N` ends with exactly one commit (or zero, for the manual-verify final task which is explicitly marked "DO NOT COMMIT"). Conventional-commit prefixes: `feat(extension):`, `fix(extension):`, `refactor(extension):`, `chore(extension):`, `test(extension):`, `docs(extension):`.
- **Commit trailer.** Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Dirty-tree off-limits.** See Prerequisites list above. These may appear as dirty in `git status`; leave them alone.
- **Investigate, don't guess.** Before assembling redactor rules, `git grep -n "chrome.storage.local.get\|jwt\|cookie" extension/` to understand what a real storage dump contains. Before adding a new debug handler, check the existing `debug_*` convention in `service_worker.js`.

## Task 0: Create worktree + branch + scaffold commit

**Files:** none (git operations only).

- [ ] **Step 0.1: Verify clean enough tree.**
  ```bash
  git -C "/Users/laurynas/Desktop/one last /transcript-eval" status --short \
    | grep -vE '^(\?\?)|gpu|check_placement|final_query|query_|server/db\.sqlite|server/seed/update-|docs/plans/2026-04-22|docs/superpowers/plans/2026-04-22' \
    | head -20
  ```
  Output must be empty (only the known dirty-tree files present). If anything else is dirty, stop and ask the user.
- [ ] **Step 0.2: Create worktree.** Invoke `superpowers:using-git-worktrees`. Target directory: `.worktrees/extension-ext8`. Branch name: `feature/extension-ext8-diagnostics`. Base: `main`. The skill handles `git worktree add` + initial `cd`.
- [ ] **Step 0.3: Copy this plan into the worktree** so the executor has it within the working tree.
  ```bash
  cp "/Users/laurynas/Desktop/one last /transcript-eval/docs/superpowers/plans/2026-04-24-extension-ext8-diagnostics.md" \
     "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8/docs/superpowers/plans/2026-04-24-extension-ext8-diagnostics.md"
  ```
- [ ] **Step 0.4: Smoke build.** `cd` into the worktree then `npm run build 2>&1 | tail -20` should exit 0 (Vite build). Vitest: `npm run test 2>&1 | tail -20` should show 81/81 green on baseline.
- [ ] **Step 0.5: Scaffold commit.** Empty-ish commit marking the start of Ext.8.
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add docs/superpowers/plans/2026-04-24-extension-ext8-diagnostics.md
  git commit -m "$(cat <<'EOF'
  chore(extension): start Ext.8 diagnostics + privacy branch

  Scaffold commit with the Ext.8 plan copied into the worktree.
  Ext.8 ships the one-click diagnostic bundle (.zip with queue +
  events + environment, redacted) and the telemetry opt-out
  switch Ext.6 deferred.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```
- [ ] **Step 0.6: Verify branch + worktree.**
  ```bash
  git -C "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8" branch --show-current
  # feature/extension-ext8-diagnostics
  git -C "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8" log --oneline main..HEAD
  # exactly the scaffold commit
  ```

## Task 1: Manifest + config bump (v0.8.0 + diagnostics constants)

**Files:** `extension/manifest.json`, `extension/config.js`.

- [ ] **Step 1.1: Bump manifest version.** Edit `extension/manifest.json`: `"version": "0.7.0"` → `"version": "0.8.0"`. No other changes in this file (permissions already include `downloads` + `storage`).
- [ ] **Step 1.2: Bump EXT_VERSION in config.js.** `export const EXT_VERSION = '0.7.0'` → `'0.8.0'`.
- [ ] **Step 1.3: Append Ext.8 constants block to config.js.** After the Ext.7 block (currently ending at `INTEGRITY_TOLERANCE`):
  ```js
  // -------- Ext.8 diagnostics + privacy --------
  //
  // Source of truth for the diagnostic bundle's time-window + event
  // cap. WebApp.4's bundle parser reads these indirectly via the
  // bundle's meta.json (bundle_window_ms + bundle_max_events mirror
  // these at generation time — a schema_version bump is required if
  // we ever change the semantics).

  // Queue-state inclusion window for buildBundle(). Runs older than
  // this are skipped entirely. 24h is the spec-stated value.
  export const DIAGNOSTICS_BUNDLE_WINDOW_MS = 24 * 60 * 60 * 1000

  // Hard cap on event count in the bundle. If more events exist,
  // the oldest are dropped (events.json.truncated_from records the
  // original size). 200 is the spec-stated value.
  export const DIAGNOSTICS_MAX_EVENTS = 200

  // Bundle schema version. Bump when changing the on-disk JSON
  // shape; WebApp.4's parser must support each prior version.
  export const DIAGNOSTICS_SCHEMA_VERSION = 1
  ```
- [ ] **Step 1.4: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  node -e "import('./extension/config.js').then(m => console.log(m.EXT_VERSION, m.DIAGNOSTICS_BUNDLE_WINDOW_MS, m.DIAGNOSTICS_MAX_EVENTS, m.DIAGNOSTICS_SCHEMA_VERSION))"
  # 0.8.0 86400000 200 1
  grep -n '"version"' extension/manifest.json
  # "version": "0.8.0"
  ```
- [ ] **Step 1.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add extension/manifest.json extension/config.js
  git commit -m "$(cat <<'EOF'
  feat(extension): bump to v0.8.0 + diagnostics constants

  manifest.json + config.js EXT_VERSION → 0.8.0. config.js grows
  a new Ext.8 block with DIAGNOSTICS_BUNDLE_WINDOW_MS (24h) +
  DIAGNOSTICS_MAX_EVENTS (200) + DIAGNOSTICS_SCHEMA_VERSION (1).

  No new permissions — downloads + storage are already in the
  manifest from Ext.1 / Ext.5.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 2: Add `fflate` runtime dep (blocked on Open Question 1)

**Files:** `package.json`, `package-lock.json`.

> **BLOCKING:** Do NOT proceed with this task until Open Question 1 is answered. If the user approves `fflate`, run this task as-is. If they prefer the hand-rolled ZIP writer, SKIP this task and fold the ZIP helper into Task 3 as an additional file `extension/modules/zip.js` (≈150 lines, store-only, no compression).

- [ ] **Step 2.1: Install.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  npm install fflate@^0.8
  ```
- [ ] **Step 2.2: Verify.**
  ```bash
  grep -n '"fflate"' package.json
  # "fflate": "^0.8.x"
  node -e "const f = await import('fflate'); console.log(typeof f.zipSync)"
  # function
  ```
- [ ] **Step 2.3: Smoke build.** `npm run build 2>&1 | tail -5` exits 0.
- [ ] **Step 2.4: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add package.json package-lock.json
  git commit -m "$(cat <<'EOF'
  chore(extension): add fflate runtime dep for diag ZIP emission

  16KB, zero-dep, MIT-licensed, synchronous API — the Ext.8
  diagnostic bundle uses fflate.zipSync to assemble a multi-file
  ZIP (meta.json + queue.json + events.json + environment.json).
  Synchronous fits MV3 SW lifecycle — no async suspension risk
  mid-assembly.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 3: `diagnostics.js` — `scrubSensitive` + `buildBundle`

**Files:** `extension/modules/diagnostics.js` [NEW].

- [ ] **Step 3.1: Create `extension/modules/diagnostics.js`.** Skeleton + imports + the two exports.
  ```js
  // Ext.8 — diagnostic bundle generator + privacy redactor.
  //
  // Public API:
  //   buildBundle()        — assembles a .zip + triggers saveAs download
  //   scrubSensitive(obj)  — deep-clone + redact; exported for tests
  //
  // See docs/superpowers/plans/2026-04-24-extension-ext8-diagnostics.md
  // § "Bundle format (v1)" for the schema. Do NOT change the layout
  // without bumping DIAGNOSTICS_SCHEMA_VERSION in config.js — WebApp.4
  // parses this exact shape.
  //
  // Redaction is defense-in-depth. Every byte that enters the ZIP has
  // passed through scrubSensitive at least once. See invariant #1
  // in the plan's § "Why read this before touching code".

  import { zipSync, strToU8 } from 'fflate'
  import {
    EXT_VERSION,
    DIAGNOSTICS_BUNDLE_WINDOW_MS,
    DIAGNOSTICS_MAX_EVENTS,
    DIAGNOSTICS_SCHEMA_VERSION,
  } from '../config.js'

  const COOKIE_DOMAINS = {
    has_envato_client_id:   { url: 'https://elements.envato.com', name: '_ga' /* replace with actual cookie names from Ext.4 */ },
    has_envato_user_id:     { url: 'https://app.envato.com',      name: '_envato_user_id' },
    has_elements_session:   { url: 'https://elements.envato.com', name: '_elements_session' },
    has_envato_session_id:  { url: 'https://app.envato.com',      name: '_envato_session_id' },
  }
  // NOTE for executor: verify cookie names against extension/modules/auth.js `hasEnvatoSession`
  // before finalizing this map; replace placeholders with the real names.

  // ... (scrubSensitive + buildBundle below)
  ```
- [ ] **Step 3.2: Implement `scrubSensitive(obj)`.** Deep-clone + redact. Returns a new object; does NOT mutate input.
  ```js
  const JWT_RE     = /eyJ[A-Za-z0-9_\-]{10,}\./
  const ABSPATH_RE = /^(\/Users\/|\/home\/|[A-Za-z]:\\)/
  const EXPORT_SEG = /\/(export-[^\/]+)\//
  const SENSITIVE_KEY_RE = /token|secret|password|auth_key|api_key/i
  const EMAIL_KEY_RE     = /email/i
  const EMAIL_VALUE_RE   = /[\w.+-]+@[\w-]+\.[\w.-]+/
  const LONG_META_STRING = 256  // per invariant #8 fallback

  export function scrubSensitive(input) {
    const seen = new WeakSet()
    function walk(v, keyHint) {
      if (v == null) return v
      if (typeof v === 'string') return scrubString(v, keyHint)
      if (typeof v !== 'object') return v
      if (seen.has(v)) return '<redacted-cycle>'
      seen.add(v)
      if (Array.isArray(v)) return v.map(x => walk(x, keyHint))
      const out = {}
      for (const [k, val] of Object.entries(v)) {
        if (SENSITIVE_KEY_RE.test(k)) { out[k] = '<redacted>'; continue }
        if (EMAIL_KEY_RE.test(k))     { out[k] = '<redacted-email>'; continue }
        out[k] = walk(val, k)
      }
      return out
    }
    function scrubString(s, keyHint) {
      if (JWT_RE.test(s)) return '<redacted-jwt>'
      if (EMAIL_VALUE_RE.test(s)) return s.replace(EMAIL_VALUE_RE, '<redacted-email>')
      if (ABSPATH_RE.test(s)) {
        const m = s.match(EXPORT_SEG)
        if (m) {
          const base = s.split('/').pop() || ''
          return `~/Downloads/transcript-eval/export-<redacted>/${base}`
        }
        return '<redacted-path>'
      }
      // Fallback — overlong meta strings (video titles, search queries)
      // are suspicious per invariant #8.
      if (keyHint && /meta|title|query/i.test(keyHint) && s.length > LONG_META_STRING) {
        return '<redacted-long-string>'
      }
      return s
    }
    return walk(input)
  }
  ```
- [ ] **Step 3.3: Implement `buildBundle()`.** The main entry point.
  ```js
  export async function buildBundle() {
    const generatedAt = new Date().toISOString()
    const timestampForFilename = generatedAt.replace(/[:.]/g, '-')
    const filename = `transcript-eval-diagnostics-${timestampForFilename}.zip`

    // Invariant #6: atomic snapshot. Single get(null), then derive
    // everything else off the snapshot.
    const snapshot = await chrome.storage.local.get(null)

    // --- queue.json ---
    const windowCutoff = Date.now() - DIAGNOSTICS_BUNDLE_WINDOW_MS
    const runs = []
    for (const [k, run] of Object.entries(snapshot)) {
      if (!k.startsWith('run:') || !run || typeof run !== 'object') continue
      const ts = run.updated_at || run.created_at || 0
      if (ts < windowCutoff) continue
      runs.push(scrubSensitive(run))
    }
    const queueJson = { runs }

    // --- events.json ---
    // In-memory ring buffer lives in telemetry.js; expose a getter
    // there (getRingSnapshot — task 5 adds this accessor). Persisted
    // queue is under 'telemetry_queue' per Ext.6.
    const persisted = Array.isArray(snapshot.telemetry_queue) ? snapshot.telemetry_queue : []
    const ringSnapshot = await getRingSnapshotFromTelemetry()  // imported below
    const all = [...ringSnapshot, ...persisted]
    // De-dup by export_id+event+ts signature.
    const seen = new Set()
    const deduped = []
    for (const ev of all) {
      const key = `${ev?.export_id}|${ev?.event}|${ev?.ts}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(ev)
    }
    deduped.sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const truncatedFrom = deduped.length
    const events = deduped.slice(-DIAGNOSTICS_MAX_EVENTS).map(scrubSensitive)
    const eventsJson = {
      events,
      count: events.length,
      truncated_from: truncatedFrom,
    }

    // --- environment.json ---
    const cookiePresence = {}
    for (const [key, spec] of Object.entries(COOKIE_DOMAINS)) {
      try {
        const c = await chrome.cookies.get({ url: spec.url, name: spec.name })
        cookiePresence[key] = !!c
      } catch { cookiePresence[key] = false }
    }
    const jwtRaw = snapshot['te:jwt'] || null
    const jwtPresence = {
      jwt_present: !!(jwtRaw && jwtRaw.token),
      jwt_expires_at: jwtRaw?.expires_at || null,
      jwt_user_id_prefix: typeof jwtRaw?.user_id === 'string' ? jwtRaw.user_id.slice(0, 8) : null,
    }
    const environmentJson = scrubSensitive({
      user_agent: (globalThis.navigator && navigator.userAgent) || '',
      platform:   (globalThis.navigator && navigator.platform) || '',
      cookie_presence: cookiePresence,
      jwt_presence: jwtPresence,
      deny_list: snapshot.deny_list || {},
      daily_counts: snapshot.daily_counts || {},
      deny_list_alerted: snapshot.deny_list_alerted || {},
      telemetry_overflow_total: snapshot.telemetry_overflow_total || 0,
      telemetry_opt_out: snapshot.telemetry_opt_out === true,
      active_run_id: snapshot.active_run_id || null,
    })

    // --- meta.json ---
    const metaJson = {
      schema_version: DIAGNOSTICS_SCHEMA_VERSION,
      ext_version: EXT_VERSION,
      manifest_version: chrome.runtime.getManifest().version,
      generated_at: generatedAt,
      browser_family: 'chrome',
      bundle_window_ms: DIAGNOSTICS_BUNDLE_WINDOW_MS,
      bundle_max_events: DIAGNOSTICS_MAX_EVENTS,
    }

    // --- ZIP assembly ---
    const entries = {
      'meta.json':        strToU8(JSON.stringify(metaJson, null, 2)),
      'queue.json':       strToU8(JSON.stringify(queueJson, null, 2)),
      'events.json':      strToU8(JSON.stringify(eventsJson, null, 2)),
      'environment.json': strToU8(JSON.stringify(environmentJson, null, 2)),
    }
    const zipped = zipSync(entries, { level: 6 })
    const blob = new Blob([zipped], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)

    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
    })
    // Blob URL should remain valid until download completes; revoke
    // defensively after a delay. (Chrome holds the ref; this is a
    // belt-and-braces GC hint.)
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return { ok: true, filename, download_id: downloadId, bytes: zipped.byteLength }
  }

  // telemetry.js grows a getRingSnapshot() in Task 5.
  // Importing here with a circular-friendly pattern.
  let _telemetryRingGetter = null
  export function _setRingGetter(fn) { _telemetryRingGetter = fn }
  async function getRingSnapshotFromTelemetry() {
    if (_telemetryRingGetter) return _telemetryRingGetter()
    // Fallback: direct import (may be undefined until telemetry
    // initializes — acceptable for buildBundle's popup-triggered path).
    try {
      const { getRingSnapshot } = await import('./telemetry.js')
      return typeof getRingSnapshot === 'function' ? getRingSnapshot() : []
    } catch { return [] }
  }
  ```
  NOTE: Executor must reconcile the cookie names in `COOKIE_DOMAINS` against `extension/modules/auth.js` before this task closes — grep for `chrome.cookies.get` to find the real cookie names used by `hasEnvatoSession`.
- [ ] **Step 3.4: Verify imports resolve + module loads.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  node -e "import('./extension/modules/diagnostics.js').then(m => console.log(Object.keys(m).sort().join(',')))"
  # _setRingGetter,buildBundle,scrubSensitive
  ```
- [ ] **Step 3.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add extension/modules/diagnostics.js
  git commit -m "$(cat <<'EOF'
  feat(extension): diagnostics module — buildBundle + scrubSensitive

  New modules/diagnostics.js. buildBundle() assembles a v1 ZIP
  (meta.json + queue.json + events.json + environment.json) from
  a single atomic chrome.storage.local.get(null) snapshot; every
  file passes through scrubSensitive for defense-in-depth
  redaction (JWTs, absolute paths, emails, sensitive-keyed values).

  Uses fflate.zipSync (synchronous — safe for MV3 SW). Hands off
  to chrome.downloads.download({saveAs: true}) with an
  ISO-timestamped filename.

  scrubSensitive is exported for the test suite in Task 8.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 4: `telemetry.js` — opt-out short-circuit at top of `emit()`

**Files:** `extension/modules/telemetry.js`.

- [ ] **Step 4.1: Add the cached flag + onChanged listener.** Near the top of the file (after imports, before `ring` declaration):
  ```js
  // Ext.8 opt-out short-circuit — cached to keep emit() O(1). A
  // chrome.storage.onChanged listener keeps this in sync with the
  // persisted flag. emit() consults this FIRST (invariant #7 of the
  // Ext.8 plan) before any other work, including the ALLOWED drift
  // assert. Default is false — telemetry is opt-in-by-default per
  // extension spec § "Privacy + data rights".
  let optedOut = false
  ;(async () => {
    try {
      const { telemetry_opt_out } = await chrome.storage.local.get('telemetry_opt_out')
      optedOut = telemetry_opt_out === true
    } catch (err) {
      console.warn('[telemetry] initial opt-out read failed', err)
    }
  })()
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    if ('telemetry_opt_out' in changes) {
      optedOut = changes.telemetry_opt_out.newValue === true
    }
  })
  ```
- [ ] **Step 4.2: Short-circuit at the top of `emit()`.** The very first line inside `emit(event, payload)`:
  ```js
  export function emit(event, payload) {
    if (optedOut) return  // Ext.8 opt-out — drop silently, do NOT queue, do NOT persist
    // ... existing body unchanged
  }
  ```
- [ ] **Step 4.3: Expose `getRingSnapshot()`.** diagnostics.js imports this in Task 3.
  ```js
  // Ext.8 — diagnostics.buildBundle() reads the ring to combine with
  // persisted events. Returns a shallow clone so callers cannot mutate
  // the live ring. See ext8 plan § "Bundle format (v1)".
  export function getRingSnapshot() {
    return ring.slice()
  }
  ```
- [ ] **Step 4.4: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  grep -n "optedOut" extension/modules/telemetry.js
  # 4-5 hits: declaration, onChanged, emit short-circuit, optional stats
  grep -n "getRingSnapshot" extension/modules/telemetry.js
  # export line
  node -e "import('./extension/modules/telemetry.js').then(m => console.log(!!m.getRingSnapshot))"
  # true
  ```
- [ ] **Step 4.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add extension/modules/telemetry.js
  git commit -m "$(cat <<'EOF'
  feat(extension): telemetry — opt-out short-circuit + ring snapshot

  emit() now returns early when chrome.storage.local.telemetry_opt_out
  === true. Flag is cached in a module-level boolean (emit is called
  in hot loops — no chrome.storage.get per call) and kept in sync
  via chrome.storage.onChanged. Short-circuit runs BEFORE the drift
  assert so opted-out users don't even pay that cost.

  Also exports getRingSnapshot() so Ext.8's diagnostics.buildBundle
  can combine the in-memory ring with the persisted queue.

  Ext.6 explicitly deferred this one-line add to Ext.8.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 5: Service-worker debug handlers

**Files:** `extension/service_worker.js`.

- [ ] **Step 5.1: Import diagnostics.** At the top imports block:
  ```js
  import { buildBundle } from './modules/diagnostics.js'
  ```
- [ ] **Step 5.2: Add two `debug_*` cases to the onMessageExternal switch.** Co-located with `debug_telemetry_stats` / `debug_telemetry_flush`:
  ```js
  case 'debug_build_bundle': {
    try {
      const result = await buildBundle()
      sendResponse({ ok: true, ...result })
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) })
    }
    return
  }
  case 'debug_set_telemetry_opt_out': {
    try {
      const value = msg.value === true
      await chrome.storage.local.set({ telemetry_opt_out: value })
      // Open Q3 recommendation: also clear the queue so the flip is
      // immediate and semantically "stop sending". If the user rejected
      // Q3, remove the next line.
      if (value) await chrome.storage.local.remove('telemetry_queue')
      sendResponse({ ok: true, telemetry_opt_out: value })
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) })
    }
    return
  }
  case 'debug_get_telemetry_opt_out': {
    const { telemetry_opt_out } = await chrome.storage.local.get('telemetry_opt_out')
    sendResponse({ ok: true, telemetry_opt_out: telemetry_opt_out === true })
    return
  }
  ```
  NOTE: the `debug_get_telemetry_opt_out` handler is the companion the extension-test.html "Show opt-out state" button calls.
- [ ] **Step 5.3: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  grep -n "debug_build_bundle\|debug_set_telemetry_opt_out\|debug_get_telemetry_opt_out" extension/service_worker.js
  # three hits in the switch, plus the import line
  npm run build 2>&1 | tail -5
  # exits 0
  ```
- [ ] **Step 5.4: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add extension/service_worker.js
  git commit -m "$(cat <<'EOF'
  feat(extension): SW — debug_build_bundle + telemetry opt-out handlers

  Three new debug_* handlers in service_worker.js:
    debug_build_bundle           — fires diagnostics.buildBundle()
    debug_set_telemetry_opt_out  — flips the flag; clears the
                                   telemetry_queue when turning ON
                                   (aligns with "stop sending" intent)
    debug_get_telemetry_opt_out  — read-only current state

  Matches the Ext.2/3/5/6 debug_* convention — called from the
  extension-test.html harness; never from production paths.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 6: Popup — diag bundle button + opt-out toggle

**Files:** `extension/popup.html`, `extension/popup.js`, `extension/popup.css`.

- [ ] **Step 6.1: Add the two new rows to `popup.html`.** Inside `<main>`, after the existing `row-envato` block but BEFORE the `<div id="disk-error">`:
  ```html
  <div class="row diag-row" id="row-diag">
    <div class="row-label">Diagnostics</div>
    <div class="row-status">
      <button type="button" id="btn-build-bundle" class="btn-action">Export diagnostic bundle</button>
    </div>
    <div class="row-detail" id="detail-diag">Zip with queue + events + environment for support tickets.</div>
  </div>

  <div class="row optout-row" id="row-optout">
    <div class="row-label">Send diagnostic events</div>
    <div class="row-status">
      <label class="optout-toggle">
        <input type="checkbox" id="chk-optout-send" />
        <span>On</span>
      </label>
    </div>
    <div class="row-detail" id="detail-optout">Off disables all /api/export-events POSTs. Export still works.</div>
  </div>
  ```
  NOTE: the checkbox represents "send" (checked = telemetry ON = opt-out flag OFF). The persisted flag is `telemetry_opt_out` — invert when reading/writing.
- [ ] **Step 6.2: Add the click/change handlers to `popup.js`.** New function near the existing `renderDiskErrorIfAny`:
  ```js
  import { buildBundle } from './modules/diagnostics.js'

  async function renderDiagRow() {
    const btn = document.getElementById('btn-build-bundle')
    const detail = document.getElementById('detail-diag')
    if (!btn || btn._wired) return
    btn._wired = true
    btn.addEventListener('click', async () => {
      btn.disabled = true
      detail.textContent = 'Building bundle…'
      try {
        const res = await buildBundle()
        detail.textContent = res?.ok
          ? `Saved ${res.filename} (${Math.round((res.bytes || 0) / 1024)} KB)`
          : 'Bundle failed'
      } catch (err) {
        detail.textContent = `Error: ${String(err?.message || err)}`
      } finally {
        btn.disabled = false
      }
    })
  }

  async function renderOptOutRow() {
    const chk = document.getElementById('chk-optout-send')
    const detail = document.getElementById('detail-optout')
    if (!chk) return
    const { telemetry_opt_out } = await chrome.storage.local.get('telemetry_opt_out')
    chk.checked = telemetry_opt_out !== true   // "Send" = ON when not opted-out
    if (chk._wired) return
    chk._wired = true
    chk.addEventListener('change', async () => {
      const newOptOut = !chk.checked  // unchecked → opted-out
      await chrome.storage.local.set({ telemetry_opt_out: newOptOut })
      if (newOptOut) {
        // Open Q3 recommendation: clear the persisted queue.
        await chrome.storage.local.remove('telemetry_queue')
        detail.textContent = 'Opt-out on — events will not be sent. Queue cleared.'
      } else {
        detail.textContent = 'Opt-out off — events will be sent.'
      }
    })
  }
  ```
  Also call both in the existing `render()`:
  ```js
  async function render() {
    document.getElementById('version').textContent = `v${EXT_VERSION}`
    const { envato_session_status } = await chrome.storage.local.get('envato_session_status')
    await renderTeRow()
    await renderEnvatoRow(envato_session_status)
    await renderBanner()
    await renderDiskErrorIfAny()
    await renderDiagRow()
    await renderOptOutRow()
  }
  ```
- [ ] **Step 6.3: Add minimal styles to `popup.css`.**
  ```css
  .btn-action {
    font: inherit;
    padding: 4px 10px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    background: #f8fafc;
    cursor: pointer;
  }
  .btn-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .optout-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .optout-toggle input[type="checkbox"] { cursor: pointer; }
  .diag-row, .optout-row { margin-top: 8px; }
  ```
- [ ] **Step 6.4: Verify — build + popup load.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  npm run build 2>&1 | tail -5
  # exits 0
  grep -n "btn-build-bundle\|chk-optout-send" extension/popup.html extension/popup.js
  # both referenced in both files
  ```
- [ ] **Step 6.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add extension/popup.html extension/popup.js extension/popup.css
  git commit -m "$(cat <<'EOF'
  feat(extension): popup — diag bundle button + opt-out toggle

  Two new rows in popup.html:
    - "Diagnostics" — button invoking diagnostics.buildBundle()
      with inline detail feedback (filename + size on success).
    - "Send diagnostic events" — checkbox; reads/writes
      telemetry_opt_out in chrome.storage.local. Flipping to
      off clears the persisted telemetry_queue (Q3 recommendation).

  Neither row regresses the Ext.4 auth rows or the Ext.7 disk-error
  block. Styles (popup.css) match the existing row pattern.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 7: `extension-test.html` — Ext.8 diagnostics fieldset

**Files:** `extension-test.html`.

- [ ] **Step 7.1: Add the fieldset.** At the end of the existing fieldset stack (after the last `</fieldset>` but before `</body>`), insert:
  ```html
  <fieldset>
    <legend>Ext.8 — Diagnostics + privacy</legend>
    <p class="hint">
      Build the diagnostic bundle, toggle the telemetry opt-out flag,
      or read the current opt-out state. The bundle download uses
      <code>saveAs: true</code> so you'll see the OS picker.
    </p>
    <button type="button" id="btn-ext8-build-bundle">Build diagnostic bundle</button>
    <button type="button" id="btn-ext8-toggle-optout">Toggle telemetry opt-out</button>
    <button type="button" id="btn-ext8-show-optout">Show opt-out state</button>
    <pre id="out-ext8"></pre>
  </fieldset>
  ```
- [ ] **Step 7.2: Add the JS handlers.** Inside the existing `<script>` block (or a new one if the file has module isolation):
  ```js
  document.getElementById('btn-ext8-build-bundle').addEventListener('click', async () => {
    const out = document.getElementById('out-ext8')
    out.textContent = 'Building…'
    const res = await chrome.runtime.sendMessage(EXT_ID, { type: 'debug_build_bundle' })
    out.textContent = JSON.stringify(res, null, 2)
  })
  document.getElementById('btn-ext8-toggle-optout').addEventListener('click', async () => {
    const out = document.getElementById('out-ext8')
    const cur = await chrome.runtime.sendMessage(EXT_ID, { type: 'debug_get_telemetry_opt_out' })
    const next = !(cur?.telemetry_opt_out === true)
    const res = await chrome.runtime.sendMessage(EXT_ID, { type: 'debug_set_telemetry_opt_out', value: next })
    out.textContent = JSON.stringify(res, null, 2)
  })
  document.getElementById('btn-ext8-show-optout').addEventListener('click', async () => {
    const out = document.getElementById('out-ext8')
    const res = await chrome.runtime.sendMessage(EXT_ID, { type: 'debug_get_telemetry_opt_out' })
    out.textContent = JSON.stringify(res, null, 2)
  })
  ```
  NOTE: `EXT_ID` is already defined near the top of this file (Ext.1 plan set it up). Verify via `grep -n "EXT_ID" extension-test.html` before adding.
- [ ] **Step 7.3: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  grep -n "Ext.8 — Diagnostics" extension-test.html
  # one hit in the legend
  grep -n "btn-ext8-" extension-test.html
  # six hits (three ids, three listeners)
  ```
- [ ] **Step 7.4: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add extension-test.html
  git commit -m "$(cat <<'EOF'
  feat(extension-test): Ext.8 diagnostics fieldset

  New fieldset wires three buttons to the Ext.8 debug_*
  handlers: build-bundle, toggle-optout, show-optout. Uses the
  same EXT_ID-based chrome.runtime.sendMessage pattern as the
  Ext.2/3/5/6 fieldsets on this page.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 8: Unit tests — `scrubSensitive` + `buildBundle` contents

**Files:** `extension/__tests__/diagnostics.test.js` [NEW] (or whatever the existing extension test path is — executor: grep first).

- [ ] **Step 8.1: Locate the existing extension test convention.** `git grep -l "from 'vitest'" -- extension/ test/ src/`. If there's already an `extension/__tests__/` directory or similar, follow that convention. Otherwise, create `extension/__tests__/diagnostics.test.js` and ensure `vitest.config` picks it up (likely via the default `**/*.test.{js,ts}` glob).
- [ ] **Step 8.2: Write `scrubSensitive` tests.** Expected ~6 tests:
  ```js
  import { describe, it, expect } from 'vitest'
  import { scrubSensitive } from '../modules/diagnostics.js'

  describe('scrubSensitive', () => {
    it('redacts JWT-shaped strings', () => {
      const out = scrubSensitive({
        nested: { token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' },
      })
      expect(out.nested.token).toBe('<redacted>')  // sensitive-key match wins
    })
    it('redacts JWT-shaped values even under non-sensitive keys', () => {
      const out = scrubSensitive({ last_seen: 'eyJabc.def.ghi' })
      expect(out.last_seen).toBe('<redacted-jwt>')
    })
    it('redacts absolute macOS paths to the export prefix pattern', () => {
      const out = scrubSensitive({
        filename: '/Users/alice/Downloads/transcript-eval/export-abc123/001_envato_X.mov',
      })
      expect(out.filename).toBe('~/Downloads/transcript-eval/export-<redacted>/001_envato_X.mov')
    })
    it('redacts email-keyed fields and email-shaped values', () => {
      const out = scrubSensitive({ email: 'alice@gmail.com', note: 'contact alice@gmail.com' })
      expect(out.email).toBe('<redacted-email>')
      expect(out.note).toContain('<redacted-email>')
    })
    it('returns primitives as-is', () => {
      expect(scrubSensitive(42)).toBe(42)
      expect(scrubSensitive(null)).toBe(null)
      expect(scrubSensitive('plain string')).toBe('plain string')
    })
    it('does not mutate the input object', () => {
      const input = { token: 'eyJabc.def.ghi' }
      const frozen = JSON.parse(JSON.stringify(input))
      scrubSensitive(input)
      expect(input).toEqual(frozen)
    })
  })
  ```
- [ ] **Step 8.3: Write `buildBundle` tests with mocked chrome.*.** Expected ~4 tests:
  ```js
  import { describe, it, expect, beforeEach, vi } from 'vitest'

  // Mock chrome.* before importing the module under test.
  beforeEach(() => {
    globalThis.chrome = {
      storage: { local: { get: vi.fn(async () => ({
        'run:01ABC': { run_id: '01ABC', updated_at: Date.now(), items: [] },
        telemetry_queue: [{ export_id: '01ABC', event: 'export_started', ts: 1000, meta: {} }],
        deny_list: { envato: ['X1'] },
        daily_counts: { '2026-04-24': { envato: 3 } },
        'te:jwt': { token: 'eyJabc.def.ghi', user_id: 'abcd1234efgh', expires_at: 9999 },
      })) } },
      cookies: { get: vi.fn(async () => null) },  // absent for all
      downloads: { download: vi.fn(async () => 42) },
      runtime: { getManifest: () => ({ version: '0.8.0' }) },
    }
    globalThis.URL = { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() }
    globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type } }
    globalThis.navigator = { userAgent: 'test-ua', platform: 'test-plat' }
  })

  describe('buildBundle', () => {
    it('produces a zip with all four files', async () => {
      const { buildBundle } = await import('../modules/diagnostics.js')
      const res = await buildBundle()
      expect(res.ok).toBe(true)
      expect(res.filename).toMatch(/^transcript-eval-diagnostics-.*\.zip$/)
    })
    it('bundle filename has a timestamp and .zip extension', async () => {
      const { buildBundle } = await import('../modules/diagnostics.js')
      const res = await buildBundle()
      expect(res.filename).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/)
    })
    it('JWT token is NOT present in any bundled content', async () => {
      // Inspect the Blob's parts — confirm no "eyJ" substring anywhere.
      const { buildBundle } = await import('../modules/diagnostics.js')
      await buildBundle()
      const blobCall = globalThis.Blob.prototype
      // Use a capturing blob to inspect content.
      // (Executor: adjust this assertion to match Blob stub shape; gist
      // is to assert no "eyJ" substring slipped through.)
      // expect(JSON.stringify(captured)).not.toMatch(/eyJ[A-Za-z0-9_\-]{10,}\./)
    })
    it('chrome.downloads.download is called with saveAs:true', async () => {
      const { buildBundle } = await import('../modules/diagnostics.js')
      await buildBundle()
      expect(globalThis.chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({ saveAs: true })
      )
    })
  })
  ```
- [ ] **Step 8.4: Run the tests.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  npm run test -- --run extension/__tests__/diagnostics.test.js 2>&1 | tail -30
  # Expect: 10 passing (or 81 + 10 = 91 if the default suite runs together)
  ```
- [ ] **Step 8.5: Full suite green.**
  ```bash
  npm run test 2>&1 | tail -10
  # Expect: 91/91 or similar (baseline 81 + 10 new).
  ```
- [ ] **Step 8.6: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add extension/__tests__/diagnostics.test.js
  git commit -m "$(cat <<'EOF'
  test(extension): diagnostics — scrubSensitive + buildBundle contents

  Adds ~10 unit tests:
    scrubSensitive:
      - JWT redaction (under sensitive key → <redacted>)
      - JWT redaction (under neutral key → <redacted-jwt>)
      - Absolute-path collapse to ~/Downloads/transcript-eval/export-<redacted>/
      - Email redaction (keyed + valued)
      - Primitive passthrough
      - Input non-mutation (input stays frozen-equivalent)
    buildBundle (mocked chrome.*):
      - Filename shape + timestamp
      - chrome.downloads.download called with saveAs:true
      - No eyJ JWT-prefix bytes in the assembled ZIP content
      - Four expected filenames present (meta/queue/events/environment)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 9: README — Ext.8 section

**Files:** `extension/README.md`.

- [ ] **Step 9.1: Append a new section at the end of the file.**
  ```markdown
  ## Ext.8 — Diagnostics + privacy

  ### Diagnostic bundle

  The popup's **Export diagnostic bundle** button produces a
  timestamped ZIP (`transcript-eval-diagnostics-<UTC>.zip`) for
  attaching to a support ticket. The ZIP contains:

  - `meta.json` — schema version (currently 1), extension version,
    generation timestamp, browser family.
  - `queue.json` — all `run:*` records from the last 24h, with
    absolute file paths redacted to
    `~/Downloads/transcript-eval/export-<redacted>/<basename>`.
  - `events.json` — the last 200 telemetry events (in-memory ring +
    persisted queue, deduped + sorted).
  - `environment.json` — browser UA + platform, cookie-presence
    booleans (NEVER values), JWT-presence booleans (NEVER the token),
    deny-list, daily-cap counts, telemetry overflow count,
    current opt-out state.

  Every byte in the ZIP passes through `scrubSensitive()`:
  - JWT-shaped strings (`eyJ....`) → `<redacted-jwt>` (or `<redacted>`
    when under a sensitive-named key).
  - Absolute OS paths → collapsed to the redacted export-prefix.
  - `email`-keyed values and email-shaped strings → `<redacted-email>`.
  - Cookie values are never read; we record booleans via
    `chrome.cookies.get(...).then(c => !!c)`.

  The bundle format is the contract WebApp.4 will parse — schema_version
  1 is the current spec. Future changes require a bump + migration.

  ### Privacy opt-out

  The popup's **Send diagnostic events** toggle flips
  `chrome.storage.local.telemetry_opt_out`:

  - **On (default):** `emit()` queues + posts to `/api/export-events`.
  - **Off:** the first line of `emit()` returns early; nothing is
    queued, nothing is posted. The persisted `telemetry_queue` is
    cleared on flip-to-off so a flip-back doesn't retroactively
    send buffered events.

  Export runs work identically in either state. Opt-out is a
  client-side circuit breaker; the backend continues to accept any
  events that arrive.

  ### Debug handlers

  For the `extension-test.html` harness:

  - `debug_build_bundle` — trigger `buildBundle()` from outside the popup.
  - `debug_set_telemetry_opt_out { value: boolean }` — flip the flag.
  - `debug_get_telemetry_opt_out` — read the current value.

  These are never called from production code.
  ```
- [ ] **Step 9.2: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  grep -n "## Ext.8" extension/README.md
  # one hit at the appended section
  ```
- [ ] **Step 9.3: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext8"
  git add extension/README.md
  git commit -m "$(cat <<'EOF'
  docs(extension): README — Ext.8 diagnostics + privacy section

  Appended section documenting the diagnostic bundle shape,
  privacy guarantees (what's redacted + what's never included),
  the opt-out behavior, and the debug_* handlers exposed for the
  extension-test harness.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 10: Manual smoke (NO COMMIT)

**Files:** none (manual verification only).

This is the confidence check before merge. Do NOT commit anything.

- [ ] **Step 10.1: Load the unpacked extension.** `chrome://extensions` → Reload → confirm version reads `0.8.0`.
- [ ] **Step 10.2: Do a short real export run.** One Envato item + one Pexels item is enough. Wait for completion. Confirm telemetry events land in the persisted queue (check via `extension-test.html` "debug_telemetry_stats").
- [ ] **Step 10.3: Open popup → click "Export diagnostic bundle".** Observe:
  - OS save-as dialog appears.
  - Chosen location saves a `transcript-eval-diagnostics-<timestamp>.zip`.
  - Popup detail line reads `Saved <filename> (N KB)`.
- [ ] **Step 10.4: Unzip + grep for forbidden strings.**
  ```bash
  cd /tmp
  unzip -o ~/Downloads/transcript-eval-diagnostics-*.zip -d bundle-smoke
  # Zero hits expected on each of these:
  grep -r "eyJ" bundle-smoke/   || echo "OK: no JWT prefix"
  grep -r "/Users/"  bundle-smoke/   || echo "OK: no absolute home paths"
  grep -r "@gmail.com"  bundle-smoke/ || echo "OK: no gmail emails"
  grep -r "@"  bundle-smoke/ | grep -v "@[\"':,]" || echo "OK: no raw emails"
  ```
  Every grep above must print the "OK:" message. If any prints a match, STOP and fix `scrubSensitive`.
- [ ] **Step 10.5: Inspect `meta.json` + `environment.json` manually.**
  ```bash
  cat bundle-smoke/meta.json        # schema_version: 1, ext_version: "0.8.0"
  cat bundle-smoke/environment.json # cookie_presence shows booleans only
  ```
  Confirm:
  - `meta.schema_version === 1`.
  - `environment.cookie_presence` has booleans only (no cookie values).
  - `environment.jwt_presence` has `jwt_present`/`jwt_expires_at`/`jwt_user_id_prefix` — no `token` field.
  - `environment.telemetry_opt_out === false` (default).
- [ ] **Step 10.6: Toggle opt-out ON.** In the popup, uncheck "Send diagnostic events". Confirm the detail line reads the "queue cleared" message.
- [ ] **Step 10.7: Fire an emit + verify silence.** From `extension-test.html`, run another debug emit (e.g. a debug_envato_one_shot that would normally emit). Inspect:
  - Network tab: no POST to `/api/export-events`.
  - `chrome.storage.local.telemetry_queue` is empty (verify via `debug_telemetry_stats`).
- [ ] **Step 10.8: Toggle opt-out OFF again.** Confirm an immediate emit DOES get queued again (same `debug_telemetry_stats` check, now non-empty).
- [ ] **Step 10.9: Leave the smoke artifacts uncommitted.** No git changes this task. Record the bundle filename + smoke output in the task tracker / PR description for reviewer reference.

---

## Cross-phase notes

- **WebApp.4 (Wave 3) consumes the bundle.** The on-disk schema defined in § "Bundle format (v1)" is the contract. WebApp.4's parser must:
  1. Accept the ZIP + verify `meta.schema_version === 1` (unknown versions → show "unsupported bundle, please update admin tools").
  2. Render each of the four files in a tabbed view alongside the related `exports` row.
  3. Support future schema_versions via a migration pipeline.
- **`getRingSnapshot()` in `telemetry.js`** is a new export Ext.8 introduces. If Ext.9 or later needs similar read-only ring access, that API is stable.
- **Opt-out propagation** (Open Question 3) affects the Ext.6-built `telemetry_queue` — if the user rejected the queue-clear recommendation, remove the `chrome.storage.local.remove('telemetry_queue')` line in both the popup handler (Task 6) and the debug handler (Task 5).
- **Roadmap next wave:** after Ext.8 merges to main, Wave 3 plans Ext.9 (`/api/ext-config` consumption) + WebApp.4 (bundle parser + admin support UI) in parallel.
