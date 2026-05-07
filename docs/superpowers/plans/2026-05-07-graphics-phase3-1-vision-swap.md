# Motion Graphics — Phase 3.1: Critic Vision Swap to Gemini 3 Flash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Opus-4.7-vision with Gemini 3 Flash in the critic-loop evaluator to cut per-iteration vision cost by ~10–20× without changing behavior or return contract.

**Architecture:** Extend `callGemini` to accept multipart `content` (mix of `{ text }` and `{ inlineData: { mimeType, data } }` parts), then rewrite `server/services/graphics/critic/evaluator.js` to use it with `gemini-3-flash-preview`. The evaluator's return shape (`{score, criteria, feedback, retry_recommended, tokens}`) stays identical, so `critic-runner.js`, `render-worker.js`, and the integration test need zero downstream changes.

**Tech Stack:** Node 22, `@google/generative-ai` (already a project dep), vitest. Model: `gemini-3-flash-preview` (consistent with the rest of this codebase's Gemini usage).

**Out of scope:** Asset search, multi-scene, LLM-generated HTML, iteration history UI. All reserved for 3.2-3.5.

---

## File Structure

**Modified:**
- `server/lib/llm/gemini.js` — add multipart `content` support to `callGemini`
- `server/lib/llm/__tests__/gemini.test.js` — NEW; tests text + multipart paths
- `server/services/graphics/critic/evaluator.js` — swap from `callAnthropic` to `callGemini` with image parts
- `server/services/graphics/critic/__tests__/evaluator.test.js` — re-mock to `callGemini`, keep both test cases (parse OK + parse fail)

**Untouched (verified before each task):**
- `server/services/graphics/critic/critic-runner.js` — calls `evaluateFrames`, signature preserved
- `server/services/graphics/render-worker.js` — same
- `server/services/graphics/__tests__/critic-loop-integration.test.js` — mocks `evaluator.js` at the module boundary, unaffected

---

### Task 1: Extend `callGemini` to accept multipart `content`

**Files:**
- Modify: `server/lib/llm/gemini.js`
- Test: `server/lib/llm/__tests__/gemini.test.js` (new)

The current wrapper only handles `messages[*].content` as a string and calls `chat.sendMessage(lastMsg.content)`. For vision we need the last user message to carry image parts alongside text. Backwards-compatible extension: when `content` is a string, behave as today; when it's an array, pass it through to `sendMessage` as a parts array.

- [ ] **Step 1: Write the failing tests**

```js
// server/lib/llm/__tests__/gemini.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMessage = vi.fn()
const startChat = vi.fn(() => ({ sendMessage }))
const getGenerativeModel = vi.fn(() => ({ startChat }))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({ getGenerativeModel })),
}))

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test'
  sendMessage.mockReset()
  startChat.mockClear()
  getGenerativeModel.mockClear()
  sendMessage.mockResolvedValue({
    response: {
      text: () => 'ok',
      functionCalls: () => [],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      candidates: [{ finishReason: 'STOP' }],
    },
  })
})

describe('callGemini', () => {
  it('passes a plain string when content is a string (back-compat)', async () => {
    const { callGemini } = await import('../gemini.js')
    await callGemini({
      model: 'gemini-3-flash-preview',
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(sendMessage).toHaveBeenCalledWith('hi')
  })

  it('passes a parts array when content is an array (multipart)', async () => {
    const { callGemini } = await import('../gemini.js')
    await callGemini({
      model: 'gemini-3-flash-preview',
      system: 'be a critic',
      messages: [
        {
          role: 'user',
          content: [
            { text: 'Score these frames:' },
            { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
            { inlineData: { mimeType: 'image/png', data: 'BBBB' } },
          ],
        },
      ],
    })
    const arg = sendMessage.mock.calls[0][0]
    expect(Array.isArray(arg)).toBe(true)
    expect(arg).toHaveLength(3)
    expect(arg[0]).toEqual({ text: 'Score these frames:' })
    expect(arg[1].inlineData.mimeType).toBe('image/png')
    expect(arg[1].inlineData.data).toBe('AAAA')
  })

  it('returns normalized shape', async () => {
    const { callGemini } = await import('../gemini.js')
    const r = await callGemini({
      model: 'gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(r.text).toBe('ok')
    expect(r.tokens).toEqual({ in: 10, out: 5 })
    expect(r.stop).toBe('STOP')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-vision-gemini-flash"
npx vitest run server/lib/llm/__tests__/gemini.test.js
```
Expected: 2/3 fail (back-compat passes, multipart fails because current wrapper sends `lastMsg.content` directly which would be the array but Gemini SDK chokes / our normalization is wrong; normalized shape passes).

- [ ] **Step 3: Implement multipart support**

Replace the `callGemini` body's last-message handling:

```js
// server/lib/llm/gemini.js (full replacement of callGemini fn body)
export async function callGemini({ model, system, messages, tools, thinkingLevel = 'low', max_tokens = 4096 }) {
  const gen = getClient().getGenerativeModel({
    model,
    systemInstruction: system,
    generationConfig: {
      maxOutputTokens: max_tokens,
      temperature: 1.0, // Google warns: do NOT lower for Gemini 3 Flash
      thinkingConfig: { thinkingLevel },
    },
    tools,
  });
  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content,
  }));
  const lastMsg = messages[messages.length - 1];
  const chat = gen.startChat({ history });
  const result = await chat.sendMessage(lastMsg.content);
  const response = result.response;
  return {
    text: response.text(),
    toolUses: response.functionCalls() || [],
    tokens: {
      in: response.usageMetadata?.promptTokenCount || 0,
      out: response.usageMetadata?.candidatesTokenCount || 0,
    },
    stop: response.candidates?.[0]?.finishReason || 'STOP',
  };
}
```

The single change is in `history.map`: history now also accepts arrays (no-op for current callers; required if multipart messages ever appear in the history, which the critic doesn't need today but other callers might in 3.4). The last message — already passed verbatim to `sendMessage` — works as either string or parts-array because the SDK accepts both.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/lib/llm/__tests__/gemini.test.js
```
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/llm/gemini.js server/lib/llm/__tests__/gemini.test.js
git commit -m "feat(llm): callGemini accepts multipart content for vision"
```

---

### Task 2: Rewrite `evaluator.js` to use Gemini 3 Flash

**Files:**
- Modify: `server/services/graphics/critic/evaluator.js`
- Modify: `server/services/graphics/critic/__tests__/evaluator.test.js`

The evaluator's contract — `evaluateFrames({ framePaths, spec }) → { score, criteria, feedback, retry_recommended, tokens }` — is preserved. Only the underlying LLM call changes. Image encoding now produces Gemini's `inlineData` shape instead of Anthropic's `image source` shape.

- [ ] **Step 1: Update the test to mock `callGemini`**

```js
// server/services/graphics/critic/__tests__/evaluator.test.js (full replacement)
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../lib/llm/gemini.js', () => ({
  callGemini: vi.fn().mockResolvedValue({
    text: '{"score":0.85,"criteria":{"fidelity":0.9,"legibility":0.85,"style":0.8,"timing":0.85},"feedback":"Looks good","retry_recommended":false}',
    toolUses: [],
    tokens: { in: 1200, out: 80 },
    stop: 'STOP',
  }),
}))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, readFile: vi.fn().mockResolvedValue(Buffer.from('fake png')) }
})

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test'
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
    const { callGemini } = await import('../../../../lib/llm/gemini.js')
    callGemini.mockResolvedValueOnce({
      text: 'not json at all',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'STOP',
    })
    const { evaluateFrames } = await import('../evaluator.js')
    await expect(
      evaluateFrames({ framePaths: ['/tmp/f0.png'], spec: { template: 'lower-third' } })
    ).rejects.toThrow(/critic returned invalid JSON/i)
  })

  it('strips markdown fences from gemini responses', async () => {
    const { callGemini } = await import('../../../../lib/llm/gemini.js')
    callGemini.mockResolvedValueOnce({
      text: '```json\n{"score":0.7,"criteria":{"fidelity":0.7,"legibility":0.7,"style":0.7,"timing":0.7},"feedback":"meh","retry_recommended":true}\n```',
      toolUses: [],
      tokens: { in: 100, out: 10 },
      stop: 'STOP',
    })
    const { evaluateFrames } = await import('../evaluator.js')
    const r = await evaluateFrames({ framePaths: ['/tmp/f0.png'], spec: { template: 'lower-third' } })
    expect(r.score).toBe(0.7)
    expect(r.retry_recommended).toBe(true)
  })

  it('passes inlineData parts to callGemini', async () => {
    const { callGemini } = await import('../../../../lib/llm/gemini.js')
    callGemini.mockResolvedValue({
      text: '{"score":0.9,"criteria":{"fidelity":1,"legibility":1,"style":0.8,"timing":0.8},"feedback":"ok","retry_recommended":false}',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'STOP',
    })
    const { evaluateFrames } = await import('../evaluator.js')
    await evaluateFrames({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png', '/tmp/f3.png'],
      spec: { template: 'lower-third' },
    })
    const lastCall = callGemini.mock.calls.at(-1)[0]
    expect(lastCall.model).toBe('gemini-3-flash-preview')
    expect(Array.isArray(lastCall.messages[0].content)).toBe(true)
    const parts = lastCall.messages[0].content
    const imageParts = parts.filter((p) => p.inlineData)
    expect(imageParts).toHaveLength(4)
    expect(imageParts[0].inlineData.mimeType).toBe('image/png')
    expect(imageParts[0].inlineData.data).toBe(Buffer.from('fake png').toString('base64'))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run server/services/graphics/critic/__tests__/evaluator.test.js
```
Expected: existing tests fail (still using `callAnthropic`); new "passes inlineData parts" test fails.

- [ ] **Step 3: Rewrite `evaluator.js` to use Gemini**

```js
// server/services/graphics/critic/evaluator.js (full replacement)
//
// VLM critic. Sends N PNG frames + the spec to Gemini 3 Flash, asks for
// a structured score JSON, parses, returns. Throws on parse error so the
// caller can decide whether to retry with the same frames or skip.

import { readFile } from 'node:fs/promises'
import { callGemini } from '../../../lib/llm/gemini.js'

const SYSTEM_PROMPT = `You are a senior motion-graphics art director reviewing a rendered short clip frame-by-frame. You will receive a spec and N evenly-spaced keyframes from a single render.

Score the render across four criteria, each 0.0-1.0:
- fidelity: does the frame match the spec (template, text content, tone)?
- legibility: is text readable, contrast sufficient, no clipping?
- style: does it look like professional motion graphics, not LLM slop?
- timing: do the frames suggest a coherent animation arc (entry → hold → exit)?

Output ONLY this JSON shape, no markdown fences, no commentary:
{
  "score": 0.0-1.0,
  "criteria": { "fidelity": 0.0, "legibility": 0.0, "style": 0.0, "timing": 0.0 },
  "feedback": "one paragraph of specific actionable critique",
  "retry_recommended": true|false
}`

export async function evaluateFrames({ framePaths, spec }) {
  const imageParts = await Promise.all(
    framePaths.map(async (p) => {
      const buf = await readFile(p)
      return { inlineData: { mimeType: 'image/png', data: buf.toString('base64') } }
    })
  )
  const r = await callGemini({
    model: 'gemini-3-flash-preview',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { text: `Spec:\n${JSON.stringify(spec, null, 2)}\n\nFrames (in time order):` },
          ...imageParts,
        ],
      },
    ],
    max_tokens: 512,
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

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/services/graphics/critic/__tests__/evaluator.test.js
```
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/critic/evaluator.js server/services/graphics/critic/__tests__/evaluator.test.js
git commit -m "feat(graphics): swap critic vision model to gemini-3-flash"
```

---

### Task 3: Verify integration + downstream tests

**Files:** none modified. This task confirms downstream code (critic-runner, render-worker, integration) is untouched and still green.

- [ ] **Step 1: Run all critic-loop tests**

```bash
npx vitest run server/services/graphics/critic/__tests__/ server/services/graphics/__tests__/render-worker.test.js
```
Expected: all green. Render-worker test mocks `evaluator` at the module boundary so the swap is invisible to it.

- [ ] **Step 2: Run the end-to-end integration test against real Postgres**

```bash
export DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
npx vitest run server/services/graphics/__tests__/critic-loop-integration.test.js
```
Expected: 1/1 pass in <5s. The test mocks the evaluator directly so the swap doesn't affect it; the run is a regression check that nothing in the wider tree drifted.

- [ ] **Step 3: Run the full server test suite to catch any unexpected fallout**

```bash
npx vitest run server/
```
Expected: green (or no new failures vs main; pre-existing failures unrelated to graphics are fine — record their names if any in the commit body).

- [ ] **Step 4: Commit (docs + plan only — code already shipped)**

No code changes in this task. If any test fixtures needed updates, they go in Task 1 or 2's commit. This step is a checkpoint, not a commit.

---

### Task 4: Manual smoke against live Gemini

**Files:** none. Verifies real-world behavior before merge.

- [ ] **Step 1: Confirm `GOOGLE_GENERATIVE_AI_API_KEY` (or `GOOGLE_API_KEY`) is set**

```bash
node -e 'console.log("key set:", !!(process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY))'
```

- [ ] **Step 2: Drive a single critic call against four real PNGs**

Pick four frames from a recent successful render (any `/tmp/integration-x` work dir from a prior run), or generate four solid-color test PNGs:

```bash
node --experimental-vm-modules -e '
import("./server/services/graphics/critic/evaluator.js").then(async ({ evaluateFrames }) => {
  const r = await evaluateFrames({
    framePaths: ["/tmp/f0.png", "/tmp/f1.png", "/tmp/f2.png", "/tmp/f3.png"],
    spec: { template: "lower-third", mainText: "Test", subText: "Smoke", tone: "neutral" }
  })
  console.log(JSON.stringify(r, null, 2))
})'
```
Expected: JSON shape returned with score in [0,1], criteria object, feedback string, retry_recommended boolean. Token usage logged.

If the call returns a non-JSON response (Gemini occasionally wraps in fences despite the prompt — already handled), the test in Task 2 Step 4 covers that path.

- [ ] **Step 3: Compare cost back-of-envelope**

Note input tokens reported. Gemini 3 Flash is ~$0.075/Mtok input, ~$0.30/Mtok output (current public pricing as of 2026-05-07). With 4 PNG frames at ~258 tokens each + ~250-token prompt + ~80 output ≈ ~1300 in / 80 out per call ≈ ~$0.000123 per critic call vs Opus-4.7's ~$0.10. Per render with 3 iterations: ~$0.0004 vs ~$0.30 — ~750× cheaper.

If the per-call latency is materially higher than Opus (Gemini Flash is typically faster, but the vision path can be slower), note it for 3.4 planning.

- [ ] **Step 4: Push branch, surface PR-equivalent summary**

```bash
git push origin feat/graphics-vision-gemini-flash
```

Wait for user confirmation before fast-forwarding `main`.

---

## Self-Review (controller)

**Spec coverage:**
- ✅ Vision swap from Opus to Gemini 3 Flash → Tasks 1+2
- ✅ "Always use Gemini 3 Flash, no GPT-4o-mini" → model ID is `gemini-3-flash-preview` everywhere
- ✅ Behavior preserved → return shape identical, downstream untouched (Task 3 verifies)

**Placeholder scan:** None. All code blocks are complete-replacement-ready.

**Type consistency:** `evaluateFrames({ framePaths, spec }) → { score, criteria, feedback, retry_recommended, tokens }` is unchanged across the swap. `callGemini` accepts both string and array `content` (back-compat preserved). The new `inlineData` part shape matches Google SDK docs exactly.

**Risks called out:**
- Gemini Flash quality on motion-graphics critique is untested in this codebase. If scores cluster too high or too low vs Opus baseline, Task 4 Step 3 will surface it. Mitigation if needed: tune SYSTEM_PROMPT (out of scope for 3.1 unless smoke fails).
- Gemini sometimes wraps JSON in markdown fences despite the prompt. Existing fence-stripping in evaluator handles this; Task 2 adds an explicit test.
