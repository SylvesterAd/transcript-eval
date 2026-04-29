// Tests for runAiRoughCut.
//
// Strategy: mock db.js at the module boundary, mirroring exports.test.js.
// Covers three branches: insufficient balance, existing annotations,
// happy path (deduction + experiment + run created, IDs returned).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  group: null,
  videos: [],
  videoWithTranscript: null,
  strategy: null,
  version: null,
  balance: 10000,
  insertedExperimentId: null,
  insertedRunId: null,
  poolBeginCalls: 0,
  poolCommitCalls: 0,
  poolRollbackCalls: 0,
  insufficient: false,
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT .* FROM video_groups WHERE id/.test(sql)) return state.group
          if (/SELECT .* FROM strategies WHERE is_main/.test(sql)) return state.strategy
          if (/SELECT .* FROM strategy_versions/.test(sql)) return state.version
          if (/SELECT v\.\* FROM videos v/.test(sql)) return state.videoWithTranscript
          throw new Error(`unexpected .get SQL: ${sql}`)
        },
        async all(...args) {
          if (/SELECT duration_seconds FROM videos/.test(sql)) return state.videos
          throw new Error(`unexpected .all SQL: ${sql}`)
        },
        async run(...args) {
          if (/UPDATE experiment_runs SET status = 'failed'/.test(sql)) return { changes: 0 }
          if (/INSERT INTO experiments/.test(sql)) {
            state.insertedExperimentId = 42
            return { lastInsertRowid: 42 }
          }
          if (/INSERT INTO experiment_runs/.test(sql)) {
            state.insertedRunId = 7
            return { lastInsertRowid: 7 }
          }
          if (/UPDATE video_groups SET annotations_json/.test(sql)) return { changes: 1 }
          if (/UPDATE video_groups SET rough_cut_status/.test(sql)) return { changes: 1 }
          throw new Error(`unexpected .run SQL: ${sql}`)
        },
      }
    },
    pool: {
      async connect() {
        return {
          async query(sql, args) {
            if (/^BEGIN/i.test(sql)) { state.poolBeginCalls++; return {} }
            if (/^COMMIT/i.test(sql)) { state.poolCommitCalls++; return {} }
            if (/^ROLLBACK/i.test(sql)) { state.poolRollbackCalls++; return {} }
            if (/INSERT INTO user_tokens/i.test(sql)) return { rows: [] }
            if (/SELECT balance FROM user_tokens/i.test(sql)) return { rows: [{ balance: state.balance }] }
            if (/UPDATE user_tokens SET balance/i.test(sql)) return { rows: [] }
            if (/INSERT INTO token_transactions/i.test(sql)) return { rows: [] }
            throw new Error(`unexpected pool query: ${sql}`)
          },
          release() {},
        }
      },
    },
  },
}))

vi.mock('../llm-runner.js', () => ({ executeRun: vi.fn().mockResolvedValue() }))
vi.mock('../annotation-mapper.js', () => ({
  buildAnnotationsFromRun: vi.fn().mockResolvedValue({ items: [] }),
  getTimelineWordTimestamps: vi.fn().mockResolvedValue([{ word: 'hi', start: 0, end: 1 }]),
}))

import { runAiRoughCut } from '../rough-cut-runner.js'

beforeEach(() => {
  state.group = { id: 1, user_id: 'u1', annotations_json: null, assembled_transcript: 'hello' }
  state.videos = [{ duration_seconds: 60 }]
  state.videoWithTranscript = { id: 100, group_id: 1, video_type: 'raw' }
  state.strategy = { id: 5, name: 'Main', is_main: 1 }
  state.version = { id: 50, strategy_id: 5, stages_json: '[{"name":"S1","type":"llm"}]' }
  state.balance = 10000
  state.insertedExperimentId = null
  state.insertedRunId = null
  state.poolBeginCalls = 0
  state.poolCommitCalls = 0
  state.poolRollbackCalls = 0
})

describe('runAiRoughCut', () => {
  it('returns insufficient_tokens when balance below cost', async () => {
    state.balance = 1
    const r = await runAiRoughCut({ groupId: 1, userId: 'u1' })
    expect(r.error).toBe('insufficient_tokens')
    expect(r.required).toBeGreaterThan(state.balance)
    expect(state.poolRollbackCalls).toBe(1)
    expect(state.poolCommitCalls).toBe(0)
  })

  it('returns already_exists when group has annotations', async () => {
    state.group.annotations_json = JSON.stringify({ items: [{ id: 'a' }] })
    const r = await runAiRoughCut({ groupId: 1, userId: 'u1' })
    expect(r.already_exists).toBe(true)
    expect(state.poolCommitCalls).toBe(1)
  })

  it('creates experiment + run and returns IDs on happy path', async () => {
    const r = await runAiRoughCut({ groupId: 1, userId: 'u1' })
    expect(r.error).toBeUndefined()
    expect(r.experimentId).toBe(42)
    expect(r.runId).toBe(7)
    expect(r.totalStages).toBe(1)
    expect(r.balanceAfter).toBe(state.balance - r.tokensDeducted)
    expect(state.poolCommitCalls).toBe(1)
  })

  it('returns 404-equivalent when group missing', async () => {
    state.group = null
    const r = await runAiRoughCut({ groupId: 999, userId: 'u1' })
    expect(r.error).toBe('not_found')
  })
})
