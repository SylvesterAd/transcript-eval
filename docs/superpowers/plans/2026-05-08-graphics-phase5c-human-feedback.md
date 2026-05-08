# Graphics Phase 5C — Human-Feedback Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist canonical HTML on every render and let users iterate on a completed render via natural-language chat (refineHtml against parent's final_html_text + spec).

**Architecture:** Three additive columns on `graphics_renders` (`parent_render_id`, `final_html_text`, `human_feedback`). Worker thread `bestHtml` through critic loop and writes `final_html_text` on completion. When `claimNextRender` returns a row with `parent_render_id`, the worker calls `refineHtml(parent_html, human_feedback, spec)` instead of `specToHtml`. Orchestrator branches on `session.status='iterating'`, bypasses the brief LLM, and enqueues a refine render off the latest complete parent. Cap at `MAX_ITERATIONS_PER_SESSION=10` total renders per session.

**Tech Stack:** Node.js (ESM), Postgres (via `pg.Pool` in `server/db.js`), vitest mocks via `vi.mock` factory pattern.

**Spec:** [docs/superpowers/specs/2026-05-08-graphics-phase5c-human-feedback-design.md](../specs/2026-05-08-graphics-phase5c-human-feedback-design.md)

---

## File Structure

| File | Responsibility | Operation |
|---|---|---|
| `server/db.js` | Postgres schema + idempotent migrations | Modify (insert one `pool.query` block after the existing `DROP COLUMN IF EXISTS scene_index` migration around line 337) |
| `server/services/graphics/render-worker.js` | Drain loop; per-render flow; refine/fresh branch; persist HTML | Modify (~80 LOC delta) |
| `server/services/graphics/orchestrator.js` | Chat turn dispatch; brief vs iterating branch | Modify (~60 LOC delta) |
| `server/routes/graphics.js` | Read-only endpoint surface | Modify (extend two SELECTs) |
| `server/services/graphics/__tests__/render-worker.test.js` | Worker unit tests | Modify (add ~6 tests) |
| `server/services/graphics/__tests__/orchestrator.test.js` | Orchestrator unit tests | Modify (add ~3 tests) |

No file creations, no deletions, no moves. All changes additive at the line level.

---

## Task 1: Schema migration

**Files:**
- Modify: `server/db.js` (insert after the existing "dropped scene_index" migration block — currently around line 337)

- [ ] **Step 1: Locate insertion point**

```bash
grep -n "dropped scene_index from graphics_render_iterations" server/db.js
```
Expected: one match around line 337 — the `console.log` after the DROP COLUMN block. Insert your new `pool.query` immediately after that line, BEFORE the closing `} catch {}` of the migrations try-block.

- [ ] **Step 2: Add the migration block**

Insert this code after the existing `console.log('[migrate] dropped scene_index from graphics_render_iterations')`:

```js
    // Phase 5C: human-feedback persistence — parent_render_id (lineage),
    // final_html_text (durable HTML), human_feedback (verbatim user message)
    await pool.query(`
      ALTER TABLE graphics_renders
        ADD COLUMN IF NOT EXISTS parent_render_id INTEGER REFERENCES graphics_renders(id),
        ADD COLUMN IF NOT EXISTS final_html_text  TEXT,
        ADD COLUMN IF NOT EXISTS human_feedback   TEXT;
      CREATE INDEX IF NOT EXISTS idx_graphics_renders_parent
        ON graphics_renders(parent_render_id);
    `);
    console.log('[migrate] graphics_renders human-feedback columns ready')
```

- [ ] **Step 3: Verify the file boots without syntax error**

```bash
node -e "import('./server/db.js').then(() => console.log('OK')).catch(e => { console.error('FAIL', e.message); process.exit(1) })" 2>&1 | tail -5
```
Expected: either `OK` (if `DATABASE_URL` is set in env) or a clean `FAIL` with a `DATABASE_URL` error (NOT a SyntaxError). Anything other than those two outcomes means the edit is broken.

If `DATABASE_URL` isn't set, this is fine — the import will fail at the env check at the top of db.js, but BEFORE reaching the migration block, which means the migration code is at least syntactically valid.

- [ ] **Step 4: Run all tests to confirm no regression**

```bash
npm test -- server/services/graphics 2>&1 | tail -10
```
Expected: `Test Files 12 passed | 4 skipped (16) ... Tests 92 passed | 7 skipped (99)` — same as baseline. Migration is additive, no test should care.

- [ ] **Step 5: Commit**

```bash
git add server/db.js
git commit -m "feat(graphics): add parent_render_id, final_html_text, human_feedback columns

Phase 5C schema for human-feedback iteration. Additive, idempotent
ALTER TABLE; no backfill required (existing complete renders simply
have NULL final_html_text — they are only iterable AFTER the worker
starts persisting HTML on completion in a follow-up task)."
```

---

## Task 2: Worker — thread `bestHtml` and persist `final_html_text` on completion

