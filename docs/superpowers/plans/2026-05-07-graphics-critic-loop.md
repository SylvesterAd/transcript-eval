# Motion Graphics — Critic Loop + Streaming Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-render VLM critic-fix loop and streaming pipeline telemetry to the motion-graphics chat. After every Hyperframe render, extract 3–4 keyframes, score them with Opus-4.7-with-vision against 4 criteria, and re-render with critic feedback if `score < 0.7`. Cap at 2 retries. Stream pipeline events (`scene_rendered`, `frames_captured`, `critic_scoring`, `retry_triggered`) over SSE to the frontend so the user sees Mosaic-style streaming labels.

**Architecture:** The render-worker drains queued renders as before (Phase 1, Task 10). New behavior: after each render produces an MP4, the worker invokes a `critic-runner` that (1) extracts frames via ffmpeg, (2) calls Opus-4.7-with-vision via a new `evaluator` module, (3) decides retry-or-ship. Retries call a new `retry-creator` prompt that incorporates critic feedback into the var-generation step. Each iteration is persisted in a new `graphics_render_iterations` table so the admin can inspect history. A pipeline `emitter` broadcasts structured events; an SSE endpoint streams them to the frontend, where a `PipelineStream` component renders Mosaic-style labels.

**Tech Stack:** Express 5, Node 20, `@anthropic-ai/sdk` (Opus-4.7 vision via existing wrapper), ffmpeg (already on Railway via `@ffmpeg-installer/ffmpeg` or system binary — verify), Supabase storage (frames bucket), React 19, vitest. No new npm dependencies expected unless `@ffmpeg-installer/ffmpeg` is missing.

**Decisions confirmed:**
- Score threshold: `>= 0.7` ships; `< 0.7` retries.
- Retry budget: max 2 retries (so up to 3 attempts total including initial).
- Iteration UX: chat shows only the FINAL approved render. A "Show iterations" toggle expands prior attempts.
- Failure mode: if all 3 attempts < 0.7, ship the highest-scoring with a small `(low confidence)` tag.
- Vision model: Opus-4.7. Already wired (anthropic.js wrapper), already paid for in the create step. Defer GPT-4o-mini swap until cost data exists.

---

## File Structure

### New backend files

```
server/
  services/
    graphics/
      critic/
        frame-extractor.js      # ffmpeg → 3-4 keyframes to local disk
        evaluator.js            # Opus-4.7-vision → score+critique JSON
        critic-runner.js        # orchestrates extract → evaluate → persist
      events/
        emitter.js              # in-memory pub/sub for pipeline events
      retry-prompt.js           # CREATE_RETRY_SYSTEM_PROMPT — incorporates critic feedback
  routes/
    graphics-events.js          # SSE endpoint /api/graphics/sessions/:id/events
```

### Modified backend files

```
server/
  schema-pg.sql                              # +1 table, +2 columns on graphics_renders
  db.js                                      # +migration block
  services/graphics/render-worker.js         # integrate critic loop
  services/graphics/orchestrator.js          # emit pipeline events at each stage
  services/graphics/uploader.js              # add uploadFrames() helper
  routes/graphics.js                         # add iteration-history endpoint
  index.js                                   # mount graphics-events route
```

### New frontend files

```
src/
  hooks/
    useGraphicsEvents.js                     # SSE subscriber (EventSource)
  components/motion-graphics/
    PipelineStream.jsx                       # streaming labels list
    IterationHistory.jsx                     # show/hide prior attempts
```

### Modified frontend files

```
src/
  components/motion-graphics/
    RenderViewer.jsx                         # add low-confidence tag + iteration toggle
    ChatThread.jsx                           # render PipelineStream alongside renders
  pages/admin/MotionGraphicsView.jsx         # surface chat-turn errors (queued fix)
```

### Test files

```
server/services/graphics/critic/__tests__/
  frame-extractor.test.js
  evaluator.test.js
  critic-runner.test.js
server/services/graphics/events/__tests__/
  emitter.test.js
server/routes/__tests__/
  graphics-events.test.js
server/services/graphics/__tests__/
  critic-loop-integration.test.js
src/components/motion-graphics/__tests__/
  PipelineStream.test.jsx
  IterationHistory.test.jsx
```

---

## Task 1: Schema — `graphics_render_iterations` + render columns

**Files:**
- Modify: `server/schema-pg.sql` (append new table + ALTER on graphics_renders)
- Modify: `server/db.js` (boot migrations block)
- Create test: `server/services/graphics/critic/__tests__/schema.test.js`

- [ ] **Step 1: Write the failing schema test**

```js
import { describe, it, expect } from 'vitest'

const skip = !process.env.DATABASE_URL
const d = skip ? describe.skip : describe

let db
async function getDb() {
  if (!db) db = (await import('../../../../db.js')).default
  return db
}

d('graphics_render_iterations table + render columns', () => {
  it('graphics_render_iterations exists with expected columns', async () => {
    const p = (await getDb()).pool
    const { rows } = await p.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'graphics_render_iterations' ORDER BY ordinal_position"
    )
    const cols = rows.map((r) => r.column_name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'render_id', 'iteration_index', 'mp4_path', 'frame_urls_json',
        'critic_score', 'critic_criteria_json', 'critic_feedback', 'created_at',
      ])
    )
  })

  it('graphics_renders has iteration_count + final_score columns', async () => {
    const p = (await getDb()).pool
    const { rows } = await p.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'graphics_renders'"
    )
    const cols = rows.map((r) => r.column_name)
    expect(cols).toContain('iteration_count')
    expect(cols).toContain('final_score')
  })
})
```

- [ ] **Step 2: Run — should fail**

```
npm test -- server/services/graphics/critic/__tests__/schema.test.js
```
Expected: FAIL ("relation 'graphics_render_iterations' does not exist") or column missing.

- [ ] **Step 3: Append SQL to `server/schema-pg.sql`**

