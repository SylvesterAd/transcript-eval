# Auto Rough Cut — Slice 1 (Upload Step + Server-side Auto-trigger After Sync) — Design

**Date**: 2026-04-28
**Branch target**: `feature/auto-rough-cut-slice1` (git worktree)
**Source design**: `~/Downloads/Adpunk (2)/` (HTML + JSX mockups)
**Parent feature**: Upload-time selection of "Auto Rough Cut + Path-based automation"
**This slice**: Step 5 in upload flow + server-side fire of existing rough-cut pipeline after `analyzeMulticam` finishes.

## Scope

### In scope (this slice)
- A new optional **Rough Cut** step between `references` and `path` in the upload-config flow.
- Persisting the user's choice on `video_groups`.
- A **pre-flight balance check** on Step 5 that disables Continue when balance < estimate.
- A **server-side auto-trigger**: at the tail of `analyzeMulticam`, when assembly is about to complete, fire the existing AI Rough Cut pipeline if the group flagged it.
- Extending `SyncingScreen` with a `rough_cut` stage so the user stays on a single coherent loading screen until rough cut finishes.
- Failure handling for race-condition insufficient-tokens (token deduction is transactional on the server).

### Out of scope (deferred to slices 2 & 3)
- Path-driven B-roll automation (strategy → plan → 10-search). Covered in slice 2.
- Full-auto progress UI + email-on-completion. Covered in slice 3.
- Any change to the manual "Start AI Rough Cut" button in `EditorView`. (It will start calling the same refactored helper, but its UX is unchanged.)
- Token reservations / hold-and-charge mechanics. We pre-flight at Step 5 and re-validate at trigger time only.

## Background

Today the user manually triggers AI Rough Cut from the editor:
1. `EditorView.handleStartAIRoughCut` → `POST /videos/groups/:id/estimate-ai-roughcut` → opens estimation modal.
2. User clicks Run → `handleAcceptAIRoughCut` → `POST /videos/groups/:id/start-ai-roughcut`.
3. `/start-ai-roughcut` does a transactional `user_tokens` deduction, creates an `experiment_run`, runs the pipeline, writes `annotations_json` on the group.

This slice removes the requirement that the user open the editor — the same pipeline gets fired automatically once sync finishes.

## Source design pointers

- `~/Downloads/Adpunk (2)/step-rough-cut.jsx` — the new step component (target visual).
- `~/Downloads/Adpunk (2)/Upload Configuration.html` — confirms step ordering: `upload, libraries, audience, references, roughcut, path, transcribe`.
- `~/Downloads/Adpunk (2)/Upload Configuration.html` lines around `STEPS = UNIFIED_STEPS.slice(1, 6)` — confirms 5 sub-steps in the modal (was 4).

## DB schema

Two columns on `video_groups`:

```sql
ALTER TABLE video_groups
  ADD COLUMN auto_rough_cut BOOLEAN DEFAULT FALSE,
  ADD COLUMN rough_cut_status TEXT;  -- NULL | 'pending' | 'running' | 'done' | 'failed' | 'insufficient_tokens'
```

- `auto_rough_cut` — set to `true` when user picks "Run" on Step 5; `false` (default) when they pick Skip. Persisted via `PUT /videos/groups/:id` (existing endpoint, just extend `validateGroupUpdate`).
- `rough_cut_status` — orchestrator-set status for SyncingScreen polling. Distinct from `assembly_status` because they run sequentially and SyncingScreen needs to display them as two phases.

`server/schema-pg.sql` updated; one inline migration (existing rows default to `FALSE`/`NULL` — no backfill needed).

## Frontend — Upload flow

### Step ordering changes (`UploadConfigFlow.jsx`)

```js
const UNIFIED_STEPS = [
  { id: 'upload',     label: 'Upload' },
  { id: 'libraries',  label: 'Libraries' },
  { id: 'audience',   label: 'Audience' },
  { id: 'references', label: 'Refs' },
  { id: 'roughcut',   label: 'Rough Cut' },   // NEW
  { id: 'path',       label: 'Path' },
  { id: 'transcribe', label: 'Transcribe' },
]
const CONFIG_STEPS = UNIFIED_STEPS.slice(1, 6) // 5 sub-steps now (was 4)
```

`ProjectsView.CONFIG_STEPS` Set must add `'roughcut'`. URL `?step=roughcut` becomes valid.

### New file: `src/components/upload-config/steps/StepRoughCut.jsx`

Skeleton from the Adpunk(2) mockup (target cards, before/after preview, stat row), Tailwind-classed against existing theme tokens.

State (held in parent `UploadConfigFlow`):
```js
{ autoRoughCut: boolean }   // default false
```

Reducer additions:
```js
case 'setAutoRoughCut': return { ...state, autoRoughCut: action.payload }
```

Persistence on Continue (`persistCurrent` switch case `'roughcut'`):
```js
body.auto_rough_cut = state.autoRoughCut
```

### Token estimate fetch

