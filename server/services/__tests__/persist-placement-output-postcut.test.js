import { describe, it, expect, vi, beforeEach } from 'vitest'

// The default mockPrepare returns a stmt that responds with safe defaults
// (changes:0, no rows). beforeEach replaces it with a transcript-aware
// version per test. Hoisted so vi.mock can reference it before module init.
const { mockPrepare } = vi.hoisted(() => ({
  mockPrepare: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    get: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue([]),
  })),
}))
vi.mock('../../db.js', () => ({
  default: { prepare: (...a) => mockPrepare(...a) },
}))

import { persistPlacementOutput } from '../broll.js'

const fakeWords = [
  { word: 'There', start: 19.94, end: 20.10 },
  { word: 'is', start: 20.10, end: 20.18 },
  { word: 'a', start: 20.18, end: 20.21 },
  { word: 'bad', start: 20.21, end: 20.50 },
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

describe('persistPlacementOutput (post-cut canonical)', () => {
  const editorCuts = { cuts: [{ start: 10, end: 15 }], cutExclusions: [] }

  it('keeps placement times unchanged (no un-shift)', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const parsed = JSON.parse(out)
    expect(parsed.placements[0].start).toBe('[00:00:19.94]')
    expect(parsed.placements[0].end).toBe('[00:00:23.94]')
  })

  it('attaches anchor_word_idx based on audio_anchor', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const parsed = JSON.parse(out)
    expect(parsed.placements[0].anchor_word_idx).toBe(0)
  })

  it('sets anchor_word_idx = -1 when audio_anchor not in transcript', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'never says this exact phrase ever' }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    expect(JSON.parse(out).placements[0].anchor_word_idx).toBe(-1)
  })

  it('passes through unchanged when videoId omitted (cant fetch words)', async () => {
    const stageOutput = JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts)
    expect(out).toBe(stageOutput)
  })

  it('handles {chapters: [{placements: [...]}]} shape', async () => {
    const stageOutput = JSON.stringify({
      chapters: [{ chapter_number: 1, placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' }] }],
    })
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const parsed = JSON.parse(out)
    expect(parsed.chapters[0].placements[0].anchor_word_idx).toBe(0)
    expect(parsed.chapters[0].placements[0].start).toBe('[00:00:19.94]')
  })

  it('handles top-level array of placements', async () => {
    const stageOutput = JSON.stringify([
      { start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' },
    ])
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const parsed = JSON.parse(out)
    expect(parsed[0].anchor_word_idx).toBe(0)
    expect(parsed[0].start).toBe('[00:00:19.94]')
  })

  it('passes through markdown-fenced JSON', async () => {
    const stageOutput = '```json\n' + JSON.stringify({
      placements: [{ start: '[00:00:19.94]', end: '[00:00:23.94]', audio_anchor: 'There is a bad piece' }],
    }) + '\n```'
    const out = await persistPlacementOutput(stageOutput, editorCuts, 449)
    const parsed = JSON.parse(out)
    expect(parsed.placements[0].anchor_word_idx).toBe(0)
  })
})
