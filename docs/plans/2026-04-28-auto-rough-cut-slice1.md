# Auto Rough Cut — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Rough Cut" step to the upload-config flow and have the existing AI Rough Cut pipeline fire automatically server-side after `analyzeMulticam` finishes.

**Architecture:** Two new columns on `video_groups` (`auto_rough_cut`, `rough_cut_status`). Extract the existing `/start-ai-roughcut` route body into a reusable `runAiRoughCut` helper. Hook the helper into `multicam-sync.updateStatus` whenever a group transitions to `assembly_status='done'` and has the flag. Frontend gets a new `StepRoughCut` between `references` and `path`, plus one extra status label in `SyncingScreen` and a small failure banner in `EditorView`.

**Tech Stack:** Node 20 (Express + node-pg), React + Vite, Vitest 1.6 (workspace projects: server / web / extension), Tailwind. Backend Postgres on Railway, frontend on Vercel.

**Spec:** `docs/specs/2026-04-28-auto-rough-cut-slice1-design.md`

**Branch:** `feature/auto-rough-cut-slice1` (this worktree)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `server/schema-pg.sql` | Modify | Add `auto_rough_cut` + `rough_cut_status` columns on `video_groups`. |
| `server/seed/migrate-auto-rough-cut.js` | Create | One-shot migration for the two columns (run once on the live DB; idempotent). |
| `server/services/rough-cut-runner.js` | Create | Pure helper `runAiRoughCut({ groupId, userId, isAdmin, force, force })`. Token deduction + experiment + run + background pipeline + completion-hook. |
| `server/services/__tests__/rough-cut-runner.test.js` | Create | Vitest. Mocks `db.js`. Covers insufficient_tokens, already_exists, happy path. |
| `server/routes/videos.js` | Modify | (a) `validateGroupUpdate` accepts `auto_rough_cut`. (b) PUT `/groups/:id` writes the column. (c) `GET /groups/:id/status` returns `rough_cut_status` + `rough_cut_error_required`. (d) `POST /groups/:id/start-ai-roughcut` becomes a thin wrapper around `runAiRoughCut`. |
| `server/routes/__tests__/videos-groups.test.js` | Modify | Add `validateGroupUpdate` cases for `auto_rough_cut`. |
| `server/services/multicam-sync.js` | Modify | `updateStatus` fires the auto-trigger when status transitions to `'done'` and the group has `auto_rough_cut=true`. |
| `server/services/__tests__/multicam-sync-auto-trigger.test.js` | Create | Vitest. Verifies the hook fires only on `done` + flag, idempotent under repeat calls. |
| `src/components/upload-config/steps/StepRoughCut.jsx` | Create | New Step 5 component. Skip/Run radio, before/after preview, target cards, estimate display + balance check. |
| `src/components/upload-config/UploadConfigFlow.jsx` | Modify | Add `'roughcut'` to `UNIFIED_STEPS`, expand `CONFIG_STEPS` slice, add reducer case + `persistCurrent` branch + `continueDisabled` plumbing. |
| `src/components/views/ProjectsView.jsx` | Modify | Add `'roughcut'` to `CONFIG_STEPS` set; extend `initialConfig` with `autoRoughCut`. |
| `src/components/editor/EditorView.jsx` | Modify | (a) `SyncingScreen` polls `rough_cut_status` and adds a label. (b) `isAssembling` predicate extends. (c) New `RoughCutFailureBanner` rendered above the editor when `rough_cut_status` is failed/insufficient. |
| `src/components/upload-config/__tests__/StepRoughCut.test.jsx` | Create | Vitest. Default Skip; balance gate; estimate polling. |

---

## Task 1: DB schema — add `auto_rough_cut` + `rough_cut_status`

**Files:**
- Modify: `server/schema-pg.sql` (the `video_groups` CREATE block)
- Create: `server/seed/migrate-auto-rough-cut.js`

- [ ] **Step 1.1: Add columns to schema**

Find the `CREATE TABLE IF NOT EXISTS video_groups` block in `server/schema-pg.sql` (top of file). After the existing `path_id TEXT,` line, add:

```sql
  auto_rough_cut BOOLEAN DEFAULT FALSE,
  rough_cut_status TEXT,
  rough_cut_error_required INTEGER,
```

- [ ] **Step 1.2: Write idempotent migration script**

Create `server/seed/migrate-auto-rough-cut.js`:

```js
// One-shot migration to add Auto Rough Cut columns to video_groups.
// Idempotent — safe to run multiple times.
import 'dotenv/config'
import db from '../db.js'

async function run() {
  await db.prepare(`
    ALTER TABLE video_groups
      ADD COLUMN IF NOT EXISTS auto_rough_cut BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS rough_cut_status TEXT,
      ADD COLUMN IF NOT EXISTS rough_cut_error_required INTEGER
  `).run()
  console.log('[migrate] auto-rough-cut columns ensured on video_groups')
  process.exit(0)
}

run().catch(err => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
```

- [ ] **Step 1.3: Run the migration locally to verify it succeeds**

Run:
```bash
node --env-file=.env server/seed/migrate-auto-rough-cut.js
```
Expected stdout: `[migrate] auto-rough-cut columns ensured on video_groups`

- [ ] **Step 1.4: Verify columns exist via psql**

Run:
```bash
DB_URL=$(grep '^DATABASE_URL=' .env | sed 's/^DATABASE_URL=//' | sed 's/?.*//')
psql "$DB_URL" -c "\d video_groups" | grep -E "auto_rough_cut|rough_cut_status|rough_cut_error_required"
```
Expected: three lines listing the new columns.

- [ ] **Step 1.5: Commit**

```bash
git add server/schema-pg.sql server/seed/migrate-auto-rough-cut.js
git commit -m "feat(db): add auto_rough_cut + rough_cut_status to video_groups

Two new columns on video_groups: auto_rough_cut (boolean default false)
captures the user's choice on the new upload Step 5; rough_cut_status
tracks the lifecycle of the post-sync auto-trigger so SyncingScreen can
keep polling through it. rough_cut_error_required stores the token
shortfall for the failure banner.

Idempotent migration script committed for production rollout."
```

---

## Task 2: `validateGroupUpdate` accepts `auto_rough_cut`

**Files:**
- Modify: `server/routes/videos.js:51-70` (the `validateGroupUpdate` function)
- Modify: `server/routes/__tests__/videos-groups.test.js`

- [ ] **Step 2.1: Add failing test**

Open `server/routes/__tests__/videos-groups.test.js` and add inside the existing `describe('validateGroupUpdate', ...)` block:

```js
  it('accepts boolean auto_rough_cut', () => {
    const { error } = validateGroupUpdate({ auto_rough_cut: true })
    expect(error).toBe(null)
  })

  it('rejects non-boolean auto_rough_cut', () => {
    const { error } = validateGroupUpdate({ auto_rough_cut: 'yes' })
    expect(error).toMatch(/auto_rough_cut/)
  })
```

- [ ] **Step 2.2: Run test, expect failure**

Run:
```bash
npx vitest run server/routes/__tests__/videos-groups.test.js
```
Expected: 2 new tests fail (function ignores `auto_rough_cut`).

- [ ] **Step 2.3: Implement validation**

In `server/routes/videos.js`, inside `validateGroupUpdate`, before the final `return { error: null }`, add:

```js
  if (body.auto_rough_cut !== undefined && typeof body.auto_rough_cut !== 'boolean') {
    return { error: 'auto_rough_cut must be boolean' }
  }
```

- [ ] **Step 2.4: Wire up the column write in PUT /groups/:id**

In `server/routes/videos.js` near line 2306 in the PUT handler, find the destructured field list:

```js
  const { rough_cut_config_json, libraries, freepik_opt_in, audience, path_id } = req.body
```

Replace with:

```js
  const { rough_cut_config_json, libraries, freepik_opt_in, audience, path_id, auto_rough_cut } = req.body
```

Then below the existing `path_id` block (around line 2333), add:

```js
  if (auto_rough_cut !== undefined) {
    updates.push('auto_rough_cut = ?')
    values.push(auto_rough_cut)
  }
```

- [ ] **Step 2.5: Run tests, verify pass**

Run:
```bash
npx vitest run server/routes/__tests__/videos-groups.test.js
```
Expected: all tests pass.

- [ ] **Step 2.6: Commit**

```bash
git add server/routes/videos.js server/routes/__tests__/videos-groups.test.js
git commit -m "feat(api): persist auto_rough_cut on PUT /groups/:id"
```

---

## Task 3: Extract `runAiRoughCut` helper

**Files:**
- Create: `server/services/rough-cut-runner.js`
- Modify: `server/routes/videos.js:1012-1153` (the existing route)
- Create: `server/services/__tests__/rough-cut-runner.test.js`