```sql
-- Critic-loop iteration history (per-render attempt)
CREATE TABLE IF NOT EXISTS graphics_render_iterations (
  id                    SERIAL PRIMARY KEY,
  render_id             INTEGER NOT NULL REFERENCES graphics_renders(id) ON DELETE CASCADE,
  iteration_index       INTEGER NOT NULL,
  mp4_path              TEXT,
  frame_urls_json       JSONB NOT NULL DEFAULT '[]'::jsonb,
  critic_score          NUMERIC(3,2),
  critic_criteria_json  JSONB,
  critic_feedback       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_graphics_render_iterations_render
  ON graphics_render_iterations(render_id, iteration_index);

ALTER TABLE graphics_renders ADD COLUMN IF NOT EXISTS iteration_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE graphics_renders ADD COLUMN IF NOT EXISTS final_score NUMERIC(3,2);
```

- [ ] **Step 4: Add same migration block to `server/db.js`**

Inside the existing inner-`try` boot-migrations block (right after the Phase 1 `[migrate] graphics_* tables ready` log line), append:

```js
await pool.query(`
  CREATE TABLE IF NOT EXISTS graphics_render_iterations (
    id                    SERIAL PRIMARY KEY,
    render_id             INTEGER NOT NULL REFERENCES graphics_renders(id) ON DELETE CASCADE,
    iteration_index       INTEGER NOT NULL,
    mp4_path              TEXT,
    frame_urls_json       JSONB NOT NULL DEFAULT '[]'::jsonb,
    critic_score          NUMERIC(3,2),
    critic_criteria_json  JSONB,
    critic_feedback       TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_graphics_render_iterations_render
    ON graphics_render_iterations(render_id, iteration_index);
  ALTER TABLE graphics_renders ADD COLUMN IF NOT EXISTS iteration_count INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE graphics_renders ADD COLUMN IF NOT EXISTS final_score NUMERIC(3,2);
`);
console.log('[migrate] graphics_render_iterations + critic columns ready');
```

- [ ] **Step 5: Run test — should pass**

Expected: 2/2 PASS.

- [ ] **Step 6: Commit**

```bash
git add server/schema-pg.sql server/db.js server/services/graphics/critic/__tests__/schema.test.js
git commit -m "feat(graphics): critic loop iteration table + columns"
```

---

## Task 2: Frame extractor — ffmpeg keyframe extraction

**Files:**
- Create: `server/services/graphics/critic/frame-extractor.js`
- Create test: `server/services/graphics/critic/__tests__/frame-extractor.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/graphics/critic/__tests__/frame-extractor.test.js
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    cb(null, { stdout: '', stderr: '' })
  }),
}))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, mkdir: vi.fn().mockResolvedValue(undefined) }
})

describe('extractFrames', () => {
  it('returns N evenly-spaced frame paths', async () => {
    const { extractFrames } = await import('../frame-extractor.js')
    const result = await extractFrames({
      mp4Path: '/tmp/x.mp4',
      durationSec: 5,
      count: 4,
      outDir: '/tmp/frames',
    })
    expect(result).toHaveLength(4)
    expect(result[0]).toMatch(/\/tmp\/frames\/frame-0\.png$/)
    expect(result[3]).toMatch(/\/tmp\/frames\/frame-3\.png$/)
  })

  it('throws when count < 1', async () => {
    const { extractFrames } = await import('../frame-extractor.js')
    await expect(
      extractFrames({ mp4Path: '/tmp/x.mp4', durationSec: 5, count: 0, outDir: '/tmp' })
    ).rejects.toThrow(/count/i)
  })
})
```

- [ ] **Step 2: Run — should fail**

`npm test -- server/services/graphics/critic/__tests__/frame-extractor.test.js`
Expected: FAIL ("Cannot find module '../frame-extractor.js'").

- [ ] **Step 3: Implement**

```js
// server/services/graphics/critic/frame-extractor.js
//
// Extracts N evenly-spaced PNG keyframes from an MP4 via ffmpeg.
// Used by the critic loop to give the VLM a small set of representative
// frames rather than asking it to reason about full video.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const exec = promisify(execFile)

export async function extractFrames({ mp4Path, durationSec, count = 4, outDir }) {
  if (count < 1) throw new Error('count must be >= 1')
  await mkdir(outDir, { recursive: true })
  const paths = []
  for (let i = 0; i < count; i++) {
    // Spread frames across [0.1, durationSec - 0.1] to avoid black first/last frames
    const t = 0.1 + (i / Math.max(1, count - 1)) * Math.max(0, durationSec - 0.2)
    const out = path.join(outDir, `frame-${i}.png`)
    await exec(
      'ffmpeg',
      ['-y', '-ss', String(t), '-i', mp4Path, '-frames:v', '1', '-q:v', '2', out],
      { timeout: 30000 }
    )
    paths.push(out)
  }
  return paths
}
```

- [ ] **Step 4: Run test — should pass**

Expected: 2/2 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/critic/frame-extractor.js server/services/graphics/critic/__tests__/frame-extractor.test.js
git commit -m "feat(graphics): ffmpeg frame extractor for critic loop"
```

---

## Task 3: VLM evaluator — Opus-4.7-vision scorer

**Files:**
- Create: `server/services/graphics/critic/evaluator.js`
- Create test: `server/services/graphics/critic/__tests__/evaluator.test.js`

The evaluator takes N frame file paths, base64-encodes them, sends them to Opus-4.7 with a structured-output system prompt, and parses the JSON response into `{score, criteria, feedback, retry_recommended}`.

- [ ] **Step 1: Write the failing test**

```js
// server/services/graphics/critic/__tests__/evaluator.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn().mockResolvedValue({
    text: '{"score":0.85,"criteria":{"fidelity":0.9,"legibility":0.85,"style":0.8,"timing":0.85},"feedback":"Looks good","retry_recommended":false}',
    toolUses: [],
    tokens: { in: 1200, out: 80 },
    stop: 'end_turn',
  }),
}))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, readFile: vi.fn().mockResolvedValue(Buffer.from('fake png')) }
})

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test'
})

