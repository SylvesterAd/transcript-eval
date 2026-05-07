import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrepare } = vi.hoisted(() => ({
  mockPrepare: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    get: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue([]),
  })),
}))
vi.mock('../../db.js', () => ({ default: { prepare: (...a) => mockPrepare(...a) } }))

import { persistPlacementOutput } from '../broll.js'

const fakeWords = [
  { word: 'There', start: 19.94, end: 20.10 },
  { word: 'is',    start: 20.10, end: 20.18 },
  { word: 'a',     start: 20.18, end: 20.21 },
  { word: 'bad',   start: 20.21, end: 20.50 },
  { word: 'piece', start: 20.50, end: 20.78 },
]

beforeEach(() => {
  mockPrepare.mockReset()
  mockPrepare.mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({ word_timestamps_json: JSON.stringify(fakeWords) }),
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    all: vi.fn().mockResolvedValue([]),
  }))
})

// LLM now emits ORIGINAL-time placements; persist shifts to the post-cut
// domain so storage stays canonical for the editor.
describe('persistPlacementOutput (original→post-cut shift)', () => {
  // Cut [10,15] removes 5s. So original 19.94 → post-cut 14.94.
  const editorCuts = { cuts: [{ start: 10, end: 15 }], cutExclusions: [] }

  it('shifts placement start/end by the cumulative cut offset', async () => {
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:19.94]', end: '[00:00:23.94]',
        start_seconds: 19.94, end_seconds: 23.94,
        audio_anchor: 'There is a bad piece',
      }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const p = JSON.parse(out).placements[0]
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.end_seconds).toBeCloseTo(18.94, 2)
    expect(p.start).toBe('[00:00:14.94]')
    expect(p.end).toBe('[00:00:18.94]')
  })

  it('still attaches anchor_word_idx (anchor lookup unaffected by shift)', async () => {
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:19.94]', end: '[00:00:23.94]',
        start_seconds: 19.94, end_seconds: 23.94,
        audio_anchor: 'There is a bad piece',
      }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    expect(JSON.parse(out).placements[0].anchor_word_idx).toBe(0)
  })

  it('passes times through unchanged when there are no cuts', async () => {
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:19.94]', end: '[00:00:23.94]',
        start_seconds: 19.94, end_seconds: 23.94,
        audio_anchor: 'There is a bad piece',
      }],
    })
    const out = await persistPlacementOutput(stageOutput, { cuts: [], cutExclusions: [] }, 449)
    const p = JSON.parse(out).placements[0]
    expect(p.start_seconds).toBeCloseTo(19.94, 2)
    expect(p.end_seconds).toBeCloseTo(23.94, 2)
    expect(p.start).toBe('[00:00:19.94]')
  })

  it('handles {chapters: [{placements:[…]}]} shape', async () => {
    const stageOutput = JSON.stringify({
      chapters: [{
        chapter_number: 1,
        placements: [{
          start: '[00:00:19.94]', end: '[00:00:23.94]',
          start_seconds: 19.94, end_seconds: 23.94,
          audio_anchor: 'There is a bad piece',
        }],
      }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const p = JSON.parse(out).chapters[0].placements[0]
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.anchor_word_idx).toBe(0)
  })

  it('handles top-level array of placements', async () => {
    const stageOutput = JSON.stringify([{
      start: '[00:00:19.94]', end: '[00:00:23.94]',
      start_seconds: 19.94, end_seconds: 23.94,
      audio_anchor: 'There is a bad piece',
    }])
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const p = JSON.parse(out)[0]
    expect(p.start_seconds).toBeCloseTo(14.94, 2)
    expect(p.anchor_word_idx).toBe(0)
  })

  it('passes through unchanged when videoId omitted', async () => {
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:19.94]', end: '[00:00:23.94]',
        start_seconds: 19.94, end_seconds: 23.94,
        audio_anchor: 'There is a bad piece',
      }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    expect(out).toBe(stageOutput)
  })

  it('shifts a placement that straddles a cut boundary by independently shifting each endpoint', async () => {
    // Cut [15, 17] removes 2s. Placement runs from original 12 to 20:
    //   start=12 has 0 preceding cut → post-cut start = 12
    //   end=20 has the full cut [15,17] preceding it → post-cut end = 20 - 2 = 18
    // Result: placement spans [12, 18] in post-cut, collapsing across the cut as if it weren't there.
    const cuts = { cuts: [{ start: 15, end: 17 }], cutExclusions: [] }
    const stageOutput = JSON.stringify({
      placements: [{
        start: '[00:00:12]', end: '[00:00:20]',
        start_seconds: 12, end_seconds: 20,
        audio_anchor: 'There is a bad piece',
      }],
    })
    const out = await persistPlacementOutput(stageOutput, cuts, 449)
    const p = JSON.parse(out).placements[0]
    expect(p.start_seconds).toBeCloseTo(12, 2)
    expect(p.end_seconds).toBeCloseTo(18, 2)
  })
})
