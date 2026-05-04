import { describe, it, expect } from 'vitest'
import { sortPlanVariants } from '../BRollPanel.jsx'

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

  it('returns a new array and does not mutate the input', () => {
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
})
