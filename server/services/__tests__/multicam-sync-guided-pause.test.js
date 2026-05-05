// Verifies that multicam-sync only triggers chainAfterRoughCut when rough cut
// reaches a TERMINAL state (already_exists, kickoff failure, or thrown error).
// For the "ok && !already_exists" case (pipeline running async), it just sets
// rough_cut_status='running' and bails — rough-cut-runner.js fires
// chainAfterRoughCut from its IIFE when the actual cut completes.

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

const chainAfterRoughCutMock = vi.fn().mockResolvedValue(undefined)
const runFullAutoBrollChainMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../auto-orchestrator.js', () => ({
  chainAfterRoughCut: chainAfterRoughCutMock,
  runFullAutoBrollChain: runFullAutoBrollChainMock,
}))

const runAiRoughCutMock = vi.fn()
vi.mock('../rough-cut-runner.js', () => ({
  runAiRoughCut: runAiRoughCutMock,
}))

import { updateStatus } from '../multicam-sync.js'

describe('multicam-sync rough-cut completion handoff', () => {
  beforeEach(() => {
    dbState.rows.clear()
    dbState.updates.length = 0
    chainAfterRoughCutMock.mockClear()
    runFullAutoBrollChainMock.mockClear()
    runAiRoughCutMock.mockReset()
  })

  it('running (ok && !already_exists): sets rough_cut_status=running and does NOT call chainAfterRoughCut', async () => {
    runAiRoughCutMock.mockResolvedValue({ ok: true }) // pipeline kicked off, not done yet
    dbState.rows.set(42, { user_id: 1, auto_rough_cut: 1, path_id: 'guided' })

    await updateStatus(42, 'done')
    await new Promise(r => setImmediate(r))

    const runningUpdate = dbState.updates.find(u => u.sql.includes("rough_cut_status = 'running'"))
    expect(runningUpdate).toBeTruthy()
    // The whole point: do NOT pause prematurely. rough-cut-runner.js handles this
    // when the IIFE completes — multicam-sync just records 'running' and exits.
    expect(chainAfterRoughCutMock).not.toHaveBeenCalled()
  })

  it('already_exists (terminal): calls chainAfterRoughCut so guided pauses or auto chain fires', async () => {
    runAiRoughCutMock.mockResolvedValue({ ok: true, already_exists: true })
    dbState.rows.set(43, { user_id: 1, auto_rough_cut: 1, path_id: 'guided' })

    await updateStatus(43, 'done')
    await new Promise(r => setImmediate(r))

    const doneUpdate = dbState.updates.find(u => u.sql.includes("rough_cut_status = 'done'"))
    expect(doneUpdate).toBeTruthy()
    expect(chainAfterRoughCutMock).toHaveBeenCalledWith(43)
  })

  it('kickoff failure (!ok && !already_exists): marks failed and calls chainAfterRoughCut', async () => {
    runAiRoughCutMock.mockResolvedValue({ ok: false, error: 'kickoff broke' })
    dbState.rows.set(44, { user_id: 1, auto_rough_cut: 1, path_id: 'strategy-only' })

    await updateStatus(44, 'done')
    await new Promise(r => setImmediate(r))

    const failedUpdate = dbState.updates.find(u => u.sql.includes("rough_cut_status = 'failed'"))
    expect(failedUpdate).toBeTruthy()
    expect(chainAfterRoughCutMock).toHaveBeenCalledWith(44)
  })

  it('insufficient_tokens: marks insufficient and does NOT call chainAfterRoughCut', async () => {
    runAiRoughCutMock.mockResolvedValue({ error: 'insufficient_tokens', required: 1000 })
    dbState.rows.set(45, { user_id: 1, auto_rough_cut: 1, path_id: 'guided' })

    await updateStatus(45, 'done')
    await new Promise(r => setImmediate(r))

    const insufficientUpdate = dbState.updates.find(u =>
      u.sql.includes("rough_cut_status = 'insufficient_tokens'")
    )
    expect(insufficientUpdate).toBeTruthy()
    expect(chainAfterRoughCutMock).not.toHaveBeenCalled()
  })

  it('thrown rejection: marks failed and calls chainAfterRoughCut', async () => {
    runAiRoughCutMock.mockRejectedValue(new Error('rough cut blew up'))
    dbState.rows.set(46, { user_id: 1, auto_rough_cut: 1, path_id: 'guided' })

    await updateStatus(46, 'done')
    await new Promise(r => setImmediate(r))

    const failedUpdate = dbState.updates.find(u => u.sql.includes("rough_cut_status = 'failed'"))
    expect(failedUpdate).toBeTruthy()
    expect(chainAfterRoughCutMock).toHaveBeenCalledWith(46)
  })
})
