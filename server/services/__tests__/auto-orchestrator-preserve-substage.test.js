import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture all UPDATE statements issued against video_groups.
const updates = []

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      run: (...args) => { updates.push({ sql, args }); return { rowCount: 1 } },
      get: (..._args) => null,
      all: (..._args) => [],
    }),
  },
}))

describe('runFullAutoBrollChain failure UPDATE preserves substage', () => {
  beforeEach(() => { updates.length = 0 })

  it('does not include broll_chain_substage = NULL in the failure UPDATE', async () => {
    // We don't fully execute the chain — we just inspect the SQL statements that
    // would be issued. The two failure updates we care about are at
    // auto-orchestrator.js:584 and :660. Read both literal SQL strings here and
    // assert they no longer null out substage.
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      new URL('../auto-orchestrator.js', import.meta.url), 'utf-8',
    )

    // Find every "broll_chain_status = 'failed'" UPDATE in the file
    const failureUpdates = src.match(
      /UPDATE video_groups SET broll_chain_status = 'failed'[^"]*/g,
    ) || []

    expect(failureUpdates.length).toBeGreaterThan(0)
    for (const sql of failureUpdates) {
      expect(sql).not.toMatch(/broll_chain_substage\s*=\s*NULL/)
    }
  })
})
