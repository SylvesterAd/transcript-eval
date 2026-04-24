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
