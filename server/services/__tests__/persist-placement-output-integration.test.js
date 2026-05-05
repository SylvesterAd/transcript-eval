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

import { persistPlacementOutput } from '../broll.js'

describe('persistPlacementOutput — assemble_broll_plan output shape', () => {
  it('un-shifts placements inside {chapters:[{placements:[...]}]}', async () => {
    const editorCuts = {
      cuts: [{ id: 'c1', start: 60, end: 80 }],
      cutExclusions: [],
    }
    // Mimic what assemble_broll_plan produces.
    const rawOutput = JSON.stringify({
      video_context: 'context',
      total_chapters: 1,
      chapters: [
        {
          chapter_number: 1,
          chapter_name: 'Hook',
          placements: [
            { start_seconds: 100, end_seconds: 110, type: 'broll', description: 'x' },
            { start_seconds: 200, end_seconds: 210, type: 'broll', description: 'y' },
          ],
        },
      ],
    })
    const out = await persistPlacementOutput(rawOutput, editorCuts)
    const parsed = JSON.parse(out)
    expect(parsed.chapters[0].placements[0].start_seconds).toBe(120)
    expect(parsed.chapters[0].placements[0].end_seconds).toBe(130)
    expect(parsed.chapters[0].placements[1].start_seconds).toBe(220)
    expect(parsed.chapters[0].placements[1].end_seconds).toBe(230)
    // Non-placement fields preserved.
    expect(parsed.video_context).toBe('context')
    expect(parsed.chapters[0].chapter_name).toBe('Hook')
  })
})
