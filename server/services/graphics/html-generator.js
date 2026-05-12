// server/services/graphics/html-generator.js
//
// Skeleton-fill flow:
//   1. buildSkeleton(spec) produces a valid Hyperframes shell — composition
//      root, scene clips, paused timeline declaration, and
//      window.__timelines["main"] = tl already wired. Three CLAUDE_FILL
//      markers wait for content: styles, per-scene innerHTML, and tweens.
//   2. Opus receives the skeleton + spec and is asked to replace ONLY the
//      markers. The rest of the file must come back byte-identical.
//   3. listSkeletonInvariantFailures() verifies the structural contract held
//      (composition root present, timeline registered, no markers left).
//
// This replaces the earlier "write the whole HTML from scratch" approach
// that kept silently dropping the `window.__timelines["main"] = tl` line —
// PRs #84, #86, #87, #89 each fixed adjacent issues; this one fixes the
// underlying problem (structural invariants implicit in a 50KB prompt
// instead of guaranteed by code).

import { callAnthropic } from '../../lib/llm/anthropic.js'
import { MODEL_FOR, costCents } from './models.js'
import {
  HYPERFRAMES_CLAUDE_DESIGN_GUIDE,
  HYPERFRAMES_GUIDE_SHA,
} from './prompts/hyperframes-claude-design.js'
import { buildSkeleton, listSkeletonInvariantFailures } from './skeleton-builder.js'

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

// Skeleton-fill system prompt structure (in this order):
//   1. FILL_INSTRUCTIONS — what the markers are, what is and isn't editable,
//      output format. The structural contract is locked in by code, not prompt.
//   2. PIPELINE_PREAMBLE — pipeline-specific style/asset/template conventions.
//   3. HYPERFRAMES_CLAUDE_DESIGN_GUIDE — vendored upstream guide (Apache-2.0,
//      heygen-com/hyperframes @ ${HYPERFRAMES_GUIDE_SHA}). Still the source of
//      truth for animation patterns, banned APIs, typography, easing → feeling,
//      visibility rules, mid-scene activity catalog. The "hard contract"
//      section is still useful as context — Opus needs to understand the shape
//      it's editing — but we no longer rely on Opus to reproduce it.
//   4. FEW_SHOTS — complete-file examples kept as visual anchors for style.
const FILL_INSTRUCTIONS = `You are filling in a Hyperframes composition skeleton. The skeleton has already been built for you — composition root, scene clips with correct data-* attributes, the paused GSAP timeline declaration, and the \`window.__timelines["main"] = tl\` registration are ALL pre-written. Your only job is to replace three kinds of CLAUDE_FILL markers with content.

## Markers to fill
1. \`/* CLAUDE_FILL_STYLES */\` (inside <style>) → CSS rules for the scene content (custom classes, scene-scoped styles, decorative elements, fonts, sizes).
2. \`<!-- CLAUDE_FILL_SCENE_N -->\` (inside each \`<div class="scene-content">\`) → the actual HTML for scene N (text elements, imgs, inline SVG overlays). Give every element a sensible \`id\` so GSAP can target it.
3. \`/* CLAUDE_FILL_TWEENS */\` (inside <script>, after the \`const tl = …\` line, before \`window.__timelines["main"] = tl\`) → the FULL set of GSAP timeline tweens for entrances, mid-scene activity, and exits across ALL scenes. Use \`tl.from\`, \`tl.to\`, \`tl.set\`. For non-first scenes, you MUST set \`autoAlpha: 1\` at the scene's data-start and \`autoAlpha: 0\` at data-start + data-duration (see the upstream guide's visibility section).

## Output rules — non-negotiable
- Output the COMPLETE HTML file with markers replaced. The rest of the file must come back BYTE-IDENTICAL to the input skeleton.
- DO NOT modify: <!doctype>, <html>, <head>, font links, GSAP <script src> tag, the composition root <div id="main" data-composition-id="main" ...>, any scene clip div's tag (you may only edit the contents of its \`<div class="scene-content">\` child), the \`const tl = gsap.timeline({ paused: true });\` line, the \`window.__timelines["main"] = tl\` registration, the closing </body>/</html>.
- DO NOT add or remove scenes. The skeleton has exactly N scenes; your output must too.
- DO NOT emit markdown fences, commentary, or explanation. Output only the HTML.
- If you cannot fill a marker honestly given the spec, leave a minimal valid placeholder (e.g. an empty <div>) — but NEVER leave a CLAUDE_FILL marker in the output.

The skeleton is delivered to you in the user message. The spec follows. Apply the spec to the skeleton.

`

