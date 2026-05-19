import { describe, it, expect } from 'vitest'
import { generateXmeml } from '../xmeml-generator.js'

function basePlacement(overrides = {}) {
  return {
    seq: 1,
    filename: 'pexels_test.mp4',
    timelineStart: 10,
    timelineDuration: 5.0,
    source: 'pexels',
    sourceItemId: 'pex_1',
    sourceFrameRate: 29.97,
    sourceDurationSeconds: 10.0,
    width: 1920,
    height: 1080,
    ...overrides,
  }
}

function extractInOut(xml, filename) {
  const idx = xml.indexOf(filename)
  if (idx === -1) return { in: NaN, out: NaN }
  const seg = xml.slice(idx)
  const inMatch = seg.match(/<in>(-?\d+)<\/in>/)
  const outMatch = seg.match(/<out>(-?\d+)<\/out>/)
  return { in: Number(inMatch?.[1]), out: Number(outMatch?.[1]) }
}

describe('generateXmeml slip-edit + clamp', () => {
  it('source_in_seconds = 1.5 shifts <in> by 1.5 * sourceFps frames', () => {
    const xml = generateXmeml({
      sequenceName: 'test',
      placements: [basePlacement({ source_in_seconds: 1.5 })],
      aroll: null,
      arollSegments: null,
    })
    const { in: inF, out: outF } = extractInOut(xml, 'pexels_test.mp4')
    expect(inF).toBe(Math.round(1.5 * 29.97))
    expect(outF - inF).toBe(Math.round(5.0 * 29.97))
  })

  it('clamp default: source shorter than placement uses min', () => {
    const placement = basePlacement({
      timelineDuration: 7.0,
      sourceDurationSeconds: 6.17,
    })
    const xml = generateXmeml({
      sequenceName: 'test',
      placements: [placement],
      aroll: null,
      arollSegments: null,
    })
    const { in: inF, out: outF } = extractInOut(xml, 'pexels_test.mp4')
    expect(outF - inF).toBeLessThanOrEqual(Math.round(6.17 * 29.97))
  })

  it('keep_original_duration=true emits <out> past source end', () => {
    const placement = basePlacement({
      timelineDuration: 7.0,
      sourceDurationSeconds: 6.17,
      keep_original_duration: true,
      original_timeline_duration: 7.0,
    })
    const xml = generateXmeml({
      sequenceName: 'test',
      placements: [placement],
      aroll: null,
      arollSegments: null,
    })
    const { in: inF, out: outF } = extractInOut(xml, 'pexels_test.mp4')
    expect(outF - inF).toBe(Math.round(7.0 * 29.97))
  })

  it('source_in combined with elst offset adds both', () => {
    const placement = basePlacement({
      source_in_seconds: 1.0,
      videoEditListMediaTimeSeconds: 0.067, // ~2 frames at 29.97
    })
    const xml = generateXmeml({
      sequenceName: 'test',
      placements: [placement],
      aroll: null,
      arollSegments: null,
    })
    const { in: inF } = extractInOut(xml, 'pexels_test.mp4')
    expect(inF).toBe(Math.round(1.0 * 29.97) + Math.round(0.067 * 29.97))
  })

  it('elst-aware clamp: <out> does not overshoot file when source has elst offset', () => {
    // Real-world item 016: 6.17s Pexels MP4 with 2-frame elst, placed in 7s slot.
    // Pre-fix bug: clamp used (sourceDur - sourceIn) but ignored elst, so
    // effectiveDur = 6.17s → 185 src-frames. <in> = 0 + 2 (elst) = 2,
    // <out> = 2 + 185 = 187. File has frames 0..184 (185 total) → <out>=187
    // is 2 frames past the file's last presentable frame.
    const placement = basePlacement({
      timelineDuration: 7.0,
      sourceDurationSeconds: 6.17,
      videoEditListMediaTimeSeconds: 0.067, // ~2 frames at 29.97
    })
    const xml = generateXmeml({
      sequenceName: 'test',
      placements: [placement],
      aroll: null,
      arollSegments: null,
    })
    const { in: inF, out: outF } = extractInOut(xml, 'pexels_test.mp4')
    const sourceTotalFrames = Math.round(6.17 * 29.97) // 185
    expect(outF).toBeLessThanOrEqual(sourceTotalFrames)
  })
})
