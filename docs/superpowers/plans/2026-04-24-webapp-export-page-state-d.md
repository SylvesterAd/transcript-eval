# WebApp.1 (Phase B) — Export Page State D (In-Progress) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the second slice of the transcript-eval Export page — **State D (export running)**. Replaces the Phase-A placeholder (`'starting'` phase) with a real in-progress UI that streams live snapshots from the Chrome Export Helper's queue over a long-lived `chrome.runtime.Port`. Renders the spec's mockup: total progress bar, per-item status table with phase icons, current-item card, speed + ETA, done/failed/remaining counters, pause / resume / cancel buttons. Handles tab-close / reopen reconnect, single-active-run detection, and clean FSM transition to placeholder `state_e` / `state_f` on `{type:"complete"}`. States E (complete) and F (partial) are OUT OF SCOPE and land in a follow-up plan — this phase only needs them as stubs to transition into.

**Architecture:** Extends the existing `useReducer`-driven FSM in `src/pages/ExportPage.jsx` with three new phases (`state_d | state_e | state_f`) and drops the Phase-A `'starting'` placeholder (or renames it; see Task 1). State D is a single top-level component (`StateD_InProgress.jsx`) driven by a new dedicated hook (`useExportPort.js`) that owns the long-lived Port lifecycle: `connect → subscribe → message → reducer → snapshot → disconnect → reconnect`. A pure reducer (`progressState.js`) applies Port messages to a cached snapshot so re-renders are cheap even at ~2 Hz/item and 50-300 items. Pause / resume / cancel dispatch one-shot `chrome.runtime.sendMessage` via the existing `useExtension` hook plus optimistic UI. States E and F get two tiny placeholder components in this phase — filled out in the next plan.

**Tech Stack:** React 19 (existing). No new runtime dependencies. Styled-components 6 already in tree; lucide-react for phase icons. Port API is `chrome.runtime.connect(EXT_ID, {name})` + `port.onMessage.addListener` + `port.onDisconnect.addListener`. No virtualization dep (`react-window` / `react-virtuoso`) — CSS `max-height + overflow:auto` is sufficient at the 300-item cap the queue enforces (see "Why read this" below). Verification is manual end-to-end against Ext.5's live queue, matching the project's curl-smoke convention.

---

## Why read this before touching code

State D is the first time the web app consumes a **long-lived** `chrome.runtime.Port`. Unlike `chrome.runtime.sendMessage` (one-shot request/response the Phase-A hook `sendSession` / `sendExport` already wraps), a Port stays open until one side calls `disconnect()` or the target context goes away. The extension (Ext.5) broadcasts four message types onto every connected Port for the active run: `{type:"state"}` (full snapshot, sent on connect and on major transitions), `{type:"progress"}` (incremental bytes-received deltas, throttled ~500 ms/item), `{type:"item_done"}` (per-item terminal), `{type:"complete"}` (run-end). The web app side connects via `chrome.runtime.connect(EXT_ID, {name:"export-tap"})`, subscribes with `port.onMessage.addListener`, and cleans up on unmount / disconnect.

**Auto-reconnect on tab close/reopen.** Users are explicitly told (per spec § State D mockup and § "Large exports (100 GB+)") that "Page can be closed; extension keeps running." When they reopen `/editor/:id/export?variant=C` mid-run, the page must transparently **reconnect the Port and request a fresh snapshot** via `{type:"status", version:1}` — the extension replies with a full `{type:"state", ...}` over the Port. The hook wraps this: on mount, connect + send `status`; on `port.onDisconnect`, if we were in an active run, retry once immediately, then after a 2s delay, then show the "Disconnected from Export Helper. Reconnecting…" banner with a manual retry button. **Do not** poll indefinitely — the user can click retry.

