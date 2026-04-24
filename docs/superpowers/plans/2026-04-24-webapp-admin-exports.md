# WebApp.3 — /admin/exports Observability UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin operator read-only visibility into the export pipeline per the master UX spec Phase 9 ("Admin UI") and the remaining-roadmap WebApp.3 phase. Ship `/admin/exports` (paginated list with failures-only + per-user + date filters) and `/admin/exports/:id` (summary row + per-event timeline + failure-rate aggregate) by adding two new admin-authed read routes and two new admin pages. Nothing else.

**Architecture:** Phase 1's `exports` + `export_events` tables (already shipped in `server/schema-pg.sql` lines 320-354) are the single source of truth — they're already written by the extension's telemetry stream (Ext.6) through `POST /api/export-events` and by `createExport`. The new work is two `GET` endpoints on a NEW `server/routes/admin/exports.js` router mounted at `/api/admin/exports`, consumed by two NEW React Router pages under the existing `/admin` AdminLayout (`src/App.jsx` lines 185-200). The pages are read-only renderers — no retry, no cancel, no delete. Auth reuses the existing `isAdmin(req)` check from `server/auth.js` behind `requireAuth + requireAdmin` middleware exactly the way `server/routes/admin.js` already does.

**Tech stack:** React 19 + React Router v7 (already in `package.json`), Tailwind (already used across `src/components/views/*`), `useApi` + `apiGet` from `src/hooks/useApi.js` (already shipped, Supabase-JWT aware), Postgres via `server/db.js` (already wired, same driver as every other admin route), vitest 1.6.x with dual-env workspace (`vitest.workspace.js`, already green at 50/50 on `main`). No new runtime deps. **Possibly no new dev deps either** — see open question #4.

---

## Open questions for the user

Flag these BEFORE drafting any file. The executor must wait on your call on each.

1. **Pagination strategy — offset or cursor?** Default recommendation: **offset with page size 50** (matches `server/routes/admin.js` lines 99-121 `/api-logs` and lines 131-144 `/broll-searches` — both use `limit/offset` with `Math.min(parseInt(req.query.limit) || 50, 200)` and `parseInt(req.query.offset) || 0`). Cursor pagination buys deterministic paging under heavy write, but at MVP scale the exports table will have dozens of rows per user. Match the existing admin pattern.

2. **Aggregate failure rates — query-time on each page load, or materialized view?** Default recommendation: **query-time**. Small table at MVP scale (tens to low-hundreds of rows). Running a `SELECT error_code, source, COUNT(*) ... GROUP BY` on every ExportDetail open is sub-millisecond. A materialized view is premature optimization; revisit if the table crosses 100k rows.

3. **Date filtering default window — 7 days or 30 days?** Default recommendation: **7 days**. The admin is looking for recent failure patterns (this is exactly what Phase 9 of the design spec motivates — "aggregate failure rate by source, by error_code, over time"); a week is the reasonable blast radius. 30 days is too broad for day-to-day debugging and makes pagination worse. The filter UI should still let the operator override to 30 or 90.

4. **New dev dependency approval — do we add React Testing Library?** The existing `src/hooks/__tests__/useExportXmlKickoff.test.js` (shipped in State E) uses bare `React.createElement` + `createRoot` + `act` — **no RTL**. Default recommendation: **don't add RTL**. Mirror the existing web-side test pattern (bare React + happy-dom + `vi.fn()` stubs for `apiGet`). Less devDep surface, and the admin pages are simple rendering — a spy on `apiGet` + a bare `createRoot` mount is enough to assert "row count from fixture shows up in the DOM." If you want RTL for richer query-by-role / user-event semantics, flag yes and the executor will add `@testing-library/react` + `@testing-library/dom` in Task 0.

5. **Admin auth model — stick with `ADMIN_EMAILS` list, or pivot to Supabase role-based?** Roadmap open question #4 (remaining-roadmap.md). Default recommendation: **stick with `ADMIN_EMAILS`** for WebApp.3. `isAdmin(req)` already checks BOTH `ADMIN_EMAILS` and `app_metadata.role === 'admin'` (`server/auth.js` lines 56-61), so operators who want role-based already have it; this plan doesn't need to re-plumb. Role-based becomes a separate plan when multiple admins exist, which is not today.

6. **Gap check: does `exports` have a server-stamped `error_summary` column or a cached `status` aggregate?** Investigated: **no**. The `exports` table (`server/schema-pg.sql` lines 320-334) has `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','failed','partial'))` but Phase 1 only writes this via `recordExportEvent` on `export_completed` / etc. There is no per-export `error_code` summary column — the list page will need to JOIN + aggregate `export_events` to show "failed items: 3" per row. This is fine for MVP; flag this if the user wants a denormalized column added (would require a Phase 1 migration, **out of WebApp.3 scope**). Default recommendation: **no schema change**. The list query will `LEFT JOIN (SELECT export_id, COUNT(*) FROM export_events WHERE event='item_failed' GROUP BY export_id)` to compute the failure count per row.

---

## Why read this before touching code

Eight numbered invariants. Skipping any of them reopens a door the next run will walk through.

**1. Every admin route MUST compose `requireAuth + requireAdmin`, in that order — Express middleware ordering is not optional.** The existing pattern in `server/routes/admin.js` lines 9-14 + 54 is `router.get('/keys', requireAuth, requireAdmin, (req, res) => {...})`. `attachAuth` runs as app-level middleware (`server/index.js` line 44) and sets `req.auth`; `requireAuth` returns 401 if it's absent; `requireAdmin` returns 403 if `isAdmin(req)` is false. Do NOT put the check at the router-level `.use()` — `requireAuth` short-circuits on missing auth and must run per-handler to emit the right status code. Every handler in the new router repeats this triplet explicitly.

**2. WebApp.3 is read-only.** No `POST`, no `DELETE`, no `PATCH` on the new admin routes. Retry/cancel/delete are explicitly deferred to future phases. An executor adding a `DELETE /api/admin/exports/:id` here has exceeded scope — stop, flag, and back it out.

**3. Event timeline queries MUST order by `t ASC` so the `idx_export_events_export(export_id, t)` composite index is used.** That index (`server/schema-pg.sql` line 352) is the only thing keeping the per-export timeline cheap. `SELECT * FROM export_events WHERE export_id = ? ORDER BY t ASC` hits it; any other ordering (e.g., `ORDER BY received_at`) forces a sort. Don't use `received_at` as the primary sort — that's the server-stamp for clock-skew triage only.

**4. The list page's pagination contract matches the existing admin routes.** Query params: `?limit=50&offset=0&failures_only=true&user_id=<uuid>&since=<iso>&until=<iso>`. Response shape: `{ exports: [...], total: <int>, limit, offset }`. This is identical to `/api/admin/api-logs` (lines 99-121) and `/api/admin/broll-searches` (lines 131-144). Stay consistent.

