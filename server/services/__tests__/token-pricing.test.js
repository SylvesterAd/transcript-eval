import { describe, it, expect } from 'vitest'
import { estimateTokenCost, estimateProcessingTime } from '../token-pricing.js'

describe('estimateTokenCost', () => {
  it('returns 0 when total duration is 0 (signals "no videos uploaded yet")', () => {
    expect(estimateTokenCost(0)).toBe(0)
  })

  it('returns 0 when duration is null/undefined', () => {
    expect(estimateTokenCost(null)).toBe(0)
    expect(estimateTokenCost(undefined)).toBe(0)
  })

  it('returns 30 tokens for a 1-minute video', () => {
    expect(estimateTokenCost(60)).toBe(30)
  })

  it('returns 300 tokens for a 10-minute video', () => {
    expect(estimateTokenCost(600)).toBe(300)
  })

  it('rounds up to the next minute (ceiling)', () => {
    // 30 seconds → 0.5 min × 30 = 15 → ceil = 15
    expect(estimateTokenCost(30)).toBe(15)
    // 90 seconds → 1.5 min × 30 = 45 → ceil = 45
    expect(estimateTokenCost(90)).toBe(45)
    // 1 second → 1/60 min × 30 = 0.5 → ceil = 1
    expect(estimateTokenCost(1)).toBe(1)
  })

  it('does NOT floor at 1 — 0 means "preview not ready" (regression for the StepRoughCut polling loop)', () => {
    // The frontend StepRoughCut.jsx polls until tokenCost > 0. If we
    // return 1 for empty input, polling stops immediately and the UI
    // shows "~1 tokens" before any video is actually uploaded.
    expect(estimateTokenCost(0)).toBe(0)
    expect(estimateTokenCost(0)).not.toBe(1)
  })
})

describe('estimateProcessingTime', () => {
  it('returns 0 for 0 duration', () => {
    expect(estimateProcessingTime(0)).toBe(0)
  })

  it('returns ~22.5s for a 1-minute video (0.375x ratio)', () => {
    // 1 min × 0.375 × 60 = 22.5 → round = 23
    expect(estimateProcessingTime(60)).toBe(23)
  })
})
