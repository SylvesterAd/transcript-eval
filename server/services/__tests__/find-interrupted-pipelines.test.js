import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  videoIdsForGroup: [],         // SELECT id FROM videos WHERE group_id = ?
  refSourceRows: [],            // joined broll_example_sources rows for refs lookup
  brollRunRows: [],             // SELECT id, metadata_json, status FROM broll_runs WHERE video_id IN (...)
  refSourcesQueried: false,     // tracks whether the refs SQL fired (for test 7)
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          return null
        },
        async all(...args) {
          if (/SELECT id FROM videos WHERE group_id = \?/.test(sql)) return state.videoIdsForGroup
          if (/FROM broll_example_sources/.test(sql)) {
            state.refSourcesQueried = true
            return state.refSourceRows
          }
          if (/FROM broll_runs/.test(sql) && /video_id IN/.test(sql)) return state.brollRunRows
          throw new Error(`unexpected all: ${sql}`)
        },
        async run(...args) {
          return { changes: 0 }
        },
      }
    },
  },
}))

const { findInterruptedPipelinesForGroup } = await import('../auto-orchestrator.js')

beforeEach(() => {
  state.videoIdsForGroup = []
  state.refSourceRows = []
  state.brollRunRows = []
  state.refSourcesQueried = false
})

describe('findInterruptedPipelinesForGroup', () => {
  it('returns empty when group has no broll_runs', async () => {
    state.videoIdsForGroup = [{ id: 100 }]
    state.brollRunRows = []
    const result = await findInterruptedPipelinesForGroup(7, 'plan')
    expect(result).toEqual([])
  })

  it('returns empty when all expected stages completed', async () => {
    state.videoIdsForGroup = [{ id: 100 }]
    state.brollRunRows = [
      { id: 1, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, totalStages: 2 }) },
      { id: 2, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, totalStages: 2 }) },
    ]
    const result = await findInterruptedPipelinesForGroup(7, 'plan')
    expect(result).toEqual([])
  })

  it('returns pipelineId when expectedStages > completed count', async () => {
    state.videoIdsForGroup = [{ id: 100 }]
    state.brollRunRows = [
      { id: 1, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, totalStages: 5 }) },
      { id: 2, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, totalStages: 5 }) },
    ]
    const result = await findInterruptedPipelinesForGroup(7, 'plan')
    expect(result).toEqual(['p1'])
  })

  it('ignores sub-run rows when counting completed main stages', async () => {
    state.videoIdsForGroup = [{ id: 100 }]
    state.brollRunRows = [
      { id: 1, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, totalStages: 3 }) },
      { id: 2, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, totalStages: 3, isSubRun: true, subIndex: 0 }) },
      { id: 3, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, totalStages: 3, isSubRun: true, subIndex: 1 }) },
    ]
    const result = await findInterruptedPipelinesForGroup(7, 'plan')
    expect(result).toEqual(['p1']) // 1 main stage complete out of 3 expected
  })

  it('excludes alt-/kw-/bs- pipelineIds (those have their own resume paths)', async () => {
    state.videoIdsForGroup = [{ id: 100 }]
    state.brollRunRows = [
      { id: 1, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'alt-p1-100-123', stageIndex: 0, totalStages: 2 }) },
      { id: 2, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'kw-p1-123', stageIndex: 0, totalStages: 2 }) },
      { id: 3, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'bs-p1-123', stageIndex: 0, totalStages: 2 }) },
      { id: 4, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, totalStages: 3 }) },
    ]
    const result = await findInterruptedPipelinesForGroup(7, 'plan')
    expect(result).toEqual(['p1'])
  })

  it("includes reference videos when substage='refs'", async () => {
    state.videoIdsForGroup = [{ id: 100 }]
    // Reference videos live in broll_example_sources.meta_json.videoId
    state.refSourceRows = [
      { meta_json: JSON.stringify({ videoId: 388 }) },
      { meta_json: JSON.stringify({ videoId: 400 }) },
    ]
    state.brollRunRows = [
      // Main video has no in-flight pipeline
      // Reference video 388 has interrupted analysis pipeline
      { id: 10, status: 'complete', metadata_json: JSON.stringify({ pipelineId: 'analysis-388', stageIndex: 0, totalStages: 4 }) },
    ]
    const result = await findInterruptedPipelinesForGroup(7, 'refs')
    expect(result).toEqual(['analysis-388'])
  })

  it("does not query reference videos when substage is not 'refs'", async () => {
    state.videoIdsForGroup = [{ id: 100 }]
    state.refSourceRows = [{ meta_json: JSON.stringify({ videoId: 388 }) }]
    state.brollRunRows = []
    await findInterruptedPipelinesForGroup(7, 'plan')
    // Verify the refs SQL never fired
    expect(state.refSourcesQueried).toBe(false)
  })
})
