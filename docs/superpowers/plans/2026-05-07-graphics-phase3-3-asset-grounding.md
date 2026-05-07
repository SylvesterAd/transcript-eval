# Motion Graphics — Phase 3.3: Asset Grounding via Gemini Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Google Search grounding on the brief LLM call so it can find and embed asset URLs (logos, backgrounds, SVGs of maps, charts data, etc.) directly into the spec when the user mentions imagery. No custom Pexels/Wikimedia API integration. Assets land in `spec.assets[]` and pass through to the renderer (consumption by HTML-gen lands in 3.4-B).

**Architecture:** Three small changes:
1. `orchestrator.js` — pass `tools: [{ googleSearch: {} }]` on the brief Gemini call (the existing `callGemini` wrapper already plumbs `tools` through to the SDK).
2. `brief-prompt.js` — extend `BRIEF_SYSTEM_PROMPT` with an "Assets" section: optional, format `[{role, url, alt, source}]`, search-and-pick when user mentions imagery.
3. `orchestrator.test.js` — assert tools array is passed on the brief call.

`session-state.js` is UNCHANGED — `mergeSpec` already accepts arbitrary keys, `isSpecComplete` doesn't gate on assets (they're optional). `html-generator.js` is also UNCHANGED for 3.3 — assets pass through to it via `spec.assets`, but the create prompt doesn't yet ask for them. 3.4-B will make HTML-gen actively use the field.

**Tech Stack:** Node 22, `@google/generative-ai` (Gemini search grounding via `tools: [{googleSearch: {}}]`), vitest. Model unchanged: `gemini-3-flash-preview`.

**Out of scope:** HTML-gen consuming assets (3.4-B), multi-scene (3.5), Pexels/Storyblocks integration (not needed — grounding is enough).

---

## File Structure

**Modified:**
- `server/services/graphics/orchestrator.js` — pass `tools` on brief callGemini call
- `server/services/graphics/brief-prompt.js` — extend system prompt with assets section
- `server/services/graphics/__tests__/orchestrator.test.js` — assert tools is passed

**Untouched (verified before each task):**
- `server/lib/llm/gemini.js` — already accepts and forwards `tools`
- `server/services/graphics/session-state.js` — `mergeSpec` is asset-agnostic; `isSpecComplete` doesn't require assets
- `server/services/graphics/html-generator.js` — assets pass through via spec; consumption is 3.4-B
- `server/services/graphics/render-worker.js` — consumes spec; doesn't care about assets shape

---

### Task 1: Extend `BRIEF_SYSTEM_PROMPT` with assets section

**Files:**
- Modify: `server/services/graphics/brief-prompt.js`

The new section instructs the LLM that it can include an `assets` array in the [SPEC] block. Each entry: `{role, url, alt, source}`. The LLM searches (via grounding) when the user mentions imagery; otherwise omits the field.

- [ ] **Step 1: Replace the prompt**

Full replacement of `server/services/graphics/brief-prompt.js`:

```js
// server/services/graphics/brief-prompt.js
import { REQUIRED_FIELDS } from './session-state.js';

export const BRIEF_SYSTEM_PROMPT = `You are a motion-graphics director. Your job is to interview the user and produce a complete spec for a single short motion graphic. The only template available right now is 'lower-third' (a name + role/subline that slides in from the bottom-left).

Required spec fields:
${REQUIRED_FIELDS.map((f) => `  - ${f}`).join('\n')}

