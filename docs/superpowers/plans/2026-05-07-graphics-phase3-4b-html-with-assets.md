# Motion Graphics — Phase 3.4-B: HTML-gen consumes `spec.assets[]` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `CREATE_HTML_SYSTEM_PROMPT` so Opus actively embeds `spec.assets[]` URLs into the generated HTML (as `<img>` for raster, inline `<svg>` for SVG, CSS `background-image` for backgrounds). Relax the "stay close to lower-third style" constraint that 3.4-A added — Opus may compose new structures when the spec calls for them. Add a second few-shot example demonstrating asset use.

**Architecture:** Single file change to `server/services/graphics/html-generator.js`'s `CREATE_HTML_SYSTEM_PROMPT` constant. No new modules, no schema changes, no orchestrator changes. The asset shape is already plumbed in via 3.3 (assets land in `spec_snapshot_json.assets`). Existing critic loop catches any regressions (broken `<img>` tag → blank-frame critic feedback → retry).

**Tech Stack:** Node 22, vitest. Model unchanged: `claude-opus-4-7`.

**Out of scope:** Multi-scene (3.5), critic prompt updates for asset-aware grading, asset URL validation/sanitization (Belt-and-suspenders only — `spec.assets[].url` originates from Gemini-grounded search results, already vetted by being indexable on Wikimedia/etc.).

---

## File Structure

**Modified:**
- `server/services/graphics/html-generator.js` — extend `CREATE_HTML_SYSTEM_PROMPT` with asset guidance + second few-shot
- `server/services/graphics/__tests__/html-generator.test.js` — add tests asserting prompt mentions asset embedding + that asset URLs from a spec land in the user message

**Untouched:**
- `server/services/graphics/render-runner.js`, `render-worker.js`, `retry-prompt.js` — they pass spec through transparently
- `server/services/graphics/orchestrator.js`, `brief-prompt.js`, `session-state.js` — already produce/persist `spec.assets`
- Critic — accepts current spec (assets are extra fields, harmless)

---

### Task 1: Extend `CREATE_HTML_SYSTEM_PROMPT` with asset guidance + second few-shot

**Files:**
- Modify: `server/services/graphics/html-generator.js`

The change is purely additive in the system prompt: a new "Asset usage" section, a second few-shot example (`FEW_SHOT_LOWER_THIRD_WITH_LOGO`), and removing the "Stay close to this style for now" sentence.