describe('evaluateFrames', () => {
  it('returns parsed critique JSON', async () => {
    const { evaluateFrames } = await import('../evaluator.js')
    const r = await evaluateFrames({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png'],
      spec: { template: 'lower-third', mainText: 'Anna Rivera', tone: 'dramatic' },
    })
    expect(r.score).toBe(0.85)
    expect(r.retry_recommended).toBe(false)
    expect(r.criteria.fidelity).toBe(0.9)
  })

  it('throws on invalid JSON response', async () => {
    const { callAnthropic } = await import('../../../../lib/llm/anthropic.js')
    callAnthropic.mockResolvedValueOnce({
      text: 'not json at all',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'end_turn',
    })
    const { evaluateFrames } = await import('../evaluator.js')
    await expect(
      evaluateFrames({ framePaths: ['/tmp/f0.png'], spec: { template: 'lower-third' } })
    ).rejects.toThrow(/critic returned invalid JSON/i)
  })
})
```

- [ ] **Step 2: Run — should fail**

`npm test -- server/services/graphics/critic/__tests__/evaluator.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// server/services/graphics/critic/evaluator.js
//
// VLM critic. Sends N PNG frames + the spec to Opus-4.7-vision, asks for
// a structured score JSON, parses, returns. Throws on parse error so the
// caller can decide whether to retry with the same frames or skip.

import { readFile } from 'node:fs/promises'
import { callAnthropic } from '../../../lib/llm/anthropic.js'

const SYSTEM_PROMPT = `You are a senior motion-graphics art director reviewing a rendered short clip frame-by-frame. You will receive a spec and N evenly-spaced keyframes from a single render.

Score the render across four criteria, each 0.0-1.0:
- fidelity: does the frame match the spec (template, text content, tone)?
- legibility: is text readable, contrast sufficient, no clipping?
- style: does it look like professional motion graphics, not LLM slop?
- timing: do the frames suggest a coherent animation arc (entry → hold → exit)?

Output ONLY this JSON shape, no markdown fences, no commentary:
{
  "score": 0.0-1.0,                          // overall — typically the min of the four
  "criteria": { "fidelity": 0.0, "legibility": 0.0, "style": 0.0, "timing": 0.0 },
  "feedback": "one paragraph of specific actionable critique",
  "retry_recommended": true|false            // true if score < 0.7 OR any criterion < 0.6
}`

export async function evaluateFrames({ framePaths, spec }) {
  // Build content blocks: spec text + each frame as an image block
  const imageBlocks = await Promise.all(
    framePaths.map(async (p) => {
      const buf = await readFile(p)
      return {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') },
      }
    })
  )
  const r = await callAnthropic({
    model: 'claude-opus-4-7',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Spec:\n${JSON.stringify(spec, null, 2)}\n\nFrames (in time order):` },
          ...imageBlocks,
        ],
      },
    ],
    max_tokens: 512,
    cache: false,
  })
  let parsed
  try {
    const trimmed = r.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '')
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error(`critic returned invalid JSON: ${r.text.slice(0, 200)}`)
  }
  return {
    score: parsed.score,
    criteria: parsed.criteria,
    feedback: parsed.feedback,
    retry_recommended: parsed.retry_recommended,
    tokens: r.tokens,
  }
}
```

- [ ] **Step 4: Run — should pass**

Expected: 2/2 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/critic/evaluator.js server/services/graphics/critic/__tests__/evaluator.test.js
git commit -m "feat(graphics): Opus-4.7 vision critic evaluator"
```

---

## Task 4: Frame uploader — Supabase storage helper

**Files:**
- Modify: `server/services/graphics/uploader.js` (add `uploadFrames()`)
- Modify: `server/services/graphics/__tests__/uploader.test.js` (or create if absent)

- [ ] **Step 1: Write the failing test for `uploadFrames`**

```js
// server/services/graphics/__tests__/uploader.test.js
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, readFile: vi.fn().mockResolvedValue(Buffer.from('fake png')) }
})
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: 'https://supabase.example/frame.png' },
          error: null,
        }),
      })),
    },
  })),
}))

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb-test'
})

describe('uploadFrames', () => {
  it('uploads each frame and returns array of signed URLs', async () => {
    const { uploadFrames } = await import('../uploader.js')
    const urls = await uploadFrames({
      renderId: 7,
      iterationIndex: 1,
      framePaths: ['/tmp/f0.png', '/tmp/f1.png'],
    })
    expect(urls).toHaveLength(2)
    expect(urls[0]).toMatch(/^https:/)
  })
})
```

- [ ] **Step 2: Run — should fail**

`npm test -- server/services/graphics/__tests__/uploader.test.js`
Expected: FAIL ("uploadFrames is not a function") or test file not found.

- [ ] **Step 3: Add `uploadFrames` to `server/services/graphics/uploader.js`**

Below the existing `uploadRender` function:

```js
export async function uploadFrames({ renderId, iterationIndex, framePaths }) {
  const bucket = process.env.GRAPHICS_FRAMES_BUCKET || 'graphics-frames'
  const sb = getClient()
  const urls = []
  for (let i = 0; i < framePaths.length; i++) {
    const data = await readFile(framePaths[i])
    const key = `renders/${renderId}/iter-${iterationIndex}/frame-${i}.png`
    const { error } = await sb.storage.from(bucket).upload(key, data, {
      contentType: 'image/png',
      upsert: true,
    })
    if (error) throw error
    const { data: signed, error: sErr } = await sb.storage
      .from(bucket)
      .createSignedUrl(key, 60 * 60 * 24 * 7)
    if (sErr) throw sErr
    urls.push(signed.signedUrl)
  }
  return urls
}
```

- [ ] **Step 4: Run test — should pass**

Expected: 1/1 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/uploader.js server/services/graphics/__tests__/uploader.test.js
git commit -m "feat(graphics): uploadFrames helper for critic frame storage"
```

---

## Task 5: Critic runner — orchestrates extract → evaluate → persist