**Files:**
- Modify: `server/services/graphics/render-worker.js` (lines around 88–132 for `runCriticLoop`; lines around 144–152 for the completion UPDATE)
- Modify: `server/services/graphics/__tests__/render-worker.test.js` (add one new test)

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `server/services/graphics/__tests__/render-worker.test.js` (at the end of the file):

```js
describe('renderWorker.drainOnce — final_html_text persistence', () => {
  it('writes the final HTML into the completion UPDATE', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 200, session_id: 's-200', iteration: 1, template: 'lower-third',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    const { runLint } = await import('../lint-runner.js')
    const { renderHtml } = await import('../render-runner.js')
    const { runCritic } = await import('../critic/critic-runner.js')
    const { uploadRender } = await import('../uploader.js')

    runLint.mockReset()
    runLint.mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] })
    specToHtml.mockClear()
    specToHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="5">FINAL_HTML_MARKER</div></body></html>',
      cost: 1, tokens: { in: 100, out: 100 },
    })
    refineHtml.mockClear()
    renderHtml.mockClear()
    renderHtml.mockResolvedValue({ outputPath: '/tmp/x.mp4', durationMs: 1000 })
    uploadRender.mockClear()
    uploadRender.mockResolvedValue({ url: 'http://supa/x.mp4' })
    runCritic.mockReset()
    runCritic.mockResolvedValue({
      score: 0.9, criteria: {}, feedback: 'good',
      retry_recommended: false, frameUrls: [], tokens: { in: 0, out: 0 },
    })

    const prepareSpy = vi.spyOn(db, 'prepare')
    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    const sqls = prepareSpy.mock.calls.map((c) => c[0])
    const completionUpdate = sqls.find(
      (s) => /UPDATE graphics_renders/.test(s) && /status\s*=\s*'complete'/.test(s)
    )
    expect(completionUpdate).toBeDefined()
    expect(completionUpdate).toMatch(/final_html_text\s*=\s*\?/)
    prepareSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js -t "final_html_text persistence" 2>&1 | tail -15
```
Expected: FAIL — the test should fail because the current completion UPDATE does NOT include `final_html_text`.

- [ ] **Step 3: Modify `runCriticLoop` to track `bestHtml`**

In `server/services/graphics/render-worker.js`, locate the line:
```js
const attempt = { iteration, score: critique.score, mp4Path: currentResult.outputPath, upload: currentUpload, durationMs: currentResult.durationMs }
```
Change it to:
```js
const attempt = { iteration, score: critique.score, mp4Path: currentResult.outputPath, upload: currentUpload, durationMs: currentResult.durationMs, html: currentHtml }
```

Then locate the `return { ... }` at the end of `runCriticLoop`:
```js
return {
  bestMp4Path: bestAttempt.mp4Path,
  bestUpload: bestAttempt.upload,
  bestScore: bestAttempt.score,
  totalIterations: iteration,
  totalDurationMs,
  cost: totalCost,
}
```
Replace it with:
```js
return {
  bestMp4Path: bestAttempt.mp4Path,
  bestUpload: bestAttempt.upload,
  bestScore: bestAttempt.score,
  bestHtml: bestAttempt.html,
  totalIterations: iteration,
  totalDurationMs,
  cost: totalCost,
}
```

- [ ] **Step 4: Modify the completion UPDATE in `drainOnce`**

In `server/services/graphics/render-worker.js`, locate the completion UPDATE:
```js
await tx.prepare(
  `UPDATE graphics_renders
   SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
       iteration_count = ?, final_score = ?, scene_count = ?
   WHERE id = ?`
).run(r.bestUpload.url, r.totalDurationMs, r.cost, r.totalIterations, r.bestScore, sceneCount, row.id)
```

Replace with:
```js
await tx.prepare(
  `UPDATE graphics_renders
   SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
       iteration_count = ?, final_score = ?, scene_count = ?, final_html_text = ?
   WHERE id = ?`
).run(r.bestUpload.url, r.totalDurationMs, r.cost, r.totalIterations, r.bestScore, sceneCount, r.bestHtml, row.id)
```

- [ ] **Step 5: Run the new test — should pass**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js -t "final_html_text persistence" 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 6: Run all worker tests — make sure nothing else broke**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js 2>&1 | tail -15
```
Expected: all tests pass (8 existing + 1 new = 9 tests).

- [ ] **Step 7: Commit**

```bash
git add server/services/graphics/render-worker.js server/services/graphics/__tests__/render-worker.test.js
git commit -m "feat(graphics): persist final_html_text on render completion

Track currentHtml as part of bestAttempt and thread it back through
runCriticLoop's return shape as bestHtml. Completion UPDATE now writes
final_html_text alongside output_url, enabling Phase 5C iteration off
the canonical HTML."
```

---

## Task 3: Worker — extend `claimNextRender` SELECT

**Files:**
- Modify: `server/services/graphics/render-worker.js` (lines around 69–84 for `claimNextRender`)

This is wire-only: extend the SELECT to return new columns, and propagate them into `runCriticLoop`'s call site. No behavior change yet (the new params are accepted as defaults until Task 4 wires the branch).

- [ ] **Step 1: Modify `claimNextRender`**

In `server/services/graphics/render-worker.js`, locate:
```js
async function claimNextRender() {
  return await db
    .prepare(
      `UPDATE graphics_renders
       SET status = 'running'
       WHERE id = (
         SELECT id FROM graphics_renders
         WHERE status = 'queued'
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, session_id, iteration, spec_snapshot_json, template`
    )
    .get()
}
```

Replace the `RETURNING` clause:
```js
       RETURNING id, session_id, iteration, spec_snapshot_json, template, parent_render_id, human_feedback`
```

