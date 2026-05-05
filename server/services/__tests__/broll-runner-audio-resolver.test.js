// Tests for resolvePlanStrategyId in broll-runner.js — runtime resolver that
// picks the audio-only plan strategy when the group contains any audio video,
// and falls back to the default plan_prep strategy otherwise.
//
// Mock pattern matches the rest of server/services/__tests__/: vi.mock the db
// module, route SQL by regex. This avoids writing to the live Supabase that
// db.js connects to in dev/prod.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbMockState = {
  audioVideoLookup: null,      // controls SELECT 1 FROM videos ... media_type='audio'
  audioStrategyLookup: null,   // controls SELECT id FROM broll_strategies WHERE bundle_key='audio_only' ...
  defaultStrategyLookup: null, // controls SELECT id FROM broll_strategies WHERE strategy_kind='plan_prep' ...
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(..._args) {
          if (/SELECT 1 FROM videos WHERE group_id = \? AND media_type = 'audio'/.test(sql)) {
            return dbMockState.audioVideoLookup
          }
          if (/bundle_key = 'audio_only'/.test(sql)) {
            return dbMockState.audioStrategyLookup
          }
          if (/strategy_kind = 'plan_prep'/.test(sql)) {
            return dbMockState.defaultStrategyLookup
          }
          throw new Error(`unexpected get SQL: ${sql}`)
        },
      }
    },
  },
}))

import { __test__resolvePlanStrategyId as resolvePlanStrategyId } from '../broll-runner.js'

describe('resolvePlanStrategyId', () => {
  beforeEach(() => {
    dbMockState.audioVideoLookup = null
    dbMockState.audioStrategyLookup = { id: 12 }
    dbMockState.defaultStrategyLookup = { id: 7 }
  })

  it('returns default plan strategy for video-only groups', async () => {
    dbMockState.audioVideoLookup = null // no audio in group

    const id = await resolvePlanStrategyId(99)
    expect(id).toBe(7)
  })

  it('returns audio-only plan strategy when group has audio media', async () => {
    dbMockState.audioVideoLookup = { '?column?': 1 } // SELECT 1 — audio detected

    const id = await resolvePlanStrategyId(99)
    expect(id).toBe(12)
  })

  it('falls back to default when audio detected but no audio_only strategy seeded', async () => {
    dbMockState.audioVideoLookup = { '?column?': 1 }
    dbMockState.audioStrategyLookup = null // no audio strategy seeded

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = await resolvePlanStrategyId(99)
    expect(id).toBe(7)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('audio_only'))
    consoleSpy.mockRestore()
  })

  it('returns hardcoded 7 when neither audio nor default strategy is found in db', async () => {
    dbMockState.audioVideoLookup = null
    dbMockState.defaultStrategyLookup = null // db returned nothing

    const id = await resolvePlanStrategyId(99)
    expect(id).toBe(7)
  })
})
