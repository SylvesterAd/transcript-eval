import { describe, it, expect, vi, beforeEach } from 'vitest'
import { slimChapterStrategy, loadPriorChapterStrategies, assertNoSelfReference, assertPriorsComplete } from '../broll-prior-strategies.js'

vi.mock('../../db.js', () => ({
  default: { prepare: vi.fn() },
}))
import db from '../../db.js'

describe('slimChapterStrategy', () => {
  it('returns empty string for null/undefined/non-string input', () => {
    expect(slimChapterStrategy(null)).toBe('')
    expect(slimChapterStrategy(undefined)).toBe('')
    expect(slimChapterStrategy('')).toBe('')
    expect(slimChapterStrategy(42)).toBe('')
  })

  it('keeps only beat_strategies, drops strategy + matched_reference_chapter + frequency_targets', () => {
    const input = JSON.stringify({
      matched_reference_chapter: { chapter_name: 'X', match_reason: 'Y' },
      frequency_targets: { broll: { target_per_minute: 13 } },
      strategy: { commonalities: 'pacing X', broll: { sources: 'mixed' } },
      beat_strategies: [{ beat_name: 'Hook', strategy_points: ['close-up'] }],
    })
    const parsed = JSON.parse(slimChapterStrategy(input))
    expect(Object.keys(parsed)).toEqual(['beat_strategies'])
    expect(parsed.beat_strategies).toHaveLength(1)
    expect(parsed.beat_strategies[0].beat_name).toBe('Hook')
    expect(parsed.strategy).toBeUndefined()
    expect(parsed.matched_reference_chapter).toBeUndefined()
    expect(parsed.frequency_targets).toBeUndefined()
  })

  it('handles missing beat_strategies field with safe default', () => {
    const out = JSON.parse(slimChapterStrategy(JSON.stringify({ frequency_targets: {} })))
    expect(out.beat_strategies).toEqual([])
  })

  it('parses JSON wrapped in markdown fence', () => {
    const input = '```json\n{"beat_strategies":[{"beat_name":"X"}]}\n```'
    const out = JSON.parse(slimChapterStrategy(input))
    expect(out.beat_strategies[0].beat_name).toBe('X')
  })

  it('parses JSON wrapped in extra prose (forgiving)', () => {
    const input = 'Here is the JSON: {"beat_strategies":[{"beat_name":"X"}]} thanks'
    const out = JSON.parse(slimChapterStrategy(input))
    expect(out.beat_strategies[0].beat_name).toBe('X')
  })

  it('falls back to truncated raw text on totally unparseable input', () => {
    const input = 'no json here just text ' + 'x'.repeat(3000)
    const out = slimChapterStrategy(input)
    expect(out.length).toBeLessThanOrEqual(2000)
    expect(out.startsWith('no json here')).toBe(true)
  })
})