- [ ] **Step 2: Modify `runCriticLoop` signature**

Locate:
```js
async function runCriticLoop({ renderId, sessionId, spec }) {
```
Replace with:
```js
async function runCriticLoop({ renderId, sessionId, spec, parentRenderId = null, humanFeedback = null }) {
```

(The new parameters are unused for now — Task 4 wires them into the branch logic.)

- [ ] **Step 3: Modify `drainOnce` to pass the new fields**

In `drainOnce`, locate the call to `runCriticLoop`:
```js
const r = await runCriticLoop({ renderId: row.id, sessionId: row.session_id, spec })
```
Replace with:
```js
const r = await runCriticLoop({
  renderId: row.id,
  sessionId: row.session_id,
  spec,
  parentRenderId: row.parent_render_id ?? null,
  humanFeedback: row.human_feedback ?? null,
})
```

- [ ] **Step 4: Run all worker tests — must still pass (wire-only change, no behavior)**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js 2>&1 | tail -10
```
Expected: 9 tests pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/render-worker.js
git commit -m "feat(graphics): plumb parent_render_id + human_feedback into runCriticLoop

claimNextRender SELECT now returns the new columns; runCriticLoop
accepts parentRenderId/humanFeedback params (unused — Task 4 wires
the refine-from-parent branch)."
```

---

## Task 4: Worker — refine-from-parent branch in `runCriticLoop`

**Files:**
- Modify: `server/services/graphics/render-worker.js` (top of `runCriticLoop`)
- Modify: `server/services/graphics/__tests__/render-worker.test.js` (add new describe block)

- [ ] **Step 1: Write the failing test for the refine path**

Append to `server/services/graphics/__tests__/render-worker.test.js`:

```js
describe('renderWorker.drainOnce — refine-from-parent path', () => {
  it('uses refineHtml(parent_final_html, human_feedback, spec) when parent_render_id is set', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      // 1st call: claimNextRender returns a row with parent_render_id set
      .mockResolvedValueOnce({
        id: 300, session_id: 's-300', iteration: 2, template: 'lower-third',
        parent_render_id: 200,
        human_feedback: 'make the title bigger',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      // 2nd call: parent lookup returns parent's final_html_text
      .mockResolvedValueOnce({
        final_html_text: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="5">PARENT</div></body></html>',
      })
      // subsequent calls: queue empty
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    const { runLint } = await import('../lint-runner.js')
    const { renderHtml } = await import('../render-runner.js')
    const { runCritic } = await import('../critic/critic-runner.js')
    const { uploadRender } = await import('../uploader.js')

    specToHtml.mockClear()
    refineHtml.mockClear()
    refineHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="5">REFINED</div></body></html>',
      cost: 2, tokens: { in: 200, out: 300 },
    })
    runLint.mockReset()
    runLint.mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] })
    renderHtml.mockClear()
    renderHtml.mockResolvedValue({ outputPath: '/tmp/x.mp4', durationMs: 1000 })
    uploadRender.mockClear()
    uploadRender.mockResolvedValue({ url: 'http://supa/x.mp4' })
    runCritic.mockReset()
    runCritic.mockResolvedValue({
      score: 0.9, criteria: {}, feedback: 'good',
      retry_recommended: false, frameUrls: [], tokens: { in: 0, out: 0 },
    })

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    expect(result.errors).toHaveLength(0)
    // The refine path bypasses specToHtml entirely
    expect(specToHtml).not.toHaveBeenCalled()
    // refineHtml gets called with parent's HTML + user feedback + spec
    expect(refineHtml).toHaveBeenCalledTimes(1)
    const refineCall = refineHtml.mock.calls[0][0]
    expect(refineCall.html).toMatch(/PARENT/)
    expect(refineCall.feedback).toBe('make the title bigger')
    expect(refineCall.spec.template).toBe('lower-third')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js -t "refine-from-parent path" 2>&1 | tail -15
```
Expected: FAIL — `specToHtml` is still being called for every render.

- [ ] **Step 3: Implement the branch in `runCriticLoop`**

In `server/services/graphics/render-worker.js`, locate the current top of `runCriticLoop`:
```js
async function runCriticLoop({ renderId, sessionId, spec, parentRenderId = null, humanFeedback = null }) {
  let totalCost = 0
  const { html: initialHtml, cost } = await generateHtmlWithLintGate({ spec, renderId })
  totalCost += cost
  let currentHtml = initialHtml
  let currentResult = await renderHtml({ html: currentHtml, renderId })
```