**5. `failures_only=true` filters on `status IN ('failed','partial')` AT THE LIST LEVEL — not on per-event `event='item_failed'`.** The former is what the Phase 9 spec asks for ("Filter: failures-only"), the latter is a UX footgun (a single failed item inside an otherwise-ok run is noise for the operator's first-pass triage). Per-event failure drill-down lives on the Detail page.

**6. `variant_labels` and `manifest_json` are stored as TEXT, not JSONB, in `server/schema-pg.sql`.** Any query that wants to filter by variant count must `JSON.parse` server-side after `SELECT`, or use `jsonb`-specific operators if/when the column is migrated — WebApp.3 does NOT migrate. The list page simply renders the raw `variant_labels` TEXT (a JSON array string like `["A","C"]`) for operator inspection; parsing happens in the React layer for display.

**7. Component tests hit the `happy-dom` env per `vitest.workspace.js`; server tests hit `node` env — don't cross the streams.** The workspace file (committed in Week 4, see `vitest.workspace.js`) routes `server/**/__tests__/**/*.test.js` to the node project and `src/**/__tests__/**/*.test.{js,jsx}` to happy-dom. Placing a server route test under `src/` will fail with `req is not defined`; placing a React component test under `server/` will fail with `document is not defined`. Follow the precedent: `server/services/__tests__/exports.test.js` (node) and `src/hooks/__tests__/useExportXmlKickoff.test.js` (happy-dom) are the two patterns to copy.

**8. The admin pages live at `src/pages/admin/*.jsx`, NOT under `src/components/views/*.jsx`.** This is a deliberate deviation from the existing `src/components/views/BRollRunsView.jsx` precedent: the roadmap's `Files:` section at `docs/specs/2026-04-24-export-remaining-roadmap.md:455` pins `src/pages/admin/ExportsList.jsx`, `src/pages/admin/ExportDetail.jsx`. The one prior file under `src/pages/` (`src/pages/ExportPage.jsx`) establishes `pages/` as the home for route-mounted top-level screens. The `components/views/*` files are legacy admin CMS views; `pages/admin/*` is the correct new home. Don't dump these into `components/views/` just because that's where the neighbors live.

---

## Scope (WebApp.3 only — hold the line)

### In scope

- `server/routes/admin/exports.js` **[NEW]** — a new Express router exporting two handlers: `GET /` (list) and `GET /:id/events` (timeline). Mounted at `/api/admin/exports` in `server/index.js`. Composed with `requireAuth + requireAdmin + db` — zero new service modules, zero new service exports. The SQL is short enough to live inline in the route file, matching the existing `server/routes/admin.js` pattern.
- `server/routes/admin/__tests__/exports.test.js` **[NEW]** — vitest unit tests for the two route handlers. Uses `vi.mock('../../../db.js')` with a scripted-response fake, mirroring `server/services/__tests__/exports.test.js`. Covers: admin allow, non-admin 403, unauthenticated 401, pagination math, failures-only filter, date-range filter, per-user filter, timeline ordering by `t ASC`, per-item failure-count LEFT JOIN.
- `src/pages/admin/ExportsList.jsx` **[NEW]** — paginated list view. Filters: failures-only toggle, user_id text input, date range (since/until). Uses `apiGet('/admin/exports?...')` via `useApi`. Renders a `<table>` in the existing admin style (copy border/color classes from `src/components/views/BRollRunsView.jsx`). Each row is a `<Link to={`/admin/exports/${id}`}>`.
- `src/pages/admin/ExportDetail.jsx` **[NEW]** — per-export detail. Summary card at the top (id, user_id, plan_pipeline_id, variant_labels, status, created_at, completed_at, folder_path), then a timeline table of events from `/admin/exports/:id/events`, then a per-source / per-error_code failure-rate aggregate (query-time, computed in the route response).
- `src/pages/admin/__tests__/ExportsList.test.jsx` **[NEW]** — happy-dom smoke test. Stubs `apiGet` with a fixture of 3 export rows, mounts the page, asserts all 3 row `id`s are in the DOM.
- `src/pages/admin/__tests__/ExportDetail.test.jsx` **[NEW]** — happy-dom smoke test. Stubs `apiGet` with a fixture export + 5 events, mounts the page, asserts timeline rows appear in order.
- `src/App.jsx` **[MOD]** — add two `<Route>` entries inside the `/admin` nested Routes block: `<Route path="exports" element={<ExportsList />} />` and `<Route path="exports/:id" element={<ExportDetail />} />`. Add two imports at the top.
- `src/components/layouts/AdminLayout.jsx` **[MOD]** — add one navItems entry: `{ to: '/admin/exports', icon: Download, label: 'Exports' }` (lucide-react `Download` icon, already a peer of `Video`, `Key`, etc. in the existing import). Position: after `GPU Pipeline`, before nothing — this is the new last nav item.
- `server/index.js` **[MOD]** — register the new router: `import adminExportsRouter from './routes/admin/exports.js'` + `app.use('/api/admin/exports', adminExportsRouter)`.

### Deferred (DO NOT add)

- **`/admin/support` upload + bundle parser** — this is WebApp.4. No route, no page, no nav entry in this plan.
- **Admin authentication re-architecture** — flag in open question #5. Do NOT re-plumb auth. Do NOT add Supabase role-metadata sync code. Do NOT introduce a new `role` column.
- **Slack alert wiring for failures on admin pages** — already shipped in Phase 1 backend (`server/services/slack-notifier.js`, notified by `recordExportEvent`). Admin pages are read-only. Do NOT re-wire any `notify()` call from the admin route file. Do NOT add a "send test alert" button (the one in `server/routes/admin.js:162` already exists).
- **New schema columns or migrations** — `exports` + `export_events` tables exist and carry what's needed. If a column is genuinely missing for the UI, flag as an open question BEFORE touching schema. Specifically: the UI does NOT need a new denormalized `error_code_summary` column on `exports` — the list route will compute it via LEFT JOIN.
- **Retention / DSAR delete endpoints** (main spec Phase 10) — deferred entirely.
- **Extension/backend changes** — this phase is web + server-route only. Do NOT modify `extension/**` or `server/services/exports.js` or `server/services/slack-notifier.js`.
- **Write routes** — retry failed item, cancel in-progress, delete failed — all deferred. Even `PATCH /status` to force-close a stuck `in_progress` row is deferred; the admin can manually update via DB for now.
- **Realtime updates** — no Server-Sent Events, no WebSocket, no polling loop on the detail page. Operator clicks refresh. Keep MVP simple.
- **Charts** — no `chart.js`, no `recharts`, no sparklines. Failure-rate aggregates are rendered as a plain table. If the user wants charts, that's a separate plan.

---

## Prerequisites

- Node 20+ (already used).
- Local branch `main` has Phase 1 merged (`exports`, `export_events` tables in `server/schema-pg.sql`), Ext.6 merged (telemetry write path), and Week 4 State E + test harness merged (dual-env `vitest.workspace.js`). Verify by: `git log --oneline main | head -15` should show recent `feat(export)` / `feat(ext)` commits.
- `npm install` up to date. `npm run test` on `main` must be 50/50 green before branching (baseline invariant — don't build on a broken baseline).
- Backend running on `localhost:3001` for the manual smoke task (Task 9); `:3001` must be the user's dev-server port. **Do NOT kill anything on :3001** — if the port is in use, either reuse that server or skip the smoke.
- Path quoting: `/Users/laurynas/Desktop/one last /transcript-eval/` — trailing space in `one last `. Quote every shell path.
- At least one `exports` row in the local DB owned by `silvestras.stonk@gmail.com` with ≥1 `export_events` row. The Week 4 State E smoke run should have produced this; if not, skip to Task 9's "run the extension once to populate" sub-step.

---

## File structure (WebApp.3 final state)

All paths are inside `$TE` where `TE="/Users/laurynas/Desktop/one last /transcript-eval"`.

```
$TE/server/
├── routes/
│   ├── admin.js                                   UNCHANGED — prior admin routes stay
│   └── admin/
│       ├── exports.js                             NEW — GET / + GET /:id/events
│       └── __tests__/
│           └── exports.test.js                    NEW — 9+ unit tests (auth, pagination, filters)
└── index.js                                       MODIFIED — +import + +app.use('/api/admin/exports', ...)

$TE/src/
├── pages/
│   ├── ExportPage.jsx                             UNCHANGED
│   └── admin/
│       ├── ExportsList.jsx                        NEW — paginated list + filters
│       ├── ExportDetail.jsx                       NEW — summary + timeline + aggregates
│       └── __tests__/
│           ├── ExportsList.test.jsx               NEW — happy-dom smoke
│           └── ExportDetail.test.jsx              NEW — happy-dom smoke
├── components/
│   └── layouts/
│       └── AdminLayout.jsx                        MODIFIED — +navItems entry
└── App.jsx                                        MODIFIED — +2 route entries + 2 imports

$TE/docs/superpowers/plans/
└── 2026-04-24-webapp-admin-exports.md             THIS FILE
```

**Why this split:**
- Routes nest under `server/routes/admin/` (new subdir) rather than extending `server/routes/admin.js`. The existing `admin.js` already carries API keys + API logs + broll search admin + GPU test-alert — adding exports would push it past 250 lines of grab-bag. A feature-scoped file under `routes/admin/exports.js` keeps the next phase's `/admin/support` (WebApp.4) clean to add at `routes/admin/support.js`.
- The `server/routes/admin/__tests__/exports.test.js` path matches vitest's `server/**/__tests__/**/*.test.js` include pattern verbatim; no workspace.js change needed.
- Pages live at `src/pages/admin/*.jsx`. The existing `src/pages/ExportPage.jsx` establishes `pages/` as the home for route-mounted screens; this plan adds the first `pages/admin/` subdir, reserving it for future `pages/admin/support/` etc. (WebApp.4). See invariant #8 above.
- Component smoke tests live alongside as `src/pages/admin/__tests__/*.test.jsx` matching the `src/**/__tests__/**/*.test.{js,jsx}` include pattern in `vitest.workspace.js`.

---

## Working conventions for these tasks

- **Branch:** `feature/webapp-admin-exports`, created on the worktree (NOT in the user's current working directory — the dirty tree at `git status` must be left alone).
- **Worktree path:** `.worktrees/webapp-admin-exports` off the repo root. Use `git worktree add -b feature/webapp-admin-exports .worktrees/webapp-admin-exports main`. All subsequent work happens inside the worktree. See superpowers:using-git-worktrees.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval. Task 9 (manual smoke) does not push.
- **Never kill anything on :3001.** The user's dev server may be running. Tests don't need the backend; the manual smoke assumes the backend is already up.
- **Leave the user's dirty tree alone.** The following files are modified/untracked on `main` and MUST NOT be touched by any task in this plan: `server/routes/gpu.js`, `server/services/gpu-failure-poller.js`, `check_placement.js`, `final_query*.js`, `query_*.js`, `server/db.sqlite`, `server/seed/update-*.js`, `docs/plans/2026-04-22-reset-broll-searches.md`, `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md`.
- **Never modify `~/.git` or git config.** Never use destructive git ops (`reset --hard`, `push --force`, `clean -fd`, etc.). Never amend — every task commits NEW.
- **Commit style:** conventional commits (`feat(admin)`, `test(admin)`, `refactor(admin)`). One commit per task. Add the Claude co-author trailer at the end of every commit message:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"`. Unquoted paths silently break on the trailing space.
- **Auth check is non-negotiable.** Every handler in the new router MUST use `requireAuth, requireAdmin` explicitly. Any PR that omits one fails review.
- **Read-only.** No `router.post`, no `router.delete`, no `router.patch` in the new file. See invariant #2.

---

## Task 0: Create worktree + branch + scaffold commit

**Files:**
- Verify: `$TE/docs/superpowers/plans/2026-04-24-webapp-admin-exports.md` (this file)
- Create: git worktree at `$TE/.worktrees/webapp-admin-exports` on new branch `feature/webapp-admin-exports`

- [ ] **Step 1: From the main repo, create the worktree off local `main`**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git status --short
# Expected: shows the known dirty tree (gpu.js mods + untracked query_*.js files etc.).
# CRITICAL: do NOT try to clean or stash these. They're the user's unrelated work.
git fetch origin main 2>/dev/null || echo "No remote; continuing with local main"
git worktree add -b feature/webapp-admin-exports "$TE/.worktrees/webapp-admin-exports" main
# Expected: "Preparing worktree (new branch 'feature/webapp-admin-exports')"
#           "HEAD is now at <sha> ..."
git worktree list
# Expected: two entries, one at $TE on main (or prior branch), one at .worktrees/webapp-admin-exports
```

- [ ] **Step 2: Switch to the worktree for ALL subsequent tasks**

```bash
WT="/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/webapp-admin-exports"
cd "$WT"
git branch --show-current
# Expected: feature/webapp-admin-exports
git status --short
# Expected: clean tree (the dirty files live in $TE, not $WT)
```

From this point on, every `cd` in this plan uses `$WT`. The original `$TE` is left untouched.

- [ ] **Step 3: Sanity-check the in-tree files we'll modify/reference**

```bash
cd "$WT"
test -f server/auth.js && grep -q "export function isAdmin" server/auth.js && echo "auth: OK" || echo "MISSING auth"
test -f server/routes/admin.js && grep -q "requireAdmin" server/routes/admin.js && echo "admin-pattern: OK" || echo "MISSING pattern"
test -f server/schema-pg.sql && grep -q "CREATE TABLE IF NOT EXISTS exports" server/schema-pg.sql && echo "schema: OK" || echo "MISSING schema"
test -f server/schema-pg.sql && grep -q "CREATE TABLE IF NOT EXISTS export_events" server/schema-pg.sql && echo "events: OK" || echo "MISSING events"
test -f src/App.jsx && grep -q 'path="/admin"' src/App.jsx && echo "router: OK" || echo "MISSING router"
test -f src/components/layouts/AdminLayout.jsx && echo "admin-layout: OK" || echo "MISSING layout"
test -f src/hooks/useApi.js && grep -q "export async function apiGet" src/hooks/useApi.js && echo "useApi: OK" || echo "MISSING useApi"
test -f vitest.workspace.js && echo "vitest-workspace: OK" || echo "MISSING vitest-workspace"
# Expected: every line "OK". If any "MISSING", the base branch isn't what we think.
```

- [ ] **Step 4: Run the existing test suite — baseline must pass (50/50 per memory)**

```bash
cd "$WT"
npm run test 2>&1 | tail -10
# Expected tail:
#   Test Files  X passed (X)
#   Tests       50 passed (50)
# If this fails, STOP. The executor must not build on a broken baseline.
```

- [ ] **Step 5: Confirm this plan file is at the expected path, then commit**

```bash
cd "$WT"
test -f docs/superpowers/plans/2026-04-24-webapp-admin-exports.md && echo OK || echo "MISSING plan"
# Expected: OK (committed to main before the worktree was made, carries through)
git status --short
# Expected: empty (plan was in main already)
```

If the plan file is not yet on `main` (you wrote it after branching), stage and commit it:

```bash
git add docs/superpowers/plans/2026-04-24-webapp-admin-exports.md
git diff --cached --stat
git commit -m "$(cat <<'EOF'
docs(plan): WebApp.3 /admin/exports observability UI

Ships read-only admin list + detail pages over Phase 1's exports +
export_events tables. Two new read routes under a new
server/routes/admin/exports.js, two new pages under src/pages/admin/,
router wiring in App.jsx, one navItems entry in AdminLayout.

Auth reuses isAdmin + requireAuth + requireAdmin (the existing
server/routes/admin.js pattern). No schema change. No write routes.
No Slack re-wiring (shipped in Phase 1). Read-only.

Explicit non-goals: /admin/support (WebApp.4), admin auth
re-plumb, retention/DSAR endpoints, realtime updates, charts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -3
# Expected: top line is the plan commit; second is the merge of State E; third earlier.
```

---

## Task 1: Schema + query probe (no code yet — document findings)

Before writing any route, confirm (a) exactly what columns `exports` and `export_events` carry, (b) which index supports each query, (c) whether the local DB is Postgres or SQLite (the project carries both — see `server/schema.sql` vs `server/schema-pg.sql`). Document findings in a scratch comment block we'll delete at the end of the task. No commit if nothing changes besides the plan's own scratch notes.

**Files:**
- Read-only probes. No file modified.

- [ ] **Step 1: Confirm schema file parity (pg vs sqlite)**

```bash
cd "$WT"
# Does both schema files carry exports + export_events?
grep -n "CREATE TABLE IF NOT EXISTS exports\b" server/schema.sql server/schema-pg.sql 2>/dev/null
grep -n "CREATE TABLE IF NOT EXISTS export_events\b" server/schema.sql server/schema-pg.sql 2>/dev/null
# Expected: both tables in schema-pg.sql. schema.sql may or may not carry them
# (sqlite is legacy). The prod backend is Postgres — trust schema-pg.sql.
```

- [ ] **Step 2: Enumerate the exact column set**

```bash
cd "$WT"
sed -n '/CREATE TABLE IF NOT EXISTS exports/,/);/p' server/schema-pg.sql
# Expected columns (per the plan's investigation):
#   id TEXT PRIMARY KEY                -- 'exp_<ulid>'
#   user_id TEXT                       -- nullable (legacy rows)
#   plan_pipeline_id TEXT NOT NULL
#   variant_labels TEXT NOT NULL       -- JSON array as TEXT
#   status TEXT NOT NULL               -- 'pending'|'in_progress'|'complete'|'failed'|'partial'
#   manifest_json TEXT NOT NULL        -- full per-item manifest (heavy, don't SELECT on list)
#   result_json TEXT                   -- post-run shape (XMEML-ready) OR null
#   xml_paths TEXT                     -- JSON map "C" -> "variant-c.xml"
#   folder_path TEXT                   -- redacted absolute path
#   created_at TIMESTAMPTZ
#   completed_at TIMESTAMPTZ

sed -n '/CREATE TABLE IF NOT EXISTS export_events/,/);/p' server/schema-pg.sql
# Expected columns:
#   id BIGSERIAL PRIMARY KEY
#   export_id TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE
#   user_id TEXT
#   event TEXT NOT NULL                -- enum per design spec
#   item_id TEXT
#   source TEXT
#   phase TEXT
#   error_code TEXT
#   http_status INTEGER
#   retry_count INTEGER
#   meta_json TEXT
#   t BIGINT NOT NULL                  -- client epoch_ms
#   received_at BIGINT NOT NULL        -- server epoch_ms

grep -n "CREATE INDEX" server/schema-pg.sql | grep -E "exports|export_events"
# Expected indexes:
#   idx_exports_user_created    (user_id, created_at DESC)
#   idx_exports_pipeline        (plan_pipeline_id)
#   idx_export_events_export    (export_id, t)
#   idx_export_events_failures  (event, received_at) WHERE event IN (...)
```

- [ ] **Step 2b: Verify the design spec's event enum**

```bash
cd "$WT"
grep -nE "item_failed|rate_limit_hit|session_expired|export_started|item_resolved|item_licensed|item_downloaded|queue_paused|queue_resumed|export_completed" docs/specs/2026-04-23-envato-export-design.md | head -12
# Expected: all 10 events land at the "Event types" table.
# The enum for Slack alerting + UI badges in the admin pages.
```

- [ ] **Step 3: Decide the list-page columns**

The list route SELECTs these columns (NOT `manifest_json` — it's huge; NOT `result_json` — same; NOT `xml_paths` — render count only):

```
id, user_id, plan_pipeline_id, variant_labels, status,
folder_path, created_at, completed_at,
(SELECT COUNT(*) FROM export_events e WHERE e.export_id = exports.id AND e.event = 'item_failed') AS failed_count,
(SELECT COUNT(*) FROM export_events e WHERE e.export_id = exports.id AND e.event = 'item_downloaded') AS downloaded_count
```

The correlated subqueries let the DB use `idx_export_events_failures` + `idx_export_events_export` respectively. At MVP scale this is fine. If it measurably regresses (flag via the smoke in Task 9), replace with a single `LEFT JOIN (SELECT export_id, COUNT(*) FILTER (WHERE event='item_failed'), ... GROUP BY export_id) e ON e.export_id = exports.id`. Pg filter aggregates make this one pass. **Start simple; profile only if the user complains.**

- [ ] **Step 4: Decide the detail-page event response shape**

The timeline route SELECTs every column from `export_events WHERE export_id = ? ORDER BY t ASC`. The response shape is `{ export: {...exports-row...}, events: [{id, event, item_id, source, phase, error_code, http_status, retry_count, meta_json (parsed), t, received_at}, ...], aggregates: { by_source: {...}, by_error_code: {...}, fail_count, success_count } }`. The aggregates are computed in JS from the events array — no second query — since we've already paid for the events fetch.

- [ ] **Step 5: No commit this task**

This task is pure investigation. No files were changed; the findings are embedded above. Move to Task 2.

```bash
cd "$WT"
git status --short
# Expected: empty
```

---

## Task 2: Server route — `GET /api/admin/exports` (list)

Add the list handler in a new file. Keep SQL inline (matches existing `server/routes/admin.js` style). The entire file after this task should be ~120 lines.

**Files:**
- Create: `$WT/server/routes/admin/exports.js` (new dir + new file)
- Modify: `$WT/server/index.js` (add import + mount)

- [ ] **Step 1: Read the existing admin route pattern to copy**

Use `Read` on `server/routes/admin.js` lines 1-50 and 99-144. Note specifically:
- The `requireAdmin` local middleware (lines 9-14) — we'll re-declare it in our new file rather than export+import (small amount of duplication vs. a new `server/middleware/*` module; this keeps the change footprint minimal and WebApp.4 can extract later if a second file needs it).
- The pagination pattern at lines 99-121 (query parse, count query, response shape).
- The SQL style (`db.prepare('...').all(...)` / `.get()`).

- [ ] **Step 2: Create the file with just the list handler**

Use `Write` for this new file. Content:

```js
// server/routes/admin/exports.js
//
// Admin-only read routes over Phase 1's exports + export_events tables.
// Read-only by design (WebApp.3). No retry/cancel/delete.
//
// Mount: server/index.js → app.use('/api/admin/exports', router)
//
// Auth model: every handler composes `requireAuth + requireAdmin`.
// The middleware order matters — `requireAuth` short-circuits on missing
// auth and must run first to emit the correct 401. `requireAdmin`
// follows to emit 403 for authed-but-non-admin. Declared locally rather
// than sharing with server/routes/admin.js because the extraction into
// server/middleware/* is a follow-up once a second file needs it.
//
// Pagination: offset/limit matching /api/admin/api-logs. Max limit 200.
// Default 50. Consumer contract: { exports, total, limit, offset }.
//
// Date filters: `since` and `until` are ISO 8601. Omitted defaults apply
// per WebApp.3's open question #3 — the UI layer passes explicit
// `since` for the last 7 days; the server layer does not default.

import { Router } from 'express'
import { requireAuth, isAdmin } from '../../auth.js'
import db from '../../db.js'

const router = Router()

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// GET /api/admin/exports
//
// Query params (all optional):
//   ?limit=50&offset=0           pagination
//   ?failures_only=true          status IN ('failed','partial')
//   ?user_id=<uuid>              exact match
//   ?since=<iso>                 created_at >= ?
//   ?until=<iso>                 created_at <= ?
//
// Response 200: { exports: [...], total: <int>, limit, offset }
// Response 401: { error: 'Authentication required' }   (via requireAuth)
// Response 403: { error: 'Admin access required' }     (via requireAdmin)
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = parseInt(req.query.offset) || 0
    const failuresOnly = String(req.query.failures_only || '') === 'true'
    const userId = req.query.user_id || null
    const since = req.query.since || null
    const until = req.query.until || null

    const where = []
    const params = []
    if (failuresOnly) {
      where.push("status IN ('failed','partial')")
    }
    if (userId) {
      where.push('user_id = ?')
      params.push(userId)
    }
    if (since) {
      where.push('created_at >= ?')
      params.push(since)
    }
    if (until) {
      where.push('created_at <= ?')
      params.push(until)
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const listSql = `
      SELECT
        id, user_id, plan_pipeline_id, variant_labels, status,
        folder_path, created_at, completed_at,
        (SELECT COUNT(*) FROM export_events ev
           WHERE ev.export_id = exports.id AND ev.event = 'item_failed')     AS failed_count,
        (SELECT COUNT(*) FROM export_events ev
           WHERE ev.export_id = exports.id AND ev.event = 'item_downloaded') AS downloaded_count
      FROM exports
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `
    const rows = await db.prepare(listSql).all(...params, limit, offset)

    const countSql = `SELECT COUNT(*) AS total FROM exports ${whereClause}`
    const countRow = await db.prepare(countSql).get(...params)

    res.json({
      exports: rows,
      total: parseInt(countRow.total),
      limit,
      offset,
    })
  } catch (err) {
    next(err)
  }
})

export default router
```

- [ ] **Step 3: Mount the router in `server/index.js`**

Use `Edit`. Two changes: the import line and the mount.

Import edit — match on the `exportsRouter` import line (unique):

`old_string`:
```js
import exportsRouter, { sessionTokenRouter, exportEventsRouter, pexelsUrlRouter, freepikUrlRouter } from './routes/exports.js'
```

`new_string`:
```js
import exportsRouter, { sessionTokenRouter, exportEventsRouter, pexelsUrlRouter, freepikUrlRouter } from './routes/exports.js'
import adminExportsRouter from './routes/admin/exports.js'
```

Mount edit — match on the `adminRouter` mount line:

`old_string`:
```js
app.use('/api/admin', adminRouter)
```

`new_string`:
```js
app.use('/api/admin', adminRouter)
app.use('/api/admin/exports', adminExportsRouter)
```

**Ordering note:** Express resolves routers in registration order and by longest prefix match for same-base-path routers. `/api/admin` and `/api/admin/exports` are distinct bases — no collision. Mounting `/api/admin/exports` AFTER `/api/admin` is fine because `adminRouter` does not register a `/exports` path itself.

- [ ] **Step 4: Syntax check via import probe**

```bash
cd "$WT"
node --input-type=module -e "
import('./server/routes/admin/exports.js').then(m => {
  console.log('router default export:', typeof m.default)
})
" 2>&1 | head -5
# Expected: router default export: function
```

- [ ] **Step 5: Existing tests still pass**

```bash
cd "$WT"
npm run test 2>&1 | tail -8
# Expected: 50/50 still passing. We haven't added route tests yet (Task 5);
# mounting a new router doesn't regress anything.
```

- [ ] **Step 6: Commit**

```bash
cd "$WT"
git add server/routes/admin/exports.js server/index.js
git diff --cached --stat
# Expected: 2 files; new route file ~120 lines, index.js +2 lines
git commit -m "$(cat <<'EOF'
feat(admin): GET /api/admin/exports list route

Adds a new server/routes/admin/exports.js router with the list
handler. Paginated (offset/limit, max 200, default 50). Filters:
failures_only, user_id, since, until. Response shape matches
/api/admin/api-logs: { exports, total, limit, offset }.

Auth: requireAuth + requireAdmin composed per handler.
requireAdmin is declared locally — matches the existing
server/routes/admin.js pattern. Extraction into
server/middleware/* is deferred until a second file needs it.

SQL uses correlated subqueries for per-row failure + download
counts so the list page renders the ok/fail ratio without a
second round-trip. idx_export_events_failures + idx_export_events_export
cover these subqueries at MVP scale.

No write routes. Read-only. Events timeline route lands in Task 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server route — `GET /api/admin/exports/:id/events` (timeline)

Extend the same file with the timeline handler. The detail route returns the `exports` row, the full event list, AND pre-computed aggregates (by_source, by_error_code) — one round-trip to fill the ExportDetail page.

**Files:**
- Modify: `$WT/server/routes/admin/exports.js` (add second handler)

- [ ] **Step 1: Insert the new handler before `export default router`**

Use `Edit`. Match on the `export default router` line at the bottom.

`old_string`:
```js
    res.json({
      exports: rows,
      total: parseInt(countRow.total),
      limit,
      offset,
    })
  } catch (err) {
    next(err)
  }
})

export default router
```

`new_string`:
```js
    res.json({
      exports: rows,
      total: parseInt(countRow.total),
      limit,
      offset,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/admin/exports/:id/events
//
// Returns the full export row + all events in `t ASC` order (the
// index idx_export_events_export is ordered on (export_id, t), so
// ASC hits the index exactly). Aggregates are computed in JS from
// the events array — no second query — since we've already paid
// for the events fetch.
//
// Response 200: {
//   export: { id, user_id, plan_pipeline_id, variant_labels, status,
//             manifest_json, result_json, xml_paths, folder_path,
//             created_at, completed_at },
//   events: [{ id, event, item_id, source, phase, error_code,
//              http_status, retry_count, meta, t, received_at }, ...],
//   aggregates: { fail_count, success_count, by_source: {...},
//                 by_error_code: {...} }
// }
// Response 404: { error: 'export not found' }
// Response 401/403: via requireAuth/requireAdmin
router.get('/:id/events', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params
    const exportRow = await db.prepare(
      `SELECT id, user_id, plan_pipeline_id, variant_labels, status,
              manifest_json, result_json, xml_paths, folder_path,
              created_at, completed_at
       FROM exports WHERE id = ?`
    ).get(id)
    if (!exportRow) return res.status(404).json({ error: 'export not found' })

    // `t ASC` hits idx_export_events_export(export_id, t). Do not
    // change to `received_at` — that's the server-stamp for clock-skew
    // triage only and is not the primary sort.
    const events = await db.prepare(
      `SELECT id, event, item_id, source, phase, error_code,
              http_status, retry_count, meta_json, t, received_at
       FROM export_events
       WHERE export_id = ?
       ORDER BY t ASC`
    ).all(id)

    // Parse meta_json server-side so the client doesn't re-parse
    // per row in render. Null on parse failure — the client treats
    // meta as optional.
    const eventsParsed = events.map(e => {
      let meta = null
      if (e.meta_json) {
        try { meta = JSON.parse(e.meta_json) } catch { /* leave null */ }
      }
      const { meta_json, ...rest } = e
      return { ...rest, meta }
    })

    // Aggregates: per-source and per-error_code failure rates.
    // Only counts events with event === 'item_failed'. Per-source
    // also counts successes so the UI can render a rate (failed /
    // (failed + downloaded)) per source.
    const bySource = {}
    const byErrorCode = {}
    let failCount = 0
    let successCount = 0
    for (const ev of eventsParsed) {
      if (ev.event === 'item_failed') {
        failCount++
        const src = ev.source || 'unknown'
        bySource[src] = bySource[src] || { failed: 0, succeeded: 0 }
        bySource[src].failed++
        const code = ev.error_code || 'unknown'
        byErrorCode[code] = (byErrorCode[code] || 0) + 1
      } else if (ev.event === 'item_downloaded') {
        successCount++
        const src = ev.source || 'unknown'
        bySource[src] = bySource[src] || { failed: 0, succeeded: 0 }
        bySource[src].succeeded++
      }
    }

    res.json({
      export: exportRow,
      events: eventsParsed,
      aggregates: {
        fail_count: failCount,
        success_count: successCount,
        by_source: bySource,
        by_error_code: byErrorCode,
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
```

- [ ] **Step 2: Sanity check — the file should still parse**

```bash
cd "$WT"
node --input-type=module -e "
import('./server/routes/admin/exports.js').then(m => {
  console.log('router default export:', typeof m.default)
})" 2>&1 | head -5
# Expected: router default export: function
```

- [ ] **Step 3: Existing tests still pass**

```bash
cd "$WT"
npm run test 2>&1 | tail -8
# Expected: 50/50. New routes don't impact existing tests.
```

- [ ] **Step 4: Commit**

```bash
cd "$WT"
git add server/routes/admin/exports.js
git diff --cached --stat
# Expected: 1 file, ~100 lines added
git commit -m "$(cat <<'EOF'
feat(admin): GET /api/admin/exports/:id/events timeline route

Returns the full export row + all events in t-ASC order (hits
idx_export_events_export exactly) + pre-computed aggregates
(fail_count, success_count, by_source, by_error_code).

meta_json is parsed server-side so the React layer doesn't
re-parse per row in render.

Aggregates computed from the events array in a single pass —
no second DB round-trip. Small enough at MVP scale; profile
only if the user complains.

Auth: requireAuth + requireAdmin. Read-only.

Tests in Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ExportsList.jsx` page (happy-dom smoke test + UI)

The list view. Filters, pagination, rows with per-item failure/success counts, click-through to detail.

**Files:**
- Create: `$WT/src/pages/admin/ExportsList.jsx`
- Create: `$WT/src/pages/admin/__tests__/ExportsList.test.jsx`

- [ ] **Step 1: Read existing admin view for UI style**

Use `Read` on `src/components/views/BRollRunsView.jsx` lines 1-100 to copy Tailwind classes (table borders, row hovers, status badge colors). Use `Read` on `src/hooks/useApi.js` lines 49-115 to confirm `useApi` + `apiGet` signatures.

- [ ] **Step 2: Create the page**

Use `Write`. Content:

```jsx
// src/pages/admin/ExportsList.jsx
//
// /admin/exports — paginated list of export runs with filters.
// Read-only. Row click navigates to /admin/exports/:id (the Detail
// page). Data source: GET /api/admin/exports via apiGet.
//
// Filter defaults (per WebApp.3 open question #3): `since` is
// now - 7 days, applied client-side on mount. The operator can
// override via the since/until inputs. `failures_only` defaults off.
// `user_id` is empty (all users).

import { useMemo, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../../hooks/useApi.js'

const DEFAULT_SINCE_DAYS = 7
const PAGE_SIZE = 50

function toIsoDayStart(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    in_progress: 'bg-blue-900/50 text-blue-400 border-blue-800',
    complete: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
    failed: 'bg-red-900/50 text-red-400 border-red-800',
    partial: 'bg-amber-900/50 text-amber-400 border-amber-800',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 text-xs rounded border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

export default function ExportsList() {
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [userId, setUserId] = useState('')
  const [since, setSince] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - DEFAULT_SINCE_DAYS)
    return toIsoDayStart(d)
  })
  const [until, setUntil] = useState('')
  const [offset, setOffset] = useState(0)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const queryString = useMemo(() => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(offset))
    if (failuresOnly) p.set('failures_only', 'true')
    if (userId) p.set('user_id', userId)
    if (since) p.set('since', since)
    if (until) p.set('until', until)
    return p.toString()
  }, [failuresOnly, userId, since, until, offset])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet(`/admin/exports?${queryString}`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [queryString])

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">Exports</h2>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={e => { setFailuresOnly(e.target.checked); setOffset(0) }}
          />
          Failures only
        </label>
        <label className="flex flex-col text-xs text-zinc-400">
          user_id
          <input
            type="text"
            value={userId}
            onChange={e => { setUserId(e.target.value); setOffset(0) }}
            placeholder="uuid or blank for all"
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 w-72"
          />
        </label>
        <label className="flex flex-col text-xs text-zinc-400">
          since (ISO)
          <input
            type="text"
            value={since}
            onChange={e => { setSince(e.target.value); setOffset(0) }}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 w-60"
          />
        </label>
        <label className="flex flex-col text-xs text-zinc-400">
          until (ISO, optional)
          <input
            type="text"
            value={until}
            onChange={e => { setUntil(e.target.value); setOffset(0) }}
            placeholder="leave blank for now"
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 w-60"
          />
        </label>
      </div>

      {loading && <div className="text-sm text-zinc-400">Loading…</div>}
      {error && <div className="text-sm text-red-400">Error: {error}</div>}

      {data && (
        <>
          <div className="text-xs text-zinc-500 mb-2">
            {data.total} total · page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(data.total / PAGE_SIZE))}
          </div>

          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-xs text-zinc-400 border-b border-zinc-800">
                <th className="text-left py-2 pr-4">id</th>
                <th className="text-left py-2 pr-4">user_id</th>
                <th className="text-left py-2 pr-4">pipeline</th>
                <th className="text-left py-2 pr-4">variants</th>
                <th className="text-left py-2 pr-4">status</th>
                <th className="text-right py-2 pr-4">ok</th>
                <th className="text-right py-2 pr-4">fail</th>
                <th className="text-left py-2 pr-4">created</th>
              </tr>
            </thead>
            <tbody>
              {data.exports.map(row => (
                <tr
                  key={row.id}
                  className="border-b border-zinc-900 hover:bg-zinc-900/50"
                  data-testid="export-row"
                >
                  <td className="py-2 pr-4">
                    <Link to={`/admin/exports/${row.id}`} className="text-blue-400 hover:underline font-mono text-xs">
                      {row.id}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-400 truncate max-w-[12rem]">
                    {row.user_id || '—'}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-400 truncate max-w-[10rem]">
                    {row.plan_pipeline_id}
                  </td>
                  <td className="py-2 pr-4 text-xs text-zinc-300">{row.variant_labels}</td>
                  <td className="py-2 pr-4"><StatusBadge status={row.status} /></td>
                  <td className="py-2 pr-4 text-right text-emerald-400">{row.downloaded_count}</td>
                  <td className="py-2 pr-4 text-right text-red-400">{row.failed_count}</td>
                  <td className="py-2 pr-4 text-xs text-zinc-400 whitespace-nowrap">
                    {row.created_at}
                  </td>
                </tr>
              ))}
              {data.exports.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-sm text-zinc-500">
                    No exports match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-3 py-1 rounded border border-zinc-700 text-sm text-zinc-300 disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= data.total}
              className="px-3 py-1 rounded border border-zinc-700 text-sm text-zinc-300 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Create the happy-dom smoke test**

Use `Write` for `src/pages/admin/__tests__/ExportsList.test.jsx`:

```jsx
// src/pages/admin/__tests__/ExportsList.test.jsx
//
// Smoke test only — mounts the page with a stubbed apiGet returning
// 3 fixture rows and asserts all 3 ids land in the DOM. No RTL
// (matches the project's bare-React test precedent in
// src/hooks/__tests__/useExportXmlKickoff.test.js).
//
// Environment: happy-dom (set by vitest.workspace.js `web` project).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Stub apiGet BEFORE ExportsList imports it.
vi.mock('../../../hooks/useApi.js', () => ({
  apiGet: vi.fn(),
}))

// Stub supabase (imported transitively by useApi) — it reads
// VITE_SUPABASE_URL at module load. happy-dom has no env plumbing.
vi.mock('../../../lib/supabaseClient.js', () => ({ supabase: null }))

import ExportsList from '../ExportsList.jsx'
import { apiGet } from '../../../hooks/useApi.js'

const fixtureRows = [
  {
    id: 'exp_A', user_id: 'u-1', plan_pipeline_id: 'pp-1',
    variant_labels: '["A"]', status: 'complete', folder_path: '~/Downloads/a',
    created_at: '2026-04-24T00:00:00Z', completed_at: '2026-04-24T00:05:00Z',
    failed_count: 0, downloaded_count: 3,
  },
  {
    id: 'exp_B', user_id: 'u-1', plan_pipeline_id: 'pp-2',
    variant_labels: '["A","C"]', status: 'failed', folder_path: null,
    created_at: '2026-04-23T00:00:00Z', completed_at: null,
    failed_count: 2, downloaded_count: 1,
  },
  {
    id: 'exp_C', user_id: 'u-2', plan_pipeline_id: 'pp-3',
    variant_labels: '["C"]', status: 'partial', folder_path: '~/Downloads/c',
    created_at: '2026-04-22T00:00:00Z', completed_at: '2026-04-22T00:03:00Z',
    failed_count: 1, downloaded_count: 2,
  },
]

let container
let root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiGet.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ExportsList', () => {
  it('renders all fixture rows with their ids', async () => {
    apiGet.mockResolvedValueOnce({
      exports: fixtureRows,
      total: 3,
      limit: 50,
      offset: 0,
    })
    await act(async () => {
      root.render(
        createElement(MemoryRouter, null, createElement(ExportsList)),
      )
    })
    // Let the async apiGet settle.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const text = container.textContent
    expect(text).toContain('exp_A')
    expect(text).toContain('exp_B')
    expect(text).toContain('exp_C')
    expect(text).toContain('3 total')
  })

  it('shows empty state when no rows match', async () => {
    apiGet.mockResolvedValueOnce({ exports: [], total: 0, limit: 50, offset: 0 })
    await act(async () => {
      root.render(
        createElement(MemoryRouter, null, createElement(ExportsList)),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('No exports match these filters.')
  })

  it('surfaces apiGet errors', async () => {
    apiGet.mockRejectedValueOnce(new Error('500 Internal'))
    await act(async () => {
      root.render(
        createElement(MemoryRouter, null, createElement(ExportsList)),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('500 Internal')
  })
})
```

- [ ] **Step 4: Run both test projects**

```bash
cd "$WT"
npm run test 2>&1 | tail -15
# Expected:
#   server project: prior tests still passing
#   web project: 3 new tests passing (ExportsList)
#   Total: 53/53 (was 50/50)
```

If the test fails with "document is not defined", verify the include path in `vitest.workspace.js` catches `src/**/__tests__/**/*.test.jsx`. If it fails with "apiGet is not a function", the `vi.mock` hoisting didn't land — re-check import ordering.

- [ ] **Step 5: Commit**

```bash
cd "$WT"
git add src/pages/admin/ExportsList.jsx src/pages/admin/__tests__/ExportsList.test.jsx
git diff --cached --stat
# Expected: 2 files, ~220 + ~80 lines
git commit -m "$(cat <<'EOF'
feat(admin): ExportsList page + happy-dom smoke test

/admin/exports — paginated list with failures-only, user_id,
since, until filters. Default since = now - 7 days per WebApp.3
open question #3.

Page uses apiGet directly inside useEffect (not useApi) so the
queryString-driven refetch is explicit and cancellable. Offset
pagination, page size 50, matching /api/admin/api-logs.

Smoke test uses bare React + createRoot + MemoryRouter (no RTL),
matching src/hooks/__tests__/useExportXmlKickoff.test.js. Stubs
apiGet via vi.mock and asserts 3 fixture ids land in the DOM.
Also covers empty state + error surfacing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Server route unit tests

Now that both routes exist, add unit tests matching `server/services/__tests__/exports.test.js`'s pattern (vi.mock the db module, script the returns, assert shape).

**Files:**
- Create: `$WT/server/routes/admin/__tests__/exports.test.js`

- [ ] **Step 1: Study the existing server-test precedent**

Use `Read` on `server/services/__tests__/exports.test.js` lines 1-60 to copy the `vi.mock('../../db.js')` hoisting pattern. For a route test (vs. a service test), we additionally want to spin up a supertest-lite: either (a) use `supertest` if already a dep, or (b) call the handler directly via a fabricated `req`/`res`/`next`. Option (b) is zero-new-dep and sufficient for unit-level assertions on SQL + status codes.

**Decision: option (b), fabricate req/res/next.** Rationale: no new devDep; the middleware chain is short (`requireAuth` + `requireAdmin` + handler); we can test each middleware's effect in isolation.

```bash
cd "$WT"
grep -n "supertest" package.json 2>/dev/null
# Expected: no match (supertest is not a dep today)
```

- [ ] **Step 2: Create the test file**

Use `Write` for `server/routes/admin/__tests__/exports.test.js`:

```js
// server/routes/admin/__tests__/exports.test.js
//
// Unit tests for GET /api/admin/exports and GET /:id/events.
//
// Strategy: same as server/services/__tests__/exports.test.js —
// vi.mock('../../../db.js') with a scripted in-memory fake.
// The handlers are called directly with fabricated req/res/next
// objects (no supertest — avoids a new devDep, and the middleware
// chain is short enough to exercise manually).
//
// Auth model tests: we fabricate `req.auth` per test to represent
// (a) missing auth, (b) non-admin auth, (c) admin auth.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake db state.
let listRows = []
let listCount = 0
let eventsRows = []
let exportRow = null
// Captured SQL for assertions about WHERE clauses / ORDER BY.
const capturedSql = []
const capturedParams = []

vi.mock('../../../db.js', () => ({
  default: {
    prepare(sql) {
      capturedSql.push(sql)
      return {
        async all(...params) {
          capturedParams.push(params)
          if (/FROM exports\b/i.test(sql) && /LIMIT \? OFFSET \?/i.test(sql)) {
            return listRows
          }
          if (/FROM export_events/i.test(sql) && /WHERE export_id = \?/i.test(sql)) {
            return eventsRows
          }
          throw new Error(`unexpected .all SQL: ${sql}`)
        },
        async get(...params) {
          capturedParams.push(params)
          if (/SELECT COUNT\(\*\) AS total FROM exports/i.test(sql)) {
            return { total: listCount }
          }
          if (/FROM exports WHERE id = \?/i.test(sql)) {
            return exportRow
          }
          throw new Error(`unexpected .get SQL: ${sql}`)
        },
      }
    },
  },
}))

// Stub the auth module so we can control isAdmin per test.
vi.mock('../../../auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' })
    next()
  },
  isAdmin: (req) => req.auth?.isAdmin === true,
}))

