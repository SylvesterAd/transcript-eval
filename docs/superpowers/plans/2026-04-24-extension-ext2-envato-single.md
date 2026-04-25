# Ext.2 — Envato Single-Item Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Ext.2 of the transcript-eval Export Helper Chrome extension — the first real download flow. End-to-end licensed download of **exactly one Envato item** via the 3-phase pipeline: (1) resolve `elements.envato.com/…` → `app.envato.com/<UUID>` via a hidden tab + `chrome.webNavigation.onCommitted`, (2) call `app.envato.com/download.data?itemUuid=…` with the user's session cookies and extract the signed URL from the Remix streaming response, (3) save the file via `chrome.downloads.download`. No queue, no concurrency (cap=1), no telemetry, no partial-run logic — just prove the pipeline works against a real Envato subscription. A cheap ZIP/AEP/PRPROJ filetype safety net IS in scope because it prevents the single test download from burning an Envato license on a file Premiere can't import.

**Architecture:** Ext.2 adds one new module — `extension/modules/envato.js` — and one new message type to the existing service-worker router (`{type:"debug_envato_one_shot"}`). The orchestration is linear and single-threaded: resolver → licenser → ZIP check → downloader → reply. All three phases live in the service worker; no content scripts, no offscreen documents, no long-lived Port (Port lands in Ext.4/Ext.5). The tab-based resolver is non-negotiable — the `elements.envato.com` → `app.envato.com` redirect only materialises in a real authenticated browser context, so `fetch()` tricks are skipped. The test page adds a dedicated fieldset that fires the debug one-shot; reply is pretty-printed in-line.

**Tech Stack:** Chrome MV3 (unchanged from Ext.1), vanilla JS ES modules, `chrome.tabs.create` + `chrome.webNavigation.onCommitted` for the resolver, `fetch(..., {credentials: 'include'})` for Phase 2 licensing, `chrome.downloads.download` for Phase 3, existing transcript-eval vite dev server (`:5173`) for the test harness.

---

## Why read this before touching code

Seven invariants — skim them before opening any file. They are the load-bearing pieces; everything else is mechanical.

1. **License is COMMITTED on Phase-2 success.** `GET download.data` increments the user's Envato fair-use counter whether or not we subsequently write the file. Never call Phase 2 on a timer, a retry, a page-load, or any code path that isn't a direct consequence of a user clicking a button. Ext.2 has exactly one entry point: the `{type:"debug_envato_one_shot"}` message, which is only fired from the test page by a human click. If you find yourself writing `setInterval` or `onCommitted` → `getSignedDownloadUrl`, stop and re-read this line.

2. **Resolver is tab-based, not fetch-based.** `elements.envato.com/<old-slug>` issues a cross-origin redirect chain (including a client-side `window.location` hop) to `app.envato.com/<segment>/<UUID>`. That chain only completes in a fully authenticated browser context. `chrome.tabs.create({url, active: false})` + `chrome.webNavigation.onCommitted` is the prescribed pattern; the commit fires on every frame/navigation of that tab, including the final hop — filter by `tabId` match and a regex against `app.envato.com/<segment>/<UUID>`. Always remove the tab and detach the listener in ALL paths (resolve, reject, 15-second timeout).

3. **Concurrency cap = 1 in Ext.2.** Ext.2 serves one item per user click. Ext.5 raises the resolver cap to 5 and the downloader cap to 3. The `MAX_RESOLVER_CONCURRENCY = 1` constant is added to `config.js` so that Ext.5 has a single obvious place to bump. Do NOT ship a pool/semaphore; a bare `await` is the concurrency primitive.

4. **ZIP safety net IS in Ext.2.** The full deny-list, `chrome.storage.local` persistence, and per-24h rate-limited telemetry land in Ext.7. But the cheap, synchronous check — parse `response-content-disposition` out of the signed URL, bail if the filename ends `.zip|.aep|.prproj` — is trivial to add now and prevents wasting a license on a motion-graphics item that Premiere can't open. One extra regex and an early return. Do include it.

5. **No JIT URL refetching yet.** Signed URLs from `download.data` live ~1 hour. For a single user-triggered download, the time between `getSignedDownloadUrl` and `chrome.downloads.download` is milliseconds. Ext.5 adds the refetch-if-stale logic for the queue; Ext.2 does not need it.

6. **JWT from Ext.1 storage; no backend call yet.** `/api/session-token` is already live (Phase 1 backend) but Ext.2 doesn't call it. The debug handler uses the JWT already in `chrome.storage.local` from Ext.1's `{type:"session"}` round trip — and actually, the handler doesn't *require* the JWT to be present since the debug flow doesn't post telemetry yet. Document this in the test-page UI.

7. **The filename scheme is intentionally flat.** `envato_<id>.<ext>` into `~/Downloads/transcript-eval/`, where `<ext>` is inferred from the signed URL's content-disposition filename (`.mov` most of the time, sometimes `.mp4`; fallback `.mov` if extraction fails). The full `<NNN>_<source>_<id>` numbering and the per-run `export-<runId>/media/` subfolder wait for Ext.5, which introduces the run concept. `runId` is accepted as a parameter today for forward compatibility but is ignored in the path.

---

## Scope (Ext.2 only — hold the line)

### In scope

- `extension/modules/envato.js` — new module exporting three public functions (`resolveOldIdToNewUuid`, `getSignedDownloadUrl`, `downloadEnvato`) + two private helpers (`extractDownloadUrlFromRemixStream`, `extractFilenameFromSignedUrl`).
- `extension/service_worker.js` — extend the existing `onMessageExternal` switch with one new case: `'debug_envato_one_shot'`.
- `extension/manifest.json` — add `tabs`, `webNavigation`, `downloads` to `permissions`; add three entries to `host_permissions`; bump `version` from `0.1.0` to `0.2.0`.
- `extension/config.js` — add `RESOLVER_TIMEOUT_MS = 15000` and `MAX_RESOLVER_CONCURRENCY = 1`; bump `EXT_VERSION` to `0.2.0`.
- `extension/fixtures/envato/.gitkeep` — placeholder directory so Ext.5's fixture work has a home.
- ZIP/AEP/PRPROJ filetype safety net (Phase 2.5) — the cheap regex check that aborts before `chrome.downloads.download`.
- `extension-test.html` — new fieldset "Envato one-shot" with two inputs, one button, one `<pre>` for the reply.
- `extension/README.md` — append a "Ext.2 — Envato single item" section documenting trigger, expected file path, license-commit warning.
- Manual smoke verification task (no commit) mirroring Ext.1's Task 7 pattern.

### Deferred (DO NOT add to Ext.2 — they belong to later phases)

- **Pexels / Freepik** → Ext.3. No `modules/sources.js` in this phase.
- **Real 401 recovery / session refresh / cookie watcher** → Ext.4. Ext.2 surfaces 401 as `envato_session_missing` and stops.
- **Queue / concurrency > 1 / pause / resume / cancel / keep-awake** → Ext.5. Single bare `await` is fine here.
- **Telemetry to `/api/export-events`** → Ext.6. No `modules/telemetry.js`, no POST.
- **Full per-error retry matrix** (402 tier-restricted, 403 hard-stop, 429 Retry-After + jitter, empty-downloadUrl, 5xx backoff, etc.) → Ext.7. Ext.2 throws a coarse `envato_<code>` and lets the caller see it.
- **Persistent deny-list** + telemetry rate-limiting for `envato_unsupported_filetype` → Ext.7. Ext.2 returns `{ok:false, errorCode:'envato_unsupported_filetype'}` but does NOT persist.
- **oldId → newUuid cache in `chrome.storage.local`** → Ext.5. Every Ext.2 call re-resolves; the 1-second cost is fine for a single test download.
- **JIT URL refetching** (re-call `download.data` if the signed URL aged past ~1h) → Ext.5.
- **Run concept / `export-<runId>/media/` subfolder / multi-item sequencing (`<NNN>_<source>_<id>`)** → Ext.5. Ext.2 writes directly under `transcript-eval/`.
- **Resolution / variant picker** (`assetUuid` param, resolution selection UI) → post-MVP. Ext.2 uses "always highest" by omitting `assetUuid` per the spec's Resolution Selection section.
- **Long-lived `chrome.runtime.Port`** → Ext.4 is where the first real Port lands.
- **`cookies` permission** → Ext.4 (cookie watcher). Ext.2 relies on `credentials:'include'` + host_permissions alone; see the "Open risks" section.
- **`power` permission** → Ext.5 (keep-awake).
- **Icons** → still deferred (Chrome default is fine for dev).
- **Real captured HAR fixtures** → Ext.5+ mock-mode work. Ext.2 only creates the empty `fixtures/envato/` directory.
- **CI packaging / Chrome Web Store prep** → Ext.10 / Ext.11.
- **`/api/ext-config` fetch / feature flags** → Ext.9.

