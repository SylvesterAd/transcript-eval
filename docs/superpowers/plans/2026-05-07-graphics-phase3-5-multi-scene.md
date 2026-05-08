# Motion Graphics — Phase 3.5: Multi-Scene Videos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a graphic to be a sequence of N scenes (each its own template/duration/text/assets), rendered independently and concatenated via ffmpeg into a final MP4. Each scene runs through its own critic loop. Brief LLM may produce `scenes: [...]` in the spec; if absent, the existing single-scene path is used (back-compat).

**Architecture:** Five additions:
1. **Schema** — `scene_index` on `graphics_render_iterations` (nullable); `scene_count` on `graphics_renders` (default 1).
2. **`isSpecComplete`** — accepts multi-scene specs.
3. **Brief prompt** — explains optional `scenes` array.
4. **`scene-concat.js`** — ffmpeg concat-demuxer helper.
5. **`renderHtml` + render-worker** — `renderHtml` accepts `subDir` (per-scene workdirs); render-worker branches on `spec.scenes`, runs each scene's critic loop, concatenates, uploads.

`critic-runner` gets a new optional `sceneIndex` arg (default null = single-scene). `html-generator`, `retry-prompt`, `uploader`, `orchestrator` are unchanged.

**Tech Stack:** Node 22, ffmpeg (already used by `video-processor.js`), Postgres, vitest. Models unchanged.

**Out of scope:** UI per-scene grouping (existing iteration history works with sceneIndex column), inter-scene transitions/crossfades (concat demuxer = hard cuts).

---

## File Structure

**Modified:**
- `server/db.js`
- `server/services/graphics/session-state.js` + tests
- `server/services/graphics/brief-prompt.js`
- `server/services/graphics/critic/critic-runner.js`
- `server/services/graphics/render-runner.js` + tests (subDir support)
- `server/services/graphics/render-worker.js` + tests

**Created:**
- `server/services/graphics/scene-concat.js` + tests

---

### Task 1: Schema migration

**Files:** `server/db.js`

- [ ] **Step 1: Locate the Phase 2 migration block**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-multi-scene"
grep -n "graphics_render_iterations\|critic columns ready" server/db.js
```

- [ ] **Step 2: Append migration lines**

In the SQL template-literal that creates iterations + adds iteration_count/final_score, add (just before the closing backtick):

```sql
ALTER TABLE graphics_render_iterations ADD COLUMN IF NOT EXISTS scene_index INTEGER;
ALTER TABLE graphics_renders ADD COLUMN IF NOT EXISTS scene_count INTEGER NOT NULL DEFAULT 1;
```

Update the log message to include "+ scene columns".

- [ ] **Step 3: Verify both columns exist**

```bash
export DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | cut -d= -f2-)"
node --input-type=module -e '
import db from "./server/db.js";
const r = await db.prepare(`SELECT column_name FROM information_schema.columns WHERE table_name = '\''graphics_render_iterations'\'' AND column_name = '\''scene_index'\''`).get();
console.log("scene_index:", r ? "EXISTS" : "MISSING");
const r2 = await db.prepare(`SELECT column_name FROM information_schema.columns WHERE table_name = '\''graphics_renders'\'' AND column_name = '\''scene_count'\''`).get();
console.log("scene_count:", r2 ? "EXISTS" : "MISSING");
process.exit(0);
'
```

Expected: both EXISTS.

- [ ] **Step 4: Commit**

```bash
git add server/db.js
git commit -m "feat(graphics): scene_index + scene_count columns"
```

---

### Task 2: `isSpecComplete` handles multi-scene

**Files:** `server/services/graphics/session-state.js` + `__tests__/session-state.test.js`

- [ ] **Step 1: Append failing tests**

Append to `server/services/graphics/__tests__/session-state.test.js`:

```js
describe('isSpecComplete (multi-scene)', () => {
  it('multi-scene complete', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    expect(isSpecComplete({
      aspectRatio: '16:9', tone: 'neutral',
      scenes: [
        { template: 'lower-third', duration: 3, mainText: 'A', subText: 'a' },
        { template: 'lower-third', duration: 5, mainText: 'B', subText: 'b' },
      ],
    })).toBe(true)
  })
  it('multi-scene incomplete: scene missing field', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    expect(isSpecComplete({
      aspectRatio: '16:9', tone: 'neutral',
      scenes: [{ template: 'lower-third', duration: 3, mainText: 'A' }],
    })).toBe(false)
  })
  it('multi-scene incomplete: top-level missing aspectRatio', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    expect(isSpecComplete({
      tone: 'neutral',
      scenes: [{ template: 'lower-third', duration: 3, mainText: 'A', subText: 'a' }],
    })).toBe(false)
  })
  it('single-scene back-compat', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    expect(isSpecComplete({
      template: 'lower-third', aspectRatio: '16:9', duration: 5,
      mainText: 'A', subText: 'a', tone: 'neutral',
    })).toBe(true)
  })
})
```

- [ ] **Step 2: Verify red, then implement**

```bash
npx vitest run server/services/graphics/__tests__/session-state.test.js
```

Expected: 3 multi-scene tests fail; single-scene passes.

- [ ] **Step 3: Replace `session-state.js`**

```js
// server/services/graphics/session-state.js
export const REQUIRED_FIELDS = [
  'template', 'aspectRatio', 'duration', 'mainText', 'subText', 'tone',
];
const SCENE_REQUIRED = ['template', 'duration', 'mainText', 'subText'];
const TOPLEVEL_FOR_SCENES = ['aspectRatio', 'tone'];