describe('loadPriorChapterStrategies', () => {
  beforeEach(() => { db.prepare.mockReset() })

  it('returns empty string when priors array is empty/undefined/null', async () => {
    expect(await loadPriorChapterStrategies([], 0, ['Hook'])).toBe('')
    expect(await loadPriorChapterStrategies(undefined, 0, ['Hook'])).toBe('')
    expect(await loadPriorChapterStrategies(null, 0, ['Hook'])).toBe('')
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('throws when sub-run is missing for a prior pipeline + chapter', async () => {
    db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) })
    await expect(loadPriorChapterStrategies(['pid-x'], 2, ['Hook']))
      .rejects.toThrow('missing sub-run: pid=pid-x chapter=2')
  })

  it('formats single prior as per-beat array with directive header + ordinal source label + video title', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          beat_strategies: [
            { beat_name: 'Hook', beat_emotion: 'urgent', strategy_points: ['close-up faces'] },
          ],
        }),
        video_id: 5,
        title: 'My Reference Video',
      }),
    })
    const out = await loadPriorChapterStrategies(['pid-1'], 0, ['Hook'])
    expect(out).toContain('## Prior strategies for this chapter (do NOT repeat strategy_points):')
    // Parse the JSON portion (after the header line)
    const jsonStart = out.indexOf('[')
    const beats = JSON.parse(out.slice(jsonStart))
    expect(beats).toHaveLength(1)
    expect(beats[0].beat_name).toBe('Hook')
    expect(beats[0].beat_emotion).toBe('urgent')
    expect(beats[0].prior_strategy_points).toHaveLength(1)
    expect(beats[0].prior_strategy_points[0].source).toBe('First Strategy (from "My Reference Video")')
    expect(beats[0].prior_strategy_points[0].strategy_points).toEqual(['close-up faces'])
  })

  it('source label has no title parenthetical when video has no title', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          beat_strategies: [{ beat_name: 'Hook', strategy_points: ['x'] }],
        }),
        video_id: 5,
        title: null,
      }),
    })
    const out = await loadPriorChapterStrategies(['pid-fallback'], 0, ['Hook'])
    const beats = JSON.parse(out.slice(out.indexOf('[')))
    expect(beats[0].prior_strategy_points[0].source).toBe('First Strategy')
  })

  it('two priors → per-beat array with both priors in order, ordinal labels are First/Second', async () => {
    let callCount = 0
    db.prepare.mockReturnValue({
      get: vi.fn(() => {
        callCount++
        return {
          output_text: JSON.stringify({
            beat_strategies: [
              { beat_name: 'Hook', strategy_points: [`points from prior ${callCount}`] },
            ],
          }),
          video_id: callCount,
          title: `Ref ${callCount}`,
        }
      }),
    })
    const out = await loadPriorChapterStrategies(['p1', 'p2'], 0, ['Hook'])
    const beats = JSON.parse(out.slice(out.indexOf('[')))
    expect(beats).toHaveLength(1)
    expect(beats[0].prior_strategy_points).toHaveLength(2)
    expect(beats[0].prior_strategy_points[0].source).toBe('First Strategy (from "Ref 1")')
    expect(beats[0].prior_strategy_points[1].source).toBe('Second Strategy (from "Ref 2")')
    expect(beats[0].prior_strategy_points[0].strategy_points).toEqual(['points from prior 1'])
    expect(beats[0].prior_strategy_points[1].strategy_points).toEqual(['points from prior 2'])
  })

  it('beat ordering follows canonicalBeatNames when provided', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          // priors emit beats in REVERSE order to prove canonical order wins
          beat_strategies: [
            { beat_name: 'Conclusion', strategy_points: ['c'] },
            { beat_name: 'Body', strategy_points: ['b'] },
            { beat_name: 'Hook', strategy_points: ['h'] },
          ],
        }),
        video_id: 1,
        title: 'Ref',
      }),
    })
    const out = await loadPriorChapterStrategies(['p1'], 0, ['Hook', 'Body', 'Conclusion'])
    const beats = JSON.parse(out.slice(out.indexOf('[')))
    expect(beats.map(b => b.beat_name)).toEqual(['Hook', 'Body', 'Conclusion'])
  })

  it('drops beats present in priors but missing from canonicalBeatNames', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          beat_strategies: [
            { beat_name: 'Hook', strategy_points: ['h'] },
            { beat_name: 'HallucinatedBeat', strategy_points: ['x'] },
          ],
        }),
        video_id: 1,
        title: 'Ref',
      }),
    })
    const out = await loadPriorChapterStrategies(['p1'], 0, ['Hook'])
    const beats = JSON.parse(out.slice(out.indexOf('[')))
    expect(beats.map(b => b.beat_name)).toEqual(['Hook'])
  })

  it('falls back to union of beats when canonicalBeatNames is empty', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          beat_strategies: [
            { beat_name: 'A', strategy_points: ['a'] },
            { beat_name: 'B', strategy_points: ['b'] },
          ],
        }),
        video_id: 1,
        title: 'Ref',
      }),
    })
    const out = await loadPriorChapterStrategies(['p1'], 0, [])
    const beats = JSON.parse(out.slice(out.indexOf('[')))
    expect(beats.map(b => b.beat_name)).toEqual(['A', 'B'])
  })

  it('skips a prior silently when its strategy_points for a beat is empty', async () => {
    let callCount = 0
    db.prepare.mockReturnValue({
      get: vi.fn(() => {
        callCount++
        return {
          output_text: JSON.stringify({
            beat_strategies: [
              { beat_name: 'Hook', strategy_points: callCount === 1 ? ['real'] : [] },
            ],
          }),
          video_id: callCount,
          title: `Ref ${callCount}`,
        }
      }),
    })
    const out = await loadPriorChapterStrategies(['p1', 'p2'], 0, ['Hook'])
    const beats = JSON.parse(out.slice(out.indexOf('[')))
    expect(beats[0].prior_strategy_points).toHaveLength(1)
    expect(beats[0].prior_strategy_points[0].source).toBe('First Strategy (from "Ref 1")')
  })

  it('drops a beat entirely when every prior is empty/missing for it', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          beat_strategies: [
            { beat_name: 'Hook', strategy_points: ['h'] },
            // 'Body' has no strategy_points anywhere
          ],
        }),
        video_id: 1,
        title: 'Ref',
      }),
    })
    const out = await loadPriorChapterStrategies(['p1'], 0, ['Hook', 'Body'])
    const beats = JSON.parse(out.slice(out.indexOf('[')))
    expect(beats.map(b => b.beat_name)).toEqual(['Hook'])
  })

  it('returns empty string when no prior produced any non-empty strategy_points', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          beat_strategies: [{ beat_name: 'Hook', strategy_points: [] }],
        }),
        video_id: 1,
        title: 'Ref',
      }),
    })
    const out = await loadPriorChapterStrategies(['p1'], 0, ['Hook'])
    expect(out).toBe('')
  })

  it('uses comma boundary on subIndex to prevent matching subIndex:10 when looking for subIndex:1', async () => {
    const captured = []
    db.prepare.mockImplementation((sql) => ({
      get: vi.fn((...params) => {
        captured.push({ sql, params })
        return {
          output_text: JSON.stringify({ beat_strategies: [{ beat_name: 'Hook', strategy_points: ['x'] }] }),
          video_id: 1,
          title: 'Ref',
        }
      }),
    }))
    await loadPriorChapterStrategies(['p1'], 1, ['Hook'])
    const subIndexParam = captured[0].params.find(p => typeof p === 'string' && p.includes('subIndex'))
    expect(subIndexParam).toBe('%"subIndex":1,%')
  })
})

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
