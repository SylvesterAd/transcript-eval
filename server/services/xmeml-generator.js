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

// ----------------------------------------------------------------------
// sanitizeFilename — defensive ASCII-only + reserved-char replacement.
//
// The extension already emits names like "001_envato_NX9WYGQ.mov" which
// are ASCII-clean by construction, but we apply the spec's rules here
// as belt-and-suspenders:
//
//   - Drop any byte outside printable ASCII (0x20–0x7E).
//   - Replace Windows-reserved chars <>:"|?* with _.
//   - Preserve / to allow subpath components (we only emit leaf names,
//     but this keeps the primitive general-purpose).
//   - Cap total length at 240 chars (Windows MAX_PATH 260 minus margin).
//
// NOT responsible for: generating the name (extension does that),
// checking for collisions (`chrome.downloads` handles via
// `conflictAction: "uniquify"`), or lowercasing (Premiere is
// case-sensitive on Linux/macOS).
const RESERVED_CHARS = /[<>:"|?*]/g
const NON_PRINTABLE_ASCII = /[^\x20-\x7E]/g
const MAX_PATH_LEN = 240

export function sanitizeFilename(name) {
  if (name === null || name === undefined) return ''
  let s = String(name)
  s = s.replace(NON_PRINTABLE_ASCII, '')
  s = s.replace(RESERVED_CHARS, '_')
  if (s.length > MAX_PATH_LEN) s = s.slice(0, MAX_PATH_LEN)
  return s
}

// ----------------------------------------------------------------------
// secondsToFrames — single rounding boundary for timeline arithmetic.
//
// All XMEML time fields are integer frames. Round once here; downstream
// code compares integers. Using Math.round() (not floor/ceil) matches
// Premiere's own behavior when it reads float-second timelines.
export function secondsToFrames(seconds, frameRate) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new Error(`secondsToFrames: seconds must be a finite number, got ${seconds}`)
  }
  if (typeof frameRate !== 'number' || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error(`secondsToFrames: frameRate must be a positive finite number, got ${frameRate}`)
  }
  return Math.round(seconds * frameRate)
}

// ----------------------------------------------------------------------
// assignTracks — greedy interval scheduling.
//
// Input: placements with integer-frame start/end (after secondsToFrames).
// Output: same placements, each annotated with .trackIndex (0-based: V1 = 0).
//
// Algorithm (spec § "Overlapping timeline placements"):
//   1. Sort by start frame ascending; ties broken by seq (stable).
//   2. Track frontier = array of "next-free frame" per track index.
//   3. For each placement, find the lowest track index whose frontier
//      is ≤ this placement's start. If none, open a new track.
//   4. Update that track's frontier to this placement's end.
//
// Half-open intervals: a clip ending at frame 120 and another starting
// at frame 120 share track — matches Premiere's butt-splice semantics.
// This is the right call; XMEML placements at shared frame boundaries
// are idiomatic.
export function assignTracks(placements) {
  // Copy + sort so we don't mutate caller's array.
  const sorted = placements
    .map((p, originalIndex) => ({ ...p, _originalIndex: originalIndex }))
    .sort((a, b) => {
      if (a._startFrame !== b._startFrame) return a._startFrame - b._startFrame
      // Tiebreak on seq so ordering is deterministic across runs.
      return a.seq - b.seq
    })

  const frontier = []  // frontier[i] = next-free frame on track i

  for (const p of sorted) {
    let assigned = -1
    for (let i = 0; i < frontier.length; i++) {
      if (frontier[i] <= p._startFrame) {
        assigned = i
        break
      }
    }
    if (assigned === -1) {
      frontier.push(p._endFrame)
      p.trackIndex = frontier.length - 1
    } else {
      frontier[assigned] = p._endFrame
      p.trackIndex = assigned
    }
  }

  // Restore original seq-based ordering? No — callers get the
  // sorted-by-start ordering, which is what XMEML emission wants
  // (we emit per-track, but per-track ordering is also by start).
  // _originalIndex is left in place for debuggability; callers may
  // strip before emission.
  return sorted
}

// TODO(task 2+): generateXmeml(...) — implemented in subsequent tasks.
export function generateXmeml() {
  throw new Error('generateXmeml: not yet implemented — see task 2')
}
