// Tests the auto-rough-cut hook inside multicam-sync.updateStatus.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { group: null, statusUpdates: [], runAiRoughCutCalls: [] }

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(id) {
          if (/SELECT user_id, auto_rough_cut FROM video_groups WHERE id/.test(sql)) {
            return state.group
          }
          throw new Error(`unexpected .get SQL: ${sql}`)
        },
        async run(...args) {
          if (/UPDATE video_groups SET assembly_status/.test(sql)) {
            state.statusUpdates.push(args)
            return { changes: 1 }
          }
          if (/UPDATE video_groups SET rough_cut_status/.test(sql)) {
            state.statusUpdates.push(['rough_cut_status', ...args])
            return { changes: 1 }
          }
          throw new Error(`unexpected .run SQL: ${sql}`)
        },
      }
    },
  },
}))

vi.mock('../rough-cut-runner.js', () => ({
  runAiRoughCut: vi.fn(async (args) => {
    state.runAiRoughCutCalls.push(args)
    return { ok: true, experimentId: 1, runId: 2 }
  }),
}))

import { updateStatus } from '../multicam-sync.js'

beforeEach(() => {
  state.group = null
  state.statusUpdates = []
  state.runAiRoughCutCalls = []
})

describe('updateStatus auto-rough-cut hook', () => {
  it('fires runAiRoughCut when status=done and auto_rough_cut=true', async () => {
    state.group = { user_id: 'u1', auto_rough_cut: true }
    await updateStatus(1, 'done')
    await new Promise(r => setImmediate(r))
    expect(state.runAiRoughCutCalls).toHaveLength(1)
    expect(state.runAiRoughCutCalls[0]).toMatchObject({ groupId: 1, userId: 'u1' })
  })

  it('does NOT fire when auto_rough_cut=false', async () => {
    state.group = { user_id: 'u1', auto_rough_cut: false }
    await updateStatus(1, 'done')
    await new Promise(r => setImmediate(r))
    expect(state.runAiRoughCutCalls).toHaveLength(0)
  })

  it('does NOT fire on non-terminal statuses', async () => {
    state.group = { user_id: 'u1', auto_rough_cut: true }
    await updateStatus(1, 'syncing')
    await new Promise(r => setImmediate(r))
    expect(state.runAiRoughCutCalls).toHaveLength(0)
  })

  it('does NOT fire when status is failed', async () => {
    state.group = { user_id: 'u1', auto_rough_cut: true }
    await updateStatus(1, 'failed', 'some error')
    await new Promise(r => setImmediate(r))
    expect(state.runAiRoughCutCalls).toHaveLength(0)
  })
})
