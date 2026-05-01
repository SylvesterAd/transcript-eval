# B-Roll Editor Load Performance Plan (Tier A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the b-roll editor's mount-to-interactive time from the observed ~2 minutes (per the user's HAR file) to under 3 seconds, by (1) replacing the full-table-scan `metadata_json LIKE` queries that drive `getBRollEditorData` with an indexed JSONB expression lookup, (2) coalescing duplicate in-flight requests in the frontend `useApi`, and (3) sequentializing the per-variant `editor-data` fetches behind the active variant.

**Architecture:** Three independent layers. The DB layer change is the single biggest win and works on its own. The frontend changes (in-flight dedup + sequentialized inactive fetches) compound on top — they reduce the *number* of editor-data calls so the still-imperfect server can keep up. None of the three depends on the others; they ship together to multiply.

**Tech Stack:** Postgres 14+ (Supabase), Node.js 18+ Express server, React 18 + Vite frontend, Vitest for tests, no new dependencies.

---

## Investigation evidence (recorded in this plan so the reader doesn't have to re-derive it)

The HAR file the user supplied (taken on `/editor/225/brolls/edit/user:u_f914ac40-59a`, 3 b-roll variants) showed:

| Metric | Value |
|---|---|
| Total HTTP entries | 106 |
| API entries | 27 |
| Sum of API time | 375 s |
| Slowest 5 calls | 360 s (96 % of total) |
| 3× `editor-data` calls | 134 s, 114 s, 108 s — each ≥99 % in server "Wait" (TTFB) |
| `editor-state` for active pipeline fetched | **11×** |
| Each inactive `editor-data` URL fetched | **3×** |
| `/api/broll/runs/video/370` payload | **11.4 MB** |

The 3 slow `editor-data` calls all started within 154 ms of each other and finished within 250 ms of each other → they were **queued serially on the server** behind a single bottleneck. The endpoint at `server/services/broll.js:5401` (`getBRollEditorData`) per-call does:

1. `SELECT … FROM broll_runs WHERE metadata_json LIKE '%"pipelineId":"<id>"%' AND status='complete'` — no index, full table scan, returns big rows
2. `ensurePlanUuids(planPipelineId)` — extra query
3. `SELECT * FROM broll_searches WHERE plan_pipeline_id = ?` — already indexed
4. (optional) `SELECT DISTINCT ON (brief) … FROM broll_search_logs ORDER BY brief, id DESC` — full scan + sort
5. `SELECT … FROM broll_runs WHERE metadata_json LIKE '%"pipelineId":"kw-<id>-%'` — second full scan
6. `loadBrollEditorState(planPipelineId)`

Steps 1, 4, and 5 are the dominant cost. Steps 1 and 5 are addressable with a JSONB expression index (Task 1). Step 4 is gated behind a fallback path that doesn't fire on healthy pipelines — out of scope for Tier A. Verified by reading the function body at `server/services/broll.js:5401-5689` end-to-end.

The frontend reasons for the 11× and 3× duplicate counts trace to:

- **`useApi`** (`src/hooks/useApi.js`) has no in-flight cache — concurrent identical calls each make their own network request
- **`BRollEditor.jsx:81-111`** fires inactive-variant `editor-data` for *every* inactive variant in parallel, **and** has `brollState.searchProgress?.status` in its deps so re-fires whenever search state flips during load
- React's strict-mode double-render in dev compounds, but production saw 3× per URL because the searchProgress-status dep flipped during initial load

`metadata_json` is `TEXT` per `server/schema-pg.sql:269`, but the contents are always JSON-stringified objects (verified by every writer using `JSON.stringify(metadata)`). So `(metadata_json::jsonb ->> 'pipelineId')` is safe.

`server/db.js` runs migrations inline at server boot via `pool.query(\`ALTER … IF NOT EXISTS …\`)` — that's the convention this plan follows. Migrations are idempotent and use `IF NOT EXISTS`.

---

## File Structure

Five files modified, no new files. The DB migration lives inline in the existing `server/db.js` migrations block, matching the project convention (lines 47-152 are inline migrations).

