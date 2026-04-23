# B-Roll Export to Adobe Premiere Pro

## Goal

When a user clicks Export on `/editor/:id/brolls/edit`, deliver:
(a) full-quality licensed video files for every b-roll in the selected
variant(s), downloaded to the user's laptop, and
(b) one Adobe Premiere-compatible XML per variant that places each clip at
the exact timeline position recorded in state.

Source coverage at launch: **Envato, Pexels, Freepik.** Envato is the hard
case (no public API, user's own subscription required). Pexels + Freepik
have APIs and go through our server. Storyblocks and Adobe Stock: explicit
non-goals for now.

## User flow (brief)

1. User is logged into transcript-eval, viewing a variant in
   `/editor/:id/brolls/edit`.
2. Clicks **Export** → opens a dedicated export page `/editor/:id/export`.
3. Export page checks: is the Chrome extension installed, are Envato/our
   sessions valid, enough disk space, how many items + estimated bytes.
4. User picks: which variants to export, target folder, download options.
5. Clicks **Start Export** → extension downloads Envato clips (user's
   session) + API-proxied clips (Pexels/Freepik URLs our server provides)
   to the target folder.
6. On completion: web app generates one XMEML per variant in the folder.
7. User opens the XML(s) in Premiere; clips land at exact positions.

## UX flow (end-to-end)

Detailed walkthrough because the "install a browser extension to export"
step adds friction. Every screen needs a fallback path.

### Screen 1 — Editor, variant view (existing)

`/editor/:id/brolls/edit?variant=C`

- Adds an "Export" button in the variant toolbar.
- Button opens `/editor/:id/export?variant=C` in a new tab.

### Screen 2 — Export page, "pre-flight"

`/editor/:id/export?variant=C`

On page load, web app runs parallel checks:

```
[checking extension ...]   chrome.runtime.sendMessage(EXT_ID, {type:"ping"})
[checking session   ...]   extension replies with session status or error
[computing manifest ...]   fetch items for variant(s), sum estimated bytes
[checking disk      ...]   navigator.storage.estimate()
```

Four possible states, rendered as progressive UI:

**State A — Extension not installed**

```
┌───────────────────────────────────────────────────────────────┐
│  Ready to export Variant C                                    │
│                                                               │
│  Install the Export Helper Chrome extension to continue.      │
│                                                               │
│  This extension downloads your licensed b-roll files into a   │
│  folder, using your own Envato subscription. Files never      │
│  leave your computer.                                         │
│                                                               │
│  [ Install from Chrome Web Store ]  (opens in new tab)        │
│                                                               │
│  After install, this page updates automatically.              │
└───────────────────────────────────────────────────────────────┘
```

Web app polls for extension presence every 2s. When detected, transitions
to next state. If user is on non-Chrome browser: show "This feature
requires Chrome. Safari/Firefox support is planned." with install link for
Chrome.

**State B — Extension installed, Envato session missing/expired**

```
┌───────────────────────────────────────────────────────────────┐
│  Ready to export Variant C                                    │
│                                                               │
│  ✓ Export Helper installed                                    │
│  ⚠ Sign in to Envato to continue                              │
│     Your b-roll includes 12 Envato clips. Sign in to license  │
│     and download them.                                        │
│                                                               │
│  [ Sign in to Envato ]  (opens envato.com in new tab)         │
│                                                               │
│  This page updates automatically after sign-in.               │
└───────────────────────────────────────────────────────────────┘
```

If no Envato items in manifest: skip this state entirely.

**State C — All preconditions met, show summary**

```
┌───────────────────────────────────────────────────────────────┐
│  Variant C · 47 clips · ~8.5 GB                               │
│                                                               │
│  ✓ Export Helper installed                                    │
│  ✓ Envato: active subscription (unlimited33_monthly)          │
│  ✓ Disk space available                                       │
│                                                               │
│  Sources:                                                     │
│    Envato   12 clips  (your subscription)                     │
│    Pexels   30 clips  (free)                                  │
│    Freepik   5 clips  (transcript-eval account)               │
│                                                               │
│  Target folder: ~/Downloads/transcript-eval/export-225-c/     │
│    [ Change folder ]  (File System Access API picker)         │
│                                                               │
│  □ Also export Variant A and Variant B                        │
│      Shares the media folder, adds 2 more XML files.          │
│                                                               │
│  □ Re-download files already on disk                          │
│      Default off: skip clips already downloaded in this       │
│      folder to protect your Envato fair-use counter.          │
│                                                               │
│  Estimated time: 25-45 min at typical home internet.          │
│                                                               │
│  [ Start Export ]                                             │
└───────────────────────────────────────────────────────────────┘
```

Sources count is dynamic — only shows rows for sources in this variant.

**State D — Export running**

```
┌───────────────────────────────────────────────────────────────┐
│  Exporting Variant C                                          │
│                                                               │
│  ████████████░░░░░░░░░░░░░░░░  12 / 47 done · 2.1 / 8.5 GB    │
│  current: 012_NX9WYGQ.mov  (83 MB)                            │
│  speed: 95 Mbps · ETA 18 min                                  │
│                                                               │
│  [ Pause ]   [ Cancel ]                                       │
│                                                               │
│  ── item status ──────────────────────────────────────        │
│  ✓ 001_pexels_123.mp4         46 MB   ·  4.8 s                │
│  ✓ 002_NX9WYGQ.mov            112 MB  ·  12.3 s               │
│  ✓ 003_freepik_abc.mp4        89 MB   ·  9.1 s                │
│  ...                                                          │
│  ⏳ 012_NX9WYGQ.mov            21 / 83 MB ·  25%              │
│  · 013_pexels_456.mp4                                         │
│  · 014_NX9WYGQ.mov                                            │
│  ...                                                          │
│  ── done counts ─────────────────────────────────────         │
│  12 ok · 0 failed · 35 remaining                              │
└───────────────────────────────────────────────────────────────┘
```

Page can be closed; extension keeps running. On reopen, page reconnects,
queries extension for current state, resumes showing progress.

**State E — Export complete**

```
┌───────────────────────────────────────────────────────────────┐
│  Export complete                                              │
│                                                               │
│  47 / 47 clips downloaded · 8.3 GB · 28 min                   │
│                                                               │
│  Folder: ~/Downloads/transcript-eval/export-225-c/            │
│    [ Open folder ]    [ Copy path ]                           │
│                                                               │
│  XML files:                                                   │
│    ▸ variant-c.xml    ← open this in Premiere                 │
│    ▸ variant-a.xml    (if you opted in)                       │
│    ▸ variant-b.xml                                            │
│                                                               │
│  [ How to import in Premiere ]  (link to 30-sec tutorial)     │
└───────────────────────────────────────────────────────────────┘
```

**State F — Export complete with failures**

```
┌───────────────────────────────────────────────────────────────┐
│  Export partial                                               │
│                                                               │
│  44 / 47 clips downloaded · 3 failed                          │
│                                                               │
│  Failed items:                                                │
│    · 023_NX9WYGQ.mov   — Envato session expired, re-login     │
│    · 031_TKT32A4.mov   — Item unavailable (delisted)          │
│    · 039_QZ3LMP8.mov   — Network error (3 retries)            │
│                                                               │
│  [ Retry failed items ]   [ Generate XML anyway ]             │
│                                                               │
│  If you generate anyway, missing clips appear as offline      │
│  (red) in Premiere. You can relink them manually later.       │
│                                                               │
│  [ Report issue ]   (auto-attaches diagnostic bundle)         │
└───────────────────────────────────────────────────────────────┘
```

### How web app talks to extension

Two channels:

**Web app → extension** — `chrome.runtime.sendMessage(EXT_ID, msg)`.
Requires the extension's ID hard-coded in web app config. Extension's
`externally_connectable` manifest entry whitelists `localhost:5173` +
production domain.

**Extension → web app** — postMessage via a content script injected into
transcript-eval pages OR long-lived `chrome.runtime.Port` that web app
connects on export-page load. Use port: it auto-disconnects on tab close,
which is a clean signal the UI went away.

Message contract (versioned):

```js
// web app → extension
{ type: "ping",    version: 1 }
{ type: "session", version: 1, token, user_id, expires_at }
{ type: "status",  version: 1 }                            // "what's your current state?"
{ type: "export",  version: 1, manifest, target_folder, options }
{ type: "pause",   version: 1, export_id }
{ type: "resume",  version: 1, export_id }
{ type: "cancel",  version: 1, export_id }

// extension → web app (via Port)
{ type: "pong",     version: 1, ext_version: "0.3.1", envato_session: "ok"|"missing"|"expired" }
{ type: "state",    version: 1, export: {...} }            // full queue snapshot
{ type: "progress", version: 1, item_id, phase, bytes, total_bytes }
{ type: "item_done",  version: 1, item_id, result }
{ type: "complete", version: 1, ok_count, fail_count, folder_path, xml_paths: [] }
```

## Architecture

```
┌──────────────────────────┐                     ┌─────────────────────────────────┐
│  transcript-eval web app │                     │   Chrome extension (installed)  │
│                          │                     │   "transcript-eval Export Helper"│
│  /editor/:id/brolls/edit │                     │                                  │
│     │ click Export        │                    │   manifest.json (MV3)            │
│     ▼                    │                     │   service worker                 │
│  /editor/:id/export      │◀─── Port ──────────▶│     · queue state persistence    │
│  (pre-flight + state UI) │    chrome.runtime   │     · resolver (Envato)          │
│                          │                     │     · licenser (Envato)          │
│                          │                     │     · downloader (all sources)   │
│                          │                     │     · chrome.downloads           │
│  POST /api/export-events │◀────── HTTP ────────┤     · chrome.power.keepAwake     │
│  POST /api/freepik-url   │──── Bearer JWT ────▶│                                  │
│  POST /api/pexels-url    │                     │   popup.html (toolbar UI)        │
│                          │                     │                                  │
│  GET  /admin/exports     │                     └─────────────────────────────────┘
│  (admin visibility)      │                                       │
│                          │                                       │ chrome.downloads
└──────────────────────────┘                                       ▼
                                                ┌──────────────────────────────┐
                                                │  ~/Downloads/transcript-eval/ │
                                                │    export-225-c/             │
                                                │      media/                  │
                                                │        001_pexels_123.mp4    │
                                                │        002_NX9WYGQ.mov       │
                                                │        003_freepik_abc.mp4   │
                                                │        ...                   │
                                                │      variant-c.xml           │
                                                │      variant-a.xml  (opt-in) │
                                                │      variant-b.xml  (opt-in) │
                                                └──────────────────────────────┘
                                                           │
                                                           ▼
                                                   Open XML in Premiere
```

## Research summary (why these choices)

Rejected alternatives:

| Approach | Why rejected |
|---|---|
| Server-side download with user's Envato cookies | Envato sees datacenter IP; fingerprint invalidates session; clearest TOS violation. |
| Chrome+Firefox+Safari extensions | Safari extension requires native Xcode app + Apple Developer + per-update review. Maintenance burden too high. |
| Electron/Tauri desktop helper | 150MB+ install; separate login from user's normal Chrome (Envato session doesn't transfer). |
| Official Envato Elements Premiere plugin | Envato sunset their Adobe plugins August 21, 2025. |
| Adobe Stock integration | Excellent UX but expensive per user. Out-of-budget. |
| Envato public API | Does not exist for Elements. |
| `.prproj` direct generation | Adobe-proprietary binary format, no spec. |
| FCPXML (FCP X format) | Premiere does not import it. |

