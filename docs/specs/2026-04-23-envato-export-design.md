# Envato B-Roll Export to Adobe Premiere Pro

## Goal

When a user picks a variant in `/editor/:id/brolls/edit` and clicks Export,
deliver (a) full-quality licensed Envato video files downloaded locally and
(b) an Adobe Premiere Pro-compatible XML file that places each clip at the
exact timeline position recorded in our state — with licensing flowing through
the user's own Envato subscription, not ours.

Out of scope for this spec: Pexels, Storyblocks, Adobe Stock. They integrate
via their official APIs (Storyblocks test keys already on file, Pexels key
already on file) and plug into the same export pipeline as a separate layer.
Envato is the hard case because it has no public API.

## User flow

1. User is logged into Envato Elements in their normal Chrome.
2. User has the `transcript-eval Export Helper` Chrome extension installed
   (one-time install, ~2 min).
3. In the web app: picks Variant C, clicks **Export**.
4. Web app generates an export manifest (300 items max), sends it to the
   extension via `chrome.runtime.sendMessage`.
5. Extension resolves each old Envato item ID to the new platform UUID,
   fetches the signed download URL, and saves the file with the filename
   our manifest dictates. All in the user's own browser session, user's IP.
6. When all downloads are complete, extension signals the web app.
7. Web app generates the xmeml XML in the same folder as the media.
8. User opens the XML in Premiere — 300 clips land at exact positions, done.

## Architecture

```
┌──────────────────────────┐     ┌─────────────────────────────────┐
│  transcript-eval web app │     │   Chrome extension (installed)  │
│  (Vite + React)          │     │   "transcript-eval Export Helper"│
│                          │     │                                  │
│  /editor/:id/brolls/edit │     │   manifest.json (MV3)            │
│     │                    │     │   service worker (background)    │
│     ▼                    │     │   popup.html (progress UI)       │
│  [Export Variant C] ─────┼────▶│                                  │
│                          │ postMessage                            │
│                          │     │   Phase 1: resolve old→new UUID  │
│                          │     │     open hidden tab              │
│                          │     │     watch navigation             │
│                          │     │     extract UUID from URL        │
│                          │     │     close tab                    │
│                          │     │                                  │
│                          │     │   Phase 2: get signed URL        │
│                          │     │     GET app.envato.com/          │
│                          │     │         download.data            │
│                          │     │     parse Remix JSON             │
│                          │     │                                  │
│                          │     │   Phase 3: save file             │
│                          │     │     chrome.downloads.download    │
│                          │     │     with our filename            │
│                          │     │                                  │
│                          │     │   progress events ───────────────┼──┐
│                          │◀────┤                                  │  │
│                          │     └─────────────────────────────────┘  │
│                          │                                           │
│    extension "done" ◀────┼───────────────────────────────────────────┘
│         │                │
│         ▼                │           ┌──────────────────────────────┐
│  Generate xmeml XML      │           │  ~/Downloads/transcript-eval/ │
│  in same folder as       │           │    export-<run-id>/           │
│  media                   │           │      media/                   │
│                          │           │        001_NX9WYGQ.mov        │
└──────────────────────────┘           │        002_TKT32A4.mov        │
                                       │        ...                    │
                                       │      project.xml   ◀── here   │
                                       └──────────────────────────────┘
                                                    │
                                                    ▼
                                         User opens project.xml
                                         in Premiere Pro
                                         → sequence with 300 clips
                                           at exact timeline_start
                                           positions
```

## Research summary (why these choices)

Every alternative to the Chrome-extension pattern was ruled out:

| Approach | Why rejected |
|---|---|
| Server-side download with user cookies | Envato sees datacenter IP; fingerprint-invalidates session; clearest TOS violation. |
| Browser-extension for Chrome+Firefox+Safari | Safari extension requires native Xcode app, Apple Developer account, store review for every update. Maintenance burden too high for this project. |
| Electron/Tauri desktop helper | 150MB+ install, separate login from user's normal Chrome (Envato session doesn't transfer). |
| Official Envato Elements Premiere plugin | Envato sunset their Adobe plugins August 21, 2025. Dead. |
| Adobe Stock integration | Excellent UX but Adobe Stock is expensive per user. Out-of-budget. |
| Envato public API | Does not exist for Elements. Envato Market API is unrelated. |
| `.prproj` direct generation | Adobe-proprietary binary format, no spec. |
| FCPXML (Final Cut X format) | Premiere does not import it. |

