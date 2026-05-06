import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock db.js so test runs without DATABASE_URL.
// dbState lets each test control what the audio-variant lookup vs default
// lookup returns. Both lookups use SELECT ... LIMIT 1, so we discriminate
// by the WHERE clause's reference to bundle_key.
const dbState = {
  audioVariant: null,
  defaultStrat: null,
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get() {
          if (/bundle_key = 'audio_only'/.test(sql)) return dbState.audioVariant
          return dbState.defaultStrat
        },
        async all() { return [] },
        async run() { return {} },
      }
    },
  },
}))

import { __test__pickStrategyByKind as pickStrategyByKind } from '../broll.js'

describe('pickStrategyByKind', () => {
  beforeEach(() => {
    dbState.audioVariant = null
    dbState.defaultStrat = null
  })

  it('returns audio variant when mediaType=audio and variant exists', async () => {
    dbState.audioVariant = { id: 12, name: 'Plan Prep (Audio-Only)', strategy_kind: 'plan_prep', bundle_key: 'audio_only' }
    dbState.defaultStrat = { id: 7, name: 'Plan Prep', strategy_kind: 'plan_prep', bundle_key: null }
    const r = await pickStrategyByKind('plan_prep', 'audio')
    expect(r.id).toBe(12)
    expect(r.bundle_key).toBe('audio_only')
  })

  it('falls back to default when audio variant missing', async () => {
    dbState.audioVariant = null
    dbState.defaultStrat = { id: 7, name: 'Plan Prep', strategy_kind: 'plan_prep', bundle_key: null }
    const r = await pickStrategyByKind('plan_prep', 'audio')
    expect(r.id).toBe(7)
  })

  it('returns default when mediaType=video regardless of variant existence', async () => {
    dbState.audioVariant = { id: 12, name: 'Plan Prep (Audio-Only)' }
    dbState.defaultStrat = { id: 7, name: 'Plan Prep' }
    const r = await pickStrategyByKind('plan_prep', 'video')
    expect(r.id).toBe(7)
  })

  it('returns default when mediaType is null/undefined', async () => {
    dbState.audioVariant = { id: 12, name: 'Plan Prep (Audio-Only)' }
    dbState.defaultStrat = { id: 7, name: 'Plan Prep' }
    expect((await pickStrategyByKind('plan_prep', null)).id).toBe(7)
    expect((await pickStrategyByKind('plan_prep', undefined)).id).toBe(7)
  })

  it('returns null when nothing exists for the kind', async () => {
    dbState.audioVariant = null
    dbState.defaultStrat = null
    expect(await pickStrategyByKind('plan_prep', 'audio')).toBeNull()
    expect(await pickStrategyByKind('plan_prep', 'video')).toBeNull()
  })
})