const routerModule = await import('../exports.js')
const router = routerModule.default

// Extract the handlers from the router's stack. Express exposes
// handlers via router.stack[i].route.stack[j].handle. Order: the
// list route is registered first, then the events route.
function extractHandler(pathPattern) {
  const layer = router.stack.find(l => l.route && l.route.path === pathPattern)
  if (!layer) throw new Error(`no route for ${pathPattern}`)
  return layer.route.stack.map(s => s.handle)
}
const listHandlers = extractHandler('/')
const eventsHandlers = extractHandler('/:id/events')

// Fabricated res helper.
function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(obj) { this.body = obj; return this },
  }
  return res
}

async function runChain(handlers, req, res) {
  for (const h of handlers) {
    let called = false
    await new Promise((resolve, reject) => {
      const next = (err) => { called = true; err ? reject(err) : resolve() }
      const ret = h(req, res, next)
      if (ret && typeof ret.then === 'function') ret.then(() => called || resolve()).catch(reject)
      else if (!called && res.body !== null) resolve()     // handler wrote a response, stop
      else if (!called) resolve()                          // handler is sync and didn't call next — resolve
    })
    if (res.body !== null && res.statusCode !== 200 && res.statusCode >= 400) return  // short-circuit on error response
  }
}

beforeEach(() => {
  listRows = []
  listCount = 0
  eventsRows = []
  exportRow = null
  capturedSql.length = 0
  capturedParams.length = 0
})

