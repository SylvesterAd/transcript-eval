# B-Roll Editor Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add delete+undo/redo, persist all user edits across sessions, fix Pexels preview playback, add copy/paste/cross-variant drag with soft displacement, and add lazy loading with loading-state feedback to the B-Roll editor at `/editor/:id/brolls/edit`.

**Architecture:** Single new Postgres table `broll_editor_state` per plan pipeline holds a JSON blob of all user state (edits, user-created placements, undo/redo stacks) with optimistic-concurrency versioning. Reducer is refactored around a single `APPLY_ACTION` entrypoint that logs inverses so every mutation can be undone. Soft displacement is computed render-time-only in `matchPlacementsToTranscript` — not persisted — so "spring-back" is automatic when the causing fixed clip is removed.

**Tech Stack:** Node + Express + Postgres (via `pg` pool) on server; Vite + React 19 on client; `@supabase/supabase-js` for auth; no test framework (manual verification per task).

**Spec:** [`docs/specs/2026-04-23-broll-edit-features-design.md`](../specs/2026-04-23-broll-edit-features-design.md)

**Branch / worktree:** `feature/broll-edit-features` in `.worktrees/broll-edit-features/`.

---

## Conventions for this plan

1. **No test framework:** Each task has an explicit manual verification step. You will need the dev server running: `npm run dev` from the worktree root (starts server on default port + Vite).
2. **Commit after every task.** Never batch. Use concise conventional-commit prefixes: `feat(broll):`, `fix(broll):`, `refactor(broll):`, `chore(broll):`.
3. **Exact paths everywhere.** All file paths are relative to the worktree root `/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/broll-edit-features/` unless absolute.
4. **Don't push without explicit user approval** (per `feedback_coding_style.md`).
5. **Read before editing.** Each task lists modified files — read them first to understand current structure.

---

## File Structure Overview

### New files

| Path | Purpose | Phase |
|------|---------|-------|
| `src/components/editor/brollClipboard.js` | In-memory + localStorage-mirrored clipboard singleton | B |
| `src/components/editor/BRollContextMenu.jsx` | Right-click context menu component | B |
| `src/components/editor/brollPreloader.js` | LRU cache of `<link rel=preload as=video>` tags | C |

### Modified files

| Path | Changes |
|------|---------|
| `server/schema-pg.sql` | Add `broll_editor_state` table definition |
| `server/db.js` | Add runtime `CREATE TABLE IF NOT EXISTS` for existing DBs |
| `server/services/broll.js` | Add `loadBrollEditorState`, `saveBrollEditorState`, `searchUserPlacement`; extend `getBRollEditorData` |
| `server/routes/broll.js` | Add `GET`/`PUT /pipeline/:pid/editor-state`; `POST /pipeline/:pid/search-user-placement` |
| `src/components/editor/useBRollEditorState.js` | Reducer refactor: new state (edits, userPlacements, undoStack, redoStack, version, dirty); new actions (LOAD_EDITOR_STATE, APPLY_ACTION, UNDO, REDO, MERGE_REMOTE_STATE, SAVE_SUCCESS); debounced save |
| `src/components/editor/brollUtils.js` | Extend `matchPlacementsToTranscript` with edits filter/override and two-pass soft-displacement |
| `src/components/editor/BRollEditor.jsx` | Editor-state fetch on mount, keyboard handlers (Delete/Backspace, CMD+Z/Y, CMD+C/X/V), undo/redo toolbar, preloader wiring, beforeunload flush |
| `src/components/editor/BRollTrack.jsx` | Dispatch APPLY_ACTION on drag/resize end; context menu trigger; cross-variant drag with yellow insertion marker + ghost clone; "copied" corner badge |
| `src/components/editor/BRollPreview.jsx` | URL order fix, onerror fallback chain, loading-state backdrop |
| `src/components/editor/BRollDetailPanel.jsx` | Support user placements (Retry calls new endpoint); alternative preload; "Reset to original" button |

---

## Phase A — Persistence Foundation + Delete/Undo + Pexels Fix

Tasks 1–14. Delivers: manual edits stop disappearing; delete with keyboard + context menu; undo/redo with persistence; Pexels preview works.

---

### Task 1: Add `broll_editor_state` table to schema

**Files:**
- Modify: `server/schema-pg.sql` (append after the existing `broll_example_sources` block, ~line 317)

- [ ] **Step 1: Read the file to locate the insertion point**

Run: open the file and scroll to the end. The last existing table is `broll_example_sources`. Append the new block at EOF.

- [ ] **Step 2: Append the new table definition**

Add at end of `server/schema-pg.sql`:

```sql

-- B-Roll editor state: persisted per-pipeline user edits, user placements, undo/redo
CREATE TABLE IF NOT EXISTS broll_editor_state (
  plan_pipeline_id TEXT PRIMARY KEY,
  state_json       TEXT    NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 1,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 3: Commit**

```bash
git add server/schema-pg.sql
git commit -m "feat(broll): add broll_editor_state schema"
```

---

### Task 2: Add runtime CREATE TABLE for existing DBs

**Files:**
- Modify: `server/db.js:66-88` (inside the "Migrations for existing databases" block)

- [ ] **Step 1: Read `server/db.js` around the migrations block**

- [ ] **Step 2: Insert new runtime migration after the `broll_searches` CREATE INDEX line** (~line 87)

Find the line `await pool.query(\`CREATE INDEX IF NOT EXISTS idx_broll_searches_batch ON broll_searches(batch_id)\`)` and append directly after it (still inside the try block):

```js
    await pool.query(`CREATE TABLE IF NOT EXISTS broll_editor_state (
      plan_pipeline_id TEXT PRIMARY KEY,
      state_json       TEXT    NOT NULL DEFAULT '{}',
      version          INTEGER NOT NULL DEFAULT 1,
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )`)
```

- [ ] **Step 3: Start the dev server and verify the table was created**

```bash
npm run dev:server
```

In another terminal:

```bash
PGPASSWORD="$DATABASE_PASSWORD" psql "$DATABASE_URL" -c "\d broll_editor_state"
```

Expected: table definition printed with `plan_pipeline_id`, `state_json`, `version`, `updated_at` columns. If the connection command fails, just verify the server startup log shows `[db] Schema initialized` without error.

- [ ] **Step 4: Stop the dev server and commit**

```bash
git add server/db.js
git commit -m "feat(broll): create broll_editor_state table at server boot"
```

---

### Task 3: Service functions `loadBrollEditorState` and `saveBrollEditorState`

**Files:**
- Modify: `server/services/broll.js` — append new exports near other editor data helpers (search for `export async function getBRollEditorData` and place new functions just before it).

- [ ] **Step 1: Read `server/services/broll.js` around `getBRollEditorData`**

- [ ] **Step 2: Add both functions**

Insert these two functions immediately above the `export async function getBRollEditorData(planPipelineId) {` line:

```js
/**
 * Load the editor state blob for a plan pipeline.
 * Returns { state, version } — empty object and version 0 if no row yet.
 */
export async function loadBrollEditorState(planPipelineId) {
  const row = await db.prepare(
    `SELECT state_json, version FROM broll_editor_state WHERE plan_pipeline_id = ?`
  ).get(planPipelineId)
  if (!row) return { state: {}, version: 0 }
  let state = {}
  try { state = JSON.parse(row.state_json || '{}') } catch {}
  return { state, version: row.version }
}

/**
 * Save the editor state blob with optimistic concurrency.
 * If expectedVersion does not match the current row's version, returns
 * { status: 'conflict', state, version } without writing.
 * On success returns { status: 'ok', version: newVersion }.
 */
export async function saveBrollEditorState(planPipelineId, state, expectedVersion) {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    const cur = await client.query(
      `SELECT state_json, version FROM broll_editor_state WHERE plan_pipeline_id = $1 FOR UPDATE`,
      [planPipelineId],
    )
    const currentVersion = cur.rows[0]?.version || 0
    if (currentVersion !== expectedVersion) {
      await client.query('ROLLBACK')
      let currentState = {}
      try { currentState = JSON.parse(cur.rows[0]?.state_json || '{}') } catch {}
      return { status: 'conflict', state: currentState, version: currentVersion }
    }
    const nextVersion = currentVersion + 1
    const stateJson = JSON.stringify(state || {})
    if (cur.rows.length === 0) {
      await client.query(
        `INSERT INTO broll_editor_state (plan_pipeline_id, state_json, version, updated_at) VALUES ($1, $2, $3, NOW())`,
        [planPipelineId, stateJson, nextVersion],
      )
    } else {
      await client.query(
        `UPDATE broll_editor_state SET state_json = $1, version = $2, updated_at = NOW() WHERE plan_pipeline_id = $3`,
        [stateJson, nextVersion, planPipelineId],
      )
    }
    await client.query('COMMIT')
    return { status: 'ok', version: nextVersion }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
```

- [ ] **Step 3: Manual verify — start dev server, hit a shell from it, call the function**

```bash
npm run dev:server
```

In another terminal (node REPL attached to the same runtime isn't practical — instead confirm no syntax error by looking at server log on startup).

Expected: server boot without syntax errors; `[db] Schema initialized` and no stack traces.

- [ ] **Step 4: Commit**

```bash
git add server/services/broll.js
git commit -m "feat(broll): add load/save editor state service functions"
```

---

### Task 4: HTTP routes `GET` and `PUT /broll/pipeline/:pid/editor-state`

**Files:**
- Modify: `server/routes/broll.js` — add near the existing `router.get('/pipeline/:pipelineId/editor-data', ...)` route (~line 708).

- [ ] **Step 1: Read `server/routes/broll.js:707-716`** to see the existing editor-data route pattern.

- [ ] **Step 2: Import the new service functions**

Find the import block at the top (`import { BROLL_MODELS, createStrategy, ... } from '../services/broll.js'`) and add two names:

```js
  loadBrollEditorState,
  saveBrollEditorState,
```

- [ ] **Step 3: Add the two new routes**

Directly after the existing `router.get('/pipeline/:pipelineId/editor-data', ...)` block:

```js
router.get('/pipeline/:pipelineId/editor-state', requireAuth, async (req, res) => {
  try {
    const data = await loadBrollEditorState(req.params.pipelineId)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/pipeline/:pipelineId/editor-state', requireAuth, async (req, res) => {
  try {
    const { state, version } = req.body || {}
    if (state == null || typeof version !== 'number') {
      return res.status(400).json({ error: 'state and numeric version required' })
    }
    const result = await saveBrollEditorState(req.params.pipelineId, state, version)
    if (result.status === 'conflict') {
      return res.status(409).json({ state: result.state, version: result.version })
    }
    res.json({ version: result.version })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4: Manual verify**

With server running:

```bash
curl -i -H "Authorization: Bearer $(cat ~/.supabase-test-token 2>/dev/null)" \
  http://localhost:3000/api/broll/pipeline/fake-pid/editor-state
```

(If no auth token is handy, confirm by skimming the server log that no startup error occurred — the actual HTTP test can be deferred until the frontend wires up.)

Expected (unauthenticated): `401` or `403`. Expected (authenticated, fake pid): `200 {"state":{},"version":0}`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/broll.js
git commit -m "feat(broll): add editor-state GET and PUT routes"
```

---

### Task 5: Extend `getBRollEditorData` to merge editor-state

**Files:**
- Modify: `server/services/broll.js:getBRollEditorData` (~line 4849, the `return { placements, searchProgress, totalPlacements }` at the end).

- [ ] **Step 1: Read `server/services/broll.js:4849-5087`** to understand current shape.

- [ ] **Step 2: Merge editor state before returning**

Replace the final `return { placements, searchProgress, totalPlacements: placements.length }` with:

```js
  // 4. Merge user edits from broll_editor_state (hidden, manual positions, selected result, userPlacements)
  let editorState = {}
  try {
    const loaded = await loadBrollEditorState(planPipelineId)
    editorState = loaded.state || {}
  } catch (err) {
    console.error('[getBRollEditorData] Failed to load editor-state:', err.message)
  }

  const edits = editorState.edits || {}
  const userPlacements = Array.isArray(editorState.userPlacements) ? editorState.userPlacements : []

  // Apply edits to originals: attach userTimelineStart/End and selectedResult, filter hidden
  const editedPlacements = []
  for (const p of placements) {
    const key = `${p.chapterIndex}:${p.placementIndex}`
    const e = edits[key]
    if (e?.hidden) continue
    if (e?.timelineStart != null && e?.timelineEnd != null) {
      p.userTimelineStart = e.timelineStart
      p.userTimelineEnd = e.timelineEnd
    }
    if (e?.selectedResult != null) {
      p.persistedSelectedResult = e.selectedResult
    }
    editedPlacements.push(p)
  }

  // Append user placements as first-class entries
  for (const up of userPlacements) {
    editedPlacements.push({
      index: `user:${up.id}`,
      userPlacementId: up.id,
      isUserPlacement: true,
      sourcePipelineId: up.sourcePipelineId,
      chapterIndex: up.sourceChapterIndex ?? null,
      placementIndex: up.sourcePlacementIndex ?? null,
      userTimelineStart: up.timelineStart,
      userTimelineEnd: up.timelineEnd,
      persistedSelectedResult: up.selectedResult,
      results: up.results || [],
      searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
      ...(up.snapshot || {}),
    })
  }

  return { placements: editedPlacements, searchProgress, totalPlacements: editedPlacements.length, editorState: { version: (await loadBrollEditorState(planPipelineId)).version } }
```

Note: the double `loadBrollEditorState` call is wasteful — refactor to a single call:

Replace the whole merge block with a single-call version:

```js
  // 4. Merge user edits from broll_editor_state (hidden, manual positions, selected result, userPlacements)
  let editorState = {}, editorVersion = 0
  try {
    const loaded = await loadBrollEditorState(planPipelineId)
    editorState = loaded.state || {}
    editorVersion = loaded.version
  } catch (err) {
    console.error('[getBRollEditorData] Failed to load editor-state:', err.message)
  }

  const edits = editorState.edits || {}
  const userPlacements = Array.isArray(editorState.userPlacements) ? editorState.userPlacements : []

  const editedPlacements = []
  for (const p of placements) {
    const key = `${p.chapterIndex}:${p.placementIndex}`
    const e = edits[key]
    if (e?.hidden) continue
    if (e?.timelineStart != null && e?.timelineEnd != null) {
      p.userTimelineStart = e.timelineStart
      p.userTimelineEnd = e.timelineEnd
    }
    if (e?.selectedResult != null) {
      p.persistedSelectedResult = e.selectedResult
    }
    editedPlacements.push(p)
  }

  for (const up of userPlacements) {
    editedPlacements.push({
      index: `user:${up.id}`,
      userPlacementId: up.id,
      isUserPlacement: true,
      sourcePipelineId: up.sourcePipelineId,
      chapterIndex: up.sourceChapterIndex ?? null,
      placementIndex: up.sourcePlacementIndex ?? null,
      userTimelineStart: up.timelineStart,
      userTimelineEnd: up.timelineEnd,
      persistedSelectedResult: up.selectedResult,
      results: up.results || [],
      searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
      ...(up.snapshot || {}),
    })
  }

  return { placements: editedPlacements, searchProgress, totalPlacements: editedPlacements.length, editorStateVersion: editorVersion }
```

- [ ] **Step 3: Manual verify**

Server restart, open the existing b-roll editor in the browser at `/editor/225/brolls/edit/10`. Expected: the editor loads exactly as before (no editor-state exists yet, so the merge is a no-op). The `editorStateVersion: 0` field appears in the response.

Check in DevTools → Network → `editor-data` request → Response includes `editorStateVersion: 0`.

- [ ] **Step 4: Commit**

```bash
git add server/services/broll.js
git commit -m "feat(broll): merge editor-state edits and userPlacements into editor-data"
```

---

### Task 6: Reducer — extend initial state and add `LOAD_EDITOR_STATE`

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Read the full file** (320 lines).

- [ ] **Step 2: Extend `initialState` (~line 111)**

Replace:

```js
const initialState = {
  rawPlacements: [],
  placements: [],
  selectedIndex: null,
  selectedResults: {},
  searchProgress: null,
  loading: true,
  error: null,
}
```

With:

```js
const initialState = {
  rawPlacements: [],
  placements: [],
  selectedIndex: null,
  selectedResults: {},
  searchProgress: null,
  loading: true,
  error: null,
  // Editor state — persisted per pipeline
  edits: {},                  // { "chapterIdx:placementIdx": { hidden?, timelineStart?, timelineEnd?, selectedResult? } }
  userPlacements: [],          // array of user-created placements (pastes, cross-variant copies)
  undoStack: [],               // array of action objects
  redoStack: [],               // array of action objects
  editorStateVersion: 0,       // for optimistic concurrency
  dirty: false,                // true while a debounced save is pending
}
```

- [ ] **Step 3: Add `LOAD_EDITOR_STATE` reducer case (inside `function reducer(state, action)`)**

Add as a new case **before** the `default:` case:

```js
    case 'LOAD_EDITOR_STATE': {
      const { state: loaded, version } = action.payload
      return {
        ...state,
        edits: loaded.edits || {},
        userPlacements: Array.isArray(loaded.userPlacements) ? loaded.userPlacements : [],
        undoStack: Array.isArray(loaded.undoStack) ? loaded.undoStack : [],
        redoStack: Array.isArray(loaded.redoStack) ? loaded.redoStack : [],
        editorStateVersion: version || 0,
        dirty: false,
      }
    }
```

- [ ] **Step 4: Wire up a fetch on mount/pipeline-change inside the hook**

Find the existing `useEffect` that fetches `editor-data` (~line 162-188). Directly after it, add a parallel fetch:

```js
  // Load editor-state in parallel with editor-data. Backend's editor-data endpoint
  // returns editorStateVersion too, but we do a dedicated fetch to get the full state
  // (which editor-data does not return — it only merges it into placements).
  useEffect(() => {
    if (!planPipelineId) return
    let cancelled = false
    authFetch(`/broll/pipeline/${planPipelineId}/editor-state`)
      .then(data => {
        if (cancelled) return
        dispatch({ type: 'LOAD_EDITOR_STATE', payload: data })
      })
      .catch(() => { /* non-fatal; empty state stays */ })
    return () => { cancelled = true }
  }, [planPipelineId])
```

- [ ] **Step 5: Expose the new state from the `useMemo` at the bottom**

Find the `return useMemo(() => ({ ... }), [...])` block at the end of `useBRollEditorState`. Add these to the returned object:

```js
    edits: state.edits,
    userPlacements: state.userPlacements,
    undoStack: state.undoStack,
    redoStack: state.redoStack,
    editorStateVersion: state.editorStateVersion,
    dirty: state.dirty,
```

And add `state.edits, state.userPlacements, state.undoStack, state.redoStack, state.editorStateVersion, state.dirty,` to the deps array.

- [ ] **Step 6: Manual verify**

Restart dev server, open `/editor/225/brolls/edit/10`, open DevTools → Network. Expected: `/editor-state` request fires and returns `{"state":{},"version":0}`. Editor renders normally.

- [ ] **Step 7: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): load editor-state into reducer on pipeline change"
```

---

### Task 7: Reducer — `APPLY_ACTION` with inverse logging

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Define action kinds at top of file**

Just below the imports and above `export const BRollContext`:

```js
// Editor-state action kinds. Each APPLY_ACTION payload is of this shape:
//   { id: string, ts: number, kind: string, ...action-specific fields }
// `before` and `after` capture just the mutated slots so the action can be reversed.
const MAX_UNDO = 50

function generateActionId() {
  return 'act_' + (crypto.randomUUID?.() || (Math.random().toString(36).slice(2) + Date.now().toString(36))).slice(0, 12)
}
```

- [ ] **Step 2: Add helper `applyMutation(state, kind, fields)`**

Add above `function reducer(state, action)`:

```js
// Applies just the mutation side of an action to the reducer's editor-state slots.
// Used by APPLY_ACTION (with action.after), UNDO (with entry.before), and REDO (with entry.after).
function applyMutation(state, entry, side /* 'before' | 'after' */) {
  const patch = entry[side] || {}
  let nextEdits = state.edits
  let nextUserPlacements = state.userPlacements

  if (entry.placementKey != null) {
    // Mutation targets an original placement's `edits[key]` slot.
    const key = entry.placementKey
    if (patch.editsSlot === null) {
      // Delete the edits slot entirely (e.g. "reset to original")
      nextEdits = { ...nextEdits }
      delete nextEdits[key]
    } else if (patch.editsSlot) {
      nextEdits = { ...nextEdits, [key]: { ...(nextEdits[key] || {}), ...patch.editsSlot } }
    }
  }

  if (entry.userPlacementId != null) {
    // Mutation targets a userPlacement.
    if (patch.userPlacementDelete) {
      nextUserPlacements = nextUserPlacements.filter(up => up.id !== entry.userPlacementId)
    } else if (patch.userPlacementCreate) {
      // Only create if not already present (avoid dup on repeated redo)
      if (!nextUserPlacements.some(up => up.id === entry.userPlacementId)) {
        nextUserPlacements = [...nextUserPlacements, patch.userPlacementCreate]
      }
    } else if (patch.userPlacementPatch) {
      nextUserPlacements = nextUserPlacements.map(up =>
        up.id === entry.userPlacementId ? { ...up, ...patch.userPlacementPatch } : up
      )
    }
  }

  return { ...state, edits: nextEdits, userPlacements: nextUserPlacements, dirty: true }
}
```

- [ ] **Step 3: Add `APPLY_ACTION` reducer case**

Insert before `default:`:

```js
    case 'APPLY_ACTION': {
      const entry = action.payload
      const applied = applyMutation(state, entry, 'after')
      const newUndoStack = [...state.undoStack, entry].slice(-MAX_UNDO)
      return { ...applied, undoStack: newUndoStack, redoStack: [] }
    }
```

- [ ] **Step 4: Manual verify**

Restart server, open the editor, open React DevTools, find the `useBRollEditorState` hook's state. Expected: `edits`, `userPlacements`, `undoStack`, `redoStack` all present and empty. No runtime errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): add APPLY_ACTION reducer case with undo stack"
```

---

### Task 8: Reducer — `UNDO`, `REDO`, `MERGE_REMOTE_STATE`, `SAVE_SUCCESS`

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Add four more reducer cases**

Insert before `default:` (after the `APPLY_ACTION` case):

```js
    case 'UNDO': {
      const stack = state.undoStack
      if (!stack.length) return state
      const entry = stack[stack.length - 1]
      const applied = applyMutation(state, entry, 'before')
      return {
        ...applied,
        undoStack: stack.slice(0, -1),
        redoStack: [...state.redoStack, entry],
      }
    }
    case 'REDO': {
      const stack = state.redoStack
      if (!stack.length) return state
      const entry = stack[stack.length - 1]
      const applied = applyMutation(state, entry, 'after')
      return {
        ...applied,
        redoStack: stack.slice(0, -1),
        undoStack: [...state.undoStack, entry].slice(-MAX_UNDO),
      }
    }
    case 'MERGE_REMOTE_STATE': {
      // Used after a 409: replace base with remote state, then replay any pending
      // local actions (undoStack entries whose ids are NOT in the remote stack).
      const { state: remoteState, version } = action.payload
      const remoteUndo = Array.isArray(remoteState.undoStack) ? remoteState.undoStack : []
      const remoteIds = new Set(remoteUndo.map(e => e.id))
      const pending = state.undoStack.filter(e => !remoteIds.has(e.id))
      let next = {
        ...state,
        edits: remoteState.edits || {},
        userPlacements: Array.isArray(remoteState.userPlacements) ? remoteState.userPlacements : [],
        undoStack: remoteUndo,
        redoStack: Array.isArray(remoteState.redoStack) ? remoteState.redoStack : [],
        editorStateVersion: version,
        dirty: pending.length > 0,
      }
      for (const entry of pending) {
        next = applyMutation(next, entry, 'after')
        next = { ...next, undoStack: [...next.undoStack, entry].slice(-MAX_UNDO) }
      }
      return next
    }
    case 'SAVE_SUCCESS': {
      return { ...state, editorStateVersion: action.payload.version, dirty: false }
    }
```

- [ ] **Step 2: Manual verify**

Restart dev server, confirm editor still loads. No behavior change yet.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): add UNDO/REDO/MERGE_REMOTE_STATE/SAVE_SUCCESS reducer cases"
```

---

### Task 9: Debounced save hook + `beforeunload` handler

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Add `apiPut` helper**

Near the top, after `authFetch`:

```js
async function authPut(path, body, signal) {
  const headers = { 'Content-Type': 'application/json' }
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  const res = await fetch(`${API_BASE}${path}`, { method: 'PUT', headers, body: JSON.stringify(body), signal })
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}))
    const err = new Error('conflict')
    err.conflict = body
    throw err
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}
```

- [ ] **Step 2: Inside the hook body, after the existing effects, add the debounced save effect**

```js
  // Debounced save of editor-state. Triggered whenever state.dirty flips to true.
  const saveTimerRef = useRef(null)
  const savingRef = useRef(false)
  const pendingSaveRef = useRef(null) // holds a pending snapshot if a save is in flight

  const flushSave = useCallback(async (immediate = false) => {
    if (!planPipelineId) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (savingRef.current) {
      // Mark a follow-up needed; the in-flight save will re-trigger itself
      pendingSaveRef.current = true
      return
    }
    savingRef.current = true
    try {
      // Read the latest state from the reducer via the closure capturing setState
      // — we snapshot inside the effect below rather than here.
      const payload = savePayloadRef.current
      if (!payload) { savingRef.current = false; return }
      try {
        const res = await authPut(`/broll/pipeline/${planPipelineId}/editor-state`, payload)
        dispatch({ type: 'SAVE_SUCCESS', payload: { version: res.version } })
      } catch (err) {
        if (err.conflict) {
          dispatch({ type: 'MERGE_REMOTE_STATE', payload: err.conflict })
          // Schedule an immediate retry after merge
          pendingSaveRef.current = true
        } else {
          console.error('[broll-editor-state] save failed:', err.message)
        }
      }
    } finally {
      savingRef.current = false
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false
        // Re-trigger: the next render will re-enter this effect if still dirty
        setTimeout(() => flushSave(true), 100)
      }
    }
  }, [planPipelineId])

  // Keep a ref to the current save payload so flushSave reads the latest
  const savePayloadRef = useRef(null)
  useEffect(() => {
    savePayloadRef.current = {
      state: {
        edits: state.edits,
        userPlacements: state.userPlacements,
        undoStack: state.undoStack,
        redoStack: state.redoStack,
      },
      version: state.editorStateVersion,
    }
  }, [state.edits, state.userPlacements, state.undoStack, state.redoStack, state.editorStateVersion])

  // Schedule debounced save on dirty
  useEffect(() => {
    if (!state.dirty || !planPipelineId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => flushSave(false), 500)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [state.dirty, planPipelineId, flushSave])

  // beforeunload flush — if the user closes the tab with a pending save
  useEffect(() => {
    const handler = (e) => {
      if (!state.dirty) return
      // Synchronously flush via sendBeacon (fire-and-forget; we can't await here)
      const payload = savePayloadRef.current
      if (payload && navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        navigator.sendBeacon(`${API_BASE}/broll/pipeline/${planPipelineId}/editor-state?beacon=1`, blob)
      }
      // Present the standard browser prompt as a fallback
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [state.dirty, planPipelineId])
```

- [ ] **Step 3: Expose `flushSave` from the hook**

Add to the returned `useMemo`:

```js
    flushSave,
```

And `flushSave` to the deps array.

- [ ] **Step 4: Extend the PUT route to accept `?beacon=1` for sendBeacon**

Modify `server/routes/broll.js` — the existing PUT handler (added in Task 4). Replace its body with:

```js
router.put('/pipeline/:pipelineId/editor-state', requireAuth, async (req, res) => {
  try {
    let body = req.body || {}
    // sendBeacon posts as text/plain; Express's text() parser stashes raw body.
    // Our default JSON parser handles it if Content-Type was set; fall back for beacon.
    if (req.query.beacon && typeof body === 'string') {
      try { body = JSON.parse(body) } catch {}
    }
    const { state, version } = body
    if (state == null || typeof version !== 'number') {
      return res.status(400).json({ error: 'state and numeric version required' })
    }
    const result = await saveBrollEditorState(req.params.pipelineId, state, version)
    if (result.status === 'conflict') {
      return res.status(409).json({ state: result.state, version: result.version })
    }
    res.json({ version: result.version })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

Also ensure Express parses text bodies for the beacon case — in `server/index.js`, find where `express.json()` is registered and add right after:

```js
app.use('/api/broll/pipeline/:pipelineId/editor-state', express.text({ type: '*/*', limit: '2mb' }))
```

No — that conflicts with the JSON parser. Simpler: add a `express.raw()` parser just for this route inside the route itself, OR leave only the JSON parser and rely on sendBeacon's Blob body typed as `application/json`. The Blob's type header is `application/json`, so Express's json parser handles it.

- [ ] **Step 5: Manual verify**

Not behaviorally testable yet — the reducer's `dirty` flag never flips to true because nothing calls `APPLY_ACTION` yet. Confirm by restarting the server and opening the editor: no errors, `editor-state` GET still works.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/useBRollEditorState.js server/routes/broll.js
git commit -m "feat(broll): debounced save + beforeunload beacon for editor-state"
```

---

### Task 10: `brollUtils.matchPlacementsToTranscript` — consume `edits` (no displacement yet)

**Files:**
- Modify: `src/components/editor/brollUtils.js`

- [ ] **Step 1: Extend the function signature to take edits**

The function is currently called from multiple sites. We need to keep the simple call-site compatible. Accept an optional third argument:

Find `export function matchPlacementsToTranscript(placements, words) {`. Replace with:

```js
export function matchPlacementsToTranscript(placements, words, editsByKey = null) {
```

- [ ] **Step 2: Use `edits` for override when available**

Inside the `.map(p => { ... })` block, replace the first if-block:

```js
    if (p.userTimelineStart != null && p.userTimelineEnd != null) {
      return {
        ...p,
        timelineStart: p.userTimelineStart,
        timelineEnd: p.userTimelineEnd,
        timelineDuration: p.userTimelineEnd - p.userTimelineStart,
      }
    }
```

With a version that also consults `editsByKey`:

```js
    // Prefer editsByKey lookup if provided; fall back to inline userTimelineStart/End
    const editKey = p.chapterIndex != null && p.placementIndex != null
      ? `${p.chapterIndex}:${p.placementIndex}`
      : null
    const edit = editKey && editsByKey ? editsByKey[editKey] : null
    const uStart = edit?.timelineStart ?? p.userTimelineStart
    const uEnd   = edit?.timelineEnd   ?? p.userTimelineEnd
    if (uStart != null && uEnd != null) {
      return {
        ...p,
        timelineStart: uStart,
        timelineEnd: uEnd,
        timelineDuration: uEnd - uStart,
      }
    }
```

- [ ] **Step 3: Pass `edits` from `useBRollEditorState.js` to `matchPlacementsToTranscript`**

In `useBRollEditorState.js`, find every call to `matchPlacementsToTranscript(...)`. There are three (inside `seedFromCache`, inside the load `useEffect`, and inside the re-resolve `useEffect`). Change each call from:

```js
matchPlacementsToTranscript(visible, transcriptWordsRef.current)
```

to:

```js
matchPlacementsToTranscript(visible, transcriptWordsRef.current, state.edits)
```

Note: `state.edits` may not be in scope in every call site — for calls inside `useCallback`s and `useEffect`s, add a ref:

```js
const editsRef = useRef(state.edits)
editsRef.current = state.edits
```

and use `editsRef.current` in the calls.

Also update the call in `BRollEditor.jsx:inactiveVariantPlacements` useMemo. But inactive variants don't have their edits loaded — leave them unedited for now (TODO for Phase B refinement). Add a `// TODO: inactive variant edits` comment.

- [ ] **Step 4: Manual verify**

Start server, load editor. Existing behavior unchanged because `state.edits` is empty. No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/brollUtils.js src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): thread edits into matchPlacementsToTranscript"
```

---

### Task 11: Dispatch `APPLY_ACTION` for drag/resize + expose action builders

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` — replace `updatePlacementPosition` with action-emitting version; keep the old hide API intact for now (re-implement in Task 12).
- Modify: `src/components/editor/BRollTrack.jsx` — no change required to call site because the function signature stays the same.

- [ ] **Step 1: Refactor `updatePlacementPosition` in the hook**

Find the existing `const updatePlacementPosition = useCallback((index, timelineStart, timelineEnd) => { dispatch({ type: 'UPDATE_PLACEMENT_POSITION', ... }) }, [])` block (~line 287).

Replace with:

```js
  const updatePlacementPosition = useCallback((index, timelineStart, timelineEnd, opts = {}) => {
    // Look up current placement to capture `before` for undo
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const placementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    const userPlacementId = placement.userPlacementId || null

    if (placementKey) {
      const prev = state.edits[placementKey] || {}
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: opts.kind || 'move',
        placementKey,
        before: { editsSlot: { timelineStart: prev.timelineStart, timelineEnd: prev.timelineEnd } },
        after:  { editsSlot: { timelineStart, timelineEnd } },
      }
      dispatch({ type: 'APPLY_ACTION', payload: entry })
    } else if (userPlacementId) {
      const up = state.userPlacements.find(u => u.id === userPlacementId)
      if (!up) return
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: opts.kind || 'move',
        userPlacementId,
        before: { userPlacementPatch: { timelineStart: up.timelineStart, timelineEnd: up.timelineEnd } },
        after:  { userPlacementPatch: { timelineStart, timelineEnd } },
      }
      dispatch({ type: 'APPLY_ACTION', payload: entry })
    }
  }, [state.placements, state.edits, state.userPlacements])
```

- [ ] **Step 2: Remove the now-unused reducer case**

Delete the `case 'UPDATE_PLACEMENT_POSITION':` block (inside `function reducer`, around line 88).

- [ ] **Step 3: Manual verify — drag a placement**

Start server, open editor, drag an existing placement's body. Expected: drag works, position updates. Reload the page after waiting 1-2 seconds. Expected: **position is preserved**. This is the first sign of Phase A working.

Also check: open two browser tabs on the same variant. Drag in tab A, wait 1s. In tab B, hit reload — edit appears.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): persist drag/resize via APPLY_ACTION"
```

---

### Task 12: Refactor `hidePlacement` to dispatch a delete action

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Replace `hidePlacement`**

Find (~line 283):

```js
  const hidePlacement = useCallback((index) => {
    dispatch({ type: 'HIDE_PLACEMENT', payload: index })
  }, [])
```

Replace with:

```js
  const hidePlacement = useCallback((index) => {
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const placementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    const userPlacementId = placement.userPlacementId || null

    if (placementKey) {
      const prev = state.edits[placementKey] || {}
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: 'delete',
        placementKey,
        before: { editsSlot: { hidden: !!prev.hidden } },
        after:  { editsSlot: { hidden: true } },
      }
      dispatch({ type: 'APPLY_ACTION', payload: entry })
    } else if (userPlacementId) {
      const up = state.userPlacements.find(u => u.id === userPlacementId)
      if (!up) return
      const entry = {
        id: generateActionId(),
        ts: Date.now(),
        kind: 'delete',
        userPlacementId,
        before: { userPlacementCreate: up },  // restore the full entry on undo
        after:  { userPlacementDelete: true },
      }
      dispatch({ type: 'APPLY_ACTION', payload: entry })
    }
  }, [state.placements, state.edits, state.userPlacements])
```

- [ ] **Step 2: Remove the old `HIDE_PLACEMENT` reducer case**

Delete the `case 'HIDE_PLACEMENT':` block (~line 100).

- [ ] **Step 3: Also add `undo` and `redo` to the returned API**

At the bottom of the hook, add:

```js
  const undo = useCallback(() => dispatch({ type: 'UNDO' }), [])
  const redo = useCallback(() => dispatch({ type: 'REDO' }), [])
```

And include `undo, redo` in the returned memo + its deps array.

- [ ] **Step 4: Manual verify**

Click a placement in the editor. In the sidebar, click Delete button. Expected: placement hides. Reload page — stays hidden. (Can't undo yet — that's Task 13.)

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): persist delete via APPLY_ACTION"
```

---

### Task 13: Keyboard handlers — Delete, Backspace, CMD+Z, CMD+Shift+Z

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx`

- [ ] **Step 1: Read the file** and locate the `return (` of `BRollEditor` (~line 188).

- [ ] **Step 2: Add the keyboard handler effect**

Just after `const pendingSelectionRef = useRef(null)` (~line 78) or anywhere in the effects block, add:

```js
  // Keyboard shortcuts — delete/backspace, undo/redo
  useEffect(() => {
    const handler = (e) => {
      // Ignore when user is typing in inputs
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return

      const isMac = navigator.platform.toLowerCase().includes('mac')
      const mod = isMac ? e.metaKey : e.ctrlKey

      // Delete / Backspace → delete selected placement
      if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && brollState.selectedIndex != null) {
        e.preventDefault()
        brollState.hidePlacement(brollState.selectedIndex)
        brollState.selectPlacement(null)
        return
      }

      // CMD/Ctrl + Z → undo
      if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        brollState.undo()
        return
      }

      // CMD/Ctrl + Shift + Z (or CMD+Y on Windows) → redo
      if ((mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) || (mod && (e.key === 'y' || e.key === 'Y'))) {
        e.preventDefault()
        brollState.redo()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [brollState.selectedIndex, brollState.hidePlacement, brollState.selectPlacement, brollState.undo, brollState.redo])
```

- [ ] **Step 3: Manual verify**

Load editor. Click a placement to select. Press Delete — placement hides. CMD+Z — placement reappears. CMD+Shift+Z — hides again. Delete again, CMD+Z — reappears.

Try while focused on a text input (e.g. open Edit modal): shortcuts don't fire.

Open a second tab on same URL — undo stack is loaded from DB on each tab mount. Works.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/BRollEditor.jsx
git commit -m "feat(broll): keyboard handlers for delete, undo, redo"
```

---

### Task 14: Undo/Redo toolbar icons + Pexels URL fix

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx` — add toolbar strip between splitter and timeline.
- Modify: `src/components/editor/BRollPreview.jsx` — URL order fix.

- [ ] **Step 1: Import icons**

In `BRollEditor.jsx`, modify the `lucide-react` import (~line 11) to add Undo2 and Redo2:

```js
import { Loader2, Square, Undo2, Redo2 } from 'lucide-react'
```

- [ ] **Step 2: Add the toolbar above the timeline**

Inside the `BRollEditor` JSX, find the `<div className="flex-1 min-h-0">` that wraps `<Timeline ... />` (~line 210). Directly above that div, add:

```jsx
            <UndoRedoToolbar
              undoStack={brollState.undoStack}
              redoStack={brollState.redoStack}
              onUndo={brollState.undo}
              onRedo={brollState.redo}
            />
```

- [ ] **Step 3: Add the toolbar component at the bottom of the file**

At the very end of `BRollEditor.jsx`, after the `SearchStatusBar` component declaration:

```jsx
function UndoRedoToolbar({ undoStack, redoStack, onUndo, onRedo }) {
  const canUndo = undoStack.length > 0
  const canRedo = redoStack.length > 0
  const lastUndo = canUndo ? undoStack[undoStack.length - 1] : null
  const lastRedo = canRedo ? redoStack[redoStack.length - 1] : null
  const labelFor = (entry) => {
    if (!entry) return ''
    const verb = { delete: 'Delete', move: 'Move', resize: 'Resize', paste: 'Paste', 'drag-cross': 'Move between variants', reset: 'Reset', 'select-result': 'Swap result' }[entry.kind] || entry.kind
    return verb
  }
  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-white/5 shrink-0">
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title={canUndo ? `Undo: ${labelFor(lastUndo)}` : 'Nothing to undo'}
        className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Undo2 size={14} />
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title={canRedo ? `Redo: ${labelFor(lastRedo)}` : 'Nothing to redo'}
        className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Redo2 size={14} />
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Pexels URL fix in `BRollPreview.jsx:30`**

Find the line:

```js
const url = activeResult.preview_url_hq || activeResult.preview_url || activeResult.url
```

Replace with:

```js
const url = activeResult.preview_url || activeResult.preview_url_hq || activeResult.url
```

- [ ] **Step 5: Manual verify — undo/redo icons + Pexels preview**

Load the editor. Undo/Redo icons appear above the timeline. Both disabled initially.

Delete a placement → Undo icon enables, hover shows "Undo: Delete". Click → placement back. Redo icon enables. Click → placement gone again. Check tooltips match the last action.

Click a placement with a Pexels result source. Play in the main preview: video plays (was previously black).

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/BRollEditor.jsx src/components/editor/BRollPreview.jsx
git commit -m "feat(broll): undo/redo toolbar icons; fix(broll): prefer SD preview_url in main preview"
```

---

### Phase A complete — manual smoke test

Before moving to Phase B, run this checklist manually:

- [ ] Drag a placement's body → release → reload page → position preserved.
- [ ] Drag an edge to resize → release → reload → size preserved.
- [ ] Click a placement, press Delete → hidden. CMD+Z → restored. CMD+Shift+Z → hidden again.
- [ ] Delete 3 placements one after another. CMD+Z three times → all restored in reverse order.
- [ ] Undo/Redo toolbar buttons reflect stack state; tooltips show the action label.
- [ ] Play a Pexels-source clip in the main preview → video plays.
- [ ] Open two tabs on the same variant; edit in tab A; wait 1s; reload tab B → edit appears.

If any fail — fix before proceeding to Phase B.

---

## Phase B — Copy / Paste / Cross-variant Drag + Soft Displacement

Tasks 15–27.

---

### Task 15: `brollClipboard.js` — singleton clipboard with localStorage mirror

**Files:**
- Create: `src/components/editor/brollClipboard.js`

- [ ] **Step 1: Create the file with this content**

```js
// In-memory + localStorage-mirrored clipboard for b-roll placements.
// Only one slot; newer copy overwrites older.

const STORAGE_KEY = 'broll-clipboard'
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h — purge stale entries

let memCache = null
const subscribers = new Set()

function notify() {
  for (const cb of subscribers) cb(memCache)
}

export function getClipboard() {
  if (memCache) return memCache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.copiedAt) return null
    if (Date.now() - parsed.copiedAt > MAX_AGE_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    memCache = parsed
    return parsed
  } catch {
    return null
  }
}

export function setClipboard(entry) {
  memCache = entry
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry))
  } catch { /* storage full — ignore */ }
  notify()
}

export function clearClipboard() {
  memCache = null
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
  notify()
}

export function subscribeClipboard(cb) {
  subscribers.add(cb)
  // Push current value
  cb(memCache ?? getClipboard())
  return () => subscribers.delete(cb)
}

// Listen for cross-tab updates
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    memCache = null
    notify()
  })
}
```

- [ ] **Step 2: Manual verify**

Start the dev server. In DevTools console on the editor page:

```js
import('/src/components/editor/brollClipboard.js').then(m => {
  m.setClipboard({ copiedAt: Date.now(), test: 1 })
  console.log(m.getClipboard())
})
```

Expected: logs the entry. Check `localStorage` tab → `broll-clipboard` present.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/brollClipboard.js
git commit -m "feat(broll): clipboard singleton with localStorage mirror"
```

---

### Task 16: `BRollContextMenu.jsx` — right-click menu component

**Files:**
- Create: `src/components/editor/BRollContextMenu.jsx`

- [ ] **Step 1: Create the file**

```jsx
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * Lightweight context menu rendered via portal.
 *
 * @param {number} x,y - viewport coordinates where the menu opens (from event.clientX/Y)
 * @param {Array<{ label, shortcut?, onClick, disabled?, divider? }>} items
 * @param {() => void} onClose
 */
export default function BRollContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onEsc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  // Clamp menu within viewport
  const menuW = 180
  const menuH = items.length * 28 + 16
  const clampedX = Math.min(x, window.innerWidth - menuW - 8)
  const clampedY = Math.min(y, window.innerHeight - menuH - 8)

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[300] rounded-lg border border-white/10 bg-[#1a1a1c] shadow-2xl shadow-black/60 py-1 text-xs"
      style={{ left: clampedX, top: clampedY, minWidth: menuW }}
    >
      {items.map((it, i) => {
        if (it.divider) return <div key={`d-${i}`} className="my-1 h-px bg-white/5" />
        return (
          <button
            key={i}
            disabled={it.disabled}
            onClick={() => { if (!it.disabled) { onClose(); it.onClick() } }}
            className="w-full flex items-center justify-between px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-600 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <span>{it.label}</span>
            {it.shortcut && <span className="text-[10px] text-zinc-500">{it.shortcut}</span>}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
```

- [ ] **Step 2: Manual verify**

Component is not yet wired anywhere. Verify it compiles — no error on page load.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollContextMenu.jsx
git commit -m "feat(broll): add context menu component"
```

---

### Task 17: Wire context menu into `BRollTrack.jsx` + clipboard actions

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx` — add `onContextMenu`, render `BRollContextMenu`.
- Modify: `src/components/editor/useBRollEditorState.js` — add `copyPlacement`, `pastePlacement`, `resetPlacement` actions.

- [ ] **Step 1: Add clipboard-aware action builders to the hook**

In `useBRollEditorState.js`, import clipboard helpers at top:

```js
import { getClipboard, setClipboard } from './brollClipboard.js'
```

Inside the hook, after `const redo = useCallback(...)`, add these three builders:

```js
  const copyPlacement = useCallback((index, { cut = false } = {}) => {
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const resultIdx = state.selectedResults[index] ?? placement.persistedSelectedResult ?? 0
    const entry = {
      sourcePipelineId: placement.isUserPlacement ? placement.sourcePipelineId : planPipelineId,
      sourceChapterIndex: placement.chapterIndex ?? null,
      sourcePlacementIndex: placement.placementIndex ?? null,
      sourceUserPlacementId: placement.userPlacementId ?? null,
      selectedResult: resultIdx,
      results: JSON.parse(JSON.stringify(placement.results || [])),
      snapshot: {
        description: placement.description,
        audio_anchor: placement.audio_anchor,
        function: placement.function,
        type_group: placement.type_group,
        source_feel: placement.source_feel,
        style: placement.style,
      },
      durationSec: placement.timelineDuration,
      copiedAt: Date.now(),
    }
    setClipboard(entry)
    if (cut) hidePlacement(index)
  }, [state.placements, state.selectedResults, planPipelineId, hidePlacement])

  const pastePlacement = useCallback((targetStartSec) => {
    const entry = getClipboard()
    if (!entry) return
    const uuid = 'u_' + (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12)
    const timelineStart = Math.max(0, targetStartSec)
    const timelineEnd = timelineStart + Math.max(0.5, entry.durationSec)
    const up = {
      id: uuid,
      sourcePipelineId: entry.sourcePipelineId,
      sourceChapterIndex: entry.sourceChapterIndex,
      sourcePlacementIndex: entry.sourcePlacementIndex,
      timelineStart, timelineEnd,
      selectedResult: entry.selectedResult,
      results: entry.results,
      snapshot: entry.snapshot,
    }
    const action = {
      id: generateActionId(),
      ts: Date.now(),
      kind: 'paste',
      userPlacementId: uuid,
      before: { userPlacementDelete: true },
      after:  { userPlacementCreate: up },
    }
    dispatch({ type: 'APPLY_ACTION', payload: action })
  }, [])

  const resetPlacement = useCallback((index) => {
    const placement = state.placements.find(p => p.index === index)
    if (!placement) return
    const placementKey = placement.chapterIndex != null && placement.placementIndex != null
      ? `${placement.chapterIndex}:${placement.placementIndex}`
      : null
    if (!placementKey) return // reset only meaningful for originals
    const prev = state.edits[placementKey]
    if (!prev) return
    dispatch({ type: 'APPLY_ACTION', payload: {
      id: generateActionId(), ts: Date.now(), kind: 'reset', placementKey,
      before: { editsSlot: prev },
      after:  { editsSlot: null },
    }})
  }, [state.placements, state.edits])
```

Add `copyPlacement, pastePlacement, resetPlacement` to the returned memo and deps.

- [ ] **Step 2: Wire `onContextMenu` in `BRollTrack.jsx`**

At the top of `BRollTrack.jsx` add:

```js
import { useState as useStateCM } from 'react' // avoid shadowing
import BRollContextMenu from './BRollContextMenu.jsx'
import { getClipboard } from './brollClipboard.js'
```

(Use `useState` that's already imported — the `useStateCM` alias is unnecessary; delete that line.)

Inside the `BRollTrack` component, add state for the menu:

```js
  const [menuState, setMenuState] = useState(null) // { x, y, placement? , emptyAreaTime? }
```

On each placement `<div>`, add:

```jsx
onContextMenu={(e) => {
  e.preventDefault(); e.stopPropagation()
  setMenuState({ x: e.clientX, y: e.clientY, placement: p })
}}
```

At the end of `BRollTrack`'s return, directly before the closing `</div>`, render:

```jsx
{menuState && (
  <BRollContextMenu
    x={menuState.x}
    y={menuState.y}
    onClose={() => setMenuState(null)}
    items={buildMenuItems(menuState, broll)}
  />
)}
```

And add a helper above the return:

```jsx
  const buildMenuItems = (menu, broll) => {
    const p = menu.placement
    const hasClipboard = !!getClipboard()
    const hasEditOverride = p && broll?.edits?.[`${p.chapterIndex}:${p.placementIndex}`]
    const items = []
    if (p) {
      items.push({ label: 'Copy',   shortcut: '⌘C', onClick: () => broll.copyPlacement(p.index) })
      items.push({ label: 'Cut',    shortcut: '⌘X', onClick: () => broll.copyPlacement(p.index, { cut: true }) })
    }
    items.push({
      label: 'Paste', shortcut: '⌘V', disabled: !hasClipboard,
      onClick: () => {
        const targetStart = p ? p.timelineEnd + 0.05 : menu.emptyAreaTime
        broll.pastePlacement(targetStart)
      },
    })
    if (p) {
      items.push({ divider: true })
      items.push({ label: 'Delete', shortcut: 'Del', onClick: () => { broll.hidePlacement(p.index); broll.selectPlacement(null) } })
      if (hasEditOverride || p.isUserPlacement) {
        items.push({ divider: true })
        items.push({ label: 'Reset to original', onClick: () => broll.resetPlacement(p.index) })
      }
    }
    return items
  }
```

- [ ] **Step 3: Also handle context menu on empty track area**

Inside the `BRollTrack`'s outer wrapper `<div>`, add an `onContextMenu` handler:

```jsx
onContextMenu={(e) => {
  if (e.defaultPrevented) return // already handled by a placement
  e.preventDefault()
  const rect = e.currentTarget.getBoundingClientRect()
  const timeAtClick = ((e.clientX - rect.left) + (scrollX || 0) - 144 /* labelW */) / zoom
  setMenuState({ x: e.clientX, y: e.clientY, emptyAreaTime: Math.max(0, timeAtClick) })
}}
```

- [ ] **Step 4: Manual verify**

Right-click a placement → menu appears with Copy / Cut / Paste / Delete / divider / Reset. Copy → Paste becomes enabled. Paste on a placement → new clip appears 0.05s after that placement's end (no displacement math yet — may visually overlap neighbors; that's Task 18).

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollTrack.jsx src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): context menu + copy/cut/paste/reset actions"
```

---

### Task 18: Soft displacement — two-pass algorithm in `matchPlacementsToTranscript`

**Files:**
- Modify: `src/components/editor/brollUtils.js`

- [ ] **Step 1: Read `brollUtils.js:matchPlacementsToTranscript` in full**

The current Step 2 (after positioning) does a simple overlap trim. Replace it with the two-pass algorithm.

- [ ] **Step 2: Replace Step 2 (the sort + trim block at the bottom)**

Find:

```js
  // Step 2: Fix overlaps — audio_anchor position has priority.
  // Sort by timelineStart, then trim earlier placement's end if it overlaps
  // the next placement's anchor-based start.
  const sorted = [...resolved].sort((a, b) => a.timelineStart - b.timelineStart)
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i]
    const next = sorted[i + 1]
    if (curr.timelineEnd > next.timelineStart) {
      curr.timelineEnd = next.timelineStart
      curr.timelineDuration = Math.max(0, curr.timelineEnd - curr.timelineStart)
    }
  }

  return sorted