The one workable pattern: **Chrome extension running in user's own logged-in
browser session.** Envato sees the user's real IP + real cookies + normal
session, matching their fingerprint. The extension's downloads are click-
equivalent actions from the user's perspective (user initiated the export,
the extension is their proxy for clicking 300 buttons).

## Authentication

Two independent identity surfaces, with different mechanisms:

### 1. Envato session (for downloads)

The extension uses the user's existing Envato cookies — no separate login
inside the extension. If cookies are missing or expired:

- Popup shows: `Envato: ⚠ sign in required` with a "Sign in" button.
- Button opens `https://app.envato.com/sign-in` in a new tab.
- Extension watches `chrome.cookies.onChanged` for `envato_client_id`
  and/or `elements.session.5` — once set, marks session healthy.
- Any paused export queue resumes automatically.

**Pre-flight check before each run:** one GET to
`app.envato.com/download.data` with a reference itemUuid. 200 OK = proceed.
401 = prompt user, do not start.

Per-item subscription check is unnecessary — cookie-based session remains
valid for an entire run unless Envato invalidates mid-flight (handled in
failure modes).

### 2. transcript-eval identity (for event logging + export records)

Extension needs to know which transcript-eval user initiated the export.

**Do NOT make the extension the primary login for transcript-eval.**
Extension breaks = user locked out of app. Bad failure mode.

**Instead:** web app mints a short-lived session token (JWT, 8h TTL) and
passes it to the extension via `postMessage` on the first export click:

```js
// transcript-eval web app
chrome.runtime.sendMessage(EXTENSION_ID, {
  type: "session",
  token: "eyJ...",       // short-lived JWT signed by server
  user_id: "<uuid>",
  expires_at: <epoch_ms>
});
```

Extension stores the token in `chrome.storage.local`, uses it as
`Authorization: Bearer` when posting to `/api/export-events`. If the token
401s, extension asks web app to refresh via
`postMessage({ type: "refresh_session" })`. If the web app isn't open, popup
shows: "Open transcript-eval to continue."

### Popup status surface

The toolbar popup always shows combined health:

```
┌─────────────────────────────────────────────┐
│  transcript-eval Export Helper              │
│                                             │
│  transcript-eval:  ✓ connected              │
│  Envato:           ✓ subscription active    │
│                    (unlimited33_monthly)    │
│                                             │
│  [ Ready for export ]                       │
└─────────────────────────────────────────────┘
```

Each row is clickable when red — launches the respective sign-in flow.

## Download flow detail — three phases per item

### Phase 1: Resolve old ID → new platform UUID

Envato migrated from `elements.envato.com` to `app.envato.com` with new
UUIDs. Our scraper (which runs anonymously on public HTML for discovery)
captures the **old 7-char item ID** (e.g. `NX9WYGQ` from
`elements.envato.com/ocean-NX9WYGQ`). The download endpoint needs the
**new platform UUID** (e.g. `e4553817-fdb1-495b-add8-02643cee7211`).

The old→new redirect happens client-side in JS when a logged-in user loads
the old URL. The new UUID is NOT in the anonymous HTML response.

**Resolver (extension service worker):**

```js
async function resolveOldIdToNewUuid(oldUrl) {
  return new Promise(async (resolve, reject) => {
    const tab = await chrome.tabs.create({ url: oldUrl, active: false });
    const listener = (d) => {
      if (d.tabId !== tab.id) return;
      const m = d.url.match(
        /^https:\/\/app\.envato\.com\/[\w-]+\/([0-9a-f-]{36})/
      );
      if (m) {
        chrome.webNavigation.onCommitted.removeListener(listener);
        chrome.tabs.remove(tab.id);
        resolve(m[1]);
      }
    };
    chrome.webNavigation.onCommitted.addListener(listener);
    setTimeout(() => {
      chrome.webNavigation.onCommitted.removeListener(listener);
      chrome.tabs.remove(tab.id).catch(() => {});
      reject(new Error("resolve timeout"));
    }, 15000);
  });
}
```