describe('GET /api/admin/exports (list)', () => {
  it('401 when unauthenticated', async () => {
    const req = { auth: null, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })

  it('403 when authed but non-admin', async () => {
    const req = { auth: { userId: 'u-1', isAdmin: false }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(403)
  })

  it('200 for admin with default pagination', async () => {
    listRows = [
      { id: 'exp_A', user_id: 'u-1', plan_pipeline_id: 'pp-1', variant_labels: '["A"]',
        status: 'complete', folder_path: '~/a', created_at: '2026-04-24', completed_at: null,
        failed_count: 0, downloaded_count: 3 },
    ]
    listCount = 1
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      exports: listRows,
      total: 1,
      limit: 50,
      offset: 0,
    })
  })

  it('applies failures_only filter via status IN (failed, partial)', async () => {
    listCount = 0
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: { failures_only: 'true' },
      params: {},
    }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(capturedSql.join('\n')).toContain("status IN ('failed','partial')")
  })

  it('applies user_id filter as prepared-statement param', async () => {
    listCount = 0
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: { user_id: 'u-target' },
      params: {},
    }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(capturedSql.join('\n')).toMatch(/user_id = \?/)
    // First all() call is the list; its first param should be u-target
    // followed by limit and offset.
    expect(capturedParams[0]).toEqual(['u-target', 50, 0])
  })

  it('applies since + until as prepared-statement params', async () => {
    listCount = 0
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: { since: '2026-04-17T00:00:00Z', until: '2026-04-24T00:00:00Z' },
      params: {},
    }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(capturedSql.join('\n')).toMatch(/created_at >= \?/)
    expect(capturedSql.join('\n')).toMatch(/created_at <= \?/)
    expect(capturedParams[0]).toEqual([
      '2026-04-17T00:00:00Z', '2026-04-24T00:00:00Z', 50, 0,
    ])
  })

  it('caps limit at 200', async () => {
    listCount = 0
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: { limit: '9999' },
      params: {},
    }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.body.limit).toBe(200)
  })
})

