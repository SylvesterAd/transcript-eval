import { describe, it, expect, vi } from 'vitest'

// broll.js imports db.js at module load time (top-level await).
// Mock it before any import from broll.js to prevent process.exit(1).
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ changes: 0 }),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

import {
  parseTimecodeString,
  formatTimecodeString,
  remapPlacementTimesString,
  persistPlacementOutput,
} from '../broll.js'

describe('parseTimecodeString', () => {
  it('parses [HH:MM:SS] without fraction', () => {
    expect(parseTimecodeString('[00:05:09]')).toBe(309)
    expect(parseTimecodeString('[01:00:00]')).toBe(3600)
    expect(parseTimecodeString('[00:00:00]')).toBe(0)
  })

  it('parses [HH:MM:SS.cc] with fraction', () => {
    expect(parseTimecodeString('[00:05:09.50]')).toBe(309.5)
    expect(parseTimecodeString('[00:00:01.25]')).toBe(1.25)
  })

  it('handles single/double/triple digit fractions', () => {
    expect(parseTimecodeString('[00:00:01.5]')).toBe(1.5)    // .5 → 500ms
    expect(parseTimecodeString('[00:00:01.50]')).toBe(1.5)
    expect(parseTimecodeString('[00:00:01.500]')).toBe(1.5)
  })

  it('returns null on unparseable input', () => {
    expect(parseTimecodeString('00:05:09')).toBe(null)  // missing brackets
    expect(parseTimecodeString('[5:09]')).toBe(null)    // wrong format
    expect(parseTimecodeString('garbage')).toBe(null)
    expect(parseTimecodeString('')).toBe(null)
    expect(parseTimecodeString(null)).toBe(null)
    expect(parseTimecodeString(undefined)).toBe(null)
    expect(parseTimecodeString(42)).toBe(null)
  })
})

describe('formatTimecodeString', () => {
  it('formats whole seconds without fraction', () => {
    expect(formatTimecodeString(309)).toBe('[00:05:09]')
    expect(formatTimecodeString(0)).toBe('[00:00:00]')
    expect(formatTimecodeString(3600)).toBe('[01:00:00]')
  })

  it('formats sub-second values with .cc fraction', () => {
    expect(formatTimecodeString(309.5)).toBe('[00:05:09.50]')
    expect(formatTimecodeString(1.25)).toBe('[00:00:01.25]')
  })

  it('parseTimecodeString is left-inverse of formatTimecodeString for whole-second values', () => {
    for (let s = 0; s < 7200; s += 47) {
      expect(parseTimecodeString(formatTimecodeString(s))).toBe(s)
    }
  })

  it('handles negative or non-finite input gracefully', () => {
    expect(formatTimecodeString(-5)).toBe('[00:00:00]')
    expect(formatTimecodeString(NaN)).toBe('[00:00:00]')
    expect(formatTimecodeString(Infinity)).toBe('[00:00:00]')
  })

  // Regression: float drift can produce values like 349.99999999 where the
  // naive (s, cs) split gives s=49 + cs=100 — invalid centiseconds, parses
  // back as 349.1 instead of 350. The formatter now rounds in centisecond
  // units first, then derives each field, so the carry to seconds happens
  // correctly.
  it('carries cs=100 to seconds when value rounds up', () => {
    expect(formatTimecodeString(349.999)).toBe('[00:05:50]')
    expect(formatTimecodeString(349.9999999)).toBe('[00:05:50]')
    expect(formatTimecodeString(59.999)).toBe('[00:01:00]')
    expect(formatTimecodeString(3599.999)).toBe('[01:00:00]')
  })

  it('round-trip is exact for fractional values that are at risk of carry', () => {
    // These are real-world float-drift values from project 273 mapping.
    const samples = [349.999, 349.9999, 350 - 1e-9, 60 - 1e-12, 3600 - 1e-12]
    for (const s of samples) {
      const formatted = formatTimecodeString(s)
      // After rounding, parse should give back the rounded value (not drift).
      const parsed = parseTimecodeString(formatted)
      // The formatted value rounds to the nearest centisecond.
      const expected = Math.round(s * 100) / 100
      expect(parsed).toBeCloseTo(expected, 2)
    }
  })
})