**Files:**
- Create: `server/services/graphics/critic/critic-runner.js`
- Create test: `server/services/graphics/critic/__tests__/critic-runner.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/graphics/critic/__tests__/critic-runner.test.js
import { describe, it, expect, vi } from 'vitest'

vi.mock('../frame-extractor.js', () => ({
  extractFrames: vi.fn().mockResolvedValue(['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png', '/tmp/f3.png']),
}))
vi.mock('../evaluator.js', () => ({
  evaluateFrames: vi.fn().mockResolvedValue({
    score: 0.82,
    criteria: { fidelity: 0.85, legibility: 0.8, style: 0.85, timing: 0.78 },
    feedback: 'Title fits, sub-text could be larger.',
    retry_recommended: false,
    tokens: { in: 1200, out: 80 },
  }),
}))
vi.mock('../../uploader.js', () => ({
  uploadFrames: vi.fn().mockResolvedValue([
    'https://x/0.png', 'https://x/1.png', 'https://x/2.png', 'https://x/3.png',
  ]),
}))
vi.mock('../../../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ lastInsertRowid: 99, changes: 1 }),
      get: vi.fn().mockResolvedValue({ id: 99 }),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

describe('runCritic', () => {
  it('extracts → evaluates → uploads → persists, returns the critique', async () => {
    const { runCritic } = await import('../critic-runner.js')
    const result = await runCritic({
      renderId: 7,
      iterationIndex: 1,
      mp4Path: '/tmp/render.mp4',
      durationSec: 5,
      spec: { template: 'lower-third', mainText: 'Anna' },
    })
    expect(result.score).toBe(0.82)
    expect(result.retry_recommended).toBe(false)
    expect(result.frameUrls).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run — should fail**

`npm test -- server/services/graphics/critic/__tests__/critic-runner.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// server/services/graphics/critic/critic-runner.js
//
// Orchestrates the per-iteration critic loop:
//   1. Extract N frames from the rendered MP4
//   2. Upload frames to Supabase
//   3. Call VLM evaluator
//   4. Persist iteration row
//   5. Return critique + retry decision

import path from 'node:path'
import db from '../../../db.js'
import { extractFrames } from './frame-extractor.js'
import { evaluateFrames } from './evaluator.js'
import { uploadFrames } from '../uploader.js'

const FRAME_COUNT = 4

