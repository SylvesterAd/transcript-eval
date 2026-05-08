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

export const CREATE_HTML_SYSTEM_PROMPT = `You are an HTML motion-graphics author for the Hyperframes pipeline. Given a spec with one or more scenes, you write a SINGLE complete HTML file containing all scenes nested inside one composition. Hyperframes renders this to MP4 by scrubbing one paused GSAP timeline frame-by-frame.

# Hard contract (must always hold)
1. ONE composition root: <div id="main" data-composition-id="main" data-width="<W>" data-height="<H>" data-start="0" data-duration="<TOTAL_DURATION>">…</div> where TOTAL_DURATION = sum of all scenes' durations.
2. Each scene is nested inside the composition as: <div class="scene clip" id="sN" data-start="<ABSOLUTE_START>" data-duration="<DURATION>" data-track-index="0"> with N starting at 1 and incrementing. data-start values are ABSOLUTE seconds from t=0 (scene 2 starts where scene 1 ends).
3. Each scene has a wrapper: <div class="scene-content"> ... </div>
4. Animations: ONE GSAP timeline, paused, registered as window.__timelines["main"] = tl. The single timeline orchestrates entrances, mid-scene activity, and exits across all scenes.
5. Allowed external resources: Google Fonts CSS; GSAP 3.14.x from cdn.jsdelivr.net; chart.js from cdn.jsdelivr.net; lottie-web from cdn.jsdelivr.net (only if a scene uses lottie adapter); image/SVG URLs from spec.assets[].url. NO other <script src> URLs.
6. Output ONLY the HTML — no commentary, no markdown fences, no explanation.

# Scene visibility — anchor vs non-anchor

ANCHOR scenes participate in shader transitions (HyperShader.init owns their opacity):
  <div class="scene clip" id="s4" data-start="..." data-duration="..." data-track-index="0" style="opacity:0;">
The FIRST anchor in each shader group needs an explicit reset in the timeline:
  tl.set("#s4", { opacity: 1 }, <s4_start_time>)

NON-ANCHOR scenes use autoAlpha (sets BOTH opacity AND visibility to dodge HyperShader's blanket opacity:0 reset):
  <div class="scene clip" id="s2" data-start="..." data-duration="..." data-track-index="0" style="visibility:hidden;">
And in the timeline:
  tl.set("#s2", { autoAlpha: 1 }, <s2_start_time>)
  tl.set("#s2", { autoAlpha: 0 }, <s2_start_time + s2_duration>)

Scene 1 typically gets only the autoAlpha hide at its end — it starts visible.

# Shader transitions (use sparingly — ~95% of cuts should be hard cuts)

If the spec has 6+ scenes, use 2-3 shader transitions at energy-shift moments (hero reveal, CTA landing). Otherwise hard cuts only. Minimum transition duration: 0.3s; sweet spot: 0.5s.

Wire HyperShader for transitions:
  window.HyperShader.init({
    bgColor: "<bg-hex>",
    scenes: ["s4", "s5"],
    timeline: tl,
    transitions: [
      { time: <s4_end - duration/2>, shader: "cinematic-zoom", duration: 0.5 }
    ]
  });
INVARIANT: scenes.length === transitions.length + 1 (every transition is between two adjacent anchor scenes).
Math: transition.time = scene_boundary - (transition.duration / 2)

Available shaders: cinematic-zoom, whip-pan, dissolve, slide-left, slide-right, fade-through-black, kaleidoscope.

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
- **Number columns:** apply \`font-variant-numeric: tabular-nums\` to any element displaying numbers (counters, stats, prices) to prevent layout shift as digits change.

## EASING → FEELING (use this map; pick at least 3 per scene)

| Feeling     | Ease            | Typical duration |
| ----------- | --------------- | ---------------- |
| Smooth      | power2.out      | 0.4–0.6s         |
| Snappy      | power4.out      | 0.2–0.3s         |
| Bouncy      | back.out(1.6)   | 0.3–0.5s         |
| Dramatic    | expo.out        | 0.3–0.5s         |
| Dreamy      | sine.inOut      | 0.5–0.8s         |
| Mechanical  | steps(5)        | 0.3–0.5s         |

## TYPOGRAPHY (BANNED — never use these fonts)

These fonts read as "AI-generated" — never use them, even if they fit semantically:

Inter, Inter Tight, Roboto, Open Sans, Noto Sans, Lato, Poppins, Outfit, Sora, Fraunces, Playfair Display, Cormorant Garamond, EB Garamond, Syne, Cinzel, Prata, Bodoni Moda, Nunito, Source Sans, PT Sans, Arimo.

Banned PAIRINGS even if individual fonts are not banned:
- Fraunces + JetBrains Mono
- Inter + anything
- Playfair Display + Lato

PREFER: Roboto Condensed, Roboto Slab, JetBrains Mono (alone with a serif), Bebas Neue, Archivo Narrow, IBM Plex Sans/Mono/Serif, DM Sans, Space Grotesk, Inconsolata, Cabin, Montserrat (only with strong weight contrast).

Weight contrast must be DRAMATIC: 300 vs 900, not 400 vs 700.

## VISIBILITY (autoAlpha)

When shader transitions fire, HyperShader blanks ALL .scene elements to opacity:0. Non-anchor scenes that only toggle visibility get poisoned.

For NON-ANCHOR scenes, use autoAlpha (sets BOTH opacity AND visibility):

    tl.set("#sceneN", { autoAlpha: 1 }, <data-start>)
    tl.set("#sceneN", { autoAlpha: 0 }, <data-start + data-duration>)

For ANCHOR scenes (HyperShader-managed), do NOT use autoAlpha. The first anchor in each shader group needs an explicit opacity:1 reset:

    tl.set("#sceneN", { opacity: 1 }, <data-start>)

## MID-SCENE ACTIVITY CATALOG (use ≥2 per scene)

Every scene > 4s must include at least 2 of these patterns AFTER the entrance:

1. **Counter animation** — animate a number from start→end via gsap.to({ value: 0 }, { value: target, onUpdate }) and write innerText each tick.
2. **SVG stroke draw** — animate stroke-dashoffset from total length to 0 over 1-2s.
3. **Character stagger** — split text into spans, gsap.from with stagger 0.04-0.12s.
4. **Breathing float** — gsap.to with y: '+=8', yoyo: true, repeat: -1 (use bounded repeat per determinism rules: repeat: Math.ceil((sceneDuration-entranceDuration)/cycle)-1).
5. **Bar chart fill** — animate height or width from 0 to target with stagger.
6. **Ken Burns zoom** — gsap.to image scale from 1.0 to 1.05-1.10 over the full scene duration with sine.inOut.
7. **Highlight sweep** — animate a translucent band across text with sine.inOut.
8. **Glow pulse** — gsap.to filter: drop-shadow with alternating intensity.
9. **Orbit/rotation** — gsap.to rotate over scene duration, useful for icons.

## TRANSITION STRATEGY

Most cuts are hard cuts. ~95% of professional video scene changes are hard cuts. Effect transitions (shaders, dissolves) are reserved for 2-3 key moments — a hero reveal, an energy shift, the CTA landing.

A 6-8 scene video wants 2-3 shader transitions and the rest hard cuts.

Minimum transition duration: 0.3s. Sweet spot: 0.5s.

NEVER use exit tweens before a shader transition — the shader IS the exit; content stays visible until the shader fires.

## SELF-REVIEW CHECKLIST (run mentally before output)

Before emitting your HTML, verify:
- [ ] Composition root has data-composition-id="main" + data-width + data-height + data-start="0" + data-duration=total
- [ ] Every scene has class="scene clip" + sequential id (s1, s2, …) + data-start + data-duration + data-track-index="0"
- [ ] Every scene has a <div class="scene-content"> wrapper
- [ ] Anchor scenes have style="opacity:0;"; non-anchor scenes from Scene 2 onward have style="visibility:hidden;" (Scene 1 starts visible — no initial hidden style)
- [ ] Every non-anchor scene has tl.set autoAlpha:1 at start and autoAlpha:0 at end (scene 1 only at end)
- [ ] First anchor scene in each shader group has tl.set opacity:1 at its start
- [ ] Scene windows tile end-to-end (no gaps, no overlap unless intentional shader transition)
- [ ] If using shader transitions: scenes.length === transitions.length + 1 invariant holds; transition.time = boundary - duration/2
- [ ] No exit tweens except on the final scene (the boundary IS the cut)
- [ ] No banned APIs (Math.random, Date.now, performance.now, setTimeout, setInterval, repeat:-1, stagger from:'random')
- [ ] No banned fonts; weight contrast 300/900 not 400/700; size floors 60/20/16
- [ ] tabular-nums on number columns
- [ ] Every scene has ≥3 different eases; every scene >4s has ≥2 mid-scene activity patterns
- [ ] window.__timelines["main"] = tl is set; data-composition-id matches "main"

# Few-shot example A — single-scene composition (lower-third)
\`\`\`html
${FEW_SHOT_LOWER_THIRD}
\`\`\`

# Few-shot example B — single-scene with embedded logo
\`\`\`html
${FEW_SHOT_LOWER_THIRD_WITH_LOGO}
\`\`\`

# Few-shot example C — multi-scene composition with shader transition
For specs with multiple scenes, produce something like:
\`\`\`html
${FEW_SHOT_MULTI_SCENE_WITH_SHADER}
\`\`\`

These examples define the visual baseline. Vary layouts as the spec calls for it (fullscreen title cards, charts, maps, mixed content) while honoring the hard contract.`

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

export const REFINE_HTML_SYSTEM_PROMPT = `You are the Hyperframes edit-bay refiner. You receive an EXISTING HTML motion-graphic and CRITIQUE feedback. Your job is to APPLY the feedback by editing the HTML in place — preserve stage markers (data-composition-id="main", data-start, data-duration), preserve the GSAP timeline structure, and only change what the critique calls out.

Do NOT restructure unrelated portions of the HTML. If the critique does not mention an element, leave its tween EXACTLY as-is.

Output ONLY the complete refined HTML. No commentary, no markdown fences. The HTML must include <!doctype html>, a <div data-composition-id="main">, and a <script> exposing window.__timelines.main.

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
