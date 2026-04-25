# Phase 1.5 — /api/ext-config Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single new public HTTP endpoint `GET /api/ext-config` that returns a JSON config the Chrome extension fetches at service-worker startup and before each export. Lets us turn off features (Envato / Pexels / Freepik / overall export / Slack alerts) and bump the minimum extension version without republishing the extension to the Chrome Web Store. No DB writes, no auth, no per-user cohorts — just env-var-backed flags read on every request.

**Architecture:** One new Express router `server/routes/ext-config.js` with one handler, backed by one new service `server/services/ext-config.js` that reads env vars at request time and returns the config object. Mounted in `server/index.js` at `/api/ext-config` alongside the existing routers. Adds one runtime dep (`semver`, ~50 KB) for `min_ext_version` validation — same package the extension itself uses for the comparison, so we share the parsing semantics.

**Tech Stack:** Node 20 + Express 5 (already in repo) + `semver` ^7 (new dep). ES modules, no TypeScript. Verification is curl smoke, matching Phase 1's pattern — no test framework added.

**Working directory note:** The project path contains a trailing space: `/Users/laurynas/Desktop/one last /transcript-eval/`. Quote every path. Examples in this plan use the shell variable `TE` set at the top of each task.

---

## Why read this before touching code

This endpoint has a few load-bearing invariants that shape every decision below — get any of them wrong and the extension breaks in production.

1. **Public, no auth.** The extension hits `/api/ext-config` from its service worker BEFORE the JWT mint flow runs. There is no `Authorization` header to validate. The route is mounted ahead of the auth middleware path; it never calls `requireAuth`. A malicious actor learns the names of our feature flags — that's the entire blast radius, and it's acceptable.

2. **`Cache-Control: public, max-age=60`.** Service workers are aggressive callers. With 60s caching at the proxy/CDN layer, a flag flip propagates within ~1 minute (acceptable for a kill-switch). Without it, the extension would refetch on every export start and we'd burn Railway egress.

3. **Falls open, never closed.** Every env var has a default that ships features ON (`true`), except `freepik_enabled` which ships OFF until Ext.3 is verified. If the env var is unset OR malformed, we use the default — we do NOT 5xx. The extension treats a 5xx as "config unavailable" and falls back to its baked-in defaults (which match these defaults). Two layers of fall-open safety.

4. **`min_ext_version` MUST be valid semver.** It's the kill-switch for forcing extension updates. The service validates it with `semver.valid(...)` at module load — if `EXT_MIN_VERSION` is set but malformed, the server fails to start. Loud failure on boot is better than silent defaults in production.

5. **Env-var pattern, no DB.** Phase 1.5 deliberately stays env-only. No `ext_config` table, no admin UI, no per-user cohorts. Flipping a flag is a Railway env-var change + restart — same cost as flipping any other flag in this codebase. DB-backed overrides are an explicit later-phase concern (see Deferred below).

If you find yourself adding auth, persistence, or anything fancier — stop and re-read the roadmap section linked in Self-review.

---

## Scope (Phase 1.5 only — hold the line)

### In scope

- `server/routes/ext-config.js` — single `GET /api/ext-config` handler, returns the config object as JSON, sets `Cache-Control: public, max-age=60`.
- `server/services/ext-config.js` — `getExtConfig()` reads the seven env vars, applies defaults, returns the object. Module-load-time validation of `EXT_MIN_VERSION` via `semver.valid`. Small `parseBool(value, default)` helper.
- `server/index.js` — one `import` line and one `app.use('/api/ext-config', extConfigRouter)` line.
- `package.json` — add `semver: ^7.6.0` to `dependencies`.
- `.env.example` — create (file does not exist yet) and document the seven new `EXT_*` env vars with their defaults.

### Deferred (DO NOT add in Phase 1.5 — they belong to later phases)

- **DB-backed overrides** — no `ext_config` table, no `INSERT` / `UPDATE` paths, no `server/db.js` migration. The roadmap explicitly says "optional, only if we want env-var overrides via DB. Defer until an actual need surfaces." That need has not surfaced.
- **Per-user cohorts** — no `?user_id=...` query param, no JWT decoding, no Supabase lookup. Every caller gets the same config in Phase 1.5. A/B / canary cohorts are an Ext.12+ concern.
- **Signed config payload** — no HMAC, no JWT-wrapping of the response. The extension trusts the response over TLS. Signing is a Phase 10+ hardening item.
- **Admin UI for flipping flags** — no React page, no `POST /api/admin/ext-config`. Operators flip flags by editing Railway env vars and restarting the service.
- **Audit log of flag flips** — out of scope. Railway already logs env-var changes.
- **Slack notification on flag change** — out of scope (operator will know — they triggered the change).
- **Min-version *recommended* (soft) gate** — only `min_ext_version` (hard floor) ships in 1.5. Soft "please update" UX is an Ext.9 extension-side concern, not a backend concern.
- **Freepik daily-cap remote control** — `daily_cap_override` ships as a passthrough int field but the extension's enforcement of it lands in Ext.5. Backend in 1.5 only returns the value.