export async function runCritic({ renderId, iterationIndex, mp4Path, durationSec, spec }) {
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders'
  const frameDir = path.join(baseDir, String(renderId), `iter-${iterationIndex}-frames`)

  const localFramePaths = await extractFrames({
    mp4Path,
    durationSec,
    count: FRAME_COUNT,
    outDir: frameDir,
  })
  const frameUrls = await uploadFrames({ renderId, iterationIndex, framePaths: localFramePaths })
  const critique = await evaluateFrames({ framePaths: localFramePaths, spec })

  await db.prepare(
    `INSERT INTO graphics_render_iterations
       (render_id, iteration_index, mp4_path, frame_urls_json, critic_score, critic_criteria_json, critic_feedback)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    renderId,
    iterationIndex,
    mp4Path,
    JSON.stringify(frameUrls),
    critique.score,
    JSON.stringify(critique.criteria),
    critique.feedback
  )

  return {
    score: critique.score,
    criteria: critique.criteria,
    feedback: critique.feedback,
    retry_recommended: critique.retry_recommended,
    frameUrls,
    tokens: critique.tokens,
  }
}
```

- [ ] **Step 4: Run — should pass**

Expected: 1/1 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/critic/critic-runner.js server/services/graphics/critic/__tests__/critic-runner.test.js
git commit -m "feat(graphics): critic runner orchestrates extract+evaluate+persist"
```

---

## Task 6: Retry-creator prompt — incorporates critic feedback

**Files:**
- Create: `server/services/graphics/retry-prompt.js`

- [ ] **Step 1: Write the prompt module**

```js
// server/services/graphics/retry-prompt.js
//
// System prompt for the SECOND-pass creator (when the critic forced a retry).
// Same output shape as create-prompt.js (var-JSON), but constrained by critic feedback.

import { CREATE_SYSTEM_PROMPT } from './create-prompt.js'

export function buildRetryPrompt({ priorCritique, priorVars }) {
  return `${CREATE_SYSTEM_PROMPT}

# Prior attempt
A prior render of this spec was scored ${priorCritique.score} by the art-director critic. The critic feedback was:

"${priorCritique.feedback}"

Per-criteria scores: ${JSON.stringify(priorCritique.criteria)}

The prior var output was:
${JSON.stringify(priorVars, null, 2)}

# Your task
Output a NEW JSON object with adjustments that address the critique. Keep aspect ratio + duration + content fields the same; only adjust visual parameters (sizes, positions, accent shade) the critic flagged. Output JSON only, no commentary.`
}
```

- [ ] **Step 2: Smoke import check**

```bash
node --input-type=module -e "import('./server/services/graphics/retry-prompt.js').then(m => console.log('keys:', Object.keys(m).join(',')))"
```
Expect: `keys: buildRetryPrompt`.

- [ ] **Step 3: Commit**

```bash
git add server/services/graphics/retry-prompt.js
git commit -m "feat(graphics): retry-creator prompt with critic feedback"
```

(No test file — pure-string builder; covered indirectly by Task 7's integration.)

---

## Task 7: Render-worker integration — full critic loop

**Files:**
- Modify: `server/services/graphics/render-worker.js`
- Modify: `server/services/graphics/__tests__/render-worker.test.js`

The worker's per-claim flow becomes:
1. specToVars → renderTemplate → uploadRender → **runCritic**
2. If `retry_recommended && iteration < MAX_ITERATIONS`: regenerate vars via `buildRetryPrompt(...)` + `callAnthropic` → renderTemplate → uploadRender → runCritic. Repeat until pass or budget exhausted.
3. Pick the winning iteration: `score >= 0.7` (any) wins; else max-score across all attempts. Mark final.

Constants:
- `MAX_ITERATIONS = 3` (initial + 2 retries)
- `SCORE_THRESHOLD = 0.7`

- [ ] **Step 1: Write the failing test for the retry path**

```js
// in server/services/graphics/__tests__/render-worker.test.js — add a NEW test
// alongside the existing 'claims one queued render, runs it, marks complete' test.

it('retries up to 2 times when critic score is below threshold', async () => {
  const { runCritic } = await import('../critic/critic-runner.js')
  // First two attempts fail, third passes
  runCritic
    .mockResolvedValueOnce({ score: 0.4, criteria: {}, feedback: 'too small', retry_recommended: true, frameUrls: ['x'], tokens: { in: 0, out: 0 } })
    .mockResolvedValueOnce({ score: 0.5, criteria: {}, feedback: 'still small', retry_recommended: true, frameUrls: ['x'], tokens: { in: 0, out: 0 } })
    .mockResolvedValueOnce({ score: 0.85, criteria: {}, feedback: 'good', retry_recommended: false, frameUrls: ['x'], tokens: { in: 0, out: 0 } })

  const { drainOnce } = await import('../render-worker.js')
  const result = await drainOnce()
  expect(result.processed).toBe(1)
  expect(result.errors).toHaveLength(0)
  // 1 spec→vars + 2 retry-creator calls = 3 callAnthropic invocations
  // 3 renderTemplate calls (initial + 2 retries)
})
```

(The existing happy-path test continues to use the same shared `runCritic` mock, so add `vi.mock('../critic/critic-runner.js', () => ({ runCritic: vi.fn().mockResolvedValue({ score: 0.9, criteria: {}, feedback: 'good', retry_recommended: false, frameUrls: ['x'], tokens: { in: 0, out: 0 } }) }))` at the top of the file.)

- [ ] **Step 2: Run — should fail**

Expected: FAIL (worker doesn't yet call `runCritic`).

- [ ] **Step 3: Modify `server/services/graphics/render-worker.js`**

Add at top:
```js
import { runCritic } from './critic/critic-runner.js'
import { buildRetryPrompt } from './retry-prompt.js'

const MAX_ITERATIONS = 3
const SCORE_THRESHOLD = 0.7
```

Replace the success-path body (currently lines after `const result = await renderTemplate(...)`) with this loop:

```js
let iteration = 1
let bestAttempt = null
let lastVars = vars
let lastCritique = null
let lastResult = result
let lastUpload = upload

while (iteration <= MAX_ITERATIONS) {
  const critique = await runCritic({
    renderId: row.id,
    iterationIndex: iteration,
    mp4Path: lastResult.outputPath,
    durationSec: row.spec_snapshot_json.duration || 5,
    spec: row.spec_snapshot_json,
  })
  const attempt = {
    iteration,
    score: critique.score,
    upload: lastUpload,
    durationMs: lastResult.durationMs,
  }
  if (!bestAttempt || attempt.score > bestAttempt.score) bestAttempt = attempt

  if (!critique.retry_recommended || critique.score >= SCORE_THRESHOLD) break
  if (iteration >= MAX_ITERATIONS) break

  // Retry: rebuild vars with critique feedback and re-render
  const retrySys = buildRetryPrompt({ priorCritique: critique, priorVars: lastVars })
  const retryResp = await callAnthropic({
    model: MODEL_FOR.create,
    system: retrySys,
    messages: [{ role: 'user', content: `Spec:\n${JSON.stringify(row.spec_snapshot_json)}` }],
    max_tokens: 1024,
  })
  const retryText = retryResp.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '')
  lastVars = JSON.parse(retryText)
  iteration += 1
  lastResult = await renderTemplate({
    template: row.template,
    vars: lastVars,
    renderId: row.id,
  })
  lastUpload = await uploadRender({
    renderId: row.id,
    sessionId: row.session_id,
    localPath: lastResult.outputPath,
  })
  lastCritique = critique
}

// Persist final
await db.transaction(async (tx) => {
  await tx
    .prepare(
      `UPDATE graphics_renders
       SET status = 'complete', output_url = ?, duration_ms = ?, cost_cents = ?,
           iteration_count = ?, final_score = ?
       WHERE id = ?`
    )
    .run(bestAttempt.upload.url, bestAttempt.durationMs, cost, iteration, bestAttempt.score, row.id)
  await tx.prepare(`UPDATE graphics_sessions SET status = 'iterating' WHERE id = ?`).run(row.session_id)
})
```

(Note: `iteration === 1` happens BEFORE the loop — call `runCritic` at top with the initial `result`/`upload`. Adjust the loop initialization to match.)

- [ ] **Step 4: Run all worker tests — should pass**

`npm test -- server/services/graphics/__tests__/render-worker.test.js`
Expected: 2/2 PASS (existing happy-path + new retry path).

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/render-worker.js server/services/graphics/__tests__/render-worker.test.js
git commit -m "feat(graphics): worker integrates critic-loop with up to 2 retries"
```

---

## Task 8: Pipeline event emitter — in-memory pub/sub

**Files:**
- Create: `server/services/graphics/events/emitter.js`
- Create test: `server/services/graphics/events/__tests__/emitter.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/graphics/events/__tests__/emitter.test.js
import { describe, it, expect, vi } from 'vitest'

describe('pipeline event emitter', () => {
  it('subscribers receive emitted events for their session', async () => {
    const { emit, subscribe } = await import('../emitter.js')
    const events = []
    const unsubscribe = subscribe(7, (e) => events.push(e))
    emit({ sessionId: 7, step: 'render_queued', label: 'Queued' })
    emit({ sessionId: 7, step: 'frames_captured', label: 'Captured 4 frames' })
    emit({ sessionId: 8, step: 'foreign', label: 'should not arrive' })
    expect(events).toHaveLength(2)
    expect(events[0].step).toBe('render_queued')
    expect(events[1].step).toBe('frames_captured')
    unsubscribe()
    emit({ sessionId: 7, step: 'after_unsub', label: 'should not arrive' })
    expect(events).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run — should fail**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// server/services/graphics/events/emitter.js
//
// In-memory pub/sub for pipeline telemetry. Each subscriber registers for a
// specific sessionId; emit() fans out to all subscribers for that session.
// No persistence — events are best-effort streaming. SSE consumers may miss
// events that happened before they connected; that's acceptable for MVP.

const subscribers = new Map() // sessionId → Set<callback>

export function subscribe(sessionId, callback) {
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set())
  subscribers.get(sessionId).add(callback)
  return () => {
    const set = subscribers.get(sessionId)
    if (set) {
      set.delete(callback)
      if (set.size === 0) subscribers.delete(sessionId)
    }
  }
}

export function emit(event) {
  const set = subscribers.get(event.sessionId)
  if (!set) return
  for (const cb of set) {
    try { cb(event) } catch (e) { console.error('[emitter] subscriber threw', e) }
  }
}
```

- [ ] **Step 4: Run — should pass**

Expected: 1/1 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/events/emitter.js server/services/graphics/events/__tests__/emitter.test.js
git commit -m "feat(graphics): pipeline event emitter (in-memory pub/sub)"
```

---

## Task 9: SSE route — `/api/graphics/sessions/:id/events`

**Files:**
- Create: `server/routes/graphics-events.js`
- Modify: `server/index.js` (mount route)
- Create test: `server/routes/__tests__/graphics-events.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/routes/__tests__/graphics-events.test.js
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../../services/graphics/events/emitter.js', () => {
  const subs = new Map()
  return {
    subscribe: vi.fn((id, cb) => {
      if (!subs.has(id)) subs.set(id, new Set())
      subs.get(id).add(cb)
      return () => subs.get(id)?.delete(cb)
    }),
    emit: vi.fn((e) => {
      subs.get(e.sessionId)?.forEach((cb) => cb(e))
    }),
  }
})
vi.mock('../../auth.js', () => ({
  requireAuth: (req, res, next) => req.auth ? next() : res.status(401).json({ error: 'no auth' }),
  isAdmin: (req) => req.auth?.isAdminFlag === true,
}))
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      get: vi.fn().mockResolvedValue({ id: 7 }),
      run: vi.fn(), all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

