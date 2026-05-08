# Graphics Phase 5C — Human-Feedback Persistence Design

**Status:** Approved
**Date:** 2026-05-08
**Branch:** `feat/graphics-phase5c-human-feedback`
**Predecessor:** Phase 5A+5B (canonical single-HTML architecture, merged to `main` at `07926ba`)

---

## Goal

Close the round-trip loop: after the first canonical-HTML render completes, let the user iterate on it via natural-language chat ("make the title bigger", "different shade of blue"), and have the worker apply that feedback to the **prior render's actual HTML** — not the spec.

Today the session reaches `status='iterating'` after the first render but there is no path back to a new render. Phase 5C adds that path with full lineage, durable HTML storage, and a per-session iteration cap.

## Out of Scope (deliberately)

- Spec mutation from chat (e.g. "add a 4th scene"). v1 keeps `spec_snapshot_json` constant across iterations of a session — the user re-briefs from scratch for structural changes.
- Brief-LLM intent classification (`refine` vs `done` vs `structural-change`). v1 sends the user message straight to `refineHtml`. If the user says "looks great" we'll waste one render — acceptable cost for simplicity.
- Forking from non-latest renders. Always iterate off the most recent complete render of the session.
- UI surface beyond plumbing the new read-only fields onto existing endpoints. The chat input already POSTs to `/messages`.

---

## Architecture

```
┌─ briefing ──────┐    ┌─ rendering ─────┐    ┌─ iterating ─────┐
│ brief LLM       │ ─► │ worker drains   │ ─► │ user chats more │
│ extracts spec   │    │ specToHtml +    │    │ (this phase!)   │
│ enqueues 1st    │    │ critic loop     │    │                 │
│ render when     │    │ persists        │    │                 │
│ complete        │    │ final_html_text │    │                 │
└─────────────────┘    └─────────────────┘    └────────┬────────┘
                              ▲                        │
                              │                        ▼
                       ┌──────┴────────────────────────┐
                       │ orchestrator iterating-mode:  │
                       │ insert user msg, copy spec    │
                       │ from latest render, enqueue   │
                       │ new render with               │
                       │ parent_render_id + feedback,  │
                       │ flip session → rendering      │
                       └───────────────────────────────┘
```

The worker, when it sees `parent_render_id` set on a queued render, **loads the parent's `final_html_text` and skips `specToHtml`**. Iteration 1 of the new render is `refineHtml(parent_html, human_feedback, spec)`. The critic + refine loop downstream is identical to the existing path.

---

## Schema (server/db.js — additive, idempotent)

Add a fourth `pool.query` migration block immediately after the existing `DROP COLUMN IF EXISTS scene_index` block:

```sql
ALTER TABLE graphics_renders
  ADD COLUMN IF NOT EXISTS parent_render_id INTEGER REFERENCES graphics_renders(id),
  ADD COLUMN IF NOT EXISTS final_html_text  TEXT,
  ADD COLUMN IF NOT EXISTS human_feedback   TEXT;
CREATE INDEX IF NOT EXISTS idx_graphics_renders_parent
  ON graphics_renders(parent_render_id);
```

**Field semantics:**
- `parent_render_id INTEGER NULL` — FK to `graphics_renders(id)`. NULL means "first render of this session". Non-NULL means "human-feedback iteration of `parent_render_id`".
- `final_html_text TEXT NULL` — the final HTML that produced the best-scoring MP4 after the critic loop. Persisted in the same transaction that flips `status='complete'`. Durable — survives the 7-day signed-URL expiration on `output_url`.
- `human_feedback TEXT NULL` — verbatim user message that triggered this render. NULL on first render. Non-NULL on iterations. Stored verbatim (no truncation needed; bounded by message-input limits at the route layer).

**No new tables.** Lineage and HTML live on the existing `graphics_renders` row.

**Index rationale:** `parent_render_id` is selected when listing children of a render (future feature) but never in the worker's hot path; a single index is sufficient.

---

## Orchestrator (server/services/graphics/orchestrator.js)

The function `runChatTurn({ sessionId, userMessage })` branches on session status.

### Existing path: `briefing`
Unchanged. Brief LLM → `[SPEC]` patch → enqueue first render with `parent_render_id=NULL`, `human_feedback=NULL` when spec complete.

### New path: `iterating`
Insert user message; bypass brief LLM; enqueue refine render off latest complete render. Pseudocode:

```js
if (session.status === 'iterating') {
  // Cap check
  const iterationCount = await db.prepare(
    `SELECT COUNT(*)::int AS c FROM graphics_renders WHERE session_id = ?`
  ).get(sessionId);
  if (iterationCount.c >= MAX_ITERATIONS_PER_SESSION) {
    // Insert user message + assistant refusal, no render enqueued
    await db.transaction(async (tx) => {
      await tx.prepare(/* INSERT user message */).run(...);
      await tx.prepare(/* INSERT assistant message: "Iteration cap reached..." */).run(...);
    });
    return { assistantText: '...', renderId: null, cost: 0 };
  }

  // Find latest complete render
  const parent = await db.prepare(
    `SELECT id, iteration, spec_snapshot_json, template, final_html_text
     FROM graphics_renders
     WHERE session_id = ? AND status = 'complete'
     ORDER BY iteration DESC LIMIT 1`
  ).get(sessionId);
  if (!parent) {
    // Defensive: should not happen if status='iterating', but be safe
    throw new Error('iterating session has no complete parent render');
  }
  if (!parent.final_html_text) {
    throw new Error(`parent render ${parent.id} missing final_html_text`);
  }

  // Atomic: insert user msg, insert assistant ack, insert new render row, flip session
  const renderId = await db.transaction(async (tx) => {
    await tx.prepare(/* INSERT user message */).run(sessionId, 'user', userMessage);
    await tx.prepare(/* INSERT assistant ack "Refining…" */).run(sessionId, 'assistant', 'Refining…');
    const inserted = await tx.prepare(
      `INSERT INTO graphics_renders
        (session_id, iteration, spec_snapshot_json, template, status,
         parent_render_id, human_feedback)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)
       RETURNING id`
    ).get(sessionId, parent.iteration + 1, parent.spec_snapshot_json,
          parent.template, parent.id, userMessage);
    await tx.prepare(`UPDATE graphics_sessions SET status = 'rendering' WHERE id = ?`).run(sessionId);
    return inserted.id;
  });

  emit({ sessionId, step: 'render_queued', label: 'Refine queued', renderId });
  return { assistantText: 'Refining…', renderId, cost: 0 };
}
```

**Constants:**
```js
const MAX_ITERATIONS_PER_SESSION = parseInt(process.env.GRAPHICS_MAX_ITERATIONS_PER_SESSION || '10', 10);
const ACK_TEXT = 'Refining…';
```

**Cap semantics:** `MAX_ITERATIONS_PER_SESSION` counts **all** rows in `graphics_renders` for the session, including the initial brief-driven render. Default 10 → user gets 1 first render + 9 human-feedback iterations before hitting the cap. The 10th request is refused with a polite message.

**Why bypass brief LLM:** the brief prompt is built around extracting spec fields. For freeform refinement feedback ("smaller font", "more red") the brief LLM has no useful role — it would just echo the message or try to extract a non-existent `[SPEC]` block. `refineHtml` already accepts plain English feedback (validated extensively in Phase 5A+5B critic loop).

**Why fixed `'Refining…'` ack:** cheap (no LLM call, no cost), deterministic, surfaces immediately so the chat UI stays responsive. The actual progress comes through the existing SSE event stream (`render_started`, `critic_scored`, `render_complete`).

---

## Worker (server/services/graphics/render-worker.js)

### `claimNextRender` — extend SELECT
```js
RETURNING id, session_id, iteration, spec_snapshot_json, template,
          parent_render_id, human_feedback
```

### `drainOnce` — pass new fields to `runCriticLoop`
```js
const r = await runCriticLoop({
  renderId: row.id, sessionId: row.session_id, spec,
  parentRenderId: row.parent_render_id,
  humanFeedback: row.human_feedback,
});
```

### `runCriticLoop` — branch on `parentRenderId`
Replace the current "always call `generateHtmlWithLintGate`" with:

```js
async function runCriticLoop({ renderId, sessionId, spec, parentRenderId = null, humanFeedback = null }) {
  let totalCost = 0;
  let initialHtml;
  let initialTokens;
  let initialCost;

  if (parentRenderId) {
    // Load parent's final HTML, run refine instead of fresh generate
    const parent = await db.prepare(
      `SELECT final_html_text FROM graphics_renders WHERE id = ?`
    ).get(parentRenderId);
    if (!parent || !parent.final_html_text) {
      throw new Error(`parent render ${parentRenderId} missing final_html_text`);
    }
    if (!humanFeedback) {
      throw new Error(`render ${renderId} has parent_render_id but no human_feedback`);
    }
    const refined = await refineHtml({ html: parent.final_html_text, feedback: humanFeedback, spec });
    initialHtml = refined.html;
    initialCost = refined.cost;
    initialTokens = refined.tokens;
    // Lint gate against the refined HTML — re-uses generateHtmlWithLintGate's lint path
    // but we already have HTML, so do a single lint check inline:
    const lintCheck = await runLintInline({ html: initialHtml, renderId });
    if (lintCheck.errorCount > 0) {
      throw new Error(`refined HTML failed lint: ${formatFindingsForPrompt(lintCheck.findings)}`);
    }
  } else {
    const fresh = await generateHtmlWithLintGate({ spec, renderId });
    initialHtml = fresh.html;
    initialCost = fresh.cost;
    initialTokens = fresh.tokens;
  }
  totalCost += initialCost;

  // ... rest of loop unchanged: renderHtml, uploadRender, runCritic,
  // optional refineHtml retries (still triggered by critic, not by user)
}
```

`runLintInline` is a small helper that writes HTML to disk and calls `runLint` once (without the retry loop that `generateHtmlWithLintGate` has — for human-feedback path, if the LLM produces broken HTML on first refine, we surface the error rather than auto-retrying with synthesized feedback).

### `drainOnce` — persist `final_html_text` on completion
The completion transaction currently does:
```js
await tx.prepare(
  `UPDATE graphics_renders
   SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
       iteration_count = ?, final_score = ?, scene_count = ?
   WHERE id = ?`
).run(...);
```
Add `final_html_text = ?` to the SET clause and pass `r.bestHtml` as the corresponding value. Requires `runCriticLoop` to return `bestHtml` alongside `bestUpload`, `bestScore`, etc.

### `bestAttempt` — track HTML alongside MP4
```js
const attempt = {
  iteration, score: critique.score,
  mp4Path: currentResult.outputPath,
  upload: currentUpload,
  durationMs: currentResult.durationMs,
  html: currentHtml,  // NEW
};
```
And the return:
```js
return {
  bestMp4Path: bestAttempt.mp4Path,
  bestUpload: bestAttempt.upload,
  bestScore: bestAttempt.score,
  bestHtml: bestAttempt.html,  // NEW
  totalIterations: iteration,
  totalDurationMs,
  cost: totalCost,
};
```

---

## Routes (server/routes/graphics.js)

Read-only surface additions — no new endpoints.

### `GET /api/graphics/sessions/:id`
Add `parent_render_id, human_feedback` to the renders SELECT (skip `final_html_text` — too large to ship in list payloads):
```sql
SELECT id, iteration, status, output_url, preview_url, duration_ms, cost_cents,
       iteration_count, final_score, parent_render_id, human_feedback, created_at
FROM graphics_renders WHERE session_id = ? ORDER BY iteration ASC
```

### `GET /api/graphics/renders/:id`
Already does `SELECT r.*` — naturally picks up the new columns including `final_html_text`. No change needed, except a note in code that `final_html_text` may be large (~30-50KB typical). Acceptable for individual render fetches; we explicitly omit it from list endpoints above.

---

## Error Handling

| Condition | Outcome |
|---|---|
| `parent_render_id` set but parent has no `final_html_text` | Worker marks render `failed` with message "parent missing final_html_text". Session stays in `rendering` until reclaimed by `reclaimStuck`. |
| `parent_render_id` set but `human_feedback` is NULL | Worker marks render `failed`. Same recovery path. |
| Refined HTML fails lint | Worker marks render `failed`. **No auto-retry on the human-feedback path** — surfacing the error is more useful than synthesized feedback. |
| Iteration cap exceeded | Orchestrator returns assistant ack: "Iteration limit reached for this session. Start a new session for further changes." No render enqueued. Session stays in `iterating`. |
| Session in `iterating` but no complete parent render exists | Orchestrator throws (defensive — should not happen given status invariant). Logged loudly. |
| Brief LLM call fails during `briefing` | Existing handling — unchanged. |

---

## Testing

### Unit (vitest)