```

Replace with:

```js
  // Step 2: Two-pass soft displacement.
  // A clip is "fixed" if user manually edited its position OR it's a userPlacement
  // (paste/cross-variant copy). Fixed clips are immovable landmarks. Free clips
  // flow left-to-right through the gaps, shrinking-or-squeezing past fixed clips.

  // Each resolved placement has its "natural" timelineStart/End already set above.
  // Tag isFixed.
  for (const p of resolved) {
    const hasEditsOverride = editsByKey && p.chapterIndex != null && p.placementIndex != null
      && !!editsByKey[`${p.chapterIndex}:${p.placementIndex}`]?.timelineStart
    p.isFixed = !!p.isUserPlacement || hasEditsOverride
    p.naturalStart = p.timelineStart
    p.naturalEnd   = p.timelineEnd
  }

  const sorted = [...resolved].sort((a, b) => a.naturalStart - b.naturalStart)

  // Pass 1: fixed clips stay at natural
  for (const p of sorted) {
    if (p.isFixed) {
      p.timelineStart = p.naturalStart
      p.timelineEnd   = p.naturalEnd
    }
  }

  // Pass 2: walk free clips left to right, clipped by next fixed clip on their right
  let prevEnd = 0
  let i = 0
  while (i < sorted.length) {
    const c = sorted[i]
    if (c.isFixed) {
      prevEnd = Math.max(prevEnd, c.timelineEnd)
      i++; continue
    }
    // Find the next fixed clip after c by natural position
    let rightBoundary = Infinity
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].isFixed) { rightBoundary = sorted[j].naturalStart; break }
    }
    const desiredStart = Math.max(c.naturalStart, prevEnd)
    const naturalDur = Math.max(0, c.naturalEnd - c.naturalStart)
    let timelineStart = desiredStart
    let timelineEnd = Math.min(desiredStart + naturalDur, rightBoundary)
    if (timelineEnd - timelineStart < 0.5) {
      // Squeezed out past the fixed clip
      timelineStart = rightBoundary
      timelineEnd = rightBoundary + naturalDur
    }
    c.timelineStart = timelineStart
    c.timelineEnd = timelineEnd
    c.timelineDuration = Math.max(0, c.timelineEnd - c.timelineStart)
    prevEnd = Math.max(prevEnd, c.timelineEnd)
    i++
  }

  return sorted
