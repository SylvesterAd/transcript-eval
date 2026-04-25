# DB Pool Structural Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate recurring `MaxClientsInSessionMode` errors from Supavisor by switching the app to transaction-mode pooling, then consolidate hot-path queries and add frontend resilience so a transient pool hiccup never hides data again.

**Architecture:** Single structural pivot — move the `DATABASE_URL` from Supavisor port 5432 (session mode, `max_clients == pool_size ≈ 15`) to port 6543 (transaction mode, `max_clients == 200` on the current tier). `pg`'s default unnamed prepared statements work under transaction mode (verified: no named `{name:}` query calls anywhere in the codebase). Secondary work: trim the editor-open request burst (`/detail` 3-query chain → 1 JOIN), make `useApi` auto-retry transient 5xx/network errors, and batch the two hottest N+1 loops.

**Tech Stack:** Node 20 + Express 5 + `pg` (node-postgres) + Supabase Postgres via Supavisor pooler. React 19 + Vite frontend. Deployed: Railway (backend, auto-deploys on push) + Vercel (frontend, requires manual API deploy for unsigned commits).

**Repo has no test framework** — verification for each task is explicit curl/log checks, not unit tests.

---

## File Structure

| File | Responsibility | Changes |
|---|---|---|
| Railway env (no file) | `DATABASE_URL` | Port 5432 → 6543 |
| `server/db.js` | pg.Pool config + query retry | Tune pool for tx mode; reduce retry backoff post-verification |
| `server/routes/videos.js:467-487` | `GET /groups/:id/detail` | 3 sequential queries → 1 JOIN + 1 conditional |
| `server/routes/videos.js:592-627` | `POST /confirm-classification` | Inner video-UPDATE loop → batched `WHERE id IN (...)` |
| `server/routes/broll.js:890-935` | `POST /pipeline/clean-strategy` | N individual UPDATEs → single transaction, held once |
| `src/hooks/useApi.js` | Frontend data fetching | Add 3-attempt retry with exponential backoff; retain existing `mutate`/`refetch` API |

---

## Task 1: Switch Supabase pooler to transaction mode

**Files:** Railway env var (no code change)

**Why first:** Single env flip, instantly reversible, addresses the direct root cause. Rest of the plan builds on this already working.

