import { describe, it, expect, vi } from 'vitest'

// broll.js → llm-runner.js does a top-level `await db.prepare(...).run()` for
// startup cleanup. Mock prepare to return a chainable stmt that resolves to a
// {changes:0} object; that's enough for module load.
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ changes: 0 }),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

import { parsePriorStage } from '../broll.js'

describe('parsePriorStage', () => {
  it('returns parsed JSON when input is well-formed', () => {
    expect(parsePriorStage('{"a": 1}', 0)).toEqual({ a: 1 })
  })

  it('returns parsed JSON via lenient extraction (trailing comma)', () => {
    expect(parsePriorStage('{"a": 1,}', 2)).toEqual({ a: 1 })
  })

  it('throws an error tagged with upstreamStageIndex when unparseable', () => {
    let caught = null
    try { parsePriorStage('not json at all', 3) }
    catch (e) { caught = e }
    expect(caught).not.toBeNull()
    expect(caught.upstreamStageIndex).toBe(3)
    expect(caught.message).toMatch(/stage 3/)
  })

  it('does not tag when stageIndex is null (caller has no upstream to invalidate)', () => {
    let caught = null
    try { parsePriorStage('not json', null) }
    catch (e) { caught = e }
    expect(caught).not.toBeNull()
    expect(caught.upstreamStageIndex).toBeUndefined()
  })

  it('handles null/empty input by throwing tagged error', () => {
    let caught = null
    try { parsePriorStage('', 1) }
    catch (e) { caught = e }
    expect(caught).not.toBeNull()
    expect(caught.upstreamStageIndex).toBe(1)
  })
})
