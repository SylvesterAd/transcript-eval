# Ext.9 — Feature Flag Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

## Goal

Ext.9 wires the extension to Backend 1.5's `GET /api/ext-config` endpoint shipped in Week 1 (commit `684c4be`). On service-worker boot, the extension fires a fire-and-forget `fetchConfig()` to populate a TTL-bounded cache (`chrome.storage.local.cached_ext_config`, 60s TTL). Before each `{type:"export"}` the SW reads the cache and enforces four gates: global `export_enabled`, per-source `envato_enabled`/`pexels_enabled`/`freepik_enabled` kills, and a `min_ext_version` vs `EXT_VERSION` semver check. On a healthy response everything proceeds as before. On a network failure with a stale-but-present cache we use the cache with a warning log. On no cache AND fetch failure we **fall open** — `export_enabled=true`, all source flags true — rather than stranding users whose backend is unreachable. Extension bumps to **v0.9.0**. No backend changes (the endpoint exists + is public by design); no Port changes; no web-app changes.

## Architecture

Ext.9 is a pure extension-side phase — a read-only consumer of an endpoint already in production. One new module (`extension/modules/config-fetch.js`) owns the four public entry points (`fetchConfig` / `getCachedConfig` / `refreshConfigOnStartup` / `enforceConfigBeforeExport`) plus an internal 20-line `compareSemver` comparator. The SW grows a top-level `refreshConfigOnStartup()` call + a `enforceConfigBeforeExport` guard at the top of the `{type:"export"}` case. The queue's `startRun` gains a defensive "was the config check done?" guard — <10 new lines, race safety only. The popup surfaces three new states: "Export temporarily disabled" (global kill), per-source "paused by transcript-eval" rows in the Sources list, and a single "Update required — Ext.<min> needed" banner when the semver gate trips.

The semver comparator is hand-rolled (Open Question 1 recommendation): twenty lines, only handles `x.y.z` strings — no pre-release, no build metadata. The `semver` npm package is overkill for this scope and adds runtime-bundle weight. The SW-boot fetch is fire-and-forget so a slow/down backend cannot wedge SW initialization. `enforceConfigBeforeExport` awaits any in-flight startup refresh (capped at 5s) so the "startup racing with first export" edge case does not surface a stale fall-open when a fresh response was about to land (Open Question 4).

## Tech Stack

