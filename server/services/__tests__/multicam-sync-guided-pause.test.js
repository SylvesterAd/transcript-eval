// Verifies that for path_id='guided', after rough cut completes, multicam-sync
// sets broll_chain_status='paused_at_rough_cut' and does NOT fire the b-roll chain.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbState = { rows: new Map(), updates: [] }

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        get: (id) => {
          if (sql.includes('SELECT user_id, auto_rough_cut, path_id')) {
            return dbState.rows.get(id) || null
          }
          return null
        },
        run: (...args) => {
          dbState.updates.push({ sql, args })
          return { changes: 1 }
        },
        all: () => [],
      }
    },
  },
}))

const runFullAutoBrollChainMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../auto-orchestrator.js', () => ({
  runFullAutoBrollChain: runFullAutoBrollChainMock,
}))

const runAiRoughCutMock = vi.fn().mockResolvedValue({ ok: true })
vi.mock('../rough-cut-runner.js', () => ({
  runAiRoughCut: runAiRoughCutMock,
}))

import { updateStatus } from '../multicam-sync.js'

describe('multicam-sync post-rough-cut pause', () => {
  beforeEach(() => {
    dbState.rows.clear()
    dbState.updates.length = 0
    runFullAutoBrollChainMock.mockClear()
    runAiRoughCutMock.mockClear()
  })

  it('guided: sets paused_at_rough_cut and does NOT fire b-roll chain', async () => {
    dbState.rows.set(42, { user_id: 1, auto_rough_cut: 1, path_id: 'guided' })

    await updateStatus(42, 'done')
    await new Promise(r => setImmediate(r))

    const pausedUpdate = dbState.updates.find(u =>
      u.sql.includes("broll_chain_status = 'paused_at_rough_cut'")
    )
    expect(pausedUpdate).toBeTruthy()
    expect(runFullAutoBrollChainMock).not.toHaveBeenCalled()
  })

  it('strategy-only: still fires b-roll chain after rough cut', async () => {
    dbState.rows.set(43, { user_id: 1, auto_rough_cut: 1, path_id: 'strategy-only' })

    await updateStatus(43, 'done')
    await new Promise(r => setImmediate(r))

    expect(runFullAutoBrollChainMock).toHaveBeenCalledWith(43)
    const pausedUpdate = dbState.updates.find(u =>
      u.sql.includes("broll_chain_status = 'paused_at_rough_cut'")
    )
    expect(pausedUpdate).toBeFalsy()
  })

  it('hands-off: still fires b-roll chain after rough cut', async () => {
    dbState.rows.set(44, { user_id: 1, auto_rough_cut: 1, path_id: 'hands-off' })

    await updateStatus(44, 'done')
    await new Promise(r => setImmediate(r))

    expect(runFullAutoBrollChainMock).toHaveBeenCalledWith(44)
  })
})
