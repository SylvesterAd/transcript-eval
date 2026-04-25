# WebApp — State E XMEML Wire-Up & Production-404 Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the production-blocking `POST /api/exports/:id/generate-xml` 404 by wiring the web app's State E handler to synthesize the `{variants:[{label, sequenceName, placements}]}` shape the XMEML endpoint reads from `exports.result_json`, have the client POST to that endpoint directly, persist the generated XML files to the user's downloads folder, and render the download links — replacing `StateE_Complete_Placeholder.jsx` with the real UI. No extension change. No schema change. No amendment to Phase 1's `recordExportEvent`.

---

## Diagnosis (verified in code, not assumed)

The production 404 comes from exactly **one** code path: `server/routes/export-xml.js:54` returning `404 {error:'export not found or not ready'}` because `getExportResult` (`server/services/exports.js:67–83`) reads `exports.result_json`, `JSON.parse`s it, and returns `null` if `parsed.variants` is not an array.

Today nothing in the system **ever** writes that `{variants:[...]}` shape:

1. **Extension's `complete` Port message** — `extension/modules/queue.js:444–456`, the payload is `{ type:'complete', ok_count, fail_count, folder_path, xml_paths: [] }`. It carries no variants, no placements, no sequence names. The comment explicitly says `xml_paths: [], // web app generates XMLs`.
2. **Phase 1's `recordExportEvent`** — `server/services/exports.js:128–179`, on `event === 'export_completed'` it writes `result_json = meta ? JSON.stringify(meta) : null` (line 172). The `meta` arrives from the extension's telemetry POST — per the Phase 1 plan (`docs/superpowers/plans/2026-04-23-envato-export-phase1.md:826`) and the `export_completed` emit site in Ext.5, `meta` is `{ ok_count, fail_count, total_bytes_downloaded }` — NOT `{variants:[...]}`. So `result_json` ends up as `'{"ok_count":3,"fail_count":0,"total_bytes_downloaded":123}'`, `parsed.variants` is `undefined`, and `getExportResult` returns `null`, and the endpoint 404s.
3. **No one currently calls `/api/exports/:id/generate-xml` at all.** `git grep -n "generate-xml" src/` returns zero hits. The WebApp.2 endpoint has been sitting in `server/routes/export-xml.js` waiting for a client to talk to it since it landed — State D plan explicitly left the XMEML kickoff for "the next plan" (`docs/superpowers/plans/2026-04-24-webapp-export-page-state-d.md:47`, `:1881`; README note at `src/components/export/README.md:63`). `StateE_Complete_Placeholder.jsx` renders `complete.xml_paths` which is always `[]` from the extension.

**Where the fix belongs: client-side only.** The endpoint contract from WebApp.2 is already explicit (`docs/superpowers/plans/2026-04-24-webapp-xmeml-generator.md:1400`, in Task 6's note): *"Option A is to document the contract here and let WebApp.1's `handle 'complete' postMessage` write the variants shape before calling this endpoint … upstream is responsible for writing the shape."* This plan implements Option A.

**Why Option A (client-only) is correct:**

- The web app **already has** the placement timing data from `buildManifest()` in `src/lib/buildManifest.js:57–127`. The `unifiedManifest.items[].placements[]` array carries `{ variant, timeline_start_s, timeline_duration_s }` per variant per item, along with per-item `seq`, `source`, `source_item_id`, `target_filename`. That's literally the input the XMEML endpoint needs — just reshaped per variant and passed in via the endpoint's `{variants:[...]}` request body is what the spec envisioned. Re-read more carefully: the endpoint takes `{variants: ["A","C"]}` as the request body, then reads placements out of `result_json`. So the client still has to **post the full placements shape to `result_json` first** via a new endpoint OR transform+POST directly.
- The cleanest way: POST a NEW small endpoint — `POST /api/exports/:id/result` — that accepts `{ variants:[{label, sequenceName, placements:[...]}, ...] }` and writes it atomically to `exports.result_json`. Then call the existing `POST /api/exports/:id/generate-xml` with the short label list. This isolates the write (idempotent) from the XML read (stateless render).
- Phase 1's `recordExportEvent` is left untouched — its `meta` contract stays what it is (`{ok_count, fail_count, total_bytes_downloaded}`), `export_events` continues to receive its per-transition rows, and `result_json` gets filled by the new path AFTER the extension signals complete. The `COALESCE(?, result_json)` in `recordExportEvent` is non-destructive, so order doesn't matter — whichever write lands second wins, and the extension's `export_completed` currently nulls meta-as-result which is fine as a precursor (the new endpoint's write will overwrite).

**Server-side delta:** one tiny new route (`POST /api/exports/:id/result`) with a validator + `UPDATE exports SET result_json = ? WHERE id = ? AND user_id = ?` and a 200/404. That's it. Everything else is client-side.

**Bug summary: origin = client-side hole (no code wires `{type:"complete"}` → `POST /generate-xml`). Fix = client-only wire-up + one thin server write-endpoint (because Phase 1's single write-path for `result_json` is the telemetry flow and we intentionally don't want to overload it).**

---

## Why read this before touching code

Seven load-bearing invariants. Skipping any of them reopens a door the next run will walk through.

**1. Do NOT modify `recordExportEvent` or the `export_events` flow.** Phase 1 is shipped and its test surface currently has zero vitest coverage of this path; the project's 30 passing tests are all XMEML generator tests. Touching `recordExportEvent`'s `meta → result_json` write to coerce shape would couple telemetry semantics (what `export_completed` means) to a write concern (what State E needs) and cause silent regressions the moment `meta` gains new fields. **The per-event telemetry rows must continue landing in `export_events` exactly as they do today** — that's both Phase 1's observability contract AND the input for the admin dashboard (WebApp.3, deferred).