If you catch yourself reaching for any of the Deferred list items, stop. Ext.2 proves the pipeline; adding anything above makes this phase bigger than it needs to be and blocks the single most important question: *does our 3-phase flow work against a real authenticated Envato account?*

See `docs/specs/2026-04-24-export-remaining-roadmap.md` § "Part C — Extension Ext.2 → Ext.12" for the per-phase boundary definitions.

---

## Prerequisites

- **Ext.1 merged or working in parallel branch with the pinned extension ID.** If Ext.1 has merged to `main` by the time you start, branch from `main`; otherwise branch from `feature/extension-ext1`. Either way, `extension/.extension-id` must exist and be committed before Ext.2 work begins (everything downstream assumes the ID is stable).
- **A real Envato account with an active subscription** on the dev machine's Chrome profile. License commits in Phase 2 are real — every click of the test button ticks the user's fair-use counter. See the "Open risks" section for budget guidance.
- **Signed in to Envato** in the same Chrome profile that loads the unpacked extension. The resolver's hidden tab needs the session cookies; Phase 2's `fetch(..., {credentials:'include'})` needs them too.
- **Chrome 120+** (already an Ext.1 prereq).
- **Node 20+** (already used by transcript-eval; no new packages added in Ext.2).

Note: Path to the repo has a trailing space in `"one last "` — quote every path.

---

## File structure (Ext.2 final state)

Additions over Ext.1 are marked `[NEW Ext.2]`; modifications are `[MOD Ext.2]`; unchanged Ext.1 files are shown for context without annotation.

```
$TE/extension/
├── manifest.json                  [MOD Ext.2] version 0.1.0 → 0.2.0; permissions +tabs/+webNavigation/+downloads; new host_permissions block
├── service_worker.js              [MOD Ext.2] new case 'debug_envato_one_shot'
├── config.js                      [MOD Ext.2] +RESOLVER_TIMEOUT_MS, +MAX_RESOLVER_CONCURRENCY, EXT_VERSION bump
├── popup.html                     (unchanged)
├── popup.css                      (unchanged)
├── popup.js                       (unchanged)
├── .extension-id                  (unchanged — key pinned in Ext.1)
├── README.md                      [MOD Ext.2] append "Ext.2 — Envato single item" section
├── modules/
│   ├── auth.js                    (unchanged)
│   └── envato.js                  [NEW Ext.2] resolver + licenser + downloader orchestration
├── scripts/
│   └── generate-key.mjs           (unchanged)
└── fixtures/
    └── envato/
        └── .gitkeep               [NEW Ext.2] placeholder; real fixtures in Ext.5

$TE/extension-test.html            [MOD Ext.2] new fieldset "Envato one-shot"
```

Why this split:
- `modules/envato.js` is the sole owner of the Envato 3-phase orchestration. Later phases will add `modules/sources.js` (Pexels/Freepik) and `modules/queue.js` (Ext.5); keeping Envato in its own file means those additions don't have to refactor Ext.2.
- Helpers (`extractDownloadUrlFromRemixStream`, `extractFilenameFromSignedUrl`) stay file-private (non-exported) for Ext.2 — if Ext.7's failure matrix or Ext.5's queue need them, promote then. Don't export speculatively.
- `fixtures/envato/.gitkeep` establishes the directory conventionally; actual HAR capture is a separate skill that belongs to Ext.5's mock-mode work.
- The debug message handler lives in `service_worker.js` directly (not a separate `modules/debug.js`) because it's ~10 lines and there's no other debug infrastructure to co-locate with. If Ext.3 adds `debug_source_one_shot`, revisit.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/extension-ext2` on branch `feature/extension-ext2-envato-single`. If Ext.1 has merged to `main`, branch from `main`; otherwise branch from `feature/extension-ext1`. The plan's bash uses `main` as the branch-point but Task 0 includes both variants — pick the right one based on `git branch -a | grep extension-ext1`.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan. Task 8 has an explicit "DO NOT push" reminder.
- **Never kill anything on port 3001.** User's backend dev server.
- **Commit style:** conventional commits (`feat(ext): ...`, `chore(ext): ...`, `docs(ext): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing in every shell call.
- **License commits are real.** Each manual-test click through Task 7 debits the user's Envato fair-use counter. Before running a manual test step, re-read that step's warning.

---

## Task 0: Create worktree + branch

**Files:**
- Create: `$TE/.worktrees/extension-ext2/` (worktree)

- [ ] **Step 1: Decide the branch-point**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin
git branch -a | grep extension-ext1 || echo "no ext1 branch"
```

- If `feature/extension-ext1` still exists (not yet merged to `main`), branch Ext.2 FROM `feature/extension-ext1`:
  ```bash
  git worktree add -b feature/extension-ext2-envato-single .worktrees/extension-ext2 feature/extension-ext1
  ```
- If Ext.1 has already merged, branch from `main`:
  ```bash
  git worktree add -b feature/extension-ext2-envato-single .worktrees/extension-ext2 main
  ```

Pick one. Do not create the worktree twice.

- [ ] **Step 2: Enter the worktree and verify**

```bash
cd "$TE/.worktrees/extension-ext2"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext2
git branch --show-current
# Expected: feature/extension-ext2-envato-single
ls extension/
# Expected: config.js manifest.json modules popup.css popup.html popup.js scripts service_worker.js README.md .extension-id
cat extension/.extension-id
# Expected: 32-char a-p string (identical to Ext.1)
```

If `extension/.extension-id` is missing, Ext.1 is incomplete — stop and go fix Ext.1 before proceeding. Ext.2 depends on the pinned ID.

- [ ] **Step 3: Confirm the manifest says version `0.1.0`**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions, '| has host_permissions:', !!m.host_permissions)"
# Expected: version: 0.1.0 | permissions: [ 'storage' ] | has host_permissions: false
```

If the output differs from `0.1.0` + `['storage']` + `false`, someone has already started Ext.2 work on this branch — figure out why before continuing.

There is nothing to commit in this task — creating a worktree and branch doesn't produce a file change on its own.

---

## Task 1: Update manifest — permissions, host_permissions, version bump

Manifest changes go first so that when the service worker adds `chrome.webNavigation` / `chrome.downloads` API calls in Task 3, the permission is already declared. Loading the extension with an API call that lacks its permission throws `undefined is not a function` in the SW console — a confusing class of bug worth not courting.

**Files:**
- Modify: `extension/manifest.json`

