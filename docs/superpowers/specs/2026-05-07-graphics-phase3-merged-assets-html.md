# Motion Graphics — Phase 3.3 + 3.4 Merged Design

**Status:** brainstorm draft, awaiting user approval before plan(s) are written.

## Goal

Replace the hardcoded `lower-third.html` template with **LLM-generated HTML** so the graphics flow can produce arbitrary motion-graphic templates (lower-thirds, title cards with backgrounds, logo reveals, charts, maps, multi-element compositions). The brief LLM picks visual assets (logos, photos, SVGs, maps) on the user's behalf via Gemini's built-in Google Search grounding — no custom Pexels/Wikimedia/Storyblocks API integration needed.

The user's words: "I want backgrounds, logos, .svg of maps, images, etc. → all that. Even charts, whatever." Asset choice mode: **auto-pick** (no per-asset approval flow).

## Architecture

```
┌─ Brief turn (existing chat flow, with grounding ON) ────────────────┐
│ user: "make a lower-third for Anna Rivera, journalist"              │
│ Gemini Flash + Google Search:                                       │
│   - already knows: spec fields                                      │
│   - now searches inline for any imagery user mentions               │
│   - emits [SPEC] block including spec.assets[]                      │
│       e.g. {"role":"logo","url":"https://...","alt":"WSJ logo"}     │
│ → spec_json persisted, render queued                                │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─ Render worker (existing drain loop, modified create step) ─────────┐
│ Opus 4.7 (NEW: emits HTML, not JSON vars)                           │
│   input:  spec + assets[] + Hyperframes contract reminders          │
│   output: complete index.html (1920x1080, GSAP timeline, paused)    │
│ renderTemplate (modified): writes raw HTML directly, runs hyperframes│
│ critic loop (unchanged): scores frames, retries up to 2x with feedback│
└─────────────────────────────────────────────────────────────────────┘
```

## Key decisions

### D1: Asset acquisition — Gemini grounding, NOT custom API integrations

- Enable `tools: [{googleSearch: {}}]` on the brief LLM call (Gemini SDK supports this natively).
- Update `BRIEF_SYSTEM_PROMPT` to instruct: when user mentions imagery, search and embed the URL in `spec.assets[]`.
- **Why:** zero new code surface for Pexels/Storyblocks/Wikimedia. Gemini already crawls the open web. License attribution flows through the URL's source page.
- **Trade-off:** less curated than Pexels (some results will be rough). Critic loop catches obvious failures (broken image, wrong logo). User can ask in chat to swap ("use a different one").

### D2: Opus generates a full HTML file, not JSON vars

- New `htmlGenerator.specToHtml({ spec })` replaces `specToVars`.
- New `CREATE_SYSTEM_PROMPT` teaches Opus the **Hyperframes contract**:
  - Root must be `<div id="stage" data-composition-id="main" data-start="0" data-duration="<dur>" data-width="<w>" data-height="<h>">`
  - Animations use GSAP: `const tl = gsap.timeline({paused: true}); ...; window.__timelines.main = tl;`
  - Only allowed external resources: Google Fonts (any), GSAP via jsdelivr CDN, asset URLs from `spec.assets[]`. No arbitrary scripts.
  - Charts: emit inline SVG or `<canvas>` + chart.js (allowed CDN).
- **Why:** the existing template's contract is small (2 invariants + a CSS budget). Opus is strong enough to honor it. Existing critic catches violations (blank frames, off-screen content).
- **Trade-off:** ~10× more output tokens vs. JSON vars (per-render cost: ~$0.04 → ~$0.20 for HTML gen). Acceptable for the expressivity gain.

### D3: Renderer just writes the HTML — no template files anymore

- `render-runner.js` `renderTemplate()` becomes `renderHtml()`: takes raw HTML string, writes `index.html`, runs hyperframes.
- Drop `server/services/graphics/templates/` directory (or keep `lower-third.html` as a hidden fallback for prompt few-shot examples).
- **Why:** the LLM IS the template engine now. No `{{var}}` substitution.

### D4: Spec extension — `assets` is an optional array on spec

```json
{
  "template": "lower-third" | null,
  "aspectRatio": "16:9", "duration": 8, ...,
  "assets": [
    { "role": "logo",       "url": "https://...", "alt": "WSJ logo", "source": "..." },
    { "role": "background", "url": "https://...", "alt": "skyline", "source": "..." }
  ]
}
```