**2. Transform happens in the React layer, at exactly one site: the new `useExportXmlKickoff` hook.** The hook owns (a) assembling `{variants:[...]}` from the unified manifest + the port's final snapshot, (b) POSTing to the new `result` endpoint, (c) POSTing to `generate-xml`, (d) writing XML files to disk via the browser's `Blob` + anchor-download trick (no File System Access API — that's explicitly deferred per State D plan §Deferred). The page is NOT allowed to do this transform inline; keeping it in one hook makes the contract testable as a pure function.

**3. State E must not deadlock if XMEML 500s.** If the generate-xml endpoint throws, the State E UI must still show the extension's `complete` payload (ok/fail counts, folder_path) and expose a "Regenerate XML" button. It must NOT be stuck on a spinner forever. The hook returns a discriminated-union result (`{ status: 'idle' | 'posting-result' | 'generating' | 'ready' | 'error', xml_by_variant?, error? }`) and State E reads from it; no suspense-boundary, no promise-throwing.

**4. The transform must be idempotent + deterministic.** Re-clicking "Regenerate XML" does not mutate anything; it posts the same `{variants:[...]}` and reads back the same xml_by_variant. The hook de-dupes in-flight POSTs by tracking a request ID, so a double-click can't start two parallel XMEML jobs.

**5. The XML download uses blob + anchor, not File System Access API.** Deferred per State D plan and the root roadmap spec (`docs/specs/2026-04-24-export-remaining-roadmap.md`, State C item "Folder picker deferred"). One `<a href="blob:..." download="variant-C.xml">` per variant, triggered programmatically once the endpoint returns. The user gets browser-default downloads. Filename scheme: `variant-<label-lowercased>.xml`. For multi-variant exports this produces one click-to-download per variant — acceptable for Phase C per State D §Out-of-Scope.

**6. Filename fidelity gap is explicitly NOT fixed here.** The extension uses `conflictAction: 'uniquify'` (`extension/modules/queue.js:234`) but never updates `item.target_filename` after uniquification — the Port snapshot still shows the pre-uniquify name. On a fresh run with no filename collisions (the normal case), this is a no-op. When collisions exist, Premiere's `<pathurl>` entries will point at the pre-uniquify name even though the real file has `(1)` appended. **This is pre-existing Ext.5 behavior.** Fixing it belongs to a separate extension bump (would need a new `item_finalized` Port message carrying the actual download path from `chrome.downloads.search`). This plan DOES NOT TOUCH the extension (the task boundary says "Ext.6 owns version bumps; webapp side only"). Flag this as a future work item in the plan's open-questions list; don't regress around it.

**7. Quote every path — the repo lives at `/Users/laurynas/Desktop/one last /transcript-eval/` with a trailing space in `one last `.** Every shell snippet in this plan quotes its paths; executors must do the same. Unquoted paths silently break.

---

## Scope

### In scope

- `src/hooks/useExportXmlKickoff.js` — NEW. A hook that takes the unified manifest (passed up from State C via the FSM's new `onStart` plumbing), the export ID, the variant labels, and the extension's `complete` payload (via `useExportPort.complete`), and runs the three-step `build → POST result → POST generate-xml → download blobs` flow. Returns `{ status, xml_by_variant, error, regenerate }`. Pure transform logic extracted as `buildVariantsPayload({unifiedManifest, variantLabels})` (exported separately for unit testing).
- `server/routes/exports.js` — extend with `POST /api/exports/:id/result`. Auth via `requireAuth` (Supabase JWT). Owner-checks against `req.auth.userId`. Body: `{ variants: [{ label, sequenceName, placements: [...] }, ...] }`. Writes `exports.result_json = JSON.stringify({variants})`. Returns `{ ok: true }` on success, 404 on missing-or-not-owned, 400 on shape violation, 500 on DB error. **This is the ONLY server-side change.**
- `src/components/export/StateE_Complete.jsx` — NEW (replaces the `_Placeholder` file). Renders (a) extension's `complete` payload (ok_count, folder_path), (b) XMEML kickoff status via the hook, (c) per-variant XML download buttons, (d) "Regenerate" button on error, (e) short "How to import in Premiere" text. No new dependencies.
- `src/components/export/StateE_Complete_Placeholder.jsx` — delete (file removal is a committed diff).
- `src/pages/ExportPage.jsx` — modify `ActiveRun` to (a) store the unified manifest in state when State C completes (it already reaches ExportPage via `onStart`'s `unifiedManifest` param — just thread it to `state.unified_manifest` via a new reducer action), (b) pass `unifiedManifest` + `exportId` + `variantLabels` + `port.complete` to `StateE_Complete`, (c) swap the placeholder import.
- `server/services/exports.js` — extend with `writeExportResult({id, userId, variants})` helper. Validates shape. Does the `UPDATE exports SET result_json = ? WHERE id = ? AND (user_id IS NULL OR user_id = ?)` and throws `NotFoundError` on zero-rows-updated.
- `server/services/__tests__/exports.test.js` — NEW. Covers `writeExportResult` (valid shape round-trips through `getExportResult`; non-owner write is 404; missing export is 404; malformed shape is 400 via throwing `ValidationError`). Uses a sqlite-in-memory instance spun up like the rest of the project's tests — reuses `server/db.js` import pattern (see existing `xmeml-generator.test.js` for ESM fixture loading style).
- `src/hooks/__tests__/useExportXmlKickoff.test.js` — NEW. Covers `buildVariantsPayload()` (pure function — deterministic, handles single/multi variant, empty placements, filename unknown-seq drop) + one integration-style test of the hook using vitest's `vi.fn()` to stub `apiPost` and assert the three-POST dance + download blob creation calls happen in order. Uses `happy-dom` environment for `URL.createObjectURL` / `<a>` click. **This plan introduces happy-dom as a new devDep** since the existing vitest config is node-only — see Task 1.
- `vitest.config.js` — amend to add a second project/config for frontend tests with `happy-dom` environment. Keep server tests on `node`. No breaking changes to the 30 existing tests.

### Deferred (DO NOT add to this plan)

- **State F full UI** — per-failure diagnostics, retry failed items, "Generate XML anyway" button, diagnostic bundle export. Plan only touches State F enough to coexist: leave `StateF_Partial_Placeholder.jsx` as-is OR optionally add a "Generate XML for successful items" button that reuses the same hook. The conservative choice: leave it, note as follow-up.
- **Admin routes** — `/admin/exports`, `/admin/support`. That's WebApp.3 / WebApp.4.
- **File System Access API** — rendering inside a user-picked folder alongside `media/`. Per State D plan, blob + download anchor is acceptable.
- **Refactor to XMEML generator internals** — the `generateXmeml()` function works; the bug is at the data hand-off.
- **Extension-side amendment.** This plan is webapp-side only, and the current extension already has everything the webapp needs (its snapshot carries `target_filename`, the `complete` Port message carries `folder_path`, and the unified manifest carries placement timing). Do NOT bump the extension version (Ext.6 owns that).
- **Schema migration.** `exports.result_json` is already `TEXT`. No column changes.
- **Retry/backoff on XMEML 500.** The hook exposes `regenerate`; the button is the retry. No automatic retry (a 500 from `generateXmeml` likely means malformed placement data — retrying without user insight loops).
- **Filename-fidelity fix for `conflictAction: 'uniquify'` collisions** — requires an extension-side message bump (Ext.6 territory). Surface as an open question; do not attempt.

---

## Prerequisites

- Node 20+ (already used).
- Local branch `main` has: Phase 1 export backend merged (`server/routes/exports.js`, `server/services/exports.js`, `server/routes/export-xml.js`, `server/services/xmeml-generator.js`, schema with `exports.result_json` TEXT). Verified: all present in `main` today (see diagnosis).
- `npm install` up to date. Vitest 1.6.x available (devDep already present).
- Extension loaded unpacked OR an in-browser mock of `chrome.runtime` for smoke. Real extension run recommended for Task 9's manual verification.
- Backend running on `localhost:3001` for manual curl checks.
- Path quoting: `/Users/laurynas/Desktop/one last /transcript-eval/` — trailing space in `one last `.

---

## File structure (final state)

All paths are inside `$TE` where `TE="/Users/laurynas/Desktop/one last /transcript-eval"`.

```
$TE/server/
├── services/
│   ├── exports.js                                 MODIFIED — +writeExportResult helper
│   └── __tests__/
│       └── exports.test.js                        NEW — writeExportResult round-trip + auth tests
└── routes/
    └── exports.js                                 MODIFIED — +POST /:id/result

$TE/src/
├── hooks/
│   ├── useExportXmlKickoff.js                     NEW — the 3-step transform+POST flow + download
│   └── __tests__/
│       └── useExportXmlKickoff.test.js            NEW — buildVariantsPayload unit tests +
│                                                       hook integration test with stubbed apiPost
├── components/export/
│   ├── StateE_Complete.jsx                        NEW — real State E UI (replaces placeholder)
│   └── StateE_Complete_Placeholder.jsx            DELETED
└── pages/
    └── ExportPage.jsx                             MODIFIED — thread unifiedManifest via FSM,
                                                       swap StateE import

$TE/vitest.config.js                               MODIFIED — dual-env config (node + happy-dom)
$TE/package.json                                   MODIFIED — +happy-dom devDep
$TE/docs/superpowers/plans/
└── 2026-04-24-webapp-state-e-xmeml-wire.md        THIS FILE
```

Rationale:
- Keeping `useExportXmlKickoff` in `src/hooks/` rather than `src/lib/` matches the existing pattern (`useExportPort`, `useExportPreflight`, `useExtension`). A hook is React-state-aware; a lib is pure.
- `StateE_Complete.jsx` (no `_Placeholder` suffix) is the new real file so a `grep -R _Placeholder src/` shows only State F left — a correct single TODO.
- `vitest.config.js` uses `workspace` for dual-env (node for server, happy-dom for src). The existing 30 tests stay in the node project and their include path is unchanged.

---

## Working conventions for these tasks

- **Branch:** `feature/webapp-state-e-xmeml` branched off local `main`. **Executor creates the branch**; this plan just declares it.
- **No worktree requirement.** The file surface is small (~6 files changed, ~5 added); a regular branch checkout in the same working directory is fine. Executor can opt into a worktree if they want isolation; not required.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval. Task 9 (manual verification) does not push.
- **Commit style:** conventional commits (`feat(export)`, `fix(export)`, `test(export)`, `refactor(export)`). One commit per task. Add the Claude co-author trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"`.
- **Never kill backend dev server on port 3001.** Tests don't need it; manual verification (Task 9) does.
- **Auth on the new server route is non-negotiable.** `POST /api/exports/:id/result` MUST use `requireAuth`, MUST owner-check, MUST 404-collapse missing-vs-not-owned to match the existing `getExportResult` / `recordExportEvent` error contract.
- **Do not amend `recordExportEvent`.** Any PR that touches `server/services/exports.js` recordExportEvent body is out-of-scope for this plan and should fail review.

---

## Task 0: Scaffold — branch + plan check-in

**Files:**
- Verify: `$TE/docs/superpowers/plans/2026-04-24-webapp-state-e-xmeml-wire.md` (this file — committed in this task)
- Create: git branch `feature/webapp-state-e-xmeml`

- [ ] **Step 1: Create the branch off local main**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git status --short
# Expected: empty (or only this plan file staged). If working tree is dirty with
# unrelated changes, STOP and stash/commit before branching.
git fetch origin main
git checkout main
git pull --ff-only origin main || echo "No remote fast-forward; continuing with local main"
git checkout -b feature/webapp-state-e-xmeml
git branch --show-current
# Expected: feature/webapp-state-e-xmeml
```

- [ ] **Step 2: Sanity-check the in-tree code we're changing**

```bash
# Confirm the files we'll modify/add all exist (or don't, as expected).
test -f server/services/exports.js && echo "exports-svc: OK" || echo "MISSING"
test -f server/routes/exports.js && echo "exports-route: OK" || echo "MISSING"
test -f server/routes/export-xml.js && echo "export-xml: OK" || echo "MISSING"
test -f src/components/export/StateE_Complete_Placeholder.jsx && echo "state-e-placeholder: OK" || echo "MISSING"
test -f src/pages/ExportPage.jsx && echo "exportpage: OK" || echo "MISSING"
test -f src/lib/buildManifest.js && echo "buildManifest: OK" || echo "MISSING"
test -f src/hooks/useExportPort.js && echo "useExportPort: OK" || echo "MISSING"
test -f vitest.config.js && echo "vitest-config: OK" || echo "MISSING"
# Expected: all "OK". If any "MISSING", the base branch isn't what we think.
```

- [ ] **Step 3: Run the existing 30 tests — baseline must pass**

```bash
npm run test 2>&1 | tail -6
# Expected:
#   Test Files  1 passed (1)
#   Tests       30 passed (30)
# If this fails, STOP. Don't build on a broken baseline.
```

- [ ] **Step 4: Confirm this plan file is at the expected path, then commit**

```bash
test -f docs/superpowers/plans/2026-04-24-webapp-state-e-xmeml-wire.md && echo OK || echo "MISSING plan"
# Expected: OK
git status --short
# Expected: show the plan file as untracked or newly added
git add docs/superpowers/plans/2026-04-24-webapp-state-e-xmeml-wire.md
git commit -m "$(cat <<'EOF'
docs(plan): State E XMEML wire-up + prod-404 fix

Diagnosis: POST /api/exports/:id/generate-xml returns 404 because
no code path writes exports.result_json in the {variants:[...]}
shape getExportResult() reads. The extension's {type:"complete"}
Port message carries {ok_count, fail_count, folder_path, xml_paths:[]}
— no variants, no placements. recordExportEvent writes raw `meta`
(which is {ok_count, fail_count, total_bytes_downloaded}) into
result_json. getExportResult returns null → endpoint 404s.

Fix is client-side: new hook assembles {variants:[...]} from the
unified manifest (already built at State C), POSTs to a new thin
`POST /api/exports/:id/result` endpoint, then calls the existing
generate-xml endpoint. Phase 1's event recorder is untouched;
export_events keeps receiving per-transition rows.

Scope: 1 new server route, 1 new hook, 1 new component
(replaces placeholder), 1 reducer action in ExportPage, 2 test
files, vitest dual-env config.

Explicit non-goals: extension change, schema change, Phase 1
touch, File System Access API, State F full UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Verify commit landed on the feature branch**

```bash
git log --oneline -3
# Expected: top line is the plan check-in on feature/webapp-state-e-xmeml
git log --oneline main...feature/webapp-state-e-xmeml
# Expected: exactly one commit (the plan commit)
```

---

## Task 1: Add happy-dom devDep + dual-environment vitest config

The existing `vitest.config.js` is node-only (`environment: 'node'`, `include: ['server/**/__tests__/**/*.test.js']`). We need a second project for `src/**/__tests__/**/*.test.js` using `happy-dom` so React hooks / `URL.createObjectURL` / DOM globals work. Keep the 30 existing tests on the node project — no regression.

**Files:**
- Modify: `$TE/package.json` (add `happy-dom` devDep + `@testing-library/react` for hook testing)
- Modify: `$TE/vitest.config.js` (switch to workspace-style dual-config)

- [ ] **Step 1: Decide whether to use happy-dom + Testing Library or bare happy-dom + raw hook callers**

The project currently has NO `@testing-library/*` dependencies. Installing `@testing-library/react` + `@testing-library/react-hooks` adds ~2MB of devDep surface. **Cheaper path:** use bare `happy-dom` + `React.createElement` + `ReactDOM.createRoot` in the one hook test, or skip DOM rendering entirely and test the hook's pure `buildVariantsPayload` export (no DOM needed) + mock `apiPost` directly without mounting the hook.

**Decision: bare `happy-dom` only, no Testing Library.** Rationale:
- Only one test file in `src/` (this plan). Not worth pulling a whole test-library ecosystem for one file.
- `buildVariantsPayload` is a pure function — tests run in the node project, no DOM.
- For the hook's orchestration test, we drive the `useExportXmlKickoff` output via a thin wrapper `renderHook`-equivalent of ~15 lines using `React.act` + `createRoot`. Works under happy-dom. Documented in Task 7.
- Blob + anchor-click test: happy-dom provides `URL.createObjectURL` stub; we spy on `document.createElement('a').click` to assert the download was triggered.

```bash
# No install yet — we make the call in Step 2.
echo "Decision: bare happy-dom, no Testing Library. See plan Task 1 Step 1."
```

- [ ] **Step 2: Install happy-dom as a devDep**

```bash
cd "$TE"
# Pin to a known-good version that works with vitest 1.6.x.
npm install --save-dev happy-dom@^14.12.0
# Expected: happy-dom added to devDependencies; package-lock updated.
git diff --stat package.json package-lock.json
# Expected: 2 files changed, new devDep entry + lock updates
```

- [ ] **Step 3: Read the current `vitest.config.js` before rewriting it**

Read tool, full file. You should see the existing 18-line node-only config. If it's longer than that, someone else modified it — merge carefully.

- [ ] **Step 4: Rewrite `vitest.config.js` using workspace-style dual-project config**

Use `Edit` (NOT `Write`) — rewrite in one shot via `old_string` / `new_string`. The replacement keeps the existing options (coverage, globals, reporters) and adds projects.

`old_string` (the whole existing config, including comment header):
```js
// Vitest config for transcript-eval. First test harness in the project
// — kept minimal. Tests live next to the code they test, under a
// __tests__/ directory, to match the server/services/__tests__/ pattern
// established by WebApp.2.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',        // server-side code; no DOM
    include: ['server/**/__tests__/**/*.test.js'],
    globals: false,             // explicit imports of describe/it/expect
    reporters: 'default',
    watch: false,               // `npm run test:watch` opts in
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['server/services/**/*.js'],
      exclude: ['server/services/__tests__/**', 'server/services/*.py'],
    },
  },
})
```

`new_string`:
```js
// Vitest config for transcript-eval. Dual-environment:
//   - Node project: server-side code (services, routes). No DOM.
//   - Browser project: React hooks + pure frontend utilities under
//     src/. Uses happy-dom for URL.createObjectURL + document globals.
//
// Both projects share `globals: false` so describe/it/expect are
// always explicit imports — keeps tests portable and greppable.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Defaults apply unless a project overrides.
    globals: false,
    reporters: 'default',
    watch: false,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['server/services/**/*.js', 'src/hooks/**/*.js', 'src/lib/**/*.js'],
      exclude: [
        'server/services/__tests__/**',
        'server/services/*.py',
        'src/hooks/__tests__/**',
        'src/lib/__tests__/**',
      ],
    },
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/**/__tests__/**/*.test.js'],
        },
      },
      {
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['src/**/__tests__/**/*.test.js', 'src/**/__tests__/**/*.test.jsx'],
        },
      },
    ],
  },
})
```

- [ ] **Step 5: Run tests — confirm the 30 existing tests still pass AND vitest picks up the new project (even though it has no tests yet)**

```bash
npm run test 2>&1 | tail -12
# Expected: both projects run. `server` project: 30 passed. `web` project: no tests
# yet, exits OK because vitest accepts an empty project. If happy-dom throws
# a missing-module error, Step 2 didn't land — re-run `npm install`.
```

If vitest 1.6.x doesn't support `projects` config key, fall back to `workspace` key (vitest pre-2.0 syntax) — define `vitest.workspace.js` at the repo root listing two config files. Verify the fallback path works before committing.

**Fallback path (use only if `projects` isn't supported by vitest 1.6.x):**

```js
// vitest.workspace.js (NEW)
import { defineWorkspace } from 'vitest/config'
export default defineWorkspace([
  './vitest.server.config.js',
  './vitest.web.config.js',
])
```

Then split the per-project configs. Task author to pick whichever vitest 1.6.x actually supports — verify with `npx vitest --help | grep -i project` before committing.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.js
# If using the fallback: also add vitest.workspace.js + vitest.server.config.js + vitest.web.config.js
git diff --cached --stat
# Expected: 3 files (or 5 with fallback). All under config/deps.
git commit -m "$(cat <<'EOF'
chore(test): dual-environment vitest — node + happy-dom

Add happy-dom devDep and split vitest into two projects:

  - server: Node 20 env, server/**/__tests__/**/*.test.js
            (existing 30 XMEML generator tests stay here)
  - web:    happy-dom, src/**/__tests__/**/*.test.{js,jsx}
            (new home for the State E XMEML hook tests
             landing in later tasks of this plan)

Keep globals off so describe/it/expect stay explicit imports.
Coverage widened to include src/hooks and src/lib (but excludes
__tests__).

happy-dom over jsdom: lighter, faster, and sufficient for the
URL.createObjectURL + <a>.click surface the XMEML download flow
exercises. No Testing Library — we'll use bare React + createRoot
for the one hook integration test (see plan Task 7).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Server — `writeExportResult` service helper

Add a service-layer function that writes the `{variants:[...]}` shape into `exports.result_json` with the same owner-check semantics as `getExportResult`. Kept in `server/services/exports.js` alongside the other exports helpers.

**Files:**
- Modify: `$TE/server/services/exports.js` (add `writeExportResult`, no changes to existing exports)

- [ ] **Step 1: Read the existing `server/services/exports.js`**

Use Read tool, full file. Note the export list at the top, the `ValidationError` / `NotFoundError` imports, and the existing `db.prepare(...).run(...)` pattern on line 173. You'll mirror that pattern.

- [ ] **Step 2: Insert `writeExportResult` right after `getExportResult` (line ~83)**

The helper belongs grouped with `getExportResult` since they're the read/write pair for the same column.

Use `Edit`. Match on the trailing line of `getExportResult` + the `const ALLOWED_EVENTS` declaration that follows it, since that's a unique line pair.

`old_string`:
```js
export async function getExportResult(id, { userId } = {}) {
  const row = await db.prepare(
    'SELECT id, user_id, status, folder_path, result_json FROM exports WHERE id = ?'
  ).get(id)
  if (!row) return null
  if (userId && row.user_id && row.user_id !== userId) return null
  if (!row.result_json) return null
  let parsed
  try { parsed = JSON.parse(row.result_json) } catch { return null }
  if (!parsed || !Array.isArray(parsed.variants)) return null
  return {
    export_id: row.id,
    status: row.status,
    folder_path: row.folder_path || null,
    variants: parsed.variants,
  }
}

const ALLOWED_EVENTS = new Set([
```

`new_string`:
```js
export async function getExportResult(id, { userId } = {}) {
  const row = await db.prepare(
    'SELECT id, user_id, status, folder_path, result_json FROM exports WHERE id = ?'
  ).get(id)
  if (!row) return null
  if (userId && row.user_id && row.user_id !== userId) return null
  if (!row.result_json) return null
  let parsed
  try { parsed = JSON.parse(row.result_json) } catch { return null }
  if (!parsed || !Array.isArray(parsed.variants)) return null
  return {
    export_id: row.id,
    status: row.status,
    folder_path: row.folder_path || null,
    variants: parsed.variants,
  }
}

// Write the post-run {variants:[...]} shape to exports.result_json.
// Called by WebApp.1's State E handler AFTER the Chrome extension
// signals {type:"complete"} — the web app already has placement
// timing data from the unified manifest built at State C, so it
// assembles the shape client-side and POSTs it here. Phase 1's
// recordExportEvent does NOT write this shape (meta is just counts);
// this helper is the sole writer of the XMEML-ready payload.
//
// Shape: { variants: [{ label, sequenceName, placements: [{
//   seq, source, sourceItemId, filename,
//   timelineStart, timelineDuration,
//   width?, height?, sourceFrameRate?
// }, ...] }, ...] }
//
// Ownership: same 404-collapsing rule as recordExportEvent — missing
// row OR not-owned row both throw NotFoundError so the endpoint
// can't be used to enumerate export IDs.
//
// Idempotency: repeated writes with the same shape are safe — the
// generator is deterministic, so re-running the endpoint yields
// identical XML. Callers SHOULD de-dupe, but the server doesn't
// enforce it.
export async function writeExportResult({ id, userId, variants }) {
  if (!id || typeof id !== 'string') throw new ValidationError('export id required')
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new ValidationError('variants must be a non-empty array')
  }
  for (const v of variants) {
    if (!v || typeof v !== 'object') throw new ValidationError('each variant must be an object')
    if (typeof v.label !== 'string' || !v.label) throw new ValidationError('variant.label must be a non-empty string')
    if (typeof v.sequenceName !== 'string' || !v.sequenceName) {
      throw new ValidationError('variant.sequenceName must be a non-empty string')
    }
    if (!Array.isArray(v.placements)) throw new ValidationError('variant.placements must be an array')
    // The generator itself validates per-placement fields; we do a
    // minimal shape check here so obvious client bugs surface before
    // the generator throws.
    for (const p of v.placements) {
      if (!p || typeof p !== 'object') throw new ValidationError('each placement must be an object')
      if (typeof p.seq !== 'number' || !Number.isFinite(p.seq)) {
        throw new ValidationError('placement.seq must be a finite number')
      }
      if (typeof p.filename !== 'string' || !p.filename) {
        throw new ValidationError('placement.filename must be a non-empty string')
      }
      if (typeof p.timelineStart !== 'number' || !Number.isFinite(p.timelineStart)) {
        throw new ValidationError('placement.timelineStart must be a finite number')
      }
      if (typeof p.timelineDuration !== 'number' || !Number.isFinite(p.timelineDuration)) {
        throw new ValidationError('placement.timelineDuration must be a finite number')
      }
    }
  }

  const row = await db.prepare('SELECT id, user_id FROM exports WHERE id = ?').get(id)
  if (!row || (userId && row.user_id && row.user_id !== userId)) {
    throw new NotFoundError('export_id not found')
  }

  const payload = JSON.stringify({ variants })
  await db.prepare('UPDATE exports SET result_json = ? WHERE id = ?').run(payload, id)

  return { ok: true }
}

const ALLOWED_EVENTS = new Set([
```

- [ ] **Step 3: Confirm the existing exported surface grew by exactly one name**

```bash
cd "$TE"
grep -E "^export (async )?function" server/services/exports.js
# Expected lines:
#   export function mintExportId() {
#   export async function createExport({ ... }) {
#   export async function getExport(id, { ... }) {
#   export async function getExportResult(id, { ... }) {
#   export async function writeExportResult({ ... }) {
#   export async function recordExportEvent({ ... }) {
```

- [ ] **Step 4: Quick mental typecheck**

No static types in JS — check by running the existing tests + attempting to import `writeExportResult` in a scratch file. Don't commit the scratch; just confirm the ESM surface.

```bash
node --input-type=module -e "
import('./server/services/exports.js').then(m => {
  console.log('exports:', Object.keys(m).filter(k => !k.startsWith('Validation') && !k.startsWith('NotFound')))
})
" 2>&1 | head -5
# Expected: exports: [ 'mintExportId', 'createExport', 'getExport',
#   'getExportResult', 'writeExportResult', 'recordExportEvent',
#   'ValidationError', 'NotFoundError' ]
# (ValidationError/NotFoundError are re-exports and filtered out above;
# adjust the filter if this script doesn't show what you expect.)
```

- [ ] **Step 5: Run existing tests — MUST STILL BE 30 passing**

```bash
npm run test 2>&1 | tail -6
# Expected: Tests 30 passed (30). Any other number: STOP and diagnose.
```

- [ ] **Step 6: Commit**

```bash
git add server/services/exports.js
git diff --cached --stat
# Expected: 1 file, ~60 lines added, 0 removed
git commit -m "$(cat <<'EOF'
feat(exports): writeExportResult service helper

Adds a new service-layer writer for exports.result_json in the
{variants:[{label, sequenceName, placements:[...]}, ...]} shape the
XMEML endpoint reads. This is the sole writer of that shape —
Phase 1's recordExportEvent continues to write raw telemetry meta,
which is intentional per the plan diagnosis.

Validation is minimal but surface-level (non-empty array, required
string/number fields on each placement) so obvious client bugs 400
before the XMEML generator chokes on them. Ownership semantics match
getExportResult / recordExportEvent: missing-vs-not-owned both 404
via NotFoundError to prevent ID enumeration.

Idempotent: same payload → same UPDATE → same XML downstream.
Generator is deterministic, so re-calls are cheap and safe.

Tests in Task 4; no behavior visible externally until Task 3 wires
the endpoint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server — `POST /api/exports/:id/result` endpoint

Wires `writeExportResult` behind an HTTP route. Mounted alongside the existing `POST /api/exports` in `server/routes/exports.js` — same router, one new handler.

**Files:**
- Modify: `$TE/server/routes/exports.js` (add `POST /:id/result` to the main router)

- [ ] **Step 1: Read `server/routes/exports.js`**

Read full file. Note the existing `router.post('/', requireAuth, ...)` handler on line 10. We'll insert our new handler just after it, before the other named routers (`sessionTokenRouter`, etc.).

- [ ] **Step 2: Extend the import line to include `writeExportResult`**

`old_string`:
```js
import { createExport, recordExportEvent, ValidationError, NotFoundError } from '../services/exports.js'
```

`new_string`:
```js
import { createExport, recordExportEvent, writeExportResult, ValidationError, NotFoundError } from '../services/exports.js'
```

- [ ] **Step 3: Insert the new route handler**

Match on the closing `})` of the existing POST `/` handler + the `export const sessionTokenRouter` line.

`old_string`:
```js
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { plan_pipeline_id, variant_labels, manifest } = req.body || {}
    const result = await createExport({
      userId: req.auth?.userId || null,
      planPipelineId: plan_pipeline_id,
      variantLabels: variant_labels,
      manifest,
    })
    res.status(201).json(result)
  } catch (err) {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

export const sessionTokenRouter = Router()
```

`new_string`:
```js
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { plan_pipeline_id, variant_labels, manifest } = req.body || {}
    const result = await createExport({
      userId: req.auth?.userId || null,
      planPipelineId: plan_pipeline_id,
      variantLabels: variant_labels,
      manifest,
    })
    res.status(201).json(result)
  } catch (err) {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

// POST /api/exports/:id/result
//
// Writes the {variants:[{label, sequenceName, placements}, ...]} shape to
// exports.result_json. Called by WebApp.1's State E handler AFTER the
// extension signals {type:"complete"} — the client has the placement
// timing data from the unified manifest built at State C, so the client
// is the authority on what to write.
//
// Why not put this inside the extension telemetry flow? Phase 1's
// recordExportEvent writes raw `meta` (counts only) to result_json;
// coercing its shape would conflate telemetry semantics with a write
// concern for a specific downstream consumer (XMEML). Keeping the
// writer separate here means the extension contract doesn't have to
// care about XMEML's input shape.
//
// Request body: { variants: [{ label, sequenceName, placements: [...] }, ...] }
// Response: 200 { ok: true } | 400 { error } | 404 { error } | 500 passthrough
router.post('/:id/result', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth?.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    const { id } = req.params
    const { variants } = req.body || {}
    const result = await writeExportResult({ id, userId, variants })
    res.status(200).json(result)
  } catch (err) {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message })
    if (err instanceof NotFoundError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

export const sessionTokenRouter = Router()
```

- [ ] **Step 4: Double-check the route doesn't collide with the existing `POST /:id/generate-xml` route**

The exports router is mounted at `/api/exports` (server/index.js:60), and `exportXmlRouter` is mounted at the same base path (server/index.js:61). Express evaluates routers in registration order; our new `POST /:id/result` handler on the first (main) router is distinct from `POST /:id/generate-xml` on the second. `Express` resolves by literal path, not prefix — `/result` doesn't match `/generate-xml`.

```bash
# Sanity-grep: should show three exports-API routes with distinct paths.
grep -nE "router.post|router.get" server/routes/exports.js server/routes/export-xml.js
# Expected, among others:
#   server/routes/exports.js:router.post('/', requireAuth, ...
#   server/routes/exports.js:router.post('/:id/result', requireAuth, ...
#   server/routes/export-xml.js:router.post('/:id/generate-xml', requireAuth, ...
```

- [ ] **Step 5: Run the 30 existing tests — still pass**

```bash
npm run test 2>&1 | tail -6
# Expected: Tests 30 passed (30). No behavioral change to tested code paths.
```

- [ ] **Step 6: Manual smoke via curl (OPTIONAL, skip if you don't have a running backend)**

Only run if `npm run dev:server` is already up. We're checking the endpoint wires correctly at the HTTP layer; the full end-to-end smoke is Task 9.

```bash
# Requires a valid Supabase JWT in $JWT and an export row owned by the user.
# Replace exp_TEST... with a real export ID from the DB if testing.
curl -sS -X POST http://localhost:3001/api/exports/exp_TEST000/result \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"variants":[{"label":"A","sequenceName":"Variant A","placements":[]}]}' | jq
# Expected: {"error": "export_id not found"} (HTTP 404) because exp_TEST000 isn't real.
# A 500 here means the handler is throwing — diagnose before committing.
```

- [ ] **Step 7: Commit**

```bash
git add server/routes/exports.js
git diff --cached --stat
# Expected: 1 file, ~40 lines added, 1 line (the import) modified
git commit -m "$(cat <<'EOF'
feat(api): POST /api/exports/:id/result — write variants shape

New endpoint mounted on the existing /api/exports router. Accepts
{variants:[{label, sequenceName, placements:[...]}, ...]} and writes
it to exports.result_json via the service-layer writeExportResult
helper.

Auth: requireAuth (Supabase JWT) + owner-check. Missing-vs-not-owned
collapsed to 404 to match the existing read path (getExportResult)
and telemetry path (recordExportEvent) — prevents ID enumeration.

This is the web app's hand-off into the XMEML generator:
1. extension posts {type:"complete"} via Port
2. web app assembles {variants:[...]} from the unified manifest
3. POST /api/exports/:id/result → result_json populated
4. POST /api/exports/:id/generate-xml → xml_by_variant returned

Phase 1's recordExportEvent remains untouched; export_events keeps
receiving per-transition rows as before.

Tests in Task 4. No extension change required.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tests — `writeExportResult` round-trip + ownership

First server-side test beyond the XMEML generator. Exercises the `writeExportResult` → `getExportResult` round-trip through the real DB (a throwaway in-memory sqlite via the project's existing `server/db.js` layer).

**Files:**
- Create: `$TE/server/services/__tests__/exports.test.js`

- [ ] **Step 1: Confirm how `server/db.js` is set up for tests**

```bash
cd "$TE"
grep -nE "DATABASE_URL|POSTGRES|sqlite|better-sqlite3|pg.Client|new Pool" server/db.js | head -20
# Read the file if needed to understand how the test DB is spun up.
head -40 server/db.js
```

Based on the db module pattern, confirm whether the existing XMEML generator test suite is the only test and whether it avoids DB (it does — the generator is pure). This means the project currently has NO DB-backed tests. Strategy:

Option A: **Use a real test database via environment variable** (e.g., `TEST_DATABASE_URL`). Requires the test runner to spin up pg and is invasive.

Option B: **Stub the DB at the module boundary.** Use `vi.mock('../db.js', ...)` to replace `db.prepare` calls with a tiny in-memory fake. Each test controls its own return values.

**Decision: Option B (stub the DB).** Rationale:
- Scope-minimal: no new DB dependency, no test-only DB URL, no docker-compose in CI.
- The `writeExportResult` logic is a sequence of validation + one SELECT + one UPDATE. A stub can faithfully represent that.
- Round-trip via `getExportResult` is tested by stubbing the reads to return what we just wrote. Acceptable because the JSON shape being stored is deterministic, not the pg driver's behavior — we're not testing pg.

```bash
# Verify vitest supports vi.mock with ESM.
grep -n 'vi.mock\|vitest.*mock' server/services/__tests__/xmeml-generator.test.js
# (Likely returns nothing — xmeml-generator doesn't mock anything.)
```

Vitest's `vi.mock` works with ESM via hoisting; it's documented at https://vitest.dev/api/vi.html#vi-mock. Imports of `../db.js` inside `server/services/exports.js` will pick up the mock provided `vi.mock('../../db.js', ...)` fires before the import resolves (vitest hoists it automatically).

- [ ] **Step 2: Write the test file**

Create `server/services/__tests__/exports.test.js`:

```js
// Service-layer tests for writeExportResult.
//
// Strategy: mock server/db.js at the module boundary. `writeExportResult`
// does (a) a read via `db.prepare('SELECT id, user_id FROM exports WHERE id = ?').get(id)`
// and (b) a write via `db.prepare('UPDATE exports SET result_json = ? WHERE id = ?').run(payload, id)`.
// The fake DB records calls and returns scripted rows.
//
// Why mock instead of a real test DB: the project has no test-db fixture
// today and the writer's logic is validation + single SELECT + single
// UPDATE — nothing pg-specific to exercise. If a round-trip test ever
// needs real pg semantics (serialization, concurrent updates), add it
// then; we don't pre-invest.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake db state. Tests mutate this in beforeEach.
const rows = new Map() // id -> { id, user_id, result_json }

// Hoisted mock BEFORE the service import. vi.mock is auto-hoisted by
// vitest; the factory runs before any `import` in this file resolves.
vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        get(id) {
          if (/SELECT .* FROM exports WHERE id = \?/.test(sql)) {
            return rows.get(id) || null
          }
          throw new Error(`unexpected .get SQL: ${sql}`)
        },
        run(...args) {
          if (sql.startsWith('UPDATE exports SET result_json = ?')) {
            const [payload, id] = args
            const row = rows.get(id)
            if (!row) return { changes: 0 }
            rows.set(id, { ...row, result_json: payload })
            return { changes: 1 }
          }
          throw new Error(`unexpected .run SQL: ${sql}`)
        },
      }
    },
  },
}))

// Import AFTER mock declaration.
const mod = await import('../exports.js')
const { writeExportResult, getExportResult, ValidationError, NotFoundError } = mod

beforeEach(() => {
  rows.clear()
})

describe('writeExportResult', () => {
  const baseVariants = [
    {
      label: 'A',
      sequenceName: 'Variant A',
      placements: [
        {
          seq: 1,
          source: 'envato',
          sourceItemId: 'NX9WYGQ',
          filename: '001_envato_NX9WYGQ.mov',
          timelineStart: 0,
          timelineDuration: 2.5,
        },
      ],
    },
  ]

  it('writes valid payload and round-trips via getExportResult', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    const result = await writeExportResult({
      id: 'exp_OK',
      userId: 'user-1',
      variants: baseVariants,
    })
    expect(result).toEqual({ ok: true })
    expect(rows.get('exp_OK').result_json).toBe(JSON.stringify({ variants: baseVariants }))

    // Round-trip via getExportResult. Since getExportResult reads a
    // different SELECT ('SELECT id, user_id, status, folder_path, result_json ...'),
    // extend the fake to accept it. Add columns to the row first.
    rows.set('exp_OK', { ...rows.get('exp_OK'), status: 'complete', folder_path: '~/Downloads/test' })
    const readBack = await getExportResult('exp_OK', { userId: 'user-1' })
    expect(readBack).toEqual({
      export_id: 'exp_OK',
      status: 'complete',
      folder_path: '~/Downloads/test',
      variants: baseVariants,
    })
  })

  it('404s when the export does not exist', async () => {
    await expect(
      writeExportResult({ id: 'exp_MISSING', userId: 'user-1', variants: baseVariants }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('404s when the export is owned by a different user', async () => {
    rows.set('exp_OTHER', { id: 'exp_OTHER', user_id: 'user-2', result_json: null })
    await expect(
      writeExportResult({ id: 'exp_OTHER', userId: 'user-1', variants: baseVariants }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('allows writes to null-owner exports (migration-era legacy)', async () => {
    rows.set('exp_NULLOWNER', { id: 'exp_NULLOWNER', user_id: null, result_json: null })
    const result = await writeExportResult({
      id: 'exp_NULLOWNER',
      userId: 'user-1',
      variants: baseVariants,
    })
    expect(result).toEqual({ ok: true })
    // The service is permissive on null-owner rows — same rule as
    // getExportResult. This test pins that behavior so a future
    // tightening is an explicit decision.
  })

  it('throws ValidationError on empty variants array', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    await expect(
      writeExportResult({ id: 'exp_OK', userId: 'user-1', variants: [] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError on missing variant.label', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    const bad = [{ ...baseVariants[0], label: '' }]
    await expect(
      writeExportResult({ id: 'exp_OK', userId: 'user-1', variants: bad }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError on placement with non-finite timelineStart', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    const bad = [{
      ...baseVariants[0],
      placements: [{ ...baseVariants[0].placements[0], timelineStart: Infinity }],
    }]
    await expect(
      writeExportResult({ id: 'exp_OK', userId: 'user-1', variants: bad }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError on placement with empty filename', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    const bad = [{
      ...baseVariants[0],
      placements: [{ ...baseVariants[0].placements[0], filename: '' }],
    }]
    await expect(
      writeExportResult({ id: 'exp_OK', userId: 'user-1', variants: bad }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is idempotent — re-writing the same shape yields the same stored JSON', async () => {
    rows.set('exp_IDEM', { id: 'exp_IDEM', user_id: 'user-1', result_json: null })
    await writeExportResult({ id: 'exp_IDEM', userId: 'user-1', variants: baseVariants })
    const firstWrite = rows.get('exp_IDEM').result_json
    await writeExportResult({ id: 'exp_IDEM', userId: 'user-1', variants: baseVariants })
    const secondWrite = rows.get('exp_IDEM').result_json
    expect(secondWrite).toBe(firstWrite)
  })
})
```

**Note on the round-trip test's second SELECT:** `getExportResult` runs a different SELECT statement than `writeExportResult`. The fake DB's `.get()` matches any `SELECT .* FROM exports WHERE id = ?` via the regex, so both paths share the same scripted rows. If vitest's mock hoisting causes the `getExportResult` SELECT to hit a `throw new Error('unexpected .get SQL')` path during the test, expand the regex.

- [ ] **Step 3: Run the new tests**

```bash
npm run test 2>&1 | tail -20
# Expected:
#   Test Files  2 passed (2)       # xmeml-generator + exports
#   Tests       30 + 9 = 39 passed
# The `server` project picks up both test files automatically.
```

If a test fails, fix the fake DB logic until it passes. Don't adjust the expectations.

- [ ] **Step 4: Commit**

```bash
git add server/services/__tests__/exports.test.js
git diff --cached --stat
# Expected: 1 file, ~180 lines added
git commit -m "$(cat <<'EOF'
test(exports): writeExportResult round-trip + auth coverage

First DB-touching test in the project. Uses vi.mock on db.js to
provide a tiny in-memory fake; no new test-DB dependency. Exercises:

  - happy path: write → getExportResult round-trips the shape
  - 404 on missing export
  - 404 on export owned by different user
  - null-owner row is writable (legacy, pinned by this test)
  - ValidationError on empty variants array
  - ValidationError on missing variant.label
  - ValidationError on non-finite timelineStart
  - ValidationError on empty filename
  - idempotency: same payload → same stored JSON

Running: vitest server project, now 39 tests (was 30).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Client — `useExportXmlKickoff` hook (+ pure `buildVariantsPayload`)

The heart of the client-side fix. Pure transform + React orchestration. Exports `buildVariantsPayload` separately for testing without mounting.

**Files:**
- Create: `$TE/src/hooks/useExportXmlKickoff.js`

- [ ] **Step 1: Sketch the contract**

```js
// Inputs:
//   exportId: string
//   variantLabels: string[]                 // e.g. ['A', 'C']
//   unifiedManifest: ReturnType<buildManifest>
//   complete: { ok_count, fail_count, folder_path, xml_paths } | null
//
// Returns:
//   status: 'idle' | 'posting-result' | 'generating' | 'ready' | 'error'
//   xml_by_variant: { A: string, C: string } | null
//   error: string | null
//   regenerate: () => void
//
// Side effects:
//   - When `complete` transitions from null → non-null AND fail_count === 0,
//     auto-runs the 3-step flow: build → POST /result → POST /generate-xml.
//   - When the 3-step flow succeeds, synthesizes one Blob + <a>.click() per
//     variant, filename `variant-<label-lowercased>.xml`. Creates object
//     URLs and revokes them after a 10s grace window (same pattern used by
//     React's own `useSyncExternalStore` tutorials — long enough for the
//     browser download to grab the blob, short enough to not leak).
//   - regenerate() re-runs the 3-step flow even if xml_by_variant is populated.
//     UI uses this to retry on 500.
```

- [ ] **Step 2: Write `buildVariantsPayload` (pure function)**

This is the transform you'll unit-test first. It turns the unified manifest + variant labels into the shape `writeExportResult` accepts.

Before writing, reread `src/lib/buildManifest.js` to lock in exactly what fields are on each item and each placement:

```
item: {
  seq, source, source_item_id, envato_item_url, target_filename,
  resolution: {width, height}, frame_rate, est_size_bytes,
  variants: [],
  placements: [{ variant, timeline_start_s, timeline_duration_s }, ...]
}
```

Transform rule: for each variant label `L`:
- Filter `items` to those whose `placements[]` contains at least one entry with `variant === L`.
- For each matching item + each of its placements with `variant === L`, emit one XMEML placement `{seq, source, sourceItemId, filename, timelineStart, timelineDuration, width?, height?, sourceFrameRate?}`.
- Preserve `seq` as the item's manifest seq (not re-numbered per variant — the XMEML generator uses `seq` for `<clipitem id>` and track tie-breaking, and stable seq across variants means a clip shared between A and C gets the same ID, which is exactly what we want for multi-variant dedup).
- `sequenceName = "Variant <label>"` (mirrors the Phase 1 plan's example).
- Skip items whose `timeline_start_s` or `timeline_duration_s` is `null` or non-finite — log once in development (`console.warn`) but otherwise drop silently. These are items that slipped through broll manifest without timing info; the XMEML generator would throw on them otherwise.

- [ ] **Step 3: Write `useExportXmlKickoff.js`**

```js
// src/hooks/useExportXmlKickoff.js
//
// State E's primary driver. Takes the Ext.5 extension's {type:"complete"}
// payload + the unified manifest built at State C and produces per-variant
// XMEML strings ready to download.
//
// Flow (auto-runs on completion; manual re-run via `regenerate`):
//   1. buildVariantsPayload(unifiedManifest, variantLabels)
//      → {variants:[{label, sequenceName, placements:[...]}, ...]}
//   2. POST /api/exports/:id/result
//      → writes the shape to exports.result_json
//   3. POST /api/exports/:id/generate-xml with {variants: variantLabels}
//      → server reads result_json, runs generateXmeml() per variant
//   4. For each returned xml string, synthesize a Blob + <a>.click()
//      → browser downloads variant-<label>.xml into default folder
//
// State machine:
//   idle → posting-result → generating → ready
//                                      ↘ error (terminal until regenerate)
//
// De-duplication: tracks a request ID (`activeRequestRef`). regenerate()
// bumps it; any in-flight promise whose captured ID no longer matches
// the active one is dropped. Prevents double-POST on double-click.

import { useState, useEffect, useRef, useCallback } from 'react'
import { apiPost } from './useApi.js'

// ----------------------------------------------------------------------
// Pure transform: unified manifest → endpoint-ready variants shape.
//
// Exported as a named export so tests can exercise it without a React
// tree. See src/hooks/__tests__/useExportXmlKickoff.test.js.
//
// Why "Variant X" as sequenceName: matches the XMEML plan's example and
// is human-readable when the user opens the XML in Premiere. If the
// editor later introduces user-editable variant names, thread through.

const DEFAULT_SEQ_FRAME_RATE = 30

export function buildVariantsPayload({ unifiedManifest, variantLabels }) {
  if (!unifiedManifest || !Array.isArray(unifiedManifest.items)) {
    throw new Error('buildVariantsPayload: unifiedManifest.items required')
  }
  if (!Array.isArray(variantLabels) || variantLabels.length === 0) {
    throw new Error('buildVariantsPayload: variantLabels must be a non-empty array')
  }

  const variants = []

  for (const label of variantLabels) {
    const placements = []
    for (const item of unifiedManifest.items) {
      if (!Array.isArray(item.placements)) continue
      for (const pl of item.placements) {
        if (pl.variant !== label) continue
        const ts = pl.timeline_start_s
        const td = pl.timeline_duration_s
        if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
        if (typeof td !== 'number' || !Number.isFinite(td) || td <= 0) continue
        placements.push({
          seq: item.seq,
          source: item.source || '',
          sourceItemId: item.source_item_id || '',
          filename: item.target_filename || '',
          timelineStart: ts,
          timelineDuration: td,
          // Optional per-placement overrides — fall back to sequence
          // defaults in the generator if omitted. We pass width/height
          // only if explicit to avoid burning in a guessed 1920x1080.
          ...(item.resolution?.width ? { width: item.resolution.width } : {}),
          ...(item.resolution?.height ? { height: item.resolution.height } : {}),
          ...(item.frame_rate ? { sourceFrameRate: item.frame_rate } : {}),
        })
      }
    }
    variants.push({
      label,
      sequenceName: `Variant ${label}`,
      placements,
    })
  }

  return { variants }
}

// ----------------------------------------------------------------------
// Browser-side download helper. Encapsulated for easier test spying.
// Synthesizes one anchor + one click per variant, revokes the URL
// after 10 seconds (long enough for any browser to pick up the blob;
// short enough not to leak if the user closes the tab).

export function triggerXmlDownload(filename, xmlString) {
  const blob = new Blob([xmlString], { type: 'application/xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // Next tick, remove the element. Schedule URL revocation later.
  setTimeout(() => {
    try { document.body.removeChild(a) } catch {}
  }, 0)
  setTimeout(() => {
    try { URL.revokeObjectURL(url) } catch {}
  }, 10_000)
  return url  // returned for test assertions; callers can ignore
}

// ----------------------------------------------------------------------
// The hook.
//
// Accepts `autoKick` (default true) for the standard auto-run flow.
// Tests pass `autoKick: false` to drive the flow explicitly.

const STATUS_IDLE = 'idle'
const STATUS_POSTING_RESULT = 'posting-result'
const STATUS_GENERATING = 'generating'
const STATUS_READY = 'ready'
const STATUS_ERROR = 'error'

export function useExportXmlKickoff({
  exportId,
  variantLabels,
  unifiedManifest,
  complete,
  autoKick = true,
  // Test-seams: override the network or download primitives. Default
  // to the real ones. Keeping them injectable avoids heavy mocking
  // frameworks in tests.
  _apiPost = apiPost,
  _triggerDownload = triggerXmlDownload,
} = {}) {
  const [status, setStatus] = useState(STATUS_IDLE)
  const [xmlByVariant, setXmlByVariant] = useState(null)
  const [error, setError] = useState(null)
  const activeRequestRef = useRef(0)

  const run = useCallback(async () => {
    if (!exportId || !unifiedManifest || !Array.isArray(variantLabels) || variantLabels.length === 0) {
      setError('missing inputs (exportId / unifiedManifest / variantLabels)')
      setStatus(STATUS_ERROR)
      return
    }
    const reqId = ++activeRequestRef.current
    setError(null)
    setStatus(STATUS_POSTING_RESULT)
    try {
      const body = buildVariantsPayload({ unifiedManifest, variantLabels })
      await _apiPost(`/exports/${encodeURIComponent(exportId)}/result`, body)
      if (reqId !== activeRequestRef.current) return  // superseded
      setStatus(STATUS_GENERATING)
      const resp = await _apiPost(
        `/exports/${encodeURIComponent(exportId)}/generate-xml`,
        { variants: variantLabels },
      )
      if (reqId !== activeRequestRef.current) return
      const xmls = resp?.xml_by_variant || {}
      setXmlByVariant(xmls)
      for (const label of variantLabels) {
        const xml = xmls[label]
        if (typeof xml !== 'string' || !xml) continue
        const filename = `variant-${String(label).toLowerCase()}.xml`
        _triggerDownload(filename, xml)
      }
      setStatus(STATUS_READY)
    } catch (err) {
      if (reqId !== activeRequestRef.current) return
      setError(err?.message || String(err))
      setStatus(STATUS_ERROR)
    }
  }, [exportId, variantLabels, unifiedManifest, _apiPost, _triggerDownload])

  // Auto-run on the null → complete-with-no-failures transition.
  // We do NOT auto-run for partial failures (State F); State F will
  // offer a "Generate XML anyway" button that calls regenerate() on
  // demand. Keeping that out of scope for this plan — State F is
  // deferred — but we avoid regressing around it: the auto-run
  // condition here is exactly `fail_count === 0`.
  const lastCompleteRef = useRef(null)
  useEffect(() => {
    if (!autoKick) return
    if (!complete) return
    if (lastCompleteRef.current === complete) return
    lastCompleteRef.current = complete
    if ((complete.fail_count ?? 0) === 0) {
      run()
    }
    // If fail_count > 0, do nothing here — State F is responsible.
  }, [complete, autoKick, run])

  const regenerate = useCallback(() => {
    // User clicked "Retry". Bump the request ID before calling run()
    // so any in-flight response is dropped.
    run()
  }, [run])

  return {
    status,
    xml_by_variant: xmlByVariant,
    error,
    regenerate,
  }
}
```

- [ ] **Step 4: Lint check — no syntax errors**

```bash
cd "$TE"
node --input-type=module -e "
import('./src/hooks/useExportXmlKickoff.js').then(m => {
  console.log('exports:', Object.keys(m))
})
" 2>&1 | head -6
# Expected: exports: [ 'buildVariantsPayload', 'triggerXmlDownload', 'useExportXmlKickoff' ]
# If you get an import error for React, that's expected outside a Vite build —
# skip this step and rely on the test in Task 7 instead.
```

In practice this ESM check fails because `useState` imports from `react` which expects a Vite resolution context. Skip if it fails — the test in Task 7 will cover it.

- [ ] **Step 5: Run the existing 39 tests — no regressions**

```bash
npm run test 2>&1 | tail -6
# Expected: Tests 39 passed (39). Hook added but not yet tested — not a regression.
```

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useExportXmlKickoff.js
git diff --cached --stat
# Expected: 1 file, ~160 lines added
git commit -m "$(cat <<'EOF'
feat(export): useExportXmlKickoff hook — State E XMEML flow

Orchestrates the 3-step hand-off from the extension's {type:"complete"}
Port message to downloaded XML files in the user's default downloads
folder:

  1. buildVariantsPayload — pure transform from the unified manifest
     (built at State C) + variant labels into the {variants:[...]}
     shape POST /api/exports/:id/result accepts.
  2. POST /api/exports/:id/result — writes the shape to result_json.
  3. POST /api/exports/:id/generate-xml — reads result_json, runs
     generateXmeml per variant, returns xml_by_variant.
  4. triggerXmlDownload — Blob + <a download> per variant, filename
     `variant-<label>.xml`. No File System Access API (deferred).

Auto-kicks on the null→complete-with-no-failures transition; does
nothing if fail_count > 0 (State F owns that dispatch).

buildVariantsPayload is exported independently so tests can hit the
transform without mounting the hook. Network + download primitives
are injectable via _apiPost / _triggerDownload options for testing.

Tests in Task 7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Client — `StateE_Complete.jsx` component + delete placeholder

Replaces `StateE_Complete_Placeholder.jsx` with the real UI. Consumes `useExportXmlKickoff` + the extension's `complete` payload. Matches the design language of the existing placeholder (same `Wrap` / `Card` / `Header` styled-components feel — don't reinvent the look).

**Files:**
- Create: `$TE/src/components/export/StateE_Complete.jsx`
- Delete: `$TE/src/components/export/StateE_Complete_Placeholder.jsx`

- [ ] **Step 1: Read the placeholder for style inventory**

Already read above. The colors (`#15803d` for the success header, `#1f2937` body text, border `#e5e7eb`) and the `Card` padding should carry over. Drop the `StubBanner` — this is no longer a placeholder.

- [ ] **Step 2: Write `StateE_Complete.jsx`**

```jsx
import styled from 'styled-components'
import { CheckCircle2, Download, FileText, AlertCircle } from 'lucide-react'
import { useExportXmlKickoff, triggerXmlDownload } from '../../hooks/useExportXmlKickoff.js'

// State E: export succeeded, zero failures, XMEML generation in
// progress or ready. Reads:
//   - `complete`          — the extension's {type:"complete"} payload
//                           (ok_count, folder_path). Always available
//                           when this component mounts.
//   - `exportId`          — the export row ID (from the FSM).
//   - `variantLabels`     — e.g. ['A', 'C'] for multi-variant exports.
//   - `unifiedManifest`   — built at State C and passed through the FSM.
//
// The useExportXmlKickoff hook does the heavy lifting: auto-kicks
// the 3-step write + generate + download flow on mount. This
// component renders the status + download buttons.

const Wrap = styled.div`
  max-width: 640px;
  margin: 60px auto;
  padding: 0 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1a1a1a;
`

const Card = styled.div`
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 28px 32px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
`

const Header = styled.h1`
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 12px;
  color: #15803d;
`

const Summary = styled.p`
  margin: 0 0 20px;
  color: #4b5563;
  font-size: 14px;
`

const Section = styled.div`
  margin: 16px 0;
`

const SectionLabel = styled.div`
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 8px;
  letter-spacing: 0.02em;
`

const Folder = styled.div`
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px 14px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #1f2937;
  word-break: break-all;
`

const Status = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #4b5563;
`

const DownloadBtn = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #1a1a1a;
  font-size: 13px;
  cursor: pointer;
  &:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
`

const RetryBtn = styled(DownloadBtn)`
  color: #b91c1c;
  border-color: #fca5a5;
  &:hover {
    background: #fef2f2;
    border-color: #ef4444;
  }
`

const ErrorBox = styled.div`
  padding: 10px 14px;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 12px;
`

const Tutorial = styled.details`
  margin-top: 20px;
  font-size: 13px;
  color: #4b5563;
  summary {
    cursor: pointer;
    color: #2563eb;
    font-weight: 500;
  }
  p {
    margin: 8px 0 0;
    line-height: 1.5;
  }
`

export default function StateE_Complete({
  complete,
  exportId,
  variantLabels,
  unifiedManifest,
}) {
  const ok = complete?.ok_count ?? 0
  const folder = complete?.folder_path ?? '(unknown)'

  const kickoff = useExportXmlKickoff({
    exportId,
    variantLabels,
    unifiedManifest,
    complete,
  })

  const pluralClip = ok === 1 ? 'clip' : 'clips'
  const xmlByVariant = kickoff.xml_by_variant || {}
  const variantsReady = kickoff.status === 'ready' && Object.keys(xmlByVariant).length > 0

  function onDownloadAgain(label) {
    const xml = xmlByVariant[label]
    if (!xml) return
    triggerXmlDownload(`variant-${String(label).toLowerCase()}.xml`, xml)
  }

  return (
    <Wrap>
      <Card>
        <Header>
          <CheckCircle2 size={22} /> Export complete
        </Header>
        <Summary>
          {ok} {pluralClip} downloaded to your default downloads folder.
        </Summary>

        <Section>
          <SectionLabel>Folder</SectionLabel>
          <Folder>{folder}</Folder>
        </Section>

        <Section>
          <SectionLabel>Premiere XML</SectionLabel>
          {kickoff.status === 'posting-result' && (
            <Status><FileText size={16} /> Preparing XML…</Status>
          )}
          {kickoff.status === 'generating' && (
            <Status><FileText size={16} /> Generating XML…</Status>
          )}
          {kickoff.status === 'error' && (
            <>
              <ErrorBox>
                <strong>Couldn&rsquo;t generate XML.</strong>{' '}
                {kickoff.error || 'Unknown error.'} Your media files are
                safe on disk — retry below or open the folder manually.
              </ErrorBox>
              <RetryBtn type="button" onClick={kickoff.regenerate}>
                <AlertCircle size={14} /> Retry
              </RetryBtn>
            </>
          )}
          {variantsReady && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {variantLabels.map(label => xmlByVariant[label] ? (
                <DownloadBtn key={label} type="button" onClick={() => onDownloadAgain(label)}>
                  <Download size={14} /> Download variant-{String(label).toLowerCase()}.xml again
                </DownloadBtn>
              ) : null)}
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                XML files auto-downloaded to your default downloads folder.
                Click a button above to re-download if you cleared the browser queue.
              </div>
            </div>
          )}
          {kickoff.status === 'idle' && (
            <Status>Waiting for completion signal…</Status>
          )}
        </Section>

        <Tutorial>
          <summary>How to import in Premiere Pro</summary>
          <p>
            1. Move <code>variant-x.xml</code> into the same folder as your
            downloaded media (the folder above).
            2. In Premiere: File → Import → select the XML file.
            3. Premiere resolves the <code>file://./media/</code> paths
            relative to the XML&rsquo;s location.
          </p>
        </Tutorial>
      </Card>
    </Wrap>
  )
}
```

- [ ] **Step 3: Delete the placeholder**

```bash
rm "src/components/export/StateE_Complete_Placeholder.jsx"
ls src/components/export/StateE*.jsx
# Expected: StateE_Complete.jsx only. StateE_Complete_Placeholder.jsx gone.
```

- [ ] **Step 4: Run existing 39 tests — no regressions (component is untested here, Task 7 tests the hook)**

```bash
npm run test 2>&1 | tail -6
# Expected: Tests 39 passed (39).
```

- [ ] **Step 5: Commit**

Note: `git add` must capture both the creation and the deletion. Use `git add -A src/components/export/` to grab both at once; verify the diff staged contains exactly those two file changes.

```bash
git add src/components/export/StateE_Complete.jsx
git add src/components/export/StateE_Complete_Placeholder.jsx
git status --short
# Expected:
#   A  src/components/export/StateE_Complete.jsx
#   D  src/components/export/StateE_Complete_Placeholder.jsx
git commit -m "$(cat <<'EOF'
feat(export): real State E component + drop placeholder

StateE_Complete replaces StateE_Complete_Placeholder. Renders:

  - Success summary: ok_count, folder_path.
  - XMEML kickoff status ("Preparing XML…" / "Generating XML…"
    / "Ready" / "Error") via useExportXmlKickoff.
  - Per-variant "Download variant-X.xml again" buttons once XML
    is ready. The hook auto-triggers the first download on entry
    to State E — the buttons are for re-download.
  - Retry button on error (kickoff.regenerate).
  - Short "How to import in Premiere" inline help.

No File System Access API; the anchor-blob download goes to the
browser's default downloads folder. That's the Phase C compromise
per the State D plan.

Deleted StateE_Complete_Placeholder.jsx. Grep for _Placeholder
in src/components/export/ now returns only StateF.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Tests — `buildVariantsPayload` + hook integration

Two kinds of tests in one file:
1. **Unit tests on `buildVariantsPayload`** — pure function, drive it with hand-assembled `unifiedManifest` fixtures. Cover single variant, multi-variant, item belonging to only one variant, item with null timing (dropped), timeline values preserved exactly, sequenceName format.
2. **Integration test on `useExportXmlKickoff`** — drives the hook via a minimal React render using bare `react-dom` + `happy-dom`. Stubs `_apiPost` and `_triggerDownload`. Asserts the state machine (idle → posting-result → generating → ready), asserts the two POST bodies match, asserts `triggerDownload` is called once per variant with the right filename + XML string.

**Files:**
- Create: `$TE/src/hooks/__tests__/useExportXmlKickoff.test.js`

- [ ] **Step 1: Write the test file**

```js
// src/hooks/__tests__/useExportXmlKickoff.test.js
//
// Covers:
//   - buildVariantsPayload: pure transform over the unified manifest
//   - triggerXmlDownload: happy-dom Blob + <a>.click assertion (smoke)
//   - useExportXmlKickoff: state machine + POST order + auto-kick on
//     `complete` transition (via a minimal renderHook-equivalent)
//
// Environment: happy-dom (set by vitest.config.js `web` project).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

import {
  buildVariantsPayload,
  triggerXmlDownload,
  useExportXmlKickoff,
} from '../useExportXmlKickoff.js'

// -------------------- Fixtures --------------------

// A single-variant unified manifest approximating what buildManifest
// returns after State C's "Start Export" in a single-variant flow.
function makeManifestSingleVariant() {
  return {
    variants: ['A'],
    totals: { count: 2, est_size_bytes: 200_000_000, by_source: { envato: 1, pexels: 1 } },
    options: { force_redownload: false },
    items: [
      {
        seq: 1,
        source: 'envato',
        source_item_id: 'NX9WYGQ',
        envato_item_url: 'https://elements.envato.com/thing-NX9WYGQ',
        target_filename: '001_envato_NX9WYGQ.mov',
        resolution: { width: 1920, height: 1080 },
        frame_rate: 30,
        est_size_bytes: 100_000_000,
        variants: ['A'],
        placements: [{ variant: 'A', timeline_start_s: 0, timeline_duration_s: 2.5 }],
      },
      {
        seq: 2,
        source: 'pexels',
        source_item_id: '123456',
        target_filename: '002_pexels_123456.mp4',
        resolution: { width: 1920, height: 1080 },
        frame_rate: 30,
        est_size_bytes: 100_000_000,
        variants: ['A'],
        placements: [{ variant: 'A', timeline_start_s: 2.5, timeline_duration_s: 3.0 }],
      },
    ],
  }
}

// Two-variant manifest: one item is shared (placements from both A and C),
// one item is A-only. Exercises dedup + per-variant slicing.
function makeManifestTwoVariant() {
  return {
    variants: ['A', 'C'],
    totals: { count: 2, est_size_bytes: 200_000_000, by_source: { envato: 2 } },
    items: [
      {
        seq: 1, source: 'envato', source_item_id: 'SHARED',
        target_filename: '001_envato_SHARED.mov',
        resolution: { width: 3840, height: 2160 }, frame_rate: 24, est_size_bytes: 100_000_000,
        variants: ['A', 'C'],
        placements: [
          { variant: 'A', timeline_start_s: 0, timeline_duration_s: 4 },
          { variant: 'C', timeline_start_s: 10, timeline_duration_s: 4 },
        ],
      },
      {
        seq: 2, source: 'envato', source_item_id: 'AONLY',
        target_filename: '002_envato_AONLY.mov',
        resolution: { width: 1920, height: 1080 }, frame_rate: 30, est_size_bytes: 100_000_000,
        variants: ['A'],
        placements: [{ variant: 'A', timeline_start_s: 4, timeline_duration_s: 2 }],
      },
    ],
  }
}

// -------------------- buildVariantsPayload --------------------

describe('buildVariantsPayload', () => {
  it('turns a single-variant manifest into one variant with seq-preserved placements', () => {
    const out = buildVariantsPayload({
      unifiedManifest: makeManifestSingleVariant(),
      variantLabels: ['A'],
    })
    expect(out).toEqual({
      variants: [{
        label: 'A',
        sequenceName: 'Variant A',
        placements: [
          {
            seq: 1,
            source: 'envato',
            sourceItemId: 'NX9WYGQ',
            filename: '001_envato_NX9WYGQ.mov',
            timelineStart: 0,
            timelineDuration: 2.5,
            width: 1920,
            height: 1080,
            sourceFrameRate: 30,
          },
          {
            seq: 2,
            source: 'pexels',
            sourceItemId: '123456',
            filename: '002_pexels_123456.mp4',
            timelineStart: 2.5,
            timelineDuration: 3.0,
            width: 1920,
            height: 1080,
            sourceFrameRate: 30,
          },
        ],
      }],
    })
  })

  it('preserves seq across variants for a shared item (multi-variant dedup)', () => {
    const out = buildVariantsPayload({
      unifiedManifest: makeManifestTwoVariant(),
      variantLabels: ['A', 'C'],
    })
    expect(out.variants.length).toBe(2)
    // Variant A: seq 1 + seq 2
    expect(out.variants[0].label).toBe('A')
    expect(out.variants[0].placements.map(p => p.seq)).toEqual([1, 2])
    // Variant C: seq 1 only (SHARED), with its C-specific timing
    expect(out.variants[1].label).toBe('C')
    expect(out.variants[1].placements.length).toBe(1)
    expect(out.variants[1].placements[0]).toMatchObject({
      seq: 1, sourceItemId: 'SHARED',
      timelineStart: 10, timelineDuration: 4,
    })
  })

  it('names sequences "Variant <label>"', () => {
    const out = buildVariantsPayload({
      unifiedManifest: makeManifestSingleVariant(),
      variantLabels: ['A'],
    })
    expect(out.variants[0].sequenceName).toBe('Variant A')
  })

  it('skips placements with null or non-finite timing', () => {
    const manifest = makeManifestSingleVariant()
    manifest.items[0].placements[0].timeline_start_s = null
    manifest.items[1].placements[0].timeline_duration_s = NaN
    const out = buildVariantsPayload({
      unifiedManifest: manifest,
      variantLabels: ['A'],
    })
    expect(out.variants[0].placements).toEqual([])
  })

  it('skips placements with zero or negative duration', () => {
    const manifest = makeManifestSingleVariant()
    manifest.items[0].placements[0].timeline_duration_s = 0
    manifest.items[1].placements[0].timeline_duration_s = -1
    const out = buildVariantsPayload({
      unifiedManifest: manifest,
      variantLabels: ['A'],
    })
    expect(out.variants[0].placements).toEqual([])
  })

  it('throws on missing unifiedManifest.items', () => {
    expect(() => buildVariantsPayload({
      unifiedManifest: null, variantLabels: ['A'],
    })).toThrow(/items required/)
  })

  it('throws on empty variantLabels', () => {
    expect(() => buildVariantsPayload({
      unifiedManifest: makeManifestSingleVariant(), variantLabels: [],
    })).toThrow(/non-empty/)
  })
})

// -------------------- triggerXmlDownload --------------------
//
// Smoke-level: assert the function (a) creates a blob URL, (b) creates
// an <a> element, (c) clicks it. We don't assert filename content
// because happy-dom's <a download> behavior is stubbed.

describe('triggerXmlDownload', () => {
  let clickSpy
  beforeEach(() => {
    clickSpy = vi.fn()
    // Patch all created anchors to record clicks. happy-dom's
    // HTMLAnchorElement.click is a no-op; replacing on the prototype
    // is the simplest spy.
    HTMLAnchorElement.prototype.click = clickSpy
    // Happy-dom: URL.createObjectURL / revokeObjectURL exist but return
    // a placeholder. That's fine for our assertions.
  })

  it('creates a blob URL and clicks an anchor with the right filename', () => {
    const url = triggerXmlDownload('variant-a.xml', '<?xml version="1.0"?><xmeml/>')
    expect(typeof url).toBe('string')
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })
})

// -------------------- useExportXmlKickoff --------------------
//
// Minimal "render a hook" helper. Creates a root, renders a
// <Probe /> that captures the hook return into a ref, and exposes
// `act(() => { ... })` for flushing effects.
//
// React 19's `act` is exported from `react`, not `react-dom/test-utils`.

function renderHookOnce(useFn, props) {
  const captured = { current: null }
  function Probe(p) {
    captured.current = useFn(p)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(Probe, props)) })
  return {
    result: captured,
    rerender: (nextProps) => act(() => { root.render(createElement(Probe, nextProps)) }),
    unmount: () => act(() => { root.unmount() }),
  }
}

describe('useExportXmlKickoff', () => {
  let apiPost
  let triggerDownload
  let downloadedFilenames

  beforeEach(() => {
    downloadedFilenames = []
    apiPost = vi.fn(async (path, body) => {
      if (path.endsWith('/result')) {
        return { ok: true }
      }
      if (path.endsWith('/generate-xml')) {
        const labels = body?.variants || []
        const xml_by_variant = {}
        for (const l of labels) xml_by_variant[l] = `<?xml ${l}?><xmeml/>`
        return { xml_by_variant }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    triggerDownload = vi.fn((filename, xml) => {
      downloadedFilenames.push(filename)
      return `blob:test/${filename}`
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('auto-kicks on complete with no failures and posts both bodies in order', async () => {
    const manifest = makeManifestSingleVariant()
    const props = {
      exportId: 'exp_TEST',
      variantLabels: ['A'],
      unifiedManifest: manifest,
      complete: null,  // start idle
      _apiPost: apiPost,
      _triggerDownload: triggerDownload,
    }
    const h = renderHookOnce(useExportXmlKickoff, props)
    expect(h.result.current.status).toBe('idle')

    // Simulate the Port delivering {type:"complete"} — re-render with
    // a non-null complete. The effect should auto-kick.
    h.rerender({ ...props, complete: { ok_count: 2, fail_count: 0, folder_path: '~/Downloads/test', xml_paths: [] } })

    // Flush any pending promises (two POSTs). happy-dom doesn't need
    // fake timers; a microtask flush suffices.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(apiPost).toHaveBeenCalledTimes(2)
    expect(apiPost.mock.calls[0][0]).toMatch(/\/exports\/exp_TEST\/result$/)
    expect(apiPost.mock.calls[1][0]).toMatch(/\/exports\/exp_TEST\/generate-xml$/)
    // Body #1 is the variants shape
    expect(apiPost.mock.calls[0][1]).toMatchObject({
      variants: [{ label: 'A', sequenceName: 'Variant A' }],
    })
    // Body #2 is just the labels
    expect(apiPost.mock.calls[1][1]).toEqual({ variants: ['A'] })

    expect(h.result.current.status).toBe('ready')
    expect(h.result.current.xml_by_variant).toEqual({ A: expect.stringContaining('<?xml A?>') })
    expect(downloadedFilenames).toEqual(['variant-a.xml'])

    h.unmount()
  })

  it('does NOT auto-kick when fail_count > 0', async () => {
    const props = {
      exportId: 'exp_PARTIAL',
      variantLabels: ['A'],
      unifiedManifest: makeManifestSingleVariant(),
      complete: { ok_count: 1, fail_count: 1, folder_path: '~/Downloads/test', xml_paths: [] },
      _apiPost: apiPost,
      _triggerDownload: triggerDownload,
    }
    const h = renderHookOnce(useExportXmlKickoff, props)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    expect(apiPost).not.toHaveBeenCalled()
    expect(h.result.current.status).toBe('idle')
    h.unmount()
  })

  it('transitions to error state on POST /result failure and exposes regenerate', async () => {
    apiPost = vi.fn(async (path) => {
      if (path.endsWith('/result')) throw new Error('simulated 500')
      return {}
    })
    const props = {
      exportId: 'exp_500',
      variantLabels: ['A'],
      unifiedManifest: makeManifestSingleVariant(),
      complete: { ok_count: 2, fail_count: 0, folder_path: '~/Downloads', xml_paths: [] },
      _apiPost: apiPost,
      _triggerDownload: triggerDownload,
    }
    const h = renderHookOnce(useExportXmlKickoff, props)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(h.result.current.status).toBe('error')
    expect(h.result.current.error).toMatch(/simulated 500/)

    // regenerate() retries the flow. Patch apiPost to succeed this
    // time; verify the state returns to 'ready'.
    apiPost = vi.fn(async (path, body) => {
      if (path.endsWith('/result')) return { ok: true }
      if (path.endsWith('/generate-xml')) {
        return { xml_by_variant: { A: '<?xml ok?><xmeml/>' } }
      }
      throw new Error(path)
    })
    // The hook captured the OLD apiPost in useCallback closures; the
    // call to regenerate() will still use the old one. To test the
    // retry path, we'd need to re-render with the new apiPost prop.
    // Do that:
    h.rerender({ ...props, _apiPost: apiPost })
    h.result.current.regenerate()
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(h.result.current.status).toBe('ready')
    h.unmount()
  })
})
```

- [ ] **Step 2: Run the web project**

```bash
npm run test 2>&1 | tail -20
# Expected:
#   Test Files  3 passed (3)   (xmeml-generator + exports + useExportXmlKickoff)
#   Tests       39 + 13 = 52+ passing
# If the web project shows "No test files" — the include pattern doesn't match.
# Confirm vitest.config.js has src/**/__tests__/**/*.test.js in the web project.
```

If the `renderHookOnce` helper breaks because React 19's `act` export is somewhere else, fall back to importing `act` from `react-dom/test-utils` (React 18 style) or adjust per the exact React version. The project uses React 19 per `package.json` — act from `react`.

- [ ] **Step 3: If happy-dom lacks `HTMLAnchorElement.prototype.click`**

Run the tests. If `triggerDownload` smoke test throws with "TypeError: undefined is not a function", happy-dom doesn't stub click on anchors. Fallback: in the `beforeEach`, define click:

```js
Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
  configurable: true,
  value: clickSpy,
})
```

- [ ] **Step 4: Commit**

```bash
git add src/hooks/__tests__/useExportXmlKickoff.test.js
git diff --cached --stat
# Expected: 1 file, ~250 lines added
git commit -m "$(cat <<'EOF'
test(export): useExportXmlKickoff hook + buildVariantsPayload

Three test suites in one file (mirrors the XMEML generator test
file's style):

  - buildVariantsPayload (7 tests): pure transform. Single-variant,
    multi-variant shared-seq dedup, sequenceName format, skip null/
    non-finite/zero-duration placements, input validation.

  - triggerXmlDownload (1 test): happy-dom smoke on the blob +
    anchor-click primitive.

  - useExportXmlKickoff (3 tests): state-machine integration.
    Auto-kick on null→complete+no-failures, no auto-kick on
    fail_count>0 (reserved for State F), retry-via-regenerate
    after a simulated 500 on POST /result.

Runs in the new `web` vitest project (happy-dom env). Uses a
minimal `renderHookOnce` helper (~15 lines) instead of pulling
in @testing-library — the surface is small.

Test Files: 3 passed (was 2).
Tests: 52+ passing (was 39).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `ExportPage.jsx` — thread unifiedManifest through the FSM + swap StateE import

The component that glues it all together. Minimal change: reducer action to remember the unified manifest, one import swap, one prop-pass update in `ActiveRun`.

**Files:**
- Modify: `$TE/src/pages/ExportPage.jsx`

- [ ] **Step 1: Read the current file**

Use Read. Focus on:
- Reducer (lines 26–39)
- Initial state (lines 41–49)
- `onStart` callback (lines 154–194) — this is where unifiedManifest is already available as a param
- `ActiveRun` component (lines 267–301) — receives `exportId`, `expectedRunId`; we'll add `unifiedManifest` + `variantLabels`.

- [ ] **Step 2: Add a new reducer action `store_start_payload` to remember unifiedManifest + variantLabels**

`old_string`:
```js
function reducer(state, action) {
  switch (action.type) {
    case 'goto':                  return { ...state, phase: action.phase }
    case 'set_extra_variants':    return { ...state, additionalVariants: action.variants }
    case 'override_session':      return { ...state, sessionOverridden: true }
    case 'export_started':        return { ...state, phase: 'state_d', export_id: action.export_id, run_id: action.run_id || null }
    case 'export_completed': {
      const fail = action.payload?.fail_count ?? 0
      return { ...state, phase: fail > 0 ? 'state_f' : 'state_e', complete_payload: action.payload }
    }
    case 'set_error':             return { ...state, error: action.error }
    default:                      return state
  }
}

const initialState = {
  phase: 'init',
  additionalVariants: [],
  sessionOverridden: false,
  export_id: null,
  run_id: null,
  complete_payload: null,
  error: null,
}
```

`new_string`:
```js
function reducer(state, action) {
  switch (action.type) {
    case 'goto':                  return { ...state, phase: action.phase }
    case 'set_extra_variants':    return { ...state, additionalVariants: action.variants }
    case 'override_session':      return { ...state, sessionOverridden: true }
    case 'export_started':        return {
      ...state,
      phase: 'state_d',
      export_id: action.export_id,
      run_id: action.run_id || null,
      unified_manifest: action.unified_manifest || null,
      variant_labels: action.variant_labels || [],
    }
    case 'export_completed': {
      const fail = action.payload?.fail_count ?? 0
      return { ...state, phase: fail > 0 ? 'state_f' : 'state_e', complete_payload: action.payload }
    }
    case 'set_error':             return { ...state, error: action.error }
    default:                      return state
  }
}

const initialState = {
  phase: 'init',
  additionalVariants: [],
  sessionOverridden: false,
  export_id: null,
  run_id: null,
  complete_payload: null,
  unified_manifest: null,   // captured in onStart; needed by State E
  variant_labels: [],       // captured in onStart; passed to State E
  error: null,
}
```

- [ ] **Step 3: Thread `unifiedManifest` + `variant_labels` through `dispatch({type:'export_started'})`**

Find the existing dispatch call in `onStart`:

`old_string`:
```js
    dispatch({
      type: 'export_started',
      export_id: exportId,
      run_id: maybeResponse?.run_id || null,
    })
```

`new_string`:
```js
    dispatch({
      type: 'export_started',
      export_id: exportId,
      run_id: maybeResponse?.run_id || null,
      unified_manifest: unifiedManifest,
      variant_labels: variantLabels,
    })
```

- [ ] **Step 4: Swap the StateE import**

`old_string`:
```js
import StateE_Complete_Placeholder from '../components/export/StateE_Complete_Placeholder.jsx'
```

`new_string`:
```js
import StateE_Complete from '../components/export/StateE_Complete.jsx'
```

- [ ] **Step 5: Pass new props through `ActiveRun`**

Find the `ActiveRun` declaration call:

`old_string`:
```js
  // States D / E / F — live-progress + terminal placeholders.
  if (state.phase === 'state_d' || state.phase === 'state_e' || state.phase === 'state_f') {
    return (
      <ActiveRun
        variant={variant}
        exportId={state.export_id}
        expectedRunId={state.run_id}
        phase={state.phase}
        completePayload={state.complete_payload}
        onComplete={(payload) => dispatch({ type: 'export_completed', payload })}
      />
    )
  }
```

`new_string`:
```js
  // States D / E / F — live-progress + State E XMEML + State F stub.
  if (state.phase === 'state_d' || state.phase === 'state_e' || state.phase === 'state_f') {
    return (
      <ActiveRun
        variant={variant}
        exportId={state.export_id}
        expectedRunId={state.run_id}
        phase={state.phase}
        completePayload={state.complete_payload}
        unifiedManifest={state.unified_manifest}
        variantLabels={state.variant_labels}
        onComplete={(payload) => dispatch({ type: 'export_completed', payload })}
      />
    )
  }
```

- [ ] **Step 6: Update `ActiveRun` to accept + forward the new props**

`old_string`:
```js
// ActiveRun wraps the State D / E / F rendering so that useExportPort
// is mounted only while we're actually in those phases. Pulling this
// out as a child component keeps ExportPage.jsx's FSM clean — the Port
// lifecycle lives only for the duration of the active run.
function ActiveRun({ variant, exportId, expectedRunId, phase, completePayload, onComplete }) {
  const port = useExportPort({ exportId, expectedRunId })

  // When the Port reports completion, notify parent to transition FSM.
  useEffect(() => {
    if (port.complete && phase === 'state_d') {
      onComplete(port.complete)
    }
  }, [port.complete, phase, onComplete])

  if (phase === 'state_e') {
    return <StateE_Complete_Placeholder complete={completePayload} />
  }
  if (phase === 'state_f') {
    return <StateF_Partial_Placeholder complete={completePayload} snapshot={port.snapshot} />
  }
```

`new_string`:
```js
// ActiveRun wraps the State D / E / F rendering so that useExportPort
// is mounted only while we're actually in those phases. Pulling this
// out as a child component keeps ExportPage.jsx's FSM clean — the Port
// lifecycle lives only for the duration of the active run.
function ActiveRun({
  variant, exportId, expectedRunId, phase, completePayload,
  unifiedManifest, variantLabels, onComplete,
}) {
  const port = useExportPort({ exportId, expectedRunId })

  // When the Port reports completion, notify parent to transition FSM.
  useEffect(() => {
    if (port.complete && phase === 'state_d') {
      onComplete(port.complete)
    }
  }, [port.complete, phase, onComplete])

  if (phase === 'state_e') {
    return (
      <StateE_Complete
        complete={completePayload}
        exportId={exportId}
        variantLabels={variantLabels}
        unifiedManifest={unifiedManifest}
      />
    )
  }
  if (phase === 'state_f') {
    return <StateF_Partial_Placeholder complete={completePayload} snapshot={port.snapshot} />
  }
```

- [ ] **Step 7: Sanity-check imports and references**

```bash
cd "$TE"
grep -n "StateE_Complete\|StateE_Complete_Placeholder\|StateF_Partial_Placeholder\|unified_manifest\|variant_labels" src/pages/ExportPage.jsx
# Expected references:
#   - Exactly 1 import: `import StateE_Complete from ...`
#   - 0 references to StateE_Complete_Placeholder (file is gone; any left would fail build)
#   - `unified_manifest` and `variant_labels` appear in reducer + initial state
```

- [ ] **Step 8: Run the full test suite + check Vite build surfaces no import errors**

```bash
npm run test 2>&1 | tail -6
# Expected: 52+ tests passing.
npx vite build 2>&1 | tail -20
# Expected: build completes. Look for any "Could not resolve" warnings —
# if StateE_Complete.jsx import path is wrong, build fails here.
```

- [ ] **Step 9: Commit**

```bash
git add src/pages/ExportPage.jsx
git diff --cached --stat
# Expected: 1 file, ~20 lines changed
git commit -m "$(cat <<'EOF'
feat(export): wire unifiedManifest into State E via FSM

ExportPage captures the unifiedManifest + variantLabels from
State C's onStart callback into FSM state. These flow through
ActiveRun into the new StateE_Complete component, which needs
them to build the {variants:[...]} body for
POST /api/exports/:id/result (see useExportXmlKickoff).

Swaps the StateE import from the deleted placeholder to the
real component.

No behavior change for State D / State F — the FSM paths through
those states are identical. State F remains on its placeholder
pending the WebApp.3 / State F plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Manual verification — no commit, no push

End-to-end smoke. Goal: a real extension run (or a mocked-`chrome.runtime` run in the browser devtools console) moves the app into State E, the XML auto-downloads, and the XML opens in Premiere (or, at minimum, passes a curl inspection of `/generate-xml`'s response).

**Preconditions:**
- Backend running: `npm run dev:server` on port 3001.
- Frontend running: `npm run dev:client` on Vite's default port (usually 5173).
- Extension: either (a) loaded unpacked with Ext.5 build, or (b) use the `window.chrome` mock option from the State D plan Task 6 acceptance check.
- A pipeline with at least one completed `broll_searches` row (gives you a real `pipeline_id` for `/editor/:id/export`).
- Valid Supabase JWT (i.e., you're logged in via the frontend).

- [ ] **Step 1: Happy path — real extension, single variant**

1. Navigate to `http://localhost:5173/editor/<pipelineId>/export?variant=A`.
2. Expect State A → B → C depending on ext state. Click "Start Export" at State C.
3. State D renders. Extension downloads 2-3 items (use a small manifest — Pexels clips keep Envato licenses from burning).
4. When downloads finish, the Port sends `{type:"complete", fail_count:0}`. Page transitions to State E.
5. **Expected:**
   - State E renders "Export complete — N clips downloaded".
   - Brief status: "Preparing XML…" then "Generating XML…".
   - Browser auto-downloads `variant-a.xml` to the default downloads folder.
   - A "Download variant-a.xml again" button appears for re-download.
6. Open `variant-a.xml` in a text editor. Expected shape: `<?xml version="1.0"?><!DOCTYPE xmeml><xmeml version="5"><sequence ...>` with `<clipitem>` entries whose `<name>` matches the `target_filename` values the extension downloaded.

- [ ] **Step 2: Endpoint sanity via curl (if you want to verify without a real export)**

```bash
# Requires JWT + existing export row with a user_id matching the JWT user.
# Use a test export you know exists; pick its id with:
#   psql ... -c "SELECT id, user_id, status FROM exports ORDER BY created_at DESC LIMIT 5"
EXPORT_ID="exp_01K..." # real ID
JWT="eyJ..." # from devtools Network tab on any API call

# 1. Write the shape
curl -sS -X POST "http://localhost:3001/api/exports/$EXPORT_ID/result" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "variants": [
      {
        "label": "A",
        "sequenceName": "Variant A",
        "placements": [
          {"seq": 1, "source": "pexels", "sourceItemId": "123",
           "filename": "001_pexels_123.mp4",
           "timelineStart": 0, "timelineDuration": 2.5}
        ]
      }
    ]
  }'
# Expected: {"ok": true}

# 2. Read back via generate-xml
curl -sS -X POST "http://localhost:3001/api/exports/$EXPORT_ID/generate-xml" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"variants":["A"]}' | jq '.xml_by_variant.A' | head -20
# Expected: <?xml version="1.0"...>  with sequence name "Variant A", one clipitem.
```

- [ ] **Step 3: Partial failure — fail_count > 0 does NOT kick XMEML**

Simulate via the extension test handler or Chrome DevTools:
1. Run a small export where one of the items is a known-bad Envato ID (triggers failure).
2. Completion arrives with `fail_count: 1`.
3. **Expected:** page transitions to State F (placeholder — still shows raw fields). No `POST /result` call in the Network tab. No XML download. This pins invariant #3: State F is NOT handled here; zero regression.

- [ ] **Step 4: XMEML 500 — retry works**

Simulate a 500 by temporarily writing invalid data:
1. In the devtools console, capture the `apiPost('/exports/$ID/result', ...)` call.
2. In the server, add a `throw new Error('simulated')` at the top of `writeExportResult` (don't commit this).
3. Run a full export. Expect State E to show the error banner + a "Retry" button.
4. Revert the server change. Click "Retry". XML downloads successfully.

- [ ] **Step 5: Re-entry — closing tab then reopening during State E**

1. Run a successful export. State E renders; XML downloads.
2. Close the tab. Reopen `/editor/<pipelineId>/export?variant=A`.
3. **Expected:** the page restarts at State C (since there's no persistent client cache of `{complete_payload, unified_manifest}`). The user can re-trigger by clicking Start again. If they'd like to regenerate XML without re-downloading media, the existing endpoint allows that once the second export writes a new result_json — but the UI flow for this is explicit "State E after re-export", NOT state restoration. **Open question:** do we want to persist result_json reads across tab reloads? For now: no. Flag as future work.

- [ ] **Step 6: Fresh-run regression — existing vitest suite**

```bash
cd "$TE"
npm run test 2>&1 | tail -10
# Expected: all tests passing (39 server + 11+ web = 50+ total).
```

- [ ] **Step 7: Review the full branch diff**

```bash
git log --oneline main...HEAD
# Expected: 8 commits (Tasks 0-8, one per task).
git diff --stat main...HEAD
# Expected: ~10 files changed, ~800 lines added, ~85 removed.
```

- [ ] **Step 8: Do NOT push. Do NOT merge.**

Reporting to user: "Branch `feature/webapp-state-e-xmeml` ready for review. Manual smoke passed for happy path + partial + retry. Not merged or pushed — awaiting approval." See [Coding Feedback](feedback_coding_style.md) user preference: don't push without asking.

---

## Risk & open questions

1. **`conflictAction: 'uniquify'` filename fidelity gap.** The Port snapshot's `target_filename` does not reflect `(1)`-suffixed collisions on disk. In a fresh folder this is a no-op; in a folder with leftover files from a previous run, Premiere will 404 the media on XML open. Fix requires an Ext.6 bump to add an `item_finalized` Port message carrying the actual `filename` from `chrome.downloads.search`. Out of scope for this plan — flag as tech-debt item for Ext.6 roadmap.

2. **Cross-tab State E reentry.** If the user closes the tab post-export and reopens, we lose `unified_manifest` + `complete_payload`. A cache in `sessionStorage` (keyed by exportId) would let State E survive a reload. Deferred — needs a brainstorm on "what does a reloaded State E even mean when the extension's run is already done?".

3. **Happy-dom vs jsdom drift.** The hook integration test relies on happy-dom's `URL.createObjectURL` + anchor click behavior. If happy-dom's API drifts between versions, Task 7's test gets flaky. Mitigation: pin `happy-dom@^14.12.0` (Task 1). If the pin proves painful, swap to jsdom — one-line change in `vitest.config.js`.

4. **Vitest projects vs workspace syntax.** Task 1 uses `projects:` inside `defineConfig`. If vitest 1.6.x doesn't recognize it, fall back to `vitest.workspace.js`. Flagged in Task 1 Step 5.

5. **Endpoint authentication layering.** The existing XMEML endpoint (`POST /api/exports/:id/generate-xml`) uses `requireAuth` (Supabase JWT). The new `POST /api/exports/:id/result` uses the same. Consistent with Phase 1. No mismatch.

6. **Extension telemetry vs Port `complete` ordering race** — see Contracts section. If telemetry `export_completed` POSTs to `/api/export-events` AFTER the webapp issues `POST /result`, `recordExportEvent`'s COALESCE overwrites the variants shape with counts-only meta, breaking the subsequent `/generate-xml`. The fix is ordering-dependent and we haven't confirmed the current Ext.5 code's POST ordering. **Task 9 Step 1 MUST verify the network order** (telemetry first, then Port, then client's POST /result). If the race is real, options:
   - (a) Amend `recordExportEvent` to skip the COALESCE when existing `result_json` parses with a `variants` key. Tiny, safe, 3-line change — but plan says "do not modify recordExportEvent" so this needs escalation.
   - (b) Have the client retry `POST /result` + `POST /generate-xml` with small backoff on 404 from the XML endpoint. Stays client-only; acceptable under this plan's scope.
   - (c) Bump Ext.6 to wait for the telemetry POST's 202 before broadcasting `{type:"complete"}`. Cleanest but out-of-scope.

   Default preference: (b) if the race materializes, because it keeps the plan's "no server change" posture. Flag explicitly as a conditional task — do NOT pre-build the retry loop unless Task 9 observes the bug.

---

## Deferred → owning plan

| Item | Owning plan |
|------|--------------|
| State F full UI (per-failure diagnostics, retry, generate-anyway) | Follow-up `webapp-state-f` plan |
| `/admin/exports`, `/admin/support` | WebApp.3 / WebApp.4 |
| File System Access API — media folder co-located with XML | Later WebApp.1 iteration |
| Filename-fidelity fix for uniquified collisions | Extension Ext.6 roadmap |
| sessionStorage caching for State E reload | Follow-up webapp plan (minor) |

---

## Contracts (upstream → this plan → downstream)

| Upstream | Delivered | Consumed here |
|----------|-----------|---------------|
| Phase 1 (`server/services/exports.js`) | `createExport`, `getExport`, `ValidationError`, `NotFoundError`, `recordExportEvent` | `writeExportResult` helper added alongside (extends, does NOT modify the existing surface) |
| WebApp.2 (`server/routes/export-xml.js`, `server/services/xmeml-generator.js`) | `POST /api/exports/:id/generate-xml`, `generateXmeml()` | Called AS-IS; no changes |
| WebApp.1 preflight (`src/hooks/useExportPreflight.js`) | Manifest fetch + disk check | Unchanged |
| WebApp.1 State C (`StateC_Summary.jsx`, `src/lib/buildManifest.js`) | `unifiedManifest` produced at "Start Export" | Threaded through FSM into State E |
| WebApp.1 State D (`useExportPort`, `StateD_InProgress.jsx`) | `{type:"complete"}` payload surfaced via `port.complete` | Consumed by `useExportXmlKickoff` auto-kick |
| Ext.5 extension (`extension/modules/queue.js`) | `{type:"complete", ok_count, fail_count, folder_path, xml_paths:[]}` | Consumed AS-IS; no extension change |

The one hard upstream contract: **Phase 1's `recordExportEvent` stays untouched**. The new `writeExportResult` is additive.

**Ordering nuance — read carefully.** `recordExportEvent` on `event === 'export_completed'` runs `UPDATE exports SET result_json = COALESCE(?, result_json) WHERE id = ?` with the first `?` set to `JSON.stringify(meta)` (the extension's counts-only meta). Since `meta` is non-null in a real completion event, `COALESCE` evaluates to `meta` and OVERWRITES any existing `result_json`. This means:

- **Safe ordering (expected):** extension POSTs `/api/export-events` with `export_completed` BEFORE it broadcasts the Port `{type:"complete"}` message. Server writes counts-only meta to `result_json`. Webapp receives Port broadcast, runs its 3-step flow, and its `POST /result` hard-replaces `result_json` with the `{variants:[...]}` shape. Then `/generate-xml` reads the variants — success.
- **Unsafe ordering (theoretical race):** if Port broadcast fires BEFORE the telemetry POST completes on the server (network delay on telemetry, Port message processed faster in the browser), the webapp could issue `POST /result` first, then the late-arriving telemetry's COALESCE overwrites the variants with counts-only meta. The next `/generate-xml` call would 404.

**Mitigation in this plan:** the 3-step flow in `useExportXmlKickoff` runs in JS async order on the SAME browser tab. The Port broadcast arrives from a chrome.runtime message; the extension's queue.js (`extension/modules/queue.js:450`) broadcasts `{type:"complete"}` from `finalize()` which is called from `schedule()` after every worker drains. The telemetry POST for `export_completed` is NOT currently in the codebase I inspected — the queue's `finalize()` does NOT post `/api/export-events` itself. Whoever does (the extension's telemetry module, if present, or a service worker handler) likely posts telemetry BEFORE `finalize()`. Verify this during Task 9 Step 1 manual verification: watch the Network tab and confirm `POST /api/export-events` with `event: export_completed` fires BEFORE the webapp's `POST /api/exports/:id/result`. If it fires after, we have a race — mitigation is to amend `recordExportEvent` to only COALESCE counts-meta when existing `result_json` has no `variants` key, OR have the client retry `/result` on a 404 from `/generate-xml`. DO NOT amend this plan to do either unless the race is observed — flag as open question #6 below.

---

## Summary

- 10 tasks: Task 0 (scaffold) + Tasks 1–8 (work) + Task 9 (manual verification, no commit).
- 9 commits on branch `feature/webapp-state-e-xmeml` after Task 8.
- Test file count: 2 → 3 (`xmeml-generator`, `exports`, `useExportXmlKickoff`). Test count: 30 → ~52.
- No extension change. No schema change. No Phase 1 touch.
- Manual verification catches the happy path + partial + retry. No push.