Optional spec field:
  - assets: array of imagery referenced in the graphic, format [{role, url, alt, source}]
      - role: short label like "logo", "background", "map", "chart-data"
      - url: a fully-qualified HTTPS URL the renderer can fetch (image, SVG, etc.)
      - alt: short text description for accessibility
      - source: domain/publisher of the asset (e.g. "wikimedia.org", "wsj.com")
    Include an entry only when the user mentions a logo, background, map, chart, or other image.
    Use Google Search to find a reliable URL — prefer Wikimedia, official brand sites, or stable
    publisher pages. If no imagery is mentioned, omit the field entirely (don't emit \`assets: []\`).

Rules:
1. Ask ONE question at a time. Confirm understanding before moving on.
2. If the user says "you decide" for any field, fill it with a sensible default and TELL them what you chose so they can override.
3. NEVER call the render_now tool until all required fields are present.
4. When you ask a question, also include the current spec state in your reply formatted as a code block prefixed with [SPEC]:
   [SPEC]{"aspectRatio":"16:9","duration":null,...}
5. The frontend parses the [SPEC] block to update the sidebar.
6. Defaults to suggest if the user is unsure: aspectRatio=16:9, duration=8, tone=neutral.
7. Asset selection is auto: when the user mentions imagery, search and pick a high-quality URL yourself; do NOT ask the user to confirm each pick. They can request a swap by saying "different logo" / "different background".

When the spec is complete, respond with a single short confirmation ("Looks good. Rendering now.") and call the render_now tool with the full spec object.`;
```

(Notes: Required-field block stays as-is. New "Optional spec field" block + a new Rule 7 about auto-pick.)

- [ ] **Step 2: Sanity check the file**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-asset-grounding"
node -e "import('./server/services/graphics/brief-prompt.js').then(m => { console.log('len:', m.BRIEF_SYSTEM_PROMPT.length); console.log('has assets:', /Optional spec field/.test(m.BRIEF_SYSTEM_PROMPT)); })"
```

Expected: prints a length and `has assets: true`. (Lightweight smoke — no test runner needed for a pure-string export.)

- [ ] **Step 3: Commit**

```bash
git add server/services/graphics/brief-prompt.js
git commit -m "feat(graphics): brief prompt teaches optional assets[] field"
```

---

### Task 2: Pass `tools: [{ googleSearch: {} }]` on the brief Gemini call

**Files:**
- Modify: `server/services/graphics/orchestrator.js`
- Modify: `server/services/graphics/__tests__/orchestrator.test.js`

The existing `callGemini` wrapper already accepts and forwards a `tools` parameter to `getGenerativeModel({ tools })`. Google's SDK accepts the search-grounding declaration as `[{ googleSearch: {} }]` for Gemini 2+ models (Gemini 3 Flash supports it).

- [ ] **Step 1: Append a failing test**

Append to `server/services/graphics/__tests__/orchestrator.test.js` (within the existing `describe('orchestrator', ...)` block):

```js
  it('passes Google Search grounding tools on the brief callGemini call', async () => {
    const { callGemini } = await import('../../../lib/llm/gemini.js')
    callGemini.mockClear()
    callGemini.mockResolvedValue({
      text: '[SPEC]{"template":"lower-third"}',
      toolUses: [],
      tokens: { in: 100, out: 10 },
      stop: 'STOP',
    })
    const { runChatTurn } = await import('../orchestrator.js')
    await runChatTurn({ sessionId: 1, userMessage: 'use the WSJ logo' })
    const lastCall = callGemini.mock.calls.at(-1)[0]
    expect(lastCall.tools).toEqual([{ googleSearch: {} }])
    expect(lastCall.model).toBe('gemini-3-flash-preview')
  })
```

- [ ] **Step 2: Run the test to verify failure**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js
```

Expected: the new test fails (`tools` is `undefined` — orchestrator doesn't pass it yet).

- [ ] **Step 3: Update `orchestrator.js`**

In `server/services/graphics/orchestrator.js`, find this block (around line 47):

```js
const briefResp = await callGemini({
  model: MODEL_FOR.brief,
  system: BRIEF_SYSTEM_PROMPT,
  messages: history,
  thinkingLevel: 'low',
});
```

Replace with:

```js
const briefResp = await callGemini({
  model: MODEL_FOR.brief,
  system: BRIEF_SYSTEM_PROMPT,
  messages: history,
  thinkingLevel: 'low',
  tools: [{ googleSearch: {} }],
});
```

(Single-line addition: `tools: [{ googleSearch: {} }],`.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/services/graphics/__tests__/orchestrator.test.js
```

Expected: all tests pass (existing test + new tools assertion).

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/orchestrator.js server/services/graphics/__tests__/orchestrator.test.js
git commit -m "feat(graphics): brief flow uses Gemini Google Search grounding"
```

---

### Task 3: Verify full graphics suite

**Files:** none modified.

- [ ] **Step 1: Run all graphics-related tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-asset-grounding"
export DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | cut -d= -f2-)"
npx vitest run server/services/graphics/ server/lib/llm/ server/routes/__tests__/graphics.test.js
```

Expected: green. The grounding tools is purely additive at the LLM call site; no other behavior changes.

- [ ] **Step 2: Document any pre-existing failures**

Same `integration-flow.test.js` flake from 3.1/3.2/3.4-A may persist — confirm it's the same `processed=0` vs `processed=1` failure and not a new break.

---

### Task 4: Manual smoke against live Gemini with grounding

**Files:** none.

- [ ] **Step 1: Confirm Google API key is set**

```bash
node -e 'console.log("set:", !!(process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY))'
```

If not, source from .env:
```bash
export $(grep -E '^GOOGLE_API_KEY=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | xargs)
```

- [ ] **Step 2: Drive a single brief turn with imagery**

```bash
node --input-type=module -e '
import { callGemini } from "./server/lib/llm/gemini.js"
import { BRIEF_SYSTEM_PROMPT } from "./server/services/graphics/brief-prompt.js"
const r = await callGemini({
  model: "gemini-3-flash-preview",
  system: BRIEF_SYSTEM_PROMPT,
  messages: [
    { role: "user", content: "Make a lower-third for Anna Rivera, senior journalist at WSJ. 16:9, 8 seconds, neutral tone. Include the WSJ logo." }
  ],
  tools: [{ googleSearch: {} }],
})
console.log("=== text ===")
console.log(r.text)
console.log("=== tokens ===", r.tokens)
'
```

Expected:
- The reply contains a `[SPEC]` block
- The [SPEC] JSON includes a non-empty `assets` array, e.g. `[{"role":"logo","url":"https://upload.wikimedia.org/wikipedia/commons/...","alt":"WSJ logo","source":"wikimedia.org"}]`
- The URL is fetchable (HTTPS, real-looking host)

If grounding ISN'T returning real URLs (e.g. LLM emits placeholder strings), report DONE_WITH_CONCERNS — that's a real prompt-engineering signal and 3.3 needs a follow-up.

- [ ] **Step 3: HEAD-check the asset URL**

Pick the first URL from the response and HEAD it:

```bash
URL="<copy from previous output>"
curl -sI "$URL" | head -3
```

Expected: 200 OK with `content-type: image/...` (or 301/302 → 200). If 404, the LLM made up a URL — concerning but not a 3.3 bug; needs prompt iteration.

- [ ] **Step 4: DO NOT PUSH**

Per durable feedback. Wait for user to review.

---

## Self-Review (controller)

**Spec coverage:**
- ✅ Asset acquisition via grounding, no custom APIs → Tasks 1+2
- ✅ Auto-pick (no per-asset approval flow) → Rule 7 in prompt
- ✅ Scope: backgrounds / logos / SVGs / maps / charts → covered by `role` + `url` shape (LLM picks per-case)
- ✅ Spec stays back-compat → assets is optional; mergeSpec/isSpecComplete unchanged
- ✅ Plumbing-only for 3.3 → html-generator untouched (will consume in 3.4-B)

**Placeholder scan:** None. Each step has full code or a complete prose edit.

**Type consistency:**
- `spec.assets` shape: `[{role, url, alt, source}]` — declared in BRIEF_SYSTEM_PROMPT, no JS type validation needed since the data is LLM-emitted JSON parsed into spec_json (JSONB on the DB side).
- `tools: [{ googleSearch: {} }]` — matches the @google/generative-ai SDK shape.

**Risks called out:**
- LLM might emit `[SPEC]` with `assets: []` even when user mentioned no imagery (waste of tokens, harmless). Prompt explicitly says "omit the field entirely (don't emit `assets: []`)" but compliance varies.
- LLM might emit fake URLs (404). Mitigation in Task 4 Step 3 (curl HEAD check). If common, follow-up: add a server-side URL-validate pass before persist. Out of scope for 3.3 base.
- Grounding adds latency to brief turn (~1-3s extra per call). Acceptable for the use case — brief turns are already 1-2s.
- Grounding has cost: Google bills search-grounded calls separately ($0.035 per ~25 grounded calls per their docs as of 2026). Per-brief cost goes from ~$0.0003 → ~$0.001-0.002 with grounding. Negligible.
