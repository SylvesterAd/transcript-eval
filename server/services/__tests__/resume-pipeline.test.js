import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const state = {
  brollRuns: [],
  latestVersion: null,
  videoGroup: null,
  groupEditorState: null,
  deletedRunIds: [],
  executePipelineCalls: [],
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async all(...args) {
          if (/SELECT \* FROM broll_runs[\s\S]*WHERE metadata_json LIKE \? AND status = 'complete'/.test(sql)) {
            return state.brollRuns
          }
          return []
        },
        async get(...args) {
          if (/SELECT \* FROM broll_strategy_versions WHERE strategy_id = \?/.test(sql)) return state.latestVersion
          if (/SELECT group_id FROM videos WHERE id = \?/.test(sql)) return state.videoGroup
          if (/SELECT editor_state_json FROM video_groups WHERE id = \?/.test(sql)) return state.groupEditorState
          return null
        },
        async run(...args) {
          if (/DELETE FROM broll_runs WHERE id = \?/.test(sql)) {
            state.deletedRunIds.push(args[0])
            return {}
          }
          return { changes: 0 }
        },
      }
    },
  },
}))

// resumePipeline calls executePipeline via the exported __pipelineRunner
// holder. Swapping the holder's executePipeline is the simplest way to
// stub it — vitest's partial vi.mock of an ESM module doesn't intercept
// in-module call sites (the local function reference bypasses the mock).
import { resumePipeline, __pipelineRunner } from '../broll.js'

const realExecutePipeline = __pipelineRunner.executePipeline

beforeEach(() => {
  state.brollRuns = []
  state.latestVersion = null
  state.videoGroup = null
  state.groupEditorState = null
  state.deletedRunIds = []
  state.executePipelineCalls = []
  __pipelineRunner.executePipeline = (...args) => {
    state.executePipelineCalls.push(args)
    return Promise.resolve({ pipelineId: 'fake' })
  }
})

afterEach(() => {
  __pipelineRunner.executePipeline = realExecutePipeline
})

