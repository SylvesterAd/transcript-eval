import { describe, it, expect } from 'vitest'
import { slimChapterStrategy } from '../broll-prior-strategies.js'

describe('slimChapterStrategy', () => {
  it('returns empty string for null/undefined/non-string input', () => {
    expect(slimChapterStrategy(null)).toBe('')
    expect(slimChapterStrategy(undefined)).toBe('')
    expect(slimChapterStrategy('')).toBe('')
    expect(slimChapterStrategy(42)).toBe('')
  })

  it('keeps strategy + beat_strategies, drops bookkeeping fields', () => {
    const input = JSON.stringify({
      matched_reference_chapter: { chapter_name: 'X', match_reason: 'Y' },
      frequency_targets: { broll: { target_per_minute: 13 } },
      strategy: { commonalities: 'pacing X', broll: { sources: 'mixed' } },
      beat_strategies: [{ beat_name: 'Hook', strategy_points: ['close-up'] }],
    })
    const parsed = JSON.parse(slimChapterStrategy(input))
    expect(parsed.strategy).toEqual({ commonalities: 'pacing X', broll: { sources: 'mixed' } })
    expect(parsed.beat_strategies).toHaveLength(1)
    expect(parsed.beat_strategies[0].beat_name).toBe('Hook')
    expect(parsed.matched_reference_chapter).toBeUndefined()
    expect(parsed.frequency_targets).toBeUndefined()
  })

  it('handles missing strategy or beat_strategies fields with safe defaults', () => {
    const out = JSON.parse(slimChapterStrategy(JSON.stringify({ frequency_targets: {} })))
    expect(out.strategy).toBeNull()
    expect(out.beat_strategies).toEqual([])
  })

  it('parses JSON wrapped in markdown fence', () => {
    const input = '```json\n{"strategy":"X","beat_strategies":[]}\n```'
    const out = JSON.parse(slimChapterStrategy(input))
    expect(out.strategy).toBe('X')
  })

  it('parses JSON wrapped in extra prose (forgiving)', () => {
    const input = 'Here is the JSON: {"strategy":"X","beat_strategies":[]} thanks'
    const out = JSON.parse(slimChapterStrategy(input))
    expect(out.strategy).toBe('X')
  })

  it('falls back to truncated raw text on totally unparseable input', () => {
    const input = 'no json here just text ' + 'x'.repeat(3000)
    const out = slimChapterStrategy(input)
    expect(out.length).toBeLessThanOrEqual(2000)
    expect(out.startsWith('no json here')).toBe(true)
  })
})