**Batch with concurrency limit = 5:** ~3s/item serial, 5 parallel = ~3 min
for 300 items. Acceptable one-time cost per export.

**Cache:** once resolved, persist `{oldId → newUuid}` in
`chrome.storage.local`. Second export of the same item = instant.

### Phase 2: Get signed download URL

```
GET  https://app.envato.com/download.data
     ?itemUuid=<NEW_UUID>
     &itemType=stock-video
     &_routes=routes/download/route

Auth: session cookies only (no CSRF, no JWT, no bearer)
Response: Remix streaming JSON (~700 bytes):
  [...,"downloadUrl","https://video-downloads.elements.envatousercontent.com/files/<ASSET>/source.mov?Expires=...&Signature=..."]
```

Parse:

```js
const text = await resp.text();
const m = text.match(/"downloadUrl","(https:\/\/[^"]+)"/);
const signedUrl = m[1];
```

Signed URL is CloudFront-signed, ~1 hour valid, not one-shot.

**Hitting this endpoint commits a license against the user's subscription
and increments their fair-use counter.** Do not call it until the user has
explicitly clicked Export. Never speculatively. Do not retry on network
failure except with exponential backoff (3 attempts max).

### Phase 3: Save file with our filename

```js
await chrome.downloads.download({
  url: signedUrl,
  filename: `transcript-eval/export-${runId}/media/${ourFilename}`,
  saveAs: false,          // no dialog; user opt-in per-export in extension UI
  conflictAction: "uniquify"
});
```

Envato's default filename (e.g. `ocean-2026-01-28-05-03-58-utc.mov`) is
overridden at download time. Our filename scheme: `<seq>_<oldId>.mov`
(e.g. `001_NX9WYGQ.mov`) so xmeml path resolution matches deterministically.

## Large exports (100 GB+)

A real export can be 300 items × ~150-300 MB each ≈ 30-90 GB. At typical
home internet (100 Mbps), that's 2-4 hours. This breaks naive designs:

| Problem | Mitigation |
|---|---|
| Signed URLs expire ~1 hour after minting | **Just-in-time URL fetching.** Don't batch-fetch 300 URLs upfront. Each worker fetches `download.data` immediately before starting its download; URL is <60s old when download begins. |
| User closes Chrome or laptop sleeps mid-run | **Persistent queue state in `chrome.storage.local`.** Queue resumes automatically on service-worker wake. Popup shows "Resume export (203/300 remaining)?" button. |
| macOS/Windows auto-sleep kills downloads | `chrome.power.requestKeepAwake("system")` on run start, `releaseKeepAwake()` on complete/pause. User override: "Keep awake during exports" toggle in popup. |
| Flaky WiFi interrupts a single file mid-download | `chrome.downloads.resume(downloadId)` when `onChanged` reports `state=interrupted` with a `NETWORK_*` error. Chrome preserves byte offset. Max 3 resume attempts before marking `network_failed`. |
| Insufficient disk space | Before run, estimate total bytes (sum of captured file sizes, or 200 MB × count fallback). Check `navigator.storage.estimate()`. Abort with clear error if insufficient + 10% buffer. |
| 300+ parallel downloads saturate uplink or flag Envato | **Concurrency limits:** 5 parallel in Phase 1 (resolver), **3 parallel in Phases 2+3** (license + download). Three concurrent big downloads is roughly the ceiling a typical user would initiate manually. |
| No user visibility over 4 hours | Popup shows live: `47/300 done · 12.3 GB / 89.1 GB · ETA 2h 14m · current 85 Mbps`. Per-item rows: ⏳ / ✓ / ⚠ / ✗. Pause / resume / cancel controls. |

### Run state persistence

Every phase transition → `chrome.storage.local.set({ [runId]: queueState })`:

```
{
  runId,
  started_at, updated_at,
  items: [
    { seq, itemId, envato_item_url, target_filename,
      phase,            // queued | resolving | licensing | downloading | done | failed
      download_id,      // chrome.downloads id once started
      bytes_received,
      error_code        // nullable
    },
    ...
  ],
  stats: { completed, failed, total_bytes_downloaded }
}
```