- [ ] **Step 1: Read the current file**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-html-assets"
cat server/services/graphics/html-generator.js
```

You'll see imports, `FEW_SHOT_LOWER_THIRD` constant, `CREATE_HTML_SYSTEM_PROMPT` constant ending with "Stay close to this style for now. Future iterations will introduce free-form templates.", `STAGE_MARKER` regex, and `specToHtml` async function.

- [ ] **Step 2: Add `FEW_SHOT_LOWER_THIRD_WITH_LOGO` constant**

In `server/services/graphics/html-generator.js`, AFTER the existing `FEW_SHOT_LOWER_THIRD` constant (i.e. before `export const CREATE_HTML_SYSTEM_PROMPT = ...`), add:

```js
const FEW_SHOT_LOWER_THIRD_WITH_LOGO = `<!doctype html>
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
      .lt-bar { position: absolute; bottom: 80px; left: 80px; height: 130px; background: rgba(0,0,0,0.78); border-left: 4px solid #9ca3af; padding: 14px 22px; opacity: 0; display: flex; align-items: center; gap: 24px; max-width: 1100px; }
      .lt-text { display: flex; flex-direction: column; justify-content: center; }
      .lt-main { font-weight: 700; font-size: 56px; color: #fafaf5; letter-spacing: 0.01em; line-height: 1.05; white-space: nowrap; }
      .lt-sub { margin-top: 6px; font-family: "JetBrains Mono", monospace; font-weight: 400; font-size: 18px; color: #9ca3af; letter-spacing: 0.18em; text-transform: uppercase; }
      .lt-logo { height: 80px; display: flex; align-items: center; }
      .lt-logo img { height: 100%; width: auto; filter: brightness(0) invert(1); }
    </style>
  </head>
  <body>
    <div id="stage" data-composition-id="main" data-start="0" data-duration="8" data-width="1920" data-height="1080">
      <div class="lt-bar" id="lt-bar">
        <div class="lt-text">
          <div class="lt-main" id="lt-main">Anna Rivera</div>
          <div class="lt-sub" id="lt-sub">Senior journalist, WSJ</div>
        </div>
        <div class="lt-logo" id="lt-logo">
          <img src="https://upload.wikimedia.org/wikipedia/commons/4/4a/WSJ_Logo.svg" alt="WSJ logo" />
        </div>
      </div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#lt-bar", { opacity: 0, x: -60 }, { opacity: 1, x: 0, duration: 0.6, ease: "expo.out" }, 0.1);
      tl.fromTo("#lt-main", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5 }, 0.4);
      tl.fromTo("#lt-sub", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5 }, 0.6);
      tl.fromTo("#lt-logo", { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.7);
      tl.to("#lt-bar", { opacity: 0, x: -40, duration: 0.5, ease: "power2.in" }, Math.max(0.1, 8 - 0.7));
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`
```

(Notes: 130px-tall bar with flex row containing text + logo; logo uses `filter: brightness(0) invert(1)` to render the dark Wikimedia SVG as white-on-dark; new timeline step fades the logo in just after the sub text.)

- [ ] **Step 3: Replace `CREATE_HTML_SYSTEM_PROMPT` constant**

Replace the entire `export const CREATE_HTML_SYSTEM_PROMPT = \`...\`;` block with this:

```js
export const CREATE_HTML_SYSTEM_PROMPT = `You are an HTML motion-graphics author for the Hyperframes pipeline. Given a spec, you write a single complete HTML file that Hyperframes renders to MP4 by scrubbing GSAP timelines frame-by-frame.

# Hard contract (must always hold)
1. Root element MUST be: <div id="stage" data-composition-id="main" data-start="0" data-duration="<DURATION>" data-width="<W>" data-height="<H>">…</div>
2. Animations: define a SINGLE GSAP timeline, paused, assigned to window.__timelines.main.
   Example: const tl = gsap.timeline({ paused: true }); ...; window.__timelines.main = tl;
3. Allowed external resources: Google Fonts CSS; GSAP from cdn.jsdelivr.net; chart.js from cdn.jsdelivr.net; image/SVG URLs from spec.assets[].url. NO other <script src> URLs.
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

# Asset usage (when spec.assets is present)
The spec may include an \`assets\` array. Each entry has { role, url, alt, source }.
- "logo" / "icon" → embed as <img src="<url>" alt="<alt>" /> sized appropriately for the layout.
  Hint: a logo on a dark bar usually wants \`filter: brightness(0) invert(1);\` for white-on-dark.
- "background" → set as a CSS background on body or a wrapper div: \`background: url('<url>') center/cover no-repeat\`.
- "map" / "chart" / generic image → <img> or inline <svg> as appropriate.
- If a "chart-data" role contains JSON-shaped data, render with chart.js inline.
- ALWAYS include the \`alt\` attribute on <img> tags for accessibility.
- Compose layouts that show the asset prominently — don't hide it behind text or off-screen.

# Few-shot example A — lower-third (no assets)
\`\`\`html
${FEW_SHOT_LOWER_THIRD}
\`\`\`

# Few-shot example B — lower-third with embedded logo
For specs that include an \`assets\` entry with role "logo", produce something like:
\`\`\`html
${FEW_SHOT_LOWER_THIRD_WITH_LOGO}
\`\`\`

These examples define the visual baseline. Vary layouts as the spec calls for it (e.g. fullscreen title cards, charts, maps) while honoring the hard contract.`
```

(Key changes vs. 3.4-A: added "image/SVG URLs from spec.assets[].url" to allowed-resources rule 3; new "Asset usage" section; renamed example to "Example A"; added "Example B" using `${FEW_SHOT_LOWER_THIRD_WITH_LOGO}`; replaced "Stay close to this style for now. Future iterations will introduce free-form templates." with a more permissive closing line.)

- [ ] **Step 4: Run existing tests to confirm no regression**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-html-assets"
npx vitest run server/services/graphics/__tests__/html-generator.test.js
```

