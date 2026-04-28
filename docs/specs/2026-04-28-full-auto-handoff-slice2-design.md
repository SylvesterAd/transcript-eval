# Full Auto Handoff — Slice 2 (Server-side Chain + ProcessingModal Evolution + Email) — Design

**Date**: 2026-04-28
**Branch target**: `feature/full-auto-handoff-slice2` (git worktree)
**Source design**: `~/Downloads/Adpunk (2)/` (HTML + JSX mockups)
**Parent feature**: Upload-time selection of "Auto Rough Cut + Path-based automation"
**This slice**: After upload bytes are done, the user can close the tab. Server runs the entire chain (transcribe → classify → confirm-split → multi-cam sync → optional rough cut → b-roll references → strategy → plan → first-10 search) end-to-end and emails the user when their project is ready (or when their attention is needed at a checkpoint).
**Depends on**: Slice 1 (`docs/specs/2026-04-28-auto-rough-cut-slice1-design.md`) — reuses `runAiRoughCut`, `rough_cut_status`, slice 1 hooks at `analyzeMulticam` completion.

## Scope

### In scope

- A server-side **auto-orchestrator** that fires the full pipeline chain when `path_id='hands-off'` and respects checkpoints for `strategy-only` and `guided`.
- Reusable runners extracted from existing route handlers (mirrors slice 1's `runAiRoughCut` extraction).
- New `ProcessingModal` render mode: a project-level **stage timeline** that polls aggregate `/full-auto-status`. Replaces the per-file pipeline view once uploads complete. File-level rows still drive the upload phase.
- A "you can close this tab" banner on `ProcessingModal` for Full Auto users.
- Reference propagation at split: `broll_example_sources` rows are copied from parent to each sub-group at `/confirm-classification`.
- Pre-flight checks at Step 6 (Path) for Full Auto: ≥1 reference video + sufficient token balance for the combined estimate.
- New schema: `broll_chain_status`, `broll_chain_error`, `notified_at` on `video_groups`.
- New endpoint `GET /videos/groups/:id/full-auto-status` — single aggregate poll target for the modal.
- New endpoint `POST /broll/groups/:subId/resume-chain?from={plan|search}` — used after `strategy-only` / `guided` checkpoints.
- New endpoint `POST /broll/groups/:subId/retry-chain` — manual retry on failure.
- Resume-after-server-restart hook for chains stuck mid-flight.
- **Email-when-done** via Resend. Triggered per sub-group at terminal completion and at every pause checkpoint for non-Full-Auto paths. Failure-path emails dispatched on chain failure.
- ProjectsView aggregate progress badge (`Processing · 4 / 10 stages`).
- Full Auto behavior across all three paths: `hands-off`, `strategy-only`, `guided`.

### Out of scope (will not be done in this slice)

- Cancel + refund mid-chain.
- Per-stage time-remaining ETAs (elapsed only).
- Changes to `analyzeMulticam` internals.
- Changes to BRollPanel UI.

## Background

Slice 1 added a `Rough Cut` step at index 5 of the upload-config flow and a server-side trigger that runs `runAiRoughCut` whenever a sub-group hits `assembly_status='done'`.

Slice 2 builds on that foundation. The user's mental model after they pick "Full Auto" on Step 6 (Path) is: "I'm done. Take my files and email me when it's ready." Today the user has to:
1. Sit through transcription on `ProcessingModal`.
2. Click "Continue" → land on `AssetsView`.
3. Click "Confirm & Start Sync" (multi-cam) or wait for solo auto-confirm.
4. Wait through `SyncingScreen` per sub-group.
5. Manually navigate to BRollPanel.
6. Click "Run All", then "Run Strategies", then "Run Plan", then "Search".

Slice 2 collapses (2)–(6) into a server-side chain that runs while the user is offline and emails them when terminal states are reached.

The b-roll endpoints already exist in `server/routes/broll.js` (verified):
- `POST /broll/pipeline/run-all` — prep + reference analysis (parallel one-per-reference).
- `POST /broll/pipeline/run-strategies` — strategy generation (parallel one-per-analysis).
- `POST /broll/pipeline/run-plan` — plan generation per strategy variant.
- `POST /broll/pipeline/:pipelineId/run-broll-search` — first-batch search.
- `POST /broll/pipeline/search-next-batch` — search batch (10 placements at a time).

`pathToFlags` ([server/routes/broll.js:68](server/routes/broll.js:68)) already maps `hands-off → autoSelectVariants: true` and stop-flags off; `strategy-only` and `guided` map to the appropriate stop points. The orchestrator just calls these endpoints in sequence.

## Source design pointers

- `~/Downloads/Adpunk (2)/Path step — Full Auto card` — subtitle: "Start now, email when b-roll is ready".
- `~/Downloads/Adpunk (2)/Processing.html` — the visual target for the new pipeline-mode timeline (we'll Tailwind-translate but match the structure).
- BRollPanel at `/editor/<id>/brolls/strategy/{analysis|strategy|plan}` — visual reference for what each pipeline stage produces (the orchestrator mirrors the click sequence).

## DB schema

Three new columns on `video_groups`. Slice 1's columns (`auto_rough_cut`, `rough_cut_status`, `rough_cut_error_required`) remain.

```sql
ALTER TABLE video_groups
  ADD COLUMN IF NOT EXISTS broll_chain_status TEXT,    -- null|pending|running|paused_at_strategy|paused_at_plan|done|failed
  ADD COLUMN IF NOT EXISTS broll_chain_error  TEXT,    -- error message when status='failed'
  ADD COLUMN IF NOT EXISTS notified_at        TIMESTAMP; -- last email dispatch time (dedup guard)
```

Idempotent migration script at `server/seed/migrate-broll-chain.js`.

## Server-side chain

### File layout

```
server/services/
  auto-orchestrator.js         # NEW — chain orchestrator + reclassify/confirm helpers
  broll-runner.js              # NEW — extracted runners for run-all, run-strategies, run-plan, search
  email-notifier.js            # NEW — Resend wrapper, template registry
```

### Orchestrator entry points

```js
// server/services/auto-orchestrator.js
//
// Public entry points:
//   - reclassifyGroup(groupId)                         // hooks Hook 1 (transcription done)
//   - confirmClassificationGroup(parentId, groups)     // splits + propagates flags
//   - runFullAutoBrollChain(subGroupId)                // hooks Hook 3 (rough cut terminal)
//   - resumeChain(subGroupId, fromStage)               // strategy-only / guided checkpoint resumption
//   - resumeStuckFullAutoChains()                      // startup-resume

export async function reclassifyGroup(groupId) { … }
export async function confirmClassificationGroup(parentId, groups, opts) { … }
export async function runFullAutoBrollChain(subGroupId) { … }
export async function resumeChain(subGroupId, fromStage) { … }
export async function resumeStuckFullAutoChains() { … }
```

### Chain hooks (where each step's completion fires the next)

| # | Hook site | Condition | Action |
|---|---|---|---|
| 1 | `runTranscription` (`server/routes/videos.js:210`) at the existing `transcription_status='done'` UPDATE | All raw videos in the group have `transcription_status` ∈ {done, failed} AND `path_id='hands-off'` AND `assembly_status` is null/pending (no prior reclassify) | `reclassifyGroup(groupId)` (fire-and-forget) |
| 2 | End of `reclassifyGroup` | Local `path_id='hands-off'` AND `assembly_status='classified'` | `confirmClassificationGroup(parentId, groups, { propagateAutoRoughCut, propagatePathId, propagateReferences })` |
| 3 | `analyzeMulticam.updateStatus` (slice 1 hook extended) on per-sub-group `assembly_status='done'` | Slice 1: fires `runAiRoughCut` if `auto_rough_cut`. Slice 2 chain extension: continues to b-roll chain after rough cut terminal. | Slice 1 unchanged. After `rough_cut_status` reaches terminal (done/skipped/failed/insufficient_tokens), if sub-group's `path_id='hands-off' \| 'strategy-only' \| 'guided'`, fire `runFullAutoBrollChain(subGroupId)`. |
| 4 | Pipeline completion polls inside `runFullAutoBrollChain` | Each stage's pipelines reach `complete` | Advance to next stage; or pause at checkpoint per `pathToFlags`; or terminal `done`. |
| 5 | `runFullAutoBrollChain` terminal | `broll_chain_status` ∈ {done, failed, paused_at_*} | Email dispatch via `email-notifier.send(...)` with the template matching the terminal state. |

### `runFullAutoBrollChain(subGroupId)` body

```js
async function runFullAutoBrollChain(subGroupId) {
  // 0. Mark started.
  await db.prepare("UPDATE video_groups SET broll_chain_status = 'running' WHERE id = ?").run(subGroupId)

  const sg = await db.prepare('SELECT id, user_id, path_id, parent_group_id FROM video_groups WHERE id = ?').get(subGroupId)
  const flags = pathToFlags(sg.path_id)  // existing helper, slice-2 imports it

  try {
    // 1. References analyzed — same as BRollPanel's "Run All" button.
    //    Wait until prep + every per-reference analysis pipeline reaches 'complete'.
    const { prepPipelineId, analysisPipelineIds } = await runAllReferences(subGroupId)
    await waitForPipelinesComplete([prepPipelineId, ...analysisPipelineIds])

    // 2. Strategies — generates one variant per analysis pipeline.
    const strategyPipelineIds = await runStrategies(subGroupId, prepPipelineId, analysisPipelineIds)
    await waitForPipelinesComplete(strategyPipelineIds)

    // strategy-only / guided: pause for user pick.
    if (flags.stopAfterStrategy) {
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_strategy' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('paused_at_strategy', { subGroupId, userId: sg.user_id })
      return
    }

    // 3. Plans — Full Auto selects ALL strategy variants. Run a plan per variant.
    const planPipelineIds = await runPlanForEachVariant(subGroupId, strategyPipelineIds)
    await waitForPipelinesComplete(planPipelineIds)

    // guided: pause for user plan pick.
    if (flags.stopAfterPlan) {
      await db.prepare("UPDATE video_groups SET broll_chain_status = 'paused_at_plan' WHERE id = ?").run(subGroupId)
      await emailNotifier.send('paused_at_plan', { subGroupId, userId: sg.user_id })
      return
    }

    // 4. B-roll search — first 10 placements (canonical first plan; matches today's UX).
    await runBrollSearchFirst10(subGroupId, planPipelineIds[0])

    // Terminal.
    await db.prepare("UPDATE video_groups SET broll_chain_status = 'done', notified_at = NOW() WHERE id = ?").run(subGroupId)
    await emailNotifier.send('done', { subGroupId, userId: sg.user_id })
  } catch (err) {
    await db.prepare("UPDATE video_groups SET broll_chain_status = 'failed', broll_chain_error = ? WHERE id = ?").run(String(err.message).slice(0, 500), subGroupId)
    await emailNotifier.send('failed', { subGroupId, userId: sg.user_id, error: err.message })
  }
}
```

### `resumeChain(subGroupId, fromStage)`

Called from a new endpoint after the user reviews at a checkpoint:

- `fromStage='plan'`: read selected variant ID from request, run plan + search.
- `fromStage='search'`: run search only.

The endpoint ensures `broll_chain_status` is currently `paused_at_strategy` or `paused_at_plan` and the request originates from the project owner.

### `runAllReferences`, `runStrategies`, `runPlanForEachVariant`, `runBrollSearchFirst10`

Each is a thin wrapper extracted from the existing route handler. Pattern (mirrors slice 1's `runAiRoughCut`):

```js
// server/services/broll-runner.js
export async function runAllReferences(subGroupId) {
  // Body extracted from POST /broll/pipeline/run-all (broll.js:927).
  // Returns { prepPipelineId, analysisPipelineIds }.
}
export async function runStrategies(subGroupId, prepPipelineId, analysisPipelineIds) {
  // Body extracted from POST /broll/pipeline/run-strategies (broll.js:1032).
  // Returns array of strategy pipeline IDs.
}
export async function runPlanForEachVariant(subGroupId, strategyPipelineIds) {
  // For each strategy pipeline, call body extracted from POST /broll/pipeline/run-plan (broll.js:1155).
  // Returns array of plan pipeline IDs.
}
export async function runBrollSearchFirst10(subGroupId, planPipelineId) {
  // Body extracted from POST /broll/pipeline/search-next-batch (broll.js:628), batch=10.
}
export async function waitForPipelinesComplete(pipelineIds, { maxWaitMs = 60 * 60 * 1000 } = {}) {
  // Polls brollPipelineProgress (existing in-memory Map) + broll_runs table.
  // Resolves when all complete; rejects on first failed; rejects on timeout.
}
```

The original routes (`/run-all`, `/run-strategies`, `/run-plan`, `/run-broll-search`, `/search-next-batch`) become 1-line wrappers calling these helpers — manual paths preserved.

### Reference propagation at `/confirm-classification`

`broll_example_sources` rows reference `group_id` (parent today). At split time we copy each row into N copies, one per sub-group:

```js
// inside confirmClassificationGroup, after each sub-group INSERT:
const refs = await db.prepare('SELECT * FROM broll_example_sources WHERE group_id = ?').all(parentId)
for (const r of refs) {
  await db.prepare(
    'INSERT INTO broll_example_sources (group_id, video_id, label, is_favorite, ...) VALUES (?, ?, ?, ?, ...)'
  ).run(subGroupId, r.video_id, r.label, r.is_favorite, ...)
}
```

(Exact column list resolved during implementation — schema-pg.sql is authoritative.)

### Resume-after-server-restart

Mirrors slice-1 / `runTranscription`'s startup re-queue. On boot:

```js
// server/services/auto-orchestrator.js
export async function resumeStuckFullAutoChains() {
  // Sub-groups where all preconditions are met but chain didn't fire.
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
  // Sub-groups where chain was 'running' but server restarted.
  const interrupted = await db.prepare(`
    SELECT id FROM video_groups WHERE broll_chain_status = 'running'
  `).all()
  for (const sg of interrupted) {
    await db.prepare("UPDATE video_groups SET broll_chain_status = NULL WHERE id = ?").run(sg.id)
    setTimeout(() => runFullAutoBrollChain(sg.id), 3000)
  }
}
```

Called from `server/index.js` startup.

## Email — `email-notifier.js`

Provider: **Resend** (`npm i resend`). Free tier: 3,000 emails/mo, 100/day. Single env var `RESEND_API_KEY`. From address: `Adpunk <noreply@adpunk.ai>` (domain DNS to be configured separately as part of slice 2 PR).

```js
// server/services/email-notifier.js
import { Resend } from 'resend'
import db from '../db.js'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const FROM = 'Adpunk <noreply@adpunk.ai>'

const TEMPLATES = {
  done: ({ projectName, editorUrl }) => ({
    subject: `Your project "${projectName}" is ready`,
    html: `<p>We've finished processing your project. Open it in the editor to review.</p><p><a href="${editorUrl}">Open project →</a></p>`,
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
    html: `<p>We hit an error processing your project: ${error}.</p><p><a href="${editorUrl}">Open project to retry →</a></p>`,
  }),
}

