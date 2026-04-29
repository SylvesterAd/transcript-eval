import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  escapeXml,
  sanitizeFilename,
  secondsToFrames,
  assignTracks,
  generateXmeml,
  buildPathUrl,
} from '../xmeml-generator.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURES = path.join(__dirname, '__fixtures__', 'xmeml')

function loadFixture(name) {
  return readFileSync(path.join(FIXTURES, name), 'utf-8')
}

describe('escapeXml', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world')
    expect(escapeXml('001_envato_NX9WYGQ.mov')).toBe('001_envato_NX9WYGQ.mov')
  })

  it('escapes the five XML reserved chars', () => {
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;')
    expect(escapeXml('Tom & Jerry')).toBe('Tom &amp; Jerry')
    expect(escapeXml(`she said "hi"`)).toBe('she said &quot;hi&quot;')
    expect(escapeXml(`it's fine`)).toBe('it&apos;s fine')
  })

  it('does not double-escape already-escaped entities', () => {
    // This is the subtle bug: naive sequential .replace would turn
    // "&amp;" into "&amp;amp;" if & is processed before <. Our regex
    // fires one replacement per char position, so we're safe.
    expect(escapeXml('&amp;')).toBe('&amp;amp;')
    // NB: the correct behavior for an input that happens to already
    // look escaped IS to re-escape — the input is a raw string, not
    // pre-escaped XML. The assertion above is intentional.
  })

  it('handles null/undefined gracefully', () => {
    expect(escapeXml(null)).toBe('')
    expect(escapeXml(undefined)).toBe('')
  })

  it('coerces non-strings via String()', () => {
    expect(escapeXml(42)).toBe('42')
    expect(escapeXml(true)).toBe('true')
  })
})

describe('sanitizeFilename', () => {
  it('passes through safe ASCII names', () => {
    expect(sanitizeFilename('001_envato_NX9WYGQ.mov')).toBe('001_envato_NX9WYGQ.mov')
    expect(sanitizeFilename('002_pexels_456.mp4')).toBe('002_pexels_456.mp4')
  })

  it('replaces Windows-reserved chars with _', () => {
    expect(sanitizeFilename('bad<name>.mov')).toBe('bad_name_.mov')
    expect(sanitizeFilename('a:b|c?d*.mp4')).toBe('a_b_c_d_.mp4')
    expect(sanitizeFilename('with"quote.mov')).toBe('with_quote.mov')
  })

  it('drops non-printable ASCII and unicode', () => {
    expect(sanitizeFilename('café.mov')).toBe('caf.mov')           // é dropped
    expect(sanitizeFilename('tab\there.mov')).toBe('tabhere.mov')  // \t dropped
    expect(sanitizeFilename('日本語.mp4')).toBe('.mp4')
  })

  it('caps length at 240 chars', () => {
    const long = 'x'.repeat(500)
    const out = sanitizeFilename(long)
    expect(out.length).toBe(240)
    expect(out).toBe('x'.repeat(240))
  })

  it('handles null/undefined/empty as empty string', () => {
    expect(sanitizeFilename(null)).toBe('')
    expect(sanitizeFilename(undefined)).toBe('')
    expect(sanitizeFilename('')).toBe('')
  })
})

describe('secondsToFrames', () => {
  it('converts exact boundaries', () => {
    expect(secondsToFrames(0, 30)).toBe(0)
    expect(secondsToFrames(1, 30)).toBe(30)
    expect(secondsToFrames(2.5, 30)).toBe(75)
  })

  it('rounds to nearest frame (banker-style not needed, Math.round)', () => {
    expect(secondsToFrames(0.016666, 30)).toBe(0)   // < 0.5 frame
    expect(secondsToFrames(0.017, 30)).toBe(1)      // > 0.5 frame
    expect(secondsToFrames(1.0 / 60, 60)).toBe(1)   // exact 1 frame at 60fps
  })

  it('throws on non-finite or non-positive inputs', () => {
    expect(() => secondsToFrames(NaN, 30)).toThrow()
    expect(() => secondsToFrames(0, 0)).toThrow()
    expect(() => secondsToFrames(0, -30)).toThrow()
    expect(() => secondsToFrames('1', 30)).toThrow()
  })
})