Crash-safe: service worker writes state after every phase transition, so a
Chrome restart, OS reboot, or laptop sleep cannot lose more than the current
in-flight item.

### Partial-run XML generation

If a run finishes with N of 300 items complete (user cancelled, or a few
items permanently failed): web app can still generate XML from the
successful downloads. Missing clips appear as Premiere-offline (red) — user
can manually relink or re-run export for just the missing items.

## Data model changes

### `broll_searches.results_json` — add fields

Current `result` shape (per `project_transcript_eval.md` memory):

```
{ url, preview_url, preview_url_hq, thumbnail_url, source, ... }
```

Add per-result:

```
{
  ...
  envato_item_id:  "NX9WYGQ",         // old 7-char ID (from scraper)
  envato_item_url: "https://elements.envato.com/ocean-NX9WYGQ",
  // Optional capture at search time to avoid probing at export:
  resolution: { width, height },
  duration_seconds,
  frame_rate
}
```

`envato_item_url` is what goes into the export manifest. New UUID is NOT
stored server-side — the extension resolves it client-side and caches in
`chrome.storage.local`.

### New table: `exports`

Tracks export runs so user can re-trigger, diagnose, resume partial failures.

```sql
CREATE TABLE exports (
  id TEXT PRIMARY KEY,                  -- ULID, short form
  plan_pipeline_id INTEGER NOT NULL,
  variant_label TEXT NOT NULL,          -- "Variant C"
  status TEXT NOT NULL,                 -- pending, in_progress, complete, failed, partial
  manifest_json TEXT NOT NULL,          -- array of items for extension
  result_json TEXT,                     -- per-item status from extension
  xml_path TEXT,                        -- relative to user's Downloads/
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

`manifest_json` shape (per item):

```
{
  seq:                1,
  timeline_start_s:   25.4,
  timeline_duration_s: 4.0,
  source:             "envato",
  envato_item_url:    "https://elements.envato.com/ocean-NX9WYGQ",
  envato_item_id:     "NX9WYGQ",
  target_filename:    "001_NX9WYGQ.mov",
  resolution:         { width: 1920, height: 1080 },
  frame_rate:         30
}
```

## Chrome extension surface area

### Files (~400 LOC total)

```
extension/
├── manifest.json         MV3 manifest
├── service_worker.js     Phase 1/2/3 queue, chrome.downloads, progress
├── popup.html            Export progress UI (opens from toolbar)
├── popup.js              Renders queue status, pause/resume
├── content_script.js     Receives postMessage from transcript-eval page
└── icons/                Required by Web Store
```

### `manifest.json` essentials

```json
{
  "manifest_version": 3,
  "name": "transcript-eval Export Helper",
  "version": "0.1.0",
  "permissions": ["downloads", "tabs", "webNavigation", "storage"],
  "host_permissions": [
    "https://elements.envato.com/*",
    "https://app.envato.com/*",
    "https://video-downloads.elements.envatousercontent.com/*",
    "http://localhost:5173/*",
    "https://<production-domain>/*"
  ],
  "externally_connectable": {
    "matches": [
      "http://localhost:5173/*",
      "https://<production-domain>/*"
    ]
  },
  "background": { "service_worker": "service_worker.js" },
  "action": { "default_popup": "popup.html" }
}
```

`externally_connectable` lets the transcript-eval web app send messages
directly to the extension via `chrome.runtime.sendMessage(EXT_ID, msg)`
without needing a content script.

### Chrome Web Store submission

- $5 one-time Google developer fee.
- Privacy policy URL required — add to transcript-eval site (`/privacy`).
- Description must explicitly position as "exports b-rolls from your
  transcript-eval projects via your logged-in Envato session." NOT as
  "Envato downloader." Prior "envato downloader" extensions have been
  pulled after DMCA complaints; framing matters.
- Expect 1-3 business days for initial review. Updates are same-day.

## XMEML generation

FCP7-style `.xml` (xmeml), written in same folder as `media/`. Premiere's
auto-relink scans the XML's directory.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="seq-1">
    <name>Variant C</name>
    <duration>27000</duration>   <!-- total frames at 30fps -->
    <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>1920</width><height>1080</height>
            <rate><timebase>30</timebase></rate>
          </samplecharacteristics>
        </format>
        <track>
          <!-- one clipitem per b-roll placement -->
          <clipitem id="clip-001">
            <name>001_NX9WYGQ.mov</name>
            <start>762</start>                <!-- timeline_start_s * 30 -->
            <end>882</end>                    <!-- + duration_s * 30 -->
            <in>0</in>
            <out>120</out>                    <!-- source in/out in frames -->
            <file id="file-001">
              <name>001_NX9WYGQ.mov</name>
              <pathurl>file://./media/001_NX9WYGQ.mov</pathurl>
              <duration>120</duration>
              <rate><timebase>30</timebase></rate>
              <media>
                <video>
                  <samplecharacteristics>
                    <width>1920</width><height>1080</height>
                  </samplecharacteristics>
                </video>
              </media>
            </file>
          </clipitem>
          <!-- ... 299 more ... -->
        </track>
      </video>
    </media>
  </sequence>
</xmeml>
```