```

- [ ] **Step 3: Append `userPlacements` to the resolved list before Step 2**

In `useBRollEditorState.js`, update the three call sites to include userPlacements. E.g.:

```js
const resolved = matchPlacementsToTranscript([...visible, ...state.userPlacements.map(up => ({
  ...up.snapshot,
  index: `user:${up.id}`,
  userPlacementId: up.id,
  isUserPlacement: true,
  userTimelineStart: up.timelineStart,
  userTimelineEnd: up.timelineEnd,
  results: up.results,
  searchStatus: (up.results || []).length > 0 ? 'complete' : 'pending',
  chapterIndex: null,
  placementIndex: null,
}))], transcriptWordsRef.current, editsRef.current)
```

Do this for each of the three `matchPlacementsToTranscript` calls. Consider extracting a helper `buildResolveInput(visible, userPlacements)` to DRY.

- [ ] **Step 4: Manual verify soft displacement**

1. Load editor at a populated timeline.
2. Copy a placement; paste it right after another one.
3. Verify: pasted clip visible; neighbor gets pushed forward; pasted clip is fixed (doesn't move when you click elsewhere).
4. Move the pasted clip far away (drag). Verify: pushed neighbor springs back to its natural position.
5. Manually edit the neighbor's position BEFORE pasting; then paste near it. Verify the manually-edited neighbor stays put (it is now fixed); pasted clip shrinks or squeezes past it.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/brollUtils.js src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): two-pass soft displacement with spring-back"
```