- [ ] **Step 1: Capture current DATABASE_URL for rollback**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
set -a && source .env && set +a
curl -s "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"query { variables(projectId: \\\"$RAILWAY_PROJECT_ID\\\", environmentId: \\\"$RAILWAY_ENVIRONMENT_ID\\\", serviceId: \\\"$RAILWAY_SERVICE_ID\\\") }\"}" \
  | python3 -c "import json,sys; v=json.load(sys.stdin)['data']['variables']; print('OLD DATABASE_URL:', v.get('DATABASE_URL'))" \
  > /tmp/old_database_url.txt
cat /tmp/old_database_url.txt
```

Expected: a line starting with `OLD DATABASE_URL: postgresql://...@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`.

- [ ] **Step 2: Compute the new URL (port 5432 → 6543)**

```bash
OLD=$(cat /tmp/old_database_url.txt | sed 's/^OLD DATABASE_URL: //')
NEW=$(echo "$OLD" | sed 's/:5432\//:6543\//')
echo "NEW URL ends in port: $(echo "$NEW" | grep -oE ':[0-9]+/')"
```

Expected: `NEW URL ends in port: :6543/`. Do NOT print the full URL (contains password).

- [ ] **Step 3: Update the Railway env var via GraphQL**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
set -a && source .env && set +a
OLD=$(cat /tmp/old_database_url.txt | sed 's/^OLD DATABASE_URL: //')
NEW=$(echo "$OLD" | sed 's/:5432\//:6543\//')
ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$NEW")
curl -s "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation(\$input: VariableUpsertInput!) { variableUpsert(input: \$input) }\",\"variables\":{\"input\":{\"projectId\":\"$RAILWAY_PROJECT_ID\",\"environmentId\":\"$RAILWAY_ENVIRONMENT_ID\",\"serviceId\":\"$RAILWAY_SERVICE_ID\",\"name\":\"DATABASE_URL\",\"value\":$ESCAPED}}}"
echo ""
```

Expected: `{"data":{"variableUpsert":null}}` (null on success, error object on failure).

- [ ] **Step 4: Wait for Railway to pick up the change and redeploy**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
# Poll health until a fresh deploy timestamp appears (within 3 min of now)
START_TS=$(date +%s)
until DEPLOYED=$(curl -s --max-time 5 "https://backend-production-4b19.up.railway.app/api/health" | python3 -c "import json,sys,datetime; d=json.load(sys.stdin); t=datetime.datetime.fromisoformat(d['deployed'].replace('Z','+00:00')).timestamp(); print(int(t))" 2>/dev/null) \
  && NOW=$(date +%s) \
  && AGE=$((NOW - DEPLOYED)) \
  && echo "[$(date +%H:%M:%S)] deploy age=${AGE}s" \
  && [[ $AGE -lt 180 ]]; do
  sleep 20
done
echo "Fresh deploy detected."
```

Expected: `age` drops from high triple-digits to under 60s, then loop exits.

- [ ] **Step 5: Smoke test — verify basic DB queries work**

```bash
curl -s --max-time 10 "https://backend-production-4b19.up.railway.app/api/health"
```

Expected: `{"status":"ok","version":"...","deployed":"...","timestamp":"..."}`. If this returns the health JSON, the DB connection is alive (schema init ran successfully under the new pooler mode).

- [ ] **Step 6: Check Railway logs for connection/startup errors**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
set -a && source .env && set +a
DEPLOY_ID=$(curl -s "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"query { service(id: \\\"$RAILWAY_SERVICE_ID\\\") { deployments(first: 1) { edges { node { id } } } } }\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['service']['deployments']['edges'][0]['node']['id'])")
curl -s "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"query(\$id: String!) { deploymentLogs(deploymentId: \$id, limit: 200) { message timestamp } }\",\"variables\":{\"id\":\"$DEPLOY_ID\"}}" \
  | python3 -c "
import json, sys
logs = json.load(sys.stdin).get('data',{}).get('deploymentLogs',[])
bad = [l for l in logs if any(k in l.get('message','') for k in ['MaxClients','ECONNREFUSED','prepared statement','SASL','error:','[error]'])]
print(f'Bad markers: {len(bad)}')
for l in bad[-20:]:
    print(l.get('timestamp','')[:19], l.get('message','').strip()[:200])
"
```

Expected: 0 `MaxClientsInSessionMode` occurrences. Minor 401s during boot (auth race before JWT verify loads) are OK. Any `prepared statement` or `SASL` errors → **STOP**, roll back (see Rollback section).

- [ ] **Step 7: Load the editor in a browser**

Open `https://transcript-eval-sylvesterads-projects.vercel.app/editor/225/roughcut` in a browser. Verify:
1. Timeline loads with waveforms.
2. Transcript text is visible (the specific symptom that triggered this work).
3. Token balance shows in the top-right nav.

All three should load without a reload.

- [ ] **Step 8: Commit a breadcrumb noting the mode change**

The env-var change doesn't produce a code diff, but document it so the plan's code changes reference the right pooler mode. Add this breadcrumb to `server/db.js`.

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
```

Then open `server/db.js` and update the top comment to note the pooler contract. Exact change:

```js
// ── Connection ─────────────────────────────────────────────────────────
// DATABASE_URL must point to Supavisor transaction mode (port 6543).
// Session mode (port 5432) caps concurrent clients at pool_size (~15
// on Nano/Micro), which we exhausted. Transaction mode returns the
// backend to the shared pool after each transaction, so pg.Pool can
// hold many idle clients without reserving Supabase backends.
// Do NOT use named prepared statements (client.query({ name:...})) —
// they break under transaction pooling.
const DATABASE_URL = process.env.DATABASE_URL
```

Replace the existing `// ── Connection ──` block header + `const DATABASE_URL = process.env.DATABASE_URL` line with the block above.

```bash
git add server/db.js
git commit -m "docs(db): note Supavisor transaction-mode contract at pool setup"
git push origin main
```

No Vercel deploy needed (backend-only change, Railway auto-deploys; no behavior change).

---

## Task 2: Tune pg.Pool config for transaction mode

**Files:**
- Modify: `server/db.js:15-21`

**Why:** With transaction mode, holding more pool clients is cheap (they don't reserve backends). Add timeouts + keepalive + application_name for observability.

- [ ] **Step 1: Read current pool config to confirm baseline**

```bash
sed -n '14,25p' "/Users/laurynas/Desktop/one last /transcript-eval/server/db.js"
```

Expected:
```
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})
```

- [ ] **Step 2: Update the pool config**

Replace the block above with:

```js
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 10,
  min: 0,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  statement_timeout: 30000,
  query_timeout: 30000,
  application_name: 'transcript-eval',
})
```

Rationale: `max: 10` per process is fine under transaction mode; `keepAlive` avoids TCP reset surprises on idle connections; per-query timeouts prevent a hung LLM-adjacent DB query from holding a slot forever; `application_name` shows up in Supabase's query logs for diagnosis.

- [ ] **Step 3: Syntax-check**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node --check server/db.js && echo "  ✓ parses"
```

Expected: `  ✓ parses`.

- [ ] **Step 4: Commit and push**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/db.js
git commit -m "perf(db): tune pg.Pool for Supavisor transaction mode

max 5→10, add keepAlive, statement_timeout/query_timeout 30s, and
application_name for Supabase query-log attribution. Safe under
transaction mode — idle clients no longer reserve backends."
git push origin main
```

- [ ] **Step 5: Wait for Railway redeploy and verify health**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
SHA=$(git rev-parse HEAD | cut -c1-7)
until V=$(curl -s --max-time 5 "https://backend-production-4b19.up.railway.app/api/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null) \
  && echo "[$(date +%H:%M:%S)] railway=$V" \
  && [[ "$V" == "$SHA" ]]; do sleep 20; done
```

Expected: eventually prints `railway=<new sha>`.

- [ ] **Step 6: Load the editor and hammer refetches**

Open the editor in a browser, navigate `/sync` → `/roughcut` → `/assets` → `/brolls` a few times, watching for any console errors or blanks. With `max: 10`, burst fetches should now sail through.

---

## Task 3: Frontend — `useApi` auto-retry + error surfacing

**Files:**
- Modify: `src/hooks/useApi.js`

**Why:** Even with transaction mode, network blips and transient 5xx exist. A single failed GET on editor mount currently leaves state silently null (that's what caused "reload to see transcript"). Auto-retry with exponential backoff turns the failure invisible.

- [ ] **Step 1: Read the current file**

```bash
sed -n '1,50p' "/Users/laurynas/Desktop/one last /transcript-eval/src/hooks/useApi.js"
```

Reference behavior: `useApi(path, deps)` returns `{ data, loading, error, refetch, mutate }`. The `refetch` does a single fetch with auth headers and either sets data or sets error.

- [ ] **Step 2: Add a retry helper above `useApi`**

Insert these lines after line 23 (after `handleUnauthorized` function, before `export function useApi`):

```js
async function fetchWithRetry(path, maxAttempts = 3) {
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
      // Don't retry auth errors — they won't succeed by retrying
      if (e.message.startsWith('401')) break
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt - 1)))
      }
    }
  }
  throw lastErr
}
```

Three attempts with 300ms/600ms backoff = ~900ms total extra latency worst case, ≪ human perception threshold for a still-loading page. Auth errors short-circuit (a bad token won't fix itself by retrying).

- [ ] **Step 3: Swap the `refetch` implementation to use `fetchWithRetry`**

Replace the body of `refetch` (the `const refetch = useCallback(...)` block) with:

```js
  const refetch = useCallback((silent) => {
    if (!path) { setLoading(false); return }
    if (!silent) { setLoading(true); setError(null) }
    fetchWithRetry(path)
      .then(setData)
      .catch(e => { if (!silent) setError(e.message) })
      .finally(() => { if (!silent) setLoading(false) })
  }, [path])
