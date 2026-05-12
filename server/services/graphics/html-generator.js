// server/services/graphics/html-generator.js
//
// Opus generates a complete HTML file matching the Hyperframes contract.
// Replaces the older specToVars + template-substitution path. Adapt the
// prompt's few-shot example to evolve the supported visual styles.

import { callAnthropic } from '../../lib/llm/anthropic.js'
import { MODEL_FOR, costCents } from './models.js'
import {
  HYPERFRAMES_CLAUDE_DESIGN_GUIDE,
  HYPERFRAMES_GUIDE_SHA,
} from './prompts/hyperframes-claude-design.js'

export const FEW_SHOT_LOWER_THIRD = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@300;700;900&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; background: transparent; overflow: hidden; font-family: "Roboto Condensed", sans-serif; }
      .lt-bar { position: absolute; bottom: 80px; left: 80px; height: 120px; background: rgba(0,0,0,0.78); border-left: 4px solid #9ca3af; padding: 14px 22px; opacity: 0; display: flex; flex-direction: column; justify-content: center; max-width: 1056px; }
      .lt-main { font-weight: 900; font-size: 64px; color: #fafaf5; letter-spacing: 0.01em; line-height: 1.05; white-space: nowrap; }
      .lt-sub { margin-top: 6px; font-family: "JetBrains Mono", monospace; font-weight: 400; font-size: 20px; color: #9ca3af; letter-spacing: 0.18em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <div id="main" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="8">
      <div class="scene clip" id="s1" data-start="0" data-duration="8" data-track-index="0">
        <div class="scene-content">
          <div class="lt-bar" id="lt-bar">
            <div class="lt-main" id="lt-main">Anna Rivera</div>
            <div class="lt-sub" id="lt-sub">SENIOR JOURNALIST · BERLIN</div>
          </div>
        </div>
      </div>
    </div>
    <script>
      gsap.set("#lt-bar", { autoAlpha: 0, x: -40 });
      gsap.set("#lt-main", { autoAlpha: 0, y: 12 });
      gsap.set("#lt-sub",  { autoAlpha: 0, y: 8 });

      const tl = gsap.timeline({ paused: true });
      tl.to("#lt-bar",  { autoAlpha: 1, x: 0, duration: 0.6, ease: "back.out(1.6)" }, 0.2);
      tl.to("#lt-main", { autoAlpha: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0.4);
      tl.to("#lt-sub",  { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.55);
      // mid-scene breathe
      tl.to("#lt-main", { letterSpacing: "0.02em", duration: 2, ease: "sine.inOut", yoyo: true, repeat: 1 }, 1.5);
      // exit
      tl.to(["#lt-bar", "#lt-main", "#lt-sub"], { autoAlpha: 0, duration: 0.5, ease: "power2.in" }, 7.3);

      window.__timelines = window.__timelines || {};
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
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@300;700;900&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; background: transparent; overflow: hidden; font-family: "Roboto Condensed", sans-serif; }
      .lt-bar { position: absolute; bottom: 80px; left: 80px; height: 120px; background: rgba(0,0,0,0.78); border-left: 4px solid #9ca3af; padding: 14px 22px 14px 80px; opacity: 0; display: flex; flex-direction: column; justify-content: center; max-width: 1056px; }
      .lt-logo { position: absolute; left: 22px; top: 50%; transform: translateY(-50%); height: 60px; filter: brightness(0) invert(1); }
      .lt-main { font-weight: 900; font-size: 64px; color: #fafaf5; letter-spacing: 0.01em; line-height: 1.05; white-space: nowrap; }
      .lt-sub { margin-top: 6px; font-family: "JetBrains Mono", monospace; font-weight: 400; font-size: 20px; color: #9ca3af; letter-spacing: 0.18em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <div id="main" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="8">
      <div class="scene clip" id="s1" data-start="0" data-duration="8" data-track-index="0">
        <div class="scene-content">
          <div class="lt-bar" id="lt-bar">
            <img class="lt-logo" id="lt-logo" src="{{LOGO_URL}}" alt="{{LOGO_ALT}}" />
            <div class="lt-main" id="lt-main">Anna Rivera</div>
            <div class="lt-sub" id="lt-sub">SENIOR JOURNALIST · BERLIN</div>
          </div>
        </div>
      </div>
    </div>
    <script>
      gsap.set("#lt-bar", { autoAlpha: 0, x: -40 });
      gsap.set("#lt-logo", { autoAlpha: 0, scale: 0.7 });
      gsap.set("#lt-main", { autoAlpha: 0, y: 12 });
      gsap.set("#lt-sub",  { autoAlpha: 0, y: 8 });

      const tl = gsap.timeline({ paused: true });
      tl.to("#lt-bar",  { autoAlpha: 1, x: 0, duration: 0.6, ease: "back.out(1.6)" }, 0.2);
      tl.to("#lt-logo", { autoAlpha: 1, scale: 1, duration: 0.5, ease: "expo.out" }, 0.5);
      tl.to("#lt-main", { autoAlpha: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0.6);
      tl.to("#lt-sub",  { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.75);
      // mid-scene breathe + logo glow pulse
      tl.to("#lt-main", { letterSpacing: "0.02em", duration: 2, ease: "sine.inOut", yoyo: true, repeat: 1 }, 1.5);
      tl.to("#lt-logo", { filter: "brightness(0) invert(1) drop-shadow(0 0 8px rgba(255,255,255,0.6))", duration: 1.5, ease: "sine.inOut", yoyo: true, repeat: 1 }, 2.0);
      // exit
      tl.to(["#lt-bar", "#lt-logo", "#lt-main", "#lt-sub"], { autoAlpha: 0, duration: 0.5, ease: "power2.in" }, 7.3);

      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`

export const FEW_SHOT_MULTI_SCENE_WITH_SHADER = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/hyperframes@0.5.3/runtime/shader.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; background: #0a0a0d; overflow: hidden; color: #fafaf5; font-family: "Bebas Neue", sans-serif; }
      .scene-content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; }
      .kicker { font-family: "IBM Plex Mono", monospace; font-weight: 400; font-size: 20px; color: #f59e0b; letter-spacing: 0.3em; text-transform: uppercase; margin-bottom: 18px; }
      .headline { font-size: 144px; line-height: 0.95; letter-spacing: 0.02em; }
      .stat { font-family: "IBM Plex Mono", monospace; font-weight: 700; font-size: 240px; color: #f59e0b; font-variant-numeric: tabular-nums; }
      .stat-label { font-family: "IBM Plex Mono", monospace; font-weight: 400; font-size: 24px; color: #9ca3af; letter-spacing: 0.2em; text-transform: uppercase; margin-top: 24px; }
      .cta { font-size: 96px; }
    </style>
  </head>
  <body>
    <div id="main" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="11">
      <div class="scene clip" id="s1" data-start="0" data-duration="3" data-track-index="0">
        <div class="scene-content">
          <div class="kicker" id="s1-kicker">CHAPTER ONE</div>
          <div class="headline" id="s1-headline">THE OPENING ARGUMENT</div>
        </div>
      </div>
      <div class="scene clip" id="s2" data-start="3" data-duration="4" data-track-index="0" style="visibility:hidden;">
        <div class="scene-content">
          <div class="stat" id="s2-stat">0</div>
          <div class="stat-label" id="s2-label">PERCENT GROWTH</div>
        </div>
      </div>
      <div class="scene clip" id="s3" data-start="7" data-duration="4" data-track-index="0" style="opacity:0;">
        <div class="scene-content">
          <div class="cta" id="s3-cta">READ THE FULL STORY</div>
        </div>
      </div>
    </div>
    <script>
      // initial states
      gsap.set("#s1-kicker", { autoAlpha: 0, y: 20 });
      gsap.set("#s1-headline", { autoAlpha: 0, y: 30 });
      gsap.set("#s2-stat", { autoAlpha: 0 });
      gsap.set("#s2-label", { autoAlpha: 0, y: 8 });
      gsap.set("#s3-cta", { autoAlpha: 0, scale: 0.94 });

      const tl = gsap.timeline({ paused: true });

      // SCENE 1 (anchor — visible at t=0; HyperShader will manage exit into shader transition)
      tl.set("#s1", { opacity: 1 }, 0);                      // first anchor in shader group
      tl.to("#s1-kicker", { autoAlpha: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0.1);
      tl.to("#s1-headline", { autoAlpha: 1, y: 0, duration: 0.7, ease: "back.out(1.6)" }, 0.3);
      tl.to("#s1-headline", { letterSpacing: "0.04em", duration: 1.8, ease: "sine.inOut", yoyo: true, repeat: 1 }, 1.0);

      // SCENE 2 (non-anchor — appears after hard cut at t=3)
      tl.set("#s2", { autoAlpha: 1 }, 3);
      tl.to("#s2-stat", { autoAlpha: 1, duration: 0.4, ease: "power2.out" }, 3.1);
      // counter animation 0 → 187
      tl.to({ value: 0 }, {
        value: 187, duration: 1.6, ease: "expo.out",
        onUpdate: function() {
          document.getElementById("s2-stat").innerText = Math.floor(this.targets()[0].value);
        }
      }, 3.1);
      tl.to("#s2-label", { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, 3.6);
      // mid-scene glow pulse on the stat
      tl.to("#s2-stat", { filter: "drop-shadow(0 0 12px rgba(245,158,11,0.6))", duration: 1.5, ease: "sine.inOut", yoyo: true, repeat: 1 }, 4.5);
      tl.set("#s2", { autoAlpha: 0 }, 7);                    // hide before next scene

      // SCENE 3 (anchor — receives shader transition entry from scene 2 boundary)
      tl.to("#s3-cta", { autoAlpha: 1, scale: 1, duration: 0.7, ease: "back.out(1.6)" }, 7.2);
      // mid-scene breathe
      tl.to("#s3-cta", { letterSpacing: "0.06em", duration: 2.5, ease: "sine.inOut", yoyo: true, repeat: 1 }, 8.2);

      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;

      // Shader transition between s1 (anchor) and s3 (anchor); s2 is non-anchor between them.
      // Per canonical: scenes.length === transitions.length + 1 — here we wire only the s1↔s3 group.
      // Hard cut s1→s2 (no shader); hard cut s2→s3 (no shader); the shader runs between the
      // two anchor scenes (s1 and s3) via HyperShader's own boundary handling.
      window.HyperShader && window.HyperShader.init({
        bgColor: "#0a0a0d",
        scenes: ["s1", "s3"],
        timeline: tl,
        transitions: [
          { time: 6.75, shader: "cinematic-zoom", duration: 0.5 }
        ]
      });
    </script>
  </body>
</html>`

// Lottie adapter few-shot — demonstrates window.__hfLottie usage for scenes
// that scrub a Lottie animation in lockstep with the GSAP timeline. The
// `{{LOTTIE_ASSET_URL}}` token is a templating placeholder substituted by the
// codegen path from `spec.assetUrl` (Phase 3.3 grounding).
export const FEW_SHOT_LOTTIE_LOGO = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; background: #0a0a0f; overflow: hidden; }
      .stage { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
      .logo-wrap { width: 480px; height: 480px; }
      .tagline { position: absolute; bottom: 240px; left: 50%; transform: translateX(-50%); font-family: "Roboto Condensed", sans-serif; font-weight: 900; font-size: 72px; color: #fafaf5; letter-spacing: 0.05em; }
    </style>
  </head>
  <body>
    <div id="stage" class="stage" data-composition-id="main" data-start="0" data-duration="6" data-width="1920" data-height="1080">
      <div class="logo-wrap" id="logo-wrap"></div>
      <div class="tagline" id="tagline" style="opacity:0;">RIVERA &amp; CO</div>
    </div>
    <script>
      // Lottie adapter (window.__hfLottie) — load animation paused, scrubbed via timeline.
      const lottieAnim = lottie.loadAnimation({
        container: document.getElementById('logo-wrap'),
        renderer: 'svg',
        loop: false,
        autoplay: false,
        path: '{{LOTTIE_ASSET_URL}}'
      });
      window.__hfLottie = window.__hfLottie || {};
      window.__hfLottie.main = lottieAnim;

      const tl = gsap.timeline({ paused: true });
      tl.to({ frame: 0 }, {
        frame: 60, duration: 3, ease: 'power4.out',
        onUpdate: function() { lottieAnim.goToAndStop(this.targets()[0].frame, true); }
      }, 0);
      tl.to('#tagline', { autoAlpha: 1, y: 0, duration: 0.7, ease: 'back.out(1.6)' }, 1.6);
      tl.fromTo('#tagline', { letterSpacing: '0.02em' }, { letterSpacing: '0.05em', duration: 4, ease: 'sine.inOut' }, 2.0);

      window.__timelines = { main: tl };
    </script>
  </body>
</html>`

// The HTML-authoring system prompt is composed of three layers, in this order:
//   1. PIPELINE PREAMBLE — how the spec is delivered, what to output, our scene
//      template vocabulary, asset-URL conventions, aspect-ratio + tone mapping.
//   2. OFFICIAL HYPERFRAMES CLAUDE DESIGN GUIDE — vendored verbatim from
//      heygen-com/hyperframes @ ${HYPERFRAMES_GUIDE_SHA} (Apache-2.0). Owns the
//      hard contract, banned APIs, visibility rules, animation baselines,
//      typography, transition strategy, mid-scene activity, and the self-review
//      checklist. Don't re-state these in the preamble — just defer.
//   3. FEW-SHOT EXAMPLES — our pipeline-specific complete HTML files (lower-
//      third, logo'd lower-third, multi-scene with shader transition).
const PIPELINE_PREAMBLE = `You are an HTML motion-graphics author for the Hyperframes pipeline. The user message will contain a spec JSON object with one or more scenes; you produce a SINGLE complete HTML file rendering it. The framework renders to MP4 by scrubbing one paused GSAP timeline frame-by-frame.

## Output rules
- Output ONLY the complete HTML. No commentary, no markdown fences, no explanation.
- The document MUST satisfy every rule in the "Claude Design + HyperFrames" guide below (hard contract, banned APIs, self-review checklist, etc.). Treat that guide as authoritative.

## Spec → composition mappings (pipeline-specific; the guide does not cover these)

### Aspect ratio → composition root width × height
- 16:9 → 1920 × 1080
- 9:16 → 1080 × 1920
- 1:1  → 1080 × 1080

### Tone → accent color (CSS hex)
- analytical → #f59e0b
- dramatic   → #dc2626
- neutral    → #9ca3af
- playful    → #10b981

### Scene \`template\` field — intent hint that drives layout
The \`template\` field on each scene signals what kind of scene it is. Pick layout/composition from this — do NOT default everything to lower-third bars.
- \`lower-third\`: name/role bar bottom-left; rest of frame transparent (see Few-shot A/B).
- \`title-card\`: fullscreen centered headline + optional subline. Big type, generous negative space; suitable for openers, section breaks, summary frames.
- \`map\`: the frame IS a map. If spec.assets has a "map" / "background" image, render it full-bleed via \`<img>\` (HTTPS URL — never base64, never an inline mega-SVG). Overlay regions, arrows, hotspots, frontline strokes, and city labels using INLINE \`<svg>\` elements positioned absolutely on top of the base img, animated through the GSAP timeline (stroke-dashoffset for arrows, opacity pulses for hotspots, etc.). mainText/subText become a broadcast title overlay (top strip or corner card), NOT the primary subject. A war-map sequence MUST render real maps per scene — do not produce eight lower-third bars instead.
- \`chart\`: data viz as the primary subject. Use chart.js (CDN allowed per the guide's resource policy) for axis-bound viz, or hand-rolled SVG/divs for bars/lines/counters. mainText/subText become the chart title + caption.
- \`freeform\`: use your judgment based on mainText/subText, assets, and the brief.

### Asset usage (when spec.assets is present)
Each entry: \`{ role, url, alt, source }\`. Follow the guide's media rules — HTTPS URL or local file reference only; never base64; never placeholder URLs; never SVG-filter \`data:image/svg+xml\` grain.
- \`logo\` / \`icon\` → \`<img src="<url>" alt="<alt>" />\`. White-on-dark hint: \`filter: brightness(0) invert(1);\`.
- \`background\` → CSS background on a wrapper div: \`background: url('<url>') center/cover no-repeat;\`.
- \`map\` → full-bleed \`<img>\` background per the \`map\` template rule above. NEVER paste a giant base-map SVG inline; overlay arrows/hotspots as small inline \`<svg>\` per scene.
- \`chart\` / generic image → \`<img>\` or hand-rolled inline \`<svg>\` as appropriate.
- ALWAYS include the \`alt\` attribute on \`<img>\` tags.
- Compose layouts that show the asset prominently — don't hide it behind text or off-screen.

## Resources the renderer allows
Google Fonts CSS; GSAP 3.14.x from cdn.jsdelivr.net; chart.js from cdn.jsdelivr.net; lottie-web from cdn.jsdelivr.net (only if a scene uses the lottie adapter); image / SVG URLs declared in spec.assets[].url. NO other \`<script src>\` URLs.

---

# Authoritative authoring guide

Everything below this line is the official Hyperframes Claude Design guide vendored verbatim. It is the source of truth for the hard contract, banned APIs, visibility (autoAlpha) rules, shader transitions, typography, easing → feeling, mid-scene activity patterns, and the self-review checklist. Follow it literally.

`

export const CREATE_HTML_SYSTEM_PROMPT = `${PIPELINE_PREAMBLE}${HYPERFRAMES_CLAUDE_DESIGN_GUIDE}

---

# Pipeline-specific few-shot examples

These are complete HTML files matching this pipeline's data-attribute conventions. They are visual baselines for the lower-third and multi-scene shapes; vary layouts as the spec calls for it (title cards, charts, maps, mixed content) while honoring every rule above.

## Few-shot A — single-scene composition (lower-third)
\`\`\`html
${FEW_SHOT_LOWER_THIRD}
\`\`\`

## Few-shot B — single-scene with embedded logo
\`\`\`html
${FEW_SHOT_LOWER_THIRD_WITH_LOGO}
\`\`\`

## Few-shot C — multi-scene composition with shader transition
\`\`\`html
${FEW_SHOT_MULTI_SCENE_WITH_SHADER}
\`\`\``

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

export const REFINE_HTML_SYSTEM_PROMPT = `You are the Hyperframes edit-bay refiner. You receive an EXISTING HTML motion-graphic and SCENE-SCOPED CRITIQUE feedback. Your job is to APPLY the feedback by editing the HTML in place.

The critique is formatted as scene-by-scene notes:
  Scene 1: <feedback for scene 1, or "ok">
  Scene 2: <feedback for scene 2, or "ok">
  ...

Editing rules:
- Edit ONLY the scenes the critique names with actionable feedback.
- If a critique entry says "ok" or has no actionable item, leave that scene's HTML EXACTLY as-is — do not touch its data-start, data-duration, internal layout, or tweens.
- Preserve the composition root identity (data-composition-id="main", data-width, data-height, data-start). Its data-duration may change ONLY when a scene's duration changes (see cascade rule below).
- Preserve the GSAP timeline structure (the single window.__timelines["main"] paused timeline).
- Preserve all stage markers on scene clips (class="scene clip", id="sN", data-start, data-duration, data-track-index).
- If the critique calls for a duration change on Scene N, you may adjust Scene N's data-duration, cascade Scene (N+1)+'s data-start values, AND recalculate the composition root's data-duration to equal the new sum of all scene durations. Do NOT change unrelated scenes' content.
- If the critique calls for a font change, color change, or other style change on Scene N, edit only Scene N's content elements (inside its <div class="scene-content">) and Scene N's tween targets.
- Do NOT add new scenes or remove existing scenes.
- Do NOT restructure unrelated portions of the HTML. If a scene is not mentioned in the critique, it must come back byte-identical.

Output ONLY the complete refined HTML. No commentary, no markdown fences. The HTML must include <!doctype html>, a <div data-composition-id="main">, and a <script> exposing window.__timelines["main"].

## ORIGINAL CONSTRAINTS (must still hold after refinement)

${CREATE_HTML_SYSTEM_PROMPT}`

export async function refineHtml({ html, feedback, spec }) {
  if (!html) throw new Error('refineHtml: html required')
  if (typeof feedback !== 'string' || !feedback.trim()) {
    throw new Error('refineHtml: non-empty feedback required')
  }

  const userMessage = `EXISTING HTML:\n${html}\n\nCRITIQUE FEEDBACK:\n${feedback}\n\nSPEC:\n${JSON.stringify(spec, null, 2)}\n\nReturn the refined HTML only.`

  const r = await callAnthropic({
    model: MODEL_FOR.create,
    system: REFINE_HTML_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 8192,
  })

  let refined = r.text.trim()
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/, '')
    .trim()

  if (!STAGE_MARKER.test(refined)) {
    throw new Error(`refineHtml: refined output missing data-composition-id="main": ${refined.slice(0, 200)}`)
  }

  const cost = costCents(MODEL_FOR.create, r.tokens)
  return { html: refined, cost, tokens: r.tokens }
}