export function mergeSpec(current = {}, update = {}) {
  const out = { ...current };
  for (const [k, v] of Object.entries(update)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function isMultiScene(spec) {
  return Array.isArray(spec.scenes) && spec.scenes.length > 0;
}

export function isSpecComplete(spec) {
  if (isMultiScene(spec)) {
    if (!TOPLEVEL_FOR_SCENES.every((f) => spec[f] !== undefined && spec[f] !== null)) return false;
    return spec.scenes.every((sc) =>
      SCENE_REQUIRED.every((f) => sc[f] !== undefined && sc[f] !== null)
    );
  }
  return REQUIRED_FIELDS.every((f) => spec[f] !== undefined && spec[f] !== null);
}

export function missingFields(spec) {
  if (isMultiScene(spec)) {
    const missing = [];
    for (const f of TOPLEVEL_FOR_SCENES) {
      if (spec[f] === undefined || spec[f] === null) missing.push(f);
    }
    spec.scenes.forEach((sc, i) => {
      for (const f of SCENE_REQUIRED) {
        if (sc[f] === undefined || sc[f] === null) missing.push(`scenes[${i}].${f}`);
      }
    });
    return missing;
  }
  return REQUIRED_FIELDS.filter((f) => spec[f] === undefined || spec[f] === null);
}
```

- [ ] **Step 4: Verify green**

```bash
npx vitest run server/services/graphics/__tests__/session-state.test.js
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/session-state.js server/services/graphics/__tests__/session-state.test.js
git commit -m "feat(graphics): isSpecComplete handles multi-scene specs"
```

---

### Task 3: Brief prompt — `scenes` field

**Files:** `server/services/graphics/brief-prompt.js`

- [ ] **Step 1: Insert the scenes section**

In `BRIEF_SYSTEM_PROMPT`, find the assets section and add immediately after it (before "Rules:"):

```
  - scenes: array of scene objects for multi-scene graphics, format [{template, duration, mainText, subText, assets?}]
      Use this when the user wants a sequence of clips (e.g. "intro then main then outro").
      Each scene has its own template/duration/text and may have its own assets. Top-level
      aspectRatio + tone apply to all scenes. When scenes is present, top-level
      template/duration/mainText/subText are ignored. Defaults to single-scene (omit the field)
      unless the user requests a sequence.
```

- [ ] **Step 2: Sanity check**

```bash
node -e "import('./server/services/graphics/brief-prompt.js').then(m => console.log('scenes:', /scenes: array of scene objects/.test(m.BRIEF_SYSTEM_PROMPT)))"
```

Expected: `scenes: true`.

- [ ] **Step 3: Commit**

```bash
git add server/services/graphics/brief-prompt.js
git commit -m "feat(graphics): brief prompt teaches optional scenes[] field"
```

---

### Task 4: `scene-concat.js` ffmpeg helper

**Files:**
- Create: `server/services/graphics/scene-concat.js`
- Create: `server/services/graphics/__tests__/scene-concat.test.js`

ffmpeg concat-demuxer with `-c copy` (no re-encode). Manifest file lists inputs.

- [ ] **Step 1: Failing tests**

Create `server/services/graphics/__tests__/scene-concat.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => cb(null, { stdout: '', stderr: '' })),
}))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, writeFile: vi.fn().mockResolvedValue(undefined), mkdir: vi.fn().mockResolvedValue(undefined) }
})

