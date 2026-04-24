# Export page (WebApp.1 Phase A — States A/B/C)

Pre-flight UI rendered at `/editor/:id/export?variant=<X>` that walks the user
through three states before handing off to the Chrome Export Helper extension:

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