- Chrome MV3 service worker, Vite-built extension bundle (no build-step changes).
- `chrome.storage.local` for the cached config (`cached_ext_config` key: `{config, fetched_at}`).
- `fetch()` against `<BACKEND_URL>/api/ext-config` — public endpoint, no Bearer, no CORS config needed (same origin as Ext.3's `/api/pexels-url` + `/api/freepik-url`).
- Hand-rolled `compareSemver(a, b)` — no new runtime deps.
- Vitest (existing `extension/__tests__/` tree per Ext.8) for unit tests on `compareSemver`, `enforceConfigBeforeExport`, and fall-open / stale-cache logic.
- No new host permissions, no new backend routes, no web-app changes this phase.

## Open questions for the user

1. **Semver compare — hand-rolled `compareSemver` vs `semver` npm package.** Recommend hand-rolled (≈20 lines). Scope is literal `x.y.z` string comparison for values we control on both sides (`EXT_VERSION` and `min_ext_version`). The `semver` package adds ≈55KB to the extension bundle for features (ranges, caret/tilde operators, pre-release tags) we never use. A 20-line comparator lives next to its one caller and is trivially testable. **Default recommendation: hand-rolled.** Needs user approval before Task 2.
2. **Fall-open policy — what happens on "no cache AND fetch failure".** Recommend `export_enabled=true`, `envato_enabled=true`, `pexels_enabled=true`, `freepik_enabled=true` (baked-in default constant, see Task 2). Rationale: the documented user priority is "never strand users"; a down backend that blocks every export is a self-inflicted outage when the extension's local-only download paths would otherwise still work. Confirm.
3. **Per-source kill UX — one banner or per-row messages?** Recommend per-row messages in the Sources list (State C), plus a single aggregate "Some sources disabled" line in the popup's Envato/Pexels auth rows. Rationale: per-row matches the spec's existing "Sources" list surface (each source has its own visual row in State C); a single popup banner would hide which source is killed. Popup still shows the global "Export temporarily disabled" banner when `export_enabled===false`. Defer to State C spec if still ambiguous when the State C plan lands.
4. **Config-check race — startup refresh vs first export.** Recommend: `enforceConfigBeforeExport` awaits any in-flight `refreshConfigOnStartup()` with a 5s timeout. If the refresh completes within 5s, enforce against the fresh value; if it times out, enforce against whatever cache we have (stale or null) with a warning log — `CONFIG_CHECK_AWAIT_TIMEOUT_MS` as a named constant. Confirm the 5s value.

## Why read this before touching code

1. **Fall-open is NOT a graceful-degradation afterthought — it's a core requirement.** Users whose backend is unreachable must still export. The invariant: when the `fetch` fails AND no cached config exists AND no in-flight refresh is pending, `enforceConfigBeforeExport` returns `{ok: true, reason: 'fall_open_no_cache_no_network'}` with a `console.warn` logged — NOT a reject. Any future refactor that turns fall-open into a reject is a regression even if the code "looks cleaner".

2. **Cache TTL is 60s; past 60s + fetch failure, use stale with a warning log — less bad than fall-open.** The tiered policy: fresh cache (<60s) → trust. Stale cache (>60s) + network failure → trust stale + log warning. No cache at all + network failure → fall open (see invariant #1). This tiering prevents a single 10min backend outage from flipping every user to fall-open when they have a perfectly serviceable 61s-old cache with the real flag values.

3. **Semver compare operates on extension's own `EXT_VERSION` (from `extension/config.js`) vs `min_ext_version` (from server); NEVER parse `manifest.json` at runtime.** Constants are the truth. Both the manifest bump (Task 1) and the config.js bump (Task 1) happen in the same commit — they are kept in sync manually at each version bump. Any runtime check that reads `chrome.runtime.getManifest().version` is forbidden here because it adds a second source of truth that can drift under partially-loaded builds.

4. **Per-source kill doesn't retroactively pause in-flight runs — it only gates NEW `{type:"export"}` acceptance.** Running queue is immune. If the user flipped `freepik_enabled=false` while a Freepik item is mid-download, that download completes normally. If they want to kill an active run, they issue `{type:"cancel"}` from the web app. This matches the backend's own "flip the env var + restart" semantics and prevents mid-run mutations from creating half-exported folders.

5. **Config endpoint is PUBLIC (no Bearer) — this is by design so the extension can gate BEFORE JWT mint.** A newly-installed extension with no stored JWT still needs `export_enabled` + `min_ext_version` to decide whether to even attempt a session mint. Any future refactor that moves `/api/ext-config` behind auth breaks Ext.9's contract. The server-side `router.get('/')` in `server/routes/ext-config.js` explicitly skips the JWT middleware — do not "fix" this.

6. **Race: startup fetch + first export.** `enforceConfigBeforeExport` awaits any in-flight startup refresh up to `CONFIG_CHECK_AWAIT_TIMEOUT_MS` (5s) before deciding. If the refresh completes within the timeout, the fresh value wins. If the refresh times out, we fall back to whatever cache we have (stale or null) and log a warning — never block the export on a slow server. This is the ONE place where Ext.9 introduces a wait; everywhere else reads are synchronous / cached.

7. **Request `Cache-Control` is `public, max-age=60` on the server side — we respect the freshness window without parsing headers.** The 60s TTL in the extension (`EXT_CONFIG_CACHE_TTL_MS`) mirrors `server/routes/ext-config.js`'s `res.set('Cache-Control', 'public, max-age=60')`. Keeping them synchronized is a manual contract documented here — if the server bumps to 120s, the extension bumps to 120s in the same merge wave.

8. **`enforceConfigBeforeExport` is the single gate — never duplicate the check.** Ext.9 has exactly one enforcement site: the top of the `{type:"export"}` case in `service_worker.js`. The queue's `startRun` has a defensive assertion (was a check done?) but does NOT re-enforce. Duplicating the check creates the "two sources of truth" bug class: if a future phase adds a new enforcement path and forgets to update the original, flags silently fail to propagate. Single site, single guard.

9. **`daily_cap_override` is passed through but NOT wired to Ext.7's enforcement yet.** The endpoint returns `daily_cap_override` (a number or null); Ext.9 stores it in the cache but Ext.7's daily-cap check in `modules/classifier.js` still reads the compile-time constant. A future 2-line PR can plumb the override in. Flagged as a cross-phase note — do NOT re-architect `classifier.js` in this phase.

10. **Config-check failure messages map to explicit error codes consumed by WebApp.4 / popup.** Five canonical codes: `export_disabled_by_config`, `ext_version_below_min` (with `current` + `min` fields), `envato_disabled_by_config`, `pexels_disabled_by_config`, `freepik_disabled_by_config`. These land in the `startRun` reject payload AND in a `rate_limit_hit`-adjacent telemetry event (Ext.6's `session_expired`-style shape, NOT a new event — no `TELEMETRY_EVENT_ENUM` addition this phase). WebApp.4 will key its "Export disabled" UI off these exact strings; a typo here is a contract break.

## Config contract (from Backend 1.5)

The endpoint `GET /api/ext-config` returns the JSON below. Source: `server/services/ext-config.js`'s `getExtConfig()`:

```jsonc
{
  "min_ext_version":       "0.1.0",    // semver string; "0.1.0" is the DEFAULTS constant
  "export_enabled":        true,        // global kill
  "envato_enabled":        true,        // per-source kill
  "pexels_enabled":        true,        // per-source kill
  "freepik_enabled":       false,       // per-source kill (off until Ext.3 is verified e2e)
  "daily_cap_override":    null,        // integer | null — passed through, Ext.9 does NOT enforce
  "slack_alerts_enabled":  true         // server-facing only, Ext.9 passes through
}
```

Server response includes `Cache-Control: public, max-age=60` (intentional mirror of the extension's TTL).

Unknown fields: the extension MUST tolerate unknown keys gracefully (future server additions should not break older extensions). Missing required keys: treat as default-true for booleans, default-`DEFAULTS.min_ext_version` for `min_ext_version`. This matches Backend 1.5's own `DEFAULTS` object.

## Scope (Ext.9 only — hold the line)

### In scope

1. **`extension/modules/config-fetch.js` [NEW].** Public API: `fetchConfig()`, `getCachedConfig()`, `refreshConfigOnStartup()`, `enforceConfigBeforeExport(manifest)`. Internal: `compareSemver(a, b)` (20 lines, x.y.z only). Keeps an in-memory `_inFlightRefresh` Promise so race-awaiting is O(1).
2. **`extension/service_worker.js` [MOD].** Add `refreshConfigOnStartup()` call at SW top level + inside `chrome.runtime.onStartup` + `chrome.runtime.onInstalled` listeners (matches Ext.5's `autoResumeIfActiveRun` pattern). Add `enforceConfigBeforeExport(manifest)` at the top of the `{type:"export"}` case; reject early with `{ok:false, error_code: <canonical code>}` on gate failure. Add a `debug_fetch_config` handler.
3. **`extension/modules/queue.js` [MOD — minimal].** `startRun` grows a guard: if called without the SW having set `_config_check_passed === true` on the run params, warn-log + proceed (defensive only — the SW is supposed to have done the check). Aim for <10 new lines.
4. **`extension/popup.js` + `popup.html` + `popup.css` [MOD].** Surface three new states:
   - Global `export_enabled===false` → banner "Export temporarily disabled — check transcript-eval.com for status".
   - `min_ext_version > EXT_VERSION` → banner "Update required — <min> needed" with a placeholder link (`#` for now, real Chrome Web Store URL lands in Ext.11).
   - Per-source kills → the Envato auth row becomes "Envato downloads paused by transcript-eval" (replacing "Sign in to Envato" when applicable). Pexels/Freepik rows get their own "paused by transcript-eval" line (added in State C's Sources list; if State C isn't merged yet, popup shows aggregate "Some sources disabled" line only).
5. **`extension/config.js` [MOD].** Bump `EXT_VERSION` to `'0.9.0'`. Add `EXT_CONFIG_CACHE_TTL_MS = 60_000`, `EXT_CONFIG_ENDPOINT = '/api/ext-config'`, `CONFIG_CHECK_AWAIT_TIMEOUT_MS = 5000`, and `CONFIG_FALL_OPEN_DEFAULTS` (frozen object matching the safe-open fall-open shape).
6. **`extension/manifest.json` [MOD].** Bump `version` to `'0.9.0'`. NO new permissions — host permissions for `BACKEND_URL` are already set by Ext.3/4.
7. **`extension-test.html` [MOD].** Add "Ext.9 Config" fieldset with three buttons: "Fetch config now" (`debug_fetch_config`), "Show cached config", "Simulate config.export_enabled=false" (writes directly to cache).
8. **Unit tests [NEW].** `extension/__tests__/config-fetch.test.js`. ~8-12 tests covering:
   - `compareSemver` — equal, greater, lesser, trailing-zero normalization, invalid input rejection.
   - `enforceConfigBeforeExport` — healthy pass-through; each of the five reject codes; fall-open on no-cache + network failure; stale-cache-plus-failure uses stale; race: awaits in-flight refresh up to 5s.
9. **`extension/README.md` [MOD].** Append "Ext.9 — Feature flag fetch" section documenting TTL, semver gate, per-source kills, fall-open behavior, five canonical error codes.
10. **Manual smoke (no commit).** Flip `EXT_FREEPIK_ENABLED=false` on the Phase 1 backend at `:3001`, restart the backend (NEVER kill `:3001` — ask the user to restart), reload the extension, trigger a manifest with a Freepik item, observe the `freepik_disabled_by_config` reject. Flip back.

### Deferred (DO NOT include)

- CI packaging + Web Store upload → **Ext.10+**.
- Canary channel (second Web Store listing) → **Ext.11/Ext.12**.
- Daily-cap override integration — `daily_cap_override` is cached + surfaced but Ext.7's classifier daily-cap still reads the compile-time constant. A 2-line future PR plumbs it in.
- Popup-auto-closing behavior — popup surfaces the disabled state; user decides to close.
- Backend changes to `/api/ext-config` — the endpoint is read-only from Ext.9's perspective.
- WebApp.4 bundle parser changes for config telemetry — WebApp.4 consumes diagnostic bundles (Ext.8), not config events.
- Server-side feature flag auditing / event stream — unrelated surface.
- `chrome.alarms`-based periodic refresh — fire-and-forget on SW boot + pre-export is sufficient; periodic refresh is overkill for 60s-TTL data.

## Prerequisites

- Weeks 1-4 merged to local `main`; Wave 1 (Ext.7 + WebApp.3 + State F) merged; Wave 2 (Ext.8) merged at `8679693`; Ext.8 extension at v0.8.0.
- Vitest 96/96 green on `main` baseline.
- `chrome` + Node 20+ (Vite build).
- `chrome://extensions` loaded with the unpacked dev build.
- `localhost:3001` backend running with the Backend 1.5 `/api/ext-config` route live. Verify: `curl http://localhost:3001/api/ext-config` returns the expected JSON shape.
- User approval on **Open Question 1** (hand-rolled vs `semver` package) BEFORE Task 2. If denied, swap to `npm install semver@^7` in Task 2 and `import { gt } from 'semver'` in the module; drop the hand-rolled `compareSemver`.
- User approval on **Open Question 2** (fall-open defaults) BEFORE Task 2.
- User confirmation on **Open Question 4** (5s race timeout) BEFORE Task 2 — changing the constant later is trivial, but the value is documented here.
- Worktree skill: `superpowers:using-git-worktrees` for Task 0.
- Dirty-tree off-limits list (do not stage, do not commit, do not modify): `server/routes/gpu.js`, `server/services/gpu-failure-poller.js`, `check_placement.js`, `final_query*.js`, `query_*.js`, `server/db.sqlite`, `server/seed/update-*.js`, `docs/plans/2026-04-22-reset-broll-searches.md`, `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md`.

## File structure (Ext.9 final state)

```
extension/
├── manifest.json              [MOD Ext.9] version: "0.9.0"
├── config.js                  [MOD Ext.9] EXT_VERSION = '0.9.0'; EXT_CONFIG_* constants + CONFIG_FALL_OPEN_DEFAULTS
├── service_worker.js          [MOD Ext.9] refreshConfigOnStartup boot + enforceConfigBeforeExport gate + debug_fetch_config
├── popup.html                 [MOD Ext.9] global-disabled banner + update-required banner rows
├── popup.js                   [MOD Ext.9] reads cached config on open; renders banners / row text
├── popup.css                  [MOD Ext.9] styles for .config-banner + per-source paused row variant
├── README.md                  [MOD Ext.9] appended "Ext.9 — Feature flag fetch" section
├── modules/
│   ├── auth.js                unchanged
│   ├── envato.js              unchanged
│   ├── sources.js             unchanged
│   ├── queue.js               [MOD Ext.9] <10-line defensive _config_check_passed guard in startRun
│   ├── storage.js             unchanged
│   ├── telemetry.js           unchanged
│   ├── classifier.js          unchanged (daily_cap_override not wired — cross-phase note)
│   ├── diagnostics.js         unchanged (Ext.8 module)
│   ├── port.js                unchanged
│   └── config-fetch.js        [NEW Ext.9] fetchConfig + getCachedConfig + refreshConfigOnStartup + enforceConfigBeforeExport + compareSemver
├── fixtures/                  unchanged
├── icons/                     unchanged
└── __tests__/
    ├── diagnostics.test.js    unchanged (Ext.8 tests)
    └── config-fetch.test.js   [NEW Ext.9] ~8-12 tests
extension-test.html            [MOD Ext.9] Ext.9 Config fieldset with three debug buttons
```

Why this split:

- **`config-fetch.js` as its own module** (spec already names it in the roadmap § "Ext.9"). Single owner of the cache + fetch + enforcement logic keeps the gate-checking code centralized; any future refactor to push the cache into its own storage module has one target.
- **`compareSemver` co-located** with its one caller inside the same file. If a future phase needs semver compare elsewhere (unlikely), promote it then — premature extraction invites bike-shedding.
- **Tests at `extension/__tests__/config-fetch.test.js`** matches the Ext.8 convention (`extension/__tests__/diagnostics.test.js`). If Ext.8's tests landed in a different path, Executor must match that path — grep for `diagnostics.test.js` at Task 0.
- **`debug_fetch_config` handler** lives alongside Ext.8's `debug_build_bundle` handler in `service_worker.js` — one switch case, trivially greppable. Kept separate from the production path (`refreshConfigOnStartup`) so test-harness calls don't disturb the in-flight refresh Promise.
- **Per-source row copy** ("paused by transcript-eval") intentionally matches the brand voice of other popup copy ("Sign in to Envato", "Envato session active") rather than technical jargon like "disabled by flag". Users see this; WebApp.4 sees the error code.

## Working conventions

- **Worktree.** All work happens in `.worktrees/extension-ext9` (branch `feature/extension-ext9-ext-config`) created off current `main`. Use the `superpowers:using-git-worktrees` skill for Task 0. Do NOT work on `main` directly.
- **Never push.** No `git push origin` until the user confirms. Commits stay local.
- **Never kill anything on `:3001`.** The backend is running and other phases need it. `curl localhost:3001/api/ext-config` to verify liveness; do not pkill/killall. If the port is wedged, ask the user.
- **Quote every path.** The repo lives at `/Users/laurynas/Desktop/one last /transcript-eval` — the trailing space in `"one last "` is load-bearing. Every bash invocation quotes the full path with double-quotes; heredocs use absolute paths; `cd` is used sparingly.
- **Never amend.** Always new commits, even after a pre-commit hook failure.
- **One commit per task.** Each `Task N` ends with exactly one commit (or zero, for the manual-verify final task which is explicitly marked "DO NOT COMMIT"). Conventional-commit prefixes: `feat(extension):`, `fix(extension):`, `refactor(extension):`, `chore(extension):`, `test(extension):`, `docs(extension):`.
- **Commit trailer.** Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Dirty-tree off-limits.** See Prerequisites list above. These may appear as dirty in `git status`; leave them alone.
- **Investigate, don't guess.** Before implementing `enforceConfigBeforeExport`, `git grep -n "source" extension/modules/classifier.js extension/modules/queue.js` to confirm how sources are enumerated in the manifest. Before adding a new popup banner, read `extension/popup.html` end-to-end so banner placement matches existing row order.

## Task 0: Create worktree + branch + scaffold commit

**Files:** none (git operations only).

- [ ] **Step 0.1: Verify clean enough tree.**
  ```bash
  git -C "/Users/laurynas/Desktop/one last /transcript-eval" status --short \
    | grep -vE '^(\?\?)|gpu|check_placement|final_query|query_|server/db\.sqlite|server/seed/update-|docs/plans/2026-04-22|docs/superpowers/plans/2026-04-22' \
    | head -20
  ```
  Output must be empty (only the known dirty-tree files present). If anything else is dirty, stop and ask the user.
- [ ] **Step 0.2: Verify Ext.8 baseline is merged.**
  ```bash
  git -C "/Users/laurynas/Desktop/one last /transcript-eval" log --oneline -5
  # Expect 8679693 (or later) — Ext.8 merge.
  grep -n 'EXT_VERSION' "/Users/laurynas/Desktop/one last /transcript-eval/extension/config.js"
  # Expect EXT_VERSION = '0.8.0'
  ```
- [ ] **Step 0.3: Confirm Backend 1.5 endpoint is live.**
  ```bash
  curl -sS http://localhost:3001/api/ext-config | head -c 500
  # Expect JSON with min_ext_version, export_enabled, envato_enabled, pexels_enabled, freepik_enabled, daily_cap_override, slack_alerts_enabled
  ```
  If this 404s, ask the user to restart the backend — do NOT proceed.
- [ ] **Step 0.4: Create worktree.** Invoke `superpowers:using-git-worktrees`. Target directory: `.worktrees/extension-ext9`. Branch name: `feature/extension-ext9-ext-config`. Base: `main`. The skill handles `git worktree add` + initial `cd`.
- [ ] **Step 0.5: Copy this plan into the worktree** so the executor has it within the working tree.
  ```bash
  cp "/Users/laurynas/Desktop/one last /transcript-eval/docs/superpowers/plans/2026-04-24-extension-ext9-ext-config.md" \
     "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9/docs/superpowers/plans/2026-04-24-extension-ext9-ext-config.md"
  ```
- [ ] **Step 0.6: Smoke build + baseline tests.** `cd` into the worktree then:
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  npm run build 2>&1 | tail -20
  # exits 0
  npm run test 2>&1 | tail -20
  # 96/96 green
  ```
- [ ] **Step 0.7: Confirm test convention from Ext.8.**
  ```bash
  ls -la extension/__tests__/ 2>/dev/null
  # Expect diagnostics.test.js (Ext.8) present — confirms the path convention Task 8 will follow.
  ```
  If `extension/__tests__/` doesn't exist (Ext.8 landed tests elsewhere), grep for the actual path: `git -C . grep -l 'scrubSensitive' -- '*.test.js' '*.spec.js'`. Adjust Task 8's target path accordingly.
- [ ] **Step 0.8: Scaffold commit.** Empty-ish commit marking the start of Ext.9.
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add docs/superpowers/plans/2026-04-24-extension-ext9-ext-config.md
  git commit -m "$(cat <<'EOF'
  chore(extension): start Ext.9 feature flag fetch branch

  Scaffold commit with the Ext.9 plan copied into the worktree.
  Ext.9 consumes Backend 1.5's /api/ext-config (public endpoint,
  60s cache TTL) and gates {type:"export"} messages on global
  export_enabled, per-source kill switches, and a semver
  min_ext_version check. Fall-open on no-cache + network failure
  so a down backend never strands users.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```
- [ ] **Step 0.9: Verify branch + worktree.**
  ```bash
  git -C "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9" branch --show-current
  # feature/extension-ext9-ext-config
  git -C "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9" log --oneline main..HEAD
  # exactly the scaffold commit
  ```

## Task 1: Manifest + config bump (v0.9.0 + Ext.9 constants)

**Files:** `extension/manifest.json`, `extension/config.js`.

- [ ] **Step 1.1: Bump manifest version.** Edit `extension/manifest.json`: `"version": "0.8.0"` → `"version": "0.9.0"`. No other changes in this file (host permissions already cover `BACKEND_URL` from Ext.3/4).
- [ ] **Step 1.2: Bump EXT_VERSION in config.js.** `export const EXT_VERSION = '0.8.0'` → `'0.9.0'`.
- [ ] **Step 1.3: Append Ext.9 constants block to config.js.** After the Ext.8 block (currently ending at `DIAGNOSTICS_SCHEMA_VERSION`):
  ```js
  // -------- Ext.9 feature flag fetch --------
  //
  // Source of truth for /api/ext-config consumption. Keep this block
  // in sync with server/routes/ext-config.js — both share the 60s
  // TTL contract (server sets Cache-Control: public, max-age=60).

  // Endpoint path appended to BACKEND_URL. PUBLIC (no auth) — must stay
  // public so newly-installed extensions can gate BEFORE JWT mint.
  export const EXT_CONFIG_ENDPOINT = '/api/ext-config'

  // Cache TTL in ms. Fresh (<60s) → trust. Stale (>60s) + fetch failure
  // → trust stale with a warning log. No cache at all + fetch failure
  // → fall open (see CONFIG_FALL_OPEN_DEFAULTS).
  export const EXT_CONFIG_CACHE_TTL_MS = 60 * 1000

  // Max wait for an in-flight startup refresh when the first
  // {type:"export"} races with SW boot. Past this, fall back to
  // cached / fall-open.
  export const CONFIG_CHECK_AWAIT_TIMEOUT_MS = 5000

  // Fall-open defaults — what enforceConfigBeforeExport uses when no
  // cache exists AND fetch failed. Match Backend 1.5 DEFAULTS where
  // they are "on"; freepik_enabled is true here (vs false in server
  // DEFAULTS) because fall-open means "backend unreachable" — a remote
  // safety flag cannot be honored when we cannot reach the remote.
  // The user gets Freepik; if Freepik is broken upstream, the download
  // itself will fail with a clear per-item error.
  export const CONFIG_FALL_OPEN_DEFAULTS = Object.freeze({
    min_ext_version:      '0.0.0',
    export_enabled:       true,
    envato_enabled:       true,
    pexels_enabled:       true,
    freepik_enabled:      true,
    daily_cap_override:   null,
    slack_alerts_enabled: false,  // client doesn't care — pass-through field
  })

  // Canonical error codes emitted by enforceConfigBeforeExport on reject.
  // WebApp.4 / popup key UI off these exact strings — do NOT rename.
  export const CONFIG_ERROR_CODES = Object.freeze({
    EXPORT_DISABLED:    'export_disabled_by_config',
    VERSION_BELOW_MIN:  'ext_version_below_min',
    ENVATO_DISABLED:    'envato_disabled_by_config',
    PEXELS_DISABLED:    'pexels_disabled_by_config',
    FREEPIK_DISABLED:   'freepik_disabled_by_config',
  })
  ```
- [ ] **Step 1.4: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  node -e "import('./extension/config.js').then(m => console.log(m.EXT_VERSION, m.EXT_CONFIG_ENDPOINT, m.EXT_CONFIG_CACHE_TTL_MS, m.CONFIG_CHECK_AWAIT_TIMEOUT_MS, JSON.stringify(m.CONFIG_FALL_OPEN_DEFAULTS), JSON.stringify(m.CONFIG_ERROR_CODES)))"
  # 0.9.0 /api/ext-config 60000 5000 {...} {...}
  grep -n '"version"' extension/manifest.json
  # "version": "0.9.0"
  ```
- [ ] **Step 1.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/manifest.json extension/config.js
  git commit -m "$(cat <<'EOF'
  feat(extension): bump to v0.9.0 + Ext.9 config constants

  manifest.json + config.js EXT_VERSION → 0.9.0. config.js grows
  a new Ext.9 block with EXT_CONFIG_ENDPOINT (/api/ext-config),
  EXT_CONFIG_CACHE_TTL_MS (60s — mirrors server Cache-Control),
  CONFIG_CHECK_AWAIT_TIMEOUT_MS (5s race-await cap),
  CONFIG_FALL_OPEN_DEFAULTS (safe-open shape), and
  CONFIG_ERROR_CODES (five canonical reject strings).

  No new permissions — host permissions for BACKEND_URL already
  cover /api/ext-config (same origin as Ext.3's /api/pexels-url +
  /api/freepik-url).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 2: `config-fetch.js` — module skeleton + `compareSemver`

**Files:** `extension/modules/config-fetch.js` [NEW].

> **BLOCKING:** Do NOT proceed with this task until **Open Questions 1, 2, and 4** are answered. If the user accepts all three recommendations, proceed as written. If OQ1 is rejected (user wants `semver` package), run `npm install semver@^7` first, drop Step 2.2's hand-rolled comparator, and `import { gt } from 'semver'` instead.

- [ ] **Step 2.1: Create `extension/modules/config-fetch.js` with skeleton + imports.**
  ```js
  // Ext.9 — feature flag fetch + enforcement gate.
  //
  // Public API:
  //   fetchConfig()                      — fetch /api/ext-config, cache it, return result
  //   getCachedConfig()                  — read cached_ext_config; return {config, fresh} or null
  //   refreshConfigOnStartup()           — fire-and-forget boot refresh; populates _inFlightRefresh
  //   enforceConfigBeforeExport(manifest) — gate a {type:"export"} message; returns {ok, error_code?}
  //
  // Internal:
  //   compareSemver(a, b)                — -1 / 0 / 1 for x.y.z strings
  //
  // See docs/superpowers/plans/2026-04-24-extension-ext9-ext-config.md
  // for the fall-open + race semantics. Do NOT change the five canonical
  // error codes without a coordinated WebApp.4 update.

  import {
    BACKEND_URL,
    EXT_VERSION,
    EXT_CONFIG_ENDPOINT,
    EXT_CONFIG_CACHE_TTL_MS,
    CONFIG_CHECK_AWAIT_TIMEOUT_MS,
    CONFIG_FALL_OPEN_DEFAULTS,
    CONFIG_ERROR_CODES,
  } from '../config.js'

  const CACHE_KEY = 'cached_ext_config'

  // In-memory handle to any currently-pending fetch. enforceConfigBeforeExport
  // awaits this (with a timeout) so the startup-racing-first-export edge
  // case does not surface a fall-open when a fresh response is about to land.
  let _inFlightRefresh = null
  ```
- [ ] **Step 2.2: Implement `compareSemver(a, b)`.** Append below the imports block. ≈20 lines.
  ```js
  // Minimal x.y.z semver comparator. Pre-release tags + build metadata
  // are NOT supported — this scope is fully controlled on both ends
  // (EXT_VERSION + server's min_ext_version are always plain x.y.z).
  // Returns -1 / 0 / 1; throws on malformed input.
  export function compareSemver(a, b) {
    const parse = s => {
      if (typeof s !== 'string') throw new Error(`compareSemver: expected string, got ${typeof s}`)
      const parts = s.split('.')
      if (parts.length !== 3) throw new Error(`compareSemver: expected x.y.z, got "${s}"`)
      return parts.map((p, i) => {
        const n = Number.parseInt(p, 10)
        if (!Number.isFinite(n) || String(n) !== p || n < 0) {
          throw new Error(`compareSemver: invalid segment "${p}" in "${s}"`)
        }
        return n
      })
    }
    const pa = parse(a), pb = parse(b)
    for (let i = 0; i < 3; i++) {
      if (pa[i] < pb[i]) return -1
      if (pa[i] > pb[i]) return 1
    }
    return 0
  }
  ```
- [ ] **Step 2.3: Verify imports + `compareSemver` resolve.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  node -e "import('./extension/modules/config-fetch.js').then(m => { console.log(m.compareSemver('0.9.0', '0.1.0')); console.log(m.compareSemver('1.0.0', '1.0.0')); console.log(m.compareSemver('0.8.0', '0.9.0')); })"
  # 1
  # 0
  # -1
  ```
- [ ] **Step 2.4: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/modules/config-fetch.js
  git commit -m "$(cat <<'EOF'
  feat(extension): config-fetch module skeleton + compareSemver

  New modules/config-fetch.js. Hand-rolled 20-line compareSemver
  for x.y.z strings — no runtime dep. The semver npm package adds
  ~55KB to the bundle for range-parsing and pre-release features
  we do not use here; scope is exactly "EXT_VERSION vs
  min_ext_version" and both are always plain x.y.z.

  Skeleton exports an _inFlightRefresh handle that Task 4's
  enforceConfigBeforeExport will await (with a 5s cap) to resolve
  the startup-racing-first-export edge case.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 3: `fetchConfig` + `getCachedConfig` + `refreshConfigOnStartup`

**Files:** `extension/modules/config-fetch.js`.

- [ ] **Step 3.1: Implement `fetchConfig()`.** Append below `compareSemver`.
  ```js
  // Fetch /api/ext-config; on 2xx parse JSON, validate required keys,
  // persist to chrome.storage.local.cached_ext_config with fetched_at.
  // On network failure or non-2xx, rethrow — callers decide fall-open.
  export async function fetchConfig() {
    const url = `${BACKEND_URL}${EXT_CONFIG_ENDPOINT}`
    let resp
    try {
      resp = await fetch(url, { method: 'GET', credentials: 'omit' })
    } catch (err) {
      // Network failure (DNS, offline, CORS). Caller handles fall-open.
      throw new Error(`[config-fetch] fetch failed: ${err?.message || err}`)
    }
    if (!resp.ok) {
      throw new Error(`[config-fetch] non-2xx: ${resp.status}`)
    }
    let json
    try {
      json = await resp.json()
    } catch (err) {
      throw new Error(`[config-fetch] JSON parse failed: ${err?.message || err}`)
    }
    // Minimum validation — reject obviously malformed responses.
    if (!json || typeof json !== 'object' || typeof json.min_ext_version !== 'string') {
      throw new Error(`[config-fetch] invalid response shape: ${JSON.stringify(json).slice(0, 200)}`)
    }
    const record = { config: json, fetched_at: Date.now() }
    try {
      await chrome.storage.local.set({ [CACHE_KEY]: record })
    } catch (err) {
      console.warn('[config-fetch] cache write failed', err)
      // Do NOT rethrow — the caller has the in-memory result.
    }
    return record
  }
  ```
- [ ] **Step 3.2: Implement `getCachedConfig()`.** Append below `fetchConfig`.
  ```js
  // Read the cached config + compute freshness. Returns
  // { config, fetched_at, fresh } or null if no cache exists.
  // fresh === true iff Date.now() - fetched_at < EXT_CONFIG_CACHE_TTL_MS.
  export async function getCachedConfig() {
    let record
    try {
      const res = await chrome.storage.local.get(CACHE_KEY)
      record = res[CACHE_KEY]
    } catch (err) {
      console.warn('[config-fetch] cache read failed', err)
      return null
    }
    if (!record || !record.config || typeof record.fetched_at !== 'number') return null
    const age = Date.now() - record.fetched_at
    return {
      config: record.config,
      fetched_at: record.fetched_at,
      fresh: age >= 0 && age < EXT_CONFIG_CACHE_TTL_MS,
    }
  }
  ```
- [ ] **Step 3.3: Implement `refreshConfigOnStartup()`.** Append below `getCachedConfig`.
  ```js
  // Fire-and-forget from SW boot. Populates _inFlightRefresh so
  // enforceConfigBeforeExport can await if a first export races
  // with boot. Never throws — logs and swallows.
  export function refreshConfigOnStartup() {
    if (_inFlightRefresh) return _inFlightRefresh
    _inFlightRefresh = (async () => {
      try {
        const record = await fetchConfig()
        return { ok: true, record }
      } catch (err) {
        console.warn('[config-fetch] refreshConfigOnStartup: fetch failed; falling back to cache or fall-open', err?.message || err)
        return { ok: false, error: String(err?.message || err) }
      } finally {
        // Clear after the Promise resolves so subsequent awaiters
        // trigger a new fetch (not wait on a resolved one forever).
        queueMicrotask(() => { _inFlightRefresh = null })
      }
    })()
    return _inFlightRefresh
  }

  // Exported for tests + the awaiting-logic in enforceConfigBeforeExport.
  export function _getInFlightRefresh() { return _inFlightRefresh }
  ```
- [ ] **Step 3.4: Verify the three new exports exist.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  node -e "import('./extension/modules/config-fetch.js').then(m => console.log(Object.keys(m).sort().join(',')))"
  # _getInFlightRefresh,compareSemver,fetchConfig,getCachedConfig,refreshConfigOnStartup
  ```
- [ ] **Step 3.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/modules/config-fetch.js
  git commit -m "$(cat <<'EOF'
  feat(extension): config-fetch — fetchConfig + getCachedConfig + startup refresh

  fetchConfig() hits BACKEND_URL/api/ext-config (no auth), parses
  JSON, validates min_ext_version is a string, persists
  {config, fetched_at} to chrome.storage.local.cached_ext_config.
  Errors rethrown — callers decide fall-open.

  getCachedConfig() returns {config, fetched_at, fresh} or null.
  fresh === true iff age < EXT_CONFIG_CACHE_TTL_MS (60s).

  refreshConfigOnStartup() is fire-and-forget — holds the in-flight
  Promise in _inFlightRefresh so enforceConfigBeforeExport can
  await-with-timeout during the startup-racing-first-export edge.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 4: `enforceConfigBeforeExport`

**Files:** `extension/modules/config-fetch.js`.

- [ ] **Step 4.1: Implement `enforceConfigBeforeExport(manifest)`.** Append below `_getInFlightRefresh`.
  ```js
  // Gate a {type:"export"} message. Returns:
  //   { ok: true, effective_config, reason? }
  //   { ok: false, error_code, detail?, current?, min? }
  //
  // Ordering:
  //   1. Await any in-flight startup refresh, up to CONFIG_CHECK_AWAIT_TIMEOUT_MS.
  //   2. Read cached config (fresh or stale).
  //   3. If no cache AND no successful refresh: fall open (safe-by-default).
  //   4. Run five gates in order: export_enabled → version → per-source.
  //
  // manifest is the user's export manifest; inspected only for which
  // sources appear (so per-source kills only fire when that source is
  // actually in the run).
  export async function enforceConfigBeforeExport(manifest) {
    // --- Step 1: await in-flight refresh (bounded) ---
    const inflight = _inFlightRefresh
    if (inflight) {
      await Promise.race([
        inflight.catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, CONFIG_CHECK_AWAIT_TIMEOUT_MS)),
      ])
    }

    // --- Step 2: read cache ---
    let effective_config
    let reason = 'cache_fresh'
    const cached = await getCachedConfig()
    if (cached && cached.fresh) {
      effective_config = cached.config
    } else if (cached && !cached.fresh) {
      // Stale cache + (no successful refresh landed). Try ONE direct fetch
      // — cheap and often succeeds if only the startup race timed out.
      try {
        const fresh = await fetchConfig()
        effective_config = fresh.config
        reason = 'cache_refreshed_on_demand'
      } catch (err) {
        effective_config = cached.config
        reason = 'cache_stale_fetch_failed'
        console.warn('[config-fetch] using stale cache; on-demand fetch failed:', err?.message || err)
      }
    } else {
      // --- Step 3: no cache at all ---
      try {
        const fresh = await fetchConfig()
        effective_config = fresh.config
        reason = 'cache_miss_fetched_on_demand'
      } catch (err) {
        effective_config = CONFIG_FALL_OPEN_DEFAULTS
        reason = 'fall_open_no_cache_no_network'
        console.warn('[config-fetch] FALL-OPEN: no cache + fetch failed:', err?.message || err)
      }
    }

    // --- Step 4: gates ---
    if (effective_config.export_enabled === false) {
      return { ok: false, error_code: CONFIG_ERROR_CODES.EXPORT_DISABLED, detail: 'Export temporarily disabled' }
    }
    const minVersion = effective_config.min_ext_version || CONFIG_FALL_OPEN_DEFAULTS.min_ext_version
    try {
      if (compareSemver(EXT_VERSION, minVersion) < 0) {
        return {
          ok: false,
          error_code: CONFIG_ERROR_CODES.VERSION_BELOW_MIN,
          detail: `Extension v${EXT_VERSION} below required v${minVersion}`,
          current: EXT_VERSION,
          min: minVersion,
        }
      }
    } catch (err) {
      // Malformed min_ext_version from server — log and pass (fall-open spirit).
      console.warn('[config-fetch] compareSemver failed, passing gate:', err?.message || err)
    }
    const sourcesInManifest = collectSources(manifest)
    if (sourcesInManifest.has('envato') && effective_config.envato_enabled === false) {
      return { ok: false, error_code: CONFIG_ERROR_CODES.ENVATO_DISABLED, detail: 'Envato downloads paused by transcript-eval' }
    }
    if (sourcesInManifest.has('pexels') && effective_config.pexels_enabled === false) {
      return { ok: false, error_code: CONFIG_ERROR_CODES.PEXELS_DISABLED, detail: 'Pexels downloads paused by transcript-eval' }
    }
    if (sourcesInManifest.has('freepik') && effective_config.freepik_enabled === false) {
      return { ok: false, error_code: CONFIG_ERROR_CODES.FREEPIK_DISABLED, detail: 'Freepik downloads paused by transcript-eval' }
    }
    return { ok: true, effective_config, reason }
  }

  // Extract the set of unique sources referenced by a manifest. Tolerant
  // of malformed manifests (returns an empty set) so a bad input doesn't
  // hide a real gate failure. Manifest shape per spec: {items: [{source}]}.
  function collectSources(manifest) {
    const out = new Set()
    if (!manifest || !Array.isArray(manifest.items)) return out
    for (const item of manifest.items) {
      if (item && typeof item.source === 'string') out.add(item.source)
    }
    return out
  }
  ```
- [ ] **Step 4.2: Verify the export exists.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  node -e "import('./extension/modules/config-fetch.js').then(m => console.log(typeof m.enforceConfigBeforeExport))"
  # function
  ```
- [ ] **Step 4.3: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/modules/config-fetch.js
  git commit -m "$(cat <<'EOF'
  feat(extension): config-fetch — enforceConfigBeforeExport gate

  Single enforcement site: await in-flight startup refresh (5s cap),
  read cache, fall through to cache-refreshed-on-demand / stale-cache /
  fall-open, then run five gates in order: export_enabled → semver
  version → envato → pexels → freepik. Per-source gates only fire
  when that source appears in the manifest.

  Five canonical error codes returned on reject:
    export_disabled_by_config
    ext_version_below_min (with current + min fields)
    envato_disabled_by_config
    pexels_disabled_by_config
    freepik_disabled_by_config

  WebApp.4 and popup.js key UI off these exact strings.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 5: Wire `service_worker.js` — boot refresh + export gate + debug handler

**Files:** `extension/service_worker.js`.

- [ ] **Step 5.1: Import config-fetch.** At the top imports block (next to the `diagnostics` import):
  ```js
  import {
    refreshConfigOnStartup,
    enforceConfigBeforeExport,
    fetchConfig,
    getCachedConfig,
  } from './modules/config-fetch.js'
  ```
- [ ] **Step 5.2: Gate the `{type:"export"}` case.** Modify the existing `case 'export':` block. Insert the enforcement check BEFORE any other work in the case:
  ```js
  case 'export': {
    const { manifest, target_folder, options, export_id } = msg
    // Ext.9 — enforce feature flags BEFORE anything else. Single site;
    // startRun has a defensive guard only (see queue.js).
    const gate = await enforceConfigBeforeExport(manifest)
    if (!gate.ok) {
      sendResponse({ ok: false, error_code: gate.error_code, detail: gate.detail, current: gate.current, min: gate.min })
      return
    }
    // user_id comes from the stored JWT — queue uses it for
    // completed_items keying.
    const jwt = await getJwt()
    const userId = jwt?.user_id || null
    const result = await startRun({
      runId: export_id,
      manifest,
      targetFolder: target_folder,
      options,
      userId,
      // Ext.9 — mark that the config gate passed so queue.startRun's
      // defensive guard doesn't warn-log.
      _config_check_passed: true,
    })
    sendResponse(result)
    return
  }
  ```
- [ ] **Step 5.3: Add the `debug_fetch_config` case + `debug_get_cached_config` case + `debug_set_cached_config` case.** Co-located with Ext.8's `debug_build_bundle` case:
  ```js
  case 'debug_fetch_config': {
    try {
      const record = await fetchConfig()
      sendResponse({ ok: true, record })
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) })
    }
    return
  }
  case 'debug_get_cached_config': {
    try {
      const cached = await getCachedConfig()
      sendResponse({ ok: true, cached })
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) })
    }
    return
  }
  case 'debug_set_cached_config': {
    // Test harness only — directly writes a cache record. Used to
    // simulate export_enabled=false without touching the backend.
    try {
      const { config, fetched_at } = msg
      if (!config || typeof config !== 'object') {
        sendResponse({ ok: false, error: 'config (object) required' })
        return
      }
      await chrome.storage.local.set({ cached_ext_config: { config, fetched_at: fetched_at || Date.now() } })
      sendResponse({ ok: true })
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) })
    }
    return
  }
  ```
- [ ] **Step 5.4: Add startup refresh hooks.** Find the existing `chrome.runtime.onStartup.addListener` block (Ext.5) and add a refresh call inside, plus a top-level call next to the module-init `autoResumeIfActiveRun`:
  ```js
  chrome.runtime.onStartup.addListener(() => {
    // Ext.9 — fire-and-forget config refresh on Chrome startup.
    refreshConfigOnStartup()
    autoResumeIfActiveRun().catch(err => {
      console.error('[sw] autoResumeIfActiveRun on startup failed', err)
    })
  })
  chrome.runtime.onInstalled.addListener(() => {
    // Ext.9 — fire-and-forget config refresh on install / update.
    refreshConfigOnStartup()
    autoResumeIfActiveRun().catch(err => {
      console.error('[sw] autoResumeIfActiveRun on install failed', err)
    })
  })
  // Also try at module top level — onStartup doesn't always fire on
  // SW wake from idle (it fires on Chrome startup). The top-level call
  // covers wake-from-idle.
  refreshConfigOnStartup()  // Ext.9 — fire-and-forget, safe to call repeatedly.
  autoResumeIfActiveRun().catch(err => {
    console.error('[sw] autoResumeIfActiveRun at module-init failed', err)
  })
  ```
- [ ] **Step 5.5: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  grep -n "enforceConfigBeforeExport\|refreshConfigOnStartup\|debug_fetch_config" extension/service_worker.js
  # Expect multiple hits covering the import, the gate call, the three debug cases, the three boot calls.
  node -e "import('./extension/service_worker.js').catch(e => console.log('module load error (expected — uses chrome globals):', e.message))"
  ```
- [ ] **Step 5.6: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/service_worker.js
  git commit -m "$(cat <<'EOF'
  feat(extension): service_worker — Ext.9 boot refresh + export gate

  SW now fires refreshConfigOnStartup() at module top-level,
  chrome.runtime.onStartup, and chrome.runtime.onInstalled — three
  entry points matching the Ext.5 autoResumeIfActiveRun pattern.
  Fire-and-forget; never blocks SW init.

  {type:"export"} case gated by enforceConfigBeforeExport BEFORE
  any other work (JWT read, startRun dispatch). Reject payload
  surfaces {ok:false, error_code, detail, current?, min?} per the
  five canonical codes. On pass, startRun is called with
  _config_check_passed: true so the queue's defensive guard
  stays quiet.

  Three debug_* handlers added for the extension-test harness:
  debug_fetch_config, debug_get_cached_config, debug_set_cached_config.
  Test-harness use only; never called from production code.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 6: `queue.js` — defensive `_config_check_passed` guard

**Files:** `extension/modules/queue.js`.

- [ ] **Step 6.1: Locate `startRun`.** Grep for `export async function startRun` — it's the queue's entry point.
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  grep -n "export async function startRun\|export function startRun" extension/modules/queue.js
  ```
- [ ] **Step 6.2: Add the guard at the top of `startRun`.** ≈8 lines total.
  ```js
  export async function startRun(params) {
    // Ext.9 — defensive guard. The SW's {type:"export"} handler MUST call
    // enforceConfigBeforeExport and pass _config_check_passed: true in
    // params. If this flag is missing, the SW was bypassed (either a test
    // harness or a future code path). Warn-log but PROCEED — Ext.9's
    // contract is single-site enforcement, not defense-in-depth.
    if (!params || params._config_check_passed !== true) {
      console.warn('[queue] startRun called without _config_check_passed — config gate bypassed')
    }
    // ... existing body unchanged
  }
  ```
- [ ] **Step 6.3: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  grep -n "_config_check_passed" extension/modules/queue.js extension/service_worker.js
  # queue.js: the warn-log guard
  # service_worker.js: the pass-through in the export case
  ```
- [ ] **Step 6.4: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/modules/queue.js
  git commit -m "$(cat <<'EOF'
  feat(extension): queue — defensive _config_check_passed guard

  startRun logs a warning if called without the SW having set
  _config_check_passed: true in params. Proceeds normally — Ext.9's
  contract is single-site enforcement at the SW's {type:"export"}
  case, not defense-in-depth at the queue. The guard catches future
  code paths that might bypass the SW (test harnesses, direct
  queue calls from a new message type).

  <10 new lines.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 7: Popup UI — banners + per-source row states

**Files:** `extension/popup.html`, `extension/popup.js`, `extension/popup.css`.

- [ ] **Step 7.1: Add the config-banner block to `popup.html`.** Insert near the top of the popup body, BEFORE the existing auth rows (so the banner is the first thing users see). The HTML:
  ```html
  <!-- Ext.9 — global config state banner. Hidden by default; popup.js
       toggles the .show class based on cached config. -->
  <div id="config-banner" class="config-banner" hidden>
    <div class="config-banner-icon" aria-hidden="true">!</div>
    <div class="config-banner-body">
      <div id="config-banner-title" class="config-banner-title"></div>
      <div id="config-banner-detail" class="config-banner-detail"></div>
      <a id="config-banner-action" class="config-banner-action" href="#" hidden>Open Chrome Web Store</a>
    </div>
  </div>
  ```
- [ ] **Step 7.2: Add the per-source-paused row variant.** In the Envato auth row (the row that switches between "Sign in to Envato" and "Envato session active"), add a third state: `data-state="paused"` with copy "Envato downloads paused by transcript-eval". The existing row HTML structure stays; popup.js sets `data-state` dynamically.
- [ ] **Step 7.3: Read cached config on popup open.** In `popup.js`, in the DOMContentLoaded / init handler, fetch the cached config and render banners:
  ```js
  import { EXT_VERSION, CONFIG_ERROR_CODES } from './config.js'

  async function renderConfigBanner() {
    const banner = document.getElementById('config-banner')
    const title  = document.getElementById('config-banner-title')
    const detail = document.getElementById('config-banner-detail')
    const action = document.getElementById('config-banner-action')

    // Read cached config directly from chrome.storage.local — popup.js
    // intentionally does NOT import config-fetch.js to keep the popup
    // bundle small. The cache format is stable (see Ext.9 plan).
    const { cached_ext_config } = await chrome.storage.local.get('cached_ext_config')
    const cfg = cached_ext_config?.config
    if (!cfg) {
      banner.hidden = true
      return
    }

    if (cfg.export_enabled === false) {
      banner.hidden = false
      banner.dataset.severity = 'error'
      title.textContent = 'Export temporarily disabled'
      detail.textContent = 'Check transcript-eval.com for status.'
      action.hidden = true
      return
    }

    // Semver compare inline (avoid importing compareSemver to keep
    // popup bundle lean — duplication is three lines).
    const parse = s => s.split('.').map(n => parseInt(n, 10))
    const [ca, cb, cc] = parse(EXT_VERSION)
    const [ma, mb, mc] = parse(cfg.min_ext_version || '0.0.0')
    const below = (ca < ma) || (ca === ma && cb < mb) || (ca === ma && cb === mb && cc < mc)
    if (below) {
      banner.hidden = false
      banner.dataset.severity = 'warn'
      title.textContent = 'Update required'
      detail.textContent = `v${EXT_VERSION} is below required v${cfg.min_ext_version}.`
      action.hidden = false
      action.href = '#'  // Ext.11 fills in the real Chrome Web Store URL.
      return
    }

    // Per-source kill aggregate banner. Per-row updates are State C's
    // job; popup shows an aggregate hint when State C isn't rendered.
    const killed = []
    if (cfg.envato_enabled === false) killed.push('Envato')
    if (cfg.pexels_enabled === false) killed.push('Pexels')
    if (cfg.freepik_enabled === false) killed.push('Freepik')
    if (killed.length > 0) {
      banner.hidden = false
      banner.dataset.severity = 'info'
      title.textContent = 'Some sources disabled'
      detail.textContent = `${killed.join(', ')} paused by transcript-eval.`
      action.hidden = true
      return
    }

    banner.hidden = true
  }

  // Also update the Envato row's data-state when envato_enabled is false.
  async function updateEnvatoRowForConfig() {
    const { cached_ext_config } = await chrome.storage.local.get('cached_ext_config')
    const cfg = cached_ext_config?.config
    const row = document.getElementById('envato-auth-row')  // id may differ — executor: match existing id
    if (!row || !cfg) return
    if (cfg.envato_enabled === false) {
      row.dataset.state = 'paused'
    }
  }

  // Add these two to the existing init sequence (after the Ext.8 opt-out
  // toggle reader, before the initial state paint).
  await renderConfigBanner()
  await updateEnvatoRowForConfig()
  ```
  **Executor note:** Match `getElementById` ids to existing popup DOM. Grep the current `popup.html` to confirm the Envato row's id before hard-coding `envato-auth-row`.
- [ ] **Step 7.4: Add CSS for `.config-banner` + paused-row variant.** In `popup.css`:
  ```css
  /* Ext.9 — config state banner. Three severity variants. */
  .config-banner {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 6px;
    margin: 8px 0;
    border: 1px solid #e5e7eb;
    background: #fef3c7;  /* default: warn */
  }
  .config-banner[data-severity="error"] { background: #fee2e2; border-color: #fecaca; }
  .config-banner[data-severity="warn"]  { background: #fef3c7; border-color: #fde68a; }
  .config-banner[data-severity="info"]  { background: #e0f2fe; border-color: #bae6fd; }
  .config-banner-icon { flex: 0 0 auto; font-weight: 700; width: 20px; height: 20px; border-radius: 50%; background: #000; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 12px; }
  .config-banner-body { flex: 1 1 auto; min-width: 0; }
  .config-banner-title  { font-weight: 600; color: #111827; }
  .config-banner-detail { color: #374151; font-size: 13px; margin-top: 2px; }
  .config-banner-action { display: inline-block; margin-top: 6px; color: #1d4ed8; font-size: 13px; }

  /* Ext.9 — Envato auth row "paused" state (distinct from "signed-out"). */
  [data-state="paused"] { color: #6b7280; font-style: italic; }
  [data-state="paused"]::before { content: "⏸  "; font-style: normal; }
  ```
- [ ] **Step 7.5: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  grep -n "config-banner\|cached_ext_config" extension/popup.html extension/popup.js extension/popup.css
  # Expect hits in all three files.
  npm run build 2>&1 | tail -10
  # exits 0
  ```
- [ ] **Step 7.6: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/popup.html extension/popup.js extension/popup.css
  git commit -m "$(cat <<'EOF'
  feat(extension): popup — Ext.9 config banners + paused row state

  popup.js now reads chrome.storage.local.cached_ext_config on open
  and renders a single .config-banner with three severity variants:
    - error: "Export temporarily disabled" (global export_enabled=false)
    - warn:  "Update required" (EXT_VERSION < min_ext_version)
    - info:  "Some sources disabled" (per-source kill aggregate)

  Envato auth row gains a [data-state="paused"] variant styled
  distinctly from the signed-out state — users can tell "I need to
  sign in" from "the service is paused upstream".

  Popup does NOT import config-fetch.js (keeps bundle small); cache
  format is stable + read directly. Inline 3-line semver compare
  avoids the runtime import.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 8: Tests — `compareSemver` + `enforceConfigBeforeExport` + fall-open

**Files:** `extension/__tests__/config-fetch.test.js` [NEW].

- [ ] **Step 8.1: Confirm test convention matches Ext.8.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  ls extension/__tests__/
  # Expect diagnostics.test.js — confirms the path convention.
  ```
- [ ] **Step 8.2: Create `extension/__tests__/config-fetch.test.js`.** ≈8-12 tests.
  ```js
  // Ext.9 — config-fetch unit tests.
  //
  // Covers:
  //   compareSemver: equal, greater, lesser, invalid input rejection.
  //   enforceConfigBeforeExport: healthy pass-through; each reject code;
  //     fall-open on no-cache + network failure; stale-cache + failure
  //     uses stale; awaits in-flight refresh up to timeout.

  import { describe, it, expect, beforeEach, vi } from 'vitest'

  // Mock chrome.storage.local before importing the module under test.
  beforeEach(() => {
    const store = new Map()
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async (key) => {
            if (typeof key === 'string') return { [key]: store.get(key) }
            if (Array.isArray(key)) {
              const out = {}
              for (const k of key) out[k] = store.get(k)
              return out
            }
            return Object.fromEntries(store)
          }),
          set: vi.fn(async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v) }),
        },
      },
    }
    globalThis.fetch = vi.fn()
  })

  describe('compareSemver', () => {
    it('returns 0 for equal versions', async () => {
      const { compareSemver } = await import('../modules/config-fetch.js')
      expect(compareSemver('0.9.0', '0.9.0')).toBe(0)
    })
    it('returns 1 for greater', async () => {
      const { compareSemver } = await import('../modules/config-fetch.js')
      expect(compareSemver('0.9.0', '0.8.5')).toBe(1)
      expect(compareSemver('1.0.0', '0.99.99')).toBe(1)
    })
    it('returns -1 for lesser', async () => {
      const { compareSemver } = await import('../modules/config-fetch.js')
      expect(compareSemver('0.8.5', '0.9.0')).toBe(-1)
    })
    it('throws on malformed input', async () => {
      const { compareSemver } = await import('../modules/config-fetch.js')
      expect(() => compareSemver('1.0', '1.0.0')).toThrow(/x\.y\.z/)
      expect(() => compareSemver('1.a.0', '1.0.0')).toThrow(/invalid segment/)
    })
  })

  describe('enforceConfigBeforeExport', () => {
    const makeManifest = (sources) => ({ items: sources.map(s => ({ source: s })) })

    it('pass-through on healthy fresh cache', async () => {
      const { enforceConfigBeforeExport } = await import('../modules/config-fetch.js')
      await chrome.storage.local.set({
        cached_ext_config: {
          config: { min_ext_version: '0.1.0', export_enabled: true, envato_enabled: true, pexels_enabled: true, freepik_enabled: true },
          fetched_at: Date.now(),
        },
      })
      const result = await enforceConfigBeforeExport(makeManifest(['envato']))
      expect(result.ok).toBe(true)
    })

    it('rejects export_disabled_by_config', async () => {
      const { enforceConfigBeforeExport } = await import('../modules/config-fetch.js')
      await chrome.storage.local.set({
        cached_ext_config: {
          config: { min_ext_version: '0.1.0', export_enabled: false, envato_enabled: true, pexels_enabled: true, freepik_enabled: true },
          fetched_at: Date.now(),
        },
      })
      const result = await enforceConfigBeforeExport(makeManifest(['envato']))
      expect(result.ok).toBe(false)
      expect(result.error_code).toBe('export_disabled_by_config')
    })

    it('rejects ext_version_below_min with current + min fields', async () => {
      const { enforceConfigBeforeExport } = await import('../modules/config-fetch.js')
      await chrome.storage.local.set({
        cached_ext_config: {
          config: { min_ext_version: '99.0.0', export_enabled: true, envato_enabled: true, pexels_enabled: true, freepik_enabled: true },
          fetched_at: Date.now(),
        },
      })
      const result = await enforceConfigBeforeExport(makeManifest(['envato']))
      expect(result.ok).toBe(false)
      expect(result.error_code).toBe('ext_version_below_min')
      expect(result.min).toBe('99.0.0')
      expect(result.current).toBeDefined()
    })

    it('rejects envato_disabled_by_config only if envato is in the manifest', async () => {
      const { enforceConfigBeforeExport } = await import('../modules/config-fetch.js')
      await chrome.storage.local.set({
        cached_ext_config: {
          config: { min_ext_version: '0.1.0', export_enabled: true, envato_enabled: false, pexels_enabled: true, freepik_enabled: true },
          fetched_at: Date.now(),
        },
      })
      // Manifest has NO envato — pass.
      let result = await enforceConfigBeforeExport(makeManifest(['pexels']))
      expect(result.ok).toBe(true)
      // Manifest HAS envato — reject.
      result = await enforceConfigBeforeExport(makeManifest(['envato']))
      expect(result.ok).toBe(false)
      expect(result.error_code).toBe('envato_disabled_by_config')
    })

    it('rejects freepik_disabled_by_config only if freepik is in the manifest', async () => {
      const { enforceConfigBeforeExport } = await import('../modules/config-fetch.js')
      await chrome.storage.local.set({
        cached_ext_config: {
          config: { min_ext_version: '0.1.0', export_enabled: true, envato_enabled: true, pexels_enabled: true, freepik_enabled: false },
          fetched_at: Date.now(),
        },
      })
      const result = await enforceConfigBeforeExport(makeManifest(['freepik', 'envato']))
      expect(result.ok).toBe(false)
      expect(result.error_code).toBe('freepik_disabled_by_config')
    })

    it('falls open on no cache + network failure', async () => {
      const { enforceConfigBeforeExport } = await import('../modules/config-fetch.js')
      globalThis.fetch.mockRejectedValueOnce(new Error('offline'))
      const result = await enforceConfigBeforeExport(makeManifest(['envato']))
      expect(result.ok).toBe(true)
      expect(result.reason).toBe('fall_open_no_cache_no_network')
    })

    it('uses stale cache on fetch failure (less bad than fall-open)', async () => {
      const { enforceConfigBeforeExport } = await import('../modules/config-fetch.js')
      await chrome.storage.local.set({
        cached_ext_config: {
          config: { min_ext_version: '0.1.0', export_enabled: false, envato_enabled: true, pexels_enabled: true, freepik_enabled: true },
          fetched_at: Date.now() - 5 * 60 * 1000,  // 5 min old — STALE
        },
      })
      globalThis.fetch.mockRejectedValueOnce(new Error('offline'))
      const result = await enforceConfigBeforeExport(makeManifest(['envato']))
      // Stale cache says export_enabled=false — trust it, don't fall open.
      expect(result.ok).toBe(false)
      expect(result.error_code).toBe('export_disabled_by_config')
    })

    it('awaits in-flight refresh when one is pending', async () => {
      const mod = await import('../modules/config-fetch.js')
      // Kick off a slow refresh.
      let resolveFetch
      globalThis.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveFetch = () => resolve({ ok: true, json: async () => ({ min_ext_version: '0.1.0', export_enabled: true, envato_enabled: true, pexels_enabled: true, freepik_enabled: true }) }) }))
      const refreshPromise = mod.refreshConfigOnStartup()
      // Enforcement awaits the refresh.
      const enforcePromise = mod.enforceConfigBeforeExport({ items: [{ source: 'envato' }] })
      // Resolve the refresh NOW.
      resolveFetch()
      await refreshPromise
      const result = await enforcePromise
      expect(result.ok).toBe(true)
    })
  })
  ```
- [ ] **Step 8.3: Run the tests.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  npm run test -- --run extension/__tests__/config-fetch.test.js 2>&1 | tail -30
  # Expect 10+ passing
  ```
- [ ] **Step 8.4: Full suite green.**
  ```bash
  npm run test 2>&1 | tail -10
  # Expect 96 baseline + new (106+/106+)
  ```
- [ ] **Step 8.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/__tests__/config-fetch.test.js
  git commit -m "$(cat <<'EOF'
  test(extension): config-fetch — compareSemver + enforce gates + fall-open

  Adds ~10 unit tests:
    compareSemver:
      - equal / greater / lesser
      - throws on malformed input (non-x.y.z, non-numeric segment)
    enforceConfigBeforeExport (mocked chrome.storage.local + fetch):
      - healthy fresh cache → pass
      - export_enabled=false → export_disabled_by_config
      - EXT_VERSION < min → ext_version_below_min with current + min
      - envato_enabled=false only rejects if envato is in manifest
      - freepik_enabled=false rejects when freepik is in manifest
      - no cache + fetch failure → fall_open_no_cache_no_network
      - stale cache + fetch failure → use stale (even to reject)
      - in-flight refresh awaited by enforce (race safety)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 9: `extension-test.html` — Ext.9 Config fieldset

**Files:** `extension-test.html` (at repo root).

- [ ] **Step 9.1: Add the fieldset near the Ext.8 diagnostics fieldset.**
  ```html
  <fieldset>
    <legend>Ext.9 — Config (feature flags)</legend>
    <button id="btn-fetch-config">Fetch config now</button>
    <button id="btn-show-cached-config">Show cached config</button>
    <button id="btn-simulate-disabled">Simulate export_enabled=false</button>
    <pre id="config-result"></pre>
  </fieldset>
  ```
- [ ] **Step 9.2: Add the click handlers.** Append to the existing `<script>` in `extension-test.html`:
  ```javascript
  const configResult = document.getElementById('config-result')
  document.getElementById('btn-fetch-config').addEventListener('click', async () => {
    const res = await sendMessage({ type: 'debug_fetch_config' })
    configResult.textContent = JSON.stringify(res, null, 2)
  })
  document.getElementById('btn-show-cached-config').addEventListener('click', async () => {
    const res = await sendMessage({ type: 'debug_get_cached_config' })
    configResult.textContent = JSON.stringify(res, null, 2)
  })
  document.getElementById('btn-simulate-disabled').addEventListener('click', async () => {
    const res = await sendMessage({
      type: 'debug_set_cached_config',
      config: {
        min_ext_version: '0.1.0',
        export_enabled: false,
        envato_enabled: true,
        pexels_enabled: true,
        freepik_enabled: true,
        daily_cap_override: null,
        slack_alerts_enabled: true,
      },
      fetched_at: Date.now(),
    })
    configResult.textContent = JSON.stringify(res, null, 2)
  })
  ```
  **Executor note:** Match `sendMessage` signature to existing usage in the file. If it's `chrome.runtime.sendMessage(EXT_ID, ...)`, mirror that call convention for the three new buttons.
- [ ] **Step 9.3: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  grep -n "Ext.9 — Config\|btn-fetch-config\|btn-simulate-disabled" extension-test.html
  # Expect three hits.
  ```
- [ ] **Step 9.4: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension-test.html
  git commit -m "$(cat <<'EOF'
  chore(extension-test): Ext.9 Config fieldset

  Three buttons:
    - Fetch config now → debug_fetch_config
    - Show cached config → debug_get_cached_config
    - Simulate export_enabled=false → debug_set_cached_config with
      a canned payload (lets us verify popup + enforcement without
      flipping the backend env var)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 10: README — Ext.9 section

**Files:** `extension/README.md`.

- [ ] **Step 10.1: Append a new section at the end of the file.**
  ```markdown
  ## Ext.9 — Feature flag fetch

  The extension consumes `GET /api/ext-config` (Backend 1.5, public
  endpoint) on service-worker boot and before every `{type:"export"}`
  message. Response shape:

  ```jsonc
  {
    "min_ext_version":       "0.1.0",
    "export_enabled":        true,
    "envato_enabled":        true,
    "pexels_enabled":        true,
    "freepik_enabled":       false,
    "daily_cap_override":    null,
    "slack_alerts_enabled":  true
  }
  ```

  ### Cache TTL

  Successful fetches are persisted to
  `chrome.storage.local.cached_ext_config` with a `fetched_at`
  timestamp. The 60-second TTL mirrors the server's
  `Cache-Control: public, max-age=60` header — within 60s, reads
  trust the cache; past 60s, reads try a refresh and fall back to
  the stale value if the refresh fails.

  ### Semver gate

  `EXT_VERSION` (from `config.js`) is compared against
  `min_ext_version` (from the server) using a hand-rolled `x.y.z`
  comparator. If `EXT_VERSION < min_ext_version`, the export is
  rejected with `ext_version_below_min`, and the popup surfaces an
  "Update required" banner.

  ### Per-source kill switches

  `envato_enabled` / `pexels_enabled` / `freepik_enabled` gate
  NEW exports only. A running queue is immune — kill-switch flips
  do NOT retroactively pause in-flight runs. Rejections name the
  source: `envato_disabled_by_config`, `pexels_disabled_by_config`,
  `freepik_disabled_by_config`.

  ### Fall-open behavior

  - **Cache fresh (<60s)** → trust cache.
  - **Cache stale + fetch succeeds** → trust fresh response.
  - **Cache stale + fetch fails** → trust stale (warning logged).
  - **No cache + fetch succeeds** → trust fresh response.
  - **No cache + fetch fails** → FALL OPEN (all flags default true).
    A down backend must never strand users whose download paths
    are otherwise healthy.

  ### Error codes

  The five canonical codes returned by `enforceConfigBeforeExport`:

  | Code                             | Meaning |
  |----------------------------------|---------|
  | `export_disabled_by_config`      | Global `export_enabled=false`. |
  | `ext_version_below_min`          | `EXT_VERSION` < `min_ext_version`. Payload includes `current` + `min`. |
  | `envato_disabled_by_config`      | Envato kill, and envato is in the manifest. |
  | `pexels_disabled_by_config`      | Pexels kill, and pexels is in the manifest. |
  | `freepik_disabled_by_config`     | Freepik kill, and freepik is in the manifest. |

  WebApp.4 keys its "Export disabled" UI off these exact strings —
  do not rename without a coordinated change there.

  ### Debug handlers

  For the `extension-test.html` harness:

  - `debug_fetch_config` — trigger `fetchConfig()` manually.
  - `debug_get_cached_config` — read the current cache record.
  - `debug_set_cached_config` — inject a cache record (for simulating
    `export_enabled=false` without touching the backend env var).

  These are never called from production code.
  ```
- [ ] **Step 10.2: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  grep -n "## Ext.9" extension/README.md
  # one hit at the appended section
  ```
- [ ] **Step 10.3: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext9"
  git add extension/README.md
  git commit -m "$(cat <<'EOF'
  docs(extension): README — Ext.9 feature flag fetch section

  Appended section documenting the /api/ext-config response shape,
  60s TTL (mirrors server Cache-Control), semver gate, per-source
  kill switches (NEW exports only, running queue immune), fall-open
  behavior on no-cache + fetch failure, the five canonical error
  codes that WebApp.4 will key UI off, and the three debug_*
  handlers exposed for the extension-test harness.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 11: Manual smoke (NO COMMIT)

**Files:** none (manual verification only).

This is the confidence check before merge. Do NOT commit anything.

- [ ] **Step 11.1: Load the unpacked extension.** `chrome://extensions` → Reload → confirm version reads `0.9.0`.
- [ ] **Step 11.2: Open `extension-test.html` → click "Fetch config now".** Observe the JSON response in the `<pre>` — verify it includes the expected seven fields.
- [ ] **Step 11.3: Open popup.** No banner should be visible (default config is all-healthy). Sources list / auth rows render normally.
- [ ] **Step 11.4: Simulate `export_enabled=false`.** Click "Simulate export_enabled=false" in the test page. Reopen the popup. Observe:
  - Red banner "Export temporarily disabled — Check transcript-eval.com for status."
  - No other row state changes.
- [ ] **Step 11.5: Flip `EXT_FREEPIK_ENABLED=false` on the backend.** Ask the user to restart the backend (NEVER kill `:3001` yourself). Reload the extension.
- [ ] **Step 11.6: Trigger a manifest with a Freepik item.** Use the web app or `extension-test.html`'s `debug_source_one_shot` → `debug_source_one_shot` path is single-item only and does not hit the gate; instead, dispatch a full `{type:"export"}` with a multi-item manifest that includes a Freepik item. Observe the SW console:
  - `[config-fetch]` log showing the fresh response landed.
  - `{ok: false, error_code: 'freepik_disabled_by_config', detail: 'Freepik downloads paused by transcript-eval'}` in the response payload.
- [ ] **Step 11.7: Flip `EXT_FREEPIK_ENABLED=true` (or unset) + restart backend.** Verify a fresh export succeeds.
- [ ] **Step 11.8: Fall-open smoke (harder — requires a temporary backend stop or endpoint block).**
  - Ask the user to stop the `/api/ext-config` route temporarily (e.g., comment out the route mount; NEVER kill `:3001`).
  - Clear the extension's `cached_ext_config` via `extension-test.html` (you may need a fourth "Clear cache" button — skip this step if it adds too much scope; the test coverage already proves fall-open works).
  - Reload the extension.
  - Trigger an export. Observe a successful gate-pass with a `console.warn('[config-fetch] FALL-OPEN: ...')` in the SW console.
- [ ] **Step 11.9: Confirm no regressions.** Run a real 3-item export (envato + pexels). Every item completes. No config-related warnings for healthy runs.
- [ ] **Step 11.10: Leave smoke artifacts uncommitted.** No git changes this task. Record the smoke output (fall-open log line + healthy-run timestamps) in the task tracker / PR description.

---

## Cross-phase notes

- **Daily-cap override is pass-through only.** `daily_cap_override` is cached + returned by `enforceConfigBeforeExport` via `effective_config`, but Ext.7's `classifier.js` still reads the compile-time `DAILY_CAP_HARD_STOP_AT`. A future 2-line PR plumbs the override in: read from cache before enforcing the cap. Flagged for the Week 5+ backlog.
- **WebApp.4 (Wave 3, parallel with Ext.9) will surface the five error codes.** WebApp.4's State F or a new "Export disabled" card reads the payload shape `{ok: false, error_code, detail, current?, min?}` and renders matching UI. Any rename to the codes (Task 1's `CONFIG_ERROR_CODES`) requires a coordinated WebApp.4 change.
- **Ext.10 packaging.** When the CI build lands, the `EXT_VERSION` bump in `config.js` and the `version` bump in `manifest.json` should be consolidated behind a build-step (`EXT.10`'s scripted package step) so they can't drift. For now, manual sync — the Task 1 commit touches both.
- **Ext.11 canary channel.** Will add a `channel: "canary"` query parameter to the `EXT_CONFIG_ENDPOINT` and a second Web Store listing. Ext.9's cache format already accommodates this (config is opaque to the extension).
- **Ext.12 cohort gating.** Will pass `user_id` as a query parameter to `/api/ext-config` and have the server return a cohort-specific config. Ext.9's `fetchConfig()` is the site to plumb the `user_id` in; the current no-auth design is intentional — cohort gating is opt-in per request.
- **Spec anchor.** This plan implements the spec's § "Runtime feature flags" (approximately lines 621-638 of `docs/specs/2026-04-23-envato-export-extension.md`) and the roadmap's § "Ext.9 — Feature flag fetch" (lines 362-380 of `docs/specs/2026-04-24-export-remaining-roadmap.md`). Any deviation from those anchors is flagged in this plan's § Scope or § Deferred.