- [ ] **Step 1: Read the current manifest**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext2"
```

Open `extension/manifest.json` — it should have 4 top-level keys after `"minimum_chrome_version"`: `permissions`, `externally_connectable`, `background`, `action`, plus the `key` field pinned by Ext.1.

- [ ] **Step 2: Bump `version` from `0.1.0` to `0.2.0`**

Use the Edit tool:
- `old_string`: `"version": "0.1.0"`
- `new_string`: `"version": "0.2.0"`

Only ONE occurrence exists, so this is unambiguous.

- [ ] **Step 3: Extend the `permissions` array**

- `old_string`: `"permissions": ["storage"]`
- `new_string`: `"permissions": ["storage", "tabs", "webNavigation", "downloads"]`

Rationale:
- `tabs` — required for `chrome.tabs.create({url, active: false})` and `chrome.tabs.remove(tabId)`. (Opening a tab via `chrome.tabs.create` is possible WITHOUT `tabs`, but reading the tab object, matching on `tabId` in `webNavigation` listeners, and removing by `tabId` all need it.)
- `webNavigation` — required for `chrome.webNavigation.onCommitted`.
- `downloads` — required for `chrome.downloads.download`.
- NOT `cookies` yet — Ext.2 relies on `credentials:'include'` + `host_permissions` alone. See the open risks section.
- NOT `power` yet — keep-awake is an Ext.5 concern.

- [ ] **Step 4: Add a `host_permissions` block**

Insert a new `host_permissions` key AFTER `permissions` and BEFORE `externally_connectable`. The surrounding context looks like:

```json
  "permissions": ["storage", "tabs", "webNavigation", "downloads"],
  "externally_connectable": {
```

Use Edit:
- `old_string`:
  ```
    "permissions": ["storage", "tabs", "webNavigation", "downloads"],
    "externally_connectable": {
  ```
- `new_string`:
  ```
    "permissions": ["storage", "tabs", "webNavigation", "downloads"],
    "host_permissions": [
      "https://elements.envato.com/*",
      "https://app.envato.com/*",
      "https://video-downloads.elements.envatousercontent.com/*"
    ],
    "externally_connectable": {
  ```

Rationale for each origin:
- `https://elements.envato.com/*` — the URL we *open* in the hidden tab (old-style item page that client-side-redirects to app.envato.com).
- `https://app.envato.com/*` — both the redirect target that `webNavigation.onCommitted` matches AND the origin of the `download.data` fetch in Phase 2.
- `https://video-downloads.elements.envatousercontent.com/*` — the signed-download CDN that `chrome.downloads.download` hits in Phase 3. `host_permissions` here means cookies + `credentials:'include'` work cleanly; also permits `chrome.downloads.download` to proceed without host-permission prompts mid-download.

- [ ] **Step 5: Verify the manifest still parses**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions.length, '| host_perms:', m.host_permissions.length, '| key_present:', !!m.key)"
# Expected: version: 0.2.0 | permissions: 4 | host_perms: 3 | key_present: true
```

- [ ] **Step 6: Commit**

```bash
git add extension/manifest.json
git commit -m "$(cat <<'EOF'
feat(ext): manifest — add Envato permissions and host_permissions for Ext.2

Version 0.1.0 → 0.2.0. Permissions +tabs/+webNavigation/+downloads for
the Phase 1 resolver (hidden tab + navigation watcher) and Phase 3
downloader. New host_permissions block covers the three Envato
origins the 3-phase flow touches:
- elements.envato.com/* (the old item URL we open)
- app.envato.com/* (redirect target + download.data origin)
- video-downloads.elements.envatousercontent.com/* (signed CDN)

No cookies/power permissions yet — those land in Ext.4 / Ext.5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extend `config.js` — resolver timeout + concurrency constant

Adds two constants that `modules/envato.js` will import in Task 3. Keeps timing / concurrency knobs in one place so Ext.5's pool sizing change is a one-file edit.

**Files:**
- Modify: `extension/config.js`

- [ ] **Step 1: Read the current `config.js`**

```bash
cat extension/config.js
```

Expected shape (from Ext.1):

```js
export const EXT_VERSION = '0.1.0'
export const ENV = 'dev'
export const BACKEND_URL = ENV === 'prod'
  ? 'https://backend-production-4b19.up.railway.app'
  : 'http://localhost:3001'
export const MESSAGE_VERSION = 1
```

- [ ] **Step 2: Bump `EXT_VERSION` + add the two new constants**

Use Edit:
- `old_string`:
  ```
  export const EXT_VERSION = '0.1.0'
  ```
- `new_string`:
  ```
  export const EXT_VERSION = '0.2.0'
  ```

Then append (as a separate Edit) at the END of the file, after `MESSAGE_VERSION`:
- `old_string`: `export const MESSAGE_VERSION = 1`
- `new_string`:
  ```
  export const MESSAGE_VERSION = 1

  // Resolver timing — Phase 1 waits this long for elements.envato.com/...
  // to client-redirect to app.envato.com/<uuid>. 15s chosen to tolerate
  // a slow network + cold Envato cache without hanging forever.
  export const RESOLVER_TIMEOUT_MS = 15000

  // Concurrency cap for hidden-tab resolvers. Ext.2 serves one item per
  // user click so the cap is 1; Ext.5 raises this to 5 with a real pool.
  // Keep the constant here so the bump point is a single-line edit.
  export const MAX_RESOLVER_CONCURRENCY = 1
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
feat(ext): config — add resolver timeout + concurrency cap constants

EXT_VERSION → 0.2.0. Adds RESOLVER_TIMEOUT_MS (15s) for Phase 1 hidden
tab navigation and MAX_RESOLVER_CONCURRENCY = 1 (raised to 5 in Ext.5).
Both are single-line knobs so that Ext.5's pool sizing change is
localized.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Write `modules/envato.js` — the 3-phase orchestrator

The heart of Ext.2. One file, three public functions, two private helpers, linear orchestration.

**Files:**
- Create: `extension/modules/envato.js`

- [ ] **Step 1: Create `extension/modules/envato.js`**

Exact content:

```js
// Envato 3-phase download. Ext.2 scope: ONE item per user click. No
// queue, no pool, no retry matrix — Ext.5 and Ext.7 add those.
//
// Phase 1 — Resolve: open elements.envato.com/<old-slug> in a hidden
//   tab, wait for webNavigation.onCommitted to commit a URL matching
//   app.envato.com/<segment>/<UUID>, capture the UUID, close the tab.
// Phase 2 — License: GET app.envato.com/download.data?itemUuid=...
//   with credentials:'include'. Parse the Remix streaming response
//   for the signed URL. THIS COMMITS A LICENSE on the user's Envato
//   fair-use counter — never call without a user-initiated trigger.
// Phase 2.5 — Filetype safety net: if the signed URL's
//   response-content-disposition filename ends .zip/.aep/.prproj,
//   abort BEFORE chrome.downloads.download. (Full deny-list + 24h
//   rate-limited telemetry is Ext.7.)
// Phase 3 — Save: chrome.downloads.download() into
//   ~/Downloads/transcript-eval/<sanitizedFilename>.
//
// Orchestration is a bare `await` chain — Ext.2's concurrency cap is 1.

import { RESOLVER_TIMEOUT_MS } from '../config.js'

// Matches app.envato.com/<segment>/<UUID> where UUID is the standard
// 8-4-4-4-12 hex form. <segment> is typically "stock-video" but we
// accept any single path segment to future-proof.
const APP_URL_UUID_RE = /^https:\/\/app\.envato\.com\/[^\/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\/?#]|$)/i

// Matches the Remix streaming response field: "downloadUrl","https://..."
// The streaming format uses pairs of JSON-encoded strings; we find the
// first pair whose key is exactly "downloadUrl" and capture the URL
// that follows it.
const REMIX_DOWNLOAD_URL_RE = /"downloadUrl"\s*,\s*"(https:\/\/[^"]+)"/

// Parses the response-content-disposition filename out of an AWS-
// flavored signed URL. The query parameter name varies
// (response-content-disposition OR X-Amz-SignedHeaders-adjacent params)
// but Envato's CDN uses the literal response-content-disposition
// parameter with a URL-encoded "attachment; filename=..." value.
const CONTENT_DISPOSITION_RE = /response-content-disposition=([^&]+)/
const FILENAME_FROM_DISPOSITION_RE = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i

/**
 * Phase 1. Opens `oldUrl` in a hidden tab, waits for the client-side
 * redirect to `app.envato.com/<segment>/<UUID>`, returns the UUID,
 * and closes the tab. Rejects with Error('resolve_timeout') after
 * RESOLVER_TIMEOUT_MS.
 *
 * MUST be called only in response to a user-initiated trigger. The
 * tab is opened active:false so the user doesn't see it flash.
 */
export async function resolveOldIdToNewUuid(oldUrl) {
  const tab = await new Promise((resolve, reject) => {
    chrome.tabs.create({ url: oldUrl, active: false }, t => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve(t)
    })
  })

  return new Promise((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      if (settled) return
      settled = true
      try { chrome.webNavigation.onCommitted.removeListener(onCommitted) } catch {}
      try { chrome.tabs.remove(tab.id) } catch {}
    }

    const timer = setTimeout(() => {
      if (settled) return
      cleanup()
      reject(new Error('resolve_timeout'))
    }, RESOLVER_TIMEOUT_MS)

    const onCommitted = (details) => {
      if (settled) return
      if (details.tabId !== tab.id) return
      const match = APP_URL_UUID_RE.exec(details.url)
      if (!match) return
      clearTimeout(timer)
      cleanup()
      resolve(match[1])
    }

    chrome.webNavigation.onCommitted.addListener(onCommitted)
  })
}

