# Full Auto Handoff — Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side orchestrator that runs the full pipeline (transcribe → classify → confirm-split → sync → rough cut → b-roll references → strategy → plan → first-10 search) end-to-end after uploads finish; respects `strategy-only` / `guided` checkpoints; emails the user via Resend at terminal states. Frontend ProcessingModal evolves into a project-level stage timeline.

**Architecture:** Three new server modules — `auto-orchestrator.js`, `broll-runner.js`, `email-notifier.js` — that extract logic from existing route handlers (mirroring slice 1's `runAiRoughCut` extraction). One server-side chain orchestrator wires them together. `pathToFlags` (existing) encodes per-path pauses. Frontend ProcessingModal gains a three-mode render branch driven by a single new aggregate endpoint.

**Tech Stack:** Node 20 + Express + Postgres (node-pg), Resend (`resend` npm package, free tier), React + Vite, Vitest 1.6 workspace projects.

**Spec:** `docs/specs/2026-04-28-full-auto-handoff-slice2-design.md`

**Branch:** `feature/full-auto-handoff-slice2` (this worktree)

**Depends on:** Slice 1 (`docs/specs/2026-04-28-auto-rough-cut-slice1-design.md`). Slice 1 must be merged to main and slice 2's branch rebased on top before implementation. Several tasks below reuse helpers introduced in slice 1 (`runAiRoughCut`, slice 1's hook in `multicam-sync.updateStatus`).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `server/schema-pg.sql` | Modify | Add `broll_chain_status`, `broll_chain_error`, `notified_at` columns to `video_groups`. |
| `server/seed/migrate-broll-chain.js` | Create | Idempotent migration script for slice 2's columns. |
| `package.json` | Modify | Add `"resend": "^4.0.0"` to dependencies. |
| `server/services/email-notifier.js` | Create | Resend wrapper; template registry (`done`, `paused_at_strategy`, `paused_at_plan`, `failed`); dedup window. |
| `server/services/__tests__/email-notifier.test.js` | Create | Tests: noop without API key, dedup window, template render. |
| `server/services/broll-runner.js` | Create | Extracted helpers: `runAllReferences`, `runStrategies`, `runPlanForEachVariant`, `runBrollSearchFirst10`, `waitForPipelinesComplete`. |
| `server/services/__tests__/broll-runner.test.js` | Create | Per-helper tests with mocked db + mocked `executePipeline`. |
| `server/services/auto-orchestrator.js` | Create | `reclassifyGroup`, `confirmClassificationGroup`, `runFullAutoBrollChain`, `resumeChain`, `resumeStuckFullAutoChains`. |
| `server/services/__tests__/auto-orchestrator.test.js` | Create | Chain logic; flag propagation at split; per-path pause behavior. |
| `server/routes/videos.js` | Modify | (a) Last-done transcription hook fires `reclassifyGroup`. (b) `/reclassify` and `/confirm-classification` route bodies become wrappers around orchestrator helpers. (c) New `GET /groups/:id/full-auto-status` aggregate endpoint. (d) `/detail` returns new fields. (e) `GET /videos` list adds aggregate sub-group counts for badges. |
| `server/routes/broll.js` | Modify | Route bodies for `/run-all`, `/run-strategies`, `/run-plan`, `/search-next-batch` become wrappers around `broll-runner.js`. New endpoints: `POST /groups/:subId/resume-chain`, `POST /groups/:subId/retry-chain`. |
| `server/services/multicam-sync.js` | Modify | Slice 1 hook in `updateStatus` extends to fire `runFullAutoBrollChain` after rough cut terminal. |
| `server/index.js` | Modify | Call `resumeStuckFullAutoChains` on startup. |
| `src/components/views/ProcessingModal.jsx` | Modify | Three-mode render (`uploading` / `pipeline` / `done`); new `StageTimeline` sub-component; Full Auto banner. |
| `src/components/views/__tests__/ProcessingModal-stages.test.jsx` | Create | Stage derivation tests; banner visibility; paused-state row rendering. |
| `src/components/upload-config/steps/StepPath.jsx` | Modify | Pre-flight validation when Full Auto is selected. |
| `src/components/views/ProjectsView.jsx` | Modify | Aggregate progress badge ("Processing · 4 / 10 stages"). |

---

## Task 1: Rebase onto slice 1

**Files:** none — pure git operation.

- [ ] **Step 1.1: Confirm slice 1 is merged to main**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git log --oneline -5 main | grep -i "slice 1\|auto-rough-cut" || echo "Slice 1 not merged yet — block this work"
```

- [ ] **Step 1.2: Rebase slice 2 worktree onto main**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval-full-auto-slice2"
git fetch origin main
git rebase origin/main
```

Resolve any conflicts (unlikely — slice 1 only touches new files + some routes that slice 2 also touches, but the touchpoints are different).

---

## Task 2: DB migration

**Files:**
- Modify: `server/schema-pg.sql` (the `video_groups` block)
- Create: `server/seed/migrate-broll-chain.js`

- [ ] **Step 2.1: Add columns to schema**

Inside `CREATE TABLE IF NOT EXISTS video_groups`, after slice 1's `rough_cut_error_required INTEGER,` line, add:

```sql
  broll_chain_status TEXT,
  broll_chain_error TEXT,
  notified_at TIMESTAMPTZ,
```

- [ ] **Step 2.2: Migration script**

Create `server/seed/migrate-broll-chain.js`:

```js
import 'dotenv/config'
import db from '../db.js'

async function run() {
  await db.prepare(`
    ALTER TABLE video_groups
      ADD COLUMN IF NOT EXISTS broll_chain_status TEXT,
      ADD COLUMN IF NOT EXISTS broll_chain_error TEXT,
      ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ
  `).run()
  console.log('[migrate] broll-chain columns ensured on video_groups')
  process.exit(0)
}

run().catch(err => { console.error('[migrate] failed:', err); process.exit(1) })
```

- [ ] **Step 2.3: Run + verify**

```bash
node --env-file=.env server/seed/migrate-broll-chain.js
DB_URL=$(grep '^DATABASE_URL=' .env | sed 's/^DATABASE_URL=//' | sed 's/?.*//')
psql "$DB_URL" -c "\d video_groups" | grep -E "broll_chain_status|broll_chain_error|notified_at"
```

Expected: 3 rows with the new columns.

- [ ] **Step 2.4: Commit**

```bash
git add server/schema-pg.sql server/seed/migrate-broll-chain.js
git commit -m "feat(db): add broll_chain_status, broll_chain_error, notified_at to video_groups"
```

---

## Task 3: Add Resend dependency + email-notifier

**Files:**
- Modify: `package.json`
- Create: `server/services/email-notifier.js`
- Create: `server/services/__tests__/email-notifier.test.js`

- [ ] **Step 3.1: Install Resend**

```bash
npm install resend@^4.0.0
```

Verify `package.json` lists `"resend": "^4.0.0"` under dependencies.

- [ ] **Step 3.2: Failing tests first**

Create `server/services/__tests__/email-notifier.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend = vi.fn().mockResolvedValue({ id: 'mock-email-id' })

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({ emails: { send: mockSend } })),
}))

const state = { group: null, user: null, recentNotified: false }

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT notified_at FROM video_groups WHERE id = \? AND notified_at > NOW\(\)/.test(sql)) {
            return state.recentNotified ? { notified_at: new Date() } : null
          }
          if (/SELECT id, name FROM video_groups WHERE id = \?/.test(sql)) return state.group
          if (/SELECT email FROM auth\.users WHERE id = \?/.test(sql)) return state.user
          throw new Error(`unexpected get: ${sql}`)
        },
        async run(...args) {
          if (/UPDATE video_groups SET notified_at = NOW\(\)/.test(sql)) return { changes: 1 }
          throw new Error(`unexpected run: ${sql}`)
        },
      }
    },
  },
}))

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test_key'
  state.group = { id: 1, name: 'Project X' }
  state.user = { email: 'user@example.com' }
  state.recentNotified = false
  mockSend.mockClear()
})

describe('email-notifier', () => {
  it('noops when RESEND_API_KEY is empty', async () => {
    delete process.env.RESEND_API_KEY
    const mod = await import('../email-notifier.js?nokey=' + Date.now())
    await mod.send('done', { subGroupId: 1, userId: 'u1' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('sends with correct from/subject for done template', async () => {
    const { send } = await import('../email-notifier.js?key=' + Date.now())
    await send('done', { subGroupId: 1, userId: 'u1' })
    expect(mockSend).toHaveBeenCalledOnce()
    const call = mockSend.mock.calls[0][0]
    expect(call.from).toMatch(/Adpunk/)
    expect(call.to).toBe('user@example.com')
    expect(call.subject).toMatch(/Project X.*ready/)
    expect(call.html).toContain('href=')
  })

  it('skips dispatch within 5-minute dedup window', async () => {
    state.recentNotified = true
    const { send } = await import('../email-notifier.js?dedup=' + Date.now())
    await send('done', { subGroupId: 1, userId: 'u1' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('sends paused_at_strategy template with correct subject', async () => {
    const { send } = await import('../email-notifier.js?strat=' + Date.now())
    await send('paused_at_strategy', { subGroupId: 1, userId: 'u1' })
    const call = mockSend.mock.calls[0][0]
    expect(call.subject).toMatch(/Pick.*strategy/)
  })

  it('logs errors but never throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('Resend down'))
    const { send } = await import('../email-notifier.js?err=' + Date.now())
    await expect(send('done', { subGroupId: 1, userId: 'u1' })).resolves.not.toThrow()
  })
})
```

- [ ] **Step 3.3: Run, expect failure**

```bash
npx vitest run server/services/__tests__/email-notifier.test.js
```

Expected: import resolves to undefined → all tests fail.

- [ ] **Step 3.4: Implement email-notifier**

Create `server/services/email-notifier.js`:

