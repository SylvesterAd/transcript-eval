# B-Roll Export — Remaining Work Roadmap

**Date:** 2026-04-24
**Status:** Authoritative roadmap for everything still to ship on the b-roll export feature.

## Status snapshot

| Project | Branch | Commits | State |
|---|---|---|---|
| transcript-eval backend **Phase 1** | `feature/envato-export-phase1` | 13 | Complete, reviewed, unmerged |
| adpunk.ssh **broll candidate pipeline** | `feature/broll-candidate-pipeline` | 47 | Complete (8 phases, 45 tasks), unmerged, passes stress test |
| Chrome Extension **Ext.1** | `feature/extension-ext1` | 15 | Complete (9 tasks), unmerged, MV3 skeleton loads |

Everything above is additive to `main`/`master`. User is keeping branches local until all pieces align, then will merge as a coordinated drop.

## What this doc covers

Everything NOT yet built that the export feature needs to reach production:

1. **Backend Phase 1.5** — `/api/ext-config` endpoint.
2. **Web app: export page** — `/editor/:id/export` UI with pre-flight + in-progress states.
3. **Web app: XMEML generator** — `server/services/xmeml-generator.js`.
4. **Extension Ext.2 → Ext.12** — 11 remaining extension phases.
5. **Web app: Admin observability UI** — per main spec's Phase 9.
6. **Web app: Support diagnostics UI** — per main spec's Phase 10.

It does NOT cover:
- Anything already shipped on the 3 branches above.
- Stage 1-3 scraper work (lives in adpunk.ssh, already shipped on `feature/broll-candidate-pipeline`).
- Non-goals from the main spec (Safari, Firefox, XMEML → CapCut, Adobe Stock, bundled subscriptions, etc.).

## Companion docs

Read before starting any phase below:

- `docs/specs/2026-04-23-envato-export-design.md` — master spec, still the source of truth for UX screens and error semantics.
- `docs/specs/2026-04-23-envato-export-extension.md` — extension spec (all 12 phases, committed on `feature/extension-ext1`).
- `docs/superpowers/plans/2026-04-23-envato-export-phase1.md` — Phase 1 backend plan (committed on `feature/envato-export-phase1`).
- `docs/superpowers/plans/2026-04-23-envato-export-extension-ext1.md` — Ext.1 plan (committed on `feature/extension-ext1`).
- Adpunk.ssh spec + plan: `Adpunk.Ssh/docs/superpowers/{specs,plans}/2026-04-23-broll-candidate-pipeline.md`.

## Dependency graph

```
     ┌──────────────────── Phase 1 backend (done) ────────────────────┐
     │                                                                 │
     ▼                                                                 ▼
Backend Phase 1.5                                       Web App: Export Page
(api/ext-config)                                        (states A–F)
     │                                                           │
     │                                                           ▼
     │                                                 Web App: XMEML Generator
     │                                                           │
     │                                                           │
     └─ Ext.2 (Envato) ─ Ext.3 (Pexels/Freepik) ─ Ext.4 (auth)   │
                             │                          │        │
                             ▼                          ▼        │
                        Ext.5 (queue + persistence) ◄────────────┘
                             │
                             ▼
                        Ext.6 (telemetry) ─ writes to /api/export-events (ready)
                             │
                             ▼
                        Ext.7 (failure polish)
                             │
                             ▼
                        Ext.8 (diagnostics + privacy)
                             │
                             ▼
                        Ext.9 (consumes Backend 1.5)
                             │
                             ▼
                        Ext.10 (cross-browser + CI)
                             │
                             ▼
                        Ext.11 (Chrome Web Store beta)
                             │
                             ▼
                        Ext.12 (soft launch → GA)

Independent (can slot in anywhere):
   - Web App: Admin Observability UI (main spec Phase 9)
   - Web App: Support Diagnostics UI (main spec Phase 10)
```

**Critical path** to user-facing export: Backend 1.5 → Export page + XMEML → Ext.2 → Ext.3 → Ext.4 → Ext.5 → Ext.6 → (private test).

