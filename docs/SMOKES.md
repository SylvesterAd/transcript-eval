# Manual Smoke Tests

Pending manual smoke tests for the transcript-eval extension and web app. These are acceptance gates for each phase.

## Smoke #12: Ext.FPS — file:// probe end-to-end

- **5-item export** across known framerates: one 23.976 Envato MOV, one 29.97 Pexels MP4, one 25 Pexels MP4, one 30 Freepik MP4, one user A-roll at 50fps (Supabase).
- **Acceptance:** import generated XML to Premiere Pro. Every clip lands green (online) in project bin. No "File not found in search directories" errors. No rate-mismatch warnings in source monitor.
- **Negative path:** disable "Allow access to file URLs" toggle in chrome://extensions for this extension, re-export. Expect probe to skip, manifest values to flow through (today's behavior), no regression in import success for clips where manifest already matched the file.

## Smoke #13: Envato sequential cycle

- Start a 5+ item Envato export. Open the extension's service worker DevTools (chrome://extensions → service worker link). Watch the queue logs + the network panel filtered to `envato`.
- **Acceptance:**
  - At any moment, `chrome.tabs.query({})` returns ≤ 1 tab matching `app.envato.com` AND ≤ 1 tab matching `elements.envato.com`.
  - `/download.data` requests are visibly serial in the network panel (no concurrent commits).
  - No HTTP 429 across the 5-item run.
  - Approximate wall-clock per item: licensing (~3s) + download (~5-30s) + 1-2s jitter. Compare against pre-feature baseline to confirm the slowdown is in the expected range (≤ 50% slower for typical 5-item runs; bigger gap for runs that would have 429-paused before).
- **Negative path:** cancel the run mid-cycle; verify the held Envato tab closes immediately (not after a delay).
- **Telemetry path:** filter the `export_events` log for `envato_license_tab_held` and `envato_license_tab_closed` — there should be one of each per item, in order, with matching `source_item_id`.