describe('GET /api/graphics/sessions/:id/events', () => {
  it('admin: streams events via SSE', async () => {
    const router = (await import('../graphics-events.js')).default
    const layer = router.stack.find((l) => l.route?.path === '/sessions/:id/events' && l.route.methods.get)
    const middleware = router.stack.filter((l) => !l.route).map((l) => l.handle)
    const handlers = [...middleware, ...layer.route.stack.map((s) => s.handle)]

    const events = []
    const req = { auth: { userId: 'u1', isAdminFlag: true }, params: { id: '7' }, on: (ev, cb) => {} }
    const res = {
      headers: {},
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h); return this },
      write(chunk) { events.push(chunk); return true },
      end() { this.ended = true },
      on() {}, // close listener
      flushHeaders() {},
    }
    // Run handlers up to (and including) the SSE setup but resolve quickly
    let i = 0
    function next(err) { if (err) throw err; i++; if (i < handlers.length) handlers[i](req, res, next) }
    handlers[0](req, res, next)
    // Give it a microtask
    await new Promise((r) => setImmediate(r))
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('text/event-stream')

    // Simulate an emitted event
    const { emit } = await import('../../services/graphics/events/emitter.js')
    emit({ sessionId: 7, step: 'render_queued', label: 'Queued' })
    expect(events.some((c) => c.includes('render_queued'))).toBe(true)
  })

  it('non-admin: 403', async () => {
    const router = (await import('../graphics-events.js')).default
    const layer = router.stack.find((l) => l.route?.path === '/sessions/:id/events' && l.route.methods.get)
    const middleware = router.stack.filter((l) => !l.route).map((l) => l.handle)
    const handlers = [...middleware, ...layer.route.stack.map((s) => s.handle)]
    const req = { auth: { userId: 'u1', isAdminFlag: false }, params: { id: '7' }, on() {} }
    const res = {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this },
      json(b) { this.body = b; return this },
    }
    let i = 0
    function next() { i++; if (i < handlers.length) handlers[i](req, res, next) }
    handlers[0](req, res, next)
    await new Promise((r) => setImmediate(r))
    expect(res.statusCode).toBe(403)
  })
})
```

- [ ] **Step 2: Run — should fail**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// server/routes/graphics-events.js
import { Router } from 'express'
import db from '../db.js'
import { requireAuth, isAdmin } from '../auth.js'
import { subscribe } from '../services/graphics/events/emitter.js'

const router = Router()

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
  next()
}

router.use(requireAuth)
router.use(requireAdmin)

router.get('/sessions/:id/events', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' })
  // Ownership: session must belong to this admin
  const session = await db
    .prepare(`SELECT id FROM graphics_sessions WHERE id = ? AND user_id = ?`)
    .get(id, req.auth.userId)
  if (!session) return res.status(404).json({ error: 'not found' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  // Initial heartbeat so the client knows the stream is open
  res.write(`event: open\ndata: {"sessionId":${id}}\n\n`)

  const unsub = subscribe(id, (event) => {
    res.write(`event: ${event.step}\ndata: ${JSON.stringify(event)}\n\n`)
  })

  // Periodic heartbeat to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`)
  }, 25000)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsub()
  })
})

export default router
```

- [ ] **Step 4: Mount in `server/index.js`**

Near the existing `app.use('/api/graphics', graphicsRouter)` line, add:

```js
import graphicsEventsRouter from './routes/graphics-events.js'
// ... after the existing graphics mount:
app.use('/api/graphics', graphicsEventsRouter)
```

- [ ] **Step 5: Run — should pass**

Expected: 2/2 PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/graphics-events.js server/routes/__tests__/graphics-events.test.js server/index.js
git commit -m "feat(graphics): SSE endpoint for pipeline events"
```

---

## Task 10: Emit pipeline events from orchestrator + worker

**Files:**
- Modify: `server/services/graphics/orchestrator.js`
- Modify: `server/services/graphics/render-worker.js`
- Modify: `server/services/graphics/critic/critic-runner.js`

Add `emit({sessionId, step, label, ...meta})` calls at key points so the SSE stream populates.

- [ ] **Step 1: Add emit() calls**

In `orchestrator.js` (before/after callGemini, before render-INSERT):
```js
import { emit } from './events/emitter.js'
// ... in runChatTurn, after loadSession:
emit({ sessionId, step: 'brief_thinking', label: 'Thinking…' })
// ... after callGemini returns:
emit({ sessionId, step: 'brief_replied', label: 'Reply received' })
// ... after render-INSERT (when isSpecComplete fires):
if (renderId) emit({ sessionId, step: 'render_queued', label: 'Render queued', renderId })
```