The current `/start-ai-roughcut` handler does: validate group → compute cost → transactional debit → existing-annotations short-circuit → cleanup stale runs → fetch strategy → create experiment + run → respond → background pipeline. Extract everything except request/response into a reusable helper.

- [ ] **Step 3.1: Write failing test for happy path**

Create `server/services/__tests__/rough-cut-runner.test.js`:

```js
// Tests for runAiRoughCut.
//
// Strategy: mock db.js at the module boundary, mirroring exports.test.js.
// Covers three branches: insufficient balance, existing annotations,
// happy path (deduction + experiment + run created, IDs returned).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  group: null,                 // SELECT * FROM video_groups WHERE id = ?
  videos: [],                  // SELECT duration_seconds FROM videos WHERE group_id = ?
  videoWithTranscript: null,   // SELECT v.* FROM videos JOIN transcripts ...
  strategy: null,              // SELECT * FROM strategies WHERE is_main = 1
  version: null,               // SELECT * FROM strategy_versions ...
  balance: 10000,              // user_tokens.balance
  insertedExperimentId: null,
  insertedRunId: null,
  poolBeginCalls: 0,
  poolCommitCalls: 0,
  poolRollbackCalls: 0,
  insufficient: false,
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT .* FROM video_groups WHERE id/.test(sql)) return state.group
          if (/SELECT .* FROM strategies WHERE is_main/.test(sql)) return state.strategy
          if (/SELECT .* FROM strategy_versions/.test(sql)) return state.version
          if (/SELECT v\.\* FROM videos v/.test(sql)) return state.videoWithTranscript
          throw new Error(`unexpected .get SQL: ${sql}`)
        },
        async all(...args) {
          if (/SELECT duration_seconds FROM videos/.test(sql)) return state.videos
          throw new Error(`unexpected .all SQL: ${sql}`)
        },
        async run(...args) {
          if (/UPDATE experiment_runs SET status = 'failed'/.test(sql)) return { changes: 0 }
          if (/INSERT INTO experiments/.test(sql)) {
            state.insertedExperimentId = 42
            return { lastInsertRowid: 42 }
          }
          if (/INSERT INTO experiment_runs/.test(sql)) {
            state.insertedRunId = 7
            return { lastInsertRowid: 7 }
          }
          if (/UPDATE video_groups SET annotations_json/.test(sql)) return { changes: 1 }
          throw new Error(`unexpected .run SQL: ${sql}`)
        },
      }
    },
    pool: {
      async connect() {
        return {
          async query(sql, args) {
            if (/^BEGIN/i.test(sql)) { state.poolBeginCalls++; return {} }
            if (/^COMMIT/i.test(sql)) { state.poolCommitCalls++; return {} }
            if (/^ROLLBACK/i.test(sql)) { state.poolRollbackCalls++; return {} }
            if (/INSERT INTO user_tokens/i.test(sql)) return { rows: [] }
            if (/SELECT balance FROM user_tokens/i.test(sql)) return { rows: [{ balance: state.balance }] }
            if (/UPDATE user_tokens SET balance/i.test(sql)) return { rows: [] }
            if (/INSERT INTO token_transactions/i.test(sql)) return { rows: [] }
            throw new Error(`unexpected pool query: ${sql}`)
          },
          release() {},
        }
      },
    },
  },
}))

vi.mock('../llm-runner.js', () => ({ executeRun: vi.fn().mockResolvedValue() }))
vi.mock('../annotation-mapper.js', () => ({
  buildAnnotationsFromRun: vi.fn().mockResolvedValue({ items: [] }),
  getTimelineWordTimestamps: vi.fn().mockResolvedValue([{ word: 'hi', start: 0, end: 1 }]),
}))

import { runAiRoughCut } from '../rough-cut-runner.js'

beforeEach(() => {
  state.group = { id: 1, user_id: 'u1', annotations_json: null, assembled_transcript: 'hello' }
  state.videos = [{ duration_seconds: 60 }]
  state.videoWithTranscript = { id: 100, group_id: 1, video_type: 'raw' }
  state.strategy = { id: 5, name: 'Main', is_main: 1 }
  state.version = { id: 50, strategy_id: 5, stages_json: '[{"name":"S1","type":"llm"}]' }
  state.balance = 10000
  state.insertedExperimentId = null
  state.insertedRunId = null
  state.poolBeginCalls = 0
  state.poolCommitCalls = 0
  state.poolRollbackCalls = 0
})

describe('runAiRoughCut', () => {
  it('returns insufficient_tokens when balance below cost', async () => {
    state.balance = 1
    const r = await runAiRoughCut({ groupId: 1, userId: 'u1' })
    expect(r.error).toBe('insufficient_tokens')
    expect(r.required).toBeGreaterThan(state.balance)
    expect(state.poolRollbackCalls).toBe(1)
    expect(state.poolCommitCalls).toBe(0)
  })

  it('returns already_exists when group has annotations', async () => {
    state.group.annotations_json = JSON.stringify({ items: [{ id: 'a' }] })
    const r = await runAiRoughCut({ groupId: 1, userId: 'u1' })
    expect(r.already_exists).toBe(true)
    expect(state.poolCommitCalls).toBe(1)
  })

  it('creates experiment + run and returns IDs on happy path', async () => {
    const r = await runAiRoughCut({ groupId: 1, userId: 'u1' })
    expect(r.error).toBeUndefined()
    expect(r.experimentId).toBe(42)
    expect(r.runId).toBe(7)
    expect(r.totalStages).toBe(1)
    expect(r.balanceAfter).toBe(state.balance - r.tokensDeducted)
    expect(state.poolCommitCalls).toBe(1)
  })

  it('returns 404-equivalent when group missing', async () => {
    state.group = null
    const r = await runAiRoughCut({ groupId: 999, userId: 'u1' })
    expect(r.error).toBe('not_found')
  })
})
```

