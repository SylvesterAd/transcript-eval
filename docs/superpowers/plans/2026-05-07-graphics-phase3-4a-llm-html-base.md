# Motion Graphics — Phase 3.4-A: LLM-generated HTML (lower-third smoke) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `specToVars` (Opus → JSON variables) + `renderTemplate` (substitute into hardcoded `lower-third.html`) with `specToHtml` (Opus → full HTML file) + `renderHtml` (write raw HTML, run hyperframes). Output: a visually-equivalent lower-third using LLM-generated HTML, with the existing critic loop unchanged.

**Architecture:** The Hyperframes pipeline reads `index.html` from the work dir and runs GSAP timelines on `window.__timelines.main`. The LLM now produces this whole file directly. The existing `lower-third.html` template is embedded in the system prompt as a few-shot example so the LLM faithfully reproduces the visual style. No assets, no new templates yet — those land in 3.3 and 3.4-B.

**Tech Stack:** Node 22, `@anthropic-ai/sdk` (already a dep), vitest. Model: `claude-opus-4-7` via existing `MODEL_FOR.create`.

**Out of scope:** Asset search (3.3), free-form templates beyond lower-third (3.4-B), multi-scene (3.5), HTML sanitization beyond a basic regex (Belt-and-suspenders is enough for admin-only feature).

---

## File Structure

**Created:**
- `server/services/graphics/html-generator.js` — `specToHtml({ spec })` and `CREATE_HTML_SYSTEM_PROMPT`
- `server/services/graphics/__tests__/html-generator.test.js`

**Modified:**
- `server/services/graphics/render-runner.js` — add `renderHtml({ html, renderId, ... })` (keep `renderTemplate` for the integration test which mocks it; deprecate but don't delete in 3.4-A)
- `server/services/graphics/__tests__/render-runner.test.js` — add `renderHtml` tests
- `server/services/graphics/retry-prompt.js` — emit a prompt that asks for revised HTML given prior HTML + critique
- `server/services/graphics/render-worker.js` — swap `specToVars` → `specToHtml` and `renderTemplate` → `renderHtml`; retry path uses new prompt + new HTML
- `server/services/graphics/__tests__/render-worker.test.js` — adapt mocks/assertions
- `server/services/graphics/__tests__/critic-loop-integration.test.js` — adapt to new mock surface (replaces `specToVars`/`renderTemplate` mocks with `specToHtml`/`renderHtml`)

**Untouched:**
- `server/services/graphics/critic/**` — critic loop, evaluator, frame extractor (Phase 2 + 3.1)
- `server/services/graphics/uploader.js`, `events/emitter.js`, `models.js`, `session-state.js`, `orchestrator.js`, `brief-prompt.js`
- `server/services/graphics/templates/lower-third.html` — kept for now as the canonical visual reference; embedded into the system prompt verbatim. (May be deleted in 3.4-B once free-form is proven.)
- Frontend (`src/components/motion-graphics/**`)

---

### Task 1: Create `html-generator.js` with `specToHtml` and `CREATE_HTML_SYSTEM_PROMPT`

**Files:**
- Create: `server/services/graphics/html-generator.js`
- Create: `server/services/graphics/__tests__/html-generator.test.js`

The new module exports `specToHtml({ spec }) → { html, cost, tokens }`. It calls `callAnthropic` with the new system prompt, strips ``` fences, returns the HTML string + metadata. The system prompt embeds the existing `lower-third.html` verbatim as a few-shot example so Opus reproduces the visual style faithfully.

The Hyperframes contract (the LLM must respect):
1. Root: `<div id="stage" data-composition-id="main" data-start="0" data-duration="<dur>" data-width="<w>" data-height="<h>">`
2. Animations on `window.__timelines.main` as a paused GSAP timeline
3. Allowed external resources: Google Fonts, GSAP via jsdelivr CDN, chart.js via jsdelivr (for future)

- [ ] **Step 1: Write the failing tests**

Create `server/services/graphics/__tests__/html-generator.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn().mockResolvedValue({
    text: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080"><div class="lt-bar">Hi</div></div><script>window.__timelines={main: {paused:true}}</script></body></html>',
    toolUses: [],
    tokens: { in: 600, out: 400 },
    stop: 'end_turn',
  }),
}))

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test'
})