Expected: all 4 existing tests still pass (none of them inspect the system prompt content beyond its presence — they exercise `specToHtml` end-to-end).

- [ ] **Step 5: Commit**

```bash
git add server/services/graphics/html-generator.js
git commit -m "feat(graphics): create-prompt teaches asset embedding"
```

---

### Task 2: Add a test asserting the system prompt teaches asset embedding

**Files:**
- Modify: `server/services/graphics/__tests__/html-generator.test.js`

A single test that the prompt now contains the asset-usage guidance (sanity check; cheap regression safety).

- [ ] **Step 1: Append a failing test (it'll pass — already implemented in Task 1; this is a docs-as-test)**

Append to `server/services/graphics/__tests__/html-generator.test.js` (within the existing `describe('specToHtml', ...)` block):

```js
  it('system prompt includes asset-usage guidance', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Asset usage/i)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/spec\.assets/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/<img src=/)
    expect(CREATE_HTML_SYSTEM_PROMPT).not.toMatch(/Stay close to this style for now/)
  })

  it('passes assets array to the LLM via the user message', async () => {
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
      spec: {
        template: 'lower-third',
        aspectRatio: '16:9',
        duration: 8,
        mainText: 'Anna Rivera',
        subText: 'Senior journalist',
        tone: 'neutral',
        assets: [
          { role: 'logo', url: 'https://example.com/wsj.svg', alt: 'WSJ logo', source: 'wikimedia.org' },
        ],
      },
    })
    const lastCall = callAnthropic.mock.calls.at(-1)[0]
    const userMsg = lastCall.messages[0].content
    expect(userMsg).toContain('"assets":')
    expect(userMsg).toContain('https://example.com/wsj.svg')
    expect(userMsg).toContain('"role": "logo"')
  })
```

- [ ] **Step 2: Run tests to verify both pass**

```bash
npx vitest run server/services/graphics/__tests__/html-generator.test.js
```

Expected: 6/6 pass (4 existing + 2 new).

- [ ] **Step 3: Commit**

```bash
git add server/services/graphics/__tests__/html-generator.test.js
git commit -m "test(graphics): assert create-prompt teaches asset embedding"
```

---

### Task 3: Verify full graphics suite

**Files:** none modified.

- [ ] **Step 1: Run all graphics-related tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-html-assets"
export DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | cut -d= -f2-)"
npx vitest run server/services/graphics/ server/lib/llm/ server/routes/__tests__/graphics.test.js
```

Expected: green. The system-prompt change is purely additive — it doesn't break any existing test fixtures.

---

### Task 4: Manual smoke against live Opus with assets

**Files:** none.

- [ ] **Step 1: Confirm `ANTHROPIC_API_KEY` is set**

```bash
node -e 'console.log("set:", !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY))'
```

If not, source from `.env`:
```bash
export $(grep -E '^ANTHROPIC_API_KEY=' "/Users/laurynas/Desktop/one last /transcript-eval/.env" | xargs)
```

- [ ] **Step 2: Drive a `specToHtml` call with assets**

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
      subText: "Senior journalist, WSJ",
      tone: "neutral",
      assets: [
        {
          role: "logo",
          url: "https://upload.wikimedia.org/wikipedia/commons/4/4a/WSJ_Logo.svg",
          alt: "WSJ logo",
          source: "wikimedia.org"
        }
      ]
    }
  });
  const ms = Date.now() - t0;
  console.log("=== latency_ms:", ms);
  console.log("=== cost_cents:", r.cost);
  console.log("=== tokens:", JSON.stringify(r.tokens));
  console.log("=== html_size_bytes:", r.html.length);
  console.log("--- HTML ---");
  console.log(r.html);
}).catch(e => { console.error("=== SMOKE FAIL ===", e.message); process.exit(1); });'
```