describe('concatScenes', () => {
  it('writes manifest and runs ffmpeg concat', async () => {
    const { concatScenes } = await import('../scene-concat.js')
    const { writeFile } = await import('node:fs/promises')
    const cp = await import('node:child_process')
    const r = await concatScenes({ sceneMp4Paths: ['/tmp/r/s0.mp4', '/tmp/r/s1.mp4'], outputPath: '/tmp/r/final.mp4' })
    expect(r.outputPath).toBe('/tmp/r/final.mp4')
    const manifestCall = writeFile.mock.calls.find((c) => /\.txt$/.test(c[0]))
    expect(manifestCall[1]).toContain("file '/tmp/r/s0.mp4'")
    expect(manifestCall[1]).toContain("file '/tmp/r/s1.mp4'")
    const ffArgs = cp.execFile.mock.calls[0][1]
    expect(ffArgs).toEqual(expect.arrayContaining(['-f', 'concat', '-safe', '0', '-c', 'copy', '/tmp/r/final.mp4']))
  })
  it('throws on empty input', async () => {
    const { concatScenes } = await import('../scene-concat.js')
    await expect(concatScenes({ sceneMp4Paths: [], outputPath: '/tmp/x.mp4' })).rejects.toThrow(/at least one/i)
  })
})
```

- [ ] **Step 2: Verify red**

```bash
npx vitest run server/services/graphics/__tests__/scene-concat.test.js
```

Expected: module-not-found.

- [ ] **Step 3: Implement**

Create `server/services/graphics/scene-concat.js`:

```js
// server/services/graphics/scene-concat.js
//
// ffmpeg concat-demuxer helper. Concatenates N scene MP4s into one file
// without re-encoding (`-c copy`). Requires inputs to share codec/format,
// which Hyperframes' default H.264/AAC output guarantees.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const exec = promisify(execFile)

export async function concatScenes({ sceneMp4Paths, outputPath }) {
  if (!sceneMp4Paths || sceneMp4Paths.length === 0) {
    throw new Error('concatScenes: needs at least one scene mp4')
  }
  const outputDir = path.dirname(outputPath)
  await mkdir(outputDir, { recursive: true })
  const manifestPath = path.join(outputDir, 'concat-manifest.txt')
  const manifest = sceneMp4Paths.map((p) => `file '${p}'`).join('\n') + '\n'
  await writeFile(manifestPath, manifest, 'utf8')
  const start = Date.now()
  await exec(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', manifestPath, '-c', 'copy', outputPath],
    { timeout: 5 * 60 * 1000 }
  )
  return { durationMs: Date.now() - start, outputPath }
}
```

- [ ] **Step 4: Verify green**

```bash
npx vitest run server/services/graphics/__tests__/scene-concat.test.js
```

Expected: 2/2.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/scene-concat.js server/services/graphics/__tests__/scene-concat.test.js
git commit -m "feat(graphics): concatScenes — ffmpeg concat-demuxer helper"
```

---

### Task 5: `critic-runner` accepts `sceneIndex`

**Files:** `server/services/graphics/critic/critic-runner.js`

- [ ] **Step 1: Replace the file**

Full replacement (preserves all behavior; adds optional sceneIndex):