Everything after Ext.6 is polish, hardening, rollout.

---

## Part A — Backend Phase 1.5

One small backend slice so the extension can version-gate and be killswitched in production.

### Backend 1.5 — `GET /api/ext-config`

**Goal:** Return a JSON config the extension fetches at service-worker start + before each export. Lets us turn off features without republishing the extension.

**Depends on:** Nothing — slots into Phase 1 backend cleanly.

**Response shape (already specified in extension spec):**
```json
{
  "min_ext_version":      "0.1.0",
  "export_enabled":       true,
  "envato_enabled":       true,
  "pexels_enabled":       true,
  "freepik_enabled":      false,
  "daily_cap_override":   null,
  "slack_alerts_enabled": true
}
```

**Files:**
- `server/routes/ext-config.js` — new, single GET handler. Public (no auth — the extension hits it before JWT mint).
- `server/services/ext-config.js` — new, returns the config object. Reads from env vars initially; can evolve to read from a DB table or Supabase remote config later.
- `server/index.js` — wire mount.
- `server/schema-pg.sql` + `server/db.js` — optional, only if we want env-var overrides via DB. Defer until an actual need surfaces.

**Key decisions:**
- No auth — this endpoint is called before the JWT mint. A malicious actor learns we have flags; not sensitive.
- Cache-Control: `public, max-age=60` so the SW doesn't hammer us; 60s turn-around on flag changes is acceptable.
- `min_ext_version` is a string compared via the `semver` npm package (small dep; justified). Extension declares its own version in manifest.json.

**Verification:**
- Curl with no auth → 200 + expected JSON.
- Change an env var (e.g. `EXT_FREEPIK_ENABLED=false`), restart, curl again → flipped.

**Estimate:** 1 PR, half a day.

**Target branch:** `feature/envato-export-phase1-5-ext-config`, branched off `feature/envato-export-phase1` if Phase 1 hasn't merged yet, otherwise off main.

---

## Part B — Web App Integration

Two pieces, both in the transcript-eval React app + Express backend. Neither requires extension work to start; both must exist before a user-facing end-to-end demo.

### WebApp.1 — Export page UI (`/editor/:id/export`)

**Goal:** The React page that lives between "click Export in the editor" and "extension starts downloading." States A–F per main spec.

**Depends on:** Phase 1 backend (done). Can progress in parallel with Ext.2+.

**States to render:**
- A — Extension not installed. Polling every 2s via `chrome.runtime.sendMessage(EXT_ID, {type: "ping"})`.
- B — Extension installed but Envato session missing/expired.
- C — Preconditions met, manifest summary + "Start Export" button.
- D — Export running (progress bar, per-item status, pause/cancel).
- E — Complete (folder path, XML links, "How to import in Premiere" link).
- F — Complete with failures (per-failure diagnostics, retry options).

**Files (rough — expect 15-25 files for the page + supporting hooks):**
- `src/pages/ExportPage.jsx` — main page; state machine for A-F.
- `src/hooks/useExtension.js` — `sendMessage`, `connect` Port, state subscriptions.
- `src/hooks/useExportPreflight.js` — disk space via `navigator.storage.estimate()`, extension ping, session probe.
- `src/components/export/StateA_Install.jsx`, `StateB_Session.jsx`, etc.
- `src/lib/buildManifest.js` — reads `broll_searches.results_json` (via an existing or new web-app endpoint), transforms to extension manifest shape.
- `server/routes/export.js` — a small web-facing shim: `GET /api/broll-searches/:pipelineId/manifest` returns the pre-built manifest array. Reads from `broll_searches.results_json`.

**Key decisions:**
- Extension ID pinned in a shared config file between extension + web app. Ext.1 committed `extension/.extension-id` — web app should read this at build time.
- "Target folder" selection: main spec says File System Access API optional. For MVP, default to `~/Downloads/transcript-eval/export-<id>-<variant>/` with no picker; add picker in a later PR. Safer given FSA API permissioning variability.
- Multi-variant export checkbox — visible per main spec Figure C.
- Multi-browser detection — non-Chrome browsers see a "Requires Chrome" banner with download link.

