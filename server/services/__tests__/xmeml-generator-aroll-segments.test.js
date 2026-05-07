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
    // Two A-Roll clipitems on track 1.
    const matches = xml.match(/<clipitem[^>]*aroll[^"]*"/g) || []
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
    // <start>=10*50=500 (timeline). <end>=20*50=1000.
    // <in>=10*src_rate, <out>=20*src_rate (source coords).
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
    expect(xml).toMatch(/<in>300<\/in>/) // 10 * 30
    expect(xml).toMatch(/<out>600<\/out>/) // 20 * 30
  })
})