- **Modify:** `server/db.js` — add one `CREATE INDEX CONCURRENTLY IF NOT EXISTS` for the JSONB pipelineId expression on `broll_runs`. Inline migration block.
- **Modify:** `server/services/broll.js` — three query rewrites in `getBRollEditorData()` (lines 5403, 5527, 5585) replacing `metadata_json LIKE '%"pipelineId":"…"%'` with `(metadata_json::jsonb ->> 'pipelineId')` equality / prefix match.
- **Modify:** `src/hooks/useApi.js` — add an in-flight-request `Map<string, Promise>` so concurrent identical GETs share one network call.
- **Modify:** `src/components/editor/BRollEditor.jsx` — change inactive-variant fetch (lines 81-111) to (a) wait until active variant finished loading, (b) fetch one inactive at a time sequentially, (c) drop `searchProgress?.status` from the initial-load effect deps and split polling into a separate effect.
- **Test:** No automated tests added for the index migration (would require a real Postgres). Existing vitest suite must still pass. Manual verification step (Task 6) is a HAR comparison against the user's recorded baseline.

---

### Task 1: Add JSONB expression index on `broll_runs.metadata_json -> 'pipelineId'`

**Files:**
- Modify: `server/db.js` — append to inline migrations block (around line 150, just below the `broll_searches` migrations, before the `broll_placement_uuids` block)

The expression `(metadata_json::jsonb ->> 'pipelineId')` extracts the pipelineId as text. A btree index on this expression supports both equality lookups (`= $1`) and right-anchored `LIKE 'prefix%'`. We add `text_pattern_ops` so the index is usable for `LIKE` regardless of the database collation (some Supabase databases default to non-C collations and that would otherwise disable LIKE-prefix index usage).

`CREATE INDEX CONCURRENTLY` is required because `broll_runs` is the largest table in the system (every LLM call appends a row) and we don't want the migration to block writes on server boot. The `IF NOT EXISTS` clause is supported with `CONCURRENTLY` in PG 9.5+.

- [ ] **Step 1: Add the migration**

Open `server/db.js`. Find the migrations block — there's a `try { … } catch` around `pool.query(\`ALTER TABLE …\`)` calls starting around line 47. Find the END of that block (after the last `ALTER TABLE`/`CREATE INDEX`, before the closing `} catch (err)`). Add this single statement:

```javascript
    // Index broll_runs by pipelineId extracted from metadata_json.
    // Replaces full-table LIKE '%"pipelineId":"…"%' scans in getBRollEditorData()
    // and a dozen other call sites. text_pattern_ops makes the index usable
    // for LIKE 'prefix%' matches regardless of database collation.
    await pool.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_broll_runs_pipeline_id
      ON broll_runs ((metadata_json::jsonb ->> 'pipelineId') text_pattern_ops)
      WHERE status = 'complete'
    `).catch(err => {
      // CONCURRENTLY can't run inside a transaction; if the schema-init query above
      // is treated as one, retry without CONCURRENTLY. Logged so we know which path
      // we took.
      if (err.code === '25001' || /transaction block/i.test(err.message)) {
        console.warn('[db] CONCURRENTLY refused; falling back to blocking CREATE INDEX')
        return pool.query(`
          CREATE INDEX IF NOT EXISTS idx_broll_runs_pipeline_id
          ON broll_runs ((metadata_json::jsonb ->> 'pipelineId') text_pattern_ops)
          WHERE status = 'complete'
        `)
      }
      throw err
    })
```

- [ ] **Step 2: Sanity-check the SQL parses locally**

Run a syntax-only check against the file (this won't connect to a real DB, just verifies node loads it):

```bash
node --check server/db.js
```

Expected: no output (silent = OK).

- [ ] **Step 3: Commit**

```bash
git add server/db.js
git commit -m "perf(broll): index broll_runs by metadata_json pipelineId"
```

---

### Task 2: Rewrite the three hot LIKE queries in `getBRollEditorData()` to use the indexed expression

**Files:**
- Modify: `server/services/broll.js` — three call sites at lines 5403-5407, 5527-5530, 5584-5586

Only the three queries inside `getBRollEditorData()` are rewritten. The other 32 LIKE call sites elsewhere in `broll.js` continue to work (they hit a full scan, which is what they did before — no regression). Targeting only the hot path keeps the diff small and reviewable, and keeps the change strictly perf-additive.

The expression `(metadata_json::jsonb ->> 'pipelineId')` returns the pipelineId text. For the first query it's an equality lookup; for the third (`kw-<id>-%`) it's a prefix lookup that the index can serve thanks to `text_pattern_ops`.

The legacy fallback query at line 5527 (`bs-<planPipelineId>-`) is also a prefix lookup — same treatment.

- [ ] **Step 1: Rewrite query #1 (line 5403)**

Find:
```javascript
  const planSubRuns = await db.prepare(`
    SELECT id, output_text, metadata_json FROM broll_runs
    WHERE metadata_json LIKE ? AND status = 'complete'
    ORDER BY id
  `).all(`%"pipelineId":"${planPipelineId}"%`)