### Sequence frame rate

Hardcode **30fps** for sequences. Envato sources vary (24, 25, 30, 60).
Premiere conforms source clips to sequence rate automatically — no artifacts
for typical b-roll use.

### Missing metadata fallback

If `resolution` or `frame_rate` was not captured during search, fall back
to `1920x1080 / 30fps` for the xmeml `<samplecharacteristics>`. Premiere
reads the actual file metadata on import and corrects the display; the xml
values are advisory.

### File at: `server/services/xmeml-generator.js` (~180 LOC)

```js
export function generateXmeml({ sequenceName, placements, frameRate = 30 }) {
  // placements: [{ seq, timelineStart, timelineDuration, filename, width, height }, ...]
  // returns: XML string
}
```

Pure function, no I/O. Unit-testable.

## Rate limiting, TOS, fair use

Envato's Fair Use Policy forbids "scripts or bots to mass generate or mass
download Content" and "excessively high volumes in a short amount of time."
Published threshold: none. Enforcement: account suspension.

Hard rules the extension enforces:

1. **Only triggered by explicit user action** — no speculative downloads,
   no background queuing without the user clicking Export.
2. **0.5-3s jittered gap** between successive `download.data` fetches
   within an export run (per item, not per parallel worker).
3. **300-item hard cap per export run.** Above that, show an error and
   ask the user to split the export. (Revisit if product needs higher.)
4. **Daily cap: 500 downloads.** Tracked in `chrome.storage.local`. Soft
   wall — user can bypass with a click, but warns. Far below any realistic
   Envato auto-flag threshold.
5. **Session-IP sanity check.** Before a run, extension fetches
   `app.envato.com/download.data?itemUuid=...` once with a known-good
   reference item. If response is a 401/redirect-to-login, abort the run
   and prompt user to re-login.
6. **403 = hard stop.** Not auto-recoverable (account flagged or API
   change). Surface immediately, Slack alert.
7. **429 = backoff.** Honor `Retry-After` header + 20% jitter, then retry
   once. If second 429, pause 5 min and try once more before hard stop.

## Observability (admin visibility)

### Event ingestion endpoint

New route: `POST /api/export-events` on transcript-eval backend.

Payload (single event or array of events):

```
{
  export_id:    "exp_01JQ...",
  user_id:      "<transcript-eval user uuid>",
  event:        "item_failed",
  item_id:      "NX9WYGQ",
  phase:        "download",       // resolve | license | download | xml
  error_code:   "envato_403",
  http_status:  403,
  retry_count:  2,
  meta:         { url_host: "video-downloads.elements..." },
  t:            1776942569000
}
```

Auth: Bearer JWT (from postMessage handshake, see Authentication).

### Event types (MVP)

| Event | When | Key fields |
|---|---|---|
| `export_started` | User clicks Export, extension accepts manifest | total_items, est_bytes |
| `item_resolved` | Phase 1 complete for one item | item_id, resolve_ms |
| `item_licensed` | Phase 2 complete for one item | item_id, license_ms |
| `item_downloaded` | Phase 3 complete for one item | item_id, bytes, download_ms |
| `item_failed` | Any phase errored after retries exhausted | item_id, phase, error_code, http_status, retry_count |
| `rate_limit_hit` | 429 response from Envato | retry_after_sec |
| `session_expired` | 401 on download.data | (none) |
| `queue_paused` / `queue_resumed` | User-initiated | reason |
| `export_completed` | Run end (success or partial) | ok_count, fail_count, wall_seconds, total_bytes |

