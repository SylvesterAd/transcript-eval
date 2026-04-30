# B-Roll Search Queue — Frontend Polling Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan.

**Goal:** Adapt `useBRollEditorState.js` to the new async `{brollSearchId, batchId}` response from `/search-placement` and `/search-user-placement`. Poll `GET /pipeline/search-status/:brollSearchId` until terminal, then dispatch results.

**Architecture:** A small shared helper `pollBrollSearch(brollSearchId, opts)` does the polling loop. The 3 search functions in `useBRollEditorState.js` (`searchPlacement`, `searchPlacementCustom`, `searchUserPlacement`) call enqueue → poll → dispatch.

**Tech Stack:** React 18, hooks, fetch via `apiPost` / `authFetch`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-04-30-broll-search-queue-design.md](../specs/2026-04-30-broll-search-queue-design.md) — section "Out of Scope" notes the frontend follow-up; this plan delivers it.

**Backend contract (from PR 2):**
- `POST /broll/pipeline/:pipelineId/search-placement` → returns `{ brollSearchId: number, batchId: string }` (was `{ results, ... }`)
- `POST /broll/pipeline/:pipelineId/search-user-placement` → returns `{ brollSearchId: number, batchId: string }` (was full search result)
- `GET /broll/pipeline/search-status/:brollSearchId` → returns `{ id, status, results, num_results, error, ... }`. `status` is one of `'waiting'`, `'running'`, `'complete'`, `'failed'`, `'timeout'`, `'stopped'`.

---

## File Map

**Modify:**
- `src/components/editor/useBRollEditorState.js` — add `pollBrollSearch` helper, rewrite the three search functions.

**No new files.** No reducer changes (the existing `SET_PLACEMENT_SEARCHING` and `SET_PLACEMENT_RESULTS` actions are sufficient — see [brollReducer.js:224-236](src/components/editor/brollReducer.js#L224)).

---

## Design Notes

### Polling parameters
- **Poll interval:** 1500 ms. Backend's empty-queue poll is 1000 ms; this is just slow enough not to thrash, fast enough that a 30-second search returns within ~20 polls.
- **Max wait:** 25 minutes (the worker's GPU-job poll cap is 20 min; we add 5 min headroom for the reclaimer to potentially requeue + retry).
- **Cancellation:** each function gets an `AbortController`. If the user fires a new search on the same placement before the previous poll terminates, the old controller is aborted.
- **Per-placement cancellation map:** `useRef<Map<index, AbortController>>` tracks in-flight polls. Keyed by placement index for `searchPlacement`/`searchPlacementCustom`, by `userPlacementId` for `searchUserPlacement`.

### Failure mapping
| Backend status | UI dispatch (`searchStatus`) |
|---|---|
| `complete` | `'complete'` if `num_results > 0`, else `'no_results'` |
| `failed` | `'failed'` |
| `timeout` | `'failed'` (treat timeout as a search failure for the user) |
| `stopped` | `'failed'` (user-initiated abort still presents as a failed search) |
| `waiting`/`running` | continue polling |
| Network/HTTP error | `'failed'` |
| Aborted by client | no dispatch (intentional cancellation) |
| Max wait exceeded | `'failed'` with error log |

### Why not a hook?
A `usePollBrollSearch` hook would be more React-idiomatic but the lifecycle is "fire-and-forget within a callback," not a component-bound subscription. A plain helper that returns a Promise is simpler and matches the existing async callback pattern.

---

## Tasks

### Task 1: Add `pollBrollSearch` helper

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Add a helper at module scope (above the `BRollContext` export, ~line 28)**

```js
const POLL_INTERVAL_MS = 1500
const MAX_POLL_DURATION_MS = 25 * 60 * 1000  // 25 minutes

// Polls GET /broll/pipeline/search-status/:brollSearchId until the row reaches
// a terminal status. Returns { status, results, num_results, error } from the
// final status payload. Throws on AbortError or if max duration is exceeded.
async function pollBrollSearch(brollSearchId, { signal } = {}) {
  const start = Date.now()
  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (Date.now() - start > MAX_POLL_DURATION_MS) {
      throw new Error(`pollBrollSearch: timeout after ${MAX_POLL_DURATION_MS / 60000} min for brollSearchId ${brollSearchId}`)
    }

    let row
    try {
      row = await authFetch(`/broll/pipeline/search-status/${brollSearchId}`, signal)
    } catch (err) {
      if (err.name === 'AbortError') throw err
      throw new Error(`pollBrollSearch: status fetch failed for ${brollSearchId}: ${err.message}`)
    }

    if (row.status !== 'waiting' && row.status !== 'running') {
      return row
    }

    // Wait POLL_INTERVAL_MS, but interruptible via signal
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS)
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      }
    })
  }
}
```

- [ ] **Step 2: Verify the file still parses**

```bash
cd .worktrees/broll-search-queue-cutover
node --check src/components/editor/useBRollEditorState.js
```

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll-editor): add pollBrollSearch helper for async search status"
```

---

### Task 2: Rewrite `searchPlacement` and `searchPlacementCustom` to enqueue + poll

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Add per-placement abort tracker inside the hook**

Inside the `useBRollEditorState` hook (the function exported at the bottom of the file), near the top of the hook body where other `useRef`s/`useState`s live, add:

```js
  // Tracks the in-flight poll AbortController per placement index. Lets a
  // re-search on the same placement cancel the prior poll cleanly.
  const placementPollControllers = useRef(new Map())
```

(If you can't find a good spot for it next to other refs, place it just above `searchPlacement`'s declaration around line 416.)

- [ ] **Step 2: Replace the existing `searchPlacement` function**

Find the current `searchPlacement` (around line 416-438):

```js
  const searchPlacement = useCallback(async (index) => {
    const placement = state.rawPlacements[index]
    if (!placement || !planPipelineId) return
    dispatch({ type: 'SET_PLACEMENT_SEARCHING', payload: index })
    try {
      const result = await apiPost(`/broll/pipeline/${planPipelineId}/search-placement`, {
        placementUuid: placement.uuid,
        chapterIndex: placement.chapterIndex,   // kept for legacy server fallback
        placementIndex: placement.placementIndex,
      })
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results: result.results || [],
        searchStatus: result.results?.length ? 'complete' : 'no_results',
      }})
    } catch (err) {
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results: [],
        searchStatus: 'failed',
      }})
    }
  }, [state.rawPlacements, planPipelineId])
