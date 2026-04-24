# WebApp.4 — /admin/support Diagnostics UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin operator a stateless, in-browser way to inspect an Ext.8 diagnostic bundle produced by a user's extension. Admin drops a `.zip` into the page; the server parses it, pulls out the four canonical JSON files (`meta.json`, `queue.json`, `events.json`, `environment.json`), and the page renders them side-by-side with the matching `exports` row (if any) from the DB. Main UX spec Phase 10 ("Support diagnostics"). Closes WebApp.4 of the remaining-roadmap; no persistence, no writes, no schema change.

**Architecture:** One new server route under `server/routes/admin/support-bundles.js` — a **stateless** endpoint that accepts a raw `application/zip` body (via `express.raw({ limit: '50mb', type: 'application/zip' })` — middleware added locally on the route, not globally), hands the bytes to a pure parser module at `server/services/bundle-parser.js`, and returns the combined parsed JSON. The parser uses `fflate`'s `unzipSync` (already a runtime dep from Ext.8) — no multipart library added. One new admin page at `src/pages/admin/SupportBundle.jsx` uploads the file via `fetch('/api/admin/support-bundles/parse', { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } })` and renders the four sections + a correlated `exports` row fetched via `apiGet('/admin/exports/<run_id>/events')` (WebApp.3's existing detail endpoint). Router wiring at `src/App.jsx` + one `AdminLayout.jsx` nav entry. Auth reuses `isAdmin(req)` behind `requireAuth + requireAdmin`, identical to WebApp.3.

**Tech stack:** React 19 + React Router v7 (already in `package.json`), Tailwind (already used across `src/components/views/*`), `apiGet` from `src/hooks/useApi.js` (already shipped, Supabase-JWT aware), Express 5 + `fflate` 0.8.2 (already in `dependencies`), vitest 1.6.x with triple-env workspace (`vitest.workspace.js` — `web` happy-dom for the page, `server` node for the route + parser). No new runtime deps. No new dev deps.

---

## Open questions for the user

Flag these BEFORE drafting any file. The executor must wait on your call on each.

1. **Upload size cap.** Recommend **50MB**. Real bundles built by Ext.8 (`schema_version: 1`, capped at 200 events + 24h of queue state) will be well under 1MB; 50MB leaves comfortable headroom for pathological cases (huge deny-lists, accidental event-buffer overflow) without inviting abuse. The cap is enforced by `express.raw({ limit: '50mb' })` — exceeding it returns a 413 (Payload Too Large) from Express itself; the route handler never runs.

2. **Bundle-to-export correlation logic.** Recommend: if `queue.json.runs[*].run_id` contains at least one value, pick **the most recent** (max `updated_at`) and fetch the matching `exports` row via an internal call to WebApp.3's `GET /api/admin/exports/:id/events` endpoint. If zero `run_id`s in the bundle, render "No run IDs in bundle — nothing to correlate." If the chosen `run_id` does not match any `exports.id`, render "No matching export record (run_id `<id>`)." If multiple, show a picker that lets the admin pick which run to correlate (dropdown of the bundle's `run_id`s sorted by `updated_at` desc). Confirm.

3. **fflate import location on the server.** Recommend a pure, side-effect-free parser module at `server/services/bundle-parser.js` that takes `Uint8Array` bytes and returns `{ meta, queue, events, environment }` (or throws `BundleParseError` with an `errorCode`). The route file is a thin wrapper that handles Express plumbing and maps `BundleParseError.errorCode` to the right HTTP status. This matches the existing split between `server/services/exports.js` (pure) and `server/routes/admin/exports.js` (route). Flag if the repo has a different service-layer convention.

4. **Admin auth.** Recommend **reuse `isAdmin(req)`** from `server/auth.js` behind `requireAuth + requireAdmin`, identical to WebApp.3's `server/routes/admin/exports.js`. `isAdmin(req)` already checks `ADMIN_EMAILS` + `app_metadata.role === 'admin'`. Do NOT introduce new auth plumbing.

5. **Multipart vs raw bytes for upload transport.** The repo has `multer` in `dependencies` (package.json), but using `multer` forces us to parse a multipart form just to fish out one file. Recommend **raw bytes via `express.raw({ limit: '50mb', type: 'application/zip' })` applied locally on the route** — cleaner API surface, no form-data ceremony, and the browser sends the `File` object directly as the `fetch` body. `multer` stays unused here. If you prefer multipart (e.g. to let the admin type a free-text "ticket id" alongside the upload), flag it — I'd add that as a follow-up phase, not bolt it onto WebApp.4.

6. **Reuse of WebApp.3's `StatusBadge` / `EventBadge` / `formatTimestamp` helpers.** These are currently inline in `src/pages/admin/ExportDetail.jsx` (lines 16-43). Recommend: **extract them into a tiny shared module** `src/pages/admin/_helpers.jsx` and import from both `ExportDetail.jsx` and `SupportBundle.jsx`. The extraction is a minor refactor (three small pure components/functions, zero behavior change). The alternative — duplicate them inline in `SupportBundle.jsx` — is cheaper but drifts the UI. Confirm.

---

## Why read this before touching code

Eight numbered invariants. Skipping any of them reopens a door the next run will walk through.

**1. Parser is STATELESS — no DB writes, no filesystem side effects, no temp files.** Upload → `fflate.unzipSync(bytes)` in-memory → parse the four JSON files → respond → discard. There is NO `INSERT INTO support_bundles`, NO `fs.writeFile`, NO `os.tmpdir()`. The bundle exists for one request's duration and then GC'd. An executor who adds a `support_bundles` table or writes a file to disk has exceeded scope — stop, flag, and back it out.