- [ ] **Step 3.2: Run test, expect failure (file doesn't exist yet)**

Run:
```bash
npx vitest run server/services/__tests__/rough-cut-runner.test.js
```
Expected: import resolves to undefined → all four tests fail.

- [ ] **Step 3.3: Create the helper**

Create `server/services/rough-cut-runner.js`:

```js
// Reusable AI Rough Cut runner.
//
// Used by:
//   - POST /videos/groups/:id/start-ai-roughcut (manual editor button)
//   - multicam-sync.updateStatus when assembly transitions to 'done' on a
//     group with auto_rough_cut = true (slice 1 auto-trigger)
//
// Behaviour matches the prior inline route handler exactly:
//   1. Look up group (404-equivalent if missing or not owned).
//   2. Compute tokenCost from total durations.
//   3. Transactional balance deduction; rollback + 'insufficient_tokens'
//      if balance < cost.
//   4. Short-circuit with already_exists if group.annotations_json has
//      items (and !force).
//   5. Find main strategy + latest version.
//   6. Create experiment + experiment_run rows.
//   7. Return synchronously with all IDs.
//   8. Kick off pipeline in background (executeRun + buildAnnotations).
//
// Returns:
//   { error?, ok?, tokensDeducted?, balanceAfter?, experimentId?, runId?,
//     totalStages?, stageNames?, stageTypes?, already_exists?, required?, balance? }

import db from '../db.js'

// Same formula as the original route — kept identical so estimates match.
function estimateTokenCost(totalDurationSeconds) {
  const minutes = totalDurationSeconds / 60
  return Math.round(minutes * 20)
}

export async function runAiRoughCut({ groupId, userId, isAdmin = false, force = false }) {
  // 1. Look up group with the ownership scope the route used.
  const ownerScope = isAdmin ? '' : 'AND user_id = ?'
  const args = isAdmin ? [groupId] : [groupId, userId]
  const group = await db.prepare(
    `SELECT * FROM video_groups WHERE id = ? ${ownerScope}`
  ).get(...args)
  if (!group) return { error: 'not_found' }

  // 2. Compute cost
  const videos = await db.prepare(
    'SELECT duration_seconds FROM videos WHERE group_id = ?'
  ).all(groupId)
  const totalDuration = videos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0)
  const tokenCost = estimateTokenCost(totalDuration)

  // 3. Transactional deduction
  const client = await db.pool.connect()
  let balanceAfter
  try {
    await client.query('BEGIN')
    await client.query(
      'INSERT INTO user_tokens (user_id, balance) VALUES ($1, 10000) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    )
    const { rows } = await client.query(
      'SELECT balance FROM user_tokens WHERE user_id = $1 FOR UPDATE',
      [userId]
    )
    const currentBalance = rows[0]?.balance ?? 0

    if (currentBalance < tokenCost) {
      await client.query('ROLLBACK')
      return { error: 'insufficient_tokens', balance: currentBalance, required: tokenCost }
    }

    balanceAfter = currentBalance - tokenCost
    await client.query(
      'UPDATE user_tokens SET balance = $1, updated_at = NOW() WHERE user_id = $2',
      [balanceAfter, userId]
    )
    await client.query(
      `INSERT INTO token_transactions (user_id, amount, balance_after, type, description, group_id)
       VALUES ($1, $2, $3, 'debit', $4, $5)`,
      [userId, -tokenCost, balanceAfter, `AI Rough Cut for project ${groupId}`, groupId]
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // 4. Existing annotations short-circuit (after committing the deduction
  //    so the manual button's behaviour is byte-for-byte unchanged).
  if (group.annotations_json && !force) {
    try {
      const ann = JSON.parse(group.annotations_json)
      if (ann?.items?.length > 0) {
        return { already_exists: true, tokensDeducted: tokenCost, balanceAfter }
      }
    } catch { /* proceed */ }
  }

  // 5. Stale pending cleanup
  await db.prepare(`
    UPDATE experiment_runs SET status = 'failed'
    WHERE id IN (
      SELECT er.id FROM experiment_runs er
      JOIN experiments e ON e.id = er.experiment_id
      WHERE er.video_id IN (SELECT id FROM videos WHERE group_id = ?)
        AND er.status = 'pending'
        AND e.name ILIKE 'Auto:%'
        AND er.created_at < NOW() - INTERVAL '5 minutes'
    )
  `).run(groupId)

  // 6. Strategy + version
  const mainStrategy = await db.prepare('SELECT * FROM strategies WHERE is_main = 1').get()
  if (!mainStrategy) return { error: 'no_main_strategy' }
  const version = await db.prepare(
    'SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version_number DESC LIMIT 1'
  ).get(mainStrategy.id)
  if (!version) return { error: 'no_strategy_versions' }

  // 7. Find one video with a transcript
  const video = await db.prepare(`
    SELECT v.* FROM videos v
    JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id = ? AND v.video_type = 'raw'
    ORDER BY v.id LIMIT 1
  `).get(groupId)
  if (!video) return { error: 'no_video_with_transcript' }

  // 8. Create experiment + run
  const expResult = await db.prepare(
    'INSERT INTO experiments (strategy_version_id, name, notes, video_ids_json, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(version.id, `Auto: ${mainStrategy.name}`, `Auto-run for group ${groupId}`, JSON.stringify([video.id]), userId)

  const experimentId = Number(expResult.lastInsertRowid)
  const runResult = await db.prepare(
    'INSERT INTO experiment_runs (experiment_id, video_id, run_number, status) VALUES (?, ?, 1, ?)'
  ).run(experimentId, video.id, 'pending')
  const runId = Number(runResult.lastInsertRowid)

  let stageInfos = []
  try {
    const stages = JSON.parse(version.stages_json || '[]')
    stageInfos = stages.map((s, i) => ({
      name: s.name || `Stage ${i + 1}`,
      type: s.type || 'llm',
    }))
  } catch {}

  // 9. Background pipeline
  ;(async () => {
    const MAX_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { executeRun } = await import('./llm-runner.js')
        if (attempt > 1) {
          await db.prepare("UPDATE experiment_runs SET status = 'pending', error_message = NULL WHERE id = ?").run(runId)
        }
        await executeRun(runId)
        const completedRun = await db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(runId)
        if (completedRun.status !== 'complete' && completedRun.status !== 'partial') {
          if (attempt < MAX_ATTEMPTS) continue
          return
        }
        const am = await import('./annotation-mapper.js')
        let wordTimestamps = await am.getTimelineWordTimestamps(groupId)
        if (!wordTimestamps?.length) {
          const transcript = await db.prepare(
            "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'"
          ).get(video.id)
          if (transcript?.word_timestamps_json) {
            try { wordTimestamps = JSON.parse(transcript.word_timestamps_json) } catch {}
          }
        }
        if (!wordTimestamps?.length) return
        const groupData = await db.prepare(
          'SELECT assembled_transcript FROM video_groups WHERE id = ?'
        ).get(groupId)
        const annotations = await am.buildAnnotationsFromRun(runId, wordTimestamps, groupData?.assembled_transcript)
        await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?').run(JSON.stringify(annotations), groupId)
        return
      } catch (err) {
        console.error(`[runAiRoughCut] Attempt ${attempt} failed for group ${groupId}:`, err.message)
      }
    }
  })()

  return {
    ok: true,
    experimentId, runId,
    totalStages: stageInfos.length,
    stageNames: stageInfos.map(s => s.name),
    stageTypes: stageInfos.map(s => s.type),
    tokensDeducted: tokenCost,
    balanceAfter,
  }
}
```

- [ ] **Step 3.4: Run test, verify pass**

Run:
```bash
npx vitest run server/services/__tests__/rough-cut-runner.test.js
```
Expected: 4 passing.

- [ ] **Step 3.5: Refactor route to use the helper**

In `server/routes/videos.js`, replace the body of the `POST /groups/:id/start-ai-roughcut` handler at line 1012 with:

```js
import { runAiRoughCut } from '../services/rough-cut-runner.js'
// (add to imports at top of file if not already present)

// ...

router.post('/groups/:id/start-ai-roughcut', requireAuth, async (req, res) => {
  const r = await runAiRoughCut({
    groupId: parseInt(req.params.id),
    userId: req.auth.userId,
    isAdmin: isAdmin(req),
    force: !!req.query.force,
  })
  if (r.error === 'not_found') return res.status(404).json({ error: 'Group not found' })
  if (r.error === 'no_main_strategy') return res.status(400).json({ error: 'No main strategy configured' })
  if (r.error === 'no_strategy_versions') return res.status(400).json({ error: 'Main strategy has no versions' })
  if (r.error === 'no_video_with_transcript') return res.status(400).json({ error: 'No video with transcript found' })
  if (r.error === 'insufficient_tokens') return res.status(402).json({ error: 'insufficient_tokens', balance: r.balance, required: r.required })
  if (r.already_exists) return res.json({ already_exists: true, tokensDeducted: r.tokensDeducted, balanceAfter: r.balanceAfter })
  res.json({
    experimentId: r.experimentId, runId: r.runId,
    totalStages: r.totalStages, stageNames: r.stageNames, stageTypes: r.stageTypes,
    tokensDeducted: r.tokensDeducted, balanceAfter: r.balanceAfter,
  })
})
```

The original 140-line body is gone; the response shape is preserved.

- [ ] **Step 3.6: Run full server test suite to confirm no regressions**

Run:
```bash
npx vitest run --project server
```
Expected: all server tests pass (existing tests untouched).

- [ ] **Step 3.7: Manual smoke — hit the endpoint**

Start the server (`npm run dev:server`), then in another terminal:
```bash
curl -X POST 'http://localhost:3001/api/videos/groups/<existing-group-id>/start-ai-roughcut' \
  -H "Authorization: Bearer <test-token>"
```
Expected: same JSON shape as before — `experimentId`, `runId`, `tokensDeducted`, etc. (or `already_exists: true` if the group already has annotations).

- [ ] **Step 3.8: Commit**

```bash
git add server/services/rough-cut-runner.js server/services/__tests__/rough-cut-runner.test.js server/routes/videos.js
git commit -m "refactor(api): extract runAiRoughCut helper from /start-ai-roughcut

Pulls the route's 140-line body — token deduction, existing-annotations
short-circuit, experiment/run creation, background pipeline — into a
reusable function. The route handler is now a 15-line wrapper that
forwards the same response shape. Sets up the slice 1 auto-trigger
(next task) to fire the same pipeline server-side after sync."
```

---

## Task 4: `GET /groups/:id/status` returns rough_cut fields

**Files:**
- Modify: `server/routes/videos.js:551-555`

- [ ] **Step 4.1: Update the route**

Find the existing handler (around line 551):

```js
router.get('/groups/:id/status', requireAuth, async (req, res) => {
  const row = await db.prepare(`SELECT assembly_status, assembly_error FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!row) return res.status(404).json({ error: 'Group not found' })
  res.json({ assembly_status: row.assembly_status, assembly_error: row.assembly_error })
})
```

Replace with:

```js
router.get('/groups/:id/status', requireAuth, async (req, res) => {
  const row = await db.prepare(
    `SELECT assembly_status, assembly_error, rough_cut_status, rough_cut_error_required
     FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`
  ).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!row) return res.status(404).json({ error: 'Group not found' })
  res.json({
    assembly_status: row.assembly_status,
    assembly_error: row.assembly_error,
    rough_cut_status: row.rough_cut_status,
    rough_cut_error_required: row.rough_cut_error_required,
  })
})
```

- [ ] **Step 4.2: Manual verify**

Hit the endpoint for a known group:
```bash
curl 'http://localhost:3001/api/videos/groups/<group-id>/status' -H "Authorization: Bearer <token>"
```
Expected JSON includes `rough_cut_status: null` (until the auto-trigger fires).

- [ ] **Step 4.3: Commit**

```bash
git add server/routes/videos.js
git commit -m "feat(api): expose rough_cut_status in GET /groups/:id/status"
```

---

## Task 5: Auto-trigger hook in `multicam-sync.updateStatus`

**Files:**
- Modify: `server/services/multicam-sync.js:792-800`
- Create: `server/services/__tests__/multicam-sync-auto-trigger.test.js`

The hook centralises in `updateStatus` so all four `done` paths (1-video shortcut, no-sync mode, post-classification single, full sync) are covered.

- [ ] **Step 5.1: Write failing test**

Create `server/services/__tests__/multicam-sync-auto-trigger.test.js`:

```js
// Tests the auto-rough-cut hook inside multicam-sync.updateStatus.
//
// We bypass the analyzer (it's heavy and irrelevant) and call updateStatus
// directly with status='done', then assert that runAiRoughCut was or wasn't
// invoked based on the group's auto_rough_cut flag.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { group: null, statusUpdates: [], runAiRoughCutCalls: [] }

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(id) {
          if (/SELECT user_id, auto_rough_cut FROM video_groups WHERE id/.test(sql)) {
            return state.group
          }
          throw new Error(`unexpected .get SQL: ${sql}`)
        },
        async run(...args) {
          if (/UPDATE video_groups SET assembly_status/.test(sql)) {
            state.statusUpdates.push(args)
            return { changes: 1 }
          }
          if (/UPDATE video_groups SET rough_cut_status/.test(sql)) {
            state.statusUpdates.push(['rough_cut_status', ...args])
            return { changes: 1 }
          }
          throw new Error(`unexpected .run SQL: ${sql}`)
        },
      }
    },
  },
}))