describe('GET /api/admin/exports/:id/events (timeline)', () => {
  it('404 when export not found', async () => {
    exportRow = null
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { id: 'exp_MISSING' },
    }
    const res = makeRes()
    await runChain(eventsHandlers, req, res)
    expect(res.statusCode).toBe(404)
  })

  it('200 with events + aggregates when export exists', async () => {
    exportRow = {
      id: 'exp_OK', user_id: 'u-1', plan_pipeline_id: 'pp-1',
      variant_labels: '["A"]', status: 'complete',
      manifest_json: '{}', result_json: null, xml_paths: null,
      folder_path: '~/d', created_at: '2026-04-24', completed_at: null,
    }
    eventsRows = [
      { id: 1, event: 'export_started', item_id: null, source: null, phase: null,
        error_code: null, http_status: null, retry_count: 0, meta_json: '{"n":2}',
        t: 1000, received_at: 1001 },
      { id: 2, event: 'item_downloaded', item_id: 'X', source: 'envato', phase: 'download',
        error_code: null, http_status: 200, retry_count: 0, meta_json: null,
        t: 2000, received_at: 2001 },
      { id: 3, event: 'item_failed', item_id: 'Y', source: 'pexels', phase: 'download',
        error_code: 'pexels_429', http_status: 429, retry_count: 2, meta_json: null,
        t: 3000, received_at: 3001 },
    ]
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { id: 'exp_OK' },
    }
    const res = makeRes()
    await runChain(eventsHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.export.id).toBe('exp_OK')
    expect(res.body.events).toHaveLength(3)
    // Meta parsed
    expect(res.body.events[0].meta).toEqual({ n: 2 })
    // Aggregates
    expect(res.body.aggregates.fail_count).toBe(1)
    expect(res.body.aggregates.success_count).toBe(1)
    expect(res.body.aggregates.by_source).toEqual({
      envato: { failed: 0, succeeded: 1 },
      pexels: { failed: 1, succeeded: 0 },
    })
    expect(res.body.aggregates.by_error_code).toEqual({ pexels_429: 1 })
  })

  it('orders events by t ASC to hit idx_export_events_export', async () => {
    exportRow = {
      id: 'exp_OK', user_id: 'u-1', plan_pipeline_id: 'pp-1',
      variant_labels: '["A"]', status: 'complete',
      manifest_json: '{}', result_json: null, xml_paths: null,
      folder_path: null, created_at: '2026-04-24', completed_at: null,
    }
    eventsRows = []
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { id: 'exp_OK' },
    }
    const res = makeRes()
    await runChain(eventsHandlers, req, res)
    expect(capturedSql.join('\n')).toMatch(/ORDER BY t ASC/)
  })

  it('403 when non-admin', async () => {
    const req = {
      auth: { userId: 'u-1', isAdmin: false },
      query: {}, params: { id: 'exp_OK' },
    }
    const res = makeRes()
    await runChain(eventsHandlers, req, res)
    expect(res.statusCode).toBe(403)
  })
})
```

- [ ] **Step 3: Run all tests**

```bash
cd "$WT"
npm run test 2>&1 | tail -15
# Expected: 50 (prior) + 3 (ExportsList smoke) + ~11 (this task) = ~64 passing
# If the runChain helper has subtle issues with mixing sync/async handlers,
# simplify by just awaiting handler(req, res, () => {}) and checking res directly.
```

If this task's handler extraction (`router.stack[i].route.stack[j]`) breaks because Express's internal shape shifted between versions, swap to installing `supertest` (flag to user first per open question #4; then `npm install --save-dev supertest` and rewrite tests against `supertest(app).get('/')`).

- [ ] **Step 4: Commit**

```bash
cd "$WT"
git add server/routes/admin/__tests__/exports.test.js
git diff --cached --stat
# Expected: 1 file, ~230 lines
git commit -m "$(cat <<'EOF'
test(admin): unit tests for /api/admin/exports routes

