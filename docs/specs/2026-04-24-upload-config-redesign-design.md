# Upload Configuration Redesign — Design

**Date**: 2026-04-24
**Branch target**: `feature/upload-config-redesign` (git worktree)
**Source design**: `~/Downloads/Adpunk/` (inline-styled React mockups)

## Goal

Replace the current single-page AI Rough Cut configuration (`?step=config` → `RoughCutConfigModal`) with a multi-step onboarding flow that captures B-roll library subscriptions, target audience, reference videos, and workflow-automation preference. Remove the rough-cut options question entirely and apply sensible server-side defaults so existing pipelines keep working.

## Current flow (to replace)

`ProjectsView.jsx` drives a URL-param state machine:

1. `?step=upload` → `UploadModal` (video + script upload; creates `video_groups` row).
2. `?step=config` → `RoughCutConfigModal` (writes `rough_cut_config_json`; this goes away).
3. `?step=broll-examples` → `BRollExamplesModal` (writes to `broll_example_sources`).
4. `?step=processing` → `ProcessingModal` (transcription kickoff).

## Target flow

Six unified steps (header stepper always visible from step 2 onward):

| # | id | Component | State touched |
|---|---|---|---|
| 1 | `upload` | `UploadModal` (unchanged) | creates `video_groups` row |
| 2 | `libraries` | `StepLibraries` | `libraries_json`, `freepik_opt_in` |
| 3 | `audience` | `StepAudience` | `audience_json` |
| 4 | `references` | `StepReferences` (rewrite) | `broll_example_sources` (existing) |
| 5 | `path` | `StepPath` | `path_id` |
| 6 | `transcribe` | `ProcessingModal` (unchanged) | transcription kickoff |

Between steps 5 and 6 the `StepDone` summary surfaces. "Proceed to Editor" on the summary triggers the same `onComplete` flow currently fired by `RoughCutConfigModal`, which advances to `ProcessingModal`.

## File layout

```
src/components/upload-config/
  UploadConfigFlow.jsx           # orchestrator; replaces RoughCutConfigModal usage in ProjectsView
  Stepper.jsx                    # 6-step header
  primitives/
    Eyebrow.jsx
    PageTitle.jsx
    CheckPill.jsx
    RadioTile.jsx
    FieldCard.jsx
    Toggle.jsx                   # skip if project already has one
  steps/
    StepLibraries.jsx
    StepAudience.jsx
    StepReferences.jsx           # rewrite (not refactor) of BRollExamplesModal
    StepPath.jsx
    StepDone.jsx
```

All Tailwind-classed using the existing theme tokens (`lime`, `primary-container`, `surface-container-*`, `on-surface-variant`). Design colors (`#cefc00`, `#c180ff`, `#2dd4bf`) already map to theme classes.

## State shape (client)

Held in `UploadConfigFlow` via `useReducer`:

```js
{
  libraries: string[],                 // subset of ['envato','artlist','storyblocks']
  freepikOptIn: boolean,               // used only when libraries.length === 0
  audience: {
    age: string[],                     // e.g. ['gen_z','millennial']
    sex: string[],                     // e.g. ['any']
    ethnicity: string[],
    language: string,                  // e.g. 'English'
    region: string,                    // free text, optional
    notes: string,                     // free text, optional
  },
  pathId: 'hands-off' | 'strategy-only' | 'guided',
  // references live authoritatively in broll_example_sources; not mirrored here
}
```

### Defaults on first load of a freshly-created group

- `libraries`: `[]` (triggers Pexels fallback UI).
- `freepikOptIn`: `true`.
- `audience`: `{ age: ['millennial','gen_z'], sex: ['any'], ethnicity: ['any'], language: 'English', region: '', notes: '' }` (matches design mockup).
- `pathId`: `'strategy-only'` (balanced default).

### Persistence cadence

Each "Continue" click fires `PUT /videos/groups/:id` with only the fields touched by that step. No per-keystroke saves. No `localStorage`.

### Naming convention

Client state uses camelCase (`freepikOptIn`, `pathId`). Server columns use snake_case (`freepik_opt_in`, `path_id`). The `PUT /videos/groups/:id` handler translates between them. `audience_json` and `libraries_json` are stored as JSON text; parsed into objects/arrays on the way out of `GET /videos`.

## Backend

### Migration (add to `server/schema-pg.sql` and `schema.sql`; ALTER for existing DBs)

