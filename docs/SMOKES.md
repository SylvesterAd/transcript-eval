# Manual Smoke Tests

Pending manual smoke tests for the transcript-eval extension and web app. These are acceptance gates for each phase.

## Smoke #12: Ext.FPS — file:// probe end-to-end

- **5-item export** across known framerates: one 23.976 Envato MOV, one 29.97 Pexels MP4, one 25 Pexels MP4, one 30 Freepik MP4, one user A-roll at 50fps (Supabase).
- **Acceptance:** import generated XML to Premiere Pro. Every clip lands green (online) in project bin. No "File not found in search directories" errors. No rate-mismatch warnings in source monitor.
- **Negative path:** disable "Allow access to file URLs" toggle in chrome://extensions for this extension, re-export. Expect probe to skip, manifest values to flow through (today's behavior), no regression in import success for clips where manifest already matched the file.