```

Replace with:
```javascript
  const planSubRuns = await db.prepare(`
    SELECT id, output_text, metadata_json FROM broll_runs
    WHERE (metadata_json::jsonb ->> 'pipelineId') = ? AND status = 'complete'
    ORDER BY id
  `).all(planPipelineId)
```

- [ ] **Step 2: Rewrite query #2 (line 5527, legacy fallback)**

Find:
```javascript
    const searchRuns = await db.prepare(`
      SELECT id, output_text, metadata_json FROM broll_runs
      WHERE metadata_json LIKE ? AND status IN ('complete', 'failed')
      ORDER BY id
    `).all(`%"pipelineId":"bs-${planPipelineId}-%`)
```

Replace with:
```javascript
    const searchRuns = await db.prepare(`
      SELECT id, output_text, metadata_json FROM broll_runs
      WHERE (metadata_json::jsonb ->> 'pipelineId') LIKE ? AND status IN ('complete', 'failed')
      ORDER BY id
    `).all(`bs-${planPipelineId}-%`)
```

Note: the prefix `bs-…-%` ends with `%` (a glob the index supports), the leading `%` from the original wildcard is gone. The partial-index `WHERE status='complete'` does NOT cover this query (it has `status IN ('complete','failed')`) — so this query still does a heap scan, just one driven by the LIKE prefix on the expression rather than a full-table substring scan. The benefit is smaller here but still meaningful (Postgres can use the index for the prefix match and only check `status` per row).

- [ ] **Step 3: Rewrite query #3 (line 5584, kw runs)**

Find:
```javascript
  const kwRuns = await db.prepare(
    `SELECT output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete'`
  ).all(`%"pipelineId":"kw-${planPipelineId}-%`)
```

Replace with:
```javascript
  const kwRuns = await db.prepare(
    `SELECT output_text, metadata_json FROM broll_runs WHERE (metadata_json::jsonb ->> 'pipelineId') LIKE ? AND status = 'complete'`
  ).all(`kw-${planPipelineId}-%`)
```

This one IS covered by the partial index (`status='complete'`), so it goes from full scan to index scan.

- [ ] **Step 4: Run existing tests to confirm no regressions**

```bash
npx vitest run
```

Expected: same pass/fail count as on `origin/main` HEAD (3 pre-existing failures in unrelated upload-config + server/db tests are environmental — same as current main; verify the failure count and failing files match).

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js
git commit -m "perf(broll): use indexed JSONB expression for pipelineId lookups in getBRollEditorData"
```

---

### Task 3: Add in-flight request deduplication to `useApi`'s `fetchWithRetry`

**Files:**
- Modify: `src/hooks/useApi.js` — wrap `fetchWithRetry` with a module-level `Map<path, Promise>` cache that releases on settle

When two components ask for the same URL at the same time (e.g., `EditorView.jsx:53` and the inactive-variant fetch in `BRollEditor.jsx:87`, or `useApi` re-firing under React strict-mode), each currently makes its own request. We coalesce them: the second caller awaits the same Promise as the first.

Important: this is **in-flight only**. Once the Promise settles, the entry is deleted, so this is NOT a stale cache. Genuine refetches still hit the network. This avoids the cache-invalidation problem entirely.

We only dedupe GETs — `apiPost`/`apiPut`/`apiDelete` are not idempotent and must each make their own request.

- [ ] **Step 1: Add the in-flight cache**

Replace the `fetchWithRetry` function (lines 25-47 in current `src/hooks/useApi.js`) with:

```javascript
// In-flight GET cache: coalesce concurrent identical requests so multiple
// components asking for the same URL don't each fire their own network call.
// Entry is deleted as soon as the underlying Promise settles, so this is NOT
// a stale-data cache.
const inflightGets = new Map() // path → Promise<json>

async function fetchWithRetry(path, maxAttempts = 3) {
  if (inflightGets.has(path)) return inflightGets.get(path)

  const promise = (async () => {
    let lastErr
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const headers = await getAuthHeaders()
        const res = await fetch(`${BASE}${path}`, { headers })
        if (res.status === 401) {
          handleUnauthorized(res)
          throw new Error('401 Unauthorized')
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return await res.json()
      } catch (e) {
        lastErr = e
        if (e.message.startsWith('401')) break
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt - 1)))
        }
      }
    }
    throw lastErr
  })()

  inflightGets.set(path, promise)
  // Release the entry whether the request succeeds or fails.
  promise.finally(() => inflightGets.delete(path))
  return promise
}
```