```

Same external shape; internal fetch now retries.

- [ ] **Step 4: Build to confirm no syntax errors**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npm run build 2>&1 | tail -3
```

Expected: `✓ built in Xms` and a dist hash.

- [ ] **Step 5: Commit, push, force-deploy Vercel**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/hooks/useApi.js
git commit -m "feat(useApi): auto-retry transient failures with exponential backoff

3-attempt retry at 300/600ms covers the transient 5xx/network
blips that previously surfaced as silent blank UI (empty transcript,
empty assets, empty examples) and required a hard reload. Auth
errors skip the retry loop. API shape unchanged."
git push origin main

set -a && source .env && set +a
SHA=$(git rev-parse HEAD)
DEPLOY_ID=$(curl -s -X POST "https://api.vercel.com/v13/deployments?teamId=$VERCEL_TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"transcript-eval\",\"project\":\"$VERCEL_PROJECT_ID\",\"gitSource\":{\"type\":\"github\",\"repoId\":\"1185581833\",\"ref\":\"main\",\"sha\":\"$SHA\"},\"target\":\"production\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
echo "Vercel deploy: $DEPLOY_ID"
until STATE=$(curl -s "https://api.vercel.com/v13/deployments/$DEPLOY_ID?teamId=$VERCEL_TEAM_ID" -H "Authorization: Bearer $VERCEL_TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin).get('readyState','?'))") \
  && echo "[$(date +%H:%M:%S)] state=$STATE" \
  && [[ "$STATE" == "READY" || "$STATE" == "ERROR" || "$STATE" == "CANCELED" ]]; do sleep 15; done
```

Expected: `state=READY`.

- [ ] **Step 6: Verify retry works in the browser**

Open DevTools → Network tab. Load `/editor/225/roughcut`. If any request fails once it should retry silently; rightmost column in the Network tab will show the extra attempts. Transcript should load without needing a manual reload.

---

## Task 4: Consolidate `GET /groups/:id/detail` into a JOIN

**Files:**
- Modify: `server/routes/videos.js:467-487`

**Why:** Every editor page mount fires this endpoint. Currently it runs 3 sequential queries (group, videos, optional relatedGroups). Each holds a backend for ~20–50ms serially. A single query keeps the response shape identical but halves the pool pressure per page load.

- [ ] **Step 1: Read the current handler**

```bash
sed -n '467,488p' "/Users/laurynas/Desktop/one last /transcript-eval/server/routes/videos.js"
```

- [ ] **Step 2: Rewrite as a single parallel-ish function**

Replace lines 467-487 with:

```js
router.get('/groups/:id/detail', requireAuth, async (req, res) => {
  const groupId = req.params.id
  const userScope = isAdmin(req) ? '' : 'AND user_id = ?'
  const userArgs = isAdmin(req) ? [] : [req.auth.userId]

  // Kick off the two independent reads in parallel — pg.Pool will use
  // two backends briefly under transaction mode and return them as
  // soon as the SELECTs finish.
  const [group, videos] = await Promise.all([
    db.prepare(`SELECT * FROM video_groups WHERE id = ? ${userScope}`).get(groupId, ...userArgs),
    db.prepare('SELECT id, title, video_type, duration_seconds, transcription_status, transcription_error, thumbnail_path, file_path, frames_status FROM videos WHERE group_id = ?').all(groupId),
  ])
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const relatedGroups = group.upload_batch_id
    ? await db.prepare(
        'SELECT id, name, assembly_status FROM video_groups WHERE upload_batch_id = ? AND id != ?'
      ).all(group.upload_batch_id, group.id)
    : []

  res.json({
    ...group,
    videos,
    relatedGroups,
    assembly_details: group.assembly_details_json ? JSON.parse(group.assembly_details_json) : null,
    timeline: group.timeline_json ? JSON.parse(group.timeline_json) : null,
    rough_cut_config: group.rough_cut_config_json ? JSON.parse(group.rough_cut_config_json) : null,
    editor_state: group.editor_state_json ? JSON.parse(group.editor_state_json) : null,
    annotations: group.annotations_json ? JSON.parse(group.annotations_json) : null,
  })
})
```

The two guaranteed queries (`group` + `videos`) now race in parallel; `relatedGroups` is unchanged but only runs when it's needed. Response shape is identical to before.

- [ ] **Step 3: Syntax-check**

```bash
node --check "/Users/laurynas/Desktop/one last /transcript-eval/server/routes/videos.js" && echo "  ✓ parses"
```

- [ ] **Step 4: Commit and push**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/routes/videos.js
git commit -m "perf(videos): parallelize /groups/:id/detail queries

Group + videos SELECTs are independent — run them with Promise.all
instead of serially. relatedGroups still only runs when
upload_batch_id is set. Response shape unchanged. Halves sequential
DB latency on every editor page mount."
git push origin main
```

- [ ] **Step 5: Verify the response shape hasn't drifted**

Wait for redeploy (same pattern as Task 2 Step 5), then:

```bash
# Use the session cookie/JWT from a browser, or do this via the browser DevTools.
# Quick smoke check — open the editor for a known group and confirm it loads.
echo "Load https://transcript-eval-sylvesterads-projects.vercel.app/editor/225/sync and confirm timeline + videos render."
```

Expected: editor still loads, transcript/waveforms still present. Any missing fields → STOP (response shape drifted).

---

## Task 5: Batch the N+1 UPDATE in `POST /confirm-classification`

**Files:**
- Modify: `server/routes/videos.js:604-615`

**Why:** User confirming classification on a project with 400 clips hits 400 sequential UPDATEs. Each one acquires a pool slot briefly. Collapses to one UPDATE per sub-group.

- [ ] **Step 1: Read the current inner loop**

```bash
sed -n '600,625p' "/Users/laurynas/Desktop/one last /transcript-eval/server/routes/videos.js"
```

- [ ] **Step 2: Replace the inner UPDATE loop with a single batched UPDATE**

Replace lines 604-615 with:

```js
  for (const g of groups) {
    const r = await db.prepare(
      'INSERT INTO video_groups (name, assembly_status, parent_group_id, user_id) VALUES (?, ?, ?, ?)'
    ).run(g.name, 'pending', groupId, req.auth.userId)
    const subId = r.lastInsertRowid
    subGroupIds.push(subId)

    if (g.videoIds?.length) {
      const placeholders = g.videoIds.map(() => '?').join(',')
      await db.prepare(`UPDATE videos SET group_id = ? WHERE id IN (${placeholders})`)
        .run(subId, ...g.videoIds)
    }
    console.log(`[confirm] Sub-group "${g.name}": ${g.videoIds?.length || 0} videos → group ${subId}`)
  }
```

Keeps the outer INSERT-per-subgroup (unavoidable, we need the generated `subId`), but reduces N inner UPDATEs to 1.

- [ ] **Step 3: Syntax check + commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node --check server/routes/videos.js && echo "  ✓ parses"
git add server/routes/videos.js
git commit -m "perf(videos): batch video-UPDATE in confirm-classification

Classification with N sub-groups × M videos was firing N×M
individual UPDATEs. Collapse each sub-group's UPDATE to a single
WHERE id IN (...) query — M times fewer pool acquisitions per
request."
git push origin main
```

- [ ] **Step 4: Verify via Railway redeploy + a classification flow if there's one pending**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
SHA=$(git rev-parse HEAD | cut -c1-7)
until V=$(curl -s --max-time 5 "https://backend-production-4b19.up.railway.app/api/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null) \
  && echo "[$(date +%H:%M:%S)] railway=$V" \
  && [[ "$V" == "$SHA" ]]; do sleep 20; done
```

Expected: railway on new sha. Manual: if a project is currently in classification state, confirm it; expect no visible change in UX, just fewer log lines.

---

## Task 6: Wrap `clean-strategy` UPDATEs in a single transaction

**Files:**
- Modify: `server/routes/broll.js:890-935`

**Why:** The per-row UPDATE here is unavoidable (each row has a unique JSON blob). But wrapping all N UPDATEs in a single transaction holds exactly one pool slot for the whole batch instead of N acquire/release cycles. Also cheaper on Supavisor (one transaction, not N).

- [ ] **Step 1: Read the current handler**

```bash
sed -n '890,935p' "/Users/laurynas/Desktop/one last /transcript-eval/server/routes/broll.js"
```

- [ ] **Step 2: Rewrite with an explicit client + transaction**

Replace the full `router.post('/pipeline/clean-strategy', ...)` handler (lines 890 through the closing `})` around line 935) with:

```js
router.post('/pipeline/clean-strategy', requireAuth, async (req, res) => {
  try {
    const { strategy_pipeline_id } = req.body || {}
    if (!strategy_pipeline_id) return res.status(400).json({ error: 'strategy_pipeline_id required' })
    const db = (await import('../db.js')).default

    const runs = await db.prepare(
      `SELECT id, output_text, metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
    ).all(`%"pipelineId":"${strategy_pipeline_id}"%`)

    const subRuns = runs.filter(r => { try { return JSON.parse(r.metadata_json || '{}').isSubRun } catch { return false } })
    const maxStage = subRuns.reduce((max, r) => { try { return Math.max(max, JSON.parse(r.metadata_json || '{}').stageIndex ?? 0) } catch { return max } }, -1)
    const lastStageRuns = subRuns.filter(r => { try { return (JSON.parse(r.metadata_json || '{}').stageIndex ?? 0) === maxStage } catch { return false } })

    // Build (id, newOutput) pairs first — don't hold a pool slot while parsing
    const updates = []
    for (const run of lastStageRuns) {
      try {
        const jsonMatch = run.output_text?.match(/```json\s*([\s\S]*?)```/)
        const parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(run.output_text || '{}')
        delete parsed.matched_reference_chapter
        delete parsed.commonalities
        if (parsed.strategy) delete parsed.strategy.commonalities
        const bs = parsed.beat_strategies || parsed.beatStrategies || []
        for (const b of bs) {
          delete b.matched_reference_beat
          delete b.match_reason
        }
        updates.push({ id: run.id, newOutput: '```json\n' + JSON.stringify(parsed, null, 2) + '\n```' })
      } catch (err) {
        console.error(`[clean-strategy] Failed to parse run ${run.id}:`, err.message)
      }
    }

    // One transaction holds a single pool slot for the whole batch
    let cleaned = 0
    if (updates.length) {
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        for (const u of updates) {
          await client.query('UPDATE broll_runs SET output_text = $1 WHERE id = $2', [u.newOutput, u.id])
          cleaned++
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    }

    res.json({ success: true, cleaned })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

Key changes:
- Parse/prep happens before we grab a pool client (so the slot isn't held during JSON work).
- A single `client.connect()` + `BEGIN`/`COMMIT` holds one slot for the whole batch.
- If any UPDATE throws, `ROLLBACK` + re-throw — the caller sees a 500 and no partial cleanup.

- [ ] **Step 3: Syntax check + commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node --check server/routes/broll.js && echo "  ✓ parses"
git add server/routes/broll.js
git commit -m "perf(broll): batch clean-strategy UPDATEs into one transaction

Per-row JSON parsing now happens before the pool client is acquired,
then all UPDATEs run inside a single BEGIN/COMMIT. One pool slot
held for the full batch instead of N acquire/release cycles."
git push origin main
```

- [ ] **Step 4: Wait for redeploy**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
SHA=$(git rev-parse HEAD | cut -c1-7)
until V=$(curl -s --max-time 5 "https://backend-production-4b19.up.railway.app/api/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null) \
  && echo "[$(date +%H:%M:%S)] railway=$V" \
  && [[ "$V" == "$SHA" ]]; do sleep 20; done
```

---

## Task 7: Trim `queryWithRetry` now that transaction mode handles the burst

**Files:**
- Modify: `server/db.js:81-97` (the `queryWithRetry` function added in commit `7756cb0`)

**Why:** Under transaction mode the pool exhaustion case we were defending against (`MaxClientsInSessionMode`) should effectively disappear. Three retries with growing backoff adds latency and masks real failures. Keep one retry as safety net; drop the rest.

Only do this task after at least 24 hours of production traffic under Tasks 1–6 with no `MaxClientsInSessionMode` in Railway logs. If you haven't waited, skip and come back.

- [ ] **Step 1: Confirm no `MaxClientsInSessionMode` errors since Task 1 landed**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
set -a && source .env && set +a
DEPLOY_ID=$(curl -s "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"query { service(id: \\\"$RAILWAY_SERVICE_ID\\\") { deployments(first: 1) { edges { node { id } } } } }\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['service']['deployments']['edges'][0]['node']['id'])")
curl -s "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"query(\$id: String!) { deploymentLogs(deploymentId: \$id, limit: 1000) { message } }\",\"variables\":{\"id\":\"$DEPLOY_ID\"}}" \
  | python3 -c "
import json, sys
logs = json.load(sys.stdin).get('data',{}).get('deploymentLogs',[])
hits = [l for l in logs if 'MaxClients' in l.get('message','')]
print(f'MaxClients errors in current deployment: {len(hits)}')
"
```

Expected: `0`. If non-zero, stop — transaction mode isn't fully resolving the issue and the retry is still load-bearing.

- [ ] **Step 2: Reduce retry attempts from 3 to 1 + shorter backoff**

In `server/db.js`, find the `queryWithRetry` function and replace its signature + loop:

```js
async function queryWithRetry(sql, params, maxRetries = 1) {
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(sql, params)
    } catch (err) {
      lastErr = err
      const msg = err?.message || ''
      const transient = /max clients|MaxClientsInSessionMode|ECONNREFUSED|Connection terminated|timeout/i.test(msg)
      if (!transient || attempt === maxRetries) throw err
      await new Promise(r => setTimeout(r, 150))
    }
  }
  throw lastErr
}
```

One retry after 150ms. That's the entire safety net — enough to absorb a TCP handshake blip, nothing more.

- [ ] **Step 3: Syntax check + commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node --check server/db.js && echo "  ✓ parses"
git add server/db.js
git commit -m "refactor(db): trim queryWithRetry to a single 150ms retry

Transaction-mode Supavisor handles burst concurrency natively, so
the 3-retry backoff we added to paper over session-mode saturation
is now adding latency without value. Keep one short retry for
genuine TCP blips."
git push origin main
```

- [ ] **Step 4: Wait for redeploy + verify**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
SHA=$(git rev-parse HEAD | cut -c1-7)
until V=$(curl -s --max-time 5 "https://backend-production-4b19.up.railway.app/api/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null) \
  && echo "[$(date +%H:%M:%S)] railway=$V" \
  && [[ "$V" == "$SHA" ]]; do sleep 20; done
```

---

## Rollback

**If Task 1 (transaction mode) causes issues:**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
set -a && source .env && set +a
# Use the captured OLD URL from Task 1 Step 1
OLD=$(cat /tmp/old_database_url.txt | sed 's/^OLD DATABASE_URL: //')
ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$OLD")
curl -s "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation(\$input: VariableUpsertInput!) { variableUpsert(input: \$input) }\",\"variables\":{\"input\":{\"projectId\":\"$RAILWAY_PROJECT_ID\",\"environmentId\":\"$RAILWAY_ENVIRONMENT_ID\",\"serviceId\":\"$RAILWAY_SERVICE_ID\",\"name\":\"DATABASE_URL\",\"value\":$ESCAPED}}}"
```

Redeploy triggers automatically. This returns the app to session mode in ~2 min.

**For any other task:** `git revert <sha> && git push origin main`. Backend tasks: Railway redeploys automatically. Frontend tasks (Task 3): also force-deploy Vercel after the revert (same flow as Task 3 Step 5).

---

## Done-ness Criteria

- [ ] No `MaxClientsInSessionMode` in Railway logs for 24h following Task 1.
- [ ] `/editor/225/roughcut` loads with transcript visible on first mount (no reload needed) — the bug that kicked this off.
- [ ] Editor page mount triggers ≤ 6 backend DB queries total (measurable from Railway logs or Supabase query insights).
- [ ] `queryWithRetry` logs (if any retries happen) show them as rare edge cases, not regular occurrence.

---

## Out of Scope (deferred)

Documented here so they don't get lost:

- **Broll-pipeline N+1 INSERTs** in `server/services/broll.js:1098-1243` (alt-plan) and `1338-1385` (keywords). 30-150 inserts per pipeline run. Background work, doesn't block user flows, and gets dramatically cheaper under transaction mode. Revisit if Supabase query volume becomes a cost concern.
- **Migrations via direct URL.** For one-off schema changes from a laptop, use `db.PROJECT.supabase.co:5432` (direct connection) instead of the pooler. Not set up today; not blocking.
- **Frontend request deduplication.** Multiple components can call `useApi` with the same path, triggering duplicate fetches. A small `Map<path, Promise>` in `useApi` would dedupe in-flight requests. Defer until we see duplicate fetches in a profile.
