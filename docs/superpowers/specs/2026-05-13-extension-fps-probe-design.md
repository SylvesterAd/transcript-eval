# Extension-Side FPS Probe for B-Roll and A-Roll Downloads — Design

**Date:** 2026-05-13
**Branch:** `feature/extension-fps-probe` (proposed)
**Status:** Design

## Problem

Exports occasionally fail to import into Premiere Pro with "File not found in search directories" — a misleading error that NLEs raise when the XML's declared frame rate, NTSC flag, embedded SMPTE timecode, or claimed dimensions disagree with the actual on-disk file's container metadata. The downloaded clip is right next to the XML, the filename matches, but Premiere refuses to relink it because the bytes it reads don't match what the XML claims.

Root cause: the server's existing `ffprobe` step (`server/services/video-processor.js:362` — `probeMediaUrl()`, called during manifest build in `server/routes/broll.js:253-289`) probes URLs *before* the extension downloads them. For **Envato**, the probed URL is the watermarked preview, not the licensed download — the system assumes "encoders preserve container rate when transcoding to preview bitrate" (`broll.js:263-266`), which is the assumption that breaks on some clips. For **Pexels/Freepik**, probe can also silently fail (timeout, 4xx, ffprobe binary missing) → manifest's `frame_rate` falls back to whatever the source API reported (often integer-rounded, sometimes absent). The downloaded file itself is never probed.

## Goal

The XML always declares per-file metadata that matches the actual bytes on disk. We achieve this by having the Chrome extension probe each downloaded file (A-roll and b-rolls) directly from local disk after `chrome.downloads` completes, and threading the result through to the XMEML generator. Server-side ffprobe stays as fallback for users who haven't granted the new `file://` permission and for any probe failure mode.

## Current State

- **Server-side probe** (`probeMediaUrl()` at `video-processor.js:362-419`) extracts `{rFrameRate, frameRateInt, ntsc, width, height, durationSeconds, codec, embeddedTimecode}` from any URL via ffprobe. Cached in-memory by URL. Returns `null` on any failure. Good code; correct logic; only problem is the URL it's pointed at.
- **Manifest build** (`broll.js:253-289`) probes each item's `_probe_url` in parallel with a 20s budget. For **Envato and Freepik** (anything where `probeIsSource` is false at `broll.js:281`): only FPS, NTSC, and embedded TC are taken from the probe — dimensions and duration are kept from the source API because the probed URL may be a watermarked/lower-res preview that lies about resolution. For **Pexels** and **A-roll** (`probeIsSource === true`): the probed URL equals the source URL, and all fields including dimensions and duration are trusted.
- **XMEML generator** (`xmeml-generator.js:258-761`) accepts per-placement `sourceFrameRate`, `ntsc`, `embeddedTimecode`, `width`, `height`, `sourceDurationSeconds`. Emits per-file `<rate>`, `<ntsc>`, `<duration>`, `<timecode>` blocks; for b-rolls additionally uses source-rate frames in `<in>`/`<out>` (`xmeml-generator.js:604-606`). For A-roll, `<in>`/`<out>` use the sequence rate by design (`xmeml-generator.js:475-476`, fixed in an earlier bug pass).
- **Extension download flow** (`extension/modules/queue.js`) uses `chrome.downloads.download()` per item; on completion, `chrome.downloads.search()` returns `final_path` (absolute disk path). A-roll is included as `seq=0` in `manifest.items` and downloaded the same way as b-rolls.

## Approaches Considered

### A — Range request the signed URL before/during download

Extension fires `fetch(url, { headers: { Range: 'bytes=0-1048575' } })` on the signed URL, parses the response bytes for `moov` atom metadata. Runs in parallel with `chrome.downloads.download()`.

**Rejected** because Envato and Storyblocks signed URLs are buyer-bound and may be use-counted (partial GET may consume a download credit) or single-use (signature invalidates on first GET, breaking the actual download). Without testing against a real subscription, the risk to the user's account quota is unacceptable. Pexels/Freepik are safe here, but a hybrid (A for some sources, B for others) doesn't reduce complexity — if we need B for any source, we need the `file://` permission regardless.

### B — Probe the on-disk file via `file://` fetch after download (chosen)

After `chrome.downloads.onChanged` reports the download as `complete`, the extension service worker reads the file with `fetch('file://' + finalPath)`, parses the first ~1 MB of MP4/MOV box structure (with a second range against the tail of the file if `moov` is at end), and writes the result to the queue's per-item record.