/**
 * Phase 2. Commits an Envato license and returns the signed CDN URL.
 * THIS IS THE LICENSE COMMIT POINT — never speculatively. Throws on
 * 401/403/429/empty-downloadUrl/other non-OK.
 */
export async function getSignedDownloadUrl(newUuid) {
  const url = `https://app.envato.com/download.data?itemUuid=${encodeURIComponent(newUuid)}&itemType=stock-video&_routes=routes/download/route`
  let resp
  try {
    resp = await fetch(url, { credentials: 'include' })
  } catch (err) {
    throw new Error('envato_network_error: ' + String(err?.message || err))
  }

  if (resp.status === 401) throw new Error('envato_session_missing')
  if (resp.status === 402) throw new Error('envato_402')
  if (resp.status === 403) throw new Error('envato_403')
  if (resp.status === 429) throw new Error('envato_429')
  if (!resp.ok) throw new Error('envato_http_' + resp.status)

  const text = await resp.text()
  const signedUrl = extractDownloadUrlFromRemixStream(text)
  if (!signedUrl) throw new Error('envato_unavailable')
  return signedUrl
}

/**
 * Top-level orchestrator. Calls Phase 1 → Phase 2 → Phase 2.5 → Phase 3.
 * Returns {ok, filename, downloadId} on success or {ok:false, errorCode,
 * detail} on any failure. Does NOT throw — the caller is the SW message
 * handler which wants a plain reply object.
 */