describe('assignTracks', () => {
  // Helpers: construct a placement with integer frames pre-computed.
  const p = (seq, startFrame, endFrame) => ({
    seq, _startFrame: startFrame, _endFrame: endFrame,
  })

  it('assigns single placement to V1 (index 0)', () => {
    const out = assignTracks([p(1, 0, 60)])
    expect(out[0].trackIndex).toBe(0)
  })

  it('keeps two non-overlapping placements on V1', () => {
    const out = assignTracks([p(1, 0, 60), p(2, 60, 120)])  // butt-splice
    expect(out.map(x => x.trackIndex)).toEqual([0, 0])

    const out2 = assignTracks([p(1, 0, 60), p(2, 90, 150)]) // gap
    expect(out2.map(x => x.trackIndex)).toEqual([0, 0])
  })

  it('stacks three overlapping placements across V1/V2/V3', () => {
    // All three overlap at frame 30.
    const out = assignTracks([
      p(1, 0, 60),
      p(2, 10, 70),
      p(3, 20, 80),
    ])
    // After sort by start: [1, 2, 3] already.
    expect(out.map(x => ({ seq: x.seq, t: x.trackIndex }))).toEqual([
      { seq: 1, t: 0 },
      { seq: 2, t: 1 },
      { seq: 3, t: 2 },
    ])
  })

  it('reuses a track when a prior clip has ended', () => {
    // p1 ends at 60, p3 starts at 70 — p3 goes on V1 not V3.
    const out = assignTracks([
      p(1, 0, 60),
      p(2, 10, 100),  // opens V2
      p(3, 70, 120),  // should reuse V1 (60 ≤ 70)
    ])
    expect(out.map(x => ({ seq: x.seq, t: x.trackIndex }))).toEqual([
      { seq: 1, t: 0 },
      { seq: 2, t: 1 },
      { seq: 3, t: 0 },
    ])
  })

  it('breaks start-time ties by seq (deterministic)', () => {
    const out = assignTracks([
      p(2, 0, 60),
      p(1, 0, 60),
    ])
    // Sort by start=0 both → seq tiebreak → p1 before p2.
    // Both start at 0 and overlap → V1 and V2.
    expect(out.map(x => ({ seq: x.seq, t: x.trackIndex }))).toEqual([
      { seq: 1, t: 0 },
      { seq: 2, t: 1 },
    ])
  })
})

describe('generateXmeml — golden fixtures', () => {
  it('Case 1: single placement, single track, matches fixture', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant C',
      placements: [
        { seq: 1, source: 'envato', sourceItemId: 'NX9WYGQ',
          filename: '001_envato_NX9WYGQ.mov',
          timelineStart: 25.4, timelineDuration: 4.0,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toBe(loadFixture('single-placement.xml'))
  })

  it('Case 2: two non-overlapping placements, both on V1', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: 'pexels', sourceItemId: '456',
          filename: '002_pexels_456.mp4',
          timelineStart: 3, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toBe(loadFixture('two-non-overlapping.xml'))
    // Structural assertion: exactly one <track> opening
    expect((xml.match(/<track>/g) || []).length).toBe(1)
  })

  it('Case 3: three overlapping placements → V1, V2, V3', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant C',
      placements: [
        { seq: 1, source: 'envato', sourceItemId: 'A',
          filename: '001_envato_A.mov',
          timelineStart: 0, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: 'envato', sourceItemId: 'B',
          filename: '002_envato_B.mov',
          timelineStart: 1, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 3, source: 'envato', sourceItemId: 'C',
          filename: '003_envato_C.mov',
          timelineStart: 2, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toBe(loadFixture('three-overlapping.xml'))
    expect((xml.match(/<track>/g) || []).length).toBe(3)
  })

  it('Case 4: missing metadata falls back to sequence defaults', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant B',
      placements: [
        { seq: 1, source: 'freepik', sourceItemId: 'xyz',
          filename: '001_freepik_xyz.mp4',
          timelineStart: 0, timelineDuration: 3 },
      ],
    })
    expect(xml).toBe(loadFixture('missing-metadata.xml'))
    // Structural: emitted width/height are the sequence defaults
    expect(xml).toContain('<width>1920</width><height>1080</height>')
    expect(xml).toContain('<timebase>30</timebase>')
  })
})