The workable pattern: **Chrome extension running in the user's own
logged-in session.** Envato sees user's real IP + cookies + fingerprint.
Extension downloads are click-equivalent actions the user initiated.

## Authentication

Two independent identity surfaces:

### 1. Envato session (for Envato downloads only)

Extension uses the user's existing Envato cookies — no separate login
inside the extension.

- Popup shows: `Envato: ⚠ sign in required` with "Sign in" button when
  cookies missing/expired.
- Button opens `https://app.envato.com/sign-in` in a new tab.
- Extension watches `chrome.cookies.onChanged` for `envato_client_id` /
  `elements.session.5`; marks session healthy once present.
- Paused queue auto-resumes.

**Pre-flight check before each run:** one GET to
`app.envato.com/download.data` with a reference itemUuid. 200 OK =
proceed; 401 = prompt user; do not start run.

### 2. transcript-eval identity (for event telemetry + API calls)

Extension does NOT become the primary login. Web app mints a short-lived
JWT and passes it via postMessage on first export. Extension stores in
`chrome.storage.local` and uses as `Authorization: Bearer` for calls to
`/api/export-events` and `/api/pexels-url` / `/api/freepik-url`.

```js
// transcript-eval web app on first export button click
chrome.runtime.sendMessage(EXTENSION_ID, {
  type: "session", version: 1,
  token: "eyJ...",       // JWT, 8h TTL, signed by our backend
  user_id: "<uuid>",
  expires_at: <epoch_ms>
});
```

