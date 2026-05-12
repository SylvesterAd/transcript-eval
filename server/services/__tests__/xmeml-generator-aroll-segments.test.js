import { describe, it, expect } from 'vitest'
import { generateXmeml } from '../xmeml-generator.js'

describe('generateXmeml — arollSegments', () => {
  const baseInput = {
    sequenceName: 'TestSeq',
    placements: [],
    frameRate: 50,
    sequenceSize: { w: 1920, h: 1080 },
  }

  it('emits one V1 clipitem per segment', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [
        { filename: 'aroll.mov', start: 0, end: 10 },
        { filename: 'aroll.mov', start: 15, end: 30 },
      ],
    })
    // Two A-Roll VIDEO clipitems on V1. The audio twins on A1/A2 use the
    // same base ID with `-a1` / `-a2` suffix; this regex stops at the first
    // digit-then-quote so it only counts video clips, not audio twins.
    const matches = xml.match(/<clipitem id="clip-[^"]*-aroll-\d+"/g) || []
    expect(matches.length).toBe(2)
    // First clip start=0, end = 10 * 50fps = 500 frames.
    expect(xml).toMatch(/<start>0<\/start>[\s\S]*?<end>500<\/end>/)
    // Second clip start = 15 * 50 = 750, end = 30 * 50 = 1500.
    expect(xml).toMatch(/<start>750<\/start>[\s\S]*?<end>1500<\/end>/)
  })

  it('arollSegments takes precedence over legacy aroll prop', () => {
    const xml = generateXmeml({
      ...baseInput,
      aroll: { filename: 'should-be-ignored.mov' },
      arollSegments: [{ filename: 'real.mov', start: 0, end: 5 }],
    })
    expect(xml).toMatch(/real\.mov/)
    expect(xml).not.toMatch(/should-be-ignored/)
  })

  it('falls back to legacy aroll prop when arollSegments is absent', () => {
    const xml = generateXmeml({
      ...baseInput,
      aroll: { filename: 'legacy.mov' },
    })
    expect(xml).toMatch(/legacy\.mov/)
  })

  it('emits no V1 track when both arollSegments and aroll are absent', () => {
    const xml = generateXmeml({ ...baseInput })
    expect(xml).not.toMatch(/clipitem.*aroll/)
  })

  it('rejects empty arollSegments array gracefully (falls through to legacy aroll)', () => {
    const xml = generateXmeml({ ...baseInput, arollSegments: [] })
    expect(xml).not.toMatch(/clipitem.*aroll/)
  })

  it('also falls through to legacy aroll when arollSegments is empty array', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [],
      aroll: { filename: 'fallback.mov' },
    })
    expect(xml).toMatch(/fallback\.mov/)
  })

  it('preserves source IN/OUT correctly per segment (timeline pos vs source pos)', () => {
    // A 30s aroll source. Segment is [10,20] in original time = a 10s slice.
    // <start>/<end> AND <in>/<out> all live INSIDE the clipitem and Premiere
    // reads them at the clipitem's effective rate (= sequence rate when no
    // inner <rate>). So all four values use frameRate=50:
    //   <start> = 10*50 = 500    <in>  = 10*50 = 500
    //   <end>   = 20*50 = 1000   <out> = 20*50 = 1000
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{
        filename: 'aroll.mov',
        start: 10,
        end: 20,
        sourceFrameRate: 30,
        sourceDurationSeconds: 30,
      }],
    })
    expect(xml).toMatch(/<start>500<\/start>/)
    expect(xml).toMatch(/<end>1000<\/end>/)
    expect(xml).toMatch(/<in>500<\/in>/)
    expect(xml).toMatch(/<out>1000<\/out>/)
  })

  it('uses timelineStart/timelineEnd for <start>/<end> (ripple-deleted), sourceStart/sourceEnd for <in>/<out>', () => {
    // Models the user's actual case: source has a 18.78s intro cut and
    // a 22.66s mid cut (5:51-6:14). Two kept segments.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [
        // First kept segment: source 18.78s-351.62s, timeline 0-332.84s (intro removed).
        { filename: 'aroll.mov',
          sourceStart: 18.78, sourceEnd: 351.62,
          timelineStart: 0,    timelineEnd: 332.84,
          sourceFrameRate: 30, sourceDurationSeconds: 713 },
        // Second kept segment: source 374.28s-713s, timeline lays
        // contiguous starting where the first ended (332.84s) — the
        // 22.66s gap from 351.62→374.28 source is collapsed.
        { filename: 'aroll.mov',
          sourceStart: 374.28, sourceEnd: 713.00,
          timelineStart: 332.84, timelineEnd: 671.56,
          sourceFrameRate: 30, sourceDurationSeconds: 713 },
      ],
    })
    // All four frame counts inside the clipitem use sequence rate (50).
    //   seg 1 timeline 0 → 332.84*50 = 16642 ; source 18.78*50=939 → 351.62*50=17581
    expect(xml).toMatch(/<clipitem id="clip-testseq-aroll-1">[\s\S]*?<start>0<\/start>\s*<end>16642<\/end>\s*<in>939<\/in>\s*<out>17581<\/out>/)
    //   seg 2 timeline 332.84*50=16642 → 671.56*50=33578 ; source 374.28*50=18714 → 713*50=35650
    expect(xml).toMatch(/<clipitem id="clip-testseq-aroll-2">[\s\S]*?<start>16642<\/start>\s*<end>33578<\/end>\s*<in>18714<\/in>\s*<out>35650<\/out>/)
  })

  it('falls back to start/end when timelineStart not provided (legacy callers)', () => {
    // Pre-fix callers passed only start/end — both coordinates collapse
    // to the same source-time value. New fields are opt-in.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{
        filename: 'aroll.mov',
        start: 5, end: 15,
        sourceFrameRate: 30, sourceDurationSeconds: 30,
      }],
    })
    // All four frame counts at sequence rate 50:
    //   <start>=5*50=250  <end>=15*50=750  <in>=5*50=250  <out>=15*50=750
    expect(xml).toMatch(/<start>250<\/start>\s*<end>750<\/end>\s*<in>250<\/in>\s*<out>750<\/out>/)
  })
})