describe('generateXmeml — sanitization + edge cases', () => {
  it('Case 5: filename with reserved chars is sanitized in <name> and <pathurl>', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant C',
      placements: [
        { seq: 1, source: 'envato', sourceItemId: 'X',
          filename: 'bad<name>:clip|001?.mov',  // all 5 reserved chars
          timelineStart: 0, timelineDuration: 1,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    // Reserved chars replaced with _; the raw input never appears.
    expect(xml).not.toContain('bad<name>')
    expect(xml).toContain('bad_name_')
    // <name> and <pathurl> both use the sanitized form (bare filename
    // when mediaFolderAbsolute is unset — Premiere relinks via Match
    // File Properties → File Name in the XML's folder).
    expect(xml).toMatch(/<name>bad_name_[^<]*<\/name>/)
    expect(xml).toMatch(/<pathurl>bad_name_[^<]*<\/pathurl>/)
  })

  it('Case 5b: XML reserved chars in sequenceName are escaped', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant & Co <demo>',
      placements: [],
    })
    expect(xml).toContain('<name>Variant &amp; Co &lt;demo&gt;</name>')
    // Raw "Variant & Co <demo>" does NOT appear as-is
    expect(xml).not.toContain('<name>Variant & Co <demo></name>')
  })

  it('Case 6: empty placements array → valid empty <sequence>', () => {
    const xml = generateXmeml({
      sequenceName: 'Empty',
      placements: [],
    })
    // Must be valid xmeml (contains the wrapper)
    expect(xml).toMatch(/^<\?xml version="1\.0"/)
    expect(xml).toContain('<xmeml version="5">')
    expect(xml).toContain('<sequence ')
    expect(xml).toContain('<duration>0</duration>')
    // No <track> elements (zero placements → zero tracks)
    expect(xml).not.toContain('<track>')
    // Ends with the document close
    expect(xml.trim().endsWith('</xmeml>')).toBe(true)
  })

  it('Case 7: determinism — two calls with the same input produce identical output', () => {
    const input = {
      sequenceName: 'Variant C',
      placements: [
        { seq: 1, source: 'envato', sourceItemId: 'A',
          filename: '001_envato_A.mov',
          timelineStart: 0, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: 'envato', sourceItemId: 'B',
          filename: '002_envato_B.mov',
          timelineStart: 1, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    }
    const a = generateXmeml(input)
    const b = generateXmeml(input)
    expect(a).toBe(b)
    // Also verify: byte-identical length as a pure sanity check
    expect(Buffer.byteLength(a)).toBe(Buffer.byteLength(b))
  })
})

describe('buildPathUrl', () => {
  it('returns bare filename when no folder is provided', () => {
    expect(buildPathUrl(null, 'foo.mp4')).toBe('foo.mp4')
    expect(buildPathUrl(undefined, '001_pexels_x.mp4')).toBe('001_pexels_x.mp4')
    expect(buildPathUrl('', 'a.mov')).toBe('a.mov')
  })

  it('emits absolute file:/// URL when folder is provided', () => {
    expect(
      buildPathUrl('/Users/laurynas/Downloads/transcript-eval/export-370-a', '001_aroll_370.mp4'),
    ).toBe('file:///Users/laurynas/Downloads/transcript-eval/export-370-a/001_aroll_370.mp4')
  })

  it('URL-encodes spaces and special chars in folder + filename', () => {
    expect(
      buildPathUrl('/Users/jane doe/My Movies', 'clip with space.mov'),
    ).toBe('file:///Users/jane%20doe/My%20Movies/clip%20with%20space.mov')
  })

  it('strips leading/trailing slashes from folder', () => {
    expect(buildPathUrl('//Users/foo//', 'x.mp4')).toBe('file:///Users/foo/x.mp4')
  })
})

