# B-Roll Export — Chrome Extension Spec

## Goal

Ship the Chrome MV3 extension ("transcript-eval Export Helper") that downloads licensed b-roll files to the user's disk during an export run. Integrates with the already-shipped transcript-eval Phase 1 backend (export record, JWT, event ingestion, Pexels/Freepik URL proxies) and with the editor web app via `chrome.runtime` messaging. Chrome-only at launch; Safari/Firefox explicitly deferred.

## Companion specs

| Spec | Lives in | Covers |
|---|---|---|
| `2026-04-23-envato-export-design.md` | transcript-eval `docs/specs/` | The whole 4-stage funnel end-to-end. Reference for the big picture. |
| `2026-04-23-envato-export-phase1.md` | transcript-eval `docs/superpowers/plans/` | Phase 1 backend **(already shipped on `feature/envato-export-phase1`)** — the HTTP endpoints this extension will call. |
| `2026-04-23-broll-candidate-pipeline.md` | adpunk.ssh `docs/superpowers/specs/` | Stages 1-3 (scrape → SigLIP → Qwen rerank). Produces `broll_searches.results_json`, which the web app reads to build the manifest this extension consumes. |
| **`2026-04-23-envato-export-extension.md`** | transcript-eval `docs/specs/` | **This file — the extension.** |

When a sentence in this spec says "per the main spec", it means section X of `2026-04-23-envato-export-design.md` — consult that document for context / rejected alternatives / UX screens.

---

## Scope

