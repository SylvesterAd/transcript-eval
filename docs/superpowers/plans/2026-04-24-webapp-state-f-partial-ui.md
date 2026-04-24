# WebApp.1 State F — Partial-failure UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a one-PR slice — scope is tight and contained to the web app. Expect one focused day of work.

**Goal:** Replace the `StateF_Partial_Placeholder.jsx` stub with the real partial-failure UI per the design spec: a per-failure diagnostics list (filename + source + human-readable reason derived from the 15-code `error_code` enum), a "Retry failed items" button that sends a filtered manifest as a fresh export run, a "Generate XML anyway" button that reuses Week 4's `useExportXmlKickoff` hook, and a "Report issue" stub (disabled with a "Coming soon" tooltip — the real diagnostic-bundle attachment lives in Ext.8). The FSM in `ExportPage.jsx` already routes `phase === 'state_f'` when `fail_count > 0` on completion; this plan swaps the placeholder component for the real one and threads in any missing props (the `onStart` callback for retry, the pipeline id for the new export create). No extension change. No schema change. No XMEML generator change.

**Architecture:** One new component (`StateF_Partial.jsx` replacing the placeholder), one new small pure module (`src/lib/errorCodeLabels.js`) that owns the 15-code → human-string map, and one modest `ExportPage.jsx` edit to (a) swap the import, (b) pass the `onStart` callback + `pipelineId` down through `ActiveRun` so retry can mint a new export row and re-send a filtered manifest, (c) optionally surface the `snapshot.items` failed subset that's already available via `useExportPort`. The retry flow reuses the existing `onStart({ unifiedManifest, options, targetFolder })` call path — we rebuild a filtered unified manifest from the prior one + the failed items' `source_item_id` set, then let the existing createExport → sendSession → sendExport pipe do its thing. The result is a fresh `exports` row (new `export_id`), a fresh run, and the FSM naturally transitions back to `state_d`. The "Generate XML anyway" path simply calls `useExportXmlKickoff({ exportId, variantLabels, unifiedManifest, complete })` — the Week 4 hook already de-dupes and handles the `fail_count > 0` case (it does NOT auto-kick when partial; it waits for explicit `regenerate()`).

**Tech Stack:** React 19 + Vite (unchanged), styled-components (unchanged — matches StateE/StateD/etc. sibling files), `lucide-react` icons (unchanged — used by every State_*.jsx), vitest 1.6.x with the `web` project on happy-dom (set up in the Week 4 State E plan; see `vitest.workspace.js`). **No** new dependencies — specifically NOT adding `@testing-library/react` (the Week 4 State E plan decided against it; this plan continues the bare-`createRoot` + `React.act` convention). No schema change. Extension version unchanged. Backend unchanged.

---

## Open questions for the user

These decisions color the plan; flag them in Task 0 and either confirm the defaults below with the user or hold the line and let the executor revisit when they hit each task.

### 1. Retry semantics — new `exports` row vs. mutate the existing row

**Question:** When the user clicks "Retry failed items," does the web app (a) call `POST /api/exports` to mint a **new** export row, then `sendExport` to the extension (the standard onStart path), or (b) reuse the existing `export_id` and overwrite `result_json` on the completed row?

**Recommendation:** **Option A — new export row.**

- Verified in code: `extension/modules/queue.js:559–588` — `finalize()` runs `await clearActiveRunId()` after broadcasting `{type:"complete"}`, so the single-active-run lock is RELEASED by the time the Port's `complete` message reaches the web app. A fresh `{type:"export"}` will pass the Ext.5 lock check and start a new run without `run_already_active`.
- Verified in code: `server/routes/exports.js:10–24` — `POST /api/exports` accepts `{plan_pipeline_id, variant_labels, manifest}` and returns `{export_id, ...}`; no constraint preventing a second row for the same pipeline.
- Cleaner audit trail: each attempt lands as its own `exports` row with its own `export_events` chronology. The partial run's `result_json` stays intact for diagnostic bundle review (Ext.8). Mutating the original row would collapse two attempts into one event stream and break the WebApp.3 admin UI's "show all runs for a pipeline" view.
- Simpler code path: the existing `onStart({unifiedManifest, options, targetFolder})` already does the full ceremony; StateF.retry just builds a **filtered** manifest (only the failed items' `source_item_id`s) and calls `onStart` with it.

**If the user says Option B:** this plan would need a new `POST /api/exports/:id/reset` endpoint that nulls `result_json` + status and a new extension contract for "continue this run, I changed my mind" — neither exists today. That's a cross-phase coordination point; flag as "Ext.X + Backend.X + WebApp.X coordination" and stop this plan's implementation until the decision is formalized.

### 2. "Report issue" button behavior pre-Ext.8

**Question:** Disabled with a "Coming in Ext.8" tooltip, OR a `mailto:support@adpunk.ai` link (or similar) for now?

**Recommendation:** **Disabled with tooltip.**

- Matches the existing State C / State B pattern of disabling deferred features with a clear "coming in phase X" caveat.
- A `mailto:` link without the diagnostic bundle is actively worse than disabled: the user writes a useless email ("hey, my export failed, idk why") with no `runId`, no `export_id`, no failed-item list. Support costs go up.
- Ext.8 is planned and landing soon; a one-turn stub-to-real upgrade is cleaner than swapping a half-finished mailto for the bundle later.

**If the user prefers mailto:** acceptable alternative — use `mailto:support@adpunk.ai?subject=Export%20issue%20${exportId}&body=<prefilled%20run%20summary>` with export_id, runId, ok/fail counts, and folder_path prefilled into the body. Flag the caveat in the Ext.8 plan that this pre-stubbed mailto gets upgraded to auto-attach the zipped bundle.

### 3. ExportPage FSM — does the retry path need a reducer change?

**Question:** Does clicking "Retry failed items" mean the FSM should (a) go directly back to `state_d` with the new `export_id`, or (b) transition through `state_c` first (summary preview of the filtered retry)?

**Recommendation:** **Option A — straight to `state_d`.**

- Verified in code: `src/pages/ExportPage.jsx:31–38` — the existing `export_started` reducer action already transitions `phase: 'state_d'` with a new `export_id`. The retry flow is exactly that path; no new reducer action needed.
- The user already saw a summary in the original State C; a filtered retry doesn't re-introduce new information worth a second confirmation. The diagnostic list in State F itself is the "preview."
- No FSM restructure; only a prop-threading change in `ActiveRun` to expose `onStart` + `pipelineId` to `StateF_Partial`.

**If the user says Option B:** adds a new reducer action + a "preview retry" panel; doubles this plan's component scope. Skip unless requested.

### 4. "Generate XML anyway" with partial placements — does the existing XMEML generator need a change?

**Question:** When `StateF_Partial` calls `useExportXmlKickoff({...})` with a `unifiedManifest` whose items include placements for **failed** downloads, what does Premiere see when it imports the resulting `variant-X.xml`?

**Recommendation:** **No generator change. Document as expected behavior.**

- Verified in code: `src/hooks/useExportXmlKickoff.js:38–82` — `buildVariantsPayload` iterates `unifiedManifest.items[].placements[]` and emits `{seq, filename, timelineStart, timelineDuration, ...}` per placement. Failed items are in the manifest (they were originally intended for download) — they just don't have a corresponding file on disk.
- When Premiere imports the XML and tries to resolve `file://./media/<filename>`, the absent file renders as an **offline (red) clip** in the sequence — this is literally what the design spec says on line 196–197: *"If you generate anyway, missing clips appear as offline (red) in Premiere. You can relink them manually later."* So the existing behavior IS the documented behavior.
- `writeExportResult` (server/services/exports.js) validates placement shape — it does NOT check "file exists on disk." That's by design (the server can't verify the user's disk state).

**If the user wants a "drop failed items before generating XML" option:** that's a new `buildVariantsPayload` parameter + a new toggle in State F ("Include failed items as offline clips" checkbox). Out of scope for this plan — flag as a State F v2 enhancement.

---

## Why read this before touching code

Six load-bearing invariants. Skipping any of them reopens a door the next run will walk through.

1. **StateF must stay a pure read of Port state + FSM props — no duplicating the extension FSM in React.** The component renders from (a) `complete` — the terminal `{type:"complete"}` payload (`ok_count`, `fail_count`, `folder_path`) — and (b) `snapshot.items` — the full item list with per-item `phase` (`'done'` | `'failed'`) and `error_code`. Both already flow from `useExportPort` → `progressReducer` → the `ActiveRun` wrapper; StateF just accepts them as props. Do NOT open a second Port, do NOT re-fetch the manifest, do NOT derive failures from log events. The snapshot is the source of truth for the item list; `complete` is the source of truth for the counts.

2. **Retry re-export creates a NEW `exports` row — never mutate `result_json` on a completed row.** Verified: `POST /api/exports/:id/result` (server/routes/exports.js:43) is for writing the XMEML-ready shape after the run; there is no "reset run state" endpoint. The retry path uses the same `onStart` ceremony as the original export: `POST /api/exports` → `POST /api/session-token` → `sendSession` → `sendExport`. The extension's lock is released by `finalize()`'s `clearActiveRunId()` call (queue.js:584), so a second `{type:"export"}` immediately after a partial will NOT hit `run_already_active`. If you find yourself overwriting the original run's fields — STOP and re-read open question #1.

3. **Error-code → human-string mapping lives ONCE, in a dedicated module.** Do NOT scatter `switch`/`if` chains across StateF_Partial.jsx. Create `src/lib/errorCodeLabels.js` as a pure module exporting `ERROR_CODE_LABELS` (object) + `getErrorLabel(code)` (function with a null-safe fallback to "Unknown error"). The 15-code enum is authoritative at `extension/modules/telemetry.js:185–201` — copy those 15 values, DO NOT import from the extension (web and extension are separate module graphs; the web build tree must never import from `extension/`). Keep the module pure so a unit test asserts every enum value has a label and the fallback path returns a readable string.

4. **Component tests run under happy-dom per `vitest.workspace.js` — don't import `chrome.*` globals in test files.** The Week 4 State E plan established the `web` project on happy-dom (env provides `document`, `URL.createObjectURL`, etc. — but NOT `chrome.runtime`). StateF's tests mock `useExportXmlKickoff` and any extension helpers via vitest's `vi.fn()` + the `_apiPost` / `_triggerDownload` test-seams exposed by the hook. Do NOT mount the hook with real `chrome.runtime` expectations; the test-seam pattern exists precisely to avoid that. Test file goes under `src/components/export/__tests__/StateF_Partial.test.jsx` (JSX — happy-dom; new `.jsx` extension in the include pattern already accepted per `vitest.workspace.js:31`).

5. **The filtered-retry manifest MUST preserve all the original fields the extension needs.** The extension's `{type:"export"}` handler (queue.js `startRun`) expects `{manifest: [...items...], target_folder, options}`. Each item carries `{seq, source, source_item_id, envato_item_url?, target_filename, resolution, frame_rate, est_size_bytes, variants, placements}`. Do NOT slice to a bare `{source_item_id}` — rebuild the filtered manifest by `filter(item => failedIds.has(item.source_item_id))` on the **original `unified_manifest.items`** kept in ExportPage state. If you try to reconstruct items from `snapshot.items` (which is the Port's wire view), you'll lose `envato_item_url`, `placements`, `variants`, and the extension's resolver will fall over.

