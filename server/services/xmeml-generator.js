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

// ----------------------------------------------------------------------
// generateXmeml — main entry point.
//
// Inputs:
//   sequenceName: string  — human-readable, e.g. "Variant C". Escaped.
//   placements: Array<{
//     seq: number                — monotonic; used for ids + ordering
//     source: string             — "envato" | "pexels" | "freepik"
//     sourceItemId: string       — upstream id; used in file id
//     filename: string           — leaf name in media/; sanitized
//     timelineStart: number      — seconds on timeline
//     timelineDuration: number   — seconds
//     width?: number             — per-file, defaults to sequenceSize.w
//     height?: number            — per-file, defaults to sequenceSize.h
//     sourceFrameRate?: number   — per-file, defaults to frameRate
//   }>
//   frameRate: number = 30       — sequence timebase
//   sequenceSize: {w, h} = 1920x1080
//
// Returns: XML string (FCP7 xmeml v5). Deterministic: same inputs →
// byte-identical output across calls and processes.
//
// Edge cases:
//   - placements is empty → emit a valid <sequence> with an empty
//     <video> (one track, no clipitems). Does NOT throw — the caller
//     decides whether to offer XML for a zero-item run.
//   - missing width/height/sourceFrameRate on a placement → use
//     sequence defaults. Premiere re-reads actual file metadata on
//     import anyway.
//   - overlapping placements → stacked on V1/V2/... via assignTracks.
//   - escapes every text node that could contain user-influenced
//     data (sequenceName, filename, file id components).
//
// What the function is NOT:
//   - Not a file writer. Returns a string.
//   - Not a validator against an XMEML schema. We target the permissive
//     subset Premiere accepts; regressions are caught by golden fixture
//     tests in Task 5.

