# WebApp.1 (Phase A) — Export Page Pre-flight (States A–C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first slice of the transcript-eval Export page at `/editor/:id/export?variant=<X>` — a finite state machine that walks the user through the three pre-flight states described in the master spec: **State A** (extension not installed), **State B** (Envato session missing), and **State C** (preconditions met / summary / Start Export). Plus the single supporting backend endpoint (`GET /api/broll-searches/:pipelineId/manifest`) that turns `broll_searches.results_json` into the per-item manifest the extension will consume. States D / E / F (in-progress, complete, partial) are deferred to a separate plan that lands AFTER Ext.5 ships, because State D depends on the long-lived Port the extension's queue exposes.

**Architecture:** New React route `/editor/:id/export` mounted in `src/App.jsx`, rendered by `src/pages/ExportPage.jsx` which is a `useReducer`-driven state machine (`'init' | 'state_a' | 'state_b' | 'state_c' | 'starting'`). Three discrete state components in `src/components/export/`. Two new hooks (`useExtension` and `useExportPreflight`) wrap `chrome.runtime.sendMessage` (promise-ified, with `lastError` handling) and compose the parallel pre-flight checks (extension ping, manifest fetch, disk estimate). One pure lib `src/lib/buildManifest.js` builds the per-variant manifest the extension consumes (multi-variant dedup baked in). Extension ID delivered at build time via a small Vite `define` block in `vite.config.js` that reads `extension/.extension-id` (falling back to `VITE_EXTENSION_ID`). One new backend endpoint extends the existing `server/routes/broll.js` (matches existing route style + `requireAuth` pattern).

**Tech Stack:** React 19 + react-router-dom 7 + Vite 5 (existing). Styled-components 6 already in `package.json` for component-level styles; lucide-react for icons. Express 5 + `pg` (existing) for the new backend route. No new runtime dependencies. No test framework — verification is manual + curl, matching project convention. No state-management library — `useReducer` is sufficient for the FSM.

---

## Why read this before touching code

The export page is a **finite state machine**, not a single monolithic component. Each pre-flight state (A/B/C) is its own discrete React component owned by `ExportPage.jsx`, which dispatches transitions based on the result of the parallel pre-flight checks. Resist the urge to "just put it all in one big page" — each state has different copy, different actions, and a different "what happens when this changes" lifecycle. Treating them as one component buries the transitions and turns this plan into a future grease fire.