### Storage

New table: `export_events`

```sql
CREATE TABLE export_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  export_id    TEXT NOT NULL,
  user_id      TEXT,
  event        TEXT NOT NULL,
  item_id      TEXT,
  phase        TEXT,
  error_code   TEXT,
  http_status  INTEGER,
  retry_count  INTEGER,
  meta_json    TEXT,
  t            INTEGER NOT NULL,
  received_at  INTEGER NOT NULL
);
CREATE INDEX idx_export_events_export    ON export_events(export_id, t);
CREATE INDEX idx_export_events_failures  ON export_events(event, received_at)
  WHERE event IN ('item_failed','rate_limit_hit','session_expired');
```

Retention: 90 days, then auto-purged by a nightly job.

### Admin UI

Simple list view at `/admin/exports`:

- Recent exports (paginated), per-export event timeline on click.
- Filter: `event IN ('item_failed','rate_limit_hit','session_expired')`
  for triage.
- Per-user view: all exports for a given `user_id` + failure rate.

### Slack alerting

Wire into existing `server/services/slack-notifier.js`. Fire `notify()` on:

- Any `item_failed` with `error_code` in `{ envato_403, envato_429 }`.
- Any `session_expired` (suggests Envato fingerprint change or user
  logout).
- Any `export_completed` where `fail_count >= 10`.
- Pattern detector: ≥3 distinct users hitting `envato_403` within 15 min
  → Slack with "possible Envato API change" title.

Dedupe: same `{user_id, event, error_code}` within 60s collapses to one
Slack message. Prevents floods during a mass incident.

### Privacy

- No video titles, search queries, or user-identifying file paths in
  event `meta`.
- `user_id` is a transcript-eval internal UUID — not PII.
- User opt-out: extension setting "Send diagnostic events to transcript-eval
  admins" (default on). Off disables `/api/export-events` posts but export
  itself still works.

## Failure modes & handling

Per-error-code behavior. **Retry semantics: exponential backoff unless
noted; 1s → 5s → 15s → 60s; max 4 attempts.**

| Trigger | Phase | Strategy |
|---|---|---|
| Resolver tab navigation timeout | 1 resolve | Retry once with 30s timeout. Then skip + mark `resolve_failed`; continue rest of queue. Event: `item_failed`. |
| Resolver: UUID not found in redirect URL | 1 resolve | Item likely delisted. Skip + mark `resolve_failed`; no retry. |
| `download.data` network error (timeout / DNS fail / 5xx) | 2 license | Exp backoff, 4 attempts. Then mark `license_failed`. |
| `download.data` 401 | 2 license | Session expired. Pause entire queue. Popup: "Re-login to Envato". Resume on session restored. Event: `session_expired`. |
| `download.data` 403 | 2 license | Hard stop entire run. Not auto-recoverable (account flagged or API change). Popup shows error + "Contact support". Event: `item_failed` with `error_code=envato_403` + Slack alert. |
| `download.data` 429 | 2 license | Wait `Retry-After` + 20% jitter, retry once. On second 429, pause queue 5 min then retry once more before hard stop. Event: `rate_limit_hit`. |
| `download.data` returns empty `downloadUrl` | 2 license | Item unavailable. Skip + mark `license_failed`; no retry. |
| Signed CDN URL expired mid-download (403 on downloads host) | 3 download | Automatic re-fetch of `download.data` for this item, retry download once. Common on long runs. |
| `chrome.downloads` interrupted with `NETWORK_*` error | 3 download | `chrome.downloads.resume()`. Max 3 resume attempts. Then mark `network_failed`. |
| `chrome.downloads` interrupted with `FILE_*` error | 3 download | Disk issue. Hard stop queue, popup shows OS error + "Change folder" button. |
| `chrome.downloads` `USER_CANCELED` | 3 download | Mark `cancelled`, do not retry, continue queue. |
| File size mismatch after download complete | 3 download | Delete file, retry once. Then mark `integrity_failed`. |
| User closes browser mid-run | any | Queue persisted. On next service-worker wake, popup shows "Resume export (N/M)?". |
| Machine sleeps | any | `chrome.power.requestKeepAwake()` prevents this. If override fails, resumes when machine wakes. |
| XML generation fails (missing fields, bad placements) | xml | Web app surfaces error; downloaded files already on disk. User can fix data + re-run XML-only. |
| Extension not installed / not reachable | web app | Export button in web app shows "Install the transcript-eval Export Helper extension" + Web Store link. |

