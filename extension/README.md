# transcript-eval Export Helper — Chrome Extension

Chrome MV3 extension that downloads licensed b-roll files during a
transcript-eval export run. Ext.1 scope: MV3 skeleton + JWT storage
+ `{type:"ping"}` / `{type:"session"}` round-trip with the web app.
Download flows arrive in Ext.2+.

See `docs/specs/2026-04-23-envato-export-extension.md` for the full
spec and `docs/superpowers/plans/2026-04-23-envato-export-extension-ext1.md`
for the Ext.1 implementation plan.

## Load unpacked (dev)

1. `cd` into this repo's root.
2. `chrome://extensions` → **Developer mode** ON → **Load unpacked**.
3. Select the `extension/` directory.
4. Confirm the ID matches `extension/.extension-id`.

## Stable extension ID

Chrome derives the extension ID from the RSA public key in
`manifest.json`'s `key` field. That key was generated once (Task 2 of
the Ext.1 plan) and committed — so every dev machine loads the
extension under the same ID. That ID is also what the web app's
`externally_connectable` whitelist matches against.

Do **not** regenerate without discussing first. Regenerating changes
the ID and breaks every place that hard-codes it (including the dev
test harness page).

If you must rotate:
1. Delete the `key` field from `manifest.json`.
2. `npm run ext:generate-key` — rewrites `manifest.json`'s `key` field and `extension/.extension-id` with the new values.
3. `chrome://extensions` → click **reload** on the Export Helper card so the new manifest takes effect.
4. If any downstream code hard-codes the ID (none in Ext.1; web-app constants may exist in later phases), update those references too.

The private key at `.secrets/extension-private-key.pem` is gitignored
and not used by Chrome — it's kept only as a rotation artifact.

## Dev test harness

`extension-test.html` at the repo root is a one-page dev tool that
sends `chrome.runtime.sendMessage` calls to the extension and shows
the replies. Load it via the repo's vite dev server:

```bash
npm run dev:client
# open http://localhost:5173/extension-test.html
```

Vite defaults to port 5173 but falls back to 5174 if 5173 is
occupied (e.g., another worktree running vite). Both ports are in
the manifest's `externally_connectable` whitelist, so either works.

Paste the ID from `extension/.extension-id` and click **Run all
checks** for a fast smoke test.

## File layout

```
extension/
├── manifest.json
├── .extension-id         derived Chrome extension ID (committed, auto-written by generate-key)
├── service_worker.js     message router (onMessageExternal)
├── config.js             BACKEND_URL / EXT_VERSION / ENV
├── popup.html/css/js     toolbar popup (status-only)
├── modules/
│   └── auth.js           JWT storage + expiry check
└── scripts/
    └── generate-key.mjs  one-off RSA keygen + manifest key pinner
```

## Known Ext.1 limitations

- Envato cookie status is a static placeholder — cookie watcher
  lands in Ext.4.
- No telemetry to `/api/export-events` — telemetry lands in Ext.6.
- No long-lived `chrome.runtime.Port` — the export page will open one
  in Ext.5 when the queue UI is added.
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

## Ext.4 — Auth polish (Port + Cookie Watcher + Session Recovery)

Ext.4 adds the glue that keeps the extension reliable across
session-boundary events (user signs out, JWT expires, web app
reloads, etc.).

### New permissions

Ext.4 adds one permission to `manifest.json`:

- `cookies` — required for `chrome.cookies.get` (pre-flight
  convenience) and `chrome.cookies.onChanged` (reactive cookie
  watcher).

### Privacy posture for `cookies`

The extension ONLY reads cookies on `.envato.com`, and only two
of them: `envato_client_id` and `elements.session.5`. It NEVER:

- writes any cookie
- reads cookies on any other domain
- sends cookie values to our backend or to the Port-connected web
  app

Surface the user sees: a red badge `!` on the extension icon when
the Envato session is missing; a "sign in required" row in the
popup that opens `https://app.envato.com/sign-in` on click.

### Port (long-lived connection)

The web app's export page opens a `chrome.runtime.Port` when it
loads; it auto-disconnects when the tab closes. Only one active
Port is tracked; a new connection replaces the previous.

The extension uses the Port for:

- **Outbound**: `{type:"state", envato_session:"ok"|"missing"}`
  on cookie change; `{type:"refresh_session", version:1}` when a
  401 needs a fresh JWT.
- **Inbound**: `{type:"session", token, kid, user_id, expires_at}`
  to update the stored JWT (written via `modules/auth.setJwt`).

Ext.5 will extend the inbound path with `{type:"export"|"pause"|
"resume"|"cancel"}` queue commands.

### Pre-flight session check

