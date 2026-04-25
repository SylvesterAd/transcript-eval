# Ext.3 — Pexels + Freepik Single-Item Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Ext.3 of the transcript-eval Export Helper Chrome extension — the second real download flow. End-to-end server-proxied download of **exactly one Pexels item OR exactly one Freepik item** via Phase 1 backend's `POST /api/pexels-url` and `POST /api/freepik-url` endpoints. The extension mints a Bearer JWT (from Ext.1's `chrome.storage.local`), calls the endpoint, receives a signed URL + filename, and hands off to `chrome.downloads.download`. No queue, no dedupe, no TTL refetch, no telemetry — just prove the server-proxied pipeline works end-to-end for both sources. A 60-second "URL likely expired" grace check for Freepik's short-lived signed URLs IS in scope because full JIT refetching lands in Ext.5/Ext.7 and a simple grace check is nearly free.

**Architecture:** Ext.3 adds one new module — `extension/modules/sources.js` — and one new message type to the existing service-worker router (`{type:"debug_source_one_shot", source, item_id}`). The orchestration is linear and single-threaded per call: read JWT → call backend → optional TTL-grace check → `chrome.downloads.download` → reply. No content scripts, no hidden tabs, no Remix stream parsing (those are Ext.2's Envato-specific concerns). This is the first real outbound backend call from the extension — the first real use of the JWT stored by Ext.1's `{type:"session"}` round-trip. The test page adds a dedicated fieldset that fires the debug one-shot with a source dropdown + item_id input.

**Tech Stack:** Chrome MV3 (unchanged from Ext.2), vanilla JS ES modules, `fetch(BACKEND_URL + '/api/<source>-url', {headers: {Authorization: 'Bearer <jwt>'}})` for the URL mint, `chrome.downloads.download` for the save, existing transcript-eval vite dev server (`:5173`) for the test harness, Phase 1 backend on `:3001` for the URL-mint endpoints.

---

## Why read this before touching code

Six invariants — skim them before opening any file. They are the load-bearing pieces; everything else is mechanical.

1. **The download topology is different from Envato.** Pexels/Freepik downloads go `extension → backend → URL → chrome.downloads`. The backend holds the API keys (Pexels key + Freepik key — the latter is paid-per-call); the extension never touches those keys directly. This is why `host_permissions` only needs the CDN hosts where the signed URL *lives* (`videos.pexels.com`, `*.freepik.com`, `images.pexels.com`), NOT the backend origin (backend fetches go through the SW, which doesn't need host_permissions to POST to localhost:3001 / railway). Keep the topology clear: "mint URL at backend, hand URL to chrome.downloads." Two hops, not three like Envato.

2. **Every backend call requires `Authorization: Bearer <jwt>`.** Ext.1 stored the JWT in `chrome.storage.local` via the `{type:"session"}` round-trip; Ext.3 is the first phase that actually USES it on an outbound call. The helper `buildAuthHeaders()` reads the JWT fresh every call (MV3 service workers terminate aggressively — no caching) and throws `no_jwt` if the token is missing or `jwt_expired` if `expires_at <= Date.now()`. Ext.4 will add 401 recovery; Ext.3 surfaces missing/expired JWT as a fatal-for-that-item error and stops.

3. **Freepik URLs are short-lived — respect `expires_at`.** The backend response includes `expires_at` (epoch ms) from Phase 1's conservative 15-minute TTL. Pexels URLs are permanent; no expiry. Ext.3 adds a 60-second grace check: if `expires_at && Date.now() > expires_at - 60_000`, abort with `freepik_url_expired`. For a single debug one-shot the gap between mint and `chrome.downloads.download` is milliseconds so this check will almost never fire — but the helper is a hook point for Ext.5's queue, where the gap can be minutes. Full TTL parse-and-refetch lands in Ext.7.

4. **No deny-list / dedupe / queue / 401 recovery in Ext.3.** Ext.2 added a cheap ZIP safety net because Envato's Phase 2 commits a license before we see the filename. Ext.3's backend endpoints are free for Pexels and billable for Freepik per call — but Freepik's `/v1/videos/:id/download` cost is paid regardless of whether we then write the file, so an "if mp4 extension" check here doesn't save money. Skip it. Similarly: no dedupe (Ext.5), no queue (Ext.5), no 401 recovery (Ext.4), no TTL refetch (Ext.7).

5. **Cost model — surface `freepik_unconfigured` as fatal-for-that-item.** If the backend's `FREEPIK_API_KEY` env var is unset, the `/api/freepik-url` endpoint returns HTTP 503 with `{error: "Freepik is not configured"}` (Phase 1 Task 8). Ext.3 reads that and emits `errorCode: 'freepik_unconfigured'` so the user's export run can continue with their other sources. Do NOT crash, do NOT retry, do NOT bypass — the user is expected to configure Freepik server-side before relying on it. This is also how the Task 7 smoke test verifies the error path without needing an actual Freepik key (see the Freepik unconfigured decision below).

6. **Error code taxonomy is load-bearing.** Ext.7's retry matrix keys off these strings. Don't change them without also updating the roadmap. Ext.3 emits: `pexels_api_error`, `pexels_404`, `freepik_api_error`, `freepik_404`, `freepik_429`, `freepik_unconfigured`, `network_error`, `no_jwt`, `jwt_expired`, `freepik_url_expired`, `chrome_downloads_error`, `bad_input`.

---

## Scope (Ext.3 only — hold the line)

### In scope

- `extension/modules/sources.js` — new module exporting `fetchPexelsUrl`, `fetchFreepikUrl`, `downloadSourceItem`. Two private helpers (`buildAuthHeaders`, `isUrlLikelyExpired`).
- `extension/service_worker.js` — extend the existing `onMessageExternal` switch with one new case: `'debug_source_one_shot'`.
- `extension/manifest.json` — add three entries to `host_permissions` (Pexels CDN + Freepik CDN + Pexels images CDN); bump `version` from `0.2.0` to `0.3.0`. **NO new `permissions` added** — `downloads` / `storage` / `tabs` / `webNavigation` are all carried forward from Ext.2.
- `extension/config.js` — bump `EXT_VERSION` to `0.3.0`. One new constant: `FREEPIK_URL_GRACE_MS = 60000`.
- `extension-test.html` — new fieldset "Source one-shot (Pexels/Freepik)" with source dropdown, item_id input, trigger button, inline reply pretty-print.
- `extension/README.md` — append a "Ext.3 — Pexels + Freepik single item" section documenting trigger, expected file path, backend-required-on-3001 caveat.
- Manual smoke verification task (no commit) mirroring Ext.2's Task 7 pattern — including explicit `freepik_unconfigured` test when the key is absent.

### Deferred (DO NOT add to Ext.3 — they belong to later phases)

- **Queue / concurrency > 1 / pause / resume / cancel** → Ext.5. Single bare `await` chain; concurrency is implicitly 1.
- **Real 401 recovery / session refresh** → Ext.4. Ext.3 surfaces `no_jwt` / `jwt_expired` / HTTP 401 from backend as fatal-for-that-item and stops.
- **Per-run dedupe** (same `itemId` twice within one run) → Ext.5.
- **JIT URL refetch when Freepik URL is close to expiring** → Ext.7. Ext.3 adds only the 60-second grace *check* (abort if already expired), not a refetch loop.
- **Rate-limit handling beyond surfacing the error** → Ext.7. Ext.3 emits `freepik_429` and stops; no Retry-After parsing, no pause-and-retry.
- **Telemetry to `/api/export-events`** → Ext.6. The debug handler returns a reply object; no POST.
- **Mock fixtures for Pexels/Freepik responses** → Ext.5's mock-mode work. Ext.3 only hits real Pexels; Freepik is tested via the 503 path when the key is unset.
- **Envato code changes** → Ext.2's module is complete. Do NOT touch `modules/envato.js` or its service-worker case.
- **Run concept / `export-<runId>/media/` subfolder / multi-item sequencing** → Ext.5. Ext.3 writes flat under `transcript-eval/`, matching Ext.2's filename scheme (`<source>_<id>.<ext>`).
- **Resolution / format picker UI** → post-MVP. Ext.3 defaults to `preferred_resolution: '1080p'` for Pexels and `format: 'mp4'` for Freepik, not exposed in the test UI.
- **`cookies` permission / `power` permission** → Ext.4 / Ext.5. Ext.3 is JWT-authenticated, not cookie-authenticated.
- **Long-lived `chrome.runtime.Port`** → Ext.4 is where the first real Port lands.

If you catch yourself reaching for any of the Deferred list items, stop. Ext.3 proves the server-proxied pipeline for two sources; adding anything above makes this phase bigger than it needs to be and blocks the single most important question: *does our `extension → backend → URL → chrome.downloads` flow work end-to-end for Pexels and Freepik?*

See `docs/specs/2026-04-24-export-remaining-roadmap.md` § "Ext.3 — Pexels + Freepik single item" for the per-phase boundary definitions.

---

## Prerequisites

- **Ext.2 merged or working in parallel branch.** Either way, the files listed under "Ext.2 final state" in that plan must exist on the branch point. Ext.3 adds `modules/sources.js` alongside `modules/envato.js`; it does NOT touch `modules/envato.js`.
- **Phase 1 backend running on `:3001`** with `PEXELS_API_KEY` set in the repo's `.env`. The Ext.3 happy path for Pexels requires a live Pexels API round-trip.
- **Freepik key decision (optional):** If `FREEPIK_API_KEY` is set, the Freepik happy path can be exercised at a cost of €0.05 per successful call; if unset, Task 7's Freepik step verifies the `freepik_unconfigured` code path using the 503 response — that's the deliberate testing strategy (see decision note in the summary).
- **JWT round-trip still works from Ext.1.** Task 7 Step 3 re-fires `{type:"session"}` before calling the debug handler. If that fails, fix Ext.1 before proceeding.
- **Chrome 120+** (already an Ext.1/Ext.2 prereq).
- **Node 20+** (already used by transcript-eval; no new packages added in Ext.3).

Note: Path to the repo has a trailing space in `"one last "` — quote every path. `cd "$TE"` patterns only.

---

## File structure (Ext.3 final state)

Additions over Ext.2 are marked `[NEW Ext.3]`; modifications are `[MOD Ext.3]`; unchanged files are shown for context without annotation.

```
$TE/extension/
├── manifest.json                  [MOD Ext.3] version 0.2.0 → 0.3.0; host_permissions += videos.pexels.com, *.freepik.com, images.pexels.com
├── service_worker.js              [MOD Ext.3] new case 'debug_source_one_shot' + import from modules/sources.js
├── config.js                      [MOD Ext.3] EXT_VERSION bump + FREEPIK_URL_GRACE_MS constant
├── popup.html                     (unchanged)
├── popup.css                      (unchanged)
├── popup.js                       (unchanged)
├── .extension-id                  (unchanged — key pinned in Ext.1)
├── README.md                      [MOD Ext.3] append "Ext.3 — Pexels + Freepik single item" section
├── modules/
│   ├── auth.js                    (unchanged)
│   ├── envato.js                  (unchanged — Ext.2)
│   └── sources.js                 [NEW Ext.3] Pexels + Freepik URL mint + download orchestration
├── scripts/
│   └── generate-key.mjs           (unchanged)
└── fixtures/
    └── envato/
        └── .gitkeep               (unchanged — Ext.2 placeholder)

$TE/extension-test.html            [MOD Ext.3] new fieldset "Source one-shot (Pexels/Freepik)"
```

Why this split:
- `modules/sources.js` is the sole owner of server-proxied URL mint + download for BOTH Pexels and Freepik. They share the auth header shape, the `chrome.downloads.download` call, and the reply shape — one module, two public entry points (`fetchPexelsUrl`, `fetchFreepikUrl`), plus one top-level orchestrator (`downloadSourceItem`) that dispatches on `source`.
- `buildAuthHeaders` and `isUrlLikelyExpired` stay file-private. If Ext.6's telemetry module needs to call backend with Bearer JWT, promote `buildAuthHeaders` to `modules/auth.js` at that time — don't export speculatively.
- The debug message handler lives in `service_worker.js` directly (same pattern as Ext.2's `debug_envato_one_shot`). If Ext.4 adds a third debug case, revisit moving all three into `modules/debug.js`.
- No fixtures directory for Pexels/Freepik yet — Ext.5 covers that when mock-mode becomes necessary.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/extension-ext3` on branch `feature/extension-ext3-pexels-freepik`. If Ext.2 has merged to `main`, branch from `main`; otherwise branch from `feature/extension-ext2-envato-single`. Task 0 includes both variants — pick the right one based on `git branch -a | grep extension-ext2`.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan. Task 8 has an explicit "DO NOT push" reminder.
- **Never kill anything on port 3001.** That's the user's backend dev server (AND the Phase 1 API Ext.3 actually calls — killing it is self-defeating).
- **Commit style:** conventional commits (`feat(ext): ...`, `chore(ext): ...`, `docs(ext): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing in every shell call.
- **Do NOT modify Envato code.** `modules/envato.js` and its service-worker case are Ext.2 deliverables — complete as-is. Ext.3 only ADDS sibling code.

---

## Task 0: Create worktree + branch

**Files:**
- Create: `$TE/.worktrees/extension-ext3/` (worktree)

- [ ] **Step 1: Decide the branch-point**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin
git branch -a | grep extension-ext2 || echo "no ext2 branch"
```

- If `feature/extension-ext2-envato-single` still exists (not yet merged to `main`), branch Ext.3 FROM it:
  ```bash
  git worktree add -b feature/extension-ext3-pexels-freepik .worktrees/extension-ext3 feature/extension-ext2-envato-single
  ```
- If Ext.2 has already merged, branch from `main`:
  ```bash
  git worktree add -b feature/extension-ext3-pexels-freepik .worktrees/extension-ext3 main
  ```

Pick one. Do not create the worktree twice.

- [ ] **Step 2: Enter the worktree and verify**

```bash
cd "$TE/.worktrees/extension-ext3"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext3
git branch --show-current
# Expected: feature/extension-ext3-pexels-freepik
ls extension/modules/
# Expected: auth.js  envato.js       (no sources.js yet — that's Task 2)
cat extension/.extension-id
# Expected: 32-char a-p string (identical to Ext.1/Ext.2)
```

If `extension/modules/envato.js` is missing, Ext.2 is incomplete — stop and go fix Ext.2 before proceeding. Ext.3 does not DEPEND on Envato code at runtime but the regression check in Task 7 does (we verify Ext.2 still works after manifest + SW changes).

- [ ] **Step 3: Confirm the manifest says version `0.2.0`**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions, '| host_perms:', m.host_permissions?.length)"
# Expected: version: 0.2.0 | permissions: [ 'storage', 'tabs', 'webNavigation', 'downloads' ] | host_perms: 3
```

If the output differs from `0.2.0` + 4 perms + 3 host_perms, someone has already started Ext.3 work on this branch — figure out why before continuing.

There is nothing to commit in this task — creating a worktree and branch doesn't produce a file change on its own.

---

## Task 1: Update manifest — host_permissions + version bump

Manifest changes go first so that when `modules/sources.js` calls `fetch` to mint a URL and then `chrome.downloads.download` hits the Pexels/Freepik CDN, the host permissions are already declared. Chrome's MV3 fetch requires no explicit permission for backend calls to `localhost:3001` (external origin, standard CORS), but `chrome.downloads.download` of a signed CDN URL benefits from `host_permissions` for cookies/credentials cleanliness — and future Ext.5 JIT refetch logic will run `fetch` against those CDNs.

**Files:**
- Modify: `extension/manifest.json`

- [ ] **Step 1: Read the current manifest**

Open `extension/manifest.json` — it should have `permissions: ["storage","tabs","webNavigation","downloads"]` and `host_permissions` with three Envato-family entries.

- [ ] **Step 2: Bump `version` from `0.2.0` to `0.3.0`**

Use the Edit tool:
- `old_string`: `"version": "0.2.0"`
- `new_string`: `"version": "0.3.0"`

Only ONE occurrence exists, so this is unambiguous.

- [ ] **Step 3: Extend the `host_permissions` array**

Use Edit. The anchor relies on the last existing entry being `video-downloads.elements.envatousercontent.com/*`:

- `old_string`:
  ```
    "host_permissions": [
      "https://elements.envato.com/*",
      "https://app.envato.com/*",
      "https://video-downloads.elements.envatousercontent.com/*"
    ],
  ```
- `new_string`:
  ```
    "host_permissions": [
      "https://elements.envato.com/*",
      "https://app.envato.com/*",
      "https://video-downloads.elements.envatousercontent.com/*",
      "https://videos.pexels.com/*",
      "https://images.pexels.com/*",
      "https://*.freepik.com/*"
    ],
  ```

Rationale for each new origin:
- `https://videos.pexels.com/*` — the signed CDN where Pexels video files live (`/video-files/...`). `chrome.downloads.download` hits this origin.
- `https://images.pexels.com/*` — Pexels image CDN, not strictly required for Ext.3 (we only download videos from Pexels in MVP) but declared now so Ext.5's photo-source work doesn't need another manifest bump. Cheap to include.
- `https://*.freepik.com/*` — Freepik's signed URLs may be served from `freepik.com` or various `*.freepik.com` subdomains; wildcard keeps us safe. (The actual CDN may also use `videocdn.cdnpk.net` per Phase 1 notes; if that's confirmed in Task 7, revisit adding it. For Ext.3 we stick to the spec's listed `*.freepik.com`.)

Note: Spec § "MV3 manifest" sample at line 911-912 lists `videos.pexels.com` and `*.freepik.com` — Ext.3 matches that. The `images.pexels.com` addition is an inexpensive forward-reach and can be removed in code review if preferred.

- [ ] **Step 4: Verify the manifest still parses**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions.length, '| host_perms:', m.host_permissions.length, '| key_present:', !!m.key)"
# Expected: version: 0.3.0 | permissions: 4 | host_perms: 6 | key_present: true
```

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json
git commit -m "$(cat <<'EOF'
feat(ext): manifest — add Pexels/Freepik host_permissions for Ext.3

Version 0.2.0 → 0.3.0. host_permissions += videos.pexels.com/*,
images.pexels.com/*, *.freepik.com/*. No new permissions needed —
storage/tabs/webNavigation/downloads all carry forward from Ext.2.

Ext.3 routes downloads through the backend (which holds the API
keys); the extension fetches the signed URL from Phase 1 endpoints
and then hands it to chrome.downloads.download. host_permissions
cover the CDN hosts where the signed URL terminates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extend `config.js` — EXT_VERSION bump + grace constant

Adds one constant that `modules/sources.js` will import in Task 3. Keeps timing knobs in one place.

**Files:**
- Modify: `extension/config.js`

- [ ] **Step 1: Read the current `config.js`**

```bash
cat extension/config.js
```

Expected shape (from Ext.2):

```js
export const EXT_VERSION = '0.2.0'
export const ENV = 'dev'
export const BACKEND_URL = ENV === 'prod'
  ? 'https://backend-production-4b19.up.railway.app'
  : 'http://localhost:3001'
export const MESSAGE_VERSION = 1
export const RESOLVER_TIMEOUT_MS = 15000
export const MAX_RESOLVER_CONCURRENCY = 1
```

- [ ] **Step 2: Bump `EXT_VERSION` + add the new constant**

Use Edit:
- `old_string`: `export const EXT_VERSION = '0.2.0'`
- `new_string`: `export const EXT_VERSION = '0.3.0'`

Then append at the END of the file (anchor on the existing last line, `MAX_RESOLVER_CONCURRENCY`):
- `old_string`:
  ```
  export const MAX_RESOLVER_CONCURRENCY = 1
  ```
- `new_string`:
  ```
  export const MAX_RESOLVER_CONCURRENCY = 1

  // Freepik signed URLs are short-lived (Phase 1 backend mints with
  // ~15 min TTL; Freepik's own TTL is 15-60 min). Ext.3 aborts the
  // download if the URL is within 60s of expiry rather than starting
  // a transfer that may 403 mid-stream. Full refetch-on-expiry lands
  // in Ext.5/Ext.7; this constant is the grace window.
  export const FREEPIK_URL_GRACE_MS = 60000
  ```

- [ ] **Step 3: Verify syntax**

```bash
node --check extension/config.js
# Expected: exit 0
```

- [ ] **Step 4: Commit**

```bash
git add extension/config.js
git commit -m "$(cat <<'EOF'
feat(ext): config — EXT_VERSION 0.3.0 + FREEPIK_URL_GRACE_MS

Adds FREEPIK_URL_GRACE_MS = 60_000 for the 60-second "URL about to
expire" check in modules/sources.js. Full TTL parsing + refetch
lands in Ext.7; this is just the cheap abort-before-transfer guard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Write `modules/sources.js` — the URL mint + download orchestrator

The heart of Ext.3. One file, three public functions, two private helpers, linear orchestration.

**Files:**
- Create: `extension/modules/sources.js`

- [ ] **Step 1: Create `extension/modules/sources.js`**

Exact content:

```js
// Pexels + Freepik server-proxied downloads. Ext.3 scope: ONE item
// per user click. No queue, no dedupe, no retry matrix — Ext.5 and
// Ext.7 add those.
//
// Topology (different from Envato's 3-phase flow):
//   extension → backend /api/<source>-url (Bearer JWT) → signed URL
//     → chrome.downloads.download → ~/Downloads/transcript-eval/
//
// The backend holds Pexels and Freepik API keys; extension never sees
// them. Every call requires a valid JWT from Ext.1's storage.

import { BACKEND_URL, FREEPIK_URL_GRACE_MS } from '../config.js'
import { getJwt } from './auth.js'

// ---- public API ----

/**
 * Phase A (Pexels). Mints a signed Pexels video URL via backend.
 * Returns {url, filename, size_bytes, resolution: {width, height}}.
 * Throws Error('pexels_404') if the item doesn't exist upstream,
 * Error('pexels_api_error') on other non-OK responses,
 * Error('no_jwt') / Error('jwt_expired') via buildAuthHeaders,
 * Error('network_error: <detail>') on fetch failure.
 */
export async function fetchPexelsUrl({ itemId, preferredResolution = '1080p' }) {
  const headers = await buildAuthHeaders()
  let resp
  try {
    resp = await fetch(`${BACKEND_URL}/api/pexels-url`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ item_id: itemId, preferred_resolution: preferredResolution }),
    })
  } catch (err) {
    throw new Error('network_error: ' + String(err?.message || err))
  }

  if (resp.status === 404) throw new Error('pexels_404')
  if (!resp.ok) throw new Error('pexels_api_error')

  const data = await resp.json().catch(() => null)
  if (!data || !data.url) throw new Error('pexels_api_error')
  return data  // { url, filename, size_bytes, resolution }
}

/**
 * Phase A (Freepik). Mints a signed Freepik video URL via backend.
 * Returns {url, filename, size_bytes, expires_at}.
 * Throws Error('freepik_404'), Error('freepik_429'),
 * Error('freepik_unconfigured') on 503, Error('freepik_api_error')
 * on other 4xx/5xx, Error('no_jwt') / Error('jwt_expired') via
 * buildAuthHeaders, Error('network_error: <detail>') on fetch
 * failure.
 */
export async function fetchFreepikUrl({ itemId, format = 'mp4' }) {
  const headers = await buildAuthHeaders()
  let resp
  try {
    resp = await fetch(`${BACKEND_URL}/api/freepik-url`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ item_id: itemId, format }),
    })
  } catch (err) {
    throw new Error('network_error: ' + String(err?.message || err))
  }

  if (resp.status === 404) throw new Error('freepik_404')
  if (resp.status === 429) throw new Error('freepik_429')
  if (resp.status === 503) throw new Error('freepik_unconfigured')
  if (!resp.ok) throw new Error('freepik_api_error')

  const data = await resp.json().catch(() => null)
  if (!data || !data.url) throw new Error('freepik_api_error')
  return data  // { url, filename, size_bytes, expires_at }
}

/**
 * Top-level orchestrator. Dispatches on `source`, calls the right
 * fetch*Url, runs the Freepik TTL grace check, and calls
 * chrome.downloads.download. Returns
 *   {ok:true, filename, downloadId, size_bytes}
 * or
 *   {ok:false, errorCode, detail}
 * on any failure. Does NOT throw — the caller is the SW message
 * handler which wants a plain reply object.
 */
export async function downloadSourceItem({ source, itemId, runId, sanitizedFilename }) {
  // Light sanity check.
  if (source !== 'pexels' && source !== 'freepik') {
    return { ok: false, errorCode: 'bad_input', detail: `unknown source: ${source}` }
  }
  if (!itemId || (typeof itemId !== 'string' && typeof itemId !== 'number')) {
    return { ok: false, errorCode: 'bad_input', detail: 'itemId missing or wrong type' }
  }

  const t0 = Date.now()

  // Phase A — mint the signed URL.
  let mint
  try {
    mint = source === 'pexels'
      ? await fetchPexelsUrl({ itemId })
      : await fetchFreepikUrl({ itemId })
  } catch (err) {
    return { ok: false, errorCode: err?.message?.split(':')[0] || 'mint_error', detail: String(err?.message || err) }
  }
  const t1 = Date.now()
  console.log(`[sources] phase A mint OK (${source})`, { itemId, filename: mint.filename, ms: t1 - t0 })

  // Phase B — Freepik TTL grace check. Pexels URLs don't carry
  // expires_at so this is a no-op for Pexels.
  if (source === 'freepik' && isUrlLikelyExpired(mint.expires_at)) {
    console.log('[sources] phase B grace-check aborted', { expires_at: mint.expires_at })
    return { ok: false, errorCode: 'freepik_url_expired', detail: `expires_at ${mint.expires_at} within ${FREEPIK_URL_GRACE_MS}ms of now` }
  }

  // Phase C — chrome.downloads.download.
  // runId is accepted for Ext.5 forward compatibility but ignored.
  void runId

  const finalFilename = sanitizedFilename || mint.filename || `${source}_${itemId}.mp4`
  let downloadId
  try {
    downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: mint.url,
        filename: `transcript-eval/${finalFilename}`,
        saveAs: false,
        conflictAction: 'uniquify',
      }, id => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve(id)
      })
    })
  } catch (err) {
    return { ok: false, errorCode: 'chrome_downloads_error', detail: String(err?.message || err) }
  }
  const t2 = Date.now()
  console.log(`[sources] phase C download started (${source})`, { downloadId, ms: t2 - t1, total_ms: t2 - t0 })

  return { ok: true, filename: finalFilename, downloadId, size_bytes: mint.size_bytes ?? null }
}

// ---- private helpers ----

// Reads the JWT fresh from chrome.storage.local (MV3 SWs terminate
// aggressively — never cache). Throws 'no_jwt' if missing or
// 'jwt_expired' if past expiry. Returns a headers object ready to
// spread into fetch().
async function buildAuthHeaders() {
  const jwt = await getJwt()
  if (!jwt || !jwt.token) throw new Error('no_jwt')
  if (typeof jwt.expires_at === 'number' && jwt.expires_at <= Date.now()) {
    throw new Error('jwt_expired')
  }
  return {
    'Authorization': 'Bearer ' + jwt.token,
    'Content-Type': 'application/json',
  }
}

// True if `expiresAt` is a number AND we're within FREEPIK_URL_GRACE_MS
// of it. null / undefined / 0 / NaN → false (treat as "no expiry info,
// proceed"). This is the cheap guard; Ext.7 adds refetch-if-expired.
function isUrlLikelyExpired(expiresAt) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return false
  return Date.now() > expiresAt - FREEPIK_URL_GRACE_MS
}
```

Design notes worth reading before you start changing this file:

- **Error code shape** — `err?.message?.split(':')[0]` in the `downloadSourceItem` catch strips the `: <detail>` suffix from `network_error: fetch failed`, giving a clean `errorCode: 'network_error'` with the raw message in `detail`. If you add new error classes, either keep the `code: detail` format or branch explicitly.
- **`isUrlLikelyExpired` intentionally lenient** — if the backend omits `expires_at` (future shape change) or sends 0/NaN, we proceed. The guard is defensive, not gating. Phase 1's Freepik endpoint always returns a valid number so this path is well-exercised; Pexels omits the field and the function returns false for both cases.
- **No Pexels TTL check** — Pexels CDN URLs are documented as permanent (spec line 390). We don't parse them.
- **`runId` + `sanitizedFilename` through-parameters** — match Ext.2's `downloadEnvato` signature so Ext.5's queue can call both modules with the same arg shape. Ext.3 ignores `runId` and falls back to the backend's `filename` if `sanitizedFilename` isn't passed.
- **No retry on any error** — The caller gets a coarse error code and decides what to do. Ext.7 adds the retry matrix (Freepik 429 Retry-After, network_error backoff, etc.). Here we surface the raw error.

- [ ] **Step 2: Syntax check**

```bash
node --check extension/modules/sources.js
# Expected: exit 0
```

`node --check` only validates syntax — it does NOT evaluate `chrome.*` globals (which don't exist in Node). Runtime correctness is verified in Task 7's manual smoke.

- [ ] **Step 3: Commit**

```bash
git add extension/modules/sources.js
git commit -m "$(cat <<'EOF'
feat(ext): modules/sources.js — Pexels + Freepik download orchestrator

Single-file implementation of Ext.3's server-proxied flow:

Phase A fetchPexelsUrl / fetchFreepikUrl — POST to BACKEND_URL/api/
<source>-url with Bearer JWT, throw coarse error codes on non-OK
(pexels_404 / pexels_api_error / freepik_404 / freepik_429 /
freepik_unconfigured / freepik_api_error / no_jwt / jwt_expired /
network_error).

Phase B TTL grace check — if Freepik URL is within 60s of expiry,
abort as freepik_url_expired. Pexels URLs skip this (permanent).

Phase C — chrome.downloads.download into ~/Downloads/transcript-eval/
with conflictAction:'uniquify'.

downloadSourceItem() dispatches on `source` and orchestrates;
returns {ok, filename, downloadId, size_bytes} or {ok:false,
errorCode, detail}. Concurrency cap 1, bare `await` chain; pool
lands in Ext.5. No dedupe, no 401 recovery, no retry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend `service_worker.js` — add `debug_source_one_shot` handler

One new `case` in the existing switch. Everything else stays.

**Files:**
- Modify: `extension/service_worker.js`

- [ ] **Step 1: Read the current service worker**

Confirm it matches the Ext.2 shape: a top-of-file import block including `downloadEnvato`, `handlePing`, `handleSession`, `handleDebugEnvatoOneShot`, `isSupportedVersion`, a `chrome.runtime.onMessageExternal.addListener` with `switch (msg.type)` containing `case 'ping'`, `case 'session'`, `case 'debug_envato_one_shot'`, `default`.

- [ ] **Step 2: Add the sources import**

Use Edit:
- `old_string`:
  ```
  import { EXT_VERSION, MESSAGE_VERSION } from './config.js'
  import { getJwt, setJwt, hasValidJwt } from './modules/auth.js'
  import { downloadEnvato } from './modules/envato.js'
  ```
- `new_string`:
  ```
  import { EXT_VERSION, MESSAGE_VERSION } from './config.js'
  import { getJwt, setJwt, hasValidJwt } from './modules/auth.js'
  import { downloadEnvato } from './modules/envato.js'
  import { downloadSourceItem } from './modules/sources.js'
  ```

- [ ] **Step 3: Add the `handleDebugSourceOneShot` helper**

Insert it immediately after `handleDebugEnvatoOneShot` (above `isSupportedVersion`). Use Edit:

- `old_string`:
  ```
  function isSupportedVersion(v) {
  ```
- `new_string`:
  ```
  // Ext.3 debug handler — fires the full Pexels OR Freepik flow for
  // ONE item via the server-proxied /api/<source>-url endpoints.
  // NOT user-facing; only triggered from the dev test page.
  //
  // REQUIRES a valid JWT in chrome.storage.local (mint one via
  // {type:"session"} from the test page first). Unlike the Envato
  // debug handler, this flow posts to the backend with Bearer auth.
  async function handleDebugSourceOneShot(msg) {
    const { source, item_id, run_id, sanitized_filename } = msg
    if (source !== 'pexels' && source !== 'freepik') {
      return { ok: false, errorCode: 'bad_input', detail: 'source must be "pexels" or "freepik"' }
    }
    if (!item_id || (typeof item_id !== 'string' && typeof item_id !== 'number')) {
      return { ok: false, errorCode: 'bad_input', detail: 'item_id required (string or number)' }
    }
    try {
      const result = await downloadSourceItem({
        source,
        itemId: item_id,
        runId: run_id,                  // may be undefined — Ext.3 ignores it
        sanitizedFilename: sanitized_filename,  // may be undefined — default <source>_<id>.<ext>
      })
      return result
    } catch (err) {
      // downloadSourceItem returns rather than throwing, but be defensive.
      return { ok: false, errorCode: 'unhandled_error', detail: String(err?.message || err) }
    }
  }

  function isSupportedVersion(v) {
  ```

- [ ] **Step 4: Add the switch case**

Use Edit:
- `old_string`:
  ```
        case 'debug_envato_one_shot':
          sendResponse(await handleDebugEnvatoOneShot(msg))
          return
        default:
  ```
- `new_string`:
  ```
        case 'debug_envato_one_shot':
          sendResponse(await handleDebugEnvatoOneShot(msg))
          return
        case 'debug_source_one_shot':
          sendResponse(await handleDebugSourceOneShot(msg))
          return
        default:
  ```

- [ ] **Step 5: Verify syntax**

```bash
node --check extension/service_worker.js
# Expected: exit 0
```

- [ ] **Step 6: Commit**

```bash
git add extension/service_worker.js
git commit -m "$(cat <<'EOF'
feat(ext): service worker — debug_source_one_shot handler

Adds one new case to the onMessageExternal switch. The handler calls
downloadSourceItem(...) from modules/sources.js and replies with the
{ok, filename, downloadId, size_bytes} or {ok:false, errorCode,
detail} result.

Accepts {type, version, source:"pexels"|"freepik", item_id,
run_id?, sanitized_filename?}. REQUIRES a valid JWT in
chrome.storage.local (unlike Ext.2's debug_envato_one_shot which
uses cookies). Ping + session + Envato handlers are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Extend the test harness — "Source one-shot" fieldset

Adds a new `<fieldset>` to `extension-test.html` with a source dropdown, item_id input, a trigger button, and a `<pre>` for the reply. Pre-fills a known-public Pexels video id so the user can smoke-test without hunting for an id.

**Files:**
- Modify: `extension-test.html` (at repo root)

- [ ] **Step 1: Read the current test harness**

The Ext.2 plan's Task 6 added fieldset **"5. Envato one-shot (Ext.2)"** with `id="out-envato"` as the reply pre. The new fieldset goes AFTER that one and BEFORE the `<script type="module">` block.

- [ ] **Step 2: Insert the new fieldset**

Find the closing `</fieldset>` of the "Envato one-shot (Ext.2)" section. Use Edit:

- `old_string`:
  ```
      <fieldset>
        <legend>5. Envato one-shot (Ext.2)</legend>
  ```
  (Use the full Envato fieldset block plus its trailing `</fieldset>` plus the blank line before `<script type="module">` as the anchor. If the Edit complains about uniqueness, narrow to the last two lines before the `<script>` tag: `      </fieldset>\n\n    <script type="module">`.)

- `new_string` (the entire block including the new fieldset):
  ```
      <fieldset>
        <legend>5. Envato one-shot (Ext.2)</legend>
  ```
  ...unchanged Envato block unchanged... and after Envato's `</fieldset>` insert the following before `<script type="module">`:

**Implementation note for the executor:** The Edit tool requires an exact unique anchor. The reliable approach is a two-part edit:

1. First Edit: anchor on `        <pre id="out-envato">(no response yet)</pre>\n      </fieldset>\n\n    <script type="module">` → replace with the same three lines PLUS the new fieldset inserted between `</fieldset>` and `<script type="module">`.

Use Edit with:
- `old_string`:
  ```
        <pre id="out-envato">(no response yet)</pre>
      </fieldset>

      <script type="module">
  ```
- `new_string`:
  ```
        <pre id="out-envato">(no response yet)</pre>
      </fieldset>

      <fieldset>
        <legend>6. Source one-shot — Pexels/Freepik (Ext.3)</legend>
        <p class="muted" style="margin-top: 0;">
          Calls the backend's <code>POST /api/pexels-url</code> or <code>POST /api/freepik-url</code> endpoint
          with a Bearer JWT, then hands the signed URL to <code>chrome.downloads.download</code>.
          Requires a valid JWT (run fieldset 2 first) and the backend running on :3001.
          Freepik calls are billable (€0.05 per successful mint); if <code>FREEPIK_API_KEY</code> is
          unset, the Freepik button returns <code>freepik_unconfigured</code> (503).
        </p>
        <label for="src-source">source:</label>
        <select id="src-source">
          <option value="pexels">pexels</option>
          <option value="freepik">freepik</option>
        </select>
        <label for="src-item-id">item_id:</label>
        <input type="text" id="src-item-id" placeholder="e.g. 856971 (Pexels) or freepik video id" autocomplete="off">
        <p class="muted">
          Pexels default: <code>856971</code> (public Pexels sample, safe for testing — the file will
          land in <code>~/Downloads/transcript-eval/pexels_856971.mp4</code>).
          Inputs persist to localStorage.
        </p>
        <div class="row">
          <button id="btn-source-one-shot">Run source download</button>
          <span id="source-status"></span>
        </div>
        <pre id="out-source">(no response yet)</pre>
      </fieldset>

      <script type="module">
  ```

- [ ] **Step 3: Append the click handler to the inline `<script type="module">` block**

The Ext.2 plan's Task 6 put its handler at the end of the `<script type="module">` block, closing on a line like `}\n    </script>`. Add the new handler after that closing brace.

Use Edit. The Ext.2 handler ends with `}\n    </script>` after `document.getElementById('btn-envato-one-shot').onclick = async () => { ... }`. Anchor on the last 3 lines:

- `old_string`: (end of the Envato click handler + closing script tag)
  ```
          out.textContent = 'ERROR: ' + (e.message || e)
          }
        }
      </script>
  ```
  If this anchor isn't unique, broaden by including a line further up in the Envato handler.

- `new_string`:
  ```
          out.textContent = 'ERROR: ' + (e.message || e)
          }
        }

        // ---- Ext.3 Source one-shot ----
        const srcSourceSelect = document.getElementById('src-source')
        const srcItemIdInput = document.getElementById('src-item-id')
        srcSourceSelect.value = localStorage.getItem('ext_test_source') || 'pexels'
        srcItemIdInput.value = localStorage.getItem('ext_test_source_item_id') || '856971'
        srcSourceSelect.addEventListener('change', () => localStorage.setItem('ext_test_source', srcSourceSelect.value))
        srcItemIdInput.addEventListener('input', () => localStorage.setItem('ext_test_source_item_id', srcItemIdInput.value.trim()))

        document.getElementById('btn-source-one-shot').onclick = async () => {
          const status = document.getElementById('source-status')
          const out = document.getElementById('out-source')
          const source = srcSourceSelect.value
          const itemId = srcItemIdInput.value.trim()
          if (!itemId) {
            status.textContent = 'missing item_id'
            status.className = 'status-err'
            out.textContent = 'item_id is required.'
            return
          }
          status.textContent = 'running…'
          status.className = ''
          out.textContent = '…'
          try {
            const t0 = performance.now()
            const r = await send({
              type: 'debug_source_one_shot',
              version: 1,
              source,
              item_id: itemId,
            })
            const ms = Math.round(performance.now() - t0)
            status.textContent = r?.ok ? `OK in ${ms}ms` : `FAIL in ${ms}ms`
            status.className = r?.ok ? 'status-ok' : 'status-err'
            out.textContent = pretty(r)
          } catch (e) {
            status.textContent = 'EXCEPTION'
            status.className = 'status-err'
            out.textContent = 'ERROR: ' + (e.message || e)
          }
        }
      </script>
  ```

- [ ] **Step 4: Sanity check**

```bash
grep -c 'src-source' extension-test.html
# Expected: >= 3 (label for, select id, JS handler)
grep -c 'debug_source_one_shot' extension-test.html
# Expected: 1 (the send() call)
grep -c 'src-item-id' extension-test.html
# Expected: >= 3
```

- [ ] **Step 5: Commit**

```bash
git add extension-test.html
git commit -m "$(cat <<'EOF'
feat(ext): test harness — Source one-shot fieldset (Pexels/Freepik)

New fieldset "6. Source one-shot (Ext.3)" with a source dropdown
(pexels|freepik), item_id input, trigger button, and inline reply
pretty-print. Pre-fills source=pexels and item_id=856971 (public
Pexels sample) so the user can smoke the happy path without
hunting for an id.

Inputs persist to localStorage so reloads keep the last-used
values. Callout surfaces the backend-required-on-3001 + JWT
prereqs + Freepik-is-billable caveats before the click.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend README — Ext.3 section

**Files:**
- Modify: `extension/README.md`

- [ ] **Step 1: Append the Ext.3 section**

Open `extension/README.md`. After the last section (the Ext.2 "Manifest changes" block ending with `Ext.5.`), append:

Use Edit with an `old_string` anchor on the Ext.2 section's last lines. Match on the Ext.2 closing bullet:

- `old_string`:
  ```
    - `host_permissions` (new): `elements.envato.com/*`,
      `app.envato.com/*`,
      `video-downloads.elements.envatousercontent.com/*`.
    - No `cookies` / `power` permissions yet — those land in Ext.4 /
      Ext.5.
  ```
- `new_string`:
  ```
    - `host_permissions` (new): `elements.envato.com/*`,
      `app.envato.com/*`,
      `video-downloads.elements.envatousercontent.com/*`.
    - No `cookies` / `power` permissions yet — those land in Ext.4 /
      Ext.5.

    ## Ext.3 — Pexels + Freepik single item

    Ext.3 adds the second real download flow: end-to-end server-proxied
    download of ONE Pexels OR ONE Freepik item via the backend's
    `POST /api/pexels-url` and `POST /api/freepik-url` endpoints. No
    queue, no dedupe — just prove the server-proxied pipeline works
    end-to-end for both sources.

    ### Trigger via the dev test harness

    1. Backend running on :3001 (Phase 1). `PEXELS_API_KEY` set in the
       repo's `.env`. Optionally `FREEPIK_API_KEY` — unset triggers a
       503 / `freepik_unconfigured` error path (also a valid test).
    2. `npm run dev:client` (port 5173).
    3. Open `http://localhost:5173/extension-test.html`.
    4. Fieldset **"2. Session"** → click **Send {type:"session", …}** to
       mint a mock JWT into `chrome.storage.local`.
    5. Fieldset **"6. Source one-shot (Ext.3)"** → pick `pexels` from
       the dropdown, leave `item_id` at `856971` (public Pexels sample)
       → click **Run source download**.

    The file lands in `~/Downloads/transcript-eval/pexels_856971.mp4`.
    Freepik runs the same flow; the filename pattern is
    `freepik_<id>.<ext>` where `<ext>` comes from the backend-returned
    filename (typically `.mp4`).

    ### Caveats

    - **Backend required.** The extension posts to `BACKEND_URL/api/
      <source>-url`. If the backend isn't running, the handler replies
      `{ok:false, errorCode:"network_error", detail: ...}` and stops.
    - **JWT required.** Every backend call sends `Authorization: Bearer
      <jwt>`. If `chrome.storage.local` has no JWT (or it's expired),
      the handler replies `{ok:false, errorCode:"no_jwt"}` or
      `{ok:false, errorCode:"jwt_expired"}`. Mint a JWT via fieldset 2
      before firing fieldset 6. Real 401 recovery is Ext.4.
    - **Freepik is billable.** Every successful
      `POST /api/freepik-url` call invokes Freepik's
      `/v1/videos/:id/download`, which costs €0.05. The test harness
      surfaces this in the fieldset callout; don't spam the button.
    - **Freepik URL TTL.** Backend mints with a conservative 15-min
      expiry. If somehow 14+ minutes elapse between mint and
      `chrome.downloads.download` (near-impossible in a debug one-shot),
      the extension aborts with `freepik_url_expired`. Full
      refetch-on-expiry lands in Ext.5/Ext.7.
    - **`freepik_unconfigured` is a first-class fatal-for-that-item.**
      If the backend's `FREEPIK_API_KEY` is unset, `POST /api/freepik-url`
      returns 503 and the handler replies
      `{ok:false, errorCode:"freepik_unconfigured"}`. The user's
      other sources (Envato, Pexels) keep working; only Freepik items
      fail. This is the expected path when Freepik isn't wired yet.

    ### Error codes emitted

    `pexels_404`, `pexels_api_error`, `freepik_404`, `freepik_429`,
    `freepik_unconfigured`, `freepik_api_error`, `freepik_url_expired`,
    `no_jwt`, `jwt_expired`, `network_error`, `chrome_downloads_error`,
    `bad_input`, `unhandled_error`.

    Ext.7 adds the retry matrix keyed off these strings. Do NOT rename
    them without also updating Ext.7's mapping.

    ### Manifest changes (0.2.0 → 0.3.0)

    - `permissions`: unchanged from Ext.2 (`storage`, `tabs`,
      `webNavigation`, `downloads`).
    - `host_permissions` (added): `videos.pexels.com/*`,
      `images.pexels.com/*`, `*.freepik.com/*`.
    - No `cookies` / `power` permissions yet — those land in Ext.4 /
      Ext.5.
  ```

- [ ] **Step 2: Commit**

```bash
git add extension/README.md
git commit -m "$(cat <<'EOF'
docs(ext): README — Ext.3 Pexels/Freepik source section

Documents the dev-test trigger path, file-location expectation, and
the five caveats that matter for the first server-proxied flow:
backend on :3001 required; JWT required; Freepik is billable;
Freepik URL TTL grace; freepik_unconfigured is surfaced, not fatal
for other items.

Lists the full error-code taxonomy Ext.7's retry matrix keys off.
Adds the 0.2.0 → 0.3.0 manifest delta (host_permissions only).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual load-unpacked smoke test (no commit)

End-to-end verification. Human-driven. This is the Ext.3 acceptance gate — do not skip or shortcut.

**Prereq:** Dev server running on port 5173 (vite). Phase 1 backend running on port 3001 (`node --env-file=.env server/index.js`). `PEXELS_API_KEY` set in `.env`. `FREEPIK_API_KEY` optional — the plan tests BOTH the "set" and "unset" paths (see Step 7).

- [ ] **Step 1: Start backend + vite dev**

In terminal 1 (keep backend up):
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
# If backend isn't already running:
node --env-file=.env server/index.js &
# Confirm it's up:
curl -s http://localhost:3001/health | head -3 || echo "backend not responding"
```

In terminal 2 (vite):
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext3"
npm install
npm run dev:client
```

Expected: `Local: http://localhost:5173/` line in the vite output. If 5173 is taken, free it (do NOT touch 3001).

- [ ] **Step 2: Reload the extension**

1. `chrome://extensions` in Chrome.
2. Find **transcript-eval Export Helper**, ID matches `extension/.extension-id`.
3. Click the refresh/reload arrow on the extension card. The service worker stops and restarts with the new manifest (Task 1) and the new handler (Task 4).
4. On the card, click **service worker** to open the SW DevTools. Keep this window open — the Phase A/B/C console logs surface here.
5. Card should show version **0.3.0** (Task 1 bump). If it still says 0.2.0, the reload didn't take — remove + reload unpacked from `extension/` again.

- [ ] **Step 3: Regression check — ping still works**

1. Open `http://localhost:5173/extension-test.html`.
2. Paste the extension ID if needed (localStorage should already have it).
3. Click **Send {type:"ping"}**.
4. Expect: `{type:"pong", version:1, ext_version:"0.3.0", envato_session:"missing", has_jwt:false_or_true, jwt_expires_at:…}`.
5. `ext_version` should now be `"0.3.0"`. If it still reads `0.2.0`, config.js didn't reload — hard reload the extension.

- [ ] **Step 4: Mint a JWT via the session round-trip**

1. Fieldset **"2. Session"** → click **Send {type:"session", …}** (the happy-path one, `expires_at: now+1h`).
2. Expect `{ok: true}`.
3. Re-ping → `has_jwt` should be `true`.

Without this step, Task 7 Step 5+ will return `no_jwt` and not exercise the happy path.

- [ ] **Step 5: Pexels happy path**

1. Scroll to fieldset **"6. Source one-shot (Ext.3)"**.
2. `source` dropdown: `pexels`.
3. `item_id`: `856971` (public Pexels sample, pre-filled).
4. Click **Run source download**.
5. Watch two surfaces in parallel:
   - **Test page `#out-source`** — should show `…` then the reply object within ~1-3 seconds.
   - **SW DevTools console** — should print:
     ```
     [sources] phase A mint OK (pexels) {itemId: "856971", filename: "pexels_856971.mp4", ms: 500-1500}
     [sources] phase C download started (pexels) {downloadId: <int>, ms: 50-200, total_ms: 600-2000}
     ```
     (Phase B is Freepik-only; no log line for Pexels.)
6. Test page reply:
   ```json
   {
     "ok": true,
     "filename": "pexels_856971.mp4",
     "downloadId": <int>,
     "size_bytes": null
   }
   ```
7. `#source-status` should show `OK in <N>ms` in green.

- [ ] **Step 6: Verify the Pexels file**

1. Open Finder → `~/Downloads/transcript-eval/`.
2. A file named `pexels_856971.mp4` should be present, multi-MB, playable in VLC.

If the file appears with size 0 or doesn't play:
- Check SW console for chrome.downloads.download error (the `downloadId` will still appear even if the file later fails).
- Check `chrome://downloads` for the download row and its error status.
- If Pexels changed its CDN or the ID, try a different public Pexels video id.

- [ ] **Step 7: Freepik error path — `freepik_unconfigured` (no billable cost)**

**Prerequisite for this step:** `FREEPIK_API_KEY` is either unset in `.env` OR the backend is started without it. Check:

```bash
grep FREEPIK_API_KEY "/Users/laurynas/Desktop/one last /transcript-eval/.env"
# If line is missing or blank, you'll hit the unconfigured path automatically.
# If it's set and you want to SKIP the billable live test, temporarily comment the line, restart backend, run this step, restore.
```

1. Fieldset 6 → `source` dropdown: `freepik`.
2. `item_id`: `123456` (any value — the backend 503s before consulting Freepik).
3. Click **Run source download**.
4. Expect within ~500ms:
   - SW console: `[sources] phase A mint OK` line does NOT appear (mint throws).
   - Test page reply:
     ```json
     {
       "ok": false,
       "errorCode": "freepik_unconfigured",
       "detail": "freepik_unconfigured"
     }
     ```
   - `#source-status`: `FAIL in <N>ms` in red.
5. No file in `~/Downloads/transcript-eval/`.

This step verifies the 503 → `freepik_unconfigured` path WITHOUT costing €0.05. If `FREEPIK_API_KEY` IS set, run Step 7b instead.

- [ ] **Step 7b (optional): Freepik happy path (costs €0.05)**

Skip if `FREEPIK_API_KEY` is unset.

1. Fieldset 6 → `source: freepik`.
2. `item_id`: a real Freepik video id you have access to (e.g. from adpunk.ssh search pipeline results). Phase 1 backend doc line 1305-1307 has example curl flow.
3. Click **Run source download**.
4. Expect:
   - SW console: `[sources] phase A mint OK (freepik) {filename: "freepik_<id>.mp4", ms: 500-2000}` then `[sources] phase C download started`.
   - Test page reply:
     ```json
     {
       "ok": true,
       "filename": "freepik_<id>.mp4",
       "downloadId": <int>,
       "size_bytes": <number>
     }
     ```
5. File lands at `~/Downloads/transcript-eval/freepik_<id>.mp4`.
6. **Note: this call cost €0.05.** Only run once per verification round.

- [ ] **Step 8: Pexels 404 path**

1. Fieldset 6 → `source: pexels`.
2. `item_id`: `99999999999` (or any obviously invalid id).
3. Click **Run source download**.
4. Expect:
   - Test page reply:
     ```json
     {
       "ok": false,
       "errorCode": "pexels_404",
       "detail": "pexels_404"
     }
     ```
   - No file written.

If the backend instead returns 400 (depending on how Phase 1's "not found" path resolves — the Phase 1 plan Task 7 Step 4 shows both possibilities), the errorCode will be `pexels_api_error`. Both are acceptable for Ext.3; the takeaway is that the handler doesn't crash and writes no file.

- [ ] **Step 9: `no_jwt` path**

1. In the SW DevTools console:
   ```js
   await chrome.storage.local.clear()
   ```
2. Re-ping from fieldset 1 → `has_jwt: false`.
3. Fieldset 6 → `source: pexels`, `item_id: 856971`.
4. Click **Run source download**.
5. Expect:
   - Test page reply: `{"ok":false,"errorCode":"no_jwt","detail":"no_jwt"}`.
   - No file written.
6. Re-run Step 4 to restore the JWT before moving on.

- [ ] **Step 10: Regression check — Envato one-shot still works (no license commit if you pass an invalid URL)**

1. Fieldset **"5. Envato one-shot (Ext.2)"** is still there.
2. Paste `item_id: FAKEITM`, `envato_item_url: https://elements.envato.com/stock-video/does-not-exist-FAKEITM-123456789`.
3. Click. Expect `{"ok":false,"errorCode":"resolve_timeout",...}` after ~15s. This confirms Ext.2 still routes correctly under the 0.3.0 manifest — no license committed.

(If you have a real Envato item handy and want a full-stack regression check, go ahead; remember a license commit is real.)

- [ ] **Step 11: Regression check — popup still renders**

1. Click the extension toolbar icon.
2. Popup should show two rows (transcript-eval, Envato) identical to Ext.1/Ext.2, with version `v0.3.0` in the header.
3. Close popup.

- [ ] **Step 12: Do NOT commit anything from this task**

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

If any of Steps 5-10 fail:
- **Step 5 reply is `{ok:false, errorCode:"network_error"}`** → backend not running on :3001 or `BACKEND_URL` mismatch. Check `curl http://localhost:3001/health`.
- **Step 5 reply is `{ok:false, errorCode:"no_jwt"}`** → Step 4 didn't persist the JWT. Re-run fieldset 2's session button.
- **Step 5 reply is `{ok:false, errorCode:"pexels_api_error"}`** → backend `PEXELS_API_KEY` missing or Pexels API rate-limited. Check backend log.
- **Step 5 reply is `{ok:true}` but no file appears in Downloads** → chrome.downloads.download silently failed. Check `chrome://downloads`. Likely the CDN URL is 403ing; confirm host_permissions includes `videos.pexels.com`.
- **Step 7 reply is `{ok:true}` instead of `freepik_unconfigured`** → `FREEPIK_API_KEY` IS set; either skip Step 7 (use Step 7b) or temporarily unset the key for this verification.

---

## Task 8: Final review + DO NOT push

**Files:** (none — review only)

- [ ] **Step 1: Full branch review**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext3"
# Substitute main if Ext.2 has merged
git log --oneline feature/extension-ext2-envato-single..HEAD
# Expected: 6 commits — Task 1 (manifest), Task 2 (config), Task 3 (sources.js),
# Task 4 (service_worker), Task 5 (test harness), Task 6 (README).
# Task 0 has no commit (worktree setup). Task 7 is verification-only.

git diff feature/extension-ext2-envato-single --stat
# Expected additions (approximate):
#   extension-test.html                              |  60+
#   extension/README.md                              |  70+
#   extension/config.js                              |   8+
#   extension/manifest.json                          |   4+
#   extension/modules/sources.js                     | 160+
#   extension/service_worker.js                      |  32+
```

If `git diff` surfaces anything outside `extension/` or `extension-test.html`, investigate. Revert unrelated changes before finalizing.

- [ ] **Step 2: DO NOT push**

Per user convention: `git push` requires explicit consent. This task's acceptance is "all 6 commits on the local branch, branch ready for review." Surface the branch name + last commit sha to the user; ask before pushing.

```bash
git log -1 --oneline
git branch --show-current
# Report these two lines to the user along with the acceptance summary.
```

---

## Self-review against the spec

After completing Tasks 0–8, re-read the following spec sections:

**Roadmap (`docs/specs/2026-04-24-export-remaining-roadmap.md`) § "Ext.3 — Pexels + Freepik single item"** coverage check (lines ~231-251):

- "Same prove-one-item shape as Ext.2" — ✓ debug handler + one module + one test fieldset.
- Files listed: `extension/modules/sources.js` — ✓ Task 3.
- `extension/service_worker.js` — add `{type:"debug_source_one_shot", source, item_id}` dev handler — ✓ Task 4.
- "Error handling for `freepik_unconfigured` (503 from backend — treat as fatal for that item)" — ✓ `sources.js` throws `'freepik_unconfigured'`, handler replies with `errorCode` and `ok:false`, file-not-written; covered in Task 7 Step 7.
- Freepik URL TTL: "use the `expires_at` from backend response; if file not started within 60s of mint, refetch. No parsing of the `exp=...` token yet." → **Intentional deviation:** Ext.3 implements only the 60-second grace ABORT (`freepik_url_expired`); refetch logic is punted to Ext.7. The roadmap's wording "refetch" is taken as forward-looking (Ext.5+), and the in-plan rationale is stated under `isUrlLikelyExpired` in Task 3 and the Why-read-this blurb. If the user wants Ext.3 to include refetch, surface this as an open question before execution.
- "No dedupe per run (Ext.5)" — ✓ explicit in Deferred.
- "Dev handler emits `item_downloaded` or `item_failed` events via a stub telemetry module (real telemetry in Ext.6)" — **Intentional deviation:** Ext.3 returns reply objects; no stub telemetry module is created. Telemetry is Ext.6 exclusively. Surface this if the user wants the stub.
- Verification: "one Pexels ID + one Freepik ID (when `FREEPIK_API_KEY` is configured; mock Freepik via fixture otherwise)" — Ext.3 replaces the mock-Freepik-via-fixture with the simpler 503-path verification (Task 7 Step 7). Fixture-based mock mode is Ext.5 work.

**Extension spec (`docs/specs/2026-04-23-envato-export-extension.md`) § server-proxied endpoints** coverage check:

- `POST /api/pexels-url` request `{item_id, preferred_resolution}`, response `{url, filename, size_bytes, resolution}` — ✓ `fetchPexelsUrl` in sources.js.
- `POST /api/freepik-url` request `{item_id, format}`, response `{url, filename, size_bytes, expires_at}` — ✓ `fetchFreepikUrl`.
- Bearer JWT required — ✓ `buildAuthHeaders` enforced on every call.
- "Pexels URLs are permanent; no refresh needed" — ✓ isUrlLikelyExpired is no-op for Pexels (no `expires_at` in response, returns false).
- "Freepik URLs are signed and short-lived (typically 15-60 min). Extension must respect `expires_at` and refetch on expiry" — ✓ grace check implemented; refetch deferred to Ext.7 (explicit).

**Ext.3 scope hold-the-line check:**

- No queue, concurrency > 1, pause/resume/cancel ✓
- No 401 recovery (Ext.4 owns that) ✓
- No dedupe (Ext.5) ✓
- No TTL refetch (Ext.7) ✓
- No telemetry (Ext.6) ✓
- No Envato code touched ✓
- No rate-limit handling beyond surfacing error ✓
- No icons ✓
- No `cookies` / `power` permissions ✓

---

## Inputs parked for Ext.4+

These are NOT used in Ext.3 — capturing here so they aren't lost when the relevant downstream phase picks up:

**For Ext.4 (auth polish / 401 recovery / Port):**

- `no_jwt` / `jwt_expired` / HTTP 401 from backend currently return `errorCode` and stop. Ext.4 replaces this with: pause run, post `{type:"refresh_session"}` on Port, wait for a new token, resume. Hook points:
  - `buildAuthHeaders` throws `no_jwt` / `jwt_expired` before the fetch — Ext.4 adds a refresh-and-retry here.
  - The fetch itself currently has no 401 branch (Pexels/Freepik backend endpoints don't distinguish 401 from other 4xx in Ext.3's error mapping — they fall into `pexels_api_error` / `freepik_api_error`). Ext.4 adds explicit 401 handling.
- The debug handler comment in `service_worker.js` says "REQUIRES a valid JWT." Ext.4's real flow can retry automatically; revisit the comment.

**For Ext.5 (queue + concurrency + persistence):**

- `runId` parameter is already threaded through `downloadSourceItem({runId})` and ignored. Ext.5 wires it to the `transcript-eval/export-<runId>/media/<filename>` path template.
- `isUrlLikelyExpired` is the hook point for refetch-on-expiry: Ext.5's queue will see a non-zero gap between mint and download, so expand the helper into a "refetch if Freepik URL expired" wrapper around `fetchFreepikUrl`.
- No dedupe in Ext.3 — same `itemId` twice in one run downloads twice. Ext.5's queue adds per-run dedupe keyed by `<source>:<itemId>`.

**For Ext.6 (telemetry):**

- `downloadSourceItem` currently returns `{ok, filename, downloadId, size_bytes}` / `{ok:false, errorCode, detail}`. Ext.6 adds event emission (`item_mint_ok`, `item_downloaded` / `item_failed`). Either add an optional `emit` callback, or have the SW handler emit based on the reply.

**For Ext.7 (failure-mode polish):**

- The error-code taxonomy from Ext.3 (`pexels_404`, `pexels_api_error`, `freepik_404`, `freepik_429`, `freepik_unconfigured`, `freepik_api_error`, `freepik_url_expired`, `network_error`, `no_jwt`, `jwt_expired`, `chrome_downloads_error`, `bad_input`) is the set Ext.7's retry matrix keys off. Don't change the strings without updating Ext.7 in lockstep.
- Freepik 429 currently stops. Ext.7 spec line 1226: "Pause 5 min, retry once. If still 429, hard stop. Admin Slack." Hook point: the `if (resp.status === 429) throw new Error('freepik_429')` line in `fetchFreepikUrl`.
- `freepik_url_expired` currently stops. Ext.7 adds refetch-and-retry at the `downloadSourceItem` orchestration level.

**Open risks / questions that need user confirmation:**

- **Freepik refetch in Ext.3 vs. Ext.7** — Roadmap lines 243-244 say "if file not started within 60s of mint, refetch." This plan implements a 60-second ABORT check (no refetch). Rationale: refetch is a loop with its own cost model (€0.05 per Freepik call — can't re-spend lightly) and is better sized with Ext.5's queue, where `runId` threading exists. If you want refetch inside Ext.3 instead of Ext.7, surface as an open question before Task 3 implementation.
- **Telemetry stub in Ext.3 vs. Ext.6** — Roadmap line 245 says "Dev handler emits `item_downloaded` or `item_failed` events via a stub telemetry module." This plan does not create `modules/telemetry.js` — the debug handler returns reply objects and the plan punts ALL telemetry to Ext.6. Rationale: one stub file per phase is easy to let drift into the permanent architecture; creating it at the same time as the real one (Ext.6) keeps the contract clean. If you want the stub in Ext.3, surface as an open question.
- **`images.pexels.com` in host_permissions** — Not strictly needed for Ext.3 (we only download Pexels VIDEOS), but declared now to avoid an Ext.5 manifest bump. Cheap to include but listed here in case a reviewer prefers MVP-strict manifest.
- **Pexels "sample id" `856971` in test-harness pre-fill** — Verified stable on Pexels's CDN as of the Phase 1 plan (line 1131). If it's dead-linked by the time Task 7 runs, pick any public Pexels video id from https://www.pexels.com/search/videos/.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-extension-ext3-pexels-freepik.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Task 7's manual smoke stays with the human driver regardless.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints before Task 7.

Which approach?