Mirrors server/services/__tests__/exports.test.js pattern —
vi.mock db.js + auth.js with scripted fakes; call router handlers
directly with fabricated req/res/next (no supertest, no new devDep).

Coverage:
  - GET / 401 on missing auth
  - GET / 403 on non-admin auth
  - GET / 200 with default pagination shape
  - GET / failures_only filter surfaces the correct WHERE clause
  - GET / user_id filter uses prepared-statement params
  - GET / since + until filters use prepared-statement params
  - GET / caps limit at 200
  - GET /:id/events 404 on missing export
  - GET /:id/events 200 with events + aggregates (fail_count,
    success_count, by_source, by_error_code)
  - GET /:id/events uses ORDER BY t ASC (index hit invariant)
  - GET /:id/events 403 on non-admin

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `ExportDetail.jsx` page + happy-dom smoke test

Detail view: summary card, timeline table, aggregates.

**Files:**
- Create: `$WT/src/pages/admin/ExportDetail.jsx`
- Create: `$WT/src/pages/admin/__tests__/ExportDetail.test.jsx`

- [ ] **Step 1: Create the page**

Use `Write` for `src/pages/admin/ExportDetail.jsx`:

```jsx
// src/pages/admin/ExportDetail.jsx
//
// /admin/exports/:id — per-export detail view:
//   1. Summary card (id, user_id, pipeline, variants, status,
//      created_at, completed_at, folder_path)
//   2. Failure-rate aggregates (by source, by error_code)
//   3. Event timeline in t-ASC order
//
// Data source: GET /api/admin/exports/:id/events.
// Read-only. No retry, no cancel, no delete.

import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { apiGet } from '../../hooks/useApi.js'

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    in_progress: 'bg-blue-900/50 text-blue-400 border-blue-800',
    complete: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
    failed: 'bg-red-900/50 text-red-400 border-red-800',
    partial: 'bg-amber-900/50 text-amber-400 border-amber-800',
  }
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

function EventBadge({ event }) {
  const isFailure = event === 'item_failed' || event === 'rate_limit_hit' || event === 'session_expired'
  const cls = isFailure
    ? 'bg-red-900/40 text-red-300 border-red-800/60'
    : 'bg-zinc-800 text-zinc-300 border-zinc-700'
  return <span className={`inline-block px-1.5 py-0.5 text-xs rounded border font-mono ${cls}`}>{event}</span>
}

function formatTimestamp(ms) {
  if (!ms && ms !== 0) return '—'
  const d = new Date(ms)
  return d.toISOString().replace('T', ' ').replace('Z', '')
}

export default function ExportDetail() {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet(`/admin/exports/${encodeURIComponent(id)}/events`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  if (loading) return <div className="p-6 text-sm text-zinc-400">Loading…</div>
  if (error) return <div className="p-6 text-sm text-red-400">Error: {error}</div>
  if (!data) return null

  const ex = data.export
  const { fail_count, success_count, by_source, by_error_code } = data.aggregates

  return (
    <div className="p-6 space-y-6">
      <div>
        <Link to="/admin/exports" className="text-xs text-blue-400 hover:underline">← Back to Exports</Link>
        <h2 className="text-lg font-semibold text-zinc-100 mt-1">Export {ex.id}</h2>
      </div>

      {/* Summary card */}
      <div className="rounded border border-zinc-800 bg-zinc-950/50 p-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div><span className="text-zinc-500">user_id:</span> <span className="font-mono text-xs text-zinc-300">{ex.user_id || '—'}</span></div>
        <div><span className="text-zinc-500">pipeline:</span> <span className="font-mono text-xs text-zinc-300">{ex.plan_pipeline_id}</span></div>
        <div><span className="text-zinc-500">variants:</span> <span className="text-zinc-300">{ex.variant_labels}</span></div>
        <div><span className="text-zinc-500">status:</span> <StatusBadge status={ex.status} /></div>
        <div><span className="text-zinc-500">created_at:</span> <span className="text-zinc-300">{ex.created_at}</span></div>
        <div><span className="text-zinc-500">completed_at:</span> <span className="text-zinc-300">{ex.completed_at || '—'}</span></div>
        <div className="col-span-2"><span className="text-zinc-500">folder_path:</span> <span className="font-mono text-xs text-zinc-300">{ex.folder_path || '—'}</span></div>
      </div>

      {/* Aggregates */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-200 mb-2">Summary</h3>
        <div className="text-sm text-zinc-300 mb-3">
          Downloaded: <span className="text-emerald-400">{success_count}</span> · Failed: <span className="text-red-400">{fail_count}</span>
        </div>

        {Object.keys(by_source).length > 0 && (
          <div className="mb-3">
            <div className="text-xs text-zinc-500 mb-1">By source</div>
            <table className="text-sm">
              <thead>
                <tr className="text-xs text-zinc-500"><th className="text-left pr-4">source</th><th className="text-right pr-4">ok</th><th className="text-right pr-4">fail</th><th className="text-right pr-4">rate</th></tr>
              </thead>
              <tbody>
                {Object.entries(by_source).map(([src, { succeeded, failed }]) => {
                  const total = succeeded + failed
                  const rate = total > 0 ? ((failed / total) * 100).toFixed(1) + '%' : '—'
                  return (
                    <tr key={src}>
                      <td className="pr-4 text-zinc-300">{src}</td>
                      <td className="pr-4 text-right text-emerald-400">{succeeded}</td>
                      <td className="pr-4 text-right text-red-400">{failed}</td>
                      <td className="pr-4 text-right text-zinc-300">{rate}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {Object.keys(by_error_code).length > 0 && (
          <div>
            <div className="text-xs text-zinc-500 mb-1">By error code</div>
            <table className="text-sm">
              <thead>
                <tr className="text-xs text-zinc-500"><th className="text-left pr-4">error_code</th><th className="text-right pr-4">count</th></tr>
              </thead>
              <tbody>
                {Object.entries(by_error_code).map(([code, count]) => (
                  <tr key={code}>
                    <td className="pr-4 text-zinc-300 font-mono text-xs">{code}</td>
                    <td className="pr-4 text-right text-red-400">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Timeline */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-200 mb-2">Timeline ({data.events.length} events)</h3>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-xs text-zinc-400 border-b border-zinc-800">
              <th className="text-left py-2 pr-4">t</th>
              <th className="text-left py-2 pr-4">event</th>
              <th className="text-left py-2 pr-4">item</th>
              <th className="text-left py-2 pr-4">source</th>
              <th className="text-left py-2 pr-4">phase</th>
              <th className="text-left py-2 pr-4">error</th>
              <th className="text-right py-2 pr-4">http</th>
              <th className="text-right py-2 pr-4">retry</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map(ev => (
              <tr key={ev.id} className="border-b border-zinc-900 hover:bg-zinc-900/50" data-testid="event-row">
                <td className="py-2 pr-4 text-xs text-zinc-400 whitespace-nowrap">{formatTimestamp(ev.t)}</td>
                <td className="py-2 pr-4"><EventBadge event={ev.event} /></td>
                <td className="py-2 pr-4 text-xs font-mono text-zinc-300">{ev.item_id || '—'}</td>
                <td className="py-2 pr-4 text-xs text-zinc-300">{ev.source || '—'}</td>
                <td className="py-2 pr-4 text-xs text-zinc-300">{ev.phase || '—'}</td>
                <td className="py-2 pr-4 text-xs font-mono text-red-400">{ev.error_code || '—'}</td>
                <td className="py-2 pr-4 text-right text-xs text-zinc-300">{ev.http_status || '—'}</td>
                <td className="py-2 pr-4 text-right text-xs text-zinc-300">{ev.retry_count ?? '—'}</td>
              </tr>
            ))}
            {data.events.length === 0 && (
              <tr><td colSpan={8} className="py-8 text-center text-sm text-zinc-500">No events recorded.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create the smoke test**

Use `Write` for `src/pages/admin/__tests__/ExportDetail.test.jsx`:

```jsx
// src/pages/admin/__tests__/ExportDetail.test.jsx
//
// Smoke test — mounts the page for an :id route, stubs apiGet with
// a fixture export + 5 events + aggregates, asserts timeline rows
// render in order.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../hooks/useApi.js', () => ({
  apiGet: vi.fn(),
}))
vi.mock('../../../lib/supabaseClient.js', () => ({ supabase: null }))

