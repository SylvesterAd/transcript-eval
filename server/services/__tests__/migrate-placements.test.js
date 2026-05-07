import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// Mock db.js to avoid the process.exit(1) on missing DATABASE_URL.
// migrateGroupState is pure — doesn't use DB — but its module dependency
// chain pulls in broll.js → db.js which insists on a connection at load.
vi.mock('../../db.js', () => ({
  default: {
    prepare: () => ({
      get: async () => null,
      all: async () => [],
      run: async () => ({ changes: 0 }),
    }),
  },
}))

import { migrateGroupState } from '../../../scripts/_migrate-placements-to-postcut.mjs'

const fixture = JSON.parse(readFileSync(
  './server/services/__tests__/__fixtures__/project-273-cuts.json', 'utf8'))

describe('migrateGroupState', () => {
  it('marks state schema_version=post-cut after migration', () => {
    const state = {
      cuts: fixture.editor_state.cuts,
      cutExclusions: [],
      broll: {
        placements: [{
          uuid: 'p1', audio_anchor: 'There is a bad piece',
          start_seconds: 134.18,  // original
          end_seconds: 138.18,
        }],
      },
    }
    const migrated = migrateGroupState(state, fixture.word_timestamps)
    expect(migrated.broll.schema_version).toBe('post-cut')
  })

  it('converts original-time start/end_seconds to post-cut', () => {
    const state = {
      cuts: fixture.editor_state.cuts,
      cutExclusions: [],
      broll: {
        placements: [{
          uuid: 'p1', audio_anchor: 'There is a bad piece',
          start_seconds: 134.18,
          end_seconds: 138.18,
        }],
      },
    }
    const migrated = migrateGroupState(state, fixture.word_timestamps)
    // Project 273 has many cuts before t=134.18. Post-cut t should be smaller.
    expect(migrated.broll.placements[0].start_seconds).toBeLessThan(134.18)
    expect(migrated.broll.placements[0].end_seconds).toBeLessThan(138.18)
    // Duration preserved
    const dur = migrated.broll.placements[0].end_seconds - migrated.broll.placements[0].start_seconds
    expect(dur).toBeCloseTo(4, 1)
  })

  it('attaches anchor_word_idx >= 0 when audio_anchor matches a word', () => {
    const state = {
      cuts: fixture.editor_state.cuts,
      cutExclusions: [],
      broll: {
        placements: [{
          uuid: 'p1',
          audio_anchor: fixture.word_timestamps.slice(50, 53).map(w => w.word).join(' '),  // 3-word phrase from fixture
          start_seconds: 100,
          end_seconds: 103,
        }],
      },
    }
    const migrated = migrateGroupState(state, fixture.word_timestamps)
    expect(migrated.broll.placements[0].anchor_word_idx).toBeGreaterThanOrEqual(0)
  })

  it('is idempotent: re-running on already-migrated state is a no-op', () => {
    const state = {
      broll: {
        schema_version: 'post-cut',
        placements: [{ uuid: 'p1', start_seconds: 19.94, end_seconds: 23.94, anchor_word_idx: 0 }],
      },
    }
    const migrated = migrateGroupState(state, [])
    expect(migrated.broll.placements[0].start_seconds).toBe(19.94)
    expect(migrated.broll.placements[0].end_seconds).toBe(23.94)
    expect(migrated.broll.placements[0].anchor_word_idx).toBe(0)
  })

  it('is a no-op when broll.placements is empty or missing', () => {
    expect(migrateGroupState({}, []).broll).toBeUndefined()  // no broll key, returned as-is
    const stateNoP = { broll: {} }
    const migrated = migrateGroupState(stateNoP, [])
    expect(migrated.broll.schema_version).toBeUndefined()  // no marker added if no placements
  })

  it('is a no-op when broll.placements is an empty array', () => {
    const state = { broll: { placements: [] } }
    const migrated = migrateGroupState(state, [])
    // No marker added because no placements to migrate
    expect(migrated.broll.schema_version).toBeUndefined()
    expect(migrated.broll.placements).toEqual([])
  })

  it('handles placement with no audio_anchor (anchor_word_idx = -1)', () => {
    const state = {
      cuts: [],
      broll: {
        placements: [{
          uuid: 'p1',
          start_seconds: 10,
          end_seconds: 13,
          // no audio_anchor
        }],
      },
    }
    const migrated = migrateGroupState(state, fixture.word_timestamps)
    expect(migrated.broll.placements[0].anchor_word_idx).toBe(-1)
  })
})