vi.mock('../rough-cut-runner.js', () => ({
  runAiRoughCut: vi.fn(async (args) => {
    state.runAiRoughCutCalls.push(args)
    return { ok: true, experimentId: 1, runId: 2 }
  }),
}))

import { updateStatus } from '../multicam-sync.js' // see Task 5.3 — exported

beforeEach(() => {
  state.group = null
  state.statusUpdates = []
  state.runAiRoughCutCalls = []
})

describe('updateStatus auto-rough-cut hook', () => {
  it('fires runAiRoughCut when status=done and auto_rough_cut=true', async () => {
    state.group = { user_id: 'u1', auto_rough_cut: true }
    await updateStatus(1, 'done')
    // wait a tick — the hook is fire-and-forget but invocation is synchronous
    await new Promise(r => setImmediate(r))
    expect(state.runAiRoughCutCalls).toHaveLength(1)
    expect(state.runAiRoughCutCalls[0]).toMatchObject({ groupId: 1, userId: 'u1' })
  })

  it('does NOT fire when auto_rough_cut=false', async () => {
    state.group = { user_id: 'u1', auto_rough_cut: false }
    await updateStatus(1, 'done')
    await new Promise(r => setImmediate(r))
    expect(state.runAiRoughCutCalls).toHaveLength(0)
  })

  it('does NOT fire on non-terminal statuses', async () => {
    state.group = { user_id: 'u1', auto_rough_cut: true }
    await updateStatus(1, 'syncing')
    await new Promise(r => setImmediate(r))
    expect(state.runAiRoughCutCalls).toHaveLength(0)
  })

  it('does NOT fire when status is failed', async () => {
    state.group = { user_id: 'u1', auto_rough_cut: true }
    await updateStatus(1, 'failed', 'some error')
    await new Promise(r => setImmediate(r))
    expect(state.runAiRoughCutCalls).toHaveLength(0)
  })
})
```

- [ ] **Step 5.2: Run test, expect failure (updateStatus not exported, hook not present)**

Run:
```bash
npx vitest run server/services/__tests__/multicam-sync-auto-trigger.test.js
```
Expected: import fails or all four tests fail (no hook + not exported).

- [ ] **Step 5.3: Export `updateStatus` and add the hook**

In `server/services/multicam-sync.js`, find:

```js
async function updateStatus(groupId, status, error = null, transcript = null, details = null) {
  if (transcript !== null) {
    await db.prepare('UPDATE video_groups SET assembly_status = ?, assembly_error = ?, assembled_transcript = ?, assembly_details_json = ? WHERE id = ?')
      .run(status, error, transcript, details, groupId)
  } else {
    await db.prepare('UPDATE video_groups SET assembly_status = ?, assembly_error = ? WHERE id = ?')
      .run(status, error, groupId)
  }
}
```

Replace with:

```js
export async function updateStatus(groupId, status, error = null, transcript = null, details = null) {
  if (transcript !== null) {
    await db.prepare('UPDATE video_groups SET assembly_status = ?, assembly_error = ?, assembled_transcript = ?, assembly_details_json = ? WHERE id = ?')
      .run(status, error, transcript, details, groupId)
  } else {
    await db.prepare('UPDATE video_groups SET assembly_status = ?, assembly_error = ? WHERE id = ?')
      .run(status, error, groupId)
  }

  // Auto-trigger AI Rough Cut when sync finishes successfully on a flagged group.
  // Fire-and-forget: rough cut is independent of the assembly write success.
  if (status === 'done') {
    const flagRow = await db.prepare(
      'SELECT user_id, auto_rough_cut FROM video_groups WHERE id = ?'
    ).get(groupId)
    if (flagRow?.auto_rough_cut) {
      await db.prepare(
        "UPDATE video_groups SET rough_cut_status = 'pending' WHERE id = ?"
      ).run(groupId)
      const { runAiRoughCut } = await import('./rough-cut-runner.js')
      runAiRoughCut({ groupId, userId: flagRow.user_id })
        .then(async (r) => {
          if (r.error === 'insufficient_tokens') {
            await db.prepare(
              "UPDATE video_groups SET rough_cut_status = 'insufficient_tokens', rough_cut_error_required = ? WHERE id = ?"
            ).run(r.required, groupId)
          } else if (r.error || (!r.ok && !r.already_exists)) {
            await db.prepare(
              "UPDATE video_groups SET rough_cut_status = 'failed' WHERE id = ?"
            ).run(groupId)
          } else if (r.already_exists) {
            await db.prepare(
              "UPDATE video_groups SET rough_cut_status = 'done' WHERE id = ?"
            ).run(groupId)
          } else {
            // ok=true, pipeline kicked off in background. Pipeline completion
            // hook (Task 6) flips status to 'done'. Hold at 'running'.
            await db.prepare(
              "UPDATE video_groups SET rough_cut_status = 'running' WHERE id = ?"
            ).run(groupId)
          }
        })
        .catch(async (err) => {
          console.error(`[auto-rough-cut] group ${groupId} failed:`, err.message)
          await db.prepare(
            "UPDATE video_groups SET rough_cut_status = 'failed' WHERE id = ?"
          ).run(groupId)
        })
    }
  }
}
```

- [ ] **Step 5.4: Run test, verify pass**

Run:
```bash
npx vitest run server/services/__tests__/multicam-sync-auto-trigger.test.js
```
Expected: 4 passing.

- [ ] **Step 5.5: Commit**

```bash
git add server/services/multicam-sync.js server/services/__tests__/multicam-sync-auto-trigger.test.js
git commit -m "feat(server): auto-fire rough cut after sync when group is flagged

updateStatus picks up the group's auto_rough_cut flag whenever it writes
status='done' and dispatches runAiRoughCut. Outcome is reflected in
rough_cut_status: 'pending' → 'running' (pipeline took over) | 'done'
(annotations already existed) | 'insufficient_tokens' | 'failed'.
'running' → 'done' is wired in the next task.
Hooks centralised in updateStatus so all four 'done' paths (single
video, no-sync, post-classification, full sync) are covered."
```

---

## Task 6: Pipeline completion → `rough_cut_status='done'`

**Files:**
- Modify: `server/services/rough-cut-runner.js` (the background pipeline IIFE)

The runner already writes `annotations_json` at the end of the pipeline — we extend that block to also flip `rough_cut_status` if it was set to `'running'`.

- [ ] **Step 6.1: Add the status flip**

In `server/services/rough-cut-runner.js`, find the line that writes annotations inside the background IIFE:

```js
        await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?').run(JSON.stringify(annotations), groupId)
        return