```

Replace with:

```js
  const searchPlacement = useCallback(async (index) => {
    const placement = state.rawPlacements[index]
    if (!placement || !planPipelineId) return

    // Cancel any prior poll for this placement
    const prior = placementPollControllers.current.get(index)
    if (prior) prior.abort()
    const controller = new AbortController()
    placementPollControllers.current.set(index, controller)

    dispatch({ type: 'SET_PLACEMENT_SEARCHING', payload: index })
    try {
      const enq = await apiPost(`/broll/pipeline/${planPipelineId}/search-placement`, {
        placementUuid: placement.uuid,
        chapterIndex: placement.chapterIndex,
        placementIndex: placement.placementIndex,
      })
      const row = await pollBrollSearch(enq.brollSearchId, { signal: controller.signal })
      const results = row.results || []
      const isOk = row.status === 'complete' && results.length > 0
      const isEmpty = row.status === 'complete' && results.length === 0
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results,
        searchStatus: isOk ? 'complete' : (isEmpty ? 'no_results' : 'failed'),
      }})
    } catch (err) {
      if (err.name === 'AbortError') return  // intentional cancellation
      console.error('[broll] searchPlacement failed:', err.message)
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results: [],
        searchStatus: 'failed',
      }})
    } finally {
      // Only clear the controller if it's still ours (a newer search may have replaced it)
      if (placementPollControllers.current.get(index) === controller) {
        placementPollControllers.current.delete(index)
      }
    }
  }, [state.rawPlacements, planPipelineId])
```

- [ ] **Step 3: Replace the existing `searchPlacementCustom` function (around line 441-464)**

Same pattern as Step 2, but pass `overrides`:

```js
  const searchPlacementCustom = useCallback(async (index, overrides) => {
    const placement = state.rawPlacements[index]
    if (!placement || !planPipelineId) return

    const prior = placementPollControllers.current.get(index)
    if (prior) prior.abort()
    const controller = new AbortController()
    placementPollControllers.current.set(index, controller)

    dispatch({ type: 'SET_PLACEMENT_SEARCHING', payload: index })
    try {
      const enq = await apiPost(`/broll/pipeline/${planPipelineId}/search-placement`, {
        placementUuid: placement.uuid,
        chapterIndex: placement.chapterIndex,
        placementIndex: placement.placementIndex,
        ...overrides,
      })
      const row = await pollBrollSearch(enq.brollSearchId, { signal: controller.signal })
      const results = row.results || []
      const isOk = row.status === 'complete' && results.length > 0
      const isEmpty = row.status === 'complete' && results.length === 0
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results,
        searchStatus: isOk ? 'complete' : (isEmpty ? 'no_results' : 'failed'),
      }})
    } catch (err) {
      if (err.name === 'AbortError') return
      console.error('[broll] searchPlacementCustom failed:', err.message)
      dispatch({ type: 'SET_PLACEMENT_RESULTS', payload: {
        index,
        results: [],
        searchStatus: 'failed',
      }})
    } finally {
      if (placementPollControllers.current.get(index) === controller) {
        placementPollControllers.current.delete(index)
      }
    }
  }, [state.rawPlacements, planPipelineId])
```

- [ ] **Step 4: Verify file parses**

```bash
node --check src/components/editor/useBRollEditorState.js
```

- [ ] **Step 5: Run frontend tests**

```bash
npm test -- src/components/editor 2>&1 | tail -10
```
Expected: no NEW failures (StepRoughCut x2 and other pre-existing baseline remain).

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll-editor): poll search status for /search-placement enqueue response"
```