export async function downloadEnvato({ envatoItemUrl, itemId, runId, sanitizedFilename }) {
  // Light sanity check. The SW message handler also validates, but
  // catching obvious errors here gives a more useful error surface.
  if (!envatoItemUrl || typeof envatoItemUrl !== 'string') {
    return { ok: false, errorCode: 'bad_input', detail: 'envatoItemUrl missing or non-string' }
  }
  if (!itemId || typeof itemId !== 'string') {
    return { ok: false, errorCode: 'bad_input', detail: 'itemId missing or non-string' }
  }

  const t0 = Date.now()
  let newUuid
  try {
    newUuid = await resolveOldIdToNewUuid(envatoItemUrl)
  } catch (err) {
    return { ok: false, errorCode: err?.message === 'resolve_timeout' ? 'resolve_timeout' : 'resolve_error', detail: String(err?.message || err) }
  }
  const t1 = Date.now()
  console.log('[envato] phase 1 resolve OK', { newUuid, ms: t1 - t0 })

  let signedUrl
  try {
    signedUrl = await getSignedDownloadUrl(newUuid)
  } catch (err) {
    return { ok: false, errorCode: err?.message || 'envato_license_error', detail: String(err?.message || err) }
  }
  const t2 = Date.now()
  console.log('[envato] phase 2 license OK', { ms: t2 - t1 })

  // Phase 2.5 — ZIP / AEP / PRPROJ safety net.
  const cdnFilename = extractFilenameFromSignedUrl(signedUrl)
  if (cdnFilename && /\.(zip|aep|prproj)$/i.test(cdnFilename)) {
    console.log('[envato] phase 2.5 safety net aborted', { cdnFilename })
    return { ok: false, errorCode: 'envato_unsupported_filetype', detail: cdnFilename }
  }

  // Derive extension from the CDN filename. Default .mov if extraction
  // failed — Envato's default for stock-video is .mov.
  let ext = 'mov'
  if (cdnFilename) {
    const m = /\.([a-z0-9]{2,5})$/i.exec(cdnFilename)
    if (m) ext = m[1].toLowerCase()
  }
  const finalFilename = sanitizedFilename || `envato_${itemId}.${ext}`

  // Phase 3 — save. runId is captured for Ext.5's per-run folder layout
  // but ignored here; Ext.2 writes flat under transcript-eval/.
  void runId

  let downloadId
  try {
    downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: signedUrl,
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
  const t3 = Date.now()
  console.log('[envato] phase 3 download started', { downloadId, ms: t3 - t2, total_ms: t3 - t0 })

  return { ok: true, filename: finalFilename, downloadId }
}

// ---- private helpers ----

// Extracts `"downloadUrl","https://..."` from a Remix streaming response.
// Returns null if not found (caller treats null as `envato_unavailable`).
function extractDownloadUrlFromRemixStream(text) {
  if (typeof text !== 'string' || !text.length) return null
  const m = REMIX_DOWNLOAD_URL_RE.exec(text)
  return m ? m[1] : null
}

// Pulls the response-content-disposition filename out of a signed URL.
// Returns the decoded filename string or null if the URL doesn't
// include that query param (in which case we fall back to the MOV
// default in the caller).
function extractFilenameFromSignedUrl(url) {
  if (typeof url !== 'string' || !url.length) return null
  const dispMatch = CONTENT_DISPOSITION_RE.exec(url)
  if (!dispMatch) return null
  let disposition
  try {
    disposition = decodeURIComponent(dispMatch[1])
  } catch {
    return null
  }
  const nameMatch = FILENAME_FROM_DISPOSITION_RE.exec(disposition)
  return nameMatch ? nameMatch[1] : null
}
```

Design notes worth reading before you start changing this file:

- **`settled` flag + try/catch on cleanup** — the resolver has three mutually exclusive exit paths (onCommitted match, timeout, `tabs.remove` throwing), and each must detach the webNavigation listener AND remove the tab. Wrapping the cleanup in `try {} catch {}` avoids a failure in `tabs.remove` (tab already closed) from turning a success into a reject.
- **`URL-encoded filename` path** — Envato's signed URLs encode the content-disposition value once in the query string; `decodeURIComponent` runs once. If the disposition uses RFC 5987 `filename*=UTF-8''…` form, the regex still captures it; the `URL-encoded` bytes inside that value stay encoded but `FILENAME_FROM_DISPOSITION_RE` only needs the trailing extension, which is ASCII, so we're fine.
- **No retry on Phase 2 errors** — The caller gets a coarse `envato_401|402|403|429|unavailable|http_<n>` code and decides what to do. Ext.7 adds the matrix (Retry-After parsing, exponential backoff, hard-stop on 403 generic, etc.). Here we surface the raw error.
- **No cache for `oldUrl → UUID`** — see the Deferred list; Ext.5 adds this.

- [ ] **Step 2: Syntax check**

```bash
node --check extension/modules/envato.js
# Expected: exit 0
```

`node --check` only validates syntax — it does NOT evaluate `chrome.*` globals (which don't exist in Node). Runtime correctness is verified in Task 7's manual smoke.

- [ ] **Step 3: Commit**

```bash
git add extension/modules/envato.js
git commit -m "$(cat <<'EOF'
feat(ext): modules/envato.js — Envato 3-phase download orchestrator

Single-file implementation of Ext.2's prove-the-pipeline flow:

Phase 1 resolveOldIdToNewUuid(oldUrl) — chrome.tabs.create hidden tab,
chrome.webNavigation.onCommitted filter on tabId + app.envato.com UUID
regex, 15s timeout, cleanup-in-all-paths. Returns the UUID.

Phase 2 getSignedDownloadUrl(newUuid) — fetch download.data with
credentials:'include', throw on 401/403/429/empty, extract signed URL
from Remix streaming response via regex. COMMITS A LICENSE; never
speculative.

Phase 2.5 — inspect response-content-disposition in signed URL;
abort if .zip/.aep/.prproj (cheap safety net; full deny-list is Ext.7).

Phase 3 — chrome.downloads.download into ~/Downloads/transcript-eval/
with conflictAction:'uniquify'.

downloadEnvato() orchestrates and returns {ok, filename, downloadId}
or {ok:false, errorCode, detail} — does not throw. Concurrency cap 1,
bare `await` chain; pool lands in Ext.5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend `service_worker.js` — add `debug_envato_one_shot` handler

One new `case` in the existing switch. Everything else stays.

**Files:**
- Modify: `extension/service_worker.js`

- [ ] **Step 1: Read the current service worker**

Confirm it matches the Ext.1 shape: a top-of-file import block, `handlePing`, `handleSession`, `isSupportedVersion`, a `chrome.runtime.onMessageExternal.addListener` with `switch (msg.type)` containing `case 'ping'`, `case 'session'`, `default`, and `return true` at the end of the listener.

- [ ] **Step 2: Add the envato import**

Use Edit:
- `old_string`:
  ```
  import { EXT_VERSION, MESSAGE_VERSION } from './config.js'
  import { getJwt, setJwt, hasValidJwt } from './modules/auth.js'
  ```
- `new_string`:
  ```
  import { EXT_VERSION, MESSAGE_VERSION } from './config.js'
  import { getJwt, setJwt, hasValidJwt } from './modules/auth.js'
  import { downloadEnvato } from './modules/envato.js'
  ```

- [ ] **Step 3: Add the `handleDebugEnvatoOneShot` helper**

Insert it immediately after `handleSession` (above `isSupportedVersion`). Use Edit:
- `old_string`:
  ```
  function isSupportedVersion(v) {
  ```
- `new_string`:
  ```
  // Ext.2 debug handler — fires the full 3-phase Envato flow for ONE
  // item. NOT user-facing; only triggered from the dev test page.
  // The message does not require a valid JWT — the debug path doesn't
  // emit telemetry yet (that lands in Ext.6). We accept it regardless
  // so a fresh Chrome profile can exercise the flow without first
  // doing a {type:"session"} round-trip.
  async function handleDebugEnvatoOneShot(msg) {
    const { item_id, envato_item_url, run_id, sanitized_filename } = msg
    if (typeof item_id !== 'string' || !item_id) {
      return { ok: false, errorCode: 'bad_input', detail: 'item_id required' }
    }
    if (typeof envato_item_url !== 'string' || !envato_item_url) {
      return { ok: false, errorCode: 'bad_input', detail: 'envato_item_url required' }
    }
    try {
      const result = await downloadEnvato({
        envatoItemUrl: envato_item_url,
        itemId: item_id,
        runId: run_id,                 // may be undefined — Ext.2 ignores it
        sanitizedFilename: sanitized_filename, // may be undefined — default envato_<id>.<ext>
      })
      return result
    } catch (err) {
      // downloadEnvato returns rather than throwing, but be defensive.
      return { ok: false, errorCode: 'unhandled_error', detail: String(err?.message || err) }
    }
  }

  function isSupportedVersion(v) {
  ```

- [ ] **Step 4: Add the switch case**

Use Edit:
- `old_string`:
  ```
        case 'session':
          sendResponse(await handleSession(msg))
          return
        default:
  ```
- `new_string`:
  ```
        case 'session':
          sendResponse(await handleSession(msg))
          return
        case 'debug_envato_one_shot':
          sendResponse(await handleDebugEnvatoOneShot(msg))
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
feat(ext): service worker — debug_envato_one_shot handler

Adds one new case to the onMessageExternal switch. The handler calls
downloadEnvato(...) from modules/envato.js and replies with the
{ok, filename, downloadId} or {ok:false, errorCode, detail} result.

Accepts {type, version, item_id, envato_item_url, run_id?,
sanitized_filename?}. Does NOT require a valid JWT — the debug path
has no telemetry emission yet (Ext.6), so session state is
irrelevant. Ping + session handlers are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Fixtures directory placeholder

Ext.5's mock-mode work will drop captured HAR snippets and mocked responses into `extension/fixtures/envato/`. Create the directory with `.gitkeep` now so the directory exists and the path is claimed — reduces the diff size of Ext.5.

**Files:**
- Create: `extension/fixtures/envato/.gitkeep`

- [ ] **Step 1: Create the directory and placeholder**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext2"
mkdir -p extension/fixtures/envato
```

Then create `extension/fixtures/envato/.gitkeep` as an empty file (0 bytes). Using the Write tool with empty content is fine, or:

```bash
touch extension/fixtures/envato/.gitkeep
```

- [ ] **Step 2: Verify**

```bash
ls extension/fixtures/envato/
# Expected: .gitkeep
ls -la extension/fixtures/envato/.gitkeep | awk '{print $5, $NF}'
# Expected: 0 .gitkeep  (or whatever byte count your touch produces — just confirm file exists)
```

- [ ] **Step 3: Commit**

```bash
git add extension/fixtures/envato/.gitkeep
git commit -m "$(cat <<'EOF'
chore(ext): placeholder extension/fixtures/envato/ directory

Claims the directory path for Ext.5's mock-mode work. Real captured
HAR fixtures land in that phase; Ext.2 doesn't consume fixtures
(smoke verification runs against the real Envato API in a real
browser profile).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend the test harness — "Envato one-shot" fieldset

Adds a new `<fieldset>` to `extension-test.html` with two inputs (item_id, envato_item_url), a trigger button, and a `<pre>` for the reply. Defaults to a placeholder URL so the user is forced to paste their own.

**Files:**
- Modify: `extension-test.html` (at repo root)

- [ ] **Step 1: Read the current test harness**

Look for the last fieldset (Ext.1's "End-to-end happy path" block — `id="out-run"`). The new fieldset goes AFTER that one and BEFORE the `</body>` closing script block.

- [ ] **Step 2: Insert the new fieldset**

Find the closing `</fieldset>` of the "End-to-end happy path" section. Use Edit:

- `old_string`:
  ```
    <fieldset>
      <legend>4. End-to-end happy path</legend>
      <div class="row">
        <button id="btn-run-all">Run all checks</button>
        <span id="run-status"></span>
      </div>
      <pre id="out-run">(not run yet)</pre>
    </fieldset>

    <script type="module">
  ```
- `new_string`:
  ```
    <fieldset>
      <legend>4. End-to-end happy path</legend>
      <div class="row">
        <button id="btn-run-all">Run all checks</button>
        <span id="run-status"></span>
      </div>
      <pre id="out-run">(not run yet)</pre>
    </fieldset>

    <fieldset>
      <legend>5. Envato one-shot (Ext.2)</legend>
      <p class="muted" style="margin-top: 0;">
        <strong>Warning:</strong> clicking this button COMMITS a real Envato license
        (Phase 2 GET download.data). Every click ticks the fair-use counter on the
        signed-in Envato account. Only run with a URL you actually want to download.
      </p>
      <label for="env-item-id">item_id (short code from the URL, e.g. <code>NX9WYGQ</code>):</label>
      <input type="text" id="env-item-id" placeholder="NX9WYGQ" autocomplete="off">
      <label for="env-item-url">envato_item_url (full elements.envato.com URL):</label>
      <input type="text" id="env-item-url" placeholder="https://elements.envato.com/stock-video/some-slug-NX9WYGQ" autocomplete="off">
      <p class="muted">
        Fill both inputs with a real item from your Envato subscription, then click.
        The file will appear in <code>~/Downloads/transcript-eval/envato_&lt;id&gt;.&lt;ext&gt;</code>.
        Inputs persist to localStorage.
      </p>
      <div class="row">
        <button id="btn-envato-one-shot">Run Envato single download</button>
        <span id="envato-status"></span>
      </div>
      <pre id="out-envato">(no response yet)</pre>
    </fieldset>

    <script type="module">
  ```

- [ ] **Step 3: Append the click handler to the inline `<script type="module">` block**

Find the last line before the closing `</script>` tag. In Ext.1 that's the `document.getElementById('btn-run-all').onclick = async () => { ... }` block — it ends with `}` on its own line. Add the new handler after that closing brace.

Use Edit:
- `old_string`: (the closing line of the existing `btn-run-all` handler — pick a unique enough anchor, e.g. the last two lines:)
  ```
        out.textContent = log.join('\n')
      }
    </script>
  ```
- `new_string`:
  ```
        out.textContent = log.join('\n')
      }

      // ---- Ext.2 Envato one-shot ----
      const envIdInput = document.getElementById('env-item-id')
      const envUrlInput = document.getElementById('env-item-url')
      envIdInput.value = localStorage.getItem('ext_test_envato_item_id') || ''
      envUrlInput.value = localStorage.getItem('ext_test_envato_item_url') || ''
      envIdInput.addEventListener('input', () => localStorage.setItem('ext_test_envato_item_id', envIdInput.value.trim()))
      envUrlInput.addEventListener('input', () => localStorage.setItem('ext_test_envato_item_url', envUrlInput.value.trim()))

      document.getElementById('btn-envato-one-shot').onclick = async () => {
        const status = document.getElementById('envato-status')
        const out = document.getElementById('out-envato')
        const itemId = envIdInput.value.trim()
        const itemUrl = envUrlInput.value.trim()
        if (!itemId || !itemUrl) {
          status.textContent = 'missing input'
          status.className = 'status-err'
          out.textContent = 'Both item_id and envato_item_url are required.'
          return
        }
        status.textContent = 'running…'
        status.className = ''
        out.textContent = '…'
        try {
          const t0 = performance.now()
          const r = await send({
            type: 'debug_envato_one_shot',
            version: 1,
            item_id: itemId,
            envato_item_url: itemUrl,
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
grep -c 'env-item-id' extension-test.html
# Expected: >= 3 (label for, input id, JS handler)
grep -c 'debug_envato_one_shot' extension-test.html
# Expected: 1 (the send() call)
```

- [ ] **Step 5: Commit**

```bash
git add extension-test.html
git commit -m "$(cat <<'EOF'
feat(ext): test harness — Envato one-shot fieldset

New fieldset "5. Envato one-shot (Ext.2)" with two inputs
(item_id, envato_item_url), a trigger button, and inline reply
pretty-print. Inputs persist to localStorage so a page reload keeps
the last-used values.

Includes an explicit warning that clicking commits a real Envato
license — this is the first button in the test harness that costs
the user anything, so the UX surfaces that before the click.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual load-unpacked smoke test (no commit)

End-to-end verification. Human-driven. This is the Ext.2 acceptance gate — do not skip or shortcut.

**License commits are real in this task.** Every press of "Run Envato single download" ticks the Envato fair-use counter on the signed-in account. Step 6 and Step 8 are deliberate license commits; do not spam the button.

**Prereq:** Dev server running on port 5173 in a separate terminal. A real Envato account signed in to the same Chrome profile that will load the unpacked extension. You have picked a specific Envato item URL (from a subscription you own) you want to download as the test item.

- [ ] **Step 1: Start vite dev**

In a new terminal:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext2"
npm install
npm run dev:client
```

Expected: `Local: http://localhost:5173/` line in the output. If 5173 is taken, free it (do NOT touch 3001).

- [ ] **Step 2: Reload the extension**

1. `chrome://extensions` in Chrome.
2. Find **transcript-eval Export Helper**, ID matches `extension/.extension-id`.
3. Click the refresh/reload arrow on the extension card. The service worker stops and restarts with the new manifest (Task 1) and the new handler (Task 4).
4. On the card, click **service worker** to open the SW DevTools. Keep this window open — the Phase 1/2/3 console logs surface here.
5. Card should show version **0.2.0** (Task 1 bump). If it still says 0.1.0, the reload didn't take — remove + reload unpacked from `extension/` again.

- [ ] **Step 3: Regression check — ping still works**

1. Open `http://localhost:5173/extension-test.html`.
2. Paste the extension ID if needed (localStorage should already have it).
3. Click **Send {type:"ping"}**.
4. Expect the Ext.1 pong reply (same as before): `{type:"pong", version:1, ext_version:"0.2.0", envato_session:"missing", has_jwt:false_or_true, jwt_expires_at:…}`.
5. `ext_version` should now be `"0.2.0"` (Task 2 bump). If it still reads `0.1.0`, config.js didn't reload — hard reload the extension (Step 2.3).

- [ ] **Step 4: Ensure JWT is present (optional)**

Not strictly required for the debug handler to accept the request, but it exercises the Ext.1 flow under the 0.2.0 reload:

1. Click **Send {type:"session", …}** (the first session button).
2. Expect `{ok: true}`.
3. Re-ping — `has_jwt` should be `true`.

If you want to run the debug handler without a JWT, skip this step.

- [ ] **Step 5: Confirm you're signed in to Envato in THIS Chrome profile**

1. In a regular tab: `https://app.envato.com/`.
2. You should land on the signed-in dashboard, not the sign-in page. If signed-in dashboard does NOT appear, complete sign-in before proceeding — Phase 2 will 401 otherwise.
3. Back to the test page.

- [ ] **Step 6: Fire the one-shot — HAPPY PATH (license commit #1)**

This step commits one Envato license. Choose the item URL deliberately.

1. Scroll to the **"5. Envato one-shot (Ext.2)"** fieldset.
2. Fill `item_id` with the short code at the end of the URL (e.g. `NX9WYGQ`).
3. Fill `envato_item_url` with the full `elements.envato.com/…` URL.
4. Click **Run Envato single download**.
5. Watch two surfaces in parallel:
   - **Test page `#out-envato`** — should show `…` then the reply object within ~2-5 seconds.
   - **SW DevTools console** — should print three lines:
     ```
     [envato] phase 1 resolve OK {newUuid: "...-...-...", ms: 500-2000}
     [envato] phase 2 license OK {ms: 300-800}
     [envato] phase 3 download started {downloadId: <int>, ms: 50-200, total_ms: 900-3000}
     ```
6. On the test page reply:
   ```json
   {
     "ok": true,
     "filename": "envato_NX9WYGQ.mov",
     "downloadId": <int>
   }
   ```
7. `#envato-status` should show `OK in <N>ms` in green.

- [ ] **Step 7: Verify the file**

1. Open Finder → `~/Downloads/transcript-eval/`. (If the `transcript-eval` folder didn't exist, Chrome created it on first download.)
2. A file named `envato_<id>.<ext>` should be present, size on the order of tens to hundreds of MB.
3. Open it in VLC (or double-click to let macOS pick a player). It should play as a normal video clip.

If the file appears with a size of 0 bytes, or doesn't play, note the Envato item type — you may have picked an audio-only or image-only asset. Pick a different item URL for a re-run and record the issue.

- [ ] **Step 8: Fire the one-shot — UNSUPPORTED FILETYPE PATH (license commit #2)**

This also commits a license but is expected to short-circuit at Phase 2.5 before writing a file.

Prerequisite: identify an Envato motion-graphics item URL whose download delivers as `.zip` or `.aep` (e.g. an After Effects template). These are plentiful on Envato Elements; any "After Effects Template" listing works.

1. Clear the two inputs (or leave — localStorage will overwrite on type).
2. Paste the motion-graphics item_id + URL.
3. Click **Run Envato single download**.
4. Watch for:
   - SW DevTools: `[envato] phase 1 resolve OK`, `[envato] phase 2 license OK`, `[envato] phase 2.5 safety net aborted {cdnFilename: "something.zip"}`.
   - Test page reply:
     ```json
     {
       "ok": false,
       "errorCode": "envato_unsupported_filetype",
       "detail": "<the CDN-returned filename>"
     }
     ```
   - No file written under `~/Downloads/transcript-eval/`.
5. Acceptable: the Envato license HAS been committed for this item — that's the bounded-waste tradeoff documented in the spec. Do NOT call this a bug.

- [ ] **Step 9: Fire the one-shot — RESOLVE TIMEOUT (no license commit expected)**

Tests the timeout branch without wasting a license. Use a clearly invalid Envato-shaped URL.

1. Set `item_id` = `FAKEITM`.
2. Set `envato_item_url` = `https://elements.envato.com/stock-video/does-not-exist-FAKEITM-123456789`.
3. Click the button.
4. Expect after ~15 seconds:
   - SW DevTools: no "phase 2 license OK" line (we never got past Phase 1).
   - Test page reply:
     ```json
     {
       "ok": false,
       "errorCode": "resolve_timeout",
       "detail": "resolve_timeout"
     }
     ```
5. No tab should remain open — the resolver's cleanup path closes it in all three exits.
6. Confirm no new file in `~/Downloads/transcript-eval/`.

- [ ] **Step 10: Regression check — popup still renders**

1. Click the extension toolbar icon.
2. Popup should show two rows (transcript-eval, Envato) identical to Ext.1, with version `v0.2.0` in the header.
3. Close popup.

- [ ] **Step 11: Do NOT commit anything from this task**

```bash
git status
# Expected: "nothing to commit, working tree clean" (or only tracked files that you CHOSE to edit for debugging — if so, go fix those as proper tasks before returning here)
```

If any of Steps 6-9 fail:
- **Step 6 reply is `{ok:false, errorCode:"envato_session_missing"}`** → Envato session cookie missing. Go sign in again in the same profile and retry.
- **Step 6 hangs forever** → `webNavigation` permission missing, or the URL regex doesn't match a newer Envato redirect shape. Check SW console; adjust `APP_URL_UUID_RE` in `envato.js` if needed.
- **Step 6 returns `{ok:false, errorCode:"envato_unavailable"}`** → either the item is delisted (try a different URL) or the Remix streaming response format changed (inspect the raw `resp.text()` by adding a `console.log` to Phase 2).
- **Step 9 doesn't time out** → the timer or cleanup is broken; re-read `envato.js` Phase 1 logic.

---

## Task 8: Extend README + final polish

**Files:**
- Modify: `extension/README.md`

- [ ] **Step 1: Append the Ext.2 section**

Open `extension/README.md`. After the last section ("Known Ext.1 limitations"), append:

Use Edit with an `old_string` anchor on the last Ext.1 bullet. For example:
- `old_string`:
  ```
  - No download flows — Ext.2 (Envato) and Ext.3 (Pexels/Freepik) add
    those.
  ```
- `new_string`:
  ```
  - No download flows — Ext.2 (Envato) and Ext.3 (Pexels/Freepik) add
    those.

  ## Ext.2 — Envato single item

  Ext.2 adds the first real download flow: end-to-end licensed download
  of ONE Envato item via the 3-phase pipeline (resolve → license →
  download). No queue, no concurrency — just prove the pipeline.

  ### Trigger via the dev test harness

  1. `npm run dev:client` (port 5173).
  2. Open `http://localhost:5173/extension-test.html`.
  3. Scroll to fieldset **"5. Envato one-shot (Ext.2)"**.
  4. Fill `item_id` (e.g. `NX9WYGQ`) and `envato_item_url` (the full
     `https://elements.envato.com/…` URL).
  5. Click **Run Envato single download**.

  The file lands in `~/Downloads/transcript-eval/envato_<id>.<ext>`
  (Chrome creates the `transcript-eval/` subfolder on first download).
  Most Envato stock-video items deliver as `.mov`; a few as `.mp4`.

  ### Caveats

  - **Signed in to Envato in this Chrome profile.** The resolver's
    hidden tab and Phase 2's `fetch(..., {credentials:'include'})` both
    rely on the Envato session cookies on `.envato.com`. If the profile
    is signed out, Phase 2 returns 401 and the handler replies
    `{ok:false, errorCode:"envato_session_missing"}`.
  - **License IS committed on Phase 2 success.** Every successful run
    of the debug handler ticks the signed-in Envato account's
    fair-use counter — same as if the user had clicked Download on
    the Envato website. Do NOT aim this at a production Envato
    account unless you intentionally want the license.
  - **ZIP/AEP/PRPROJ items are aborted AFTER the license commits.**
    Phase 2.5 inspects the signed URL's content-disposition filename;
    if it ends `.zip`/`.aep`/`.prproj`, no file is written — but the
    license has already been spent on that item. This is bounded
    waste; full deny-list handling lands in Ext.7.
  - **No retry / session-refresh / error matrix.** 401 / 402 / 403 /
    429 / empty-downloadUrl surface as `errorCode: "envato_<…>"` and
    stop. Retry policy, session refresh, and hard-stop on 403 are
    Ext.4 + Ext.7 work.
  - **Concurrency cap = 1.** Ext.5 raises this to 5 resolvers + 3
    downloaders.

  ### Manifest changes (0.1.0 → 0.2.0)

  - `permissions`: `storage` → `storage`, `tabs`, `webNavigation`,
    `downloads`.
  - `host_permissions` (new): `elements.envato.com/*`,
    `app.envato.com/*`,
    `video-downloads.elements.envatousercontent.com/*`.
  - No `cookies` / `power` permissions yet — those land in Ext.4 /
    Ext.5.
  ```

- [ ] **Step 2: Commit**

```bash
git add extension/README.md
git commit -m "$(cat <<'EOF'
docs(ext): README — Ext.2 Envato single-item section

Documents the dev-test trigger path, expected file location, and the
four caveats that matter for the first real download flow: profile
must be signed in to Envato; license commits are real; Phase 2.5
bounded waste on ZIP/AEP; no retry/refresh matrix yet.

Also lists the manifest permission deltas for the 0.1.0 → 0.2.0 bump.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Full branch review**

```bash
git log --oneline feature/extension-ext1..HEAD  # or main..HEAD if Ext.1 merged
# Expected: 7 commits — one per Task 1..6 and Task 8. Task 0 has no commit (worktree setup). Task 7 is verification-only.

git diff feature/extension-ext1 --stat  # or main
# Expected additions (approximate):
#   extension-test.html                              |  50+
#   extension/README.md                              |  60+
#   extension/config.js                              |  10+
#   extension/fixtures/envato/.gitkeep               |   0
#   extension/manifest.json                          |   8+
#   extension/modules/envato.js                      | 200+
#   extension/service_worker.js                      |  30+
```

If `git diff` surfaces anything outside the `extension/` directory, `extension-test.html` at the root, or files that Ext.2 shouldn't touch — investigate. Revert unrelated changes before finalizing.

- [ ] **Step 4: DO NOT push**

Per user convention: `git push` requires explicit consent. This task's acceptance is "all 7 commits on the local branch, branch ready for review." Surface the branch name + last commit sha to the user; ask before pushing.

---

## Self-review against the spec

After completing Tasks 0–8, re-read the following spec sections:

**Roadmap (`docs/specs/2026-04-24-export-remaining-roadmap.md`) § "Ext.2 — Envato single item"** coverage check:

- 3-phase flow: resolve → license → download ✓ (`modules/envato.js`)
- Files listed: `extension/modules/envato.js`, extended `service_worker.js`, `extension/fixtures/envato/*` placeholder ✓
- Tab-based resolver with webNavigation.onCommitted, 15s timeout, hidden tab, concurrency cap 1 ✓
- No deny-list in Ext.2 ✓ (deny-list is Ext.7)
- No JIT URL refetching ✓ (JIT is Ext.5)
- `.zip/.aep/.prproj` filetype safety net IS in Ext.2 ✓ (Phase 2.5)
- Verification: manual send of `{type:"debug_envato_one_shot", item_id, envato_item_url}` and confirming file in `~/Downloads/transcript-eval/envato_<id>.mov` ✓ (Task 7 Step 6–7)
- SW logs: 3 phase lines ✓ (Task 7 Step 6.5 expectation)

**Extension spec (`/tmp/ext-spec.md`) § "Envato 3-phase download"** coverage check:

- Phase 1 via hidden tab + `webNavigation.onCommitted`, caching UUID DEFERRED to Ext.5 ✓
- Phase 2 hits `app.envato.com/download.data?itemUuid=…&itemType=stock-video&_routes=routes/download/route` ✓
- Parses signed URL from Remix streaming response ✓
- Emphasis that Phase 2 commits a license; only user-initiated ✓ (called out in the SW debug handler comment and README)
- Filetype safety net inspects `response-content-disposition` in the signed URL ✓
- Phase 3 uses `chrome.downloads.download({conflictAction:'uniquify', saveAs:false})` ✓
- No `assetUuid` param → always highest resolution ✓ (Resolution Selection MVP)

**Extension spec § "Failure modes & handling"** — Ext.2 scope:

- ZIP safety net: Ext.2 ✓ (without deny-list persistence or 24h rate-limit — those are Ext.7)
- 401 surfacing: Ext.2 ✓ (`envato_session_missing`; Ext.4 adds auto-recovery via Port)
- Full retry matrix (402 tier, 403 hard-stop, 429 Retry-After + jitter, 5xx backoff, empty-downloadUrl skip): Ext.7 — NOT in Ext.2 ✓

**Ext.2 scope hold-the-line check:**

- No Pexels/Freepik ✓
- No queue, concurrency > 1, pause/resume/cancel ✓
- No telemetry ✓
- No cookie watcher / 401 refresh ✓
- No `power` permission ✓
- No icons ✓
- No cross-browser polish ✓

---

## Inputs parked for Ext.3+

These are NOT used in Ext.2 — capturing here so they aren't lost when the relevant downstream phase picks up:

**For Ext.3 (Pexels + Freepik single item):**

- The debug-handler pattern in `service_worker.js` is the template to copy for `{type:"debug_source_one_shot", source, item_id}`. Adding a second debug case follows the same structure; don't restructure into a debug sub-module until there's a third call site.
- The signed-URL filename extraction helper (`extractFilenameFromSignedUrl`) is Envato-specific (AWS-flavored disposition-in-query-string format). Pexels/Freepik backend responses return the filename field directly, so this helper is NOT reusable. Don't generalize speculatively.
- The `run_id` + `sanitized_filename` parameters on the debug handler are already wired through; Ext.3 can use the same shape for parity, but still no persistent run concept.

**For Ext.4 (auth polish / cookie watcher / Port):**

- Phase 2's 401 branch currently returns `{ok:false, errorCode:"envato_session_missing"}` and stops. Ext.4 replaces this with: pause run, post `{type:"refresh_session"}` on Port, wait for a new token / cookie refresh, resume. Hook point: the `if (resp.status === 401) throw …` line in `getSignedDownloadUrl`.
- When Ext.4 adds the `cookies` permission and a `chrome.cookies.onChanged` watcher on `.envato.com`, the `envato_session: "missing"` placeholder in `handlePing()` (Ext.1) becomes real. Plumb through without breaking the existing message shape.
- The debug handler comment in `service_worker.js` mentions "The message does not require a valid JWT." Ext.4's real flow WILL require it (telemetry needs `user_id`). Revisit that comment when Ext.6 wires `/api/export-events`.

**For Ext.5 (queue + concurrency + persistence):**

- `MAX_RESOLVER_CONCURRENCY = 1` in `config.js` is the constant to bump to 5. Also introduce `MAX_DOWNLOADER_CONCURRENCY = 3`.
- The `runId` parameter through `downloadEnvato({ runId })` is ALREADY accepted and ignored. Ext.5 wires it to the `transcript-eval/export-<runId>/media/<filename>` path template.
- `resolveOldIdToNewUuid` recomputes on every call. Ext.5 adds a `chrome.storage.local` cache keyed by `oldUrl → newUuid` with no expiry (per spec).
- The signed URL in Phase 2 is returned to the caller and immediately consumed by Phase 3. Ext.5's queue will have a non-zero gap between licensing and downloading; add "if more than 45 minutes since `getSignedDownloadUrl`, re-call it" logic at that point.

**For Ext.6 (telemetry):**

- `downloadEnvato` currently returns `{ok, filename, downloadId}` / `{ok:false, errorCode, detail}` synchronously. Ext.6 adds an event emission after each phase (`item_resolved`, `item_licensed`, `item_downloaded` / `item_failed`). Either add an optional `emit` callback parameter, or have the SW handler emit based on the phase timings in the log statements (simpler).

**For Ext.7 (failure-mode polish):**

- The coarse error codes from Phase 2 (`envato_session_missing`, `envato_402`, `envato_403`, `envato_429`, `envato_unavailable`, `envato_http_<n>`) are the TAXONOMY Ext.7 keys its retry matrix off. Don't change the strings without updating Ext.7 in lockstep.
- The ZIP safety net returns `envato_unsupported_filetype` but does NOT persist to a deny-list. Ext.7 adds the `chrome.storage.local` deny-list + 24h rate-limited telemetry. Hook point: right after the `console.log('[envato] phase 2.5 safety net aborted')` line.

**Open risks that need user confirmation:**

- **Cookies-without-permission is the one thing I can't verify from code alone.** Ext.2 uses `credentials:'include'` on the Phase 2 fetch without requesting the `cookies` permission, relying on `host_permissions` + same-site-cookie rules. This is expected to work in Chrome 120+ for cross-origin fetches where the origin is in `host_permissions`, but it's not bullet-proof across all Chrome versions / enterprise policies. If Task 7 Step 6 returns `envato_session_missing` despite the user being signed in to Envato in the same profile, the fix is to add `"cookies"` to `permissions` (one line in `manifest.json`) and reload. Surface this as a known gotcha in the task description.
- **No hard-coded test Envato URL in the plan.** The user must supply a real Envato subscription item URL for Task 7. The plan's examples use placeholder strings (`NX9WYGQ`, `https://elements.envato.com/stock-video/some-slug-NX9WYGQ`). If the user runs this without filling real values, the debug handler returns `resolve_timeout` and no license is committed — safe failure, but not the happy-path verification.
- **License budget.** Task 7 plans at least 2 license commits (Steps 6 and 8). Each commit costs one item against the signed-in Envato account's fair-use cap (~daily 30 items on Envato Elements as of 2025 pricing). If re-runs are needed to diagnose Step 6 failures, this can add up. Advise: cap Task 7 retries at 3-5 total before stepping back to debug code.
- **Chrome profile isolation.** If the user has multiple Chrome profiles (personal + work), load-unpacked installs into the currently-active profile. Confirm the Envato sign-in lives in that same profile before Step 6. The quick check is `chrome://version` → "Profile Path" — should match the profile where `app.envato.com` shows the signed-in dashboard.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-extension-ext2-envato-single.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Task 7's manual smoke stays with the human driver regardless.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints before Task 7.

Which approach?