**2. `fflate.unzipSync` is synchronous and takes `Uint8Array` bytes.** In Express 5 with `express.raw({ limit: '50mb', type: 'application/zip' })`, `req.body` is a `Buffer`. Convert via `new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength)` — do NOT `req.body.toString()` (would corrupt the ZIP) and do NOT pipe `req` into fflate (it's not a streaming API). The whole payload is buffered in memory before parse — the 50MB cap is the backstop.

**3. Schema v1 is the ONLY supported version.** The Ext.8 bundle carries `meta.schema_version: 1`. If the parser sees any other value, it returns 422 with `{ error: 'unsupported_bundle_version', supported_versions: [1], got: <n> }`. Future bumps require an explicit migration pass + `supported_versions` list update — the UI must NOT silently accept v2 data and render it with v1 field assumptions.

**4. Every admin route MUST compose `requireAuth + requireAdmin`, in that order.** Identical to WebApp.3's `server/routes/admin/exports.js`. `attachAuth` is app-level (`server/index.js:46`), `requireAuth` emits 401 if missing, `requireAdmin` (defined locally in the route file, calling `isAdmin(req)`) emits 403. Do NOT put the auth check at `router.use()` — per-handler is the convention. There's only one handler in this file, but follow the pattern.

**5. `express.raw()` middleware is applied LOCALLY on the route, not globally.** The global middleware stack at `server/index.js:44-45` is `express.json({ limit: '10mb' })` + `express.text({ limit: '10mb' })`. A global `express.raw({ type: 'application/zip' })` would parse every request of that content-type, which is fine today (only this route uses it) but is fragile as the surface grows. Apply it as the second arg on `router.post('/parse', express.raw({ limit: '50mb', type: 'application/zip' }), requireAuth, requireAdmin, handler)`. Keep the blast radius tiny.

**6. Component tests hit `happy-dom` env per `vitest.workspace.js`; server route + parser tests hit `node` env — don't cross the streams.** `src/pages/admin/__tests__/SupportBundle.test.jsx` → `web` project; `server/routes/admin/__tests__/support-bundles.test.js` + `server/services/__tests__/bundle-parser.test.js` → `server` project. Placing a route test under `src/` or a component test under `server/` will fail loud.

**7. The page fetches the ZIP upload via `fetch(..., { body: file })`, NOT `FormData`.** The `File` / `Blob` object is directly assignable to `fetch`'s `body` and the browser sets `Content-Type: application/zip` when you pass the header explicitly. No `FormData`, no `multer`, no boundary string. See invariant #5.

**8. The side-by-side `exports` row reuses WebApp.3's `GET /api/admin/exports/:id/events` endpoint.** The SupportBundle page has a two-pane layout: left = parsed bundle, right = correlated export. The right pane is a cut-down version of `ExportDetail.jsx`'s render — it calls `apiGet('/admin/exports/<run_id>/events')` (when a `run_id` exists in the bundle), handles 404 gracefully ("No matching export record"), and renders using the extracted `StatusBadge` / `EventBadge` / `formatTimestamp` helpers per open question #6. Do NOT duplicate the events endpoint logic — re-hit the existing one.

---

## Bundle format (v1) — consumed contract

Source of truth: `docs/superpowers/plans/2026-04-24-extension-ext8-diagnostics.md` § "Bundle format (v1)" (lines 42-143). The parser MUST pin to this contract. Any deviation in the Ext.8 plan trumps this excerpt; re-check before coding.

```
transcript-eval-diagnostics-<ISO-timestamp>.zip
├── meta.json           — bundle metadata
├── queue.json          — recent queue states (last 24h)
├── events.json         — last 200 telemetry events
└── environment.json    — UA, platform, cookie booleans, jwt_presence, deny_list, daily_counts, overflow_total
```

### `meta.json`

```jsonc
{
  "schema_version": 1,                        // REQUIRED. Parser rejects any other value with 422.
  "ext_version": "0.8.0",                     // REQUIRED. String.
  "manifest_version": "0.8.0",                // OPTIONAL. String.
  "generated_at": "2026-04-24T17:22:31.412Z", // REQUIRED. ISO 8601 UTC. UI renders via Date parse.
  "browser_family": "chrome",                 // OPTIONAL. String.
  "bundle_window_ms": 86400000,               // OPTIONAL. Int.
  "bundle_max_events": 200                    // OPTIONAL. Int.
}
```

### `queue.json`

```jsonc
{
  "runs": [                                   // REQUIRED. Array (possibly empty).
    {
      "run_id": "01ABCDXYZ",                  // REQUIRED (per run).
      "created_at": 1714000000000,            // REQUIRED. Epoch ms.
      "updated_at": 1714000123000,            // REQUIRED. Epoch ms. Used for "most recent run" selection.
      "phase": "complete",                    // REQUIRED. One of pending|in_progress|complete|failed|partial.
      "error_code": null,                     // OPTIONAL. String | null.
      "stats": { "ok_count": 12, "fail_count": 1 }, // REQUIRED. Counters.
      "items": [                              // REQUIRED. Array.
        {
          "source": "envato",                 // REQUIRED. One of envato|pexels|freepik|storyblocks.
          "source_item_id": "NX9WYGQ",        // REQUIRED.
          "status": "complete",               // REQUIRED.
          "error_code": null,                 // OPTIONAL.
          "filename": "~/Downloads/transcript-eval/export-<redacted>/001_envato_NX9WYGQ.mov"  // paths redacted by Ext.8
        }
      ]
    }
  ]
}
```

### `events.json`

```jsonc
{
  "events": [                                 // REQUIRED. Array (possibly empty).
    {
      "export_id": "01A...",                  // REQUIRED.
      "event": "export_started",              // REQUIRED. String.
      "ts": 1714000000000,                    // REQUIRED. Epoch ms.
      "meta": {},                             // OPTIONAL. Object.
      "ext_version": "0.8.0"                  // OPTIONAL. String.
    }
  ],
  "count": 173,                               // OPTIONAL. Reported count.
  "truncated_from": 200                       // OPTIONAL. How many were considered before truncation.
}
```

### `environment.json`

```jsonc
{
  "user_agent": "Mozilla/5.0 ...",            // REQUIRED. String.
  "platform": "MacIntel",                     // REQUIRED. String.
  "cookie_presence": {                        // REQUIRED. Object of boolean flags.
    "has_envato_client_id": true,
    "has_envato_user_id": true,
    "has_elements_session": false,
    "has_envato_session_id": true
  },
  "jwt_presence": {                           // REQUIRED. Object.
    "jwt_present": true,
    "jwt_expires_at": 1714086400000,          // OPTIONAL. Epoch ms.
    "jwt_user_id_prefix": "a1b2c3d4"          // OPTIONAL. String (first 8 chars of userId).
  },
  "deny_list": { "envato": ["NX9WYGQ"] },     // REQUIRED. Object of { source: item_id[] }.
  "daily_counts": {                           // REQUIRED. Object of { "YYYY-MM-DD": { source: int } }.
    "2026-04-24": { "envato": 42, "pexels": 17, "freepik": 0 }
  },
  "deny_list_alerted": {},                    // OPTIONAL. Object.
  "telemetry_overflow_total": 0,              // REQUIRED. Int.
  "telemetry_opt_out": false,                 // REQUIRED. Boolean.
  "active_run_id": null                       // OPTIONAL. String | null.
}
```

**Parser error taxonomy (from invariants #1-3):**

| Error code | HTTP | Trigger |
|-----------|------|---------|
| `missing_zip_body` | 400 | `req.body` is empty or not a Buffer. |
| `invalid_zip` | 400 | `fflate.unzipSync` throws (corrupt/not a ZIP). |
| `missing_bundle_file` | 400 | Any of the 4 expected JSON files is absent. Response includes `missing: <name>`. |
| `invalid_json` | 400 | JSON.parse on any file throws. Response includes `file: <name>`. |
| `unsupported_bundle_version` | 422 | `meta.schema_version !== 1`. Response includes `supported_versions: [1]` + `got`. |
| `missing_required_field` | 400 | A REQUIRED field from the tables above is absent. Response includes `file` + `field`. |

File-size overages (>50MB) return 413 from Express itself before the handler runs — no route-level error code needed.

---

## Scope (WebApp.4 only — hold the line)

### In scope

1. **`server/services/bundle-parser.js` [NEW]** — pure parser. Takes `Uint8Array` bytes, returns `{ meta, queue, events, environment }` on success; throws `BundleParseError` with `{ errorCode, httpStatus, detail }` on failure. Uses `fflate.unzipSync`. Validates `meta.schema_version === 1` + REQUIRED fields per the tables above. No Express, no DB, no filesystem — pure.
2. **`server/routes/admin/support-bundles.js` [NEW]** — one `POST /parse` handler, composed as `router.post('/parse', express.raw({ limit: '50mb', type: 'application/zip' }), requireAuth, requireAdmin, handler)`. Converts `req.body` to `Uint8Array`, calls `bundle-parser`, returns the parsed JSON on 200 or maps `BundleParseError.errorCode` to the documented status. `requireAdmin` is defined inline (calls `isAdmin(req)`), matching WebApp.3's file-local pattern.
3. **`server/index.js` [MOD]** — register the router: `import adminSupportBundlesRouter from './routes/admin/support-bundles.js'` + `app.use('/api/admin/support-bundles', adminSupportBundlesRouter)`. Mount alongside the existing `app.use('/api/admin/exports', adminExportsRouter)`.
4. **`src/pages/admin/SupportBundle.jsx` [NEW]** — file-drop/picker UI + parsed-bundle rendering. Four sections (meta / queue / events / environment) + side-by-side correlated `exports` row (fetched via `apiGet('/admin/exports/<run_id>/events')`). Graceful "no run_id", "no match", "multiple runs" states per Q2. Unsupported-version banner per invariant #3.
5. **`src/pages/admin/_helpers.jsx` [NEW] (pending Q6)** — extracts `StatusBadge`, `EventBadge`, `formatTimestamp` from `ExportDetail.jsx`. `ExportDetail.jsx` is updated to import from here. Zero behavior change.
6. **`src/pages/admin/ExportDetail.jsx` [MOD]** — replace inline definitions with imports from `_helpers.jsx` (pending Q6). This is the only change — no render/layout tweaks.
7. **`src/App.jsx` [MOD]** — add one `<Route>` inside the `/admin` block: `<Route path="support" element={<SupportBundle />} />`. Add one import at the top.
8. **`src/components/layouts/AdminLayout.jsx` [MOD]** — add one `navItems` entry: `{ to: '/admin/support', icon: LifeBuoy, label: 'Support' }` (lucide-react `LifeBuoy` icon — add to the existing lucide import). Position: immediately after the existing `/admin/exports` entry.
9. **`server/routes/admin/__tests__/support-bundles.test.js` [NEW]** — ~6 route tests: admin allow (happy-path 200), unauthenticated 401, non-admin 403, missing zip body (400), unsupported schema version (422), file-size-cap pass-through (not asserted via actual 50MB payload — just confirm the middleware is configured with `limit: '50mb'`). Mocks `fflate.unzipSync` with scripted responses.
10. **`server/services/__tests__/bundle-parser.test.js` [NEW]** — ~7 parser tests: happy-path (all 4 files present, schema_version=1), missing zip body, corrupt ZIP (unzipSync throws), missing `meta.json`, missing `queue.json`, malformed JSON in `environment.json`, unsupported schema_version. Uses a fixture helper to build a valid `{ [filename]: Uint8Array }` map mirroring what `fflate.unzipSync` would return.
11. **`src/pages/admin/__tests__/SupportBundle.test.jsx` [NEW]** — ~2-3 happy-dom smoke tests: renders upload form; mocked `fetch` returns a fixture bundle response → asserts all 4 sections render; mocked fetch returns 422 → asserts unsupported-version banner renders.
12. **`src/pages/admin/__tests__/fixtures/sample-bundle-v1.json` [NEW]** — small handcrafted fixture matching the v1 schema. Shared between the parser tests + component tests. Written by hand based on the Bundle Format (v1) excerpt above — do NOT depend on `fflate` or the extension's encoder at test time.

**Test count target:** ~10-14 new tests; vitest baseline 96/96 → ~106-110/106-110 after.

### Deferred (DO NOT add)

- **Bundle persistence / `support_bundles` DB table** — future phase. The endpoint is stateless per invariant #1.
- **Schema v2 parser** — design for it (the 422 response carries `supported_versions`), but don't implement v2 field handling. The `BundleParseError` + 422 is the forward-migration seam.
- **Any extension changes** — Ext.8 ships the producer; WebApp.4 is the consumer only. Do NOT touch `extension/**`.
- **Any change to WebApp.3's `/admin/exports` list/detail pages** — the `StatusBadge`/`EventBadge`/`formatTimestamp` extraction per Q6 is the ONE allowed minor touch of `ExportDetail.jsx`. Do NOT add new filters, columns, or data to the existing admin pages.
- **Bundle file-download audit logging** — not requested. The endpoint is read-only-ish from the DB perspective (no DB writes at all).
- **Slack re-wire on bundle upload** — no. Silent admin tool.
- **`GET /api/admin/support-bundles`** (list) — there's no list; bundles are not stored. If a future phase persists them, that's when this endpoint appears.
- **Charts / histograms** — raw tables only, matching WebApp.3's read-only ethos.
- **Realtime** — no SSE, no WebSocket. Admin re-uploads the bundle if they need refresh.
- **Multi-file upload** — one ZIP per request. Multi-bundle comparison is a future phase if asked.

---

## Prerequisites

- Node 20+ (already used).
- Local branch `main` has Wave 1 (Ext.7 + WebApp.3 + State F) merged + Wave 2 (Ext.8) merged. Verify: `git log --oneline main | head -15` shows recent `feat(extension)` + `feat(admin)` commits. Latest should include `Merge branch 'feature/extension-ext8-diagnostics' into main` at `8679693` or later.
- `npm install` up to date. `npm run test` on `main` must be **96/96 green** before branching (baseline invariant — don't build on a broken baseline).
- `fflate ^0.8.2` is in `package.json` `dependencies` (shipped with Ext.8). Verify: `node -e "console.log(require('fflate').version || 'loaded')"`. If absent, STOP — Ext.8 is not merged; prerequisite failed.
- Backend running on `localhost:3001` for the manual smoke task (final task); `:3001` must be the user's dev-server port. **Do NOT kill anything on :3001** — if the port is in use, reuse that server or skip the smoke.
- Path quoting: `/Users/laurynas/Desktop/one last /transcript-eval/` — trailing space in `one last `. Quote every shell path.
- Worktree skill: `superpowers:using-git-worktrees` for Task 0.
- Dirty-tree off-limits list (do not stage, do not commit, do not modify): `server/routes/gpu.js`, `server/services/gpu-failure-poller.js`, `check_placement.js`, `final_query*.js`, `query_*.js`, `server/db.sqlite`, `server/seed/update-*.js`, `docs/plans/2026-04-22-reset-broll-searches.md`, `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md`.
- A real diagnostic bundle for the smoke step. Produce one by opening `extension-test.html`, clicking the Ext.8 diagnostic bundle button, and saving the resulting `.zip`. If Ext.8 unused recently, trigger a short export run first so `queue.json` isn't empty.

---

## File structure (WebApp.4 final state)

All paths are inside `$WT` where `WT="/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/webapp-admin-support"`.

```
$WT/server/
├── routes/
│   ├── admin.js                                   UNCHANGED
│   └── admin/
│       ├── exports.js                             UNCHANGED — WebApp.3
│       ├── support-bundles.js                     NEW — POST /parse handler
│       └── __tests__/
│           ├── exports.test.js                    UNCHANGED — WebApp.3
│           └── support-bundles.test.js            NEW — ~6 tests
├── services/
│   ├── exports.js                                 UNCHANGED
│   ├── bundle-parser.js                           NEW — pure parser (fflate + validators)
│   └── __tests__/
│       ├── exports.test.js                        UNCHANGED
│       └── bundle-parser.test.js                  NEW — ~7 tests
└── index.js                                       MODIFIED — +import + +app.use(...)

$WT/src/
├── pages/
│   ├── ExportPage.jsx                             UNCHANGED
│   └── admin/
│       ├── ExportsList.jsx                        UNCHANGED — WebApp.3
│       ├── ExportDetail.jsx                       MODIFIED — imports badges from _helpers
│       ├── SupportBundle.jsx                      NEW — upload + render
│       ├── _helpers.jsx                           NEW — StatusBadge, EventBadge, formatTimestamp
│       └── __tests__/
│           ├── ExportsList.test.jsx               UNCHANGED
│           ├── ExportDetail.test.jsx              UNCHANGED (must still pass after refactor)
│           ├── SupportBundle.test.jsx             NEW — ~2-3 smoke tests
│           └── fixtures/
│               └── sample-bundle-v1.json          NEW — shared handcrafted fixture
├── components/
│   └── layouts/
│       └── AdminLayout.jsx                        MODIFIED — +navItems entry + LifeBuoy import
└── App.jsx                                        MODIFIED — +1 route + 1 import

$WT/docs/superpowers/plans/
└── 2026-04-24-webapp-admin-support.md             THIS FILE
```

**Why this split:**
- **Route vs parser split.** Keeps the route file a thin Express adapter and the parser pure + unit-testable without route plumbing. Matches existing `routes/admin/exports.js` (route) + `services/exports.js` (pure service) pattern.
- **Fixtures under `src/pages/admin/__tests__/fixtures/`.** Happy-dom component tests need the fixture; parser tests can also import from there (node env can still resolve the JSON). One fixture, two callers.
- **`_helpers.jsx` under `src/pages/admin/`.** The underscore-prefix is a soft signal ("internal to this directory"). JSX extension because the badges return JSX. Tiny by design — if it grows beyond ~50 lines, split later.

---

## Working conventions for these tasks

- **Branch:** `feature/webapp-admin-support`, created on the worktree (NOT in the user's current working directory — the dirty tree at `git status` must be left alone).
- **Worktree path:** `.worktrees/webapp-admin-support` off the repo root. Use `git worktree add -b feature/webapp-admin-support .worktrees/webapp-admin-support main`. All subsequent work happens inside the worktree. See superpowers:using-git-worktrees.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval. Final task (manual smoke) does not push.
- **Never kill anything on :3001.** The user's dev server may be running. Tests don't need the backend; the manual smoke assumes the backend is already up.
- **Leave the user's dirty tree alone.** The files in the prerequisites off-limits list MUST NOT be touched by any task in this plan.
- **Never modify `~/.git` or git config.** Never use destructive git ops (`reset --hard`, `push --force`, `clean -fd`, etc.). **Never amend** — every task commits NEW.
- **Commit style:** conventional commits (`feat(admin)`, `feat(server)`, `refactor(admin)`, `test(admin)`, `test(server)`). One commit per task. Add the Claude co-author trailer at the end of every commit message:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"`. Unquoted paths silently break on the trailing space.
- **Auth check is non-negotiable.** The one handler in `support-bundles.js` MUST compose `express.raw() + requireAuth + requireAdmin`. Any PR that omits one fails review.
- **Stateless.** No `INSERT INTO`, no `fs.writeFile`, no `os.tmpdir()`. See invariant #1.

---

## Task 0: Create worktree + branch + scaffold commit

**Files:**
- Verify: `$TE/docs/superpowers/plans/2026-04-24-webapp-admin-support.md` (this file) on `main`.
- Create: git worktree at `$TE/.worktrees/webapp-admin-support` on new branch `feature/webapp-admin-support`.

- [ ] **Step 1: From the main repo, create the worktree off local `main`**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git status --short
# Expected: shows the known dirty tree (gpu.js mods + untracked query_*.js files etc.).
# CRITICAL: do NOT try to clean or stash these. They're the user's unrelated work.
git fetch origin main 2>/dev/null || echo "No remote; continuing with local main"
git worktree add -b feature/webapp-admin-support "$TE/.worktrees/webapp-admin-support" main
# Expected: "Preparing worktree (new branch 'feature/webapp-admin-support')"
#           "HEAD is now at <sha> ..."
git worktree list
# Expected: two entries minimum — one at $TE on main (or prior branch), one at .worktrees/webapp-admin-support
```

- [ ] **Step 2: Switch to the worktree for ALL subsequent tasks**

```bash
WT="/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/webapp-admin-support"
cd "$WT"
git branch --show-current
# Expected: feature/webapp-admin-support
git status --short
# Expected: clean tree
```

From this point on, every `cd` in this plan uses `$WT`.

- [ ] **Step 3: Sanity-check the in-tree files we'll modify/reference**

```bash
cd "$WT"
test -f server/auth.js && grep -q "export function isAdmin" server/auth.js && echo "auth: OK" || echo "MISSING auth"
test -f server/routes/admin/exports.js && grep -q "requireAdmin" server/routes/admin/exports.js && echo "webapp3-pattern: OK" || echo "MISSING pattern"
test -f src/pages/admin/ExportDetail.jsx && grep -q "StatusBadge\|EventBadge\|formatTimestamp" src/pages/admin/ExportDetail.jsx && echo "badges-inline: OK" || echo "MISSING badges"
test -f src/App.jsx && grep -q 'path="/admin"' src/App.jsx && echo "router: OK" || echo "MISSING router"
test -f src/components/layouts/AdminLayout.jsx && grep -q "Download" src/components/layouts/AdminLayout.jsx && echo "admin-layout: OK" || echo "MISSING layout"
test -f src/hooks/useApi.js && grep -q "export async function apiGet" src/hooks/useApi.js && echo "useApi: OK" || echo "MISSING useApi"
test -f vitest.workspace.js && grep -q "'server'" vitest.workspace.js && echo "vitest-workspace: OK" || echo "MISSING vitest-workspace"
node -e "import('fflate').then(m => console.log('fflate:', m.unzipSync ? 'OK' : 'MISSING'))" 2>&1 | tail -1
# Expected: every line "OK" (fflate exposes unzipSync).
```

- [ ] **Step 4: Run the existing test suite — baseline must pass (96/96 per memory)**

```bash
cd "$WT"
npm run test 2>&1 | tail -10
# Expected tail:
#   Test Files  X passed (X)
#   Tests       96 passed (96)
# If this fails, STOP. The executor must not build on a broken baseline.
```

- [ ] **Step 5: Confirm this plan file is at the expected path, then commit if needed**

```bash
cd "$WT"
test -f docs/superpowers/plans/2026-04-24-webapp-admin-support.md && echo OK || echo "MISSING plan"
# Expected: OK if plan was committed to main before the worktree was made.
git status --short
# Expected: empty (plan was in main already)
```

If the plan file is not yet on `main` (you wrote it after branching), stage and commit it:

```bash
cd "$WT"
git add docs/superpowers/plans/2026-04-24-webapp-admin-support.md
git diff --cached --stat
git commit -m "$(cat <<'EOF'
docs(plan): WebApp.4 /admin/support diagnostics UI

Ships a stateless POST /api/admin/support-bundles/parse endpoint that
reads an Ext.8 Bundle-Format-v1 ZIP in memory (via fflate.unzipSync),
validates the four required JSON files (meta/queue/events/environment),
and returns the parsed contents. Plus a new SupportBundle admin page
that uploads via raw bytes, renders the four sections, and correlates
with the matching exports row via WebApp.3's existing endpoint.

Auth reuses isAdmin + requireAuth + requireAdmin. No DB writes, no
filesystem side effects. Schema v1 only; future versions return 422
with supported_versions list. Extracts badge helpers from WebApp.3's
ExportDetail into src/pages/admin/_helpers.jsx for reuse.

Explicit non-goals: bundle persistence, schema v2 parsing, extension
changes, WebApp.3 admin-page reshape, file-download audit logs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -3
# Expected: top line is the plan commit.
```

---

## Task 1: Extract badge helpers from ExportDetail (Q6 resolution)

**Files:**
- Create: `src/pages/admin/_helpers.jsx`
- Modify: `src/pages/admin/ExportDetail.jsx`
- Verify: `src/pages/admin/__tests__/ExportDetail.test.jsx` still passes unchanged.

- [ ] **Step 1: Read the current inline definitions**

```bash
cd "$WT"
grep -n "function StatusBadge\|function EventBadge\|function formatTimestamp" src/pages/admin/ExportDetail.jsx
# Expected: three matches, around lines 16, 31, 39.
```

- [ ] **Step 2: Create `src/pages/admin/_helpers.jsx` — pure extraction (verbatim copy of bodies + shared `export`)**

```jsx
// src/pages/admin/_helpers.jsx
// Shared admin-page UI helpers. Extracted from ExportDetail.jsx so
// SupportBundle.jsx (WebApp.4) can reuse them without duplication.
// Zero behavior change from the ExportDetail originals — pure cut
// and paste.

export function StatusBadge({ status }) {
  // (copy body from ExportDetail.jsx lines 16-29 verbatim)
}

export function EventBadge({ event }) {
  // (copy body from ExportDetail.jsx lines 31-38 verbatim)
}

export function formatTimestamp(ms) {
  // (copy body from ExportDetail.jsx lines 39-43 verbatim)
}
```

- [ ] **Step 3: Replace the inline definitions in `ExportDetail.jsx` with imports**

Remove the three local `function` declarations; add at the top:

```jsx
import { StatusBadge, EventBadge, formatTimestamp } from './_helpers.jsx'
```

The call sites (`<StatusBadge status={ex.status} />`, `<EventBadge event={ev.event} />`, `formatTimestamp(ev.t)`) stay unchanged.

- [ ] **Step 4: Verify ExportDetail test still passes**

```bash
cd "$WT"
npm run test -- --run src/pages/admin/__tests__/ExportDetail.test.jsx 2>&1 | tail -8
# Expected: ExportDetail tests pass with no edits.
```

- [ ] **Step 5: Full test suite still 96/96 (no regression)**

```bash
cd "$WT"
npm run test 2>&1 | tail -5
# Expected: Tests 96 passed (96)
```

- [ ] **Step 6: Commit**

```bash
cd "$WT"
git add src/pages/admin/_helpers.jsx src/pages/admin/ExportDetail.jsx
git diff --cached --stat
git commit -m "$(cat <<'EOF'
refactor(admin): extract StatusBadge/EventBadge/formatTimestamp to _helpers

WebApp.4's SupportBundle page needs the same badge helpers as WebApp.3's
ExportDetail. Move them to a shared src/pages/admin/_helpers.jsx.
Zero behavior change; ExportDetail.jsx now imports from ./_helpers.jsx.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Pure parser — `server/services/bundle-parser.js` + tests

**Files:**
- Create: `server/services/bundle-parser.js`
- Create: `server/services/__tests__/bundle-parser.test.js`

- [ ] **Step 1: Create the parser — pure, side-effect-free**

```js
// server/services/bundle-parser.js
// Pure parser for Ext.8 Bundle Format (v1). Takes Uint8Array bytes of
// a ZIP, returns { meta, queue, events, environment } or throws a
// BundleParseError. See docs/superpowers/plans/2026-04-24-extension-ext8-diagnostics.md
// § "Bundle format (v1)" for the schema.
//
// Invariants (see WebApp.4 plan):
//   1. STATELESS — no DB, no FS. Pure.
//   3. Only schema_version === 1 accepted. Anything else → BundleParseError
//      with errorCode "unsupported_bundle_version" + httpStatus 422.

import { unzipSync, strFromU8 } from 'fflate'

export const SUPPORTED_SCHEMA_VERSIONS = [1]

const EXPECTED_FILES = ['meta.json', 'queue.json', 'events.json', 'environment.json']

export class BundleParseError extends Error {
  constructor(errorCode, httpStatus, detail = {}) {
    super(errorCode)
    this.errorCode = errorCode
    this.httpStatus = httpStatus
    this.detail = detail
  }
}

export function parseBundle(bytes) {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new BundleParseError('missing_zip_body', 400)
  }

  let files
  try {
    files = unzipSync(bytes)
  } catch (err) {
    throw new BundleParseError('invalid_zip', 400, { cause: String(err?.message || err) })
  }

  for (const name of EXPECTED_FILES) {
    if (!files[name]) throw new BundleParseError('missing_bundle_file', 400, { missing: name })
  }

  const parsed = {}
  for (const name of EXPECTED_FILES) {
    const key = name.replace('.json', '') // meta | queue | events | environment
    try {
      parsed[key] = JSON.parse(strFromU8(files[name]))
    } catch (err) {
      throw new BundleParseError('invalid_json', 400, { file: name, cause: String(err?.message || err) })
    }
  }

  // Schema version check — only meta.schema_version gates migration.
  const schema = parsed.meta?.schema_version
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schema)) {
    throw new BundleParseError('unsupported_bundle_version', 422, {
      supported_versions: SUPPORTED_SCHEMA_VERSIONS,
      got: schema ?? null,
    })
  }

  // Required-field validation per the Bundle Format (v1) contract.
  // Add more checks as spec tightens; each should map to missing_required_field.
  const requireField = (file, obj, field) => {
    if (obj == null || obj[field] === undefined) {
      throw new BundleParseError('missing_required_field', 400, { file, field })
    }
  }
  requireField('meta.json', parsed.meta, 'ext_version')
  requireField('meta.json', parsed.meta, 'generated_at')
  requireField('queue.json', parsed.queue, 'runs')
  requireField('events.json', parsed.events, 'events')
  requireField('environment.json', parsed.environment, 'user_agent')
  requireField('environment.json', parsed.environment, 'platform')
  requireField('environment.json', parsed.environment, 'cookie_presence')
  requireField('environment.json', parsed.environment, 'jwt_presence')
  requireField('environment.json', parsed.environment, 'deny_list')
  requireField('environment.json', parsed.environment, 'daily_counts')
  requireField('environment.json', parsed.environment, 'telemetry_overflow_total')
  requireField('environment.json', parsed.environment, 'telemetry_opt_out')

  return parsed
}
```

- [ ] **Step 2: Create tests — ~7 cases**

```js
// server/services/__tests__/bundle-parser.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fflate so we can control unzipSync output per test without
// needing a real ZIP byte sequence. `strFromU8` we keep real.
vi.mock('fflate', async () => {
  const actual = await vi.importActual('fflate')
  return {
    ...actual,
    unzipSync: vi.fn(),
  }
})

import { unzipSync } from 'fflate'
import { parseBundle, BundleParseError, SUPPORTED_SCHEMA_VERSIONS } from '../bundle-parser.js'

function u8(str) {
  return new TextEncoder().encode(str)
}

function validBundleFiles() {
  return {
    'meta.json': u8(JSON.stringify({
      schema_version: 1,
      ext_version: '0.8.0',
      generated_at: '2026-04-24T17:22:31.412Z',
    })),
    'queue.json': u8(JSON.stringify({
      runs: [{ run_id: '01ABC', created_at: 1, updated_at: 2, phase: 'complete', stats: { ok_count: 1, fail_count: 0 }, items: [] }],
    })),
    'events.json': u8(JSON.stringify({ events: [] })),
    'environment.json': u8(JSON.stringify({
      user_agent: 'Mozilla/5.0 ...',
      platform: 'MacIntel',
      cookie_presence: { has_envato_client_id: true },
      jwt_presence: { jwt_present: false },
      deny_list: {},
      daily_counts: {},
      telemetry_overflow_total: 0,
      telemetry_opt_out: false,
    })),
  }
}

describe('parseBundle', () => {
  beforeEach(() => { vi.mocked(unzipSync).mockReset() })
  afterEach(() => { vi.clearAllMocks() })

  it('happy path — returns all four parsed sections', () => {
    vi.mocked(unzipSync).mockReturnValue(validBundleFiles())
    const result = parseBundle(new Uint8Array([0x50, 0x4b, 0x03, 0x04])) // fake ZIP header bytes
    expect(result.meta.schema_version).toBe(1)
    expect(result.meta.ext_version).toBe('0.8.0')
    expect(result.queue.runs).toHaveLength(1)
    expect(result.events.events).toEqual([])
    expect(result.environment.user_agent).toMatch(/Mozilla/)
  })

  it('throws missing_zip_body when given null / empty / non-Uint8Array', () => {
    expect(() => parseBundle(null)).toThrow(BundleParseError)
    expect(() => parseBundle(new Uint8Array(0))).toThrow(/missing_zip_body/)
  })

  it('throws invalid_zip when fflate.unzipSync throws', () => {
    vi.mocked(unzipSync).mockImplementation(() => { throw new Error('bad zip') })
    try {
      parseBundle(new Uint8Array([1, 2, 3]))
    } catch (e) {
      expect(e).toBeInstanceOf(BundleParseError)
      expect(e.errorCode).toBe('invalid_zip')
      expect(e.httpStatus).toBe(400)
    }
  })

  it('throws missing_bundle_file when meta.json is absent', () => {
    const files = validBundleFiles()
    delete files['meta.json']
    vi.mocked(unzipSync).mockReturnValue(files)
    try { parseBundle(new Uint8Array([1])) } catch (e) {
      expect(e.errorCode).toBe('missing_bundle_file')
      expect(e.detail.missing).toBe('meta.json')
    }
  })

  it('throws invalid_json when environment.json is malformed', () => {
    const files = validBundleFiles()
    files['environment.json'] = u8('{ not-json')
    vi.mocked(unzipSync).mockReturnValue(files)
    try { parseBundle(new Uint8Array([1])) } catch (e) {
      expect(e.errorCode).toBe('invalid_json')
      expect(e.detail.file).toBe('environment.json')
    }
  })

  it('throws unsupported_bundle_version when schema_version !== 1', () => {
    const files = validBundleFiles()
    files['meta.json'] = u8(JSON.stringify({ schema_version: 2, ext_version: '1.0.0', generated_at: 'x' }))
    vi.mocked(unzipSync).mockReturnValue(files)
    try { parseBundle(new Uint8Array([1])) } catch (e) {
      expect(e.errorCode).toBe('unsupported_bundle_version')
      expect(e.httpStatus).toBe(422)
      expect(e.detail.supported_versions).toEqual(SUPPORTED_SCHEMA_VERSIONS)
      expect(e.detail.got).toBe(2)
    }
  })

  it('throws missing_required_field when environment.jwt_presence absent', () => {
    const files = validBundleFiles()
    const env = JSON.parse(new TextDecoder().decode(files['environment.json']))
    delete env.jwt_presence
    files['environment.json'] = u8(JSON.stringify(env))
    vi.mocked(unzipSync).mockReturnValue(files)
    try { parseBundle(new Uint8Array([1])) } catch (e) {
      expect(e.errorCode).toBe('missing_required_field')
      expect(e.detail.file).toBe('environment.json')
      expect(e.detail.field).toBe('jwt_presence')
    }
  })
})
```

- [ ] **Step 3: Run the new test file**

```bash
cd "$WT"
npm run test -- --run server/services/__tests__/bundle-parser.test.js 2>&1 | tail -10
# Expected: 7 passed (or close; tweak if count drifts).
```

- [ ] **Step 4: Full suite — baseline grows by ~7**

```bash
cd "$WT"
npm run test 2>&1 | tail -5
# Expected: Tests 103 passed (103)
```

- [ ] **Step 5: Commit**

```bash
cd "$WT"
git add server/services/bundle-parser.js server/services/__tests__/bundle-parser.test.js
git diff --cached --stat
git commit -m "$(cat <<'EOF'
feat(server): bundle-parser — pure parser for Ext.8 Bundle Format v1

Pure, side-effect-free parser. Takes Uint8Array ZIP bytes, returns
{ meta, queue, events, environment } on success; throws BundleParseError
with errorCode + httpStatus + detail on failure. Uses fflate.unzipSync
(already a runtime dep from Ext.8). Validates schema_version === 1 and
the REQUIRED fields from the Ext.8 Bundle Format v1 contract.

Error taxonomy: missing_zip_body (400), invalid_zip (400),
missing_bundle_file (400), invalid_json (400),
unsupported_bundle_version (422), missing_required_field (400).

No DB, no FS, no Express — pure. Plans WebApp.4 Task 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Route wrapper — `server/routes/admin/support-bundles.js` + tests

**Files:**
- Create: `server/routes/admin/support-bundles.js`
- Create: `server/routes/admin/__tests__/support-bundles.test.js`

- [ ] **Step 1: Create the route**

```js
// server/routes/admin/support-bundles.js
// POST /api/admin/support-bundles/parse — STATELESS bundle parser.
// Accepts raw application/zip bytes, calls the pure parser, returns JSON.
// NO persistence, NO filesystem side effects. See WebApp.4 plan § invariant #1.

import { Router } from 'express'
import express from 'express'
import { requireAuth, isAdmin } from '../../auth.js'
import { parseBundle, BundleParseError } from '../../services/bundle-parser.js'

const router = Router()

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// POST /parse — body is raw application/zip (≤50MB).
// Response 200: { meta, queue, events, environment }
// Response 400: { error: '<errorCode>', ...detail }
// Response 401: { error: 'Authentication required' }    (via requireAuth)
// Response 403: { error: 'Admin access required' }       (via requireAdmin)
// Response 413: sent by express.raw when body > 50MB
// Response 422: { error: 'unsupported_bundle_version', supported_versions, got }
router.post(
  '/parse',
  express.raw({ limit: '50mb', type: 'application/zip' }),
  requireAuth,
  requireAdmin,
  (req, res, next) => {
    try {
      const body = req.body
      if (!body || !Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: 'missing_zip_body' })
      }
      const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      const parsed = parseBundle(bytes)
      return res.json(parsed)
    } catch (err) {
      if (err instanceof BundleParseError) {
        return res.status(err.httpStatus).json({ error: err.errorCode, ...err.detail })
      }
      next(err)
    }
  }
)

export default router
```

- [ ] **Step 2: Register the router in `server/index.js`**

```js
// Near the other admin imports:
import adminSupportBundlesRouter from './routes/admin/support-bundles.js'

// Immediately after `app.use('/api/admin/exports', adminExportsRouter)`:
app.use('/api/admin/support-bundles', adminSupportBundlesRouter)
```

- [ ] **Step 3: Create route tests — ~6 cases**

```js
// server/routes/admin/__tests__/support-bundles.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the pure parser so the route tests only exercise the Express wiring.
vi.mock('../../../services/bundle-parser.js', () => {
  const actual = {
    BundleParseError: class BundleParseError extends Error {
      constructor(code, status, detail = {}) { super(code); this.errorCode = code; this.httpStatus = status; this.detail = detail }
    },
  }
  actual.parseBundle = vi.fn()
  return actual
})

// Stub the auth module so we can control isAdmin per test.
vi.mock('../../auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' })
    next()
  },
  isAdmin: (req) => req.auth?.isAdmin === true,
}))