---

### Task 19: Keyboard shortcuts — CMD+C, CMD+X, CMD+V

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx` — extend the keyboard handler added in Task 13.

- [ ] **Step 1: Add EditorContext import if not already**

Confirm `import { useContext } from 'react'` present and `EditorContext` imported.

- [ ] **Step 2: Extend the keydown handler**

In the `useEffect` added in Task 13, add new branches (after the Delete/Backspace block but before Undo/Redo):

```js
      // CMD/Ctrl + C → copy selected
      if (mod && (e.key === 'c' || e.key === 'C') && brollState.selectedIndex != null) {
        e.preventDefault()
        brollState.copyPlacement(brollState.selectedIndex)
        return
      }
      // CMD/Ctrl + X → cut selected
      if (mod && (e.key === 'x' || e.key === 'X') && brollState.selectedIndex != null) {
        e.preventDefault()
        brollState.copyPlacement(brollState.selectedIndex, { cut: true })
        return
      }
      // CMD/Ctrl + V → paste at selected.timelineEnd + 0.05 OR playhead
      if (mod && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        let targetStart
        if (brollState.selectedPlacement) {
          targetStart = brollState.selectedPlacement.timelineEnd + 0.05
        } else if (editorCtx?.state?.currentTime != null) {
          targetStart = editorCtx.state.currentTime
        } else {
          targetStart = 0
        }
        brollState.pastePlacement(targetStart)
        return
      }
