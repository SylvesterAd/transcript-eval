import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { runRow: null, version: null, video: null, raw: null, human: null, group: null, stageInserts: [], runUpdates: [] }

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get() {
          if (/SELECT er\.\*, e\.strategy_version_id/.test(sql)) return state.runRow
          if (/SELECT \* FROM strategy_versions WHERE id/.test(sql)) return state.version
          if (/SELECT \* FROM videos/.test(sql)) return state.video
          if (/raw/.test(sql) && /transcripts/.test(sql)) return state.raw
          if (/human_edited/.test(sql) && /transcripts/.test(sql)) return state.human
          if (/SELECT assembled_transcript/.test(sql)) return state.group
          return null
        },
        async all() { return [] },
        async run(...args) {
          if (/INSERT INTO run_stage_outputs/.test(sql)) {
            state.stageInserts.push({ sql, args })
            return { lastInsertRowid: state.stageInserts.length }
          }
          if (/UPDATE experiment_runs/.test(sql)) {
            state.runUpdates.push({ sql, args })
            return { changes: 1 }
          }
          if (/UPDATE experiment_runs SET stages_snapshot_json/.test(sql)) return { changes: 1 }
          return { changes: 0 }
        },
      }
    },
  },
}))

vi.mock('../rough-cut-agent/index.js', () => ({
  runAgent: vi.fn().mockResolvedValue({
    cuts: [{ id: 'cut_1', start: 3, end: 3.4, category: 'filler_word',
             reason: 'um', confidence: 0.9, evidence: ['"Um,"'] }],
    uncertain: [],
    stopReason: 'finish',
    totalTokens: { in: 1000, out: 200 },
    toolCalls: 5,
  }),
}))

beforeEach(() => {
  state.runRow = { id: 99, experiment_id: 1, strategy_version_id: 50, vid: 100, video_id: 100 }
  state.version = { id: 50, stages_json: JSON.stringify([
    { name: 'Agent', type: 'agent', model: 'claude-opus-4-7' },
  ]) }
  state.video = { id: 100, group_id: 7 }
  state.raw = { content: '[00:00:00] hello\n[00:00:03] um' }
  state.human = null
  state.group = { assembled_transcript: '[00:00:00] hello\n[00:00:03] um', assembly_status: 'done' }
  state.stageInserts.length = 0
  state.runUpdates.length = 0
})

describe('llm-runner — agent stage type', () => {
  it('dispatches type=agent stage to runAgent and stores the cuts as JSON in llm_response_raw', async () => {
    const { executeRun } = await import('../llm-runner.js')
    await executeRun(99)
    expect(state.stageInserts.length).toBe(1)
    const inserted = state.stageInserts[0].args
    // Shape: [runId, stageIndex, stageName, input, output, prompt, system, model, params,
    //        tokensIn, tokensOut, cost, runtime, llmResponseRaw]
    const llmResponseRaw = inserted[13]
    expect(llmResponseRaw).toBeDefined()
    const parsed = JSON.parse(llmResponseRaw)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].category).toBe('filler_word')
    expect(parsed[0].confidence).toBe(0.9)
    // Model column reflects the agent model
    expect(inserted[7]).toBe('claude-opus-4-7')
  })
})