describe('remapPlacementTimesString', () => {
  const cuts = [{ start: 60, end: 80 }] // 20s cut

  it('un-shifts string [HH:MM:SS] timecodes via unshiftPostCutTime', () => {
    const placements = [
      { start: '[00:00:50]', end: '[00:00:55]', description: 'before cut' },
      { start: '[00:05:09]', end: '[00:05:15]', description: 'after cut' },
    ]
    const out = remapPlacementTimesString(placements, cuts)
    // Before cut: 50s post-cut → 50s original (unchanged).
    expect(out[0].start).toBe('[00:00:50]')
    expect(out[0].end).toBe('[00:00:55]')
    // After cut: 309s post-cut → 329s original (shift by 20s cut).
    expect(out[1].start).toBe('[00:05:29]')
    expect(out[1].end).toBe('[00:05:35]')
  })

  it('preserves non-time fields', () => {
    const placements = [{
      start: '[00:05:09]', end: '[00:05:15]',
      beat: 'Liability', category: 'broll', audio_anchor: 'x', description: 'y',
      style: { colors: 'green' },
    }]
    const out = remapPlacementTimesString(placements, cuts)
    expect(out[0]).toMatchObject({
      beat: 'Liability', category: 'broll', audio_anchor: 'x', description: 'y',
      style: { colors: 'green' },
    })
  })

  it('passes through entries with unparseable timecodes', () => {
    const placements = [
      { start: 'not a timecode', end: '[00:05:15]' },
      { start: '[00:05:09]', /* end missing */ },
    ]
    const out = remapPlacementTimesString(placements, cuts)
    expect(out[0].start).toBe('not a timecode')      // pass-through
    expect(out[0].end).toBe('[00:05:35]')             // un-shifted
    expect(out[1].start).toBe('[00:05:29]')           // un-shifted
    expect(out[1].end).toBeUndefined()                // pass-through
  })

  it('returns input unchanged when cuts list is empty', () => {
    const placements = [{ start: '[00:05:09]', end: '[00:05:15]' }]
    expect(remapPlacementTimesString(placements, [])).toEqual(placements)
  })

  it('handles non-array input gracefully', () => {
    expect(remapPlacementTimesString(null, cuts)).toBe(null)
    expect(remapPlacementTimesString(undefined, cuts)).toBe(undefined)
  })
})

describe('persistPlacementOutput — string-shape (per-chapter sub-run)', () => {
  const editorCuts = { cuts: [{ start: 60, end: 80 }], cutExclusions: [] }

  it('un-shifts {placements: [{start: "[HH:MM:SS]"}]} top-level shape', async () => {
    const stageOutput = JSON.stringify({
      total_placements: 1,
      placements: [
        { start: '[00:05:09]', end: '[00:05:15]', beat: 'X', description: 'foo' },
      ],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed.placements[0].start).toBe('[00:05:29]')
    expect(parsed.placements[0].end).toBe('[00:05:35]')
    expect(parsed.placements[0].beat).toBe('X')
    expect(parsed.total_placements).toBe(1)
  })

  it('un-shifts string-format placements inside {chapters: [{placements: [...]}]}', async () => {
    const stageOutput = JSON.stringify({
      chapters: [
        {
          chapter_number: 1,
          placements: [
            { start: '[00:05:09]', end: '[00:05:15]', description: 'a' },
          ],
        },
      ],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed.chapters[0].placements[0].start).toBe('[00:05:29]')
    expect(parsed.chapters[0].placements[0].end).toBe('[00:05:35]')
  })

  it('still supports {chapters:[{placements:[{start_seconds}]}]} numeric shape (back-compat)', async () => {
    const stageOutput = JSON.stringify({
      chapters: [
        {
          placements: [
            { start_seconds: 100, end_seconds: 110, description: 'numeric' },
          ],
        },
      ],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed.chapters[0].placements[0].start_seconds).toBe(120)
    expect(parsed.chapters[0].placements[0].end_seconds).toBe(130)
  })

  it('passes through markdown-fenced JSON', async () => {
    const stageOutput = '```json\n' + JSON.stringify({
      placements: [{ start: '[00:05:09]', end: '[00:05:15]' }],
    }) + '\n```'
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed.placements[0].start).toBe('[00:05:29]')
  })

  it('no-op when editorCuts has no cuts', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:05:09]', end: '[00:05:15]' }],
    })
    const out = await persistPlacementOutput(stageOutput, null)
    expect(JSON.parse(out)).toEqual(JSON.parse(stageOutput))
  })
})