```js
// server/services/graphics/critic/critic-runner.js
import path from 'node:path'
import db from '../../../db.js'
import { extractFrames } from './frame-extractor.js'
import { evaluateFrames } from './evaluator.js'
import { uploadFrames } from '../uploader.js'
import { emit } from '../events/emitter.js'

const FRAME_COUNT = 4

export async function runCritic({ renderId, iterationIndex, mp4Path, durationSec, spec, sessionId, sceneIndex = null }) {
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders'
  const sceneSuffix = sceneIndex !== null ? `scene-${sceneIndex}-` : ''
  const frameDir = path.join(baseDir, String(renderId), `${sceneSuffix}iter-${iterationIndex}-frames`)

  const localFramePaths = await extractFrames({ mp4Path, durationSec, count: FRAME_COUNT, outDir: frameDir })
  emit({ sessionId, step: 'frames_captured', label: 'Frames captured', renderId, iteration: iterationIndex, sceneIndex })
  const frameUrls = await uploadFrames({ renderId, iterationIndex: `${sceneSuffix}${iterationIndex}`, framePaths: localFramePaths })
  const critique = await evaluateFrames({ framePaths: localFramePaths, spec })

  await db.prepare(
    `INSERT INTO graphics_render_iterations
       (render_id, iteration_index, scene_index, mp4_path, frame_urls_json, critic_score, critic_criteria_json, critic_feedback)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    renderId, iterationIndex, sceneIndex, mp4Path,
    JSON.stringify(frameUrls), critique.score,
    JSON.stringify(critique.criteria), critique.feedback
  )

  return {
    score: critique.score, criteria: critique.criteria,
    feedback: critique.feedback, retry_recommended: critique.retry_recommended,
    frameUrls, tokens: critique.tokens,
  }
}
```

- [ ] **Step 2: Run critic tests**

```bash
npx vitest run server/services/graphics/critic/__tests__/
```

Expected: existing tests pass (sceneIndex defaults to null; INSERT writes NULL into the new column).

- [ ] **Step 3: Commit**

```bash
git add server/services/graphics/critic/critic-runner.js
git commit -m "feat(graphics): critic-runner accepts optional sceneIndex"
```

---

### Task 6: `renderHtml` accepts `subDir`

**Files:** `server/services/graphics/render-runner.js` + `__tests__/render-runner.test.js`

Multi-scene needs per-scene workdirs.

- [ ] **Step 1: Append failing test**

```js
  it('renderHtml writes to subDir when provided', async () => {
    process.env.GRAPHICS_RENDER_DIR = '/tmp/test-renders';
    const { renderHtml } = await import('../render-runner.js');
    const html = '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>';
    const result = await renderHtml({ html, renderId: 88, subDir: 'scene-0' });
    expect(result.outputPath).toContain('/tmp/test-renders/88/scene-0/out.mp4');
    expect(result.workDir).toContain('/scene-0');
  });
