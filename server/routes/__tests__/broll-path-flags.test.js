// server/routes/__tests__/broll-path-flags.test.js
//
// Unit tests for pathToFlags in server/routes/broll.js.
//
// Like videos-groups.test.js, importing the route module triggers the
// transitive `../db.js` import whose top-level side effects include
// process.exit(1) on missing DATABASE_URL. We stub db with a no-op
// prepared-statement factory so the module loads cleanly for unit test.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    prepare() {
      return {
        async all() { return [] },
        async get() { return null },
        async run() { return { lastInsertRowid: 0 } },
      }
    },
  },
}))

import { pathToFlags } from '../broll.js'

describe('pathToFlags', () => {
  it('hands-off: no stops, auto-select variants', () => {
    expect(pathToFlags('hands-off')).toEqual({
      stopAfterStrategy: false,
      stopAfterPlan: false,
      autoSelectVariants: true,
    })
  })

  it('strategy-only: stop after strategy only', () => {
    expect(pathToFlags('strategy-only')).toEqual({
      stopAfterStrategy: true,
      stopAfterPlan: false,
      autoSelectVariants: false,
    })
  })

  it('guided: stop after strategy AND plan', () => {
    expect(pathToFlags('guided')).toEqual({
      stopAfterStrategy: true,
      stopAfterPlan: true,
      autoSelectVariants: false,
    })
  })

  it('null / unknown: defaults to strategy-only behavior', () => {
    expect(pathToFlags(null)).toEqual({
      stopAfterStrategy: true,
      stopAfterPlan: false,
      autoSelectVariants: false,
    })
    expect(pathToFlags('unknown-value')).toEqual({
      stopAfterStrategy: true,
      stopAfterPlan: false,
      autoSelectVariants: false,
    })
  })
})
