import { describe, it, expect, vi, beforeEach } from 'vitest'

// Captures every db.prepare(...).run(...) call so we can assert the DELETE
// fires for the tagged upstream stage.
const dbCalls = []

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      run: (...args) => { dbCalls.push({ kind: 'run', sql, args }); return { rowCount: 1 } },
      get: (...args) => { dbCalls.push({ kind: 'get', sql, args }); return null },
      all: (...args) => { dbCalls.push({ kind: 'all', sql, args }); return [] },
    }),
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

describe('executePipeline catch — upstreamStageIndex deletion', () => {
  beforeEach(() => { dbCalls.length = 0 })

  it('issues DELETE for upstream stage row when error has upstreamStageIndex', async () => {
    // Drive the catch block directly via the exported helper rather than
    // running the full pipeline. We add a small exported function in broll.js
    // that performs the catch's delete-on-tagged-error logic.
    const { handleUpstreamFailureCleanup } = await import('../broll.js')

    const err = new Error('Parse of stage 0 output failed: Unexpected token')
    err.upstreamStageIndex = 0

    await handleUpstreamFailureCleanup({
      pipelineId: '2-409-1777644060670-ex400',
      err,
    })

    const deletes = dbCalls.filter(c =>
      c.kind === 'run' && /DELETE FROM broll_runs/i.test(c.sql),
    )
    expect(deletes.length).toBe(1)
    expect(deletes[0].args).toEqual(['2-409-1777644060670-ex400', 0])
  })

  it('does not issue DELETE when error has no upstreamStageIndex', async () => {
    const { handleUpstreamFailureCleanup } = await import('../broll.js')

    await handleUpstreamFailureCleanup({
      pipelineId: '2-409-1777644060670-ex400',
      err: new Error('LLM API timeout'),
    })

    const deletes = dbCalls.filter(c =>
      c.kind === 'run' && /DELETE FROM broll_runs/i.test(c.sql),
    )
    expect(deletes.length).toBe(0)
  })
})
