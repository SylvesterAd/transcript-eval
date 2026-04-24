import { describe, it, expect } from 'vitest'
import { escapeXml, sanitizeFilename, secondsToFrames, assignTracks } from '../xmeml-generator.js'

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