If token 401s, extension asks web app to refresh via
`postMessage({ type: "refresh_session" })`. If web app isn't open, popup
prompts "Open transcript-eval to continue."

### JWT key rotation

Signing keys must rotate (quarterly or on incident). Design for it:

- JWT payload includes `kid` (key ID) header claim.
- Backend maintains a ring of valid keys (current + previous 2).
- Extension's 401 on token triggers silent refresh — no user action
  needed. If refresh also fails, surface "Open transcript-eval to
  continue."
- Rotation-safe: in-flight tokens keep working while they're within TTL
  even after rotation; only new tokens use the new key.

### Popup status surface

```
┌─────────────────────────────────────────────┐
│  transcript-eval Export Helper              │
│                                             │
│  transcript-eval:  ✓ connected              │
│                    silvestras.stonk@gmail.com│
│  Envato:           ✓ active subscription    │
│                    (unlimited33_monthly)    │
│                                             │
│  [ Ready for export ]                       │
└─────────────────────────────────────────────┘
```

Rows clickable when red — launch the respective sign-in flow.

## Multi-source downloads

Unified principle: **the extension is the only process that writes files
to the user's disk.** Server provides URLs for sources that have APIs;
extension downloads from those URLs + from Envato's session-bound flow.

### Source matrix

| Source | URL origin | Auth to fetch URL | Extension action |
|---|---|---|---|
| Envato | User's Envato session (see Download flow detail) | Cookie-bound, user's own | 3-phase: resolve UUID, license, download |
| Pexels | Public API call from our server; returns direct MP4 URL | Our Pexels API key (server-side) | Single `chrome.downloads.download()` |
| Freepik | Paid API call from our server; returns signed short-lived URL | Our Freepik account key (server-side) | Single `chrome.downloads.download()` with URL refetch if expired |
| Storyblocks (deferred) | — | — | — |
| Adobe Stock (deferred) | — | — | — |

### Server endpoints (non-Envato sources)

**`POST /api/pexels-url`** — extension request, Bearer JWT.

```
Request:  { item_id: <pexels video id>, preferred_resolution: "1080p" }
Response: { url: "https://videos.pexels.com/...", filename, size_bytes, resolution }
```

Pexels URLs are permanent; no refresh needed. Server-side caches.

**`POST /api/freepik-url`** — extension request, Bearer JWT.

```
Request:  { item_id: <freepik id>, format: "mp4" }
Response: { url: "https://...signed...", filename, size_bytes, expires_at }
```

Freepik URLs are signed and short-lived (typically 15-60 min). Extension
must respect `expires_at` and refetch on expiry.

### Why server-side fetch for these

