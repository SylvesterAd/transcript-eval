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

// Adobe-specific sub-frame precision constant. Premiere uses these tick
// values to position clips with picosecond accuracy independent of the
// sequence framerate — without pproTicks, in/out/start/end snap to the
// nearest integer frame (±16.7ms at 30fps). Verified against multiple
// real Premiere-exported XMLs.
//
// Source: https://community.adobe.com/t5/premiere-pro-discussions/how-to-parse-pproticksin-and-pproticksout-to-frames/td-p/10878160
const PPRO_TICKS_PER_SECOND = 254016000000

function secondsToPproTicks(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 0
  return Math.round(seconds * PPRO_TICKS_PER_SECOND)
}

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
// Parse a SMPTE timecode string into total frame count (absolute from
// 00:00:00:00). Handles drop-frame (semicolon separator before frames)
// for 29.97 (timebase 30) and 59.94 (timebase 60). Returns 0 on null /
// malformed input — caller falls back to zero-based in/out, matching
// pre-fix behavior.
//
// Examples:
//   "00:00:00:00" → 0
//   "18:16:14:04" at timebase=24 → 18*3600*24 + 16*60*24 + 14*24 + 4 = 1577140
//   "01:00:00;00" at timebase=30 (DF) → 30*60*60 - dropped = 107892
export function parseTimecodeToFrame(tcString, timebase) {
  if (typeof tcString !== 'string' || !tcString) return 0
  if (!Number.isFinite(timebase) || timebase <= 0) return 0
  const isDF = tcString.includes(';')
  const parts = tcString.split(/[:;]/)
  if (parts.length !== 4) return 0
  const [h, m, s, f] = parts.map(n => Number.parseInt(n, 10))
  if (![h, m, s, f].every(Number.isFinite)) return 0
  let frames = (h * 3600 + m * 60 + s) * timebase + f
  if (isDF && (timebase === 30 || timebase === 60)) {
    // Drop-frame TC (29.97/59.94): drop 2 (or 4) frames at the start
    // of every minute except every 10th, to keep TC seconds aligned
    // with wall-clock seconds.
    const dropPerMin = timebase === 30 ? 2 : 4
    const totalMinutes = h * 60 + m
    const droppedMinutes = totalMinutes - Math.floor(totalMinutes / 10)
    frames -= droppedMinutes * dropPerMin
  }
  return frames
}

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
  // Sequence timebase (timeline frame granularity). 50fps gives 20ms
  // resolution — enough for editor edits at .02s boundaries (e.g.
  // 73.64s = frame 3682 exactly) AND it's a Premiere-supported
  // timebase (FCP7 XMEML spec enumerates 24/25/30/50/60). Source
  // clip framerates remain whatever the source was — we decouple
  // sequence from source rate via the per-placement sourceFrameRate
  // field, with a hardcoded 30 fallback (the typical b-roll rate).
  frameRate = 50,
  sequenceSize = { w: 1920, h: 1080 },
  aroll = null,  // optional: { filename, frameRate, width, height, sourceDurationSeconds } — emits a V1 track spanning the entire timeline
  arollSegments = null, // NEW: [{filename, start, end, sourceFrameRate?, sourceDurationSeconds?, width?, height?}] — emits one V1 clipitem per segment; takes precedence over aroll when non-empty
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
    // Source clip's native rate. Decoupled from sequence rate so a
    // 50fps timeline can carry 30fps b-roll without the source
    // duration being mis-scaled. Falls back to 30 (typical Pexels/
    // Storyblocks/Envato rate) when manifest didn't carry it.
    const sourceFrameRate = Number.isFinite(p.sourceFrameRate) && p.sourceFrameRate > 0
      ? p.sourceFrameRate : 30
    // NTSC fractional rate flag — TRUE for 29.97 (30000/1001), 23.976
    // (24000/1001), 59.94 (60000/1001). Source: probeMediaUrl in
    // video-processor.js. Without this, DaVinci validates XML's
    // claimed integer rate (30) against file's actual fractional
    // rate (29.97) and rejects with "File not found in search
    // directories" (misleading error). Premiere ignores the ntsc
    // flag entirely.
    const sourceNtsc = p.ntsc === true
    // Embedded SMPTE timecode from the source file's metadata
    // (probed at manifest time). When present, the file's own TC is
    // declared in <file><timecode> AND <in>/<out> are offset by the
    // corresponding frame number — DaVinci validates strictly against
    // the file's actual baked-in TC, and zero-based in/out outside the
    // file's TC range get rejected as "File not found in search
    // directories". When absent (file has TC 00:00:00:00 or no TC tag),
    // fall back to zero — the historical behavior.
    const embeddedTimecode = (typeof p.embeddedTimecode === 'string' && p.embeddedTimecode) ? p.embeddedTimecode : null
    const embeddedTimecodeFrame = embeddedTimecode ? parseTimecodeToFrame(embeddedTimecode, sourceFrameRate) : 0
    // Slip-edit: source_in_seconds is the editor's chosen start point
    // in the source clip (seconds). Defaults to 0 (from the top of the
    // file). A slip to 1.5s means <in> is shifted by 1.5 * sourceFrameRate
    // frames on top of the existing tcOffset (embedded TC + elst).
    const sourceInSeconds = Math.max(0, Number.isFinite(p.source_in_seconds) ? p.source_in_seconds : 0)
    const sourceInFrames = Math.round(sourceInSeconds * sourceFrameRate)

    // Source media's full duration in frames (in the file's own framerate).
    // When unknown, fall back to the source-rate duration so the clip plays —
    // the cost is no trim handles past the cut, but at least the import
    // succeeds and the clip is the right length.
    const sourceDurationConfirmed = Number.isFinite(p.sourceDurationSeconds) && p.sourceDurationSeconds > 0
    const sourceDur = sourceDurationConfirmed ? p.sourceDurationSeconds : null

    // Clamp logic: compute the effective duration for <in>/<out> and <end>.
    //
    // keep_original_duration=true → user explicitly accepted that the
    //   placement may read past source end (e.g. file 6.17s in a 7s slot,
    //   gap will go black). Honour original_timeline_duration (or fall back
    //   to timelineDuration) without clamping.
    //
    // Default (keep_original_duration falsy) → clamp to min(timelineDuration,
    //   sourceDur - sourceInSeconds) so <out> never lands beyond the file's
    //   last frame. This fixes item 016 (Pexels 6.17s in 7s slot) where the
    //   old code emitted <out>=212 and DaVinci showed the clip then froze.
    let effectiveDurationSec
    if (p.keep_original_duration) {
      effectiveDurationSec = p.original_timeline_duration ?? p.timelineDuration
    } else if (sourceDur != null) {
      effectiveDurationSec = Math.min(p.timelineDuration, Math.max(0, sourceDur - sourceInSeconds))
    } else {
      effectiveDurationSec = p.timelineDuration
    }

    // Warn when keep_original_duration would read past source end (the NLE
    // will go black for the overshoot). Use console.warn — no warnings array
    // return plumbing needed; tests verify the numeric frame values instead.
    if (p.keep_original_duration && sourceDur != null) {
      const overshoot = sourceInSeconds + effectiveDurationSec - sourceDur
      if (overshoot > 0) {
        console.warn(
          `[xmeml] Placement ${p.seq ?? p.filename} source ends before placement; ` +
          `DaVinci will go black for ${overshoot.toFixed(2)}s`
        )
      }
    }

    // Two duration coordinates. <start>/<end> use sequence-rate
    // frames (timeline grid); <in>/<out> use source-rate frames (cut
    // points in the source media). Equal only when sequence rate ==
    // source rate. With a 50fps sequence and 30fps source, a 2s clip
    // is 100 sequence frames AND 60 source frames.
    //
    // effectiveDurationSec (clamped or kept) governs BOTH the source-
    // rate <out> − <in> span AND the sequence-rate <end> − <start> span,
    // so the timeline slot shrinks when clamping reduces the duration.
    const startFrame = secondsToFrames(p.timelineStart, frameRate)
    const durationSeqFrames = secondsToFrames(effectiveDurationSec, frameRate)
    const durationSrcFrames = secondsToFrames(effectiveDurationSec, sourceFrameRate)
    const endFrame = startFrame + durationSeqFrames
    const width = Number.isFinite(p.width) && p.width > 0 ? p.width : seqW
    const height = Number.isFinite(p.height) && p.height > 0 ? p.height : seqH

    const sourceDurationFrames = sourceDurationConfirmed
      ? Math.round(p.sourceDurationSeconds * sourceFrameRate)
      : durationSrcFrames
    const cleanName = sanitizeFilename(p.filename)
    return {
      seq: p.seq,
      source: p.source || '',
      sourceItemId: p.sourceItemId || '',
      filename: cleanName,
      _startFrame: startFrame,
      _endFrame: endFrame,
      _duration: durationSeqFrames,
      _durationSrcFrames: durationSrcFrames,
      _sourceDurationFrames: sourceDurationFrames,
      _sourceDurationConfirmed: sourceDurationConfirmed,
      // Sub-frame-precise versions of the timing fields. Carried alongside
      // the integer-frame values; emitted as <pproTicks*> in the XML.
      _timelineStartSec: p.timelineStart,
      _timelineDurationSec: effectiveDurationSec,
      _width: width,
      _height: height,
      _sourceFrameRate: sourceFrameRate,
      _sourceNtsc: sourceNtsc,
      _embeddedTimecode: embeddedTimecode,
      _embeddedTimecodeFrame: embeddedTimecodeFrame,
      // Edit-list compensation. DaVinci respects the source file's
      // video trak elst — if media_time > 0, the file's first presented
      // frame is offset by this many seconds into the media. Convert to
      // source-rate frames and ADD to tcOffset when computing <in>/<out>
      // for b-roll clipitems below. Without this, DaVinci shows the clip
      // as offline because <in> points to a TC before the file's effective
      // presentation start.
      _videoEditListOffsetFrames: Math.round(
        (Number.isFinite(p.videoEditListMediaTimeSeconds) ? p.videoEditListMediaTimeSeconds : 0) * sourceFrameRate
      ),
      // Slip-edit offset in source-rate frames. Added to tcOffset in the
      // <in>/<out> emission block below (alongside embeddedTC + elst).
      _sourceInFrames: sourceInFrames,
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

  // A-Roll track emission. New `arollSegments` (per-segment) takes precedence
  // over legacy `aroll` (single continuous clip). Both produce V1 track output;
  // the difference is one clipitem (legacy) vs N clipitems (segments).
  const useSegments = Array.isArray(arollSegments) && arollSegments.length > 0
  const segs = useSegments
    ? arollSegments
    : (aroll && typeof aroll === 'object' && aroll.filename
      ? [{
          filename: aroll.filename,
          start: 0,
          end: sequenceDuration / frameRate,
          sourceFrameRate: aroll.frameRate,
          ntsc: aroll.ntsc === true,
          sourceDurationSeconds: aroll.sourceDurationSeconds,
          width: aroll.width,
          height: aroll.height,
        }]
      : [])

  // Capture per-segment data we need to emit audio twins of each video
  // clipitem after the <video> block closes. A-roll source files carry
  // audio (talking-head footage); without these audio clipitems Premiere
  // imports the video and applies its safety-default mute (level 0), which
  // is the user-reported "volume 0" symptom. B-roll stays silent — it's
  // a visual overlay over the A-roll's audio.
  const audioSegments = []
  if (segs.length > 0) {
    lines.push(`        <track>`)
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      if (!seg?.filename) continue
      const arollFilename = sanitizeFilename(String(seg.filename))
      const arollFrameRate = Number.isFinite(seg.sourceFrameRate) && seg.sourceFrameRate > 0 ? seg.sourceFrameRate : frameRate
      const arollWidth = Number.isFinite(seg.width) && seg.width > 0 ? seg.width : seqW
      const arollHeight = Number.isFinite(seg.height) && seg.height > 0 ? seg.height : seqH
      const arollNtsc = seg.ntsc === true
      // Two coordinate systems per segment:
      //   timelineStart/timelineEnd → where on the NLE timeline (post-cut,
      //     ripple-deleted). Used for <start>/<end>.
      //   sourceStart/sourceEnd    → which slice of the source file. Used
      //     for <in>/<out>.
      // Legacy single-clip path (no cuts) only sets seg.start/seg.end and
      // both coordinate systems collapse to the same value — no ripple
      // needed because there are no cuts. Fall back to start/end when the
      // explicit fields aren't provided.
      const tlStart = Number.isFinite(seg.timelineStart) ? seg.timelineStart : seg.start
      const tlEnd = Number.isFinite(seg.timelineEnd) ? seg.timelineEnd : seg.end
      const srcStart = Number.isFinite(seg.sourceStart) ? seg.sourceStart : seg.start
      const srcEnd = Number.isFinite(seg.sourceEnd) ? seg.sourceEnd : seg.end
      const sourceDurationSec = Number.isFinite(seg.sourceDurationSeconds) && seg.sourceDurationSeconds > 0
        ? seg.sourceDurationSeconds
        : (srcEnd - srcStart)
      // Two rates per clipitem:
      //   - frameRate (sequence) governs every frame count INSIDE the
      //     <clipitem>: <start>, <end>, <in>, <out>, and clipitem-<duration>.
      //     Premiere reads them at the clipitem's effective rate, which
      //     defaults to the sequence's rate when the clipitem has no inner
      //     <rate>. Computing <in>/<out> at arollFrameRate made Premiere's
      //     source monitor display the IN at frame/seq_rate seconds:
      //     <in>129</in> on a 29.97 source emitted-at-30 read as 2.58s
      //     instead of the intended 4.30s.
      //   - arollFrameRate (file) only governs values inside the inner
      //     <file> block: file's <rate> + file's <duration>.
      const arollClipitemDurationFrames = Math.round(sourceDurationSec * frameRate)
      const arollFileDurationFrames = Math.round(sourceDurationSec * arollFrameRate)
      const startFrame = secondsToFrames(tlStart, frameRate)
      const endFrame = secondsToFrames(tlEnd, frameRate)
      const inSrcFrames = Math.round(srcStart * frameRate)
      const outSrcFrames = Math.round(srcEnd * frameRate)
      // Legacy aroll uses the original bare id (no index suffix) for backwards
      // compat with existing tests and any saved Premiere XML references.
      const arollClipId = useSegments ? `clip-${seqSlug}-aroll-${i + 1}` : `clip-${seqSlug}-aroll`
      const arollFileId = i === 0 ? `file-aroll` : `file-aroll-${i + 1}`

      // Element order + always-emit-ntsc per WyattBlue/auto-editor —
      // see b-roll branch for rationale.
      const arollNtscTag = `<ntsc>${arollNtsc ? 'TRUE' : 'FALSE'}</ntsc>`
      lines.push(`          <clipitem id="${escapeXml(arollClipId)}">`)
      lines.push(`            <name>${escapeXml(arollFilename)}</name>`)
      lines.push(`            <enabled>TRUE</enabled>`)
      lines.push(`            <duration>${arollClipitemDurationFrames}</duration>`)
      lines.push(`            <start>${startFrame}</start>`)
      lines.push(`            <end>${endFrame}</end>`)
      lines.push(`            <in>${inSrcFrames}</in>`)
      lines.push(`            <out>${outSrcFrames}</out>`)
      // pproTicks are picosecond-precision IN/OUT for source — Premiere
      // uses these instead of integer in/out frames. Use source coords.
      lines.push(`            <pproTicksIn>${secondsToPproTicks(srcStart)}</pproTicksIn>`)
      lines.push(`            <pproTicksOut>${secondsToPproTicks(srcEnd)}</pproTicksOut>`)
      if (i === 0) {
        // First clipitem owns the <file> block; later clipitems reference it by id.
        const arollHasDur = Number.isFinite(seg.sourceDurationSeconds) && seg.sourceDurationSeconds > 0
        lines.push(`            <file id="${escapeXml(arollFileId)}">`)
        lines.push(`              <name>${escapeXml(arollFilename)}</name>`)
        lines.push(`              <pathurl>${escapeXml(buildPathUrl(mediaFolderAbsolute, arollFilename))}</pathurl>`)
        // <timecode> first per WyattBlue's order. Override embedded
        // SMPTE so DaVinci accepts our zero-based <in>/<out>.
        lines.push(`              <timecode>`)
        lines.push(`                <string>00:00:00:00</string>`)
        lines.push(`                <displayformat>NDF</displayformat>`)
        lines.push(`                <rate><timebase>${arollFrameRate}</timebase>${arollNtscTag}</rate>`)
        lines.push(`              </timecode>`)
        lines.push(`              <rate><timebase>${arollFrameRate}</timebase>${arollNtscTag}</rate>`)
        // Empty <duration> tag REQUIRED by DaVinci even if blank.
        lines.push(`              <duration>${arollHasDur ? arollFileDurationFrames : ''}</duration>`)
        // <media> with sequence dims, rate, pixelaspectratio per WyattBlue.
        // <audio> sibling declares stereo PCM characteristics — mandatory
        // for Premiere to apply the audiolevels filter we emit on the audio
        // clipitems below. Mono sources mirror channel 1 to both A1/A2.
        lines.push(`              <media>`)
        lines.push(`                <video>`)
        lines.push(`                  <samplecharacteristics>`)
        lines.push(`                    <rate><timebase>${arollFrameRate}</timebase>${arollNtscTag}</rate>`)
        lines.push(`                    <width>${seqW}</width>`)
        lines.push(`                    <height>${seqH}</height>`)
        lines.push(`                    <pixelaspectratio>square</pixelaspectratio>`)
        lines.push(`                  </samplecharacteristics>`)
        lines.push(`                </video>`)
        lines.push(`                <audio>`)
        lines.push(`                  <samplecharacteristics>`)
        lines.push(`                    <depth>16</depth>`)
        lines.push(`                    <samplerate>48000</samplerate>`)
        lines.push(`                  </samplecharacteristics>`)
        lines.push(`                  <channelcount>2</channelcount>`)
        lines.push(`                </audio>`)
        lines.push(`              </media>`)
        lines.push(`            </file>`)
      } else {
        lines.push(`            <file id="${escapeXml(`file-aroll`)}"/>`)
      }
      lines.push(`            <compositemode>normal</compositemode>`)
      lines.push(`          </clipitem>`)
      // Stash everything an audio twin clipitem needs. Emitted after the
      // last <video> track closes so XML order stays <video>...</video>
      // <audio>...</audio> per FCP7 spec.
      audioSegments.push({
        videoClipId: arollClipId,
        filename: arollFilename,
        startFrame, endFrame,
        inSrcFrames, outSrcFrames,
        srcStart, srcEnd,
        sourceFrames: arollClipitemDurationFrames,
      })
    }
    lines.push(`        </track>`)
  }

  // Emit tracks in V1, V2, V3 order. If placements is empty, emit zero
  // tracks inside <video> — valid xmeml, opens in Premiere as an empty
  // video layer.
  //
  // For each clipitem we model two distinct durations per the FCP7
  // XMEML spec:
  //   <clipitem><duration> + <file><duration> = the SOURCE media's full
  //     length, in SOURCE-rate frames (so Premiere shows trim handles
  //     past the cut).
  //   <in>/<out> = the slice OF the source we're using, in SOURCE-rate
  //     frames. out − in = the source-frame count covering this cut.
  //   <start>/<end> = where on the sequence timeline this slice lands,
  //     in SEQUENCE-rate frames.
  //
  // The two coordinate systems match only when sequence rate == source
  // rate. For a 50fps timeline carrying 30fps b-roll, a 2s clip is 100
  // sequence frames AND 60 source frames — both are emitted, each in
  // its own field's expected unit.
  //
  // Today every cut starts at source frame 0; if/when the b-roll editor
  // exposes a per-placement source-IN, plumb it through and adjust the
  // `in`/`out` calc here.
  const trackIndices = Array.from(tracksByIndex.keys()).sort((a, b) => a - b)
  // Track which file IDs we've already emitted with a full <file> body.
  // Same source clip used at N timeline positions emits N <clipitem>s,
  // but only the FIRST gets the full <file> block — subsequent ones use
  // the self-closing <file id="X"/> reference. Without this we emit
  // duplicate <file id="X"> blocks and DaVinci rejects with "Item
  // already exists" — the source of the user's persistent rejections.
  const emittedFileIds = new Set()
  // Counter for unique clipitem IDs. The placement.seq is shared across
  // multiple placements of the same source (buildManifest dedupes by
  // source|id), so seq-based clipitem IDs collide when a clip is reused.
  // Use a strictly-increasing counter scoped to this sequence.
  let clipItemCounter = 0
  for (const trackIdx of trackIndices) {
    lines.push(`        <track>`)
    for (const p of tracksByIndex.get(trackIdx)) {
      clipItemCounter += 1
      const clipId = `clip-${seqSlug}-${padSeq(p.seq)}-${clipItemCounter}`
      const fileId = `file-${slugifyForId(p.source)}-${slugifyForId(p.sourceItemId) || padSeq(p.seq)}`
      const fileBodyAlreadyEmitted = emittedFileIds.has(fileId)
      emittedFileIds.add(fileId)
      // Offset <in>/<out> by the file's embedded TC frame so DaVinci
      // accepts the slice. With a non-zero embedded TC (e.g.
      // 18:16:14:04 → frame 1577140 at timebase 24), <in>0</in> means
      // "absolute TC 00:00:00:00" which doesn't exist in the file's
      // TC range. Offset gives <in>1577140 = file's actual frame 0
      // = TC 18:16:14:04 = within range.
      // Edit-list compensation: when the source file's video trak has
      // an elst with non-zero media_time, the first presented frame is
      // shifted forward by _videoEditListOffsetFrames media frames at
      // source rate. DaVinci's TC-range validation expects <in>/<out>
      // to land within the post-elst presentation range — without this
      // addition, <in>=tcOffset points to media frame 0 which is BEFORE
      // the presentation starts, and DaVinci shows the clip as offline.
      // Premiere is lenient about this; DaVinci is strict.
      // Slip-edit: _sourceInFrames is the editor's chosen source start
      // point (in source-rate frames). Added on top of tcOffset so the
      // three offsets stack: embeddedTC + elst + slip.
      const tcOffset = (p._embeddedTimecodeFrame || 0) + (p._videoEditListOffsetFrames || 0)
      const inFrame = tcOffset + (p._sourceInFrames || 0)
      const outFrame = inFrame + p._durationSrcFrames
      // Element order + always-emit-ntsc derived from
      // WyattBlue/auto-editor's working DaVinci-compatible exporter
      // (src/exports/fcp7.nim). DaVinci validates element order in
      // <file>: timecode → rate → duration → media. Out-of-order
      // tags caused "File not found in search directories" rejections
      // even when paths and metadata were correct. <ntsc> must always
      // be present (TRUE for fractional rates, FALSE otherwise) —
      // omitting lets DaVinci default-guess and disagree with our
      // claim.
      const ntscTag = `<ntsc>${p._sourceNtsc ? 'TRUE' : 'FALSE'}</ntsc>`
      const pproIn = secondsToPproTicks(0)
      const pproOut = secondsToPproTicks(p._timelineDurationSec)
      lines.push(`          <clipitem id="${escapeXml(clipId)}">`)
      lines.push(`            <name>${escapeXml(p.filename)}</name>`)
      lines.push(`            <enabled>TRUE</enabled>`)
      lines.push(`            <duration>${p._sourceDurationFrames}</duration>`)
      lines.push(`            <start>${p._startFrame}</start>`)
      lines.push(`            <end>${p._endFrame}</end>`)
      lines.push(`            <in>${inFrame}</in>`)
      lines.push(`            <out>${outFrame}</out>`)
      lines.push(`            <pproTicksIn>${pproIn}</pproTicksIn>`)
      lines.push(`            <pproTicksOut>${pproOut}</pproTicksOut>`)
      if (fileBodyAlreadyEmitted) {
        // Reference-only — same source clip already had its full <file>
        // body emitted in an earlier clipitem on this sequence. Per FCP7
        // XMEML, subsequent uses link by id with self-closing tag.
        // Without this we'd emit N full <file id="X"> blocks for a clip
        // used N times, which is invalid XML (duplicate id) and makes
        // DaVinci report "Item already exists" repeatedly.
        lines.push(`            <file id="${escapeXml(fileId)}"/>`)
      } else {
        lines.push(`            <file id="${escapeXml(fileId)}">`)
        lines.push(`              <name>${escapeXml(p.filename)}</name>`)
        lines.push(`              <pathurl>${escapeXml(buildPathUrl(mediaFolderAbsolute, p.filename))}</pathurl>`)
        // <timecode>: declare the file's actual embedded SMPTE so
        // DaVinci's strict TC validation matches our absolute in/out
        // frame numbers. When the file has no embedded TC (or zero),
        // we declare 00:00:00:00 — same as before. Per FCP7 spec
        // <string> is the TC at file frame 0; <frame> is that frame
        // number (here always 0 since we declare from file's start).
        // <displayformat>: DF if the embedded TC uses semicolon
        // separator (29.97 drop-frame), NDF otherwise.
        const tcString = p._embeddedTimecode || '00:00:00:00'
        const tcDisplayFmt = (p._embeddedTimecode || '').includes(';') ? 'DF' : 'NDF'
        lines.push(`              <timecode>`)
        lines.push(`                <string>${tcString}</string>`)
        lines.push(`                <displayformat>${tcDisplayFmt}</displayformat>`)
        lines.push(`                <rate><timebase>${p._sourceFrameRate}</timebase>${ntscTag}</rate>`)
        lines.push(`              </timecode>`)
        lines.push(`              <rate><timebase>${p._sourceFrameRate}</timebase>${ntscTag}</rate>`)
        // Empty <duration> tag is REQUIRED by DaVinci even when blank
        // (per WyattBlue's "DaVinci Resolve needs this tag even though
        // it's blank"). Populated when probed; empty otherwise.
        lines.push(`              <duration>${p._sourceDurationConfirmed ? p._sourceDurationFrames : ''}</duration>`)
        // <media><video><samplecharacteristics> with sequence dimensions,
        // <rate>, and <pixelaspectratio>square</pixelaspectratio>. WyattBlue
        // uses sequence dims for every file (not per-file dims) — per-file
        // dims drift from probed-preview vs licensed source.
        lines.push(`              <media>`)
        lines.push(`                <video>`)
        lines.push(`                  <samplecharacteristics>`)
        lines.push(`                    <rate><timebase>${p._sourceFrameRate}</timebase>${ntscTag}</rate>`)
        lines.push(`                    <width>${seqW}</width>`)
        lines.push(`                    <height>${seqH}</height>`)
        lines.push(`                    <pixelaspectratio>square</pixelaspectratio>`)
        lines.push(`                  </samplecharacteristics>`)
        lines.push(`                </video>`)
        lines.push(`              </media>`)
        lines.push(`            </file>`)
      }
      lines.push(`            <compositemode>normal</compositemode>`)
      lines.push(`          </clipitem>`)
    }
    lines.push(`        </track>`)
  }

  lines.push(`      </video>`)

  // <audio> sibling — A-roll audio twins on A1 (channel 1) and A2 (channel 2).
  // Structure mirrors WyattBlue/auto-editor's `premiereWriteAudio`:
  //   <numOutputChannels> + <format><samplecharacteristics> declare the
  //   sequence audio rate (without these, Premiere reinterprets clipitem
  //   <in>/<out> as 48kHz samples instead of video-frame indices and the
  //   audio desyncs from the video). Each <track> carries Premiere stereo
  //   attributes + a leading <outputchannelindex>. Clipitems omit
  //   <duration>, <pproTicks*>, and an audiolevels <filter> — auto-editor
  //   doesn't emit those on audio; once <format> is declared Premiere
  //   defaults to unity gain on its own.
  // <link> blocks tie V1/A1/A2 of the same segment together so trims stay
  // synced — auto-editor leaves linking to the user, but our pipeline
  // wants the user to trim A/V as one clip in the NLE.
  if (audioSegments.length > 0) {
    lines.push(`      <audio>`)
    lines.push(`        <numOutputChannels>2</numOutputChannels>`)
    lines.push(`        <format>`)
    lines.push(`          <samplecharacteristics>`)
    lines.push(`            <depth>16</depth>`)
    lines.push(`            <samplerate>48000</samplerate>`)
    lines.push(`          </samplecharacteristics>`)
    lines.push(`        </format>`)
    for (const channel of [1, 2]) {
      const explodedIndex = channel - 1  // 0-based
      lines.push(`        <track currentExplodedTrackIndex="${explodedIndex}" totalExplodedTrackCount="2" premiereTrackType="Stereo">`)
      lines.push(`          <outputchannelindex>${channel}</outputchannelindex>`)
      for (let i = 0; i < audioSegments.length; i++) {
        const a = audioSegments[i]
        const audioClipId = `${a.videoClipId}-a${channel}`
        const segIndex = i + 1  // 1-based clipindex per FCP7 spec
        lines.push(`          <clipitem id="${escapeXml(audioClipId)}" premiereChannelType="stereo">`)
        lines.push(`            <name>${escapeXml(a.filename)}</name>`)
        lines.push(`            <enabled>TRUE</enabled>`)
        lines.push(`            <start>${a.startFrame}</start>`)
        lines.push(`            <end>${a.endFrame}</end>`)
        lines.push(`            <in>${a.inSrcFrames}</in>`)
        lines.push(`            <out>${a.outSrcFrames}</out>`)
        lines.push(`            <file id="file-aroll"/>`)
        lines.push(`            <sourcetrack>`)
        lines.push(`              <mediatype>audio</mediatype>`)
        lines.push(`              <trackindex>${channel}</trackindex>`)
        lines.push(`            </sourcetrack>`)
        lines.push(`            <labels>`)
        lines.push(`              <label2>Iris</label2>`)
        lines.push(`            </labels>`)
        lines.push(`            <link>`)
        lines.push(`              <linkclipref>${escapeXml(a.videoClipId)}</linkclipref>`)
        lines.push(`              <mediatype>video</mediatype>`)
        lines.push(`              <trackindex>1</trackindex>`)
        lines.push(`              <clipindex>${segIndex}</clipindex>`)
        lines.push(`            </link>`)
        lines.push(`            <link>`)
        lines.push(`              <linkclipref>${escapeXml(a.videoClipId)}-a1</linkclipref>`)
        lines.push(`              <mediatype>audio</mediatype>`)
        lines.push(`              <trackindex>1</trackindex>`)
        lines.push(`              <clipindex>${segIndex}</clipindex>`)
        lines.push(`            </link>`)
        lines.push(`            <link>`)
        lines.push(`              <linkclipref>${escapeXml(a.videoClipId)}-a2</linkclipref>`)
        lines.push(`              <mediatype>audio</mediatype>`)
        lines.push(`              <trackindex>2</trackindex>`)
        lines.push(`              <clipindex>${segIndex}</clipindex>`)
        lines.push(`            </link>`)
        lines.push(`          </clipitem>`)
      }
      lines.push(`        </track>`)
    }
    lines.push(`      </audio>`)
  }

  lines.push(`    </media>`)
  lines.push(`  </sequence>`)
  lines.push(`</xmeml>`)
  lines.push(``)  // trailing newline

  return lines.join('\n')
}