import ExportDetail from '../ExportDetail.jsx'
import { apiGet } from '../../../hooks/useApi.js'

const fixture = {
  export: {
    id: 'exp_ABC', user_id: 'u-1', plan_pipeline_id: 'pp-1',
    variant_labels: '["A","C"]', status: 'partial',
    manifest_json: '{}', result_json: null, xml_paths: null,
    folder_path: '~/Downloads/test', created_at: '2026-04-24T00:00:00Z',
    completed_at: '2026-04-24T00:05:00Z',
  },
  events: [
    { id: 1, event: 'export_started', item_id: null, source: null, phase: null,
      error_code: null, http_status: null, retry_count: 0, meta: { n: 3 },
      t: 1700000000000, received_at: 1700000000100 },
    { id: 2, event: 'item_downloaded', item_id: 'ABC', source: 'envato',
      phase: 'download', error_code: null, http_status: 200, retry_count: 0,
      meta: null, t: 1700000001000, received_at: 1700000001100 },
    { id: 3, event: 'item_failed', item_id: 'XYZ', source: 'pexels',
      phase: 'download', error_code: 'pexels_429', http_status: 429,
      retry_count: 2, meta: null, t: 1700000002000, received_at: 1700000002100 },
    { id: 4, event: 'rate_limit_hit', item_id: null, source: 'pexels',
      phase: null, error_code: null, http_status: null, retry_count: 0,
      meta: { retry_after_sec: 60 }, t: 1700000003000, received_at: 1700000003100 },
    { id: 5, event: 'export_completed', item_id: null, source: null,
      phase: null, error_code: null, http_status: null, retry_count: 0,
      meta: null, t: 1700000004000, received_at: 1700000004100 },
  ],
  aggregates: {
    fail_count: 1,
    success_count: 1,
    by_source: {
      envato: { failed: 0, succeeded: 1 },
      pexels: { failed: 1, succeeded: 0 },
    },
    by_error_code: { pexels_429: 1 },
  },
}

let container, root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiGet.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ExportDetail', () => {
  it('renders summary + aggregates + all 5 events', async () => {
    apiGet.mockResolvedValueOnce(fixture)
    await act(async () => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/admin/exports/exp_ABC'] },
          createElement(Routes, null,
            createElement(Route, {
              path: '/admin/exports/:id',
              element: createElement(ExportDetail),
            }),
          ),
        ),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const text = container.textContent
    expect(text).toContain('exp_ABC')
    expect(text).toContain('pp-1')
    expect(text).toContain('partial')

    // Aggregates
    expect(text).toContain('Downloaded:')
    expect(text).toContain('pexels_429')

    // All 5 event types show up
    expect(text).toContain('export_started')
    expect(text).toContain('item_downloaded')
    expect(text).toContain('item_failed')
    expect(text).toContain('rate_limit_hit')
    expect(text).toContain('export_completed')

    // Timeline count surface
    expect(text).toContain('Timeline (5 events)')
  })

  it('shows empty timeline when no events', async () => {
    apiGet.mockResolvedValueOnce({
      ...fixture,
      events: [],
      aggregates: { fail_count: 0, success_count: 0, by_source: {}, by_error_code: {} },
    })
    await act(async () => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/admin/exports/exp_NONE'] },
          createElement(Routes, null,
            createElement(Route, {
              path: '/admin/exports/:id',
              element: createElement(ExportDetail),
            }),
          ),
        ),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('No events recorded.')
  })

  it('surfaces 404 errors from apiGet', async () => {
    apiGet.mockRejectedValueOnce(new Error('export not found'))
    await act(async () => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/admin/exports/exp_MISSING'] },
          createElement(Routes, null,
            createElement(Route, {
              path: '/admin/exports/:id',
              element: createElement(ExportDetail),
            }),
          ),
        ),
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('export not found')
  })
})
```

- [ ] **Step 3: Run all tests**

```bash
cd "$WT"
npm run test 2>&1 | tail -15
# Expected: ~67 passing total
```

- [ ] **Step 4: Commit**

```bash
cd "$WT"
git add src/pages/admin/ExportDetail.jsx src/pages/admin/__tests__/ExportDetail.test.jsx
git diff --cached --stat
# Expected: 2 files; detail page ~240 lines, test ~140 lines
git commit -m "$(cat <<'EOF'
feat(admin): ExportDetail page + happy-dom smoke test

