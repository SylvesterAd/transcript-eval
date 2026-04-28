# Export page (WebApp.1 Phase A — States A/B/C)

Pre-flight UI rendered at `/editor/:videoGroupId/export/:planPipelineId` that
walks the user through three states before handing off to the Chrome Export
Helper extension. The `:planPipelineId` segment selects which b-roll variant
to export; `/editor/:videoGroupId/export` (no plan id) auto-redirects to the
sole completed plan or shows a chooser when there are several.

| State | Renders when | Component |
|---|---|---|
| **A** | extension not installed | `StateA_Install.jsx` |
| **B** | installed but Envato session not detected (and manifest has Envato items) | `StateB_Session.jsx` |
| **C** | preconditions met → summary card with Start Export button | `StateC_Summary.jsx` |

States **D** (in-progress), **E** (complete), and **F** (partial) live in the
follow-up plan that depends on Ext.5's long-lived Port. This phase ships A/B/C
plus the supporting backend endpoint `GET /api/broll-searches/:pipelineId/manifest`.

## Wiring

```
ExportPage.jsx (FSM: init -> a -> b -> c -> starting)
  |- useExportPreflight -- ping (2s in state_a) + manifest fetch + disk estimate
  |- useExtension       -- promise-wrapped chrome.runtime.sendMessage
  \- buildManifest      -- pure function: per-variant API responses -> unified manifest
```

## Extension ID delivery

`vite.config.js` reads `extension/.extension-id` (committed by Ext.1) at build
time and exposes it as the global `__EXTENSION_ID__`, surfaced via
`src/lib/extension-id.js`.

If `extension/.extension-id` isn't on your branch (e.g. Ext.1 hasn't merged
yet), set the env var:

```bash
VITE_EXTENSION_ID=abcdefghijklmnopqrstuvwxyzabcdef npm run dev:client
```

## State B is OPTIMISTIC

Ext.1's `pong` message hard-codes `envato_session: 'missing'` because the
cookie watcher lands in **Ext.4**. To unblock users in the meantime, State B
shows the spec's sign-in CTA AND a manual "I'm signed in — continue" override
that advances the FSM to State C. The override carries a small caveat ("we'll
re-check before download") and is marked with a TODO referencing Ext.4 for
removal.

## Deferred from Phase A

- States D / E / F (in-progress / complete / partial)
- Long-lived `chrome.runtime.Port` (Ext.5)
- File System Access API folder picker (deferred per roadmap)
- XMEML generation kickoff (WebApp.2)
- Retry / cancel buttons (relevant to D / F)
- Multi-tab "export already in progress" lock (D-era)

## Phase B additions — State D (in-progress) + terminal placeholders

State D is the live-progress UI, built on a long-lived `chrome.runtime.Port`.

| State | Renders when | Component | Notes |
|---|---|---|---|
| **D** | user clicked Start → extension has an active run | `StateD_InProgress.jsx` | spec § State D mockup |
| **E** | extension reports `{type:"complete"}` with `fail_count === 0` | `StateE_Complete_Placeholder.jsx` | placeholder; real UI in next plan |
| **F** | extension reports `{type:"complete"}` with `fail_count > 0` | `StateF_Partial.jsx` | partial-failure UI (per-failure list, retry, XML-anyway, report stub) |

### Wiring (Phase B)

```
ExportPage.jsx (FSM extended: … → state_d → state_e/state_f)
  └─ ActiveRun (sub-component, mounted only in state_d/e/f)
       └─ useExportPort
            ├─ ext.openPort('export-tap')             long-lived chrome.runtime.connect
            ├─ onMessage → progressReducer            pure state transitions
            ├─ sendControl('pause'|'resume'|'cancel') one-shot chrome.runtime.sendMessage
            └─ reconnect                              user-gated after 2 auto-retries
```

### Port message contract (from Ext.5)

```js
// extension → web app (broadcast to every connected Port)
{ type:"state",    version:1, export:{ runId, items, stats, run_state, ... } }
{ type:"progress", version:1, item_id, phase, bytes, total_bytes }
{ type:"item_done",version:1, item_id, result:{ ok, bytes, error_code? } }
{ type:"complete", version:1, ok_count, fail_count, folder_path, xml_paths:[] }

// web app → extension (one-shot sendMessage)
{ type:"status",   version:1 }                        // force a fresh {type:"state"}
{ type:"pause",    version:1, export_id }
{ type:"resume",   version:1, export_id }
{ type:"cancel",   version:1, export_id }
```

### Reconnect policy

On `port.onDisconnect` during an active run:
1. Try reconnect immediately (attempt 1 of 2). Send `{type:"status"}` on success.
2. If that disconnects too, wait 2s and try again (attempt 2 of 2).
3. If both fail: render the "Disconnected from Export Helper. Reconnecting…" banner with a **manual Retry** button. Do NOT auto-poll further.

The `state.complete` sentinel short-circuits reconnect — once we've received the terminal `{type:"complete"}`, the extension legitimately closed the Port and we don't need to reopen it.

### Single-run-active detection

If the extension's first snapshot carries a `runId` different from the page's expected `run_id` (received from `ext.sendExport`'s response), we render the **mismatch blocker**: "Another export is in progress (Variant X · running)". The user can "Cancel other run" (dispatches `{type:"cancel", export_id:<other>}`) or Refresh.

### Throttle + render budget

Ext.5 throttles `{type:"progress"}` messages at ~500 ms per item (its own contract). React can render 100 updates/sec fine — the hot path is selector derivation, so `useMemo` wraps every selector call against the snapshot reference. No virtualization (`react-window` / `react-virtuoso`) — 300-item hard cap + CSS `max-height + overflow:auto` is enough.

### State E/F

- **State E** (`StateE_Complete.jsx`) — Week 4 WebApp.1 State E plan. Auto-runs `useExportXmlKickoff` on mount, downloads per-variant XML blobs, shows the folder path and a short Premiere import tutorial.
- **State F** (`StateF_Partial.jsx`) — this plan (WebApp.1 State F). Renders the partial-failure UI:
  - Amber "Export partial" header + summary (`N / M clips downloaded · K failed`).
  - Per-failure list: filename + source chip + human-readable reason from `src/lib/errorCodeLabels.js` (maps the 15-code `error_code` enum from `extension/modules/telemetry.js` to user-facing strings).
  - **"Retry failed items"** — rebuilds a filtered `unified_manifest` from the preserved `state.unified_manifest.items` (ExportPage reducer), calls the existing `onStart` ceremony (`createExport` → `sendSession` → `sendExport`), FSM transitions back to `state_d`. The extension's `finalize()` already releases the lock via `clearActiveRunId()` (queue.js:584), so a second `{type:"export"}` passes the `run_already_active` check.
  - **"Generate XML anyway"** — mounts a child `XmlKickoffPanel` that calls `useExportXmlKickoff({autoKick:false, ...}).regenerate()` once on mount. The Week 4 hook already handles partial placements gracefully; missing clips appear offline (red) in Premiere per the design spec.
  - **"Report issue"** — disabled stub with a "Coming in Ext.8" tooltip. Ext.8 will auto-attach the diagnostic bundle.