```sql
ALTER TABLE video_groups
  ADD COLUMN libraries_json   TEXT,
  ADD COLUMN freepik_opt_in   BOOLEAN DEFAULT TRUE,
  ADD COLUMN audience_json    TEXT,
  ADD COLUMN path_id          TEXT;
```

All four columns nullable; any row without them falls back to the client-side defaults listed above.

### Default backfill for rough_cut_config_json

The `rough_cut_config_json` column stays. Currently populated by `RoughCutConfigModal` via `PUT /videos/groups/:id`. Going forward, `POST /videos/groups` writes the hardcoded DEFAULT_CONFIG at group creation so the column is never null for new groups. Constant lives in `server/routes/videos.js`:

```js
const DEFAULT_ROUGH_CUT_CONFIG = {
  cut: { silences: true, false_starts: false, filler_words: true, meta_commentary: false },
  identify: { repetition: true, lengthy: false, technical_unclear: false, irrelevance: false },
};
```

This matches the existing `RoughCutConfigModal` default exactly — downstream pipeline code that reads `rough_cut_config_json` sees no behavior change.

### API changes

- `PUT /videos/groups/:id` — extend the existing whitelist to accept `libraries`, `freepik_opt_in`, `audience`, `path_id`. Keep `rough_cut_config_json` write path for back-compat (but UI stops calling it).
- `POST /videos/groups` — write DEFAULT_ROUGH_CUT_CONFIG at create time.
- `GET /videos` — extend the group shape to include the four new fields (JSON-parsed).
- No new endpoints.

### Server validation

- `libraries`: array, each element in `{'envato','artlist','storyblocks'}`.
- `path_id`: one of `{'hands-off','strategy-only','guided'}`.
- `freepik_opt_in`: boolean.
- `audience`: free-form JSON; stored as-is (future work may tighten).

## Path behavior & pipeline integration

`path_id` drives two things in the existing b-roll pipeline:

| path_id | stop_after_strategy | stop_after_plan | auto_select_variants |
|---|---|---|---|
| `hands-off` | false | false | **true** |
| `strategy-only` | true | false | false |
| `guided` | true | true | false |

**Current state**: `server/routes/broll.js:479` already accepts `stop_after_plan`. The `startBrollRun` service call passes `{ stopAfterPlan }` through.

**Change**: the POST that kicks off a b-roll run stops taking raw `stop_after_plan` from the client; instead it reads `path_id` from the group row and derives the pair of flags. Add `stop_after_strategy` to the pipeline runner in the same shape `stop_after_plan` works today.

**Variant auto-select**: `BRollEditor.jsx` currently shows a variant picker when `variants.length > 1`. Extend: if the group's `path_id === 'hands-off'`, skip the picker and mark all variants active on first mount.

**Final review**: every path still lands the user in the editor for a final review before anything is exported. No change needed — the editor is already the terminal UI.

**Out of scope for this iteration** (explicit):
- Email notifications when a checkpoint is reached.
- Auth-gated pipeline resume.
- Moving the Path step to "after references finish fetching."
- Threading audience data into b-roll prompt templates.

## Migration safety & removal plan

**Order of operations** (so main is never broken):

1. Ship UI + new backend columns + DEFAULT_ROUGH_CUT_CONFIG backfill.
2. Verify in prod that new groups get `rough_cut_config_json` populated automatically.
3. Delete `RoughCutConfigModal.jsx`, its import in `ProjectsView`, the `step=config` URL case.
4. Delete `BRollExamplesModal.jsx` after `StepReferences` ships.
5. `rough_cut_config_json` column remains indefinitely (dropping it is out of scope).

**Old-URL handling**: `ProjectsView` catches `step=config` and redirects:
```js
if (step === 'config') { setStep('libraries', groupId); return null }
```
Prevents bookmarks or in-flight sessions from breaking.

**Rollback**: worktree → PR → merge. If the new flow breaks, revert the merge commit. All migrations are additive; no columns or rows dropped.

## Sub-agent execution plan

Parallel agents are only safe if they don't touch the same files. Wave 1 pre-wires `UploadConfigFlow.jsx` so Wave 2 agents can work in parallel without merge conflicts.

**Wave 1 — single agent, sequential** (scaffolding):