describe('specToHtml', () => {
  it('returns html + cost + tokens', async () => {
    const { specToHtml } = await import('../html-generator.js')
    const r = await specToHtml({
      spec: { template: 'lower-third', aspectRatio: '16:9', duration: 5, mainText: 'Anna Rivera', subText: 'Journalist', tone: 'neutral' },
    })
    expect(r.html).toContain('<div id="stage"')
    expect(r.html).toContain('data-composition-id="main"')
    expect(r.cost).toBeGreaterThan(0)
    expect(r.tokens).toEqual({ in: 600, out: 400 })
  })

  it('strips markdown fences from response', async () => {
    const { callAnthropic } = await import('../../../lib/llm/anthropic.js')
    callAnthropic.mockResolvedValueOnce({
      text: '```html\n<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>\n```',
      toolUses: [],
      tokens: { in: 100, out: 50 },
      stop: 'end_turn',
    })
    const { specToHtml } = await import('../html-generator.js')
    const r = await specToHtml({ spec: { template: 'lower-third', duration: 5 } })
    expect(r.html).not.toContain('```')
    expect(r.html.startsWith('<!doctype html>')).toBe(true)
  })

  it('passes spec to the LLM via the user message', async () => {
    const { callAnthropic } = await import('../../../lib/llm/anthropic.js')
    callAnthropic.mockClear()
    callAnthropic.mockResolvedValueOnce({
      text: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080"></div></body></html>',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'end_turn',
    })
    const { specToHtml } = await import('../html-generator.js')
    await specToHtml({
      spec: { template: 'lower-third', aspectRatio: '9:16', duration: 6, mainText: 'Test', subText: 'X', tone: 'dramatic' },
    })
    const lastCall = callAnthropic.mock.calls.at(-1)[0]
    expect(lastCall.model).toBe('claude-opus-4-7')
    const userMsg = lastCall.messages[0].content
    expect(userMsg).toContain('"mainText": "Test"')
    expect(userMsg).toContain('"aspectRatio": "9:16"')
  })

  it('throws on response that lacks the Hyperframes root marker', async () => {
    const { callAnthropic } = await import('../../../lib/llm/anthropic.js')
    callAnthropic.mockResolvedValueOnce({
      text: '<html><body>just words, no stage div</body></html>',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'end_turn',
    })
    const { specToHtml } = await import('../html-generator.js')
    await expect(
      specToHtml({ spec: { template: 'lower-third', duration: 5 } })
    ).rejects.toThrow(/missing.*data-composition-id="main"/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-llm-html"
npx vitest run server/services/graphics/__tests__/html-generator.test.js
```

Expected: fails with module-not-found.

- [ ] **Step 3: Implement `html-generator.js`**

Create `server/services/graphics/html-generator.js`:

```js
// server/services/graphics/html-generator.js
//
// Opus generates a complete HTML file matching the Hyperframes contract.
// Replaces the older specToVars + template-substitution path. Adapt the
// prompt's few-shot example to evolve the supported visual styles.

import { callAnthropic } from '../../lib/llm/anthropic.js'
import { MODEL_FOR, costCents } from './models.js'

const FEW_SHOT_LOWER_THIRD = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;700;900&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; background: transparent; overflow: hidden; font-family: "Roboto Condensed", sans-serif; }
      .lt-bar { position: absolute; bottom: 80px; left: 80px; height: 120px; background: rgba(0,0,0,0.78); border-left: 4px solid #9ca3af; padding: 14px 22px; opacity: 0; display: flex; flex-direction: column; justify-content: center; max-width: 1056px; }
      .lt-main { font-weight: 700; font-size: 56px; color: #fafaf5; letter-spacing: 0.01em; line-height: 1.05; white-space: nowrap; }
      .lt-sub { margin-top: 6px; font-family: "JetBrains Mono", monospace; font-weight: 400; font-size: 18px; color: #9ca3af; letter-spacing: 0.18em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <div id="stage" data-composition-id="main" data-start="0" data-duration="8" data-width="1920" data-height="1080">
      <div class="lt-bar" id="lt-bar">
        <div class="lt-main" id="lt-main">Anna Rivera</div>
        <div class="lt-sub" id="lt-sub">Senior journalist</div>
      </div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#lt-bar", { opacity: 0, x: -60 }, { opacity: 1, x: 0, duration: 0.6, ease: "expo.out" }, 0.1);
      tl.fromTo("#lt-main", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5 }, 0.4);
      tl.fromTo("#lt-sub", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5 }, 0.6);
      tl.to("#lt-bar", { opacity: 0, x: -40, duration: 0.5, ease: "power2.in" }, Math.max(0.1, 8 - 0.7));
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`

export const CREATE_HTML_SYSTEM_PROMPT = `You are an HTML motion-graphics author for the Hyperframes pipeline. Given a spec, you write a single complete HTML file that Hyperframes renders to MP4 by scrubbing GSAP timelines frame-by-frame.

# Hard contract (must always hold)
1. Root element MUST be: <div id="stage" data-composition-id="main" data-start="0" data-duration="<DURATION>" data-width="<W>" data-height="<H>">…</div>
2. Animations: define a SINGLE GSAP timeline, paused, assigned to window.__timelines.main.
   Example: const tl = gsap.timeline({ paused: true }); ...; window.__timelines.main = tl;
3. Allowed external resources: Google Fonts CSS; GSAP from cdn.jsdelivr.net; chart.js from cdn.jsdelivr.net. NO other <script src> URLs.
4. Output ONLY the HTML — no commentary, no markdown fences, no explanation.

# Aspect ratio → width × height
  16:9 → 1920 × 1080
  9:16 → 1080 × 1920
  1:1  → 1080 × 1080

# Tone → accent color (CSS hex)
  analytical → #f59e0b
  dramatic   → #dc2626
  neutral    → #9ca3af
  playful    → #10b981

# Lower-third visual reference (current canonical style)
For spec.template = "lower-third", produce a file matching this style verbatim, substituting mainText/subText/duration/dimensions/accent. Animate: bar slides in from left, then main text drops in, then sub text drops in, then exit slides out near the end.

\`\`\`html
${FEW_SHOT_LOWER_THIRD}
\`\`\`

Stay close to this style for now. Future iterations will introduce free-form templates.`

const STAGE_MARKER = /data-composition-id\s*=\s*"main"/i

export async function specToHtml({ spec }) {
  const r = await callAnthropic({
    model: MODEL_FOR.create,
    system: CREATE_HTML_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Spec:\n${JSON.stringify(spec, null, 2)}` }],
    max_tokens: 4096,
  })
  let html = r.text.trim()
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/, '')
    .trim()
  if (!STAGE_MARKER.test(html)) {
    throw new Error(`creator returned HTML missing data-composition-id="main": ${html.slice(0, 200)}`)
  }
  const cost = costCents(MODEL_FOR.create, r.tokens)
  return { html, cost, tokens: r.tokens }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/services/graphics/__tests__/html-generator.test.js
```

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/html-generator.js server/services/graphics/__tests__/html-generator.test.js
git commit -m "feat(graphics): specToHtml — Opus generates complete HTML files"
```

---

### Task 2: Add `renderHtml` to `render-runner.js`

**Files:**
- Modify: `server/services/graphics/render-runner.js`
- Modify: `server/services/graphics/__tests__/render-runner.test.js`

`renderHtml({ html, renderId, fps, quality })` writes the HTML to the work dir, generates Hyperframes config, and runs the same `npx hyperframes render` invocation as `renderTemplate`. We KEEP `renderTemplate` for now (no consumer except the integration test mocks; we'll clean up in 3.4-B once free-form is proven).

- [ ] **Step 1: Append failing tests**

Append to `server/services/graphics/__tests__/render-runner.test.js`:

```js
describe('renderHtml', () => {
  it('writes raw HTML and runs hyperframes render', async () => {
    process.env.GRAPHICS_RENDER_DIR = '/tmp/test-renders';
    const { renderHtml } = await import('../render-runner.js');
    const html = '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>';
    const result = await renderHtml({ html, renderId: 73 });
    expect(result.outputPath).toContain('/tmp/test-renders/73/out.mp4');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('throws if html lacks the stage marker (defense in depth)', async () => {
    process.env.GRAPHICS_RENDER_DIR = '/tmp/test-renders';
    const { renderHtml } = await import('../render-runner.js');
    await expect(
      renderHtml({ html: '<html><body>no stage</body></html>', renderId: 74 })
    ).rejects.toThrow(/missing.*data-composition-id="main"/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run server/services/graphics/__tests__/render-runner.test.js
```

Expected: 2 new failures (no `renderHtml` export yet).

- [ ] **Step 3: Add `renderHtml` to `render-runner.js`**

In `server/services/graphics/render-runner.js`, append the new function (after `renderTemplate`, before EOF):

```js
const STAGE_MARKER_RE = /data-composition-id\s*=\s*"main"/i;

export async function renderHtml({ html, renderId, fps = 30, quality = 'standard' }) {
  if (!STAGE_MARKER_RE.test(html)) {
    throw new Error(`renderHtml: html missing data-composition-id="main"`);
  }
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders';
  const workDir = path.join(baseDir, String(renderId));
  await mkdir(workDir, { recursive: true });

  await writeFile(path.join(workDir, 'index.html'), html, 'utf8');
  await writeFile(
    path.join(workDir, 'hyperframes.json'),
    JSON.stringify({ paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' } })
  );
  await writeFile(
    path.join(workDir, 'meta.json'),
    JSON.stringify({ id: `render-${renderId}`, name: `Render ${renderId}` })
  );

  const outputPath = path.join(workDir, 'out.mp4');
  const start = Date.now();
  await exec(
    'npx',
    ['-y', 'hyperframes', 'render', '-q', quality, '-f', String(fps), '-w', '1', '-o', outputPath],
    { cwd: workDir, timeout: 5 * 60 * 1000 }
  );
  const stats = await stat(outputPath);
  return {
    outputPath,
    bytes: stats.size,
    durationMs: Date.now() - start,
    workDir,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/services/graphics/__tests__/render-runner.test.js
```

Expected: all tests in this file pass (the 2 existing `renderTemplate` tests + 2 new `renderHtml` tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/render-runner.js server/services/graphics/__tests__/render-runner.test.js
git commit -m "feat(graphics): renderHtml — write raw HTML and run hyperframes"
```

---

### Task 3: Update `retry-prompt.js` for HTML revisions

**Files:**
- Modify: `server/services/graphics/retry-prompt.js`

Replace the var-JSON retry prompt with one that asks Opus to revise the prior HTML based on critic feedback. Same return signature (`buildRetryPrompt({ priorCritique, priorHtml })`).

- [ ] **Step 1: Replace `retry-prompt.js`**

Full replacement of `server/services/graphics/retry-prompt.js`:

```js
// server/services/graphics/retry-prompt.js
//
// System prompt for the SECOND-pass HTML author (when the critic forced a retry).
// Same Hyperframes contract as create-prompt; constrained by critic feedback.

import { CREATE_HTML_SYSTEM_PROMPT } from './html-generator.js'

export function buildRetryPrompt({ priorCritique, priorHtml }) {
  return `${CREATE_HTML_SYSTEM_PROMPT}

# Prior attempt
A prior render of this spec was scored ${priorCritique.score} by the art-director critic. The critic feedback was:

"${priorCritique.feedback}"

Per-criteria scores: ${JSON.stringify(priorCritique.criteria)}

The prior HTML output was:

\`\`\`html
${priorHtml}
\`\`\`

# Your task
Output a NEW complete HTML file that addresses the critique. Keep the same content (text, duration, aspect) — only adjust visual parameters (sizing, colors, positioning, animation timing) the critic flagged. Output ONLY the HTML file, no commentary, no markdown fences.`
}
```

(No tests needed — this is a pure-string builder; the integration test exercises the round-trip.)

- [ ] **Step 2: Sanity check — run tests that import this file**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-llm-html"
grep -rln "retry-prompt" server/ | head -5
```

Confirm the only consumer is `render-worker.js` (the integration tests mock it).

- [ ] **Step 3: Commit**

```bash
git add server/services/graphics/retry-prompt.js
git commit -m "feat(graphics): retry-prompt asks for revised HTML"
```

---

### Task 4: Wire `render-worker.js` to use `specToHtml` + `renderHtml`

**Files:**
- Modify: `server/services/graphics/render-worker.js`
- Modify: `server/services/graphics/__tests__/render-worker.test.js`

Replace `specToVars` with `specToHtml`. Replace `renderTemplate` calls with `renderHtml`. Keep `currentVars` semantics but rename to `currentHtml`. Retry path uses the new `buildRetryPrompt({ priorCritique, priorHtml })` shape.

- [ ] **Step 1: Read the current test file to understand assertions**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-llm-html"
cat server/services/graphics/__tests__/render-worker.test.js | head -120
```

You'll see mocks for `callAnthropic`, `renderTemplate`, `uploader`, `runCritic`. We're replacing `renderTemplate` with `renderHtml` (or rather, mocking the new `specToHtml` to skip the LLM call entirely, since render-worker now imports it as a separate module).

- [ ] **Step 2: Update render-worker.js**

In `server/services/graphics/render-worker.js`:

1. Replace line 17 (`import { callAnthropic } from '../../lib/llm/anthropic.js';`) with:
   ```js
   import { specToHtml } from './html-generator.js';
   ```
   (We still import the SDK indirectly via html-generator; render-worker no longer calls anthropic directly.)

2. Delete lines 47-64 (`specToVars` function entirely).

3. In `drainOnce`:
   - Replace `const { vars: initialVars, cost } = await specToVars(row.spec_snapshot_json);` with:
     ```js
     const { html: initialHtml, cost } = await specToHtml({ spec: row.spec_snapshot_json });
     ```
   - Replace `let currentVars = initialVars;` with `let currentHtml = initialHtml;`.
   - Replace the first `renderTemplate(...)` call:
     ```js
     let currentResult = await renderHtml({ html: currentHtml, renderId: row.id });
     ```
   - In the retry block:
     - Replace `buildRetryPrompt({ priorCritique: critique, priorVars: currentVars })` with `buildRetryPrompt({ priorCritique: critique, priorHtml: currentHtml })`.
     - Replace the `callAnthropic` block (lines 111-118) with:
       ```js
       const retrySys = buildRetryPrompt({ priorCritique: critique, priorHtml: currentHtml });
       const retryResp = await callAnthropic({
         model: MODEL_FOR.create,
         system: retrySys,
         messages: [{ role: 'user', content: `Spec:\n${JSON.stringify(row.spec_snapshot_json)}` }],
         max_tokens: 4096,
       });
       const retryHtml = retryResp.text.trim()
         .replace(/^```html\s*/i, '')
         .replace(/^```\s*/i, '')
         .replace(/```$/, '')
         .trim();
       if (!/data-composition-id\s*=\s*"main"/i.test(retryHtml)) {
         throw new Error(`retry creator returned HTML missing data-composition-id="main"`);
       }
       currentHtml = retryHtml;
       ```
       (We KEEP the direct `callAnthropic` import from line 17 — but since we removed it, re-add it under the html-generator import: `import { callAnthropic } from '../../lib/llm/anthropic.js';`. The retry path still calls anthropic directly because retry uses a different system prompt.)
   - Replace second `renderTemplate(...)` call with `renderHtml({ html: currentHtml, renderId: row.id })`.

4. Replace `import { renderTemplate } from './render-runner.js';` with:
   ```js
   import { renderHtml } from './render-runner.js';
   ```

The full corrected `render-worker.js` imports section should be:

```js
import db from '../../db.js';
import { renderHtml } from './render-runner.js';
import { uploadRender } from './uploader.js';
import { callAnthropic } from '../../lib/llm/anthropic.js';
import { specToHtml } from './html-generator.js';
import { MODEL_FOR, costCents } from './models.js';
import { runCritic } from './critic/critic-runner.js';
import { buildRetryPrompt } from './retry-prompt.js';
import { emit } from './events/emitter.js';
```

(Note: `CREATE_SYSTEM_PROMPT` import is no longer needed — `specToHtml` handles the system prompt internally. Remove that import too.)

- [ ] **Step 3: Update render-worker.test.js**

This is the trickiest step — adapt the existing mocks to the new module surface. Read `server/services/graphics/__tests__/render-worker.test.js` and:
1. Replace `vi.mock('../render-runner.js', () => ({ renderTemplate: ... }))` with `vi.mock('../render-runner.js', () => ({ renderHtml: vi.fn().mockResolvedValue({ outputPath: '/tmp/x.mp4', bytes: 1234, durationMs: 100, workDir: '/tmp/x' }) }))`.
2. Add a new mock for the html-generator: `vi.mock('../html-generator.js', () => ({ specToHtml: vi.fn().mockResolvedValue({ html: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080"></div></body></html>', cost: 5, tokens: { in: 600, out: 400 } }) }))`.
3. The existing `callAnthropic` mock (used by the retry path) stays — but `mockResolvedValue` should now return HTML text containing the stage marker (e.g., `text: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">retry</div></body></html>'`).
4. Test assertions about `renderTemplate({ template, vars, ... })` become `renderHtml({ html, ... })`.

If a test was asserting on `template: 'lower-third'` argument, drop that assertion (template field no longer flows to the renderer — it's a hint embedded in the spec passed to `specToHtml`).

- [ ] **Step 4: Run render-worker tests**

```bash
npx vitest run server/services/graphics/__tests__/render-worker.test.js
```

Expected: green. If specific assertions fail, adapt them in-place rather than changing logic.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/render-worker.js server/services/graphics/__tests__/render-worker.test.js
git commit -m "feat(graphics): render-worker uses LLM-generated HTML"
```

---

### Task 5: Update `critic-loop-integration.test.js`

**Files:**
- Modify: `server/services/graphics/__tests__/critic-loop-integration.test.js`

The integration test mocks `renderTemplate` (now superseded by `renderHtml`) and exercises the critic loop with chained scores. Update mocks; the test logic should otherwise be unchanged.

- [ ] **Step 1: Read the existing test**

```bash
cat server/services/graphics/__tests__/critic-loop-integration.test.js
```

- [ ] **Step 2: Replace `renderTemplate` mock with `renderHtml`**

Find the `vi.mock('../render-runner.js', ...)` block and update it to mock `renderHtml` instead. Find the `vi.mock('../../../lib/llm/anthropic.js', ...)` block and update the `callAnthropic` mock's `text` field to return HTML containing the stage marker (so the retry path's HTML validation passes).

If the test mocks `specToVars` directly, replace with mocking `specToHtml` from `'../html-generator.js'` — return a fake HTML string containing the stage marker.

- [ ] **Step 3: Run the integration test**

```bash
export DATABASE_URL="$(grep '^DATABASE_URL=' /Users/laurynas/Desktop/one\ last\ /transcript-eval/.env | cut -d= -f2-)"
npx vitest run server/services/graphics/__tests__/critic-loop-integration.test.js
```

Expected: 1/1 pass.

- [ ] **Step 4: Commit**

```bash
git add server/services/graphics/__tests__/critic-loop-integration.test.js
git commit -m "test(graphics): integration test adapts to LLM-HTML path"
```

---

### Task 6: Verify full graphics suite + integration

**Files:** none modified.

- [ ] **Step 1: Run all graphics-related unit tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-llm-html"
npx vitest run server/services/graphics/ server/lib/llm/ server/routes/__tests__/graphics.test.js
```

Expected: green.

- [ ] **Step 2: Run the integration test against real Postgres**

```bash
export DATABASE_URL="$(grep '^DATABASE_URL=' /Users/laurynas/Desktop/one\ last\ /transcript-eval/.env | cut -d= -f2-)"
npx vitest run server/services/graphics/__tests__/critic-loop-integration.test.js
```

Expected: 1/1 pass.

- [ ] **Step 3: Document any pre-existing failures**

If `integration-flow.test.js` or `SupportBundle.test.jsx` fails, confirm those failures pre-date this branch (they did in 3.1 and 3.2; same pattern expected here). Otherwise investigate.

---

### Task 7: Manual smoke against live Opus

**Files:** none.

- [ ] **Step 1: Confirm `ANTHROPIC_API_KEY` is set**

```bash
node -e 'console.log("set:", !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_KEY)'
ls "/Users/laurynas/Desktop/one last /transcript-eval/.env" 2>&1 | head -1
grep -E '^ANTHROPIC_(API_)?KEY=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | head -1 | sed 's/=.*/=<REDACTED>/'
```

Source from `.env` if not in shell:
```bash
export $(grep -E '^ANTHROPIC_(API_)?KEY=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | xargs)
```

- [ ] **Step 2: Drive a single live `specToHtml` call**

```bash
node --input-type=module -e '
import("./server/services/graphics/html-generator.js").then(async ({ specToHtml }) => {
  const t0 = Date.now();
  const r = await specToHtml({
    spec: {
      template: "lower-third",
      aspectRatio: "16:9",
      duration: 8,
      mainText: "Anna Rivera",
      subText: "Senior journalist",
      tone: "neutral"
    }
  });
  const ms = Date.now() - t0;
  console.log("=== SMOKE OK ===");
  console.log("latency_ms:", ms);
  console.log("cost_cents:", r.cost);
  console.log("tokens:", JSON.stringify(r.tokens));
  console.log("html_size_bytes:", r.html.length);
  console.log("first 400 chars:");
  console.log(r.html.slice(0, 400));
}).catch(e => { console.error("=== SMOKE FAIL ===", e.message); process.exit(1); });'
```

Expected:
- `latency_ms` likely 5-15s (Opus generating ~3KB of HTML)
- `cost_cents` ~5-25 (5-25¢)
- HTML starts with `<!doctype html>`, contains `data-composition-id="main"`
- Visually scan the output: does it look like a lower-third with the right text and animation?

- [ ] **Step 3: (Optional) Render the smoke HTML to MP4**

If you want to confirm the full path:

```bash
node --input-type=module -e '
import { specToHtml } from "./server/services/graphics/html-generator.js";
import { renderHtml } from "./server/services/graphics/render-runner.js";
const { html } = await specToHtml({
  spec: { template: "lower-third", aspectRatio: "16:9", duration: 5, mainText: "Smoke", subText: "Test", tone: "neutral" }
});
const result = await renderHtml({ html, renderId: 999999 });
console.log("rendered to:", result.outputPath, result.bytes, "bytes,", result.durationMs, "ms");
'
```

If hyperframes is not installed locally, this step fails with "command not found" — that's not a code issue, just an environment one. Document and skip.

- [ ] **Step 4: DO NOT PUSH**

Per durable feedback (don't push without asking). Stop after the smoke. The user reviews and pushes themselves.

---

## Self-Review (controller)

**Spec coverage:**
- ✅ "LLM generates HTML, not JSON vars" → Tasks 1-5
- ✅ "Critic loop unchanged" → Task 5 verifies; critic-runner.js untouched
- ✅ "Match existing visual style" → CREATE_HTML_SYSTEM_PROMPT embeds the existing template verbatim as a few-shot
- ✅ "No assets / no new templates" → spec.assets ignored; lower-third only

**Placeholder scan:** None. Every step has full code. Task 4 has prose-driven edits (vs. complete-replacement) because the worker file is large and surgical edits are clearer. Each edit is precisely scoped.

**Type consistency:**
- `specToHtml({ spec }) → { html, cost, tokens }` (new contract)
- `renderHtml({ html, renderId, fps?, quality? }) → { outputPath, bytes, durationMs, workDir }` (parallel to `renderTemplate`)
- `buildRetryPrompt({ priorCritique, priorHtml }) → string` (renamed param: `priorVars` → `priorHtml`)
- Retry path in `render-worker.js` validates the new HTML for the stage marker before assigning to `currentHtml`

**Risks called out:**
- Opus might emit HTML that violates Hyperframes contract subtly (e.g., wrong `data-duration` value, missing `paused: true`). Belt-and-suspenders: stage-marker regex check rejects the most common failure. Subtler bugs (like a non-paused timeline that auto-plays during hyperframes scrubbing) will surface as bad frames → critic catches.
- Retry path duplicates the regex strip logic. Acceptable duplication (used twice); 3.4-B may centralize.
- Opus output > 4KB may be cut off at `max_tokens: 4096`. The lower-third template is 2.6KB so 4096 tokens (≈12KB output) is a generous ceiling. If Opus runs over, we get a parse failure → caught by stage-marker check → fail render.
