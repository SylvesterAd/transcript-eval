// server/services/graphics/html-generator.js
//
// Opus generates a complete HTML file matching the Hyperframes contract.
// Replaces the older specToVars + template-substitution path. Adapt the
// prompt's few-shot example to evolve the supported visual styles.

import { callAnthropic } from '../../lib/llm/anthropic.js'
import { MODEL_FOR, costCents } from './models.js'

export const FEW_SHOT_LOWER_THIRD = `<!doctype html>
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
      tl.fromTo("#lt-bar", { autoAlpha: 0, x: -60 }, { autoAlpha: 1, x: 0, duration: 0.6, ease: "back.out(1.6)" }, 0.1);
      tl.fromTo("#lt-main", { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0.4);
      tl.fromTo("#lt-sub", { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.6);
      // mid-scene activity: subtle letter-spacing breathe on the headline
      tl.to("#lt-main", { letterSpacing: "0.02em", duration: 2, ease: "sine.inOut", yoyo: true, repeat: 1 }, 1.5);
      tl.to("#lt-bar", { autoAlpha: 0, x: -40, duration: 0.5, ease: "power2.in" }, Math.max(0.1, 8 - 0.7));
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`

export const FEW_SHOT_LOWER_THIRD_WITH_LOGO = `<!doctype html>
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
      tl.fromTo("#lt-bar", { autoAlpha: 0, x: -60 }, { autoAlpha: 1, x: 0, duration: 0.6, ease: "back.out(1.6)" }, 0.1);
      tl.fromTo("#lt-main", { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0.4);
      tl.fromTo("#lt-sub", { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.6);
      tl.fromTo("#lt-logo", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5, ease: "power2.out" }, 0.7);
      // mid-scene activity: subtle letter-spacing breathe on the headline
      tl.to("#lt-main", { letterSpacing: "0.02em", duration: 2, ease: "sine.inOut", yoyo: true, repeat: 1 }, 1.5);
      tl.to("#lt-bar", { autoAlpha: 0, x: -40, duration: 0.5, ease: "power2.in" }, Math.max(0.1, 8 - 0.7));
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`

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

## DETERMINISM RULES (BANNED APIS — never use these)

The render is frame-by-frame on headless Chromium; non-deterministic state poisons capture.

| Banned                              | Use instead                                              |
| ----------------------------------- | -------------------------------------------------------- |
| Math.random()                       | A seeded PRNG (mulberry32 inline; deterministic)         |
| Date.now()                          | Hard-coded numeric timing or tl.time() inside onUpdate   |
| performance.now()                   | Same — tl.time() inside onUpdate                         |
| setInterval / setTimeout            | Timeline tweens with onUpdate                            |
| repeat: -1                          | repeat: Math.ceil(duration / cycle) - 1                  |
| stagger: { from: "random" }         | from: "start" | "center" | "end"                         |
| Async timeline construction         | Build timelines synchronously at page load               |

## ANIMATION BASELINES

- **Mid-scene activity:** every visible element must keep moving AFTER its entrance. A still element on a still background is a JPEG with a progress bar.
- **Easing variety:** use at least 3 different eases per scene. Don't default to power2.out everywhere. Approved: power2.out, power4.out, back.out(1.6), expo.out, sine.inOut, steps(5).
- **Display sizes:** headlines ≥60px, body ≥20px, labels ≥16px.
- **Reading-time budget per text element:** no text 1.5–2s; 1–3 words 2–3s; 4–10 words 3–4s; 11–20 words 4–6s; 21–35 words 6–8s; 35+ words split. Hard 5s ceiling for any single text element's on-screen time, unless justified.
- **Weight contrast:** 300 vs 900, not 400 vs 700.

## VISIBILITY (autoAlpha)

When shader transitions fire, HyperShader blanks ALL .scene elements to opacity:0. Non-anchor scenes that only toggle visibility get poisoned.

For NON-ANCHOR scenes, use autoAlpha (sets BOTH opacity AND visibility):

    tl.set("#sceneN", { autoAlpha: 1 }, <data-start>)
    tl.set("#sceneN", { autoAlpha: 0 }, <data-start + data-duration>)

For ANCHOR scenes (HyperShader-managed), do NOT use autoAlpha. The first anchor in each shader group needs an explicit opacity:1 reset:

    tl.set("#sceneN", { opacity: 1 }, <data-start>)

Scene 1 typically gets only the autoAlpha hide (it starts visible).

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

const STAGE_MARKER = /data-composition-id\s*=\s*"main"/i

export async function specToHtml({ spec, additionalSystemContext = null }) {
  const systemPrompt = additionalSystemContext
    ? `${CREATE_HTML_SYSTEM_PROMPT}\n\n## CORRECTIONS REQUESTED\n${additionalSystemContext}`
    : CREATE_HTML_SYSTEM_PROMPT
  const r = await callAnthropic({
    model: MODEL_FOR.create,
    system: systemPrompt,
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
