# Reset B-Roll Searches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only "Reset B-Roll Searches" button to the plan page (`/editor/:groupId/brolls/strategy/plan`). Clicking it shows a confirmation modal with counts, then on confirm: aborts in-memory `kw-*`, `bs-*`, and matching `search-batch-*` pipelines; deletes every `broll_searches` row for any plan in the group; deletes `broll_runs` where `pipelineId` starts with `kw-` or `bs-` for this group's videos. Plans, strategies, analysis, references, and reference_b-rolls remain untouched.

**Architecture:** Three new pure helpers in `server/services/broll.js` (`computeBrollResetScope`, `previewBrollReset`, `resetBrollSearches`), two new routes in `server/routes/broll.js` (`GET /groups/:groupId/reset-searches/preview` and `POST /groups/:groupId/reset-searches`), and one admin-visible button + inline confirmation modal in `src/components/editor/BRollPanel.jsx` on the plan stage.

**Tech Stack:** Node.js + Express + Postgres (via `db.prepare` wrapper), React + `useApi`/`apiPost` + `useRole` hook, existing `isAdmin(req)` middleware. Modal style follows the pattern from `src/components/editor/EditorView.jsx:888-890`.

**Note:** No automated tests in this repo. Each task ends with manual verification (node script, curl, or dev browser) followed by a commit.

**Working directory:** `/Users/laurynas/Desktop/one last /transcript-eval` (note the space in "one last ").

---

## File structure

- Modify: `server/services/broll.js` — append three helper functions (`computeBrollResetScope`, `previewBrollReset`, `resetBrollSearches`).
- Modify: `server/routes/broll.js` — add two routes (preview + reset), import the helpers and `isAdmin`.
- Modify: `src/components/editor/BRollPanel.jsx` — import `useRole`; add state, button, and inline modal; use existing `apiPost` + new `authFetch` call for preview.

---

## Task 1: Backend — reset helpers

**Files:**
- Modify: `server/services/broll.js` (append at end of file, after the last `export` — before any default export if present)

Reads two tables (`videos`, `video_groups`, `broll_runs`, `broll_searches`) and two in-memory maps (`brollPipelineProgress`, `pipelineAbortControllers`). Emits no writes in `compute*` / `preview*`; only `resetBrollSearches` mutates.

### Steps

- [ ] **Step 1: Find where to insert the helpers**

Locate the end of `server/services/broll.js` — find the last `export` statement. Append the new code immediately after it (no default export exists in this file).

Run to confirm last export line:

```bash
grep -n "^export " "/Users/laurynas/Desktop/one last /transcript-eval/server/services/broll.js" | tail -3
```

- [ ] **Step 2: Append `computeBrollResetScope` helper**

Add at the end of `server/services/broll.js`:

```js
// ── Reset B-Roll Searches ──────────────────────────────────────────────
// Scope helper: returns all plan pipeline IDs + video IDs for a group.
// Used by both preview and reset so they operate on the exact same set.
export async function computeBrollResetScope(groupId) {
  // Include this group's videos AND any sub-groups' videos — sub-groups inherit parent plans.
  const videos = await db.prepare(`
    SELECT id FROM videos WHERE group_id IN (
      SELECT id FROM video_groups WHERE id = ? OR parent_group_id = ?
    )
  `).all(groupId, groupId)
  const videoIds = videos.map(v => v.id)
  if (!videoIds.length) return { planPipelineIds: [], videoIds: [] }

  const placeholders = videoIds.map(() => '?').join(',')
  const planRuns = await db.prepare(`
    SELECT DISTINCT (metadata_json::jsonb->>'pipelineId') AS pid
    FROM broll_runs
    WHERE video_id IN (${placeholders})
      AND (metadata_json::jsonb->>'pipelineId') LIKE 'plan-%'
  `).all(...videoIds)
  const planPipelineIds = planRuns.map(r => r.pid).filter(Boolean)

  return { planPipelineIds, videoIds }
}
```

- [ ] **Step 3: Append `previewBrollReset` helper**

Add immediately below `computeBrollResetScope`:

```js
// Preview: returns counts for what resetBrollSearches(groupId) would delete/abort.
// Pure read, no mutations.
export async function previewBrollReset(groupId) {
  const { planPipelineIds, videoIds } = await computeBrollResetScope(groupId)
  if (!planPipelineIds.length) {
    return { plans: [], searches: { total: 0, byStatus: {} }, kwRuns: 0, bsRuns: 0, activePipelines: [] }
  }
  const planPH = planPipelineIds.map(() => '?').join(',')
  const vidPH = videoIds.map(() => '?').join(',')

  const searchRows = await db.prepare(
    `SELECT status, COUNT(*)::int AS cnt FROM broll_searches WHERE plan_pipeline_id IN (${planPH}) GROUP BY status`
  ).all(...planPipelineIds)
  const byStatus = {}
  let total = 0
  for (const r of searchRows) { byStatus[r.status] = r.cnt; total += r.cnt }

  const kwRow = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM broll_runs WHERE video_id IN (${vidPH}) AND (metadata_json::jsonb->>'pipelineId') LIKE 'kw-%'`
  ).get(...videoIds)
  const bsRow = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM broll_runs WHERE video_id IN (${vidPH}) AND (metadata_json::jsonb->>'pipelineId') LIKE 'bs-%'`
  ).get(...videoIds)

  // In-memory pipelines that belong to this group's plans
  const activePipelines = []
  for (const [pid, progress] of brollPipelineProgress.entries()) {
    const matchesKwBs = planPipelineIds.some(planId =>
      pid === `kw-${planId}` || pid.startsWith(`kw-${planId}-`) || pid.startsWith(`bs-${planId}-`)
    )
    if (matchesKwBs) {
      activePipelines.push({ pipelineId: pid, status: progress.status, stageName: progress.stageName, kind: 'kw_or_bs' })
      continue
    }
    if (pid.startsWith('search-batch-')) {
      const row = await db.prepare(
        `SELECT 1 FROM broll_searches WHERE batch_id = ? AND plan_pipeline_id IN (${planPH}) LIMIT 1`
      ).get(pid, ...planPipelineIds)
      if (row) activePipelines.push({ pipelineId: pid, status: progress.status, stageName: progress.stageName, kind: 'search-batch' })
    }
  }

  return {
    plans: planPipelineIds,
    searches: { total, byStatus },
    kwRuns: kwRow?.cnt || 0,
    bsRuns: bsRow?.cnt || 0,
    activePipelines,
  }
}
```

- [ ] **Step 4: Append `resetBrollSearches` helper**

Add immediately below `previewBrollReset`:

```js
// Execute reset: abort matching in-memory pipelines, delete broll_searches rows,
// delete kw-* and bs-* broll_runs for this group's videos.
// Leaves plans, strategies, analysis, reference data untouched.
export async function resetBrollSearches(groupId) {
  const { planPipelineIds, videoIds } = await computeBrollResetScope(groupId)
  if (!planPipelineIds.length) {
    return { searchesDeleted: 0, kwRunsDeleted: 0, bsRunsDeleted: 0, pipelinesAborted: 0 }
  }
  const planPH = planPipelineIds.map(() => '?').join(',')
  const vidPH = videoIds.map(() => '?').join(',')

  // 1) Collect pipeline IDs to abort
  const pidsToRemove = []
  for (const [pid, progress] of brollPipelineProgress.entries()) {
    const matchesKwBs = planPipelineIds.some(planId =>
      pid === `kw-${planId}` || pid.startsWith(`kw-${planId}-`) || pid.startsWith(`bs-${planId}-`)
    )
    if (matchesKwBs) { pidsToRemove.push(pid); continue }
    if (pid.startsWith('search-batch-')) {
      const row = await db.prepare(
        `SELECT 1 FROM broll_searches WHERE batch_id = ? AND plan_pipeline_id IN (${planPH}) LIMIT 1`
      ).get(pid, ...planPipelineIds)
      if (row) pidsToRemove.push(pid)
    }
  }

  // 2) Abort + clean up in-memory state for each
  let pipelinesAborted = 0
  for (const pid of pidsToRemove) {
    abortedBrollPipelines.add(pid)
    const controller = pipelineAbortControllers.get(pid)
    if (controller) {
      try { controller.abort() } catch {}
      pipelineAbortControllers.delete(pid)
    }
    brollPipelineProgress.delete(pid)
    pipelinesAborted++
  }

  // 3) Delete broll_searches rows for this group's plans
  const delSearches = await db.prepare(
    `DELETE FROM broll_searches WHERE plan_pipeline_id IN (${planPH})`
  ).run(...planPipelineIds)
  const searchesDeleted = delSearches.changes || 0

  // 4) Delete kw-* broll_runs
  const delKw = await db.prepare(
    `DELETE FROM broll_runs WHERE video_id IN (${vidPH}) AND (metadata_json::jsonb->>'pipelineId') LIKE 'kw-%'`
  ).run(...videoIds)
  const kwRunsDeleted = delKw.changes || 0

  // 5) Delete bs-* broll_runs (legacy b-roll search pipeline)
  const delBs = await db.prepare(
    `DELETE FROM broll_runs WHERE video_id IN (${vidPH}) AND (metadata_json::jsonb->>'pipelineId') LIKE 'bs-%'`
  ).run(...videoIds)
  const bsRunsDeleted = delBs.changes || 0

  console.log(`[broll-reset] group=${groupId}: searches=${searchesDeleted}, kw=${kwRunsDeleted}, bs=${bsRunsDeleted}, aborted=${pipelinesAborted}`)

  return { searchesDeleted, kwRunsDeleted, bsRunsDeleted, pipelinesAborted }
}
```