1. Create worktree `feature/upload-config-redesign` via `git worktree add`. All subsequent work happens inside that worktree.
2. Scaffold `src/components/upload-config/`:
   - All primitives (Eyebrow, PageTitle, CheckPill, RadioTile, FieldCard, Toggle) — fully implemented.
   - Stepper.jsx — fully implemented.
   - `UploadConfigFlow.jsx` — fully implemented header/footer/state store; imports each step from its expected path (`./steps/StepLibraries` etc.) and routes to it in the switch. Each step file is created as a placeholder default export: `export default function StepX() { return <div className="text-muted">Placeholder</div> }`.
   - `ProjectsView.jsx` edits: swap `RoughCutConfigModal` usage for `UploadConfigFlow`; change `step=config` routing to route through the new `libraries → audience → references → path` sequence; add the legacy `step=config` → `step=libraries` redirect.
3. Backend:
   - Add the four new columns to `schema-pg.sql` and `schema.sql` (match existing ALTER patterns in the repo).
   - Extend `PUT /videos/groups/:id` to accept/validate the new fields.
   - Extend `POST /videos/groups` to write DEFAULT_ROUGH_CUT_CONFIG.
   - Extend `GET /videos` to return parsed JSON fields.
4. Delete `RoughCutConfigModal.jsx` after its last caller in `ProjectsView` is removed.
5. Commit when typecheck passes and existing tests pass.

At the end of Wave 1, the app is usable end-to-end: every step renders the placeholder, so the flow navigates correctly. No functional UI yet.

**Wave 2 — four agents, parallel** (all launched in one message):

Each agent edits exactly one step file, plus its own dependencies. Zero shared-file conflicts because the orchestrator is already wired.

- **Agent A — `steps/StepLibraries.jsx`**: 3-tile grid, Pexels fallback card with Freepik toggle, summary line.
- **Agent B — `steps/StepAudience.jsx`**: age/sex/ethnicity pills, language dropdown, region + notes text fields.
- **Agent C — `steps/StepReferences.jsx` + delete `BRollExamplesModal.jsx`**: rewrite against new design; port YT URL fetch + local file upload + favorite + status polling from the old modal; delete `BRollExamplesModal.jsx` as the agent's last action (no caller remains after Wave 1 swaps the orchestrator).
- **Agent D — `steps/StepPath.jsx` + `steps/StepDone.jsx` + pipeline wiring**: path tiles + summary modal; change b-roll kickoff (`server/routes/broll.js`) to derive `stop_after_strategy`/`stop_after_plan` from the group's `path_id` instead of accepting `stop_after_plan` from the client; extend `BRollEditor.jsx` to auto-select-all-variants when `path_id === 'hands-off'`; add a unit test that each of the 3 `path_id` values maps to the correct flag pair.

Agent D owns the only cross-file pipeline change. It and Agent C also both delete a file — no conflict because they delete different files.

**No final merge agent needed** — each Wave 2 agent commits directly into the same worktree branch. Final step is the main-thread user reviewing the worktree diff and merging.

## Acceptance criteria

- New group created via UI lands on `step=libraries` after upload (not `step=config`).
- Continuing through each step persists to `video_groups` incrementally.
- `StepDone` summary shows the correct 4-row breakdown.
- "Proceed to Editor" triggers the same kickoff flow that `RoughCutConfigModal` → `ProcessingModal` used to trigger.
- A freshly-created group has non-null `rough_cut_config_json` matching DEFAULT_ROUGH_CUT_CONFIG.
- `path_id = 'hands-off'` on a b-roll run: no pause at strategy or plan, variant picker auto-selects all.
- `path_id = 'strategy-only'`: pipeline halts after strategy stage; after-resume runs plan + search to completion.
- `path_id = 'guided'`: pipeline halts after strategy AND after plan.
- Visiting a legacy `?step=config&group=X` URL redirects to `?step=libraries&group=X` without error.
- `RoughCutConfigModal.jsx` and `BRollExamplesModal.jsx` are deleted.
- No regression in `UploadModal` or `ProcessingModal` behavior.

## Open decisions deferred to implementation

- Exact `ALTER TABLE` phrasing for the SQLite path vs PG path — agent to match existing migration patterns in the repo.
- Whether `freepik_opt_in` is stored on the group or on a separate `user_preferences` (decision in Wave 1 agent based on existing conventions). Default: on the group.
- Whether `StepDone` surfaces as a step in the stepper header or as a modal overlay. Default: overlay (matches design).