```

- [ ] **Step 2: Verify red**

```bash
npx vitest run server/services/graphics/__tests__/render-runner.test.js
```

- [ ] **Step 3: Add `subDir` param to `renderHtml`**

Update signature: `export async function renderHtml({ html, renderId, fps = 30, quality = 'standard', subDir = null }) {`

Replace `const workDir = path.join(baseDir, String(renderId));` with:
```js
const workDir = subDir
  ? path.join(baseDir, String(renderId), subDir)
  : path.join(baseDir, String(renderId));
```

- [ ] **Step 4: Verify green**

```bash
npx vitest run server/services/graphics/__tests__/render-runner.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/render-runner.js server/services/graphics/__tests__/render-runner.test.js
git commit -m "feat(graphics): renderHtml accepts optional subDir"
```

---

### Task 7: Render-worker multi-scene branch

**Files:** `server/services/graphics/render-worker.js` + `__tests__/render-worker.test.js`

Refactor: extract the per-scene critic-loop into a helper. `drainOnce` branches on `spec.scenes`. For multi-scene, run helper N times (each with sceneIndex + subDir), concat, upload, mark complete.

- [ ] **Step 1: Extract `runSceneCriticLoop` helper**

Refactor `render-worker.js` so the existing critic-loop body becomes a local helper:

```js
async function runSceneCriticLoop({ renderId, sessionId, sceneSpec, sceneIndex = null }) {
  const subDir = sceneIndex !== null ? `scene-${sceneIndex}` : null;
  let totalCost = 0;
  const { html: initialHtml, cost } = await specToHtml({ spec: sceneSpec });
  totalCost += cost;
  let currentHtml = initialHtml;
  let currentResult = await renderHtml({ html: currentHtml, renderId, subDir });
  let currentUpload = await uploadRender({ renderId, sessionId, localPath: currentResult.outputPath });
  let bestAttempt = null;
  let iteration = 1;
  let totalDurationMs = currentResult.durationMs;

  while (iteration <= MAX_ITERATIONS) {
    const critique = await runCritic({
      renderId, iterationIndex: iteration, sceneIndex,
      mp4Path: currentResult.outputPath,
      durationSec: sceneSpec.duration || 5,
      spec: sceneSpec, sessionId,
    });
    emit({ sessionId, step: 'critic_scored', label: `Critic score ${critique.score.toFixed(2)} (iter ${iteration})`, renderId, iteration, score: critique.score, sceneIndex });
    const attempt = { iteration, score: critique.score, mp4Path: currentResult.outputPath, upload: currentUpload, durationMs: currentResult.durationMs };
    if (!bestAttempt || attempt.score > bestAttempt.score) bestAttempt = attempt;
    if (!critique.retry_recommended || critique.score >= SCORE_THRESHOLD) break;
    if (iteration >= MAX_ITERATIONS) break;

    emit({ sessionId, step: 'retry_triggered', label: `Refining (iter ${iteration + 1})`, renderId, sceneIndex });
    const retrySys = buildRetryPrompt({ priorCritique: critique, priorHtml: currentHtml });
    const retryResp = await callAnthropic({
      model: MODEL_FOR.create, system: retrySys,
      messages: [{ role: 'user', content: `Spec:\n${JSON.stringify(sceneSpec)}` }],
      max_tokens: 4096,
    });
    const retryHtml = retryResp.text.trim()
      .replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '').trim();
    if (!/data-composition-id\s*=\s*"main"/i.test(retryHtml)) {
      throw new Error('retry creator returned HTML missing data-composition-id="main"');
    }
    currentHtml = retryHtml;
    iteration += 1;
    currentResult = await renderHtml({ html: currentHtml, renderId, subDir });
    totalDurationMs += currentResult.durationMs;
    currentUpload = await uploadRender({ renderId, sessionId, localPath: currentResult.outputPath });
  }

  return {
    bestMp4Path: bestAttempt.mp4Path,
    bestUpload: bestAttempt.upload,
    bestScore: bestAttempt.score,
    totalIterations: iteration,
    totalDurationMs,
    cost: totalCost,
  };
}
```

- [ ] **Step 2: Replace the inline loop in `drainOnce` with calls to the helper**

In `drainOnce`, replace the existing critic-loop block with:

```js
let bestAttempt;
let iteration;
let totalDurationMs;
let cost;

if (Array.isArray(row.spec_snapshot_json.scenes) && row.spec_snapshot_json.scenes.length > 0) {
  // Multi-scene path
  const topLevel = row.spec_snapshot_json;
  const sceneResults = [];
  let aggregateCost = 0;
  for (let i = 0; i < topLevel.scenes.length; i++) {
    const sceneSpec = { ...topLevel, ...topLevel.scenes[i] };
    delete sceneSpec.scenes;
    const r = await runSceneCriticLoop({ renderId: row.id, sessionId: row.session_id, sceneSpec, sceneIndex: i });
    sceneResults.push(r);
    aggregateCost += r.cost;
  }
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders';
  const finalLocalPath = path.join(baseDir, String(row.id), 'final.mp4');
  await concatScenes({ sceneMp4Paths: sceneResults.map((r) => r.bestMp4Path), outputPath: finalLocalPath });
  const finalUpload = await uploadRender({ renderId: row.id, sessionId: row.session_id, localPath: finalLocalPath });
  const finalScore = Math.min(...sceneResults.map((r) => r.bestScore));
  const totalIters = sceneResults.reduce((s, r) => s + r.totalIterations, 0);
  const totalDuration = sceneResults.reduce((s, r) => s + r.totalDurationMs, 0);
  await db.transaction(async (tx) => {
    await tx.prepare(
      `UPDATE graphics_renders
       SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
           iteration_count = ?, final_score = ?, scene_count = ?
       WHERE id = ?`
    ).run(finalUpload.url, totalDuration, aggregateCost, totalIters, finalScore, topLevel.scenes.length, row.id);
    await tx.prepare(`UPDATE graphics_sessions SET status = 'iterating' WHERE id = ?`).run(row.session_id);
  });
  emit({ sessionId: row.session_id, step: 'render_complete', label: 'Done', renderId: row.id, finalScore });
  processed += 1;
  continue;
}