In `render-worker.js`:
```js
import { emit } from './events/emitter.js'
// after claim:
emit({ sessionId: row.session_id, step: 'render_started', label: 'Rendering…', renderId: row.id, iteration })
// after each renderTemplate:
emit({ sessionId: row.session_id, step: 'render_finished', label: `Render complete (iter ${iteration})`, renderId: row.id, iteration })
// after each runCritic, with score:
emit({ sessionId: row.session_id, step: 'critic_scored', label: `Critic score ${critique.score.toFixed(2)} (iter ${iteration})`, renderId: row.id, iteration, score: critique.score })
// when retry triggered:
emit({ sessionId: row.session_id, step: 'retry_triggered', label: `Refining (iter ${iteration + 1})`, renderId: row.id })
// at finalize:
emit({ sessionId: row.session_id, step: 'render_complete', label: 'Done', renderId: row.id, finalScore: bestAttempt.score })
```

In `critic-runner.js`:
```js
import { emit } from '../events/emitter.js'
// after extractFrames returns:
emit({ sessionId: spec.__sessionId, step: 'frames_captured', label: 'Frames captured' })
```

(For critic-runner, the spec doesn't currently include sessionId. Update `runCritic` signature to accept `sessionId` and pass through from worker. Update tests accordingly.)

- [ ] **Step 2: Run all tests — should still pass**

`npm test`
Expected: no regressions; existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/services/graphics/orchestrator.js server/services/graphics/render-worker.js server/services/graphics/critic/critic-runner.js
git commit -m "feat(graphics): emit pipeline events from orchestrator + worker"
```

---

## Task 11: Frontend — `useGraphicsEvents` hook + `PipelineStream` component

**Files:**
- Create: `src/hooks/useGraphicsEvents.js`
- Create: `src/components/motion-graphics/PipelineStream.jsx`
- Create test: `src/components/motion-graphics/__tests__/PipelineStream.test.jsx`

- [ ] **Step 1: Write `useGraphicsEvents.js`**

```js
// src/hooks/useGraphicsEvents.js
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'

const BASE = import.meta.env.VITE_API_URL || '/api'

export function useGraphicsEvents(sessionId) {
  const [events, setEvents] = useState([])

  useEffect(() => {
    if (!sessionId) return undefined
    let es
    let cancelled = false

    async function open() {
      // Need to pass token via query param since EventSource doesn't support headers
      const { data } = await supabase?.auth.getSession() || {}
      const token = data?.session?.access_token
      const url = `${BASE}/graphics/sessions/${sessionId}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`
      if (cancelled) return
      es = new EventSource(url)
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data)
          setEvents((prev) => [...prev, event])
        } catch {}
      }
      // Listen for named events too (server sends `event: <step>`)
      ;['brief_thinking','brief_replied','render_queued','render_started','frames_captured','critic_scored','retry_triggered','render_finished','render_complete'].forEach((step) => {
        es.addEventListener(step, (e) => {
          try {
            const event = JSON.parse(e.data)
            setEvents((prev) => [...prev, event])
          } catch {}
        })
      })
      es.onerror = () => {
        es?.close()
      }
    }
    open()

    return () => {
      cancelled = true
      es?.close()
    }
  }, [sessionId])

  return events
}
```

(Note: the EventSource cannot send Authorization headers; the SSE route must accept the access token via `?token=` query param OR via cookie. We'll need to update the SSE route to accept either. Add to Task 9's route handler: if no req.auth set but `req.query.token` exists, verify and set req.auth manually.)

- [ ] **Step 2: Update SSE route to accept token query param**

Modify `server/routes/graphics-events.js` to accept query-param JWT (since EventSource can't set headers). Skip if `req.auth` already set (header-based auth from `attachAuth`).

This needs a small helper exported from `auth.js` — verify a token string and return the decoded payload. If `auth.js` doesn't already export one, add `export async function verifyTokenString(token)`.

- [ ] **Step 3: Implement `PipelineStream.jsx`**

```jsx
// src/components/motion-graphics/PipelineStream.jsx
const STEP_LABELS = {
  brief_thinking: 'Thinking…',
  brief_replied: '✓ Reply received',
  render_queued: '✓ Render queued',
  render_started: 'Rendering…',
  frames_captured: '✓ Frames captured',
  critic_scored: '✓ Critic scored',
  retry_triggered: '↻ Refining',
  render_finished: '✓ Render complete',
  render_complete: '✓ Done',
}