describe('resumePipeline', () => {
  it('rejects alt-* pipeline IDs', async () => {
    await expect(resumePipeline('alt-abc-123')).rejects.toThrow(/Alt plan/)
  })

  it('rejects kw-* pipeline IDs', async () => {
    await expect(resumePipeline('kw-abc-123')).rejects.toThrow(/Keywords/)
  })

  it('rejects bs-* pipeline IDs', async () => {
    await expect(resumePipeline('bs-abc-123')).rejects.toThrow(/B-Roll search/)
  })

  it('throws when no completed stages exist for the pipeline', async () => {
    state.brollRuns = []
    await expect(resumePipeline('5-100-1700000000')).rejects.toThrow(/No completed stages/)
  })

  it('reconstructs completedStages from broll_runs and calls executePipeline', async () => {
    state.brollRuns = [
      { id: 1, strategy_id: 5, video_id: 100, output_text: 'OUT_A',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, stageName: 'StageA', videoLabel: '', groupId: 7 }) },
      { id: 2, strategy_id: 5, video_id: 100, output_text: 'OUT_B',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, stageName: 'StageB', videoLabel: '', groupId: 7 }) },
    ]
    state.latestVersion = { id: 50, stages_json: JSON.stringify([{ name: 'StageA' }, { name: 'StageB' }]) }
    state.groupEditorState = null

    await resumePipeline('p1')

    expect(state.executePipelineCalls).toHaveLength(1)
    const [strategyId, versionId, videoId, groupId, transcriptSource, editorCuts, refRun, opts] = state.executePipelineCalls[0]
    expect(strategyId).toBe(5)
    expect(versionId).toBe(50)
    expect(videoId).toBe(100)
    expect(groupId).toBe(7)
    expect(opts.completedStages).toEqual({ 0: 'OUT_A', 1: 'OUT_B' })
    expect(opts.originalPipelineId).toBe('p1')
  })

  it('returns { pipelineId, completedStages, executePromise } with the count', async () => {
    state.brollRuns = [
      { id: 1, strategy_id: 5, video_id: 100, output_text: 'OUT_A',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, stageName: 'StageA', videoLabel: '', groupId: 7 }) },
      { id: 2, strategy_id: 5, video_id: 100, output_text: 'OUT_B',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, stageName: 'StageB', videoLabel: '', groupId: 7 }) },
    ]
    state.latestVersion = { id: 50, stages_json: JSON.stringify([{ name: 'StageA' }, { name: 'StageB' }]) }

    const result = await resumePipeline('p1')
    expect(result.pipelineId).toBe('p1')
    expect(result.completedStages).toBe(2)
    expect(result.executePromise).toBeInstanceOf(Promise)
    await result.executePromise // drain so vitest doesn't warn
  })

  it('parses exampleVideoId from pipelineId -ex<N> suffix and forwards it', async () => {
    state.brollRuns = [
      { id: 1, strategy_id: 5, video_id: 100, output_text: 'OUT_A',
        metadata_json: JSON.stringify({ pipelineId: '5-100-1700000000-ex400', stageIndex: 0, stageName: 'StageA', videoLabel: '', groupId: 7 }) },
    ]
    state.latestVersion = { id: 50, stages_json: JSON.stringify([{ name: 'StageA' }]) }

    await resumePipeline('5-100-1700000000-ex400')

    const [, , , , , , , opts] = state.executePipelineCalls[0]
    expect(opts.exampleVideoId).toBe(400)
  })

  it('passes exampleVideoId=null when pipelineId has no -ex suffix', async () => {
    state.brollRuns = [
      { id: 1, strategy_id: 5, video_id: 100, output_text: 'OUT_A',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, stageName: 'StageA', videoLabel: '', groupId: 7 }) },
    ]
    state.latestVersion = { id: 50, stages_json: JSON.stringify([{ name: 'StageA' }]) }

    await resumePipeline('p1')

    const [, , , , , , , opts] = state.executePipelineCalls[0]
    expect(opts.exampleVideoId == null).toBe(true)
  })

  it('with fromStage drops completed stages from that index onwards and deletes their rows', async () => {
    state.brollRuns = [
      { id: 1, strategy_id: 5, video_id: 100, output_text: 'OUT_A',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, stageName: 'StageA', videoLabel: '', groupId: 7 }) },
      { id: 2, strategy_id: 5, video_id: 100, output_text: 'OUT_B',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, stageName: 'StageB', videoLabel: '', groupId: 7 }) },
      { id: 3, strategy_id: 5, video_id: 100, output_text: 'OUT_C',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 2, stageName: 'StageC', videoLabel: '', groupId: 7 }) },
    ]
    state.latestVersion = { id: 50, stages_json: JSON.stringify([{ name: 'StageA' }, { name: 'StageB' }, { name: 'StageC' }]) }

    await resumePipeline('p1', { fromStage: 1 })

    const [, , , , , , , opts] = state.executePipelineCalls[0]
    expect(opts.completedStages).toEqual({ 0: 'OUT_A' })
    expect(state.deletedRunIds).toEqual(expect.arrayContaining([2, 3]))
    expect(state.deletedRunIds).not.toContain(1)
  })

  it('reconstructs completedSubRuns from sub-run rows', async () => {
    state.brollRuns = [
      { id: 1, strategy_id: 5, video_id: 100, output_text: 'MAIN_A',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 0, stageName: 'StageA', videoLabel: '', groupId: 7 }) },
      { id: 10, strategy_id: 5, video_id: 100, output_text: 'SUB_0',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, stageName: 'StageB', videoLabel: '', groupId: 7, isSubRun: true, subIndex: 0 }) },
      { id: 11, strategy_id: 5, video_id: 100, output_text: 'SUB_2',
        metadata_json: JSON.stringify({ pipelineId: 'p1', stageIndex: 1, stageName: 'StageB', videoLabel: '', groupId: 7, isSubRun: true, subIndex: 2 }) },
    ]
    state.latestVersion = { id: 50, stages_json: JSON.stringify([{ name: 'StageA' }, { name: 'StageB' }]) }

    await resumePipeline('p1')

    const [, , , , , , , opts] = state.executePipelineCalls[0]
    expect(opts.completedSubRuns[1]).toEqual(new Set([0, 2]))
  })
})