/admin/exports/:id — summary card + per-source/per-error_code
aggregates + event timeline in t-ASC order.

Aggregates rendered as small plain-HTML tables — no charts (per
WebApp.3 scope "no recharts/chart.js"). EventBadge highlights
failure-category events in red (item_failed, rate_limit_hit,
session_expired per the design spec's event enum).

Smoke test covers: full render with 5 events, empty timeline,
error surfacing. All through MemoryRouter so useParams picks up
the id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Router wiring (`App.jsx` + `AdminLayout.jsx`)

Hook the two pages into React Router + add the sidebar nav entry. Smallest possible diff.

**Files:**
- Modify: `$WT/src/App.jsx`
- Modify: `$WT/src/components/layouts/AdminLayout.jsx`

- [ ] **Step 1: Add imports + routes in `App.jsx`**

Use `Edit`. Two edits.

Imports — match on the final admin-view import (`GpuPipelineView`):

`old_string`:
```js
import GpuPipelineView from './components/views/GpuPipelineView.jsx'
import ProjectsView from './components/views/ProjectsView.jsx'
```

`new_string`:
```js
import GpuPipelineView from './components/views/GpuPipelineView.jsx'
import ProjectsView from './components/views/ProjectsView.jsx'
import ExportsList from './pages/admin/ExportsList.jsx'
import ExportDetail from './pages/admin/ExportDetail.jsx'
```

Routes — match on the `stability` admin route (anchor point just before the closing `</Route>` of the `/admin` block):

`old_string`:
```jsx
        <Route path="experiments/:experimentId/stability" element={<StabilityView />} />
      </Route>
```

`new_string`:
```jsx
        <Route path="experiments/:experimentId/stability" element={<StabilityView />} />
        <Route path="exports" element={<ExportsList />} />
        <Route path="exports/:id" element={<ExportDetail />} />
      </Route>
```

- [ ] **Step 2: Add the nav entry in `AdminLayout.jsx`**

Use `Edit`. Match the `Cpu` import + the `navItems` array end.

Import edit:

`old_string`:
```js
import { Database, Video, FlaskConical, LayoutDashboard, DollarSign, Play, Film, Key, ScrollText, Cpu } from 'lucide-react'
```

`new_string`:
```js
import { Database, Video, FlaskConical, LayoutDashboard, DollarSign, Play, Film, Key, ScrollText, Cpu, Download } from 'lucide-react'
```

Nav list edit:

`old_string`:
```js
  { to: '/admin/gpu', icon: Cpu, label: 'GPU Pipeline' },
]
```

`new_string`:
```js
  { to: '/admin/gpu', icon: Cpu, label: 'GPU Pipeline' },
  { to: '/admin/exports', icon: Download, label: 'Exports' },
]
```

- [ ] **Step 3: Verify the page loads (no runtime regression)**

```bash
cd "$WT"
# Dev server might not be running. Just check the build step parses.
# Vite doesn't have a "typecheck" script here — the tests exercise import
# resolution. Running the test suite confirms both new pages import OK.
npm run test 2>&1 | tail -8
# Expected: all tests still passing. No test actively hits App.jsx, but
# the web-project include covers the page files, which import the
# router. Any import typo surfaces here.
```

- [ ] **Step 4: Commit**

```bash
cd "$WT"
git add src/App.jsx src/components/layouts/AdminLayout.jsx
git diff --cached --stat
# Expected: 2 files; App.jsx +4 lines, AdminLayout.jsx +2 lines
git commit -m "$(cat <<'EOF'
feat(admin): wire /admin/exports + /admin/exports/:id into router

Two new <Route> entries inside the existing /admin nested Routes
block, sitting after stability. Two new imports. AdminLayout
gains one navItems entry (Exports, lucide-react Download icon).

Minimal diff — 6 lines of JSX + 3 lines of imports. No changes
to the AdminLayout chrome, the AuthGate, or the UserLayout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: README note (+ roadmap tick, optional)

Record what shipped for the next plan author. Strictly optional — the plan file itself is canonical — but a short note in `docs/specs/2026-04-24-export-remaining-roadmap.md` turns the WebApp.3 heading green.

**Files:**
- Modify (OPTIONAL): `$WT/docs/specs/2026-04-24-export-remaining-roadmap.md` (tick WebApp.3 as shipped)

- [ ] **Step 1: Decide whether to tick the roadmap**

If the roadmap has a status column or a `[ ]`/`[x]` marker for each phase heading, tick WebApp.3. If it doesn't, skip this step — the roadmap isn't set up for per-phase status marks and pretending otherwise adds noise.

```bash
cd "$WT"
grep -n "WebApp.3\|\\[x\\]\|\\[ \\]" docs/specs/2026-04-24-export-remaining-roadmap.md | head -10
# Expected: see how the roadmap encodes status (if at all). If no [x]/[ ]
# convention, skip this task entirely.
```

- [ ] **Step 2: If convention allows, tick WebApp.3 via `Edit`**

Only run if Step 1 shows a matching pattern. Match on the `### WebApp.3 — Admin Observability UI` heading + optionally append a status line underneath:

`old_string`:
```
### WebApp.3 — Admin Observability UI (`/admin/exports`)
```

`new_string`:
```
### WebApp.3 — Admin Observability UI (`/admin/exports`) — SHIPPED
```

(Adjust the exact suffix to match how other shipped phases are marked in the same file. If there's no precedent for a status marker, do NOT invent one — leave the heading as-is and move on.)

- [ ] **Step 3: Commit if Step 2 fired; otherwise skip**

```bash
cd "$WT"
if git diff --quiet; then
  echo "No roadmap edit; skipping commit for this task."
else
  git add docs/specs/2026-04-24-export-remaining-roadmap.md
  git commit -m "$(cat <<'EOF'
docs(roadmap): mark WebApp.3 observability UI as shipped

Admin /admin/exports list + detail pages + timeline aggregates
landed across this feature branch. Read-only per scope.
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
fi
```

---

## Task 9: Manual smoke (no commit)

Load the page against the user's running dev server and confirm end-to-end behavior with real data from the Week 4 State E smoke run.

**Files:**
- None (verification only)

- [ ] **Step 1: Confirm the backend is running**

```bash
curl -sS http://localhost:3001/api/health | head -1
# Expected: {"status":"ok",...}
# If NOT running: STOP. Do NOT kill anything on :3001. If no server is up,
# ask the user to start their dev server OR skip this smoke and note it
# as a pending manual check.
```

- [ ] **Step 2: Confirm at least one export row exists owned by the admin**

```bash
# Requires a valid Supabase session token for the admin user. The user
# should already have VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY set.
# Grab a session via the web app's sign-in flow, copy the bearer from
# DevTools Network → Authorization header on any request.
JWT="<paste your admin bearer>"
curl -sS -H "Authorization: Bearer $JWT" http://localhost:3001/api/admin/exports?limit=3 | head
# Expected: {"exports":[{"id":"exp_..."}],"total":N,"limit":3,"offset":0}
# If total = 0, run the Week 4 State E smoke once first (run a small export
# from the editor → Export page → click Start with the extension loaded).
```

- [ ] **Step 3: Exercise the list page in the browser**

Open `http://localhost:5173/admin/exports` (or whatever port Vite is running on). Verify:

1. The page loads without console errors.
2. The sidebar shows a new "Exports" entry highlighted when on this route.
3. At least one row renders (from Step 2).
4. Column headers: id, user_id, pipeline, variants, status, ok, fail, created.
5. Failures-only checkbox toggles the row list. If only one row exists and it's `complete`, checking the box should empty the list.
6. user_id input filters to that user when typed.
7. since/until inputs respect ISO timestamps.
8. Pagination buttons enable/disable based on total/offset.

- [ ] **Step 4: Exercise the detail page**

Click the id of a recent export in the list. The URL should change to `/admin/exports/exp_...`. Verify:

1. Summary card renders all fields (id, user_id, pipeline, variants, status, created_at, completed_at, folder_path).
2. Aggregates section shows Downloaded / Failed counts.
3. If any failures exist, the "By source" and "By error code" tables are populated.
4. Timeline table lists events in ascending `t` order (earliest first).
5. `item_failed` / `rate_limit_hit` / `session_expired` rows show the `EventBadge` in red; other events in neutral.
6. A back link → `/admin/exports` returns to the list.

- [ ] **Step 5: Exercise the error paths**

```bash
# 1. Unauthed — should 401.
curl -sS http://localhost:3001/api/admin/exports?limit=1 -w "\n%{http_code}\n" | tail -5
# Expected: {"error":"Authentication required"} ... 401

# 2. Non-admin user — should 403. If you have a second Supabase user whose email
# is NOT in server/auth.js ADMIN_EMAILS, sign in as them and hit the endpoint.
# Expected: {"error":"Admin access required"} ... 403

# 3. Missing export id — should 404.
curl -sS -H "Authorization: Bearer $JWT" http://localhost:3001/api/admin/exports/exp_DOESNOTEXIST/events -w "\n%{http_code}\n" | tail -5
# Expected: {"error":"export not found"} ... 404
```

- [ ] **Step 6: Record findings — no commit**

If everything passed, the feature is ready. Any gaps (typos, missing columns in render, timestamp display issues) become fix-up commits on this same branch before merge.

The branch `feature/webapp-admin-exports` is now ready for a merge to local `main` — the user will handle the merge themselves per their workflow (memory note: "don't push without asking"). Do NOT `git push`.

```bash
cd "$WT"
git log --oneline feature/webapp-admin-exports ^main | head -20
# Expected: 8 commits (Task 0 plan + Task 2/3 server + Task 4/5/6 UI/test + Task 7 routing + optional Task 8)
```

---

## Appendix: End-state smoke summary (copy to a PR description if you open one)

```
[x] GET /api/admin/exports — list with filters
[x] GET /api/admin/exports/:id/events — timeline + aggregates
[x] /admin/exports list page (React Router)
[x] /admin/exports/:id detail page (React Router)
[x] Sidebar nav entry
[x] 11 server route tests + 3 list smoke + 3 detail smoke = 17 new tests
[x] Baseline 50/50 intact → new total ~67/67
[x] Read-only; auth via isAdmin + requireAuth + requireAdmin
[x] No schema changes; no extension changes; no Slack re-wiring
[x] Manual smoke verified against live backend
```
