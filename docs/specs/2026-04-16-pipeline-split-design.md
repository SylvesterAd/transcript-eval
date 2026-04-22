# Split B-Roll Pipeline: Prep → Strategy → Plan

## Goal

Split the monolithic 8-stage plan pipeline into 3 independent pipelines (Plan Prep, Create Strategy, Create Plan) so that strategies can be generated per-reference-video and users can pick which strategy to turn into a placement plan.

## Architecture

```
User clicks "Analyze & Prepare" (one button)
    │
    ├── Plan Prep (1 run)              ← stages 1-5 from current plan
    │   Produces: transcript, post-cut video, A-Roll, chapters/beats, chapterSplits
    │
    ├── Analyze Reference A (1 run)    ← existing analysis pipeline  
    ├── Analyze Reference B (1 run)    ← existing analysis pipeline
    │
    ╰── ALL COMPLETE ─────────────────────────────────────────────╮
                                                                   │
    ├── Create Strategy A (prep + analysis A)                      │
    ├── Create Strategy B (prep + analysis B)                      │
    │                                                              │
    ╰── User sees N strategies, picks 1-3 ─────────────────────────╮
                                                                   │
    ├── Create Plan from Strategy A (prep + strategy A)            │
    ├── Create Plan from Strategy B (prep + strategy B)            │
    │
    ╰── Keywords → Search (existing flow, per plan)
```

Plan Prep runs once (it's about the main video, not references). Strategies fork from it — one per reference. Plans fork from strategies — one per user selection.

## New Strategy Kinds

| Kind | Stages | Runs | Input |
|------|--------|------|-------|
| `plan_prep` | Generate transcript, Export video, A-Roll, Chapters & Beats, Split by chapter | 1 per group | main video, editor cuts |
| `create_strategy` | Per-chapter B-Roll strategy (current plan Stage 6) | N (one per reference) | prepPipelineId + analysisPipelineId |
| `create_plan` | Per-chapter placements + Assemble (current plan Stages 7-8) | 1-3 (per selected strategy) | prepPipelineId + strategyPipelineId |

The old `plan` kind stays for backward compatibility with existing completed runs. The `alt_plan` kind is no longer used for new runs.

## New Backend Functions

All in `server/services/broll.js`, following the existing pattern of `executeAltPlans`, `executeKeywords`.

### `executePlanPrep(strategyId, versionId, videoId, groupId, editorCuts)`

Runs stages 1-5 independently:
1. Generate post-cut transcript → `currentTranscript`
2. Export post-cut video → `mainVideoFilePath`
3. Analyze A-Roll Appearances → `llmAnswer` (A-Roll JSON)
4. Analyze Chapters & Beats → `llmAnswer` (chapters JSON)
5. Split by chapter → `chapterSplits`

Stores results in `broll_runs` with `phase: 'plan_prep'`. Each stage stored with `stageName` for later lookup.

Returns `{ prepPipelineId, stageCount, totalCost }`.

### `executeCreateStrategy(prepPipelineId, analysisPipelineId, strategyVersionId, videoId, groupId)`

Loads from DB:
- chapterSplits: prep pipeline's `Split by chapter` stage output, parsed back into chapter objects
- A-Roll: prep pipeline's `Analyze A-Roll Appearances` stage output  
- transcript: prep pipeline's `Generate post-cut transcript` stage output
- reference_analysis: analysis pipeline's `Assemble full analysis` stage output

Runs the current Stage 6 logic: per-chapter strategy generation with `{{reference_analysis}}`, `{{chapter_*}}` placeholders.

Stores with `phase: 'create_strategy'`. Metadata includes `prepPipelineId` and `analysisPipelineId` for traceability.

Returns `{ strategyPipelineId, stageCount, totalCost }`.

### `executeCreatePlan(prepPipelineId, strategyPipelineId, planVersionId, videoId, groupId)`

Loads from DB:
- chapterSplits: from prep pipeline (same as above)
- strategy: from strategy pipeline's per-chapter sub-runs (the strategy output per chapter)

Runs:
1. Per-chapter placements (current Stage 7) — uses `{{prev_chapter_output}}` = strategy from the strategy pipeline
2. Assemble full plan (current Stage 8)

Stores with `phase: 'create_plan'`. Metadata includes `prepPipelineId` and `strategyPipelineId`.

Returns `{ planPipelineId, stageCount, totalCost }`.

## Data Loading Pattern

Each function loads dependencies from DB by `pipelineId` + `stageName`:

```javascript
const prepRuns = await db.prepare(
  `SELECT output_text, metadata_json FROM broll_runs 
   WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
).all(`%"pipelineId":"${prepPipelineId}"%`)