```

Update the deps array of that `useEffect` to include `brollState.copyPlacement, brollState.pastePlacement, brollState.selectedPlacement, editorCtx`.

- [ ] **Step 3: Manual verify**

Select a placement. CMD+C. Move cursor playhead or select another placement. CMD+V → new clip appears. CMD+X cuts (source hides).

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/BRollEditor.jsx
git commit -m "feat(broll): keyboard shortcuts for copy/cut/paste"
```

---

### Task 20: Cross-variant drag — yellow marker + ghost clone + drop

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx` — `handleBoxMove` gains cross-variant detection.
- Modify: `src/components/editor/useBRollEditorState.js` — new `dragCrossPlacement` action.

- [ ] **Step 1: Add `dragCrossPlacement` to the hook**

Insert near `pastePlacement`:

```js
  // Cross-pipeline move OR copy. Writes to BOTH pipelines' editor-state.
  // `mode` = 'move' | 'copy'.
  const dragCrossPlacement = useCallback(async ({ sourceIndex, targetPipelineId, targetStartSec, mode }) => {
    const placement = state.placements.find(p => p.index === sourceIndex)
    if (!placement) return
    const resultIdx = state.selectedResults[sourceIndex] ?? placement.persistedSelectedResult ?? 0
    const uuid = 'u_' + (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12)
    const actionId = generateActionId()
    const up = {
      id: uuid,
      sourcePipelineId: planPipelineId,
      sourceChapterIndex: placement.chapterIndex ?? null,
      sourcePlacementIndex: placement.placementIndex ?? null,
      timelineStart: targetStartSec,
      timelineEnd: targetStartSec + Math.max(0.5, placement.timelineDuration),
      selectedResult: resultIdx,
      results: JSON.parse(JSON.stringify(placement.results || [])),
      snapshot: {
        description: placement.description,
        audio_anchor: placement.audio_anchor,
        function: placement.function,
        type_group: placement.type_group,
        source_feel: placement.source_feel,
        style: placement.style,
      },
    }

    // Fetch target pipeline's current state, mutate, and PUT.
    try {
      const remote = await authFetch(`/broll/pipeline/${targetPipelineId}/editor-state`)
      const next = {
        edits: remote.state?.edits || {},
        userPlacements: [...(remote.state?.userPlacements || []), up],
        undoStack: [...(remote.state?.undoStack || []), {
          id: actionId, ts: Date.now(), kind: 'drag-cross', userPlacementId: uuid,
          before: { userPlacementDelete: true }, after: { userPlacementCreate: up },
        }].slice(-MAX_UNDO),
        redoStack: [],
      }
      await authPut(`/broll/pipeline/${targetPipelineId}/editor-state`, { state: next, version: remote.version })
    } catch (err) {
      console.error('[broll-drag-cross] Failed to write target:', err.message)
      return
    }

    // On source: if mode==='move', push a delete-style action onto THIS pipeline's stack.
    if (mode === 'move') {
      const placementKey = placement.chapterIndex != null && placement.placementIndex != null
        ? `${placement.chapterIndex}:${placement.placementIndex}`
        : null
      if (placementKey) {
        const prev = state.edits[placementKey] || {}
        dispatch({ type: 'APPLY_ACTION', payload: {
          id: actionId, ts: Date.now(), kind: 'drag-cross', placementKey,
          before: { editsSlot: { hidden: !!prev.hidden } },
          after:  { editsSlot: { hidden: true } },
        }})
      } else if (placement.userPlacementId) {
        dispatch({ type: 'APPLY_ACTION', payload: {
          id: actionId, ts: Date.now(), kind: 'drag-cross', userPlacementId: placement.userPlacementId,
          before: { userPlacementCreate: state.userPlacements.find(u => u.id === placement.userPlacementId) },
          after:  { userPlacementDelete: true },
        }})
      }
    }
  }, [state.placements, state.selectedResults, state.edits, state.userPlacements, planPipelineId])
```

Add `dragCrossPlacement` to returned memo and deps.

Note: cross-pipeline undo (the inverse — rewinding both pipelines atomically) is exercised when the user undoes a `drag-cross` action. On the source pipeline, `UNDO` reverses the local edit. On the target pipeline, the shared actionId is not automatically rewound — that's a known limitation for v1 and documented in the spec's "Risks" section. A follow-up task may extend UNDO to detect cross-pipeline actionIds and issue the matching remote PUT.

- [ ] **Step 2: Extend `BRollTrack.handleBoxMove` with cross-variant detection**

This is a larger change. The existing `handleBoxMove` drags within the same track. We extend it to detect when the pointer crosses into a different variant's track row.

Pre-work: `BRollTrack` currently receives `isActive`, `overridePlacements`. It needs access to variants info for cross-drag. Plumb a `variants` prop + `activeVariantIdx` from `Timeline.jsx`.

In `Timeline.jsx`, find the `<BRollTrack ... />` instantiation (~line 668). Add props:

```jsx
variants={variants}
activeVariantIdx={activeVariantIdx}
onCrossDrop={onCrossDrop}
```

And accept `onCrossDrop` prop in `Timeline` from `BRollEditor.jsx`:

In `BRollEditor.jsx`, pass:

```jsx
<Timeline
  variants={variants}
  activeVariantIdx={activeVariantIdx}
  onVariantActivate={handleVariantActivate}
  inactiveVariantPlacements={inactiveVariantPlacements}
  onCrossDrop={(args) => brollState.dragCrossPlacement(args)}