**Verification:**
- Manual: click Export from a real editor session, watch states transition A→B→C→D→E.
- Backend: Puppeteer end-to-end test that drives the page through all 6 states using a real dev-loaded extension.

**Estimate:** 4–6 PRs (roughly one per state). 1 week of engineering.

**Target branch:** `feature/export-page` (single branch) OR `feature/export-page-state-a` etc. for granular merges.

### WebApp.2 — XMEML generator

**Goal:** Pure function that produces Premiere-compatible XMEML (FCP7 XML) given variant placement data + filenames. Called by the web app **after** the extension signals completion.

**Depends on:** Main spec has the full XML template + algorithm.

**Files:**
- `server/services/xmeml-generator.js` — single ~300-LOC pure function `generateXmeml({sequenceName, placements, frameRate, sequenceSize}) → xmlString`.
- `server/services/__tests__/xmeml-generator.test.js` — if we add vitest at this point (project has no test framework yet, may be time to introduce one for pure utilities). Alternatively, golden-file comparison via a smoke script.
- `server/routes/export-xml.js` — POST endpoint: `POST /api/exports/:id/generate-xml` returns the XML string per variant. The web app caches these to disk via File System Access API after extension signals complete.

**Key decisions:**
- Greedy interval scheduling for overlapping placements (spec has the algorithm).
- Default 1920×1080 / 30fps when metadata missing — Premiere re-reads real metadata at import anyway.
- No UTF-8 titles in filenames (ASCII-only); path length cap at 240 chars.
- Deterministic output — same inputs always produce same XML.

**Verification:**
- Unit tests on the pure function (multi-variant, overlapping clips, missing metadata).
- Manual: generate XML for a small variant, open in Premiere, confirm clips land at exact timeline positions.

**Estimate:** 1 PR, 1–2 days.

**Target branch:** `feature/xmeml-generator`, can merge independently.

---

## Part C — Extension Ext.2 → Ext.12

Each phase is one "Ext.N plan" produced via `superpowers:writing-plans` at start-of-phase, then executed via `superpowers:subagent-driven-development`. Below is the **scope** of each phase — detailed implementation plans are downstream deliverables.

### Ext.2 — Envato single item

**Goal:** End-to-end download of ONE Envato item via the 3-phase flow (resolve → license → download). No queue, no concurrency — just prove the pipeline.

**Depends on:** Ext.1 (MV3 + JWT) ✅, real Envato account with active subscription.

**Files:**
- `extension/modules/envato.js` — `resolveOldIdToNewUuid(oldUrl)`, `getSignedDownloadUrl(newUuid)`, `downloadWithChromeApi(url, filename)`.
- `extension/service_worker.js` — add `{type:"debug_envato_one_shot"}` handler for dev; not user-facing yet.
- `extension/fixtures/envato/*.json` — captured HAR snippets for mock mode.
- `extension/modules/envato.test.js` or golden-file smoke — optional; defer unless test harness is adopted.

**Key decisions:**
- Tab-based resolver: open hidden tab at `elements.envato.com/...`, watch `chrome.webNavigation.onCommitted` for redirect to `app.envato.com/<uuid>`, capture UUID, close tab. Concurrency cap: 1 at Ext.2 (raise to 5 at Ext.5).
- No deny-list yet (Ext.7).
- No JIT URL refetching yet (Ext.5).
- `.zip`/`.aep`/`.prproj` filetype safety net IS added here — cheap, prevents license waste on a single test download.

**Verification:**
- Manual: load extension, send `{type:"debug_envato_one_shot", item_id:"NX9WYGQ", envato_item_url:"..."}`, see a file appear in `~/Downloads/transcript-eval/` named `envato_<id>.mov`, playable in VLC.
- Observe in `chrome://extensions` service worker logs: 3 phase lines.

**Estimate:** 1 PR, 2–3 days.

### Ext.3 — Pexels + Freepik single item