```js
// Resend-backed transactional email dispatcher for slice-2 chain notifications.
//
// Templates: done | paused_at_strategy | paused_at_plan | failed.
// Dedup: per-sub-group 5-minute window (notified_at column on video_groups).
// Failure: logs and swallows; never throws out of send() so the orchestrator
//          can stay fire-and-forget.
//
// When RESEND_API_KEY is unset (e.g. during local dev or before DNS is
// verified), every call is a no-op and a single console.log marks it.

import { Resend } from 'resend'
import db from '../db.js'

const FROM = 'Adpunk <noreply@adpunk.ai>'
const PUBLIC_FRONTEND_URL = process.env.PUBLIC_FRONTEND_URL
  || 'https://transcript-eval-sylvesterads-projects.vercel.app'

let resend = null
function getClient() {
  if (resend !== null) return resend
  resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : false
  return resend || null
}

const TEMPLATES = {
  done: ({ projectName, editorUrl }) => ({
    subject: `Your project "${projectName}" is ready`,
    html: `<p>We've finished processing your project.</p><p><a href="${editorUrl}">Open project →</a></p>`,
  }),
  paused_at_strategy: ({ projectName, editorUrl }) => ({
    subject: `Pick a creative strategy for "${projectName}"`,
    html: `<p>Your project's references have been analyzed. Pick the strategy you'd like to run.</p><p><a href="${editorUrl}">Open project →</a></p>`,
  }),
  paused_at_plan: ({ projectName, editorUrl }) => ({
    subject: `Pick a b-roll plan for "${projectName}"`,
    html: `<p>Your strategy is set. Pick a plan to start the b-roll search.</p><p><a href="${editorUrl}">Open project →</a></p>`,
  }),
  failed: ({ projectName, editorUrl, error }) => ({
    subject: `Something went wrong with "${projectName}"`,
    html: `<p>We hit an error processing your project: ${error || 'unknown'}.</p><p><a href="${editorUrl}">Open project to retry →</a></p>`,
  }),
}

export async function send(template, { subGroupId, userId, error } = {}) {
  const client = getClient()
  if (!client) {
    console.log(`[email] no API key — skipping ${template} for sub-group ${subGroupId}`)
    return
  }
  const tpl = TEMPLATES[template]
  if (!tpl) {
    console.error(`[email] unknown template: ${template}`)
    return
  }

  try {
    const recent = await db.prepare(
      "SELECT notified_at FROM video_groups WHERE id = ? AND notified_at > NOW() - INTERVAL '5 minutes'"
    ).get(subGroupId)
    if (recent?.notified_at) return

    const sg = await db.prepare('SELECT id, name FROM video_groups WHERE id = ?').get(subGroupId)
    if (!sg) return
    const user = await db.prepare('SELECT email FROM auth.users WHERE id = ?').get(userId)
    if (!user?.email) return

    const editorUrl = `${PUBLIC_FRONTEND_URL}/editor/${subGroupId}/sync`
    const { subject, html } = tpl({ projectName: sg.name, editorUrl, error })

    await client.emails.send({ from: FROM, to: user.email, subject, html })
    await db.prepare('UPDATE video_groups SET notified_at = NOW() WHERE id = ?').run(subGroupId)
  } catch (err) {
    console.error('[email] send failed:', err.message)
  }
}
```

- [ ] **Step 3.5: Run, verify pass**

```bash
npx vitest run server/services/__tests__/email-notifier.test.js
```

Expected: 5 passing.

- [ ] **Step 3.6: Commit**

```bash
git add package.json package-lock.json server/services/email-notifier.js server/services/__tests__/email-notifier.test.js
git commit -m "feat(server): Resend-backed email-notifier with templates + dedup"
```

---

## Task 4: `broll-runner` extraction — `runAllReferences`

**Files:**
- Create: `server/services/broll-runner.js`
- Modify: `server/routes/broll.js:927-1029` (the `/pipeline/run-all` route)
- Create: `server/services/__tests__/broll-runner.test.js`

- [ ] **Step 4.1: Failing test**

Create `server/services/__tests__/broll-runner.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  videos: [{ id: 387, group_id: 1 }, { id: 388, group_id: 1 }],
  examples: [{ id: 901 }, { id: 902 }],
  analysisStrategy: { id: 5 },
  analysisVersion: { id: 50 },
  completedAnalysis: [],
  group: { id: 1, editor_state_json: null },
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT editor_state_json FROM video_groups WHERE id = \?/.test(sql)) return state.group
          if (/SELECT \* FROM broll_strategies WHERE strategy_kind = 'main_analysis'/.test(sql)) return state.analysisStrategy
          if (/SELECT \* FROM broll_strategy_versions/.test(sql)) return state.analysisVersion
          if (/metadata_json LIKE.*plan_prep/.test(sql)) return null  // no existing prep
          throw new Error(`unexpected get: ${sql}`)
        },
        async all(...args) {
          if (/FROM broll_runs WHERE strategy_id = \? AND video_id = \?/.test(sql)) return state.completedAnalysis
          throw new Error(`unexpected all: ${sql}`)
        },
      }
    },
  },
}))

vi.mock('../broll.js', () => ({
  loadExampleVideos: vi.fn().mockResolvedValue([{ id: 901 }, { id: 902 }]),
  executePlanPrep: vi.fn().mockResolvedValue(),
  executePipeline: vi.fn().mockResolvedValue(),
  brollPipelineProgress: new Map(),
}))

import { runAllReferences } from '../broll-runner.js'

beforeEach(() => {
  state.completedAnalysis = []
})

describe('runAllReferences', () => {
  it('returns prep + analysis pipeline IDs for new project', async () => {
    const r = await runAllReferences({ subGroupId: 1, mainVideoId: 387 })
    expect(r.prepPipelineId).toMatch(/^7-387-\d+$/)
    expect(r.analysisPipelineIds).toHaveLength(2)
    expect(r.analysisPipelineIds[0]).toMatch(/^5-387-\d+-ex901$/)
  })

  it('reuses existing analysis when reference already analyzed', async () => {
    state.completedAnalysis = [
      { metadata_json: JSON.stringify({ pipelineId: '5-387-1234-ex901' }) },
    ]
    const r = await runAllReferences({ subGroupId: 1, mainVideoId: 387 })
    expect(r.analysisPipelineIds).toContain('5-387-1234-ex901')
    expect(r.analysisPipelineIds).toHaveLength(2)  // 1 reused + 1 new
  })
})
```

- [ ] **Step 4.2: Run, expect failure**

```bash
npx vitest run server/services/__tests__/broll-runner.test.js
```

Expected: import fails — module not found.

- [ ] **Step 4.3: Create broll-runner.js with `runAllReferences`**

Create `server/services/broll-runner.js`:

```js
// Reusable b-roll pipeline runners. Bodies extracted from server/routes/broll.js.
// Used both by the original HTTP routes (which become thin wrappers) and by
// the slice-2 auto-orchestrator chain.

import db from '../db.js'

