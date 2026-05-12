// Build a deterministic Hyperframes-shaped skeleton HTML from a spec. The
// skeleton owns the *structural* contract — composition root, scene clips,
// data-* attributes, the GSAP timeline declaration, and the
// `window.__timelines["main"] = tl` registration. Opus fills in:
//   - CSS rules for scene content     → /* CLAUDE_FILL_STYLES */
//   - inner HTML for each scene       → <!-- CLAUDE_FILL_SCENE_N -->
//   - GSAP tweens (all scenes)        → /* CLAUDE_FILL_TWEENS */
//
// This replaces the previous "write the whole file from scratch" flow that
// kept dropping the trailing timeline registration. Bug history: PRs #84,
// #86, #87, #89 — each fixed a different layer but the structural invariants
// were still implicit in a 50KB prompt instead of guaranteed by code.

const ASPECT_DIMS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1':  { width: 1080, height: 1080 },
}

const TONE_ACCENT = {
  analytical: '#f59e0b',
  dramatic:   '#dc2626',
  neutral:    '#9ca3af',
  playful:    '#10b981',
}

export const FILL_MARKERS = Object.freeze({
  STYLES: '/* CLAUDE_FILL_STYLES */',
  TWEENS: '/* CLAUDE_FILL_TWEENS */',
  scene: (n) => `<!-- CLAUDE_FILL_SCENE_${n} -->`,
})

// Invariants that the post-fill HTML MUST preserve. If any are missing, the
// model corrupted the skeleton — reject and retry.
export const SKELETON_INVARIANTS = Object.freeze([
  /data-composition-id\s*=\s*"main"/,
  /window\.__timelines\s*\[\s*["']main["']\s*\]\s*=\s*tl/,
  /const\s+tl\s*=\s*gsap\.timeline\s*\(\s*\{\s*paused:\s*true/,
])

function getScenes(spec) {
  if (Array.isArray(spec.scenes) && spec.scenes.length > 0) return spec.scenes
  // Single-scene specs: synthesize one scene from top-level fields
  return [{
    template: spec.template,
    duration: spec.duration,
    mainText: spec.mainText,
    subText: spec.subText,
  }]
}

export function buildSkeleton(spec) {
  const dims = ASPECT_DIMS[spec.aspectRatio] || ASPECT_DIMS['16:9']
  const accent = TONE_ACCENT[spec.tone] || TONE_ACCENT.neutral
  const scenes = getScenes(spec)
  const totalDuration = scenes.reduce((sum, s) => sum + (s.duration ?? 0), 0)

  const sceneDivs = []
  let cumStart = 0
  for (const [i, scene] of scenes.entries()) {
    const n = i + 1
    const id = `s${n}`
    // Scene 1 starts visible; subsequent scenes start hidden and are tweened
    // in via autoAlpha. (See upstream guide: visibility section.)
    const hiddenStyle = i === 0 ? '' : ' style="visibility:hidden;"'
    sceneDivs.push(
`      <div class="scene clip" id="${id}" data-start="${cumStart}" data-duration="${scene.duration}" data-track-index="0"${hiddenStyle}>
        <div class="scene-content">
          ${FILL_MARKERS.scene(n)}
        </div>
      </div>`,
    )
    cumStart += scene.duration
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${dims.width}, height=${dims.height}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@300;700;900&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${dims.width}px; height: ${dims.height}px; background: transparent; overflow: hidden; font-family: "Roboto Condensed", sans-serif; }
      :root { --accent: ${accent}; }
      ${FILL_MARKERS.STYLES}
    </style>
  </head>
  <body>
    <div id="main" data-composition-id="main" data-width="${dims.width}" data-height="${dims.height}" data-start="0" data-duration="${totalDuration}">
${sceneDivs.join('\n')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${FILL_MARKERS.TWEENS}
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`
}

export function listSkeletonInvariantFailures(html) {
  const failures = []
  for (const invariant of SKELETON_INVARIANTS) {
    if (!invariant.test(html)) failures.push(invariant.source)
  }
  // Also check that no CLAUDE_FILL markers were left behind
  if (html.includes('CLAUDE_FILL_')) failures.push('CLAUDE_FILL markers remain unfilled')
  return failures
}