Fight the urge to "just add" any of the above. Phase 1.5 is the smallest slice that unblocks Ext.9 (extension-side feature-flag fetch). Ship that, get out.

---

## Prerequisites

- Node 20+ (already used by transcript-eval).
- The repo's existing `npm run dev:server` works on port 3001. Do NOT kill any running process on port 3001 — that's the user's backend dev server.
- No DB connectivity required for Phase 1.5 (the service does not read from Postgres).
- `curl` and `jq` for verification.

Note: Path to the repo has a trailing space in "one last " — quote every path.

---

## File structure (Phase 1.5 final state)

All paths are inside the transcript-eval repo root (which I'll call `$TE`).

```
$TE/server/
├── index.js                          MODIFIED — +1 import, +1 app.use()
├── routes/
│   └── ext-config.js                 NEW — single GET handler, sets Cache-Control
└── services/
    └── ext-config.js                 NEW — getExtConfig() + parseBool() + module-load semver check

$TE/.env.example                      NEW — documents the 7 new EXT_* env vars + defaults
$TE/package.json                      MODIFIED — adds "semver": "^7.6.0" under dependencies
$TE/package-lock.json                 MODIFIED — updated by `npm install semver`
```

Why this split:
- `routes/ext-config.js` is HTTP-only — it owns the response shape, status code, and headers. No business logic, so it can stay tiny (~25 LOC).
- `services/ext-config.js` is the only file that touches `process.env.EXT_*`. Concentrating env reads in one file means future Phase 9+ work (DB-backed overrides) just rewrites this single function.
- Module-load-time validation lives in `services/ext-config.js` so it runs the moment `server/index.js` imports the router (which imports the service). A bad `EXT_MIN_VERSION` crashes the server before it accepts a single request.
- `.env.example` is the doc artifact; it doesn't affect runtime. It exists so a fresh clone can `cp .env.example .env` and discover the new flags.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/ext-config-phase-1-5` on branch `feature/envato-export-phase1-5-ext-config`, branched off `main`. (NOT off `feature/envato-export-phase1` — the roadmap calls this slice "additive and independently mergeable." If Phase 1 has merged, branch off main; if Phase 1 is still in flight, still branch off main — this slice does not depend on the new exports/export_events tables.)
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan. Task N includes an explicit reminder.
- **Never kill processes on port 3001.** That's the user's backend. If you start a server for verification, do it inside the worktree directory and let it bind to 3001 only AFTER confirming the user's instance is stopped — or use a different port for the verification run.
- **Commit style:** conventional commits (`feat(api): ...`, `chore(api): ...`, `feat(deps): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing.

---

## Task 0: Create worktree + branch

**Files:**
- Create: `$TE/.worktrees/ext-config-phase-1-5/` (worktree)

- [ ] **Step 1: Confirm `main` is fetched and create the worktree**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin main
git worktree add -b feature/envato-export-phase1-5-ext-config .worktrees/ext-config-phase-1-5 main
cd ".worktrees/ext-config-phase-1-5"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/ext-config-phase-1-5
git status
# Expected: "On branch feature/envato-export-phase1-5-ext-config; nothing to commit, working tree clean"
```

- [ ] **Step 2: Verify you are on the new branch before any file changes**

```bash
git branch --show-current
# Expected: feature/envato-export-phase1-5-ext-config
```

If this prints anything else, STOP and fix — don't write files into the wrong branch.

- [ ] **Step 3: No commit yet**

This task creates a worktree only — no files have changed. `git status` should still report a clean tree. Subsequent tasks add files and commit them.

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

---

## Task 1: Add `semver` dependency

The service uses `semver.valid(...)` at module load to fail fast on a malformed `EXT_MIN_VERSION`. The extension (Ext.9) will use the same package to compare its own `EXT_VERSION` against `min_ext_version` — installing it in the backend repo now keeps both halves on the same parser.

**Files:**
- Modify: `$TE/.worktrees/ext-config-phase-1-5/package.json`
- Modify: `$TE/.worktrees/ext-config-phase-1-5/package-lock.json` (auto by npm)

- [ ] **Step 1: Install semver as a runtime dep**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/ext-config-phase-1-5"
npm install semver@^7.6.0
```

Expected output ends with something like:
```
added 1 package, and audited <N> packages in <Ns>
```

- [ ] **Step 2: Verify the dep landed in `package.json` under `dependencies` (not `devDependencies`)**

```bash
node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('runtime semver:', p.dependencies?.semver, '| dev semver:', p.devDependencies?.semver)"
# Expected: runtime semver: ^7.6.0 | dev semver: undefined
```

If it landed in `devDependencies`, run `npm uninstall semver && npm install semver@^7.6.0 --save` (no `--save-dev`).

- [ ] **Step 3: Verify it imports cleanly from the runtime**

```bash
node -e "import('semver').then(m => console.log('semver.valid(\"0.1.0\") =', m.default.valid('0.1.0')))"
# Expected: semver.valid("0.1.0") = 0.1.0
node -e "import('semver').then(m => console.log('semver.valid(\"not-a-version\") =', m.default.valid('not-a-version')))"
# Expected: semver.valid("not-a-version") = null
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git status --short
# Expected: M package.json, M package-lock.json (no other changes)
git commit -m "$(cat <<'EOF'
feat(deps): add semver ^7.6.0 for ext-config min-version validation

Used by server/services/ext-config.js (next commit) to validate
EXT_MIN_VERSION at module load — malformed semver crashes boot
rather than silently defaulting in production.

Same package the extension itself uses for the client-side comparison
in Ext.9, so we share parsing semantics across both halves of the
feature.

Tiny dep (~50KB), zero transitive runtime deps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -1
# Expected: <sha> feat(deps): add semver ^7.6.0 for ext-config min-version validation
```

---

## Task 2: Service — `server/services/ext-config.js`

The service is the only file that touches `process.env.EXT_*`. It exports `getExtConfig()` (the public entry) and a tiny `parseBool` helper. At module load it asserts that `EXT_MIN_VERSION` (if set) is valid semver — the import in Task 3 will trigger this check before the route is ever hit.

**Files:**
- Create: `$TE/.worktrees/ext-config-phase-1-5/server/services/ext-config.js`

- [ ] **Step 1: Write `server/services/ext-config.js`**

Exact contents (no trailing whitespace; final newline):

```javascript
import semver from 'semver'

// Defaults — what the extension would receive if every EXT_* env var
// were unset. These match the defaults baked into the extension itself
// (Ext.9), so a 5xx from this endpoint produces the same behavior as a
// healthy "everything-on" response.
const DEFAULTS = Object.freeze({
  min_ext_version:      '0.1.0',
  export_enabled:       true,
  envato_enabled:       true,
  pexels_enabled:       true,
  freepik_enabled:      false,   // ships off until Ext.3 is verified end-to-end
  daily_cap_override:   null,
  slack_alerts_enabled: true,
})

// Module-load assertion: if EXT_MIN_VERSION is set, it must be valid
// semver. Loud failure on boot beats silent default in production.
const RAW_MIN_VERSION = process.env.EXT_MIN_VERSION
if (RAW_MIN_VERSION !== undefined && semver.valid(RAW_MIN_VERSION) === null) {
  throw new Error(
    `[ext-config] EXT_MIN_VERSION is set to "${RAW_MIN_VERSION}" but is not a valid semver string. ` +
    `Set it to something like "0.1.0" or unset it to use the default "${DEFAULTS.min_ext_version}".`
  )
}

// 'true'/'1' → true; 'false'/'0' → false; anything else (incl. undefined,
// empty string, garbage) → fallback. Case-insensitive.
export function parseBool(value, fallback) {
  if (value === undefined || value === null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return fallback
}

// Parse EXT_DAILY_CAP_OVERRIDE → integer | null. Unset → null.
// Non-integer / non-positive → null (with a console.warn so the
// operator notices in Railway logs).
function parseDailyCapOverride(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || String(n) !== String(raw).trim() || n < 0) {
    console.warn(`[ext-config] EXT_DAILY_CAP_OVERRIDE="${raw}" is not a non-negative integer; treating as null`)
    return null
  }
  return n
}

// Read env vars on every call (NOT cached) so flag flips via Railway's
// "edit variable + restart" land immediately on the next request.
// process.env reads are O(1); no measurable overhead.
export function getExtConfig() {
  const minVersion = process.env.EXT_MIN_VERSION || DEFAULTS.min_ext_version

  return {
    min_ext_version:      minVersion,
    export_enabled:       parseBool(process.env.EXT_EXPORT_ENABLED,        DEFAULTS.export_enabled),
    envato_enabled:       parseBool(process.env.EXT_ENVATO_ENABLED,        DEFAULTS.envato_enabled),
    pexels_enabled:       parseBool(process.env.EXT_PEXELS_ENABLED,        DEFAULTS.pexels_enabled),
    freepik_enabled:      parseBool(process.env.EXT_FREEPIK_ENABLED,       DEFAULTS.freepik_enabled),
    daily_cap_override:   parseDailyCapOverride(process.env.EXT_DAILY_CAP_OVERRIDE),
    slack_alerts_enabled: parseBool(process.env.EXT_SLACK_ALERTS_ENABLED,  DEFAULTS.slack_alerts_enabled),
  }
}

// Exported for tests / future admin tooling. Consumers should NOT
// mutate the returned object.
export { DEFAULTS }
```

Why these specific decisions:
- **Frozen `DEFAULTS`** — accidental mutation would silently change every subsequent response.
- **Module-load `throw`** — a malformed `EXT_MIN_VERSION` is an operator error; it should abort `npm start` before Railway marks the service "live." `if (RAW_MIN_VERSION !== undefined)` lets the unset case fall through to the default.
- **Read env on every call** — operators expect "set var → restart → next request reflects it." Caching at the process level would require a server restart for caching to "expire," which is the same as no caching. Skip the complication.
- **`String(n) !== String(raw).trim()`** — catches `"42abc"` (which `parseInt` happily returns `42` for) and `"3.14"` (returns `3`). The override is an integer count of downloads; partial parses are operator errors worth warning about.
- **`console.warn` on bad daily-cap** — falls open (returns `null` so the extension uses its baked default) but surfaces the misconfig in Railway logs. Same belt-and-suspenders shape as the rest of the codebase.

- [ ] **Step 2: Verify module loads without throwing under defaults**

```bash
node -e "import('./server/services/ext-config.js').then(m => console.log(m.getExtConfig()))"
```

Expected output (object key order may differ):
```
{
  min_ext_version: '0.1.0',
  export_enabled: true,
  envato_enabled: true,
  pexels_enabled: true,
  freepik_enabled: false,
  daily_cap_override: null,
  slack_alerts_enabled: true
}
```

- [ ] **Step 3: Verify module crashes on a malformed `EXT_MIN_VERSION`**

```bash
EXT_MIN_VERSION="not-a-version" node -e "import('./server/services/ext-config.js').catch(e => { console.log('CAUGHT:', e.message); process.exit(0) })"
# Expected: CAUGHT: [ext-config] EXT_MIN_VERSION is set to "not-a-version" but is not a valid semver string. Set it to something like "0.1.0" or unset it to use the default "0.1.0".
```

The dynamic import surfaces the throw via the `.catch`. If you see `[ext-config] EXT_MIN_VERSION ...` printed, validation works.

- [ ] **Step 4: Verify env-driven overrides work**

```bash
EXT_FREEPIK_ENABLED=true EXT_DAILY_CAP_OVERRIDE=750 node -e "import('./server/services/ext-config.js').then(m => { const c = m.getExtConfig(); console.log('freepik:', c.freepik_enabled, '| cap:', c.daily_cap_override) })"
# Expected: freepik: true | cap: 750

EXT_DAILY_CAP_OVERRIDE="not-an-int" node -e "import('./server/services/ext-config.js').then(m => { const c = m.getExtConfig(); console.log('cap:', c.daily_cap_override) })"
# Expected (warning to stderr is fine):
# [ext-config] EXT_DAILY_CAP_OVERRIDE="not-an-int" is not a non-negative integer; treating as null
# cap: null

EXT_PEXELS_ENABLED=0 node -e "import('./server/services/ext-config.js').then(m => console.log('pexels:', m.getExtConfig().pexels_enabled))"
# Expected: pexels: false
```

- [ ] **Step 5: Commit**

```bash
git add server/services/ext-config.js
git status --short
# Expected: A server/services/ext-config.js (no other changes)
git commit -m "$(cat <<'EOF'
feat(api): ext-config service — env-backed feature flags

getExtConfig() reads EXT_* env vars on every call and returns the
config object the Chrome extension consumes. Defaults are frozen
and ship features ON (except freepik, which stays off until Ext.3
is verified end-to-end).

EXT_MIN_VERSION is validated as semver at module load; a malformed
value crashes boot rather than silently defaulting in production.

EXT_DAILY_CAP_OVERRIDE accepts a non-negative integer; anything else
falls open to null with a console.warn so misconfig surfaces in
Railway logs.

parseBool helper handles 'true'/'1'/'false'/'0' (case-insensitive);
anything else falls back to the default.

No DB writes, no auth — endpoint wiring lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Route — `server/routes/ext-config.js`

Single GET handler. No auth. Sets `Cache-Control: public, max-age=60`. Calls `getExtConfig()` and returns the result as JSON. The catch-all error handler in `server/index.js` covers any throw — but `getExtConfig()` is synchronous and only throws on operator misconfig (which happens at module load, not at request time), so in practice this handler never errors after the server has started.

**Files:**
- Create: `$TE/.worktrees/ext-config-phase-1-5/server/routes/ext-config.js`

- [ ] **Step 1: Write `server/routes/ext-config.js`**

Exact contents:

```javascript
import { Router } from 'express'
import { getExtConfig } from '../services/ext-config.js'

const router = Router()

// GET /api/ext-config
//
// Public endpoint — no auth. The Chrome extension hits this at
// service-worker startup AND before each export, BEFORE its JWT mint
// flow runs. There is no Authorization header to validate.
//
// Response is a snapshot of the EXT_* env vars (with defaults applied
// for unset vars). Cache-Control: public, max-age=60 gives operators
// a ~60s propagation window on flag flips and protects us from SW
// hot-loops if the extension ever ends up calling this in a tight
// loop.
//
// Falls open: if anything throws here (it shouldn't — getExtConfig is
// synchronous and only validates at module load), the global error
// handler in server/index.js returns 500 and the extension falls back
// to its baked-in defaults (which match this module's DEFAULTS).
router.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60')
  res.json(getExtConfig())
})

export default router
```

Why these choices:
- **Mounted at `/api/ext-config`** (in Task 4) so the handler at path `/` corresponds to `GET /api/ext-config`. Matches the existing router pattern in `server/routes/pexels.js`.
- **No `requireAuth`** — public endpoint per spec.
- **`res.set` before `res.json`** — `res.json` sends headers + body. Headers must be set first.
- **No try/catch** — `getExtConfig()` is synchronous + non-throwing post-startup. The global error handler in `server/index.js` (line 65-70) catches anything that does manage to throw and returns 500.

- [ ] **Step 2: Verify the file parses as valid JS**

```bash
node --check server/routes/ext-config.js
# Expected: no output; exit 0
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/ext-config.js
git status --short
# Expected: A server/routes/ext-config.js (no other changes)
git commit -m "$(cat <<'EOF'
feat(api): ext-config route — GET /api/ext-config

Single public GET handler that returns the result of getExtConfig()
as JSON with Cache-Control: public, max-age=60.

No auth — extension hits this BEFORE its JWT mint runs, so there's
no Authorization header to check.

Wiring into server/index.js lands in the next commit; this commit
adds only the route module so the diff stays small and reviewable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire the router into `server/index.js`

Two-line change: one `import`, one `app.use`. Mount it alongside the existing routers (after the last `app.use('/api/...')` line, before the `/api/health` handler — preserves the "all `/api/*` routers grouped together" convention).

**Files:**
- Modify: `$TE/.worktrees/ext-config-phase-1-5/server/index.js`

- [ ] **Step 1: Re-read the current import block + mount block**

```bash
sed -n '1,16p' server/index.js
# Expected: 16 import lines including pexelsRouter, gpuRouter
sed -n '46,56p' server/index.js
# Expected: 10 app.use lines for /api/videos, /api/strategies, ..., /api/gpu
```

- [ ] **Step 2: Add the import line**

Use the Edit tool (NOT sed). Anchor on the existing `gpuRouter` import line so the insertion is unambiguous:

- `old_string`:
  ```
  import gpuRouter from './routes/gpu.js'
  import { attachAuth, hasServerAuthConfig } from './auth.js'
  ```
- `new_string`:
  ```
  import gpuRouter from './routes/gpu.js'
  import extConfigRouter from './routes/ext-config.js'
  import { attachAuth, hasServerAuthConfig } from './auth.js'
  ```

- [ ] **Step 3: Add the `app.use` mount line**

Use the Edit tool. Anchor on the existing `gpuRouter` mount line:

- `old_string`:
  ```
  app.use('/api/gpu', gpuRouter)

  const APP_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || process.env.RENDER_GIT_COMMIT?.slice(0, 7) || 'dev'
  ```
- `new_string`:
  ```
  app.use('/api/gpu', gpuRouter)
  app.use('/api/ext-config', extConfigRouter)

  const APP_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || process.env.RENDER_GIT_COMMIT?.slice(0, 7) || 'dev'
  ```

- [ ] **Step 4: Verify the file still parses and the diff is exactly +2 lines**

```bash
node --check server/index.js
# Expected: no output; exit 0
git diff server/index.js
```

Expected `git diff` (2 added lines, no removed lines):
```
+import extConfigRouter from './routes/ext-config.js'
...
+app.use('/api/ext-config', extConfigRouter)
```

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git status --short
# Expected: M server/index.js (no other changes)
git commit -m "$(cat <<'EOF'
feat(api): mount /api/ext-config router

Adds the import + app.use() pair alongside the existing API routers.
Order is intentional: /api/ext-config is mounted after /api/gpu (the
last existing router) and before /api/health, preserving the "all
/api/* routers grouped together" convention.

Module-load semver validation in services/ext-config.js means a
malformed EXT_MIN_VERSION env var will crash this server at startup —
that's the desired behavior for a kill-switch endpoint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Document env vars in `.env.example`

`.env.example` does not currently exist in this repo (verified during planning — only `.env` is present and is gitignored). Create it with the seven new `EXT_*` vars, with comments documenting each default. This is the discoverability artifact for fresh clones.

**Files:**
- Create: `$TE/.worktrees/ext-config-phase-1-5/.env.example`

- [ ] **Step 1: Confirm `.env.example` does NOT already exist**

```bash
ls -la .env.example 2>&1 | head -1
# Expected: ls: .env.example: No such file or directory
```

If it DOES exist (Phase 1 may have created it in parallel), do NOT overwrite — instead append the new section at the bottom and adjust the commit message accordingly.

- [ ] **Step 2: Write `.env.example`**

Exact contents:

```
# transcript-eval — example environment file
#
# Copy to .env and fill in real values for local dev. .env is gitignored;
# .env.example is committed so a fresh clone can discover required vars.
#
# Production values live in Railway env vars (per Railway deploy docs).
# Updating Railway requires a service restart for the new value to take
# effect — there is no in-process cache to invalidate.

# ----------------------------------------------------------------------
# /api/ext-config — Chrome extension feature flags (Phase 1.5)
#
# All EXT_* vars are OPTIONAL. Defaults shown in the comment to the right
# of each line. The extension treats this entire endpoint as fall-open:
# if the request fails, it uses the same defaults baked into its own code.
#
# To flip a flag in prod: edit the var in Railway, restart the service.
# Propagation to extensions is bounded by Cache-Control: public, max-age=60
# on the response (~60s worst case).
# ----------------------------------------------------------------------

# Minimum extension version users must run. MUST parse as semver.
# Server REFUSES TO BOOT if set to a non-semver string.
# Bump this to force-update users when shipping a breaking ext release.
EXT_MIN_VERSION=0.1.0

# Master kill-switch for the entire export feature. false → extension
# popup shows "Export temporarily disabled — check transcript-eval.com
# for status." Use during incidents.
EXT_EXPORT_ENABLED=true

# Per-source kill switches. Set false if a source's upstream is broken
# (e.g. Envato signed-URL changes, Freepik 503 storm).
EXT_ENVATO_ENABLED=true
EXT_PEXELS_ENABLED=true
EXT_FREEPIK_ENABLED=false

# Override the extension's baked-in 500-per-day per-source cap.
# Unset (or empty) → null → extension uses its baked default.
# Set to a non-negative integer to override (e.g. 100 to clamp during
# an incident, 1000 to relax for a power user).
# EXT_DAILY_CAP_OVERRIDE=

# Toggle Slack alerts for export incidents (rate-limit floods, session
# expirations, etc). false silences without disabling export.
EXT_SLACK_ALERTS_ENABLED=true
```

- [ ] **Step 3: Verify the file is committed-readable (no BOM, no weird bytes)**

```bash
file .env.example
# Expected: ".env.example: ASCII text" (or "UTF-8 Unicode text")
wc -l .env.example
# Expected: ~40 lines
```

- [ ] **Step 4: Verify .env.example is NOT gitignored (.env IS gitignored, but .env.example must be committed)**

```bash
git check-ignore -v .env.example
# Expected: exit 1 (not ignored). If exit 0, .gitignore matches it — fix the gitignore (or this filename) before committing.
git check-ignore -v .env 2>&1 | head -1
# Expected: a .gitignore line confirming .env IS ignored (e.g. ".gitignore:5:.env\t.env")
```

- [ ] **Step 5: Commit**

```bash
git add .env.example
git status --short
# Expected: A .env.example (no other changes)
git commit -m "$(cat <<'EOF'
chore(api): document EXT_* env vars in .env.example

Creates .env.example (file did not exist previously) with the seven
EXT_* vars consumed by /api/ext-config. Each var is annotated with
its default and the operational reason to flip it.

Notes the load-bearing behaviors:
- EXT_MIN_VERSION must be valid semver (server refuses to boot
  otherwise);
- EXT_DAILY_CAP_OVERRIDE empty/unset → null (extension's baked
  default applies);
- All flags propagate within ~60s thanks to Cache-Control: max-age=60.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Verification — curl smoke (no commit)

This is the Phase 1.5 acceptance gate. Three sub-checks. Do not skip — this is the only verification we have (no test framework).

**Prereq:** The user's existing dev server on port 3001 may or may not be running. For these checks we want to control the env vars passed to the server, so we'll start a dedicated instance from inside the worktree on a different port (3099) to avoid colliding with the user's instance. If port 3099 is taken, pick another free port — the principle is "do not touch port 3001."

- [ ] **Step 1: Start the worktree dev server on port 3099 in the background**

In a terminal that you'll keep open for the duration of Task 6:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/ext-config-phase-1-5"
npm install   # ensure semver is installed in this worktree's node_modules
PORT=3099 node --env-file=.env server/index.js &
SERVER_PID=$!
sleep 1
echo "server pid: $SERVER_PID"
```

Wait ~1 second for boot. Expected log line:
```
Transcript Eval API running on http://localhost:3099
```

If you don't have a `.env` in the worktree, copy yours over OR start without `--env-file` (the endpoint has no required env vars):
```bash
PORT=3099 node server/index.js &
```

- [ ] **Step 2: Sub-check 1 — defaults**

```bash
curl -s http://localhost:3099/api/ext-config | jq
```

Expected output (exact JSON, key order may vary):
```json
{
  "min_ext_version": "0.1.0",
  "export_enabled": true,
  "envato_enabled": true,
  "pexels_enabled": true,
  "freepik_enabled": false,
  "daily_cap_override": null,
  "slack_alerts_enabled": true
}
```

All seven fields present. `freepik_enabled` is `false` (the only `false` in the default set). `daily_cap_override` is `null` (NOT a string, NOT 0).

- [ ] **Step 3: Sub-check 2 — env override flips a flag**

Stop the background server, restart with the override env var:

```bash
kill $SERVER_PID
sleep 1
EXT_FREEPIK_ENABLED=true EXT_DAILY_CAP_OVERRIDE=750 PORT=3099 node server/index.js &
SERVER_PID=$!
sleep 1
curl -s http://localhost:3099/api/ext-config | jq '{freepik_enabled, daily_cap_override}'
```

Expected:
```json
{
  "freepik_enabled": true,
  "daily_cap_override": 750
}
```

If `freepik_enabled` is still `false`, you didn't restart cleanly — the old server PID is still serving on 3099. `lsof -ti:3099 | xargs kill` and rerun.

- [ ] **Step 4: Sub-check 3 — `Cache-Control` header**

```bash
curl -sI http://localhost:3099/api/ext-config | grep -i cache-control
# Expected: Cache-Control: public, max-age=60
```

If the header is missing, the route file did not call `res.set('Cache-Control', ...)` before `res.json(...)`. Go fix Task 3.

- [ ] **Step 5: Sub-check 4 (bonus) — malformed `EXT_MIN_VERSION` crashes boot**

This validates the loud-fail-on-misconfig behavior:

```bash
kill $SERVER_PID
sleep 1
EXT_MIN_VERSION="garbage" PORT=3099 node server/index.js
# Expected: process exits non-zero with the error from services/ext-config.js:
# Error: [ext-config] EXT_MIN_VERSION is set to "garbage" but is not a valid semver string. Set it to something like "0.1.0" or unset it to use the default "0.1.0".
echo "exit=$?"
# Expected: exit=1
```

- [ ] **Step 6: Cleanup — stop the verification server**

```bash
kill $SERVER_PID 2>/dev/null
lsof -ti:3099 | xargs -r kill 2>/dev/null
# Confirm nothing on 3099:
lsof -i:3099
# Expected: no output (port is free)
```

DO NOT touch port 3001 at any point in this task. If the user's dev server is running there, it is unrelated to this verification and must be left alone.

- [ ] **Step 7: Confirm no code changes occurred during verification**

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

If anything is modified (e.g. you edited a file to debug), revert via `git checkout -- <file>` and re-land the change as a proper task. Verification tasks never produce commits.

---

## Task 7: Final branch review (no new commit)

Sanity check that the branch contains exactly the expected commits and exactly the expected file changes — nothing more.

- [ ] **Step 1: Commit log**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/ext-config-phase-1-5"
git log --oneline main..HEAD
```

Expected: 5 commits, in order (oldest first):
1. `feat(deps): add semver ^7.6.0 for ext-config min-version validation`
2. `feat(api): ext-config service — env-backed feature flags`
3. `feat(api): ext-config route — GET /api/ext-config`
4. `feat(api): mount /api/ext-config router`
5. `chore(api): document EXT_* env vars in .env.example`

(Tasks 0 and 6/7 produce no commits — Task 0 only creates a worktree, Tasks 6/7 are verification.)

- [ ] **Step 2: File-level diff**

```bash
git diff main --stat
```

Expected (line counts approximate):
```
 .env.example                    | 40 ++++++++++++++++++++++++++++
 package-lock.json               | <varies — semver + transitive deps>
 package.json                    |  3 ++-
 server/index.js                 |  2 ++
 server/routes/ext-config.js     | 25 +++++++++++++++++
 server/services/ext-config.js   | 60 +++++++++++++++++++++++++++++++++++++++++
 6 files changed, ~130 insertions(+), 1 deletion(-)
```

If `git diff main --stat` shows ANY file outside this list (anything under `src/`, `extension/`, other `server/routes/` files, `docs/`, etc.) — investigate. You may have accidentally edited unrelated files. Revert before finalizing.

- [ ] **Step 3: Confirm the dependency landed correctly in package.json**

```bash
git diff main package.json
```

Expected: `semver` added to `dependencies` block, alphabetically OR at the end (npm's choice — both are fine):
```diff
+    "semver": "^7.6.0",
```

If the diff shows it under `devDependencies`, fix per Task 1 Step 2 and amend... actually, do NOT amend — make a NEW commit fixing it (per the user's "never amend" convention).

- [ ] **Step 4: DO NOT push**

Per user convention: `git push` requires explicit consent. This task's acceptance is "all 5 commits on the local branch, branch ready for review." Surface the branch name + last commit sha to the user; ask before pushing.

```bash
git rev-parse --short HEAD
git branch --show-current
# Output both for the handoff message to the user.
```

The user will decide whether to push, open a PR, or keep iterating.

---

## Self-review against the spec

After completing Tasks 0–7, re-read `docs/specs/2026-04-24-export-remaining-roadmap.md` § "Part A — Backend Phase 1.5" (lines 92-133).

Coverage checklist (each item maps to a roadmap line):

- **Roadmap: "Return a JSON config the extension fetches at SW start + before each export"** → Task 3 ships `GET /api/ext-config` returning JSON. ✓
- **Roadmap: response shape** (`min_ext_version`, `export_enabled`, `envato_enabled`, `pexels_enabled`, `freepik_enabled`, `daily_cap_override`, `slack_alerts_enabled`) → Task 2 service returns exactly these seven fields with defaults matching the roadmap example (`min_ext_version: "0.1.0"`, `freepik_enabled: false`, `daily_cap_override: null`, others `true`). ✓
- **Roadmap: "Public (no auth — extension hits it before JWT mint)"** → Task 3 route does NOT call `requireAuth`; mounted in Task 4 with no auth middleware in front of it. ✓
- **Roadmap: `Cache-Control: public, max-age=60`** → Task 3 sets exactly this header; Task 6 Sub-check 3 verifies. ✓
- **Roadmap: "`min_ext_version` is a string compared via the semver npm package (small dep; justified)"** → Task 1 adds `semver ^7.6.0` to `dependencies`; Task 2 validates `EXT_MIN_VERSION` with `semver.valid()` at module load. ✓
- **Roadmap: "Reads from env vars initially; can evolve to read from a DB table or Supabase remote config later"** → Task 2 reads only from `process.env`; isolated in `services/ext-config.js` so a future DB-backed rewrite touches one file. ✓
- **Roadmap: "Verification: Curl with no auth → 200 + expected JSON. Change an env var (e.g. EXT_FREEPIK_ENABLED=false), restart, curl again → flipped."** → Task 6 Sub-checks 1 and 2 do exactly this. ✓
- **Roadmap: "Files: `server/routes/ext-config.js`, `server/services/ext-config.js`, `server/index.js` wiring"** → All three exist; no extras. ✓
- **Roadmap: "Optional, only if we want env-var overrides via DB. Defer until an actual need surfaces"** → No DB writes in any task; explicitly listed under Deferred. ✓
- **Roadmap: "Target branch: `feature/envato-export-phase1-5-ext-config`, branched off `feature/envato-export-phase1` if Phase 1 hasn't merged yet, otherwise off main"** → Task 0 branches off `main` (per the planning brief — keep the slice independently mergeable). ✓
- **Roadmap: "Estimate: 1 PR, half a day"** → 5 commits across one branch, single PR. ✓

Behavior checklist (load-bearing invariants from "Why read this before touching code"):

- Public endpoint, no auth → ✓
- Cache-Control 60s → ✓
- Falls open (defaults match extension's bakes; bad daily_cap_override → null + warn, not 5xx) → ✓
- Module-load semver validation (loud failure on bad EXT_MIN_VERSION) → ✓
- Env-var-only (no DB) → ✓

Spec items NOT in scope (expected — see Deferred):
- DB-backed overrides → later phase.
- Per-user cohorts → Ext.12+.
- Signed config → Phase 10+.
- Admin UI → not planned.
- Extension-side consumption of these flags → Ext.9 (separate plan).

Open questions resolved by Phase 1.5:
- **OQ2 from extension spec ("`/api/ext-config` in Phase 1.5 vs. deferred")** → resolved: shipped in Phase 1.5 as a thin env-var-backed endpoint, ahead of GA per the spec's "pre-GA it's table stakes" note. ✓

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-backend-ext-config-phase-1-5.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration with two-stage (spec + code) review on each task.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
