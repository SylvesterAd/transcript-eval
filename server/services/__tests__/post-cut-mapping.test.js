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

import { unshiftPostCutTime, remapPlacementTimes } from '../broll.js'
import { computeEffectiveCuts } from '../broll.js'
import { persistPlacementOutput } from '../broll.js'

// Reference shifter — algebraic forward direction. Same logic as
// generatePostCutTranscript's getOffset, simplified for tests.
function shift(t, effectiveCuts) {
  let cumOffset = 0
  for (const c of effectiveCuts) {
    if (t >= c.end) cumOffset += c.end - c.start
    else if (t >= c.start) {
      // t lands inside cut — undefined for a "kept" point. Treat as cut.start in post-cut.
      return c.start - cumOffset
    } else {
      break
    }
  }
  return t - cumOffset
}

function randCuts(rng, max = 50, totalDuration = 600) {
  const n = Math.floor(rng() * 30)
  const cuts = []
  let pos = 0
  for (let i = 0; i < n; i++) {
    const gap = rng() * 30
    const dur = rng() * 5 + 0.1
    const start = pos + gap
    const end = start + dur
    if (end > totalDuration) break
    cuts.push({ id: `c${i}`, start, end, source: 'transcript' })
    pos = end
  }
  return cuts
}

function mulberry32(seed) {
  return function() {
    seed = (seed + 0x6D2B79F5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('unshiftPostCutTime — round-trip identity', () => {
  it('round-trips kept points across 1000 random cut configurations', () => {
    const rng = mulberry32(42)
    let cases = 0
    for (let trial = 0; trial < 1000; trial++) {
      const rawCuts = randCuts(rng, 50, 600)
      const effective = computeEffectiveCuts(rawCuts, [])

      // Generate kept sample points: midpoints of gaps between cuts.
      const samples = []
      let prevEnd = 0
      for (const c of effective) {
        if (c.start > prevEnd + 0.5) samples.push((prevEnd + c.start) / 2)
        prevEnd = c.end
      }
      if (prevEnd < 599.5) samples.push((prevEnd + 600) / 2)

      for (const tOriginal of samples) {
        const tPost = shift(tOriginal, effective)
        const roundtrip = unshiftPostCutTime(tPost, effective, 'start')
        expect(Math.abs(roundtrip - tOriginal)).toBeLessThan(1e-9)
        cases++
      }
    }
    expect(cases).toBeGreaterThan(500) // sanity: we did meaningful work
  })

  it('round-trips with no cuts (identity)', () => {
    expect(unshiftPostCutTime(0, [], 'start')).toBe(0)
    expect(unshiftPostCutTime(42.5, [], 'end')).toBe(42.5)
    expect(unshiftPostCutTime(600, [], 'start')).toBe(600)
  })

  it('handles single cut at start', () => {
    const cuts = [{ start: 0, end: 10 }]
    // Post-cut t=0 corresponds to original t=10 (right after the cut).
    expect(unshiftPostCutTime(0, cuts, 'start')).toBe(10)
    expect(unshiftPostCutTime(5, cuts, 'start')).toBe(15)
  })

  it('handles many adjacent cuts (drift bound)', () => {
    const cuts = []
    for (let i = 0; i < 200; i++) {
      cuts.push({ start: i * 2, end: i * 2 + 0.5 })
    }
    // Total cut duration: 200 * 0.5 = 100s.
    // unshift(299) should give back 399.
    expect(unshiftPostCutTime(299, cuts, 'start')).toBeCloseTo(399, 9)
  })
})

describe('unshiftPostCutTime — boundary rules', () => {
  const cuts = [{ start: 60, end: 80 }]
  // Post-cut boundary for this cut = 60 - 0 = 60.

  it("kind='start' at boundary jumps past cut → cut.end", () => {
    expect(unshiftPostCutTime(60, cuts, 'start')).toBe(80)
  })

  it("kind='end' at boundary stays before cut → cut.start", () => {
    expect(unshiftPostCutTime(60, cuts, 'end')).toBe(60)
  })

  it("kind='start' just past boundary maps continuously", () => {
    expect(unshiftPostCutTime(60.001, cuts, 'start')).toBeCloseTo(80.001, 9)
  })

  it("kind='end' just before boundary maps continuously", () => {
    expect(unshiftPostCutTime(59.999, cuts, 'end')).toBeCloseTo(59.999, 9)
  })

  it('multiple cuts: boundary rule applies per-cut', () => {
    const multi = [
      { start: 10, end: 15 }, // post-cut boundary 10
      { start: 30, end: 40 }, // post-cut boundary 30 - 5 = 25
    ]
    expect(unshiftPostCutTime(10, multi, 'start')).toBe(15)
    expect(unshiftPostCutTime(10, multi, 'end')).toBe(10)
    expect(unshiftPostCutTime(25, multi, 'start')).toBe(40)
    expect(unshiftPostCutTime(25, multi, 'end')).toBe(30)
  })
})

describe('remapPlacementTimes', () => {
  const cuts = [{ start: 60, end: 80 }]

  it('un-shifts start_seconds (start kind) and end_seconds (end kind)', () => {
    const placements = [
      { start_seconds: 10, end_seconds: 50, type: 'broll', description: 'x' },
      { start_seconds: 100, end_seconds: 150, type: 'broll', description: 'y' },
    ]
    const out = remapPlacementTimes(placements, cuts)
    expect(out[0].start_seconds).toBe(10)
    expect(out[0].end_seconds).toBe(50)
    expect(out[1].start_seconds).toBe(120) // 100 post-cut → 120 original (after [60,80] cut)
    expect(out[1].end_seconds).toBe(170)
  })

  it('handles boundary timecode at start/end with asymmetric rule', () => {
    const placements = [{ start_seconds: 60, end_seconds: 60, type: 'broll' }]
    const out = remapPlacementTimes(placements, cuts)
    expect(out[0].start_seconds).toBe(80) // start kind → past cut
    expect(out[0].end_seconds).toBe(60)   // end kind → before cut
  })

  it('returns input unchanged when cuts list is empty', () => {
    const placements = [{ start_seconds: 10, end_seconds: 50 }]
    expect(remapPlacementTimes(placements, [])).toEqual(placements)
  })

  it('preserves all non-time fields (description, type, etc.)', () => {
    const placements = [{
      start_seconds: 10, end_seconds: 50,
      type: 'broll', description: 'mountain', visual_description: 'snowy',
      function: 'Inform', extra_field: 42,
    }]
    const out = remapPlacementTimes(placements, cuts)
    expect(out[0]).toMatchObject({
      type: 'broll',
      description: 'mountain',
      visual_description: 'snowy',
      function: 'Inform',
      extra_field: 42,
    })
  })

  it('handles non-array input gracefully', () => {
    expect(remapPlacementTimes(null, cuts)).toBe(null)
    expect(remapPlacementTimes(undefined, cuts)).toBe(undefined)
  })

  it('skips entries that are missing start_seconds/end_seconds', () => {
    const placements = [
      { start_seconds: 10, end_seconds: 50 },
      { description: 'no times here' },
      { start_seconds: 100 }, // partial
    ]
    const out = remapPlacementTimes(placements, cuts)
    expect(out[0].start_seconds).toBe(10)
    expect(out[1]).toEqual({ description: 'no times here' })
    expect(out[2].start_seconds).toBe(120)
    expect(out[2].end_seconds).toBeUndefined()
  })
})

describe('persistPlacementOutput — chokepoint', () => {
  const editorCuts = { cuts: [{ start: 60, end: 80 }], cutExclusions: [] }

  it('returns input unchanged when editorCuts has no cuts', async () => {
    const out = await persistPlacementOutput(JSON.stringify([{ start_seconds: 10 }]), null)
    expect(JSON.parse(out)).toEqual([{ start_seconds: 10 }])
    const out2 = await persistPlacementOutput(JSON.stringify([{ start_seconds: 10 }]), { cuts: [] })
    expect(JSON.parse(out2)).toEqual([{ start_seconds: 10 }])
  })

  it('un-shifts placement timecodes when editorCuts has cuts', async () => {
    const stageOutput = JSON.stringify([
      { start_seconds: 100, end_seconds: 110, type: 'broll' },
    ])
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed[0].start_seconds).toBe(120) // 100 + 20 cut duration
    expect(parsed[0].end_seconds).toBe(130)
  })

  it('handles JSON wrapped in markdown fence', async () => {
    const stageOutput = '```json\n[{"start_seconds":100,"end_seconds":110}]\n```'
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed[0].start_seconds).toBe(120)
  })

  it('un-shifts placements nested under {chapters: [...].placements} structure', async () => {
    const stageOutput = JSON.stringify({
      chapters: [
        { chapter_number: 1, placements: [{ start_seconds: 100, end_seconds: 110 }] },
      ],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed.chapters[0].placements[0].start_seconds).toBe(120)
  })

  it('returns raw output unchanged when JSON is unparseable (logs warning)', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stageOutput = 'totally not json'
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    expect(out).toBe(stageOutput)
    consoleWarn.mockRestore()
  })
})