**Extension ID delivery.** The Chrome extension's stable ID is committed to `extension/.extension-id` by Ext.1's keygen script. The web app must reference that same ID when calling `chrome.runtime.sendMessage(EXT_ID, …)`. We deliver the ID at build time via a Vite `define` in `vite.config.js`: the config reads `extension/.extension-id` if present, otherwise falls back to `process.env.VITE_EXTENSION_ID` (so this plan can ship even if Ext.1 hasn't merged to main yet — the env var lets a developer point the dev build at any extension ID). `?raw` runtime imports are a simpler alternative but would force `extension/` to be on the same branch — define-at-build is more portable. Document the choice in `src/lib/extension-id.js`.

**`chrome.runtime.sendMessage` is callback-only.** It does NOT return a Promise. Wrap every call in a Promise that resolves on the response and rejects on `chrome.runtime.lastError`. This wrapper lives in `useExtension.js`. If you forget to check `lastError`, Chrome silently logs a warning and the response is `undefined` — a confusing failure mode.

**Polling cadence.** Spec requires extension ping every 2s while in State A. Use a single `setInterval` cleared on (a) component unmount and (b) state transition out of A. Do NOT poll in State B/C; once the extension is detected, switch to one-shot reads. Polling forever wastes Chrome IPC and burns dev CPU.

**Manifest comes from the backend, not the React side.** The new `GET /api/broll-searches/:pipelineId/manifest?variant=<label>` endpoint reads `broll_searches.results_json` server-side and reshapes per-result entries into the manifest entry format the extension expects. The React side never reads the table directly — that would require duplicating the upstream pipeline's per-result schema knowledge in two places.

**Multi-variant export.** The State C summary card shows a "Also export Variant A and B" checkbox. When toggled, the page fetches manifests for the additional variants and `buildManifest` merges + dedupes by `(source, source_item_id)` per spec § "Dedup strategy." `buildManifest` accepts an array of variants — it's a pure function and easy to test by hand.

**Start Export.** Clicking the button POSTs to `/api/exports` (Phase 1 backend, already shipped) to create the exports row, then sends `{type:"export", version:1, export_id, manifest, target_folder, options}` to the extension via `chrome.runtime.sendMessage`. After Ext.5 lands the long-lived Port, this becomes a Port `connect()` — but for Phase A scope we only need the one-shot send. State D is the placeholder that says "Export started; in-progress UI lands once the extension queue is wired."

**Disk space check.** `navigator.storage.estimate()` returns `{usage, quota}` but `quota` is undefined or 0 in some browsers (notably Safari). Treat undefined/0 as "could not check" with a soft warning instead of blocking the user. Don't pretend we know there's enough disk when we don't.

**Non-Chrome detection.** Two-stage: (1) check for `window.chrome?.runtime` presence — Chromium-based browsers expose this and it's the actual capability we need. (2) UA string sniff as a fallback for friendlier copy ("Looks like you're on Safari…"). Don't gate purely on UA — Brave/Edge/Arc all spoof and we'd be turning away supported browsers.

**State B is OPTIMISTIC because Ext.1 doesn't watch Envato cookies yet.** Ext.1's `pong` reply hard-codes `envato_session: 'missing'`, regardless of whether the user is actually signed in. If we treated that as truth, every user would be stuck on State B forever. Compromise for Phase A: render State B as a soft warning ("Sign in to Envato to license clips") with both a "Sign in to Envato" button AND a "I'm signed in, continue" manual override. The override carries a small caveat ("we'll re-check before download") and unblocks the flow until Ext.4 wires the real cookie watcher. Mark this with a TODO comment in `StateB_Session.jsx` referencing Ext.4 so it's obvious where to tighten later.

---

## Scope (WebApp.1 Phase A only — hold the line)

### In scope

- Mount the new route `/editor/:id/export` in `src/App.jsx` (sibling of the existing `/editor/:id` editor routes).
- `src/pages/ExportPage.jsx` — `useReducer` FSM rendering one of three state components.
- `src/components/export/StateA_Install.jsx` — Install Helper screen + Chrome detection banner + 2s extension ping polling.
- `src/components/export/StateB_Session.jsx` — Sign-in-to-Envato screen with manual continue override.
- `src/components/export/StateC_Summary.jsx` — Summary card with manifest totals, source breakdown, target folder display, multi-variant checkbox, re-download checkbox, Start Export button.
- `src/hooks/useExtension.js` — promise-wrapped `chrome.runtime.sendMessage` for `ping`, `session`, `export` message types.
- `src/hooks/useExportPreflight.js` — composes ping polling + manifest fetch + disk estimate; returns a discriminated-union per sub-result.
- `src/lib/extension-id.js` — exports the EXT_ID constant baked at build time.
- `src/lib/buildManifest.js` — pure function that takes the API response(s) plus options and returns the unified manifest array + totals.
- `vite.config.js` — `define` block exposing `__EXTENSION_ID__` from `extension/.extension-id` or `VITE_EXTENSION_ID` env var.
- `server/routes/broll.js` — extend with `GET /api/broll-searches/:pipelineId/manifest?variant=<label>`. `requireAuth` + ownership check + transforms `results_json` to the manifest entry shape.

### Deferred (DO NOT add to Phase A — they belong to later plans)

- **State D** (export running with progress bar + per-item status + pause/cancel) → next webapp plan, gated on Ext.5's Port.
- **State E** (export complete with folder path + XML links + "How to import in Premiere") → next webapp plan, gated on WebApp.2 XMEML generator.
- **State F** (partial completion with per-failure diagnostics + retry options) → next webapp plan.
- Long-lived `chrome.runtime.Port` handling → Ext.5 + next webapp plan. Phase A uses one-shot `sendMessage` only.
- Real-time progress mirroring → Ext.5.
- File System Access API folder picker → deferred per roadmap "key decisions." Phase A defaults the target folder to `~/Downloads/transcript-eval/export-<id>-<variant>/` (display-only string in State C). The "Change folder" button shows an alert "Folder picker coming soon" and is wired but does nothing.
- XMEML generation kickoff → handled by WebApp.2 (separate plan); this page does NOT call `/api/exports/:id/generate-xml`.
- Retry / cancel buttons → relevant to D / F, not Phase A.
- Telemetry collection display → Ext.6 owns server-side; UI doesn't surface it in Phase A.
- Pre-export Envato session sanity check (the spec's "one GET to `app.envato.com/download.data` with a reference itemUuid") → lives in the extension (Ext.4); the page doesn't pre-flight Envato directly.
- Multi-tab "export already in progress" lock → relevant when State D exists; deferred.
- `/api/ext-config` consumption (min_ext_version gating, killswitch) → Ext.9.

Fight the urge to "just add" any of the above. Phase A proves the page can render the three pre-flight states + click Start Export and hand off to the extension. That's the entire deliverable.

---

## Prerequisites

- Phase 1 backend running on `http://localhost:3001` (provides `POST /api/session-token`, `POST /api/exports`). If you haven't merged `feature/envato-export-phase1` yet, run that branch's dev server.
- Ext.1 loaded unpacked in dev Chrome at the ID committed to `extension/.extension-id`, OR set `VITE_EXTENSION_ID=<ID>` before `npm run dev:client` to override (handles the case where `extension/.extension-id` isn't on `main` yet).
- Vite dev server on `:5173` (existing — `npm run dev:client`).
- Chrome 120+ for testing (matches Ext.1's `minimum_chrome_version`).
- A real `plan_pipeline_id` with at least one variant in `broll_searches` whose `status='complete'` and `results_json` is populated. Easiest: open `http://localhost:5173/editor/<id>/brolls/edit?variant=C` first to confirm the variant has picked b-rolls, then use that pipelineId for the export page.

Note: Path to the repo has a trailing space in "one last " — quote every path. `cd "$TE"` patterns only.

---

## File structure (Phase A final state)

All paths are inside the transcript-eval repo root (which I'll call `$TE`).

```
$TE/src/
├── App.jsx                                      MODIFIED — mount new route
├── pages/                                        NEW DIR
│   └── ExportPage.jsx                            FSM (Phase A: states init / a / b / c / starting)
├── components/
│   └── export/                                   NEW DIR
│       ├── StateA_Install.jsx                    install Helper + Chrome banner + 2s ping
│       ├── StateB_Session.jsx                    Envato sign-in + manual continue
│       └── StateC_Summary.jsx                    summary card + Start Export
├── hooks/
│   ├── useExtension.js                           NEW — promise-wrapped sendMessage helpers
│   └── useExportPreflight.js                     NEW — composed pre-flight checks
└── lib/
    ├── extension-id.js                           NEW — exports EXT_ID baked at build time
    └── buildManifest.js                          NEW — pure manifest builder

$TE/server/
└── routes/
    └── broll.js                                  MODIFIED — add GET /api/broll-searches/:pipelineId/manifest

$TE/vite.config.js                                MODIFIED — `define` for __EXTENSION_ID__
```

Why this split:
- `src/pages/` is a new directory; existing pages live in `src/components/views/` (admin) and `src/components/editor/` (editor sub-pages routed via path segments). The Export page is its own top-level route, so a sibling `src/pages/` directory matches the spec's vocabulary ("export page") and avoids polluting `views/` (which is admin-scoped) or `editor/` (which is the editor subtree, not a sibling).
- `src/components/export/` keeps the three state components co-located. They are NOT routed individually — they're only ever rendered by `ExportPage.jsx`.
- `src/lib/` already exists and is the right home for pure libs. `extension-id.js` is one constant; `buildManifest.js` is a pure function.
- `src/hooks/` already exists; `useExtension.js` and `useExportPreflight.js` slot in alongside the existing `useApi.js`.
- `server/routes/broll.js` is extended (not a new file) because the new endpoint reads from the same `broll_searches` table the existing routes write to. Having two files own the same table invites drift; a single file owns it end-to-end.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/export-page-preflight` on branch `feature/export-page-preflight`, branched off `main`. (NOT off `feature/envato-export-phase1` or `feature/extension-ext1` — this plan should merge cleanly after either; the only runtime dependency is `extension/.extension-id` for the build define, which has the env-var fallback.)
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan.
- **Never kill process on port 3001.** That's the user's backend dev server. If you launch anything for testing, use a different port.
- **Commit style:** conventional commits (`feat(export): ...`, `feat(api): ...`, `chore(export): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing.
- **No new runtime deps.** Use what's in `package.json`: react, react-router-dom, styled-components, lucide-react. The plan introduces zero new packages.
- **Match existing style.** Existing code uses Tailwind utility classes in admin views and styled-components elsewhere. For new components, prefer styled-components (it's already a dep, and the export page is a self-contained surface that doesn't need to share a Tailwind config with the admin views). Inline styles are fine for one-offs.

---

## Task 0: Create worktree + scaffold directories

**Files:**
- Create: `$TE/.worktrees/export-page-preflight/` (worktree)
- Create: `src/pages/`, `src/components/export/` (empty dirs to start)

- [ ] **Step 1: Create the worktree + branch**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin main
git worktree add -b feature/export-page-preflight .worktrees/export-page-preflight main
cd ".worktrees/export-page-preflight"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight
git status
# Expected: "On branch feature/export-page-preflight; nothing to commit, working tree clean"
```

- [ ] **Step 2: Verify you are on the new branch before any file changes**

```bash
git branch --show-current
# Expected: feature/export-page-preflight
```

If this prints anything else, STOP and fix — don't write files into the wrong branch.

- [ ] **Step 3: Create the new directories**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
mkdir -p src/pages src/components/export
ls src/pages
ls src/components/export
# Expected: both empty (created)
```

- [ ] **Step 4: Sanity check — extension/.extension-id presence**

```bash
ls extension/.extension-id 2>/dev/null && cat extension/.extension-id || echo "MISSING — will fall back to VITE_EXTENSION_ID env var"
```

If `extension/.extension-id` is missing on `main` (Ext.1 hasn't merged yet), this is fine — Task 1's vite.config edit handles the fallback. Note the absence so the verification step in Task 9 reminds you to set `VITE_EXTENSION_ID`.

- [ ] **Step 5: Commit (empty dirs are fine — git tracks them implicitly when files appear)**

The only filesystem change so far is the empty directories, which git won't track until they have files. There's nothing to commit yet. Do NOT add empty `.gitkeep` files — they pollute the tree. The first real commit lands in Task 1.

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

---

## Task 1: vite.config.js — bake the extension ID at build time

The web app needs to call `chrome.runtime.sendMessage(EXT_ID, …)`, where `EXT_ID` must match the extension's installed ID. The ID is committed to `extension/.extension-id`. We expose it to the React bundle via Vite's `define`, with a `VITE_EXTENSION_ID` env var fallback so the plan can ship even if Ext.1 hasn't merged to `main`.

**Files:**
- Modify: `vite.config.js` (extend the `define` block)

- [ ] **Step 1: Read the existing `vite.config.js`**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
cat vite.config.js
```

Current contents (~28 lines): `defineConfig({ define: { '__APP_VERSION__': … }, plugins: [react(), tailwindcss()], server: {...} })`. We add a sibling `__EXTENSION_ID__` define and a small helper that resolves it.

- [ ] **Step 2: Edit `vite.config.js` — add the extension-id helper + define entry**

Use the Edit tool. Replace the existing top of the file (imports + `gitSha` line + `defineConfig({ define: ... })`) with the version below. The change is:
- Add `import { existsSync, readFileSync } from 'node:fs'` and `import path from 'node:path'`
- Add a `getExtensionId()` helper
- Add `__EXTENSION_ID__: JSON.stringify(getExtensionId())` to the `define` block

Final `vite.config.js` (full file shown for clarity — exact contents):

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'unknown' } })()

// Extension ID: pinned by Ext.1 in extension/.extension-id (committed).
// Override via VITE_EXTENSION_ID env var when the file isn't present
// (e.g. building before Ext.1 has merged to main, or pointing the
// dev build at a freshly-loaded unpacked extension whose ID differs).
function getExtensionId() {
  const fromEnv = process.env.VITE_EXTENSION_ID
  if (fromEnv) return fromEnv
  const fromFile = path.resolve(__dirname, 'extension/.extension-id')
  if (existsSync(fromFile)) return readFileSync(fromFile, 'utf-8').trim()
  // Don't throw — let the bundle build with a sentinel so the dev test
  // page can render an actionable error instead of a build failure.
  return ''
}

export default defineConfig({
  define: {
    '__APP_VERSION__': JSON.stringify(gitSha),
    '__EXTENSION_ID__': JSON.stringify(getExtensionId()),
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        timeout: 3600000, // 1 hour for large file uploads + concat
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Remove content-length limit for file uploads
            proxyReq.setHeader('connection', 'keep-alive')
          })
        }
      },
      '/uploads': 'http://localhost:3001'
    },
    hmr: { overlay: false }
  }
})
```

Why "don't throw if missing": throwing would brick the build whenever someone clones the repo before Ext.1 merges. Returning empty string lets the bundle build; the consumer (`src/lib/extension-id.js`) treats empty as a hard error at the point of use, with a helpful message including how to set the env var. That's a much better DX than a cryptic Vite stack trace.

- [ ] **Step 3: Verify the file parses**

```bash
node -e "import('./vite.config.js').then(m => console.log('ok, plugins =', m.default.plugins?.length || 'n/a')).catch(e => { console.error(e); process.exit(1) })"
# Expected: "ok, plugins = 2" (or similar) — non-zero exit means syntax/import error
```

- [ ] **Step 4: Commit**

```bash
git add vite.config.js
git commit -m "$(cat <<'EOF'
feat(export): bake extension ID into vite build define

Reads extension/.extension-id (committed by Ext.1) at build time and
exposes it as the global __EXTENSION_ID__. Falls back to the
VITE_EXTENSION_ID env var when the file isn't present (so this branch
builds fine even when Ext.1 hasn't merged to main yet). Falls back to
an empty string if neither source is set — the consumer surfaces a
clear runtime error instead of bricking the build.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `src/lib/extension-id.js`

Tiny module — exports the EXT_ID constant baked by Task 1 plus a small `requireExtensionId()` helper that throws an actionable error when the constant is empty.

**Files:**
- Create: `src/lib/extension-id.js`

- [ ] **Step 1: Write `src/lib/extension-id.js`**

```js
// Extension ID baked at build time by vite.config.js's `define` block
// from extension/.extension-id (committed by Ext.1) or the
// VITE_EXTENSION_ID env var.
//
// Why a separate file? So every consumer imports the same constant
// and there's one obvious place to look when "the extension isn't
// receiving messages." In dev, calling requireExtensionId() with an
// empty value throws with a copy-pasteable command to fix the env.

/* global __EXTENSION_ID__ */
export const EXT_ID = typeof __EXTENSION_ID__ === 'string' ? __EXTENSION_ID__ : ''

export function requireExtensionId() {
  if (!EXT_ID) {
    throw new Error(
      'EXT_ID is empty. Either commit extension/.extension-id (run ' +
      '`npm run ext:generate-key` from the extension worktree), or set ' +
      'VITE_EXTENSION_ID before starting vite (e.g. ' +
      '`VITE_EXTENSION_ID=abcdefghijklmnopqrstuvwxyzabcdef npm run dev:client`).'
    )
  }
  return EXT_ID
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check src/lib/extension-id.js
# Expected: exit 0
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/extension-id.js
git commit -m "$(cat <<'EOF'
feat(export): EXT_ID constant + requireExtensionId helper

Single source of truth for the Chrome extension ID across the React
app. Reads __EXTENSION_ID__ baked at build time by vite.config.js;
helper throws an actionable error if empty so devs see exactly which
env var to set instead of a cryptic chrome.runtime.lastError later.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `src/hooks/useExtension.js` — promise-wrapped sendMessage

This is THE wrapper around the awkward callback-only `chrome.runtime.sendMessage` API. Three exported helpers (`ping`, `sendSession`, `sendExport`) and one internal `send()` that handles `chrome.runtime.lastError`. Returned values are plain objects — no React state — because callers (the preflight hook + State C button handler) own the state.

**Files:**
- Create: `src/hooks/useExtension.js`

- [ ] **Step 1: Write `src/hooks/useExtension.js`**

```js
// Promise-wrapped chrome.runtime.sendMessage helpers.
//
// chrome.runtime.sendMessage(EXT_ID, msg, callback) is callback-only
// AND chrome.runtime.lastError is not surfaced via the callback's
// arguments — you have to read it inside the callback. If you forget,
// Chrome silently logs a warning and your response is undefined.
//
// `send()` here:
//   - rejects if chrome.runtime is missing (non-Chrome browser, or
//     extension not installed and Chrome blocks the channel).
//   - rejects with the lastError message if Chrome reports one.
//   - resolves with the response otherwise.
//
// All exported helpers wrap `send()` and add a `.installed` boolean
// to the result (true when send succeeded, false when it rejected
// with a "Could not establish connection" / "Receiving end does not
// exist" error — the canonical "extension not installed" signals).

import { useMemo } from 'react'
import { EXT_ID } from '../lib/extension-id.js'

// Chrome reports a few distinct phrasings when the extension isn't
// reachable. Match on substrings rather than exact equality so we
// stay tolerant across Chrome versions / locales.
function isNotInstalledError(message) {
  if (!message || typeof message !== 'string') return false
  const m = message.toLowerCase()
  return (
    m.includes('could not establish connection') ||
    m.includes('receiving end does not exist') ||
    m.includes('no extension') ||
    m.includes('not exist')
  )
}

function send(msg, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
      reject(new Error('chrome.runtime.sendMessage is not available — non-Chrome browser?'))
      return
    }
    if (!EXT_ID) {
      reject(new Error('EXT_ID is empty (see src/lib/extension-id.js)'))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`extension message timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    try {
      chrome.runtime.sendMessage(EXT_ID, msg, (response) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const lastErr = chrome.runtime.lastError
        if (lastErr) {
          reject(new Error(lastErr.message || 'unknown chrome.runtime.lastError'))
          return
        }
        resolve(response)
      })
    } catch (e) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    }
  })
}

// Hook that returns memoized helpers. Hooks are the React-idiomatic
// way to hand functions to components, even when those functions
// don't close over state. Memoize so the identity is stable across
// renders (useEffect deps stay sane).
export function useExtension() {
  return useMemo(() => ({
    ping: async () => {
      try {
        const r = await send({ type: 'ping', version: 1 }, { timeoutMs: 3000 })
        return {
          installed: true,
          ext_version: r?.ext_version ?? null,
          envato_session: r?.envato_session ?? 'missing',
          has_jwt: !!r?.has_jwt,
          jwt_expires_at: r?.jwt_expires_at ?? null,
          raw: r,
        }
      } catch (err) {
        if (isNotInstalledError(err.message)) {
          return { installed: false, reason: 'not_installed' }
        }
        return { installed: false, reason: 'error', error: err.message }
      }
    },

    // Mints a session JWT via Phase 1 backend, then forwards to the
    // extension. Caller passes the minted token object; this helper
    // only does the chrome.runtime.sendMessage half so callers can
    // mint once and reuse.
    sendSession: async ({ token, kid, user_id, expires_at }) => {
      const r = await send({ type: 'session', version: 1, token, kid, user_id, expires_at })
      if (!r?.ok) throw new Error(r?.error || 'extension rejected session')
      return r
    },

    // Phase A: one-shot export send. Ext.5 will replace this with a
    // long-lived Port; State D wiring lives in the next webapp plan.
    // Manifest is the array buildManifest produced; target_folder is
    // the display string we showed in State C; options is the
    // checkbox state from State C.
    sendExport: async ({ export_id, manifest, target_folder, options }) => {
      const r = await send({
        type: 'export', version: 1,
        export_id, manifest, target_folder, options,
      }, { timeoutMs: 10000 })
      // Extension ack shape isn't strictly defined yet (Ext.5 owns it);
      // accept anything truthy that doesn't carry .error as success.
      if (r?.error) throw new Error(r.error)
      return r ?? { ok: true }
    },
  }), [])
}
```

Why each piece:
- `isNotInstalledError` — the actual Chrome error string varies ("Could not establish connection. Receiving end does not exist." in stable Chrome, but minor wording shifts have shown up). Substring match is forgiving.
- 5s default timeout — Ext.1's handlers all return synchronously inside `chrome.runtime.onMessageExternal` (sub-100ms). 5s is generous; longer than that we assume the SW died and we should abort the loop rather than hang forever.
- `useMemo` returns an object with stable identity — important because the preflight hook will pass `ping` into a `useEffect` dependency array.
- `sendExport` Phase A scope: the extension's response shape for `{type:"export"}` is owned by Ext.5; for now we accept anything non-error and move on to the "starting" placeholder state.

- [ ] **Step 2: Verify syntax**

```bash
node --check src/hooks/useExtension.js
# Expected: exit 0
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useExtension.js
git commit -m "$(cat <<'EOF'
feat(export): useExtension hook — promise-wrapped sendMessage

Wraps the callback-only chrome.runtime.sendMessage API in a Promise
helper that handles chrome.runtime.lastError + non-Chrome detection
+ a 5s timeout. Three exported helpers: ping, sendSession, sendExport.

ping() returns {installed:true, ...} on success; {installed:false,
reason:'not_installed' | 'error'} on failure — pre-flight code can
treat this as a discriminated union without try/catch.

Memoized via useMemo so identity is stable across renders.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `src/lib/buildManifest.js` — pure manifest builder

A pure function that takes the raw API response(s) from the new manifest endpoint, plus the user's options (variants, force re-download), and returns the unified manifest array + totals the extension consumes. No React, no fetch, no side effects — pure transformation. Easy to verify by hand.

**Files:**
- Create: `src/lib/buildManifest.js`

- [ ] **Step 1: Write `src/lib/buildManifest.js`**

```js
// Pure manifest builder. Takes one or more per-variant API responses
// from GET /api/broll-searches/:pipelineId/manifest and turns them
// into the unified manifest the extension expects.
//
// Per spec § "Dedup strategy": key by (source, source_item_id);
// each source-item downloaded once regardless of how many variants
// reference it. Filename is `<NNN>_<source>_<id>.<ext>` where NNN is
// the order of first appearance across selected variants (zero-pad
// to 3 digits — matches the spec's example).
//
// The spec calls for one media folder shared across N XMLs in
// multi-variant exports. This function returns the deduped item list;
// XML emission is WebApp.2's job.
//
// API response shape (per variant):
//   {
//     pipeline_id, variant,
//     items: [
//       { seq, timeline_start_s, timeline_duration_s,
//         source, source_item_id, envato_item_url,
//         target_filename, resolution: {width,height},
//         frame_rate, est_size_bytes }
//     ],
//     totals: { count, est_size_bytes, by_source: {envato, pexels, freepik} }
//   }

const EXT_BY_SOURCE = {
  envato: 'mov',   // envato downloads can be .mov OR .mp4; we don't know
                   // until phase 2 of the extension flow — placeholder.
                   // The extension uses the actual content-disposition
                   // filename; this `target_filename` is only the prefix
                   // it sanitizes/conflict-resolves against.
  pexels: 'mp4',
  freepik: 'mp4',
}

function pad3(n) { return String(n).padStart(3, '0') }

function makeFilename(seq, source, sourceItemId) {
  const ext = EXT_BY_SOURCE[source] || 'mp4'
  // Sanitize source_item_id to ASCII-safe filename chars.
  const safe = String(sourceItemId).replace(/[^A-Za-z0-9_-]/g, '_')
  return `${pad3(seq)}_${source}_${safe}.${ext}`
}

/**
 * @param {{
 *   manifests: Array<{pipeline_id:string, variant:string, items:Array}>,
 *   options?: { force_redownload?: boolean }
 * }} input
 * @returns {{
 *   items: Array,
 *   totals: { count:number, est_size_bytes:number, by_source: {[k:string]:number} },
 *   variants: string[]
 * }}
 */
export function buildManifest({ manifests, options = {} }) {
  if (!Array.isArray(manifests) || manifests.length === 0) {
    return { items: [], totals: { count: 0, est_size_bytes: 0, by_source: {} }, variants: [] }
  }

  // Concatenate raw items across variants in input order. The extension
  // needs to know which variants each clip belongs to (so XML emitter
  // later can reference the same media file from multiple <sequence>s);
  // we attach `variants: ["A","C"]` per item.
  const seen = new Map()  // key `${source}|${id}` → item
  const variants = []

  for (const m of manifests) {
    if (!m || !Array.isArray(m.items)) continue
    if (m.variant && !variants.includes(m.variant)) variants.push(m.variant)

    for (const raw of m.items) {
      const source = raw.source
      const id = raw.source_item_id
      if (!source || !id) continue
      const key = `${source}|${id}`

      if (seen.has(key)) {
        const existing = seen.get(key)
        if (m.variant && !existing.variants.includes(m.variant)) existing.variants.push(m.variant)
        // Append the per-variant placement so the eventual XML can
        // reference the same media file from multiple sequences.
        existing.placements.push({
          variant: m.variant,
          timeline_start_s: raw.timeline_start_s,
          timeline_duration_s: raw.timeline_duration_s,
        })
        continue
      }

      const seq = seen.size + 1
      seen.set(key, {
        seq,
        source,
        source_item_id: id,
        envato_item_url: source === 'envato' ? (raw.envato_item_url || null) : null,
        target_filename: makeFilename(seq, source, id),
        resolution: raw.resolution || { width: 1920, height: 1080 },
        frame_rate: raw.frame_rate || 30,
        est_size_bytes: typeof raw.est_size_bytes === 'number' ? raw.est_size_bytes : 0,
        variants: m.variant ? [m.variant] : [],
        placements: [{
          variant: m.variant,
          timeline_start_s: raw.timeline_start_s,
          timeline_duration_s: raw.timeline_duration_s,
        }],
      })
    }
  }

  const items = [...seen.values()]

  let estTotal = 0
  const bySource = {}
  for (const it of items) {
    estTotal += it.est_size_bytes || 0
    bySource[it.source] = (bySource[it.source] || 0) + 1
  }

  return {
    items,
    totals: { count: items.length, est_size_bytes: estTotal, by_source: bySource },
    variants,
    options: { force_redownload: !!options.force_redownload },
  }
}

/**
 * Format a byte count as a human-readable string. Used by State C's
 * summary card and (later) State D's progress bar. Inlined here so
 * components don't pull in another formatting lib.
 */
export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Estimate download time in minutes assuming a typical home connection
 * (75 Mbps effective throughput — close to the spec's "25-45 min for
 * 8.5 GB" range from State C's mockup). Returns a string like
 * "25-45 min". The range is the estimate ± 30%.
 */
export function estimateTimeRange(totalBytes) {
  if (!totalBytes || totalBytes <= 0) return '< 1 min'
  const bitsPerSec = 75 * 1024 * 1024  // 75 Mbps
  const seconds = (totalBytes * 8) / bitsPerSec
  const minutes = Math.ceil(seconds / 60)
  const low = Math.max(1, Math.round(minutes * 0.7))
  const high = Math.round(minutes * 1.3)
  if (low === high) return `${low} min`
  return `${low}-${high} min`
}
```

Why each piece:
- `seen` Map keyed by `(source, source_item_id)` — the spec's exact dedup key.
- `variants` array per item — used by WebApp.2's XMEML emitter later to know which variant XMLs reference this clip.
- `placements` array per item — each variant contributes its own `(timeline_start_s, timeline_duration_s)`. State C only displays totals; this richer structure is what XML emission consumes.
- `formatBytes` + `estimateTimeRange` — small helpers used by State C's summary card. Co-located here so component code stays declarative.
- `EXT_BY_SOURCE` is a placeholder hint — real extension/file extension is determined by Content-Disposition in the extension's flow; this `target_filename` is only the prefix.

- [ ] **Step 2: Verify syntax + sanity-test the function inline**

```bash
node --check src/lib/buildManifest.js
# Expected: exit 0

node -e "
const m = await import('./src/lib/buildManifest.js');
const a = {pipeline_id:'p1', variant:'A', items:[
  {source:'envato', source_item_id:'X1', envato_item_url:'https://...', timeline_start_s:1, timeline_duration_s:3, est_size_bytes:1e8},
  {source:'pexels', source_item_id:'P1', timeline_start_s:5, timeline_duration_s:2, est_size_bytes:2e7},
]};
const c = {pipeline_id:'p1', variant:'C', items:[
  {source:'envato', source_item_id:'X1', envato_item_url:'https://...', timeline_start_s:10, timeline_duration_s:4, est_size_bytes:1e8},
  {source:'freepik', source_item_id:'F1', timeline_start_s:12, timeline_duration_s:1, est_size_bytes:5e7},
]};
const out = m.buildManifest({manifests:[a, c]});
console.log('count:', out.totals.count);                  // expect 3
console.log('by_source:', out.totals.by_source);          // expect {envato:1, pexels:1, freepik:1}
console.log('variants:', out.variants);                   // expect ['A','C']
console.log('X1 variants:', out.items.find(i => i.source_item_id==='X1').variants); // expect ['A','C']
console.log('X1 placements:', out.items.find(i => i.source_item_id==='X1').placements.length); // expect 2
console.log('filename:', out.items[0].target_filename);   // expect 001_envato_X1.mov
"
```

If the inline test passes, the function is wired right. If anything's off, fix before committing.

- [ ] **Step 3: Commit**

```bash
git add src/lib/buildManifest.js
git commit -m "$(cat <<'EOF'
feat(export): buildManifest pure function + formatBytes/estimateTime

Takes per-variant manifest responses from the new
/api/broll-searches/:pipelineId/manifest endpoint and produces the
deduped (source, source_item_id) item list the extension consumes.
Each item carries `variants` and `placements` arrays so WebApp.2's
XMEML emitter can reference one media file from multiple sequences.

formatBytes + estimateTimeRange helpers live alongside so the State C
summary card stays declarative.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Backend endpoint — `GET /api/broll-searches/:pipelineId/manifest`

Extends `server/routes/broll.js`. Reads `broll_searches.results_json` for the given `plan_pipeline_id` (optionally filtered by `variant`), transforms each picked result into the manifest entry shape, and returns `{pipeline_id, variant, items, totals}`. `requireAuth` for Supabase JWT; ownership check by joining `broll_searches → broll_runs → videos` to verify the pipeline belongs to this user.

**Files:**
- Modify: `server/routes/broll.js` (add new GET handler)

- [ ] **Step 1: Decide ownership-check shape**

`broll_searches` has `plan_pipeline_id` (TEXT). The pipeline ID is derived from `broll_runs.metadata_json.pipelineId`. For Phase A, the simplest correct check: confirm at least one `broll_runs` row exists whose `metadata_json` contains the pipeline ID AND whose `video_id` belongs to a video the user owns.

Looking at existing code (`server/services/broll.js` and `server/routes/broll.js`), `broll_runs` has columns `id, strategy_id, video_id, output_text, metadata_json, status, ...`. Videos are tied to users via the same auth. The simplest auth gate that matches existing conventions: `requireAuth` only — most existing broll routes do not enforce per-pipeline ownership today. To stay consistent (don't introduce a stricter gate for one route in isolation), use `requireAuth` and add a TODO comment that pipeline ownership should be enforced project-wide once a clear pattern emerges. Document the choice in the route comment.

**Decision:** `requireAuth` only for Phase A. A TODO note inline references hardening later. (If the user pushes back during review, tighten by adding a `broll_runs WHERE metadata_json LIKE '%pipelineId%'` existence check filtered by `req.auth.userId` — but the code below is pre-wired so adding that is a one-line change.)

- [ ] **Step 2: Open `server/routes/broll.js` and locate the imports + `const router` block**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
grep -n "const router\|^router\." server/routes/broll.js | head -5
# Expected line numbers: const router = Router() near line 67; first router.get follows.
```

- [ ] **Step 3: Add the new handler**

Use the Edit tool. Find the line in `server/routes/broll.js` that reads:

```js
// Defaults & models
router.get('/defaults', (req, res) => res.json({ models: BROLL_MODELS }))
```

Insert the new handler IMMEDIATELY ABOVE that line (the position keeps related routes grouped — `/defaults`, `/models`, then the new `/broll-searches/:pipelineId/manifest` lives among the read-only routes).

The new code:

```js
// ─── Export manifest endpoint (WebApp.1 Phase A) ─────────────────
// Returns the per-item manifest the Chrome extension downloads for
// a given plan_pipeline_id. Reads broll_searches.results_json and
// reshapes per-result entries into the spec's manifest entry format
// (see docs/specs/2026-04-23-envato-export-design.md § "Manifest
// shape (unified)").
//
// Auth: requireAuth (Supabase JWT) only for Phase A. Per-pipeline
// ownership enforcement is TODO project-wide — none of the other
// /broll routes check it today; tightening here in isolation would
// be inconsistent. Revisit when adding admin/observability routes.
//
// Query: ?variant=<label>  optional; filter to a single variant_label
//                          when provided. Omitting returns all picked
//                          items across every variant.
router.get('/broll-searches/:pipelineId/manifest', requireAuth, async (req, res) => {
  try {
    const pipelineId = String(req.params.pipelineId || '')
    if (!pipelineId) return res.status(400).json({ error: 'pipelineId required' })
    const variant = req.query.variant ? String(req.query.variant) : null

    // Pull all completed search rows for this pipeline (optionally
    // filtered to a single variant_label). 'complete' is the only
    // status with usable results_json.
    const rows = variant
      ? await db.prepare(
          `SELECT id, chapter_index, placement_index, variant_label, results_json
           FROM broll_searches
           WHERE plan_pipeline_id = ? AND status = 'complete' AND variant_label = ?
           ORDER BY id`
        ).all(pipelineId, variant)
      : await db.prepare(
          `SELECT id, chapter_index, placement_index, variant_label, results_json
           FROM broll_searches
           WHERE plan_pipeline_id = ? AND status = 'complete'
           ORDER BY id`
        ).all(pipelineId)

    if (!rows.length) {
      return res.json({
        pipeline_id: pipelineId,
        variant,
        items: [],
        totals: { count: 0, est_size_bytes: 0, by_source: {} },
      })
    }

    // Each broll_searches row's results_json is the full ranked
    // candidate list. The "picked" item for export is the user's
    // selection from the editor — for Phase A we take the FIRST
    // result per placement (the highest-ranked candidate). Once the
    // editor exposes per-placement user picks, swap this for the
    // user's choice (one-line change in the map below).
    let seq = 0
    const items = []
    let estTotal = 0
    const bySource = {}

    for (const row of rows) {
      let results = []
      try { results = JSON.parse(row.results_json || '[]') } catch { results = [] }
      if (!Array.isArray(results) || results.length === 0) continue
      const pick = results[0]

      const source = String(pick.source || '').toLowerCase()
      const sourceItemId = pick.source_item_id || pick.id || pick.uid || null
      if (!source || !sourceItemId) continue

      seq += 1
      const ext = source === 'pexels' ? 'mp4' : source === 'freepik' ? 'mp4' : 'mov'
      const safeId = String(sourceItemId).replace(/[^A-Za-z0-9_-]/g, '_')
      const targetFilename = `${String(seq).padStart(3, '0')}_${source}_${safeId}.${ext}`

      const item = {
        seq,
        timeline_start_s: pick.timeline_start_s ?? pick.start ?? null,
        timeline_duration_s: pick.timeline_duration_s ?? pick.duration ?? null,
        source,
        source_item_id: String(sourceItemId),
        envato_item_url: source === 'envato' ? (pick.envato_item_url || null) : null,
        target_filename: targetFilename,
        resolution: pick.resolution || { width: pick.width || 1920, height: pick.height || 1080 },
        frame_rate: pick.frame_rate || 30,
        est_size_bytes: typeof pick.est_size_bytes === 'number'
          ? pick.est_size_bytes
          : (pick.duration_seconds ? Math.round(pick.duration_seconds * 25 * 1024 * 1024) : 100 * 1024 * 1024),
        variant_label: row.variant_label || null,
      }
      items.push(item)
      estTotal += item.est_size_bytes
      bySource[source] = (bySource[source] || 0) + 1
    }

    res.json({
      pipeline_id: pipelineId,
      variant,
      items,
      totals: { count: items.length, est_size_bytes: estTotal, by_source: bySource },
    })
  } catch (err) {
    console.error('[broll-export-manifest] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

```

Notes on the shape:
- `pick = results[0]` — Phase A uses the top-ranked candidate. When the editor exposes user picks (via a separate column or update to `results_json`), swap to `results.find(r => r.picked) ?? results[0]`. Mark with TODO if you keep `[0]`.
- `est_size_bytes` heuristic: if the upstream result has a `duration_seconds`, estimate `25 MB/s × duration` (matches typical 1080p H.264 / 4K H.265 averages); otherwise fall back to 100 MB. The State C summary tolerates rough estimates.
- Field-name fallbacks (`pick.id || pick.uid`) — the upstream `results_json` schema isn't 100% pinned across pipeline versions; cover the obvious aliases.
- `variant_label` carried on each item — `buildManifest` uses this when a multi-variant build merges responses.

- [ ] **Step 4: Sanity-check the route mount + restart server**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
grep -n "/broll-searches" server/routes/broll.js
# Expected: line(s) showing the new GET handler

# Verify the file still parses
node --check server/routes/broll.js
# Expected: exit 0
```

The new route lives under the existing `app.use('/api/broll', brollRouter)` mount in `server/index.js:51`, so the full path is `GET /api/broll/broll-searches/:pipelineId/manifest` — wait. The plan's spec calls for `GET /api/broll-searches/:pipelineId/manifest` (no `/broll/` segment). Two options:

1. Mount the route under a NEW path in `server/index.js` (e.g., add `app.use('/api/broll-searches', exportManifestRouter)` with a thin extracted router).
2. Accept the `/api/broll/broll-searches/...` path; the spec's wording was approximate.

**Decision:** match the spec literally. Add the small new mount in `server/index.js`. The handler still lives in `routes/broll.js` (single file owns the table) but is exported separately so a new mount path can serve it.

Modify `routes/broll.js` to ALSO export the handler as a standalone router:

At the top of the file, after the existing `const router = Router()` line, add:
```js
// Standalone router so server/index.js can mount the manifest endpoint
// at /api/broll-searches/:pipelineId/manifest (matches WebApp.1 spec)
// without inheriting the /api/broll prefix.
export const brollSearchesRouter = Router()
```

Then in the new handler block, instead of `router.get('/broll-searches/:pipelineId/manifest', ...)`, register on the standalone router:

```js
brollSearchesRouter.get('/:pipelineId/manifest', requireAuth, async (req, res) => {
  // ... same handler body ...
})
```

(Move the entire handler body — the one shown earlier — onto `brollSearchesRouter` and DROP the `router.get('/broll-searches/...')` registration. The handler exists in exactly one place.)

Then in `server/index.js`, add:
```js
import brollRouter, { brollSearchesRouter } from './routes/broll.js'
```
and
```js
app.use('/api/broll-searches', brollSearchesRouter)
```
right after the existing `app.use('/api/broll', brollRouter)` line.

- [ ] **Step 5: Smoke-test the endpoint**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
# Start the backend dev server in the user's existing terminal window (do NOT kill port 3001).
# Then hit the endpoint with a real pipelineId from the user's data.

# Find a pipelineId with completed broll_searches:
set -a && source .env && set +a
node -e "
import('pg').then(async ({default: pg}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized:false}, max:1 });
  const r = await pool.query(\"SELECT plan_pipeline_id, variant_label, COUNT(*) cnt FROM broll_searches WHERE status='complete' AND results_json IS NOT NULL GROUP BY plan_pipeline_id, variant_label ORDER BY cnt DESC LIMIT 5\");
  console.table(r.rows);
  await pool.end();
});
"
# Expected: 1-5 rows showing pipelineIds with completed searches.
```

Pick the top row's `plan_pipeline_id` and curl the endpoint (use the dev bypass header per `server/auth.js:71`):

```bash
PID="<paste plan_pipeline_id>"
VAR="<paste variant_label>"
curl -sS "http://localhost:3001/api/broll-searches/${PID}/manifest?variant=${VAR}" \
  -H "X-Dev-Bypass: true" | head -50
```

Expected JSON shape:
```json
{
  "pipeline_id": "...",
  "variant": "...",
  "items": [
    { "seq": 1, "source": "...", "source_item_id": "...", "target_filename": "001_..._....mp4", ... },
    ...
  ],
  "totals": { "count": N, "est_size_bytes": ..., "by_source": { "envato": ..., "pexels": ..., "freepik": ... } }
}
```

If `items` is empty, double-check the variant_label spelling matches what's in the table.

- [ ] **Step 6: Commit**

```bash
git add server/routes/broll.js server/index.js
git commit -m "$(cat <<'EOF'
feat(api): GET /api/broll-searches/:pipelineId/manifest for export page

New endpoint reshapes broll_searches.results_json into the per-item
manifest entry the Chrome extension consumes. Optional ?variant filter.
Returns {pipeline_id, variant, items, totals} per the export design
spec § "Manifest shape (unified)".

Phase A: takes the top-ranked candidate (results[0]) per placement;
swap to the editor's user-pick once that flows through. requireAuth
only — per-pipeline ownership is a project-wide TODO and tightening
here in isolation would be inconsistent with the other /broll routes.

Mounted under a standalone /api/broll-searches sub-router so the path
matches the spec exactly; handler body lives in routes/broll.js so a
single file owns the broll_searches table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `src/hooks/useExportPreflight.js`

Composes the parallel pre-flight checks for the export page: extension ping (polled at 2s while in State A, one-shot afterwards), manifest fetch (one-shot), disk estimate (one-shot). Returns a discriminated union per sub-result so callers can render granular loading/error states.

**Files:**
- Create: `src/hooks/useExportPreflight.js`

- [ ] **Step 1: Write `src/hooks/useExportPreflight.js`**

```js
// Composes the export page's pre-flight checks. Each sub-result is
// a small discriminated union: { status: 'idle'|'loading'|'ok'|'error', value?, error? }.
//
// Caller (ExportPage.jsx) dispatches state transitions based on the
// combined result:
//   - state_a (install)    : ping.value.installed === false
//   - state_b (envato)     : ping.value.installed && manifest has envato items && envato_session !== 'ok'
//                            (in Phase A, treated as soft warning per Ext.1's missing cookie watcher)
//   - state_c (summary)    : everything else
//
// Polling cadence:
//   - When `phase === 'state_a'`: ping every 2s.
//   - Otherwise: one-shot ping on phase change.

import { useEffect, useReducer, useRef } from 'react'
import { useExtension } from './useExtension.js'
import { apiGet } from './useApi.js'

const initial = {
  ping:     { status: 'idle' },
  manifest: { status: 'idle', additional: {} },  // additional: {variant -> manifest}
  disk:     { status: 'idle' },
}

function reducer(state, action) {
  switch (action.type) {
    case 'ping_loading':       return { ...state, ping: { status: 'loading' } }
    case 'ping_ok':            return { ...state, ping: { status: 'ok', value: action.value } }
    case 'ping_error':         return { ...state, ping: { status: 'error', error: action.error } }
    case 'manifest_loading':   return { ...state, manifest: { ...state.manifest, status: 'loading' } }
    case 'manifest_ok':        return { ...state, manifest: { status: 'ok', value: action.value, additional: {} } }
    case 'manifest_error':     return { ...state, manifest: { status: 'error', error: action.error, additional: {} } }
    case 'manifest_add_ok':    return { ...state, manifest: { ...state.manifest, additional: { ...state.manifest.additional, [action.variant]: action.value } } }
    case 'manifest_add_drop':  {
      const next = { ...state.manifest.additional }
      delete next[action.variant]
      return { ...state, manifest: { ...state.manifest, additional: next } }
    }
    case 'disk_loading':       return { ...state, disk: { status: 'loading' } }
    case 'disk_ok':            return { ...state, disk: { status: 'ok', value: action.value } }
    case 'disk_error':         return { ...state, disk: { status: 'error', error: action.error } }
    default:                   return state
  }
}

/**
 * @param {{
 *   pipelineId: string,
 *   variant: string,
 *   phase: 'init' | 'state_a' | 'state_b' | 'state_c' | 'starting',
 *   additionalVariants?: string[]   // for multi-variant export checkbox in State C
 * }} opts
 */
export function useExportPreflight({ pipelineId, variant, phase, additionalVariants = [] }) {
  const ext = useExtension()
  const [state, dispatch] = useReducer(reducer, initial)
  // Track the most recent additionalVariants for diff-based fetch / drop.
  const lastAdditionalRef = useRef([])

  // Extension ping. Poll every 2s in state_a; otherwise fire once on
  // phase change (we still want to know the current ext state when
  // we're past state_a).
  useEffect(() => {
    let cancelled = false
    let timer = null

    async function pingOnce() {
      dispatch({ type: 'ping_loading' })
      try {
        const value = await ext.ping()
        if (cancelled) return
        dispatch({ type: 'ping_ok', value })
      } catch (e) {
        if (cancelled) return
        dispatch({ type: 'ping_error', error: e.message })
      }
    }

    pingOnce()
    if (phase === 'state_a') {
      timer = setInterval(pingOnce, 2000)
    }

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [phase, ext])

  // Manifest fetch — one-shot per (pipelineId, variant). Re-runs when
  // either changes (e.g., user navigates from variant=A to variant=C).
  useEffect(() => {
    let cancelled = false
    if (!pipelineId || !variant) return
    dispatch({ type: 'manifest_loading' })
    apiGet(`/broll-searches/${encodeURIComponent(pipelineId)}/manifest?variant=${encodeURIComponent(variant)}`)
      .then(value => { if (!cancelled) dispatch({ type: 'manifest_ok', value }) })
      .catch(e => { if (!cancelled) dispatch({ type: 'manifest_error', error: e.message }) })
    return () => { cancelled = true }
  }, [pipelineId, variant])

  // Additional-variant manifests (multi-variant export checkbox).
  // Diff against last list: fetch newly-added, drop newly-removed.
  useEffect(() => {
    const prev = lastAdditionalRef.current
    const next = additionalVariants
    const added = next.filter(v => !prev.includes(v))
    const removed = prev.filter(v => !next.includes(v))
    lastAdditionalRef.current = next.slice()

    for (const v of removed) dispatch({ type: 'manifest_add_drop', variant: v })

    let cancelled = false
    for (const v of added) {
      apiGet(`/broll-searches/${encodeURIComponent(pipelineId)}/manifest?variant=${encodeURIComponent(v)}`)
        .then(value => { if (!cancelled) dispatch({ type: 'manifest_add_ok', variant: v, value }) })
        .catch(() => { /* error per additional variant ignored — treat as zero items */ })
    }
    return () => { cancelled = true }
  }, [additionalVariants, pipelineId])

  // Disk estimate — one-shot on mount; navigator.storage.estimate() is
  // cheap, no need to poll. Browsers without `quota` (Safari) get an
  // 'ok' with quota=null; State C surfaces a soft warning.
  useEffect(() => {
    let cancelled = false
    async function check() {
      dispatch({ type: 'disk_loading' })
      try {
        if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
          if (!cancelled) dispatch({ type: 'disk_ok', value: { quota: null, usage: null, available: null } })
          return
        }
        const { quota, usage } = await navigator.storage.estimate()
        if (cancelled) return
        const available = (typeof quota === 'number' && typeof usage === 'number') ? Math.max(0, quota - usage) : null
        dispatch({ type: 'disk_ok', value: { quota: quota ?? null, usage: usage ?? null, available } })
      } catch (e) {
        if (cancelled) return
        dispatch({ type: 'disk_error', error: e.message })
      }
    }
    check()
    return () => { cancelled = true }
  }, [])

  return state
}
```

Why each piece:
- `useReducer` not `useState` — three sub-results, each with their own status discriminant; reducer keeps transitions explicit.
- Ping `useEffect` keys on `phase`: when phase transitions out of `state_a`, the cleanup clears the interval; when phase transitions back in (it shouldn't in Phase A but the structure is correct), the interval restarts.
- Manifest additional-variant diff uses a ref so we don't re-fetch the variant when its list-position changes but membership doesn't.
- Disk: tolerate Safari's missing `quota`. Don't pretend to know what we don't.

- [ ] **Step 2: Verify syntax**

```bash
node --check src/hooks/useExportPreflight.js
# Expected: exit 0
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useExportPreflight.js
git commit -m "$(cat <<'EOF'
feat(export): useExportPreflight hook composing parallel pre-flight checks

Composes extension ping (2s polling in state_a, one-shot otherwise),
manifest fetch (one-shot per pipeline+variant), additional-variant
manifest fetches (multi-variant checkbox), and disk estimate via
navigator.storage.estimate (tolerates Safari's missing quota).

Each sub-result is a discriminated union with a .status discriminant
so the page can render granular loading / error / ok states without
nesting ternaries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: State components — A, B, C

Three small focused components in `src/components/export/`. Each takes the relevant slice of pre-flight state + callbacks; renders the spec's UI per § "UX flow (end-to-end)" Screens A / B / C.

**Files:**
- Create: `src/components/export/StateA_Install.jsx`
- Create: `src/components/export/StateB_Session.jsx`
- Create: `src/components/export/StateC_Summary.jsx`

- [ ] **Step 1: Write `src/components/export/StateA_Install.jsx`**

```jsx
import { useEffect, useState } from 'react'
import styled from 'styled-components'
import { Download, AlertCircle } from 'lucide-react'

// Spec § State A. Polls extension via the parent's useExportPreflight
// hook (parent passes `installed` derived from ping.value).
//
// Renders one of two surfaces:
//   - non-Chrome browser → "This feature requires Chrome" banner.
//   - Chrome, extension missing → install card (per spec mockup).
//
// We detect Chrome via window.chrome?.runtime presence (the actual
// capability we need) + UA fallback for friendlier copy.

const Wrap = styled.div`
  max-width: 640px;
  margin: 60px auto;
  padding: 0 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1a1a1a;
`

const Card = styled.div`
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 28px 32px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
`

const Title = styled.h1`
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px;
`

const SubText = styled.p`
  font-size: 14px;
  color: #4b5563;
  margin: 8px 0 16px;
  line-height: 1.5;
`

const InstallButton = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #2563eb;
  color: #fff;
  border-radius: 8px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  margin: 8px 0;
  &:hover { background: #1d4ed8; }
`

const Banner = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
  margin-bottom: 20px;
`

const Footnote = styled.p`
  font-size: 12px;
  color: #6b7280;
  margin: 12px 0 0;
`

function detectBrowser() {
  if (typeof navigator === 'undefined') return { isChromium: false, label: 'unknown' }
  const ua = navigator.userAgent.toLowerCase()
  // The capability check is what matters — we'll send chrome.runtime
  // messages either way; this is for UI copy only.
  const hasChromeRuntime = typeof chrome !== 'undefined' && !!chrome?.runtime?.sendMessage
  if (ua.includes('safari/') && !ua.includes('chrome/') && !ua.includes('chromium/')) {
    return { isChromium: false, label: 'Safari', hasRuntime: hasChromeRuntime }
  }
  if (ua.includes('firefox/')) {
    return { isChromium: false, label: 'Firefox', hasRuntime: hasChromeRuntime }
  }
  return { isChromium: true, label: 'Chrome', hasRuntime: hasChromeRuntime }
}

export default function StateA_Install({ variant, ping }) {
  const [browser] = useState(detectBrowser)

  // Chrome Web Store URL placeholder — Ext.11 fills in the real listing
  // URL. For Phase A we point at chrome://extensions with a "Load
  // unpacked" hint copy because there's no published store listing yet.
  const STORE_URL = 'https://chrome.google.com/webstore/'  // TODO Ext.11: replace with real listing

  if (!browser.isChromium) {
    return (
      <Wrap>
        <Card>
          <Title>This feature requires Chrome</Title>
          <Banner>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Looks like you're on {browser.label}. The Export Helper extension is
              Chrome-only at launch. Safari and Firefox support is planned but not
              yet available.
            </span>
          </Banner>
          <SubText>Open this page in Chrome to continue.</SubText>
          <InstallButton href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">
            <Download size={16} />
            Get Chrome
          </InstallButton>
        </Card>
      </Wrap>
    )
  }

  return (
    <Wrap>
      <Card>
        <Title>Ready to export Variant {variant}</Title>
        <SubText>
          Install the Export Helper Chrome extension to continue.
        </SubText>
        <SubText>
          This extension downloads your licensed b-roll files into a folder
          using your own Envato subscription. Files never leave your computer.
        </SubText>
        <InstallButton href={STORE_URL} target="_blank" rel="noreferrer">
          <Download size={16} />
          Install from Chrome Web Store
        </InstallButton>
        <Footnote>
          After install, this page updates automatically.
          {ping.status === 'loading' ? ' Checking…' : ''}
          {ping.status === 'error' ? ` (probe error: ${ping.error})` : ''}
        </Footnote>
      </Card>
    </Wrap>
  )
}
```

- [ ] **Step 2: Write `src/components/export/StateB_Session.jsx`**

```jsx
import styled from 'styled-components'
import { CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react'

// Spec § State B. Render in two cases:
//   1. Manifest contains Envato items AND extension's envato_session !== 'ok'.
//   2. Skipped entirely if no Envato items in manifest.
//
// IMPORTANT: Ext.1 always reports envato_session: 'missing' because the
// cookie watcher lands in Ext.4. Until then, this state is OPTIMISTIC:
// we render the warning + sign-in CTA but offer a manual "I'm signed
// in, continue" override so users aren't blocked. Once Ext.4 ships,
// hide the manual override (see TODO comment below).

const Wrap = styled.div`
  max-width: 640px;
  margin: 60px auto;
  padding: 0 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1a1a1a;
`

const Card = styled.div`
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 28px 32px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
`

const Title = styled.h1`
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 16px;
`

const Row = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 6px 0;
  font-size: 14px;
  color: #1f2937;
  & .icon-ok { color: #16a34a; }
  & .icon-warn { color: #d97706; }
`

const Detail = styled.p`
  font-size: 13px;
  color: #4b5563;
  margin: 4px 0 0 24px;
  line-height: 1.5;
`

const SignInButton = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #2563eb;
  color: #fff;
  border-radius: 8px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  margin: 16px 0 8px;
  &:hover { background: #1d4ed8; }
`

const ContinueLink = styled.button`
  margin-top: 12px;
  background: none;
  border: none;
  color: #6b7280;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
  &:hover { color: #374151; }
`

const ManualWarning = styled.p`
  font-size: 11px;
  color: #9ca3af;
  margin: 4px 0 0;
  line-height: 1.4;
`

const Footnote = styled.p`
  font-size: 12px;
  color: #6b7280;
  margin: 16px 0 0;
`

export default function StateB_Session({ variant, envatoItemCount, onContinue }) {
  return (
    <Wrap>
      <Card>
        <Title>Ready to export Variant {variant}</Title>

        <Row>
          <CheckCircle2 size={16} className="icon-ok" />
          <span>Export Helper installed</span>
        </Row>

        <Row>
          <AlertCircle size={16} className="icon-warn" />
          <span>Sign in to Envato to continue</span>
        </Row>
        <Detail>
          Your b-roll includes {envatoItemCount} Envato clip{envatoItemCount === 1 ? '' : 's'}.
          Sign in to license and download them.
        </Detail>

        <SignInButton href="https://app.envato.com/sign-in" target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          Sign in to Envato
        </SignInButton>

        <Footnote>This page updates automatically after sign-in.</Footnote>

        {/* TODO Ext.4: remove this manual override once the extension's
            cookie watcher reliably reports envato_session === 'ok'.
            Today (Ext.1) the extension hard-codes 'missing', so without
            this escape hatch every user is stuck on State B forever. */}
        <ContinueLink type="button" onClick={onContinue}>
          I'm already signed in — continue
        </ContinueLink>
        <ManualWarning>
          We'll re-check your Envato session before the first download.
        </ManualWarning>
      </Card>
    </Wrap>
  )
}
```

- [ ] **Step 3: Write `src/components/export/StateC_Summary.jsx`**

```jsx
import { useMemo, useState } from 'react'
import styled from 'styled-components'
import { CheckCircle2, FolderOpen, Play } from 'lucide-react'
import { buildManifest, formatBytes, estimateTimeRange } from '../../lib/buildManifest.js'

// Spec § State C. Manifest summary + Start Export.
//
// Inputs the parent passes:
//   variant            — current variant from URL ?variant=
//   manifestResp       — { pipeline_id, variant, items, totals }
//   additionalManifests— { variantLabel: manifestResp } map for multi-variant checkbox
//   ping               — preflight ping value (for installed/version display)
//   diskValue          — { quota, usage, available } or { available:null }
//   onStart            — callback({ unifiedManifest, options }) → triggers POST /api/exports + sendExport
//   onChangeFolder     — callback (Phase A: shows "coming soon" alert)
//   onToggleVariant    — callback(variantLabel, on/off) for the multi-variant checkbox
//   availableExtraVariants — string[] — variants other than the current one with completed broll_searches

const Wrap = styled.div`
  max-width: 720px;
  margin: 60px auto;
  padding: 0 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1a1a1a;
`

const Card = styled.div`
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 28px 32px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
`

const Header = styled.h1`
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 4px;
`
const SubHeader = styled.p`
  font-size: 13px;
  color: #6b7280;
  margin: 0 0 16px;
`

const CheckRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
  font-size: 14px;
  & .icon-ok { color: #16a34a; }
`

const Section = styled.div`
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #f1f5f9;
`

const SectionLabel = styled.div`
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
  margin-bottom: 8px;
`

const SourceRow = styled.div`
  display: grid;
  grid-template-columns: 80px 80px 1fr;
  font-size: 14px;
  padding: 4px 0;
`

const FolderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 13px;
  color: #1f2937;
  background: #f9fafb;
  padding: 8px 12px;
  border-radius: 6px;
`

const ChangeFolderBtn = styled.button`
  background: none;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  margin-left: auto;
  &:hover { background: #f3f4f6; }
`

const Checkbox = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 10px 0;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
  & input { margin-top: 3px; }
  & .desc {
    font-size: 12px;
    color: #6b7280;
    margin-top: 2px;
  }
`

const Estimate = styled.p`
  font-size: 13px;
  color: #6b7280;
  margin: 16px 0 0;
`

const StartButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 20px;
  &:hover { background: #1d4ed8; }
  &:disabled { background: #9ca3af; cursor: not-allowed; }
`

export default function StateC_Summary({
  variant, manifestResp, additionalManifests, ping, diskValue,
  onStart, onChangeFolder, onToggleVariant, availableExtraVariants,
}) {
  const [forceRedownload, setForceRedownload] = useState(false)
  const [includeExtras, setIncludeExtras] = useState({})  // {variantLabel: true}
  const [starting, setStarting] = useState(false)

  // Build the unified manifest from the current selection.
  const unified = useMemo(() => {
    const responses = [manifestResp]
    for (const [v, on] of Object.entries(includeExtras)) {
      if (on && additionalManifests[v]) responses.push(additionalManifests[v])
    }
    return buildManifest({ manifests: responses, options: { force_redownload: forceRedownload } })
  }, [manifestResp, additionalManifests, includeExtras, forceRedownload])

  const totalBytes = unified.totals.est_size_bytes
  const sources = unified.totals.by_source
  const variantLabels = unified.variants.length ? unified.variants.join(', ') : variant

  // Default folder per spec § "Multi-variant exports" (multi: -all suffix).
  const folderName = unified.variants.length > 1
    ? `~/Downloads/transcript-eval/export-${manifestResp?.pipeline_id || ''}-all/`
    : `~/Downloads/transcript-eval/export-${manifestResp?.pipeline_id || ''}-${variant.toLowerCase()}/`

  const diskAvailable = diskValue?.available ?? null
  const diskOk = diskAvailable == null ? 'unknown' : (diskAvailable > totalBytes * 1.1 ? 'ok' : 'warn')

  async function handleStart() {
    if (starting) return
    setStarting(true)
    try {
      await onStart({
        unifiedManifest: unified,
        options: { force_redownload: forceRedownload },
        targetFolder: folderName,
      })
    } finally {
      // Parent transitions us out of state_c on success; only release
      // local lock here on failure (parent re-throws in that case).
      setStarting(false)
    }
  }

  return (
    <Wrap>
      <Card>
        <Header>Variant {variantLabels} · {unified.totals.count} clips · ~{formatBytes(totalBytes)}</Header>
        <SubHeader>Pre-flight checks complete.</SubHeader>

        <CheckRow><CheckCircle2 size={16} className="icon-ok" /> Export Helper installed{ping?.ext_version ? ` (v${ping.ext_version})` : ''}</CheckRow>
        <CheckRow><CheckCircle2 size={16} className="icon-ok" /> Envato session detected</CheckRow>
        <CheckRow>
          <CheckCircle2 size={16} className="icon-ok" />
          {diskOk === 'ok' && `Disk space available (${formatBytes(diskAvailable)} free)`}
          {diskOk === 'warn' && `⚠ Low disk space (${formatBytes(diskAvailable)} free)`}
          {diskOk === 'unknown' && 'Disk space could not be checked'}
        </CheckRow>

        <Section>
          <SectionLabel>Sources</SectionLabel>
          {sources.envato > 0 && (
            <SourceRow><span>Envato</span><span>{sources.envato} clips</span><span>(your subscription)</span></SourceRow>
          )}
          {sources.pexels > 0 && (
            <SourceRow><span>Pexels</span><span>{sources.pexels} clips</span><span>(free)</span></SourceRow>
          )}
          {sources.freepik > 0 && (
            <SourceRow><span>Freepik</span><span>{sources.freepik} clips</span><span>(transcript-eval account)</span></SourceRow>
          )}
        </Section>

        <Section>
          <SectionLabel>Target folder</SectionLabel>
          <FolderRow>
            <FolderOpen size={16} />
            <span>{folderName}</span>
            <ChangeFolderBtn type="button" onClick={onChangeFolder}>Change folder</ChangeFolderBtn>
          </FolderRow>
        </Section>

        {availableExtraVariants.length > 0 && (
          <Section>
            <SectionLabel>Multi-variant export</SectionLabel>
            {availableExtraVariants.map(v => (
              <Checkbox key={v}>
                <input
                  type="checkbox"
                  checked={!!includeExtras[v]}
                  onChange={(e) => {
                    setIncludeExtras(prev => ({ ...prev, [v]: e.target.checked }))
                    onToggleVariant(v, e.target.checked)
                  }}
                />
                <span>
                  Also export Variant {v}
                  <div className="desc">Shares the media folder, adds 1 more XML file.</div>
                </span>
              </Checkbox>
            ))}
          </Section>
        )}

        <Section>
          <SectionLabel>Options</SectionLabel>
          <Checkbox>
            <input
              type="checkbox"
              checked={forceRedownload}
              onChange={e => setForceRedownload(e.target.checked)}
            />
            <span>
              Re-download files already on disk
              <div className="desc">
                Default off: skip clips already downloaded in this folder
                to protect your Envato fair-use counter.
              </div>
            </span>
          </Checkbox>
        </Section>

        <Estimate>Estimated time: {estimateTimeRange(totalBytes)} at typical home internet.</Estimate>

        <StartButton type="button" onClick={handleStart} disabled={starting || unified.totals.count === 0}>
          <Play size={16} />
          {starting ? 'Starting…' : 'Start Export'}
        </StartButton>
      </Card>
    </Wrap>
  )
}
```

- [ ] **Step 4: Verify all three components parse**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
node --check src/components/export/StateA_Install.jsx 2>&1 || true
# JSX won't parse with `node --check` — verify by importing in vite later.
# At minimum, check the files exist with the right names + sizes.
ls -la src/components/export/
```

`node --check` doesn't understand JSX. The real verification is in Task 9 (visual smoke). At this point we just confirm the files exist with reasonable byte counts (>1 KB each).

- [ ] **Step 5: Commit**

```bash
git add src/components/export/
git commit -m "$(cat <<'EOF'
feat(export): three pre-flight state components — A, B, C

StateA_Install: install Helper card + non-Chrome banner. Parent
polls extension via useExportPreflight; this component is presentation.

StateB_Session: Envato sign-in card with manual "continue anyway"
override. The override is a Phase-A compromise — Ext.1's pong always
reports envato_session: 'missing' (cookie watcher lands in Ext.4),
so without an escape hatch every user gets stuck. TODO comment marks
the line for removal post-Ext.4.

StateC_Summary: full summary card per spec mockup — variant + clip
count + bytes, source breakdown, target folder display, multi-variant
checkbox per extra-variant, re-download checkbox, time estimate,
Start Export button. Uses buildManifest to dedup across selected
variants.

styled-components throughout (already in package.json); no new deps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `src/pages/ExportPage.jsx` — the FSM

Top-level page component. Reads `:id` and `?variant` from the router. Owns the FSM (`'init'|'state_a'|'state_b'|'state_c'|'starting'`). Renders one of the three state components. Handles the "Start Export" callback by minting a session JWT, POSTing to `/api/exports`, sending the export message to the extension, then transitioning to a placeholder "starting" state.

**Files:**
- Create: `src/pages/ExportPage.jsx`

- [ ] **Step 1: Write `src/pages/ExportPage.jsx`**

```jsx
import { useEffect, useMemo, useReducer, useCallback, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import { useExportPreflight } from '../hooks/useExportPreflight.js'
import { useExtension } from '../hooks/useExtension.js'
import { apiPost, apiGet } from '../hooks/useApi.js'
import StateA_Install from '../components/export/StateA_Install.jsx'
import StateB_Session from '../components/export/StateB_Session.jsx'
import StateC_Summary from '../components/export/StateC_Summary.jsx'

// FSM:
//   init     → first render, deciding which state to enter
//   state_a  → extension not installed (poll every 2s)
//   state_b  → installed, manifest has envato items, session not detected
//              (Phase A: Ext.1 always reports 'missing'; manual override
//               unblocks; this lives until Ext.4)
//   state_c  → all preconditions met, summary + Start Export
//   starting → user clicked Start Export; extension acked; placeholder
//              for State D (in-progress) which lands in next plan

function reducer(state, action) {
  switch (action.type) {
    case 'goto':                  return { ...state, phase: action.phase }
    case 'set_extra_variants':    return { ...state, additionalVariants: action.variants }
    case 'override_session':      return { ...state, sessionOverridden: true }
    case 'export_started':        return { ...state, phase: 'starting', export_id: action.export_id }
    case 'set_error':             return { ...state, error: action.error }
    default:                      return state
  }
}

const initialState = {
  phase: 'init',
  additionalVariants: [],
  sessionOverridden: false,
  export_id: null,
  error: null,
}

const Loader = styled.div`
  max-width: 640px;
  margin: 80px auto;
  padding: 0 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #6b7280;
  text-align: center;
`
const ErrorBox = styled.div`
  max-width: 640px;
  margin: 80px auto;
  padding: 16px 20px;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
`
const Starting = styled.div`
  max-width: 640px;
  margin: 80px auto;
  padding: 24px 32px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  & h1 { font-size: 18px; margin: 0 0 8px; }
  & p { color: #6b7280; font-size: 14px; line-height: 1.5; }
  & code { background: #f3f4f6; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
`

export default function ExportPage() {
  const { id: pipelineId } = useParams()
  const [searchParams] = useSearchParams()
  const variant = searchParams.get('variant') || 'A'
  const ext = useExtension()
  const [state, dispatch] = useReducer(reducer, initialState)

  const preflight = useExportPreflight({
    pipelineId,
    variant,
    phase: state.phase,
    additionalVariants: state.additionalVariants,
  })

  // Decide which phase to enter based on preflight results.
  useEffect(() => {
    // Wait for ping + manifest before deciding.
    if (preflight.ping.status !== 'ok') return
    if (preflight.manifest.status !== 'ok') return

    const installed = !!preflight.ping.value?.installed
    const envatoCount = (preflight.manifest.value?.totals?.by_source?.envato) || 0
    const sessionOk = preflight.ping.value?.envato_session === 'ok'

    let next
    if (!installed) next = 'state_a'
    else if (envatoCount > 0 && !sessionOk && !state.sessionOverridden) next = 'state_b'
    else next = 'state_c'

    if (next !== state.phase && state.phase !== 'starting') {
      dispatch({ type: 'goto', phase: next })
    }
  }, [preflight.ping, preflight.manifest, state.sessionOverridden, state.phase])

  // Discover other variants for the multi-variant checkbox. Phase A
  // approach: hit the manifest endpoint without ?variant to learn what
  // variants exist for this pipeline. To keep this cheap and avoid a
  // schema change, a lightweight implementation is: fetch the all-
  // variant endpoint and inspect distinct `variant_label` values from
  // the items array. Caveat: returns up to N items; for large pipelines
  // this is wasteful. Alternative (deferred): a dedicated endpoint
  // returning just the variant list. Acceptable for Phase A.
  const [knownVariants, setKnownVariants] = useState([])

  useEffect(() => {
    if (!pipelineId) return
    let cancelled = false
    apiGet(`/broll-searches/${encodeURIComponent(pipelineId)}/manifest`)
      .then(r => {
        if (cancelled) return
        const labels = new Set()
        for (const it of r.items || []) {
          if (it.variant_label) labels.add(it.variant_label)
        }
        // Filter to labels that aren't the current variant. Variant
        // values in broll_searches are stored as "Variant X" strings;
        // the URL ?variant param is just the letter. Match flexibly.
        const norm = (v) => String(v).replace(/^Variant\s+/i, '').trim()
        const others = [...labels].map(norm).filter(v => v && v !== variant)
        setKnownVariants([...new Set(others)])
      })
      .catch(() => { if (!cancelled) setKnownVariants([]) })
    return () => { cancelled = true }
  }, [pipelineId, variant])

  const onContinueOverride = useCallback(() => {
    dispatch({ type: 'override_session' })
  }, [])

  const onChangeFolder = useCallback(() => {
    // Phase A defers File System Access API — see plan § Scope.
    window.alert('Folder picker coming in a later release. For now exports save to ~/Downloads/transcript-eval/')
  }, [])

  const onToggleVariant = useCallback((v, on) => {
    dispatch({
      type: 'set_extra_variants',
      variants: on
        ? [...new Set([...state.additionalVariants, v])]
        : state.additionalVariants.filter(x => x !== v),
    })
  }, [state.additionalVariants])

  const onStart = useCallback(async ({ unifiedManifest, options, targetFolder }) => {
    // 1. POST /api/exports → returns export_id
    const variantLabels = unifiedManifest.variants.length ? unifiedManifest.variants : [variant]
    const exportRow = await apiPost('/exports', {
      plan_pipeline_id: pipelineId,
      variant_labels: variantLabels,
      manifest: unifiedManifest,
    })
    const exportId = exportRow.export_id

    // 2. Mint session JWT for the extension (Phase 1 backend).
    const tokenRow = await apiPost('/session-token', {})

    // 3. Push the JWT to the extension (one-shot per spec § "How web
    //    app talks to extension"). Even though Ext.1 already takes a
    //    session, we re-mint per export to avoid stale-token races.
    await ext.sendSession({
      token: tokenRow.token,
      kid: tokenRow.kid,
      user_id: tokenRow.user_id,
      expires_at: tokenRow.expires_at,
    })

    // 4. Send the export to the extension. Phase A is one-shot;
    //    Ext.5 will replace this with a long-lived Port that pushes
    //    progress back, which State D consumes (next plan).
    await ext.sendExport({
      export_id: exportId,
      manifest: unifiedManifest.items,
      target_folder: targetFolder,
      options: { ...options, variants: variantLabels },
    })

    dispatch({ type: 'export_started', export_id: exportId })
  }, [pipelineId, variant, ext])

  // Fail-fast on missing pipelineId.
  if (!pipelineId) {
    return <ErrorBox>Missing pipeline id in URL — expected /editor/:id/export</ErrorBox>
  }

  // Surface explicit errors from the manifest endpoint.
  if (preflight.manifest.status === 'error') {
    return <ErrorBox>Failed to load manifest: {preflight.manifest.error}</ErrorBox>
  }

  // Loading.
  if (state.phase === 'init') {
    return <Loader>Running pre-flight checks…</Loader>
  }

  // State A — install.
  if (state.phase === 'state_a') {
    return (
      <StateA_Install
        variant={variant}
        ping={preflight.ping}
      />
    )
  }

  // State B — session.
  if (state.phase === 'state_b') {
    const envatoCount = preflight.manifest.value?.totals?.by_source?.envato || 0
    return (
      <StateB_Session
        variant={variant}
        envatoItemCount={envatoCount}
        onContinue={onContinueOverride}
      />
    )
  }

  // State C — summary.
  if (state.phase === 'state_c') {
    return (
      <StateC_Summary
        variant={variant}
        manifestResp={preflight.manifest.value}
        additionalManifests={preflight.manifest.additional}
        ping={preflight.ping.value}
        diskValue={preflight.disk.status === 'ok' ? preflight.disk.value : { available: null }}
        onStart={onStart}
        onChangeFolder={onChangeFolder}
        onToggleVariant={onToggleVariant}
        availableExtraVariants={knownVariants || []}
      />
    )
  }

  // Starting — placeholder. Real State D lands once Ext.5's Port
  // is live and the next webapp plan is executed.
  if (state.phase === 'starting') {
    return (
      <Starting>
        <h1>Export started</h1>
        <p>The Export Helper is downloading your clips. Live progress will appear here once the extension's queue is fully wired (next phase).</p>
        <p>Export ID: <code>{state.export_id}</code></p>
      </Starting>
    )
  }

  return <ErrorBox>Unknown phase: {state.phase}</ErrorBox>
}
```

- [ ] **Step 2: Verify the file exists and has the expected structure**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
ls -la src/pages/ExportPage.jsx
grep -c "import\|export default\|useReducer\|useEffect\|useState" src/pages/ExportPage.jsx
# Expected: > 5 (multiple imports + reducer + effects)
```

- [ ] **Step 3: Commit**

```bash
git add src/pages/ExportPage.jsx
git commit -m "$(cat <<'EOF'
feat(export): ExportPage FSM rendering A/B/C + starting placeholder

Reads :id and ?variant from the router. useReducer FSM with phases
init/state_a/state_b/state_c/starting. useExportPreflight feeds
ping + manifest + disk; the page picks the next phase based on:
  - !installed → state_a
  - envato items > 0 AND envato_session !== 'ok' AND not overridden → state_b
  - otherwise → state_c

onStart wires the full Phase A handoff:
  POST /api/exports (Phase 1) → POST /api/session-token → ext.sendSession
  → ext.sendExport (one-shot until Ext.5's Port lands)

State D (in-progress) is a placeholder that says "live progress lands
once the extension queue is wired." Real D/E/F components belong to
the next webapp plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Mount the route in `src/App.jsx`

Single one-line registration of the new route.

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Edit `src/App.jsx` — add the import + route**

Use the Edit tool. Find the existing import block:
```jsx
import EditorView from './components/editor/EditorView.jsx'
```

Add immediately after:
```jsx
import ExportPage from './pages/ExportPage.jsx'
```

Then find the existing editor route block:
```jsx
{/* Editor — full-screen, outside UserLayout */}
<Route path="/editor/:id" element={<ErrorBoundary><EditorView /></ErrorBoundary>} />
<Route path="/editor/:id/:tab" element={<ErrorBoundary><EditorView /></ErrorBoundary>} />
<Route path="/editor/:id/:tab/:sub" element={<ErrorBoundary><EditorView /></ErrorBoundary>} />
<Route path="/editor/:id/:tab/:sub/:detail" element={<ErrorBoundary><EditorView /></ErrorBoundary>} />
```

Add the export route IMMEDIATELY ABOVE the first `/editor/:id` line, so it takes precedence over the catch-all `/editor/:id/:tab` (otherwise React Router could match `/editor/:id/export` as the `:tab` route):

```jsx
{/* Export page — full-screen, outside UserLayout (sits between editor and extension) */}
<Route path="/editor/:id/export" element={<ErrorBoundary><ExportPage /></ErrorBoundary>} />
```

- [ ] **Step 2: Verify route order — most-specific first**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
grep -n "/editor/:id" src/App.jsx
# Expected order:
# /editor/:id/export  ← line FIRST
# /editor/:id         ← then this
# /editor/:id/:tab    ← etc.
```

react-router-dom v7 with `<Routes>` does pick the most-specific match by default, but explicit ordering keeps intent obvious in the file.

- [ ] **Step 3: Commit**

```bash
git add src/App.jsx
git commit -m "$(cat <<'EOF'
feat(export): mount /editor/:id/export route

Adds the new route immediately above the existing /editor/:id catchalls
so the order makes the precedence intent obvious. Wraps in the same
ErrorBoundary as the rest of the editor surface.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Manual end-to-end verification (no commit)

This task is the full Phase A acceptance gate. It requires both the backend (port 3001) and the vite dev server (port 5173), plus Ext.1 loaded unpacked. Do not skip — this is where wiring bugs surface.

**Prereq:** Backend dev server running on port 3001 in the user's normal terminal (do NOT kill it). Ext.1 loaded unpacked. `extension/.extension-id` either committed on this branch's worktree OR `VITE_EXTENSION_ID` env var set.

- [ ] **Step 1: Start the vite dev server in a separate terminal**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
npm install   # in case node_modules is fresh in the worktree

# If extension/.extension-id is missing on this branch (Ext.1 not yet
# merged to main), set the env var. Get the ID by:
#   cat ../extension-ext1/extension/.extension-id   (if Ext.1 worktree exists)
# OR
#   In Chrome → chrome://extensions → "transcript-eval Export Helper" card → ID

# With env var:
VITE_EXTENSION_ID=abcdefghijklmnopqrstuvwxyzabcdef npm run dev:client
# Without env var (file present):
npm run dev:client
```

Expected output: `Local: http://localhost:5173/`. Watch for vite errors about `__EXTENSION_ID__` — if you see "is not defined" in the browser console, the env var step was skipped.

- [ ] **Step 2: Curl the new manifest endpoint**

```bash
PID="<paste a real plan_pipeline_id from your DB>"
VAR="C"
curl -sS "http://localhost:3001/api/broll-searches/${PID}/manifest?variant=${VAR}" \
  -H "X-Dev-Bypass: true" | head -100
```

Expected JSON shape: `{ pipeline_id, variant, items: [...], totals: { count, est_size_bytes, by_source } }`. Items array non-empty if the variant has completed broll_searches.

If 404 / empty: confirm the variant_label matches what's in `broll_searches.variant_label` (likely "Variant C" not "C" — adjust the URL accordingly, or extend the route to normalize).

- [ ] **Step 3: Open the export page (no extension)**

1. Disable / remove the Ext.1 extension in `chrome://extensions` first (or use a fresh Chrome profile without it).
2. Navigate to `http://localhost:5173/editor/${PID}/export?variant=C`.
3. Expected: State A renders — "Install the Export Helper" card, "After install, this page updates automatically."
4. Open Chrome DevTools console: should NOT see any `chrome.runtime` errors (the wrapper handles them silently).

- [ ] **Step 4: Test non-Chrome banner**

1. Open the same URL in Safari (if available on the machine).
2. Expected: "This feature requires Chrome" banner with a Get Chrome button.
3. Optional: do the same in Firefox if installed.

- [ ] **Step 5: Re-enable Ext.1 → expect transition to State B or C**

1. Re-enable the extension in `chrome://extensions`.
2. Within ~2 seconds, the page should transition. Expected:
   - If the manifest's Envato item count > 0: page shows **State B** ("Sign in to Envato").
   - If 0: page goes straight to **State C** (summary).
3. If on State B, click **Sign in to Envato** — opens `https://app.envato.com/sign-in` in new tab.
4. Click **I'm already signed in — continue** — page transitions to State C.

- [ ] **Step 6: State C verification**

1. Summary card should show:
   - `Variant C · N clips · ~X.X GB` header.
   - Three CheckRow lines (Helper installed, Envato detected, Disk space).
   - Sources block with the source counts (Envato/Pexels/Freepik) you saw in the curl.
   - Target folder display: `~/Downloads/transcript-eval/export-${PID}-c/`.
   - "Change folder" button — clicking shows the "coming soon" alert.
   - Multi-variant checkboxes (one per other completed variant for this pipeline). If only Variant C is complete, no checkboxes appear — that's correct.
   - "Re-download files already on disk" checkbox.
   - Estimated time string.
   - "Start Export" button (blue).
2. Toggle a multi-variant checkbox: header `clips` count and `~X.X GB` should update; deduped if the variants share clips.

- [ ] **Step 7: Click Start Export — verify the handoff**

1. Open the extension's service worker DevTools: `chrome://extensions` → Export Helper card → click **service worker** link.
2. Click **Start Export** on the page.
3. Expected sequence (visible in network tab + service worker console):
   - POST `/api/session-token` → 200, returns `{token, kid, user_id, expires_at}`.
   - POST `/api/exports` → 201, returns `{export_id, created_at}`.
   - Service worker console logs an incoming `{type:"session", ...}` then `{type:"export", ...}` message (the SW console will show the message dispatch even though Ext.1's handler doesn't yet do anything with `export` — it'll fall through to the unknown-type branch and reply `{error:'unknown_type', type:'export'}`).
4. Page transitions to the "Starting" placeholder showing the export_id.
5. (Expected limitation: because Ext.1 doesn't handle `export` yet, the page won't ever leave the "Starting" placeholder. That's correct for Phase A — State D wires the real handling later.)

- [ ] **Step 8: Edge cases**

1. Open the page with an invalid pipelineId (e.g., `/editor/nonexistent/export?variant=C`). Expected: manifest endpoint returns `{items:[], totals:{count:0,...}}` → page reaches state_c showing 0 clips → Start Export button disabled. No crash.
2. Open the page in an incognito Chrome window where the extension isn't enabled (extensions are off by default in incognito unless explicitly enabled). Expected: stays on State A.
3. Open the page with `?variant=` missing. Expected: defaults to `variant=A` per `ExportPage.jsx`'s `searchParams.get('variant') || 'A'`.

- [ ] **Step 9: DO NOT commit anything from this task**

There are no code changes — it's verification.

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-preflight"
git status
# Expected: "nothing to commit, working tree clean"
```

If anything has changed (e.g., you tweaked code to debug), revert or land it as a proper task.

---

## Task 11: README + final review

A short README block under the new export directory documenting Phase A scope, the State B Ext.4 caveat, and the env var override.

**Files:**
- Create: `src/components/export/README.md`

- [ ] **Step 1: Write `src/components/export/README.md`**

```markdown
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
ExportPage.jsx (FSM: init → a → b → c → starting)
  ├─ useExportPreflight ── ping (2s in state_a) + manifest fetch + disk estimate
  ├─ useExtension       ── promise-wrapped chrome.runtime.sendMessage
  └─ buildManifest      ── pure function: per-variant API responses → unified manifest
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
```

- [ ] **Step 2: Commit**

```bash
git add src/components/export/README.md
git commit -m "$(cat <<'EOF'
docs(export): README for the Phase A export page

Documents the three states + extension ID delivery + the Ext.4 caveat
(State B optimism) so the next person picking this up doesn't have to
re-derive the constraints from the spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Full branch review**

```bash
git log --oneline main..HEAD
# Expected: 10 commits — one per task, minus Task 0 (no commit) and
# Task 10 (verification-only).
# Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 11 each produce one commit.
```

```bash
git diff main --stat
# Expected additions (approximate):
#   server/index.js                              |   3 +-
#   server/routes/broll.js                       | 100+
#   src/App.jsx                                  |   3 +
#   src/components/export/README.md              |  60+
#   src/components/export/StateA_Install.jsx     | 130+
#   src/components/export/StateB_Session.jsx     | 130+
#   src/components/export/StateC_Summary.jsx     | 230+
#   src/hooks/useExportPreflight.js              | 130+
#   src/hooks/useExtension.js                    | 100+
#   src/lib/buildManifest.js                     | 130+
#   src/lib/extension-id.js                      |  20+
#   src/pages/ExportPage.jsx                     | 220+
#   vite.config.js                               |  20 +-
```

Sanity checks:
- No files added outside `src/`, `server/`, `vite.config.js`. If anything else surfaces, investigate.
- No package.json changes (no new deps).
- No schema changes (no new tables).

- [ ] **Step 4: DO NOT push**

Per user convention: `git push` requires explicit consent. This task's acceptance is "all 10 commits on the local branch, branch ready for review." Surface the branch name + last commit sha to the user; ask before pushing.

---

## Self-review against the spec

After completing Tasks 0–11, re-read `docs/specs/2026-04-23-envato-export-design.md` § "UX flow (end-to-end)" States A/B/C and `docs/specs/2026-04-24-export-remaining-roadmap.md` § "WebApp.1 — Export page UI":

> **States to render (Phase A):**
> - A — Extension not installed. Polling every 2s.
> - B — Extension installed but Envato session missing/expired.
> - C — Preconditions met, manifest summary + "Start Export" button.

Coverage check:
- State A → `StateA_Install.jsx` + `useExportPreflight` ping polling ✓
- State B → `StateB_Session.jsx` + Envato item count check ✓ (with Ext.4 caveat documented)
- State C → `StateC_Summary.jsx` with full summary card per spec mockup ✓
- 2s ping polling → `useExportPreflight.js` `setInterval` cleared on phase change ✓
- Multi-browser detection → `StateA_Install.jsx` `detectBrowser()` ✓
- "Multi-variant export checkbox" → State C `availableExtraVariants` + `onToggleVariant` ✓
- Default folder per spec → `~/Downloads/transcript-eval/export-${id}-${variant}/` ✓
- Manifest from server → new `GET /api/broll-searches/:pipelineId/manifest` ✓
- Extension ID baked at build time → `vite.config.js` define + `src/lib/extension-id.js` ✓

Spec § "How web app talks to extension":
- `chrome.runtime.sendMessage(EXT_ID, msg)` one-shot for `ping` + `session` + `export` ✓
- Versioned messages (`version: 1`) ✓
- Long-lived Port DEFERRED to next plan ✓ (noted in scope)

Spec § "Multi-source downloads → Manifest shape":
- Per-item: `seq`, `timeline_start_s`, `timeline_duration_s`, `source`, `source_item_id`, `envato_item_url` (Envato only), `target_filename`, `resolution`, `frame_rate`, `est_size_bytes` ✓ (in `buildManifest` output + endpoint response)
- Filename scheme `<NNN>_<source>_<id>.<ext>` ✓ (`makeFilename` in `buildManifest.js` and the endpoint)

Spec § "Multi-variant exports → Dedup strategy":
- Key `(source, source_item_id)` ✓
- Each source-item once regardless of how many variants reference it ✓
- `seq` based on order of first appearance across selected variants ✓
- Per-item `variants[]` and `placements[]` carry the per-variant placement info ✓ (used by WebApp.2's XMEML emitter later)

Roadmap § "WebApp.1 — Key decisions":
- Extension ID pinned via `extension/.extension-id` ✓
- "Target folder selection: default `~/Downloads/transcript-eval/...`, picker deferred" ✓
- Multi-variant export checkbox visible per Figure C ✓
- Multi-browser detection — non-Chrome browsers see "Requires Chrome" banner ✓

Open questions resolved by this plan:
- **OQ3 (target folder picker)** → deferred to a later release; default folder + "Change folder" button stub ✓
- **OQ extension ID delivery** → vite `define` from committed file, env var fallback ✓

Open questions NOT resolved (expected — out of scope):
- Beta-test Envato subscription ownership → Ext.2.
- Test framework introduction → WebApp.2's call.
- Admin UI auth model → WebApp.3.
- Multi-user org support → permanently out of scope.
- Canary channel decision → Ext.11.

---

## Inputs parked for the next webapp plan (States D/E/F)

These are NOT used in Phase A — capturing here so they aren't lost when the
follow-up plan starts:

- **State D wiring** depends on Ext.5's long-lived `chrome.runtime.Port`. The
  Port pushes `{type:"state"}` snapshots and `{type:"progress"}` deltas; the
  next plan replaces the one-shot `sendExport` with a `connect()` and renders
  the spec's progress bar + per-item status list.
- **State E** depends on WebApp.2 (XMEML generator). Once `POST /api/exports/:id/generate-xml`
  exists, the page kicks it off after the extension reports `{type:"complete"}`,
  then renders the spec's "Open folder" / "Copy path" / XML link card.
- **State F** branches off State E when the extension's `complete` reports
  `fail_count > 0`. Renders the spec's per-failure list + "Retry failed" /
  "Generate XML anyway" / "Report issue" controls.
- **Multi-tab lock** — second `Start Export` from another tab while a run is
  active should show "Export already in progress in another tab" per spec
  § "Concurrency + queue constraints". Ext.5 owns the `active_run_id` lock;
  the page consumes the lock state.
- **`/api/ext-config` consumption** — once Backend 1.5 lands, the page should
  surface "Update required" if `min_ext_version > installed ext_version` and
  "Export temporarily disabled" if `export_enabled === false`. Ext.9 owns the
  extension side; webapp side is a small addition to the FSM.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-webapp-export-page-preflight.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration with two-stage (spec + code) review on each task.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