---

### Task 3: Rewrite `searchUserPlacement` to enqueue + poll + reload

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js`

- [ ] **Step 1: Add a separate userPlacement poll tracker** (or reuse the same map keyed by `\`up-${userPlacementId}\``)

For simplicity, reuse the same `placementPollControllers` map but key it with a string `up-${userPlacementId}` so it can't collide with numeric placement indices.

- [ ] **Step 2: Replace the existing `searchUserPlacement` function (around line 466-486)**

Find:
```js
  const searchUserPlacement = useCallback(async (userPlacementId, overrides = {}) => {
    if (!planPipelineId) return
    try {
      await apiPost(`/broll/pipeline/${planPipelineId}/search-user-placement`, {
        userPlacementId, ...overrides,
      })
      // Reload editor-state to pick up new results on the userPlacement
      const data = await authFetch(`/broll/pipeline/${planPipelineId}/editor-state`)
      const sessionScoped = {
        ...data,
        state: data?.state ? {
          ...data.state,
          undoStack: filterToSession(data.state.undoStack),
          redoStack: filterToSession(data.state.redoStack),
        } : data?.state,
      }
      dispatch({ type: 'LOAD_EDITOR_STATE', payload: sessionScoped })
    } catch (err) {
      console.error('[broll] user placement search failed:', err.message)
    }
  }, [planPipelineId])
```

Replace with:

```js
  const searchUserPlacement = useCallback(async (userPlacementId, overrides = {}) => {
    if (!planPipelineId) return

    const key = `up-${userPlacementId}`
    const prior = placementPollControllers.current.get(key)
    if (prior) prior.abort()
    const controller = new AbortController()
    placementPollControllers.current.set(key, controller)

    try {
      const enq = await apiPost(`/broll/pipeline/${planPipelineId}/search-user-placement`, {
        userPlacementId, ...overrides,
      })
      // Wait for the worker to drain this row before reloading editor-state.
      await pollBrollSearch(enq.brollSearchId, { signal: controller.signal })

      // Reload editor-state to pick up new results on the userPlacement
      const data = await authFetch(`/broll/pipeline/${planPipelineId}/editor-state`)
      const sessionScoped = {
        ...data,
        state: data?.state ? {
          ...data.state,
          undoStack: filterToSession(data.state.undoStack),
          redoStack: filterToSession(data.state.redoStack),
        } : data?.state,
      }
      dispatch({ type: 'LOAD_EDITOR_STATE', payload: sessionScoped })
    } catch (err) {
      if (err.name === 'AbortError') return
      console.error('[broll] user placement search failed:', err.message)
    } finally {
      if (placementPollControllers.current.get(key) === controller) {
        placementPollControllers.current.delete(key)
      }
    }
  }, [planPipelineId])
```

- [ ] **Step 3: Verify file parses**

```bash
node --check src/components/editor/useBRollEditorState.js
```

- [ ] **Step 4: Run frontend tests**

```bash
npm test -- src/components/editor 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/useBRollEditorState.js
git commit -m "feat(broll-editor): poll search status for /search-user-placement enqueue response"
```

---

### Task 4: Final verification

- [ ] **Step 1: Full vitest suite**

```bash
npm test 2>&1 | tail -10
```
Expected: same baseline as PR 2 before frontend changes. The `useBRollEditorState.js` itself has no unit tests, so no new test failures from this change.

- [ ] **Step 2: Verify file still parses & worker behavior unchanged**

```bash
node --check src/components/editor/useBRollEditorState.js
node --check server/services/broll-search-worker.js
```

- [ ] **Step 3: Manual smoke (after deploy of PR 2 + frontend together)**

- [ ] Open the editor for a project with placements. Click search on a single placement. Confirm the spinner appears for ~30s-2min and then results populate.
- [ ] Click search again on the same placement WHILE the first poll is in flight. Confirm only one set of results lands (no double-render, no race).
- [ ] Open the edit-modal for a placement and click "Search with overrides". Confirm same behavior.
- [ ] Search a userPlacement (e.g., from BRollDetailPanel). Confirm editor-state reloads after worker completes.

---

## Self-Review Notes

**Spec coverage:**
- ✅ Async polling for `/search-placement` (Task 2)
- ✅ Async polling for `/search-user-placement` (Task 3)
- ✅ Cancellation via AbortController (re-clicking same placement aborts prior)
- ✅ Failure status mapping (failed/timeout/stopped → 'failed'; complete with results → 'complete'; complete with no results → 'no_results')

**Out of scope (intentional):**
- No reducer changes — the existing SET_PLACEMENT_SEARCHING / SET_PLACEMENT_RESULTS actions are sufficient.
- No progress-during-poll UI (placement just stays in `searching` state until terminal).
- No retry on transient HTTP errors (network errors → fail immediately; user can re-click).
- BRollDetailPanel.jsx caller code is unchanged — the function signatures are identical, only their internals changed.