Inside `StepRoughCut`:
- Mount: call `POST /videos/groups/:id/estimate-ai-roughcut`.
- If `tokenCost === 0` (duration not yet populated), poll every 1s up to 60s, then back off to 3s.
- Stop polling once a non-zero `tokenCost` is observed.
- Display three numbers from the response: `tokenCost`, `estimatedTimeSeconds`, `balance` (from a separate `GET /videos/user/tokens` call kept fresh on mount).

### Pre-flight balance check (the user-stipulated piece)

While `state.autoRoughCut === true`:
- If `balance < tokenCost`, show "Not enough tokens — you have N, this needs M" inline and **disable the Continue button** (added to `continueDisabled` in `UploadConfigFlow`).
- If `state.autoRoughCut === false` (Skip), the button is always enabled.

The Continue handler in `UploadConfigFlow` already has a `continueDisabled` plumbing path (today only used for the references step) — extend the logic.

### Initial-state hydration

`ProjectsView.initialConfig` extended:
```js
{ ..., autoRoughCut: !!currentGroup.auto_rough_cut }
```
So if the user reloads the page on `?step=roughcut`, their selection is restored.

### Default

Step 5 mounts with `autoRoughCut = false`. User must opt in.

## Backend — Refactor + auto-trigger

### Refactor `start-ai-roughcut` route into a reusable helper

Currently lines ~1012–1310 of `server/routes/videos.js` contain everything inline. Extract:

```js
// server/services/rough-cut-runner.js (new file)
export async function runAiRoughCut({ groupId, userId, force = false, isAdmin = false }) {
  // 1. fetch group
  // 2. compute tokenCost from durations
  // 3. transactional deduction (existing INSERT ... ON CONFLICT + UPDATE + token_transactions INSERT)
  // 4. check existing annotations (already_exists short-circuit)
  // 5. clean up stale pending runs
  // 6. create experiment_run
  // 7. dispatch llm-runner
  // returns: { ok, tokenCost, balanceAfter, experimentId, runId, totalStages, stageNames, stageTypes, already_exists, error?: 'insufficient_tokens' | ... }
}
```

The route handler at `POST /groups/:id/start-ai-roughcut` becomes a thin wrapper that calls `runAiRoughCut` and forwards the response. Response shape unchanged (frontend contract preserved).

### Auto-trigger in `analyzeMulticam`

In `server/services/multicam-sync.js` (or wherever `analyzeMulticam` lives — likely `multicam-sync.js`), find the place where it transitions `assembly_status` to `done`. Replace:

```js
// before
await db.prepare('UPDATE video_groups SET assembly_status = ? WHERE id = ?')
  .run('done', groupId)
```

with:

```js
const group = await db.prepare('SELECT user_id, auto_rough_cut FROM video_groups WHERE id = ?').get(groupId)
await db.prepare('UPDATE video_groups SET assembly_status = ? WHERE id = ?')
  .run('done', groupId)

if (group?.auto_rough_cut) {
  await db.prepare("UPDATE video_groups SET rough_cut_status = 'pending' WHERE id = ?").run(groupId)
  // fire-and-forget; status updates handled inside runAiRoughCut
  runAiRoughCut({ groupId, userId: group.user_id })
    .then(async (r) => {
      const final = r.error === 'insufficient_tokens' ? 'insufficient_tokens'
        : r.error ? 'failed'
        : 'running' // pipeline took over; will set 'done' on completion
      await db.prepare('UPDATE video_groups SET rough_cut_status = ? WHERE id = ?').run(final, groupId)
    })
    .catch(async (err) => {
      console.error(`[auto-rough-cut] group ${groupId} failed:`, err.message)
      await db.prepare("UPDATE video_groups SET rough_cut_status = 'failed' WHERE id = ?").run(groupId)
    })
}
```

The pipeline (`llm-runner` + `annotation-mapper`) already writes `annotations_json` on completion. Add one final hook: when the experiment_run completes, set `rough_cut_status = 'done'`. Extend the existing finalisation point in `llm-runner` (or wherever the experiment marks itself done for an auto-rough-cut origin) to also flip the field.

> **Note**: `runAiRoughCut` itself is async and the pipeline runs in the background — its returned promise resolves quickly (after deduction + experiment creation). The "running → done" transition is handled by the pipeline's own completion hook, not the immediate caller.

### Status response extension

`GET /videos/groups/:id/status` (currently returns `{ assembly_status, assembly_error }`) extends to:

```js
{ assembly_status, assembly_error, rough_cut_status, rough_cut_error_required }
```

`rough_cut_error_required` is the token shortfall (only set when status is `'insufficient_tokens'`); used by the editor banner.

## Frontend — SyncingScreen extension

`EditorView.SyncingScreen`:

- `currentStatus` becomes `{ assembly: ..., rough_cut: ... }`.
- Polling reads both fields.
- Display priority:
  - If `assembly_status` is in any non-terminal state → existing `STATUS_LABELS` apply.
  - Else if `rough_cut_status === 'pending'` or `'running'` → show new label `"Cleaning your transcript..."` (key: `rough_cut`).
  - Else (assembly done + rough_cut is `null`/`done`/`failed`/`insufficient_tokens`) → call `onDone()`.