Expected:
- HTML contains `<img` element with the Wikimedia URL
- `data-composition-id="main"` present (sanity)
- alt text appears
- HTML still under ~5KB (the few-shots are bigger now, so output may be slightly larger — fine up to ~8KB)

If the HTML does NOT contain `<img` or the asset URL, that's a real prompt-engineering signal — DONE_WITH_CONCERNS.

- [ ] **Step 3: Sanity checks**

```bash
node --input-type=module -e '
import("./server/services/graphics/html-generator.js").then(async ({ specToHtml }) => {
  const r = await specToHtml({
    spec: { template: "lower-third", aspectRatio: "16:9", duration: 8, mainText: "Anna Rivera", subText: "Senior journalist, WSJ", tone: "neutral", assets: [{ role: "logo", url: "https://upload.wikimedia.org/wikipedia/commons/4/4a/WSJ_Logo.svg", alt: "WSJ logo", source: "wikimedia.org" }] }
  });
  const checks = {
    "data-composition-id=main": /data-composition-id="main"/i.test(r.html),
    "<img tag present": /<img\b/i.test(r.html),
    "Wikimedia URL embedded": /upload\.wikimedia\.org\/wikipedia\/commons\/4\/4a\/WSJ_Logo\.svg/.test(r.html),
    "alt attribute present": /alt=/i.test(r.html),
    "gsap paused timeline": /gsap\.timeline\(\s*\{\s*paused:\s*true/.test(r.html),
    "duration=8 in data attr": /data-duration="8"/.test(r.html),
  };
  for (const [k, v] of Object.entries(checks)) console.log((v ? "PASS" : "FAIL") + "  " + k);
})'
```

Expected: 6/6 PASS.

- [ ] **Step 4: DO NOT PUSH**

Per durable feedback. Surface the smoke output to the user.

---

## Self-Review (controller)

**Spec coverage:**
- ✅ `CREATE_HTML_SYSTEM_PROMPT` teaches asset embedding → Task 1
- ✅ Second few-shot demonstrating asset use → Task 1 (`FEW_SHOT_LOWER_THIRD_WITH_LOGO`)
- ✅ "Stay close to this style" relaxed → Task 1 (final sentence rewritten)
- ✅ No regressions in existing 4 tests → Task 1 Step 4 verifies; Task 3 full-suite verifies
- ✅ Smoke proves Opus actually uses URLs → Task 4

**Placeholder scan:** None. All code blocks complete.

**Type consistency:**
- `spec.assets` shape matches what 3.3 produces: `[{role, url, alt, source}]`. The system prompt names exactly those four fields.
- Filter trick `brightness(0) invert(1)` is valid CSS and renders SVG-as-white. Robust against most logo SVGs (single-color or filled paths). Multicolor logos may degrade gracefully (turn into a white silhouette) — acceptable for a baseline.

**Risks called out:**
- Opus might decide to skip the asset entirely if it judges the layout doesn't fit. The new prompt explicitly says "Compose layouts that show the asset prominently — don't hide it behind text or off-screen" but compliance varies. The smoke validates this directly; if Opus ignores assets, follow-up prompt iteration is needed.
- Charts not exemplified in a few-shot — only mentioned in the asset-usage section. If the user later asks for chart-heavy renders, may need a Few-shot example C in a follow-up phase.
- Prompt size grew from ~2.5KB to ~5KB. Input-token cost doubled per call (~2700 in vs ~1700 in based on 3.4-A's smoke). Per-render-iteration cost goes from ~$0.11 to ~$0.13 — minor.
- Asset URL might 404 at render time (LLM hallucinated, or asset moved). Critic catches this via "broken image" frame critique → retry. Existing failure mode handles it.