export function PipelineStream({ events }) {
  if (!events || events.length === 0) return null
  return (
    <ul className="my-2 space-y-1 px-2 text-xs text-zinc-400">
      {events.map((e, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className="font-mono text-zinc-500">{e.step}</span>
          <span>{e.label || STEP_LABELS[e.step] || e.step}</span>
          {e.score != null && <span className="text-amber-500">({e.score.toFixed(2)})</span>}
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 4: Test PipelineStream**

```jsx
// src/components/motion-graphics/__tests__/PipelineStream.test.jsx
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { PipelineStream } from '../PipelineStream'

afterEach(cleanup)

describe('PipelineStream', () => {
  it('renders nothing when no events', () => {
    const { container } = render(<PipelineStream events={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders each event with label + step', () => {
    render(<PipelineStream events={[
      { step: 'render_queued', label: 'Queued' },
      { step: 'critic_scored', label: 'Scored', score: 0.85 },
    ]} />)
    expect(screen.getByText('Queued')).toBeDefined()
    expect(screen.getByText('Scored')).toBeDefined()
    expect(screen.getByText('(0.85)')).toBeDefined()
  })
})
```

- [ ] **Step 5: Run tests — should pass**

Expected: 2/2 PASS for PipelineStream test.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useGraphicsEvents.js src/components/motion-graphics/PipelineStream.jsx src/components/motion-graphics/__tests__/PipelineStream.test.jsx server/routes/graphics-events.js server/auth.js
git commit -m "feat(graphics): SSE hook + PipelineStream component + token-query auth"
```

---

## Task 12: Wire `PipelineStream` into the chat + surface chat-turn errors

**Files:**
- Modify: `src/components/motion-graphics/ChatThread.jsx`
- Modify: `src/pages/admin/MotionGraphicsView.jsx`
- Modify: `src/components/motion-graphics/RenderViewer.jsx` (add `(low confidence)` tag when `final_score < 0.7`)

- [ ] **Step 1: Add `PipelineStream` to `ChatThread`**

Pass `events` as a new prop and render below the messages, above the renders:

```jsx
// ChatThread.jsx
import { PipelineStream } from './PipelineStream'
// ...
export function ChatThread({ messages, renders, events }) {
  // ...
  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-6 py-4">
      {messages.map(...)}
      <PipelineStream events={events} />
      {renders.map(...)}
    </div>
  )
}
```

- [ ] **Step 2: Subscribe to events in `MotionGraphicsView`**

```jsx
import { useGraphicsEvents } from '../../hooks/useGraphicsEvents'
// inside component:
const events = useGraphicsEvents(activeId)
// pass to ChatThread:
<ChatThread messages={messages} renders={renders} events={events} />
```

- [ ] **Step 3: Surface chat-turn errors**

Currently `onSend` swallows errors. Wrap in try/catch with a state:

```jsx
const [error, setError] = useState(null)
async function onSend(text) {
  setError(null)
  if (!activeId) { ... }
  setBusy(true)
  try {
    await sendMessage(text)
    await refreshList()
  } catch (e) {
    setError(e.message || 'Something went wrong.')
  } finally {
    setBusy(false)
  }
}
// render below ChatInput:
{error && (
  <div className="border-t border-red-800 bg-red-950 px-6 py-2 text-sm text-red-200">
    {error}
  </div>
)}
```

- [ ] **Step 4: Add low-confidence tag to `RenderViewer`**

In the `complete` branch, append after the iteration line:
```jsx
{render.final_score != null && render.final_score < 0.7 && (
  <span className="ml-2 rounded bg-amber-900 px-2 py-0.5 text-amber-200">low confidence</span>
)}
```

(The `final_score` field comes from the existing `/sessions/:id` response since the renders SELECT now includes it.)

- [ ] **Step 5: Update render select in `routes/graphics.js`**

Inside the GET `/sessions/:id` handler, the render SELECT needs `iteration_count, final_score`:

```sql
SELECT id, iteration, status, output_url, preview_url, duration_ms, cost_cents,
       iteration_count, final_score, created_at
FROM graphics_renders WHERE session_id = ? ORDER BY iteration ASC
```

- [ ] **Step 6: Build + smoke run tests**

```bash
npx vite build 2>&1 | tail -10
npm test 2>&1 | tail -25
```

Expect build success, no NEW test failures.

- [ ] **Step 7: Commit**

```bash
git add src/components/motion-graphics/ChatThread.jsx src/pages/admin/MotionGraphicsView.jsx src/components/motion-graphics/RenderViewer.jsx server/routes/graphics.js
git commit -m "feat(graphics): wire PipelineStream + error surface + low-confidence tag"
```

---

## Task 13: End-to-end integration test — full critic loop

**Files:**
- Create: `server/services/graphics/__tests__/critic-loop-integration.test.js`

This mirrors Task 15 of Phase 1 (`integration-flow.test.js`) but extends it to assert the critic loop runs:

- 1st render → critic returns score 0.4 → retry
- 2nd render → critic returns score 0.5 → retry
- 3rd render → critic returns score 0.85 → ship
- After: `graphics_render_iterations` has 3 rows for this render; `graphics_renders.iteration_count = 3`, `final_score = 0.85`.

- [ ] **Step 1: Write the test**

(Mock pattern reuses Phase 1's integration-flow.test.js. Add mocks for `frame-extractor`, `evaluator` (returning the chained scores), and `uploader.uploadFrames`. Assertions check the new columns + iteration count.)

- [ ] **Step 2: Run — should pass**

```bash
npm test -- server/services/graphics/__tests__/critic-loop-integration.test.js
```

(Skips when `DATABASE_URL` unset, like Phase 1's integration test.)

- [ ] **Step 3: Commit**

```bash
git add server/services/graphics/__tests__/critic-loop-integration.test.js
git commit -m "test(graphics): end-to-end critic loop with retries"
```

---

## Self-review (against confirmed scope)

| Confirmed item | Task |
|---|---|
| VLM critic loop, Opus-4.7 vision, score >= 0.7, max 2 retries | 1, 3, 5, 7 |
| Frame extraction (3-4 frames per render) | 2 |
| Iteration history persisted | 1, 5, 7 |
| Show only final approved render in chat (with toggle) | 12 (low-confidence tag covers visible part; "Show iterations" toggle is implicit via expandable RenderViewer; full toggle UI deferred to a small follow-up if needed) |
| Highest-scoring of 3 ships when all <0.7 (with low-confidence tag) | 7, 12 |
| Streaming pipeline labels | 8, 9, 10, 11, 12 |
| Error surface in chat | 12 |
| Telemetry observability | 8, 9, 10 |

**Type consistency**: `runCritic`, `extractFrames`, `evaluateFrames`, `uploadFrames`, `subscribe`/`emit`, `useGraphicsEvents`, `PipelineStream` — referenced consistently across tasks. Score field is `final_score NUMERIC(3,2)` in DB, `score: number` in JS, displayed `.toFixed(2)`.

**Gap acknowledged**: an iteration-history *toggle* in the UI (showing all attempts in an expandable panel) is not fully built — only the low-confidence tag surfaces multi-iteration awareness. If desired, add a small Phase 2.5 task that creates `<IterationHistory>` and wires it into `RenderViewer`. For now, the iteration data is in DB and accessible via a future detail endpoint.

---

## Phase 3 (post critic loop, separate plan)

1. **LLM-generated HTML composition** — replace templated lower-third with full file generation. Critic loop becomes the safety net. Reference: OpenMontage's `post-render self-review` stage.
2. **Multi-scene videos** — sequence multiple compositions into a single MP4 with crossfades; per-scene context re-gathering.
3. **Asset search agent** — for templates that reference imagery/icons (`news-graphic`, `social-card` etc.), wire Pexels + Storyblocks + Wikimedia.
4. **Vision model swap to GPT-4o-mini** for cost reduction once we have token-cost data from real usage.
5. **Iteration-history UI** — full expandable panel showing all attempts side-by-side.
