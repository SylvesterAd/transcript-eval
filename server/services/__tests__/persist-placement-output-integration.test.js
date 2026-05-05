import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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

describe('persistPlacementOutput — chokepoint coverage', () => {
  it('every placement-emitting action in broll.js routes through persistPlacementOutput', () => {
    const src = fs.readFileSync(
      path.resolve('server/services/broll.js'),
      'utf8'
    )
    // Coarse heuristic: find each `action === '<name>'` block that ultimately
    // assigns to `output` and verify that block contains `persistPlacementOutput`.
    //
    // Only executePipeline's assemble_broll_plan is the final cut-adjustment
    // boundary. The other pipeline functions (executeCreatePlan,
    // executeCreateCombinedStrategy, executeCreateStrategy, executeAltPlans)
    // also contain assemble_broll_plan handlers but those operate on intermediate
    // plan data without editorCuts — the un-shift happens in executePipeline.
    const PLACEMENT_ACTIONS = [
      'assemble_broll_plan',
    ]
    for (const action of PLACEMENT_ACTIONS) {
      // Target the executePipeline action chain specifically.
      // In executePipeline, programmatic actions use `action === '<name>'` (bare variable),
      // while other pipeline functions use `stage.action === '<name>'`.
      // We match the executePipeline form and assert persistPlacementOutput is present.
      const re = new RegExp(
        `\\} else if \\(action === '${action}'\\)[\\s\\S]*?(?=\\} else \\{[\\s\\S]{0,50}output = currentTranscript)`
      )
      const m = src.match(re)
      expect(m, `executePipeline's ${action} action block not found in broll.js`).toBeTruthy()
      expect(m[0]).toMatch(/persistPlacementOutput/)
    }
  })
})