function slugifyForId(input) {
  // Deterministic id segment: ASCII alphanumerics + dashes. Anything
  // else becomes -. Used for <clipitem id> and <file id> — these are
  // XML attribute values, which don't need escaping for our allowed
  // char set, but sanitizing avoids `"` or other terminator issues.
  return String(input || '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}

function padSeq(seq) {
  const s = String(seq)
  return s.length >= 3 ? s : ('000' + s).slice(-3)
}

// Build a Premiere-conformant <pathurl> body. Per Apple FCP7 XML spec
// (the format Premiere imports), pathurl MUST be absolute and start with
// either `file://localhost` or `file:///`. Each path segment is URL-
// encoded so spaces / special chars survive Premiere's URL parser.
//
// When `mediaFolderAbsolute` is unknown (older extension that doesn't
// emit it, fallback browser-Blob download path), we fall back to the
// bare filename — Premiere relinks via Match File Properties → File Name
// when the XML sits next to the media. That's lossy (forces a Locate
// dialog every import) but it works; the historical `file://./` form
// did not — Premiere parsed the `.` as a host and silently failed.
export function buildPathUrl(mediaFolderAbsolute, filename) {
  const safeName = String(filename || '')
  if (!mediaFolderAbsolute) {
    return safeName  // bare filename; Premiere relinks via filename match
  }
  const folder = String(mediaFolderAbsolute).replace(/^\/+/, '').replace(/\/+$/, '')
  const segs = folder.split('/').map(encodeURIComponent)
  return `file:///${segs.join('/')}/${encodeURIComponent(safeName)}`
}

export function generateXmeml({
  sequenceName,
  placements,
  frameRate = 30,
  sequenceSize = { w: 1920, h: 1080 },
  aroll = null,  // optional: { filename, frameRate, width, height, sourceDurationSeconds } — emits a V1 track spanning the entire timeline
  mediaFolderAbsolute = null,  // absolute filesystem folder, e.g. "/Users/laurynas/Downloads/transcript-eval/export-370-a"; when null we emit bare filenames (Premiere relinks via Match File Properties → File Name when the XML sits next to the media)
}) {
  if (typeof sequenceName !== 'string' || !sequenceName) {
    throw new Error('generateXmeml: sequenceName must be a non-empty string')
  }
  if (!Array.isArray(placements)) {
    throw new Error('generateXmeml: placements must be an array')
  }
  if (typeof frameRate !== 'number' || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error('generateXmeml: frameRate must be a positive finite number')
  }
  const seqW = sequenceSize?.w ?? 1920
  const seqH = sequenceSize?.h ?? 1080
  if (!Number.isFinite(seqW) || !Number.isFinite(seqH) || seqW <= 0 || seqH <= 0) {
    throw new Error('generateXmeml: sequenceSize.{w,h} must be positive finite numbers')
  }

  const seqSlug = slugifyForId(sequenceName).toLowerCase() || 'seq'

  // Step 1: normalize each placement — integer frames, defaulted metadata,
  // sanitized filenames.
  const normalized = placements.map((p) => {
    if (!p || typeof p !== 'object') {
      throw new Error('generateXmeml: each placement must be an object')
    }
    if (typeof p.seq !== 'number' || !Number.isFinite(p.seq)) {
      throw new Error(`generateXmeml: placement missing numeric seq (got ${p.seq})`)
    }
    if (typeof p.filename !== 'string' || !p.filename) {
      throw new Error(`generateXmeml: placement seq=${p.seq} missing filename`)
    }
    const startFrame = secondsToFrames(p.timelineStart, frameRate)
    const duration = secondsToFrames(p.timelineDuration, frameRate)
    const endFrame = startFrame + duration
    const width = Number.isFinite(p.width) && p.width > 0 ? p.width : seqW
    const height = Number.isFinite(p.height) && p.height > 0 ? p.height : seqH
    const sourceFrameRate = Number.isFinite(p.sourceFrameRate) && p.sourceFrameRate > 0
      ? p.sourceFrameRate : frameRate
    // Source media's full duration in frames (in the file's own framerate).
    // When unknown, fall back to the timeline duration so the clip plays —
    // the cost is no trim handles past the cut, but at least the import
    // succeeds and the clip is the right length.
    const sourceDurationFrames = Number.isFinite(p.sourceDurationSeconds) && p.sourceDurationSeconds > 0
      ? Math.round(p.sourceDurationSeconds * sourceFrameRate)
      : duration
    const cleanName = sanitizeFilename(p.filename)
    return {
      seq: p.seq,
      source: p.source || '',
      sourceItemId: p.sourceItemId || '',
      filename: cleanName,
      _startFrame: startFrame,
      _endFrame: endFrame,
      _duration: duration,
      _sourceDurationFrames: sourceDurationFrames,
      _width: width,
      _height: height,
      _sourceFrameRate: sourceFrameRate,
    }
  })

  // Step 2: assign tracks (no-op if placements is empty).
  const withTracks = assignTracks(normalized)

  // Step 3: group by track index. Within each track, order by start
  // frame (already done by assignTracks).
  const tracksByIndex = new Map()
  for (const p of withTracks) {
    if (!tracksByIndex.has(p.trackIndex)) tracksByIndex.set(p.trackIndex, [])
    tracksByIndex.get(p.trackIndex).push(p)
  }

  // Step 4: sequence <duration> = last end frame across all tracks.
  // Zero if no placements.
  let sequenceDuration = 0
  for (const p of withTracks) {
    if (p._endFrame > sequenceDuration) sequenceDuration = p._endFrame
  }

  // Step 5: emit. String concatenation in a single pass — no intermediate
  // arrays, no DOM builder. 2-space indent to match the spec's example.
  const lines = []
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`)
  lines.push(`<!DOCTYPE xmeml>`)
  lines.push(`<xmeml version="5">`)
  lines.push(`  <sequence id="seq-${slugifyForId(seqSlug)}">`)
  lines.push(`    <name>${escapeXml(sequenceName)}</name>`)
  lines.push(`    <duration>${sequenceDuration}</duration>`)
  lines.push(`    <rate><timebase>${frameRate}</timebase><ntsc>FALSE</ntsc></rate>`)
  lines.push(`    <media>`)
  lines.push(`      <video>`)
  lines.push(`        <format>`)
  lines.push(`          <samplecharacteristics>`)
  lines.push(`            <width>${seqW}</width><height>${seqH}</height>`)
  lines.push(`            <rate><timebase>${frameRate}</timebase></rate>`)
  lines.push(`          </samplecharacteristics>`)
  lines.push(`        </format>`)

  // Emit A-roll track first (V1) so b-rolls land on V2/V3 above it.
  // A-roll spans the entire sequence: source IN=0, OUT=sequenceDuration,
  // timeline start=0, end=sequenceDuration. Only emitted when caller
  // passed the optional `aroll` arg with a non-empty filename.
  if (aroll && typeof aroll === 'object' && aroll.filename) {
    const arollFilename = sanitizeFilename(String(aroll.filename))
    const arollFrameRate = Number.isFinite(aroll.frameRate) && aroll.frameRate > 0 ? aroll.frameRate : frameRate
    const arollWidth = Number.isFinite(aroll.width) && aroll.width > 0 ? aroll.width : seqW
    const arollHeight = Number.isFinite(aroll.height) && aroll.height > 0 ? aroll.height : seqH
    // A-roll source length: prefer the explicit value; default to the
    // sequence length (matches the historical behavior where aroll covers
    // the whole timeline).
    const arollSourceFrames = Number.isFinite(aroll.sourceDurationSeconds) && aroll.sourceDurationSeconds > 0
      ? Math.round(aroll.sourceDurationSeconds * arollFrameRate)
      : sequenceDuration
    const arollClipId = `clip-${seqSlug}-aroll`
    const arollFileId = `file-aroll`
    lines.push(`        <track>`)
    lines.push(`          <clipitem id="${escapeXml(arollClipId)}">`)
    lines.push(`            <name>${escapeXml(arollFilename)}</name>`)
    lines.push(`            <duration>${arollSourceFrames}</duration>`)
    lines.push(`            <start>0</start>`)
    lines.push(`            <end>${sequenceDuration}</end>`)
    lines.push(`            <in>0</in>`)
    lines.push(`            <out>${sequenceDuration}</out>`)
    lines.push(`            <file id="${escapeXml(arollFileId)}">`)
    lines.push(`              <name>${escapeXml(arollFilename)}</name>`)
    lines.push(`              <pathurl>${escapeXml(buildPathUrl(mediaFolderAbsolute, arollFilename))}</pathurl>`)
    lines.push(`              <duration>${arollSourceFrames}</duration>`)
    lines.push(`              <rate><timebase>${arollFrameRate}</timebase></rate>`)
    lines.push(`              <media>`)
    lines.push(`                <video><samplecharacteristics>`)
    lines.push(`                  <width>${arollWidth}</width><height>${arollHeight}</height>`)
    lines.push(`                </samplecharacteristics></video>`)
    lines.push(`              </media>`)
    lines.push(`            </file>`)
    lines.push(`          </clipitem>`)
    lines.push(`        </track>`)
  }

  // Emit tracks in V1, V2, V3 order. If placements is empty, emit zero
  // tracks inside <video> — valid xmeml, opens in Premiere as an empty
  // video layer.
  //
  // For each clipitem we model two distinct durations per the FCP7
  // XMEML spec:
  //   <clipitem><duration> + <file><duration> = the SOURCE media's full
  //     length (so Premiere shows trim handles past the cut).
  //   <in>/<out> = the slice OF the source we're using (sequence frames).
  //     out − in = (timeline end − timeline start).
  //   <start>/<end> = where on the sequence timeline this slice lands.
  //
  // Today every cut starts at source frame 0; if/when the b-roll editor
  // exposes a per-placement source-IN, plumb it through and adjust the
  // `in`/`out` calc here.
  const trackIndices = Array.from(tracksByIndex.keys()).sort((a, b) => a - b)
  for (const trackIdx of trackIndices) {
    lines.push(`        <track>`)
    for (const p of tracksByIndex.get(trackIdx)) {
      const clipId = `clip-${seqSlug}-${padSeq(p.seq)}`
      const fileId = `file-${slugifyForId(p.source)}-${slugifyForId(p.sourceItemId) || padSeq(p.seq)}`
      const inFrame = 0
      const outFrame = inFrame + p._duration
      lines.push(`          <clipitem id="${escapeXml(clipId)}">`)
      lines.push(`            <name>${escapeXml(p.filename)}</name>`)
      lines.push(`            <duration>${p._sourceDurationFrames}</duration>`)
      lines.push(`            <start>${p._startFrame}</start>`)
      lines.push(`            <end>${p._endFrame}</end>`)
      lines.push(`            <in>${inFrame}</in>`)
      lines.push(`            <out>${outFrame}</out>`)
      lines.push(`            <file id="${escapeXml(fileId)}">`)
      lines.push(`              <name>${escapeXml(p.filename)}</name>`)
      lines.push(`              <pathurl>${escapeXml(buildPathUrl(mediaFolderAbsolute, p.filename))}</pathurl>`)
      lines.push(`              <duration>${p._sourceDurationFrames}</duration>`)
      lines.push(`              <rate><timebase>${p._sourceFrameRate}</timebase></rate>`)
      lines.push(`              <media>`)
      lines.push(`                <video><samplecharacteristics>`)
      lines.push(`                  <width>${p._width}</width><height>${p._height}</height>`)
      lines.push(`                </samplecharacteristics></video>`)
      lines.push(`              </media>`)
      lines.push(`            </file>`)
      lines.push(`          </clipitem>`)
    }
    lines.push(`        </track>`)
  }

  lines.push(`      </video>`)
  lines.push(`    </media>`)
  lines.push(`  </sequence>`)
  lines.push(`</xmeml>`)
  lines.push(``)  // trailing newline

  return lines.join('\n')
}