export async function send(template, { subGroupId, userId, error }) {
  if (!resend) {
    console.log(`[email] RESEND_API_KEY not set — skipping ${template} for sub-group ${subGroupId}`)
    return
  }
  // dedup: don't re-email the same terminal state within 5 minutes
  const recent = await db.prepare(
    "SELECT notified_at FROM video_groups WHERE id = ? AND notified_at > NOW() - INTERVAL '5 minutes'"
  ).get(subGroupId)
  if (recent?.notified_at) return

  const sg = await db.prepare('SELECT id, name FROM video_groups WHERE id = ?').get(subGroupId)
  const user = await db.prepare('SELECT email FROM auth.users WHERE id = ?').get(userId)
  if (!user?.email) return

  const editorUrl = `${process.env.PUBLIC_FRONTEND_URL || 'https://transcript-eval-sylvesterads-projects.vercel.app'}/editor/${subGroupId}/sync`
  const tpl = TEMPLATES[template]({ projectName: sg.name, editorUrl, error })

  await resend.emails.send({ from: FROM, to: user.email, subject: tpl.subject, html: tpl.html })
  await db.prepare('UPDATE video_groups SET notified_at = NOW() WHERE id = ?').run(subGroupId)
}
```

Email dispatch is fire-and-forget from the orchestrator; failures logged, never throw out of `send()`.

DNS / domain setup (Resend dashboard, manual operation, not part of code):
1. Add `adpunk.ai` to Resend domains.
2. Add the SPF + DKIM TXT records to the DNS provider.
3. Confirm domain status = "Verified" before merging slice 2 to main.

If DNS isn't ready by merge, we set `RESEND_API_KEY=''` on Railway — the notifier no-ops; chain still runs to completion. Email shipped behind a flag.

## Frontend — `ProcessingModal` evolution

### Render modes

```jsx
// Three modes, computed from /full-auto-status payload:
function deriveMode(state) {
  if (state.parent.videos.some(v => v.upload_status === 'uploading')) return 'uploading'
  if (anyTerminal(state)) return 'done'
  return 'pipeline'
}
```

- `uploading` — existing per-file rows with progress bar / speed / ETA. Unchanged from slice 1.
- `pipeline` — new project-level **stage timeline**.
- `done` — terminal state with link(s) to project(s).

### Stage timeline rows (pipeline mode)

Each row: icon (pending/active/done/failed/skipped/paused) + label + sub-text (counts and elapsed):

```
✓ Upload          —  3 files · 234 MB
✓ Transcribing    —  3 of 3 done
✓ Classifying     —  split into 2 cams
◉ Multi-cam sync  —  1 of 2 done · 1 active (3m 42s)
○ AI Rough Cut    —  pending
○ References analyzed
○ B-roll strategy
○ B-roll plan
○ B-roll search (first 10)
○ Done            —  pending
```

Sub-group fan-out collapsed into "X of N" summaries at every stage that operates per-sub-group. Per-sub-group expandable detail (click row → expand) is a polish item not blocking slice 2.

For checkpoint paths (`strategy-only`, `guided`), the row that triggers the pause shows a `paused` state with a button: "Open project to pick". Clicking navigates to `/editor/<sub-id>/brolls/strategy/strategy` (or `/plan` for plan checkpoint). After the user picks and the orchestrator resumes via `/resume-chain`, the row transitions back to `active`.

### Full Auto banner

Pinned above the stage timeline when `path_id='hands-off'` and mode === `pipeline`:

> 📩 You can close this tab — we'll keep processing and email you when it's ready. Open Projects to check back later.

Two buttons: **[Take me to Projects]** → `/`, **[Stay here]** → dismiss banner (non-persistent).

### Done state

- **Single sub-group**: "Open project" button → `/editor/<id>/sync`.
- **Multiple sub-groups**: "We split your footage into N projects" + N buttons "Open '<name>'" + "View all in Projects".

### Polling

`ProcessingModal` polls `GET /videos/groups/:id/full-auto-status` every 2 s in `pipeline` mode, every 1 s in `uploading` mode, never in `done` mode.

```jsonc
{
  "parent": {
    "id": 238,
    "name": "Project 28/04/2026",
    "path_id": "hands-off",
    "auto_rough_cut": true,
    "assembly_status": "confirmed",
    "videos": [
      { "id": 387, "transcription_status": "done", "duration_seconds": 240 },
      { "id": 388, "transcription_status": "done", "duration_seconds": 180 },
      { "id": 389, "transcription_status": "done", "duration_seconds": 2405 }
    ]
  },
  "subGroups": [
    {
      "id": 240, "name": "Cam 1",
      "assembly_status": "syncing",
      "rough_cut_status": null,
      "broll": {
        "chain_status": null,
        "references_analyzed": 0, "references_total": 3,
        "strategies_complete": 0, "strategies_total": 0,
        "plans_complete": 0, "plans_total": 0,
        "search_complete": false
      }
    },
    { "id": 241, "name": "Cam 2", "assembly_status": "pending", "rough_cut_status": null, "broll": {…} }
  ]
}
```

The endpoint constructs this from existing tables: `videos`, `video_groups` (parent + sub-groups via `parent_group_id`), `broll_runs` aggregation, `broll_searches`.

## Frontend — Step 6 (Path) pre-flight

`StepPath.jsx` extends to validate Full Auto preconditions when the user taps the `hands-off` card:

```js
useEffect(() => {
  if (state.pathId !== 'hands-off') { onValidityChange(true); return }
  // Validate references >= 1
  fetchReferenceCount(groupId).then(count => {
    setRefCount(count)
    onValidityChange(count >= 1 && balance >= combinedEstimate)
  })
}, [state.pathId, groupId, balance, combinedEstimate])
```

Combined estimate = slice 1's rough-cut estimate (only if `auto_rough_cut=true`) + b-roll heuristic. Heuristic for b-roll:

```js
function brollHeuristicTokens(durationSeconds, refCount) {
  // ~50 tokens / minute of main video × refCount (one analysis per ref) +
  //  ~500 tokens for strategy + ~500 per plan + 0 for search (no LLM).
  const minutes = durationSeconds / 60
  return Math.round(minutes * 50 * Math.max(1, refCount) + 500 + 500 * Math.max(1, refCount))
}
```

When validation fails, an inline message under the Full Auto card: "Full Auto needs ≥1 reference video and N more tokens. Try Strategy Review instead?" Continue button stays disabled if Full Auto is selected and invalid.

## Frontend — ProjectsView aggregate badge

For each parent group, replace the simple transcription-status badge with a richer one:

```js
function aggregateProgress(parent, subGroups) {
  // Returns { stage: '4/10', label: 'Multi-cam sync', failed: false }
  // or { done: true } when terminal.
}
```

Polling: existing `GET /videos` already returns enough data to compute this client-side once `auto_rough_cut`, `path_id`, and sub-group counts are exposed (slice 1 already added the first; slice 2 ensures the join also pulls sub-group rows).

## What does NOT change

- Slice 1's `runAiRoughCut` and `rough_cut_status` polling — same code paths.
- `analyzeMulticam` internals (only `updateStatus` extends to also fire b-roll chain after rough-cut terminal — slice 1 already extended it once, slice 2 adds one more conditional inside the same hook).
- BRollPanel UI for manual flows — `pathToFlags` already drives stop points; the manual path keeps using the same buttons.
- Existing `/start-ai-roughcut` handler (slice 1 made it a thin wrapper).
- Existing transcription / classification routes — they get internal helper extracted but HTTP behaviour unchanged.

## Failure modes

| Failure | Surfaces as | User recovery |
|---|---|---|
| Transcription failed for 1 of N files | Stage timeline "X of N done · 1 failed". Per-file retry button on the failed row. | Click retry; chain resumes once that video transitions to `done`. |
| Classification failed | Stage timeline red. "Re-classify" button. | Click → calls `/reclassify`. |
| Sub-group sync failed | Per-sub-group row red. Other sub-groups continue. | Manual retry from sub-group page (existing). |
| Rough cut failed (slice 1 banner) | Editor banner. | Slice 1 retry path. |
| B-roll chain failed | Stage row red, error inline. | "Retry b-roll" → `/broll/groups/:subId/retry-chain` re-fires the orchestrator from scratch (idempotent — already-complete steps short-circuit). |
| Resend down / no API key | Email send is a noop; chain still completes. | Status visible in ProcessingModal / Projects. |
| Server restart mid-chain | `resumeStuckFullAutoChains` re-fires on boot. | Transparent. |

## Endpoints (summary)

New:
- `GET /videos/groups/:id/full-auto-status` — aggregate poll target.
- `POST /broll/groups/:subId/resume-chain?from={plan|search}` — pause-checkpoint resume.
- `POST /broll/groups/:subId/retry-chain` — manual retry.

Modified:
- `GET /videos/groups/:id/detail` — adds `broll_chain_status`, `broll_chain_error` to response.
- `POST /videos/groups/:id/reclassify` — body extracted to `auto-orchestrator.reclassifyGroup`; route is a wrapper.
- `POST /videos/groups/:id/confirm-classification` — body extracted; propagates `auto_rough_cut`, `path_id`, references at split.
- `GET /videos` — joins return `auto_rough_cut`, `path_id` (existing) plus aggregate sub-group counts for the badge.

Unchanged:
- `POST /broll/pipeline/{run-all,run-strategies,run-plan,search-next-batch,run-broll-search}` — extracted into `broll-runner.js` helpers; routes become wrappers preserving today's request/response.
- `POST /videos/groups/:id/start-ai-roughcut` — slice 1's wrapper, still calls `runAiRoughCut`.

## Testing

1. **`auto-orchestrator.reclassifyGroup`** — vitest, mocked db. Chains into `confirmClassificationGroup` only for `path_id='hands-off'`.
2. **`auto-orchestrator.confirmClassificationGroup`** — propagates `auto_rough_cut`, `path_id`, and copies `broll_example_sources` rows to each sub-group.
3. **`auto-orchestrator.runFullAutoBrollChain`** — covers happy path, pauses for `strategy-only` / `guided`, failure → email-failed.
4. **`broll-runner.runAllReferences`** + the other three runners — vitest, mocked db. Match the response shapes the existing routes return.
5. **`email-notifier.send`** — vitest, mocked Resend. Dedup window respected. Templates render. Missing API key noops.
6. **Hook tests**: `runTranscription` last-done detection, slice 1's `updateStatus` extension fires b-roll chain after rough-cut terminal.
7. **Frontend `ProcessingModal-stages.test.jsx`** — stage derivation matrix (uploading / pipeline / done), Full Auto banner visibility, paused-state row.
8. **Manual smoke**:
   - Full Auto end-to-end: upload + Run Rough Cut + Full Auto + close tab + check email + reopen.
   - Strategy Review: chain pauses at strategy → email arrives → user picks → chain resumes → final email.
   - Guided: two pause emails, three resume calls.
   - Insufficient balance at Step 6: Continue disabled.
   - Server restart mid-chain: chain resumes, completes successfully.

## Slice 2 deliverable

A user can:
1. Upload videos + go through Steps 1–7 (Steps 5 + 6 from slice 1 + slice 2 work).
2. Pick "Full Auto" on Step 6.
3. Close the tab once uploads are done.
4. Receive an email when the project is ready.
5. Open the email link, land on the editor with annotations + b-roll plans + first-10 search results visible.

Or with `strategy-only` / `guided`:
1. Same setup, different Path pick.
2. Receive an email at each checkpoint with a "pick a variant" or "pick a plan" CTA.
3. Pick → chain resumes server-side.
4. Receive a final email when complete.

Slice 3 / future polish lands on top: per-stage time estimates, expandable per-sub-group detail rows, a Cancel-and-refund button, BRollPanel UI updates for the new auto-pick states.
