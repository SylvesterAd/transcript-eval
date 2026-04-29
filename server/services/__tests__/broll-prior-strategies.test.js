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

import { vi, beforeEach } from 'vitest'
import { loadPriorChapterStrategies } from '../broll-prior-strategies.js'

vi.mock('../../db.js', () => ({
  default: { prepare: vi.fn() },
}))
import db from '../../db.js'

describe('loadPriorChapterStrategies', () => {
  beforeEach(() => { db.prepare.mockReset() })

  it('returns empty string when priors array is empty/undefined/null', async () => {
    expect(await loadPriorChapterStrategies([], 0)).toBe('')
    expect(await loadPriorChapterStrategies(undefined, 0)).toBe('')
    expect(await loadPriorChapterStrategies(null, 0)).toBe('')
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('throws when sub-run is missing for a prior pipeline + chapter', async () => {
    db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) })
    await expect(loadPriorChapterStrategies(['pid-x'], 2))
      .rejects.toThrow('missing sub-run: pid=pid-x chapter=2')
  })

  it('formats single prior with directive header + reference title', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          strategy: { commonalities: 'X' },
          beat_strategies: [{ beat_name: 'Hook' }],
        }),
        video_id: 5,
        title: 'My Reference Video',
      }),
    })
    const out = await loadPriorChapterStrategies(['pid-1'], 0)
    expect(out).toContain('## Prior strategies for this chapter (do NOT produce a similar strategy):')
    expect(out).toContain('=== Source: Reference: My Reference Video ===')
    expect(out).toContain('"beat_name": "Hook"')
    expect(out).toContain('"commonalities": "X"')
  })

  it('uses pid as fallback label when video has no title', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: '{"strategy":null,"beat_strategies":[]}',
        video_id: 5,
        title: null,
      }),
    })
    const out = await loadPriorChapterStrategies(['pid-fallback'], 0)
    expect(out).toContain('=== Source: pid-fallback ===')
  })

  it('two priors → two blocks in pipeline-id order separated by blank line', async () => {
    let callCount = 0
    db.prepare.mockReturnValue({
      get: vi.fn(() => {
        callCount++
        return {
          output_text: JSON.stringify({ strategy: `s${callCount}`, beat_strategies: [] }),
          video_id: callCount,
          title: `Ref ${callCount}`,
        }
      }),
    })
    const out = await loadPriorChapterStrategies(['p1', 'p2'], 0)
    expect(out.indexOf('Ref 1')).toBeLessThan(out.indexOf('Ref 2'))
    const blocks = out.split('=== Source:')
    expect(blocks).toHaveLength(3) // header + 2 source blocks
  })
})

import { assertNoSelfReference, assertPriorsComplete } from '../broll-prior-strategies.js'

describe('assertNoSelfReference', () => {
  it('returns nothing when pipelineId is not in priors', () => {
    expect(() => assertNoSelfReference('pid-current', ['pid-favorite', 'pid-other'])).not.toThrow()
  })

  it('returns nothing when priors is empty/undefined', () => {
    expect(() => assertNoSelfReference('pid-current', [])).not.toThrow()
    expect(() => assertNoSelfReference('pid-current', undefined)).not.toThrow()
  })

  it('throws when pipelineId appears in priors', () => {
    expect(() => assertNoSelfReference('pid-x', ['pid-favorite', 'pid-x']))
      .toThrow('self-reference: pid-x cannot have itself as prior')
  })
})

describe('assertPriorsComplete', () => {
  beforeEach(() => { db.prepare.mockReset() })

  it('returns nothing when priors is empty/undefined', async () => {
    await expect(assertPriorsComplete([])).resolves.toBeUndefined()
    await expect(assertPriorsComplete(undefined)).resolves.toBeUndefined()
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('returns nothing when every prior has a complete row in broll_runs', async () => {
    db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue({ '1': 1 }) })
    await expect(assertPriorsComplete(['pid-a', 'pid-b'])).resolves.toBeUndefined()
  })

  it('throws when any prior has zero complete rows', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn()
        .mockReturnValueOnce({ '1': 1 })
        .mockReturnValueOnce(undefined),
    })
    await expect(assertPriorsComplete(['pid-a', 'pid-missing']))
      .rejects.toThrow('prior pipeline not complete: pid-missing')
  })
})