// Single-scene path (existing behavior)
const r = await runSceneCriticLoop({ renderId: row.id, sessionId: row.session_id, sceneSpec: row.spec_snapshot_json, sceneIndex: null });
bestAttempt = { upload: r.bestUpload, score: r.bestScore, durationMs: r.totalDurationMs };
iteration = r.totalIterations;
cost = r.cost;
totalDurationMs = r.totalDurationMs;
```

The single-scene completion-write block (existing UPDATE that sets status='complete' etc.) stays unchanged BELOW this — it uses `bestAttempt`, `iteration`, `cost` already.

Add `import { concatScenes } from './scene-concat.js';` and `import path from 'node:path';` at the top (path may already be imported via render-runner — check; if not, add).

- [ ] **Step 3: Update render-worker test to mock new modules + add multi-scene test**

In `server/services/graphics/__tests__/render-worker.test.js`:
1. Add mock for `../scene-concat.js`: `vi.mock('../scene-concat.js', () => ({ concatScenes: vi.fn().mockResolvedValue({ durationMs: 50, outputPath: '/tmp/final.mp4' }) }))`
2. Existing single-scene test should still pass (back-compat).
3. Add a new test asserting that when `spec.scenes` is non-empty, `specToHtml` and `renderHtml` are each called N times, `concatScenes` is called once with N paths, and `uploadRender` is called for the final concatenated MP4.

```js
  it('multi-scene: renders each scene then concatenates', async () => {
    // arrange: row with spec.scenes [{...}, {...}]
    // (refer to existing test for db mock setup; override spec_snapshot_json to include scenes array)
    // act: drainOnce()
    // assert: specToHtml called 2x, renderHtml called 2x, concatScenes called 1x with 2 paths,
    //         uploadRender called for final.mp4, status update sets scene_count=2.
  });
```

(The implementer should adapt the existing test fixtures — copy the single-scene test, modify the row's spec to have `scenes`, and verify call counts.)

- [ ] **Step 4: Run render-worker tests**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/render-worker.js server/services/graphics/__tests__/render-worker.test.js
git commit -m "feat(graphics): render-worker handles multi-scene specs"
```

---

### Task 8: Verify suite

**Files:** none.

