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
