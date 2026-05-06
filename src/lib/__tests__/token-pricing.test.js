import { describe, it, expect } from 'vitest'
import { estimateTokenCost, estimateProcessingTime } from '../token-pricing.js'

// These values must match server/services/token-pricing.js exactly. The
// frontend mirror exists so StepRoughCut can preview the cost from the
// client-probed duration without a server round-trip; the server file is
// still the source of truth for the actual deduction in rough-cut-runner.
// If a value here changes, update the server file in lockstep.
describe('estimateTokenCost', () => {
  it('returns 0 when duration is unknown', () => {
    expect(estimateTokenCost(null)).toBe(0)
    expect(estimateTokenCost(undefined)).toBe(0)
    expect(estimateTokenCost(0)).toBe(0)
  })

  it('charges 30 tokens per minute, ceiling', () => {
    expect(estimateTokenCost(60)).toBe(30)         // 1 min → 30
    expect(estimateTokenCost(120)).toBe(60)        // 2 min → 60
    expect(estimateTokenCost(90)).toBe(45)         // 1.5 min → 45
    expect(estimateTokenCost(61)).toBe(31)         // 1m1s → ceil(30.5) = 31
    expect(estimateTokenCost(1)).toBe(1)           // 1s → ceil(0.5) = 1
  })

  it('handles long videos', () => {
    expect(estimateTokenCost(3600)).toBe(1800)     // 1h → 1800
  })
})

describe('estimateProcessingTime', () => {
  it('returns 0 when duration is unknown', () => {
    expect(estimateProcessingTime(null)).toBe(0)
    expect(estimateProcessingTime(undefined)).toBe(0)
    expect(estimateProcessingTime(0)).toBe(0)
  })

  it('estimates 22.5s of processing per minute of video', () => {
    expect(estimateProcessingTime(60)).toBe(23)    // 1 min → round(22.5) = 23
    expect(estimateProcessingTime(120)).toBe(45)   // 2 min → 45
    expect(estimateProcessingTime(600)).toBe(225)  // 10 min → 225
  })
})