**In scope (this spec):**
- MV3 service worker + popup + content script / port.
- Envato 3-phase download flow (resolve old ID → new UUID, license, download).
- Pexels/Freepik downloads via transcript-eval backend signed-URL endpoints.
- Queue with concurrency caps, pause/resume/cancel, `chrome.storage.local` persistence.
- JWT auth (receives a JWT from the web app; does NOT own login).
- Web app ↔ extension messaging protocol.
- Telemetry to `POST /api/export-events`.
- Popup UI (status-only; real in-progress UI lives in the web app's export page).
- Chrome Web Store submission, feature-flag config fetch.
- Diagnostic bundle generator.

**Explicitly out of scope (owned elsewhere):**
- The export page UI at `/editor/:id/export` — transcript-eval web app (separate phase).
- XMEML generation — transcript-eval server (`server/services/xmeml-generator.js` — future phase).
- `/api/exports`, `/api/session-token`, `/api/export-events`, `/api/pexels-url`, `/api/freepik-url` implementations — already shipped on `feature/envato-export-phase1`.
- `broll_searches` candidate pipeline — adpunk.ssh.
- Safari, Firefox, Edge — deferred (Chrome / Chromium forks only).
- Mobile — permanently not supported.
- Storyblocks full-file downloads — deferred (items are surfaced as "pick a different clip" tooltips).
- Adobe Stock — permanently not supported.

---

## Integration with Phase 1 (already shipped)

The extension is a **pure client** of the Phase 1 backend. Do not build any server-side state in the extension that duplicates what Phase 1 already stores. Treat the backend as source of truth for anything persisted across runs.

### Endpoints the extension MUST call

| Method + Path | Called by | Purpose |
|---|---|---|
| `POST /api/session-token` | Web app (extension never calls this directly) | Mint 8h extension JWT. Web app forwards it to the extension on first export. |
| `POST /api/exports` | Web app (extension never calls this directly) | Create the export record + return `export_id`. Web app puts `export_id` into the manifest it sends the extension. |
| `POST /api/export-events` | **Extension** | Stream telemetry during a run. Bearer JWT required. See "Telemetry" below for exact event list. |
| `POST /api/pexels-url` | **Extension** | Get a Pexels download URL for an `item_id`. Bearer JWT required. |
| `POST /api/freepik-url` | **Extension** | Get a signed Freepik download URL (billable €0.05 per call server-side; extension MUST only call once per item per run). Bearer JWT required. |

### Request/response shapes (pin these — the backend is already shipped against them)

**`POST /api/export-events`** — auth: Bearer extension JWT. Response: 202 `{ok: true}`. 400/404/500 on errors.

```jsonc
{
  "export_id":   "exp_01J...",          // REQUIRED — from the manifest the web app sent
  "event":       "export_started",      // REQUIRED — one of the 10 allowed events (list below)
  "item_id":     "NX9WYGQ",             // optional
  "source":      "envato",              // optional — "envato" | "pexels" | "freepik"
  "phase":       "download",            // optional — "resolve" | "license" | "download"
  "error_code":  "envato_403",          // optional — see "Error codes" below
  "http_status": 403,                   // optional
  "retry_count": 2,                     // optional
  "meta":        { "bytes": 150000000 }, // optional, JSON-stringified ≤ 4 KB, rejects arrays/circular refs
  "t":           1745000000000          // REQUIRED — client epoch_ms
}
```

Allowed `event` values (backend rejects anything else with 400): `export_started`, `item_resolved`, `item_licensed`, `item_downloaded`, `item_failed`, `rate_limit_hit`, `session_expired`, `queue_paused`, `queue_resumed`, `export_completed`.

**`POST /api/pexels-url`** — auth: Bearer JWT.

```jsonc
// Request
{ "item_id": 856971, "preferred_resolution": "1080p" }  // resolution optional; default "1080p"

// Response 200
{
  "url":       "https://videos.pexels.com/video-files/...",
  "filename":  "pexels_<id>.mp4",       // always .mp4 — service rejects non-mp4 items
  "size_bytes": null,                    // null — derive from Content-Length at download
  "resolution": { "width": 1920, "height": 1080 }
}
```

Error cases: 400 (missing `item_id`), 404 (Pexels item not found), 401 (bad/missing JWT), 503 (`PEXELS_API_KEY` unset), 500 (anything else).

**`POST /api/freepik-url`** — auth: Bearer JWT. **Each call costs €0.05**; the extension MUST deduplicate per item per run.

```jsonc
// Request
{ "item_id": "abc-123", "format": "mp4" }

// Response 200
{
  "url":       "https://...signed...",
  "filename":  "freepik_<id>.mp4",
  "size_bytes": 500000000,                // number when Freepik returns it, null otherwise
  "expires_at": 1745001000000             // epoch_ms — extension MUST refetch on expiry (typical 15-60 min)
}
```

Error cases: 400 (missing `item_id`), 404, 429 (rate-limited — back off, retry once), 503 (`FREEPIK_API_KEY` unset — treat item as fatal failure, record `item_failed` with `error_code: freepik_unconfigured`), 500.

### Extension JWT

- Minted by the backend at `POST /api/session-token`. Web app receives `{token, kid, user_id, expires_at}` and forwards to the extension (see "Web app ↔ extension messaging").
- HS256 with `kid` header. 8h TTL.
- Extension stores in `chrome.storage.local`. Sends as `Authorization: Bearer <token>` on every backend call except when the request goes to third-party CDNs (Envato, Pexels CDN, Freepik CDN — those don't get the header).
- On 401 from any backend endpoint: extension sends `postMessage({type: "refresh_session"})` to the web app (via the Port) and pauses the queue until a new token arrives. If the web app is not connected, popup shows "Open transcript-eval to continue."
- Rotation: backend's key ring auto-handles old tokens until their exp. Extension doesn't need to do anything special on rotation — just refetch on 401.

### Error codes the extension emits

Values the extension writes into `event_events.error_code`:

| Code | When |
|---|---|
| `envato_403` | `download.data` returned 403 — hard stop, not auto-recoverable. |
| `envato_402_tier` | 402 or 403 with body containing "upgrade" — tier-restricted item, skip without hard-stop. |
| `envato_429` | 429 on `download.data`. |
| `envato_session_401` | 401 on `download.data` — session expired. Fires `session_expired` event too. |
| `envato_unavailable` | `download.data` returned empty `downloadUrl` OR resolver found no UUID — item delisted. |
| `envato_unsupported_filetype` | Signed URL's `response-content-disposition` points at `.zip`/`.aep`/`.prproj`. |
| `freepik_404` | Freepik item not found. |
| `freepik_429` | Our `/api/freepik-url` returned 429. |
| `freepik_unconfigured` | Our `/api/freepik-url` returned 503 (server has no API key). |
| `pexels_404` | Pexels item not found. |
| `network_failed` | `chrome.downloads` reported `NETWORK_*` interrupt after 3 resume attempts. |
| `disk_failed` | `chrome.downloads` reported `FILE_*` interrupt — hard stop. |
| `integrity_failed` | Downloaded file size doesn't match expected — after retry. |
| `resolve_failed` | Envato resolver tab didn't redirect to `app.envato.com/<new-uuid>` after retry. |
| `url_expired_refetch_failed` | Tried to refetch a signed URL 2×, still got an expired one. |

---

## Web app ↔ extension messaging

Two channels:

### 1. Web app → extension (one-shot)

`chrome.runtime.sendMessage(EXT_ID, message)`. Requires the extension's ID hard-coded in web app config. Extension's `externally_connectable` manifest entry whitelists `localhost:5173` + production domain.

```jsonc
// Ping — extension responds with current status
{ "type": "ping", "version": 1 }

// Session token — sent on first export of a session
{
  "type":    "session",
  "version": 1,
  "token":   "eyJ...",
  "user_id": "<supabase uuid>",
  "kid":     "k1",
  "expires_at": 1745086400000
}

// Control
{ "type": "status",  "version": 1 }                          // "what's your current state?"
{ "type": "export",  "version": 1, "manifest": {...}, "target_folder": "<path>", "options": {...} }
{ "type": "pause",   "version": 1, "export_id": "exp_..." }
{ "type": "resume",  "version": 1, "export_id": "exp_..." }
{ "type": "cancel",  "version": 1, "export_id": "exp_..." }
```

### 2. Extension → web app (long-lived Port)

The web app opens a `chrome.runtime.Port` to the extension when the export page loads. The Port auto-disconnects when the tab closes — clean signal that the UI went away.

```jsonc
// Ping response
{
  "type":           "pong",
  "version":        1,
  "ext_version":    "0.1.0",
  "envato_session": "ok" | "missing" | "expired",
  "has_jwt":        true,
  "jwt_expires_at": 1745086400000
}

// State snapshot — returned on {"type":"status"}, also pushed on every transition
{
  "type":    "state",
  "version": 1,
  "export": {
    "export_id":       "exp_...",
    "phase":           "idle" | "preflight" | "resolving" | "licensing" | "downloading" | "paused" | "complete" | "failed" | "partial",
    "ok_count":        12,
    "fail_count":      0,
    "remaining":       35,
    "bytes_done":      2100000000,
    "bytes_total_est": 8500000000,
    "current_item":    { "seq": 12, "source": "envato", "source_item_id": "NX9WYGQ", "phase": "downloading", "bytes": 21000000, "bytes_total": 83000000 },
    "folder_path":     "~/Downloads/transcript-eval/export-225-c/"
  }
}

// Per-event pushes (the extension also POSTs to /api/export-events; these are for live UI only)
{ "type": "progress", "version": 1, "item_id": "...", "phase": "downloading", "bytes": 123, "bytes_total": 456 }
{ "type": "item_done", "version": 1, "item_id": "...", "result": "ok" | "failed", "error_code": null | "..." }

// End-of-run
{
  "type":       "complete",
  "version":    1,
  "ok_count":   47,
  "fail_count": 0,
  "folder_path": "<abs path>",
  "xml_paths":  []                      // always empty here — web app generates XML after the Port closes
}

// 401 from our backend — extension asks web app to mint a fresh token
{ "type": "refresh_session", "version": 1 }
```

### Manifest shape (web app → extension)

Constructed by the web app from `broll_searches.results_json` + the user's variant selection. Extension reads but does not mutate.

```jsonc
{
  "export_id":    "exp_01J...",
  "target_folder": "~/Downloads/transcript-eval/export-225-c/",
  "options": {
    "force_redownload": false,
    "variants":         ["A", "B", "C"]
  },
  "items": [
    {
      "seq":                 1,
      "timeline_start_s":    25.4,       // per variant — (populated for XMEML; extension ignores)
      "timeline_duration_s": 4.0,        // ignored by extension
      "source":              "envato" | "pexels" | "freepik",
      "source_item_id":      "NX9WYGQ" | "<numeric>" | "<uuid>",
      "envato_item_url":     "https://elements.envato.com/...",   // envato only
      "target_filename":     "001_envato_NX9WYGQ.mov",            // per spec naming convention
      "resolution":          { "width": 1920, "height": 1080 },
      "frame_rate":          30,
      "est_size_bytes":      150000000
    }
  ]
}
```

### Versioning

- Every message has a `version` field. Extension supports `version` N and N-1 (soft deprecation).
- Extension sends `{ext_version}` in every `pong`. Web app's export page declares a minimum required version — on mismatch, it shows "Update required — your Export Helper is v0.3, needs v0.5."
- Message schema bumps go in this file; extension + web app must be updated in lockstep for major bumps.

---

## Extension architecture

### File structure (~600 LOC total)

```
extension/
├── manifest.json              MV3 manifest
├── service_worker.js          entry point — router for external messages + port
├── popup.html
├── popup.js                   toolbar UI (status rows, sign-in hooks)
├── modules/
│   ├── auth.js                JWT storage, refresh flow, 401 handler
│   ├── envato.js              3-phase flow: resolve, license, download
│   ├── sources.js             pexels + freepik — call /api/<source>-url, then chrome.downloads
│   ├── queue.js               concurrency caps, pause/resume/cancel, state machine
│   ├── storage.js             chrome.storage.local wrappers — run state, deny-list, completed cache
│   ├── telemetry.js           /api/export-events emitter with offline queue + retry
│   ├── diagnostics.js         bundle generator
│   └── port.js                Port lifecycle + outbound message helpers
├── fixtures/                  mock-mode HAR + canned responses for dev
└── icons/
```

### `manifest.json`

```jsonc
{
  "manifest_version": 3,
  "name": "transcript-eval Export Helper",
  "version": "0.1.0",
  "minimum_chrome_version": "120",
  "permissions": [
    "downloads",
    "tabs",
    "webNavigation",
    "storage",
    "cookies",
    "power"
  ],
  "host_permissions": [
    "https://elements.envato.com/*",
    "https://app.envato.com/*",
    "https://video-downloads.elements.envatousercontent.com/*",
    "https://videos.pexels.com/*",
    "https://*.freepik.com/*",
    "https://videocdn.cdnpk.net/*",
    "http://localhost:5173/*",
    "https://transcript-eval.com/*"
  ],
  "externally_connectable": {
    "matches": [
      "http://localhost:5173/*",
      "https://transcript-eval.com/*"
    ]
  },
  "background": { "service_worker": "service_worker.js" },
  "action": { "default_popup": "popup.html" }
}
```

### Service worker responsibilities

MV3 service workers are terminated aggressively when idle. The extension MUST survive termination mid-run:
- All run state in `chrome.storage.local` (never in SW memory).
- Pending downloads managed by `chrome.downloads` (SW-independent).
- On wake, SW re-reads `chrome.storage.local.active_run_id` and resumes loops.

Message router:
- `chrome.runtime.onMessageExternal` → dispatch to appropriate handler.
- `chrome.runtime.onConnectExternal` → register new Port, hand to `port.js`.
- `chrome.downloads.onChanged` → forward to queue for progress + interrupt handling.
- `chrome.cookies.onChanged` → if Envato session cookies appear/disappear, update state.

---

## Authentication flows

### Envato

Extension uses the user's browser cookies — no in-extension login. Popup's "Sign in to Envato" button opens `https://app.envato.com/sign-in` in a new tab.

Signal: `chrome.cookies.onChanged` watching for `envato_client_id` or `elements.session.5` cookies on `.envato.com`.

**Pre-flight check before every run:** one GET to `app.envato.com/download.data` with a reference `itemUuid`. 200 = proceed; 401 = prompt user and do not start the run.

### transcript-eval JWT

- Stored in `chrome.storage.local.jwt = {token, kid, user_id, expires_at}`.
- Extension never logs into transcript-eval. Token arrives via `{type: "session"}` message from the web app.
- Before every authenticated backend call, check `expires_at`. If within 60s of expiry, push `{type: "refresh_session"}` to the web app and wait up to 10s for a new token.
- On 401: pause queue (if active), push `{type: "refresh_session"}`, wait for new token up to 10s; if none arrives, popup shows "Open transcript-eval to continue." Queue resumes on new token.

### Popup status surface

```
┌─────────────────────────────────────────────┐
│  transcript-eval Export Helper              │
│                                             │
│  transcript-eval:  ✓ connected              │
│                    silvestras.stonk@gmail...│
│  Envato:           ✓ active subscription    │
│                    (unlimited33_monthly)    │
│                                             │
│  [ Ready for export ]                       │
└─────────────────────────────────────────────┘
```

Rows clickable when red — launch the respective sign-in flow.

---

## Envato 3-phase download

Unchanged from main spec (§ "Download flow detail — Envato three phases"). Summary:

**Phase 1 — Resolve old ID → new UUID.** Opens `elements.envato.com/...` in a hidden tab, watches `chrome.webNavigation.onCommitted` for the redirect to `app.envato.com/<new-uuid>`, captures UUID, closes tab. Concurrency: 5 tabs in parallel. Cache `{oldId → newUuid}` in `chrome.storage.local` with no expiry.

**Phase 2 — License + get signed URL.** `GET https://app.envato.com/download.data?itemUuid=<UUID>&itemType=stock-video&_routes=routes/download/route`. Session-cookie auth. Parse signed URL out of the Remix streaming response. **Calling this commits a license. Never speculatively — only after user clicked Start Export.**

Filetype safety net: inspect `response-content-disposition` filename in the signed URL. If it ends `.zip`/`.aep`/`.prproj`, abort before GET, record `envato_unsupported_filetype`, cache the `source_item_id` in local deny-list, fire a telemetry event.

**Phase 3 — Save file.** `chrome.downloads.download({url, filename: "transcript-eval/export-<runId>/media/<target_filename>", saveAs: false, conflictAction: "uniquify"})`. Track via `chrome.downloads.onChanged`.

Resolution: call `download.data` WITHOUT `assetUuid` → Envato's default (highest resolution). No variant picker in MVP.

---

## Pexels / Freepik download

Single code path in `modules/sources.js`:

```jsonc
// pseudocode
async function downloadViaBackend(item) {
  const endpoint = item.source === "pexels" ? "/api/pexels-url" : "/api/freepik-url"
  const body = item.source === "pexels"
    ? { item_id: item.source_item_id, preferred_resolution: "1080p" }
    : { item_id: item.source_item_id, format: "mp4" }

  const r = await backendFetch(endpoint, { method: "POST", body })
  // r.url + r.filename + r.size_bytes (+ r.expires_at for Freepik)

  const downloadId = await chrome.downloads.download({
    url: r.url,
    filename: `transcript-eval/export-${runId}/media/${item.target_filename}`,
    saveAs: false,
    conflictAction: "uniquify"
  })
  return downloadId
}
```

Freepik-specific: track `expires_at`. If a Freepik download fails with "URL expired" (likely via `NETWORK_FAILED` when CDN rejects the signed token), refetch the URL and retry once. After 2 refetches still failing → `url_expired_refetch_failed`.

**Dedup per run:** before calling `/api/freepik-url`, check `chrome.storage.local.completed_items[exp_run_id][<source, source_item_id>]`. If the file is already on disk (file path exists + size matches manifest estimate), skip. Opt-in `options.force_redownload` overrides.

---

## Queue + concurrency + persistence

### Concurrency caps

- 5 resolvers (Phase 1 — hidden tabs).
- **3 downloaders** (Phase 2 + 3 for Envato; single-call for Pexels/Freepik).
- One active run per user. Second `{type: "export"}` while a run is live → reply `{type: "error", reason: "run_already_active"}`.

### State shape in `chrome.storage.local`

```jsonc
"run:<export_id>": {
  "export_id":        "exp_...",
  "user_id":          "<supabase uuid>",
  "started_at":       1745000000000,
  "updated_at":       1745000123000,
  "phase":            "resolving" | "downloading" | "paused" | "complete" | "failed" | "partial",
  "target_folder":    "<abs path>",
  "options":          { ... },
  "items":            [
    {
      "seq":             1,
      "source":          "envato",
      "source_item_id":  "NX9WYGQ",
      "target_filename": "001_envato_NX9WYGQ.mov",
      "phase":           "queued" | "resolving" | "licensing" | "downloading" | "done" | "failed",
      "download_id":     <int chrome.downloads id, nullable>,
      "bytes_received":  0,
      "error_code":      null
    }
  ],
  "stats": { "ok_count": 0, "fail_count": 0, "total_bytes_downloaded": 0 }
}

"completed_items": {                       // cross-run skip cache
  "<user_id>|<target_folder>|<source>|<source_item_id>": { "size_bytes": 123, "completed_at": 1745000000 }
}

"deny_list": {                             // Envato ZIP-leak items
  "<source_item_id>": { "first_seen_at": 1745000000, "reason": "unsupported_filetype" }
}

"active_run_id": "exp_..."                 // lock; cleared on complete/cancel
"jwt":           { token, kid, user_id, expires_at }
"ext_version":   "0.1.0"
```

### Pause / resume / cancel

- `{type: "pause"}` → queue stops issuing new work; in-flight downloads continue (cannot abort `chrome.downloads` cleanly).
- `{type: "resume"}` → picks up from persisted queue state.
- `{type: "cancel"}` → abort in-flight via `chrome.downloads.cancel(downloadId)`, clear run state, fire `export_completed` with `ok_count`/`fail_count` as-is.

### Keep-awake

`chrome.power.requestKeepAwake("system")` on run start, `chrome.power.releaseKeepAwake()` on complete/pause/cancel.

### Network interrupt

On `chrome.downloads.onChanged` with `state === "interrupted"`:
- If `error` matches `NETWORK_*` → `chrome.downloads.resume(downloadId)` up to 3 times with exponential backoff. Beyond 3 → `network_failed`.
- If `error` matches `FILE_*` → disk issue, hard stop queue, popup: "Disk error — change folder and retry."
- If `error === "USER_CANCELED"` → mark `cancelled`, continue queue.

### Large run realities (per main spec § "Large exports (100 GB+)")

- Signed URLs expire ~1h after minting → **just-in-time URL fetching** (each downloader refetches immediately before its download starts; do NOT batch URL fetches at the start of the run).
- User closes Chrome / laptop sleeps → queue state persisted; SW wake resumes automatically.
- Flaky WiFi → `chrome.downloads.resume` as above.
- Insufficient disk: `navigator.storage.estimate()` pre-flight; abort with clear error if `sum(est_size_bytes) + 10% buffer > free`.

---

## Failure handling (full matrix)

Inherited from main spec § "Failure modes & handling". Summary of per-error behavior:

| Trigger | Phase | Strategy |
|---|---|---|
| Resolver tab timeout | 1 | Retry once at 30s. Then skip, mark `resolve_failed`. |
| Resolver: no UUID in redirect | 1 | Item delisted. Skip, no retry. Mark `envato_unavailable`. |
| `download.data` 5xx / DNS / timeout | 2 | Exp backoff 1s→5s→15s→60s, 4 attempts. Then `license_failed`. |
| `download.data` 401 | 2 | Session expired. Pause queue, send `{type:"refresh_session"}` equivalent for Envato (popup prompt). Mark `envato_session_401` + fire `session_expired`. |
| `download.data` 402 or "upgrade" 403 | 2 | Tier-restricted. Skip, don't hard-stop. Mark `envato_402_tier`. |
| `download.data` 403 generic | 2 | **Hard stop** queue. Popup + telemetry. Mark `envato_403`. |
| `download.data` 429 | 2 | `Retry-After + 20% jitter`, 1 retry. Second 429 → pause 5min, 1 final retry, then hard stop. Mark `envato_429`. |
| `download.data` empty `downloadUrl` | 2 | Skip. Mark `envato_unavailable`. |
| Signed URL filename ends `.zip`/`.aep`/`.prproj` | 2 | Abort before GET. Add `source_item_id` to deny-list. Mark `envato_unsupported_filetype`. One telemetry event per item per 24h. |
| `/api/pexels-url` 404 / `/api/freepik-url` 404 | 2 | Item removed upstream. Skip, mark `pexels_404` / `freepik_404`. |
| `/api/freepik-url` 429 | 2 | Pause 5min, 1 retry. Still 429 → hard stop. |
| `/api/freepik-url` 503 | 2 | Mark all Freepik items `freepik_unconfigured`, skip. Fire one telemetry event summarizing count. |
| Signed CDN URL expired mid-download | 3 | Refetch URL for this item, retry download once. |
| `chrome.downloads` NETWORK_* | 3 | `resume()` × 3 with exp backoff. Then `network_failed`. |
| `chrome.downloads` FILE_* | 3 | Hard stop queue. `disk_failed`. |
| `chrome.downloads` USER_CANCELED | 3 | Mark `cancelled`, continue. |
| File size mismatch | 3 | Delete file, retry once. Then `integrity_failed`. |
| Browser closed mid-run | any | State persisted; resumes on SW wake. Popup: "Resume (X/Y)?" |

### Rate limiting / TOS / fair use

Per main spec § "Rate limiting, TOS, fair use":

1. Only triggered by explicit user action.
2. 0.5-3s jittered gap between `download.data` calls.
3. 300-item hard cap per run.
4. Daily cap: 500 downloads per source per user, tracked in `chrome.storage.local.daily_counts[<yyyymmdd>][<source>]`. Warn at 400; hard stop at 500.
5. Pre-flight session sanity check before every run.

Pexels/Freepik: rate-limited server-side by our backend; extension only sees 429s if our server has issues or Freepik upstream errors.

---

## Telemetry — when to fire which event

All fire to `POST /api/export-events` with the extension JWT. Payloads use the schema from "Request/response shapes".

| Extension state transition | Event | Notes |
|---|---|---|
| `{type: "export"}` received, preflight passed | `export_started` | `meta: {total_items, total_bytes_est, source_breakdown: {envato: N, pexels: M, freepik: K}}` |
| Envato Phase 1 complete for an item | `item_resolved` | `meta: {resolve_ms}` |
| Envato Phase 2 complete for an item | `item_licensed` | `meta: {license_ms}` |
| Any source's download completes successfully | `item_downloaded` | `meta: {bytes, download_ms, filename}` |
| Any source's item failed retry-exhausted | `item_failed` | `error_code` REQUIRED; `meta: {attempts, final_http_status}` |
| Envato 429 hit | `rate_limit_hit` | `meta: {retry_after_sec}` |
| Envato `download.data` 401 | `session_expired` | Fire once per run max. |
| `{type: "pause"}` received | `queue_paused` | `meta: {reason: "user"}` |
| `{type: "resume"}` received | `queue_resumed` |  |
| Run ends (complete / cancel / failed) | `export_completed` | `meta: {ok_count, fail_count, wall_seconds, total_bytes}` REQUIRED — backend uses these to derive final status |

### Offline telemetry queue

If `fetch('/api/export-events')` fails (network down), queue the event in `chrome.storage.local.telemetry_queue` and retry with exp backoff. Cap queue at 500 events; beyond that, drop oldest with a "dropped N events" marker event.

---

## Popup UI

**Purpose:** status-only. The in-progress UI (states A–F per main spec) lives on the web app's export page. The popup is for quick inspection and sign-in shortcuts when no web app tab is open.

States:
- No auth: "Sign in via transcript-eval" → opens transcript-eval in a new tab.
- Auth ok, no Envato session: "Sign in to Envato" button.
- Auth ok, Envato ok, no active run: "Ready for export".
- Active run: summary (X / Y done, ETA) + "Open export page" button.
- Post-run (within 5 min): "Export complete: 47 / 47".

Popup never initiates an export or shows queue UI beyond a one-line summary. All detail lives in the web app.

---

## Testing + local dev

### Mock mode

Config flag `env=dev` (set in `manifest.json` for the dev build) redirects Envato URLs to a local mock server (`npm run dev:ext` in the web app repo starts the mock + builds extension in dev mode + points at `localhost:5173`).

Mock serves:
- Canned HTML for Envato scrape pages.
- Remix-streaming responses for `download.data`.
- Signed URLs pointing at a local ~100MB test clip.

Fixtures in `extension/fixtures/` — captured HARs from real runs with cookies redacted. Regenerated when Envato changes HTML.

### Unit tests

- `modules/queue.js` — mock `chrome.downloads`, assert concurrency / retry / pause behavior.
- `modules/sources.js` — mock backend `/api/pexels-url` / `/api/freepik-url`, assert URL refresh on expiry.
- `modules/auth.js` — assert 401 → refresh_session flow.
- `modules/envato.js` — mock tab + webNavigation, assert resolver + license + deny-list interaction.

### Integration / E2E

- Dedicated test Envato subscription (~$33/mo).
- Puppeteer or Playwright driving the extension end-to-end against staging backend (NOT prod) — one full run per week in CI as a smoke test.
- Test accounts in 1Password vault (not in repo).

### CI

- Extension built + packaged per commit to `main`.
- `.crx` and `.zip` artifacts uploaded to GitHub Releases on tag.
- Chrome Web Store auto-submission on tagged release (Chrome Web Store API supports it). Review still required, upload automated.

---

## Distribution

### Chrome Web Store submission

- One-time $5 Google Developer fee.
- Privacy policy URL required → `transcript-eval.com/privacy`.
- Description: "Export your transcript-eval projects to Premiere with b-rolls from your own subscription accounts." **NOT** "Envato downloader" — prior such extensions have been pulled after DMCA complaints.
- Single-purpose: extension does ONE thing (export b-rolls from transcript-eval). Chrome policy-compliant.
- Initial review: 1-3 business days. Updates same-day.

### Rollout (phased)

1. **Beta (weeks 1-2):** unlisted Web Store link. You + handful of testers. Feature-flagged on `/editor/...`.
2. **Soft launch (weeks 3-4):** public listing, feature flag keeps button hidden for new signups.
3. **GA:** open to all.

### Runtime feature flags

Extension fetches `GET /api/ext-config` (new endpoint — not yet shipped in Phase 1; add in a minor Phase 1.5 PR) at SW start + on each export. Response:

```jsonc
{
  "min_ext_version":       "0.3.0",
  "export_enabled":        true,
  "envato_enabled":        true,
  "pexels_enabled":        true,
  "freepik_enabled":       false,      // can flip off if Freepik upstream is broken
  "daily_cap_override":    null,
  "slack_alerts_enabled":  true
}
```

Extension honors flags; on `export_enabled: false`, popup shows "Export temporarily disabled — check transcript-eval.com for status."

### Canary channel (optional, for major releases)

Second Web Store listing "transcript-eval Export Helper Beta" with 5-10% opt-in. Main listing on last-stable. Extension package identical except for a `channel: "canary"` flag that fetches a different `ext-config` endpoint.

---

## Diagnostic bundle

Popup has "Export diagnostic bundle" button (also triggerable from the web app's State F).

Produces a `.zip` containing:
- Recent queue state (last 24h) from `chrome.storage.local`.
- Last 200 events emitted to `/api/export-events`.
- Browser + OS + extension version strings.
- Redacted cookie presence flags (booleans: `has_envato_cookie: true`).

**Never** includes: cookie values, JWT tokens, actual file paths (only `~/Downloads/transcript-eval/export-<redacted>/`), video titles, user email.

User emails / uploads the bundle on a support ticket. Admin UI at `/admin/support` (future phase) lets you upload + view parsed contents alongside the related `exports` row.

---

## Privacy + data rights

- No video titles / search queries / usernames in event `meta`.
- `user_id` is the Supabase UUID, not PII.
- Backend event retention: 90 days, auto-purged. Extension-local state: kept until user uninstalls or "clear data".
- User opt-out: extension setting "Send diagnostic events" (default on). Off disables `/api/export-events` POSTs; export still works with no admin telemetry.
- GDPR DSAR: `DELETE /api/user/:id/export-events` (future Phase 10 endpoint) deletes all events for a user.
- Extension permissions disclosed at install: `downloads`, `tabs`, `cookies`, `power` — with one-line each explaining why.
- Privacy policy at `transcript-eval.com/privacy` documents: what events are sent, retention, opt-out, deletion path.

---

## Cross-browser

- **Chrome 120+**: primary target.
- **Edge, Arc, Vivaldi, Opera, Brave**: Chromium-based, should work with the same extension package. Test Edge explicitly; other forks best-effort.
- **Brave**: works but strict tracker-blocking may block our `/api/export-events` beacons on Envato's pages. Non-fatal; documented.
- **Chrome Enterprise** / managed policies: may block install. Corporate users need IT approval. Documented, not engineered around.
- **Safari, Firefox**: out of scope.
- **Chromebook**: untested; disk layout differs. Document unsupported until tested.

---

## Phased delivery

Same phase numbers as the main spec (§ "Implementation phases"). This extension spans phases 2, 3, 4, 5, 10, 11, 12 in that numbering. Reasonable chunking for PRs:

1. **Ext.1** — MV3 skeleton + service worker + popup stubs + JWT storage + `{type: "ping"}` round trip. No download flow yet.
2. **Ext.2** — Envato single item (resolve + license + download). Test against real Envato account.
3. **Ext.3** — Pexels + Freepik single item via backend endpoints.
4. **Ext.4** — Auth polish: 401 recovery, session refresh, popup sign-in flows, Envato cookie watcher.
5. **Ext.5** — Queue + concurrency + persistence + pause/resume/cancel + keep-awake.
6. **Ext.6** — Telemetry: wire every event to `/api/export-events` with offline queue.
7. **Ext.7** — Failure-mode polish: per-error strategies, deny-list, partial-run handling.
8. **Ext.8** — Diagnostic bundle + privacy opt-out.
9. **Ext.9** — Feature-flag fetch (requires backend Phase 1.5: `GET /api/ext-config`).
10. **Ext.10** — Cross-browser smoke + CI packaging.
11. **Ext.11** — Chrome Web Store submission (unlisted beta).
12. **Ext.12** — Soft launch → GA.

Timeline estimate: 4-6 weeks to Ext.12 inclusive, assuming no Envato breakage mid-build.

---

## Non-goals

- Standalone Electron / Tauri desktop app.
- UXP Premiere plugin (one-click import) — future phase, separate spec.
- Safari / Firefox native app.
- Envato as a login surface for the extension.
- Running without the web app open (the export page owns in-progress UI).
- Downloading without user click (always triggered by explicit Start Export).

---

## Open questions

1. **Chrome extension ID.** Web app `externally_connectable` + extension `externally_connectable` must match the extension's ID. That ID is assigned by Chrome Web Store on first upload. Dev workflow: use a key-pinned manifest during development so the ID is stable. Confirm the key-pinning approach before Ext.1 lands.

2. **`/api/ext-config` in Phase 1.5 vs. deferred.** Extension needs min-version gate + kill-switch before GA. Can ship without it for beta, but pre-GA it's table stakes. Flag for a small Phase 1.5 backend PR — maybe 30-60 min of work, same pattern as the other routes.

3. **Freepik URL TTL handling.** Backend sets `expires_at = Date.now() + 15min`. Freepik's real TTL is 15-60 min. The extension refetches on expiry but doesn't parse the token. If cost becomes a concern (each refetch is €0.05), consider parsing the `exp=...` query string and using the real TTL. Defer unless cost actually becomes a problem.

4. **Beta-test Envato subscription ownership.** The plan mentions "$33/mo subscription." Who pays / owns? Set up on a company card, share via 1Password. Coordinate before Ext.2 (the first task that hits Envato for real).

5. **Content-Length-based filename deduplication.** The `completed_items` cache uses `(source, source_item_id)` as key. If a user's `target_folder` has a file matching the filename but NOT our manifest (e.g. they dropped a same-named file there), we'd overwrite with `conflictAction: "uniquify"` → Chrome renames to `001_envato_NX9WYGQ (1).mov`. That breaks XMEML reference. Decide: pre-flight scan the folder and warn, or trust `uniquify` and let user fix manually. Probably option 2 for MVP.

6. **Popup vs. sidebar vs. devtools panel for in-depth state.** Popup is ephemeral (closes when user clicks elsewhere). If support diagnostics often want "show me what state the extension is in right now," a devtools panel is more robust. Defer; popup-only is fine for MVP.