`downloadEnvato()` (Ext.2) now starts with a Phase 0 pre-flight:
one GET to `app.envato.com/download.data?itemUuid=<REFERENCE>` with
the user's session cookies. On 401, the run returns
`envato_session_missing_preflight` before opening any resolver tab
— no license, no CPU wasted.

`ENVATO_REFERENCE_UUID` in `modules/auth.js` points at a stable
Envato stock-video item. If Envato delists it, pre-flight will
start returning `envato_preflight_error`; rotate the constant per
the docstring in that file.

### 401 recovery

Two paths:

- **Envato 401** (on `download.data`) → set
  `envato_session_status = 'missing'` in storage, broadcast on
  Port, red badge, surface `envato_session_missing` error. Queue
  pause is Ext.5.
- **transcript-eval 401** (on `/api/pexels-url` / `/api/freepik-url`)
  → `refreshSessionViaPort()` posts `{type:"refresh_session"}` on
  the Port, awaits a fresh `{type:"session", ...}` inbound within
  10s, retries the original fetch ONCE. No port / timeout →
  surface the 401 unchanged.

### Test harness additions

Fieldsets 7–9 on `extension-test.html`:

- 7. Port + Auth — connect / disconnect buttons; live inbound log.
- 8. Session status — live storage poll + manual
  `debug_check_envato_session`.
- 9. 401 refresh simulation — manual
  `{type:"refresh_session"}` post over the connected Port.

### Manifest changes (0.3.0 → 0.4.0)

- `permissions` (added): `cookies`.
- `host_permissions`: unchanged from Ext.3.

## Ext.5 — Queue & persistence

- **Permissions:** `power` added. Manifest version `0.5.0`.
- **New modules:** `modules/queue.js` (state machine + worker pools +
  `chrome.downloads.onChanged` routing), `modules/storage.js` (single
  owner of `chrome.storage.local` wrappers for run state, active-run
  lock, completed-items set, deny-list, daily counts).
- **Message handlers:** `{type:"export"}`, `{type:"pause"}`,
  `{type:"resume"}`, `{type:"cancel"}`, `{type:"status"}`. The
  `debug_envato_one_shot` / `debug_source_one_shot` handlers from
  Ext.2/3 stay intact with a DEPRECATED comment — useful for isolated
  debugging.
- **Concurrency:** 5 Envato resolver tabs, 5 Envato licensers, 3
  downloaders (Envato + Pexels + Freepik share the downloader pool).
  Tune via the constants in `config.js`.
- **Persistence invariant:** every phase transition writes
  `run:<runId>` to `chrome.storage.local` BEFORE broadcasting. MV3 SW
  termination is designed-for; whatever's persisted is the truth on
  resume.
- **SW-wake resume:** module-top-level `autoResumeIfActiveRun`
  rehydrates from `active_run_id` → `run:<runId>`. `chrome.runtime.
  onStartup` + `onInstalled` also trigger it. In-flight downloads are
  reconciled via `chrome.downloads.search({id})` and rolled back to
  `queued` if lost.
- **Single active run:** `active_run_id` lock enforced in
  `startRun` via `storage.setActiveRunId` CAS. A second
  `{type:"export"}` while the lock is held returns
  `{ok:false, reason:'run_already_active', active_run_id}`. Cleared
  on complete or cancel (NOT on pause — a paused run holds the lock).
- **Keep-awake:** `chrome.power.requestKeepAwake("system")` on
  `startRun` / `resumeRun`; `releaseKeepAwake()` on pause, cancel,
  complete, and hard-stop (disk_failed) paths.
- **Interrupt recovery:** `chrome.downloads.resume(id)` on NETWORK_*
  interrupts, up to 3 attempts per item. FILE_* interrupts hard-stop
  the whole queue (disk is hosed; no point continuing).
  USER_CANCELED marks just that item cancelled.
- **JIT URL fetching:** each downloader fetches its signed URL
  (Envato: `download.data`; Pexels/Freepik: `/api/*-url`) milliseconds
  before `chrome.downloads.download`. URL TTL (Envato ~1 h, Freepik
  15-60 min) doesn't matter even on multi-hour runs.
- **Port broadcast:** every state transition pushes `{type:"state"}`.
  Per-item byte progress is coalesced to at most one `{type:"progress"}`
  push per item per 500 ms. On `complete`, pushes `{type:"complete",
  ok_count, fail_count, folder_path, xml_paths:[]}` (web app owns
  XMEML generation).

### Stress test

Run the "Queue / stress test" fieldset on `extension-test.html`.
Cheap mode (default): 35 items, ~250 MB, no Envato license commits.
Full mode: adds 15 Envato items (budget 15 license commits).

Acceptance gate for Ext.5: close Chrome at ~20/50 items, reopen,
observe the run auto-resume from the persisted state. See
`docs/superpowers/plans/2026-04-24-extension-ext5-queue-persistence.md`
Task 12 for the full verification script.

