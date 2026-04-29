// server/routes/__tests__/videos-groups.test.js
//
// Unit tests for the validation logic in PUT /videos/groups/:id.
//
// Why the heavy mocking: `server/routes/videos.js` imports `../db.js`,
// which has top-level side effects — it reads DATABASE_URL and calls
// process.exit(1) if missing. videos.js itself also has top-level IIFEs
// that await `db.prepare(...).all(...)` (startup cleanup). To unit-test
// the pure validator we stub `../db.js` with a no-op prepared-statement
// factory; the IIFEs then resolve with empty arrays and log nothing.
//
// vi.mock is auto-hoisted by vitest (runs before imports resolve), so
// the mock takes effect for videos.js' transitive import of db.js.

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

// Also stub services videos.js imports — none of them run at import time
// in ways that break tests, but cloudflare-stream / storage / whisper all
// read env vars that are absent in CI. Those services gracefully no-op
// when misconfigured, so no mock is needed for them.

import { validateGroupUpdate } from '../videos.js'

describe('validateGroupUpdate', () => {
  it('accepts valid libraries', () => {
    const { error } = validateGroupUpdate({ libraries: ['envato', 'artlist'] })
    expect(error).toBeNull()
  })

  it('rejects unknown library', () => {
    const { error } = validateGroupUpdate({ libraries: ['envato', 'unknown'] })
    expect(error).toMatch(/libraries must be/)
  })

  it('rejects non-array libraries', () => {
    const { error } = validateGroupUpdate({ libraries: 'envato' })
    expect(error).toMatch(/libraries must be/)
  })

  it('accepts valid path_id', () => {
    const { error } = validateGroupUpdate({ path_id: 'hands-off' })
    expect(error).toBeNull()
  })

  it('rejects invalid path_id', () => {
    const { error } = validateGroupUpdate({ path_id: 'invalid-path' })
    expect(error).toMatch(/path_id must be/)
  })

  it('accepts boolean freepik_opt_in', () => {
    const { error } = validateGroupUpdate({ freepik_opt_in: true })
    expect(error).toBeNull()
  })

  it('rejects non-boolean freepik_opt_in', () => {
    const { error } = validateGroupUpdate({ freepik_opt_in: 'yes' })
    expect(error).toMatch(/freepik_opt_in must be boolean/)
  })

  it('accepts audience object', () => {
    const { error } = validateGroupUpdate({ audience: { age: ['gen_z'] } })
    expect(error).toBeNull()
  })

  it('rejects non-object audience', () => {
    const { error } = validateGroupUpdate({ audience: 'some string' })
    expect(error).toMatch(/audience must be/)
  })

  it('accepts boolean auto_rough_cut', () => {
    const { error } = validateGroupUpdate({ auto_rough_cut: true })
    expect(error).toBe(null)
  })

  it('rejects non-boolean auto_rough_cut', () => {
    const { error } = validateGroupUpdate({ auto_rough_cut: 'yes' })
    expect(error).toMatch(/auto_rough_cut/)
  })
})
