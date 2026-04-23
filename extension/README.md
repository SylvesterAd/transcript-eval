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