- `STATUS_LABELS` gets one new entry:
  ```js
  rough_cut: 'Cleaning your transcript...',
  ```
- Stage dot indicator: append a 9th dot.

`isAssembling` predicate at `EditorView.jsx:810` extends:
```js
const isAssembling = (assembly_status_in_progress) || rough_cut_in_progress
```

## Failure modes

### Insufficient tokens at trigger time (race)

- `runAiRoughCut` returns `{ error: 'insufficient_tokens', balance, required }`.
- Auto-trigger sets `rough_cut_status = 'insufficient_tokens'`, `rough_cut_error_required = required`.
- SyncingScreen exits → editor opens with raw transcript.
- Editor shows a banner (new):
  > "AI Rough Cut couldn't run — needs N tokens, you have M. [Top up & retry]"
- The banner's "Retry" reuses `handleStartAIRoughCut` (no new code).

### Annotations already exist (idempotency)

- `runAiRoughCut` short-circuits with `{ already_exists: true }` (existing behaviour).
- Auto-trigger sets `rough_cut_status = 'done'`. SyncingScreen exits cleanly.

### Pipeline runtime error

- `runAiRoughCut` resolves but the pipeline later fails (recorded on `experiment_run`).
- Pipeline finalisation hook sets `rough_cut_status = 'failed'`.
- SyncingScreen exits → editor opens with raw transcript.
- A small dismissible banner: "AI Rough Cut failed — [Retry] / [Dismiss]".

### Pre-flight estimate is 0 (duration unavailable past timeout)

- Step 5 stops polling at 60 s.
- Display: "Couldn't estimate yet — your video is still being processed. Continue and we'll calculate at run time, or come back in a moment."
- Continue stays enabled but the precise number isn't shown; pre-flight check is bypassed (we can't compare against an unknown estimate). Trust server-side validation as the safety net.

## Token-estimate edge cases

- `/estimate-ai-roughcut` returns `tokenCost = 0` when no videos have `duration_seconds`. Treat as "unknown", keep polling.
- Server-side `runAiRoughCut` recomputes from current durations — so by trigger time the precise number is always available (transcription completed → metadata filled).
- The pre-flight check is *advisory* (UX); the transactional check in `runAiRoughCut` is *authoritative*.

## What does NOT change

- Existing `/start-ai-roughcut` HTTP contract (route extracts logic into `runAiRoughCut`, but request/response unchanged).
- `EditorView.handleStartAIRoughCut` and the estimation modal — same behaviour.
- `ProcessingModal` — no changes for slice 1.
- `AssetsView` auto-confirm logic — no changes.
- Multi-cam classification — no changes.

## Testing

Unit / integration coverage to add:

1. **`runAiRoughCut` helper** — extract pure unit (`server/services/__tests__/rough-cut-runner.test.js`):
   - Insufficient balance → `{ error: 'insufficient_tokens' }`, no DB writes outside the rolled-back transaction.
   - Existing annotations → `{ already_exists: true }`, no token deduction.
   - Happy path → balance debited, `experiment_run` created, returned IDs match DB.
2. **Auto-trigger hook** — integration test in `multicam-sync` flow:
   - `auto_rough_cut = true` → `runAiRoughCut` called once after assembly done.
   - `auto_rough_cut = false` → not called.
   - Idempotent: re-running `analyzeMulticam` doesn't double-deduct.
3. **Frontend `StepRoughCut`** — vitest:
   - Renders Skip default; Continue enabled.
   - Run + sufficient balance → Continue enabled; persists `auto_rough_cut: true` on advance.
   - Run + insufficient balance → Continue disabled; shows shortfall message.
   - Estimate is 0 initially → polls; UI shows "Calculating...".
4. **`SyncingScreen`** — manual smoke (no unit test today for this component):
   - Sync done → rough_cut_status running → label changes to "Cleaning your transcript…".
   - Rough cut done → exits to editor.

## Open questions (none blocking — all answered upstream during brainstorm)

All design ambiguities (trigger location, estimate timing, default toggle state, balance-check semantics, SyncingScreen extension vs editor overlay) resolved during the design conversation.

## Slice 1 deliverable

A user can:
1. Upload a video.
2. On Step 5 of the upload flow, choose "Run Rough Cut" (default: Skip).
3. If they choose Run with insufficient balance, Continue is disabled with a clear message.
4. They proceed through Path + Transcribe as today.
5. When server-side sync completes, the rough-cut pipeline runs automatically — no editor visit required.
6. SyncingScreen shows "Cleaning your transcript..." until rough cut completes.
7. Editor opens with annotations applied.
8. Race-condition failure (rare) lands the user in the editor with a clear retry banner — no work lost.

Slice 2 (Path-driven B-roll automation) and slice 3 (full-auto progress UI + email) build on this foundation: `auto_rough_cut` becomes one of several boolean flags driving a longer post-sync chain.