1. **`session-state.test.js`** — no changes (spec semantics unchanged).

2. **`orchestrator.test.js`** — new tests:
   - Iterating-mode path: session.status='iterating' + user message → inserts user msg + ack msg + new render row with `parent_render_id` set, `human_feedback` set, `iteration = parent.iteration + 1`, session flips to `rendering`. No brief LLM call.
   - Iteration cap: when count >= MAX, inserts ack-only refusal; no render row.
   - Missing parent: session.status='iterating' but no complete render → throws (mocked).
   - Briefing-mode path: existing tests still pass (no regressions).

3. **`render-worker.test.js`** — new tests:
   - Refine path: `claimNextRender` returns row with `parent_render_id` set → worker calls `refineHtml(parent.final_html_text, human_feedback, spec)` instead of `specToHtml`. Single critic call. `final_html_text` written on completion.
   - Fresh path: `parent_render_id=NULL` → calls `specToHtml` (existing behavior). `final_html_text` written on completion (NEW persistence even on first render).
   - Parent missing `final_html_text` → marks render failed.
   - Refined HTML fails lint → marks render failed (no synth-retry).

4. **Integration test** (skipped without DB, mark `it.skipIf(!HAS_DB)`):
   - Full cycle: create session → first render completes (mocked LLM) → `final_html_text` populated → POST iterate message → second render row queued with parent_id → drain → `final_html_text` of child differs from parent.

### Pre-existing tests
All 92 currently-passing graphics tests must still pass. The 7 currently-skipped tests stay skipped.

---

## Migration Safety

- Migration is **purely additive** (`ADD COLUMN IF NOT EXISTS`). Re-running on already-migrated DB is a no-op.
- No backfill of `final_html_text` for renders made before Phase 5C — they're already complete and the user's existing flow doesn't expose iterating on them yet. If a user has an old session in `iterating`, attempting to message it will throw (caught at route layer → 500). Acceptable: there are no real users on this surface (admin-only).
- Rollback: drop the three columns + index. No data loss elsewhere.

---

## File Touch List

- `server/db.js` — schema migration block (additive, idempotent).
- `server/services/graphics/orchestrator.js` — branch on session.status; new iterating-mode path; `MAX_ITERATIONS_PER_SESSION` constant.
- `server/services/graphics/render-worker.js` — extend `claimNextRender`; pass `parentRenderId, humanFeedback` to `runCriticLoop`; refine-or-fresh branch; track `bestHtml`; persist `final_html_text` in completion UPDATE; new `runLintInline` helper (or inline lint logic — TBD in plan).
- `server/routes/graphics.js` — extend `GET /sessions/:id` SELECT to include `parent_render_id, human_feedback`. Existing `GET /renders/:id` already returns `final_html_text` via `r.*`.
- `server/services/graphics/__tests__/orchestrator.test.js` — iterating-mode + cap tests.
- `server/services/graphics/__tests__/render-worker.test.js` — refine-path + persistence tests.
- `server/services/graphics/__tests__/integration-flow.test.js` — full-cycle iterate (gated on DB env).

**No deletions. No file moves.**

---

## Acceptance Criteria

1. ✅ Schema migration runs idempotently on existing DBs (no errors when re-applied).
2. ✅ First render of a session sets `final_html_text` on completion (NEW persistence — wasn't there before).
3. ✅ User message during `iterating` enqueues a new render with `parent_render_id`, `human_feedback`, and the same `spec_snapshot_json` as the parent.
4. ✅ Worker uses `refineHtml` (not `specToHtml`) when `parent_render_id` is set.
5. ✅ Iteration cap (`MAX_ITERATIONS_PER_SESSION=10`) blocks runaway sessions and returns a polite refusal.
6. ✅ All 92 currently-passing graphics tests still pass.
7. ✅ ~10-12 new tests covering the iterating-mode orchestrator path, the worker refine path, and persistence.
8. ✅ No frontend changes required.

---

## Future (post-5C, not in this plan)

- Spec-mutation chat ("add a 4th scene") — re-engage brief LLM during `iterating` with a different prompt that produces structural spec patches.
- Done-detection via brief LLM intent classifier; mark session `'completed'` on "looks good".
- Fork from non-latest render (UI affordance to revert + iterate from earlier).
- Surface human_feedback + parent_render_id chain in UI (lineage tree of renders).
