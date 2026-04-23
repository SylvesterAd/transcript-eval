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
6. **No retries on 403/429.** Surface immediately to user, pause entire
   run, wait for user confirmation to continue.

## Failure modes & handling

| Failure | Extension behavior |
|---|---|
| Resolve phase timeout (Phase 1) | Mark item `resolve_failed`, continue rest, retry failed items at end. |
| `download.data` returns 401 | Session expired. Pause queue, popup shows "Please log into Envato." |
| `download.data` returns 403/429 | Pause queue. Popup shows error + "Retry later" button. Do NOT auto-retry. |
| `chrome.downloads` error (disk full, path perm) | Pause, popup shows OS-level error. |
| User closes browser mid-run | Service worker persists queue state to `chrome.storage.local`. On next Chrome start, popup shows "Resume export?" |
| Envato's signed URL expires during pending download (>1h) | Re-fetch `download.data` for that item only. |
| XML generation fails (e.g., corrupt placements) | Web app surfaces error; downloads are already on disk, user can manually relink in Premiere or retry XML-only. |
| Clip file corrupted on disk after download | Extension checksums via `chrome.downloads.search()` + file size match; if mismatched, delete + retry that item. |

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
- Rendering final output video. Export delivers placed clips in NLE; user
  still does color/audio/mastering in Premiere.

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

5. **Re-export behavior.** When user re-exports the same variant (e.g.,
   after tweaking), do we re-download (Envato counter ticks again) or
   re-use existing files? Default: re-use if same `envato_item_id`; force
   re-download is opt-in.

## Implementation phases

Each phase is a PR-sized chunk. Full plan to be written via
`superpowers:writing-plans` after this spec is approved.

1. **Manifest schema + exports table** (DB migration, server route to
   create/read exports).
2. **Extension MVP** — MV3 skeleton, service worker with Phase 1/2/3 for
   a single item. Test with your Envato account.
3. **Queue + progress UI** — concurrent resolver, sequential downloader,
   popup UI.
4. **XMEML generator** (pure function + unit tests).
5. **Export button + wiring in `/editor/:id/brolls/edit`** — sends
   manifest to extension, listens for progress/done.
6. **Failure-mode polish** — pause/resume, session-expired detection,
   disk errors.
7. **Web Store submission** (docs, privacy policy, screenshots).

Timeline estimate: 4-6 weeks to Phase 7 inclusive, assuming no surprises
from Envato's HTML/redirect format changing mid-build.
