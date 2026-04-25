import { describe, it, expect, vi } from 'vitest'

const userPlacementRow = {
  state_json: JSON.stringify({
    edits: {},
    userPlacements: [{
      id: 'u_test',
      sourcePipelineId: 'src-pipe',
      sourceChapterIndex: 0,
      sourcePlacementIndex: 0,
      timelineStart: 5,
      timelineEnd: 7,
      selectedResult: 0,
      results: [{ id: 'r1', thumbnail_url: 'x' }],
      snapshot: { description: 'test', audio_anchor: 'a', function: 'f', type_group: 'g', source_feel: 'h', style: {} },
    }],
  }),
  version: 1,
}

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      all: async () => [],
      get: async () => {
        if (typeof sql === 'string' && sql.includes('broll_editor_state')) return userPlacementRow
        return null
      },
      run: async () => ({ lastInsertRowid: 0 }),
    }),
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

import { getBRollEditorData } from '../broll.js'

describe('getBRollEditorData userPlacement shape', () => {
  it('sets chapterIndex/placementIndex to null even when source ids exist', async () => {
    const data = await getBRollEditorData('pipe-target')
    const up = data.placements.find(p => p.userPlacementId === 'u_test')
    expect(up).toBeTruthy()
    expect(up.chapterIndex).toBe(null)
    expect(up.placementIndex).toBe(null)
    expect(up.sourceChapterIndex).toBe(0)
    expect(up.sourcePlacementIndex).toBe(0)
  })
})