6. **Quote every path — the repo lives at `/Users/laurynas/Desktop/one last /transcript-eval/` with a trailing space in `"one last "`.** Every shell snippet in this plan quotes its paths; executors must do the same. Unquoted paths silently break with "no such file or directory" that points at the wrong location.

---

## Scope (State F only — hold the line)

### In scope

- `src/lib/errorCodeLabels.js` **[NEW]** — pure module exporting `ERROR_CODE_LABELS` (object mapping the 15 enum codes to human strings) + `getErrorLabel(code)` (null-safe getter with fallback). Copy the 15 codes from `extension/modules/telemetry.js:185–201` as a literal constant — do NOT import from `extension/`.
- `src/lib/__tests__/errorCodeLabels.test.js` **[NEW]** — unit test: every enum code has a non-empty label; `getErrorLabel(null)` / `getErrorLabel('unknown_code')` return a sensible fallback; the function is pure (same input → same output).
- `src/components/export/StateF_Partial.jsx` **[NEW]** — the real State F component. Replaces `StateF_Partial_Placeholder.jsx`. Renders:
  - Header: "Export partial — N / M clips downloaded · K failed" (mirrors design spec).
  - Failed-items list: per-item row with `{seq}_{source}_{source_item_id}.ext` filename (human-readable), source chip (Envato / Pexels / Freepik), and the human-readable error label from `getErrorLabel(item.error_code)`.
  - "Retry failed items" button — calls `onRetryFailed()` prop (provided by `ExportPage` via `ActiveRun`); the handler rebuilds a filtered unified manifest and invokes `onStart`.
  - "Generate XML anyway" button — local state `{xmlKickoffActive: bool}`. When clicked, conditionally mounts a small child component that calls `useExportXmlKickoff({autoKick: false, ...})` and then calls `regenerate()` once on mount. The Week 4 hook is hook-only so we MUST render it inside a component; the conditional mount keeps us from running the transform on State F's initial render (which would auto-download XML with partial placements before the user asks).
  - "Report issue" button — disabled `<button>` with a `title="Coming in Ext.8 — will auto-attach a diagnostic bundle"` tooltip; does nothing.
  - Small explanatory copy under "Generate XML anyway": "Missing clips appear as offline (red) in Premiere. You can relink them manually later." Copied verbatim from the design spec.
- `src/components/export/__tests__/StateF_Partial.test.jsx` **[NEW]** — component test using bare `createRoot` + `React.act` (same convention as `useExportXmlKickoff.test.js`). Asserts:
  - Renders the failed-items list from a mock `snapshot.items` with 3 failed + 2 done items (shows 3 rows).
  - Each failed row shows the human-readable label from `errorCodeLabels` (mock `envato_session_401` → "Envato session expired — sign in again").
  - Clicking "Retry failed items" calls `onRetryFailed` (spy via `vi.fn()`) with the filtered-by-failed-ids subset.
  - Clicking "Generate XML anyway" triggers `_apiPost` (injected test-seam of the hook) with the `{variants: [...]}` body (asserted via a vi-mocked `useExportXmlKickoff` that exposes the calls — or by injecting `_apiPost` through a wrapper we expose from `StateF_Partial` for testability).
  - "Report issue" button is disabled.
- `src/components/export/StateF_Partial_Placeholder.jsx` **[DELETED]** — file removal is part of the diff; the placeholder is fully superseded.
- `src/pages/ExportPage.jsx` **[MOD]** — three surgical edits:
  - Swap the import `StateF_Partial_Placeholder` → `StateF_Partial`.
  - Thread `onStart`, `pipelineId`, and `variant` down through `ActiveRun` to `StateF_Partial` (currently ActiveRun receives neither; add as props). Also pass the original `unifiedManifest` from reducer state (already stored as `state.unified_manifest`).
  - Provide an `onRetryFailed({ failedIds })` callback in `ExportPage` that rebuilds the filtered manifest from `state.unified_manifest.items` and calls `onStart(...)` — which ALREADY handles the createExport / sendSession / sendExport ceremony. Reuse, don't duplicate.
- `src/components/export/README.md` **[MOD]** — update the States E/F row to note F is now real (not a placeholder), drop the phrase "placeholder; real UI in next plan" for State F, add a "Partial-failure UI" paragraph describing the retry + generate-anyway + report-issue surface.
- **Final manual-smoke task (no commit)** — force a partial run via a deliberately-bad Pexels ID in the manifest; observe State F renders; click "Retry failed items" and observe a fresh run starts; click "Generate XML anyway" on the original State F (from a second tab if needed) and observe XML download with partial placements.

### Deferred (DO NOT add to State F)

