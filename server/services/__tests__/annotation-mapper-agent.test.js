import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { run: null, version: null, stageOutputs: [], strategy: null }

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get() {
          if (/SELECT er\.\*, e\.strategy_version_id/.test(sql)) return state.run
          if (/SELECT \* FROM strategy_versions/.test(sql)) return state.version
          if (/SELECT s\.name FROM strategies/.test(sql)) return state.strategy
          if (/SELECT editor_state_json/.test(sql)) return null
          return null
        },
        async all() { return state.stageOutputs },
        async run() { return { changes: 0 } },
      }
    },
  },
}))

beforeEach(() => {
  state.run = { id: 99, strategy_version_id: 50, experiment_name: 'Auto: auto_v2' }
  state.version = { id: 50, stages_json: JSON.stringify([
    { name: 'Agent', type: 'agent', model: 'claude-opus-4-7' },
  ]) }
  state.strategy = { name: 'auto_v2' }
  state.stageOutputs = []
})

describe('buildAnnotationsFromRun — agent stages', () => {
  it('emits deletion annotations carrying category, confidence, evidence', async () => {
    state.stageOutputs = [{
      stage_index: 0,
      stage_name: 'Agent',
      llm_response_raw: JSON.stringify([
        { id: 'cut_1', start: 3.0, end: 3.4, category: 'filler_word',
          reason: '"Um" with adjacent silence', confidence: 0.9,
          evidence: ['text: "Um,"', 'silence: 0.6s before'] },
        { id: 'cut_2', start: 7.0, end: 19.6, category: 'meta_commentary',
          reason: 'keyboard-clacking interruption cluster', confidence: 0.95,
          evidence: ['audio_event: [keyboard clacking]'] },
      ]),
      output_text: '',
    }]
    const wordTs = [
      { word: 'Hello', start: 0, end: 1 },
      { word: 'Um,', start: 3, end: 3.4 },
      { word: 'gotta', start: 7, end: 7.5 },
      { word: 'Okay.', start: 19, end: 19.6 },
    ]
    const transcript = '[00:00:00] Hello\n[00:00:03] Um,\n[00:00:07] gotta\n[00:00:19] Okay.'
    const { buildAnnotationsFromRun } = await import('../annotation-mapper.js')
    const ann = await buildAnnotationsFromRun(99, wordTs, transcript)

    expect(ann.flowName).toBe('auto_v2')
    expect(ann.items.length).toBe(2)
    const i1 = ann.items[0]
    expect(i1.type).toBe('deletion')
    expect(i1.category).toBe('filler_word')
    expect(i1.confidence).toBe(0.9)
    expect(i1.evidence).toEqual(['text: "Um,"', 'silence: 0.6s before'])
    expect(i1.reason).toBe('"Um" with adjacent silence')
    expect(i1.startTime).toBe(3)
    expect(i1.endTime).toBe(3.4)

    const i2 = ann.items[1]
    expect(i2.category).toBe('meta_commentary')
    expect(i2.evidence[0]).toContain('keyboard clacking')
  })

  it('skips agent stages with empty cuts list', async () => {
    state.stageOutputs = [{
      stage_index: 0, stage_name: 'Agent',
      llm_response_raw: '[]', output_text: '',
    }]
    const { buildAnnotationsFromRun } = await import('../annotation-mapper.js')
    const ann = await buildAnnotationsFromRun(99, [], '')
    expect(ann.items).toEqual([])
  })
})
