import { describe, it, expect } from 'vitest'
import { sortPlanVariants, filterVariantsWithPlacements } from '../BRollPanel.jsx'

describe('sortPlanVariants', () => {
  it('puts per-reference plans before the combined plan', () => {
    const input = [
      { pipelineId: 'plan-combined', strategyPipelineId: 'cstrat-1', stratVariant: { isCombined: true } },
      { pipelineId: 'plan-non-fav',  strategyPipelineId: 'strat-2-ex400', stratVariant: { isCombined: false } },
      { pipelineId: 'plan-fav',      strategyPipelineId: 'strat-1-ex403', stratVariant: { isCombined: false } },
    ]
    const sorted = sortPlanVariants(input)
    expect(sorted.map(v => v.pipelineId)).toEqual(['plan-fav', 'plan-non-fav', 'plan-combined'])
  })

  it('orders per-reference plans alphabetically by strategyPipelineId', () => {
    const input = [
      { pipelineId: 'plan-z', strategyPipelineId: 'strat-z-ex999', stratVariant: { isCombined: false } },
      { pipelineId: 'plan-a', strategyPipelineId: 'strat-a-ex001', stratVariant: { isCombined: false } },
      { pipelineId: 'plan-m', strategyPipelineId: 'strat-m-ex500', stratVariant: { isCombined: false } },
    ]
    const sorted = sortPlanVariants(input)
    expect(sorted.map(v => v.pipelineId)).toEqual(['plan-a', 'plan-m', 'plan-z'])
  })

  it('treats variants without stratVariant as non-combined and keeps them after sorted ones', () => {
    const input = [
      { pipelineId: 'plan-orphan', strategyPipelineId: null, stratVariant: undefined },
      { pipelineId: 'plan-fav',    strategyPipelineId: 'strat-1-ex403', stratVariant: { isCombined: false } },
      { pipelineId: 'plan-combined', strategyPipelineId: 'cstrat-1', stratVariant: { isCombined: true } },
    ]
    const sorted = sortPlanVariants(input)
    expect(sorted[0].pipelineId).toBe('plan-fav')
    expect(sorted[sorted.length - 1].pipelineId).toBe('plan-combined')
    expect(sorted[1].pipelineId).toBe('plan-orphan')
  })

  it('returns a new array and does not reorder the input array', () => {
    const input = [
      { pipelineId: 'plan-combined', strategyPipelineId: 'cstrat-1', stratVariant: { isCombined: true } },
      { pipelineId: 'plan-fav',      strategyPipelineId: 'strat-1-ex403', stratVariant: { isCombined: false } },
    ]
    const original = [...input]
    sortPlanVariants(input)
    expect(input).toEqual(original)
  })

  it('returns empty array unchanged', () => {
    expect(sortPlanVariants([])).toEqual([])
  })

  it('preserves relative order of two non-combined variants both missing strategyPipelineId', () => {
    // Both nulls return 0 from the comparator → Array.sort is stable in modern JS,
    // so insertion order is preserved among the orphans.
    const input = [
      { pipelineId: 'plan-orphan-1', strategyPipelineId: null, stratVariant: undefined },
      { pipelineId: 'plan-orphan-2', strategyPipelineId: null, stratVariant: undefined },
      { pipelineId: 'plan-fav',      strategyPipelineId: 'strat-1-ex403', stratVariant: { isCombined: false } },
    ]
    const sorted = sortPlanVariants(input)
    expect(sorted.map(v => v.pipelineId)).toEqual(['plan-fav', 'plan-orphan-1', 'plan-orphan-2'])
  })

  it('treats empty-string strategyPipelineId the same as null (sorts to end of non-combined)', () => {
    // The `|| null` coercion in the comparator collapses '' and null to the same
    // bucket. Real data never produces '', but defensive: a future refactor could
    // emit '' from a JSON.parse fallback, and we don't want it leapfrogging real IDs.
    const input = [
      { pipelineId: 'plan-empty', strategyPipelineId: '', stratVariant: { isCombined: false } },
      { pipelineId: 'plan-fav',   strategyPipelineId: 'strat-1-ex403', stratVariant: { isCombined: false } },
    ]
    const sorted = sortPlanVariants(input)
    expect(sorted.map(v => v.pipelineId)).toEqual(['plan-fav', 'plan-empty'])
  })
})

describe('filterVariantsWithPlacements', () => {
  it('drops variants with zero placements', () => {
    const input = [
      { pipelineId: 'plan-a', totalPlacements: 41 },
      { pipelineId: 'plan-empty', totalPlacements: 0 },
      { pipelineId: 'plan-b', totalPlacements: 12 },
    ]
    const filtered = filterVariantsWithPlacements(input)
    expect(filtered.map(v => v.pipelineId)).toEqual(['plan-a', 'plan-b'])
  })

  it('keeps all variants when every variant has placements', () => {
    const input = [
      { pipelineId: 'plan-a', totalPlacements: 5 },
      { pipelineId: 'plan-b', totalPlacements: 1 },
    ]
    const filtered = filterVariantsWithPlacements(input)
    expect(filtered).toHaveLength(2)
  })

  it('treats missing or non-numeric totalPlacements as zero', () => {
    // Defensive: a partially-built variant from a parser hiccup shouldn't
    // surface a label-only tab with no content.
    const input = [
      { pipelineId: 'plan-undefined' },
      { pipelineId: 'plan-null', totalPlacements: null },
      { pipelineId: 'plan-string', totalPlacements: 'lots' },
      { pipelineId: 'plan-real', totalPlacements: 3 },
    ]
    const filtered = filterVariantsWithPlacements(input)
    expect(filtered.map(v => v.pipelineId)).toEqual(['plan-real'])
  })

  it('returns empty array unchanged', () => {
    expect(filterVariantsWithPlacements([])).toEqual([])
  })
})