Replace the body up to and including `let currentHtml = initialHtml` with:
```js
async function runCriticLoop({ renderId, sessionId, spec, parentRenderId = null, humanFeedback = null }) {
  let totalCost = 0
  let initialHtml

  if (parentRenderId) {
    const parent = await db
      .prepare(`SELECT final_html_text FROM graphics_renders WHERE id = ?`)
      .get(parentRenderId)
    if (!parent || !parent.final_html_text) {
      throw new Error(`parent render ${parentRenderId} missing final_html_text`)
    }
    if (!humanFeedback) {
      throw new Error(`render ${renderId} has parent_render_id but no human_feedback`)
    }
    const refined = await refineHtml({ html: parent.final_html_text, feedback: humanFeedback, spec })
    initialHtml = refined.html
    totalCost += refined.cost
    // Lint once on the refined HTML — no retry on this path. If the LLM produced
    // broken HTML for human feedback, surface the error rather than synthesizing.
    const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders'
    const lintProjectDir = path.join(baseDir, String(renderId), 'lint')
    await mkdir(lintProjectDir, { recursive: true })
    await writeFile(path.join(lintProjectDir, 'index.html'), initialHtml, 'utf8')
    const lint = await runLint({ projectDir: lintProjectDir })
    if (lint.errorCount > 0) {
      throw new Error(`refined HTML failed lint: ${formatFindingsForPrompt(lint.findings)}`)
    }
  } else {
    const fresh = await generateHtmlWithLintGate({ spec, renderId })
    initialHtml = fresh.html
    totalCost += fresh.cost
  }

  let currentHtml = initialHtml
  let currentResult = await renderHtml({ html: currentHtml, renderId })
```

(Everything from `let currentResult = ...` onward in `runCriticLoop` stays unchanged.)

- [ ] **Step 4: Run the new test — should pass**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js -t "refine-from-parent path" 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 5: Run all worker tests — no regressions**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js 2>&1 | tail -15
```
Expected: 10 tests pass (9 from before + 1 new).

- [ ] **Step 6: Commit**

```bash
git add server/services/graphics/render-worker.js server/services/graphics/__tests__/render-worker.test.js
git commit -m "feat(graphics): refine-from-parent path in runCriticLoop

