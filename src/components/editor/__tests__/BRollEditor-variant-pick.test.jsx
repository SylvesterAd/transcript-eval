import { describe, it, expect } from 'vitest'
import { pickHandsOffVariant } from '../BRollEditor.jsx'

describe('pickHandsOffVariant', () => {
  it('returns empty array unchanged', () => {
    expect(pickHandsOffVariant([])).toEqual([])
  })

  it('picks the variant whose refSource.is_favorite is true', () => {
    const all = [
      { pipelineId: 'plan-c', isCombined: true, refSource: null },
      { pipelineId: 'plan-b', isCombined: false, refSource: { is_favorite: false } },
      { pipelineId: 'plan-a', isCombined: false, refSource: { is_favorite: true } },
    ]
    const picked = pickHandsOffVariant(all)
    expect(picked).toHaveLength(1)
    expect(picked[0].pipelineId).toBe('plan-a')
  })

  it('falls back to first non-combined when no favorite found', () => {
    const all = [
      { pipelineId: 'plan-c', isCombined: true, refSource: null },
      { pipelineId: 'plan-b', isCombined: false, refSource: { is_favorite: false } },
      { pipelineId: 'plan-a', isCombined: false, refSource: { is_favorite: false } },
    ]
    const picked = pickHandsOffVariant(all)
    expect(picked).toHaveLength(1)
    expect(picked[0].pipelineId).toBe('plan-b')
  })

  it('falls back to first entry when only combined plans exist', () => {
    const all = [
      { pipelineId: 'plan-c', isCombined: true, refSource: null },
    ]
    const picked = pickHandsOffVariant(all)
    expect(picked).toHaveLength(1)
    expect(picked[0].pipelineId).toBe('plan-c')
  })

  it('does not consider refSource.is_favorite on combined variants (defensive)', () => {
    // Combined variants should never have a refSource, but if a malformed
    // input somehow has one with is_favorite=true, prefer the per-reference
    // variant instead.
    const all = [
      { pipelineId: 'plan-combined', isCombined: true, refSource: { is_favorite: true } },
      { pipelineId: 'plan-fav', isCombined: false, refSource: { is_favorite: true } },
    ]
    const picked = pickHandsOffVariant(all)
    expect(picked[0].pipelineId).toBe('plan-fav')
  })
})