- **Diagnostic bundle auto-attach on "Report issue"** — Ext.8 owns `chrome.storage.local` log ring + zip-and-download. WebApp.4 wires "Report issue" to invoke Ext.8's exporter. This plan stubs the button only.
- **Admin UI for viewing partial exports** — WebApp.3 owns `/admin/exports` and the per-export drill-down. Out of scope.
- **Extension changes** — this plan is web-only. If the executor discovers a contract change IS required (e.g. the Port's `complete` message doesn't carry enough to render the failed list — see invariant #1 for why it does), flag it and STOP before writing extension code. The extension carries the per-item `phase='failed'` and `error_code` on every Port `state` broadcast plus the terminal `complete` counts; no change needed.
- **New XMEML generator features** (drop-failed-items mode, offline-ref annotations) — reuse what Week 4 shipped. `buildVariantsPayload` already iterates placements agnostic to whether the file downloaded; the generator's `<pathurl>` emits and Premiere handles the offline display. See open question #4.
- **Retry backoff / per-failure retry** — the Retry button is a full-manifest retry of the failed subset. A per-item retry UI (three dots → "Retry this one") is State F v2 territory.
- **Worktree across the web + extension** — this plan creates one worktree under `.worktrees/` for the web changes only. No extension worktree.

Fight the urge to "just add" any of the above. The plan is deliberately small (~300 LOC new, ~30 LOC modified) and the deferred items are their own PR-sized concerns.

---

## Prerequisites

- **Week 4 (WebApp.1 State E XMEML wire) merged to `main`.** Verified at commit `b748f10` ("Merge branch 'feature/webapp-state-e-xmeml' into main"). The executor confirms by running `git log --oneline -5 | grep -q webapp-state-e-xmeml && echo OK || echo MISSING` and halting if missing.
- **`useExportXmlKickoff` hook exists at `src/hooks/useExportXmlKickoff.js`** with the exported named symbols: `useExportXmlKickoff`, `buildVariantsPayload`, `triggerXmlDownload`. Verified in tree (204 LOC as of `main`).
- **`StateF_Partial_Placeholder.jsx` exists at `src/components/export/StateF_Partial_Placeholder.jsx`** and receives `{complete, snapshot}` props. Verified — this plan DELETES it.
- **FSM in `ExportPage.jsx` already routes `phase === 'state_f'`** when `fail_count > 0` on completion. Verified at `src/pages/ExportPage.jsx:39–42` — `export_completed` reducer action reads `action.payload?.fail_count ?? 0` and sets `phase: fail > 0 ? 'state_f' : 'state_e'`. **No reducer change needed** for this plan.
- **`vitest.workspace.js` exists** with a `web` project on happy-dom environment whose `include` pattern accepts `.jsx` (verified: `src/**/__tests__/**/*.test.jsx`). No vitest config change needed.
- **`package.json`** carries `happy-dom@^14.12.3` in devDependencies (verified). No new dependencies for this plan — specifically NOT adding `@testing-library/react` (Week 4 State E plan's decision).
- **Node 20+**, `npm test` passes against `main` before branching. Executor runs `npm test 2>&1 | tail -6` and halts if not all-green.
- **15-code error enum** at `extension/modules/telemetry.js:185–201` (confirm the frozen array at that line range still holds the 15 codes — this plan copies them into `src/lib/errorCodeLabels.js`). Any drift means the plan needs a re-read before landing.
- **Path to the repo has a trailing space in `"one last "`** — quote every path in every shell snippet.

---

## File structure (State F final state)

All paths are inside `$TE` where `TE="/Users/laurynas/Desktop/one last /transcript-eval"`.

```
$TE/src/
├── lib/
│   ├── errorCodeLabels.js                          [NEW] 15-code → human-string map + getErrorLabel()
│   └── __tests__/
│       └── errorCodeLabels.test.js                 [NEW] exhaustive-enum + fallback coverage
├── hooks/
│   └── useExportXmlKickoff.js                      (unchanged — reused via hook mount)
├── components/export/
│   ├── StateF_Partial.jsx                          [NEW] real State F UI
│   ├── StateF_Partial_Placeholder.jsx              [DELETED]
│   ├── StateE_Complete.jsx                         (unchanged)
│   ├── StateD_InProgress.jsx                       (unchanged)
│   ├── README.md                                   [MOD] drop "placeholder" language for State F
│   └── __tests__/
│       └── StateF_Partial.test.jsx                 [NEW] component test (happy-dom + bare createRoot)
└── pages/
    └── ExportPage.jsx                              [MOD] import swap + prop threading +
                                                         onRetryFailed callback

$TE/docs/superpowers/plans/
└── 2026-04-24-webapp-state-f-partial-ui.md         THIS FILE
```

Why this split:
- `errorCodeLabels.js` is a pure module (no React), so it lives in `src/lib/` alongside `buildManifest.js` (existing pattern). A React component importing it is fine; a future admin page (WebApp.3) can import the same module to render errors the same way.
- `StateF_Partial.jsx` stays sibling to `StateE_Complete.jsx` in `src/components/export/` — same naming convention, same styled-components idiom. A `grep -R _Placeholder src/` after this plan lands should return zero matches (State E's placeholder was already deleted in Week 4), which is the correct "no TODOs" end state.
- `StateF_Partial.test.jsx` goes under `src/components/export/__tests__/` — matches the `src/hooks/__tests__/` convention already used by `useExportXmlKickoff.test.js`. The `.jsx` extension is already in the vitest workspace include pattern.
- `src/pages/ExportPage.jsx` is modified minimally — swap import, add two props to `ActiveRun`, add an `onRetryFailed` callback. No reducer action added (per open question #3 Option A).

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/webapp-state-f-partial-ui` on branch `feature/webapp-state-f-partial-ui`. Branch from local `main` (which has Week 4 merged). Task 0 creates the worktree, the branch, and commits this plan file + an empty component shell so subsequent tasks have a clean parent to diff against.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan. The final manual-smoke task (no commit) has an explicit "DO NOT push" reminder.
- **Never kill anything on port 3001.** User's backend dev server runs there; leave it alone. The manual-smoke task relies on it being up.
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing in every shell call.
- **Never amend.** If a pre-commit hook fails, fix the root cause, re-stage, and make a NEW commit. Amending hides history; new commits are cheaper than debugging lost work.
- **Commit style:** conventional commits (`feat(webapp): …`, `test(webapp): …`, `docs(webapp): …`, `refactor(webapp): …`). Multi-line body OK. Add the Claude co-author trailer to EVERY commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **One commit per Task.** Tasks 0, 1, 2, 3, 4, 5, 6, 7 each produce exactly one commit. The final manual-smoke task produces NONE.
- **Leave the user's dirty tree alone.** These files are known-dirty on `main` and MUST NOT appear in any staged diff: `server/routes/gpu.js`, `server/services/gpu-failure-poller.js`, `check_placement.js`, `final_query*.js`, `query_*.js`, `server/db.sqlite`, `server/seed/update-*.js`, `docs/plans/2026-04-22-reset-broll-searches.md`, `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md`. Before any `git add` the executor runs `git status --short` and confirms only this plan's files are touched. If an unrelated file shows dirty in the worktree, it's inherited from the parent working tree — leave it, stage surgically.
- **Never modify `~/.git` or git config.** Never use destructive git ops (`reset --hard`, `push --force`, `branch -D`) unless the user explicitly requests them.

---

## Task 0: Create worktree + branch + scaffold commit

**Files:**
- Create: `$TE/.worktrees/webapp-state-f-partial-ui/` (worktree)
- Create: `$TE/docs/superpowers/plans/2026-04-24-webapp-state-f-partial-ui.md` (this file — travels with the branch)
- Create: `$TE/src/components/export/StateF_Partial.jsx` (empty shell — default-export a `function StateF_Partial(){ return null }` so Task 2 can iterate)
- Create: `$TE/src/lib/errorCodeLabels.js` (empty shell — default export `{}` and named `getErrorLabel` returning `'Unknown error'`; Task 1 fills in)

This mirrors the Ext.6 / State E Task 0 convention: worktree + branch + checked-in plan + empty module shells all land in one scaffold commit so subsequent tasks have a clean parent to diff against.

- [ ] **Step 1: Create the worktree and branch from local `main`**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git status --short
# Expected: dirty lines only from the user's known-dirty files (see Working
# conventions). No files in src/pages/ src/components/export/ src/hooks/ src/lib/
# or docs/superpowers/plans/ should appear.
git log --oneline -5
# Expected: top commit is 3e4d39d (upload-config plan) or later; b748f10 (State E
# merge) must appear in the last 5. If not, STOP — Week 4 didn't land.
git worktree add -b feature/webapp-state-f-partial-ui .worktrees/webapp-state-f-partial-ui main
```

- [ ] **Step 2: Enter the worktree and verify Week 4 state is inherited**

```bash
cd "$TE/.worktrees/webapp-state-f-partial-ui"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/webapp-state-f-partial-ui
git branch --show-current
# Expected: feature/webapp-state-f-partial-ui
ls src/hooks/
# Expected: useApi.js useExportPort.js useExportPreflight.js useExportXmlKickoff.js useExtension.js
ls src/components/export/
# Expected: StateA_Install.jsx StateB_Session.jsx StateC_Summary.jsx StateD_InProgress.jsx
#           StateE_Complete.jsx StateF_Partial_Placeholder.jsx progressState.js README.md
# If StateE_Complete.jsx is named _Placeholder, Week 4 didn't land correctly. STOP.
```

- [ ] **Step 3: Run the existing vitest suite — baseline must be green**

```bash
npm test 2>&1 | tail -10
# Expected: both projects (`server` + `web`) report passed. Total should be >= 50.
# If anything red, STOP — don't build on a broken baseline.
```

- [ ] **Step 4: Create the empty shell files**

Use Write tool for each. Keep each minimal.

`$TE/.worktrees/webapp-state-f-partial-ui/src/lib/errorCodeLabels.js`:
```js
// Task 1 fills this in — 15-code enum → human-string mapping for
// State F's failed-items list. Keep pure: no React, no extension
// imports, no side effects.
//
// See extension/modules/telemetry.js:185–201 for the enum source of
// truth. Copy those 15 values as a literal constant here — do NOT
// import from extension/ (web and extension are separate module
// graphs).

export const ERROR_CODE_LABELS = Object.freeze({})

export function getErrorLabel(_code) {
  return 'Unknown error'
}
```

`$TE/.worktrees/webapp-state-f-partial-ui/src/components/export/StateF_Partial.jsx`:
```jsx
// Task 2 fills this in — real State F UI. Replaces StateF_Partial_Placeholder.
// Renders per-failure diagnostics + retry + generate-anyway + report-issue stub.
//
// Props:
//   complete        — extension's {type:"complete"} payload (ok_count, fail_count, folder_path)
//   snapshot        — useExportPort snapshot with items[]; failed items have phase='failed' + error_code
//   exportId        — the completed run's export_id (for "Generate XML anyway")
//   variantLabels   — e.g. ['A', 'C']
//   unifiedManifest — the manifest built at State C (threaded through ExportPage state)
//   onRetryFailed   — callback to kick a fresh export with only the failed subset
//
// See docs/superpowers/plans/2026-04-24-webapp-state-f-partial-ui.md
// for the full "Why read this before touching code" invariants.

export default function StateF_Partial(_props) {
  return null
}
```

- [ ] **Step 5: Write this plan file into `docs/superpowers/plans/`**

The plan was drafted in the planner session and should already be at the expected path in the main worktree. Copy or checkout into the new worktree (Git handles this because the plan is committed to `main` — if it's NOT committed to main, the planner session created it in `main`'s working tree and the new worktree will see it as part of the tree).

```bash
test -f docs/superpowers/plans/2026-04-24-webapp-state-f-partial-ui.md && echo OK || echo MISSING
# Expected: OK. If MISSING, the plan wasn't inherited — copy from the main worktree.
```

- [ ] **Step 6: Stage and commit the scaffold**

```bash
git status --short
# Expected: exactly 3 untracked/new files:
#   src/lib/errorCodeLabels.js
#   src/components/export/StateF_Partial.jsx
#   docs/superpowers/plans/2026-04-24-webapp-state-f-partial-ui.md
# If any other file is listed, STOP and investigate (the user's dirty tree should
# not leak into this worktree; if it did, skip those in the add below).

git add src/lib/errorCodeLabels.js src/components/export/StateF_Partial.jsx docs/superpowers/plans/2026-04-24-webapp-state-f-partial-ui.md
git diff --cached --stat
# Expected: 3 files added, ~60 lines total.

git commit -m "$(cat <<'EOF'
docs(plan): WebApp.1 State F — partial-failure UI

Scaffold commit. Creates:
  - docs/superpowers/plans/2026-04-24-webapp-state-f-partial-ui.md
    (this plan)
  - src/lib/errorCodeLabels.js (empty shell — Task 1 fills in the
    15-code enum → human-string map)
  - src/components/export/StateF_Partial.jsx (empty shell — Task 2
    builds the real State F UI; Task 3 wires retry; Task 4 wires
    "Generate XML anyway" via the Week 4 useExportXmlKickoff hook;
    Task 5 stubs "Report issue" until Ext.8)

This plan REPLACES StateF_Partial_Placeholder.jsx (Week 3's stub)
with a real UI per the design spec's State F mockup. No extension
change, no schema change, no XMEML generator change — reuses the
Week 4 hook and the existing onStart ceremony for retry.

Open questions flagged:
  1. Retry semantics — new exports row (recommended) vs mutate.
  2. "Report issue" — disabled tooltip (recommended) vs mailto.
  3. FSM — straight to state_d (recommended) vs state_c preview.
  4. "Generate XML anyway" — no generator change (per design spec).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Verify the commit landed on the feature branch**

```bash
git log --oneline -3
# Expected: top line is the scaffold commit on feature/webapp-state-f-partial-ui.
git log --oneline main..HEAD
# Expected: exactly 1 commit (the scaffold).
```

---

## Task 1: Build `errorCodeLabels.js` + tests

Pure module. No React. 15 keys. One fallback function. One test file covering both.

**Files:**
- Modify: `$TE/.worktrees/webapp-state-f-partial-ui/src/lib/errorCodeLabels.js` (fill in the shell)
- Create: `$TE/.worktrees/webapp-state-f-partial-ui/src/lib/__tests__/errorCodeLabels.test.js`

- [ ] **Step 1: Read the 15-code enum at the source**

Use the Read tool on `extension/modules/telemetry.js` lines 185–201. Confirm the frozen array still has exactly 15 values in this order:

```
envato_403, envato_402_tier, envato_429, envato_session_401,
envato_unavailable, envato_unsupported_filetype,
freepik_404, freepik_429, freepik_unconfigured,
pexels_404,
network_failed, disk_failed, integrity_failed,
resolve_failed, url_expired_refetch_failed
```

If the count differs or the order differs, update the plan's Task 1 label table below to match before writing the file. This is the only authoritative list in the codebase — treat drift as a hard blocker.

- [ ] **Step 2: Fill in `src/lib/errorCodeLabels.js`**

Use the Edit tool. Replace the shell with the full module. Each label aims at ~6-12 words, phrased so the non-technical user can act on it.

| Code                              | Label                                                         |
|-----------------------------------|---------------------------------------------------------------|
| `envato_403`                      | Envato blocked this asset (403) — license issue               |
| `envato_402_tier`                 | Envato plan tier doesn't include this asset                   |
| `envato_429`                      | Envato rate-limited — try again in a few minutes              |
| `envato_session_401`              | Envato session expired — sign in again                        |
| `envato_unavailable`              | Envato item unavailable (delisted or removed)                 |
| `envato_unsupported_filetype`     | Envato returned an unsupported file format                    |
| `freepik_404`                     | Freepik item not found (removed or invalid)                   |
| `freepik_429`                     | Freepik rate-limited — try again in a few minutes             |
| `freepik_unconfigured`            | Freepik API key not set — contact support                     |
| `pexels_404`                      | Pexels item not found (removed or invalid)                    |
| `network_failed`                  | Network error — check your connection and retry               |
| `disk_failed`                     | Couldn't write to disk — check free space and permissions     |
| `integrity_failed`                | Downloaded file failed integrity check — corrupt or tampered  |
| `resolve_failed`                  | Couldn't locate the source file — try again later             |
| `url_expired_refetch_failed`      | Download URL expired — server refused to renew                |

`new_string` for the module body (the `old_string` is the shell from Task 0):

```js
// 15-code error_code enum → human-string mapping for State F's
// per-failure diagnostics list. Pure module: no React, no extension
// imports, no side effects.
//
// Source of truth: extension/modules/telemetry.js:185–201 (ERROR_CODE_ENUM).
// The 15 codes are copied as a literal below — do NOT import from
// extension/, which lives in a separate module graph from the web
// app's Vite build tree.
//
// Labels are 6–12 words, phrased to tell the non-technical user what
// happened and (where applicable) what to do next. If a new code lands
// in the extension enum, add it here AND bump the exhaustiveness test
// in src/lib/__tests__/errorCodeLabels.test.js.

export const ERROR_CODE_LABELS = Object.freeze({
  envato_403:                   'Envato blocked this asset (403) — license issue',
  envato_402_tier:              'Envato plan tier doesn\'t include this asset',
  envato_429:                   'Envato rate-limited — try again in a few minutes',
  envato_session_401:           'Envato session expired — sign in again',
  envato_unavailable:           'Envato item unavailable (delisted or removed)',
  envato_unsupported_filetype:  'Envato returned an unsupported file format',
  freepik_404:                  'Freepik item not found (removed or invalid)',
  freepik_429:                  'Freepik rate-limited — try again in a few minutes',
  freepik_unconfigured:         'Freepik API key not set — contact support',
  pexels_404:                   'Pexels item not found (removed or invalid)',
  network_failed:               'Network error — check your connection and retry',
  disk_failed:                  'Couldn\'t write to disk — check free space and permissions',
  integrity_failed:             'Downloaded file failed integrity check — corrupt or tampered',
  resolve_failed:               'Couldn\'t locate the source file — try again later',
  url_expired_refetch_failed:   'Download URL expired — server refused to renew',
})

// Null-safe getter with a readable fallback. State F calls this per
// failed item; the extension may normalize an unknown raw string to
// null (see extension/modules/telemetry.js normalizeErrorCode), so we
// must handle null gracefully.
export function getErrorLabel(code) {
  if (code == null) return 'Unknown error — check diagnostic bundle for details'
  const label = ERROR_CODE_LABELS[code]
  if (typeof label === 'string' && label.length > 0) return label
  return `Unknown error (${code})`
}
```

- [ ] **Step 3: Write the test file**

Use Write tool. Path: `src/lib/__tests__/errorCodeLabels.test.js`.

```js
// Unit tests for errorCodeLabels. Runs under the `web` vitest project
// (happy-dom env) — but this module is pure, so it doesn't touch any
// DOM globals. Still, keep it .js not .jsx — no JSX here.

import { describe, it, expect } from 'vitest'
import { ERROR_CODE_LABELS, getErrorLabel } from '../errorCodeLabels.js'

// The 15 codes from extension/modules/telemetry.js:185–201. If the
// extension enum grows, this list must grow in lockstep — that's the
// invariant exhaustiveness is asserting.
const EXPECTED_CODES = [
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
]

describe('ERROR_CODE_LABELS', () => {
  it('has exactly the 15 expected codes', () => {
    const keys = Object.keys(ERROR_CODE_LABELS).sort()
    expect(keys).toEqual([...EXPECTED_CODES].sort())
    expect(keys).toHaveLength(15)
  })

  it('every label is a non-empty string', () => {
    for (const code of EXPECTED_CODES) {
      expect(typeof ERROR_CODE_LABELS[code]).toBe('string')
      expect(ERROR_CODE_LABELS[code].length).toBeGreaterThan(0)
    }
  })

  it('is frozen (cannot be mutated at runtime)', () => {
    expect(Object.isFrozen(ERROR_CODE_LABELS)).toBe(true)
  })
})

describe('getErrorLabel', () => {
  it('returns the label for a known code', () => {
    expect(getErrorLabel('envato_session_401')).toBe(ERROR_CODE_LABELS.envato_session_401)
    expect(getErrorLabel('disk_failed')).toBe(ERROR_CODE_LABELS.disk_failed)
  })

  it('returns a readable fallback for null', () => {
    expect(getErrorLabel(null)).toMatch(/unknown/i)
  })

  it('returns a readable fallback for undefined', () => {
    expect(getErrorLabel(undefined)).toMatch(/unknown/i)
  })

  it('returns a fallback that includes the raw code for unknown strings', () => {
    const label = getErrorLabel('some_future_code_we_dont_know')
    expect(label).toMatch(/unknown/i)
    expect(label).toContain('some_future_code_we_dont_know')
  })

  it('is pure — same input yields same output', () => {
    expect(getErrorLabel('pexels_404')).toBe(getErrorLabel('pexels_404'))
  })
})
```

- [ ] **Step 4: Run the new tests — both should pass**

```bash
npm test 2>&1 | tail -15
# Expected: both projects green. The `web` project picks up the new test;
# total count increases by ~6 tests. If anything red, fix before committing.
```

- [ ] **Step 5: Commit**

```bash
git status --short
# Expected: 2 modified/new files:
#   M src/lib/errorCodeLabels.js
#   ?? src/lib/__tests__/errorCodeLabels.test.js

git add src/lib/errorCodeLabels.js src/lib/__tests__/errorCodeLabels.test.js
git diff --cached --stat
# Expected: 2 files, ~90 lines added, ~4 lines removed (the shell body).

git commit -m "$(cat <<'EOF'
feat(webapp): errorCodeLabels — 15-code enum → human-string map

Pure module for State F's per-failure diagnostics list. Owns the
mapping from extension/modules/telemetry.js's 15-code ERROR_CODE_ENUM
to human-readable strings the user can act on (e.g.
"envato_session_401" → "Envato session expired — sign in again").

Source of truth stays in extension/modules/telemetry.js; this module
copies the 15 codes as a literal constant (the web and extension
module graphs are deliberately separate — the extension must never
be a Vite build dep).

Tests assert exhaustiveness (exactly 15 keys), label non-emptiness,
the Object.freeze invariant, and the null-safe fallback path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Build `StateF_Partial.jsx` — render the failed-items list

Replaces the placeholder's raw dump with a styled list of failed items + header counts. No retry button yet (Task 3), no XMEML button yet (Task 4), no report-issue stub yet (Task 5). This task's single deliverable is "looks like the design spec's State F mockup with a list of failures."

**Files:**
- Modify: `$TE/.worktrees/webapp-state-f-partial-ui/src/components/export/StateF_Partial.jsx` (fill in the shell)

- [ ] **Step 1: Read sibling components for the styled-components idiom**

Use the Read tool on `src/components/export/StateE_Complete.jsx` (the closest sibling; similar card layout, same color vocabulary). Note:
- `Wrap` is the outer `max-width: 640px; margin: 60px auto;` container.
- `Card` is the white rounded-border box.
- `Header` is the colored h1 with an icon from `lucide-react`.
- For State F's semantics, the header color is `#b45309` (amber 700 — warn/partial) matching the placeholder's convention.

- [ ] **Step 2: Fill in the component body**

Use Edit tool. Replace the `StateF_Partial.jsx` shell with the full component. The body goes in three parts: (a) styled-components, (b) the `FailedItemRow` sub-component, (c) the main default export.

The Edit's `old_string` is the shell body; `new_string` is:

```jsx
import styled from 'styled-components'
import { AlertCircle } from 'lucide-react'
import { getErrorLabel } from '../../lib/errorCodeLabels.js'

// State F: partial-failure UI. Renders when the extension's
// {type:"complete"} Port message reports fail_count > 0. Reads:
//   - `complete`         — the extension's {type:"complete"} payload
//                          (ok_count, fail_count, folder_path).
//   - `snapshot`         — useExportPort's final snapshot. We read
//                          snapshot.items[] to get the failed item
//                          list with per-item source_item_id + source
//                          + target_filename + error_code.
//   - `exportId`         — the completed run's export_id.
//   - `variantLabels`    — e.g. ['A', 'C'].
//   - `unifiedManifest`  — the manifest built at State C, threaded
//                          through ExportPage's reducer state. Used
//                          in Task 3 to rebuild a filtered manifest
//                          for retry; Task 4 passes it to the
//                          useExportXmlKickoff hook.
//   - `onRetryFailed`    — callback wired in Task 3.
//
// This task (Task 2) renders the header + failed-items list only.
// Tasks 3/4/5 add the action row.

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
  margin: 0 0 8px;
  color: #b45309;
`

const Summary = styled.p`
  margin: 0 0 20px;
  color: #4b5563;
  font-size: 14px;
`

const SectionLabel = styled.div`
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 8px;
  letter-spacing: 0.02em;
`

const List = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0 0 20px;
  border: 1px solid #fde68a;
  background: #fffbeb;
  border-radius: 6px;
`

const Row = styled.li`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid #fef3c7;
  font-size: 13px;
  &:last-child { border-bottom: 0; }
`

const Filename = styled.span`
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: #1f2937;
  flex-shrink: 0;
`

const SourceChip = styled.span`
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  background: #e0f2fe;
  color: #075985;
  text-transform: uppercase;
  flex-shrink: 0;
`

const Reason = styled.span`
  color: #78350f;
  flex: 1;
`

function FailedItemRow({ item }) {
  const label = getErrorLabel(item.error_code)
  return (
    <Row>
      <Filename>{item.target_filename || `item-${item.seq}`}</Filename>
      <SourceChip>{item.source || 'unknown'}</SourceChip>
      <Reason>{label}</Reason>
    </Row>
  )
}

export default function StateF_Partial({
  complete,
  snapshot,
  // Props wired in Tasks 3–4; unused in Task 2 but already accepted
  // so ExportPage's prop-threading edit in Task 6 compiles:
  // eslint-disable-next-line no-unused-vars
  exportId,
  // eslint-disable-next-line no-unused-vars
  variantLabels,
  // eslint-disable-next-line no-unused-vars
  unifiedManifest,
  // eslint-disable-next-line no-unused-vars
  onRetryFailed,
}) {
  const ok = complete?.ok_count ?? 0
  const fail = complete?.fail_count ?? 0
  const total = ok + fail
  const failedItems = Array.isArray(snapshot?.items)
    ? snapshot.items.filter(it => it.phase === 'failed')
    : []

  return (
    <Wrap>
      <Card>
        <Header>
          <AlertCircle size={22} /> Export partial
        </Header>
        <Summary>
          {ok} / {total} clip{total === 1 ? '' : 's'} downloaded · {fail} failed
        </Summary>

        <SectionLabel>Failed items</SectionLabel>
        {failedItems.length === 0 ? (
          <Summary>
            The extension reported {fail} failure{fail === 1 ? '' : 's'} but
            did not include a per-item list. This is rare — check the
            extension popup or try reloading the page.
          </Summary>
        ) : (
          <List>
            {failedItems.map(it => (
              <FailedItemRow key={it.source_item_id || it.seq} item={it} />
            ))}
          </List>
        )}

        {/* Action row lands in Tasks 3–5. */}
      </Card>
    </Wrap>
  )
}
```

- [ ] **Step 3: Sanity-check the component mounts without crashing**

The component imports `getErrorLabel` from Task 1 and `styled`/`AlertCircle` which are already project-wide deps. Confirm by running:

```bash
npm test 2>&1 | tail -10
# Expected: all projects green. No new tests for the component yet (those land
# in Task 7), but the import-graph must resolve. If happy-dom can't find a dep,
# Week 4's vitest setup has a regression — STOP and diagnose.
```

- [ ] **Step 4: Commit**

```bash
git status --short
# Expected: 1 modified file: M src/components/export/StateF_Partial.jsx.

git add src/components/export/StateF_Partial.jsx
git diff --cached --stat
# Expected: ~160 lines added, ~5 lines removed (the shell body).

git commit -m "$(cat <<'EOF'
feat(webapp): StateF_Partial — header + failed-items list

Replaces the placeholder's raw dump with a styled list matching the
design spec mockup (spec/2026-04-23-envato-export-design.md ≈ line
181). Renders:
  - Amber "Export partial" header with AlertCircle icon.
  - Summary line: "N / M clips downloaded · K failed".
  - Per-failure row: monospace filename + colored source chip
    (envato/pexels/freepik) + human-readable reason from
    getErrorLabel(item.error_code).

Action row (Retry / Generate XML anyway / Report issue) lands in
Tasks 3–5 of this plan. Props exportId / variantLabels /
unifiedManifest / onRetryFailed are accepted but unused in this
task so ExportPage's prop-threading edit (Task 6) type-checks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire "Retry failed items" button

Add the Retry button. Clicking it calls `onRetryFailed({ failedIds })` — a callback provided by `ExportPage` (wired in Task 6) that rebuilds a filtered manifest from the original `unified_manifest.items` and calls the existing `onStart` ceremony.

**Files:**
- Modify: `$TE/.worktrees/webapp-state-f-partial-ui/src/components/export/StateF_Partial.jsx`

- [ ] **Step 1: Add the Retry button + wire the onRetryFailed callback**

Use Edit tool. Insert a styled `RetryBtn` and an `ActionRow` wrapper above the existing `{/* Action row lands in Tasks 3–5. */}` comment. Update the comment to `{/* "Generate XML anyway" + "Report issue" land in Tasks 4–5. */}`.

Also add an `onRetryClick` handler inside the component body that computes the failed IDs and invokes the callback.

`old_string` (the TAIL of the component after the List):
```jsx
        )}

        {/* Action row lands in Tasks 3–5. */}
      </Card>
    </Wrap>
  )
}
```

`new_string`:
```jsx
        )}

        <ActionRow>
          <RetryBtn
            type="button"
            onClick={onRetryClick}
            disabled={!onRetryFailed || failedItems.length === 0}
            title={!onRetryFailed ? 'Retry wiring unavailable — see devtools' : undefined}
          >
            <RefreshCw size={14} /> Retry failed items
          </RetryBtn>
          {/* "Generate XML anyway" + "Report issue" land in Tasks 4–5. */}
        </ActionRow>
      </Card>
    </Wrap>
  )
}
```

Also at the top of the component (before the `return`), add the callback:

`old_string` (the BODY of the component before the return):
```jsx
  const failedItems = Array.isArray(snapshot?.items)
    ? snapshot.items.filter(it => it.phase === 'failed')
    : []

  return (
```

`new_string`:
```jsx
  const failedItems = Array.isArray(snapshot?.items)
    ? snapshot.items.filter(it => it.phase === 'failed')
    : []

  // Retry: collect source_item_ids of failed items and hand off to
  // the caller. ExportPage rebuilds the filtered manifest from its
  // authoritative state.unified_manifest.items (NOT from snapshot.items,
  // which is the Port's wire view and loses envato_item_url / placements).
  // See invariant #5 in the plan.
  function onRetryClick() {
    if (!onRetryFailed || failedItems.length === 0) return
    const failedIds = new Set(failedItems.map(it => it.source_item_id).filter(Boolean))
    onRetryFailed({ failedIds })
  }

  return (
```

Finally add the new `RefreshCw` import and the two new styled-components at the top of the imports block:

`old_string`:
```jsx
import styled from 'styled-components'
import { AlertCircle } from 'lucide-react'
import { getErrorLabel } from '../../lib/errorCodeLabels.js'
```

`new_string`:
```jsx
import styled from 'styled-components'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { getErrorLabel } from '../../lib/errorCodeLabels.js'
```

And below the other styled-components (after `Reason = styled.span...`), before `function FailedItemRow`:

Use a second Edit call. `old_string`:
```jsx
const Reason = styled.span`
  color: #78350f;
  flex: 1;
`

function FailedItemRow({ item }) {
```

`new_string`:
```jsx
const Reason = styled.span`
  color: #78350f;
  flex: 1;
`

const ActionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
`

const RetryBtn = styled.button`
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
  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  &:hover:not(:disabled) {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
`

function FailedItemRow({ item }) {
```

- [ ] **Step 2: Remove the now-stale `eslint-disable-next-line no-unused-vars` comment for `onRetryFailed`** (it's used now).

Use Edit tool. `old_string`:
```jsx
  unifiedManifest,
  // eslint-disable-next-line no-unused-vars
  onRetryFailed,
}) {
```

`new_string`:
```jsx
  unifiedManifest,
  onRetryFailed,
}) {
```

- [ ] **Step 3: Sanity-check**

```bash
npm test 2>&1 | tail -10
# Expected: all green. The Retry button has no tests yet — Task 7 covers it.
# If any import fails (e.g. RefreshCw not in lucide-react's exports), STOP —
# the project already uses lucide-react; check the version and the symbol.
```

- [ ] **Step 4: Commit**

```bash
git add src/components/export/StateF_Partial.jsx
git diff --cached --stat
# Expected: 1 file, ~40 lines added, ~2 lines removed.

git commit -m "$(cat <<'EOF'
feat(webapp): StateF_Partial — "Retry failed items" button

Wires a Retry button that collects the failed items'
source_item_ids and invokes an onRetryFailed({failedIds}) callback
from the parent. The parent (ExportPage, Task 6) rebuilds a filtered
manifest from its authoritative state.unified_manifest.items and
kicks the existing onStart ceremony — createExport → sendSession →
sendExport — which produces a fresh exports row and a fresh run.
The FSM naturally transitions back to state_d via the existing
export_started reducer action; no new reducer action.

The Retry button disables when no onRetryFailed is wired or when
there are zero failed items (defensive — State F should not mount
with zero failures, but a stale Port snapshot could race).

The filtered manifest path lives in ExportPage (Task 6) — this
component only hands off the failed IDs. See plan invariant #5
("filtered retry manifest MUST preserve all the original fields")
for why the component does NOT reconstruct items from snapshot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire "Generate XML anyway" button via `useExportXmlKickoff`

Reuse the Week 4 hook. The trick: the hook is a hook — we can't call it conditionally from a handler; we have to mount a child component when the user clicks, and that child calls the hook with `autoKick: false` then `regenerate()` on mount. This also cleanly scopes the hook's state to the post-click render (no orphaned XML state if the user never clicks).

**Files:**
- Modify: `$TE/.worktrees/webapp-state-f-partial-ui/src/components/export/StateF_Partial.jsx`

- [ ] **Step 1: Add the XmlKickoffPanel child component + wire the button**

Use Edit tool. First, add a useState for the "XML panel shown" flag, and add the button + panel to the ActionRow. Also update the `useState` import.

`old_string` (top imports):
```jsx
import styled from 'styled-components'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { getErrorLabel } from '../../lib/errorCodeLabels.js'
```

`new_string`:
```jsx
import { useState, useEffect } from 'react'
import styled from 'styled-components'
import { AlertCircle, RefreshCw, FileText, Download } from 'lucide-react'
import { getErrorLabel } from '../../lib/errorCodeLabels.js'
import { useExportXmlKickoff, triggerXmlDownload } from '../../hooks/useExportXmlKickoff.js'
```

Then add the panel component + a new styled button below the existing styled-components. Use Edit. `old_string`:
```jsx
const RetryBtn = styled.button`
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
  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  &:hover:not(:disabled) {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
`

function FailedItemRow({ item }) {
```

`new_string`:
```jsx
const RetryBtn = styled.button`
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
  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  &:hover:not(:disabled) {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
`

const XmlBtn = styled(RetryBtn)``

const XmlPanel = styled.div`
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #f9fafb;
  font-size: 13px;
  color: #4b5563;
`

const XmlErrorBox = styled.div`
  padding: 10px 14px;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 6px;
  font-size: 13px;
  margin-top: 8px;
`

const XmlDownloadBtn = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #1a1a1a;
  font-size: 12px;
  cursor: pointer;
  margin-top: 8px;
  &:hover { background: #f3f4f6; }
`

// Child component — mounts ONLY when the user clicks "Generate XML
// anyway." Calling useExportXmlKickoff conditionally would violate
// React's rules-of-hooks; isolating it here keeps the hook's state
// scoped to the user's explicit opt-in.
//
// autoKick:false disables the hook's built-in auto-run (which is
// gated on fail_count===0 anyway — State F would never auto-kick —
// but we pass it explicitly for clarity). We fire regenerate() once
// on mount to kick the 3-step flow.
function XmlKickoffPanel({ exportId, variantLabels, unifiedManifest, complete }) {
  const kickoff = useExportXmlKickoff({
    exportId,
    variantLabels,
    unifiedManifest,
    complete,
    autoKick: false,
  })

  // Fire once on mount.
  useEffect(() => {
    kickoff.regenerate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const xmlByVariant = kickoff.xml_by_variant || {}
  const variantsReady = kickoff.status === 'ready' && Object.keys(xmlByVariant).length > 0

  function onDownloadAgain(label) {
    const xml = xmlByVariant[label]
    if (!xml) return
    triggerXmlDownload(`variant-${String(label).toLowerCase()}.xml`, xml)
  }

  return (
    <XmlPanel>
      <div>
        Missing clips will appear as offline (red) in Premiere. You can
        relink them manually later.
      </div>
      {kickoff.status === 'posting-result' && (
        <div style={{ marginTop: 8 }}><FileText size={14} /> Preparing XML&hellip;</div>
      )}
      {kickoff.status === 'generating' && (
        <div style={{ marginTop: 8 }}><FileText size={14} /> Generating XML&hellip;</div>
      )}
      {kickoff.status === 'error' && (
        <XmlErrorBox>
          <strong>Couldn&rsquo;t generate XML.</strong>{' '}
          {kickoff.error || 'Unknown error.'} Try again below.
          <div style={{ marginTop: 8 }}>
            <XmlDownloadBtn type="button" onClick={kickoff.regenerate}>
              <RefreshCw size={14} /> Retry generate
            </XmlDownloadBtn>
          </div>
        </XmlErrorBox>
      )}
      {variantsReady && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {variantLabels.map(label => xmlByVariant[label] ? (
            <XmlDownloadBtn key={label} type="button" onClick={() => onDownloadAgain(label)}>
              <Download size={14} /> Download variant-{String(label).toLowerCase()}.xml again
            </XmlDownloadBtn>
          ) : null)}
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
            XML auto-downloaded to your default downloads folder.
          </div>
        </div>
      )}
    </XmlPanel>
  )
}

function FailedItemRow({ item }) {
```

Then add the button + conditional panel mount inside the ActionRow. Use Edit. `old_string`:
```jsx
        <ActionRow>
          <RetryBtn
            type="button"
            onClick={onRetryClick}
            disabled={!onRetryFailed || failedItems.length === 0}
            title={!onRetryFailed ? 'Retry wiring unavailable — see devtools' : undefined}
          >
            <RefreshCw size={14} /> Retry failed items
          </RetryBtn>
          {/* "Generate XML anyway" + "Report issue" land in Tasks 4–5. */}
        </ActionRow>
```

`new_string`:
```jsx
        <ActionRow>
          <RetryBtn
            type="button"
            onClick={onRetryClick}
            disabled={!onRetryFailed || failedItems.length === 0}
            title={!onRetryFailed ? 'Retry wiring unavailable — see devtools' : undefined}
          >
            <RefreshCw size={14} /> Retry failed items
          </RetryBtn>
          <XmlBtn
            type="button"
            onClick={() => setXmlPanelShown(true)}
            disabled={xmlPanelShown || !exportId || !unifiedManifest}
          >
            <FileText size={14} /> Generate XML anyway
          </XmlBtn>
          {/* "Report issue" stub lands in Task 5. */}
        </ActionRow>
        {xmlPanelShown && (
          <XmlKickoffPanel
            exportId={exportId}
            variantLabels={variantLabels || []}
            unifiedManifest={unifiedManifest}
            complete={complete}
          />
        )}
```

Finally add the `useState` for the panel flag above the `failedItems` computation. Use Edit. `old_string`:
```jsx
  const ok = complete?.ok_count ?? 0
  const fail = complete?.fail_count ?? 0
  const total = ok + fail
  const failedItems = Array.isArray(snapshot?.items)
```

`new_string`:
```jsx
  const [xmlPanelShown, setXmlPanelShown] = useState(false)

  const ok = complete?.ok_count ?? 0
  const fail = complete?.fail_count ?? 0
  const total = ok + fail
  const failedItems = Array.isArray(snapshot?.items)
```

Also remove the `eslint-disable` comments for `exportId` / `variantLabels` / `unifiedManifest` (they're used now). Use Edit. `old_string`:
```jsx
  // Props wired in Tasks 3–4; unused in Task 2 but already accepted
  // so ExportPage's prop-threading edit in Task 6 compiles:
  // eslint-disable-next-line no-unused-vars
  exportId,
  // eslint-disable-next-line no-unused-vars
  variantLabels,
  // eslint-disable-next-line no-unused-vars
  unifiedManifest,
  onRetryFailed,
```

`new_string`:
```jsx
  exportId,
  variantLabels,
  unifiedManifest,
  onRetryFailed,
```

- [ ] **Step 2: Sanity-check the imports + mount**

```bash
npm test 2>&1 | tail -10
# Expected: all green.
```

- [ ] **Step 3: Commit**

```bash
git add src/components/export/StateF_Partial.jsx
git diff --cached --stat
# Expected: 1 file, ~120 lines added, ~6 lines removed.

git commit -m "$(cat <<'EOF'
feat(webapp): StateF_Partial — "Generate XML anyway" via useExportXmlKickoff

Adds a button + conditional child panel that reuses Week 4's
useExportXmlKickoff hook to generate XML with partial placements.
The design spec explicitly documents this mode: missing clips
appear offline (red) in Premiere, user can relink manually.

The hook is mounted inside an optional child component
(XmlKickoffPanel) rather than directly in StateF_Partial so the
hook's state is scoped to the user's explicit opt-in — no orphaned
posting-result/generating state if the user never clicks.
autoKick:false is passed for clarity (the hook's auto-kick is
gated on fail_count===0 anyway); regenerate() fires once on
mount to kick the 3-step flow (write result → generate-xml →
download blobs).

Panel renders the same status UI as StateE_Complete: posting →
generating → per-variant download buttons (plus an error retry
path). Reuses triggerXmlDownload to re-download previously
generated variants (the Week 4 hook keeps xml_by_variant in
component state).

No new XMEML generator features — buildVariantsPayload already
iterates placements agnostic to whether the file was downloaded;
the server's generateXmeml() emits <pathurl>s for all placements;
Premiere handles the offline display.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: "Report issue" stub — disabled button with tooltip

Smallest task. One disabled button. One tooltip. No handler.

**Files:**
- Modify: `$TE/.worktrees/webapp-state-f-partial-ui/src/components/export/StateF_Partial.jsx`

- [ ] **Step 1: Add the Report button**

Use Edit tool. Add below the XmlBtn in the ActionRow. `old_string`:
```jsx
          <XmlBtn
            type="button"
            onClick={() => setXmlPanelShown(true)}
            disabled={xmlPanelShown || !exportId || !unifiedManifest}
          >
            <FileText size={14} /> Generate XML anyway
          </XmlBtn>
          {/* "Report issue" stub lands in Task 5. */}
        </ActionRow>
```

`new_string`:
```jsx
          <XmlBtn
            type="button"
            onClick={() => setXmlPanelShown(true)}
            disabled={xmlPanelShown || !exportId || !unifiedManifest}
          >
            <FileText size={14} /> Generate XML anyway
          </XmlBtn>
          <ReportBtn
            type="button"
            disabled
            title="Coming in Ext.8 — will auto-attach a diagnostic bundle"
          >
            <MessageCircle size={14} /> Report issue
          </ReportBtn>
        </ActionRow>
```

Update the `lucide-react` import to include `MessageCircle`:

Use Edit tool. `old_string`:
```jsx
import { AlertCircle, RefreshCw, FileText, Download } from 'lucide-react'
```

`new_string`:
```jsx
import { AlertCircle, RefreshCw, FileText, Download, MessageCircle } from 'lucide-react'
```

Add the styled `ReportBtn` below the `XmlBtn` declaration. Use Edit. `old_string`:
```jsx
const XmlBtn = styled(RetryBtn)``

const XmlPanel = styled.div`
```

`new_string`:
```jsx
const XmlBtn = styled(RetryBtn)``

const ReportBtn = styled(RetryBtn)`
  color: #6b7280;
`

const XmlPanel = styled.div`
```

- [ ] **Step 2: Sanity-check**

```bash
npm test 2>&1 | tail -10
# Expected: all green.
```

- [ ] **Step 3: Commit**

```bash
git add src/components/export/StateF_Partial.jsx
git diff --cached --stat
# Expected: 1 file, ~12 lines added.

git commit -m "$(cat <<'EOF'
feat(webapp): StateF_Partial — "Report issue" stub (disabled)

Adds a disabled "Report issue" button with a tooltip ("Coming in
Ext.8 — will auto-attach a diagnostic bundle"). Ext.8 will wire
this to the diagnostic-bundle generator (zip of chrome.storage.local
log ring + run manifest + extension version + failed-item details),
WebApp.4 will upload it to support.

Disabled-with-tooltip chosen over mailto: per the plan's open
question #2: a mailto with no bundle is actively worse than
disabled (user writes a useless email with no export_id / runId).
Per-plan recommendation; user may override to mailto — swap to a
<a href="mailto:..."> in a follow-up if requested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: ExportPage FSM glue — swap import + thread props + onRetryFailed

Three surgical edits to `src/pages/ExportPage.jsx`: (1) swap the placeholder import, (2) thread `pipelineId` + `onStart` + `unifiedManifest` down through `ActiveRun` to State F, (3) add an `onRetryFailed` callback that rebuilds the filtered manifest from the preserved `state.unified_manifest` and calls `onStart`. No reducer change. No FSM restructure.

**Files:**
- Modify: `$TE/.worktrees/webapp-state-f-partial-ui/src/pages/ExportPage.jsx`

- [ ] **Step 1: Swap the import**

Use Edit. `old_string`:
```jsx
import StateF_Partial_Placeholder from '../components/export/StateF_Partial_Placeholder.jsx'
```

`new_string`:
```jsx
import StateF_Partial from '../components/export/StateF_Partial.jsx'
```

- [ ] **Step 2: Add the `onRetryFailed` callback in `ExportPage`**

Use Edit. Insert right after the `onStart` useCallback. `old_string` (the `dispatch({ type: 'export_started', ... })` closing of onStart, plus the blank line before the `// Fail-fast on missing pipelineId.` comment):
```jsx
    dispatch({
      type: 'export_started',
      export_id: exportId,
      run_id: maybeResponse?.run_id || null,
      unified_manifest: unifiedManifest,
      variant_labels: variantLabels,
    })
  }, [pipelineId, variant, ext])

  // Fail-fast on missing pipelineId.
```

`new_string`:
```jsx
    dispatch({
      type: 'export_started',
      export_id: exportId,
      run_id: maybeResponse?.run_id || null,
      unified_manifest: unifiedManifest,
      variant_labels: variantLabels,
    })
  }, [pipelineId, variant, ext])

  // Retry failed items — State F button callback. Rebuilds a filtered
  // unified manifest containing only items whose source_item_id is in
  // the failedIds set, then hands off to the existing onStart ceremony
  // (createExport → sendSession → sendExport). onStart's dispatch on
  // success naturally transitions the FSM to state_d.
  //
  // Invariant #5: the filtered manifest is built from
  // state.unified_manifest.items (the authoritative copy from State C),
  // NOT from the Port snapshot (which loses envato_item_url, placements,
  // etc.).
  const onRetryFailed = useCallback(async ({ failedIds }) => {
    if (!state.unified_manifest || !(failedIds instanceof Set) || failedIds.size === 0) return
    const filteredItems = state.unified_manifest.items.filter(
      it => failedIds.has(it.source_item_id)
    )
    if (filteredItems.length === 0) return
    const filteredManifest = {
      ...state.unified_manifest,
      items: filteredItems,
      totals: {
        ...(state.unified_manifest.totals || {}),
        count: filteredItems.length,
      },
    }
    // target_folder and options: reuse the original request's defaults.
    // (State C's onStart passed targetFolder as a display string; we
    // re-send the same string. options.variants stays the same.)
    await onStart({
      unifiedManifest: filteredManifest,
      options: { force_redownload: false, variants: state.variant_labels },
      targetFolder: '~/Downloads/transcript-eval/',  // same default as State C
    })
  }, [state.unified_manifest, state.variant_labels, onStart])

  // Fail-fast on missing pipelineId.
```

- [ ] **Step 3: Thread `onRetryFailed` + existing fields down through `ActiveRun`**

Use Edit. `old_string`:
```jsx
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

`new_string`:
```jsx
  // States D / E / F — live-progress + State E XMEML + State F partial UI.
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
        onRetryFailed={onRetryFailed}
        onComplete={(payload) => dispatch({ type: 'export_completed', payload })}
      />
    )
  }
```

- [ ] **Step 4: Update `ActiveRun` to accept + pass `onRetryFailed`, and swap the State F placeholder use**

Use Edit. `old_string`:
```jsx
function ActiveRun({
  variant, exportId, expectedRunId, phase, completePayload,
  unifiedManifest, variantLabels, onComplete,
}) {
```

`new_string`:
```jsx
function ActiveRun({
  variant, exportId, expectedRunId, phase, completePayload,
  unifiedManifest, variantLabels, onRetryFailed, onComplete,
}) {
```

And `old_string`:
```jsx
  if (phase === 'state_f') {
    return <StateF_Partial_Placeholder complete={completePayload} snapshot={port.snapshot} />
  }
```

`new_string`:
```jsx
  if (phase === 'state_f') {
    return (
      <StateF_Partial
        complete={completePayload}
        snapshot={port.snapshot}
        exportId={exportId}
        variantLabels={variantLabels}
        unifiedManifest={unifiedManifest}
        onRetryFailed={onRetryFailed}
      />
    )
  }
```

- [ ] **Step 5: Delete the placeholder file**

```bash
rm src/components/export/StateF_Partial_Placeholder.jsx
git status --short
# Expected: D src/components/export/StateF_Partial_Placeholder.jsx + M ExportPage.jsx.
```

- [ ] **Step 6: Sanity-check**

```bash
npm test 2>&1 | tail -10
# Expected: all green. `grep -R StateF_Partial_Placeholder src/` should return
# zero matches now. Confirm:
grep -R StateF_Partial_Placeholder src/ && echo "LEFTOVER — fix" || echo "Clean — no placeholder references"
# Expected: Clean.

# Also confirm the component FSM still routes state_f correctly by re-reading
# the decision code:
grep -n "state_f" src/pages/ExportPage.jsx
# Expected: reducer line ~41 (fail > 0 ? 'state_f' : 'state_e'), ActiveRun
# routing line ~262, phase check line ~307.
```

- [ ] **Step 7: Commit**

```bash
git add src/pages/ExportPage.jsx src/components/export/StateF_Partial_Placeholder.jsx
git diff --cached --stat
# Expected: 2 files — 1 modified (ExportPage.jsx +~35 lines), 1 deleted
# (StateF_Partial_Placeholder.jsx -92 lines).

git commit -m "$(cat <<'EOF'
feat(webapp): ExportPage — thread onRetryFailed to real State F

Three surgical edits to wire up the real State F component:

  1. Swap StateF_Partial_Placeholder.jsx import for the new
     StateF_Partial.jsx (Tasks 2–5 of this plan).
  2. Add an onRetryFailed callback that rebuilds a filtered unified
     manifest from state.unified_manifest.items using the failedIds
     set handed up from State F, then calls onStart. The existing
     onStart ceremony (createExport → sendSession → sendExport) does
     the rest; the FSM naturally transitions to state_d via
     export_started. No new reducer action; no FSM restructure.
  3. Thread onRetryFailed + exportId + variantLabels + unifiedManifest
     down through ActiveRun to StateF_Partial.

Deletes the StateF_Partial_Placeholder.jsx stub — after this
commit, grep -R _Placeholder src/ returns zero matches.

Invariant #5: the filtered manifest is built from the authoritative
state.unified_manifest (kept in reducer state since State C via the
export_started action), NOT from the Port snapshot. The snapshot's
items are the wire view and lose envato_item_url, full placements,
variants list — all of which the extension's resolver needs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Component test for StateF_Partial

Covers the four observable behaviors: (a) failed-items list renders with human-readable labels; (b) Retry button calls onRetryFailed with filtered IDs; (c) Generate XML anyway mounts the kickoff panel and fires the hook's regenerate; (d) Report issue button is disabled.

**Files:**
- Create: `$TE/.worktrees/webapp-state-f-partial-ui/src/components/export/__tests__/StateF_Partial.test.jsx`

- [ ] **Step 1: Read the existing hook test for the `createRoot` + `React.act` convention**

Use the Read tool on `src/hooks/__tests__/useExportXmlKickoff.test.js` lines 1–80 (done during investigation — confirms the pattern: no Testing Library, bare `createRoot`, `IS_REACT_ACT_ENVIRONMENT = true` global, `React.act` for rendering).

- [ ] **Step 2: Write the test file**

Use Write tool. Path: `src/components/export/__tests__/StateF_Partial.test.jsx`.

```jsx
// src/components/export/__tests__/StateF_Partial.test.jsx
//
// Component test for State F. Environment: happy-dom (web project in
// vitest.workspace.js). Uses bare createRoot + React.act — no Testing
// Library dependency per the Week 4 State E plan's convention.
//
// Covers:
//   - Failed-items list renders with human-readable labels.
//   - Retry button calls onRetryFailed with the set of failed
//     source_item_ids.
//   - "Generate XML anyway" mounts the kickoff panel (verified by
//     the hook's _apiPost test-seam being called).
//   - "Report issue" button is disabled.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Mock the useExportXmlKickoff module — we want the hook to be a
// no-op spy in this test so we can assert the XML panel mounts and
// calls regenerate() without actually posting. We do this with vi.mock
// at the top of the file.
vi.mock('../../../hooks/useExportXmlKickoff.js', async () => {
  const regenerate = vi.fn()
  return {
    useExportXmlKickoff: () => ({
      status: 'idle',
      xml_by_variant: null,
      error: null,
      regenerate,
    }),
    triggerXmlDownload: vi.fn(),
    __mockRegenerate: regenerate,  // test handle
  }
})

// Import after the mock is declared.
import StateF_Partial from '../StateF_Partial.jsx'
import * as xmlKickoffModule from '../../../hooks/useExportXmlKickoff.js'

// -------------------- Fixtures --------------------

function makeComplete() {
  return {
    ok_count: 2,
    fail_count: 3,
    folder_path: '~/Downloads/transcript-eval/',
    xml_paths: [],
  }
}

function makeSnapshot() {
  return {
    items: [
      { seq: 1, source: 'envato', source_item_id: 'OK1', target_filename: '001_envato_OK1.mov', phase: 'done' },
      { seq: 2, source: 'envato', source_item_id: 'FAIL1', target_filename: '002_envato_FAIL1.mov', phase: 'failed', error_code: 'envato_session_401' },
      { seq: 3, source: 'pexels', source_item_id: 'FAIL2', target_filename: '003_pexels_FAIL2.mp4', phase: 'failed', error_code: 'pexels_404' },
      { seq: 4, source: 'envato', source_item_id: 'OK2', target_filename: '004_envato_OK2.mov', phase: 'done' },
      { seq: 5, source: 'freepik', source_item_id: 'FAIL3', target_filename: '005_freepik_FAIL3.mp4', phase: 'failed', error_code: 'freepik_404' },
    ],
  }
}

function makeUnifiedManifest() {
  return {
    variants: ['A'],
    totals: { count: 5, est_size_bytes: 500_000_000 },
    options: { force_redownload: false },
    items: [
      { seq: 2, source: 'envato', source_item_id: 'FAIL1', target_filename: '002_envato_FAIL1.mov', envato_item_url: 'https://...', placements: [{variant:'A',timeline_start_s:0,timeline_duration_s:2}] },
      // ...
    ],
  }
}

// -------------------- Mount helper --------------------

async function mount(props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(StateF_Partial, props))
  })
  return { container, root, unmount: () => {
    act(() => root.unmount())
    document.body.removeChild(container)
  }}
}

// -------------------- Tests --------------------

describe('StateF_Partial — failed items list', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('renders 3 failed rows with human-readable labels', async () => {
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: makeSnapshot(),
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    // Three failed items → three <li> rows.
    const rows = container.querySelectorAll('li')
    expect(rows.length).toBe(3)
    // Labels from errorCodeLabels.js (envato_session_401, pexels_404, freepik_404).
    const text = container.textContent
    expect(text).toMatch(/Envato session expired/i)
    expect(text).toMatch(/Pexels item not found/i)
    expect(text).toMatch(/Freepik item not found/i)
    // Summary line: 2 / 5 clips downloaded · 3 failed.
    expect(text).toMatch(/2 \/ 5/)
    expect(text).toMatch(/3 failed/)
    unmount()
  })

  it('shows fallback text when snapshot items are missing', async () => {
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: null,
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    expect(container.textContent).toMatch(/did not include a per-item list/i)
    unmount()
  })
})

describe('StateF_Partial — Retry button', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('calls onRetryFailed with the failed source_item_ids', async () => {
    const onRetryFailed = vi.fn()
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: makeSnapshot(),
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed,
    })
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      b => /retry failed items/i.test(b.textContent)
    )
    expect(retryBtn).toBeDefined()
    expect(retryBtn.disabled).toBe(false)
    await act(async () => { retryBtn.click() })
    expect(onRetryFailed).toHaveBeenCalledTimes(1)
    const call = onRetryFailed.mock.calls[0][0]
    expect(call.failedIds).toBeInstanceOf(Set)
    expect([...call.failedIds]).toEqual(expect.arrayContaining(['FAIL1', 'FAIL2', 'FAIL3']))
    expect(call.failedIds.size).toBe(3)
    unmount()
  })

  it('is disabled when no failed items', async () => {
    const { container, unmount } = await mount({
      complete: { ok_count: 5, fail_count: 0, folder_path: 'x', xml_paths: [] },
      snapshot: { items: [] },
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      b => /retry failed items/i.test(b.textContent)
    )
    expect(retryBtn.disabled).toBe(true)
    unmount()
  })
})

describe('StateF_Partial — Generate XML anyway', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('mounts the XML panel and calls regenerate() on click', async () => {
    const { __mockRegenerate } = xmlKickoffModule
    __mockRegenerate.mockClear()
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: makeSnapshot(),
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    const xmlBtn = Array.from(container.querySelectorAll('button')).find(
      b => /generate xml anyway/i.test(b.textContent)
    )
    expect(xmlBtn).toBeDefined()
    expect(xmlBtn.disabled).toBe(false)
    await act(async () => { xmlBtn.click() })
    // After click: regenerate called via the XmlKickoffPanel's mount effect.
    expect(__mockRegenerate).toHaveBeenCalled()
    // Button is now disabled (xmlPanelShown === true).
    expect(xmlBtn.disabled).toBe(true)
    unmount()
  })
})

describe('StateF_Partial — Report issue', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('is disabled with a tooltip referencing Ext.8', async () => {
    const { container, unmount } = await mount({
      complete: makeComplete(),
      snapshot: makeSnapshot(),
      exportId: 'exp_01J_TEST',
      variantLabels: ['A'],
      unifiedManifest: makeUnifiedManifest(),
      onRetryFailed: vi.fn(),
    })
    const reportBtn = Array.from(container.querySelectorAll('button')).find(
      b => /report issue/i.test(b.textContent)
    )
    expect(reportBtn).toBeDefined()
    expect(reportBtn.disabled).toBe(true)
    expect(reportBtn.getAttribute('title')).toMatch(/ext\.8/i)
    unmount()
  })
})
```

- [ ] **Step 3: Run tests**

```bash
npm test 2>&1 | tail -20
# Expected: all projects green. The `web` project picks up the new test file;
# test count should jump by ~7 tests. If any fail, diagnose before committing
# (common culprits: mock path typo, happy-dom event quirk on .click).
```

- [ ] **Step 4: Commit**

```bash
git add src/components/export/__tests__/StateF_Partial.test.jsx
git diff --cached --stat
# Expected: 1 new file, ~180 lines.

git commit -m "$(cat <<'EOF'
test(webapp): StateF_Partial — component test covering 4 behaviors

Uses bare createRoot + React.act per the Week 4 State E plan's
"no Testing Library" convention. Asserts:

  1. Failed-items list renders 3 rows from the mock snapshot with
     human-readable labels from errorCodeLabels.js (envato_session_401
     → "Envato session expired — sign in again", etc.).
  2. Retry button calls onRetryFailed({failedIds: Set}) containing
     exactly the 3 failed source_item_ids. Disabled when zero failures.
  3. "Generate XML anyway" mounts the XmlKickoffPanel child; the
     child's mount effect fires the hook's regenerate() (verified via
     a vi.mock'd useExportXmlKickoff module that exposes a spy on
     regenerate). Button disables after click (xmlPanelShown flag).
  4. "Report issue" button is disabled with a title referencing Ext.8.

No network calls hit the real hook — the module is mocked at the
top of the file. No chrome.runtime references — StateF is a pure
read of props + a callback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update `src/components/export/README.md`

Small doc update: drop "placeholder; real UI in next plan" for State F, add a "Partial-failure UI" paragraph describing the retry + generate-anyway + report-issue surface.

**Files:**
- Modify: `$TE/.worktrees/webapp-state-f-partial-ui/src/components/export/README.md`

- [ ] **Step 1: Read the current README** to see the exact "Phase B additions" table text that needs the update.

- [ ] **Step 2: Apply the edits**

Use Edit tool. First edit — the States E/F table row. `old_string`:
```markdown
| **F** | extension reports `{type:"complete"}` with `fail_count > 0` | `StateF_Partial_Placeholder.jsx` | placeholder; real UI in next plan |
```

`new_string`:
```markdown
| **F** | extension reports `{type:"complete"}` with `fail_count > 0` | `StateF_Partial.jsx` | partial-failure UI (per-failure list, retry, XML-anyway, report stub) |
```

Second edit — the "State E/F are placeholders" paragraph. `old_string`:
```markdown
### State E/F are placeholders

Both components render raw dumps of the completion fields with a visible blue dashed banner. The real UI (open-folder button, XML download links, "How to import in Premiere" tutorial, per-failure diagnostics, retry) ships in the next webapp plan (Phase C / State E+F).
```

`new_string`:
```markdown
### State E/F

- **State E** (`StateE_Complete.jsx`) — Week 4 WebApp.1 State E plan. Auto-runs `useExportXmlKickoff` on mount, downloads per-variant XML blobs, shows the folder path and a short Premiere import tutorial.
- **State F** (`StateF_Partial.jsx`) — this plan (WebApp.1 State F). Renders the partial-failure UI:
  - Amber "Export partial" header + summary (`N / M clips downloaded · K failed`).
  - Per-failure list: filename + source chip + human-readable reason from `src/lib/errorCodeLabels.js` (maps the 15-code `error_code` enum from `extension/modules/telemetry.js` to user-facing strings).
  - **"Retry failed items"** — rebuilds a filtered `unified_manifest` from the preserved `state.unified_manifest.items` (ExportPage reducer), calls the existing `onStart` ceremony (`createExport` → `sendSession` → `sendExport`), FSM transitions back to `state_d`. The extension's `finalize()` already releases the lock via `clearActiveRunId()` (queue.js:584), so a second `{type:"export"}` passes the `run_already_active` check.
  - **"Generate XML anyway"** — mounts a child `XmlKickoffPanel` that calls `useExportXmlKickoff({autoKick:false, ...}).regenerate()` once on mount. The Week 4 hook already handles partial placements gracefully; missing clips appear offline (red) in Premiere per the design spec.
  - **"Report issue"** — disabled stub with a "Coming in Ext.8" tooltip. Ext.8 will auto-attach the diagnostic bundle.
```

- [ ] **Step 3: Commit**

```bash
git add src/components/export/README.md
git diff --cached --stat
# Expected: 1 file modified.

git commit -m "$(cat <<'EOF'
docs(webapp): README — State F is the real UI, not a placeholder

Updates src/components/export/README.md for the State F landing:

  - Replaces the State F table row's "placeholder; real UI in next
    plan" note with a description of the real component.
  - Rewrites the "State E/F are placeholders" paragraph to reflect
    that both states now ship real UI — State E from Week 4, State
    F from this plan. Adds short bullets for State F's three
    action buttons (Retry, XML-anyway, Report-issue stub) and
    explains the reused onStart ceremony for retry plus the
    finalize() → clearActiveRunId() invariant that makes a
    retry-without-relock work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final Task: Manual smoke (no commit)

End-to-end verification against a real extension run. Produces no commit — the goal is to observe State F rendering correctly and the two real actions (retry, generate-anyway) working against a live backend + extension.

**Do NOT push. Do NOT create a commit during this task.**

- [ ] **Step 1: Confirm the backend and frontend dev servers are running**

```bash
# Backend on :3001 (user's — do NOT kill or restart it).
curl -s http://localhost:3001/api/health | head
# Expected: some OK/healthy response. If not, the user needs to start it.

# Frontend: start the Vite dev server in the worktree.
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/webapp-state-f-partial-ui"
npm run dev:client
# Expected: Vite boots on :5173. Leave this running.
```

- [ ] **Step 2: Load the unpacked extension in Chrome**

Chrome → chrome://extensions → Developer mode ON → Load unpacked → select `/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/webapp-state-f-partial-ui/extension/`. Confirm the extension ID matches the pinned key (see `extension/.extension-id`). If a stale version is loaded from a prior worktree, click "Reload" on that extension card.

- [ ] **Step 3: Craft a manifest with at least one known-bad item**

The simplest repro: find an existing broll pipeline with Pexels items and ensure at least one has a `source_item_id` that is guaranteed to 404 (e.g. "99999999999" — confirm by `curl -s "https://api.pexels.com/videos/videos/99999999999"` returns 404; see `server/services/pexels.js` for the exact endpoint). Edit the pipeline's plan JSON in the SQL console OR craft a test payload via the backend admin tools.

Alternative: use the extension test harness (`extension-test.html`) with a hand-authored 3-item fixture: 1 good Pexels, 1 good Envato, 1 bad Pexels. Verify the harness supports this fixture shape; if not, fall back to the real pipeline edit.

- [ ] **Step 4: Kick an export run from the editor**

Navigate to `/editor/<pipeline_id>/brolls/edit` in the dev app → "Export" button. Follow the preflight through State C → click "Start Export." Observe:
- State D renders during the run.
- Terminal `{type:"complete"}` arrives with `fail_count >= 1`.
- FSM transitions to `state_f`.
- State F renders the amber card with the header "Export partial," the summary "N / M clips downloaded · K failed," and a per-row list where the bad item has a recognizable human label (e.g. "Pexels item not found (removed or invalid)").

- [ ] **Step 5: Click "Retry failed items"**

Observe:
- The page re-renders into `state_d` with a new `export_id` (confirm by checking Network → `POST /api/exports` returns a new ID).
- The extension accepts the new `{type:"export"}` without `run_already_active`.
- The second run contains only the previously-failed item(s) — its progress bar shows 1-of-1 (or however many were failing).

- [ ] **Step 6: Observe "Generate XML anyway" (run the original State F in a second tab)**

Open a second Chrome tab at `/editor/<pipeline_id>/export?variant=A` — since the pipeline has an existing partial run on the `exports` row, the FSM must surface State F via reconnect. (This is the tab-reopen path tested in `useExportPort`.) Click "Generate XML anyway" in the second tab's State F. Observe:
- The XmlKickoffPanel mounts.
- Network: `POST /api/exports/<id>/result` succeeds (200).
- Network: `POST /api/exports/<id>/generate-xml` succeeds (200) with `xml_by_variant`.
- Browser auto-downloads `variant-a.xml`.
- Opening the XML in Premiere shows the run's successful clips in the sequence AND the failed-item clips as offline (red) placeholders.

- [ ] **Step 7: "Report issue" button**

Hover the button — confirm the tooltip says "Coming in Ext.8 — will auto-attach a diagnostic bundle." Button is disabled; no action on click.

- [ ] **Step 8: Final checklist**

- [ ] Failed-items list matches the bad item's `source_item_id`.
- [ ] Retry produced a fresh `exports` row (check `SELECT id, plan_pipeline_id, status, created_at FROM exports ORDER BY created_at DESC LIMIT 5;` via your local SQLite/Postgres).
- [ ] XML-anyway generated an XML file that opened in Premiere.
- [ ] Report-issue button is disabled with the expected tooltip.
- [ ] No console errors in the browser devtools during any of the above.
- [ ] No commits created during this task. `git log --oneline main..HEAD` shows exactly the 8 commits from Tasks 0–8.
- [ ] Backend on port 3001 was NOT killed or restarted.
- [ ] The user's dirty tree files (listed in "Working conventions") did NOT appear in any of this branch's diffs.

If every checkbox passes, the plan is complete. Do NOT merge to main, do NOT push, do NOT create a PR — the user handles that. Stop here.