- [ ] **Step 2: Smoke-test the existing useApi tests**

```bash
npx vitest run src/components/editor/__tests__/BRollEditor.test.jsx src/components/editor/__tests__/useBRollEditorState.test.jsx
```

Expected: both files pass (same as before — they import from BRollEditor.jsx which transitively uses useApi, so this catches import-level regressions).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useApi.js
git commit -m "perf(api): coalesce in-flight GET requests in fetchWithRetry"
```

---

### Task 4: Sequentialize inactive-variant `editor-data` fetches behind the active variant

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx` — replace the inactive-variant fetch effect (lines 81-111) with two effects: an initial-load effect that runs once after the active variant is loaded, and a separate polling effect for in-progress searches

Today, `BRollEditor.jsx:81-111` fires inactive-variant `editor-data` requests in parallel **immediately on mount**, *while* the active variant's `editor-data` is also in flight. With N variants this means N concurrent calls on a server that processes them serially. The user's HAR shows three of these calls each blocking ~110 s.

The plan:
1. **Wait for the active variant to finish loading** before firing any inactive fetch — gate on `!brollState.loading`. This keeps the server's first ~200 ms (post-Task-2) dedicated to the only request the user is actually waiting on.
2. **Fire inactive fetches sequentially**, not in parallel, with a small delay between them. With the index in place each call is ~200 ms, so two inactives finish in ~500 ms total — well within "fast enough that the user can switch variants without waiting".
3. **Split the polling concern** into its own effect, so the every-5s polling no longer re-fires `fetchInactive()` from the dep change of `searchProgress?.status` — the polling effect handles its own timer and isn't entangled with the initial load.

Selection caching (the `seedFromCache` path) continues to work — once an inactive variant has been fetched once and stored in `rawInactivePlacements`, switching to it is instant.

- [ ] **Step 1: Replace the inactive-variant effect**

Find the existing effect at `src/components/editor/BRollEditor.jsx:81-111`:

```jsx
  const [rawInactivePlacements, setRawInactivePlacements] = useState({})
  // Load inactive variant placements, and re-fetch while searches are running
  useEffect(() => {
    if (variants.length <= 1) return
    const inactiveIds = variants.filter((_, i) => i !== activeVariantIdx).map(v => v.id)
    const controller = new AbortController()
    function fetchInactive() {
      for (const pid of inactiveIds) {
        authFetchBRollData(pid, controller.signal)
          .then(data => {
            const serverPlacements = data.placements || []
            setRawInactivePlacements(prev => {
              const local = prev[pid] || []
              const serverIds = new Set(serverPlacements.filter(p => p.userPlacementId).map(p => p.userPlacementId))
              // Keep local optimistic userPlacements whose uuids are NOT yet on server
              // (they're in flight; replacing would make them vanish from view).
              const optimistic = local.filter(p => p.isUserPlacement && p.userPlacementId && !serverIds.has(p.userPlacementId))
              return { ...prev, [pid]: [...serverPlacements, ...optimistic] }
            })
          })
          .catch(err => { if (err.name !== 'AbortError') {/* swallow */} })
      }
    }
    fetchInactive()
    // Re-fetch every 5s while a search is running
    const isRunning = brollState.searchProgress?.status === 'running'
    if (!isRunning) return () => controller.abort()
    const interval = setInterval(fetchInactive, 5000)
    return () => {
      clearInterval(interval)
      controller.abort()
    }
  }, [variants, activeVariantIdx, brollState.searchProgress?.status])
```

Replace with two separate effects:

```jsx
  const [rawInactivePlacements, setRawInactivePlacements] = useState({})

  // Helper: merges a fresh server fetch into rawInactivePlacements while preserving
  // local optimistic userPlacements whose uuids haven't reached the server yet.
  const mergeInactiveFetch = useCallback((pid, serverPlacements) => {
    setRawInactivePlacements(prev => {
      const local = prev[pid] || []
      const serverIds = new Set(serverPlacements.filter(p => p.userPlacementId).map(p => p.userPlacementId))
      const optimistic = local.filter(p => p.isUserPlacement && p.userPlacementId && !serverIds.has(p.userPlacementId))
      return { ...prev, [pid]: [...serverPlacements, ...optimistic] }
    })
  }, [])

  // Effect 1: ONE-SHOT initial load of inactive variants, sequentially, AFTER the
  // active variant has finished loading. This deliberately avoids the all-in-parallel
  // pattern that pinned the server (HAR file 2026-04-30: three concurrent editor-data
  // calls each waiting ~110 s on a serialized backend bottleneck).
  useEffect(() => {
    if (variants.length <= 1) return
    if (brollState.loading) return  // wait for active variant to land
    const inactiveIds = variants.filter((_, i) => i !== activeVariantIdx).map(v => v.id)
    // Skip already-loaded variants (cheap O(N) check; N is small)
    const stillNeeded = inactiveIds.filter(pid => !(rawInactivePlacements[pid]?.length))
    if (!stillNeeded.length) return
    const controller = new AbortController()
    let cancelled = false
    ;(async () => {
      for (const pid of stillNeeded) {
        if (cancelled) return
        try {
          const data = await authFetchBRollData(pid, controller.signal)
          if (cancelled) return
          mergeInactiveFetch(pid, data.placements || [])
        } catch (err) {
          if (err.name !== 'AbortError') {/* swallow */}
        }
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [variants, activeVariantIdx, brollState.loading, rawInactivePlacements, mergeInactiveFetch])

  // Effect 2: poll inactive variants every 5 s ONLY while a search is running.
  // Separate from the initial-load effect so a status flip doesn't refire the load.
  useEffect(() => {
    if (variants.length <= 1) return
    if (brollState.searchProgress?.status !== 'running') return
    const inactiveIds = variants.filter((_, i) => i !== activeVariantIdx).map(v => v.id)
    if (!inactiveIds.length) return
    const controller = new AbortController()
    const interval = setInterval(async () => {
      for (const pid of inactiveIds) {
        try {
          const data = await authFetchBRollData(pid, controller.signal)
          mergeInactiveFetch(pid, data.placements || [])
        } catch (err) {
          if (err.name !== 'AbortError') {/* swallow */}
        }
      }
    }, 5000)
    return () => {
      clearInterval(interval)
      controller.abort()
    }
  }, [variants, activeVariantIdx, brollState.searchProgress?.status, mergeInactiveFetch])
```

Two notes on the change:
- The **initial-load effect** now has `rawInactivePlacements` in its deps. That's intentional: it lets the effect bail out (`if (!stillNeeded.length) return`) on re-renders without re-firing fetches. The `useCallback` on `mergeInactiveFetch` keeps the dep stable.
- The **polling effect**'s loop fetches each variant sequentially within one tick (the `for…of await` is intentional, not `Promise.all`) — same anti-stampede reasoning.

`useCallback` is already imported in this file (used by `handleVariantActivate` at line 116). No new imports.

- [ ] **Step 2: Run editor tests**

```bash
npx vitest run src/components/editor/__tests__/
```