Even though Pexels is public, putting the API key in our extension would
leak it publicly (Web Store extensions are trivially unpackable). Freepik
is paid — our key, never in client. So server proxies the URL-getting
step, extension does the actual download (still from user's IP).

### Manifest shape (unified)

Per-item manifest entry is source-tagged:

```js
{
  seq: 1,
  timeline_start_s: 25.4,
  timeline_duration_s: 4.0,
  source: "envato" | "pexels" | "freepik",
  source_item_id: "NX9WYGQ" | "456789" | "abc-123",
  envato_item_url: "...",            // only when source=envato
  target_filename: "001_envato_NX9WYGQ.mov",
  resolution: { width: 1920, height: 1080 },
  frame_rate: 30,
  est_size_bytes: 150_000_000
}
```

Extension branches on `source`: calls 3-phase flow for Envato, or
`/api/<source>-url` + direct download for Pexels/Freepik.

### Integration with adpunk.ssh GPU search (upstream funnel)

Export is the tail of a 4-stage funnel. The export spec only consumes
the output of stage 3; stages 1-3 live in adpunk.ssh. Documented here
so the data contract is clear.

```
┌── stage 1 ────────┐ ┌── stage 2 ─────┐ ┌── stage 3 ───────┐ ┌── stage 4 ───┐
│ scrape candidates │ │ SigLIP on       │ │ video rerank     │ │ export       │
│ (transcript-eval  │ │ poster images   │ │ (top-N only)     │ │ (this spec)  │
│  adpunk.ssh jobs) │ │ (adpunk.ssh GPU)│ │ adpunk.ssh GPU   │ │              │
│                   │ │                 │ │                  │ │              │
│ per source, pull  │ │ embed ~5KB      │ │ download preview │ │ extension    │
│ N hundred items:  │ │ posters + query │ │ mp4 (~10MB)      │ │ downloads    │
│ - poster URLs     │ │ text; cosine    │ │ for top-N only,  │ │ licensed     │
│ - preview URLs    │ │ similarity;     │ │ temporal embed / │ │ full files   │
│ - source_item_id  │ │ drop low-rank   │ │ Qwen rerank;     │ │ (Envato)     │
│ - envato_item_url │ │ (cheap on KB    │ │ produce final    │ │ + API URLs   │
│                   │ │  image tensors) │ │ ranking          │ │ (Pexels,     │
│                   │ │                 │ │                  │ │  Freepik)    │
└───────────────────┘ └─────────────────┘ └──────────────────┘ └──────────────┘
  ~500 candidates      ~500 candidates     ~20-50 shortlisted   ~N picks user
  (broll_searches      ranked, no video    with preview video   chose in editor
   rows created)       download yet        cached               (final export)
```

Stage-by-stage responsibilities:

**Stage 1 — scrape (transcript-eval + adpunk.ssh):**
For each search placement, fetch candidate items per source. Capture
**poster-only** (no video) to keep ingest cheap:
- Envato: HTML scrape of `elements.envato.com/stock-video/<query>`
  (already proven: 38 items/page with poster URLs, no rate-limit).
- Pexels: API call, poster thumbnail URL.
- Freepik: API call, thumbnail URL.

Persist per candidate: `source`, `source_item_id`, `poster_url`,
`preview_url`, `envato_item_url` (Envato only), basic metadata
(resolution, duration if available).

**Stage 2 — SigLIP on poster images (adpunk.ssh GPU):**
Existing: `server/worker.py`, `model_registry.py`. Download the ~5 KB
poster images in parallel (proven 144/144 ok at 24 concurrent,
10k/10k at 90s aggregate). Embed each image + embed the query text;
cosine similarity; sort. Cheap: poster tensors are small, thousands per
second on RTX 3090.

Output: ranked list of candidates by image-text similarity. No videos
downloaded yet. This is where the 90% noise gets cut.

**Stage 3 — video rerank (adpunk.ssh GPU):**
Existing: `server/qwen_reranker.py`. For top-N (20-50) from stage 2,
download the preview mp4 (~10 MB each, proven 100% reliable, no auth).
Sample frames, temporal embedding, Qwen reranker for semantic
re-scoring.

Output final ranking stored in `broll_searches.results_json`. Include
per-result:
- `source`, `source_item_id`
- `envato_item_url` (Envato only, for export's Phase 1 resolver)
- `poster_url`, `preview_url` (for editor UI)
- `resolution`, `frame_rate`, `duration_seconds`
- `rank_score`, `rank_method` (siglip+qwen)

**Stage 4 — export (this spec):**
User browses ranked results in `/editor/:id/brolls/edit` (seeing
posters + on-hover preview videos from stage 1 cache). User picks
final b-rolls into a variant timeline. Clicks Export → extension does
3-phase licensed download on Envato + API-proxy download on
Pexels/Freepik.

### Stage boundary: what export requires

Export's only hard contract with upstream:
- `broll_searches.results_json` populated with `source` +
  `source_item_id` (all sources) + `envato_item_url` (Envato).
- Optional metadata: `resolution`, `frame_rate`, `duration_seconds`,
  `est_size_bytes` (used by export page pre-flight for byte estimate
  and XMEML `<samplecharacteristics>`).

Stage 1-3 implementation details (scraper regexes, SigLIP model
version, batch sizes, GPU provisioning) are out of scope for this
spec — they belong in a separate adpunk.ssh spec.

## Download flow detail — Envato three phases

### Phase 1: Resolve old ID → new platform UUID

Envato migrated from `elements.envato.com` to `app.envato.com` with new
UUIDs. Our scraper captures old 7-char IDs. Download endpoint needs new
UUIDs. The old→new mapping only happens client-side in JS on logged-in
sessions.

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

Concurrency: **5 tabs in parallel.** 300 items ≈ 3 minutes.
Cache: `{oldId → newUuid}` in `chrome.storage.local`, no expiry.

### Phase 2: Get signed download URL

```
GET https://app.envato.com/download.data
    ?itemUuid=<NEW_UUID>&itemType=stock-video
    &_routes=routes/download/route

Auth: session cookies (no CSRF, no JWT)
Response: Remix streaming JSON
  [..., "downloadUrl", "https://video-downloads..../source.mov?Expires=...&Signature=..."]
```

Parse:

```js
const text = await resp.text();
const signedUrl = text.match(/"downloadUrl","(https:\/\/[^"]+)"/)[1];
```

**Calling this endpoint commits a license.** Never speculatively, only
after user clicked Export.

### Phase 3: Save file

```js
await chrome.downloads.download({
  url: signedUrl,
  filename: `transcript-eval/export-${runId}/media/${sanitizedFilename}`,
  saveAs: false,
  conflictAction: "uniquify"
});
```

## Multi-variant exports

User can export one variant or multiple (A+B+C) in a single run. When
multiple: clips shared between variants deduplicate; one media folder
with N XMLs (one per variant).

### Folder layout — single variant

```
export-<id>-<variant>/
  media/
    001_pexels_123.mp4
    002_envato_NX9WYGQ.mov
    ...
  variant-c.xml
```

### Folder layout — multi-variant

```
export-<id>-all/
  media/
    001_pexels_123.mp4         ← may appear in A, B, and/or C
    002_envato_NX9WYGQ.mov
    003_envato_TKT32A4.mov
    ...                         ← superset of all clips across variants
  variant-a.xml                 ← references only clips A uses
  variant-b.xml
  variant-c.xml
```

### Dedup strategy

Key = `(source, source_item_id)`. Each source-item downloaded once,
regardless of how many variants reference it. Filename `<seq>_<source>_<id>`
where `seq` is the order of first appearance across all selected
variants. Each XML references the shared filenames with its own timeline
offsets.

### Cross-export dedup (cache)

Extension keeps a `completed_items` cache keyed by `(user_id, source,
source_item_id, target_folder)`. If user re-runs an export to the same
folder, clips already present are skipped by default. Opt-in checkbox
"Re-download existing files" overrides.

## Large exports (100 GB+)

Real exports: up to 300 items × 150-300 MB ≈ 30-90 GB. At 100 Mbps = 2-4
hours. Several failure modes at that scale:

| Problem | Mitigation |
|---|---|
| Signed URLs expire ~1 hour after minting | JIT fetching. Each worker fetches URL immediately before its download starts. |
| User closes Chrome / laptop sleeps mid-run | Persistent queue in `chrome.storage.local`. Service-worker wake resumes automatically. Popup shows "Resume (203/300)?". |
| OS auto-sleep kills downloads | `chrome.power.requestKeepAwake("system")` on run start, `releaseKeepAwake()` on complete/pause. |
| Flaky WiFi interrupts a file | `chrome.downloads.resume()` on NETWORK_* state=interrupted. Max 3 resume attempts. |
| Insufficient disk | `navigator.storage.estimate()` pre-flight. Abort with clear error if total_bytes + 10% buffer > free. |
| 300+ parallel downloads saturate uplink or flag Envato | Concurrency caps: 5 resolvers (Phase 1), **3 downloads** (Phase 2+3 and non-Envato sources). |
| No visibility over hours | Popup shows per-item state, speed, ETA, pause/resume/cancel. Web app page mirrors this. |

### Run state persistence

Every phase transition writes `chrome.storage.local.set({ [runId]: state })`:

```
{
  runId, started_at, updated_at,
  target_folder_path,
  options: { include_variants: ["A","B","C"], force_redownload: false },
  items: [
    { seq, source, source_item_id, target_filename,
      phase,           // queued | resolving | licensing | downloading | done | failed
      download_id,     // chrome.downloads id once started
      bytes_received,
      error_code       // nullable
    }
  ],
  stats: { ok_count, fail_count, total_bytes_downloaded }
}
```

### Partial-run XML

If run ends with N/M items done: user can still generate XML from
successful downloads. Missing clips show offline (red) in Premiere.

## Data model changes

### `broll_searches.results_json` — extended per-result

```
{
  ...existing...,
  source:          "envato" | "pexels" | "freepik",
  source_item_id:  "NX9WYGQ" | "<numeric>" | "<uuid>",
  envato_item_url: "https://elements.envato.com/ocean-NX9WYGQ",  // only envato
  resolution:      { width, height },
  duration_seconds,
  frame_rate,
  est_size_bytes
}
```

### New table: `exports`

```sql
CREATE TABLE exports (
  id              TEXT PRIMARY KEY,      -- ULID
  plan_pipeline_id INTEGER NOT NULL,
  variant_labels  TEXT NOT NULL,         -- JSON: ["C"] or ["A","B","C"]
  status          TEXT NOT NULL,         -- pending|in_progress|complete|failed|partial
  manifest_json   TEXT NOT NULL,
  result_json     TEXT,                  -- per-item status after run
  xml_paths       TEXT,                  -- JSON: {"C":"variant-c.xml",...}
  folder_path     TEXT,                  -- extension-reported absolute path (redacted user home)
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
```

### New table: `export_events`

(see Observability)

## Chrome extension surface area

### Files (~600 LOC total)

```
extension/
├── manifest.json
├── service_worker.js      main queue, download orchestration
├── popup.html + popup.js  toolbar UI (status + active export)
├── modules/
│   ├── envato.js          resolver + licenser (3-phase)
│   ├── sources.js         pexels/freepik download URL fetchers
│   ├── queue.js           concurrency + pause + resume + state
│   ├── telemetry.js       /api/export-events emitter
│   └── diagnostics.js     bundle generator
└── icons/
```

### `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "transcript-eval Export Helper",
  "version": "0.1.0",
  "minimum_chrome_version": "120",
  "permissions": ["downloads", "tabs", "webNavigation", "storage",
                  "cookies", "power"],
  "host_permissions": [
    "https://elements.envato.com/*",
    "https://app.envato.com/*",
    "https://video-downloads.elements.envatousercontent.com/*",
    "https://videos.pexels.com/*",
    "https://*.freepik.com/*",
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

### Extension version compatibility

- Extension sends `{ ext_version }` in every message to web app.
- Web app's export page declares minimum required version.
- On mismatch: State A in export page becomes "Update required — your
  Export Helper is v0.3, needs v0.5. Update in Chrome Web Store (usually
  automatic within 24 h). [Force refresh]".
- Message schema itself is versioned (`version` field in each message).
  Breaking changes bump schema version; extension supports reading
  last-1 schema for smooth rollouts.

### Chrome Web Store submission

- $5 one-time Google Developer fee.
- Privacy policy URL required — `transcript-eval.com/privacy`.
- Description positions as "Export your transcript-eval projects to
  Premiere with b-rolls from your own subscription accounts." NOT as
  "Envato downloader." Prior envato-downloader extensions have been
  pulled after DMCA complaints.
- Single-purpose: the extension must do ONE thing (Chrome policy). Ours
  does one thing: export b-rolls from transcript-eval. Fine.
- Expect 1-3 business days for initial review; updates same-day.

### Extension rollout strategy

- **Beta (weeks 1-2)**: unlisted Web Store link. Shared only with you + a
  handful of testers. Feature-flagged on `transcript-eval.com/editor/...`
  for same user IDs.
- **Soft launch (weeks 3-4)**: public listing but feature flag keeps
  export button hidden for new signups.
- **GA**: open to all.
- **Canary channel option** for major releases: a second Web Store
  listing ("transcript-eval Export Helper Beta") with 5-10% of users
  opting in. Main listing stays on last-stable. Pattern used by many
  production extensions.
- Feature flags readable by extension at runtime via
  `GET /api/ext-config` — lets backend turn off a broken feature
  without re-publishing.

## XMEML generation

FCP7-style `.xml` (xmeml), placed alongside `media/`. One XML per
exported variant. Premiere auto-relinks within the XML's folder.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="seq-c">
    <name>Variant C</name>
    <duration>27000</duration>
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
          <clipitem id="clip-c-001">
            <name>001_envato_NX9WYGQ.mov</name>
            <start>762</start>
            <end>882</end>
            <in>0</in>
            <out>120</out>
            <file id="file-NX9WYGQ">
              <name>001_envato_NX9WYGQ.mov</name>
              <pathurl>file://./media/001_envato_NX9WYGQ.mov</pathurl>
              <duration>120</duration>
              <rate><timebase>30</timebase></rate>
              <media>
                <video><samplecharacteristics>
                  <width>1920</width><height>1080</height>
                </samplecharacteristics></video>
              </media>
            </file>
          </clipitem>
        </track>
      </video>
    </media>
  </sequence>
</xmeml>
```

### Filename sanitization

`target_filename` is generated, not user-controlled, but must survive
Windows + macOS constraints:

- ASCII only. Non-ASCII in source titles is ignored in filename
  construction (we use `source + id`, not title).
- Replace reserved chars `<>:"|?*` with `_`.
- Total path length under 240 chars (margin under Windows 260 limit).
- Extension derived from downloaded MIME: `.mov`, `.mp4`.

Scheme: `<NNN>_<source>_<source_item_id>.<ext>` (e.g.
`001_envato_NX9WYGQ.mov`, `002_pexels_4567.mp4`,
`003_freepik_abc-123.mp4`).

### Overlapping timeline placements

If two placements overlap in time (intentional, e.g. A-roll under
B-roll), XMEML puts them on separate tracks (V1, V2). Track assignment
by greedy interval scheduling:

```
sort placements by timeline_start_s
for each placement:
  pick lowest track index where no existing clip overlaps
  assign to that track
```

Resulting XML emits multiple `<track>` elements under `<video>`. Premiere
displays them stacked as expected.

### Missing metadata fallback

If `resolution` / `frame_rate` absent from manifest: default `1920x1080
/ 30fps` in XML. Premiere reads actual file metadata on import and
auto-corrects display.

### Preview-vs-source divergence

Preview files in the editor are 720p h264 watermarked; source files
downloaded for export are higher resolution, no watermark, sometimes
ProRes or DNxHR. Users may notice small differences (color grading,
slightly different framing due to watermark removal). Typically
imperceptible for b-rolls, but noted in tutorial/help docs. Editor UI
can add a tooltip "Downloaded file may look slightly different —
higher quality, no watermark."

### Generator: `server/services/xmeml-generator.js` (~300 LOC)

Pure function, no I/O:

```js
export function generateXmeml({
  sequenceName, placements, frameRate = 30, sequenceSize = {w: 1920, h: 1080}
}) {
  // placements: [{ seq, source, sourceItemId, filename,
  //                timelineStart, timelineDuration,
  //                width, height, sourceFrameRate }, ...]
  // returns: XML string
}
```

Unit-tested. Inputs sanitized, XML escaped.

## Rate limiting, TOS, fair use

Envato's Fair Use Policy forbids "scripts or bots to mass generate or
mass download Content" and "excessively high volumes in a short amount
of time." No published threshold; enforcement by account suspension.

Hard rules in extension:

1. Only triggered by explicit user action.
2. 0.5-3s jittered gap between successive `download.data` fetches.
3. 300-item hard cap per export run.
4. Daily cap: 500 downloads per source, per user, tracked in
   `chrome.storage.local`. Warns at 400, hard stops at 500.
5. Pre-flight session sanity check before every run.
6. 403 = hard stop, not auto-recoverable; Slack alert.
7. 429 = `Retry-After` + 20% jitter, retry once; on second 429, pause 5
   min then try once before hard stop.

Pexels/Freepik use our API keys server-side — server owns rate limiting
and handles 429s transparently. Extension sees 429 on
`/api/<source>-url` only if our server is overloaded.

## Concurrency + queue constraints

- **One active export per user at a time.** Second "Start Export" click
  while a run is live: web app shows "Export already in progress in
  another tab. Wait for it to finish or cancel it."
- Extension's queue is single-threaded at the export level
  (parallelism is within the single active run).
- `chrome.storage.local.active_run_id` is the lock. Set at start, cleared
  at complete/cancel. Atomic via storage operations.
- If user force-cancels: extension finishes the in-flight download,
  clears state, frees the lock.

## Observability (admin visibility)

### Event ingestion

`POST /api/export-events` (Bearer JWT).

```
{
  export_id:    "exp_01JQ...",
  user_id:      "<uuid>",
  event:        "item_failed",
  item_id:      "NX9WYGQ",
  source:       "envato",
  phase:        "download",
  error_code:   "envato_403",
  http_status:  403,
  retry_count:  2,
  meta:         { url_host: "video-downloads..." },
  t:            <epoch_ms>
}
```

### Event types

| Event | When | Key fields |
|---|---|---|
| `export_started` | User clicks Start | total_items, total_bytes_est, source_breakdown |
| `item_resolved` | Phase 1 done | item_id, resolve_ms |
| `item_licensed` | Phase 2 done | item_id, license_ms |
| `item_downloaded` | Phase 3 done | item_id, bytes, download_ms |
| `item_failed` | Any retry-exhausted error | item_id, source, phase, error_code |
| `rate_limit_hit` | 429 response | source, retry_after_sec |
| `session_expired` | 401 on envato download.data | (none) |
| `queue_paused` / `queue_resumed` | User action | reason |
| `export_completed` | Run end | ok_count, fail_count, wall_seconds, total_bytes |

### Storage

```sql
CREATE TABLE export_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  export_id    TEXT NOT NULL,
  user_id      TEXT,
  event        TEXT NOT NULL,
  item_id      TEXT,
  source       TEXT,
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

### Admin UI

`/admin/exports`:
- Recent exports (paginated).
- Per-export event timeline on click.
- Filter: failures-only.
- Per-user view.
- Aggregate: failure rate by source, by error_code, over time.

### Slack alerting

Fire `notify()` (existing `server/services/slack-notifier.js`) on:
- `item_failed` with `error_code` in `{envato_403, envato_429}`.
- Any `session_expired`.
- `export_completed` with `fail_count >= 10`.
- Pattern: ≥3 distinct users with `envato_403` in 15 min → "possible
  Envato API change" alert.

Dedupe: `{user_id, event, error_code}` within 60s collapses.

## Privacy + data rights

- No video titles, search queries, or file paths with usernames in event
  `meta`.
- `user_id` is our internal UUID, not PII.
- Event retention: **90 days**, then auto-purged by nightly job.
- **User opt-out:** extension setting "Send diagnostic events" (default
  on). Off disables `/api/export-events` POSTs; export still works with
  no admin telemetry.
- **GDPR DSAR support:** `DELETE /api/user/:id/export-events` deletes
  all events for a user. Triggered by standard user-deletion flow.
- No IP addresses logged server-side. Standard request log IPs are
  filtered out of export-events aggregation.
- Privacy policy at `transcript-eval.com/privacy` documents: what
  events are sent, retention period, how to opt out, how to delete.
- Extension permissions disclosed to user at install: `downloads`
  (save files), `tabs` (resolve Envato items), `cookies` (check Envato
  session), `power` (prevent sleep).

## Failure modes & handling

Retry semantics: exponential backoff unless noted; 1s → 5s → 15s →
60s; max 4 attempts.

| Trigger | Phase | Strategy |
|---|---|---|
| Resolver tab navigation timeout | 1 resolve | Retry once at 30s. Then skip, mark `resolve_failed`. Event: `item_failed`. |
| Resolver: UUID not found in redirect | 1 resolve | Item likely delisted. Skip, no retry. Event: `item_unavailable`. |
| `download.data` network error (5xx, DNS, timeout) | 2 license | Exp backoff, 4 attempts. Then mark `license_failed`. |
| `download.data` 401 | 2 license | Session expired. Pause queue. Popup: "Re-login to Envato". Event: `session_expired`. |
| `download.data` 402 or 403 with "upgrade" body | 2 license | Tier-restricted item (user's subscription doesn't cover it). Skip, don't hard-stop run. Event: `tier_restricted`. |
| `download.data` 403 (generic) | 2 license | Hard stop. Not auto-recoverable. Popup + Slack. Event: `item_failed`, `error_code=envato_403`. |
| `download.data` 429 | 2 license | `Retry-After` + 20% jitter, 1 retry. On second 429, pause 5 min + 1 final retry before hard stop. Event: `rate_limit_hit`. |
| `download.data` empty `downloadUrl` | 2 license | Item unavailable. Skip, no retry. |
| `/api/pexels-url` or `/api/freepik-url` 404 | 2 license | Item removed upstream. Skip. Event: `item_unavailable`. |
| `/api/freepik-url` 429 | 2 license | Our Freepik quota hit. Pause 5 min, retry once. If still 429, hard stop. Admin Slack. |
| Signed CDN URL expired mid-download | 3 download | Auto-refetch URL for this item, retry download once. |
| `chrome.downloads` NETWORK_* interrupt | 3 download | `resume()`, max 3 attempts. Then mark `network_failed`. |
| `chrome.downloads` FILE_* interrupt | 3 download | Disk issue. Hard stop queue. Popup: OS error + "Change folder". |
| `chrome.downloads` USER_CANCELED | 3 download | Mark `cancelled`. No retry. Continue queue. |
| File size mismatch after download | 3 download | Delete file, retry once. Then mark `integrity_failed`. |
| User closes browser mid-run | any | State persisted; resumes on service-worker wake. Popup: "Resume?". |
| Machine sleeps | any | `requestKeepAwake` should prevent. If it doesn't, resumes on wake. |
| XML generation fails | xml | Web app error-surfaces; files still on disk; user can re-run XML-only. |
| Extension not installed / not reachable | web app | State A of export page: install prompt. |
| Extension version too old | web app | Update required message + force-refresh button. |

## Cross-browser compatibility

- **Chrome**: primary target; MV3. Chrome 120+ required (service-worker
  persistence features).
- **Edge, Arc, Vivaldi, Opera**: all Chromium-based, should work with
  the same extension package. Test Edge explicitly; other forks
  best-effort.
- **Brave**: works but strict tracker-blocking may block Datadog RUM
  beacons on Envato's pages. Non-fatal (those beacons aren't needed for
  download flow); document as a known minor issue.
- **Chrome Enterprise** / managed policies: may block extension install.
  Corporate users may need IT approval. Documented, not engineered
  around.
- **Safari, Firefox**: out of scope (see Non-goals).
- **Chromebook**: untested; service-worker-based extensions often work
  but disk layout differs. Document as unsupported until tested.

## Testing + dev

### Local dev (no Envato quota burn)

- **Mock mode:** extension has a config flag `env=dev` that redirects
  all Envato URLs to a local mock server. Mock serves canned HTML +
  Remix-streaming responses + fake signed URLs pointing at a local
  ~100MB test clip.
- Mock server fixture files live in `extension/fixtures/` (including
  captured HAR files from real runs, with cookies redacted).
- `npm run dev:ext` starts the mock server + builds the extension in dev
  mode + points it at localhost:5173.

### Unit tests

- `xmeml-generator.js`: pure function, full coverage of
  overlap/multi-variant/missing-metadata cases.
- `sources.js`: mock fetch, assert URL extraction logic.
- `queue.js`: mock chrome.downloads, assert concurrency/retry/pause
  behavior.

### Integration / E2E

- Dedicated test Envato subscription (~$33/mo) with known-good items.
- Puppeteer or Playwright driving the extension end-to-end against
  staging (not prod) — one full run per week in CI as a smoke test.
- Test accounts live in `1Password` vault (not in repo).

### CI

- Extension built + packaged per commit to `main`.
- `.crx` and `.zip` artifacts uploaded to GitHub Releases on tag.
- Web Store auto-submission on tagged release (Chrome Web Store API
  supports this) — review still required, but upload is automated.

## Support diagnostics

### Diagnostic bundle

Extension popup has "Export diagnostic bundle" button (also triggerable
from State F of the export page). Produces a `.zip` containing:

- Recent queue state (last 24h, from `chrome.storage.local`).
- Last 200 events the extension emitted to `/api/export-events`.
- Browser/OS/extension-version strings.
- Redacted cookie presence flags (just booleans: `has_envato_cookie:
  true`).

Never includes: cookie values, JWT tokens, actual file paths (only
redacted like `~/Downloads/transcript-eval/export-.../`), video titles,
user email.

User can email/upload bundle attached to a support ticket. Admin UI
(`/admin/support`) lets you upload the bundle, view parsed contents
side-by-side with the related `exports` row.

## Non-goals for this spec

- Storyblocks, Adobe Stock (explicitly deferred by user).
- UXP Premiere plugin (one-click in-Premiere import). After XMEML path
  ships.
- Safari / Firefox / Edge-first support. Chrome-only.
- DaVinci Resolve, Final Cut Pro explicit targeting. XMEML works for
  most, untested, deferred.
- Server-side Envato download orchestration. Never; violates user-IP
  constraint.
- Extension as primary login for transcript-eval. Token passed via
  postMessage; identity stays in web app.
- Rendering final output video. Export delivers placed clips; user does
  color/audio/mastering in Premiere.
- Dedicated iPhone / iPad / mobile support. Desktop Chrome only.
- Bundled-subscription model (adpunk pays for Envato on user's behalf).
  User BYO subscription only.

## Resolved decisions

- **Re-export behavior.** Default: re-use existing files in same
  folder if `{source, source_item_id}` match. Force re-download is opt-in.
- **Multi-variant export.** One run can export any subset of variants;
  shared media folder, one XML per variant.
- **Single source for downloads.** Extension is the only process that
  writes files to user's disk. Server provides URLs (Pexels/Freepik)
  but never proxies bytes.
- **No extension login for transcript-eval.** Auth via JWT from web
  app only.
- **Chrome-only at launch.** Safari/Firefox deferred as significant
  separate efforts.
- **90-day event retention.** Auto-purge nightly.

## Open questions

1. **Distribution: unlisted-then-public, or public-from-day-1.** Leaning
   unlisted-beta → public after 2-3 weeks stable.

2. **Target folder picker: fixed `~/Downloads/transcript-eval/` or File
   System Access API.** Leaning: fixed default, FSA picker optional via
   "Change folder" button.

3. **Envato session check cadence.** Pre-flight only, or also every N
   items during run. Trade-off more checks = more resilience, more
   Envato requests. Leaning: pre-flight + reactive (only when a 401
   hits).

4. **Folder-path format in `exports.folder_path`.** Include full path
   (e.g. `/Users/<user>/Downloads/.../`) or redact to
   `~/Downloads/.../`. Privacy vs. reproducibility.

## Implementation phases

PR-sized chunks. Full plan via `superpowers:writing-plans` after spec
approval.

1. **DB + server routes.** `exports`, `export_events` tables.
   `POST /api/export-events`, `POST /api/pexels-url`,
   `POST /api/freepik-url`, `POST /api/session-token` (JWT mint).
2. **Extension MVP — Envato single item.** MV3 skeleton, service
   worker, 3-phase flow. Test against real Envato account.
3. **Extension — Pexels + Freepik single item.** `sources.js` module,
   wires to server `/api/*-url` endpoints.
4. **Auth + popup status UI.** JWT storage + refresh, Envato session
   check, popup with two status rows.
5. **Queue + concurrency + persistence.** 5-resolver, 3-downloader,
   JIT URL fetching, `chrome.storage.local` state, pause/resume/cancel,
   keepAwake, `chrome.downloads.resume`.
6. **XMEML generator.** Pure function + unit tests; multi-variant,
   overlapping placements, filename sanitization.
7. **Export page UI (states A–F).** Pre-flight checks, pre-flight
   states, in-progress UI, complete/partial UI, File System Access
   picker.
8. **Failure-mode polish.** Per-error strategies, session-expired
   recovery, integrity check, tier_restricted handling,
   partial-run XML.
9. **Observability.** Event emission, ingestion route, Slack alerts,
   admin UI list + detail.
10. **Diagnostics + support.** Diagnostic bundle generator, admin
    support view, privacy controls (opt-out toggle, DSAR delete).
11. **Cross-browser smoke + testing infra.** Mock mode, fixtures, CI
    pipeline, test subscription on retainer.
12. **Rollout.** Unlisted Web Store listing, beta testers, canary
    channel option, feature flag, then public GA.

Timeline estimate: 6-8 weeks to Phase 12 inclusive, assuming no
surprises from Envato's HTML/redirect format changing mid-build.

## Known future work

Items deferred but noted so they don't get lost:

- **UXP Premiere plugin** for one-click import (eliminates XMEML step
  for users who install it).
- **Storyblocks, Adobe Stock** as additional sources (Storyblocks has a
  clean API path already proven; Adobe Stock has the watermark-relink
  UX of dreams but cost-prohibitive).
- **DaVinci Resolve / FCP direct export** formats beyond xmeml.
- **Proxy / lower-res rendering** in transcript-eval server for users
  who want faster editing before licensing full files.
- **License metadata capture** per Envato download (license ID,
  timestamp, user, project) for audit trail — Envato's response
  includes this; future schema addition to `exports.result_json`.
- **Team / org subscriptions** — multiple users sharing an Envato
  subscription under one transcript-eval org.
- **Mobile / iPad** companion (much later).
- **Certificate pinning** in extension for `app.envato.com` — defense
  against MITM on Envato auth; overkill for MVP.
- **Automated test against real Envato via a dedicated bot account** —
  today's plan uses a human tester's account for E2E smoke.