```

Replace with:

```js
        await db.prepare('UPDATE video_groups SET annotations_json = ? WHERE id = ?').run(JSON.stringify(annotations), groupId)
        // If this run was the auto-trigger (rough_cut_status was set), flip to done.
        // Use a conditional UPDATE so a manual-trigger run (status null) stays null.
        await db.prepare(
          "UPDATE video_groups SET rough_cut_status = 'done' WHERE id = ? AND rough_cut_status IN ('pending', 'running')"
        ).run(groupId)
        return
```

Also add a failure hook at the bottom of the for-loop (before the closing `})()`):

```js
    // All attempts exhausted — mark as failed if this was an auto-trigger.
    await db.prepare(
      "UPDATE video_groups SET rough_cut_status = 'failed' WHERE id = ? AND rough_cut_status IN ('pending', 'running')"
    ).run(groupId)
  })()
```

- [ ] **Step 6.2: Manual verify locally**

  1. Set `auto_rough_cut=true` on a test group via psql:
     ```bash
     psql "$DB_URL" -c "UPDATE video_groups SET auto_rough_cut = true, assembly_status = 'syncing' WHERE id = <test-group-id>;"
     ```
  2. Trigger `analyzeMulticam(<test-group-id>)` directly via a one-off node script, or wait for the next real assembly run.
  3. Tail Postgres while it runs:
     ```bash
     watch -n 1 "psql \"\$DB_URL\" -c 'SELECT id, assembly_status, rough_cut_status FROM video_groups WHERE id = <test-group-id>;'"
     ```
  4. Expect the row to walk: `syncing` → `done`, then `rough_cut_status` should walk `pending` → `running` → `done`.

- [ ] **Step 6.3: Commit**

```bash
git add server/services/rough-cut-runner.js
git commit -m "feat(server): flip rough_cut_status to done when pipeline completes

Conditional UPDATE only touches rows where status is pending or running
so manual-trigger runs (status null) stay null and don't get clobbered."
```

---

## Task 7: `StepRoughCut.jsx` — new upload step

**Files:**
- Create: `src/components/upload-config/steps/StepRoughCut.jsx`
- Create: `src/components/upload-config/__tests__/StepRoughCut.test.jsx`

Reference: `~/Downloads/Adpunk (2)/step-rough-cut.jsx` for the visual structure (target cards, before/after preview, stats grid). Tailwind translation needed — the mockup uses inline styles.

- [ ] **Step 7.1: Write failing test**

Create `src/components/upload-config/__tests__/StepRoughCut.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import StepRoughCut from '../steps/StepRoughCut.jsx'

beforeEach(() => {
  global.fetch = vi.fn(async (url) => {
    if (url.endsWith('/estimate-ai-roughcut')) {
      return { ok: true, json: async () => ({ tokenCost: 1200, estimatedTimeSeconds: 900, balance: 5000, sufficient: true, durationSeconds: 2400 }) }
    }
    if (url.endsWith('/user/tokens')) {
      return { ok: true, json: async () => ({ balance: 5000 }) }
    }
    throw new Error(`unmocked fetch: ${url}`)
  })
})

describe('StepRoughCut', () => {
  it('defaults to Skip', () => {
    render(<StepRoughCut groupId={1} state={{ autoRoughCut: false }} setState={{ autoRoughCut: () => {} }} />)
    const skip = screen.getByRole('radio', { name: /skip/i })
    expect(skip.checked).toBe(true)
  })

  it('shows estimate from server when Run is selected', async () => {
    const setAutoRoughCut = vi.fn()
    const { rerender } = render(
      <StepRoughCut groupId={1} state={{ autoRoughCut: false }} setState={{ autoRoughCut: setAutoRoughCut }} />
    )
    fireEvent.click(screen.getByRole('radio', { name: /run/i }))
    rerender(<StepRoughCut groupId={1} state={{ autoRoughCut: true }} setState={{ autoRoughCut: setAutoRoughCut }} />)
    await waitFor(() => expect(screen.getByText(/1,200/)).toBeTruthy())
  })

  it('exposes balance shortfall via onValidityChange when balance < cost', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tokenCost: 1200, estimatedTimeSeconds: 900, balance: 50, sufficient: false, durationSeconds: 2400 }),
    }))
    const onValidity = vi.fn()
    render(
      <StepRoughCut
        groupId={1}
        state={{ autoRoughCut: true }}
        setState={{ autoRoughCut: () => {} }}
        onValidityChange={onValidity}
      />
    )
    await waitFor(() => expect(onValidity).toHaveBeenCalledWith(false))
    expect(screen.getByText(/Not enough tokens/i)).toBeTruthy()
  })
})
```

- [ ] **Step 7.2: Run test, expect failure (file doesn't exist)**

Run:
```bash
npx vitest run src/components/upload-config/__tests__/StepRoughCut.test.jsx
```
Expected: import fails — module not found.

- [ ] **Step 7.3: Implement the component**

Create `src/components/upload-config/steps/StepRoughCut.jsx`:

```jsx
import { useEffect, useState, useRef } from 'react'
import { supabase } from '../../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

const TARGETS = [
  { id: 'filler',   label: 'Filler words',    icon: 'speaker_notes_off',
    examples: ['um', 'uh', 'like', 'you know', 'sort of', 'I mean'] },
  { id: 'restarts', label: 'False starts',    icon: 'restart_alt',
    examples: ['"Actually, wait — let me rephrase…"', '"So, um, what I meant was…"'] },
  { id: 'meta',     label: 'Meta commentary', icon: 'chat_bubble_outline',
    examples: ['"Can you cut that?"', '"Let\'s redo that take."', '"[pause]"'] },
]

async function authHeaders() {
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return headers
}

function formatTokens(n) {
  return n?.toLocaleString() ?? '—'
}