**Pros:** zero upstream hits — no quota risk on any source; probes the exact bytes Premiere will load — zero theoretical mismatch; works regardless of how upstream tracks downloads; future-proof against new sources.

**Cons:** requires `host_permissions: ["file:///*"]` in manifest **and** the user must toggle "Allow access to file URLs" per-extension in `chrome://extensions` (off by default, no programmatic grant API). Chrome only offers a deep-link to the extension Details page; the user does the final click.

### C — Bundle `mp4box.js` for the parser

Same plumbing as A or B, but using ~300 KB library instead of a focused DIY parser. Rejected: the four sources (Envato/Pexels/Freepik/Storyblocks) all ship plain progressive MP4/MOV; we don't need fragmented MP4 / DASH support. Adds bundle bloat and Web Store review surface for no functional gain.

## Architecture

After `chrome.downloads` reports a successful download, the extension service worker:

1. Calls `chrome.extension.isAllowedFileSchemeAccess()`. If `false`, skips probe (manifest values flow through, today's behavior preserved). Emits `fps_probe_skipped_no_permission` once per run.
2. Otherwise, fetches `'file://' + finalPath` and parses the bytes for MP4/MOV metadata using a new `extension/modules/mp4-probe.js` module.
3. Tucks the probe result onto the queue's per-item state under `probed_metadata`.
4. When the run completes, the existing `{type:'complete', completed_items:[…]}` message carries the new `probed_*` fields alongside the existing per-item fields. No new IPC.
5. The web app's existing `useExportPort.js` forwards the payload as-is to `POST /api/exports/:id/result`.
6. The backend's result handler maps the probed fields onto `result_json.placements[]` (for b-rolls) and `result_json.aroll` (for A-roll), applying a precedence rule: **probed wins over manifest wins over `null`**.
7. The unchanged `generateXmeml()` reads `sourceFrameRate`, `ntsc`, `embeddedTimecode`, `width`, `height`, `sourceDurationSeconds` per placement and per A-roll segment — same code path as today.

## Parser — `extension/modules/mp4-probe.js`

Pure JS, no dependencies. ~250 LOC implementation + ~200 LOC tests.

**Public surface:**

```js
export async function probeMp4File(fileUrl, opts?: { fetchFn?, signal? })
  // → { frameRate, ntsc, width, height, durationSeconds, embeddedTimecode } | null
```

**Strategy:**

1. `fetch(fileUrl, { headers: { Range: 'bytes=0-1048575' } })` → first 1 MB.
2. Walk top-level ISO BMFF boxes. Verify `ftyp` brand in `{mp4, isom, iso2, iso5, iso6, qt, mp41, mp42, MSNV, M4V, M4A}`.
3. Find `moov`:
   - If found in first 1 MB → parse.
   - If only `mdat` seen → moov is at end. Do `fetch(fileUrl, { method: 'HEAD' })` for total size, then `fetch(fileUrl, { headers: { Range: 'bytes=' + (total-1048576) + '-' + (total-1) } })`.
   - If still not found → return `null` with `fps_probe_failed_moov_not_located`.
4. Walk `moov → trak` for each track:
   - `tkhd` → width / height (only for video trak).
   - `mdia → hdlr` → distinguish `vide` (video) vs `tmcd` (SMPTE timecode track).
   - `mdia → mdhd` → trak `timescale`, `duration`.
   - `mdia → minf → stbl → stts` → sample-to-time table. For CFR (single entry with non-zero `sample_delta`): `frameRate = timescale / sample_delta`. For VFR (multiple entries with significant variance): weighted average, flag in telemetry.
   - For `tmcd` traks: pair with `stsd → tmcd` → read `flags` (drop-frame bit) and `stts → sample_delta` (timecode timescale) and the first sample's value (start frame number) → format as `HH:MM:SS:FF` (or `HH:MM:SS;FF` for DF).
5. Compute `ntsc`: true iff derived rate corresponds to a `/1001` denominator (e.g. `30000/1001` ≈ 29.97 → `frameRate: 30, ntsc: true`; `25/1` → `frameRate: 25, ntsc: false`).
6. Return shape mirrors the server's `probeMediaUrl()` for uniform downstream handling.

**Failure modes** all return `null` and emit a specific telemetry event (see Error Handling section). No throws cross the public surface.

## Data Flow

```
Manifest (server, today):
  manifest.items[i] = { source, source_item_id, frame_rate, ntsc, embedded_timecode,
                        resolution: {width, height}, duration_seconds, ... }
                        ↑ ffprobe of preview/source URL (can be wrong for Envato)

Extension run (today + new probe step):
  startRun({manifest}) → run.items[i] = { ...manifest.items[i] }
  for each item (sequential or parallel per existing scheduler):
    licensing → signed_url
    downloading → chrome.downloads → final_path
    probing (NEW):
      if isAllowedFileSchemeAccess():
        item.probed_metadata = await probeMp4File('file://' + final_path)
      else:
        emit('fps_probe_skipped_no_permission') once per run

Completion event payload — completed_items[i] gains six optional fields:
  probed_fps:                 number | undefined
  probed_ntsc:                boolean | undefined
  probed_width:               number | undefined
  probed_height:              number | undefined
  probed_duration_seconds:    number | undefined
  probed_embedded_timecode:   string | undefined

Web app (today, no change):
  POST /api/exports/:id/result with completed_items forwarded as-is.

Backend POST /exports/:id/result handler — apply precedence per item:
  For each completed_items[i] with seq > 0 (b-roll → result_json.placements[k]):
    placement.sourceFrameRate       = probed_fps                ?? frame_rate        ?? null
    placement.ntsc                  = probed_ntsc               ?? ntsc              ?? false
    placement.width                 = probed_width              ?? resolution.width  ?? null
    placement.height                = probed_height             ?? resolution.height ?? null
    placement.sourceDurationSeconds = probed_duration_seconds   ?? duration_seconds  ?? null
    placement.embeddedTimecode      = probed_embedded_timecode  ?? embedded_timecode ?? null

  For completed_items[0] (A-roll → result_json.aroll, mirroring broll.js:303-310):
    aroll.frame_rate         = probed_fps               ?? aroll.frame_rate         ?? null
    aroll.ntsc               = probed_ntsc              ?? aroll.ntsc               ?? false
    aroll.width              = probed_width             ?? aroll.width              ?? null
    aroll.height             = probed_height            ?? aroll.height             ?? null
    aroll.duration_seconds   = probed_duration_seconds  ?? aroll.duration_seconds   ?? null
    aroll.embedded_timecode  = probed_embedded_timecode ?? aroll.embedded_timecode  ?? null

XMEML generator: unchanged. Already consumes these fields per placement and per A-roll segment.
```

The precedence rule is the entire correctness story: **probed > manifest > fallback (null / 30 / FALSE)**. Manifest values stay populated for users without file:// permission. XMEML emission already tolerates `null` / missing per its current code.

## A-Roll vs B-Roll: What the Probe Changes (and What It Doesn't)

The probe replaces what the *file claims about itself*, never *where the clip sits on the timeline*. The exact split:

| XML field | A-roll | B-roll | Why |
|---|---|---|---|
| `<clipitem><start>`, `<end>` (timeline position) | unchanged | unchanged | both use **sequence rate** (50fps default) via `secondsToFrames(tlStart, frameRate)` |
| `<clipitem><in>`, `<out>` (source in/out) | unchanged | **changes** | A-roll uses sequence rate by design (`xmeml-generator.js:475-476` — fixed for Premiere source-monitor display); B-roll uses source rate via `_durationSrcFrames` and `_embeddedTimecodeFrame` (`xmeml-generator.js:604-606`) |
| `<clipitem><duration>` | unchanged | unchanged | sequence rate |
| `<file><rate><timebase>` + `<ntsc>` | **changes** | **changes** | the whole point of the probe |
| `<file><duration>` | **changes** | **changes** | `sourceDurationSeconds × sourceFrameRate` — both probed |
| `<file><media><samplecharacteristics><width>/<height>` | unchanged | unchanged | both currently emit **sequence** dims (1920×1080); per-file dims left untouched per WyattBlue's note (`xmeml-generator.js:669-670`) — out of scope here |
| `<file><timecode><string>` | unchanged | **changes** | A-roll hardcoded to `00:00:00:00` (`xmeml-generator.js:506`) so DaVinci accepts zero-based `<in>`/`<out>`; B-roll uses probed `embeddedTimecode` (`xmeml-generator.js:649`) |
| User's cuts / editor state | unchanged | unchanged | stored in seconds; frame-rate-independent |

The asymmetry's practical consequence: **A-roll probe's blast radius is low** (worst case: file claims wrong rate but `<in>`/`<out>` stay correct; usually still imports with a rate-mismatch warning). **B-roll probe's blast radius is high** (correctly recomputes `<in>`/`<out>` when source FPS or embedded TC differs from manifest — this is the actual fix for the failures users see today).

Probed width/height are **captured but not emitted** in v1. Switching XMEML to per-file dimensions instead of sequence dims would be a separate change (with its own Envato-preview-vs-licensed validation), explicitly out of scope.

## Error Handling

Every failure path falls back to today's behavior. Probe failure never blocks `export_completed`.

| Condition | Behavior | Telemetry event |
|---|---|---|
| `isAllowedFileSchemeAccess()` returns false | skip probe (once per run) | `fps_probe_skipped_no_permission` |
| `final_path` missing | skip probe | `fps_probe_failed_no_path` |
| `fetch('file://...')` rejects (404, OS error, file moved) | skip probe | `fps_probe_failed_fetch` |
| File < 16 bytes or no valid first box | skip probe | `fps_probe_failed_not_mp4` |
| `ftyp` brand outside the allowlist | skip probe | `fps_probe_failed_unsupported_brand` |
| `moov` not in first 1 MB; tail range also fails | skip probe | `fps_probe_failed_moov_not_located` |
| Parse error mid-box (unexpected EOF, bad atom size) | skip probe | `fps_probe_failed_parse_error` (with byte offset) |
| Derived FPS ≤ 0, NaN, or > 120 | skip probe | `fps_probe_failed_bogus_value` (with derived value) |
| VFR detected (stts variance > 10%) | use weighted average, emit, flag as VFR | `fps_probe_vfr_detected` |
| 10s timeout | skip probe | `fps_probe_timeout` |
| Success | emit probed values | `fps_probe_success` |

Telemetry rides the existing `emit()` pipe from Ext.6/Ext.8 (no new transport). Server-side aggregation lands in `/admin/exports` event timeline alongside today's events. After a week of beta data, the per-source `fps_probe_success` vs `fps_probe_failed_*` ratio confirms or refutes the "Envato preview probe is unreliable" hypothesis with real numbers.

## file:// Permission Onboarding UX

Hard constraint: Chrome does not expose a programmatic API to grant "Allow access to file URLs." Only the user can flip it in `chrome://extensions`. The UX has to coach, not prompt.

### Manifest change

```json
"host_permissions": ["file:///*"]
```

Without this entry, the toggle won't even appear on the extension's Details page.

### Popup banner state machine

`popup.html` / `popup.js` — ~50 LOC. On popup open:

1. Read `await chrome.extension.isAllowedFileSchemeAccess()`.
2. Read `chrome.storage.local.run_history_count`.
3. If permission `false` AND `run_history_count >= 1` AND `fps_banner_snoozed_until` is in the past (or unset):
   - Render yellow banner: *"Enable FPS verification for reliable Premiere imports."*
   - Primary button: **"Show me how"** → expands an inline instructions panel:
     1. A button that opens `chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id })` — Chrome deep-links to this extension's Details page.
     2. A short static SVG (or 3-frame inline GIF) illustrating the location of the "Allow access to file URLs" toggle.
     3. Caption: *"Come back to this popup — the banner will disappear automatically."*
   - Secondary action: **"Not now"** sets `fps_banner_snoozed_until = now + 7 days`.
4. While the popup is open, listen for `chrome.runtime.onConnect` (popup reopen) and `window.focus`. Re-poll `isAllowedFileSchemeAccess()` on each; if it newly returns `true`, remove banner and emit `fps_permission_granted` telemetry.

### Pre-export gate

In `extension/service_worker.js`, inside the existing `enforceConfigBeforeExport()` flow, add a one-line check: if `isAllowedFileSchemeAccess()` is `false`, emit a single `export_started_without_fps_probe` telemetry event. **Do not block.** The user has chosen their friction tolerance; nagging mid-export is too late.

### Web app side

Zero changes for v1. The State F partial-failure UI already surfaces per-item issues. A future mini-PR could add a "this item used unverified FPS" badge in `/admin/exports/:id`, but that's not blocking.

## Versioning + Rollout

- **Extension version:** v0.9.x → **v1.0.0** (semver: new manifest permission justifies major bump; aligns with the Web Store submission timeline).
- **Feature flag:** `/api/ext-config` (the Ext.9 endpoint) gains a new field — `fps_probe_enabled: boolean`, default `true` server-side. Extension reads it via the existing `fetchConfig()` cache. Lets us kill the probe remotely if a regression surfaces. **Fall-open if config unreachable:** probe enabled (consistent with Ext.9's fall-open philosophy).
- **Backward compatibility:** every change is additive. Older backend code without the precedence handler would simply ignore the new `probed_*` fields and the export would behave as today. Older extension code (no probe) won't emit `probed_*` fields and the backend handler falls through to manifest values — also today's behavior.

## Tests

### Unit — `extension/__tests__/mp4-probe.test.js` (~200 LOC)

Fixtures in `extension/fixtures/mp4/` (11 small synthesized files, 30–80 KB each), generated by a committed `extension/scripts/generate-mp4-fixtures.sh` script invoking `ffmpeg -f lavfi`:

- `23976_ntsc.mov` — 24000/1001
- `25_pal.mp4` — 25/1
- `2997_ntsc.mov` — 30000/1001
- `30_cfr.mp4` — 30/1
- `50_pal.mp4` — 50/1
- `5994_ntsc.mov` — 60000/1001
- `60_cfr.mp4` — 60/1
- `moov_at_end.mp4` — generated with `-movflags +nofaststart`; tests tail-range path
- `with_tmcd.mov` — generated with `-timecode 18:16:14:04`; tests SMPTE extraction
- `vfr.mp4` — variable frame rate; tests VFR detection + averaging
- `corrupt_truncated.mp4` — first 8 KB of `30_cfr.mp4`; tests parse-error fallback

Test matrix: each success fixture asserts the full return tuple `{frameRate, ntsc, width, height, durationSeconds, embeddedTimecode}`. Failure fixtures assert `null` return + correct telemetry event name.

### Integration — `extension/__tests__/queue-probe.test.js` (~80 LOC)

- Stub `chrome.downloads`, stub `fetch` to serve fixture bytes, stub `chrome.extension.isAllowedFileSchemeAccess` (true and false variants).
- Run a 3-item queue end-to-end; assert:
  - When permission granted: `completed_items[].probed_*` fields populated with expected values from fixtures.
  - When permission denied: `probed_*` fields absent; `fps_probe_skipped_no_permission` emitted exactly once; export still completes.

### Backend — extend `server/routes/__tests__/exports-result.test.js` (~50 LOC)

- POST result with `completed_items[].probed_*` → precedence test: probed values win over manifest values in `result_json.placements` and `result_json.aroll`.
- POST result without probed fields → manifest values flow through (regression guard).
- Snapshot: feed both shapes through `generateXmeml()`; assert XML diffs are confined to expected fields (`<file><rate>`, `<ntsc>`, `<file><duration>`, b-roll `<in>`/`<out>` when probed FPS differs from manifest FPS).

### Manual smoke (added as item #12 to the 11 pending smokes)

5-item export with known framerates:
- One 23.976 fps Envato MOV
- One 29.97 fps Pexels MP4
- One 25 fps Pexels MP4
- One 30 fps Freepik MP4
- User A-roll at 50 fps (Supabase)

Acceptance: import generated XML into Premiere Pro. Every clip lands green (online) in the project bin. No "File not found in search directories" errors. No rate-mismatch warnings in the source monitor.

## Out of Scope (deliberately deferred)

- **Per-file dimensions in XMEML** (currently all clipitems use sequence dims 1920×1080 per `xmeml-generator.js:669-670`). Capturing probed width/height in v1 unlocks this as a follow-up mini-PR, but switching the emission has its own validation cost against Envato preview-vs-licensed dimension drift.
- **Auto-grant flow.** Chrome does not expose `chrome.permissions.request()` for the file scheme; nothing programmatic to do here.
- **Native messaging or bundled ffprobe.** Massive complexity (user installs a native binary); rejected.
- **Web app UI badging for unverified items.** Future mini-PR — `/admin/exports/:id` could show a "FPS unverified" badge per placement when `probed_*` is absent. Not blocking.
- **Storyblocks-specific code paths.** Storyblocks is not a current export source (per `xmeml-generator.js:305` comment, only a planned future source). When it lands, the same parser works — MP4 container, same fields.

## Open Questions

- **VFR handling threshold.** What variance ratio in `stts` deltas should reject as VFR vs accept as CFR with rounding? Initial proposal: variance > 10% rejects. Will refine if any source produces "near-CFR" files that fail this threshold in early telemetry.
- **Fixture generation reproducibility.** `ffmpeg` versions across dev machines may produce slightly different container bytes. Acceptable for FPS probe correctness (the values we test for don't depend on byte-exact output), but committed fixtures should not be regenerated casually — re-commit only if the parser test breaks for legitimate reasons.