When parent_render_id is set on a queued render, load parent's
final_html_text and call refineHtml(parent_html, human_feedback, spec)
instead of specToHtml. Lint once on the refined output — no retry on
the human-feedback path; broken HTML surfaces as a render failure."
```

---

## Task 5: Worker — error tests for refine path

**Files:**
- Modify: `server/services/graphics/__tests__/render-worker.test.js` (add 3 new tests in the existing "refine-from-parent path" describe block)

These tests prove the error handling already implemented in Task 4. Each one drains a queued row that should fail and verifies `result.errors` captures it.

- [ ] **Step 1: Add three failure-case tests**

Insert these `it` blocks INSIDE the existing `describe('renderWorker.drainOnce — refine-from-parent path', ...)` block from Task 4:

```js
  it('marks render failed when parent has no final_html_text', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 301, session_id: 's-301', iteration: 2, template: 'lower-third',
        parent_render_id: 201,
        human_feedback: 'change something',
        spec_snapshot_json: { template: 'lower-third', mainText: 'X', subText: 'Y', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValueOnce({ final_html_text: null })
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    specToHtml.mockClear(); refineHtml.mockClear()

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()
    expect(result.processed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toMatch(/missing final_html_text/i)
    expect(refineHtml).not.toHaveBeenCalled()
  })

  it('marks render failed when human_feedback is missing despite parent_render_id', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 302, session_id: 's-302', iteration: 2, template: 'lower-third',
        parent_render_id: 202,
        human_feedback: null,
        spec_snapshot_json: { template: 'lower-third', mainText: 'X', subText: 'Y', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValueOnce({ final_html_text: '<!doctype html><div data-composition-id="main">P</div>' })
      .mockResolvedValue(null)

    const { refineHtml } = await import('../html-generator.js')
    refineHtml.mockClear()

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()
    expect(result.processed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toMatch(/no human_feedback/i)
    expect(refineHtml).not.toHaveBeenCalled()
  })

  it('marks render failed when refined HTML fails lint (no retry on this path)', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 303, session_id: 's-303', iteration: 2, template: 'lower-third',
        parent_render_id: 203,
        human_feedback: 'something',
        spec_snapshot_json: { template: 'lower-third', mainText: 'X', subText: 'Y', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValueOnce({
        final_html_text: '<!doctype html><div data-composition-id="main">P</div>',
      })
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    const { runLint } = await import('../lint-runner.js')
    const { renderHtml } = await import('../render-runner.js')
    specToHtml.mockClear()
    refineHtml.mockClear()
    refineHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div data-composition-id="main">USES_MATH_RANDOM</div></body></html>',
      cost: 1, tokens: { in: 50, out: 50 },
    })
    runLint.mockReset()
    runLint.mockResolvedValue({
      errorCount: 1, warningCount: 0, infoCount: 0,
      findings: [{ severity: 'error', rule: 'determinism', message: 'Math.random' }],
    })
    renderHtml.mockClear()

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()
    expect(result.processed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toMatch(/refined HTML failed lint/i)
    // refine was called once; lint was called ONCE (no retry); renderHtml never reached
    expect(refineHtml).toHaveBeenCalledTimes(1)
    expect(runLint).toHaveBeenCalledTimes(1)
    expect(renderHtml).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the new tests**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js -t "refine-from-parent path" 2>&1 | tail -20
```
Expected: 4 tests pass (the happy path from Task 4 + 3 new failure cases). All assertions should pass — the worker code already implements these checks (see Task 4 step 3).

- [ ] **Step 3: Run all worker tests**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js 2>&1 | tail -15
```
Expected: 13 tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/services/graphics/__tests__/render-worker.test.js
git commit -m "test(graphics): refine-from-parent failure paths

Cover the three error branches added in Task 4:
- parent missing final_html_text
- human_feedback null despite parent_render_id set
- refined HTML fails lint (no retry on human-feedback path)"
```

---

## Task 6: Orchestrator — `MAX_ITERATIONS_PER_SESSION` constant + iterating-mode happy path

**Files:**
- Modify: `server/services/graphics/orchestrator.js` (add constant near top; add status branch in `runChatTurn`)
- Modify: `server/services/graphics/__tests__/orchestrator.test.js` (enhance db mock; add iterating-mode test)

- [ ] **Step 1: Enhance the orchestrator test mock to dispatch by SQL**

The existing `vi.mock('../../../db.js', ...)` returns the same `prepareMock` for every SQL string. **Replace BOTH** the existing `vi.mock('../../../db.js', ...)` block (lines 17–30 currently) AND the existing `beforeEach(() => { process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test'; });` block (lines 32–34 currently) with this SQL-aware variant:

```js
// Correction #2: db.js default export — mock with { default: { prepare, transaction } }
// SQL-aware dispatch lets iterating-mode tests stub specific queries.
const dbState = {
  loadSessionResult: { id: 1, spec_json: {}, status: 'briefing' },
  loadHistoryResult: [],
  parentResult: null,            // graphics_renders parent lookup
  iterationCountResult: { c: 0 }, // SELECT COUNT(*)
  insertedRenderId: 7,
  txCalls: [],                    // capture INSERT/UPDATE SQLs run inside transactions
};

vi.mock('../../../db.js', () => {
  const makePrepare = (capture) => vi.fn((sql) => {
    return {
      run: vi.fn().mockImplementation((...args) => {
        capture.push({ sql, args })
        return { lastInsertRowid: 1, changes: 1 }
      }),
      get: vi.fn().mockImplementation((...args) => {
        capture.push({ sql, args })
        if (/FROM graphics_sessions WHERE id/i.test(sql)) return dbState.loadSessionResult
        if (/FROM graphics_messages/i.test(sql))         return undefined
        if (/COUNT\(\*\).*graphics_renders/i.test(sql))  return dbState.iterationCountResult
        if (/FROM graphics_renders\s+WHERE session_id/i.test(sql) && /status\s*=\s*'complete'/i.test(sql)) return dbState.parentResult
        if (/INSERT INTO graphics_renders/i.test(sql))   return { id: dbState.insertedRenderId }
        return { id: 1, spec_json: {}, status: 'briefing' }
      }),
      all: vi.fn().mockImplementation((...args) => {
        capture.push({ sql, args })
        if (/FROM graphics_messages/i.test(sql)) return dbState.loadHistoryResult
        return []
      }),
    }
  });
  // outer prepare uses non-tx capture (we mainly inspect tx via dbState.txCalls)
  const outerCapture = []
  const txCapture = dbState.txCalls
  return {
    default: {
      prepare: makePrepare(outerCapture),
      transaction: vi.fn(async (fn) => fn({ prepare: makePrepare(txCapture) })),
    },
  };
});

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test'
  // Reset dbState defaults each test
  dbState.loadSessionResult  = { id: 1, spec_json: {}, status: 'briefing' }
  dbState.loadHistoryResult  = []
  dbState.parentResult       = null
  dbState.iterationCountResult = { c: 0 }
  dbState.txCalls.length = 0
})
```

(The `beforeEach` block already exists in the file — replace its body or keep both behaviours. The new `dbState` reset must run before each test.)

- [ ] **Step 2: Verify existing orchestrator tests still pass after the mock refactor**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js 2>&1 | tail -10
```
Expected: all 4 existing tests still pass — the new mock returns the same defaults as before for the existing test SQLs.

- [ ] **Step 3: Write the failing iterating-mode test**

Append to `server/services/graphics/__tests__/orchestrator.test.js`:

```js
describe('orchestrator — iterating mode', () => {
  it('bypasses brief LLM and enqueues a refine render off the latest complete parent', async () => {
    dbState.loadSessionResult = { id: 1, spec_json: { template: 'lower-third' }, status: 'iterating' }
    dbState.parentResult = {
      id: 7, iteration: 1, template: 'lower-third',
      spec_snapshot_json: { template: 'lower-third', mainText: 'A', subText: 'B', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      final_html_text: '<!doctype html><div data-composition-id="main">PARENT</div>',
    }
    dbState.iterationCountResult = { c: 1 }
    dbState.insertedRenderId = 8

    const { callGemini } = await import('../../../lib/llm/gemini.js')
    callGemini.mockClear()

    const { runChatTurn } = await import('../orchestrator.js')
    const result = await runChatTurn({ sessionId: 1, userMessage: 'make it bigger' })

    // Brief LLM was NOT called
    expect(callGemini).not.toHaveBeenCalled()
    // A new render row was inserted with parent_render_id + human_feedback set
    const insertRender = dbState.txCalls.find(
      (c) => /INSERT INTO graphics_renders/i.test(c.sql)
    )
    expect(insertRender).toBeDefined()
    expect(insertRender.sql).toMatch(/parent_render_id/i)
    expect(insertRender.sql).toMatch(/human_feedback/i)
    // The args contain parent.id, "make it bigger", and parent.iteration + 1
    expect(insertRender.args).toContain(7)             // parent_render_id
    expect(insertRender.args).toContain('make it bigger') // human_feedback
    expect(insertRender.args).toContain(2)             // iteration = parent.iteration + 1
    // Session flips to 'rendering'
    const sessionUpdate = dbState.txCalls.find(
      (c) => /UPDATE graphics_sessions/i.test(c.sql) && /status\s*=\s*'rendering'/i.test(c.sql)
    )
    expect(sessionUpdate).toBeDefined()
    // Returned shape
    expect(result.assistantText).toBe('Refining…')
    expect(result.renderId).toBe(8)
  })
})
```

- [ ] **Step 4: Run the test — should fail**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js -t "iterating mode" 2>&1 | tail -15
```
Expected: FAIL — current `runChatTurn` doesn't branch on session.status.

- [ ] **Step 5: Implement the iterating-mode branch in `orchestrator.js`**

In `server/services/graphics/orchestrator.js`, add this constant near the top of the file (after the imports, before `SPEC_BLOCK`):
```js
const MAX_ITERATIONS_PER_SESSION = parseInt(process.env.GRAPHICS_MAX_ITERATIONS_PER_SESSION || '10', 10);
const ACK_TEXT = 'Refining…';
```

Then in `runChatTurn`, immediately after the line:
```js
if (!session) throw new Error(`session ${sessionId} not found`);
```
Insert the iterating-mode branch BEFORE the `// Bug 1 fix: load history BEFORE inserting user message` comment:

```js
  if (session.status === 'iterating') {
    // Find latest complete parent
    const parent = await db.prepare(
      `SELECT id, iteration, template, spec_snapshot_json, final_html_text
       FROM graphics_renders
       WHERE session_id = ? AND status = 'complete'
       ORDER BY iteration DESC
       LIMIT 1`
    ).get(sessionId);
    if (!parent) {
      throw new Error(`session ${sessionId} status='iterating' but no complete render exists`);
    }
    if (!parent.final_html_text) {
      throw new Error(`parent render ${parent.id} missing final_html_text`);
    }

    const renderId = await db.transaction(async (tx) => {
      await tx.prepare(
        `INSERT INTO graphics_messages (session_id, role, content) VALUES (?, ?, ?)`
      ).run(sessionId, 'user', userMessage);
      await tx.prepare(
        `INSERT INTO graphics_messages (session_id, role, content) VALUES (?, ?, ?)`
      ).run(sessionId, 'assistant', ACK_TEXT);
      const inserted = await tx.prepare(
        `INSERT INTO graphics_renders
          (session_id, iteration, spec_snapshot_json, template, status,
           parent_render_id, human_feedback)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)
         RETURNING id`
      ).get(
        sessionId,
        parent.iteration + 1,
        typeof parent.spec_snapshot_json === 'string'
          ? parent.spec_snapshot_json
          : JSON.stringify(parent.spec_snapshot_json),
        parent.template,
        parent.id,
        userMessage,
      );
      await tx.prepare(`UPDATE graphics_sessions SET status = 'rendering' WHERE id = ?`).run(sessionId);
      return inserted.id;
    });

    emit({ sessionId, step: 'render_queued', label: 'Refine queued', renderId });
    return { assistantText: ACK_TEXT, specUpdate: {}, newSpec: session.spec_json || {}, renderId, cost: 0 };
  }
```

- [ ] **Step 6: Run the test — should pass**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js -t "iterating mode" 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 7: Run all orchestrator tests — no regressions**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js 2>&1 | tail -10
```
Expected: all tests pass (4 existing + 1 new).

- [ ] **Step 8: Commit**

```bash
git add server/services/graphics/orchestrator.js server/services/graphics/__tests__/orchestrator.test.js
git commit -m "feat(graphics): orchestrator iterating-mode branch

When session.status='iterating', bypass the brief LLM, look up the
latest complete render of the session, and enqueue a refine render
with parent_render_id and human_feedback. Worker (Task 4) handles the
rest. Returned assistant text is fixed 'Refining…' — actual progress
flows through SSE events."
```

---

## Task 7: Orchestrator — iteration cap refusal

**Files:**
- Modify: `server/services/graphics/orchestrator.js` (add cap check at the top of the iterating branch)
- Modify: `server/services/graphics/__tests__/orchestrator.test.js` (add cap test)

- [ ] **Step 1: Write the failing cap test**

Append to the existing `describe('orchestrator — iterating mode', ...)` block:

```js
  it('refuses to enqueue a render when iteration cap is hit', async () => {
    dbState.loadSessionResult = { id: 1, spec_json: {}, status: 'iterating' }
    dbState.parentResult = {
      id: 7, iteration: 9, template: 'lower-third',
      spec_snapshot_json: { template: 'lower-third', mainText: 'A', subText: 'B', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      final_html_text: '<!doctype html><div data-composition-id="main">P</div>',
    }
    dbState.iterationCountResult = { c: 10 }  // already at cap

    const { callGemini } = await import('../../../lib/llm/gemini.js')
    callGemini.mockClear()

    const { runChatTurn } = await import('../orchestrator.js')
    const result = await runChatTurn({ sessionId: 1, userMessage: 'one more please' })

    // No render row inserted
    const insertRender = dbState.txCalls.find(
      (c) => /INSERT INTO graphics_renders/i.test(c.sql)
    )
    expect(insertRender).toBeUndefined()
    // No session status flip
    const sessionUpdate = dbState.txCalls.find(
      (c) => /UPDATE graphics_sessions/i.test(c.sql) && /status\s*=\s*'rendering'/i.test(c.sql)
    )
    expect(sessionUpdate).toBeUndefined()
    // The user message + a refusal assistant message ARE inserted
    const userMsgInsert = dbState.txCalls.find(
      (c) => /INSERT INTO graphics_messages/i.test(c.sql) && c.args.includes('user')
    )
    const refusalInsert = dbState.txCalls.find(
      (c) => /INSERT INTO graphics_messages/i.test(c.sql) && c.args.includes('assistant')
    )
    expect(userMsgInsert).toBeDefined()
    expect(refusalInsert).toBeDefined()
    // Returned shape
    expect(result.renderId).toBeNull()
    expect(result.assistantText).toMatch(/iteration limit/i)
  })
```

- [ ] **Step 2: Run the test — should fail**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js -t "iteration cap" 2>&1 | tail -15
```
Expected: FAIL — current iterating branch enqueues unconditionally.

- [ ] **Step 3: Add the cap check at the top of the iterating branch**

In `server/services/graphics/orchestrator.js`, locate the iterating branch you added in Task 6:
```js
  if (session.status === 'iterating') {
    // Find latest complete parent
    const parent = await db.prepare(
```

Insert the cap check IMMEDIATELY after the `if (session.status === 'iterating') {` line, BEFORE the parent lookup:

```js
    const countRow = await db.prepare(
      `SELECT COUNT(*)::int AS c FROM graphics_renders WHERE session_id = ?`
    ).get(sessionId);
    if (countRow.c >= MAX_ITERATIONS_PER_SESSION) {
      const refusal = `Iteration limit reached for this session (${MAX_ITERATIONS_PER_SESSION}). Start a new session for further changes.`;
      await db.transaction(async (tx) => {
        await tx.prepare(
          `INSERT INTO graphics_messages (session_id, role, content) VALUES (?, ?, ?)`
        ).run(sessionId, 'user', userMessage);
        await tx.prepare(
          `INSERT INTO graphics_messages (session_id, role, content) VALUES (?, ?, ?)`
        ).run(sessionId, 'assistant', refusal);
      });
      return { assistantText: refusal, specUpdate: {}, newSpec: session.spec_json || {}, renderId: null, cost: 0 };
    }
```

- [ ] **Step 4: Run the test — should pass**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js -t "iteration cap" 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 5: Run all orchestrator tests**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js 2>&1 | tail -10
```
Expected: all tests pass (4 existing + 2 new = 6 tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/graphics/orchestrator.js server/services/graphics/__tests__/orchestrator.test.js
git commit -m "feat(graphics): cap iterations per session

MAX_ITERATIONS_PER_SESSION (env, default 10) counts all renders for
the session including the initial brief-driven one. At cap, the
orchestrator inserts the user message + a polite refusal assistant
message and returns renderId=null. No render is enqueued, session
status stays 'iterating'."
```

---

## Task 8: Orchestrator — defensive test for missing parent

**Files:**
- Modify: `server/services/graphics/__tests__/orchestrator.test.js` (one more test)

- [ ] **Step 1: Add the defensive test**

Append to `describe('orchestrator — iterating mode', ...)`:

```js
  it('throws when status=iterating but no complete parent render exists', async () => {
    dbState.loadSessionResult = { id: 1, spec_json: {}, status: 'iterating' }
    dbState.parentResult = null
    dbState.iterationCountResult = { c: 1 }  // below cap

    const { runChatTurn } = await import('../orchestrator.js')
    await expect(runChatTurn({ sessionId: 1, userMessage: 'hi' }))
      .rejects.toThrow(/no complete render exists/i)
  })
```

- [ ] **Step 2: Run the test — should pass already (Task 6 throws this error)**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js -t "no complete parent" 2>&1 | tail -10
```
Expected: PASS — Task 6 already implements the throw.

- [ ] **Step 3: Run all orchestrator tests**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js 2>&1 | tail -10
```
Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/services/graphics/__tests__/orchestrator.test.js
git commit -m "test(graphics): defensive coverage — iterating with no complete parent throws"
```

---

## Task 9: Routes — extend `GET /sessions/:id` render list

**Files:**
- Modify: `server/routes/graphics.js` (the SELECT in the `/sessions/:id` handler around lines 60–65)

- [ ] **Step 1: Locate the SELECT**

```bash
grep -n "FROM graphics_renders WHERE session_id" server/routes/graphics.js
```
Expected: one match around line 63.

- [ ] **Step 2: Modify the SELECT**

Locate:
```js
const renders = await db
  .prepare(
    `SELECT id, iteration, status, output_url, preview_url, duration_ms, cost_cents,
            iteration_count, final_score, created_at
     FROM graphics_renders WHERE session_id = ? ORDER BY iteration ASC`
  )
  .all(id);
```

Replace with:
```js
const renders = await db
  .prepare(
    `SELECT id, iteration, status, output_url, preview_url, duration_ms, cost_cents,
            iteration_count, final_score, parent_render_id, human_feedback, created_at
     FROM graphics_renders WHERE session_id = ? ORDER BY iteration ASC`
  )
  .all(id);
```

(`final_html_text` is deliberately omitted from the list payload — it can be 30–50KB. The existing `GET /renders/:id` handler already does `SELECT r.*` and will return `final_html_text` when an individual render is requested.)

- [ ] **Step 3: Run the existing graphics route tests**

```bash
npx vitest run server/routes/__tests__/graphics.test.js 2>&1 | tail -10
```
Expected: all existing route tests still pass. (The change is additive in the SELECT projection — JSON output gets two new fields, no field is removed.)

- [ ] **Step 4: Commit**

```bash
git add server/routes/graphics.js
git commit -m "feat(graphics): expose parent_render_id + human_feedback on session detail

GET /api/graphics/sessions/:id now includes the lineage fields on each
render row. final_html_text remains accessible via GET /renders/:id
(too large for list payloads)."
```

---

## Task 10: Final verification

**Files:** none modified.

- [ ] **Step 1: Full graphics test suite**

```bash
npm test -- server/services/graphics 2>&1 | tail -20
```
Expected: previously 92 passed + 7 skipped (99). After Phase 5C: ~99 passed + 7 skipped (106). The new tests added across Tasks 2, 4, 5, 6, 7, 8 should sum to 7 new tests (1 + 1 + 3 + 1 + 1 + 0 wait, let me recount: Task 2: +1, Task 4: +1, Task 5: +3, Task 6: +1, Task 7: +1, Task 8: +1 = +8 new tests).

Expected exact count: **100 passed | 7 skipped (107)**.

If any test fails, do NOT proceed — fix the regression first.

- [ ] **Step 2: Full route test suite**

```bash
npm test -- server/routes 2>&1 | tail -10
```
Expected: all passing — Task 9 was a pure SELECT projection extension.

- [ ] **Step 3: Whole-project test suite (sanity)**

```bash
npm test 2>&1 | tail -15
```
Expected: same overall pass/skip count as before Phase 5C plus the 8 new graphics tests.

- [ ] **Step 4: Verify the spec branch has no untracked plan/spec drift**

```bash
git status --short
```
Expected: clean working tree (the spec was committed in the brainstorming step; the plan was committed in this branch).

- [ ] **Step 5: Final commit (only if any verification surfaced cleanups)**

If steps 1–4 produced no changes, skip. Otherwise:

```bash
git add -u
git commit -m "chore(graphics): Phase 5C verification fixups"
```

---

## After completion

- All Phase 5C tasks committed on `feat/graphics-phase5c-human-feedback` (the implementation branch — note: this plan was written on a sibling branch `feat/graphics-phase5c-plan`; merge plan→implementation before SDD execution OR cherry-pick the plan commit into the implementation worktree before starting).
- Use **superpowers:finishing-a-development-branch** to merge into main once acceptance criteria from the spec are satisfied:
  1. ✅ Migration idempotent (Task 1).
  2. ✅ First render persists `final_html_text` (Task 2).
  3. ✅ User message during `iterating` enqueues new render with parent_render_id + human_feedback + same spec (Task 6).
  4. ✅ Worker uses `refineHtml` not `specToHtml` when `parent_render_id` set (Task 4).
  5. ✅ Iteration cap blocks runaway sessions (Task 7).
  6. ✅ All 92 prior + 8 new = 100 graphics tests pass (Task 10).
  7. ✅ No frontend changes (per spec out-of-scope).