**Goal:** Add the server-proxied download flow. Same prove-one-item shape as Ext.2.

**Depends on:** Ext.2 (reuses download plumbing). Phase 1 backend `/api/pexels-url` + `/api/freepik-url` ✅.

**Files:**
- `extension/modules/sources.js` — `downloadPexels(itemId)`, `downloadFreepik(itemId)` calling backend + `chrome.downloads.download`.
- `extension/service_worker.js` — add `{type:"debug_source_one_shot", source, item_id}` dev handler.
- Error handling for `freepik_unconfigured` (503 from backend — treat as fatal for that item).

**Key decisions:**
- Freepik URL TTL: use the `expires_at` from backend response; if file not started within 60s of mint, refetch. No parsing of the `exp=...` token yet.
- No dedupe per run (Ext.5).
- Dev handler emits `item_downloaded` or `item_failed` events via a stub telemetry module (real telemetry in Ext.6).

**Verification:**
- Manual: one Pexels ID + one Freepik ID (when `FREEPIK_API_KEY` is configured; mock Freepik via fixture otherwise).
- File appears with the correct `{source}_{id}.mp4` name.

**Estimate:** 1 PR, 1–2 days.

### Ext.4 — Auth polish

**Goal:** 401 recovery, Envato cookie watcher, popup sign-in flows. This is the glue that makes the extension feel reliable across session boundaries.

**Depends on:** Ext.2 / Ext.3 (auth failures observable).

**Files:**
- `extension/modules/auth.js` — expand: add `refreshSessionViaPort()`, `handle401(endpoint)`, Envato cookie watcher (`chrome.cookies.onChanged`).
- `extension/popup.js` — add click handlers for both sign-in rows; open `https://app.envato.com/sign-in` + `https://transcript-eval.com/editor` respectively.
- `extension/service_worker.js` — register Port handler (long-lived `chrome.runtime.onConnectExternal`). First real use of Port.

**Key decisions:**
- Envato cookie check: watch `envato_client_id` and `elements.session.5` on `.envato.com`. Pre-flight before each run with one GET to `download.data`.
- 401 handling: pause queue, post `{type:"refresh_session"}` on Port, wait 10s for a new token, resume on success; surface popup banner on failure.

**Verification:**
- Manual: expire session by clearing Envato cookies mid-run, observe pause + popup prompt.
- Manual: let JWT expire (or artificially shorten TTL for a test), observe automatic refresh via Port.

**Estimate:** 1 PR, 2 days.

### Ext.5 — Queue + concurrency + persistence

**Goal:** The real queue. 5-resolver, 3-downloader caps; pause/resume/cancel; `chrome.storage.local` state; SW-wake resume; `chrome.power.requestKeepAwake`.

**Depends on:** Ext.2 (resolver) + Ext.3 (sources) + Ext.4 (auth).

**Files:**
- `extension/modules/queue.js` — the queue state machine. State persisted after each transition.
- `extension/modules/storage.js` — `chrome.storage.local` wrappers for `run:<export_id>`, `completed_items`, `deny_list`, `active_run_id`, daily counts.
- `extension/service_worker.js` — add `{type:"export"}`, `{type:"pause"}`, `{type:"resume"}`, `{type:"cancel"}` handlers. Port pushes `state` messages on every transition.
- `extension/modules/envato.js` — promote concurrency from 1 to 5 for Phase 1.
- `extension/modules/sources.js` — promote concurrency from 1 to 3 for Phase 2-3.