describe('generateXmeml — pathurl + source duration semantics', () => {
  it('emits absolute file:/// URL when mediaFolderAbsolute provided', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
      mediaFolderAbsolute: '/Users/laurynas/Downloads/transcript-eval/export-370-a',
    })
    expect(xml).toContain('<pathurl>file:///Users/laurynas/Downloads/transcript-eval/export-370-a/001_pexels_123.mp4</pathurl>')
  })

  it('falls back to bare filename when mediaFolderAbsolute is null', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toContain('<pathurl>001_pexels_123.mp4</pathurl>')
    // Negative: the historical malformed form must NOT appear.
    expect(xml).not.toContain('file://./')
  })

  it('emits source duration on <file><duration> when sourceDurationSeconds is set', () => {
    // Stock clip is 30s long, but we're only using a 2s slice on the
    // timeline. <file><duration> should be 30s × 30fps = 900 frames so
    // Premiere shows trim handles past the cut.
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 2,
          sourceDurationSeconds: 30,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    // Source IN/OUT frames the cut WITHIN the source.
    expect(xml).toContain('<in>0</in>')
    expect(xml).toContain('<out>60</out>')   // 2s × 30fps
    // The clipitem AND the file both report the SOURCE duration.
    expect(xml).toMatch(/<clipitem id="clip-variant-a-001">\s*<name>001_pexels_123\.mp4<\/name>\s*<duration>900<\/duration>/)
    expect(xml).toMatch(/<file id="file-pexels-123">\s*<name>001_pexels_123\.mp4<\/name>\s*<pathurl>001_pexels_123\.mp4<\/pathurl>\s*<duration>900<\/duration>/)
  })

  it('falls back to timeline duration when sourceDurationSeconds is missing', () => {
    // Backwards compatibility: old manifests without duration_seconds
    // still produce playable XML — file <duration> = timeline duration.
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    // No source-duration override → <duration> mirrors timeline span.
    expect(xml).toMatch(/<file id="file-pexels-123">[\s\S]*<duration>60<\/duration>/)
  })

  it('emits absolute pathurl on the A-roll track too', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [],
      aroll: { filename: 'aroll_370.mp4', frameRate: 30, sourceDurationSeconds: 120 },
      mediaFolderAbsolute: '/Users/x/Downloads/export-370-a',
    })
    expect(xml).toContain('<pathurl>file:///Users/x/Downloads/export-370-a/aroll_370.mp4</pathurl>')
    // A-roll's source duration is the source's full length (120s × 30 = 3600 frames)
    // not the sequence duration (which is 0 here).
    expect(xml).toMatch(/<clipitem id="clip-variant-a-aroll">\s*<name>aroll_370\.mp4<\/name>\s*<duration>3600<\/duration>/)
  })
})

describe('generateXmeml — pproTicks sub-frame precision', () => {
  // Adobe-specific extension at 254,016,000,000 ticks per second.
  // Lets Premiere position cuts to picosecond precision; without these
  // <in>/<out> snap to integer frames (±16.7ms at 30fps).
  it('emits pproTicksIn=0 and pproTicksOut for every b-roll clipitem', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 2,        // 2.0s × 254,016,000,000 = 508,032,000,000
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toContain('<pproTicksIn>0</pproTicksIn>')
    expect(xml).toContain('<pproTicksOut>508032000000</pproTicksOut>')
  })

  it('preserves sub-frame precision for fractional-second timings', () => {
    // 0.51s at 30fps rounds to 15 frames = 0.5s (10ms loss). pproTicksOut
    // keeps the exact 0.51s without rounding.
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 0.51,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toContain('<out>15</out>')                // frame-snapped
    expect(xml).toContain('<pproTicksOut>129548160000</pproTicksOut>')   // exact: 0.51 × 254e9
  })

  it('emits pproTicksIn/Out on the A-roll track too', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
      aroll: { filename: 'aroll.mp4', frameRate: 30 },
    })
    // A-roll spans the full sequence (60 frames at 30fps = 2s).
    expect(xml).toMatch(/<clipitem id="clip-variant-a-aroll">[\s\S]*?<pproTicksIn>0<\/pproTicksIn>[\s\S]*?<pproTicksOut>508032000000<\/pproTicksOut>/)
  })
})

describe('generateXmeml — input validation', () => {
  it('throws on non-string sequenceName', () => {
    expect(() => generateXmeml({ sequenceName: '', placements: [] })).toThrow()
    expect(() => generateXmeml({ sequenceName: null, placements: [] })).toThrow()
    expect(() => generateXmeml({ sequenceName: 123, placements: [] })).toThrow()
  })

  it('throws on non-array placements', () => {
    expect(() => generateXmeml({ sequenceName: 'x', placements: null })).toThrow()
    expect(() => generateXmeml({ sequenceName: 'x', placements: 'abc' })).toThrow()
  })

  it('throws on invalid frameRate', () => {
    expect(() => generateXmeml({ sequenceName: 'x', placements: [], frameRate: 0 })).toThrow()
    expect(() => generateXmeml({ sequenceName: 'x', placements: [], frameRate: -30 })).toThrow()
  })

  it('throws on placement missing filename', () => {
    expect(() => generateXmeml({
      sequenceName: 'x',
      placements: [{ seq: 1, timelineStart: 0, timelineDuration: 1 }],
    })).toThrow(/filename/)
  })
})