- [ ] **Step 1: Run all graphics tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-multi-scene"
export DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | cut -d= -f2-)"
npx vitest run server/services/graphics/ server/lib/llm/ server/routes/__tests__/graphics.test.js
```

Expected: green or no NEW failures vs. parent branch (the same `integration-flow.test.js` flake from 3.1/3.2/3.4-A/3.4-B may persist).

---

### Task 9: Live multi-scene smoke

**Files:** none.

- [ ] **Step 1: Source env**

```bash
export $(grep -E '^(GOOGLE_API_KEY|ANTHROPIC_API_KEY|DATABASE_URL)=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | xargs)
```

- [ ] **Step 2: Drive a 2-scene render via the worker (most realistic)**

Insert a fake render row directly with a 2-scene spec, then invoke `drainOnce` once:

```bash
node --input-type=module -e '
import db from "./server/db.js";
import { drainOnce } from "./server/services/graphics/render-worker.js";

// Create a stub session + render
const session = await db.prepare(
  `INSERT INTO graphics_sessions (user_id, user_email, title, status) VALUES ($1, $2, $3, $4) RETURNING id`
).get("smoke-user", "smoke@test", "3.5 smoke", "rendering");

const spec = {
  aspectRatio: "16:9",
  tone: "neutral",
  scenes: [
    { template: "lower-third", duration: 3, mainText: "Scene A", subText: "first scene" },
    { template: "lower-third", duration: 3, mainText: "Scene B", subText: "second scene" },
  ],
};
const render = await db.prepare(
  `INSERT INTO graphics_renders (session_id, iteration, spec_snapshot_json, template, status)
   VALUES ($1, 1, $2, $3, $4) RETURNING id`
).get(session.id, JSON.stringify(spec), "lower-third", "queued");

console.log("queued render", render.id, "for session", session.id);

const r = await drainOnce();
console.log("drained:", JSON.stringify(r));

const final = await db.prepare(`SELECT id, status, output_url, scene_count, iteration_count, final_score FROM graphics_renders WHERE id = $1`).get(render.id);
console.log("final state:", JSON.stringify(final, null, 2));

const iters = await db.prepare(`SELECT iteration_index, scene_index, critic_score FROM graphics_render_iterations WHERE render_id = $1 ORDER BY scene_index, iteration_index`).all(render.id);
console.log("iterations:", JSON.stringify(iters, null, 2));

process.exit(0);
'
```

Expected:
- `drained: {"processed":1,"errors":[]}`
- `final.status === "complete"`
- `final.output_url` is a Supabase signed URL
- `final.scene_count === 2`
- `final.iteration_count >= 2` (one per scene minimum)
- `iters` has rows with `scene_index` 0 and 1

If the smoke fails (worker throws), surface the error and the partial state. Most likely failure modes: hyperframes not available, ffmpeg failing (codec mismatch), spec validation reject.

- [ ] **Step 3: Curl the final URL**

```bash
curl -sI "<output_url>" | head -5
```

Expected: 200 with `content-type: video/mp4`.

- [ ] **Step 4: DO NOT PUSH**

Per durable feedback. Surface results to user.

---

## Self-Review (controller)

**Spec coverage:**
- ✅ Schema additions (Task 1)
- ✅ Spec validation (Task 2)
- ✅ Brief-prompt teaches scenes (Task 3)
- ✅ ffmpeg concat helper (Task 4)
- ✅ Critic per-scene (Task 5)
- ✅ Per-scene workdirs (Task 6)
- ✅ Render-worker branches on spec.scenes (Task 7)
- ✅ Suite + live smoke (Tasks 8-9)

**Placeholder scan:** Task 7 Step 3 leaves the multi-scene render-worker test sketch open-ended (the implementer adapts existing fixtures). This is the only place a subagent might need to make a judgement call; everything else has full code.

**Type consistency:**
- `runSceneCriticLoop` returns `{ bestMp4Path, bestUpload, bestScore, totalIterations, totalDurationMs, cost }` — used by both single-scene and multi-scene paths
- `concatScenes({ sceneMp4Paths, outputPath })` returns `{ durationMs, outputPath }`
- `runCritic({ ..., sceneIndex = null })` defaults preserve back-compat
- `renderHtml({ ..., subDir = null })` defaults preserve back-compat

**Risks called out:**
- Hyperframes' default H.264 output may have variable params per render (e.g. different durations affect GOP). `-c copy` requires consistent codec params — if scenes 0 and 1 have different durations or aspect ratios within the same render, ffmpeg concat MAY emit warnings or fail. Mitigation: top-level aspectRatio is forced to apply to all scenes (D1 in brainstorm); duration varies per scene but ffmpeg handles that fine. If concat fails in smoke (Task 9), fall back to `-c:v libx264 -c:a aac` re-encode (slower but always works).
- Per-scene cost: a 3-scene multi-scene render = 3 × Opus calls + 3 × hyperframes + 3 × critic. ~$0.33 × 3 = $1.00 per render. Not negligible. User-visible cost surfacing may matter eventually.
- Existing `integration-flow.test.js` failure may finally need fixing, since adding `scene_count` to the renders table changes the row shape. Verify in Task 8.