## Non-goals for this spec

- Multi-source export (Pexels/Storyblocks/Adobe Stock). Each will plug in
  via its own download module with uniform manifest shape.
- UXP Premiere plugin (one-click in-Premiere import). Consider after
  shipping the xmeml path.
- Safari / Firefox / Edge support. Chrome-only per user decision.
- Resolve, DaVinci, Final Cut Pro export. Xmeml works for most, untested,
  deferred.
- Server-side download orchestration. Never. Violates the "user's IP"
  constraint.
- Extension as primary login provider for transcript-eval. Extension
  receives a short-lived token for event reporting only; identity stays
  with the web app's existing auth.
- Rendering final output video. Export delivers placed clips in NLE; user
  still does color/audio/mastering in Premiere.

## Resolved decisions

- **Re-export behavior.** Default: **re-use existing files** if
  `{envato_item_id, target_filename}` already present on disk for the
  same run folder. Force re-download is an opt-in checkbox
  ("Re-download all files even if already present") in the extension
  popup before starting a run. Rationale: protect user's Envato fair-use
  counter; re-downloads waste bandwidth and subscription quota when
  files are unchanged.

## Open questions

1. **Distribution method for extension.** Web Store (public, slow updates)
   vs. unlisted Web Store link (still reviewed, but private) vs. dev-mode
   sideload (per-user `.crx` drag-and-drop). Start with unlisted for beta,
   move to public when stable.

2. **How user provides "target folder"** — accept `~/Downloads/transcript-eval/`
   as fixed default, or invoke File System Access API once per export for
   explicit picker? FSA is cleaner UX but adds a permission prompt.

3. **Mapping export → stored file path.** Extension tells web app where
   files landed. Web app stores this in `exports.xml_path` for
   reproducibility. Include full user-home-relative path or strip
   user-identifiable parts?

4. **Envato session check interval.** Before each item, before every N
   items, or only at start? Trade-off: more checks = less risk of partial
   failure, but every check hits Envato.

## Implementation phases

Each phase is a PR-sized chunk. Full plan to be written via
`superpowers:writing-plans` after this spec is approved.

1. **DB schemas + server routes** — `exports` table, `export_events` table,
   routes: create/read exports, `POST /api/export-events`, JWT mint
   endpoint for the extension handshake.
2. **Extension MVP** — MV3 skeleton, service worker with Phase 1/2/3 for
   a single item, postMessage handshake with web app. Test end-to-end
   against live Envato account.
3. **Auth + popup status UI** — JWT storage, refresh flow, session health
   checks for both Envato and transcript-eval, clickable sign-in rows.
4. **Queue + progress UI** — concurrent resolver (5 parallel), 3-concurrent
   downloader, JIT URL fetching, persistent queue state, keep-awake,
   pause/resume/cancel.
5. **XMEML generator** (pure function + unit tests in `server/services/`).
6. **Export button + wiring in `/editor/:id/brolls/edit`** — sends
   manifest, listens for progress/done, writes xmeml to the download
   folder when extension signals complete.
7. **Failure-mode polish** — per-error retry strategies, session-expired
   recovery, disk errors, integrity checks, partial-run XML.
8. **Observability wiring** — event emission from extension, backend
   ingestion, Slack dedup + alerts, admin UI list/detail view.
9. **Web Store submission** — copy, privacy policy, screenshots, review.

Timeline estimate: 5-7 weeks to Phase 9 inclusive, assuming no surprises
from Envato's HTML/redirect format changing mid-build.