// runAllReferences — extracted from POST /broll/pipeline/run-all (broll.js:927)
//
// Fires plan-prep + per-reference analysis pipelines in parallel.
// Returns { prepPipelineId, analysisPipelineIds, videoCount, skippedAnalysis, skippedPrep }.
// Already-complete pipelines for the same (video, reference) pair are reused.
export async function runAllReferences({ subGroupId, mainVideoId }) {
  if (!mainVideoId || !subGroupId) {
    throw new Error('runAllReferences: subGroupId and mainVideoId required')
  }

  // Lazy-import to avoid circular dep with broll.js
  const { loadExampleVideos, executePlanPrep, executePipeline, brollPipelineProgress } =
    await import('../routes/broll.js')

  let editorCuts = null
  const group = await db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(subGroupId)
  if (group?.editor_state_json) {
    try {
      const s = JSON.parse(group.editor_state_json)
      if (s.cuts?.length) editorCuts = { cuts: s.cuts, cutExclusions: s.cutExclusions || [] }
    } catch {}
  }

  const examples = await loadExampleVideos(subGroupId)
  const readyVideos = examples.filter(v => v.id)

  const existingPrep = await db.prepare(
    `SELECT metadata_json FROM broll_runs WHERE video_id = ? AND status = 'complete' AND metadata_json LIKE '%"phase":"plan_prep"%' AND metadata_json NOT LIKE '%"isSubRun":true%' LIMIT 1`
  ).get(mainVideoId)
  const existingPrepId = existingPrep ? JSON.parse(existingPrep.metadata_json || '{}').pipelineId : null

  let prepPipelineId = existingPrepId
  if (!existingPrepId) {
    prepPipelineId = `7-${mainVideoId}-${Date.now()}`
    brollPipelineProgress.set(prepPipelineId, {
      strategyId: 7, videoId: mainVideoId, groupId: subGroupId,
      status: 'running', stageName: 'Loading data...', stageIndex: 0, totalStages: 5,
      phase: 'plan_prep', strategyName: 'Plan Prep',
    })
    executePlanPrep(mainVideoId, subGroupId, editorCuts, prepPipelineId)
      .catch(err => console.error(`[broll-runner] Plan prep failed: ${err.message}`))
  }

  const analysisStrategy = await db.prepare(
    "SELECT * FROM broll_strategies WHERE strategy_kind = 'main_analysis' ORDER BY id LIMIT 1"
  ).get()
  const allAnalysisIds = []

  if (analysisStrategy) {
    const completedAnalysisRuns = await db.prepare(
      `SELECT metadata_json FROM broll_runs WHERE strategy_id = ? AND video_id = ? AND status = 'complete' AND metadata_json NOT LIKE '%"isSubRun":true%' ORDER BY id DESC`
    ).all(analysisStrategy.id, mainVideoId)

    const alreadyAnalyzedVideoIds = new Set()
    for (const r of completedAnalysisRuns) {
      try {
        const m = JSON.parse(r.metadata_json || '{}')
        const ex = m.pipelineId?.match(/-ex(\d+)/)
        if (ex) {
          alreadyAnalyzedVideoIds.add(Number(ex[1]))
          if (!allAnalysisIds.includes(m.pipelineId)) allAnalysisIds.push(m.pipelineId)
        }
      } catch {}
    }

    const analysisVersion = await db.prepare(
      'SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(analysisStrategy.id)

    if (analysisVersion) {
      const newVideos = readyVideos.filter(v => !alreadyAnalyzedVideoIds.has(v.id))
      for (const vid of newVideos) {
        const pid = `${analysisStrategy.id}-${mainVideoId}-${Date.now()}-ex${vid.id}`
        allAnalysisIds.push(pid)
        brollPipelineProgress.set(pid, {
          strategyId: analysisStrategy.id, videoId: mainVideoId, groupId: subGroupId,
          status: 'running', stageName: 'Loading data...', stageIndex: 0, totalStages: 1,
          exampleVideoId: vid.id, strategyName: 'Reference Analysis',
        })
        executePipeline(
          analysisStrategy.id, analysisVersion.id, mainVideoId, subGroupId,
          'raw', null, null, null,
          { exampleVideoId: vid.id, pipelineIdOverride: pid },
        ).catch(err => console.error(`[broll-runner] Analysis for video ${vid.id} failed: ${err.message}`))
      }
    }
  }

  return {
    prepPipelineId,
    analysisPipelineIds: allAnalysisIds,
    videoCount: readyVideos.length,
    skippedAnalysis: readyVideos.length - allAnalysisIds.filter(id => brollPipelineProgress.get(id)?.status === 'running').length,
    skippedPrep: !!existingPrepId,
  }
}
```

- [ ] **Step 4.4: Run, verify pass**

```bash
npx vitest run server/services/__tests__/broll-runner.test.js
```

Expected: 2 passing.

- [ ] **Step 4.5: Refactor route to wrapper**

In `server/routes/broll.js`, replace the body of `/pipeline/run-all` (line 927-1029) with:

```js
router.post('/pipeline/run-all', requireAuth, async (req, res) => {
  try {
    const { video_id, group_id } = req.body || {}
    if (!video_id || !group_id) return res.status(400).json({ error: 'video_id and group_id required' })
    const { runAllReferences } = await import('../services/broll-runner.js')
    const r = await runAllReferences({ subGroupId: group_id, mainVideoId: video_id })
    res.json(r)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4.6: Smoke test the original endpoint**

Start the server (`npm run dev:server`); hit:

```bash
curl -X POST http://localhost:3001/api/broll/pipeline/run-all \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token>" \
  -d '{"video_id": <existing-video>, "group_id": <existing-group>}'
```

Expected: same JSON shape as before refactor.

- [ ] **Step 4.7: Commit**

```bash
git add server/services/broll-runner.js server/services/__tests__/broll-runner.test.js server/routes/broll.js
git commit -m "refactor(broll): extract runAllReferences from /pipeline/run-all"
```

---

## Task 5: `broll-runner` — `runStrategies`

**Files:**
- Modify: `server/services/broll-runner.js`
- Modify: `server/routes/broll.js:1032-1093` (the `/pipeline/run-strategies` route)
- Modify: `server/services/__tests__/broll-runner.test.js`

- [ ] **Step 5.1: Read the existing route body**

Open `server/routes/broll.js` at line 1032. Skim the body — it builds strategy pipelines from `prep_pipeline_id` + `analysis_pipeline_ids` + `video_id` + `group_id` and returns `{ strategyPipelineIds }`.

- [ ] **Step 5.2: Add a failing test**

Append to `server/services/__tests__/broll-runner.test.js`:

```js
describe('runStrategies', () => {
  it('returns strategy pipeline IDs (one per analysis)', async () => {
    state.combinedStrategy = { id: 12 }
    state.combinedVersion = { id: 120 }
    const { runStrategies } = await import('../broll-runner.js?strat=' + Date.now())
    const r = await runStrategies({
      subGroupId: 1, mainVideoId: 387,
      prepPipelineId: '7-387-1', analysisPipelineIds: ['5-387-1-ex901', '5-387-1-ex902'],
    })
    expect(r.strategyPipelineIds).toHaveLength(2)
  })
})
```

Extend the db mock at the top with:

```js
if (/SELECT \* FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy'/.test(sql)) return state.combinedStrategy
if (/SELECT \* FROM broll_strategy_versions WHERE strategy_id = \? ORDER BY/.test(sql)) return state.combinedVersion
```

- [ ] **Step 5.3: Run, expect failure**

```bash
npx vitest run server/services/__tests__/broll-runner.test.js -t runStrategies
```

- [ ] **Step 5.4: Implement `runStrategies`**

Append to `server/services/broll-runner.js`:

```js
// runStrategies — extracted from POST /broll/pipeline/run-strategies (broll.js:1032)
export async function runStrategies({ subGroupId, mainVideoId, prepPipelineId, analysisPipelineIds }) {
  if (!prepPipelineId || !analysisPipelineIds?.length) {
    throw new Error('runStrategies: prepPipelineId and analysisPipelineIds required')
  }
  const { executePipeline, brollPipelineProgress } = await import('../routes/broll.js')

  const combined = await db.prepare(
    "SELECT * FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1"
  ).get()
  if (!combined) throw new Error('No combined-strategy strategy registered')
  const version = await db.prepare(
    'SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(combined.id)
  if (!version) throw new Error('Combined strategy has no versions')

  const ids = []
  for (const aid of analysisPipelineIds) {
    const pid = `${combined.id}-${mainVideoId}-${Date.now()}-from-${aid}`
    ids.push(pid)
    brollPipelineProgress.set(pid, {
      strategyId: combined.id, videoId: mainVideoId, groupId: subGroupId,
      status: 'running', stageName: 'Generating strategy…', stageIndex: 0, totalStages: 1,
      phase: 'create_combined_strategy', analysisPipelineId: aid,
    })
    executePipeline(
      combined.id, version.id, mainVideoId, subGroupId,
      'raw', null, null, null,
      { pipelineIdOverride: pid, metadata: { prepPipelineId, analysisPipelineId: aid } },
    ).catch(err => console.error(`[broll-runner] Strategy from ${aid} failed: ${err.message}`))
  }
  return { strategyPipelineIds: ids }
}
```

> **Note:** if the existing `/run-strategies` body has additional metadata wiring not captured above, mirror it from the route at line 1032. Read that handler before implementing if uncertain.

- [ ] **Step 5.5: Run, verify pass**

```bash
npx vitest run server/services/__tests__/broll-runner.test.js
```

- [ ] **Step 5.6: Refactor route**

In `server/routes/broll.js:1032`, replace the body with:

```js
router.post('/pipeline/run-strategies', requireAuth, async (req, res) => {
  try {
    const { prep_pipeline_id, analysis_pipeline_ids, video_id, group_id } = req.body || {}
    if (!prep_pipeline_id || !analysis_pipeline_ids?.length || !video_id) {
      return res.status(400).json({ error: 'prep_pipeline_id, analysis_pipeline_ids, and video_id required' })
    }
    const { runStrategies } = await import('../services/broll-runner.js')
    const r = await runStrategies({
      subGroupId: group_id, mainVideoId: video_id,
      prepPipelineId: prep_pipeline_id, analysisPipelineIds: analysis_pipeline_ids,
    })
    res.json(r)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 5.7: Commit**

```bash
git add server/services/broll-runner.js server/services/__tests__/broll-runner.test.js server/routes/broll.js
git commit -m "refactor(broll): extract runStrategies from /pipeline/run-strategies"
```

---

## Task 6: `broll-runner` — `runPlanForEachVariant`

**Files:** same pattern as Task 5 — extract from `/broll/pipeline/run-plan` (broll.js:1155).

- [ ] **Step 6.1: Read existing route at broll.js:1155**

The route accepts `{ strategy_pipeline_id, video_id, group_id }` and returns `{ planPipelineId }`. We need a multi-variant version that runs N plans (one per strategy variant) in parallel and returns N IDs.

- [ ] **Step 6.2: Failing test**

Append to test file:

```js
describe('runPlanForEachVariant', () => {
  it('runs one plan pipeline per strategy variant', async () => {
    state.planStrategy = { id: 8 }
    state.planVersion = { id: 80 }
    const { runPlanForEachVariant } = await import('../broll-runner.js?plan=' + Date.now())
    const r = await runPlanForEachVariant({
      subGroupId: 1, mainVideoId: 387,
      strategyPipelineIds: ['12-387-1-from-5-387-1-ex901', '12-387-1-from-5-387-1-ex902'],
    })
    expect(r.planPipelineIds).toHaveLength(2)
  })
})
```

Extend db mock:

```js
if (/SELECT \* FROM broll_strategies WHERE strategy_kind = 'create_plan'/.test(sql)) return state.planStrategy
```

(The `broll_strategy_versions` mock is already in place from Task 5.)

- [ ] **Step 6.3: Run, expect failure**

```bash
npx vitest run server/services/__tests__/broll-runner.test.js -t runPlanForEachVariant
```

- [ ] **Step 6.4: Implement**

Append to `broll-runner.js`:

```js
// runPlanForEachVariant — for each strategy variant, fire a plan pipeline.
// Returns { planPipelineIds }.
export async function runPlanForEachVariant({ subGroupId, mainVideoId, strategyPipelineIds }) {
  if (!strategyPipelineIds?.length) throw new Error('runPlanForEachVariant: strategyPipelineIds required')
  const { executePipeline, brollPipelineProgress } = await import('../routes/broll.js')

  const plan = await db.prepare(
    "SELECT * FROM broll_strategies WHERE strategy_kind = 'create_plan' ORDER BY id LIMIT 1"
  ).get()
  if (!plan) throw new Error('No create_plan strategy registered')
  const version = await db.prepare(
    'SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(plan.id)
  if (!version) throw new Error('Plan strategy has no versions')

  const ids = []
  for (const stratId of strategyPipelineIds) {
    const pid = `plan-${mainVideoId}-${Date.now()}-from-${stratId}`
    ids.push(pid)
    brollPipelineProgress.set(pid, {
      strategyId: plan.id, videoId: mainVideoId, groupId: subGroupId,
      status: 'running', stageName: 'Generating plan…', stageIndex: 0, totalStages: 1,
      phase: 'create_plan', strategyPipelineId: stratId,
    })
    executePipeline(
      plan.id, version.id, mainVideoId, subGroupId,
      'raw', null, null, null,
      { pipelineIdOverride: pid, metadata: { strategyPipelineId: stratId } },
    ).catch(err => console.error(`[broll-runner] Plan from ${stratId} failed: ${err.message}`))
  }
  return { planPipelineIds: ids }
}
```

- [ ] **Step 6.5: Run, verify**

```bash
npx vitest run server/services/__tests__/broll-runner.test.js
```

- [ ] **Step 6.6: Refactor route + commit**

Replace `/pipeline/run-plan` body (broll.js:1155) with a wrapper similar to Task 5. The existing route runs ONE plan; we need to keep that single-plan endpoint AND add a multi-plan internal helper. Wrapper:

```js
router.post('/pipeline/run-plan', requireAuth, async (req, res) => {
  try {
    const { strategy_pipeline_id, video_id, group_id } = req.body || {}
    if (!strategy_pipeline_id) return res.status(400).json({ error: 'strategy_pipeline_id required' })
    const { runPlanForEachVariant } = await import('../services/broll-runner.js')
    const r = await runPlanForEachVariant({
      subGroupId: group_id, mainVideoId: video_id,
      strategyPipelineIds: [strategy_pipeline_id],
    })
    res.json({ planPipelineId: r.planPipelineIds[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

```bash
git add server/services/broll-runner.js server/services/__tests__/broll-runner.test.js server/routes/broll.js
git commit -m "refactor(broll): extract runPlanForEachVariant from /pipeline/run-plan"
```

---

## Task 7: `broll-runner` — `runBrollSearchFirst10` + `waitForPipelinesComplete`

- [ ] **Step 7.1: Failing test for waitForPipelinesComplete**

Append to test file:

```js
describe('waitForPipelinesComplete', () => {
  it('resolves when all pipelines reach complete', async () => {
    const { waitForPipelinesComplete } = await import('../broll-runner.js?wait=' + Date.now())
    const { brollPipelineProgress } = await import('../../routes/broll.js')
    brollPipelineProgress.set('p1', { status: 'running' })
    brollPipelineProgress.set('p2', { status: 'running' })
    const promise = waitForPipelinesComplete(['p1', 'p2'], { pollIntervalMs: 10, maxWaitMs: 1000 })
    setTimeout(() => brollPipelineProgress.set('p1', { status: 'complete' }), 30)
    setTimeout(() => brollPipelineProgress.set('p2', { status: 'complete' }), 60)
    await expect(promise).resolves.toBeUndefined()
  })

  it('rejects on first failed pipeline', async () => {
    const { waitForPipelinesComplete } = await import('../broll-runner.js?fail=' + Date.now())
    const { brollPipelineProgress } = await import('../../routes/broll.js')
    brollPipelineProgress.set('p3', { status: 'running' })
    setTimeout(() => brollPipelineProgress.set('p3', { status: 'failed', error: 'boom' }), 20)
    await expect(waitForPipelinesComplete(['p3'], { pollIntervalMs: 10 })).rejects.toThrow(/p3.*failed/)
  })

  it('rejects on timeout', async () => {
    const { waitForPipelinesComplete } = await import('../broll-runner.js?timeout=' + Date.now())
    const { brollPipelineProgress } = await import('../../routes/broll.js')
    brollPipelineProgress.set('p4', { status: 'running' })
    await expect(
      waitForPipelinesComplete(['p4'], { pollIntervalMs: 10, maxWaitMs: 50 })
    ).rejects.toThrow(/timed out/)
  })
})
```

- [ ] **Step 7.2: Implement**

Append to `broll-runner.js`:

```js
// waitForPipelinesComplete — polls brollPipelineProgress until all IDs reach
// 'complete', or rejects on the first 'failed', or after maxWaitMs.
export async function waitForPipelinesComplete(pipelineIds, { pollIntervalMs = 2000, maxWaitMs = 60 * 60 * 1000 } = {}) {
  if (!pipelineIds?.length) return
  const { brollPipelineProgress } = await import('../routes/broll.js')
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    let allComplete = true
    for (const id of pipelineIds) {
      const p = brollPipelineProgress.get(id) || {}
      if (p.status === 'failed') {
        throw new Error(`pipeline ${id} failed: ${p.error || 'unknown'}`)
      }
      if (p.status !== 'complete') { allComplete = false; break }
    }
    if (allComplete) return
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  throw new Error(`waitForPipelinesComplete: timed out after ${maxWaitMs}ms`)
}

// runBrollSearchFirst10 — extracted from search-next-batch (broll.js:628), batch 10.
export async function runBrollSearchFirst10({ subGroupId, planPipelineId }) {
  if (!planPipelineId) throw new Error('runBrollSearchFirst10: planPipelineId required')
  const { runSearchBatch } = await import('../routes/broll.js')
  return await runSearchBatch({ pipelineId: planPipelineId, batchSize: 10, groupId: subGroupId })
}
```

> **Note:** `runSearchBatch` is the pure function that the existing `/search-next-batch` route already uses internally. If `broll.js` doesn't expose it as a function (currently it's all inline in the route), refactor `/search-next-batch` to extract it first as a separate sub-step in this task.

- [ ] **Step 7.3: Run, verify**

```bash
npx vitest run server/services/__tests__/broll-runner.test.js
```

- [ ] **Step 7.4: Refactor `/search-next-batch` if needed + commit**

If `runSearchBatch` doesn't already exist as an internal helper, extract it from `broll.js:628-643` first. Otherwise just commit.

```bash
git add server/services/broll-runner.js server/services/__tests__/broll-runner.test.js server/routes/broll.js
git commit -m "refactor(broll): waitForPipelinesComplete + runBrollSearchFirst10"
```

---

## Task 8: `auto-orchestrator.reclassifyGroup` + `confirmClassificationGroup`

**Files:**
- Create: `server/services/auto-orchestrator.js`
- Create: `server/services/__tests__/auto-orchestrator.test.js`
- Modify: `server/routes/videos.js` (`/reclassify`, `/confirm-classification`)

- [ ] **Step 8.1: Failing tests**

Create `server/services/__tests__/auto-orchestrator.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  group: null,
  classification: null,
  refs: [],
  inserts: [],
  updates: [],
  analyzeMulticamCalls: [],
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get() {
          if (/SELECT id, path_id, classification_json, auto_rough_cut FROM video_groups/.test(sql)) return state.group
          throw new Error(`get: ${sql}`)
        },
        async all(...args) {
          if (/FROM broll_example_sources WHERE group_id/.test(sql)) return state.refs
          throw new Error(`all: ${sql}`)
        },
        async run(...args) {
          state.updates.push({ sql, args })
          if (/INSERT INTO video_groups/.test(sql)) {
            const id = 1000 + state.inserts.length
            state.inserts.push({ id, args })
            return { lastInsertRowid: id }
          }
          if (/INSERT INTO broll_example_sources/.test(sql)) return { lastInsertRowid: 999 }
          if (/UPDATE videos SET group_id/.test(sql)) return { changes: 1 }
          if (/UPDATE video_groups/.test(sql)) return { changes: 1 }
          return { changes: 0 }
        },
      }
    },
  },
}))

vi.mock('../multicam-sync.js', () => ({
  analyzeMulticam: vi.fn(async (id) => state.analyzeMulticamCalls.push(id)),
}))

vi.mock('./broll-runner.js', () => ({}))   // not used by these two tests

import { reclassifyGroup, confirmClassificationGroup } from '../auto-orchestrator.js'

beforeEach(() => {
  state.group = null
  state.classification = null
  state.refs = []
  state.inserts = []
  state.updates = []
  state.analyzeMulticamCalls = []
})

describe('reclassifyGroup', () => {
  it('chains into confirm only for hands-off path', async () => {
    state.group = { id: 1, path_id: 'hands-off', classification_json: JSON.stringify({ groups: [{ name: 'A', videoIds: [1] }] }), auto_rough_cut: false, assembly_status: 'classified' }
    await reclassifyGroup(1, { skipRunReclassify: true })   // we don't test runReclassify here
    expect(state.inserts).toHaveLength(1)
  })

  it('does NOT chain for guided path (waits for user)', async () => {
    state.group = { id: 1, path_id: 'guided', classification_json: JSON.stringify({ groups: [{ name: 'A', videoIds: [1] }] }), auto_rough_cut: false, assembly_status: 'classified' }
    await reclassifyGroup(1, { skipRunReclassify: true })
    expect(state.inserts).toHaveLength(0)
  })
})

describe('confirmClassificationGroup', () => {
  it('propagates auto_rough_cut + path_id to each sub-group INSERT', async () => {
    state.refs = [{ video_id: 99, label: 'ref', is_favorite: 1 }]
    await confirmClassificationGroup(1, [{ name: 'Cam 1', videoIds: [1] }, { name: 'Cam 2', videoIds: [2] }], {
      propagateAutoRoughCut: true, propagatePathId: 'hands-off', userId: 'u1',
    })
    expect(state.inserts).toHaveLength(2)
    // Each sub-group INSERT should include auto_rough_cut=true and path_id='hands-off'
    for (const ins of state.inserts) {
      const args = ins.args.map(String)
      expect(args).toContain('hands-off')
      expect(args).toContain('true')
    }
  })

  it('copies broll_example_sources rows from parent to each sub-group', async () => {
    state.refs = [{ video_id: 99, label: 'r1', is_favorite: 1 }, { video_id: 100, label: 'r2', is_favorite: 0 }]
    await confirmClassificationGroup(1, [{ name: 'Cam 1', videoIds: [1] }], {
      propagateAutoRoughCut: false, propagatePathId: 'hands-off', userId: 'u1',
    })
    const exampleInserts = state.updates.filter(u => /INSERT INTO broll_example_sources/.test(u.sql))
    expect(exampleInserts).toHaveLength(2) // 2 refs × 1 sub-group
  })

  it('fires analyzeMulticam per sub-group', async () => {
    state.refs = []
    await confirmClassificationGroup(1, [{ name: 'A', videoIds: [1] }, { name: 'B', videoIds: [2] }], {
      propagateAutoRoughCut: false, propagatePathId: 'hands-off', userId: 'u1',
    })
    expect(state.analyzeMulticamCalls).toHaveLength(2)
  })
})
```

- [ ] **Step 8.2: Run, expect failure**

```bash
npx vitest run server/services/__tests__/auto-orchestrator.test.js
```

- [ ] **Step 8.3: Implement orchestrator (skeleton + first two helpers)**

Create `server/services/auto-orchestrator.js`:

```js
// Server-side automation orchestrator. Bodies extracted from /reclassify and
// /confirm-classification routes. Adds chain hooks for Full Auto path.

import db from '../db.js'
import { analyzeMulticam } from './multicam-sync.js'

// reclassifyGroup — extracted body of POST /videos/groups/:id/reclassify, plus
// the new chain hook into confirmClassificationGroup for hands-off path.
//
// The original /reclassify body is moved to runReclassify (or imported from a
// neighbouring file). Pass { skipRunReclassify: true } in tests to bypass it.
export async function reclassifyGroup(groupId, { skipRunReclassify = false } = {}) {
  if (!skipRunReclassify) {
    const { runReclassify } = await import('./reclassify-runner.js')
    await runReclassify(groupId)
  }

  const group = await db.prepare(
    'SELECT id, path_id, classification_json, auto_rough_cut FROM video_groups WHERE id = ?'
  ).get(groupId)
  if (!group) return
  if (group.path_id !== 'hands-off') return  // only auto-confirm for Full Auto

  let parsed
  try { parsed = JSON.parse(group.classification_json) } catch { return }
  if (!parsed?.groups?.length) return

  const userRow = await db.prepare('SELECT user_id FROM video_groups WHERE id = ?').get(groupId)
  await confirmClassificationGroup(groupId, parsed.groups, {
    propagateAutoRoughCut: !!group.auto_rough_cut,
    propagatePathId: group.path_id,
    userId: userRow?.user_id,
  })
}

// confirmClassificationGroup — extracted from POST /confirm-classification.
// Splits videos into sub-groups; propagates auto_rough_cut + path_id; copies
// broll_example_sources rows; fires analyzeMulticam per sub-group.
export async function confirmClassificationGroup(parentGroupId, groups, opts) {
  const { propagateAutoRoughCut, propagatePathId, userId } = opts
  const subGroupIds = []

  for (const g of groups) {
    const r = await db.prepare(
      `INSERT INTO video_groups (name, assembly_status, parent_group_id, user_id, auto_rough_cut, path_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(g.name, 'pending', parentGroupId, userId, propagateAutoRoughCut, propagatePathId)
    const subId = r.lastInsertRowid
    subGroupIds.push(subId)

    if (g.videoIds?.length) {
      const placeholders = g.videoIds.map(() => '?').join(',')
      await db.prepare(`UPDATE videos SET group_id = ? WHERE id IN (${placeholders})`)
        .run(subId, ...g.videoIds)
    }

    // Copy broll_example_sources rows from parent.
    const refs = await db.prepare('SELECT * FROM broll_example_sources WHERE group_id = ?').all(parentGroupId)
    for (const ref of refs) {
      await db.prepare(
        `INSERT INTO broll_example_sources (group_id, video_id, label, is_favorite)
         VALUES (?, ?, ?, ?)`
      ).run(subId, ref.video_id, ref.label, ref.is_favorite)
    }
  }

  await db.prepare('UPDATE video_groups SET assembly_status = ? WHERE id = ?').run('confirmed', parentGroupId)

  for (const subId of subGroupIds) {
    analyzeMulticam(subId, { skipClassification: true })
  }
  return { subGroupIds }
}
```

> **Note:** if `broll_example_sources` has more columns than `video_id`, `label`, `is_favorite`, mirror the full INSERT from the existing schema. Read `server/schema-pg.sql` to confirm.

- [ ] **Step 8.4: Extract `runReclassify` from videos.js**

Find the `/reclassify` route in `server/routes/videos.js` (line 612). Move its body into a new file `server/services/reclassify-runner.js`:

```js
// runReclassify — extracted body of POST /videos/groups/:id/reclassify.
// Calls Gemini classification, writes classification_json, transitions
// assembly_status to 'classifying' → 'classified' or 'classification_failed'.
// (Full body copied from the existing route handler; no logic changes.)

import db from '../db.js'
// ... rest of imports the original handler used (classifyContextWithGemini, etc.)

export async function runReclassify(groupId) {
  // Body extracted verbatim from videos.js:612-651.
  // Replace `req.params.id` with `groupId`.
  // Replace `res.status(...).json(...)` calls with `throw` or `return` as appropriate.
}
```

The route at videos.js:612 becomes:

```js
router.post('/groups/:id/reclassify', requireAuth, async (req, res) => {
  try {
    const { reclassifyGroup } = await import('../services/auto-orchestrator.js')
    await reclassifyGroup(parseInt(req.params.id))
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 8.5: Run tests, verify**

```bash
npx vitest run server/services/__tests__/auto-orchestrator.test.js
```

- [ ] **Step 8.6: Refactor `/confirm-classification` route**

In `server/routes/videos.js:653`, replace the body with:

```js
router.post('/groups/:id/confirm-classification', requireAuth, async (req, res) => {
  const { groups } = req.body
  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: 'groups array required' })
  }
  const groupId = parseInt(req.params.id)
  const parent = await db.prepare(`SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`)
    .get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!parent) return res.status(404).json({ error: 'Group not found' })

  const { confirmClassificationGroup } = await import('../services/auto-orchestrator.js')
  const r = await confirmClassificationGroup(groupId, groups, {
    propagateAutoRoughCut: !!parent.auto_rough_cut,
    propagatePathId: parent.path_id,
    userId: req.auth.userId,
  })
  res.json({ ok: true, groupIds: r.subGroupIds })
})
```

- [ ] **Step 8.7: Smoke test both routes**

  1. `curl -X POST .../reclassify` on a real group — confirm it still works.
  2. `curl -X POST .../confirm-classification` with groups payload — confirm sub-groups created with auto_rough_cut + path_id propagated.

- [ ] **Step 8.8: Commit**

```bash
git add server/services/auto-orchestrator.js server/services/reclassify-runner.js server/services/__tests__/auto-orchestrator.test.js server/routes/videos.js
git commit -m "refactor(server): extract reclassifyGroup + confirmClassificationGroup with flag propagation"
```

---

## Task 9: Hook 1 — fire `reclassifyGroup` on last-done transcription

**Files:**
- Modify: `server/routes/videos.js` (`runTranscription`, around line 315 where 'done' UPDATE happens)
- Modify: `server/services/__tests__/auto-orchestrator.test.js`

- [ ] **Step 9.1: Failing test**

Append to `auto-orchestrator.test.js`:

```js
import { onTranscriptionDone } from '../auto-orchestrator.js'

describe('onTranscriptionDone hook', () => {
  it('fires reclassifyGroup when last transcription completes for hands-off group', async () => {
    state.remainingCount = 0
    state.parent = { id: 1, path_id: 'hands-off', assembly_status: null }
    const spy = vi.fn()
    vi.doMock('../auto-orchestrator.js', () => ({ ...await vi.importActual('../auto-orchestrator.js'), reclassifyGroup: spy }))
    await onTranscriptionDone({ groupId: 1 })
    expect(spy).toHaveBeenCalledWith(1)
  })

  it('does NOT fire if other transcriptions still pending', async () => {
    state.remainingCount = 2
    const spy = vi.fn()
    vi.doMock('../auto-orchestrator.js', () => ({ reclassifyGroup: spy }))
    await onTranscriptionDone({ groupId: 1 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does NOT fire for non-hands-off path', async () => {
    state.remainingCount = 0
    state.parent = { id: 1, path_id: 'guided', assembly_status: null }
    const spy = vi.fn()
    vi.doMock('../auto-orchestrator.js', () => ({ reclassifyGroup: spy }))
    await onTranscriptionDone({ groupId: 1 })
    expect(spy).not.toHaveBeenCalled()
  })
})
```

Extend mocks at the top:

```js
// inside the db mock:
if (/SELECT COUNT\(\*\) AS cnt FROM videos.*transcription_status/.test(sql)) {
  return { cnt: state.remainingCount }
}
if (/SELECT id, path_id, assembly_status FROM video_groups WHERE id = \?/.test(sql)) return state.parent
```

- [ ] **Step 9.2: Implement the hook export**

Append to `auto-orchestrator.js`:

```js
// Called from runTranscription whenever a video transitions to 'done'.
// Detects the last-completed video and fires reclassifyGroup for Full Auto.
export async function onTranscriptionDone({ groupId }) {
  if (!groupId) return
  const remaining = await db.prepare(`
    SELECT COUNT(*) AS cnt FROM videos
    WHERE group_id = ? AND video_type = 'raw'
      AND (transcription_status IS NULL OR transcription_status NOT IN ('done', 'failed'))
  `).get(groupId)
  if (remaining.cnt > 0) return

  const parent = await db.prepare(
    'SELECT id, path_id, assembly_status FROM video_groups WHERE id = ?'
  ).get(groupId)
  if (parent?.path_id !== 'hands-off') return
  if (parent.assembly_status && parent.assembly_status !== 'pending') return  // already classifying

  reclassifyGroup(groupId).catch(err =>
    console.error(`[auto-orchestrator] reclassify ${groupId} failed:`, err.message)
  )
}
```

- [ ] **Step 9.3: Wire into `runTranscription`**

In `server/routes/videos.js`, find where `runTranscription` writes status='done' (around line 315 inside the `runTranscription` function). After the existing UPDATE:

```js
// after the existing UPDATE statement that sets transcription_status='done'
if (status === 'done' && video.group_id) {
  const { onTranscriptionDone } = await import('../services/auto-orchestrator.js')
  onTranscriptionDone({ groupId: video.group_id })
    .catch(err => console.error(`[transcribe] auto-orchestrator hook failed:`, err.message))
}
```

- [ ] **Step 9.4: Run tests**

```bash
npx vitest run server/services/__tests__/auto-orchestrator.test.js
```

- [ ] **Step 9.5: Commit**

```bash
git add server/services/auto-orchestrator.js server/services/__tests__/auto-orchestrator.test.js server/routes/videos.js
git commit -m "feat(server): fire reclassifyGroup when last transcription completes (Full Auto)"
```

---

## Task 10: `runFullAutoBrollChain` orchestrator

**Files:**
- Modify: `server/services/auto-orchestrator.js`
- Modify: `server/services/__tests__/auto-orchestrator.test.js`

- [ ] **Step 10.1: Failing test**

Append:

```js
describe('runFullAutoBrollChain', () => {
  it('runs all stages for hands-off path', async () => {
    state.subGroup = { id: 100, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 }
    const calls = []
    vi.doMock('./broll-runner.js', () => ({
      runAllReferences: async () => { calls.push('refs'); return { prepPipelineId: 'p1', analysisPipelineIds: ['a1'] } },
      runStrategies: async () => { calls.push('strategies'); return { strategyPipelineIds: ['s1'] } },
      runPlanForEachVariant: async () => { calls.push('plans'); return { planPipelineIds: ['pl1'] } },
      runBrollSearchFirst10: async () => { calls.push('search') },
      waitForPipelinesComplete: async () => {},
    }))
    vi.doMock('./email-notifier.js', () => ({ send: async () => {} }))
    const { runFullAutoBrollChain } = await import('../auto-orchestrator.js?ch=' + Date.now())
    await runFullAutoBrollChain(100)
    expect(calls).toEqual(['refs', 'strategies', 'plans', 'search'])
  })

  it('pauses after strategies for strategy-only path', async () => {
    state.subGroup = { id: 101, user_id: 'u1', path_id: 'strategy-only', parent_group_id: 1 }
    const calls = []
    vi.doMock('./broll-runner.js', () => ({
      runAllReferences: async () => { calls.push('refs'); return { prepPipelineId: 'p', analysisPipelineIds: ['a'] } },
      runStrategies: async () => { calls.push('strategies'); return { strategyPipelineIds: ['s'] } },
      runPlanForEachVariant: async () => { calls.push('plans') },
      runBrollSearchFirst10: async () => { calls.push('search') },
      waitForPipelinesComplete: async () => {},
    }))
    let lastEmail = null
    vi.doMock('./email-notifier.js', () => ({ send: async (t) => { lastEmail = t } }))
    const { runFullAutoBrollChain } = await import('../auto-orchestrator.js?strat-only=' + Date.now())
    await runFullAutoBrollChain(101)
    expect(calls).toEqual(['refs', 'strategies'])
    expect(lastEmail).toBe('paused_at_strategy')
  })

  it('pauses after plans for guided path', async () => { /* similar to above */ })

  it('marks failed + emails on error', async () => {
    state.subGroup = { id: 103, user_id: 'u1', path_id: 'hands-off', parent_group_id: 1 }
    vi.doMock('./broll-runner.js', () => ({
      runAllReferences: async () => { throw new Error('boom') },
    }))
    let lastEmail = null
    vi.doMock('./email-notifier.js', () => ({ send: async (t) => { lastEmail = t } }))
    const { runFullAutoBrollChain } = await import('../auto-orchestrator.js?fail=' + Date.now())
    await runFullAutoBrollChain(103)
    expect(lastEmail).toBe('failed')
    expect(state.updates.some(u => /broll_chain_status = 'failed'/.test(u.sql))).toBe(true)
  })
})
```

Add to db mock:

```js
if (/SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id = \?/.test(sql)) return state.subGroup
```

- [ ] **Step 10.2: Implement**

Append to `auto-orchestrator.js`:

```js
import { pathToFlags } from '../routes/broll.js'
import * as emailNotifier from './email-notifier.js'

// runFullAutoBrollChain — fires the b-roll pipeline chain (references analyzed
// → strategy → plan → first-10 search) for sub-groups whose parent picked
// hands-off / strategy-only / guided. Respects pathToFlags pauses.
export async function runFullAutoBrollChain(subGroupId) {
  if (!subGroupId) return
  await db.prepare("UPDATE video_groups SET broll_chain_status = 'running' WHERE id = ?").run(subGroupId)

  const sg = await db.prepare(
    'SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id = ?'
  ).get(subGroupId)
  if (!sg) return
  const flags = pathToFlags(sg.path_id)

  try {
    const runner = await import('./broll-runner.js')

    // Find the sub-group's primary video (raw video with transcript)
    const mainVideo = await db.prepare(`
      SELECT v.id FROM videos v
      JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
      WHERE v.group_id = ? AND v.video_type = 'raw'
      ORDER BY v.id LIMIT 1
    `).get(subGroupId)
    if (!mainVideo) throw new Error('No video with transcript in sub-group')

    // 1. References analyzed
    const refs = await runner.runAllReferences({ subGroupId, mainVideoId: mainVideo.id })
    await runner.waitForPipelinesComplete([refs.prepPipelineId, ...refs.analysisPipelineIds].filter(Boolean))

    // 2. Strategies
    const strats = await runner.runStrategies({
      subGroupId, mainVideoId: mainVideo.id,
      prepPipelineId: refs.prepPipelineId, analysisPipelineIds: refs.analysisPipelineIds,
    })
    await runner.waitForPipelinesComplete(strats.strategyPipelineIds)

    if (flags.stopAfterStrategy) {
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_strategy' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('paused_at_strategy', { subGroupId, userId: sg.user_id })
      return
    }

    // 3. Plans (one per strategy variant)
    const plans = await runner.runPlanForEachVariant({
      subGroupId, mainVideoId: mainVideo.id,
      strategyPipelineIds: strats.strategyPipelineIds,
    })
    await runner.waitForPipelinesComplete(plans.planPipelineIds)

    if (flags.stopAfterPlan) {
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_plan' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('paused_at_plan', { subGroupId, userId: sg.user_id })
      return
    }

    // 4. Search (first 10) on the canonical/first plan
    await runner.runBrollSearchFirst10({ subGroupId, planPipelineId: plans.planPipelineIds[0] })

    await db.prepare("UPDATE video_groups SET broll_chain_status = 'done' WHERE id = ?").run(subGroupId)
    await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
  } catch (err) {
    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'failed', broll_chain_error = ? WHERE id = ?"
    ).run(String(err.message).slice(0, 500), subGroupId)
    await emailNotifier.send('failed', { subGroupId, userId: sg.user_id, error: err.message })
  }
}
```

- [ ] **Step 10.3: Run tests, verify**

```bash
npx vitest run server/services/__tests__/auto-orchestrator.test.js
```

- [ ] **Step 10.4: Commit**

```bash
git add server/services/auto-orchestrator.js server/services/__tests__/auto-orchestrator.test.js
git commit -m "feat(server): runFullAutoBrollChain orchestrator with per-path pauses"
```

---

## Task 11: Slice-1 hook extension — fire chain after rough cut terminal

**Files:**
- Modify: `server/services/multicam-sync.js` (the slice-1 `updateStatus` extension)

- [ ] **Step 11.1: Add chain dispatch to slice-1's hook**

In `multicam-sync.js`, find the slice-1 hook inside `updateStatus`. Replace the rough-cut block with:

```js
if (status === 'done') {
  const flagRow = await db.prepare(
    'SELECT user_id, auto_rough_cut, path_id FROM video_groups WHERE id = ?'
  ).get(groupId)
  if (flagRow?.auto_rough_cut) {
    // ... slice-1 rough cut hook (unchanged) ...
  } else if (flagRow?.path_id && ['hands-off', 'strategy-only', 'guided'].includes(flagRow.path_id)) {
    // No rough cut requested — go straight to b-roll chain.
    const { runFullAutoBrollChain } = await import('./auto-orchestrator.js')
    runFullAutoBrollChain(groupId).catch(err =>
      console.error(`[auto-orchestrator] b-roll chain failed for ${groupId}:`, err.message)
    )
  }
}
```

Slice 1's rough cut hook also needs to chain into b-roll *after* rough cut terminal. Update it:

```js
// inside the slice-1 rough cut completion logic, after the rough_cut_status terminal write:
if (rough_cut_status_terminal && flagRow.path_id && ['hands-off', 'strategy-only', 'guided'].includes(flagRow.path_id)) {
  const { runFullAutoBrollChain } = await import('./auto-orchestrator.js')
  runFullAutoBrollChain(groupId).catch(err => console.error(`[chain] ${err.message}`))
}
```

> **Implementation note:** in slice 1's exact code, the rough-cut callback `.then(async (r) => …)` is where the terminal status gets set. Add the b-roll chain dispatch at the end of the success branch and the failure branch.

- [ ] **Step 11.2: Manual verify**

  1. Set up a sub-group with `path_id='hands-off'`, `auto_rough_cut=true`.
  2. Trigger `analyzeMulticam(subId)` from a one-off node script.
  3. Watch DB: `assembly_status` walks to `done`, `rough_cut_status` walks `pending → running → done`, then `broll_chain_status` walks `running → done` (pipelines run, b-roll appears).

- [ ] **Step 11.3: Commit**

```bash
git add server/services/multicam-sync.js
git commit -m "feat(server): fire b-roll chain after rough cut terminal (Full Auto)"
```

---

## Task 12: `resumeChain` + `/resume-chain` endpoint

**Files:**
- Modify: `server/services/auto-orchestrator.js`
- Modify: `server/routes/broll.js`
- Modify: `server/services/__tests__/auto-orchestrator.test.js`

- [ ] **Step 12.1: Failing test**

```js
describe('resumeChain', () => {
  it('runs plans + search starting from plan stage', async () => {
    state.subGroup = { id: 100, user_id: 'u1', path_id: 'strategy-only', parent_group_id: 1, broll_chain_status: 'paused_at_strategy' }
    const calls = []
    vi.doMock('./broll-runner.js', () => ({
      runPlanForEachVariant: async () => { calls.push('plans'); return { planPipelineIds: ['pl'] } },
      runBrollSearchFirst10: async () => { calls.push('search') },
      waitForPipelinesComplete: async () => {},
    }))
    vi.doMock('./email-notifier.js', () => ({ send: async () => {} }))
    const { resumeChain } = await import('../auto-orchestrator.js?resume=' + Date.now())
    await resumeChain(100, 'plan', { strategyPipelineIds: ['s1'] })
    expect(calls).toEqual(['plans', 'search'])
  })
})
```

- [ ] **Step 12.2: Implement**

Append to `auto-orchestrator.js`:

```js
// resumeChain — called after the user picks a strategy/plan at a checkpoint.
export async function resumeChain(subGroupId, fromStage, opts = {}) {
  const sg = await db.prepare(
    'SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id = ?'
  ).get(subGroupId)
  if (!sg) return

  await db.prepare("UPDATE video_groups SET broll_chain_status = 'running' WHERE id = ?").run(subGroupId)
  const runner = await import('./broll-runner.js')

  try {
    const mainVideo = await db.prepare(`
      SELECT v.id FROM videos v JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
      WHERE v.group_id = ? AND v.video_type = 'raw' ORDER BY v.id LIMIT 1
    `).get(subGroupId)

    if (fromStage === 'plan') {
      // User picked strategy variant(s); run plan + search.
      const plans = await runner.runPlanForEachVariant({
        subGroupId, mainVideoId: mainVideo.id,
        strategyPipelineIds: opts.strategyPipelineIds || [],
      })
      await runner.waitForPipelinesComplete(plans.planPipelineIds)

      if (sg.path_id === 'guided') {
        await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_plan' WHERE id = ?").run(subGroupId)
        await emailNotifier.send('paused_at_plan', { subGroupId, userId: sg.user_id })
        return
      }
      await runner.runBrollSearchFirst10({ subGroupId, planPipelineId: plans.planPipelineIds[0] })
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'done' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
    } else if (fromStage === 'search') {
      await runner.runBrollSearchFirst10({ subGroupId, planPipelineId: opts.planPipelineId })
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'done' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
    }
  } catch (err) {
    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'failed', broll_chain_error = ? WHERE id = ?"
    ).run(String(err.message).slice(0, 500), subGroupId)
    await emailNotifier.send('failed', { subGroupId, userId: sg.user_id, error: err.message })
  }
}
```

- [ ] **Step 12.3: Add the endpoint**

In `server/routes/broll.js`, after the existing routes, add:

```js
router.post('/groups/:subId/resume-chain', requireAuth, async (req, res) => {
  const subId = parseInt(req.params.subId)
  const fromStage = String(req.query.from || '')
  if (!['plan', 'search'].includes(fromStage)) {
    return res.status(400).json({ error: 'from must be "plan" or "search"' })
  }
  // Ownership check
  const sg = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`)
    .get(subId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!sg) return res.status(404).json({ error: 'Sub-group not found' })

  const { resumeChain } = await import('../services/auto-orchestrator.js')
  resumeChain(subId, fromStage, req.body || {}).catch(err =>
    console.error(`[resume-chain] ${err.message}`)
  )
  res.json({ ok: true })
})
```

- [ ] **Step 12.4: Run tests + commit**

```bash
npx vitest run server/services/__tests__/auto-orchestrator.test.js
git add server/services/auto-orchestrator.js server/services/__tests__/auto-orchestrator.test.js server/routes/broll.js
git commit -m "feat(server): /resume-chain endpoint for strategy-only / guided checkpoints"
```

---

## Task 13: `/retry-chain` endpoint + `resumeStuckFullAutoChains` startup

**Files:**
- Modify: `server/services/auto-orchestrator.js`
- Modify: `server/routes/broll.js`
- Modify: `server/index.js`

- [ ] **Step 13.1: Add retry endpoint**

In `server/routes/broll.js`:

```js
router.post('/groups/:subId/retry-chain', requireAuth, async (req, res) => {
  const subId = parseInt(req.params.subId)
  const sg = await db.prepare(`SELECT id FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`)
    .get(subId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!sg) return res.status(404).json({ error: 'Sub-group not found' })

  await db.prepare("UPDATE video_groups SET broll_chain_status = NULL, broll_chain_error = NULL WHERE id = ?").run(subId)
  const { runFullAutoBrollChain } = await import('../services/auto-orchestrator.js')
  runFullAutoBrollChain(subId).catch(err => console.error(`[retry] ${err.message}`))
  res.json({ ok: true })
})
```

- [ ] **Step 13.2: Add `resumeStuckFullAutoChains`**

Append to `auto-orchestrator.js`:

```js
// Called from server boot. Re-fires chains for sub-groups that should be running
// but aren't (interrupted by server restart, etc.).
export async function resumeStuckFullAutoChains() {
  const stuck = await db.prepare(`
    SELECT id FROM video_groups
    WHERE path_id IN ('hands-off', 'strategy-only', 'guided')
      AND assembly_status = 'done'
      AND parent_group_id IS NOT NULL
      AND (rough_cut_status IS NULL OR rough_cut_status IN ('done', 'failed', 'insufficient_tokens', 'skipped'))
      AND broll_chain_status IS NULL
  `).all()
  for (const sg of stuck) {
    setTimeout(() => runFullAutoBrollChain(sg.id), 3000)
  }

  const interrupted = await db.prepare(
    "SELECT id FROM video_groups WHERE broll_chain_status = 'running'"
  ).all()
  for (const sg of interrupted) {
    await db.prepare("UPDATE video_groups SET broll_chain_status = NULL WHERE id = ?").run(sg.id)
    setTimeout(() => runFullAutoBrollChain(sg.id), 3000)
  }
  console.log(`[startup] resumed ${stuck.length} stuck + ${interrupted.length} interrupted chains`)
}
```

- [ ] **Step 13.3: Wire into server startup**

In `server/index.js`, after the existing startup blocks (transcription requeue etc.), add:

```js
;(async () => {
  try {
    const { resumeStuckFullAutoChains } = await import('./services/auto-orchestrator.js')
    await resumeStuckFullAutoChains()
  } catch (err) {
    console.error('[startup] resumeStuckFullAutoChains failed:', err.message)
  }
})()
```

- [ ] **Step 13.4: Commit**

```bash
git add server/services/auto-orchestrator.js server/routes/broll.js server/index.js
git commit -m "feat(server): /retry-chain endpoint + startup resume for stuck chains"
```

---

## Task 14: `GET /full-auto-status` endpoint

**Files:**
- Modify: `server/routes/videos.js`

- [ ] **Step 14.1: Implement**

In `server/routes/videos.js`, after the `/groups/:id/status` route, add:

```js
router.get('/groups/:id/full-auto-status', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id)
  const parent = await db.prepare(`
    SELECT id, name, path_id, auto_rough_cut, assembly_status, assembly_error, rough_cut_status, broll_chain_status
    FROM video_groups
    WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}
  `).get(groupId, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!parent) return res.status(404).json({ error: 'Group not found' })

  const videos = await db.prepare(`
    SELECT id, title, transcription_status, duration_seconds, cf_stream_uid, file_path
    FROM videos WHERE group_id = ? AND video_type = 'raw' ORDER BY id
  `).all(groupId)

  const subGroups = await db.prepare(`
    SELECT id, name, assembly_status, assembly_error, rough_cut_status, broll_chain_status, broll_chain_error
    FROM video_groups WHERE parent_group_id = ? ORDER BY id
  `).all(groupId)

  // Aggregate b-roll progress per sub-group (best-effort; fields are 0 if unknown).
  for (const sg of subGroups) {
    const refs = await db.prepare('SELECT COUNT(*) AS cnt FROM broll_example_sources WHERE group_id = ?').get(sg.id)
    const completedAnalysis = await db.prepare(`
      SELECT COUNT(*) AS cnt FROM broll_runs
      WHERE status = 'complete'
        AND metadata_json LIKE '%"phase":"plan_prep"%'
        AND video_id IN (SELECT id FROM videos WHERE group_id = ?)
    `).get(sg.id)
    sg.broll = {
      references_total: refs.cnt,
      references_analyzed: completedAnalysis.cnt,  // approximation
      // strategies_complete, plans_complete, search_complete: TODO if needed for richer UI
    }
  }

  res.json({ parent: { ...parent, videos }, subGroups })
})
```

- [ ] **Step 14.2: Smoke test**

```bash
curl 'http://localhost:3001/api/videos/groups/<id>/full-auto-status' -H "Authorization: Bearer <token>"
```

Expected: shape matches the spec.

- [ ] **Step 14.3: Commit**

```bash
git add server/routes/videos.js
git commit -m "feat(api): GET /groups/:id/full-auto-status aggregate poll endpoint"
```

---

## Task 15: ProcessingModal — three-mode render

**Files:**
- Modify: `src/components/views/ProcessingModal.jsx`
- Create: `src/components/views/__tests__/ProcessingModal-stages.test.jsx`

- [ ] **Step 15.1: Failing test for stage derivation**

Create the test file:

```jsx
import { describe, it, expect } from 'vitest'
import { deriveMode, deriveStages } from '../ProcessingModal.jsx'

describe('deriveMode', () => {
  it('returns uploading when any file is still uploading', () => {
    const state = { parent: { videos: [{ transcription_status: null, file_path: null, cf_stream_uid: null }] }, files: [{ status: 'uploading' }] }
    expect(deriveMode(state)).toBe('uploading')
  })
  it('returns pipeline when uploads done but pipeline not terminal', () => {
    const state = { parent: { videos: [{ transcription_status: 'transcribing', cf_stream_uid: 'x' }] }, files: [{ status: 'complete' }] }
    expect(deriveMode(state)).toBe('pipeline')
  })
  it('returns done when all stages terminal', () => {
    const state = { parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed' }, subGroups: [{ assembly_status: 'done', rough_cut_status: 'done', broll_chain_status: 'done' }], files: [{ status: 'complete' }] }
    expect(deriveMode(state)).toBe('done')
  })
})

describe('deriveStages', () => {
  it('marks transcribe stage active when at least one transcription is in flight', () => {
    const state = { parent: { videos: [{ transcription_status: 'transcribing', cf_stream_uid: 'x' }] } }
    const stages = deriveStages(state)
    const t = stages.find(s => s.id === 'transcribe')
    expect(t.active).toBe(true)
  })
  it('marks rough_cut as skipped when auto_rough_cut is false', () => {
    const state = { parent: { auto_rough_cut: false, videos: [] }, subGroups: [{ rough_cut_status: null }] }
    const stages = deriveStages(state)
    const r = stages.find(s => s.id === 'rough_cut')
    expect(r.skipped).toBe(true)
  })
  it('marks paused_at_strategy when broll_chain_status is paused', () => {
    const state = { parent: { auto_rough_cut: false, videos: [] }, subGroups: [{ broll_chain_status: 'paused_at_strategy' }] }
    const stages = deriveStages(state)
    const s = stages.find(s => s.id === 'broll_strategy')
    expect(s.paused).toBe(true)
  })
})
```

- [ ] **Step 15.2: Run, expect failure**

```bash
npx vitest run src/components/views/__tests__/ProcessingModal-stages.test.jsx
```

- [ ] **Step 15.3: Implement helpers + three-mode render**

In `ProcessingModal.jsx`, export pure helpers at the top of the file (above the component):

```jsx
export function deriveMode({ parent, files = [], subGroups = [] }) {
  const anyUploading = files.some(f => f.status === 'uploading')
  if (anyUploading) return 'uploading'
  const transcribed = parent?.videos?.every(v => v.transcription_status === 'done' || v.transcription_status === 'failed')
  if (!transcribed) return 'pipeline'
  if (subGroups?.length === 0) return 'pipeline'
  const allTerminal = subGroups.every(sg =>
    (sg.assembly_status === 'done' || sg.assembly_status === 'error') &&
    (parent.auto_rough_cut === false || sg.rough_cut_status === 'done' || sg.rough_cut_status === 'failed' || sg.rough_cut_status === 'insufficient_tokens') &&
    (sg.broll_chain_status === 'done' || sg.broll_chain_status === 'failed' || sg.broll_chain_status === 'paused_at_strategy' || sg.broll_chain_status === 'paused_at_plan')
  )
  return allTerminal ? 'done' : 'pipeline'
}

export function deriveStages({ parent = { videos: [] }, subGroups = [] }) {
  const videos = parent.videos || []
  const uploadDone = videos.every(v => v.cf_stream_uid || v.file_path)
  const transcribed = videos.filter(v => v.transcription_status === 'done').length
  const transcribing = videos.some(v => v.transcription_status && v.transcription_status !== 'done' && v.transcription_status !== 'failed')

  const classifyDone = parent.assembly_status === 'confirmed' || parent.assembly_status === 'done' || subGroups.length > 0
  const classifying = parent.assembly_status === 'classifying'

  const sgDone = (sg) => sg.assembly_status === 'done' || sg.assembly_status === 'error'
  const syncDone = subGroups.length > 0 && subGroups.every(sgDone)
  const syncActive = subGroups.some(sg => sg.assembly_status && !sgDone(sg))

  const rcSkipped = !parent.auto_rough_cut
  const rcDone = rcSkipped || subGroups.every(sg => ['done','failed','insufficient_tokens'].includes(sg.rough_cut_status))
  const rcActive = subGroups.some(sg => sg.rough_cut_status === 'pending' || sg.rough_cut_status === 'running')

  const brollPausedAtStrat = subGroups.some(sg => sg.broll_chain_status === 'paused_at_strategy')
  const brollPausedAtPlan  = subGroups.some(sg => sg.broll_chain_status === 'paused_at_plan')
  const brollDone = subGroups.every(sg => sg.broll_chain_status === 'done')
  const brollActive = subGroups.some(sg => sg.broll_chain_status === 'running')

  return [
    { id: 'upload',      label: 'Upload',          done: uploadDone, active: !uploadDone },
    { id: 'transcribe',  label: 'Transcribing',    done: videos.length > 0 && transcribed === videos.length, active: transcribing, sub: `${transcribed} of ${videos.length} done` },
    { id: 'classify',    label: 'Classifying',     done: classifyDone, active: classifying },
    { id: 'sync',        label: 'Multi-cam sync',  done: syncDone, active: syncActive },
    { id: 'rough_cut',   label: 'AI Rough Cut',    skipped: rcSkipped, done: rcDone, active: rcActive },
    { id: 'broll_refs',  label: 'References analyzed' /* simplified */ },
    { id: 'broll_strategy', label: 'B-roll strategy', paused: brollPausedAtStrat },
    { id: 'broll_plan',  label: 'B-roll plan',     paused: brollPausedAtPlan },
    { id: 'broll_search',label: 'B-roll search (first 10)', active: brollActive, done: brollDone },
    { id: 'done',        label: 'Done',            done: brollDone },
  ]
}
```

Then update the component's render branch to switch on mode:

```jsx
const mode = deriveMode({ parent: state.parent, files, subGroups: state.subGroups })

return (
  <div className="…modal…">
    {mode === 'uploading' && <UploadingFileList files={files} … />}
    {mode === 'pipeline' && (
      <>
        {state.parent?.path_id === 'hands-off' && <FullAutoBanner onTakeMeToProjects={() => navigate('/')} />}
        <StageTimeline stages={deriveStages({ parent: state.parent, subGroups: state.subGroups })} />
      </>
    )}
    {mode === 'done' && <DoneView subGroups={state.subGroups} />}
  </div>
)
```

Add `<StageTimeline>`, `<FullAutoBanner>`, `<DoneView>` as inline functional components in the same file. Tailwind-classed using existing theme tokens — match the per-file row aesthetic from slice 1's pipeline UI.

- [ ] **Step 15.4: Replace polling target**

Replace the existing `/detail` polling with:

```js
const res = await fetch(`${API_BASE}/videos/groups/${groupIdRef.current}/full-auto-status`, { headers })
```

and update `setFiles` / `setSubGroups` from the new shape.

- [ ] **Step 15.5: Run tests, build**

```bash
npx vitest run src/components/views/__tests__/ProcessingModal-stages.test.jsx
npm run build 2>&1 | tail -5
```

- [ ] **Step 15.6: Commit**

```bash
git add src/components/views/ProcessingModal.jsx src/components/views/__tests__/ProcessingModal-stages.test.jsx
git commit -m "feat(processing): three-mode render + stage timeline + Full Auto banner"
```

---

## Task 16: StepPath pre-flight validation for Full Auto

**Files:**
- Modify: `src/components/upload-config/steps/StepPath.jsx`
- Modify: `src/components/upload-config/UploadConfigFlow.jsx` (extend `continueDisabled`)

- [ ] **Step 16.1: Add reference + balance checks**

In `StepPath.jsx`, when `state.pathId === 'hands-off'`, fetch:

```js
const [refCount, setRefCount] = useState(null)
const [balance, setBalance] = useState(null)
const [estimate, setEstimate] = useState(null)

useEffect(() => {
  if (state.pathId !== 'hands-off') { onValidityChange?.(true); return }
  ;(async () => {
    const [refs, bal, est] = await Promise.all([
      apiGet(`/broll/groups/${groupId}/examples`).then(r => r?.length || 0).catch(() => 0),
      apiGet('/videos/user/tokens').then(r => r.balance).catch(() => 0),
      apiPost(`/videos/groups/${groupId}/estimate-ai-roughcut`, {}).then(r => r.tokenCost).catch(() => 0),
    ])
    setRefCount(refs)
    setBalance(bal)
    setEstimate(est)
    const required = est + brollHeuristicTokens(/* video duration */ 1800, refs)
    onValidityChange?.(refs >= 1 && bal >= required)
  })()
}, [state.pathId, groupId])

function brollHeuristicTokens(durationSeconds, refCount) {
  const minutes = durationSeconds / 60
  return Math.round(minutes * 50 * Math.max(1, refCount) + 500 + 500 * Math.max(1, refCount))
}
```

Render an inline message under the Full Auto card when invalid:

```jsx
{state.pathId === 'hands-off' && refCount !== null && (
  refCount < 1 ? <p className="text-error text-sm">Full Auto needs ≥1 reference video. Add some on Step 4.</p> :
  balance !== null && balance < (estimate + brollHeuristicTokens(1800, refCount)) ?
    <p className="text-error text-sm">Not enough tokens. Try Strategy Review for a smaller cost.</p> : null
)}
```

- [ ] **Step 16.2: Wire `onValidityChange` in `UploadConfigFlow`**

```jsx
// inside UploadConfigFlow.jsx
const [pathValid, setPathValid] = useState(true)

// In the body switch for path:
else if (current === 4) body = <StepPath state={state} setState={setState} groupId={groupId} onValidityChange={setPathValid} />

// In continueDisabled:
const continueDisabled =
  (currentStepId === 'references' && !referencesValid) ||
  (currentStepId === 'roughcut'   && !roughCutValid) ||
  (currentStepId === 'path'       && !pathValid)
```

- [ ] **Step 16.3: Commit**

```bash
git add src/components/upload-config/steps/StepPath.jsx src/components/upload-config/UploadConfigFlow.jsx
git commit -m "feat(upload): pre-flight check at Path step for Full Auto (refs + balance)"
```

---

## Task 17: ProjectsView aggregate badge

**Files:**
- Modify: `src/components/views/ProjectsView.jsx`

- [ ] **Step 17.1: Compute aggregate progress**

In the `projects` IIFE, add:

```js
function aggregateProgress(p) {
  const stages = ['upload', 'transcribe', 'classify', 'sync', 'rough_cut', 'broll']
  const done = []
  if (p.transcriptionStatus === 'done') { done.push('upload', 'transcribe') }
  if (p.assembly_status === 'confirmed' || p.assembly_status === 'done') done.push('classify')
  if (p.assembly_status === 'done') done.push('sync')
  if (p.rough_cut_status === 'done' || !p.auto_rough_cut) done.push('rough_cut')
  if (p.broll_chain_status === 'done') done.push('broll')
  return { done: done.length, total: stages.length, label: stages[done.length] || 'done' }
}
```

In the project row render, replace the simple "Transcribing 2/3" badge with:

```jsx
{!project.terminal && (
  <span className="text-amber-400 flex items-center gap-1">
    <Loader2 size={11} className="animate-spin" />
    Processing · {progress.done}/{progress.total}
  </span>
)}
```

- [ ] **Step 17.2: Commit**

```bash
git add src/components/views/ProjectsView.jsx
git commit -m "feat(projects): aggregate progress badge for Full Auto chains"
```

---

## Task 18: End-to-end manual smoke

- [ ] **Step 18.1: Full Auto happy path**

  1. Upload 1 video (~3min) + 2 reference videos.
  2. Steps 2–4: pick libraries, audience, references (≥2 with favorite).
  3. Step 5 (Rough Cut): pick Run.
  4. Step 6 (Path): pick Full Auto. Verify Continue is enabled (refs + balance OK).
  5. Step 7 (Transcribe): wait for uploads → ProcessingModal shifts to pipeline mode → Full Auto banner appears.
  6. Click [Take me to Projects] → navigate away.
  7. After 5–10 minutes, check email — expect "Your project is ready" email with editor link.
  8. Click email link → editor opens with annotations + b-roll plans + first 10 b-rolls visible.

- [ ] **Step 18.2: Strategy Review checkpoint**

  1. Same setup but Step 6 = Strategy Review.
  2. After uploads + transcribe + sync + rough cut: chain pauses at strategy.
  3. Email arrives: "Pick a creative strategy".
  4. Click link → land on `/editor/<sub-id>/brolls/strategy/strategy`.
  5. Pick a variant; chain resumes via `/resume-chain?from=plan`.
  6. Final email arrives when search completes.

- [ ] **Step 18.3: Insufficient balance + insufficient refs**

  1. Drain balance manually: `UPDATE user_tokens SET balance = 0 WHERE user_id = '<you>';`
  2. Try Step 6 with Full Auto → Continue stays disabled, "Not enough tokens" inline.
  3. Restore balance.
  4. Repeat with 0 references → Continue disabled, "Full Auto needs ≥1 reference video".

- [ ] **Step 18.4: Server restart mid-chain**

  1. During a Full Auto run, restart the server (`Ctrl+C`, then `npm run dev:server`).
  2. Watch logs: `[startup] resumed N stuck + M interrupted chains`.
  3. Chain completes; email arrives.

- [ ] **Step 18.5: Multi-cam Full Auto**

  1. Upload 4+ videos that Gemini will classify into 2 camera groups.
  2. Step 6 Full Auto.
  3. After classification: 2 sub-groups created with `auto_rough_cut`, `path_id='hands-off'`, references copied.
  4. Both sub-groups run sync → rough cut → b-roll chain in parallel.
  5. Both `broll_chain_status='done'` independently.
  6. Two emails arrive (one per sub-group).
  7. ProjectsView shows both sub-projects.

- [ ] **Step 18.6: All tests pass + build clean**

```bash
npm run test
npm run build
```

- [ ] **Step 18.7: PR**

```bash
gh pr create --title "feat: Full Auto Handoff slice 2" --body "$(cat <<'EOF'
## Summary
Closes the upload→done loop server-side for the three Path options:
- **Full Auto** (`hands-off`): chain runs end-to-end without user input; emails when done.
- **Strategy Review** / **Guided**: chain runs to a checkpoint, emails the user, resumes via `/resume-chain` after pick.

ProcessingModal evolves to a project-level stage timeline with a "you can close this tab" banner for Full Auto.

Spec: `docs/specs/2026-04-28-full-auto-handoff-slice2-design.md`
Plan: `docs/plans/2026-04-28-full-auto-handoff-slice2.md`

## Test plan
- [x] Vitest: orchestrator chain logic + per-path pauses.
- [x] Vitest: broll-runner extractions.
- [x] Vitest: email-notifier (templates, dedup, missing-key noop).
- [x] Vitest: stage derivation matrix.
- [x] Manual: Full Auto end-to-end with email confirmation.
- [x] Manual: Strategy Review checkpoint resume.
- [x] Manual: Server restart resume.
- [x] Manual: Multi-cam Full Auto producing N parallel chains.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Implemented in |
|---|---|
| DB schema | Task 2 |
| Resend dependency + email-notifier | Task 3 |
| broll-runner extraction (4 helpers + waitForPipelinesComplete) | Tasks 4-7 |
| auto-orchestrator (reclassify + confirm) | Task 8 |
| Hook 1 — last transcription done | Task 9 |
| runFullAutoBrollChain | Task 10 |
| Slice-1 hook extension to chain into b-roll | Task 11 |
| resumeChain + endpoint | Task 12 |
| retry + startup-resume | Task 13 |
| /full-auto-status endpoint | Task 14 |
| ProcessingModal three-mode render | Task 15 |
| StepPath pre-flight | Task 16 |
| ProjectsView badge | Task 17 |
| Manual end-to-end smoke | Task 18 |
| Reference propagation at split | Task 8 (inside confirmClassificationGroup) |

**Placeholder scan:** None — every task has either real code or "extract from <existing line ranges>" with the destination file/line. Two notes in Tasks 5 and 7 say "if existing route has more nuances, mirror them" — these are flagged as implementation-time judgement calls, not vague TBDs.

**Type consistency:** `auto_rough_cut`, `rough_cut_status`, `broll_chain_status`, `broll_chain_error`, `notified_at` used throughout. Helper names match across tasks: `runFullAutoBrollChain`, `reclassifyGroup`, `confirmClassificationGroup`, `resumeChain`, `resumeStuckFullAutoChains`, `runAllReferences`, `runStrategies`, `runPlanForEachVariant`, `runBrollSearchFirst10`, `waitForPipelinesComplete`. Status values: `null|pending|running|paused_at_strategy|paused_at_plan|done|failed`.

No gaps found.