**Throttle re-renders, not messages.** Ext.5 already throttles `progress` messages server-side (~500 ms/item per its plan's contract). But at a 300-item run with 50 items in `phase: "downloading"`, 50 × 2 Hz = 100 updates/sec — React can handle that, but re-deriving "by-item lookups" + aggregates on every dispatch wastes CPU. The pattern used here: **one pure reducer holds the whole snapshot**, `useMemo` derives by-item lookups + aggregates from the snapshot (cheap), and the reducer applies messages immutably. If profiling shows jank, add `useDeferredValue` on the snapshot passed into the virtualized-ish table. Don't reach for virtualization unless 300 items + CSS `overflow` proves inadequate — the spec's hard cap is 300 items per run per spec § "Rate limiting, TOS, fair use."

**Single active export per user.** The spec mandates one live run at a time; Ext.5 enforces it via `chrome.storage.local.active_run_id`. If the user opens `/editor/42/export?variant=C` while a run exists for `plan_pipeline_id=99`, the extension's initial `{type:"state"}` reply will show a different `runId`. The hook detects this mismatch and surfaces a **blocker UI**: "An export is already running for Variant A on project #99. Wait for it to finish, or cancel it here." The user can click "Cancel other run" which dispatches `{type:"cancel", export_id:<other_id>}` and then allows this tab to start its own. Do not start a new run in the mismatched case.

**Pause / resume / cancel are ALL one-shot `sendMessage`, not Port messages.** The web app sends control messages via the existing `chrome.runtime.sendMessage(EXT_ID, {type:"pause"|"resume"|"cancel", export_id})` wrapper. The extension applies them to its queue and broadcasts the new `run_state` back via Port (it'll land as a `{type:"state", ...}` snapshot). UI is optimistic: clicking Pause immediately flips the button to a disabled "Pausing…" state, and the real flip-to-paused happens when the Port echoes back the new `run_state`. If no echo arrives within 3 s, the button flips back with an error toast — control failed. Cancel additionally requires a `window.confirm` ("Cancel export? Downloaded files will remain on disk.") to avoid mid-run accidents; no custom modal styling in this phase.

**Transitioning to State E or F.** When `{type:"complete", ok_count, fail_count, folder_path, xml_paths}` arrives, the reducer dispatches `{type:"export_completed", payload}`, and the parent FSM moves to `state_e` (if `fail_count === 0`) or `state_f` otherwise. Both states render tiny placeholder components in this plan — raw text dumps of `ok_count`/`fail_count`/`folder_path`/failed items. The next plan fleshes them out (open-folder button, XML download links, per-failure diagnostics, retry). Mark both placeholders with a visible TODO so reviewers know this is intentional.

**Don't touch the extension code.** Ext.5 owns the queue + Port broadcasting. Every message shape is their contract. If a message field you need is missing, write it up as an open question; don't patch it across the boundary.

---

## Scope (WebApp.1 Phase B / State D only — hold the line)

### In scope

- `src/hooks/useExportPort.js` — connects `chrome.runtime.connect(EXT_ID, {name:"export-tap"})`, owns Port lifecycle (connect / subscribe / disconnect / reconnect), drives the `progressState.js` reducer with Port messages, exposes `{portState, snapshot, lastComplete, send, reconnect, disconnected, mismatched, mismatchInfo}`.
- `src/components/export/progressState.js` — pure reducer + initial state. Action types: `port_connected`, `port_disconnected`, `message_state`, `message_progress`, `message_item_done`, `message_complete`, `manual_action_sent`, `reset`. Plus selector helpers for the component to consume.
- `src/components/export/StateD_InProgress.jsx` — the big state component. Renders the spec's State D mockup: header + total progress bar, current-item card, per-item status table (CSS-scrollable `max-height: 360px`), pause / resume / cancel buttons, speed + ETA, done/failed/remaining counters, reconnect banner, single-run-active blocker.
- `src/components/export/StateE_Complete_Placeholder.jsx` — stub: raw `ok_count` / total / `folder_path` / `xml_paths` dump with a visible "WebApp.1 Phase C (next plan)" banner.
- `src/components/export/StateF_Partial_Placeholder.jsx` — stub: raw `ok_count` / `fail_count` / `folder_path` / failed-item list with the same banner.
- `src/hooks/useExtension.js` — extend with `openPort(name)` (returns `{port, disconnect}`) and a convenience `portConnect()` alias; auto-retries once on immediate disconnect (EXT_ID missing / extension temporarily unreachable).
- `src/pages/ExportPage.jsx` — extend FSM: add `state_d | state_e | state_f` phases; drop `'starting'` (or keep as a ~200 ms transitional state before Port first message arrives). Reducer handles `export_completed` payload to switch to `state_e` vs `state_f`.

### Deferred (DO NOT add to Phase B — they belong to later plans)

- **State E** (complete) full UI — "Open folder" / "Copy path" button wiring, XML download links, "How to import in Premiere" tutorial link. Lands in the next plan which kicks off XMEML generation via WebApp.2.
- **State F** (partial) full UI — per-failure diagnostics UI, "Retry failed items" / "Generate XML anyway" / "Report issue" controls. Lands in the next plan.
- **XMEML generation kickoff** — `POST /api/exports/:id/generate-xml` → download XML files to disk. Belongs to State E (next plan). Phase B's placeholder just shows `xml_paths: []` raw.
- **Retry UI** — requires the extension to support `{type:"retry", item_ids:[]}` semantically; Ext.5 doesn't expose that message yet. Queue deferred to the State F plan which will negotiate with Ext.5.
- **Multi-tab "export already in progress" lock across the same user's two tabs** — this phase only detects run-ID mismatch against the Port's reply; true multi-tab lock (two tabs both on `/editor/:id/export` for the SAME run) would require BroadcastChannel or a shared-worker style coordination. Treat as "both tabs render State D simultaneously; extension is the source of truth." Good enough for MVP.
- **Virtualization** (`react-window` / `react-virtuoso`) — skip. CSS `max-height + overflow:auto` is acceptable at 300-item cap. Revisit only if profiling shows jank.
- **`useDeferredValue` on the snapshot** — don't add speculatively. Only if Task 8's manual verification shows visible jank during high-throughput progress updates.
- **Custom cancel confirm modal** — use `window.confirm()` for now. Styling a dialog is out of scope for a phase that's already at its size budget.
- **Diagnostic bundle export** (spec § F "Report issue") — Ext.8 owns the extension side; UI button belongs to State F (next plan).
- **`/api/ext-config` min-version gating** — Ext.9 + Backend 1.5 territory; not State D's problem.
- **Telemetry events on UI actions** — Ext.6 emits from the extension side; UI doesn't double-emit.
- **State-change analytics / timing metrics** — deferred to observability phase.

Fight the urge to "just add" any of the above. Phase B proves the Port lifecycle works, the progress table renders correctly at realistic throughput, pause/resume/cancel round-trip cleanly, reconnect rehydrates on tab-close/reopen, and the FSM transitions correctly to the two placeholders. That's the entire deliverable.

---

## Prerequisites

- **Ext.5 code landed on its branch** (`feature/extension-ext5-queue-persistence` or similar) with the Port broadcasting live. The message contracts below must match Ext.5's plan (`docs/superpowers/plans/2026-04-24-extension-ext5-queue-persistence.md`). If Ext.5 is mid-flight, this plan can still be written and most tasks executed up through Task 7; Task 8 (manual end-to-end) requires Ext.5 loaded unpacked.
- **WebApp.1 Phase A** merged OR on branch `feature/export-page-preflight`. This plan extends that FSM. If Phase A hasn't merged, branch this phase's worktree off the Phase-A branch (see working conventions). If Phase A has merged to `main`, branch off `main`.
- Phase 1 backend running on `http://localhost:3001` (already a Phase-A prereq; provides `POST /api/session-token`, `POST /api/exports` which State C in Phase A already exercises — State D doesn't add new backend endpoints).
- Chrome 120+ for testing.
- A real `plan_pipeline_id` with at least one variant and enough items (ideally 20+) for the progress table to exercise its scroll behavior.

Note: Path to the repo has a trailing space in "one last " — quote every path. `cd "$TE"` patterns only.

---

## File structure (Phase B final state — delta only)

All paths are inside the transcript-eval repo root (which I'll call `$TE`). Files NOT listed here were created by Phase A and remain unchanged unless specifically modified.

```
$TE/src/
├── pages/
│   └── ExportPage.jsx                            MODIFIED — add state_d / state_e / state_f phases
├── components/
│   └── export/
│       ├── StateA_Install.jsx                    (Phase A — unchanged)
│       ├── StateB_Session.jsx                    (Phase A — unchanged)
│       ├── StateC_Summary.jsx                    (Phase A — unchanged)
│       ├── StateD_InProgress.jsx                 NEW — live-progress component
│       ├── StateE_Complete_Placeholder.jsx      NEW — stub, filled in next plan
│       ├── StateF_Partial_Placeholder.jsx       NEW — stub, filled in next plan
│       ├── progressState.js                      NEW — pure reducer + selectors
│       └── README.md                             MODIFIED — document Phase B additions
├── hooks/
│   ├── useExtension.js                           MODIFIED — add openPort + closePort
│   ├── useExportPreflight.js                     (Phase A — unchanged)
│   └── useExportPort.js                          NEW — long-lived Port lifecycle + reducer-backed snapshot
└── lib/
    ├── extension-id.js                           (Phase A — unchanged)
    └── buildManifest.js                          (Phase A — unchanged)
```

Why this split:
- `useExportPort.js` is its own file (not folded into `useExtension.js`) because its lifecycle is fundamentally different — long-lived, stateful, event-driven. `useExtension.js` stays focused on its one-shot helpers.
- `progressState.js` lives under `src/components/export/` (alongside the state components) because it's colocated with the component that consumes it. Pattern matches `src/components/editor/useBRollEditorState.js` which the codebase already uses for component-scoped reducers.
- `StateE_Complete_Placeholder.jsx` and `StateF_Partial_Placeholder.jsx` intentionally have the `_Placeholder` suffix so a grep for that substring surfaces all Phase-B stubs for the follow-up plan to delete/replace.
- `StateD_InProgress.jsx` is a single file even though it's ~400 LOC — it renders one cohesive surface, splitting it into sub-files would fragment styling and make the progress-table / header / controls less cohesive. If this single file outgrows ~500 LOC, a later refactor can extract `StateD_ItemTable.jsx`.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/export-page-state-d` on branch `feature/export-page-state-d`. Base branch: `main` if WebApp.1 Phase A has merged to `main`, otherwise branch off `feature/export-page-preflight`. Task 0 checks both and picks the right base.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan.
- **Never kill process on port 3001.** That's the user's backend dev server. If you launch anything for testing, use a different port.
- **Commit style:** conventional commits (`feat(export): ...`, `refactor(export): ...`, `chore(export): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing.
- **No new runtime deps.** Use what's in `package.json`: react, react-router-dom, styled-components, lucide-react. This plan introduces zero new packages. In particular, do NOT add `react-window` / `react-virtuoso` — see "Why read this" § throttle re-renders.
- **Match existing style.** Components use styled-components (established by Phase A). Phase-B components follow the same pattern; no Tailwind in the export surface.
- **Don't mutate the extension tree (`extension/`).** Ext.5 owns the queue + Port broadcasting. If you think a message is missing a field, write it up as an open question for the next round.

---

## Task 0: Create worktree + pick base branch

**Files:**
- Create: `$TE/.worktrees/export-page-state-d/` (worktree)

- [ ] **Step 1: Pick the base branch**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin main
git branch --list "feature/export-page-preflight" --format='%(refname:short)'
git log --oneline main -5 | grep -iE "state c|state b|state a|webapp-1|preflight|export page" | head -3
```

If the Phase-A branch (`feature/export-page-preflight`) exists and its commits are NOT yet on `main`, base this worktree off that branch. If Phase-A commits are on `main` already, base off `main`. Use the script below to decide deterministically:

```bash
BASE="main"
if git rev-parse --verify feature/export-page-preflight >/dev/null 2>&1; then
  # Count commits on the Phase-A branch not in main.
  UNMERGED=$(git rev-list --count main..feature/export-page-preflight 2>/dev/null || echo 0)
  if [ "$UNMERGED" -gt 0 ]; then
    BASE="feature/export-page-preflight"
  fi
fi
echo "BASE=$BASE"
# Expected: main  OR  feature/export-page-preflight
```

- [ ] **Step 2: Create the worktree + branch off `$BASE`**

```bash
cd "$TE"
git worktree add -b feature/export-page-state-d .worktrees/export-page-state-d "$BASE"
cd ".worktrees/export-page-state-d"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d
git status
# Expected: "On branch feature/export-page-state-d; nothing to commit, working tree clean"
git log --oneline -1
# Expected: tip of $BASE
```

- [ ] **Step 3: Verify you are on the new branch before any file changes**

```bash
git branch --show-current
# Expected: feature/export-page-state-d
```

If this prints anything else, STOP and fix — don't write files into the wrong branch.

- [ ] **Step 4: Sanity check — Phase A files exist**

```bash
ls src/pages/ExportPage.jsx src/hooks/useExtension.js src/hooks/useExportPreflight.js src/lib/buildManifest.js 2>/dev/null
# Expected: all four files listed. If ANY is missing, the base branch choice was wrong — stop and revisit Step 1.
```

- [ ] **Step 5: Commit baseline — no changes yet**

Nothing to commit; Task 1 lands the first real change.

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

---

## Task 1: `src/hooks/useExtension.js` — add `openPort` + `closePort`

Extends the Phase-A `useExtension` hook with Port lifecycle helpers. The Port is fundamentally different from one-shot `sendMessage` — it's long-lived, event-driven, and must be cleanly disconnected on unmount. We wrap the awkward callback-based Chrome API in a pattern that returns a consumable `{port, disconnect}` handle the caller owns.

**Files:**
- Modify: `src/hooks/useExtension.js`

- [ ] **Step 1: Read the existing `useExtension.js`**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
cat src/hooks/useExtension.js
```

The existing file exports `useExtension()` returning `{ping, sendSession, sendExport}` — all memoized via `useMemo`. We'll add `openPort` and keep the shape stable.

- [ ] **Step 2: Edit `src/hooks/useExtension.js` — add Port helper inside the hook**

Use the Edit tool. Inside the `useMemo(() => ({...}), [])` block, add the new helper AFTER `sendExport`:

```js
    // Open a long-lived Port to the extension. Unlike sendMessage (one-
    // shot request/response), a Port stays open until one side calls
    // disconnect(). Used by State D's useExportPort hook to subscribe
    // to the extension's queue broadcasts: {type:"state"},
    // {type:"progress"}, {type:"item_done"}, {type:"complete"}.
    //
    // Returns a handle the caller owns: { port, disconnect }. The
    // caller is responsible for calling disconnect() on unmount.
    //
    // Auto-retries once on IMMEDIATE disconnect: if Chrome fires
    // onDisconnect synchronously (typical when EXT_ID is invalid or
    // the extension was just reloaded), we try one more connect with
    // a small delay before surfacing the error to the caller. This
    // handles the common "extension was reloaded during dev" race
    // without a user-visible blip.
    openPort: (name = 'export-tap') => {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.connect) {
        throw new Error('chrome.runtime.connect is not available — non-Chrome browser?')
      }
      if (!EXT_ID) {
        throw new Error('EXT_ID is empty (see src/lib/extension-id.js)')
      }
      let port = null
      let retried = false
      const listeners = { message: [], disconnect: [] }

      function attach(p) {
        p.onMessage.addListener((msg) => {
          listeners.message.forEach(fn => { try { fn(msg) } catch (e) { console.error('[useExtension.openPort onMessage listener error]', e) } })
        })
        p.onDisconnect.addListener(() => {
          const lastErr = chrome.runtime.lastError
          const reason = lastErr?.message || 'disconnected'
          // Retry ONCE on immediate disconnect (extension reloaded,
          // transient), then surface to caller.
          if (!retried) {
            retried = true
            setTimeout(() => {
              try {
                const p2 = chrome.runtime.connect(EXT_ID, { name })
                port = p2
                attach(p2)
              } catch (e) {
                listeners.disconnect.forEach(fn => { try { fn(e.message || reason) } catch {} })
              }
            }, 200)
            return
          }
          listeners.disconnect.forEach(fn => { try { fn(reason) } catch {} })
        })
      }

      try {
        port = chrome.runtime.connect(EXT_ID, { name })
        attach(port)
      } catch (e) {
        throw new Error(`failed to open port to ${EXT_ID}: ${e.message}`)
      }

      return {
        // Consumers use these to subscribe; plain add/remove pattern
        // so the hook consumer doesn't have to think about Chrome's
        // API quirks.
        onMessage: (fn) => {
          listeners.message.push(fn)
          return () => { listeners.message = listeners.message.filter(f => f !== fn) }
        },
        onDisconnect: (fn) => {
          listeners.disconnect.push(fn)
          return () => { listeners.disconnect = listeners.disconnect.filter(f => f !== fn) }
        },
        postMessage: (msg) => {
          try { port?.postMessage(msg) } catch (e) { console.error('[openPort.postMessage]', e) }
        },
        disconnect: () => {
          try { port?.disconnect() } catch {}
          port = null
          listeners.message = []
          listeners.disconnect = []
        },
      }
    },
```

Notes on each piece:
- `name: 'export-tap'` — arbitrary name for the Port. Ext.5's SW can look at `port.name` to branch behavior; using a descriptive name beats an anonymous connection.
- Retry-once on immediate disconnect — handles the "I just reloaded the extension in dev" bump without showing the user an error. Retry budget is intentionally tiny (200 ms). Further reconnect retries live in the consumer hook (`useExportPort.js`) with user-visible UX.
- `listeners.message / listeners.disconnect` arrays + wrapper — we don't expose the raw Chrome Port to the caller, because consumers would then have to care about `lastError` and re-attach listeners after retry. The wrapper presents a stable subscribe/unsubscribe API.
- `disconnect()` clears listener arrays so stale callbacks can't fire after teardown.

- [ ] **Step 3: Verify the file parses**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
node --check src/hooks/useExtension.js
# Expected: exit 0
```

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useExtension.js
git commit -m "$(cat <<'EOF'
feat(export): useExtension.openPort — long-lived Port helper

Adds chrome.runtime.connect wrapper with a clean subscribe/unsubscribe
API (onMessage, onDisconnect, postMessage, disconnect) so consumers
don't have to touch the raw Chrome Port. Retries once on immediate
disconnect (typical during dev reloads) before surfacing the error.

Used by the new useExportPort hook to subscribe to the extension's
queue broadcasts for State D. Phase A's one-shot helpers (ping,
sendSession, sendExport) are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `src/components/export/progressState.js` — pure reducer + selectors

Pure reducer that maps Port messages onto a cached snapshot shape. Keeping this pure and separate from the hook means we can reason about state transitions without Chrome APIs, React, or effects in the mix — and selectors are just functions over the snapshot.

**Files:**
- Create: `src/components/export/progressState.js`

- [ ] **Step 1: Write `src/components/export/progressState.js`**

```js
// Pure reducer for the State D progress snapshot. Applies Port messages
// from the extension queue (Ext.5) onto a cached shape the component
// renders from.
//
// Kept separate from the hook so it's trivially unit-testable in Node
// (no chrome.runtime, no React) and so the component doesn't re-derive
// expensive aggregates on every message — it reads from the snapshot
// plus memoized selectors below.
//
// Port message shapes (consumed here):
//
//   {type:"state", version:1, export: {
//      runId, export_id, plan_pipeline_id, variant_labels, target_folder,
//      items: [
//        { seq, source, source_item_id, target_filename,
//          phase,            // queued|resolving|licensing|downloading|done|failed
//          bytes_received, total_bytes, download_id,
//          error_code, started_at, completed_at }
//      ],
//      stats: { ok_count, fail_count, total_bytes_downloaded, total_bytes_est },
//      run_state,            // running|paused|cancelling|cancelled|complete|partial
//      started_at, updated_at
//   }}
//
//   {type:"progress", version:1, item_id, phase, bytes, total_bytes}
//   {type:"item_done", version:1, item_id, result: {ok:bool, bytes, duration_ms, error_code?}}
//   {type:"complete",  version:1, ok_count, fail_count, folder_path, xml_paths: []}
//
// The reducer treats anything unknown as a no-op (forward-compat with
// Ext.5 bumping its schema; we'll upgrade intentionally).

export const INITIAL_PROGRESS_STATE = Object.freeze({
  // Port lifecycle
  portStatus: 'idle',     // idle | connecting | connected | disconnected | reconnecting | failed
  portError: null,

  // Snapshot — null until the first {type:"state"} arrives
  snapshot: null,

  // Terminal
  complete: null,         // {ok_count, fail_count, folder_path, xml_paths} once {type:"complete"} arrives

  // Optimistic UI — set on manual_action_sent, cleared when a snapshot echoes back the expected run_state
  pendingAction: null,    // {action:"pause"|"resume"|"cancel", sentAt:ms}
})

export function progressReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return INITIAL_PROGRESS_STATE

    case 'port_connecting':
      return { ...state, portStatus: 'connecting', portError: null }

    case 'port_connected':
      return { ...state, portStatus: 'connected', portError: null }

    case 'port_disconnected':
      return {
        ...state,
        portStatus: 'disconnected',
        portError: action.reason || null,
      }

    case 'port_reconnecting':
      return { ...state, portStatus: 'reconnecting', portError: null }

    case 'port_failed':
      return {
        ...state,
        portStatus: 'failed',
        portError: action.error || 'unknown port error',
      }

    case 'message_state': {
      // Full snapshot replace. Extension is the source of truth; we
      // don't merge field-by-field because partial snapshots are not
      // in Ext.5's contract.
      const snap = action.payload
      // If the pending action has been echoed back in the new
      // run_state, clear it.
      let pending = state.pendingAction
      if (pending && snap?.run_state) {
        const expect = {
          pause: 'paused',
          resume: 'running',
          cancel: ['cancelling', 'cancelled'],
        }[pending.action]
        const match = Array.isArray(expect)
          ? expect.includes(snap.run_state)
          : snap.run_state === expect
        if (match) pending = null
      }
      return { ...state, snapshot: snap, pendingAction: pending }
    }

    case 'message_progress': {
      // Incremental per-item bytes update. If we haven't received a
      // snapshot yet, drop the update (we'll catch up on the next
      // {type:"state"}).
      if (!state.snapshot || !Array.isArray(state.snapshot.items)) return state
      const { item_id, phase, bytes, total_bytes } = action.payload
      let touched = false
      const items = state.snapshot.items.map(it => {
        if (it.source_item_id !== item_id) return it
        touched = true
        return {
          ...it,
          phase: phase ?? it.phase,
          bytes_received: typeof bytes === 'number' ? bytes : it.bytes_received,
          total_bytes: typeof total_bytes === 'number' ? total_bytes : it.total_bytes,
        }
      })
      if (!touched) return state
      return {
        ...state,
        snapshot: { ...state.snapshot, items, updated_at: Date.now() },
      }
    }

    case 'message_item_done': {
      if (!state.snapshot || !Array.isArray(state.snapshot.items)) return state
      const { item_id, result } = action.payload
      const items = state.snapshot.items.map(it => {
        if (it.source_item_id !== item_id) return it
        return {
          ...it,
          phase: result?.ok ? 'done' : 'failed',
          bytes_received: result?.bytes ?? it.bytes_received ?? 0,
          total_bytes: result?.bytes ?? it.total_bytes ?? 0,
          error_code: result?.ok ? null : (result?.error_code || 'unknown'),
          completed_at: Date.now(),
        }
      })
      // Adjust stats locally (extension will also emit a fresh
      // {type:"state"} shortly; this is a fast local catch-up).
      const prevStats = state.snapshot.stats || { ok_count: 0, fail_count: 0, total_bytes_downloaded: 0 }
      const stats = {
        ...prevStats,
        ok_count: prevStats.ok_count + (result?.ok ? 1 : 0),
        fail_count: prevStats.fail_count + (result?.ok ? 0 : 1),
        total_bytes_downloaded: (prevStats.total_bytes_downloaded || 0) + (result?.bytes || 0),
      }
      return {
        ...state,
        snapshot: { ...state.snapshot, items, stats, updated_at: Date.now() },
      }
    }

    case 'message_complete':
      return {
        ...state,
        complete: {
          ok_count: action.payload.ok_count,
          fail_count: action.payload.fail_count,
          folder_path: action.payload.folder_path || null,
          xml_paths: Array.isArray(action.payload.xml_paths) ? action.payload.xml_paths : [],
        },
      }

    case 'manual_action_sent':
      return {
        ...state,
        pendingAction: { action: action.action, sentAt: Date.now() },
      }

    case 'manual_action_cleared':
      return { ...state, pendingAction: null }

    default:
      return state
  }
}

// -----------------------------------------------------------------
// Selectors — pure functions off the snapshot. Called under useMemo
// in the component to avoid re-deriving on every message.
// -----------------------------------------------------------------

/**
 * Derive totals for the header (done / total / bytes).
 */
export function selectTotals(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) {
    return { done: 0, failed: 0, remaining: 0, total: 0, bytesDone: 0, bytesTotal: 0 }
  }
  let done = 0, failed = 0, bytesDone = 0, bytesTotal = 0
  for (const it of snapshot.items) {
    if (it.phase === 'done') done += 1
    else if (it.phase === 'failed') failed += 1
    bytesDone += Math.max(0, it.bytes_received || 0)
    bytesTotal += Math.max(0, it.total_bytes || it.est_size_bytes || 0)
  }
  return {
    done,
    failed,
    remaining: Math.max(0, snapshot.items.length - done - failed),
    total: snapshot.items.length,
    bytesDone,
    bytesTotal,
  }
}

/**
 * Identify the "current item" — the spec's State D mockup calls out a
 * single featured current-item card. Pick the in-flight downloading
 * item with the most bytes_received (most advanced), falling back to
 * the first non-terminal item.
 */
export function selectCurrentItem(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return null
  let best = null
  for (const it of snapshot.items) {
    if (it.phase === 'done' || it.phase === 'failed') continue
    if (it.phase === 'downloading') {
      if (!best || (it.bytes_received || 0) > (best.bytes_received || 0)) best = it
    } else if (!best) {
      best = it
    }
  }
  return best
}

/**
 * Compute an instant throughput estimate + ETA string using the
 * snapshot's started_at + bytes totals. Returns { speedMbps, etaMin }.
 *
 * Not a rolling average — keeps the component simple. Displays "—" in
 * the UI for the first few seconds when the fraction is too small to
 * be meaningful (see StateD_InProgress).
 */
export function selectSpeedAndEta(snapshot) {
  if (!snapshot || !snapshot.started_at) return { speedMbps: 0, etaMin: null, etaSeconds: null }
  const elapsedSec = Math.max(1, (Date.now() - snapshot.started_at) / 1000)
  const { bytesDone, bytesTotal } = selectTotals(snapshot)
  const bitsPerSec = (bytesDone * 8) / elapsedSec
  const speedMbps = bitsPerSec / (1024 * 1024)
  const remainingBytes = Math.max(0, bytesTotal - bytesDone)
  const etaSeconds = bitsPerSec > 0 ? Math.round((remainingBytes * 8) / bitsPerSec) : null
  const etaMin = etaSeconds != null ? Math.max(1, Math.round(etaSeconds / 60)) : null
  return { speedMbps, etaMin, etaSeconds }
}
```

Why each piece:
- `INITIAL_PROGRESS_STATE` is `Object.freeze`'d so accidental mutation surfaces as a TypeError in dev.
- `message_state` doesn't deep-merge — full snapshot replace matches Ext.5's contract (they broadcast full state on transitions). Partial snapshots aren't in scope.
- `pendingAction` cleared automatically when the snapshot's `run_state` matches the expected post-action state. This is the optimistic-UI reconciliation: fast feedback on click, but the extension is still the source of truth.
- `message_progress` drops the update if no snapshot exists yet — we can't guess which item it refers to without a prior snapshot. The next `{type:"state"}` will catch us up.
- `message_item_done` updates both the item's `phase` AND the top-level `stats` eagerly — so the "12 ok · 0 failed · 35 remaining" counter in the mockup flips instantly rather than waiting for the next full snapshot.
- `selectTotals` / `selectCurrentItem` / `selectSpeedAndEta` are pure — the component wraps each in `useMemo(() => selectX(snapshot), [snapshot])` so they only re-run when the snapshot reference changes.

- [ ] **Step 2: Verify syntax + inline sanity test**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
node --check src/components/export/progressState.js
# Expected: exit 0

node -e "
const m = await import('./src/components/export/progressState.js');
// initial → message_state → progress on one item
let s = m.INITIAL_PROGRESS_STATE;
s = m.progressReducer(s, { type: 'port_connected' });
console.log('after connect:', s.portStatus);  // expect 'connected'
s = m.progressReducer(s, { type: 'message_state', payload: {
  runId: 'r1', items: [
    {seq:1, source:'envato', source_item_id:'X1', target_filename:'001_envato_X1.mov', phase:'downloading', bytes_received:10, total_bytes:100},
    {seq:2, source:'pexels', source_item_id:'P1', target_filename:'002_pexels_P1.mp4', phase:'queued', bytes_received:0, total_bytes:0},
  ], stats:{ok_count:0,fail_count:0,total_bytes_downloaded:0}, run_state:'running', started_at: Date.now(),
}});
s = m.progressReducer(s, { type: 'message_progress', payload: {item_id: 'X1', phase: 'downloading', bytes: 50, total_bytes: 100}});
console.log('X1 bytes:', s.snapshot.items[0].bytes_received);  // expect 50
const t = m.selectTotals(s.snapshot);
console.log('totals:', t);  // expect done:0, remaining:2, total:2
s = m.progressReducer(s, { type: 'message_item_done', payload: {item_id: 'X1', result: {ok: true, bytes: 100, duration_ms: 2000}}});
console.log('X1 phase:', s.snapshot.items[0].phase);  // expect 'done'
console.log('stats:', s.snapshot.stats);  // expect ok_count:1
s = m.progressReducer(s, { type: 'manual_action_sent', action: 'pause' });
console.log('pending:', s.pendingAction.action);  // expect 'pause'
s = m.progressReducer(s, { type: 'message_state', payload: {...s.snapshot, run_state:'paused'}});
console.log('pending after paused snapshot:', s.pendingAction);  // expect null
"
```

If all lines match the expected output, the reducer is wired right.

- [ ] **Step 3: Commit**

```bash
git add src/components/export/progressState.js
git commit -m "$(cat <<'EOF'
feat(export): progressState reducer + selectors for State D

Pure reducer mapping extension Port messages (state/progress/
item_done/complete) onto a cached snapshot shape. Separated from the
hook so it's unit-testable without chrome.runtime + React.

Selectors (selectTotals, selectCurrentItem, selectSpeedAndEta) are
pure functions off the snapshot; the State D component wraps each
under useMemo so aggregates aren't re-derived on every message.

Also handles optimistic UI for pause/resume/cancel via a pendingAction
field that auto-clears when the extension echoes the expected
run_state back in a new snapshot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `src/hooks/useExportPort.js` — long-lived Port lifecycle

Owns connect → subscribe → message → reducer dispatch → reconnect → disconnect. Returns a discriminated snapshot the component renders. Reconnect on `port.onDisconnect` is the interesting bit: if the user closes the tab and reopens, we fire a fresh `{type:"status"}` to trigger a rehydrating snapshot.

**Files:**
- Create: `src/hooks/useExportPort.js`

- [ ] **Step 1: Write `src/hooks/useExportPort.js`**

```js
// State D's long-lived Port lifecycle. Connects to the extension,
// subscribes to the queue broadcasts, drives the pure progressState
// reducer, and handles reconnect on tab-close / reopen.
//
// Call pattern:
//   const { snapshot, portStatus, pendingAction, complete,
//           sendControl, reconnect, mismatched, mismatchInfo } =
//     useExportPort({ exportId, expectedRunId })
//
// Where:
//   exportId       — the export_id we started (for pause/resume/cancel)
//   expectedRunId  — the runId the web app believes is current. If the
//                    extension's initial {type:"state"} snapshot shows
//                    a DIFFERENT runId, we set mismatched=true and the
//                    component renders the "another export is running"
//                    blocker UI.
//
// Reconnect policy:
//   - On mount: connect immediately + send {type:"status"} to force a
//     full snapshot (vs. waiting for the next organic broadcast).
//   - On port.onDisconnect during an active run: try reconnect once
//     immediately (portStatus='reconnecting'). If that second attempt
//     fires onDisconnect again within 2s, portStatus='disconnected'
//     with a user-visible banner + retry button. Do not auto-poll
//     further — the user clicks reconnect.
//   - When the run is already complete (state.complete != null), we
//     don't attempt reconnect — the Port legitimately closed.

import { useEffect, useReducer, useRef, useCallback } from 'react'
import { INITIAL_PROGRESS_STATE, progressReducer } from '../components/export/progressState.js'
import { useExtension } from './useExtension.js'

export function useExportPort({ exportId, expectedRunId } = {}) {
  const ext = useExtension()
  const [state, dispatch] = useReducer(progressReducer, INITIAL_PROGRESS_STATE)

  // Ref to the active Port handle so reconnect + unmount can tear it
  // down. Held in a ref so stale closures don't fire on the wrong
  // Port.
  const portRef = useRef(null)
  const reconnectAttemptRef = useRef(0)
  const unmountedRef = useRef(false)
  const lastStateAtRef = useRef(Date.now())  // for stale-detection if we add it

  // Detect run-ID mismatch from the first snapshot.
  const mismatched = !!(state.snapshot && expectedRunId && state.snapshot.runId &&
                        state.snapshot.runId !== expectedRunId)
  const mismatchInfo = mismatched ? {
    actualRunId: state.snapshot.runId,
    actualExportId: state.snapshot.export_id,
    actualPipelineId: state.snapshot.plan_pipeline_id,
    actualVariants: state.snapshot.variant_labels || [],
    actualRunState: state.snapshot.run_state,
  } : null

  const connect = useCallback(() => {
    if (unmountedRef.current) return
    dispatch({ type: 'port_connecting' })
    let handle
    try {
      handle = ext.openPort('export-tap')
    } catch (e) {
      dispatch({ type: 'port_failed', error: e.message })
      return
    }
    portRef.current = handle
    dispatch({ type: 'port_connected' })

    handle.onMessage((msg) => {
      lastStateAtRef.current = Date.now()
      if (!msg || typeof msg !== 'object') return
      switch (msg.type) {
        case 'state':
          // Ext.5 contract: full snapshot under msg.export (or msg directly;
          // accept both to be resilient).
          dispatch({ type: 'message_state', payload: msg.export || msg })
          break
        case 'progress':
          dispatch({ type: 'message_progress', payload: {
            item_id: msg.item_id,
            phase: msg.phase,
            bytes: msg.bytes,
            total_bytes: msg.total_bytes,
          }})
          break
        case 'item_done':
          dispatch({ type: 'message_item_done', payload: {
            item_id: msg.item_id,
            result: msg.result,
          }})
          break
        case 'complete':
          dispatch({ type: 'message_complete', payload: {
            ok_count: msg.ok_count,
            fail_count: msg.fail_count,
            folder_path: msg.folder_path,
            xml_paths: msg.xml_paths,
          }})
          break
        default:
          // Unknown message type — forward-compat no-op.
          break
      }
    })

    handle.onDisconnect((reason) => {
      if (unmountedRef.current) return
      // If we already received the terminal complete, the disconnect
      // is expected (extension closed the Port at run end). Don't
      // reconnect.
      if (state.complete) {
        dispatch({ type: 'port_disconnected', reason })
        return
      }
      // Retry policy: up to 2 reconnect attempts before surfacing the
      // banner. First attempt is immediate, second after 2s.
      if (reconnectAttemptRef.current >= 2) {
        dispatch({ type: 'port_disconnected', reason })
        return
      }
      reconnectAttemptRef.current += 1
      dispatch({ type: 'port_reconnecting' })
      const delay = reconnectAttemptRef.current === 1 ? 0 : 2000
      setTimeout(() => {
        if (unmountedRef.current) return
        try {
          const h2 = ext.openPort('export-tap')
          portRef.current = h2
          attachReconnectedHandlers(h2)
          dispatch({ type: 'port_connected' })
          // Request a fresh snapshot so the UI rehydrates.
          try { h2.postMessage({ type: 'status', version: 1 }) } catch {}
          reconnectAttemptRef.current = 0
        } catch (e) {
          dispatch({ type: 'port_disconnected', reason: e.message || reason })
        }
      }, delay)
    })

    // First post after connect — ask the extension for its current
    // state even if it hasn't broadcast yet. This is the workflow
    // that makes "close tab, reopen" work: extension replies with a
    // {type:"state"} snapshot describing the in-progress run.
    try { handle.postMessage({ type: 'status', version: 1 }) } catch {}
  }, [ext, state.complete])

  // Reconnected handler re-attaches listeners on the new port.
  // Declared as a ref-closure trick so the onDisconnect callback
  // captures the LATEST connect behavior.
  function attachReconnectedHandlers(h) {
    h.onMessage((msg) => {
      lastStateAtRef.current = Date.now()
      if (!msg || typeof msg !== 'object') return
      switch (msg.type) {
        case 'state':     dispatch({ type: 'message_state', payload: msg.export || msg }); break
        case 'progress':  dispatch({ type: 'message_progress', payload: { item_id: msg.item_id, phase: msg.phase, bytes: msg.bytes, total_bytes: msg.total_bytes }}); break
        case 'item_done': dispatch({ type: 'message_item_done', payload: { item_id: msg.item_id, result: msg.result }}); break
        case 'complete':  dispatch({ type: 'message_complete', payload: { ok_count: msg.ok_count, fail_count: msg.fail_count, folder_path: msg.folder_path, xml_paths: msg.xml_paths }}); break
      }
    })
    h.onDisconnect((reason) => {
      if (unmountedRef.current) return
      if (state.complete) { dispatch({ type: 'port_disconnected', reason }); return }
      if (reconnectAttemptRef.current >= 2) { dispatch({ type: 'port_disconnected', reason }); return }
      reconnectAttemptRef.current += 1
      dispatch({ type: 'port_reconnecting' })
      setTimeout(() => {
        if (unmountedRef.current) return
        try {
          const h2 = ext.openPort('export-tap')
          portRef.current = h2
          attachReconnectedHandlers(h2)
          dispatch({ type: 'port_connected' })
          try { h2.postMessage({ type: 'status', version: 1 }) } catch {}
          reconnectAttemptRef.current = 0
        } catch (e) {
          dispatch({ type: 'port_disconnected', reason: e.message || reason })
        }
      }, 2000)
    })
  }

  // Open the Port on mount; tear down on unmount.
  useEffect(() => {
    unmountedRef.current = false
    connect()
    return () => {
      unmountedRef.current = true
      try { portRef.current?.disconnect() } catch {}
      portRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // connect intentionally NOT in deps — we only open once per mount

  // Manual reconnect button — the UI exposes this when portStatus is
  // 'disconnected' or 'failed'.
  const reconnect = useCallback(() => {
    try { portRef.current?.disconnect() } catch {}
    portRef.current = null
    reconnectAttemptRef.current = 0
    connect()
  }, [connect])

  // Control messages are ONE-SHOT sendMessage, not Port sends. Extension
  // echoes the new run_state via the Port's next snapshot.
  const sendControl = useCallback(async (action) => {
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      throw new Error(`unknown control action: ${action}`)
    }
    // Cancel confirm — mandated by the "don't lose files on a mis-
    // click" policy. We use window.confirm to avoid styling a modal.
    if (action === 'cancel') {
      const ok = window.confirm('Cancel export? Downloaded files will remain on disk.')
      if (!ok) return { cancelled: true }
    }
    dispatch({ type: 'manual_action_sent', action })
    try {
      // ext.send not exported directly; we re-use openPort's underlying
      // chrome.runtime.sendMessage via a lightweight send call. Rather
      // than adding YET another method to useExtension, we send via
      // chrome.runtime.sendMessage inline (same shape as Phase A
      // sendSession/sendExport under the hood). This keeps the hook
      // surface lean.
      const EXT_ID = (await import('../lib/extension-id.js')).EXT_ID
      if (!EXT_ID) throw new Error('EXT_ID empty')
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(EXT_ID, { type: action, version: 1, export_id: exportId }, (r) => {
          const e = chrome.runtime.lastError
          if (e) reject(new Error(e.message || 'chrome.runtime.lastError'))
          else resolve(r)
        })
      })
      if (response?.error) throw new Error(response.error)
      // After 3s, if the snapshot's run_state hasn't echoed the action,
      // clear the pending flag so the button isn't stuck.
      setTimeout(() => {
        if (unmountedRef.current) return
        dispatch({ type: 'manual_action_cleared' })
      }, 3000)
      return response ?? { ok: true }
    } catch (e) {
      // Clear the optimistic state on error — the UI button flips back.
      dispatch({ type: 'manual_action_cleared' })
      throw e
    }
  }, [exportId])

  return {
    snapshot: state.snapshot,
    portStatus: state.portStatus,
    portError: state.portError,
    pendingAction: state.pendingAction,
    complete: state.complete,
    reconnect,
    sendControl,
    mismatched,
    mismatchInfo,
  }
}
```

Why each piece:
- `portRef` is a ref so the teardown effect reads the LATEST port (not a captured stale one from the first render).
- `unmountedRef` guards async callbacks — don't dispatch to a reducer whose component has been unmounted.
- Reconnect is attempted ONCE immediately and ONCE after 2s, then banner. Further retries are user-gated. Beats an infinite retry loop burning CPU.
- `attachReconnectedHandlers` duplicates the on-connect setup because the callback identity needs to close over the latest `state.complete` / `reconnectAttemptRef` — pulling it out to a top-level function with the right closure is the cleanest way without getting into ref-inception. A later refactor could consolidate.
- `sendControl` deliberately uses `chrome.runtime.sendMessage` inline rather than adding YET another exported helper on `useExtension`. Control actions are a State-D-only concern; the one-shot Phase A helpers stay focused on their roles.
- `window.confirm` for cancel — simple and intentional (see "Why read this" § pause/resume/cancel).

- [ ] **Step 2: Verify the file parses**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
node --check src/hooks/useExportPort.js
# Expected: exit 0
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useExportPort.js
git commit -m "$(cat <<'EOF'
feat(export): useExportPort hook — long-lived Port lifecycle for State D

Connects chrome.runtime.connect(EXT_ID, {name:'export-tap'}), subscribes
to the extension's queue broadcasts, drives progressState reducer.

Reconnect policy: up to 2 attempts (first immediate, second after 2s)
before surfacing the "Disconnected from Export Helper" banner with a
user-gated retry button. Further retries are explicit — no infinite
reconnect loop.

On connect (and on successful reconnect) sends {type:"status"} to
trigger a rehydrating {type:"state"} from the extension — this is
what makes "close tab, reopen" transparent to the user.

sendControl (pause / resume / cancel) uses one-shot sendMessage;
extension echoes new run_state via the Port's next snapshot.
Cancel confirms via window.confirm per the "don't styled-modal it in
this phase" scope.

Detects run-ID mismatch: if the extension's snapshot carries a
different runId than the page expects, exposes mismatched=true so
StateD_InProgress can render the single-run-active blocker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `src/components/export/StateD_InProgress.jsx`

The big component. Renders the spec's State D mockup: total progress bar, current-item card, per-item status table (scrollable), pause/resume/cancel buttons, speed + ETA, done/failed/remaining counters, reconnect banner, mismatch blocker.

**Files:**
- Create: `src/components/export/StateD_InProgress.jsx`

- [ ] **Step 1: Write `src/components/export/StateD_InProgress.jsx`**

```jsx
import { useMemo, useState, useCallback } from 'react'
import styled, { keyframes } from 'styled-components'
import { Pause, Play, Square, AlertCircle, RefreshCw, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { selectTotals, selectCurrentItem, selectSpeedAndEta } from './progressState.js'
import { formatBytes } from '../../lib/buildManifest.js'

// Spec § State D (docs/specs/2026-04-23-envato-export-design.md).
// Renders:
//   · header (variant + "exporting")
//   · total progress bar with bytes + count overlay
//   · current-item card (filename, size, percent)
//   · speed + ETA
//   · pause / resume / cancel buttons
//   · per-item status table, scrollable (max-height 360)
//   · done/failed/remaining counters
//   · reconnect banner when port disconnected
//   · single-run-active blocker when mismatched
//
// Props come from ExportPage.jsx via useExportPort (see plan §Task 3).

const Wrap = styled.div`
  max-width: 780px;
  margin: 40px auto;
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

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.65; }
`

const Bar = styled.div`
  position: relative;
  height: 14px;
  border-radius: 6px;
  background: #e5e7eb;
  overflow: hidden;
  margin: 14px 0 6px;
`
const BarFill = styled.div`
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #2563eb, #3b82f6);
  border-radius: 6px 0 0 6px;
  transition: width 300ms ease-out;
  ${p => p.$running && `animation: ${pulse} 1.8s infinite;`}
`
const BarLabel = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: #4b5563;
  margin-bottom: 16px;
`

const CurrentCard = styled.div`
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 14px;
  margin: 12px 0;
  font-size: 13px;
  color: #1f2937;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  display: flex;
  justify-content: space-between;
  gap: 12px;
`

const Controls = styled.div`
  display: flex;
  gap: 10px;
  margin: 16px 0 8px;
`

const BtnBase = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #1f2937;
  &:hover:not(:disabled) { background: #f3f4f6; }
  &:disabled { cursor: not-allowed; opacity: 0.6; }
`

const DangerBtn = styled(BtnBase)`
  border-color: #fca5a5;
  color: #991b1b;
  &:hover:not(:disabled) { background: #fef2f2; }
`

const SpeedRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 12px;
`

const Section = styled.div`
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
`

const SectionLabel = styled.div`
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
  margin-bottom: 8px;
`

const Table = styled.div`
  max-height: 360px;
  overflow: auto;
  border: 1px solid #f1f5f9;
  border-radius: 6px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
`

const TableHeader = styled.div`
  display: grid;
  grid-template-columns: 50px 1fr 80px 100px 80px 90px;
  padding: 6px 10px;
  background: #f9fafb;
  color: #6b7280;
  font-size: 11px;
  text-transform: uppercase;
  border-bottom: 1px solid #e5e7eb;
  position: sticky;
  top: 0;
  z-index: 1;
`

const Row = styled.div`
  display: grid;
  grid-template-columns: 50px 1fr 80px 100px 80px 90px;
  padding: 5px 10px;
  border-bottom: 1px solid #f9fafb;
  align-items: center;
  &:last-child { border-bottom: none; }
  &:hover { background: #f9fafb; }
`

const PhaseBadge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: ${p => ({
    done: '#15803d',
    failed: '#b91c1c',
    downloading: '#1d4ed8',
    licensing: '#6d28d9',
    resolving: '#7c2d12',
    queued: '#6b7280',
  }[p.$phase] || '#6b7280')};
`

const Counters = styled.div`
  margin-top: 12px;
  font-size: 13px;
  color: #4b5563;
  display: flex;
  gap: 20px;
`
const CounterItem = styled.span`
  & strong { color: #1f2937; }
`

const Banner = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 14px;
`

const ErrorBanner = styled(Banner)`
  background: #fef2f2;
  border-color: #fca5a5;
  color: #991b1b;
`

// Phase → icon + glyph used in the per-item row.
function phaseGlyph(phase) {
  switch (phase) {
    case 'done':        return <span style={{ color: '#15803d' }}>&#10003;</span>            // ✓
    case 'failed':      return <span style={{ color: '#b91c1c' }}>&#10007;</span>            // ✗
    case 'downloading': return <Clock size={12} />
    case 'licensing':   return <RefreshCw size={12} />
    case 'resolving':   return <RefreshCw size={12} />
    default:            return <span style={{ color: '#9ca3af' }}>&middot;</span>
  }
}

function phaseLabel(phase) {
  return {
    queued: 'queued',
    resolving: 'resolving',
    licensing: 'licensing',
    downloading: 'downloading',
    done: 'done',
    failed: 'failed',
  }[phase] || phase || '—'
}

/**
 * @param {{
 *   variant: string,
 *   snapshot: object | null,
 *   portStatus: string,
 *   portError: string | null,
 *   pendingAction: { action: string, sentAt: number } | null,
 *   reconnect: () => void,
 *   sendControl: (action: 'pause'|'resume'|'cancel') => Promise<any>,
 *   mismatched: boolean,
 *   mismatchInfo: null | { actualExportId, actualRunState, actualPipelineId, actualVariants }
 * }} props
 */
export default function StateD_InProgress({
  variant, snapshot, portStatus, portError, pendingAction,
  reconnect, sendControl, mismatched, mismatchInfo,
}) {
  const totals = useMemo(() => selectTotals(snapshot), [snapshot])
  const current = useMemo(() => selectCurrentItem(snapshot), [snapshot])
  const { speedMbps, etaMin } = useMemo(() => selectSpeedAndEta(snapshot), [snapshot])
  const [controlErr, setControlErr] = useState(null)

  const runState = snapshot?.run_state || 'running'
  const isPaused = runState === 'paused' || pendingAction?.action === 'pause'
  const isCancelling = runState === 'cancelling' || pendingAction?.action === 'cancel'
  const canInteract = !isCancelling && portStatus !== 'disconnected' && portStatus !== 'failed'

  const handleControl = useCallback(async (action) => {
    setControlErr(null)
    try {
      await sendControl(action)
    } catch (e) {
      setControlErr(`${action} failed: ${e.message}`)
    }
  }, [sendControl])

  // Single-run mismatch blocker — if the extension's snapshot shows a
  // DIFFERENT run, we refuse to show the live progress for the wrong
  // run and offer a "cancel other run" CTA.
  if (mismatched && mismatchInfo) {
    const variantList = mismatchInfo.actualVariants.length
      ? mismatchInfo.actualVariants.join(', ')
      : 'unknown'
    return (
      <Wrap>
        <Card>
          <Header>Another export is in progress</Header>
          <SubHeader>
            The Export Helper is currently running another export
            (Variant {variantList} · run state: {mismatchInfo.actualRunState}).
            Only one export can run at a time per the extension's queue.
          </SubHeader>
          <ErrorBanner>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Wait for the other export to finish, or cancel it here before
              starting a new one.
            </span>
          </ErrorBanner>
          <Controls>
            <DangerBtn
              type="button"
              onClick={() => handleControl('cancel')}
              disabled={!canInteract}
            >
              <Square size={14} /> Cancel other run
            </DangerBtn>
            <BtnBase type="button" onClick={reconnect}>
              <RefreshCw size={14} /> Refresh
            </BtnBase>
          </Controls>
          {controlErr && (
            <ErrorBanner>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{controlErr}</span>
            </ErrorBanner>
          )}
        </Card>
      </Wrap>
    )
  }

  // Loading state — Port connecting but no snapshot yet.
  if (!snapshot) {
    return (
      <Wrap>
        <Card>
          <Header>Exporting Variant {variant}</Header>
          <SubHeader>
            {portStatus === 'connecting' && 'Connecting to Export Helper…'}
            {portStatus === 'reconnecting' && 'Reconnecting to Export Helper…'}
            {portStatus === 'failed' && 'Could not connect.'}
            {portStatus === 'disconnected' && 'Disconnected.'}
            {portStatus === 'connected' && 'Waiting for first status update…'}
          </SubHeader>
          {(portStatus === 'failed' || portStatus === 'disconnected') && (
            <>
              <ErrorBanner>
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{portError || 'Unable to reach the Export Helper.'}</span>
              </ErrorBanner>
              <Controls>
                <BtnBase type="button" onClick={reconnect}>
                  <RefreshCw size={14} /> Retry
                </BtnBase>
              </Controls>
            </>
          )}
        </Card>
      </Wrap>
    )
  }

  const items = Array.isArray(snapshot.items) ? snapshot.items : []
  const pct = totals.bytesTotal > 0 ? Math.min(100, (totals.bytesDone / totals.bytesTotal) * 100) : 0

  return (
    <Wrap>
      <Card>
        <Header>Exporting Variant {variant}</Header>
        <SubHeader>
          Run state: {runState}
          {snapshot.target_folder ? ` · ${snapshot.target_folder}` : ''}
        </SubHeader>

        {(portStatus === 'reconnecting' || portStatus === 'disconnected') && (
          <Banner>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              {portStatus === 'reconnecting'
                ? 'Disconnected from Export Helper. Reconnecting…'
                : 'Disconnected from Export Helper. '}
              {portStatus === 'disconnected' && (
                <button type="button" onClick={reconnect}
                  style={{ background: 'none', border: 'none', color: '#92400e', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}>
                  Retry now
                </button>
              )}
            </span>
          </Banner>
        )}

        <Bar>
          <BarFill style={{ width: `${pct}%` }} $running={runState === 'running'} />
        </Bar>
        <BarLabel>
          <span>{totals.done} / {totals.total} done</span>
          <span>{formatBytes(totals.bytesDone)} / {formatBytes(totals.bytesTotal)}</span>
        </BarLabel>

        {current && current.phase !== 'done' && current.phase !== 'failed' && (
          <CurrentCard>
            <span>current: {current.target_filename}</span>
            <span>
              {current.phase === 'downloading' && current.total_bytes > 0
                ? `${formatBytes(current.bytes_received)} / ${formatBytes(current.total_bytes)}`
                : phaseLabel(current.phase)}
            </span>
          </CurrentCard>
        )}

        <SpeedRow>
          <span>speed: {speedMbps > 0 ? `${speedMbps.toFixed(1)} Mbps` : '—'}</span>
          <span>ETA: {etaMin != null ? `${etaMin} min` : '—'}</span>
        </SpeedRow>

        <Controls>
          {isPaused ? (
            <BtnBase type="button" onClick={() => handleControl('resume')}
                     disabled={!canInteract || !!pendingAction}>
              <Play size={14} />
              {pendingAction?.action === 'resume' ? 'Resuming…' : 'Resume'}
            </BtnBase>
          ) : (
            <BtnBase type="button" onClick={() => handleControl('pause')}
                     disabled={!canInteract || !!pendingAction}>
              <Pause size={14} />
              {pendingAction?.action === 'pause' ? 'Pausing…' : 'Pause'}
            </BtnBase>
          )}
          <DangerBtn type="button" onClick={() => handleControl('cancel')}
                     disabled={!canInteract || isCancelling}>
            <Square size={14} />
            {isCancelling ? 'Cancelling…' : 'Cancel'}
          </DangerBtn>
        </Controls>

        {controlErr && (
          <ErrorBanner>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{controlErr}</span>
          </ErrorBanner>
        )}

        <Section>
          <SectionLabel>Item status</SectionLabel>
          <Table>
            <TableHeader>
              <span>#</span>
              <span>Filename</span>
              <span>Source</span>
              <span>Phase</span>
              <span>Progress</span>
              <span>Speed</span>
            </TableHeader>
            {items.map(it => {
              const pctItem = it.total_bytes > 0 ? (it.bytes_received / it.total_bytes) * 100 : 0
              return (
                <Row key={`${it.source}|${it.source_item_id}`}>
                  <span>{String(it.seq).padStart(3, '0')}</span>
                  <span title={it.target_filename}
                    style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {it.target_filename}
                  </span>
                  <span>{it.source}</span>
                  <PhaseBadge $phase={it.phase}>
                    {phaseGlyph(it.phase)} {phaseLabel(it.phase)}
                  </PhaseBadge>
                  <span>
                    {it.phase === 'downloading' && it.total_bytes > 0
                      ? `${Math.round(pctItem)}%`
                      : it.phase === 'done'
                        ? formatBytes(it.bytes_received || 0)
                        : '—'}
                  </span>
                  <span>{it.phase === 'downloading' ? '…' : '—'}</span>
                </Row>
              )
            })}
          </Table>
        </Section>

        <Counters>
          <CounterItem><strong>{totals.done}</strong> ok</CounterItem>
          <CounterItem><strong>{totals.failed}</strong> failed</CounterItem>
          <CounterItem><strong>{totals.remaining}</strong> remaining</CounterItem>
        </Counters>
      </Card>
    </Wrap>
  )
}
```

Why each piece:
- `useMemo` wraps every selector — aggregate derivation runs only when `snapshot` reference changes (which it does on every reducer dispatch that mutates, so the derivation is still per-message, but the derivation cost is bounded and doesn't fan out).
- Bar pulse animation when running — visual confirmation the run is live. Halts naturally when the snapshot reference stops changing (e.g., paused).
- `$phase` prop on `PhaseBadge` — styled-components transient prop (`$` prefix), won't leak to the DOM.
- `CSS max-height: 360px; overflow: auto` on the Table — scrolls at ~15 visible rows. At 300 items (Ext.5's spec cap), that's 20x, which is fine.
- Single-run-active blocker rendered BEFORE the in-progress UI guards against accidentally showing both.
- Speed + ETA show `—` when `speedMbps === 0` (first few seconds before a meaningful rate is observed); prevents flickering "0.0 Mbps / 999 min" early on.

- [ ] **Step 2: Verify the file exists**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
ls -la src/components/export/StateD_InProgress.jsx
wc -l src/components/export/StateD_InProgress.jsx
# Expected: ~420 lines
```

JSX doesn't parse via `node --check`; the real verification is in Task 8 (manual).

- [ ] **Step 3: Commit**

```bash
git add src/components/export/StateD_InProgress.jsx
git commit -m "$(cat <<'EOF'
feat(export): StateD_InProgress — live-progress UI

Renders the spec's State D mockup:
  · total progress bar with bytes + count overlay
  · current-item card (filename + bytes)
  · per-item status table (CSS-scrollable, max-height 360)
  · pause / resume / cancel buttons with optimistic UI
  · speed + ETA (shows "—" until a meaningful rate is observable)
  · done / failed / remaining counters
  · reconnect banner on Port disconnect
  · single-run-active blocker when the extension is running a
    different export

useMemo wraps all three selectors so aggregate derivation only runs
on snapshot reference changes. CSS scroll area is sufficient at the
extension's 300-item hard cap — no virtualization dep introduced.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: State E / F placeholder components

Tiny stubs. Render raw text dumps of the completion payload so the next plan has something concrete to replace. Both carry a visible "WebApp.1 Phase C (next plan)" banner so anyone reading the UI mid-development knows this is a stub.

**Files:**
- Create: `src/components/export/StateE_Complete_Placeholder.jsx`
- Create: `src/components/export/StateF_Partial_Placeholder.jsx`

- [ ] **Step 1: Write `src/components/export/StateE_Complete_Placeholder.jsx`**

```jsx
import styled from 'styled-components'
import { CheckCircle2 } from 'lucide-react'

// Spec § State E. Phase B ships a PLACEHOLDER — the real UI (open
// folder button, XML download links, "How to import in Premiere"
// tutorial link) lives in the next webapp plan which also wires
// XMEML generation via WebApp.2.

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

const StubBanner = styled.div`
  background: #eff6ff;
  border: 1px dashed #93c5fd;
  color: #1e3a8a;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  margin-bottom: 16px;
`

const Header = styled.h1`
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 12px;
  color: #15803d;
`

const Detail = styled.pre`
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px 14px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #1f2937;
  white-space: pre-wrap;
  overflow-x: auto;
  margin: 6px 0;
`

export default function StateE_Complete_Placeholder({ complete }) {
  const ok = complete?.ok_count ?? 0
  const folder = complete?.folder_path ?? '(none)'
  const xmls = Array.isArray(complete?.xml_paths) ? complete.xml_paths : []

  return (
    <Wrap>
      <Card>
        <StubBanner>
          WebApp.1 Phase C placeholder — full State E UI lands in the next
          plan (open-folder button, XML download links, Premiere import
          tutorial). This stub renders raw completion fields.
        </StubBanner>
        <Header>
          <CheckCircle2 size={22} /> Export complete
        </Header>
        <Detail>ok_count: {ok}</Detail>
        <Detail>folder: {folder}</Detail>
        <Detail>xml_paths: {xmls.length ? xmls.join('\n') : '(none)'}</Detail>
      </Card>
    </Wrap>
  )
}
```

- [ ] **Step 2: Write `src/components/export/StateF_Partial_Placeholder.jsx`**

```jsx
import styled from 'styled-components'
import { AlertCircle } from 'lucide-react'

// Spec § State F. Phase B ships a PLACEHOLDER — the real UI
// (per-failure diagnostics, "Retry failed items" / "Generate XML
// anyway" / "Report issue" controls + diagnostic bundle) lives in
// the next webapp plan.

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

const StubBanner = styled.div`
  background: #eff6ff;
  border: 1px dashed #93c5fd;
  color: #1e3a8a;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  margin-bottom: 16px;
`

const Header = styled.h1`
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 12px;
  color: #b45309;
`

const Detail = styled.pre`
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px 14px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #1f2937;
  white-space: pre-wrap;
  overflow-x: auto;
  margin: 6px 0;
`

export default function StateF_Partial_Placeholder({ complete, snapshot }) {
  const ok = complete?.ok_count ?? 0
  const fail = complete?.fail_count ?? 0
  const folder = complete?.folder_path ?? '(none)'
  const failedItems = Array.isArray(snapshot?.items)
    ? snapshot.items.filter(it => it.phase === 'failed')
    : []

  return (
    <Wrap>
      <Card>
        <StubBanner>
          WebApp.1 Phase C placeholder — full State F UI lands in the next
          plan (per-failure diagnostics, retry / generate-anyway / report-
          issue controls, diagnostic bundle). This stub renders raw
          failure fields.
        </StubBanner>
        <Header>
          <AlertCircle size={22} /> Export partial — {fail} item{fail === 1 ? '' : 's'} failed
        </Header>
        <Detail>ok_count: {ok}</Detail>
        <Detail>fail_count: {fail}</Detail>
        <Detail>folder: {folder}</Detail>
        <Detail>
          failed items:
          {'\n'}
          {failedItems.length
            ? failedItems.map(it => `  · ${it.target_filename} — ${it.error_code || 'unknown'}`).join('\n')
            : '  (extension did not report failed item list)'}
        </Detail>
      </Card>
    </Wrap>
  )
}
```

- [ ] **Step 3: Verify files exist**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
ls -la src/components/export/StateE_Complete_Placeholder.jsx src/components/export/StateF_Partial_Placeholder.jsx
```

- [ ] **Step 4: Commit**

```bash
git add src/components/export/StateE_Complete_Placeholder.jsx src/components/export/StateF_Partial_Placeholder.jsx
git commit -m "$(cat <<'EOF'
feat(export): State E + F placeholder components

Tiny stubs for the two terminal states. Each renders a visible
"WebApp.1 Phase C placeholder" banner + raw dump of the relevant
completion fields (ok_count, fail_count, folder_path, xml_paths,
failed-item list).

Real E (open-folder + XML links + Premiere tutorial) and F (per-
failure diagnostics + retry/generate-anyway/report-issue + diagnostic
bundle) ship in the next webapp plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend `src/pages/ExportPage.jsx` — wire State D/E/F

Extend the FSM. Drop `'starting'` (or keep as a pre-Port transitional state), add `state_d | state_e | state_f`. On mount of `state_d`, wire `useExportPort`. On `complete` payload, dispatch the FSM to `state_e` (fail_count === 0) or `state_f`.

**Files:**
- Modify: `src/pages/ExportPage.jsx`

- [ ] **Step 1: Read the existing `src/pages/ExportPage.jsx`**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
head -100 src/pages/ExportPage.jsx
```

Phase A's FSM has phases `'init'|'state_a'|'state_b'|'state_c'|'starting'`. We extend to `'init'|'state_a'|'state_b'|'state_c'|'state_d'|'state_e'|'state_f'`.

- [ ] **Step 2: Edit reducer phases**

Use Edit tool. Locate the existing reducer's `export_started` action:

```js
case 'export_started':        return { ...state, phase: 'starting', export_id: action.export_id }
```

Replace with:
```js
case 'export_started':        return { ...state, phase: 'state_d', export_id: action.export_id, run_id: action.run_id || null }
case 'export_completed':      {
  const fail = action.payload?.fail_count ?? 0
  return { ...state, phase: fail > 0 ? 'state_f' : 'state_e', complete_payload: action.payload }
}
```

Extend `initialState` to add `run_id: null, complete_payload: null`.

- [ ] **Step 3: Import the new components + hook**

Near the top of the file, after the existing Phase-A imports, add:

```jsx
import StateD_InProgress from '../components/export/StateD_InProgress.jsx'
import StateE_Complete_Placeholder from '../components/export/StateE_Complete_Placeholder.jsx'
import StateF_Partial_Placeholder from '../components/export/StateF_Partial_Placeholder.jsx'
import { useExportPort } from '../hooks/useExportPort.js'
```

- [ ] **Step 4: Drop the old `Starting` styled-component block**

Find and remove the old block:

```jsx
const Starting = styled.div`
  ...
`
```

It's replaced by State D.

- [ ] **Step 5: Replace the `starting` phase render with State D/E/F wiring**

Replace the final block of the render function:

```jsx
  // Starting — placeholder. Real State D lands once Ext.5's Port
  // is live and the next webapp plan is executed.
  if (state.phase === 'starting') {
    return (
      <Starting>
        <h1>Export started</h1>
        ...
      </Starting>
    )
  }

  return <ErrorBox>Unknown phase: {state.phase}</ErrorBox>
}
```

With:

```jsx
  // States D / E / F — live-progress + terminal placeholders.
  if (state.phase === 'state_d' || state.phase === 'state_e' || state.phase === 'state_f') {
    return (
      <ActiveRun
        variant={variant}
        exportId={state.export_id}
        expectedRunId={state.run_id}
        phase={state.phase}
        completePayload={state.complete_payload}
        onComplete={(payload) => dispatch({ type: 'export_completed', payload })}
      />
    )
  }

  return <ErrorBox>Unknown phase: {state.phase}</ErrorBox>
}

// ActiveRun wraps the State D / E / F rendering so that useExportPort
// is mounted only while we're actually in those phases. Pulling this
// out as a child component keeps ExportPage.jsx's FSM clean — the Port
// lifecycle lives only for the duration of the active run.
function ActiveRun({ variant, exportId, expectedRunId, phase, completePayload, onComplete }) {
  const port = useExportPort({ exportId, expectedRunId })

  // When the Port reports completion, notify parent to transition FSM.
  useEffect(() => {
    if (port.complete && phase === 'state_d') {
      onComplete(port.complete)
    }
  }, [port.complete, phase, onComplete])

  if (phase === 'state_e') {
    return <StateE_Complete_Placeholder complete={completePayload} />
  }
  if (phase === 'state_f') {
    return <StateF_Partial_Placeholder complete={completePayload} snapshot={port.snapshot} />
  }
  // state_d
  return (
    <StateD_InProgress
      variant={variant}
      snapshot={port.snapshot}
      portStatus={port.portStatus}
      portError={port.portError}
      pendingAction={port.pendingAction}
      reconnect={port.reconnect}
      sendControl={port.sendControl}
      mismatched={port.mismatched}
      mismatchInfo={port.mismatchInfo}
    />
  )
}
```

Why `ActiveRun` as a sub-component:
- `useExportPort` opens a Port on mount. If we put the hook directly in `ExportPage`, it would try to open the Port BEFORE the user clicked Start Export (i.e., during State A/B/C). Wrapping in a sub-component that renders only when `phase ∈ {state_d, state_e, state_f}` ensures the Port is opened exactly when needed and torn down when the user navigates away.
- The `onComplete` callback bubbles the completion payload up to the parent FSM so it can dispatch the right transition. Kept as a callback so the parent owns the FSM.

- [ ] **Step 6: Adjust the `onStart` callback**

The Phase-A `onStart` already handles the POST /api/exports + sendSession + sendExport chain; we just need to pass the extension's returned `runId` (if any) into the `export_started` dispatch:

Find the `onStart` block in ExportPage.jsx:
```js
const exportRow = await apiPost('/exports', { ... })
const exportId = exportRow.export_id
...
await ext.sendExport({ ... })
dispatch({ type: 'export_started', export_id: exportId })
```

Change the last line to:
```js
// Ext.5 returns { ok:true, run_id: '...' } on successful accept.
// If not provided (older extension builds), we still transition to
// State D — useExportPort will get the runId from the first snapshot.
const maybeResponse = await ext.sendExport({
  export_id: exportId,
  manifest: unifiedManifest.items,
  target_folder: targetFolder,
  options: { ...options, variants: variantLabels },
})
dispatch({
  type: 'export_started',
  export_id: exportId,
  run_id: maybeResponse?.run_id || null,
})
```

(Remove the duplicate `await ext.sendExport(...)` call — there was already one above; we keep just the one that captures the response.)

- [ ] **Step 7: Verify the file exists + parses imports**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
grep -c "StateD_InProgress\|StateE_Complete\|StateF_Partial\|useExportPort" src/pages/ExportPage.jsx
# Expected: at least 4 (one import per + at least one usage each)
grep -c "state_d\|state_e\|state_f" src/pages/ExportPage.jsx
# Expected: at least 6 (phase checks + transitions)
```

- [ ] **Step 8: Commit**

```bash
git add src/pages/ExportPage.jsx
git commit -m "$(cat <<'EOF'
feat(export): ExportPage FSM extends into state_d / state_e / state_f

Drops the Phase-A 'starting' placeholder in favor of state_d — the
live-progress UI powered by useExportPort. Adds state_e (complete)
and state_f (partial) as transitional phases for the two placeholder
components.

export_completed reducer action reads fail_count from the complete
payload to route to state_e (0 failures) vs state_f (partial).

ActiveRun sub-component mounts useExportPort ONLY when phase is in
the active trio so the Port isn't opened speculatively during
pre-flight A/B/C.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update `src/components/export/README.md`

Phase A's README documents States A/B/C. Extend with State D/E/F scope + the Port reconnect + single-run-active + throttle notes so the next person picking this up doesn't have to re-read the full spec.

**Files:**
- Modify: `src/components/export/README.md`

- [ ] **Step 1: Read the current README**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
cat src/components/export/README.md
```

- [ ] **Step 2: Append Phase B section**

Use the Edit tool. Append to the end of the file (after the existing content):

```markdown

## Phase B additions — State D (in-progress) + terminal placeholders

State D is the live-progress UI, built on a long-lived `chrome.runtime.Port`.

| State | Renders when | Component | Notes |
|---|---|---|---|
| **D** | user clicked Start → extension has an active run | `StateD_InProgress.jsx` | spec § State D mockup |
| **E** | extension reports `{type:"complete"}` with `fail_count === 0` | `StateE_Complete_Placeholder.jsx` | placeholder; real UI in next plan |
| **F** | extension reports `{type:"complete"}` with `fail_count > 0` | `StateF_Partial_Placeholder.jsx` | placeholder; real UI in next plan |

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

### State E/F are placeholders

Both components render raw dumps of the completion fields with a visible blue dashed banner. The real UI (open-folder button, XML download links, "How to import in Premiere" tutorial, per-failure diagnostics, retry) ships in the next webapp plan (Phase C / State E+F).
```

- [ ] **Step 3: Commit**

```bash
git add src/components/export/README.md
git commit -m "$(cat <<'EOF'
docs(export): README extension for Phase B (State D + E/F placeholders)

Documents the Port message contract, reconnect policy (2 auto-retries
then user-gated), single-run-active detection, and the "no
virtualization" decision so the next person picking this up doesn't
have to re-read the spec.

Makes it explicit that E + F are placeholders — anyone expecting a
full terminal UI in Phase B gets redirected to the next plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Manual end-to-end verification (no commit)

This task is the Phase B acceptance gate. Requires Ext.5 loaded unpacked with its queue + Port broadcasting working. The ext's test handler (or a real small manifest) drives an end-to-end smoke.

**Prereq:** Backend dev server on port 3001 (do NOT kill). Ext.5 extension loaded unpacked at the pinned ID. `extension/.extension-id` on branch OR `VITE_EXTENSION_ID` set.

- [ ] **Step 1: Start the vite dev server**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
npm install  # if node_modules is fresh
npm run dev:client
# OR with env override:
# VITE_EXTENSION_ID=abcdefghijklmnopqrstuvwxyzabcdef npm run dev:client
```

Expected: `Local: http://localhost:5173/`. No console errors about `__EXTENSION_ID__`.

- [ ] **Step 2: Drive Phase A through to Start**

With a real `plan_pipeline_id` + variant (same as Phase A's Task 10):
1. Navigate to `http://localhost:5173/editor/${PID}/export?variant=C`.
2. Expect State A → B → C (depending on extension state and manifest content).
3. Manually click **I'm already signed in — continue** if State B is shown (Phase A compromise).
4. At State C, click **Start Export**.
5. Expect the page to transition to State D with the progress card.

- [ ] **Step 3: State D initial render**

Expected visual:
- Header: "Exporting Variant C" with `Run state: running · <folder>` sub-header.
- Progress bar (empty at first, fills as items complete).
- Current-item card showing the filename of the active downloader.
- Speed `—` / ETA `—` for the first ~5 s, then real values.
- Pause + Cancel buttons (Resume appears after Pause is clicked).
- Per-item table with all items listed, sticky header, scrollable.
- Counters: `0 ok · 0 failed · N remaining`.

If the table is empty or the snapshot isn't rendering:
- Open DevTools → Network → filter by `websocket`/`chrome-extension://` — there's no wire trace for Port, but errors in the SW console are visible.
- Open Chrome → `chrome://extensions` → Export Helper → click **service worker** link → SW console should log `port connected (export-tap)` and the initial `state` broadcast.

- [ ] **Step 4: Progress updates live**

Let the run continue:
- Items should move from `queued → resolving → licensing → downloading → done`.
- Per-item Progress column shows `XX%` during downloading, then `XX MB` when done.
- Total progress bar advances.
- Speed settles around the real throughput.

- [ ] **Step 5: Pause / Resume round-trip**

1. Click **Pause** — button immediately shows "Pausing…" (optimistic).
2. Within ~1 s, button flips to **Resume** and `Run state: paused` in the sub-header.
3. Click **Resume** — button shows "Resuming…", then flips back to Pause.
4. No in-flight downloads should cancel during pause — the spec says "in-flight continues but no new pulls."

- [ ] **Step 6: Close tab, reopen → reconnect works**

1. With run still in progress, close the tab.
2. Open a new tab to the SAME URL: `http://localhost:5173/editor/${PID}/export?variant=C`.
3. Expected: pre-flight A/B/C re-renders quickly, then Start Export is displayed — but we WANT the page to detect the already-running export.
4. **This is a known limitation of Phase B scope:** the page's FSM only enters State D after clicking Start Export. If the user simply reopens, they'll see State C again. Workaround for now: they click Start Export, the extension detects its active run and returns the same `run_id`; the page enters State D and `useExportPort` connects + sends `{type:"status"}` which returns the in-progress snapshot. The UI rehydrates and shows current progress.
5. A follow-up could add a "resume existing export" check in State C's pre-flight — capture this in the open questions.
6. Verify: after re-clicking Start Export in the reopened tab, the progress card should show the ACTUAL in-progress state (not restart from 0).

- [ ] **Step 7: Cancel → terminal**

1. Click **Cancel**. `window.confirm` dialog appears — click OK.
2. Button flips to "Cancelling…"; then `Run state: cancelling`.
3. Eventually extension broadcasts `{type:"complete", ok_count, fail_count: ...}`.
4. Page transitions to State E (if no failures) or State F (if any). Raw-dump placeholder should appear with the ok/fail/folder/xml counts.

- [ ] **Step 8: Let a run complete naturally**

1. Reset. Start a small real export (use a manifest with, say, 3 items — preferably Pexels since Envato burns licenses).
2. Let it run to completion without pause/cancel.
3. Page should transition to State E with `ok_count: 3 · fail_count: 0 · folder: ... · xml_paths: (none)`.

- [ ] **Step 9: Induce a failure → State F**

1. Start a run with at least one intentionally broken item (e.g., a Pexels ID that 404s from `/api/pexels-url`).
2. Let the run finish.
3. Page should transition to State F. Failed items list should include the broken one with its `error_code`.

- [ ] **Step 10: Mismatch blocker**

1. Have Ext.5 running an active export (from Step 8 or re-triggered).
2. While that export is live, open a DIFFERENT export URL (different `?variant`).
3. Click Start Export in the second tab.
4. Expected: the second tab's State D renders the **mismatch blocker** ("Another export is in progress for Variant X") with a "Cancel other run" button.
5. Click "Cancel other run" — after confirming, the first tab's run terminates, and both tabs can be refreshed clean.

- [ ] **Step 11: Reconnect banner manually**

1. Start a run (State D live).
2. In `chrome://extensions`, click **service worker → Stop**, then **Start** (simulates SW death + revival).
3. Expect: page briefly shows "Disconnected from Export Helper. Reconnecting…" banner, then recovers on the next successful connect.
4. If the Port can't reopen, the banner should show a "Retry now" button that, when clicked, attempts reconnect again.

- [ ] **Step 12: DO NOT commit anything from this task**

No code changes. Verification only.

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

If anything changed during debugging, either revert or land as a proper task.

---

## Task 9: Self-review against the spec + full branch review

- [ ] **Step 1: Spec coverage walk**

Re-read `docs/specs/2026-04-23-envato-export-design.md` § "State D — Export running" and map each bullet to an implementation anchor:

> `████████████░░░░░░░░░░░░░░░░  12 / 47 done · 2.1 / 8.5 GB`

→ `StateD_InProgress.jsx` `Bar` + `BarLabel` components. Driven by `selectTotals(snapshot)`. ✓

> `current: 012_NX9WYGQ.mov  (83 MB)`

→ `CurrentCard` driven by `selectCurrentItem(snapshot)`. ✓

> `speed: 95 Mbps · ETA 18 min`

→ `SpeedRow` driven by `selectSpeedAndEta(snapshot)`. ✓

> `[ Pause ]   [ Cancel ]`

→ `Controls` with `handleControl` → `sendControl` (hook). Pause becomes Resume after click. ✓

> `── item status ──`
> `✓ 001_pexels_123.mp4         46 MB   ·  4.8 s`
> `⏳ 012_NX9WYGQ.mov            21 / 83 MB ·  25%`
> `· 013_pexels_456.mp4`

→ `Table` + `Row` with `phaseGlyph` + per-row progress %. ✓

> `── done counts ──`
> `12 ok · 0 failed · 35 remaining`

→ `Counters` driven by `selectTotals`. ✓

> "Page can be closed; extension keeps running. On reopen, page reconnects, queries extension for current state, resumes showing progress."

→ `useExportPort` + `{type:"status"}` round-trip on mount + reconnect. See Task 8 § Step 6 for the known limitation (requires user to re-click Start Export in the reopened tab because State D entry is gated on the FSM transition; captured as an open question for follow-up).

Roadmap § WebApp.1 State D ("needs Ext.5's Port messages"):
- `{type:"state"}` snapshot consumption ✓
- `{type:"progress"}` per-item deltas ✓
- `{type:"item_done"}` terminal per-item ✓
- `{type:"complete"}` run terminal ✓

Spec § "Concurrency + queue constraints":
- "One active export per user at a time" → mismatch blocker ✓

Spec § "How web app talks to extension":
- Port connect via `chrome.runtime.connect` ✓
- `{type:"status"}` from web app to force a snapshot ✓
- `{type:"pause"|"resume"|"cancel"}` one-shot ✓

- [ ] **Step 2: Full branch review**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/export-page-state-d"
git log --oneline $(git merge-base HEAD main)..HEAD
# (Or against the Phase-A branch if that's the base.)
# Expected: 7 commits — Task 1, 2, 3, 4, 5, 6, 7. Tasks 0, 8, 9 do not
# produce commits (worktree setup, manual verification, self-review).
```

```bash
git diff $(git merge-base HEAD main) --stat
# Expected additions (approximate):
#   src/components/export/README.md                      |  70+
#   src/components/export/StateD_InProgress.jsx         | 420+
#   src/components/export/StateE_Complete_Placeholder.jsx | 70+
#   src/components/export/StateF_Partial_Placeholder.jsx  | 80+
#   src/components/export/progressState.js               | 180+
#   src/hooks/useExportPort.js                           | 220+
#   src/hooks/useExtension.js                            |  70+
#   src/pages/ExportPage.jsx                             |  50+
```

Sanity checks:
- No files added outside `src/components/export/`, `src/hooks/`, `src/pages/`. If anything else surfaces, investigate.
- No changes under `extension/` (Ext.5's territory).
- No `package.json` changes (no new deps — confirm against "Working conventions").
- No schema or backend route changes (Phase B is purely frontend).

- [ ] **Step 3: DO NOT push**

Per user convention: `git push` requires explicit consent. This task's acceptance is "all commits on the local branch, branch ready for review."

---

## Self-review against the spec

After completing Tasks 0–9, re-read `docs/specs/2026-04-23-envato-export-design.md` § State D and `docs/specs/2026-04-24-export-remaining-roadmap.md` § WebApp.1.

Coverage summary:
- State D mockup (progress bar, current item, speed/ETA, pause/cancel, per-item table, counters) → `StateD_InProgress.jsx` ✓
- Long-lived `chrome.runtime.Port` consumption → `useExportPort` + `useExtension.openPort` ✓
- Message contract (`state` / `progress` / `item_done` / `complete`) → `progressReducer` actions + `useExportPort` dispatch ✓
- Tab close / reopen reconnect → `useExportPort` mount effect sends `{type:"status"}` on both fresh connect AND reconnect ✓ (with the known limitation that entering State D still requires the user to re-Start; captured in open questions)
- Pause / resume / cancel → `sendControl` via one-shot `chrome.runtime.sendMessage` ✓, optimistic UI via `pendingAction` ✓
- Single active run per user → `mismatched` + `mismatchInfo` in `useExportPort`, mismatch blocker in `StateD_InProgress` ✓
- State E / F placeholders → two stub files with visible dashed banner ✓
- No new runtime deps ✓ (audited in Task 9 Step 2)
- No extension-tree mutations ✓
- FSM transitions (`state_d → state_e` on `fail_count === 0`, `→ state_f` otherwise) ✓

Resolved in this plan:
- Port lifecycle ownership → `useExportPort` (hook owns connect/disconnect + reconnect retries).
- Render budget / no-virtualization decision → CSS `max-height + overflow:auto`, 300-item hard cap from extension.
- Optimistic UI for control actions → `pendingAction` reducer field with auto-clear on echo.
- Cancel UX → `window.confirm`, no styled modal.

Open questions (captured for the next plan):
1. **Cold-reopen into State D.** Currently, reopening `/editor/:id/export?variant=C` mid-run forces the user to re-click Start Export to re-enter State D, after which `useExportPort` rehydrates. A nicer UX would be a State C pre-flight check: if `ext.ping()` reports an active run for this `(pipeline_id, variant)`, skip directly to State D. Needs Ext.5's ping to include active-run info. Out of Phase B scope; list for next plan.
2. **Retry UI (State F).** The spec's State F mockup has a "Retry failed items" button. Requires the extension to support `{type:"retry", item_ids:[]}`. Ext.5's plan doesn't include this — capture as input for Ext.7 (failure-mode polish) OR next webapp plan.
3. **Multi-tab "export already in progress" banner** for two tabs on the SAME run (vs. the mismatch case which is two DIFFERENT runs). Needs BroadcastChannel or similar coordination. Defer.
4. **XMEML kickoff from State E.** Depends on WebApp.2's `POST /api/exports/:id/generate-xml`. Next plan.
5. **Rolling-window throughput** instead of the instant throughput `selectSpeedAndEta` produces. If users report flaky speed numbers, swap for a windowed calculator (`last 10 s of bytes_received deltas`). Add only if reported.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-webapp-export-page-state-d.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