import express from 'express'
import request from 'supertest'  // ← check package.json; may need to add as devDep. Otherwise use the in-house fake-req/res helper pattern seen in server/routes/admin/__tests__/exports.test.js.
import router from '../support-bundles.js'
import { parseBundle, BundleParseError } from '../../../services/bundle-parser.js'

// NOTE: if supertest is not already a devDep, check the style used in
// exports.test.js and replicate it — some tests there may call the
// handler function directly with a fake req/res instead of booting express.
// Use whichever matches existing WebApp.3 patterns (investigate in Task 0 Step 3).

function makeApp({ auth }) {
  const app = express()
  app.use((req, _res, next) => { req.auth = auth; next() })
  app.use('/api/admin/support-bundles', router)
  return app
}

describe('POST /api/admin/support-bundles/parse', () => {
  beforeEach(() => { vi.mocked(parseBundle).mockReset() })

  it('401 when unauthenticated', async () => {
    const app = makeApp({ auth: null })
    const res = await request(app).post('/api/admin/support-bundles/parse').set('Content-Type', 'application/zip').send(Buffer.from([1, 2, 3]))
    expect(res.status).toBe(401)
  })

  it('403 when authenticated but not admin', async () => {
    const app = makeApp({ auth: { userId: 'u-1', isAdmin: false } })
    const res = await request(app).post('/api/admin/support-bundles/parse').set('Content-Type', 'application/zip').send(Buffer.from([1, 2, 3]))
    expect(res.status).toBe(403)
  })

  it('200 happy path — returns parser output', async () => {
    vi.mocked(parseBundle).mockReturnValue({ meta: { schema_version: 1, ext_version: '0.8.0' }, queue: { runs: [] }, events: { events: [] }, environment: {} })
    const app = makeApp({ auth: { userId: 'u-admin', isAdmin: true } })
    const res = await request(app).post('/api/admin/support-bundles/parse').set('Content-Type', 'application/zip').send(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(res.status).toBe(200)
    expect(res.body.meta.schema_version).toBe(1)
  })

  it('400 when parser throws missing_zip_body', async () => {
    vi.mocked(parseBundle).mockImplementation(() => { throw new BundleParseError('missing_zip_body', 400) })
    const app = makeApp({ auth: { userId: 'u-admin', isAdmin: true } })
    const res = await request(app).post('/api/admin/support-bundles/parse').set('Content-Type', 'application/zip').send(Buffer.from([1]))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('missing_zip_body')
  })

  it('422 when parser throws unsupported_bundle_version', async () => {
    vi.mocked(parseBundle).mockImplementation(() => { throw new BundleParseError('unsupported_bundle_version', 422, { supported_versions: [1], got: 2 }) })
    const app = makeApp({ auth: { userId: 'u-admin', isAdmin: true } })
    const res = await request(app).post('/api/admin/support-bundles/parse').set('Content-Type', 'application/zip').send(Buffer.from([1]))
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('unsupported_bundle_version')
    expect(res.body.supported_versions).toEqual([1])
    expect(res.body.got).toBe(2)
  })

  it('400 when body is empty (no content-type or empty buffer)', async () => {
    const app = makeApp({ auth: { userId: 'u-admin', isAdmin: true } })
    const res = await request(app).post('/api/admin/support-bundles/parse').set('Content-Type', 'application/zip').send(Buffer.alloc(0))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('missing_zip_body')
  })
})
```

**Note on supertest:** If `supertest` is NOT already in `devDependencies`, revert to the pattern used in `server/routes/admin/__tests__/exports.test.js` (investigate first). That test likely invokes the handler directly with a fake `req`/`res` object, mirroring the style of `server/services/__tests__/exports.test.js`. Use whichever matches the repo precedent; do NOT add a new devDep for this plan.

- [ ] **Step 4: Run the new test file**

```bash
cd "$WT"
npm run test -- --run server/routes/admin/__tests__/support-bundles.test.js 2>&1 | tail -10
# Expected: 6 passed.
```

- [ ] **Step 5: Full suite green**

```bash
cd "$WT"
npm run test 2>&1 | tail -5
# Expected: Tests 109 passed (109) (approx)
```

- [ ] **Step 6: Commit**

```bash
cd "$WT"
git add server/routes/admin/support-bundles.js server/routes/admin/__tests__/support-bundles.test.js server/index.js
git diff --cached --stat
git commit -m "$(cat <<'EOF'
feat(admin): POST /api/admin/support-bundles/parse — stateless endpoint

Thin Express adapter over server/services/bundle-parser.js. Applies
express.raw({ limit: '50mb', type: 'application/zip' }) locally on the
route so the 50MB cap is enforced before the handler runs. Maps
BundleParseError.errorCode → HTTP status per the documented taxonomy.
Composes requireAuth + requireAdmin like WebApp.3.

No DB writes, no filesystem side effects, no temp files — upload is
processed in memory and discarded after the response.

Mounted at /api/admin/support-bundles in server/index.js alongside
/api/admin/exports.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `SupportBundle.jsx` page + smoke test

**Files:**
- Create: `src/pages/admin/SupportBundle.jsx`
- Create: `src/pages/admin/__tests__/SupportBundle.test.jsx`
- Create: `src/pages/admin/__tests__/fixtures/sample-bundle-v1.json`

- [ ] **Step 1: Create the fixture** — handcrafted, matches v1 schema.

```json
// src/pages/admin/__tests__/fixtures/sample-bundle-v1.json
// Shared handcrafted fixture for WebApp.4 parser + component tests.
// Represents what the /parse endpoint returns — already-parsed JSON,
// not ZIP bytes. Bundle Format v1 contract; see the WebApp.4 plan.
{
  "meta": {
    "schema_version": 1,
    "ext_version": "0.8.0",
    "manifest_version": "0.8.0",
    "generated_at": "2026-04-24T17:22:31.412Z",
    "browser_family": "chrome",
    "bundle_window_ms": 86400000,
    "bundle_max_events": 200
  },
  "queue": {
    "runs": [
      {
        "run_id": "01EXPORTABCD",
        "created_at": 1714000000000,
        "updated_at": 1714000123000,
        "phase": "complete",
        "error_code": null,
        "stats": { "ok_count": 12, "fail_count": 1 },
        "items": [
          { "source": "envato", "source_item_id": "NX9WYGQ", "status": "complete", "error_code": null, "filename": "~/Downloads/transcript-eval/export-<redacted>/001_envato_NX9WYGQ.mov" }
        ]
      }
    ]
  },
  "events": {
    "events": [
      { "export_id": "01EXPORTABCD", "event": "export_started", "ts": 1714000000000, "meta": {}, "ext_version": "0.8.0" },
      { "export_id": "01EXPORTABCD", "event": "item_ok",        "ts": 1714000005000, "meta": { "source": "envato", "source_item_id": "NX9WYGQ" }, "ext_version": "0.8.0" },
      { "export_id": "01EXPORTABCD", "event": "export_completed","ts": 1714000123000, "meta": { "ok_count": 12, "fail_count": 1 }, "ext_version": "0.8.0" }
    ],
    "count": 3,
    "truncated_from": 3
  },
  "environment": {
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128.0.0.0",
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
    "deny_list_alerted": {},
    "telemetry_overflow_total": 0,
    "telemetry_opt_out": false,
    "active_run_id": null
  }
}
```

- [ ] **Step 2: Create `SupportBundle.jsx`**

```jsx
// src/pages/admin/SupportBundle.jsx
// /admin/support — upload an Ext.8 diagnostic bundle, see parsed JSON,
// and see the matching exports row side-by-side. Stateless on the
// server (no DB writes); this page is also stateless across reloads
// (no caching — re-upload to see again). See WebApp.4 plan for scope.

import { useState } from 'react'
import { apiGet } from '../../hooks/useApi.js'
import { StatusBadge, EventBadge, formatTimestamp } from './_helpers.jsx'

// Where the parse endpoint lives. Mirrors apiGet's base-URL resolution.
const API_BASE = import.meta.env.VITE_API_URL || '/api'

export default function SupportBundle() {
  const [bundle, setBundle] = useState(null)          // parsed-bundle JSON (from /parse) or null
  const [error, setError] = useState(null)            // { error, ...detail } or string
  const [uploading, setUploading] = useState(false)
  const [correlatedExport, setCorrelatedExport] = useState(null)  // { export, events } or null
  const [correlationError, setCorrelationError] = useState(null)

  async function handleFile(file) {
    setUploading(true); setError(null); setBundle(null); setCorrelatedExport(null); setCorrelationError(null)
    try {
      // Get Supabase auth header (same pattern as apiGet internals).
      const headers = { 'Content-Type': 'application/zip' }
      // (Use whatever helper exists to inject the Supabase JWT; mirror apiGet.)

      const res = await fetch(`${API_BASE}/admin/support-bundles/parse`, { method: 'POST', body: file, headers })
      const data = await res.json().catch(() => ({ error: 'non_json_response' }))
      if (!res.ok) { setError({ status: res.status, ...data }); return }
      setBundle(data)

      // Correlate with exports table (Q2 logic).
      const runs = data?.queue?.runs || []
      if (runs.length > 0) {
        // Most-recent run by updated_at.
        const run = runs.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]
        try {
          const events = await apiGet(`/admin/exports/${encodeURIComponent(run.run_id)}/events`)
          setCorrelatedExport(events)
        } catch (e) {
          setCorrelationError(e?.message || 'no_match')
        }
      }
    } catch (e) {
      setError({ message: e?.message || 'upload_failed' })
    } finally {
      setUploading(false)
    }
  }

  const isUnsupportedVersion = error?.error === 'unsupported_bundle_version'

  return (
    <div className="p-6 text-zinc-200">
      <h1 className="text-xl font-semibold mb-4">Support Diagnostics</h1>

      <UploadForm onFile={handleFile} uploading={uploading} />

      {/* Error banner (distinguish 422 unsupported from other errors) */}
      {isUnsupportedVersion && (
        <div className="mt-4 p-3 border border-amber-800 bg-amber-950/40 rounded text-sm">
          <div className="font-medium text-amber-300">Unsupported bundle version</div>
          <div className="mt-1 text-amber-200/80">
            This admin UI only supports schema_version ∈ {JSON.stringify(error?.supported_versions || [1])}.
            Bundle reports schema_version = {JSON.stringify(error?.got)}. Ask the user to update the extension.
          </div>
        </div>
      )}
      {error && !isUnsupportedVersion && (
        <div className="mt-4 p-3 border border-red-800 bg-red-950/40 rounded text-sm">
          <div className="font-medium text-red-300">{error.error || 'Error'}</div>
          {error.missing && <div className="text-red-200/80">Missing file: {error.missing}</div>}
          {error.file && <div className="text-red-200/80">Problem in: {error.file}</div>}
          {error.field && <div className="text-red-200/80">Problem field: {error.field}</div>}
          {error.message && <div className="text-red-200/80">{error.message}</div>}
        </div>
      )}

      {bundle && (
        <div className="mt-6 grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div>
            <BundleMeta meta={bundle.meta} />
            <BundleQueue queue={bundle.queue} />
            <BundleEvents events={bundle.events?.events || []} />
            <BundleEnvironment environment={bundle.environment} />
          </div>
          <div>
            <CorrelatedExportPanel
              runs={bundle.queue?.runs || []}
              correlated={correlatedExport}
              error={correlationError}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function UploadForm({ onFile, uploading }) {
  return (
    <label className="block cursor-pointer">
      <input
        type="file"
        accept=".zip,application/zip"
        disabled={uploading}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }}
        className="block text-sm"
      />
      {uploading && <span className="ml-3 text-xs text-zinc-500">Parsing bundle…</span>}
    </label>
  )
}

function BundleMeta({ meta }) {
  if (!meta) return null
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Bundle Meta</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 text-xs">
        <dt className="text-zinc-500">schema_version</dt><dd>{meta.schema_version}</dd>
        <dt className="text-zinc-500">ext_version</dt><dd>{meta.ext_version}</dd>
        <dt className="text-zinc-500">generated_at</dt><dd>{meta.generated_at}</dd>
        <dt className="text-zinc-500">browser_family</dt><dd>{meta.browser_family || '—'}</dd>
      </dl>
    </section>
  )
}

function BundleQueue({ queue }) {
  const runs = queue?.runs || []
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Queue State ({runs.length} runs)</h2>
      {/* table: run_id | phase | ok | fail | items | updated_at  — uses StatusBadge for phase */}
    </section>
  )
}

function BundleEvents({ events }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Last {events.length} Events</h2>
      {/* table: ts | event (EventBadge) | export_id | meta JSON */}
    </section>
  )
}

function BundleEnvironment({ environment }) {
  if (!environment) return null
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Environment</h2>
      {/* user_agent, platform, cookie_presence booleans, jwt_presence booleans,
          deny_list counts, daily_counts, telemetry_overflow_total, telemetry_opt_out */}
    </section>
  )
}

function CorrelatedExportPanel({ runs, correlated, error }) {
  if (runs.length === 0) {
    return <EmptyPanel title="Correlated export" message="No run IDs in bundle — nothing to correlate." />
  }
  if (error) {
    return <EmptyPanel title="Correlated export" message={`No matching export record (run_id ${runs[0]?.run_id}).`} />
  }
  if (!correlated) return null
  const ex = correlated.export
  const events = correlated.events || []
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">Correlated Export (DB)</h2>
      {/* Summary: id, user_id, status (StatusBadge), created_at, completed_at, folder_path */}
      {/* Timeline: same render as ExportDetail.jsx's events table (reuses EventBadge + formatTimestamp) */}
    </section>
  )
}

function EmptyPanel({ title, message }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-2">{title}</h2>
      <div className="text-xs text-zinc-500 p-3 border border-zinc-800 rounded">{message}</div>
    </section>
  )
}
```

- [ ] **Step 3: Create smoke tests**

```jsx
// src/pages/admin/__tests__/SupportBundle.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// Mock apiGet (for the correlation call).
vi.mock('../../../hooks/useApi.js', () => ({
  apiGet: vi.fn(),
}))
import { apiGet } from '../../../hooks/useApi.js'

import fixture from './fixtures/sample-bundle-v1.json' assert { type: 'json' }
import SupportBundle from '../SupportBundle.jsx'

describe('<SupportBundle />', () => {
  let root, container, originalFetch

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
  })

  it('renders upload form on mount', async () => {
    await act(async () => { root.render(<SupportBundle />) })
    expect(container.querySelector('input[type="file"]')).not.toBeNull()
  })

  it('renders all four sections after a successful parse', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixture,
    })
    vi.mocked(apiGet).mockResolvedValue({ export: { id: '01EXPORTABCD', status: 'complete' }, events: [] })

    await act(async () => { root.render(<SupportBundle />) })
    const input = container.querySelector('input[type="file"]')
    const file = new File([new Uint8Array([1])], 'bundle.zip', { type: 'application/zip' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // Four section headings:
    const html = container.innerHTML
    expect(html).toMatch(/Bundle Meta/)
    expect(html).toMatch(/Queue State/)
    expect(html).toMatch(/Events/)
    expect(html).toMatch(/Environment/)
  })

  it('renders unsupported-version banner on 422', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: 'unsupported_bundle_version', supported_versions: [1], got: 2 }),
    })

    await act(async () => { root.render(<SupportBundle />) })
    const input = container.querySelector('input[type="file"]')
    const file = new File([new Uint8Array([1])], 'v2.zip', { type: 'application/zip' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.innerHTML).toMatch(/Unsupported bundle version/)
  })
})
```

- [ ] **Step 4: Run the new component test**

```bash
cd "$WT"
npm run test -- --run src/pages/admin/__tests__/SupportBundle.test.jsx 2>&1 | tail -10
# Expected: 3 passed.
```

- [ ] **Step 5: Full suite**

```bash
cd "$WT"
npm run test 2>&1 | tail -5
# Expected: Tests ~112 passed (~112)
```

- [ ] **Step 6: Commit**

```bash
cd "$WT"
git add src/pages/admin/SupportBundle.jsx src/pages/admin/__tests__/SupportBundle.test.jsx src/pages/admin/__tests__/fixtures/sample-bundle-v1.json
git diff --cached --stat
git commit -m "$(cat <<'EOF'
feat(admin): /admin/support — upload + parse + correlate bundle page

Upload form + four-section bundle display (meta/queue/events/environment),
plus correlated exports row side-by-side via WebApp.3's existing
/admin/exports/:id/events endpoint. Reuses StatusBadge/EventBadge/
formatTimestamp from src/pages/admin/_helpers.jsx.

Graceful states: no run_id in bundle, no match in DB, unsupported
schema_version (422 → distinct banner). Stateless across reloads.

Happy-dom smoke tests cover upload form mount, four-section render on
success, unsupported-version banner on 422.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Router + AdminLayout wiring

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/components/layouts/AdminLayout.jsx`

- [ ] **Step 1: Wire the `/admin/support` route in `App.jsx`**

Add the import near the existing `ExportsList` / `ExportDetail` imports:

```jsx
import SupportBundle from './pages/admin/SupportBundle.jsx'
```

Add the route entry immediately after the existing `<Route path="exports/:id" ... />`:

```jsx
<Route path="support" element={<SupportBundle />} />
```

- [ ] **Step 2: Add the `Support` nav entry in `AdminLayout.jsx`**

Extend the lucide import:

```jsx
import { Database, Video, FlaskConical, LayoutDashboard, DollarSign, Play, Film, Key, ScrollText, Cpu, Download, LifeBuoy } from 'lucide-react'
```

Add the navItems entry immediately after the existing `Exports` entry:

```jsx
{ to: '/admin/support', icon: LifeBuoy, label: 'Support' },
```

- [ ] **Step 3: Boot once to eyeball** (optional if `:3001` already running)

```bash
cd "$WT"
npm run dev -- --port 5174 &  # pick a non-3001 port if :3001 is busy; do NOT kill anything on :3001
DEV_PID=$!
sleep 4
curl -s http://localhost:5174/admin/support -o /dev/null -w "%{http_code}\n"
# Expected: 200 (SPA serves the index.html for any /admin/* path).
kill $DEV_PID 2>/dev/null
```

- [ ] **Step 4: Full test suite still green**

```bash
cd "$WT"
npm run test 2>&1 | tail -5
# Expected: Tests ~112 passed (~112). No regression from wiring.
```

- [ ] **Step 5: Commit**

```bash
cd "$WT"
git add src/App.jsx src/components/layouts/AdminLayout.jsx
git diff --cached --stat
git commit -m "$(cat <<'EOF'
feat(admin): wire /admin/support route + AdminLayout nav

Adds <Route path="support"> to the /admin nested Routes and a
Support nav entry (LifeBuoy icon) to AdminLayout.navItems,
positioned immediately after Exports.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual smoke (no commit)

The goal of this task is an end-to-end sanity check with a real bundle. Nothing is committed.

- [ ] **Step 1: Produce a real diagnostic bundle (needs Ext.8 loaded in Chrome)**

- Load the unpacked extension at `extension/` into `chrome://extensions` (dev mode).
- Open `extension-test.html` in Chrome (via the extension test harness).
- Trigger a short export run if `queue.json` would be empty otherwise (one Envato item is fine).
- Click the "Ext.8 Diagnostic bundle" button → save the `.zip` to Downloads.

- [ ] **Step 2: Start the backend if not running**

```bash
# If :3001 is already running the user's dev server, skip — do NOT kill it.
cd "$WT"
lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1 && echo "3001 already up — reuse" || { echo "starting backend"; npm run server & }
```

- [ ] **Step 3: Start the Vite dev server on 5174**

```bash
cd "$WT"
npm run dev -- --port 5174 &
DEV_PID=$!
sleep 4
```

- [ ] **Step 4: Navigate + upload**

- Open `http://localhost:5174/admin/support` in a browser logged in as an admin user.
- Click the file input, choose the `.zip` from Step 1.
- Verify all four sections render: Bundle Meta, Queue State, Events, Environment.
- Verify the right pane: either "Correlated Export (DB)" with the exports row + timeline, OR "No matching export record" if the local DB has no matching run.

- [ ] **Step 5: Negative smokes**

- Upload a random non-ZIP file (e.g. a `.txt` renamed `.zip`) → expect `invalid_zip` 400.
- Manually edit the bundle's `meta.json` to `schema_version: 2`, re-zip, upload → expect the "Unsupported bundle version" banner.
- Upload an empty file → expect `missing_zip_body` 400.

- [ ] **Step 6: Teardown**

```bash
kill $DEV_PID 2>/dev/null
# Do NOT kill :3001 if it was already up before Step 2.
```

- [ ] **Step 7: No commit.** If any smoke failed, open a follow-up task; do NOT amend prior commits.

---

## Appendix: End-state smoke summary (copy to a PR description if you open one)

- `POST /api/admin/support-bundles/parse` is mounted; returns parsed JSON for v1 bundles; returns documented error codes otherwise.
- Stateless: `git grep -n "INSERT INTO support" server/` returns zero matches; `git grep -n "fs.writeFile\|fs.writeFileSync" server/routes/admin/support-bundles.js server/services/bundle-parser.js` returns zero matches.
- Schema v1 only; 422 response includes `supported_versions: [1]`.
- `/admin/support` renders 4 sections + correlated export; no JS errors in DevTools.
- Unsupported-version banner renders distinctly from other errors.
- `StatusBadge`/`EventBadge`/`formatTimestamp` imported from `_helpers.jsx`; duplicated nowhere.
- Auth: 401 when unauthenticated, 403 when non-admin, 200 when admin.
- Tests: ~16 new tests (7 parser + 6 route + 3 component); vitest ~112/112 green.
- Read-only; no new DB columns, no new migrations, no extension changes.