const aRollRun = prepRuns.find(r => {
  const m = JSON.parse(r.metadata_json)
  return !m.isSubRun && m.stageName === 'Analyze A-Roll Appearances'
})
const chaptersRun = prepRuns.find(r => {
  const m = JSON.parse(r.metadata_json)
  return !m.isSubRun && m.stageName === 'Analyze Chapters & Beats'
})
const splitRun = prepRuns.find(r => {
  const m = JSON.parse(r.metadata_json)
  return !m.isSubRun && m.stageName === 'Split by chapter'
})
```

This follows the same pattern `executeAltPlans` already uses to load plan pipeline data.

## New API Endpoints

All in `server/routes/broll.js`.

### `POST /api/broll/pipeline/run-all`

The "one button" endpoint. Orchestrates the full flow up to strategies.

Request body: `{ video_id, group_id, transcript_source }`

Logic:
1. Load example videos for the group
2. Fire Plan Prep run
3. Fire N analysis runs in parallel (one per example video, using `example_video_id`)
4. Return immediately: `{ prepPipelineId, analysisPipelineIds: [...] }`
5. Frontend polls all pipeline IDs for progress

### `POST /api/broll/pipeline/run-strategies`

Triggered by frontend when prep + all analyses are complete.

Request body: `{ prep_pipeline_id, analysis_pipeline_ids: [...] }`

Logic:
1. Validate prep pipeline is complete
2. Validate all analysis pipelines are complete
3. Fire N strategy runs in parallel (one per analysis pipeline)
4. Return: `{ strategyPipelineIds: [...] }`

### `POST /api/broll/pipeline/run-plan`

Triggered by user after selecting a strategy.

Request body: `{ prep_pipeline_id, strategy_pipeline_id }`

Logic:
1. Validate prep and strategy pipelines are complete
2. Fire one Create Plan run
3. Return: `{ planPipelineId }`

### Downstream Endpoints (unchanged)

- `POST /api/broll/pipeline/:pipelineId/run-keywords` — receives `planPipelineId` from Create Plan, finds "Per-chapter B-Roll plan" sub-runs as before
- `POST /api/broll/pipeline/:pipelineId/run-broll-search` — same, receives `planPipelineId`

These work unchanged because Create Plan stores sub-runs with `stageName: 'Per-chapter B-Roll plan'` in the same format as the old monolithic pipeline.

## Frontend Flow

### BRollPanel Steps

The step bar in BRollPanel becomes:

1. **"Analyze & Prepare"** — fires `POST /api/broll/pipeline/run-all`. Shows parallel progress for prep + N analyses. When all complete, auto-fires strategies.
2. **"Strategies"** — shows progress while N strategies generate. When complete, shows strategy cards for selection.
3. **"Generate Plan"** — user picks 1-3 strategies, clicks generate. Fires `POST /api/broll/pipeline/run-plan` per selection. Shows progress.
4. **"Keywords"** — unchanged, fires per plan pipeline
5. **"Search B-Roll"** — unchanged, navigates to editor

### State Tracking

BRollPanel tracks:
```javascript
const [prepPipelineId, setPrepPipelineId] = useState(null)
const [analysisPipelineIds, setAnalysisPipelineIds] = useState([])
const [strategyPipelineIds, setStrategyPipelineIds] = useState([])
const [planPipelineIds, setPlanPipelineIds] = useState([])
```

Completion detection: check `broll_runs` for completed pipelines by `phase` and `groupId`, same pattern as current `hasCompletedAnalysis`, `hasCompletedPlan` checks.

### Strategy Selection UI

After strategies complete, show a card per strategy:
- Reference video name/thumbnail
- Chapter match summary (which reference chapters matched which)
- Key differences (frequency targets, style approach)
- "Select" button

User can select 1-3 strategies. Selected strategies get a plan generated.

## What Gets Removed

- **`alt_plan` strategy kind** — every reference gets equal treatment via `create_strategy`
- **`executeAltPlans` function** — replaced by `executeCreateStrategy`
- **`stop_after_plan` parameter** — pipelines are naturally separate
- **`main_strategy_id` chaining in executePipeline** — prep and strategy are independent pipelines
- **Alt plan UI step** — replaced by strategy selection

## What Stays Unchanged

- **Analysis pipeline** — `main_analysis` strategy kind, runs per reference video
- **`executeKeywords`** — receives `planPipelineId`, searches by stage name
- **`executeBrollSearch`** — receives `planPipelineId`, searches by stage name
- **`getBRollEditorData`** — receives `planPipelineId`, searches by stage name
- **BRollEditor** — receives `planPipelineId`, works as before
- **Existing completed runs** — old `plan` and `alt_plan` runs stay in DB

## Backward Compatibility

- Old `executePipeline` with `strategy_kind === 'plan'` still works for viewing/resuming old runs
- New runs go through the new pipeline functions
- The admin broll-runs page shows all runs regardless of kind
- `BROLL_STRATEGY_KINDS` array gets 3 new entries: `plan_prep`, `create_strategy`, `create_plan`

## Strategy Version Management

Each new strategy kind gets its own strategy + version row in the DB:
- `plan_prep` strategy with `stages_json` containing stages 1-5
- `create_strategy` strategy with `stages_json` containing the per-chapter strategy stage
- `create_plan` strategy with `stages_json` containing stages 7-8

These are seeded via a migration script that extracts stages from the current plan strategy version.

## Pipeline Metadata Structure

Each pipeline stores parent references in `metadata_json`:

```json
// Plan Prep
{ "pipelineId": "prep-367-...", "phase": "plan_prep", "groupId": 221 }

// Create Strategy  
{ "pipelineId": "strat-367-...", "phase": "create_strategy", 
  "prepPipelineId": "prep-367-...", "analysisPipelineId": "2-367-...-ex368",
  "referenceVideoId": 368, "referenceVideoTitle": "Crunchy brain syndrome" }

// Create Plan
{ "pipelineId": "plan-367-...", "phase": "create_plan",
  "prepPipelineId": "prep-367-...", "strategyPipelineId": "strat-367-..." }
```

This enables tracing the full lineage of any plan back to its prep and reference.
