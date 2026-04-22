# Pipeline Split Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic 8-stage plan pipeline into 3 independent backend functions (Plan Prep, Create Strategy, Create Plan) with API routes to orchestrate them.

**Architecture:** Create 3 new strategy kinds with their own stages_json, 3 new execute functions that load dependencies from DB by pipelineId+stageName (following the existing `executeAltPlans` pattern), and 3 new API routes. The old `plan` pipeline stays for backward compatibility.

**Tech Stack:** Node.js, PostgreSQL, existing `callLLM`, existing DB helpers

---

## File Structure

- **Modify:** `server/services/broll.js` — add `BROLL_STRATEGY_KINDS` entries, add 3 new export functions
- **Modify:** `server/routes/broll.js` — add 3 new API routes
- **Create:** `server/seed/split-plan-strategies.js` — migration to create new strategy kinds + versions

---

### Task 1: Seed migration — create new strategy kinds + versions

**Files:**
- Create: `server/seed/split-plan-strategies.js`
- Modify: `server/services/broll.js` (BROLL_STRATEGY_KINDS only)

Extract stages from the current plan strategy (id=3) into 3 new strategies:
- `plan_prep`: stages 0-4 (Generate transcript, Export video, A-Roll, Chapters & Beats, Split by chapter)
- `create_strategy`: stage 5 only (Create B-Roll strategy — the per_chapter stage)
- `create_plan`: stages 6-7 (Per-chapter B-Roll plan + Assemble full plan)

The migration script reads the current plan strategy version's `stages_json`, splits it, and creates 3 new strategy rows + version rows.

Also add the 3 new kinds to `BROLL_STRATEGY_KINDS` in broll.js.

---

### Task 2: Implement `executePlanPrep`

**Files:**
- Modify: `server/services/broll.js`

New exported function. Runs stages 1-5 of the old plan pipeline as an independent pipeline. 

Key behavior:
- Accepts: `(strategyId, versionId, videoId, groupId, editorCuts)`
- Loads stages from the `plan_prep` strategy version
- Runs each stage sequentially using the same stage execution logic as `executePipeline` (programmatic actions + LLM calls)
- Handles: `generate_post_cut_transcript`, `export_post_cut_video`, `video_question` (A-Roll), `transcript_question` (Chapters), `split_by_chapter`
- Stores each stage output in `broll_runs` with `phase: 'plan_prep'` and `stageName` in metadata
- Progress tracking via `brollPipelineProgress`
- Pipeline ID format: `prep-${videoId}-${Date.now()}`
- Returns: `{ prepPipelineId, stageCount, totalTokensIn, totalTokensOut, totalCost, totalRuntime }`

Follow the `executeAltPlans` pattern for structure (try/catch, progress, abort, sub-run storage).

---

### Task 3: Implement `executeCreateStrategy`

**Files:**
- Modify: `server/services/broll.js`

New exported function. Runs the per-chapter strategy generation for ONE reference video.

Key behavior:
- Accepts: `(prepPipelineId, analysisPipelineId, videoId, groupId)`
- Loads prep data from DB by `prepPipelineId`:
  - transcript: stage with `stageName === 'Generate post-cut transcript'`
  - A-Roll: stage with `stageName === 'Analyze A-Roll Appearances'`
  - chapters: stage with `stageName === 'Analyze Chapters & Beats'`
  - split output: stage with `stageName === 'Split by chapter'`
- Rebuilds `chapterSplits` from the split output + chapters data (same logic as `executeAltPlans` lines 1006-1066)
- Loads `referenceAnalysis` from the analysis pipeline: find stage with `stageName === 'Assemble full analysis'`
- Loads the `create_strategy` strategy version's stages (should be 1 stage: the per-chapter strategy)
- Runs the per-chapter stage with concurrency pool of 5 (same pattern as `executeAltPlans`)
- Stores sub-runs with `phase: 'create_strategy'`, metadata includes `prepPipelineId`, `analysisPipelineId`
- Pipeline ID format: `strat-${videoId}-${Date.now()}-ref${referenceVideoId}`
- Returns: `{ strategyPipelineId, stageCount, totalCost }`

---

### Task 4: Implement `executeCreatePlan`

**Files:**
- Modify: `server/services/broll.js`

New exported function. Runs per-chapter placements + assemble for ONE selected strategy.

Key behavior:
- Accepts: `(prepPipelineId, strategyPipelineId, videoId, groupId)`
- Loads prep data from DB (same as Task 3 — transcript, A-Roll, chapters, chapterSplits)
- Loads strategy output from `strategyPipelineId`: find sub-runs with `isSubRun: true` (per-chapter strategy outputs)
- Loads the `create_plan` strategy version's stages (should be 2 stages: Per-chapter B-Roll plan + Assemble)
- For the per-chapter plan stage: `{{prev_chapter_output}}` = the strategy output for that chapter (from the strategy pipeline's sub-runs)
- Runs per-chapter with concurrency pool of 5, then runs assemble
- Stores sub-runs with `phase: 'create_plan'`, metadata includes `prepPipelineId`, `strategyPipelineId`
- **CRITICAL**: sub-runs for the per-chapter plan stage MUST have `stageName: 'Per-chapter B-Roll plan'` — this is what `executeKeywords`, `executeBrollSearch`, and `getBRollEditorData` search for
- Pipeline ID format: `plan-${videoId}-${Date.now()}`
- Returns: `{ planPipelineId, stageCount, totalCost }`

---

### Task 5: Add API routes

**Files:**
- Modify: `server/routes/broll.js`

Three new routes:

**`POST /api/broll/pipeline/run-all`**
- Body: `{ video_id, group_id }`
- Logic: load example videos, fire `executePlanPrep` + N analysis runs (`executePipeline` with `exampleVideoId`) concurrently
- All runs are fire-and-forget (don't await completion — return pipeline IDs immediately)
- Returns: `{ prepPipelineId, analysisPipelineIds: [...] }`

**`POST /api/broll/pipeline/run-strategies`**
- Body: `{ prep_pipeline_id, analysis_pipeline_ids: [...] }`
- Logic: for each analysis pipeline ID, fire `executeCreateStrategy(prepPipelineId, analysisPipelineId, videoId, groupId)` concurrently
- Returns: `{ strategyPipelineIds: [...] }`

**`POST /api/broll/pipeline/run-plan`**
- Body: `{ prep_pipeline_id, strategy_pipeline_id }`
- Logic: fire `executeCreatePlan(prepPipelineId, strategyPipelineId, videoId, groupId)`
- Returns: `{ planPipelineId }`

---

### Task 6: Verify end-to-end via API

Manual testing:

- [ ] Call `POST /api/broll/pipeline/run-all` with a group that has 2 reference videos
- [ ] Poll progress for prep + 2 analysis pipelines until all complete
- [ ] Call `POST /api/broll/pipeline/run-strategies` with the pipeline IDs
- [ ] Poll progress for 2 strategy pipelines until complete
- [ ] Call `POST /api/broll/pipeline/run-plan` with prep + one strategy pipeline ID
- [ ] Poll progress for plan pipeline until complete
- [ ] Verify `executeKeywords` works with the new plan pipeline ID
- [ ] Verify `getBRollEditorData` works with the new plan pipeline ID