const PIPELINE_PREAMBLE = `# Pipeline-specific style conventions

### Scene \`template\` field — intent hint that drives content for that scene
- \`lower-third\`: name/role bar bottom-left; rest of frame transparent. mainText = name, subText = role/affiliation.
- \`title-card\`: fullscreen centered headline + optional subline. Big type (≥80px), generous negative space. mainText = headline.
- \`map\`: the frame IS a map. If spec.assets has a "map" / "background" image, render it full-bleed via \`<img>\` (HTTPS URL — never base64, never an inline mega-SVG). Overlay regions, arrows, hotspots, frontline strokes, and city labels using INLINE \`<svg>\` elements positioned absolutely on top of the base img. Animate via GSAP (stroke-dashoffset for arrows, opacity pulses for hotspots). mainText/subText become a broadcast-style title overlay (top strip or corner card), NOT the primary subject. A war-map sequence MUST render real maps per scene — do not produce lower-third bars instead.
- \`chart\`: data viz as the primary subject. chart.js (CDN allowed) or hand-rolled SVG/divs. mainText/subText = chart title + caption.
- \`freeform\`: use your judgment from mainText/subText, assets, and the brief.

### Asset usage (when spec.assets is present)
Each entry: \`{ role, url, alt, source }\`. HTTPS URL or local file reference only; never base64; never placeholder URLs; never SVG-filter \`data:image/svg+xml\` grain.
- \`logo\` / \`icon\` → \`<img src="<url>" alt="<alt>" />\`. White-on-dark hint: \`filter: brightness(0) invert(1);\`.
- \`background\` → CSS background on a wrapper div: \`background: url('<url>') center/cover no-repeat;\`.
- \`map\` → full-bleed \`<img>\` per the \`map\` template rule above. NEVER paste a giant base-map SVG inline; overlay arrows/hotspots as small inline \`<svg>\` per scene.
- \`chart\` / generic image → \`<img>\` or hand-rolled inline \`<svg>\` as appropriate.
- ALWAYS include the \`alt\` attribute on \`<img>\` tags.

### Resources the renderer allows
Google Fonts CSS (already in skeleton); GSAP 3.14.x (already in skeleton); chart.js from cdn.jsdelivr.net (you may add); lottie-web from cdn.jsdelivr.net (only if a scene uses the lottie adapter); image / SVG URLs declared in spec.assets[].url. NO other \`<script src>\` URLs may be added.

---

# Animation, typography, and motion patterns

Everything below is the official Hyperframes Claude Design guide vendored verbatim. Treat it as authoritative for animation feel, easing choices, mid-scene activity patterns, typography (banned fonts), and visibility rules. The "hard contract" section describes the structure your skeleton ALREADY satisfies; read it as context, but you do not need to reproduce that structure — it is fixed.

`

export const CREATE_HTML_SYSTEM_PROMPT = `${FILL_INSTRUCTIONS}${PIPELINE_PREAMBLE}${HYPERFRAMES_CLAUDE_DESIGN_GUIDE}

---

# Few-shot examples — visual baselines for fully-rendered HTML

These are complete files. They show the SHAPE of the output (composition root, scene clips, timeline, registration) and the visual language. The skeleton you receive in the user message has the same shape but with CLAUDE_FILL markers in place of content. Match the level of polish you see here.

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

  const skeleton = buildSkeleton(spec)
  const userMessage =
    `SKELETON (replace the CLAUDE_FILL markers, keep everything else byte-identical):\n` +
    `\n\`\`\`html\n${skeleton}\n\`\`\`\n\n` +
    `SPEC (apply this content to the skeleton):\n` +
    `\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``

  const r = await callAnthropic({
    model: MODEL_FOR.create,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 8192,
  })
  let html = r.text.trim()
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/, '')
    .trim()

  if (!STAGE_MARKER.test(html)) {
    throw new Error(
      `creator returned HTML missing data-composition-id="main": ${html.slice(0, 200)}`,
    )
  }
  const invariantFailures = listSkeletonInvariantFailures(html)
  if (invariantFailures.length > 0) {
    const err = new Error(
      `creator returned HTML that violates skeleton invariants: ${invariantFailures.join('; ')}`,
    )
    err.html = html
    err.invariantFailures = invariantFailures
    throw err
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