**Key decisions:**
- Single active run per user. Second `{type:"export"}` → `{type:"error", reason:"run_already_active"}`.
- `chrome.downloads.resume()` for NETWORK_* interrupts up to 3 times.
- JIT URL fetching — each worker fetches URL immediately before download starts (don't batch at run start).

**Verification:**
- Manual: 50-item manifest, force-close Chrome halfway, reopen, confirm resume.
- Manual: pause mid-download, observe in-flight continues but no new pulls; resume picks up.

**Estimate:** 2 PRs (queue machinery + resume/persistence). 3–4 days.

### Ext.6 — Telemetry

**Goal:** Wire every state transition to `POST /api/export-events`. Offline queue + retry.

**Depends on:** Ext.5 (queue state is what telemetry reports on).

**Files:**
- `extension/modules/telemetry.js` — `emit(event, payload)`, in-memory buffer, `chrome.storage.local` overflow queue, exponential-backoff retry, 500-event cap with oldest-drop.
- `extension/modules/queue.js` — call `telemetry.emit()` at each transition (10 event types mapped in extension spec).
- `extension/modules/auth.js` — attach Bearer JWT to telemetry POSTs.

**Key decisions:**
- `export_started` / `export_completed` carry meaningful `meta` (ok/fail counts, wall seconds, total bytes).
- `item_failed` MUST carry `error_code` from the fixed enum (15 codes in extension spec).
- If `/api/export-events` 401s, telemetry queue holds events until JWT refresh completes.

**Verification:**
- Manual: complete a run, query `export_events` table, observe full event chronology.
- Manual: disconnect network, complete run offline, reconnect, observe queued events flush.

**Estimate:** 1 PR, 1–2 days.

### Ext.7 — Failure-mode polish

**Goal:** Per-error retry/skip/hard-stop semantics from the extension spec's failure matrix. Deny-list for `envato_unsupported_filetype`. Partial-run handling.

**Depends on:** Ext.5 (queue) + Ext.6 (telemetry to observe behavior).

**Files:**
- `extension/modules/queue.js` — per-error branching (spec's 17-row matrix).
- `extension/modules/storage.js` — `deny_list` management; 24h-dedupe on Slack alerts per item.
- `extension/modules/sources.js` — URL-refetch-on-expiry for Freepik.
- `extension/modules/envato.js` — tier-restricted item (402/403 with "upgrade") handling — skip without hard-stop.

**Key decisions:**
- Hard-stop on `envato_403` (non-tier), `disk_failed`. Skip-and-continue on everything else.
- Partial-run XML generation: extension emits `export_completed` even on failure; backend derives status from `ok_count`/`fail_count` (already wired Phase 1).

**Verification:**
- Manual: craft a manifest with one known-deny-listed item, one known-404 Pexels, one good item. Observe: 1 hard-stop + 1 skip + 1 success, `status: partial` in DB.

**Estimate:** 1 PR, 2–3 days.

### Ext.8 — Diagnostics + privacy

**Goal:** One-click diagnostic bundle download + opt-out switch for telemetry.

**Depends on:** Ext.6 (telemetry is what we opt out of).

**Files:**
- `extension/modules/diagnostics.js` — bundle ZIP: recent queue state, last 200 events, browser/OS strings, redacted cookie booleans.
- `extension/popup.html` + `popup.js` — "Export diagnostic bundle" button, "Send diagnostic events" toggle (default on).
- `extension/modules/telemetry.js` — honor opt-out: if off, no POSTs, queue events drop.

**Key decisions:**
- Bundle NEVER includes: cookie values, JWT tokens, absolute file paths, video titles, user email.
- Bundle filenames have timestamps to avoid overwrite.
- Opt-out is persisted in `chrome.storage.local`.

**Verification:**
- Manual: generate bundle, unzip, grep for `eyJ` (JWT prefix) / cookie values / absolute paths → zero matches.

**Estimate:** 1 PR, 1 day.

### Ext.9 — Feature flag fetch

**Goal:** Consume Backend 1.5's `/api/ext-config`. Min-version gate + source killswitches.

**Depends on:** Backend 1.5.

**Files:**
- `extension/modules/config-fetch.js` — fetch `/api/ext-config` on SW startup + before each export; cache in `chrome.storage.local` with 60s TTL.
- `extension/service_worker.js` — on `{type:"export"}`, check `export_enabled` and `min_ext_version`; reject with explicit error if either fails.
- `extension/popup.js` — surface "Export temporarily disabled" when flag flips false.

**Key decisions:**
- `semver`-comparison of `EXT_VERSION` (from manifest.json) against `min_ext_version`. Small dep; bundled.
- On `fetch` failure (backend down), use last cached config. On no cache, fall open (`export_enabled=true`) to avoid stranding users.

**Verification:**
- Manual: flip `EXT_FREEPIK_ENABLED=false` on backend, observe extension rejects Freepik items in a manifest with clear error.

**Estimate:** 1 PR, 1 day.

### Ext.10 — Cross-browser + CI

**Goal:** Packaging pipeline. Smoke test Edge + Arc + Brave. `.crx` + `.zip` artifacts on tag.

**Depends on:** Ext.9 (feature-complete build).

**Files:**
- `.github/workflows/extension-build.yml` — build on push to `main`, upload `.zip` + `.crx` on `ext-v*` tags.
- `extension/scripts/package.mjs` — zip the `extension/` dir, sign with key from Ext.1.
- `extension/README.md` — cross-browser notes.

**Key decisions:**
- GitHub Actions runners — matches the rest of transcript-eval's CI (likely already uses Actions).
- Edge gets explicit smoke via GH Actions; Arc/Brave/Vivaldi/Opera best-effort manual.

**Verification:**
- CI green on a PR touching only `extension/`.
- Tagged release produces downloadable artifacts.

**Estimate:** 1 PR, 1–2 days.

### Ext.11 — Chrome Web Store submission (beta)

**Goal:** Unlisted Web Store listing, shared with you + a handful of testers.

**Depends on:** Ext.10 (CI artifact).

**Files:**
- `extension/store/listing.md` — store listing content (description, features, screenshots).
- `extension/store/privacy.md` — copy of the privacy policy (references `https://adpunk.ai/privacy-policy`).
- `extension/store/screenshots/*.png` — user-provided.

**Key decisions:**
- **Developer fee already paid** (Chrome Web Store one-time $5, per project memory).
- **Privacy policy URL:** `https://adpunk.ai/privacy-policy` (per project memory, NOT `transcript-eval.com/privacy` from the spec).
- **Store listing name:** "transcript-eval Export Helper".
- **Short description:** "Export your transcript-eval projects to Premiere with b-rolls from your own subscription accounts." — do NOT use the word "Envato" (DMCA risk per main spec).
- **Single-purpose declaration** required for MV3 compliance. Ours does one thing: export b-rolls.
- Chrome Web Store review: 1–3 business days initial; updates same-day.

**Verification:**
- Manual: install from unlisted Web Store link on a fresh Chrome profile, run a small export end-to-end.

**Estimate:** Human-heavy task (screenshots, description polish). 1 PR for repo assets; 1–2 human days for the Web Store console work.

### Ext.12 — Soft launch → GA

**Goal:** Feature flag the export button in the editor so new signups don't see it until we flip GA. Ramp via Backend 1.5's `export_enabled` + a user-cohort flag in the web app.

**Depends on:** Ext.11 (beta running cleanly for ≥1 week).

**Files:**
- `server/services/ext-config.js` — add per-user-cohort logic (e.g. `EXPORT_BETA_USER_IDS` env var).
- `src/pages/EditorPage.jsx` (or wherever the Export button lives) — check `useExtensionConfig` hook before rendering the button.

**Key decisions:**
- Canary channel (a second Web Store listing): optional, defer unless incidents in beta warrant it.
- GA threshold: 2 weeks of beta traffic with <1% failure rate on `export_completed` events. Measured via an ad-hoc admin query.

**Estimate:** 1 PR, half a day of code; 1–2 weeks of observation between beta and GA.

---

## Part D — Web App Admin + Support Surfaces

Can start anytime after Phase 1 backend merges. Low priority but cheap to ship.

### WebApp.3 — Admin Observability UI (`/admin/exports`)

**Goal:** Admin visibility per main spec Phase 9. Recent exports, per-export event timeline, filter failures, per-user view, aggregate failure rates.

**Depends on:** Phase 1 backend (data is already being written).

**Files:**
- `server/routes/admin/exports.js` — `GET /api/admin/exports`, `GET /api/admin/exports/:id/events`.
- `src/pages/admin/ExportsList.jsx`, `src/pages/admin/ExportDetail.jsx`.

**Key decisions:**
- Reuse existing admin auth (`isAdmin(req)` check from `server/auth.js`).
- Aggregation queries — consider adding a materialized view or just run at query time; the table is small until scale.

**Estimate:** 2 PRs, 2 days.

### WebApp.4 — Support Diagnostics UI (`/admin/support`)

**Goal:** Admin uploads a user's diagnostic bundle, views parsed contents side-by-side with the `exports` row. Main spec Phase 10.

**Depends on:** WebApp.3 (shares admin infra) + Ext.8 (extension produces the bundles).

**Files:**
- `src/pages/admin/SupportBundle.jsx` — upload + parse + render.
- `server/routes/admin/support-bundles.js` — stateless endpoint that parses bundle ZIP, returns JSON.
- `src/pages/admin/SupportBundle.jsx`.

**Estimate:** 1 PR, 1–2 days.

---

## Part E — Parallelization plan

The critical path is Backend 1.5 → Export page + XMEML → Ext.2-6. Roughly:

### Week 1
- Finalize merge order; decide when to land Phase 1 + adpunk.ssh pipeline + Ext.1 to main (probably in a coordinated drop since they're all additive).
- **Backend 1.5** (half day)
- **Ext.2** (Envato single-item) — one developer / AI session
- **WebApp.1 State A+B** (pre-flight screens) — other developer / AI session (independent of Ext.2)
- **WebApp.2 XMEML generator** (pure function, test-heavy) — can be a 3rd parallel session

### Week 2
- **Ext.3** (Pexels + Freepik)
- **Ext.4** (auth polish)
- **WebApp.1 State C** (manifest summary + Start button)

### Week 3
- **Ext.5** (queue + persistence) — biggest piece
- **WebApp.1 State D** (in-progress UI — needs Ext.5's Port messages)

### Week 4
- **Ext.6** (telemetry)
- **WebApp.1 State E + F** (complete / partial UIs)
- First end-to-end user test internally

### Week 5
- **Ext.7** (failure polish)
- **Ext.8** (diagnostics)
- **Ext.9** (feature flags)

### Week 6
- **Ext.10** (CI packaging)
- **Ext.11** (Chrome Web Store beta submission — deploy day)
- Beta testers start using it

### Week 7-8
- **WebApp.3 + WebApp.4** (admin UIs) — can be moved earlier if there's capacity
- Beta observation, bug fixes
- **Ext.12** (GA ramp)

Total: ~6–8 weeks of calendar time, assuming dedicated focus and no Envato breakage.

---

## Open questions / decisions needed

These block or color future work. Get answers before the relevant phase starts.

### Decisions — resolved
- ✅ Extension location: inside transcript-eval (Option A) — memory + Ext.1 branch.
- ✅ Extension ID: pinned via RSA key — Ext.1 done.
- ✅ Privacy policy URL: `adpunk.ai/privacy-policy` — memory.
- ✅ Chrome Web Store developer fee: paid — memory.
- ✅ Adpunk.ssh doesn't write directly to Supabase (deferred, HTTP response pattern retained).

### Decisions — still open

1. **Beta-test Envato subscription** — who pays, who owns credentials. Needed BEFORE Ext.2.
2. **Introduce a test framework?** Project currently has zero test harness. XMEML generator + extension modules would benefit. If yes: `vitest` is the right pick (matches Vite ecosystem). Decision point: before WebApp.2.
3. **Target folder picker** — default `~/Downloads/transcript-eval/...` or opt-in FSA API picker? Leaning default + picker opt-in. Decision point: WebApp.1 State C.
4. **Admin UI auth model** — reuse hardcoded `ADMIN_EMAILS` list from `server/auth.js`, or move to Supabase role-based? Current shape works for MVP; revisit if a second admin joins.
5. **Multi-user org support** — shared Envato subscription across teammates. Spec says "out of scope". Reconfirm at Ext.11 time; likely still deferred.
6. **Canary channel** — build a second Web Store listing for pre-GA testing, or use beta + feature flag only? Leaning latter. Decision point: before Ext.11.
7. **XMEML test strategy** — golden-file snapshot tests (no framework needed) or proper unit tests (needs test framework)? Decision point: WebApp.2.

---

## Merge coordination note

Three branches are currently ready to land on `main`:

1. `feature/envato-export-phase1` (13 commits, transcript-eval)
2. `feature/broll-candidate-pipeline` (47 commits, adpunk.ssh) — lands in a different repo, independent
3. `feature/extension-ext1` (15 commits, transcript-eval)

Within transcript-eval, the two branches touch disjoint trees:
- Phase 1 touches `server/` + `.env.example` + `package.json`.
- Ext.1 touches `extension/` + `src/extension-test.html` + `vite.config.js` + tiny `package.json` adjustment + `.gitignore`.

**Merge order recommendation:** Phase 1 first (it provides the contracts Ext.1 references in docs), then Ext.1. No rebasing or conflict resolution needed — both branched off the same `main` commit (`4381095`) and don't overlap.

Adpunk.ssh merges independently whenever the user is ready — its output (`broll_searches.results_json` schema) is a runtime contract, not a code-level dependency between the repos.

---

## Who consumes what, where

For any future session picking up any slice of this roadmap, this table is the quickest integration check:

| Phase | Reads | Writes | HTTP calls | Notes |
|---|---|---|---|---|
| Backend 1.5 | env vars | — | — | New public GET endpoint. |
| WebApp.1 | `broll_searches.results_json` | — | Phase 1 endpoints + extension (via chrome.runtime) | Needs extension ID from `extension/.extension-id`. |
| WebApp.2 | placement data (from web app) | — | — | Pure function. |
| Ext.2 | extension JWT (from Ext.1) | `chrome.downloads` | `app.envato.com/download.data` | No backend calls yet. |
| Ext.3 | extension JWT | `chrome.downloads` | `/api/pexels-url`, `/api/freepik-url` | Backend is live. |
| Ext.4 | Envato cookies | `chrome.storage.local.jwt` | — | Port connects to web app. |
| Ext.5 | JWT + cookies | `chrome.storage.local.run:*`, `completed_items`, `deny_list` | source endpoints, Envato | Queue drives everything. |
| Ext.6 | queue transitions | `chrome.storage.local.telemetry_queue` | `/api/export-events` | Events already spec'd in Phase 1. |
| Ext.7 | queue, deny-list | deny-list updates | same as Ext.5 | Error-matrix wiring. |
| Ext.8 | everything | bundles to disk | — | Nothing server-side. |
| Ext.9 | `/api/ext-config` response | `chrome.storage.local.cached_ext_config` | `/api/ext-config` | Consumes Backend 1.5. |
| Ext.10 | everything | CI artifacts | — | Packaging only. |
| Ext.11 | everything | Chrome Web Store | — | Manual submission. |
| Ext.12 | `EXPORT_BETA_USER_IDS` env, user id | — | `/api/ext-config` | Cohort-gated rollout. |
| WebApp.3 | `exports`, `export_events` | — | — | Admin read-only UI. |
| WebApp.4 | uploaded diagnostic bundle | — | — | Bundle parser. |

---

## Ending state

When this roadmap is fully executed:

- transcript-eval web app: export page live at `/editor/:id/export`, admin page at `/admin/exports` + `/admin/support`, XMEML generator served at `/api/exports/:id/generate-xml`.
- transcript-eval backend: Phase 1 endpoints + `/api/ext-config` running.
- adpunk.ssh: broll candidate pipeline serving Envato + Pexels + Storyblocks + Freepik candidates to the web app.
- Chrome extension: live on Chrome Web Store, GA'd to all users, handles Envato / Pexels / Freepik downloads with full queue + telemetry + diagnostics.
- Users: click Export → Premiere XML opens → clips at exact timeline positions.

That's the full 4-stage funnel described in the original spec, at production quality.