### Known Ext.5 limitations (belong to later phases)

- Failure matrix (402 tier_restricted, 403 hard-stop + Slack, 429
  Retry-After + jitter, integrity mismatch retry,
  `unsupported_filetype` deny-list with 24 h telemetry dedupe) →
  Ext.7.
- Telemetry to `/api/export-events` → Ext.6. Events are emitted
  in-process via Port only; no HTTP POST yet.
- Daily-cap enforcement (warn at 400, hard-stop at 500 per source per
  user) → Ext.7. Getters live in `storage.js`; the queue doesn't
  consult them yet.
- Diagnostic bundle (`modules/diagnostics.js`) → Ext.8.
- Feature flags (`/api/ext-config`) → Ext.9.

### Manifest changes (0.4.0 → 0.5.0)

- `permissions` (added): `power`.
- `host_permissions`: unchanged from Ext.4.

## Ext.6 — Telemetry

- **Permissions:** unchanged from Ext.5. Manifest version `0.6.0`.
- **New module:** `modules/telemetry.js` (~300 LOC) — owns the
  `POST /api/export-events` emitter. Ring buffer (50) + persisted
  overflow queue (`chrome.storage.local.telemetry_queue`, hard cap
  500, oldest-drop with counter) + exponential-backoff retry loop
  (2 s → 60 s, ±20 % jitter, 5 s idle interval) + Bearer-JWT attach
  + 401-pause-until-refresh + 15-code `normalizeErrorCode` mapper.
- **Queue integration:** `modules/queue.js` calls
  `telemetry.emit(<event>, <payload>)` at every state transition.
  Emits are fire-and-forget — the queue never awaits the flush.
  10 event types per the extension spec: `export_started`,
  `item_resolved`, `item_licensed`, `item_downloaded`, `item_failed`,
  `rate_limit_hit`, `session_expired`, `queue_paused`, `queue_resumed`,
  `export_completed`.
- **Payload conventions:**
  - `export_started` meta: `{total_items, total_bytes_est,
    source_breakdown: {envato, pexels, freepik}}`.
  - `export_completed` meta: `{ok_count, fail_count, wall_seconds,
    total_bytes, reason: 'complete'|'cancelled'|'hard_stop:<code>'}`
    — REQUIRED. Backend derives final export status from these.
  - `item_failed`: `error_code` REQUIRED, mapped via
    `normalizeErrorCode` to the 15-code enum; raw string preserved
    in `meta.raw_error` for admin triage of unknown branches.
- **Auth integration:** `modules/auth.js` gains `attachBearer(headers)`
  (read JWT, attach `Authorization`) and an
  `onSessionRefreshed(cb)` / `emitSessionRefreshed()` hub.
  `refreshSessionViaPort`'s success path fires the emit so telemetry
  unparks its flush.
- **Invariants:** MV3 SW termination means persist-before-flush;
  paused-for-auth is load-bearing; the 10-event enum MUST match
  `server/services/exports.js` ALLOWED_EVENTS; `export_completed`
  fires exactly once per run (on `finalize`, `cancelRun`, or
  `hardStopQueue`). Full list in
  `docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md`.

### Manual verification

The test harness's fieldset 11 (Ext.6) has three buttons: "Fire
synthetic short run" (3 items; exercises emit surface), "Query buffer
stats", and "Force flush". The DevTools Network tab's "Offline"
checkbox is the canonical way to test offline queueing — flip on,
fire a run, flip off, observe queue drain via Force flush or the
5 s loop tick.

Acceptance gate: complete a real 3-item run, query `export_events`
table for the chronology; disconnect network, complete a run offline,
reconnect, confirm queued events flush. Full step-by-step in the plan
file's Task 9.

### Known Ext.6 limitations (belong to later phases)

- Opt-out switch (user-facing "Send diagnostic events" toggle) →
  Ext.8. The emit function does NOT consult an opt-out flag today.
- Diagnostic bundle generator (`modules/diagnostics.js`) → Ext.8.
- Per-error retry / deny-list / Freepik TTL refetch → Ext.7. Today
  the retry loop is uniform exponential backoff on any non-2xx-
  non-401.
- `/api/ext-config` consumption / kill switch → Ext.9.
- CI packaging / Web Store work → Ext.10 / Ext.11 / Ext.12.

### Manifest changes (0.5.0 → 0.6.0)

- `permissions`: unchanged.
- `host_permissions`: unchanged — `/api/export-events` is same-origin
  to `BACKEND_URL`, which is already reachable for `/api/pexels-url` +
  `/api/freepik-url` from Ext.3.
- `version`: 0.5.0 → 0.6.0.