/>
```

In `Timeline`, pass through via the BRollTrack instantiation.

- [ ] **Step 3: Extend `BRollTrack`'s `handleBoxMove`**

Replace the current implementation with:

```js
  const handleBoxMove = useCallback((placement, e) => {
    e.preventDefault()
    e.stopPropagation()

    if (!isActive) {
      onActivate?.(placement.index)
      return
    }

    const startX = e.clientX
    const startY = e.clientY
    const origStart = placement.timelineStart
    const origEnd = placement.timelineEnd
    const duration = origEnd - origStart
    const { prevEnd, nextStart } = getNeighborBounds(placement)
    let moved = false
    let crossMode = null // { variantIdx, rowRect, dropStart }

    // Pre-compute variant track rows' bounds for hit testing
    const variantRows = (variants || []).map((v, vi) => {
      const row = document.querySelector(`[data-broll-variant="${vi}"]`)
      return row ? { vi, rect: row.getBoundingClientRect(), variant: v } : null
    }).filter(Boolean)

    // Create a ghost element that follows the cursor
    const ghost = document.createElement('div')
    ghost.style.position = 'fixed'
    ghost.style.pointerEvents = 'none'
    ghost.style.zIndex = '999'
    ghost.style.opacity = '0.6'
    ghost.style.background = 'rgba(206,252,0,0.3)'
    ghost.style.border = '1px solid #cefc00'
    ghost.style.borderRadius = '4px'
    ghost.style.width = (duration * zoom) + 'px'
    ghost.style.height = '60px'
    document.body.appendChild(ghost)

    // Create an insertion marker (yellow line) on the target variant row
    const marker = document.createElement('div')
    marker.style.position = 'fixed'
    marker.style.pointerEvents = 'none'
    marker.style.zIndex = '998'
    marker.style.height = '60px'
    marker.style.width = '2px'
    marker.style.background = '#cefc00'
    marker.style.boxShadow = '0 0 6px rgba(206,252,0,0.7)'
    marker.style.display = 'none'
    document.body.appendChild(marker)

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 3 && Math.abs(ev.clientY - startY) < 3) return
      moved = true

      // Position ghost at cursor
      ghost.style.left = (ev.clientX - 20) + 'px'
      ghost.style.top = (ev.clientY - 30) + 'px'

      // Determine which variant row the pointer is over
      let overRow = null
      for (const row of variantRows) {
        if (ev.clientY >= row.rect.top && ev.clientY <= row.rect.bottom) { overRow = row; break }
      }

      if (overRow && overRow.vi !== (activeVariantIdx ?? 0)) {
        // Cross-variant mode
        const labelW = 144
        const trackLeft = overRow.rect.left + labelW
        const timeAtPointer = (ev.clientX - trackLeft) / zoom
        const dropStart = Math.max(0, timeAtPointer - duration / 2)
        crossMode = { variantIdx: overRow.vi, dropStart, variant: overRow.variant }
        marker.style.display = 'block'
        marker.style.left = (trackLeft + dropStart * zoom) + 'px'
        marker.style.top = overRow.rect.top + 'px'
      } else {
        crossMode = null
        marker.style.display = 'none'
        // Same-variant drag — apply as before
        const dt = dx / zoom
        const newStart = Math.max(prevEnd, Math.min(origStart + dt, nextStart - duration))
        updatePlacementPosition(placement.index, newStart, newStart + duration)
      }
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.removeChild(ghost)
      document.body.removeChild(marker)

      if (!moved) { selectPlacement(placement.index); return }

      if (crossMode) {
        const mode = ev.altKey ? 'copy' : 'move'
        onCrossDrop?.({
          sourceIndex: placement.index,
          targetPipelineId: crossMode.variant.id,
          targetStartSec: crossMode.dropStart,
          mode,
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [zoom, getNeighborBounds, updatePlacementPosition, selectPlacement, isActive, onActivate, variants, activeVariantIdx, onCrossDrop])
```

Also add a `data-broll-variant={vi}` attribute to each variant's row `<div>` in `Timeline.jsx` so `querySelector` can find it. Find the `<div key={\`broll-track-${vi}\`}` and add `data-broll-variant={vi}`.

- [ ] **Step 4: Manual verify cross-variant drag**

Ensure the editor has at least 2 variants.

1. Drag a placement body. Move pointer over another variant's b-roll track row. Yellow insertion marker appears on that row.
2. Release → placement moves to target variant (gone from source).
3. Drag again, hold Alt on release → source unchanged, target gets a copy.
4. CMD+Z on source-tab undo → source restored locally (target still has the copy — v1 limitation).

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/BRollTrack.jsx src/components/editor/Timeline.jsx src/components/editor/BRollEditor.jsx src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): cross-variant drag with yellow marker, ghost clone, alt=copy"
```

---

### Task 21: `userPlacement` retry — backend service + route

**Files:**
- Modify: `server/services/broll.js` — add `searchUserPlacement`.
- Modify: `server/routes/broll.js` — add `POST /pipeline/:pid/search-user-placement`.

- [ ] **Step 1: Add `searchUserPlacement`**

Insert after the existing `searchSinglePlacement` export (~line 5300+). The new function reuses the same GPU flow but reads the brief/style/keywords from the userPlacement snapshot rather than from per-chapter plan sub-runs:

```js
export async function searchUserPlacement(planPipelineId, userPlacementId, overrides = {}) {
  const GPU_URL = 'https://gpu-proxy-production.up.railway.app/broll/search'
  const GPU_KEY = process.env.GPU_INTERNAL_KEY
  if (!GPU_KEY) throw new Error('GPU_INTERNAL_KEY not set')

  const loaded = await loadBrollEditorState(planPipelineId)
  const up = (loaded.state.userPlacements || []).find(u => u.id === userPlacementId)
  if (!up) throw new Error(`userPlacement ${userPlacementId} not found on pipeline ${planPipelineId}`)

  const desc = overrides.description || up.snapshot?.description
  let styleStr
  if (overrides.style) {
    styleStr = overrides.style
  } else {
    const s = up.snapshot?.style || {}
    const parts = []
    if (s.colors) parts.push(`colors: ${s.colors}`)
    if (s.temperature) parts.push(`temperature: ${s.temperature}`)
    if (s.motion) parts.push(`motion: ${s.motion}`)
    if (s.framing) parts.push(`framing: ${s.framing}`)
    if (s.lighting) parts.push(`lighting: ${s.lighting}`)
    styleStr = parts.join('; ')
  }

  const brief = [
    desc ? `# ${desc}` : '',
    styleStr ? `## Style: ${styleStr}` : '',
  ].filter(Boolean).join('\n')

  const sources = overrides.sources?.length ? overrides.sources : ['pexels', 'storyblocks']
  const requestBody = { keywords: [], brief, sources, max_results: 10 }

  const res = await fetch(GPU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': GPU_KEY },
    body: JSON.stringify(requestBody),
  })
  if (!res.ok) throw new Error(`GPU search failed: ${res.status}`)
  const data = await res.json()
  const results = (data.results || []).map(r => r.preview_url_hq ? r : { ...r, preview_url_hq: upgradePreviewUrl(r.preview_url) })

  // Persist back to editor-state: replace the userPlacement's results.
  // Uses optimistic concurrency; single retry on 409.
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await loadBrollEditorState(planPipelineId)
    const updatedUps = (latest.state.userPlacements || []).map(u =>
      u.id === userPlacementId ? { ...u, results, selectedResult: 0 } : u
    )
    const nextState = { ...latest.state, userPlacements: updatedUps }
    const save = await saveBrollEditorState(planPipelineId, nextState, latest.version)
    if (save.status === 'ok') break
  }

  return { results, searchStatus: results.length ? 'complete' : 'no_results' }
}
```

- [ ] **Step 2: Add route**

In `server/routes/broll.js`, add after the existing `search-placement` route:

```js
router.post('/pipeline/:pipelineId/search-user-placement', requireAuth, async (req, res) => {
  try {
    const { userPlacementId, description, style, sources } = req.body || {}
    if (!userPlacementId) return res.status(400).json({ error: 'userPlacementId required' })
    const overrides = {}
    if (description) overrides.description = description
    if (style) overrides.style = style
    if (sources) overrides.sources = sources
    const result = await searchUserPlacement(req.params.pipelineId, userPlacementId, overrides)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

Also add `searchUserPlacement` to the imports at the top of `routes/broll.js`.

- [ ] **Step 3: Manual verify**

Not user-facing yet — route compiles (server restarts without error). End-to-end test comes in Task 22.

- [ ] **Step 4: Commit**

```bash
git add server/services/broll.js server/routes/broll.js
git commit -m "feat(broll): search-user-placement endpoint"
```

---

### Task 22: Detail panel supports user placements + alt thumbnail preload prep

**Files:**
- Modify: `src/components/editor/BRollDetailPanel.jsx` — Retry branches for userPlacement.

- [ ] **Step 1: Update `handleRetry`**

Find the `handleRetry` function (~line 26). Replace:

```js
  async function handleRetry() {
    setRetrying(true)
    try { await broll.searchPlacement(selectedIndex) } catch {}
    setRetrying(false)
  }
```

With:

```js
  async function handleRetry() {
    setRetrying(true)
    try {
      if (placement.isUserPlacement) {
        await broll.searchUserPlacement(placement.userPlacementId)
      } else {
        await broll.searchPlacement(selectedIndex)
      }
    } catch {}
    setRetrying(false)
  }
```

- [ ] **Step 2: Add `searchUserPlacement` to the hook**

In `useBRollEditorState.js`, add near `searchPlacement`:

```js
  const searchUserPlacementFn = useCallback(async (userPlacementId, overrides = {}) => {
    if (!planPipelineId) return
    // Mark searching in-memory
    // (userPlacements don't yet have a searchStatus in state; we'll just refetch).
    try {
      await apiPost(`/broll/pipeline/${planPipelineId}/search-user-placement`, {
        userPlacementId, ...overrides,
      })
      // Reload editor-state to pick up new results
      const data = await authFetch(`/broll/pipeline/${planPipelineId}/editor-state`)
      dispatch({ type: 'LOAD_EDITOR_STATE', payload: data })
    } catch (err) {
      console.error('[broll] user placement search failed:', err.message)
    }
  }, [planPipelineId])
```

Export `searchUserPlacement: searchUserPlacementFn` from the memo.

Note: this doesn't yet propagate optimistic "searching" UI state; the user will just see results appear. A follow-up task could add a loading state.

- [ ] **Step 3: Manual verify**

Right-click any placement → Copy. Paste. Click the pasted clip in the timeline → sidebar opens. Click Retry. Wait — new results appear.

Also verify Edit modal works on a pasted clip (`searchPlacementCustom` needs to branch similarly — do that in a follow-up if needed; for now document it as a known minor gap).

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/BRollDetailPanel.jsx src/components/editor/useBRollEditorState.js
git commit -m "feat(broll): retry for user-created placements"
```

---

### Task 23: Copied-icon badge on user placements

**Files:**
- Modify: `src/components/editor/BRollTrack.jsx` — add a small corner icon for `isUserPlacement`.

- [ ] **Step 1: Add icon import**

Near the existing `Loader2` import:

```js
import { Loader2, Copy } from 'lucide-react'
```

- [ ] **Step 2: Render the icon inside each placement's div**

Inside the placement `<div>` block (the one with `onMouseDown={(e) => handleBoxMove(p, e)}`), after the content but before the resize handles, add:

```jsx
{p.isUserPlacement && (
  <div className="absolute top-1 right-1 z-10 bg-black/50 rounded p-0.5 pointer-events-none" title="Copied clip">
    <Copy size={8} className="text-white/70" />
  </div>
)}
```

- [ ] **Step 3: Manual verify**

Paste a clip. The small copy icon appears in its top-right corner.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/BRollTrack.jsx
git commit -m "feat(broll): copied-clip badge on user placements"
```

---

### Phase B complete — manual smoke test

- [ ] Right-click placement → menu with Copy/Cut/Paste/Delete/Reset.
- [ ] Copy + Paste in same timeline → new clip appears right after source.
- [ ] If neighbors exist, they get soft-displaced.
- [ ] Move pasted clip far away → displaced neighbors spring back to their natural position.
- [ ] Manually edit a neighbor BEFORE pasting → that neighbor stays at edited position after paste.
- [ ] CMD+V pastes at playhead.
- [ ] Cut (CMD+X) hides source, paste places a copy.
- [ ] Drag placement body to another variant → yellow marker shows drop position → release moves it.
- [ ] Alt+drag to another variant → copies (source stays).
- [ ] Pasted clip has the copy badge in top-right.
- [ ] Retry on a pasted clip → new results appear.
- [ ] "Reset to original" restores clip to its LLM plan position.

---

## Phase C — Lazy Load + Loading State

Tasks 24–27.

---

### Task 24: `brollPreloader.js` — LRU preload cache

**Files:**
- Create: `src/components/editor/brollPreloader.js`

- [ ] **Step 1: Create the file**

```js
// LRU cache of <link rel="preload" as="video"> tags appended to <head>.
// Keeps network pressure low by capping at 20 concurrent preloads with
// fetchpriority=low, evicting least-recently-used URLs when new ones arrive.

const MAX_ENTRIES = 20
const links = new Map() // url -> HTMLLinkElement
let scheduleTimer = null

function addPreload(url) {
  if (!url || typeof document === 'undefined') return
  if (links.has(url)) {
    // Touch for LRU: re-insert to move to end
    const el = links.get(url)
    links.delete(url)
    links.set(url, el)
    return
  }
  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'video'
  link.href = url
  link.setAttribute('fetchpriority', 'low')
  document.head.appendChild(link)
  links.set(url, link)
  // Evict LRU if over cap
  while (links.size > MAX_ENTRIES) {
    const oldestUrl = links.keys().next().value
    const oldestEl = links.get(oldestUrl)
    if (oldestEl?.parentNode) oldestEl.parentNode.removeChild(oldestEl)
    links.delete(oldestUrl)
  }
}

function removeUnused(keepSet) {
  for (const url of [...links.keys()]) {
    if (!keepSet.has(url)) {
      const el = links.get(url)
      if (el?.parentNode) el.parentNode.removeChild(el)
      links.delete(url)
    }
  }
}

/**
 * Schedule preload for the next few clips.
 *
 * @param {Array<{ timelineStart:number, results:Array<any>, persistedSelectedResult?:number }>} activePlacements
 * @param {Record<string, Array<any>>} inactivePlacementsByPid
 * @param {number} currentTime
 * @param {Record<string, number>} selectedResultsByIndex - ephemeral selections
 */
export function scheduleBrollPreload({ activePlacements = [], inactivePlacementsByPid = {}, currentTime = 0, selectedResultsByIndex = {} }) {
  if (scheduleTimer) clearTimeout(scheduleTimer)
  scheduleTimer = setTimeout(() => {
    const keep = new Set()
    const pickUrl = (p) => {
      const ri = selectedResultsByIndex[p.index] ?? p.persistedSelectedResult ?? 0
      const r = p.results?.[ri]
      if (!r) return null
      return r.preview_url || r.preview_url_hq || r.url
    }

    // Active variant: next 5 clips starting at-or-after (currentTime - 1s)
    const active = [...activePlacements]
      .filter(p => p.timelineStart >= currentTime - 1)
      .sort((a, b) => a.timelineStart - b.timelineStart)
      .slice(0, 5)
    for (const p of active) { const u = pickUrl(p); if (u) keep.add(u) }

    // Each inactive variant: next 2 clips
    for (const placements of Object.values(inactivePlacementsByPid)) {
      const list = [...(placements || [])]
        .filter(p => p.timelineStart >= currentTime - 1)
        .sort((a, b) => a.timelineStart - b.timelineStart)
        .slice(0, 2)
      for (const p of list) { const u = pickUrl(p); if (u) keep.add(u) }
    }

    // Apply: add new, remove unused
    for (const url of keep) addPreload(url)
    removeUnused(keep)
  }, 250)
}

export function clearBrollPreload() {
  for (const el of links.values()) { if (el?.parentNode) el.parentNode.removeChild(el) }
  links.clear()
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/editor/brollPreloader.js
git commit -m "feat(broll): LRU preloader module for upcoming clips"
```

---

### Task 25: Wire preloader into `BRollEditor.jsx`

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx`

- [ ] **Step 1: Import preloader**

```js
import { scheduleBrollPreload, clearBrollPreload } from './brollPreloader.js'
```

- [ ] **Step 2: Add a subscriber effect**

Inside the `BRollEditor` function body, after existing effects, add:

```js
  useEffect(() => {
    scheduleBrollPreload({
      activePlacements: brollState.placements || [],
      inactivePlacementsByPid: inactiveVariantPlacements || {},
      currentTime: editorCtx?.state?.currentTime || 0,
      selectedResultsByIndex: brollState.selectedResults || {},
    })
  }, [brollState.placements, inactiveVariantPlacements, editorCtx?.state?.currentTime, brollState.selectedResults])

  // Cleanup on unmount
  useEffect(() => () => clearBrollPreload(), [])
```

- [ ] **Step 3: Manual verify**

Open the editor. Open DevTools → Elements tab → search `<head>` for `<link rel="preload" as="video">`. Expected: up to 5 tags (active variant's next 5 clips).

Play the video (space bar). As `currentTime` advances, the preload set rotates: older entries evicted, newer ones added. Never exceeds 20.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/BRollEditor.jsx
git commit -m "feat(broll): wire preloader to currentTime + variant placements"
```

---

### Task 26: Loading state backdrop in `BRollPreview.jsx`

**Files:**
- Modify: `src/components/editor/BRollPreview.jsx`

- [ ] **Step 1: Add state + backdrop**

Replace the full component with this (preserving existing logic, adding loading state):

```jsx
import { useContext, useEffect, useRef, useState } from 'react'
import { EditorContext } from './EditorView.jsx'
import { BRollContext } from './useBRollEditorState.js'
import RoughCutPreview from './RoughCutPreview.jsx'
import { Loader2 } from 'lucide-react'

export default function BRollPreview() {
  const { state } = useContext(EditorContext)
  const broll = useContext(BRollContext)
  const brollVideoRef = useRef(null)
  const [showBRoll, setShowBRoll] = useState(false)
  const [videoLoadState, setVideoLoadState] = useState('idle') // 'idle' | 'loading' | 'ready' | 'error'
  const fallbackIdxRef = useRef(0)

  const stateRef = useRef(state); stateRef.current = state
  const brollRef = useRef(broll); brollRef.current = broll

  useEffect(() => {
    let rafId = 0
    const tick = () => {
      const s = stateRef.current
      const b = brollRef.current
      const activePlacement = b ? b.activePlacementAtTime(s.currentTime) : null
      const resultIdx = activePlacement ? (b.selectedResults[activePlacement.index] ?? activePlacement.persistedSelectedResult ?? 0) : 0
      const activeResult = activePlacement?.results?.[resultIdx] || null

      if (activeResult) {
        if (!showBRoll) setShowBRoll(true)
        if (brollVideoRef.current) {
          const v = brollVideoRef.current
          const urlChain = [activeResult.preview_url, activeResult.preview_url_hq, activeResult.url].filter(Boolean)
          const url = urlChain[fallbackIdxRef.current] || urlChain[0]
          if (v.src !== url) {
            fallbackIdxRef.current = 0
            setVideoLoadState('loading')
            v.src = url
          }
          const localTime = s.currentTime - activePlacement.timelineStart
          const clampedTime = Math.max(0, Math.min(localTime, activeResult.duration || 30))
          if (Math.abs(v.currentTime - clampedTime) > 0.5) v.currentTime = clampedTime
          if (s.isPlaying && v.paused) v.play().catch(() => {})
          else if (!s.isPlaying && !v.paused) v.pause()
        }
      } else {
        if (showBRoll) setShowBRoll(false)
        if (brollVideoRef.current && !brollVideoRef.current.paused) brollVideoRef.current.pause()
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [showBRoll])

  const handleLoadedData = () => setVideoLoadState('ready')
  const handleError = () => {
    // Advance through URL fallback chain
    const b = brollRef.current
    const s = stateRef.current
    const p = b?.activePlacementAtTime?.(s.currentTime)
    const ri = p ? (b.selectedResults[p.index] ?? p.persistedSelectedResult ?? 0) : 0
    const r = p?.results?.[ri]
    const chain = r ? [r.preview_url, r.preview_url_hq, r.url].filter(Boolean) : []
    if (fallbackIdxRef.current + 1 < chain.length) {
      fallbackIdxRef.current += 1
      console.log('[broll-preview] URL failed, trying fallback', fallbackIdxRef.current, chain[fallbackIdxRef.current])
      if (brollVideoRef.current) {
        setVideoLoadState('loading')
        brollVideoRef.current.src = chain[fallbackIdxRef.current]
      }
    } else {
      console.log('[broll-preview] all URL fallbacks exhausted')
      setVideoLoadState('error')
    }
  }

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center">
      <div className={showBRoll ? 'opacity-0 absolute inset-0' : 'w-full h-full flex items-center justify-center'}>
        <RoughCutPreview />
      </div>

      <video
        ref={brollVideoRef}
        className={`w-full h-full object-contain ${showBRoll ? '' : 'hidden'}`}
        preload="auto"
        playsInline
        muted
        onLoadedData={handleLoadedData}
        onError={handleError}
      />

      {showBRoll && videoLoadState === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black pointer-events-none">
          <Loader2 size={24} className="text-primary-fixed animate-spin" />
          <span className="text-xs text-primary-fixed/70">Loading clip…</span>
        </div>
      )}
      {showBRoll && videoLoadState === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-xs text-red-400 pointer-events-none">
          Preview unavailable
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Manual verify**

- DevTools → Network → Throttling → "Slow 3G". Play the video. When a b-roll clip comes up, the spinner appears until the clip data loads. No more black screen.
- Break a URL by editing one result's `preview_url` via DevTools to a 404-ish URL → fallback chain advances through `preview_url_hq` → `url` → shows "Preview unavailable".

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollPreview.jsx
git commit -m "feat(broll): loading spinner + onerror fallback chain for preview video"
```

---

### Task 27: Sidebar alt-thumbnail preload

**Files:**
- Modify: `src/components/editor/BRollDetailPanel.jsx`

- [ ] **Step 1: Change `preload` for the top 4 alternatives**

Find `BRollOptionThumbnail` (~line 272). It renders a `<video preload="metadata">`. Change so the top 4 thumbnails in the grid preload auto:

Inside `BRollDetailPanel`, modify the result grid (~line 135):

```jsx
            <div className="grid grid-cols-2 gap-2">
              {placement.results.map((r, i) => (
                <BRollOptionThumbnail
                  key={`${placement.index}-${i}`}
                  result={r}
                  isSelected={i === resultIdx}
                  onSelect={() => selectResult(selectedIndex, i)}
                  eager={i < 4}
                />
              ))}
            </div>
```

In `BRollOptionThumbnail`, add `eager` to the props and use it:

```jsx
function BRollOptionThumbnail({ result, isSelected, onSelect, eager = false }) {
  // ...existing code...
      {hasVideo ? (
        <video
          ref={videoRef}
          src={videoUrl}
          poster={thumb}
          className="w-full h-full object-cover bg-black pointer-events-none"
          preload={eager ? 'auto' : 'metadata'}
```

- [ ] **Step 2: Manual verify**

Select a placement with many results. In DevTools → Network, observe that the top 4 alternatives preload fully (large requests); the 5th onward preloads only metadata. Swap between the top 4 results — transitions are near-instant.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollDetailPanel.jsx
git commit -m "feat(broll): preload top-4 alt thumbnails for fast swap"
```

---

### Phase C complete — manual smoke test

- [ ] DevTools Network throttle Slow 3G → b-roll preview shows spinner instead of black; clip plays when ready.
- [ ] `<head>` always has ≤20 `<link rel="preload" as="video">` tags; set rotates as playhead advances.
- [ ] Swapping between top-4 alternatives in sidebar is near-instant.
- [ ] Breaking a URL (e.g. edit DOM to point to a 404) falls through to next URL and logs the failure.

---

## Post-Phase Review

- [ ] **Run the full 3-phase smoke test** (checklists at the end of each phase).
- [ ] **Review the spec** (`docs/specs/2026-04-23-broll-edit-features-design.md`) and confirm every requirement has been touched.
- [ ] **Finishing branch:** use `finishing-a-development-branch` skill to decide next steps (merge to main via PR, squash, or cleanup).

---

## Known Limitations (v1)

Documented in the spec's "Risks & Mitigations" section, and re-noted here so the implementer doesn't treat them as bugs:

- **Cross-variant undo is source-only.** Undoing a `drag-cross` action from one side does not auto-rewind the other side. A follow-up ticket can extend UNDO to detect cross-pipeline actionIds and issue the matching remote PUT. For v1, user can manually fix the other side.
- **No automated tests** — manual verification per task.
- **Edit modal on user placements.** The existing `searchPlacementCustom` doesn't yet branch for userPlacements; Edit→Search on a user placement currently uses the original search path. Acceptable for v1; can be extended by following the Task 21 pattern.
- **Multi-select** (bulk delete/copy/paste) is out of scope for this plan.

---

## Self-review results

Checked this plan against the spec on 2026-04-23:

- **Spec coverage:** All 5 features have tasks. Delete/undo (1 → Tasks 12–13), persistence (2 → Tasks 1–11), Pexels fix (3 → Task 14), copy/paste/drag (4 → Tasks 15–23), lazy load (5 → Tasks 24–27).
- **Placeholders:** none — every step has code or commands.
- **Type consistency:** `APPLY_ACTION` payload shape used consistently: `{ id, ts, kind, placementKey? | userPlacementId?, before, after }` with `before/after: { editsSlot?, userPlacementCreate?, userPlacementDelete?, userPlacementPatch? }`. `applyMutation` matches this in Task 7. All action builders in Tasks 11, 12, 17, 20 use the same shape.
- **Known follow-up:** cross-variant undo symmetry (noted above).