Expected: all 25 editor tests pass (same as the baseline established when we shipped PR #18).

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollEditor.jsx
git commit -m "perf(broll): sequentialize inactive variant fetches behind active variant load"
```

---

### Task 5: Run full vitest, confirm no regressions outside known-pre-existing failures

**Files:** none (verification only)

- [ ] **Step 1: Run all tests**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: same overall result as origin/main HEAD before this branch — 3 pre-existing failures in `src/components/upload-config/__tests__/StepRoughCut.test.jsx` and the two `server/services/__tests__/broll-*-uuid*.test.js` files. Established baseline during PR #18 (commit `1336d09`); same failures should remain, no new ones.

- [ ] **Step 2: Verify no test in editor/ or hooks/ regressed**

```bash
npx vitest run src/components/editor/__tests__/ src/hooks 2>&1 | tail -10
```

Expected: all pass.

---

### Task 6: Open PR, ship to prod, verify with a fresh HAR

**Files:** none (deployment + verification)

- [ ] **Step 1: Push branch and open PR**

```bash
git push origin HEAD:fix/broll-editor-load-perf

gh pr create --base main --head fix/broll-editor-load-perf --title "perf(broll): cut editor mount time from ~2min to <3s" --body "$(cat <<'EOF'
## Summary
- Add JSONB expression index on \`broll_runs.metadata_json -> 'pipelineId'\` (Postgres CONCURRENTLY).
- Rewrite three full-table LIKE scans in \`getBRollEditorData()\` to use the indexed expression.
- Coalesce in-flight identical GETs in \`useApi\` so duplicate component requests share one network call.
- Sequentialize per-variant \`editor-data\` fetches behind the active variant's load and split polling into its own effect, eliminating the on-mount fan-out that pinned the server.

## Why
HAR file from \`/editor/225/brolls/edit/...\`:
- 3 \`editor-data\` calls × 108-134 s each, 99% in server "Wait" (TTFB)
- \`editor-state\` for active pipeline fetched 11×; each inactive \`editor-data\` URL 3×
- Total API time ~375 s

Root cause: \`getBRollEditorData()\` does a full-table substring scan of \`broll_runs.metadata_json\` per call, fired 3-8× in parallel by the BRollEditor's all-variants-at-once fetch pattern + lack of frontend in-flight dedup.

## Test plan
- [ ] Capture a fresh HAR from \`/editor/225/brolls/edit/...\` post-deploy. Expected: zero \`editor-data\` calls > 1 s wait. Total API time < 5 s. No duplicate \`editor-state\` URLs.
- [ ] Verify variant switching is still snappy (cached on first fetch, instant on subsequent).
- [ ] Verify in-progress search still updates inactive-variant tracks every 5 s (polling effect intact).
- [ ] No regression in rough-cut load time (this branch only touches b-roll paths).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Squash-merge after CI passes**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 3: Wait for Vercel + Railway to redeploy**

The migration runs at server boot — `CREATE INDEX CONCURRENTLY` may take a minute on a large `broll_runs` table but does not block reads. Watch Railway logs for `[db] Schema initialized`.

- [ ] **Step 4: Capture a fresh HAR and compare**

In Chrome: open `/editor/225/brolls/edit/user:u_f914ac40-59a` with DevTools → Network → "Disable cache" checked. Wait for the editor to be interactive. Right-click in Network panel → "Save all as HAR with content".

Compare to the recorded baseline:

| Metric | Baseline | Target |
|---|---|---|
| Slowest API call | 134.1 s | < 1 s |
| Duplicate `editor-state` calls | 11 | 1 |
| Duplicate `editor-data` per pipeline | 3 | 1 |
| Total API time | ~375 s | < 5 s |
| Mount-to-interactive (subjective) | ~2 min | < 3 s |

If the slowest call is still > 1 s, the index isn't being used — check `EXPLAIN ANALYZE` against the query in production, and confirm `idx_broll_runs_pipeline_id` exists (`SELECT * FROM pg_indexes WHERE tablename='broll_runs'`).

---

## Self-review notes

- **Spec coverage:** All three Tier A items (DB index, in-flight dedup, sequentialized inactive fetches) are mapped to Tasks 1-4. Verification in Tasks 5-6.
- **Placeholders:** none — every step shows the exact diff, exact file path, exact command.
- **Type/name consistency:** `inflightGets` named consistently across Task 3 step. `mergeInactiveFetch` named consistently in Task 4 (introduced once, used in both effects). `idx_broll_runs_pipeline_id` named identically in Task 1 (both CONCURRENTLY and fallback paths) and Task 6 (verification grep).
- **Migration safety:** `CREATE INDEX CONCURRENTLY IF NOT EXISTS` on Postgres is safe to run on every server boot — idempotent, doesn't block reads or writes. Has a fallback for the (unlikely) case where the migration runs inside an implicit transaction.
- **Risk ordering:** Tasks 1+2 (DB) ship first; if they're wrong, the entire perf gain is lost — but they're guarded by `IF NOT EXISTS` and don't change behavior, only speed. Task 3 (in-flight dedup) is the next-most-impactful frontend change; the in-flight Map is bounded by concurrent requests so no memory leak. Task 4 (sequentialization) has the largest behavioral surface — the new `useCallback` + two-effect split is the only place a regression could hide. The full vitest run in Task 5 is the safety net.
- **What this plan deliberately does NOT do:** The remaining 32 `metadata_json LIKE` call sites in `server/services/broll.js`. The legacy `broll_search_logs DISTINCT ON` scan (gated behind a path that doesn't fire on healthy pipelines). The 11.4 MB `runs/video/<id>` payload bloat. SWR-style caching in `useApi`. Code-splitting the editor bundle. Those are tracked as Tier B/C in the investigation report and will be separate PRs once Tier A is verified in production.