- [ ] **Step 5: Syntax check**

Run:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/services/broll.js && echo "SYNTAX OK"
```

Expected output: `SYNTAX OK`.

- [ ] **Step 6: Manual preview test against the real DB (no mutation)**

Pick a live group. Group **225** currently has 3 plans and existing searches — good target. Run:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && DATABASE_URL="postgresql://postgres.wymmywshkimzbxbmpukp:nhFgPFp3ZMb%21ZAM@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true" node --input-type=module -e "
import('./server/services/broll.js').then(async mod => {
  const preview = await mod.previewBrollReset(225)
  console.log(JSON.stringify(preview, null, 2))
  process.exit(0)
}).catch(e => { console.error(e); process.exit(1) })
"
```

Expected: `plans` array has 3 `plan-370-*` IDs. `searches.total` > 0 (was ~60 at time of planning). `kwRuns` > 0. `bsRuns` may be 0. `activePipelines` may be empty if no pipelines are in memory right now.

- [ ] **Step 7: Commit**

```bash
git -C "/Users/laurynas/Desktop/one last /transcript-eval" add server/services/broll.js && git -C "/Users/laurynas/Desktop/one last /transcript-eval" commit -m "$(cat <<'EOF'
feat(broll): add reset-searches service helpers

Adds computeBrollResetScope, previewBrollReset, resetBrollSearches —
pure service functions scoped to a video group. Preview is read-only;
reset aborts in-memory kw-/bs-/matching search-batch pipelines and
deletes broll_searches + kw-*/bs-* broll_runs, leaving plans,
strategies, analysis, and reference data untouched.

No routes wired yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend — preview + reset routes

**Files:**
- Modify: `server/routes/broll.js`

Admin-only GET + POST. Mounts under the existing `/broll/*` prefix.

### Steps

- [ ] **Step 1: Check existing imports in the route file**

Run:

```bash
grep -n "^import" "/Users/laurynas/Desktop/one last /transcript-eval/server/routes/broll.js" | head -15
```

Locate the line that imports from `'../services/broll.js'` (there will already be one) and the line that imports `requireAuth` (from `'../auth.js'` or similar).

- [ ] **Step 2: Add `isAdmin` and the two helpers to imports**

In `server/routes/broll.js`, find the existing import from `'../services/broll.js'`. Add `previewBrollReset, resetBrollSearches` to that import list.

Find the existing `requireAuth` import. Change it to also import `isAdmin`:

```js
// BEFORE (exact wording varies — adjust)
import { requireAuth } from '../auth.js'

// AFTER
import { requireAuth, isAdmin } from '../auth.js'
```

Verify the service import similarly includes:

```js
import {
  // ...existing names...
  previewBrollReset,
  resetBrollSearches,
} from '../services/broll.js'
```

- [ ] **Step 3: Add the two routes**

Insert the following immediately after the existing `/pipeline/stop-all` route (search for `router.post('/pipeline/stop-all'` to find it — currently around line 413). The admin check runs inside the handler (not as middleware) to keep consistent with other routes in this file:

```js
// Admin-only: preview what Reset B-Roll Searches would delete for a group
router.get('/groups/:groupId/reset-searches/preview', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' })
  try {
    const groupId = Number(req.params.groupId)
    if (!Number.isFinite(groupId)) return res.status(400).json({ error: 'Invalid groupId' })
    const preview = await previewBrollReset(groupId)
    res.json(preview)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Admin-only: execute Reset B-Roll Searches for a group
router.post('/groups/:groupId/reset-searches', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' })
  try {
    const groupId = Number(req.params.groupId)
    if (!Number.isFinite(groupId)) return res.status(400).json({ error: 'Invalid groupId' })
    const result = await resetBrollSearches(groupId)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4: Syntax check both files**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --check server/routes/broll.js && node --check server/services/broll.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 5: Start the dev backend**

In one terminal:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && DATABASE_URL="postgresql://postgres.wymmywshkimzbxbmpukp:nhFgPFp3ZMb%21ZAM@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true" PORT=3001 npm run start:server
```

Wait for `listening on :3001` or the equivalent startup log.

- [ ] **Step 6: Verify preview endpoint (admin-only)**

In a second terminal — dev bypass header grants admin locally (see `server/auth.js:71-73`):

```bash
curl -s "http://localhost:3001/api/broll/groups/225/reset-searches/preview" -H "X-Dev-Bypass: true" | python3 -m json.tool
```

Expected: JSON with `plans` (3 items), `searches.total` > 0, `kwRuns` >= 0, `bsRuns` >= 0, `activePipelines` (possibly empty).

- [ ] **Step 7: Verify 403 without admin**

Without the dev-bypass, an unauthenticated request should fail auth — but to specifically test `isAdmin`, set an auth header that resolves to a non-admin user. If no such header is easy locally, at minimum confirm the unauthenticated call returns 401/503, not 200:

```bash
curl -i -s "http://localhost:3001/api/broll/groups/225/reset-searches/preview" | head -5
```

Expected first line: `HTTP/1.1 401 …` or `503 …`, NOT `200`.

- [ ] **Step 8: DO NOT call POST yet — let the frontend task trigger it via the UI for a real end-to-end test**

Skip. We'll execute the POST from the UI in Task 4.

- [ ] **Step 9: Commit**

```bash
git -C "/Users/laurynas/Desktop/one last /transcript-eval" add server/routes/broll.js && git -C "/Users/laurynas/Desktop/one last /transcript-eval" commit -m "$(cat <<'EOF'
feat(broll): add admin reset-searches preview + execute routes

GET /broll/groups/:groupId/reset-searches/preview — read-only counts
POST /broll/groups/:groupId/reset-searches — aborts + deletes

Both gated by isAdmin. Preview matches what the POST would affect so
the frontend can show accurate counts before confirming.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Frontend — admin button + confirmation modal

**Files:**
- Modify: `src/components/editor/BRollPanel.jsx`

Button sits in the plan stage footer area. Visible only when `isAdmin` AND preview shows something to reset (`searches.total > 0 || kwRuns > 0 || bsRuns > 0`). Modal renders inline, follows the pattern at `src/components/editor/EditorView.jsx:888-890` (fixed inset-0 z-[100], backdrop-blur, max-w-md).

### Steps

- [ ] **Step 1: Add the `useRole` import**

Open `src/components/editor/BRollPanel.jsx`. Find the import block at the top. Add (after the `supabase` import, before the `lucide-react` import):

```js
import { useRole } from '../../contexts/RoleContext.jsx'
```

- [ ] **Step 2: Add state inside the `BRollPanel` function component**

Find the existing `useState` calls near the top of the component (search for `const [runningType, setRunningType]`). Add these five state variables immediately below:

```js
const { isAdmin } = useRole()
const [resetPreview, setResetPreview] = useState(null)
const [resetConfirming, setResetConfirming] = useState(false)
const [resetLoading, setResetLoading] = useState(false)
const [resetError, setResetError] = useState(null)
```

- [ ] **Step 3: Add reset handler functions**

Find `async function handleRunSearch()` (around line 647). Immediately above it, add the two handlers:

```js
async function openResetModal() {
  setResetError(null)
  setResetPreview(null)
  setResetConfirming(true)
  try {
    const res = await authFetch(`/broll/groups/${groupId}/reset-searches/preview`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error(err.error || 'Preview failed')
    }
    setResetPreview(await res.json())
  } catch (err) {
    setResetError(err.message)
  }
}

async function confirmReset() {
  setResetLoading(true)
  setResetError(null)
  try {
    const res = await apiPost(`/broll/groups/${groupId}/reset-searches`)
    console.log('[reset-searches] result:', res)
    setResetConfirming(false)
    setResetPreview(null)
    refetchRuns()
  } catch (err) {
    setResetError(err.message)
  } finally {
    setResetLoading(false)
  }
}
```

- [ ] **Step 4: Find the plan-stage footer and add the admin button**

Search for the place where "Search B-Roll" button is rendered on the plan stage. The cleanest hook is just below the `steps` stepper render, visible only on the plan stage. Locate the block that renders steps (search `activeStage === 'plan'`). Add this snippet just inside the plan-stage section, near the bottom of the plan-stage content (adjust placement if your plan-stage render differs — the exact location is less important than that it's visible when `activeStage === 'plan'`):

```jsx
{isAdmin && activeStage === 'plan' && (hasCompletedBrollSearch || Object.keys(pipelineMap).some(pid => pid.startsWith('kw-') || pid.startsWith('bs-'))) && (
  <div className="mt-6 flex justify-end">
    <button
      onClick={openResetModal}
      className="text-xs text-red-400 hover:text-red-300 underline underline-offset-2"
    >
      Admin: Reset B-Roll Searches
    </button>
  </div>
)}
```

- [ ] **Step 5: Add the confirmation modal**

Near the end of the component's JSX return (just before the closing wrapper element of the top-level returned fragment), add:

```jsx
{resetConfirming && (
  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-6">
    <div className="max-w-md w-full rounded-xl overflow-hidden shadow-2xl shadow-black/60 border border-outline-variant/20 p-6" style={{ background: 'rgba(25, 25, 28, 0.85)', backdropFilter: 'blur(20px)' }}>
      <h2 className="text-lg font-bold text-zinc-100 mb-3">Reset B-Roll Searches?</h2>
      {!resetPreview && !resetError && (
        <p className="text-sm text-zinc-400">Loading preview…</p>
      )}
      {resetError && (
        <p className="text-sm text-red-400 mb-4">{resetError}</p>
      )}
      {resetPreview && (
        <div className="text-sm text-zinc-300 space-y-2 mb-4">
          <p>This will delete:</p>
          <ul className="list-disc ml-5 text-zinc-400 text-xs">
            <li>{resetPreview.searches.total} b-roll search rows ({Object.entries(resetPreview.searches.byStatus).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})</li>
            <li>{resetPreview.kwRuns} keyword pipeline runs</li>
            <li>{resetPreview.bsRuns} legacy b-roll search runs</li>
            <li>Abort {resetPreview.activePipelines.length} active in-memory pipelines</li>
          </ul>
          <p className="text-xs text-zinc-500 mt-2">Plans, strategies, analysis, and reference data are NOT touched.</p>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={() => { setResetConfirming(false); setResetPreview(null); setResetError(null) }}
          disabled={resetLoading}
          className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={confirmReset}
          disabled={resetLoading || !resetPreview}
          className="px-3 py-1.5 text-xs bg-red-500/80 hover:bg-red-500 text-white rounded disabled:opacity-50 flex items-center gap-2"
        >
          {resetLoading && <Loader2 size={12} className="animate-spin" />}
          {resetLoading ? 'Resetting…' : 'Reset'}
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 6: Start the dev frontend**

In a third terminal (backend from Task 2 should still be running):

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm run dev
```

Wait for Vite to print the local URL (usually `http://localhost:5173`).

- [ ] **Step 7: Manual UI verification — button visible**

Open `http://localhost:5173/editor/225/brolls/strategy/plan` in a browser. Sign in with the admin email (silvestras.stonk@gmail.com) or rely on dev-bypass if configured client-side. At the bottom of the plan page you should see the "Admin: Reset B-Roll Searches" link.

If the button is not visible:
- Confirm the account has `isAdmin === true` by temporarily logging it in the component (`console.log({ isAdmin })`).
- Confirm the visibility condition evaluates true — i.e. there ARE kw-* pipelines or completed broll searches for this group.

- [ ] **Step 8: Manual UI verification — preview modal**

Click the button. A modal appears with counts. The counts should match the numbers from Task 1 Step 6. Close with Cancel (no backend call fires).

- [ ] **Step 9: Manual UI verification — execute reset**

Re-open the modal. Click **Reset**. Expected flow:
1. Button shows spinner + "Resetting…"
2. Modal closes on success
3. Backend log line `[broll-reset] group=225: searches=N, kw=M, bs=K, aborted=P`
4. Runs list refetches (the plan page should look the same — plans still there — but no kw-* or broll_searches)

Verify DB state:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && DATABASE_URL="postgresql://postgres.wymmywshkimzbxbmpukp:nhFgPFp3ZMb%21ZAM@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true" node --input-type=module -e "
import('pg').then(async ({ default: pg }) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  const kw = await pool.query(\"SELECT COUNT(*)::int AS c FROM broll_runs WHERE video_id = 370 AND (metadata_json::jsonb->>'pipelineId') LIKE 'kw-%'\")
  const sr = await pool.query(\"SELECT COUNT(*)::int AS c FROM broll_searches WHERE plan_pipeline_id LIKE 'plan-370-%'\")
  const pl = await pool.query(\"SELECT COUNT(*)::int AS c FROM broll_runs WHERE video_id = 370 AND (metadata_json::jsonb->>'pipelineId') LIKE 'plan-%'\")
  console.log('kw runs:', kw.rows[0].c, '| search rows:', sr.rows[0].c, '| plan runs:', pl.rows[0].c)
  await pool.end()
})
"
```

Expected: `kw runs: 0 | search rows: 0 | plan runs: 30` (plans untouched, everything else cleaned).

- [ ] **Step 10: Manual UI verification — re-run search works**

Still on `/brolls/strategy/plan`, click "Search B-Roll". It should start fresh: kw-* pipelines appear in `broll_runs`, a new `search-batch-*` batch is created. This confirms the reset left the plan in a usable state.

- [ ] **Step 11: Commit**

```bash
git -C "/Users/laurynas/Desktop/one last /transcript-eval" add src/components/editor/BRollPanel.jsx && git -C "/Users/laurynas/Desktop/one last /transcript-eval" commit -m "$(cat <<'EOF'
feat(broll): admin-only Reset B-Roll Searches button on plan page

Shows for admins when a group has existing kw-* pipelines or b-roll
search rows. Opens a modal that previews counts (searches by status,
kw runs, bs runs, active in-memory pipelines). On confirm, calls the
backend reset endpoint and refetches runs.

Plans, strategies, analysis, and references remain untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Deploy + production end-to-end smoke test

**Files:** none — deploys existing commits.

### Steps

- [ ] **Step 1: Push to origin**

```bash
git -C "/Users/laurynas/Desktop/one last /transcript-eval" push
```

- [ ] **Step 2: Wait for Railway deploy**

Poll until backend `version` field matches the newest commit:

```bash
NEW_SHA=$(git -C "/Users/laurynas/Desktop/one last /transcript-eval" rev-parse --short HEAD)
echo "Waiting for version=$NEW_SHA to appear in /api/health…"
until curl -s https://backend-production-4b19.up.railway.app/api/health | grep -q "\"version\":\"$NEW_SHA\""; do sleep 20; done
echo "Deployed."
```

- [ ] **Step 3: Wait for Vercel deploy**

Vercel auto-deploys but cancels unsigned commits. Per project memory, a direct-from-CLI push may need to be manually promoted via the Vercel API. Open the Vercel dashboard for the project and confirm the latest commit has a deployment. If it was cancelled, force a redeploy via the Vercel UI or API (see `~/.claude/projects/-Users-laurynas/memory/reference_vercel.md`).

- [ ] **Step 4: Smoke test on production**

Open `https://transcript-eval-sylvesterads-projects.vercel.app/editor/225/brolls/strategy/plan` signed in as admin. Confirm the "Admin: Reset B-Roll Searches" link is visible, the modal loads counts, and — only if you intend to actually reset production data for group 225 — click Reset.

- [ ] **Step 5: Verify Railway log**

```bash
curl -s -H "Authorization: Bearer $RAILWAY_API_TOKEN" -H "Content-Type: application/json" \
  "https://backboard.railway.app/graphql/v2" \
  -d '{"query":"query { deploymentLogs(deploymentId: \"DEPLOYMENT_ID\", limit: 20, filter: \"broll-reset\") { message timestamp } }"}' \
  | python3 -m json.tool
```

(Replace `DEPLOYMENT_ID` with the latest ID from the Railway API or UI.)

Expected: a `[broll-reset] group=225: searches=N, kw=M, bs=K, aborted=P` line.

---

## Notes for the implementer

- Do not touch `broll_search_logs` — it is a shared cache keyed by brief text and cleaning it would slow other users' searches.
- Do not touch `api_logs` — unrelated general request log.
- Do not stop unrelated pipelines (analysis, plan, strategy). The scope helper filters specifically to `kw-`, `bs-`, and `search-batch-` whose `batch_id` matches a `broll_searches` row tied to this group's plans.
- The two SQL `LIKE '…%'` patterns work with the Postgres `::jsonb->>` extractor. Verify with the preview step before running the reset.
- If a group has a `parent_group_id` and the parent has additional plans, those will be included because `computeBrollResetScope` unions `id = ?` and `parent_group_id = ?`.
- Sub-group handling: if the group BEING reset is a parent with sub-groups, the query does NOT currently descend into sub-groups (only ascends). This matches the existing `loadExampleVideos` convention. If sub-group descent is needed later, add a CTE.
