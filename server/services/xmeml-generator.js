// XMEML generator — FCP7 xmeml v5 emitter for Adobe Premiere import.
//
// Pure function. No I/O, no Date.now(), no Math.random(). Same inputs
// always produce byte-identical output. See
// docs/specs/2026-04-23-envato-export-design.md § "XMEML generation"
// for the target format and
// docs/superpowers/plans/2026-04-24-webapp-xmeml-generator.md for the
// task-by-task breakdown of how the pieces fit.
//
// Time conversion: XMEML time fields (`<start>`, `<end>`, `<in>`,
// `<out>`, `<duration>`) are in FRAMES, not seconds. The generator
// converts via `frame = Math.round(timelineSeconds * frameRate)` at a
// single boundary (before emission); all comparisons and arithmetic
// after that point are integer-frame.

// ----------------------------------------------------------------------
// escapeXml — XML 1.0 text-node / attribute-safe escape.
//
// Covers the 5 reserved chars: &, <, >, ", '. Handles them in a single
// replace via a char-class regex (don't special-case & first; that
// requires careful ordering and is a classic source of double-escape
// bugs). Non-ASCII control chars are dropped by the filename
// sanitizer, so we don't need to emit numeric character references
// (&#NN;) here.
export function escapeXml(input) {
  if (input === null || input === undefined) return ''
  const s = String(input)
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&apos;'
      default:  return c
    }
  })
}

// TODO(task 2+): generateXmeml(...) — implemented in subsequent tasks.
export function generateXmeml() {
  throw new Error('generateXmeml: not yet implemented — see task 2')
}