function formatTime(s) {
  if (!s) return '—'
  if (s < 60) return `~${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return sec === 0 ? `~${m}m` : `~${m}m ${sec}s`
}

export default function StepRoughCut({ groupId, state, setState, onValidityChange }) {
  const [estimate, setEstimate] = useState(null) // { tokenCost, estimatedTimeSeconds, balance, sufficient, durationSeconds }
  const [polling, setPolling] = useState(false)
  const pollAttempts = useRef(0)

  // Poll the estimate endpoint until duration is populated (videos may still
  // be uploading / awaiting Cloudflare metadata when this step mounts).
  useEffect(() => {
    if (!groupId) return
    let cancelled = false

    async function fetchEstimate() {
      try {
        const headers = await authHeaders()
        const res = await fetch(`${API_BASE}/videos/groups/${groupId}/estimate-ai-roughcut`, { method: 'POST', headers })
        if (!res.ok) return null
        return await res.json()
      } catch { return null }
    }

    async function loop() {
      setPolling(true)
      while (!cancelled) {
        const data = await fetchEstimate()
        if (cancelled) return
        if (data) {
          setEstimate(data)
          if (data.tokenCost > 0) { setPolling(false); return }
        }
        pollAttempts.current++
        const delay = pollAttempts.current < 60 ? 1000 : 3000
        await new Promise(r => setTimeout(r, delay))
      }
    }
    loop()
    return () => { cancelled = true }
  }, [groupId])

  // Validity: if Skip, always valid. If Run, valid iff balance >= cost.
  useEffect(() => {
    if (!onValidityChange) return
    if (!state.autoRoughCut) { onValidityChange(true); return }
    if (!estimate || estimate.tokenCost === 0) { onValidityChange(true); return } // unknown; trust server-side
    onValidityChange(estimate.balance >= estimate.tokenCost)
  }, [state.autoRoughCut, estimate, onValidityChange])

  const insufficient = state.autoRoughCut && estimate && estimate.tokenCost > 0 && estimate.balance < estimate.tokenCost

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="text-[10px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant flex items-center gap-2">
          <span className="material-symbols-outlined text-secondary text-base">content_cut</span>
          AI Rough Cut · Step 5 of 7
        </div>
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface mt-3">
          Want a clean transcript before we plan b-roll?
        </h1>
        <p className="text-on-surface-variant text-sm mt-3 max-w-[720px] leading-relaxed">
          Rough Cut runs an AI pass over the transcript and removes the throwaway bits —
          filler words, false starts, and director commentary — before any b-roll work begins.
          Skip it and the transcript goes through untouched.
        </p>
      </div>

      {/* Skip / Run radio */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <label className={`p-4 rounded-lg border cursor-pointer transition-all ${!state.autoRoughCut ? 'border-primary-fixed bg-primary-fixed/5' : 'border-outline-variant/20 hover:border-outline-variant/40'}`}>
          <input
            type="radio"
            name="rough-cut-mode"
            checked={!state.autoRoughCut}
            onChange={() => setState.autoRoughCut(false)}
            className="sr-only"
            aria-label="Skip"
          />
          <div className="font-bold text-sm text-on-surface">Skip</div>
          <div className="text-xs text-on-surface-variant mt-1">Use the raw transcript as-is.</div>
        </label>

        <label className={`p-4 rounded-lg border cursor-pointer transition-all ${state.autoRoughCut ? 'border-secondary bg-secondary/5' : 'border-outline-variant/20 hover:border-outline-variant/40'}`}>
          <input
            type="radio"
            name="rough-cut-mode"
            checked={!!state.autoRoughCut}
            onChange={() => setState.autoRoughCut(true)}
            className="sr-only"
            aria-label="Run"
          />
          <div className="font-bold text-sm text-on-surface">Run Rough Cut</div>
          <div className="text-xs text-on-surface-variant mt-1">
            ~{formatTokens(estimate?.tokenCost)} tokens · {formatTime(estimate?.estimatedTimeSeconds)}
          </div>
        </label>
      </div>

      {insufficient && (
        <div className="mb-6 rounded-lg border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">
          Not enough tokens. You have <strong>{formatTokens(estimate.balance)}</strong>, this needs <strong>{formatTokens(estimate.tokenCost)}</strong>. Top up your balance or pick Skip to continue.
        </div>
      )}

      {/* What gets removed */}
      <div className="mb-6">
        <div className="text-[10px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant mb-3">
          What gets removed
        </div>
        <div className="grid grid-cols-3 gap-3">
          {TARGETS.map(t => (
            <div key={t.id} className="rounded-lg border border-outline-variant/10 bg-surface-container-low/50 p-4 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-base">{t.icon}</span>
              </div>
              <div className="min-w-0">
                <div className="font-bold text-xs text-on-surface mb-2">{t.label}</div>
                <div className="flex flex-wrap gap-1">
                  {t.examples.map((e, i) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 rounded border border-error/15 bg-error/5 text-error/80 line-through font-mono">
                      {e}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Estimate stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-outline-variant/10 bg-surface-container-low/50 p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary-fixed/10 text-primary-fixed flex items-center justify-center"><span className="material-symbols-outlined text-base">schedule</span></div>
          <div>
            <div className="text-[9px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant">Estimated time</div>
            <div className="text-lg font-extrabold text-on-surface mt-0.5">{polling && !estimate?.tokenCost ? 'Calculating...' : formatTime(estimate?.estimatedTimeSeconds)}</div>
          </div>
        </div>
        <div className="rounded-lg border border-outline-variant/10 bg-surface-container-low/50 p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center"><span className="material-symbols-outlined text-base">deployed_code</span></div>
          <div>
            <div className="text-[9px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant">Token usage</div>
            <div className="text-lg font-extrabold text-on-surface mt-0.5">{polling && !estimate?.tokenCost ? 'Calculating...' : `~${formatTokens(estimate?.tokenCost)} tokens`}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 7.4: Run tests, verify pass**

Run:
```bash
npx vitest run src/components/upload-config/__tests__/StepRoughCut.test.jsx
```
Expected: 3 passing.

- [ ] **Step 7.5: Commit**

```bash
git add src/components/upload-config/steps/StepRoughCut.jsx src/components/upload-config/__tests__/StepRoughCut.test.jsx
git commit -m "feat(upload): StepRoughCut — Skip/Run radio + live token estimate"
```

---

## Task 8: Wire StepRoughCut into `UploadConfigFlow`

**Files:**
- Modify: `src/components/upload-config/UploadConfigFlow.jsx`

- [ ] **Step 8.1: Update `UNIFIED_STEPS` and `CONFIG_STEPS`**

In `UploadConfigFlow.jsx`, find:

```js
const UNIFIED_STEPS = [
  { id: 'upload',     label: 'Upload' },
  { id: 'libraries',  label: 'Libraries' },
  { id: 'audience',   label: 'Audience' },
  { id: 'references', label: 'Refs' },
  { id: 'path',       label: 'Path' },
  { id: 'transcribe', label: 'Transcribe' },
]
const CONFIG_STEPS = UNIFIED_STEPS.slice(1, 5)
```

Replace with:

```js
const UNIFIED_STEPS = [
  { id: 'upload',     label: 'Upload' },
  { id: 'libraries',  label: 'Libraries' },
  { id: 'audience',   label: 'Audience' },
  { id: 'references', label: 'Refs' },
  { id: 'roughcut',   label: 'Rough Cut' },
  { id: 'path',       label: 'Path' },
  { id: 'transcribe', label: 'Transcribe' },
]
const CONFIG_STEPS = UNIFIED_STEPS.slice(1, 6)
```

- [ ] **Step 8.2: Add reducer state + action**

Update `DEFAULT_STATE`:

```js
const DEFAULT_STATE = {
  libraries: [],
  freepikOptIn: true,
  audience: { age: ['millennial', 'gen_z'], sex: ['any'], ethnicity: ['any'], language: 'English', region: '', notes: '' },
  pathId: 'strategy-only',
  autoRoughCut: false,    // NEW
}
```

Add reducer case:

```js
case 'setAutoRoughCut': return { ...state, autoRoughCut: action.payload }
```

- [ ] **Step 8.3: Persist `auto_rough_cut` on Continue**

In the `persistCurrent` function, after the `path` block add:

```js
    } else if (stepId === 'roughcut') {
      body.auto_rough_cut = state.autoRoughCut
```

- [ ] **Step 8.4: Wire into `setState` + body switch**

In `setState`:

```js
  const setState = {
    libraries:      v => dispatch({ type: 'setLibraries', payload: v }),
    freepikOptIn:   v => dispatch({ type: 'setFreepikOptIn', payload: v }),
    audience:       v => dispatch({ type: 'setAudience', payload: v }),
    pathId:         v => dispatch({ type: 'setPathId', payload: v }),
    autoRoughCut:   v => dispatch({ type: 'setAutoRoughCut', payload: v }),  // NEW
  }
```

Import the new component at the top:

```js
import StepRoughCut from './steps/StepRoughCut.jsx'
```

In the body conditional, sub-steps are now indexed 0..4:

```js
  let body
  if (submitted) body = <StepDone state={state} onEdit={() => setSubmitted(false)} onComplete={() => onComplete(groupId)} />
  else if (current === 0) body = <StepLibraries state={state} setState={setState} />
  else if (current === 1) body = <StepAudience state={state} setState={setState} />
  else if (current === 2) body = <StepReferences groupId={groupId} onValidityChange={setReferencesValid} />
  else if (current === 3) body = <StepRoughCut groupId={groupId} state={state} setState={setState} onValidityChange={setRoughCutValid} />
  else if (current === 4) body = <StepPath state={state} setState={setState} />
```

- [ ] **Step 8.5: Add `roughCutValid` state + extend `continueDisabled`**

Near the existing `referencesValid`:

```js
  const [referencesValid, setReferencesValid] = useState(false)
  const [roughCutValid, setRoughCutValid] = useState(true)  // valid by default; disabled only when balance < cost
```

Update `continueDisabled`:

```js
  const continueDisabled =
    (currentStepId === 'references' && !referencesValid) ||
    (currentStepId === 'roughcut'   && !roughCutValid)
```

- [ ] **Step 8.6: Update the warning tooltip on Continue**

```js
  title={
    continueDisabled && currentStepId === 'references' ? 'Add at least 2 reference videos and pick a favorite' :
    continueDisabled && currentStepId === 'roughcut'   ? 'Not enough tokens for AI Rough Cut' :
    undefined
  }
```

- [ ] **Step 8.7: Hydrate `autoRoughCut` from `initialState`**

`initialState` already gets spread into the reducer (existing line `useReducer(reducer, { ...DEFAULT_STATE, ...(initialState || {}) })`). Nothing to change here — make sure `ProjectsView` passes `autoRoughCut` (Task 9).

- [ ] **Step 8.8: Build + type-free smoke**

Run:
```bash
npm run build 2>&1 | tail -10
```
Expected: `✓ built in <time>` with no JSX errors.

- [ ] **Step 8.9: Commit**

```bash
git add src/components/upload-config/UploadConfigFlow.jsx
git commit -m "feat(upload): wire StepRoughCut into the config flow

Adds 'roughcut' to UNIFIED_STEPS between references and path; reducer,
persistCurrent, setState and body switch all updated. continueDisabled
extends so the user can't advance past Run with insufficient balance."
```

---

## Task 9: `ProjectsView` — register `roughcut` step + hydrate

**Files:**
- Modify: `src/components/views/ProjectsView.jsx`

- [ ] **Step 9.1: Add `'roughcut'` to `CONFIG_STEPS`**

Find:

```js
const CONFIG_STEPS = new Set(['libraries', 'audience', 'references', 'path'])
```

Replace with:

```js
const CONFIG_STEPS = new Set(['libraries', 'audience', 'references', 'roughcut', 'path'])
```

- [ ] **Step 9.2: Hydrate `autoRoughCut` in `initialConfig`**

Find the `initialConfig` block:

```js
  const initialConfig = currentGroup ? {
    libraries: currentGroup.libraries || [],
    freepikOptIn: currentGroup.freepik_opt_in !== false,
    audience: currentGroup.audience || undefined,
    pathId: currentGroup.path_id || undefined,
  } : null
```

Replace with:

```js
  const initialConfig = currentGroup ? {
    libraries: currentGroup.libraries || [],
    freepikOptIn: currentGroup.freepik_opt_in !== false,
    audience: currentGroup.audience || undefined,
    pathId: currentGroup.path_id || undefined,
    autoRoughCut: !!currentGroup.auto_rough_cut,
  } : null
```

- [ ] **Step 9.3: Map `auto_rough_cut` from the videos list response**

Find the `groupMap[gid]` initialization in the `projects` IIFE:

```js
        groupMap[gid] = {
          id: v.group_id || v.id,
          name: v.group_name || v.title,
          videos: [],
          created_at: v.created_at,
          assembly_status: v.group_assembly_status,
          isGroup: !!v.group_id,
          libraries: v.libraries || [],
          freepik_opt_in: v.freepik_opt_in === undefined ? true : v.freepik_opt_in,
          audience: v.audience || null,
          path_id: v.path_id || null,
        }
```

Add the field:

```js
        groupMap[gid] = {
          ...,
          auto_rough_cut: !!v.auto_rough_cut,
        }
```

(Apply the addition before the closing brace.)

- [ ] **Step 9.4: Verify GET /videos returns `auto_rough_cut`**

The `GET /videos` handler builds rows from `videos` joined with `video_groups`. Inspect `server/routes/videos.js:465+` — the SELECT already pulls `vg.libraries_json, vg.freepik_opt_in, vg.audience_json, vg.path_id`. Add `vg.auto_rough_cut`:

```js
// Find the SELECT inside the GET / handler. After the existing path_id field, add:
       vg.auto_rough_cut AS auto_rough_cut,
```

(If the existing query is structured differently — e.g. `SELECT v.*, vg.* FROM videos v LEFT JOIN video_groups vg ON ...` — confirm the column is already pulled by `vg.*`. Otherwise add the explicit column.)

- [ ] **Step 9.5: Smoke test the round-trip**

  1. Open a project mid-config flow: `?step=libraries&group=<id>`
  2. Click Continue through to Step 5 (Rough Cut), pick Run, click Continue.
  3. Reload `?step=roughcut&group=<id>` — expect Run to be pre-selected.

- [ ] **Step 9.6: Commit**

```bash
git add src/components/views/ProjectsView.jsx server/routes/videos.js
git commit -m "feat(upload): hydrate auto_rough_cut on reload of upload-config flow"
```

---

## Task 10: `SyncingScreen` extension — show rough cut stage

**Files:**
- Modify: `src/components/editor/EditorView.jsx:1068-1116`

- [ ] **Step 10.1: Extend `STATUS_LABELS`**

Find:

```js
const STATUS_LABELS = {
  pending: 'Starting sync...',
  transcribing: 'Transcribing audio...',
  classifying: 'Classifying videos...',
  syncing: 'Analyzing transcripts...',
  building_timeline: 'Building timeline...',
  ordering: 'Ordering segments...',
  assembling: 'Assembling transcript...',
}
```

Replace with:

```js
const STATUS_LABELS = {
  pending: 'Starting sync...',
  transcribing: 'Transcribing audio...',
  classifying: 'Classifying videos...',
  syncing: 'Analyzing transcripts...',
  building_timeline: 'Building timeline...',
  ordering: 'Ordering segments...',
  assembling: 'Assembling transcript...',
  rough_cut: 'Cleaning your transcript...',
}
```

- [ ] **Step 10.2: Update `SyncingScreen` to poll and render rough_cut**

Replace the `SyncingScreen` function with:

```jsx
function SyncingScreen({ groupId, status, onDone }) {
  // currentStatus is the *display* status — assembly stages or 'rough_cut'.
  const [currentStatus, setCurrentStatus] = useState(status)

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await authFetch(`/videos/groups/${groupId}/status`)
        const data = await res.json()

        const assemblyDone = data.assembly_status === 'done' || data.assembly_status === 'error'
        const roughCutInFlight = data.rough_cut_status === 'pending' || data.rough_cut_status === 'running'

        if (assemblyDone && roughCutInFlight) {
          setCurrentStatus('rough_cut')
          return
        }
        if (assemblyDone) {
          // assembly is done AND rough cut is null/done/failed/insufficient_tokens → exit.
          clearInterval(interval)
          onDone()
          return
        }
        setCurrentStatus(data.assembly_status)
      } catch {}
    }, 1500)
    return () => clearInterval(interval)
  }, [groupId, onDone])

  return (
    <div className="h-screen flex flex-col items-center justify-center bg-[#0e0e10] text-on-surface gap-6">
      <div className="relative">
        <span className="material-symbols-outlined animate-spin text-5xl text-primary-fixed">progress_activity</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-lg font-bold text-on-surface">
          {currentStatus === 'rough_cut' ? 'Cleaning your transcript' : 'Syncing project'}
        </h2>
        <p className="text-sm text-on-surface-variant">{STATUS_LABELS[currentStatus] || currentStatus}</p>
      </div>
      <div className="flex gap-1 mt-2">
        {Object.keys(STATUS_LABELS).map(s => (
          <div key={s} className={`w-2 h-2 rounded-full transition-colors ${
            s === currentStatus ? 'bg-primary-fixed' :
            Object.keys(STATUS_LABELS).indexOf(s) < Object.keys(STATUS_LABELS).indexOf(currentStatus) ? 'bg-primary-fixed/40' :
            'bg-white/10'
          }`} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 10.3: Extend `isAssembling` predicate**

Find at line 810:

```js
  const assemblyStatus = groupDetail?.assembly_status
  const isAssembling = assemblyStatus && !['done', 'error', 'classifying', 'classified', 'classification_failed', 'confirmed'].includes(assemblyStatus)
  if (isAssembling) {
    return <SyncingScreen groupId={id} status={assemblyStatus} onDone={() => { refetchDetail(); refetchTimestamps() }} />
  }
```

Replace with:

```js
  const assemblyStatus = groupDetail?.assembly_status
  const roughCutStatus = groupDetail?.rough_cut_status
  const inAssembly = assemblyStatus && !['done', 'error', 'classifying', 'classified', 'classification_failed', 'confirmed'].includes(assemblyStatus)
  const inRoughCut = roughCutStatus === 'pending' || roughCutStatus === 'running'
  const isAssembling = inAssembly || inRoughCut
  if (isAssembling) {
    return <SyncingScreen
      groupId={id}
      status={inRoughCut && !inAssembly ? 'rough_cut' : assemblyStatus}
      onDone={() => { refetchDetail(); refetchTimestamps() }}
    />
  }
```

- [ ] **Step 10.4: Ensure `groupDetail` exposes `rough_cut_status`**

Find `GET /groups/:id/detail` in `server/routes/videos.js` (line 514). The response builder is around line 600-610. Add `rough_cut_status` and `rough_cut_error_required` to the `group` payload:

```js
group: {
  id: group.id,
  name: group.name,
  assembly_status: group.assembly_status,
  assembly_error: group.assembly_error,
  rough_cut_status: group.rough_cut_status,                    // NEW
  rough_cut_error_required: group.rough_cut_error_required,    // NEW
},
```

- [ ] **Step 10.5: Smoke test**

  1. Trigger an assembly with `auto_rough_cut=true` (set the column manually for now).
  2. Watch the URL `/editor/<id>/sync` — SyncingScreen should walk through the existing labels, then show "Cleaning your transcript..." until the experiment_run completes.
  3. After completion, editor mounts with annotations applied.

- [ ] **Step 10.6: Commit**

```bash
git add src/components/editor/EditorView.jsx server/routes/videos.js
git commit -m "feat(editor): SyncingScreen polls rough_cut_status as final stage

isAssembling extends to cover rough_cut pending/running so the user stays
on a coherent loading screen until annotations are ready. STATUS_LABELS
gains a 'rough_cut' entry: 'Cleaning your transcript...'."
```

---

## Task 11: Editor banner for rough-cut failures

**Files:**
- Modify: `src/components/editor/EditorView.jsx`

- [ ] **Step 11.1: Add the banner component inline**

Just above the `export default function EditorView` declaration, add:

```jsx
function RoughCutFailureBanner({ status, requiredTokens, balance, onRetry, onDismiss }) {
  if (status !== 'insufficient_tokens' && status !== 'failed') return null
  const insufficient = status === 'insufficient_tokens'
  return (
    <div className="bg-error/10 border-b border-error/20 px-6 py-3 flex items-center justify-between text-sm">
      <div className="flex items-center gap-3 text-error">
        <span className="material-symbols-outlined text-base">error</span>
        {insufficient
          ? <span>AI Rough Cut couldn't run — needs <strong>{requiredTokens?.toLocaleString()}</strong> tokens, you have <strong>{balance?.toLocaleString() ?? '—'}</strong>.</span>
          : <span>AI Rough Cut failed. You can retry without re-paying tokens.</span>
        }
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onRetry} className="px-4 py-1.5 rounded bg-error text-on-error font-bold uppercase tracking-wider text-xs hover:bg-error/90">
          {insufficient ? 'Top up & retry' : 'Retry'}
        </button>
        <button onClick={onDismiss} className="px-3 py-1.5 text-error/70 hover:text-error text-xs">Dismiss</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 11.2: Render the banner in the editor frame**

Inside the main `return (...)` of `EditorView`, just below the `<header>` (around line 858, before `<div className="flex flex-1 overflow-hidden">`), add:

```jsx
        <RoughCutFailureBanner
          status={groupDetail?.rough_cut_status}
          requiredTokens={groupDetail?.rough_cut_error_required}
          balance={tokenBalance}
          onRetry={handleStartAIRoughCut}
          onDismiss={async () => {
            // Set rough_cut_status to NULL so the banner stops showing.
            await authFetch(`/videos/groups/${id}/dismiss-rough-cut-error`, { method: 'POST' })
            refetchDetail()
          }}
        />
```

- [ ] **Step 11.3: Add the dismiss endpoint**

In `server/routes/videos.js`, after `/groups/:id/start-ai-roughcut`, add:

```js
router.post('/groups/:id/dismiss-rough-cut-error', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const group = await db.prepare(
    `SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`
  ).get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })
  await db.prepare(
    "UPDATE video_groups SET rough_cut_status = NULL, rough_cut_error_required = NULL WHERE id = ? AND rough_cut_status IN ('insufficient_tokens', 'failed')"
  ).run(groupId)
  res.json({ ok: true })
})
```

- [ ] **Step 11.4: Smoke test**

  1. Manually set `rough_cut_status='insufficient_tokens'`, `rough_cut_error_required=5000` on a group via psql.
  2. Open `/editor/<id>` — banner shows above the header with the shortfall.
  3. Click Dismiss — banner disappears, DB row reflects NULLs.
  4. Re-set status to `'failed'`, reload — banner shows generic "AI Rough Cut failed", Retry calls the existing button.

- [ ] **Step 11.5: Commit**

```bash
git add src/components/editor/EditorView.jsx server/routes/videos.js
git commit -m "feat(editor): banner for rough-cut failures with retry/dismiss"
```

---

## Task 12: End-to-end manual smoke

This task has no code; it's the validation gate. Run after all preceding tasks.

- [ ] **Step 12.1: Reset a test group and walk the flow**

  1. From Projects → New Project → upload a short test video (2–5 minutes).
  2. Step through Libraries → Audience → References (add 2 refs + favorite).
  3. **Rough Cut step**: pick Run. Verify:
     - Token estimate appears within ~30s.
     - Balance display matches `/api/videos/user/tokens`.
     - If you mock low balance via psql (`UPDATE user_tokens SET balance = 10 WHERE user_id = '<your-user>';`) and reload, Continue is disabled.
     - Restore balance, Continue is enabled.
  4. Path → Transcribe → wait through ProcessingModal.
  5. Editor opens via `/editor/<id>/assets` — auto-confirms (1-video shortcut from earlier work).
  6. SyncingScreen appears. Walk through assembly labels.
  7. After assembly: SyncingScreen does NOT exit yet — shows "Cleaning your transcript..." for as long as rough cut runs.
  8. After rough cut completes: editor opens with annotations visible (filler words struck through, false-start chunks marked).

- [ ] **Step 12.2: Negative path — race-condition insufficient balance**

  1. Repeat Step 12.1 but during the wait, drain the balance manually:
     ```sql
     UPDATE user_tokens SET balance = 0 WHERE user_id = '<your-user>';
     ```
  2. When sync finishes, the auto-trigger should hit `insufficient_tokens`.
  3. SyncingScreen exits, editor opens with raw transcript + the failure banner showing the shortfall.
  4. Top up balance (`UPDATE user_tokens SET balance = 10000 ...`), click Retry → manual rough cut runs.
  5. Click Dismiss instead → banner clears, DB row goes to NULL.

- [ ] **Step 12.3: Negative path — Skip on Step 5**

  1. Same flow, but pick **Skip** on Step 5.
  2. After sync, editor opens with raw transcript and **no** banner. `rough_cut_status` stays NULL on the group.

- [ ] **Step 12.4: Negative path — manual button still works**

  1. From a group that has `auto_rough_cut=false` (i.e. Step 5 was Skip), open the editor.
  2. Click the manual "Start AI Rough Cut" button.
  3. Estimation modal opens with the same number as `/estimate-ai-roughcut`.
  4. Accept → pipeline runs → annotations appear. (Confirms the refactor in Task 3 didn't break the manual path.)

- [ ] **Step 12.5: Run full test suite**

```bash
npm run test
```
Expected: all server, web, and extension tests pass.

- [ ] **Step 12.6: Build production bundle**

```bash
npm run build
```
Expected: `✓ built in <time>`, no errors.

- [ ] **Step 12.7: Open a PR**

```bash
gh pr create --title "feat: Auto Rough Cut slice 1 — upload step + post-sync auto-trigger" --body "$(cat <<'EOF'
## Summary
- Adds an opt-in **Rough Cut** step at index 5 of the upload-config flow with a live token estimate and pre-flight balance gate.
- Server fires the existing AI Rough Cut pipeline automatically once \`analyzeMulticam\` writes \`assembly_status='done'\` on a flagged group.
- \`SyncingScreen\` keeps the user on a single coherent loading screen through both phases ("Cleaning your transcript..." for the rough-cut tail).
- Failure handling: insufficient_tokens / pipeline error surfaces a banner above the editor with retry + dismiss.

Spec: \`docs/specs/2026-04-28-auto-rough-cut-slice1-design.md\`
Plan: \`docs/plans/2026-04-28-auto-rough-cut-slice1.md\`

This is **slice 1 of 3**. Slice 2 (Path-driven B-roll automation) and slice 3 (full-auto progress UI + email) build on the \`runAiRoughCut\` helper and the \`rough_cut_status\` polling pattern.

## Test plan
- [x] Vitest: \`runAiRoughCut\` happy/insufficient/already-exists.
- [x] Vitest: \`updateStatus\` auto-trigger only fires on \`done + flag\`.
- [x] Vitest: \`StepRoughCut\` default Skip + balance gate.
- [x] Manual: end-to-end walk Skip + Run + insufficient + manual button.
- [x] \`npm run build\` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

After writing this plan, here's the spec-coverage check against `docs/specs/2026-04-28-auto-rough-cut-slice1-design.md`:

| Spec section | Implemented in |
|---|---|
| DB schema (2 columns + error_required) | Task 1 |
| Step ordering changes | Task 8 |
| `StepRoughCut` skeleton + estimate fetch | Task 7 |
| Pre-flight balance check | Task 7 + Task 8 |
| `validateGroupUpdate` + PUT `/groups/:id` | Task 2 |
| Initial-state hydration | Task 9 |
| Default Skip | Task 7 |
| `runAiRoughCut` extraction | Task 3 |
| Auto-trigger in `analyzeMulticam` (via `updateStatus`) | Task 5 |
| Status response extension | Task 4 + Task 10 (detail endpoint) |
| `SyncingScreen` extension | Task 10 |
| Insufficient-tokens race handler + banner | Task 11 |
| Annotations-already-exist short-circuit | Already in Task 3 (preserved from original route) |
| Pipeline-error banner | Task 11 |
| Pre-flight estimate=0 fallback | Task 7 (60s polling, then unblock Continue) |
| Tests for `runAiRoughCut` | Task 3 |
| Tests for auto-trigger hook | Task 5 |
| Tests for `StepRoughCut` | Task 7 |
| Manual smoke for `SyncingScreen` | Task 12 |

No gaps. No placeholders. Type names consistent (`auto_rough_cut`, `rough_cut_status`, `rough_cut_error_required` used throughout; helper called `runAiRoughCut`; status values `pending|running|done|failed|insufficient_tokens`).