- `assets` is OPTIONAL — pure-text lower-thirds still work.
- `template` becomes a **style hint** (or null for free-form), not a rigid template ID.
- `isSpecComplete()` does NOT require `assets` (that would block text-only renders).

### D5: Critic prompt sees the assets summary

- Evaluator's `spec` parameter already passed in. Add asset shorthand to the critic system prompt: "Frames may include images, logos, charts. Score fidelity (asset present and recognizable) but don't second-guess brand identity."
- **Why:** without this, critic might dock points for "unexplained imagery" which is actually a featured logo.

### D6: Failure modes (handled by existing critic loop)

| Failure | Detection | Recovery |
|---|---|---|
| Malformed HTML | puppeteer throws / blank frames | critic retries with feedback "rendered blank" |
| Off-canvas content | low fidelity score from critic | retry with feedback "content cropped" |
| 404 on asset URL | broken-image frame | retry; LLM picks different asset OR omits |
| Asset loads slowly | hyperframes captures pre-load | retry with explicit `image.complete` wait in HTML |
| LLM emits forbidden script | post-LLM regex sanitizer | reject HTML, retry |

The asset-load case (4) is the only genuine new risk; current pipeline doesn't deal with external assets. Mitigation: add a single `await Promise.all([...]).then(...)` shim in the LLM prompt for any `<img>` tags.

### D7: HTML size budget

- Cap LLM output at **8 KB** of HTML (~3000 output tokens). Forces concise CSS, no styling sprees.
- If LLM exceeds: critic likely passes anyway (large HTML doesn't hurt correctness), but bill is higher. Soft cap, not enforced.

### D8: Sub-phase split (implementation order)

1. **3.4-A — LLM-HTML for the existing lower-third style only.** No assets, no new templates. Smoke-test the pipeline by replacing `specToVars` with `specToHtml` while producing visually-identical output. Critic continues to validate. **Smallest possible win.**
2. **3.3 — Asset search via grounding.** Enable Gemini grounding on the brief flow, extend spec, persist asset URLs. Renderer gets `spec.assets[]` but doesn't yet weave them in (passes through to HTML-gen, which can use them or ignore them).
3. **3.4-B — Free-form HTML templates with assets.** Update CREATE_SYSTEM_PROMPT to invite arbitrary templates; LLM uses `spec.assets[]` URLs in the HTML. Add a couple of in-prompt few-shot examples (logo reveal, title with background, chart card).
4. **3.5 — Multi-scene.** After 3.4-B works: extend spec with `scenes: [{...}]`, render each independently, concatenate via ffmpeg. Critic per-scene.

## Risks

- **Opus HTML quality**: untested on this kind of prompt. May produce pretty but constraint-violating HTML. Mitigation: 3.4-A's smoke is the proof-of-concept; if Opus can't reliably emit Hyperframes-compatible HTML, fall back to a constrained template approach (3.4-A would expose this immediately).
- **Grounding cost/latency**: Google Search grounding adds latency to the brief turn. Acceptable if <2s; unacceptable if >5s per turn. 3.3's smoke step measures this.
- **Asset license/attribution**: Gemini grounding returns URLs but doesn't enforce licensing. We'll surface the source in the spec but won't block on license checks. Acceptable for internal/admin tool; would need rework before public release.
- **HTML sanitization**: an LLM emitting `<script src="evil.js">` is a real risk in untrusted-input scenarios. This pipeline is admin-only and the HTML never reaches a user's browser (only the pre-rendered MP4 does), so the threat surface is limited to "Opus accidentally exfiltrates data." Belt-and-suspenders: regex-strip `<script>` blocks not pointing at the GSAP/chart.js CDNs before passing to puppeteer.

## Open questions for the user

(1 question, not 5 — per "no ping-pong" preference.)

**Q1.** For sub-phase 3.4-A's smoke test, should the LLM-generated HTML for a lower-third **match the existing template's visual style** (so we can A/B old vs new and confirm zero regression), or **deliberately differ** (so the value of LLM-HTML is visible immediately)?

My recommendation: **match the existing style.** Reason: it isolates "is the path working?" from "is the LLM creative?" Once 3.4-A ships, 3.4-B is where creativity unlocks. Differs from the more exciting flavor but reduces variables in the smoke.

---

If you approve this design (with whichever answer to Q1), I'll:
1. Write the **3.4-A plan** first (smallest, clearest win — proves the pipeline)
2. Execute via subagent-driven-development
3. Then 3.3, then 3.4-B, then 3.5

Each ships its own branch, reviewed and pushed independently.
